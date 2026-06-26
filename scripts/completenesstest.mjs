// Deterministic test for the RFQ COMPLETENESS ENGINE (P2) — mirrors src/lib/completeness.ts.
// Answers "what does a seller still need?" and "do we know enough to STOP asking?". Seller-readiness =
// every REQUIRED field (must-have specs + qty + intent); everything else optional. NO LLM, NO network.

function scoreCompleteness(input) {
  const required = [
    { key: 'Use-case / intent', ok: !!input.hasIntent },
    { key: 'Quantity', ok: !!input.hasQuantity },
  ];
  const mustHave = [...new Set((input.mustHaveSpecs || []).filter(Boolean))];
  for (const m of mustHave) required.push({ key: m, ok: input.isFilled(m) });
  const missingRequired = required.filter((r) => !r.ok).map((r) => r.key);
  const optional = (input.allSpecNames || []).filter((n) => n && !mustHave.includes(n) && !input.isFilled(n));
  const pct = required.length ? Math.round((required.filter((r) => r.ok).length / required.length) * 100) : 0;
  const sellerReady = missingRequired.length === 0;
  return { pct, missingRequired, optional, sellerReady };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

const ALL = ['Battery Capacity', 'Battery Technology', 'Battery Series', 'System Voltage', 'Warranty', 'Backup Time', 'Water Top Up', 'Inverter Compatibility', 'Recommended Use'];
const MUST = ['Battery Capacity', 'Battery Technology', 'System Voltage'];

// ── early: intent + qty known, no specs filled → not ready, lists the must-haves as still-needed ──
let filled = new Set();
let r = scoreCompleteness({ mustHaveSpecs: MUST, allSpecNames: ALL, isFilled: (n) => filled.has(n), hasQuantity: true, hasIntent: true });
ok('early: NOT seller-ready (must-haves empty)', r.sellerReady === false);
ok('early: missing = intent/qty satisfied, the 3 must-have specs still needed', r.missingRequired.length === 3 && r.missingRequired.includes('Battery Capacity'));
ok('early: pct = 2/5 required filled (intent+qty) = 40%', r.pct === 40);
ok('early: optional = the 6 non-must-have specs', r.optional.length === 6 && !r.optional.includes('Battery Capacity'));

// ── fill the must-haves → seller-ready, STOP asking (optional pool may remain) ──
filled = new Set(MUST);
r = scoreCompleteness({ mustHaveSpecs: MUST, allSpecNames: ALL, isFilled: (n) => filled.has(n), hasQuantity: true, hasIntent: true });
ok('all must-haves filled → SELLER-READY (stop asking)', r.sellerReady === true);
ok('seller-ready → pct 100% over the required set', r.pct === 100);
ok('seller-ready EVEN WITH optional specs still empty (they never block)', r.optional.length === 6 && r.sellerReady === true);
ok('seller-ready → missingRequired is empty', r.missingRequired.length === 0);

// ── a missing ESSENTIAL (no intent) keeps it not-ready even with every spec filled ──
filled = new Set(ALL);
r = scoreCompleteness({ mustHaveSpecs: MUST, allSpecNames: ALL, isFilled: (n) => filled.has(n), hasQuantity: true, hasIntent: false });
ok('no intent → NOT ready (essentials are required too)', r.sellerReady === false && r.missingRequired.includes('Use-case / intent'));
ok('no quantity → NOT ready', scoreCompleteness({ mustHaveSpecs: [], allSpecNames: ALL, isFilled: () => false, hasQuantity: false, hasIntent: true }).sellerReady === false);

// ── planner gave no must-haves → ready as soon as the essentials (qty + intent) are in ──
r = scoreCompleteness({ mustHaveSpecs: [], allSpecNames: ALL, isFilled: () => false, hasQuantity: true, hasIntent: true });
ok('no must-haves + qty + intent → seller-ready (don\'t over-ask)', r.sellerReady === true && r.pct === 100);

// ── partial must-haves ──
filled = new Set(['Battery Capacity']);
r = scoreCompleteness({ mustHaveSpecs: MUST, allSpecNames: ALL, isFilled: (n) => filled.has(n), hasQuantity: true, hasIntent: true });
ok('1 of 3 must-haves filled → still needs the other 2', r.missingRequired.length === 2 && r.sellerReady === false);
ok('pct rises as must-haves fill (3/5 = 60%)', r.pct === 60);

// ── robustness ──
ok('empty everything → not ready, pct 0 (cold)', (() => { const x = scoreCompleteness({ mustHaveSpecs: [], allSpecNames: [], isFilled: () => false, hasQuantity: false, hasIntent: false }); return x.sellerReady === false && x.pct === 0; })());
ok('dedups must-have specs (no double-count)', scoreCompleteness({ mustHaveSpecs: ['A', 'A', 'B'], allSpecNames: ['A', 'B'], isFilled: (n) => n === 'A', hasQuantity: true, hasIntent: true }).missingRequired.length === 1);

console.log(`\ncompletenesstest (P2: seller-readiness — required = must-haves + qty + intent · optional never blocks · STOP-asking governor): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
