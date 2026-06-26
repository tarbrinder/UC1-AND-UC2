// ─── CATEGORY QUALITY INSPECTOR (ops tool · NOT part of the test suite) ───────────────────────
// Reads the cached category intelligence for N mcats and dumps the layers a buyer-twin planner
// consumes — critical_specs / deal_blockers / intent_patterns / common_followups / price bands —
// plus a quality heuristic. This is the "validate the INPUTS before building fusion on top" tool
// (B1a): if these aren't strong seller questions, no amount of buyer×category fusion will help.
//
// Read-only (mode=category) — never triggers a build. Lives in scripts/tools/ so the suite runner
// (scripts/*.mjs) doesn't pick it up.
//
// Usage:
//   node scripts/tools/categoryquality.mjs 13467
//   node scripts/tools/categoryquality.mjs 13467:"Diesel Generator" 11223:"Hair Wax"
//   node scripts/tools/categoryquality.mjs --json 13467   (machine-readable dump)

const BASE = 'https://imworkflow.intermesh.net/webhook/bi-user-insights-v10x';
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const doWarm = argv.includes('--warm'); // fire build + poll each mcat SEQUENTIALLY (concurrent builds stall) before inspecting
const targets = argv.filter((a) => a !== '--json' && a !== '--warm').map((a) => {
  const i = a.indexOf(':');
  return i > 0 ? { mcat: a.slice(0, i), label: a.slice(i + 1).replace(/^"|"$/g, '') } : { mcat: a, label: '' };
});
if (!targets.length) {
  console.log('usage: node scripts/tools/categoryquality.mjs <mcat[:"label"]> ...  [--json]');
  process.exit(0);
}

async function readCategory(mcat) {
  try {
    const r = await fetch(`${BASE}?mode=category&mcat_id=${encodeURIComponent(mcat)}`, { signal: AbortSignal.timeout(30000) });
    const raw = await r.json();
    const item = Array.isArray(raw) ? raw.find((x) => x && (x.category_insights !== undefined || x.category_cache !== undefined)) : raw;
    let ci = item?.category_insights ?? null;
    if (typeof ci === 'string') { try { ci = JSON.parse(ci); } catch { ci = null; } }
    return { cache: item?.category_cache || '?', insights: ci };
  } catch (e) { return { cache: 'error: ' + e.message, insights: null }; }
}

