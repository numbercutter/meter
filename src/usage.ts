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
    const write = num(u.cache_creation_input_tokens);
    if (read) out.cache_read_tokens = read;
    if (write) out.cache_write_tokens = write;
  }
  if (Array.isArray(body?.data) && body.data.some((d: any) => d?.b64_json || d?.url)) out.images = body.data.length;
  if (num(body?.seconds) || num(u.seconds)) out.seconds = num(body?.seconds) || num(u.seconds);
  if (num(u.images)) out.images = num(u.images);
  return out;
}
