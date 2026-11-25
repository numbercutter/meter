import type { Usage } from "./prices";

export function providerFromUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("anthropic.com")) return "anthropic";
  return null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function readUsage(body: any): Usage {
  const u = body?.usage ?? {};
  const out: Usage = {};
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    const cached = num(u.prompt_tokens_details?.cached_tokens);
    out.input_tokens = num(u.prompt_tokens) - cached;
    out.output_tokens = num(u.completion_tokens);
    if (cached) out.cache_read_tokens = cached;
  } else if ("input_tokens" in u || "output_tokens" in u) {
    const cachedInside = num(u.input_tokens_details?.cached_tokens);
    out.input_tokens = num(u.input_tokens) - cachedInside;
    out.output_tokens = num(u.output_tokens);
    const read = cachedInside + num(u.cache_read_input_tokens);
    const hour = num(u.cache_creation?.ephemeral_1h_input_tokens);
    const write = u.cache_creation ? num(u.cache_creation.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
    if (read) out.cache_read_tokens = read;
    if (write) out.cache_write_tokens = write;
    if (hour) out.cache_write_1h_tokens = hour;
  }
  if (Array.isArray(body?.data) && body.data.some((d: any) => d?.b64_json || d?.url)) out.images = body.data.length;
  if (num(body?.seconds) || num(u.seconds)) out.seconds = num(body?.seconds) || num(u.seconds);
  if (num(u.images)) out.images = num(u.images);
  return out;
}

export type StreamResult = { usage: Usage; model?: string; sawUsage: boolean; error?: string };

export function streamUsage() {
  let anthropic: any = null;
  let final: any = null;
  let model: string | undefined;
  let error: string | undefined;
  return {
    push(data: any) {
      if (!data || typeof data !== "object") return;
      if (data.type === "message_start") {
        anthropic = { ...(data.message?.usage ?? {}) };
        model = data.message?.model ?? model;
      } else if (data.type === "message_delta" && data.usage) {
        anthropic = { ...(anthropic ?? {}), ...Object.fromEntries(Object.entries(data.usage).filter(([, v]) => v !== null && v !== undefined)) };
      } else if (data.type === "error") {
        error = data.error?.message ?? data.error?.type ?? "stream error";
      } else if (data.type === "response.completed" || data.type === "response.incomplete" || data.type === "response.failed") {
        final = data.response;
        model = data.response?.model ?? model;
        if (data.type === "response.failed") error = data.response?.error?.message ?? "response failed";
      } else if (data.object === "chat.completion.chunk") {
        model = data.model ?? model;
        if (data.usage) final = data;
      }
    },
    result(): StreamResult {
      const body = final ?? (anthropic ? { usage: anthropic } : null);
      return { usage: readUsage(body), model, sawUsage: Boolean(body?.usage), error };
    },
  };
}

export async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: any) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      onData(JSON.parse(data));
    } catch {}
  };
  for await (const chunk of stream as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
      flush(buf.slice(0, at));
      buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
    }
  }
  if (buf.trim()) flush(buf);
}
