// Deterministic test for the CONSISTENCY ENGINE — mirrors src/lib/consistency.ts checkConsistency().
// Before an RFQ renders, its facts must pass "can these coexist?". The IIT-Kanpur run shipped
// "1 Piece → personal use / skip-credit" alongside "capital · credit · installation" — impossible.
// Also proves the SOURCE fix: a business/capital single-unit framing is neutralised → no conflict.
// NO LLM, NO network.

function checkConsistency(s) {
  const conflicts = [];
  const consumerBand = /single|small|sample/i.test(s.orderScaleBand || '');
  const consumerFraming = consumerBand && /personal|consumer|sample|skip\s*(bulk|credit|cadence)/i.test(s.orderScaleImplication || '');
  const capitalMode = /capital|project/i.test(s.requirementMode || '');
  const credit = /credit/i.test(s.paymentLean || '');
  const installNeeded = /\byes\b/i.test(s.installation || '');
  const businessBuyer = /business/i.test(s.buyerKind || '') || /manufacturer|institution|trader|distributor|wholesal|government|research|industr|corporate/i.test(s.buyerType || '');
  const bulk = /bulk|wholesale/i.test(s.orderScaleBand || '');
  if (consumerFraming && (capitalMode || credit || installNeeded)) conflicts.push({ a: 'consumer framing', b: 'capital/credit/install', severity: 'high' });
  if (consumerFraming && businessBuyer) conflicts.push({ a: 'personal framing', b: 'business buyer', severity: 'high' });
  if (/personal/i.test(s.journey || '') && (businessBuyer || bulk)) conflicts.push({ a: 'journey personal', b: 'business/bulk', severity: 'high' });
  if (bulk && /personal/i.test(s.buyerKind || '')) conflicts.push({ a: 'bulk', b: 'personal buyer-kind', severity: 'medium' });
  return conflicts;
}
const isConsistent = (s) => checkConsistency(s).length === 0;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ════ THE IIT-KANPUR FAILURE (what shipped) — must be caught ════
const iitBad = {
  buyerKind: 'business', buyerType: 'Research Institution', journey: 'industrial',
  orderScaleBand: 'single',
  orderScaleImplication: 'single — tiny order → personal use, a sample, or a trial; NOT wholesale/resale; use consumer framing, skip bulk/credit/cadence',
  requirementMode: 'capital', paymentLean: 'credit', installation: 'Yes, full installation needed',
};
ok('IIT bug: "personal/skip-credit" scale ✕ capital/credit/install → CONFLICT (R1)', checkConsistency(iitBad).some((c) => c.a === 'consumer framing'));
ok('IIT bug: personal framing ✕ business buyer → CONFLICT (R2)', checkConsistency(iitBad).some((c) => c.a === 'personal framing'));
ok('IIT bug: the run is INCONSISTENT (would have been flagged before render)', !isConsistent(iitBad));

// ════ THE SOURCE FIX — neutralised framing for a business/capital single unit → consistent ════
const iitFixed = { ...iitBad, orderScaleImplication: 'single order — a single / low-volume BUSINESS purchase (not bulk); commercial terms still apply' };
ok('FIXED: neutralised business framing + capital + credit → NO conflict', isConsistent(iitFixed));
ok('FIXED: keeps the band, just drops the false "personal" framing', checkConsistency(iitFixed).length === 0);

// ── R3: journey personal ⊥ business / bulk ──
ok('R3: journey personal + business buyer → CONFLICT', checkConsistency({ journey: 'personal', buyerType: 'Manufacturer' }).some((c) => c.a === 'journey personal'));
ok('R3: journey personal + wholesale order → CONFLICT', checkConsistency({ journey: 'personal', orderScaleBand: 'wholesale' }).some((c) => c.a === 'journey personal'));
ok('R3: journey personal + genuine personal buyer (single) → NO conflict', isConsistent({ journey: 'personal', buyerKind: 'personal', orderScaleBand: 'single' }));

// ── R4: bulk ⊥ personal buyer-kind ──
ok('R4: bulk order + personal buyer-kind → CONFLICT', checkConsistency({ orderScaleBand: 'bulk', buyerKind: 'personal' }).some((c) => c.b === 'personal buyer-kind'));

// ── legitimate combinations stay clean (no false conflicts) ──
ok('clean: genuine personal sample (personal kind, single, personal journey)', isConsistent({ buyerKind: 'personal', orderScaleBand: 'single', journey: 'personal', orderScaleImplication: 'tiny order → personal use' }));
ok('clean: manufacturer bulk + credit (no consumer framing)', isConsistent({ buyerKind: 'business', buyerType: 'Manufacturer', orderScaleBand: 'wholesale', journey: 'resale', paymentLean: 'credit' }));

// ════ JAIVEER/PAPER REGRESSION (P1 fix) — the wholesale implication literally says "NOT personal use".
// The old substring match flagged a false conflict with the Manufacturer + credit. Band-gate kills it. ════
const jaiveer = { buyerKind: 'business', buyerType: 'Manufacturer', orderScaleBand: 'wholesale', paymentLean: 'credit',
  orderScaleImplication: 'wholesale — bulk-unit order → business / reseller scale, NOT personal use; bulk pricing, credit terms and freight are relevant' };
ok('REGRESSION: "NOT personal use" in a WHOLESALE band → NO false consumer-framing conflict', isConsistent(jaiveer));
ok('REGRESSION: wholesale band is never read as consumer framing', !checkConsistency(jaiveer).some((c) => /consumer|personal framing/.test(c.a)));
// but a genuine consumer single-unit STILL conflicts with capital/credit (the real IIT bug stays caught)
ok('still catches: single-band consumer framing ✕ credit (real conflict preserved)', checkConsistency({ orderScaleBand: 'single', orderScaleImplication: 'personal use / sample / skip credit', paymentLean: 'credit', requirementMode: 'capital' }).length > 0);
ok('clean: small business order, advance, no consumer framing', isConsistent({ buyerKind: 'business', buyerType: 'Trader', orderScaleBand: 'small', orderScaleImplication: 'small order — a small business buy', paymentLean: 'advance' }));
ok('clean: empty snapshot → no conflicts (no crash)', isConsistent({}));

// ── severity ──
ok('R1/R2/R3 are HIGH severity; R4 is medium', checkConsistency(iitBad).every((c) => c.severity === 'high') && checkConsistency({ orderScaleBand: 'bulk', buyerKind: 'personal' })[0].severity === 'medium');

console.log(`\nconsistencytest (Consistency Engine: personal-vs-capital · personal-vs-business · journey-vs-buyer · bulk-vs-personal · source-fix neutralises framing): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
