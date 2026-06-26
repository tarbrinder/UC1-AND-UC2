// Deterministic test for the CEO / UNIFIED REQUIREMENT SUMMARY (Phase C) — mirrors src/lib/ceoSummary.ts.
// Buckets the existing signals into Know / Think / Still-need / Unusual. Golden Rule: no evidence ⇒
// "still need", never a guess in "know". Modelled on the Jaiveer/paper run. NO LLM.

function buildCEOSummary(input) {
  const dims = input.dims || [];
  const know = dims.filter((d) => d.state === 'Confirmed' && d.value).map((d) => ({ label: d.label, value: d.value, source: d.source }));
  const think = dims.filter((d) => (d.state === 'Likely' || d.state === 'Weak') && d.value).map((d) => ({ label: d.label, value: d.value, confidence: d.confidence }));
  const unknownDims = dims.filter((d) => d.state === 'Unknown').map((d) => d.label);
  const stillNeed = [...new Set([...(input.missingRequired || []), ...unknownDims])];
  const unusual = [
    ...dims.filter((d) => d.state === 'Contradicted').map((d) => `${d.label}: ${d.value || 'conflicting signals'}`),
    ...(input.conflicts || []),
    ...(input.offProfile ? ['New area for this buyer — current product is unrelated to their history'] : []),
  ];
  const denom = dims.length || 1;
  const readiness = Math.round(((know.length + think.length) / denom) * 100);
  return { know, think, stillNeed, unusual, readiness };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the Jaiveer/paper dims (from the live run) ──
const jaiveer = buildCEOSummary({
  dims: [
    { label: 'Who is the buyer', value: 'Manufacturer', state: 'Confirmed', confidence: 100, source: 'User' },
    { label: 'Use case / intent', value: 'Notebook Manufacturing Inputs', state: 'Confirmed', confidence: 90, source: 'Derived' },
    { label: 'Buyer maturity', value: 'Existing Buyer', state: 'Confirmed', confidence: 80, source: 'Profile' },
    { label: 'Requirement stage', value: 'Evaluating options', state: 'Likely', confidence: 65, source: 'Journey' },
    { label: 'Income band', value: '8-10L', state: 'Likely', confidence: 70, source: 'External' },
    { label: 'Local supplier preference', value: 'High', state: 'Likely', confidence: 70, source: 'Twin' },
    { label: 'Purchase urgency', value: '', state: 'Unknown', confidence: 0 },
    { label: 'Support required', value: '', state: 'Unknown', confidence: 0 },
  ],
  missingRequired: ['Finish'],
  conflicts: [],
});
ok('KNOW = 3 Confirmed (buyer, intent, maturity)', jaiveer.know.length === 3);
ok('KNOW carries source (User/Derived/Profile)', jaiveer.know.find((k) => k.label === 'Who is the buyer')?.source === 'User');
ok('THINK = 3 Likely (stage, income, local-pref)', jaiveer.think.length === 3);
ok('THINK carries confidence', jaiveer.think.every((t) => typeof t.confidence === 'number'));
ok('STILL NEED = the 2 Unknown dims + 1 missing must-have', jaiveer.stillNeed.length === 3 && jaiveer.stillNeed.includes('Purchase urgency') && jaiveer.stillNeed.includes('Finish'));
ok('UNUSUAL = empty (no conflicts, on-profile)', jaiveer.unusual.length === 0);
ok('readiness = 6/8 known-or-inferred = 75%', jaiveer.readiness === 75);

// ── Golden Rule: an Unknown value never lands in KNOW ──
ok('Unknown dim is NOT in know', !jaiveer.know.some((k) => k.label === 'Purchase urgency'));
ok('Unknown dim IS in stillNeed', jaiveer.stillNeed.includes('Purchase urgency'));

// ── UNUSUAL surfaces contradictions + conflicts + off-profile ──
const conflicted = buildCEOSummary({
  dims: [{ label: 'Buyer type', value: 'Manufacturer vs Trader', state: 'Contradicted', confidence: 50 }, { label: 'Intent', value: 'X', state: 'Confirmed', confidence: 90 }],
  conflicts: ['order-scale ✕ payment lean'],
  offProfile: true,
});
ok('UNUSUAL: contradicted dim surfaced', conflicted.unusual.some((u) => /Buyer type/.test(u)));
ok('UNUSUAL: consistency conflict surfaced', conflicted.unusual.some((u) => /payment lean/.test(u)));
ok('UNUSUAL: off-profile surfaced', conflicted.unusual.some((u) => /New area/.test(u)));
ok('contradicted dim is NOT counted as known', !conflicted.know.some((k) => k.label === 'Buyer type'));

// ── dedup: a missing spec that is also an Unknown dim appears once ──
const dedup = buildCEOSummary({ dims: [{ label: 'Finish', value: '', state: 'Unknown', confidence: 0 }], missingRequired: ['Finish'] });
ok('stillNeed dedups (Finish appears once)', dedup.stillNeed.filter((x) => x === 'Finish').length === 1);

// ── graceful ──
ok('empty → 0% readiness, all buckets empty, no divide-by-zero', (() => { const s = buildCEOSummary({ dims: [] }); return s.readiness === 0 && s.know.length === 0 && s.stillNeed.length === 0; })());
ok('all confirmed → 100% readiness', buildCEOSummary({ dims: [{ label: 'A', value: 'x', state: 'Confirmed', confidence: 100 }] }).readiness === 100);

console.log(`\nceosummarytest (Phase C: know/think/still-need/unusual buckets · Golden Rule · contradictions+conflicts+off-profile surfaced · dedup · readiness% · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
