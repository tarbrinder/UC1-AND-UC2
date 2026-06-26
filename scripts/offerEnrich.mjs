// Deterministic test for the Offer-Enrichment engine (mirrors offerEnrich.ts). Proves: price/qty sanity (ports of
// absurd_quantity), the confidence GATE (high→apply · medium→suggest · low→keep raw), platform-leak counting
// (a cited platform fact is dropped + counted, never carried forward), hallucination counting, and the eval verdict.
// The LLM round-trip is the only async/env-gated piece and is NOT exercised here. `node scripts/offerEnrich.mjs`.

function parsePriceInr(s) {
  if (!s) return null;
  const t = String(s).replace(/,/g, '');
  const m = t.match(/\d[\d.]*/); if (!m) return null;
  const n = parseFloat(m[0]); if (!isFinite(n)) return null;
  if (/crore|\bcr\b/i.test(t)) return n * 1e7;
  if (/lakh|lac/i.test(t)) return n * 1e5;
  if (/\dk\b|\bk\b/i.test(t)) return n * 1e3;
  return n;
}
function quantitySanity(qty, viewedPrices = []) {
  if (!isFinite(qty) || qty <= 0) return { absurd: false, reason: '' };
  if (qty > 1000 && qty % 10 !== 0) return { absurd: true, reason: 'non-round bulk' };
  if (viewedPrices.some((p) => Math.abs(p - qty) < 1)) return { absurd: true, reason: 'price-as-quantity' };
  return { absurd: false, reason: '' };
}
const GATE_HI = 70, GATE_MED = 50;
// mirror of the gate inside mergeOfferLLM.apply
function gateAction(llmAction, conf) {
  let action = llmAction;
  if ((action === 'corrected' || action === 'added') && conf < GATE_HI) action = conf >= GATE_MED ? 'suggested' : 'kept';
  return action;
}
// mirror of resolveEvidence leak counting
function resolveEvidence(ids, buyerIds, platIds) {
  let ev = 0, leaks = 0;
  for (const id of ids || []) { if (buyerIds.has(id)) ev++; else if (platIds.has(id)) leaks++; }
  return { ev, leaks };
}
// mirror of offerEval (now: llmApplied gates the 'no-llm' verdict — an all-kept skeleton is NOT a false 'strong')
function offerEval(all, dropped, platformLeaks = 0, llmApplied = true) {
  const changed = all.filter((f) => ['corrected', 'added', 'suggested'].includes(f.action));
  const groundedPct = changed.length ? Math.round((changed.filter((f) => f.grounded).length / changed.length) * 100) : 100;
  const hallucinations = changed.filter((f) => !f.grounded).length;
  const verdict = !llmApplied ? 'no-llm' : (groundedPct >= 80 && hallucinations === 0 && platformLeaks === 0) ? 'strong' : groundedPct < 50 ? 'thin' : 'mixed';
  return { corrected: all.filter((f) => f.action === 'corrected').length, added: all.filter((f) => f.action === 'added').length, dropped: dropped.length, groundedPct, hallucinations, platformLeaks, llmApplied, verdict };
}
// mirror of canonField — "I am interested in" / "category" reconcile to ONE key so a mis-map fix can land
const canonField = (s) => /^(category|i am interested in|interested in|mapping|product category|true product|item)$/.test(String(s || '').toLowerCase().trim()) ? 'category' : String(s || '').toLowerCase().trim();
// mirror of the merge add-loop: does an LLM field NOT in the skeleton get LANDED? (added OR corrected OR suggested, if grounded)
function landsNewField(skeletonFields, llm) {
  const have = new Set(skeletonFields.map(canonField));
  const key = canonField(llm.field);
  const grounded = !!llm.grounded && (llm.evidence_ids || []).length > 0;
  return ['added', 'corrected', 'suggested'].includes(llm.action) && !['title', 'location', 'quantity'].includes(key) && !have.has(key) && grounded;
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); } };

// — price parsing —
ok('₹ 8 Lakh → 800000', parsePriceInr('₹ 8 Lakh / Piece') === 800000);
ok('20,000 → 20000', parsePriceInr('Rs. 20,000') === 20000);
ok('1.5 crore → 15000000', parsePriceInr('1.5 crore') === 15000000);
ok('70 Lakh → 7000000', parsePriceInr('Rs. 70 - 74 Lakh') === 7000000);
ok('empty → null', parsePriceInr('') === null);

// — quantity sanity —
ok('43869 (non-round bulk) → absurd', quantitySanity(43869).absurd === true);
ok('10980 (round bulk) → ok', quantitySanity(10980).absurd === false);
ok('800000 == viewed price → absurd', quantitySanity(800000, [800000]).absurd === true);
ok('5 (small) → ok', quantitySanity(5).absurd === false);
ok('0 / NaN → ok (no false alarm)', quantitySanity(0).absurd === false && quantitySanity(NaN).absurd === false);

