// Contract test for Source Distillation (P5) — mirrors src/lib/distill.ts (repo harness pattern).
// Proves WA/PNS/CSL channel signals fuse into ranked human THEMES (not raw counts), de-dup across
// channels (case-insensitive), recent clusters outrank baseline, and empty input is crash-safe.

const tslug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function distillSourceThemes(input, max = 3) {
  const weights = new Map();
  const add = (raw, weight) => {
    const label = (raw || '').trim();
    const key = tslug(label);
    if (!key) return;
    const cur = weights.get(key);
    if (cur) cur.weight += weight; else weights.set(key, { label, weight });
  };
  let sourceCount = 0;
  for (const c of input.recentClusters || []) { const sc = Math.max(1, c.signal_count || 1); add(c.intent, 3 * sc); sourceCount += sc; }
  for (const [intent, count] of Object.entries(input.intentHistory || {})) { const c = Math.max(1, Number(count) || 1); add(intent, c); sourceCount += c; }
  for (const cat of input.historicalCategories || []) add(cat, 2);
  const ranked = [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, max)).map((x) => x.label);
  return { themes: ranked, line: ranked.join(' · '), sourceCount };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the canonical case: counts → themes ──
const d = distillSourceThemes({
  recentClusters: [{ intent: 'Industrial Chemicals', signal_count: 8 }, { intent: 'Cleaning Supplies', signal_count: 3 }],
  historicalCategories: ['Automotive Care', 'Industrial Chemicals'],
  intentHistory: { 'Industrial Chemicals': 5 },
});
ok('produces human themes (not raw counts)', d.themes.length > 0 && /Industrial Chemicals/.test(d.line));
ok('line is " · "-joined', d.line.includes(' · '));
ok('top theme = highest-weight (Industrial Chemicals)', d.themes[0] === 'Industrial Chemicals');
ok('de-dups across channels (Industrial Chemicals appears once)', d.themes.filter((t) => t === 'Industrial Chemicals').length === 1);
ok('folds in source signals for "distilled from N"', d.sourceCount >= 16);

// ── case-insensitive / punctuation de-dup across channels ──
const dd = distillSourceThemes({ recentClusters: [{ intent: 'Industrial Chemicals', signal_count: 2 }], historicalCategories: ['industrial-chemicals', 'INDUSTRIAL CHEMICALS'] });
ok('case/punct variants collapse to ONE theme', dd.themes.length === 1 && dd.themes[0] === 'Industrial Chemicals');

// ── fusion: themes still surface when recent clusters are EMPTY (the gap the inline version had) ──
const histOnly = distillSourceThemes({ recentClusters: [], historicalCategories: ['Packaging Film', 'PVC Resin'] });
ok('no recent clusters → still themes from historical categories', histOnly.themes.length === 2);
const intentOnly = distillSourceThemes({ intentHistory: { 'Solar Panels': 4, 'Inverters': 1 } });
ok('intent-history alone → themes, ranked by count', intentOnly.themes[0] === 'Solar Panels');

// ── recent clusters OUTRANK baseline history (recency wins) ──
const rank = distillSourceThemes({ recentClusters: [{ intent: 'Forklifts', signal_count: 2 }], intentHistory: { 'Office Chairs': 3 } });
ok('recent cluster (weight 3×2=6) outranks a higher raw baseline count (3)', rank.themes[0] === 'Forklifts');

// ── cap + crash-safety ──
ok('respects max cap', distillSourceThemes({ historicalCategories: ['A', 'B', 'C', 'D', 'E'] }, 3).themes.length === 3);
ok('empty input → empty themes, no crash', (() => { const r = distillSourceThemes({}); return r.themes.length === 0 && r.line === '' && r.sourceCount === 0; })());
ok('garbage/blank labels ignored', distillSourceThemes({ historicalCategories: ['', '   ', null] }).themes.length === 0);

console.log(`\ndistillthemestest (WA/PNS/CSL → fused human themes · cross-channel de-dup · recency-ranked · crash-safe): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
