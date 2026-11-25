import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { costOf, createMeter, defaultPrices, readLog, type CallEntry } from "../src/index";

const log = fileURLToPath(new URL("./out/stream.jsonl", import.meta.url));
rmSync(log, { force: true });

const words = "Matte ceramic mug on warm oak, soft window light, three-quarter view.".split(" ");

function sse(events: { event?: string; data: unknown }[], breakAfter?: number) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const [i, e] of events.entries()) {
        if (breakAfter !== undefined && i === breakAfter) {
          c.error(new Error("connection reset"));
          return;
        }
        c.enqueue(enc.encode(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`));
        await Bun.sleep(2);
      }
      c.close();
    },
  });
}

function anthropicEvents(model: string, failMidway: boolean) {
  const out: { event?: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_local",
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: { input_tokens: 812, cache_read_input_tokens: 3000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, output_tokens: 1 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  ];
  for (const [i, w] of words.entries()) {
    if (failMidway && i === 4) {
      out.push({ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
      return out;
    }
    out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (i ? " " : "") + w } } });
  }
  out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  out.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 214 } } });
  out.push({ event: "message_stop", data: { type: "message_stop" } });
  return out;
}

function openaiEvents(model: string, includeUsage: boolean) {
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: "chatcmpl-local", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }], ...(includeUsage ? { usage: null } : {}) });
  const out: { data: unknown }[] = [{ data: chunk({ role: "assistant", content: "" }) }];
  for (const [i, w] of words.entries()) out.push({ data: chunk({ content: (i ? " " : "") + w }) });
  out.push({ data: chunk({}, "stop") });
  if (includeUsage) out.push({ data: { id: "chatcmpl-local", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 18, total_tokens: 1218, prompt_tokens_details: { cached_tokens: 1000 } } } });
  out.push({ data: "[DONE]" });
  return out;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  error: () => new Response(null, { status: 500 }),
  async fetch(req) {
    const body: any = await req.json();
    const url = new URL(req.url);
    const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
    if (url.pathname === "/v1/messages") return new Response(sse(anthropicEvents(body.model, body.metadata?.fail === "midway")), { headers });
    if (url.pathname === "/v1/chat/completions") {
      const events = openaiEvents(`${body.model}-2025-04-14`, Boolean(body.stream_options?.include_usage));
      return new Response(sse(events, body.user === "drop" ? 5 : undefined), { headers });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
console.log(`Local stand-in for both APIs at ${base}. No real provider is called.\n`);

const meter = createMeter({ log });
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function readText(res: Response) {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    for (const line of decoder.decode(chunk).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const d = JSON.parse(line.slice(6));
      text += d.delta?.text ?? d.choices?.[0]?.delta?.content ?? "";
    }
  }
  return text;
}

function check(ok: unknown, label: string) {
  if (!ok) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`ok   ${label}`);
}

const full = words.join(" ");

const a = await meter.fetch(`${base}/v1/messages`, post({ model: "claude-sonnet-5-5", max_tokens: 1024, stream: true }), { tag: "copy", provider: "anthropic", outputId: "a" });
check((await readText(a)) === full, "anthropic: caller reads the whole stream untouched");

const o = await meter.fetch(`${base}/v1/chat/completions`, post({ model: "gpt-4.1-mini", stream: true, stream_options: { include_usage: true } }), { tag: "copy", provider: "openai", outputId: "o" });
check((await readText(o)) === full, "openai: caller reads the whole stream untouched");

const bare = await meter.fetch(`${base}/v1/chat/completions`, post({ model: "gpt-4.1-mini", stream: true }), { tag: "copy", provider: "openai" });
await readText(bare);

const broken = await meter.fetch(`${base}/v1/messages`, post({ model: "claude-sonnet-5-5", max_tokens: 1024, stream: true, metadata: { fail: "midway" } }), { tag: "copy", provider: "anthropic" });
await readText(broken);

const dropped = await meter.fetch(`${base}/v1/chat/completions`, post({ model: "gpt-4.1-mini", stream: true, stream_options: { include_usage: true }, user: "drop" }), { tag: "copy", provider: "openai" });
await readText(dropped).catch(() => {});

await meter.flush();
server.stop(true);

const calls = (await readLog(log)).filter((e): e is CallEntry => e.type === "call");
for (const c of calls) console.log(`  ${c.provider}/${c.model}  ok=${c.ok}  ${JSON.stringify(c.usage)}  $${c.cost?.toFixed(6)}${c.error ? `  error: ${c.error}` : ""}${c.note ? `  note: ${c.note}` : ""}`);

const [ca, co, cb, cbroken, cdrop] = calls;
const sonnet = defaultPrices["anthropic/claude-sonnet-5-5"];
const expectA = (812 * 2 + 214 * 10 + 3000 * 0.1 + 1000 * 2.5 + 2000 * 4) / 1e6;
check(ca.usage.input_tokens === 812 && ca.usage.output_tokens === 214 && ca.usage.cache_read_tokens === 3000 && ca.usage.cache_write_tokens === 1000 && ca.usage.cache_write_1h_tokens === 2000, "anthropic: message_start + message_delta usage, cache writes split by TTL");
check(Math.abs(ca.cost! - expectA) < 1e-12 && Math.abs(costOf(sonnet, ca.usage) - expectA) < 1e-12, `anthropic: priced with separate 5m and 1h write rates ($${expectA.toFixed(6)})`);
const mini = defaultPrices["openai/gpt-4.1-mini"];
const expectO = (200 * mini.input! + 1000 * mini.cache_read! + 18 * mini.output!) / 1e6;
check(co.model === "gpt-4.1-mini-2025-04-14" && co.usage.input_tokens === 200 && co.usage.cache_read_tokens === 1000 && Math.abs(co.cost! - expectO) < 1e-12, `openai: include_usage final chunk, cached input priced at the cached rate ($${expectO.toFixed(6)})`);
check(cb.ok && cb.stream && cb.note?.includes("include_usage") && !cb.usage.output_tokens, "openai without include_usage: logged with a note, no invented usage");
check(!cbroken.ok && cbroken.error === "Overloaded" && cbroken.usage.input_tokens === 812, "anthropic error event mid-stream: failed, input usage kept");
check(!cdrop.ok && Boolean(cdrop.error), "dropped connection: failed with the network error");
console.log("\nall checks passed");