// Heuristic: are these REAL seller-qualifying questions, ranked, mapped, evidence-backed?
function rubric(ci) {
  const cs = Array.isArray(ci?.critical_specs) ? ci.critical_specs : [];
  const ip = Array.isArray(ci?.intent_patterns) ? ci.intent_patterns : [];
  const db = Array.isArray(ci?.deal_blockers) ? ci.deal_blockers : [];
  const price = ci?.price_distribution_inr;
  const issues = [];
  if (cs.length < 4) issues.push(`thin critical_specs (${cs.length}, want ≥4)`);
  const ranked = cs.every((c, i) => i === 0 || (cs[i - 1].seller_frequency ?? 0) >= (c.seller_frequency ?? 0));
  if (cs.length > 1 && !ranked) issues.push('critical_specs NOT freq-ranked');
  const mapped = cs.filter((c) => c.maps_to_isq && String(c.maps_to_isq).trim()).length;
  if (cs.length && mapped < cs.length * 0.5) issues.push(`weak ISQ mapping (${mapped}/${cs.length})`);
  const withFreq = cs.filter((c) => typeof c.seller_frequency === 'number' && c.seller_frequency > 0).length;
  if (cs.length && withFreq < cs.length * 0.5) issues.push(`missing seller_frequency (${cs.length - withFreq})`);
  if (!ip.length) issues.push('no intent_patterns');
  if (!db.length) issues.push('no deal_blockers');
  const priceOk = price && Number(price.max) > 0 && Number(price.max) > Number(price.min || 0);
  if (!priceOk) issues.push('no usable price_distribution');
  const score = Math.max(0, 10 - issues.length * 1.5);
  return { score: Math.round(score * 10) / 10, issues, counts: { critical_specs: cs.length, intent_patterns: ip.length, deal_blockers: db.length, mappedISQ: mapped, withFreq } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Warm ONE category: fire a fresh build, then poll the read until hit (concurrent builds stall, so
// callers must warm sequentially). Returns the final cache state.
async function warmOne(mcat) {
  try { await fetch(`${BASE}?mode=build_category&mcat_id=${encodeURIComponent(mcat)}&fresh=1`, { signal: AbortSignal.timeout(20000) }); } catch { /* kickoff is fire-and-forget */ }
  for (let i = 0; i < 14; i++) {
    await sleep(22000);
    const { cache } = await readCategory(mcat);
    process.stdout.write(`\r  warming ${mcat}: ${cache} (${(i + 1) * 22}s)   `);
    if (cache === 'hit') { process.stdout.write('\n'); return 'hit'; }
  }
  process.stdout.write('\n');
  return 'timeout';
}

const results = [];
for (const t of targets) {
  if (doWarm) { console.log(`▸ warming mcat ${t.mcat}${t.label ? ` (${t.label})` : ''} …`); await warmOne(t.mcat); }
  const { cache, insights } = await readCategory(t.mcat);
  results.push({ ...t, cache, insights });
}

if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

for (const r of results) {
  const head = `━━━ mcat ${r.mcat}${r.label ? ` · ${r.label}` : ''} · cache=${r.cache} ━━━`;
  console.log('\n' + head);
  if (!r.insights) { console.log('  (no insights — cold cache / build failed / error). Prewarm: ?mode=build_category&mcat_id=' + r.mcat + '&fresh=1'); continue; }
  const ci = r.insights;
  const rb = rubric(ci);
  console.log(`  QUALITY ${rb.score}/10` + (rb.issues.length ? `  ⚠ ${rb.issues.join(' · ')}` : '  ✓ clean') + (ci.salvaged ? '  · ⚠ SALVAGED (was truncated)' : ''));
  console.log(`  category_name: ${ci.category_name || '—'} · calls_analyzed: ${ci.calls_analyzed ?? '?'} · confidence: ${ci.confidence ?? '?'}`);
  const cs = (ci.critical_specs || []);
  console.log(`  critical_specs (${cs.length}) — the seller-qualifying questions, freq-ranked:`);
  cs.slice(0, 12).forEach((c, i) => console.log(`    ${String(i + 1).padStart(2)}. ${(c.name || '?').padEnd(28)} freq=${String(c.seller_frequency ?? '—').padStart(3)}  → ISQ: ${c.maps_to_isq || '(unmapped)'}`));
  const ip = (ci.intent_patterns || []);
  if (ip.length) console.log(`  intent_patterns (${ip.length}): ` + ip.slice(0, 6).map((p) => `${p.intent || p}${p.frequency ? `(${p.frequency})` : ''}`).join(' · '));
  const db = (ci.deal_blockers || []);
  if (db.length) console.log(`  deal_blockers (${db.length}): ` + db.slice(0, 6).map((b) => `${b.name || b}${b.frequency ? `(${b.frequency})` : ''}`).join(' · '));
  const cf = (ci.common_followups || []);
  if (cf.length) console.log(`  common_followups (${cf.length}): ` + cf.slice(0, 6).map((f) => (typeof f === 'string' ? f : f.question || f.maps_to_spec)).join(' · '));
  const p = ci.price_distribution_inr;
  if (p) console.log(`  price_distribution_inr: min=${p.min} median=${p.median} max=${p.max}`);
}

// ─── CATEGORY RELIABILITY DASHBOARD (ChatGPT #2): build · calls · quality · confidence · band ───
// One health view across categories. Reads the server-side category_confidence (v15) when present,
// else falls back to the local rubric. This is the category health monitor the audit surfaced a need for.
console.log('\n┌─ CATEGORY RELIABILITY DASHBOARD ' + '─'.repeat(46));
console.log('│ ' + 'Category'.padEnd(20) + 'Build'.padEnd(10) + 'Calls'.padEnd(7) + 'Quality'.padEnd(9) + 'Conf'.padEnd(6) + 'Band'.padEnd(11) + 'Age');
console.log('│ ' + '─'.repeat(70));
let built = 0;
for (const r of results) {
  const ci = r.insights || {};
  const ok = !!r.insights;
  if (ok) built++;
  const conf = ci.category_confidence; // v15 server-side
  const q = ok ? `${rubric(ci).score}/10` : '—';
  const build = ok ? (ci.salvaged ? 'salvaged' : 'hit') : (r.cache || 'cold');
  const confStr = conf && typeof conf.score === 'number' ? `${conf.score}` : '—';
  const band = conf?.band || (ok ? '(pre-v15)' : '—');
  const age = ci.cached_at ? `${Math.round((Date.now() - ci.cached_at) / 60000)}m` : '—';
  console.log('│ ' + String(r.label || r.mcat).slice(0, 19).padEnd(20) + build.padEnd(10) + String(ci.calls_analyzed ?? '?').padEnd(7) + q.padEnd(9) + confStr.padEnd(6) + band.padEnd(11) + age);
}
console.log('└' + '─'.repeat(78));
const scored = results.filter((r) => r.insights);
const avg = scored.length ? Math.round((scored.reduce((s, r) => s + rubric(r.insights).score, 0) / scored.length) * 10) / 10 : 0;
console.log(`Build reliability: ${built}/${results.length} cached · avg quality ${avg}/10` + (built < results.length ? `  ⚠ ${results.length - built} not built (cold/slow/failed)` : '  ✓ all built'));
