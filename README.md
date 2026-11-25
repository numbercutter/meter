![meter](assets/banner.svg)

# meter

Know what every output really cost.

meter logs every model call in a generative pipeline, including the failures, retries and drafts you threw away, and marks the outputs you kept. Its report divides all of that spend by what you kept, so you see the price of a usable result instead of the price of one call.

## Quick start

No API keys. The example simulates three days of a pipeline with overloaded APIs, retries, a critic that rejects most drafts and a daily budget on two tags.

```sh
git clone https://github.com/numbercutter/meter && cd meter
bun examples/pipeline.ts
bun src/cli.ts report --log examples/out/meter.jsonl --html examples/out/report.html
```

```
Simulated 3 days: 46 product-shot attempts, 14 kept, 3 teasers refused by budget.
  budget: 2026-11-20 product-shot passed $0.5 (warn only)
  budget: 2026-11-20 teaser passed $0.5; later teasers that day are refused
  ...

tag           calls  failed    spend  kept  cost/kept  wasted  cache saved
------------  -----  ------  -------  ----  ---------  ------  -----------
teaser            3       0    $2.40     2      $1.20     33%            -
product-shot    158      24    $2.06    14    $0.1473     69%      $0.2052
caption          14       0  $0.0011    13    $0.0001      8%            -

One image lists at $0.042. One kept product shot really cost $0.1473.
```

`examples/out/report.html` is one self-contained page: totals, spend per day as a bar chart split into kept and discarded spend, and the cost-per-kept table by tag and by model. No scripts, no network.

`bun examples/stream.ts` starts a local stand-in for the Anthropic and OpenAI streaming APIs and checks that meter reads usage from both without touching the stream the caller reads.

Requires [Bun](https://bun.sh) 1.1 or later. No dependencies.

## Usage

```ts
import { createMeter } from "@numbercutter/meter";

const meter = createMeter({ log: "meter.jsonl" });

const res = await meter.fetch(
  "https://api.anthropic.com/v1/messages",
  { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1024, messages }) },
  { tag: "product-shot", outputId: "shot-42" },
);

meter.record({
  provider: "fal",
  model: "my-video-model",
  usage: { seconds: 8 },
  tag: "teaser",
  ok: true,
  outputId: "teaser-7",
});

meter.keep("product-shot", "shot-42");

meter.budget({ tag: "teaser", perDay: 5, action: "throw" });
```

- `meter.fetch(url, init, { tag, outputId?, provider?, model? })` calls `fetch`, returns the response, and logs the call. It reads usage from OpenAI Chat Completions, OpenAI Responses, OpenAI Images, Anthropic Messages, and any JSON body with `usage.input_tokens` / `output_tokens`. Non-2xx responses and thrown network errors are logged as failed.
- Streams (`text/event-stream`) are split with `tee()`: you read your copy as usual and meter reads the other, then logs the call when the stream ends. It takes usage from Anthropic's `message_start` and `message_delta` events, OpenAI's final Chat Completions chunk, and the Responses API's `response.completed` event. For OpenAI Chat Completions, send `stream_options: { include_usage: true }`, or the stream has no usage and the call is logged with a note saying so. An `error` event or a dropped connection logs the call as failed, with whatever usage arrived before it. Call `await meter.flush()` before exiting so streams still being read get logged.
- `meter.record({ provider, model, usage, tag, ok, outputId?, cost? })` logs a call you measured yourself. `usage` takes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `images` and `seconds`. Pass `cost` to skip the price table.
- `meter.keep(tag, outputId)` marks an output as kept. Anything never kept counts as discarded.
- `meter.budget({ tag?, perDay, action?, onExceed? })` sets a daily spend limit in USD for one tag (or every tag when `tag` is left out). It counts what the log already holds for today, then each new call. When spend reaches `perDay` it warns once per day (`console.warn`, or your `onExceed`). With `action: "throw"`, every later `meter.fetch` on that tag throws `BudgetError` before sending. For calls you log with `record`, call `budget.check()` first; it throws the same way. `budget.status()` returns `{ spent, remaining, exceeded }`.
- `import { meter } from "@numbercutter/meter"` gives a shared instance that logs to `$METER_LOG` or `./meter.jsonl`.

Give every call in one attempt the same `outputId` (prompt, render, critic) and give a retry from scratch a new one. That is what lets the report say how much of the spend went to outputs you threw away.

### Report

```sh
meter report --by tag|model|day [--log meter.jsonl] [--prices overrides.json] [--since 2026-11-01] [--tag name] [--json] [--html out.html]
meter prices [provider/model]
```

| column | meaning |
|---|---|
| `spend` | Cost of every call in the group, successful or not. |
| `failed` | Calls that errored or returned non-2xx. |
| `kept` | Distinct outputs marked with `keep`. |
| `cost/kept` | `spend / kept`. The number to watch. |
| `wasted` | Share of spend on calls whose `outputId` was never kept. `-` when calls carry no `outputId`. |
| `cache saved` | What cache reads saved against the full input price, minus what cache writes cost over it. Shown only when there is caching. Negative means writes that were never read back enough to pay off. |

By `model` and `day`, an output counts as kept for a group when one of that group's calls produced it.

### Prices

`prices.json` holds USD per million input and output tokens, and per-image and per-second rates for media. Cached tokens are priced separately: `cache_read` for cached input (Anthropic cache reads, OpenAI `cached_tokens`), `cache_write` for Anthropic's 5-minute cache writes and `cache_write_1h` for its 1-hour writes, which the API reports apart in `usage.cache_creation`. OpenAI caches automatically and bills no writes, so its entries carry `cache_write: 0`. It has an `asOf` date, and some entries carry their own. **Prices change. Check each one you rely on against the provider's pricing page.** Override or add models without editing the file:

```ts
createMeter({ prices: { "openai/sora-2": { second: 0.3 }, "acme/upscaler-v2": { image: 0.01 } } });
```

```sh
meter report --prices examples/prices.override.json
```

Model ids match exactly first, then by the longest prefix, so `openai/gpt-4o-mini-2024-07-18` uses `openai/gpt-4o-mini`. The report re-prices logged usage with the current table, so fixing a price fixes old reports too. Calls with no matching price are left out of spend and listed under the table.

## How it works

Each call and each keep is one line in an append-only JSONL file. The report reads the whole file, prices each call from its usage, groups calls, and joins keeps by `(tag, outputId)`. There is no server or database.

## Limits

- Tiered prices (long-context rates, batch discounts, image quality and size tiers, regional rates) are not modelled. Set an override or pass `cost`.
- A failed call that the provider still bills shows as $0 unless its body reports usage.
- A stream your code abandons before the end is logged with the usage seen so far, which for Anthropic means output tokens up to the last `message_delta`. Streams from other providers are logged with no usage.
- Budgets count days in UTC and only see calls that go through this meter (and what the log held when the day started). Two processes sharing one log each keep their own running total.
- The log is a plain file written with synchronous appends. Many processes writing the same file at once can interleave lines.
- The report loads the whole log into memory.
- The bundled prices are a place to start, not a source of truth.

Works with [glass](https://github.com/numbercutter/glass) to see the steps behind an expensive output, and [sieve](https://github.com/numbercutter/sieve) to stop prompts that should never be paid for.

<sub>A numbercutter instrument · MIT</sub>
