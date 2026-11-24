import { createMeter, type FetchOptions, type Meter, type RecordInput } from "./meter";

export { createMeter } from "./meter";
export type { CallEntry, Entry, FetchOptions, KeepEntry, Meter, MeterOptions, RecordInput } from "./meter";
export { buildReport, formatReport, readLog } from "./report";
export type { GroupBy, Report, Row } from "./report";
export { costOf, defaultPrices, findPrice, loadPriceFile, mergePrices, pricesAsOf } from "./prices";
export type { Price, PriceTable, Usage } from "./prices";
export { readUsage } from "./usage";

let shared: Meter | undefined;
const get = () => (shared ??= createMeter());

export const meter = {
  record: (input: RecordInput) => get().record(input),
  keep: (tag: string, outputId: string) => get().keep(tag, outputId),
  fetch: (input: string | URL | Request, init: RequestInit | undefined, opts: FetchOptions) => get().fetch(input, init, opts),
};
