// ─── SEQUENTIAL CATEGORY PREWARM (ops tool · no n8n change) ───────────────────────────────────
// The audits proved: concurrent category builds STALL (only one finishes); they must be built ONE
// AT A TIME. This is the production prewarm pattern — feed a list of mcats, it skips already-warm
// ones and builds cold ones sequentially, reporting progress + a final reliability summary.
// Usage: node scripts/tools/prewarm.mjs 13467 122454 179993 ...   (or a file of ids, one per line)
import { readFileSync } from 'fs';

const BASE = 'https://imworkflow.intermesh.net/webhook/bi-user-insights-v10x';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const fileArg = args.find((a) => a.endsWith('.txt') || a.endsWith('.csv'));
let mcats = args.filter((a) => /^\d+$/.test(a));
if (fileArg) mcats = mcats.concat(readFileSync(fileArg, 'utf8').split(/\s+/).filter((x) => /^\d+$/.test(x)));
mcats = [...new Set(mcats)];
if (!mcats.length) { console.log('usage: node prewarm.mjs <mcat> [<mcat> ...] [ids.txt]'); process.exit(1); }

async function read(mcat) {
  try {
    const r = await fetch(`${BASE}?mode=category&mcat_id=${mcat}`, { signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    const it = Array.isArray(j) ? (j.find((x) => x && (x.category_insights !== undefined || x.category_cache !== undefined)) || j[0]) : j;
    let ins = it?.category_insights ?? null;
    if (typeof ins === 'string') { try { ins = JSON.parse(ins); } catch { ins = null; } }
    return { cache: it?.category_cache, ins };
  } catch { return { cache: 'error', ins: null }; }
}

let warmed = 0, skipped = 0, failed = 0;
console.log(`▸ prewarming ${mcats.length} categories SEQUENTIALLY (concurrent builds stall)\n`);
for (const [i, mcat] of mcats.entries()) {
  const pre = await read(mcat);
  if (pre.ins) { skipped++; console.log(`[${i + 1}/${mcats.length}] ${mcat} · already warm (${pre.ins.calls_analyzed ?? '?'} calls · conf ${pre.ins.category_confidence?.score ?? '—'}) — skip`); continue; }
  try { await fetch(`${BASE}?mode=build_category&mcat_id=${mcat}&fresh=1`, { signal: AbortSignal.timeout(20000) }); } catch { /* fire-and-forget */ }
  let done = false;
  for (let p = 0; p < 14; p++) {
    await sleep(22000);
    const r = await read(mcat);
    process.stdout.write(`\r[${i + 1}/${mcats.length}] ${mcat} · building ${(p + 1) * 22}s   `);
    if (r.ins) { warmed++; done = true; console.log(`\r[${i + 1}/${mcats.length}] ${mcat} · ✓ built (${r.ins.calls_analyzed ?? '?'} calls · conf ${r.ins.category_confidence?.score ?? '—'} ${r.ins.category_confidence?.band ?? ''})        `); break; }
  }
  if (!done) { failed++; console.log(`\r[${i + 1}/${mcats.length}] ${mcat} · ✗ not built after ~5 min (cold/slow/empty)        `); }
}
console.log(`\n═══ prewarm done · warmed ${warmed} · already-warm ${skipped} · failed ${failed} / ${mcats.length} ═══`);
