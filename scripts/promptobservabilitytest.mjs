// Deterministic test for the ADDITIVE prompt-observability parsing — mirrors the deriveIntent +
// planRequirement parsers in src/lib/gemini.ts. Proves: (1) the new debug fields (intent_candidates,
// per-question priority, considered) parse correctly; (2) they are GRACEFUL when absent/garbled; and
// CRUCIALLY (3) the EXISTING field extraction is byte-identical whether or not the new fields exist —
// i.e. observability did NOT become a behavioral change. NO LLM.

const clampScore = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Number(v))) : 0);

// ── mirror: deriveIntent parser (existing fields + the new intentCandidates) ──
function parseIntent(p) {
  const chips = Array.isArray(p?.chips) ? p.chips.map((c) => String(c).trim()).filter(Boolean).slice(0, 6) : [];
  const question = typeof p?.question === 'string' ? p.question.trim() : '';
  if (!question || chips.length < 2) return null;
  return {
    journey: ['retail', 'resale', 'industrial', 'project', 'maintenance', 'personal', 'unknown'].includes(String(p?.journey).toLowerCase()) ? String(p.journey).toLowerCase() : 'unknown',
    question, chips,
    derivedIntent: typeof p?.derivedIntent === 'string' ? p.derivedIntent.trim() : '',
    confidence: Number.isFinite(p?.confidence) ? Math.max(0, Math.min(100, p.confidence)) : 0,
    intentCandidates: Array.isArray(p?.intent_candidates)
      ? p.intent_candidates.filter((c) => !!c && typeof c === 'object')
          .map((c) => ({ label: String(c.label ?? '').trim(), score: clampScore(c.score), reason: String(c.reason ?? '').trim() }))
          .filter((c) => c.label).sort((a, b) => b.score - a.score).slice(0, 6)
      : undefined,
  };
}
// ── mirror: planRequirement parser (the new priority per question + considered) ──
const parsePriority = (q) => (Number.isFinite(q.priority) ? Math.max(0, Math.min(100, Number(q.priority))) : undefined);
function parseConsidered(p) {
  return Array.isArray(p?.considered)
    ? p.considered.filter((c) => !!c && typeof c === 'object')
        .map((c) => ({ label: String(c.label ?? '').trim(), score: clampScore(c.score), reason: String(c.reason ?? '').trim() }))
        .filter((c) => c.label).sort((a, b) => b.score - a.score).slice(0, 8)
    : undefined;
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── deriveIntent: WITH intent_candidates ──
const withCands = parseIntent({
  journey: 'industrial', question: 'What will this power?', chips: ['Factory', 'Office', 'Backup'],
  derivedIntent: 'Manufacturing backup', confidence: 88,
  intent_candidates: [
    { label: 'Residential Backup', score: 12, reason: 'no industrial signal' },
    { label: 'Manufacturing Backup', score: 92, reason: 'manufacturer + diesel genset + capacity' },
    { label: 'Commercial Backup', score: 71, reason: 'business buyer' },
  ],
});
ok('intent: candidates ranked desc (92 first)', withCands.intentCandidates[0].label === 'Manufacturing Backup' && withCands.intentCandidates[0].score === 92);
ok('intent: lowest candidate last (12)', withCands.intentCandidates[2].score === 12);
ok('intent: existing fields intact WITH candidates (chips/derivedIntent/conf)', withCands.chips.length === 3 && withCands.derivedIntent === 'Manufacturing backup' && withCands.confidence === 88);

// ── deriveIntent: WITHOUT intent_candidates — existing fields must be byte-identical ──
const noCands = parseIntent({ journey: 'industrial', question: 'What will this power?', chips: ['Factory', 'Office', 'Backup'], derivedIntent: 'Manufacturing backup', confidence: 88 });
ok('intent: no candidates → intentCandidates undefined', noCands.intentCandidates === undefined);
ok('intent: existing fields identical with/without candidates', JSON.stringify({ ...noCands, intentCandidates: 0 }) === JSON.stringify({ ...withCands, intentCandidates: 0 }));

// ── deriveIntent: GARBAGE candidates → graceful ──
const garbage = parseIntent({ question: 'Q?', chips: ['A', 'B'], intent_candidates: [null, 5, { score: 200 }, { label: '  ', score: 'x' }, { label: 'Real', score: -7, reason: 'r' }] });
ok('intent: garbage candidates filtered (only the labelled one survives)', garbage.intentCandidates.length === 1 && garbage.intentCandidates[0].label === 'Real');
ok('intent: out-of-range score clamped (-7 → 0)', garbage.intentCandidates[0].score === 0);
ok('intent: candidates as non-array → undefined (no throw)', parseIntent({ question: 'Q?', chips: ['A', 'B'], intent_candidates: { x: 1 } }).intentCandidates === undefined);
ok('intent: still returns null when question/chips invalid (behavior unchanged)', parseIntent({ chips: ['A'], intent_candidates: [{ label: 'X', score: 9 }] }) === null);

// ── planRequirement: per-question priority ──
ok('planner: priority 90 → 90', parsePriority({ priority: 90 }) === 90);
ok('planner: priority 150 → clamped 100', parsePriority({ priority: 150 }) === 100);
ok('planner: priority missing → undefined (older cached plans)', parsePriority({}) === undefined);
ok('planner: priority "high" → undefined (not finite)', parsePriority({ priority: 'high' }) === undefined);

// ── planRequirement: considered (suppressed candidates) ──
const considered = parseConsidered({ considered: [
  { label: 'Budget range', score: 71, reason: 'below the 3-question cap' },
  { label: 'Site readiness', score: 83, reason: 'covered by Installation question' },
  null, { score: 40 }, { label: 'Fuel storage', score: 'x', reason: 'lower utility' },
] });
ok('planner: considered ranked desc (83 first)', considered[0].label === 'Site readiness' && considered[0].score === 83);
ok('planner: considered drops unlabelled/garbage rows', considered.length === 3 && considered.every((c) => c.label));
ok('planner: considered non-finite score → 0', considered.find((c) => c.label === 'Fuel storage').score === 0);
ok('planner: no considered key → undefined (graceful)', parseConsidered({ questions: [] }) === undefined);
ok('planner: considered capped at 8', parseConsidered({ considered: Array.from({ length: 20 }, (_, i) => ({ label: 'q' + i, score: i })) }).length === 8);

console.log(`\npromptobservabilitytest (additive debug fields · intent_candidates + planner priority/considered · ranked/clamped/graceful · EXISTING extraction byte-identical with/without — observability, not behavior): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
