// Deterministic test for P (Quick Re-post) — mirrors RFQModalV3.tsx priorRequirements()
// (build "Buy again" cards from enrichment.categories) + the spec-drift mapping that decides,
// per prior spec, whether it MATCHES a current ISQ spec (prefill that chip) or is CUSTOM-added
// (drift → rendered with an "added from your [date] order" badge). NO LLM, NO network.
// GENERIC token-overlap matching — NO category literals (standing rule).

// ── coreTokens mirror (src/lib/enrichment.ts): ≥3 chars + plural-stem + function-word stopwords ──
const STOP = new Set(['for', 'the', 'and', 'with', 'from', 'your', 'our', 'this', 'that', 'any', 'all', 'per', 'via', 'new', 'use']);
const singularize = (w) => {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
};
const toks = (s) => {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(singularize(w));
  }
  return out;
};

// ── priorRequirements mirror: de-dup by title, merge specs, richest source + earliest recency, recency-sorted, cap 6 ──
function priorRequirements(categories) {
  const byTitle = new Map();
  const rank = (s) => (s === 'isq' ? 3 : s === 'call' ? 2 : 1);
  for (const c of categories || []) {
    const title = (c.mcat || '').trim();
    if (!title) continue;
    const specs = { ...(c.isqAnswers || {}), ...(c.knownSpecs || {}) };
    const key = title.toLowerCase();
    const prev = byTitle.get(key);
    const mergedSpecs = { ...(prev ? prev.specs : {}), ...specs };
    const recency = [prev && prev.recencyDays, c.recencyDays].filter((x) => typeof x === 'number');
    byTitle.set(key, {
      title: prev ? prev.title : title,
      source: !prev || rank(c.source) > rank(prev.source) ? c.source : prev.source,
      recencyDays: recency.length ? Math.min(...recency) : undefined,
      specs: mergedSpecs,
      specCount: Object.keys(mergedSpecs).length,
    });
  }
  return [...byTitle.values()]
    .sort((a, b) => (a.recencyDays ?? 1e9) - (b.recencyDays ?? 1e9) || b.specCount - a.specCount)
    .slice(0, 6);
}

// ── spec-drift matching mirror: a prior spec matches a current ISQ spec on shared core tokens;
//    the current spec with the MOST shared tokens wins; 0 shared → custom-added (drift). ──
function matchPriorSpec(priorName, currentNames) {
  const p = toks(priorName);
  if (!p.size) return null;
  let best = null, bestN = 0;
  for (const cn of currentNames) {
    const overlap = [...toks(cn)].filter((t) => p.has(t)).length;
    if (overlap > bestN) { bestN = overlap; best = cn; }
  }
  return bestN > 0 ? best : null;
}
function driftMap(priorSpecs, currentISQNames) {
  const matched = [], custom = [];
  const used = new Set();
  for (const [name, value] of Object.entries(priorSpecs)) {
    const m = matchPriorSpec(name, currentISQNames.filter((c) => !used.has(c)));
    if (m) { matched.push({ current: m, value }); used.add(m); }
    else custom.push({ name, value });
  }
  return { matched, custom };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── priorRequirements ──
const cats = [
  { mcat: 'Cable Lug', source: 'isq', recencyDays: 20, isqAnswers: { 'Material': 'Copper', 'Size': '25 sqmm' } },
  { mcat: 'Cable Lug', source: 'buylead', recencyDays: 60 }, // older bare BL — same title, merge, keep recent face
  { mcat: 'PVC Resin', source: 'buylead', recencyDays: 5 },
  { mcat: 'TMT Bar', source: 'isq', recencyDays: 90, isqAnswers: { 'Grade': 'Fe500', 'Diameter': '12 mm' } },
  { mcat: '', source: 'isq' }, // empty title → dropped
];
const prs = priorRequirements(cats);
ok('de-dups by title (Cable Lug appears once)', prs.filter((p) => p.title === 'Cable Lug').length === 1);
ok('drops empty-title records', prs.every((p) => p.title));
ok('recency-sorted (PVC Resin @5d first)', prs[0].title === 'PVC Resin');
ok('Cable Lug keeps the most-recent recency (20, not 60)', prs.find((p) => p.title === 'Cable Lug').recencyDays === 20);
ok('Cable Lug carries the ISQ specs (Material+Size)', prs.find((p) => p.title === 'Cable Lug').specCount === 2);
ok('bare BL (no specs) still listed', prs.some((p) => p.title === 'PVC Resin' && p.specCount === 0));

// cap at 6
const many = Array.from({ length: 10 }, (_, i) => ({ mcat: `Prod ${i}`, source: 'buylead', recencyDays: i }));
ok('caps at 6 cards', priorRequirements(many).length === 6);
ok('no prior requirements → empty list (cold buyer)', priorRequirements([]).length === 0);

// ── spec-drift mapping ──
// Prior order had Material/Size/Brand; the CURRENT ISQ schema for this category exposes
// Conductor Material / Cable Size / Insulation. Material→Conductor Material, Size→Cable Size match;
// Brand has no token overlap → custom-added (drift, badge).
const drift = driftMap(
  { 'Material': 'Copper', 'Size': '25 sqmm', 'Brand': 'Polycab' },
  ['Conductor Material', 'Cable Size', 'Insulation Type']
);
ok('prior "Material" → current "Conductor Material"', drift.matched.some((m) => m.current === 'Conductor Material' && m.value === 'Copper'));
ok('prior "Size" → current "Cable Size"', drift.matched.some((m) => m.current === 'Cable Size' && m.value === '25 sqmm'));
ok('prior "Brand" (no overlap) → custom-added', drift.custom.some((c) => c.name === 'Brand' && c.value === 'Polycab'));
ok('exactly 2 matched, 1 custom', drift.matched.length === 2 && drift.custom.length === 1);

// one current spec is not double-claimed by two prior specs
const drift2 = driftMap(
  { 'Material': 'Copper', 'Body Material': 'Brass' },
  ['Material']
);
ok('one current spec claimed by only ONE prior spec (no double-map)', drift2.matched.length === 1 && drift2.custom.length === 1);

// all-custom when the current schema shares no tokens (different category entirely)
const drift3 = driftMap({ 'Grade': 'Fe500', 'Diameter': '12 mm' }, ['Voltage', 'Phase']);
ok('no overlap at all → everything custom-added', drift3.matched.length === 0 && drift3.custom.length === 2);

// plural-stem: prior "Bolts" matches current "Bolt Count" (singularize)
const drift4 = driftMap({ 'Bolts': '4' }, ['Bolt Count', 'Finish']);
ok('plural-stem match: "Bolts" → "Bolt Count"', drift4.matched.some((m) => m.current === 'Bolt Count'));

console.log(`\nrepostflowtest (P: priorRequirements + spec-drift mapping): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
