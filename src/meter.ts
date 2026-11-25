import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { costOf, defaultPrices, findPrice, mergePrices, type PriceTable, type Usage } from "./prices";
import { providerFromUrl, readSse, readUsage, streamUsage } from "./usage";

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
  stream?: boolean;
  note?: string;
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
  stream?: boolean;
  note?: string;
};

export type FetchOptions = {
  tag: string;
  outputId?: string;
  provider?: string;
  model?: string;
};

export type BudgetOptions = {
  tag?: string;
  perDay: number;
  action?: "warn" | "throw";
  onExceed?: (b: BudgetStatus) => void;
};

export type BudgetStatus = { tag: string; perDay: number; day: string; spent: number; remaining: number; exceeded: boolean };

export class BudgetError extends Error {
  constructor(public status: BudgetStatus) {
    super(`meter: ${status.tag} spent $${status.spent.toFixed(4)} of its $${status.perDay} budget for ${status.day}. Call refused.`);
  }
}

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
    if (input.stream) entry.stream = true;
    if (input.note) entry.note = input.note;
    write(entry);
    for (const b of budgets) b.add(entry);
    return entry;
  }

  const budgets: ReturnType<typeof makeBudget>[] = [];

  function makeBudget(o: BudgetOptions) {
    if (!(o.perDay > 0)) throw new Error("meter.budget needs perDay > 0");
    const tag = o.tag ?? "*";
    const action = o.action ?? "warn";
    const matches = (t: string) => tag === "*" || t === tag;
    let day = "";
    let spent = 0;
    let warned = "";
    const roll = () => {
      const today = now().toISOString().slice(0, 10);
      if (today === day) return;
      day = today;
      spent = 0;
      if (!existsSync(log)) return;
      for (const line of readFileSync(log, "utf8").split("\n")) {
        if (!line.includes(today)) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "call" && e.ts.startsWith(today) && matches(e.tag) && typeof e.cost === "number") spent += e.cost;
        } catch {}
      }
    };
    const status = (): BudgetStatus => {
      roll();
      return { tag, perDay: o.perDay, day, spent, remaining: Math.max(0, o.perDay - spent), exceeded: spent >= o.perDay };
    };
    const notify = (st: BudgetStatus) => {
      if (warned === st.day) return;
      warned = st.day;
      if (o.onExceed) o.onExceed(st);
      else console.warn(`meter: ${st.tag} is over its $${st.perDay}/day budget: $${st.spent.toFixed(4)} spent on ${st.day}.${action === "throw" ? " Further calls will be refused." : ""}`);
    };
    return {
      matches,
      status,
      add(e: CallEntry) {
        if (!matches(e.tag)) return;
        const before = day;
        roll();
        if (before === day && e.ts.startsWith(day) && typeof e.cost === "number") spent += e.cost;
        if (spent >= o.perDay) notify(status());
      },
      check() {
        const st = status();
        if (!st.exceeded) return st;
        notify(st);
        if (action === "throw") throw new BudgetError(st);
        return st;
      },
    };
  }

  function budget(o: BudgetOptions) {
    const b = makeBudget(o);
    budgets.push(b);
    return { tag: o.tag ?? "*", perDay: o.perDay, status: b.status, check: b.check };
  }

  function checkBudgets(tag: string) {
    for (const b of budgets) if (b.matches(tag)) b.check();
  }

  const pending = new Set<Promise<void>>();

  function flush() {
    return Promise.all([...pending]).then(() => undefined);
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
    checkBudgets(o.tag);
    const started = performance.now();
    let res: Response;
    try {
      res = await doFetch(input, init);
    } catch (e) {
      record({ provider, model: requestModel ?? "unknown", tag: o.tag, ok: false, outputId: o.outputId, error: (e as Error).message, ms: Math.round(performance.now() - started) });
      throw e;
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      const [mine, theirs] = res.body.tee();
      const parsed = streamUsage();
      const done: Promise<void> = readSse(mine, parsed.push)
        .then(() => null, (e) => (e as Error).message)
        .then((broken) => {
          const r = parsed.result();
          record({
            provider,
            model: o.model ?? r.model ?? requestModel ?? "unknown",
            usage: r.usage,
            tag: o.tag,
            ok: res.ok && !r.error && !broken,
            outputId: o.outputId,
            status: res.status,
            error: r.error ?? broken ?? undefined,
            ms: Math.round(performance.now() - started),
            stream: true,
            note: r.sawUsage || r.error || broken ? undefined : "stream carried no usage; for OpenAI set stream_options.include_usage",
          });
        })
        .finally(() => {
          pending.delete(done);
        });
      pending.add(done);
      return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    let body: any = null;
    if (type.includes("json")) body = await res.clone().json().catch(() => null);
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

  return { record, keep, fetch: meteredFetch, budget, flush, log, prices };
}

export type Meter = ReturnType<typeof createMeter>;