// — confidence gate —
ok('corrected @85 → corrected', gateAction('corrected', 85) === 'corrected');
ok('corrected @60 → suggested', gateAction('corrected', 60) === 'suggested');
ok('corrected @40 → kept (reverted)', gateAction('corrected', 40) === 'kept');
ok('added @90 → added', gateAction('added', 90) === 'added');
ok('added @55 → suggested', gateAction('added', 55) === 'suggested');
ok('kept stays kept', gateAction('kept', 10) === 'kept');

// — platform-leak counting —
const buyerIds = new Set(['f1', 'f2', 'f3']); const platIds = new Set(['p1', 'p2']);
ok('buyer ids resolve, no leak', (() => { const r = resolveEvidence(['f1', 'f2'], buyerIds, platIds); return r.ev === 2 && r.leaks === 0; })());
ok('cited platform fact → leak counted, not used as evidence', (() => { const r = resolveEvidence(['f1', 'p1'], buyerIds, platIds); return r.ev === 1 && r.leaks === 1; })());

// — eval verdict —
const strong = [{ action: 'corrected', grounded: true }, { action: 'added', grounded: true }, { action: 'kept', grounded: false }];
ok('all-grounded, no leak, llm ran → strong', offerEval(strong, [{}], 0, true).verdict === 'strong');
ok('a leak forces non-strong', offerEval(strong, [{}], 1, true).verdict !== 'strong');
const halluc = [{ action: 'added', grounded: false }, { action: 'corrected', grounded: true }];
ok('ungrounded change → hallucination counted', offerEval(halluc, [], 0, true).hallucinations === 1);
ok('ungrounded majority → thin', offerEval([{ action: 'added', grounded: false }, { action: 'corrected', grounded: false }, { action: 'corrected', grounded: true }], [], 0, true).verdict === 'thin');
ok('no changes, llm ran → strong', offerEval([{ action: 'kept', grounded: false }], [], 0, true).verdict === 'strong');
ok('LLM never returned a verdict → no-llm (NOT a false "strong")', offerEval([{ action: 'kept', grounded: false }], [], 0, false).verdict === 'no-llm');

// — category / mapping reconciliation (the bug that swallowed the Paper-Plate → Notebook-Paper fix) —
ok('"I am interested in" canonicalises to category', canonField('I am interested in') === 'category' && canonField('category') === 'category');
ok('a category correction NOT in the skeleton still LANDS (was silently dropped before)', landsNewField(['title', 'gsm', 'size'], { field: 'category', action: 'corrected', grounded: true, evidence_ids: ['f53'] }) === true);
ok('a corrected field ALREADY in the skeleton is not double-added (apply handles it)', landsNewField(['title', 'category', 'gsm'], { field: 'category', action: 'corrected', grounded: true, evidence_ids: ['f53'] }) === false);
ok('an UNGROUNDED new field does NOT land (hallucination guard)', landsNewField(['title'], { field: 'category', action: 'corrected', grounded: false, evidence_ids: [] }) === false);
ok('LLM field "i am interested in" lands on the category slot via canon', landsNewField(['title', 'gsm'], { field: 'i am interested in', action: 'corrected', grounded: true, evidence_ids: ['f53'] }) === true);

// — narrative spec extraction (the buried 54 GSM + 0.5–1 ton the lite model missed; now PRE-SURFACED to DECISIVE) —
// exact regexes from buildOfferEnrichPrompt, fed the real PNS narrative lines (f51/f59/f68/f76/f88) for this buyer.
const NARR = [
  'Seeking raw material for notebook manufacturing.',
  'Wants to procure 0.5 to 1 ton of 54 GSM raw paper regularly for manufacturing business.',
  'Wants to purchase raw material for manufacturing notebooks.',
  'Wants to source raw materials or finished products for a new notebook business venture.',
  "Buyer is looking for raw paper material and lives near the seller's location in Kanpur.",
].join('  ');
const gsmHits = [...new Set([...NARR.matchAll(/(\d{2,3})\s*GSM/gi)].map((m) => m[1]))];
const qtyNarr = NARR.match(/(\d+(?:\.\d+)?)\s*(?:to|–|—|-)\s*(\d+(?:\.\d+)?)\s*(?:ton|tonne|kg|quintal|kilo)/i) || NARR.match(/(\d+(?:\.\d+)?)\s*(?:ton|tonne|kg|quintal)\b/i);
ok('narrative GSM extracted → 54 surfaced (recorded was 100; lite model missed the buried one)', gsmHits.includes('54'));
ok('narrative quantity extracted → "0.5 to 1 ton" surfaced (vs recorded 100000)', !!qtyNarr && /0\.5\s*to\s*1\s*ton/i.test(qtyNarr[0]));

console.log(`\nofferEnrich: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
