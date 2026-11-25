#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { defaultPrices, findPrice, loadPriceFile, mergePrices, pricesAsOf } from "./prices";
import { renderHtml } from "./html";
import { buildReport, formatReport, readLog, type GroupBy } from "./report";

const usage = `meter: the real cost of every kept output.

  meter report [--by tag|model|day] [--log meter.jsonl] [--prices overrides.json]
               [--since YYYY-MM-DD] [--tag name] [--json] [--html out.html]
  meter prices [provider/model] [--prices overrides.json]

The log defaults to $METER_LOG or ./meter.jsonl.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    by: { type: "string", default: "tag" },
    log: { type: "string" },
    prices: { type: "string" },
    since: { type: "string" },
    tag: { type: "string" },
    json: { type: "boolean", default: false },
    html: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(msg: string): never {
  console.error(`meter: ${msg}`);
  process.exit(1);
}

const [command, arg] = positionals;
if (values.help || !command) {
  console.log(usage);
  process.exit(command || values.help ? 0 : 1);
}

const prices = mergePrices(defaultPrices, values.prices ? await loadPriceFile(values.prices).catch((e) => fail(`could not read ${values.prices}: ${e.message}`)) : undefined);

if (command === "report") {
  const by = values.by as GroupBy;
  if (!["tag", "model", "day"].includes(by)) fail("--by must be tag, model or day");
  const log = values.log ?? process.env.METER_LOG ?? "meter.jsonl";
  const entries = await readLog(log).catch((e) => fail(e.message));
  const filter = { since: values.since, tag: values.tag };
  const report = buildReport(entries, by, prices, filter);
  if (values.html) {
    const html = renderHtml({
      byDay: buildReport(entries, "day", prices, filter),
      byTag: buildReport(entries, "tag", prices, filter),
      byModel: buildReport(entries, "model", prices, filter),
      pricesAsOf,
      source: log,
      generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    });
    await Bun.write(values.html, html);
    console.error(`Wrote ${values.html}`);
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
    console.log(`\ncost/kept = all spend for the group, failed and discarded attempts included, divided by kept outputs.`);
    console.log(`Prices as of ${pricesAsOf}${values.prices ? ` with overrides from ${values.prices}` : ""}. Verify them before you rely on these numbers.`);
  }
} else if (command === "prices") {
  if (arg) {
    const [provider, ...rest] = arg.split("/");
    const found = findPrice(prices, provider, rest.join("/"));
    if (!found) fail(`no price for ${arg}`);
    console.log(JSON.stringify({ [found.key]: found.price }, null, 2));
  } else {
    console.log(`asOf ${pricesAsOf}. Text: USD per million tokens. image: USD each. second: USD per second.\n`);
    for (const [k, p] of Object.entries(prices)) {
      const parts = Object.entries(p).filter(([f]) => f !== "asOf").map(([f, v]) => `${f} ${v}`);
      console.log(`${k.padEnd(32)} ${parts.join(", ")}${p.asOf ? `  (checked ${p.asOf})` : ""}`);
    }
  }
} else {
  fail(`unknown command ${command}\n\n${usage}`);
}
