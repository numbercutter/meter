import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReport, createMeter, defaultPrices, formatReport, readLog } from "../src/index";

const log = fileURLToPath(new URL("./out/meter.jsonl", import.meta.url));
rmSync(log, { force: true });

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const between = (a: number, b: number) => Math.round(a + rand() * (b - a));

let clock = Date.parse("2026-11-20T09:00:00Z");
const now = () => new Date((clock += between(20, 90) * 1000));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const req = JSON.parse(String(init?.body ?? "{}"));
  if (url.includes("anthropic.com")) {
    if (rand() < 0.08) return json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const critic = req.model.includes("haiku");
    const score = critic ? (rand() * 10).toFixed(1) : null;
    return json(200, {
      id: `msg_${between(1e6, 9e6)}`,
      type: "message",
      model: req.model,
      content: [{ type: "text", text: critic ? `{"score": ${score}}` : "A matte ceramic mug on warm oak, soft window light, 3/4 view." }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: critic ? between(1400, 1700) : between(600, 900),
        output_tokens: critic ? between(20, 40) : between(140, 260),
        cache_read_input_tokens: critic ? 0 : 2400,
        cache_creation_input_tokens: 0,
      },
    });
  }
  if (url.includes("/images/")) {
    if (rand() < 0.12) return json(500, { error: { message: "The server had an error processing your request.", type: "server_error" } });
    return json(200, { created: 1, data: [{ b64_json: "iVBORw0KGgo" }], usage: { input_tokens: 60, output_tokens: 4160 } });
  }
  return json(200, {
    id: "chatcmpl-x",
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ message: { role: "assistant", content: "Morning coffee, slower." } }],
    usage: { prompt_tokens: between(300, 420), completion_tokens: between(25, 60), prompt_tokens_details: { cached_tokens: 0 } },
  });
}) as typeof fetch;

const meter = createMeter({ log, fetch: fakeFetch, now });

async function withRetries(attempts: number, call: () => Promise<Response>) {
  for (let i = 0; i < attempts; i++) {
    const res = await call();
    if (res.ok) return res.json();
  }
  return null;
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let shots = 0;
let attemptsMade = 0;
for (let day = 0; day < 3; day++) {
  clock = Date.parse(`2026-11-${20 + day}T09:00:00Z`);
  for (let brief = 0; brief < 6; brief++) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const outputId = `shot-${day}-${brief}-${attempt}`;
      attemptsMade++;
      const prompt = await withRetries(3, () =>
        meter.fetch("https://api.anthropic.com/v1/messages", post({ model: "claude-sonnet-5-5", max_tokens: 1024 }), { tag: "product-shot", outputId }),
      );
      if (!prompt) break;
      const image = await withRetries(3, () =>
        meter.fetch("https://api.openai.com/v1/images/generations", post({ model: "gpt-image-1" }), { tag: "product-shot", outputId, model: "gpt-image-1" }),
      );
      if (!image) continue;
      const review = await withRetries(2, () =>
        meter.fetch("https://api.anthropic.com/v1/messages", post({ model: "claude-haiku-5-5", max_tokens: 64 }), { tag: "product-shot", outputId }),
      );
      const score = review ? JSON.parse(review.content[0].text).score : 0;
      if (score >= 6.5) {
        meter.keep("product-shot", outputId);
        shots++;
        const captionId = `caption-${outputId}`;
        const caption = await withRetries(2, () =>
          meter.fetch("https://api.openai.com/v1/chat/completions", post({ model: "gpt-4o-mini" }), { tag: "caption", outputId: captionId }),
        );
        if (caption && rand() < 0.85) meter.keep("caption", captionId);
        break;
      }
    }
  }
  for (let clip = 0; clip < 2; clip++) {
    const outputId = `teaser-${day}-${clip}`;
    const ok = rand() > 0.15;
    meter.record({ provider: "openai", model: "sora-2", usage: { seconds: ok ? 8 : 0 }, tag: "teaser", ok, outputId, status: ok ? 200 : 500 });
    if (ok && rand() < 0.5) meter.keep("teaser", outputId);
  }
}

console.log(`Simulated 3 days: ${attemptsMade} product-shot attempts, ${shots} kept.\n`);
const entries = await readLog(log);
const byTag = buildReport(entries, "tag", defaultPrices);
console.log(formatReport(byTag));
const shot = byTag.rows.find((r) => r.group === "product-shot")!;
console.log(`\nOne image lists at $${defaultPrices["openai/gpt-image-1"].image}. One kept product shot really cost $${shot.cost_per_kept!.toFixed(4)}.\n`);
console.log(formatReport(buildReport(entries, "model", defaultPrices)));
console.log(`\nLog written to ${log}`);
console.log(`Try: bun src/cli.ts report --by day --log examples/out/meter.jsonl`);
