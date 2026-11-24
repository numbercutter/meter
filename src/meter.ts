import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { costOf, defaultPrices, findPrice, mergePrices, type PriceTable, type Usage } from "./prices";
import { providerFromUrl, readUsage } from "./usage";

export type CallEntry = {
  type: "call";
  ts: string;
  tag: string;
  provider: string;
  model: string;
  ok: boolean;
  usage: Usage;
  cost: number | null;
  cost_source: "price" | "explicit" | "unpriced";
  output_id?: string;
  status?: number;
  error?: string;
  ms?: number;
};

export type KeepEntry = { type: "keep"; ts: string; tag: string; output_id: string };
export type Entry = CallEntry | KeepEntry;

export type RecordInput = {
  provider: string;
  model: string;
  usage?: Usage;
  tag: string;
  ok?: boolean;
  outputId?: string;
  cost?: number;
  status?: number;
  error?: string;
  ms?: number;
};

export type FetchOptions = {
  tag: string;
  outputId?: string;
  provider?: string;
  model?: string;
};

export type MeterOptions = {
  log?: string;
  prices?: PriceTable;
  fetch?: typeof fetch;
  now?: () => Date;
};

export function createMeter(opts: MeterOptions = {}) {
  const log = opts.log ?? process.env.METER_LOG ?? "meter.jsonl";
  const prices = mergePrices(defaultPrices, opts.prices);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(log), { recursive: true });

  function write(entry: Entry) {
    appendFileSync(log, JSON.stringify(entry) + "\n");
    return entry;
  }

  function record(input: RecordInput): CallEntry {
    if (!input.tag) throw new Error("meter.record needs a tag");
    const usage = input.usage ?? {};
    const found = findPrice(prices, input.provider, input.model);
    const entry: CallEntry = {
      type: "call",
      ts: now().toISOString(),
      tag: input.tag,
      provider: input.provider,
      model: input.model,
      ok: input.ok ?? true,
      usage,
      cost: input.cost ?? (found ? costOf(found.price, usage) : null),
      cost_source: input.cost !== undefined ? "explicit" : found ? "price" : "unpriced",
    };
    if (input.outputId) entry.output_id = input.outputId;
    if (input.status !== undefined) entry.status = input.status;
    if (input.error) entry.error = input.error;
    if (input.ms !== undefined) entry.ms = input.ms;
    write(entry);
    return entry;
  }

  function keep(tag: string, outputId: string): KeepEntry {
    return write({ type: "keep", ts: now().toISOString(), tag, output_id: outputId }) as KeepEntry;
  }

  async function meteredFetch(input: string | URL | Request, init: RequestInit | undefined, o: FetchOptions): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const provider = o.provider ?? providerFromUrl(url) ?? "generic";
    let requestModel = o.model;
    if (!requestModel && typeof init?.body === "string") {
      try {
        requestModel = JSON.parse(init.body).model;
      } catch {}
    }
    const started = performance.now();
    let res: Response;
    try {
      res = await doFetch(input, init);
    } catch (e) {
      record({ provider, model: requestModel ?? "unknown", tag: o.tag, ok: false, outputId: o.outputId, error: (e as Error).message, ms: Math.round(performance.now() - started) });
      throw e;
    }
    let body: any = null;
    if ((res.headers.get("content-type") ?? "").includes("json")) body = await res.clone().json().catch(() => null);
    record({
      provider,
      model: o.model ?? body?.model ?? requestModel ?? "unknown",
      usage: readUsage(body),
      tag: o.tag,
      ok: res.ok,
      outputId: o.outputId,
      status: res.status,
      error: res.ok ? undefined : body?.error?.message ?? body?.error?.type ?? res.statusText,
      ms: Math.round(performance.now() - started),
    });
    return res;
  }

  return { record, keep, fetch: meteredFetch, log, prices };
}

export type Meter = ReturnType<typeof createMeter>;
