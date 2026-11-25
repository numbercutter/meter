import { pct, signedUsd, usd, type Report, type Row } from "./report";

const BASE = "#18181B";
const POP = "#EF4444";
const TINT = "#979798";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function days(byDay: Report) {
  const spend = new Map(byDay.rows.map((r) => [r.group, r]));
  if (!byDay.rows.length) return [];
  const out: { day: string; spend: number; wasted: number }[] = [];
  const last = byDay.rows[byDay.rows.length - 1].group;
  for (let d = byDay.rows[0].group; d <= last; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    const r = spend.get(d);
    out.push({ day: d, spend: r?.spend ?? 0, wasted: r ? r.spend * (r.wasted_share ?? 0) : 0 });
    if (out.length > 400) break;
  }
  return out;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v)!;
}

function chart(byDay: Report) {
  const data = days(byDay);
  if (!data.length) return `<p class="muted">No calls in range.</p>`;
  const w = 880;
  const h = 260;
  const left = 64;
  const bottom = 40;
  const top = 16;
  const plotW = w - left - 16;
  const plotH = h - top - bottom;
  const max = niceMax(Math.max(...data.map((d) => d.spend)));
  const slot = plotW / data.length;
  const bar = Math.max(2, Math.min(48, slot * 0.7));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(data.length / 12);
  const parts = [
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Spend per day, split into spend on kept outputs and spend on discarded attempts" xmlns="http://www.w3.org/2000/svg">`,
    ...ticks.map((t) => `<line x1="${left}" x2="${w - 16}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${TINT}" stroke-opacity="0.18"/><text x="${left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" class="tick">$${t.toFixed(max >= 1 ? 2 : max >= 0.01 ? 3 : 5)}</text>`),
  ];
  data.forEach((d, i) => {
    const x = left + i * slot + (slot - bar) / 2;
    const kept = d.spend - d.wasted;
    const title = `<title>${d.day}: ${usd(d.spend)} spent, ${usd(d.wasted)} on discarded attempts</title>`;
    parts.push(`<g>${title}<rect x="${x.toFixed(1)}" y="${y(d.spend).toFixed(1)}" width="${bar.toFixed(1)}" height="${(y(kept) - y(d.spend)).toFixed(1)}" fill="${POP}"/><rect x="${x.toFixed(1)}" y="${y(kept).toFixed(1)}" width="${bar.toFixed(1)}" height="${(y(0) - y(kept)).toFixed(1)}" fill="${POP}" fill-opacity="0.35"/></g>`);
    if (i % labelEvery === 0) parts.push(`<text x="${(x + bar / 2).toFixed(1)}" y="${h - bottom + 18}" text-anchor="middle" class="tick">${d.day.slice(5)}</text>`);
  });
  parts.push(`<line x1="${left}" x2="${w - 16}" y1="${y(0)}" y2="${y(0)}" stroke="${TINT}" stroke-opacity="0.5"/></svg>`);
  return parts.join("");
}

function table(r: Report) {
  const cache = r.rows.some((x) => Math.abs(x.cache_saved) > 0.00005);
  const head = [r.by, "calls", "failed", "spend", "kept", "cost/kept", "wasted", ...(cache ? ["cache saved"] : [])];
  const cells = (x: Row) => [x.group, String(x.calls), String(x.failed), usd(x.spend), String(x.kept), usd(x.cost_per_kept), pct(x.wasted_share), ...(cache ? [signedUsd(x.cache_saved)] : [])];
  const row = (c: string[], tag = "td") => `<tr>${c.map((v, i) => `<${tag}${i === 5 ? ' class="key"' : ""}>${esc(v)}</${tag}>`).join("")}</tr>`;
  return `<table><thead>${row(head, "th")}</thead><tbody>${r.rows.map((x) => row(cells(x))).join("")}</tbody><tfoot>${row(cells(r.total))}</tfoot></table>`;
}

export function renderHtml(o: { byDay: Report; byTag: Report; byModel: Report; pricesAsOf: string; source: string; generated: string }) {
  const t = o.byTag.total;
  const stat = (label: string, value: string) => `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  const unpriced = o.byTag.unpriced_models.length ? `<p class="muted">No price for ${esc(o.byTag.unpriced_models.join(", "))}. Those calls are left out of spend.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meter report</title>
<style>
:root{--base:${BASE};--pop:${POP};--tint:${TINT};--text:#F4F4F5}
*{box-sizing:border-box}
body{margin:0;background:var(--base);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}
header{display:flex;align-items:center;gap:16px;margin-bottom:8px}
h1{font:700 32px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--pop);margin:0}
h2{font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--tint);text-transform:lowercase;margin:40px 0 12px}
.muted{color:var(--tint)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.stat{border:1px solid #38383B;border-radius:12px;padding:14px 16px}
.stat .v{font:700 24px ui-monospace,SFMono-Regular,Menlo,monospace}
.stat .l{color:var(--tint);font-size:13px}
.stat.key .v{color:var(--pop)}
svg{width:100%;height:auto;display:block}
svg .tick{fill:var(--tint);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
.legend{display:flex;gap:16px;color:var(--tint);font-size:13px;margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--pop);margin-right:6px;vertical-align:-1px}
.legend i.soft{opacity:.35}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid #2A2A2E;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--tint);font-weight:400}
td.key{color:var(--pop);font-weight:700}
tfoot td{border-top:1px solid var(--tint);border-bottom:0;font-weight:700}
footer{margin-top:40px;color:var(--tint);font-size:13px}
</style>
</head>
<body>
<main>
<header>
<svg width="48" height="48" viewBox="0 0 64 64" aria-hidden="true" style="width:48px;flex:none"><path d="M14 0 H46 L64 18 V50 Q64 64 50 64 H14 Q0 64 0 50 V14 Q0 0 14 0 Z" fill="${BASE}" stroke="#38383B" stroke-width="1.5"/><path d="M16.96 42.47 A16 16 0 1 1 47.04 42.47" fill="none" stroke="${POP}" stroke-width="5" stroke-linecap="round"/><path d="M32 37 L39.71 27.81" stroke="${POP}" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="37" r="4" fill="${POP}"/></svg>
<h1>meter</h1>
</header>
<p class="muted">What every kept output really cost. ${esc(o.source)}, generated ${esc(o.generated)}.</p>
<div class="stats">
${stat("spend", usd(t.spend))}
${stat("kept outputs", String(t.kept))}
<div class="stat key"><div class="v">${esc(usd(t.cost_per_kept))}</div><div class="l">cost per kept output</div></div>
${stat("spend on discarded attempts", pct(t.wasted_share))}
${stat("calls, failed", `${t.calls}, ${t.failed}`)}
</div>
<h2>spend per day</h2>
${chart(o.byDay)}
<div class="legend"><span><i></i>discarded attempts</span><span><i class="soft"></i>kept outputs</span></div>
<h2>cost per kept output, by tag</h2>
<div class="scroll">${table(o.byTag)}</div>
<h2>by model</h2>
<div class="scroll">${table(o.byModel)}</div>
${unpriced}
<footer>cost/kept is all spend for the group, failed and discarded attempts included, divided by kept outputs. Prices as of ${esc(o.pricesAsOf)}; verify them before relying on these numbers.</footer>
</main>
</body>
</html>
`;
}
