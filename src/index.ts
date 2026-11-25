import { createMeter, type BudgetOptions, type FetchOptions, type Meter, type RecordInput } from "./meter";

export { BudgetError, createMeter } from "./meter";
export type { BudgetOptions, BudgetStatus, CallEntry, Entry, FetchOptions, KeepEntry, Meter, MeterOptions, RecordInput } from "./meter";
export { buildReport, formatReport, readLog } from "./report";
export { renderHtml } from "./html";
export type { GroupBy, Report, Row } from "./report";
export { cacheSavings, costOf, defaultPrices, findPrice, loadPriceFile, mergePrices, pricesAsOf } from "./prices";
export type { Price, PriceTable, Usage } from "./prices";
export { readSse, readUsage, streamUsage } from "./usage";

let shared: Meter | undefined;
const get = () => (shared ??= createMeter());

export const meter = {
  record: (input: RecordInput) => get().record(input),
  keep: (tag: string, outputId: string) => get().keep(tag, outputId),
  fetch: (input: string | URL | Request, init: RequestInit | undefined, opts: FetchOptions) => get().fetch(input, init, opts),
  budget: (opts: BudgetOptions) => get().budget(opts),
  flush: () => get().flush(),
};
