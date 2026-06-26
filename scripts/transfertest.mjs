// Deterministic test for the INTELLIGENCE TRANSFER ENGINE (P1) — mirrors src/lib/transfer.ts.
// The decision is "which prior buyer intelligence can I SAFELY reuse for THIS requirement?" — tiered,
// NOT binary. A (who they are) always · B (how they buy) usually · C (what they source) only when related
// · D (product specs) never. Relatedness (0-100) gates ONLY Tier C. NO LLM, NO network.

const CATEGORY_TRANSFER_THRESHOLD = 50;
function decideTransfer(items, relatedness) {
  const r = Math.max(0, Math.min(100, Math.round(relatedness || 0)));
  const categoryTransfers = r >= CATEGORY_TRANSFER_THRESHOLD;
  const transfer = [], withhold = [];
  for (const it of items || []) {
    if (!it || !it.key) continue;
    const keep = it.tier === 'A' || it.tier === 'B' ? true : it.tier === 'C' ? categoryTransfers : false;
    (keep ? transfer : withhold).push(it);
  }
  return { transfer, withhold, relatedness: r, categoryTransfers };
}
function tierBuyerIntelligence(src) {
  const items = [];
  const add = (key, value, tier) => { const v = String(value ?? '').trim(); if (v && !/^(unknown|n\/?a|none|false)$/i.test(v)) items.push({ key, value: v, tier }); };
  const p = src.profile || {};
  add('business type', src.twinBusinessType || p.persona, 'A');
  add('nature', p.nature, 'A'); add('authority', p.authorityRole || p.authority, 'A'); add('maturity', p.maturity, 'A');
  add('region', src.region, 'A'); add('language', src.language, 'A'); add('entity type', src.entityType, 'A');
  if (src.verified) add('verified', 'GST/Udyam verified', 'A');
  add('procurement model', p.procurementModel, 'B'); add('buying pattern', p.buyingPattern, 'B'); add('sourcing style', p.sourcingStyle, 'B');
  add('decision style', p.decisionStyle, 'B'); add('info-seeking', p.infoSeeking, 'B'); add('supplier preference', p.supplierPreference, 'B');
  add('local preference', p.localityPreference, 'B'); add('communication', p.engagement, 'B'); add('response sensitivity', p.responseSensitivity, 'B');
  if (p.multiSku) add('multi-SKU', 'buys across categories', 'B');
  for (const c of src.historicalCategories || []) add(`history: ${c}`, c, 'C');
  for (const th of src.themes || []) add(`theme: ${th}`, th, 'C');
  for (const [k, v] of Object.entries(src.knownSpecs || {})) add(`spec: ${k}`, String(v), 'D');
  return items;
}
const STOP = new Set(['for', 'the', 'and', 'with', 'raw', 'material', 'materials']);
const tok = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
function categoryRelatedness(currentProduct, history, tokenize) {
  const cur = tokenize(currentProduct || ''); if (!cur.size) return 0;
  let best = 0;
  for (const h of history || []) { const ht = tokenize(h || ''); if (!ht.size) continue; const shared = [...cur].filter((t) => ht.has(t)).length; if (!shared) continue; best = Math.max(best, shared / Math.min(cur.size, ht.size)); }
  return Math.round(best * 100);
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const tierOf = (d, t) => d.transfer.filter((i) => i.tier === t);
const has = (list, key) => list.some((i) => i.key === key || i.value.toLowerCase().includes(key));

// Jaiveer the notebook manufacturer
const jaiveer = tierBuyerIntelligence({
  profile: { persona: 'Manufacturer', maturity: 'Existing Buyer', procurementModel: 'Recurring Supply', buyingPattern: 'inventory_builder', localityPreference: 'Local Only', responseSensitivity: 'Patient', multiSku: true },
  twinBusinessType: 'Manufacturer', region: 'Auraiya', language: 'Hindi', verified: true,
  historicalCategories: ['Notebook Making Machine', 'Exercise Notebook Raw Material'],
  knownSpecs: { 'Automation Grade': 'Semi-Automatic', 'GSM': '70' },
});

// ── tier assignment ──
ok('business type → Tier A', jaiveer.find((i) => i.key === 'business type')?.tier === 'A');
ok('region → Tier A', jaiveer.find((i) => i.key === 'region')?.tier === 'A');
ok('procurement model → Tier B', jaiveer.find((i) => i.key === 'procurement model')?.tier === 'B');
ok('local preference → Tier B', jaiveer.find((i) => i.key === 'local preference')?.tier === 'B');
ok('history category → Tier C', jaiveer.find((i) => i.key.startsWith('history:'))?.tier === 'C');
ok('a prior spec VALUE (GSM/Automation) → Tier D', jaiveer.filter((i) => i.tier === 'D').length === 2);
ok('Unknown/blank facts dropped', !jaiveer.some((i) => /^(unknown|n\/a)$/i.test(i.value)));

// ── Jaiveer → PAPER (related: notebook input). Relatedness high → category intel carries ──
const rPaper = Math.max(categoryRelatedness('Paper', ['Notebook Making Machine', 'Exercise Notebook Raw Material'], tok), 90 /* Buyer Story semantic core_input */);
const paper = decideTransfer(jaiveer, rPaper);
ok('PAPER: category intel CARRIES (related)', paper.categoryTransfers === true);
ok('PAPER: Tier C (notebook history) carries', tierOf(paper, 'C').length >= 1);
ok('PAPER: Tier A (manufacturer) carries', has(tierOf(paper, 'A'), 'manufacturer'));
ok('PAPER: product specs (GSM) STILL withheld (Tier D never portable)', paper.withhold.some((i) => i.tier === 'D'));

// ── Jaiveer → DIESEL GENERATOR (unrelated: plant overhead). Relatedness low → category intel WITHHELD,
//    but who-they-are + how-they-buy STILL carry (this is the whole point — no notebook leak, no muting). ──
const rGen = Math.max(categoryRelatedness('Diesel Generator', ['Notebook Making Machine', 'Exercise Notebook Raw Material'], tok), 25 /* Buyer Story: new/overhead */);
const gen = decideTransfer(jaiveer, rGen);
ok('GENERATOR: category intel WITHHELD (unrelated)', gen.categoryTransfers === false);
ok('GENERATOR: notebook history is WITHHELD (no category leak)', gen.transfer.every((i) => !i.key.startsWith('history:')));
ok('GENERATOR: Tier A (manufacturer · region · verified) STILL carries', tierOf(gen, 'A').length >= 3);
ok('GENERATOR: Tier B (procurement · locality · cadence) STILL carries', tierOf(gen, 'B').length >= 3);
ok('GENERATOR: the OLD binary mute would have dropped EVERYTHING — tiered keeps A+B', gen.transfer.length >= 6);
ok('GENERATOR: product specs never carry', gen.transfer.every((i) => i.tier !== 'D'));

// ── threshold + relatedness scorer ──
ok('threshold: relatedness 49 → C withheld', decideTransfer([{ key: 'history: x', value: 'x', tier: 'C' }], 49).categoryTransfers === false);
ok('threshold: relatedness 50 → C carries (boundary)', decideTransfer([{ key: 'history: x', value: 'x', tier: 'C' }], 50).categoryTransfers === true);
ok('relatedness: "paper" vs "Writing Paper" overlaps (lexical catches the literal case)', categoryRelatedness('Paper', ['Writing Paper'], tok) >= 50);
ok('relatedness: "Diesel Generator" vs notebook history → 0 (lexical miss, needs semantic)', categoryRelatedness('Diesel Generator', ['Notebook Making Machine', 'Exercise Notebook Raw Material'], tok) === 0);
ok('relatedness clamps 0..100', decideTransfer([], 999).relatedness === 100 && decideTransfer([], -5).relatedness === 0);

// ── cold buyer: nothing to transfer, no crash ──
ok('cold buyer (no intelligence) → empty transfer, no crash', (() => { const d = decideTransfer(tierBuyerIntelligence({}), 0); return d.transfer.length === 0 && d.withhold.length === 0; })());

// ════ THE 4 STRUCTURAL-SOUNDNESS CASES (the reviewer's checklist) ════
// IIT Kanpur — an academic/research institution: authority=Researcher (Tier A), research procurement history.
const iitk = tierBuyerIntelligence({
  profile: { persona: 'Institution', nature: 'Academic / Research Institution', authorityRole: 'Researcher', maturity: 'Existing Buyer', localityPreference: 'No Preference', decisionStyle: 'Self Driven' },
  twinBusinessType: 'Research Institution', region: 'Kanpur', verified: true,
  historicalCategories: ['Lab Equipment', 'Research Instruments', 'Laboratory Chemicals'],
  knownSpecs: { 'Accuracy Class': '0.1%' },
});
const researcherCarries = (d) => d.transfer.some((i) => /researcher/i.test(i.value));

// Case 1 — Jaiveer · Paper → A+B+C transfer
ok('CASE 1 — Jaiveer · Paper → A+B+C all transfer', paper.categoryTransfers && tierOf(paper, 'A').length && tierOf(paper, 'B').length && tierOf(paper, 'C').length > 0);
// Case 2 — Jaiveer · Diesel Generator → A+B only (C withheld, no notebook leak)
ok('CASE 2 — Jaiveer · Diesel Generator → A+B only (C withheld)', !gen.categoryTransfers && tierOf(gen, 'A').length && tierOf(gen, 'B').length && tierOf(gen, 'C').length === 0);
// Case 3 — IIT Kanpur · Lab Equipment → researcher transfers AND category intel carries (research procurement)
const iitkLab = decideTransfer(iitk, Math.max(categoryRelatedness('Lab Equipment', ['Lab Equipment', 'Research Instruments', 'Laboratory Chemicals'], tok), 85));
ok('CASE 3 — IIT-K · Lab Equipment → Researcher transfers + category intel carries', researcherCarries(iitkLab) && iitkLab.categoryTransfers);
// Case 4 — IIT Kanpur · Office Chair → researcher STILL transfers (Tier A is always), but category intel
//   is WITHHELD (a chair isn't research procurement). NB: "researcher must not DOMINATE" is the CONSUMPTION
//   layer's job (relevance weighting) — the transfer layer correctly carries it without letting it lead.
const iitkChair = decideTransfer(iitk, Math.max(categoryRelatedness('Office Chair', ['Lab Equipment', 'Research Instruments', 'Laboratory Chemicals'], tok), 15));
ok('CASE 4 — IIT-K · Office Chair → Researcher carries (A always) but category intel WITHHELD', researcherCarries(iitkChair) && !iitkChair.categoryTransfers);
ok('CASE 4 — research-specific Tier-C history is NOT leaked onto an office chair', iitkChair.transfer.every((i) => !i.key.startsWith('history:')));
ok('CASE 4 — the product-spec (Accuracy Class) never leaks to a chair (Tier D)', iitkChair.transfer.every((i) => i.tier !== 'D'));

console.log(`\ntransfertest (P1 Intelligence Transfer: A always · B usually · C if-related · D never · relatedness gates only C): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
