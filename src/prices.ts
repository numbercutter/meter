import defaults from "../prices.json";

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_write_1h_tokens?: number;
  images?: number;
  seconds?: number;
};

export type Price = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
  image?: number;
  second?: number;
  asOf?: string;
};

export type PriceTable = Record<string, Price>;

export const defaultPrices: PriceTable = defaults.models;
export const pricesAsOf: string = defaults.asOf;

export function mergePrices(...tables: (PriceTable | undefined)[]): PriceTable {
  const out: PriceTable = {};
  for (const t of tables) for (const [k, v] of Object.entries(t ?? {})) out[k] = { ...out[k], ...v };
  return out;
}

export async function loadPriceFile(path: string): Promise<PriceTable> {
  const json = await Bun.file(path).json();
  return json.models ?? json;
}

export function findPrice(table: PriceTable, provider: string, model: string): { key: string; price: Price } | null {
  const id = `${provider}/${model}`;
  if (table[id]) return { key: id, price: table[id] };
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { key: best, price: table[best] } : null;
}

export function costOf(price: Price, u: Usage): number {
  const m = 1_000_000;
  const input = price.input ?? 0;
  return (
    ((u.input_tokens ?? 0) * input) / m +
    ((u.output_tokens ?? 0) * (price.output ?? 0)) / m +
    ((u.cache_read_tokens ?? 0) * (price.cache_read ?? input * 0.1)) / m +
    ((u.cache_write_tokens ?? 0) * (price.cache_write ?? input * 1.25)) / m +
    ((u.cache_write_1h_tokens ?? 0) * (price.cache_write_1h ?? input * 2)) / m +
    (u.images ?? 0) * (price.image ?? 0) +
    (u.seconds ?? 0) * (price.second ?? 0)
  );
}

export function cacheSavings(price: Price, u: Usage): number {
  const m = 1_000_000;
  const input = price.input ?? 0;
  const saved = ((u.cache_read_tokens ?? 0) * (input - (price.cache_read ?? input * 0.1))) / m;
  const premium =
    ((u.cache_write_tokens ?? 0) * ((price.cache_write ?? input * 1.25) - input)) / m +
    ((u.cache_write_1h_tokens ?? 0) * ((price.cache_write_1h ?? input * 2) - input)) / m;
  return saved - premium;
}
