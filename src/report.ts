import { costOf, findPrice, type PriceTable } from "./prices";
import type { CallEntry, Entry, KeepEntry } from "./meter";

export type GroupBy = "tag" | "model" | "day";

export type Row = {
  group: string;
  calls: number;
  failed: number;
  spend: number;
  kept: number;
  cost_per_kept: number | null;
  wasted_share: number | null;
  unpriced: number;
};

export type Report = {
  by: GroupBy;
  rows: Row[];
  total: Row;
  unpriced_models: string[];
};

export async function readLog(path: string): Promise<Entry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No log at ${path}. Record something first, or pass --log.`);
  const entries: Entry[] = [];
  for (const [i, line] of (await file.text()).split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON`);
    }
  }
  return entries;
}

function priced(call: CallEntry, prices: PriceTable): number | null {
  if (call.cost_source === "explicit") return call.cost;
  const found = findPrice(prices, call.provider, call.model);
  return found ? costOf(found.price, call.usage ?? {}) : call.cost;
}

export function buildReport(entries: Entry[], by: GroupBy, prices: PriceTable, filter: { since?: string; tag?: string } = {}): Report {
  const calls = entries.filter((e): e is CallEntry => e.type === "call").filter((c) => (!filter.since || c.ts >= filter.since) && (!filter.tag || c.tag === filter.tag));
  const keeps = entries.filter((e): e is KeepEntry => e.type === "keep").filter((k) => (!filter.since || k.ts >= filter.since) && (!filter.tag || k.tag === filter.tag));
  const keptIds = new Map<string, Set<string>>();
  for (const k of keeps) {
    if (!keptIds.has(k.tag)) keptIds.set(k.tag, new Set());
    keptIds.get(k.tag)!.add(k.output_id);
  }
  const isKept = (c: CallEntry) => Boolean(c.output_id && keptIds.get(c.tag)?.has(c.output_id));
  const keyOf = (c: CallEntry) => (by === "tag" ? c.tag : by === "model" ? `${c.provider}/${c.model}` : c.ts.slice(0, 10));

  const groups = new Map<string, CallEntry[]>();
  for (const c of calls) {
    const k = keyOf(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }

  const unpriced = new Set<string>();
  const summarize = (group: string, list: CallEntry[], keptCount?: number): Row => {
    let spend = 0;
    let keptSpend = 0;
    let missing = 0;
    const kept = new Set<string>();
    for (const c of list) {
      const cost = priced(c, prices);
      if (cost === null) {
        missing++;
        unpriced.add(`${c.provider}/${c.model}`);
        continue;
      }
      spend += cost;
      if (isKept(c)) {
        keptSpend += cost;
        kept.add(`${c.tag}\u0000${c.output_id}`);
      }
    }
    const linked = list.some((c) => c.output_id);
    const keptN = keptCount ?? kept.size;
    return {
      group,
      calls: list.length,
      failed: list.filter((c) => !c.ok).length,
      spend,
      kept: keptN,
      cost_per_kept: keptN ? spend / keptN : null,
      wasted_share: linked && spend > 0 ? 1 - keptSpend / spend : null,
      unpriced: missing,
    };
  };

  const rows = [...groups.entries()].map(([g, list]) => summarize(g, list, by === "tag" ? keptIds.get(g)?.size ?? 0 : undefined));
  rows.sort((a, b) => (by === "day" ? a.group.localeCompare(b.group) : b.spend - a.spend));
  const totalKept = by === "tag" ? rows.reduce((s, r) => s + r.kept, 0) : undefined;
  return { by, rows, total: summarize("total", calls, totalKept), unpriced_models: [...unpriced].sort() };
}

function usd(v: number | null) {
  if (v === null) return "-";
  if (v === 0) return "$0";
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function pct(v: number | null) {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

export function formatReport(r: Report): string {
  const head = [r.by, "calls", "failed", "spend", "kept", "cost/kept", "wasted"];
  const line = (x: Row) => [x.group, String(x.calls), String(x.failed), usd(x.spend), String(x.kept), usd(x.cost_per_kept), pct(x.wasted_share)];
  const body = r.rows.map(line);
  const total = line(r.total);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length), total[i].length));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const out = [fmt(head), rule, ...body.map(fmt), rule, fmt(total)];
  if (r.unpriced_models.length) {
    out.push("", `No price for: ${r.unpriced_models.join(", ")}. Those calls are left out of spend. Add them with --prices.`);
  }
  return out.join("\n");
}
