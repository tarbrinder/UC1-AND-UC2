// Deterministic test for the FIRST-PAGE INTENT LEADERBOARD — mirrors src/lib/intentDisposition.ts.
// Answers "why was THIS intent pre-filled (and not the Twin's / the LLM's)?" — the page-1 race. NO LLM.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
const isChosen = (v, chosen) => !!chosen && norm(v) === norm(chosen);
function intentLeaderboard(input) {
  const bar = typeof input.threshold === 'number' ? input.threshold : 80;
  const rows = [];
  const regOk = !!input.registry && input.registry.confidence >= bar;
  const twinOk = !!input.twin && input.twin.confidence >= bar && !input.twin.offProfile;
  const winner = regOk ? 'Registry' : twinOk ? 'Twin' : (!!input.llm && input.llm.confidence >= bar) ? 'LLM' : null;
  if (input.registry) { const r = input.registry; rows.push(r.confidence < bar ? { source: 'Registry', value: r.value, confidence: r.confidence, disposition: 'BELOW_THRESHOLD', reason: 'below bar' } : { source: 'Registry', value: r.value, confidence: r.confidence, disposition: 'CHOSEN', reason: 'registry top precedence' }); }
  if (input.twin) { const t = input.twin; rows.push(t.offProfile ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'OFF_PROFILE', reason: 'off-profile, never used' } : t.confidence < bar ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'BELOW_THRESHOLD', reason: 'below bar' } : winner !== 'Twin' ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'OVERRIDDEN', reason: 'registry wins' } : { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'CHOSEN', reason: 'on-profile active-intent' }); }
  if (input.llm && input.llm.value) { const l = input.llm; rows.push(l.confidence < bar ? { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'BELOW_THRESHOLD', reason: 'below bar — ask chips' } : winner !== 'LLM' ? { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'OVERRIDDEN', reason: 'higher precedence wins' } : { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'CHOSEN', reason: 'product derivation' }); }
  for (const c of input.chips || []) { if (!c) continue; rows.push({ source: 'Chip', value: c, confidence: 0, disposition: 'ASK_FALLBACK', reason: winner ? 'change-option' : 'live question option' }); }
  return rows.sort((a, b) => { const ac = isChosen(a.value, input.chosenValue) && a.source !== 'Chip' ? 1 : 0; const bc = isChosen(b.value, input.chosenValue) && b.source !== 'Chip' ? 1 : 0; if (ac !== bc) return bc - ac; if ((a.source === 'Chip') !== (b.source === 'Chip')) return a.source === 'Chip' ? 1 : -1; return b.confidence - a.confidence; });
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── Case A: notebook MANUFACTURER buying corrugated boxes. Twin says "resale" but it's OFF-PROFILE
//    (a manufacturing INPUT, not resale). LLM derives "Notebook packaging" at conf 88. LLM should win. ──
const A = intentLeaderboard({
  registry: null,
  twin: { value: 'Resale / trading', confidence: 90, offProfile: true },
  llm: { value: 'Notebook packaging', confidence: 88 },
  chips: ['Notebook packaging', 'Product shipping', 'General packaging'],
  chosenValue: 'Notebook packaging',
});
const aTwin = A.find((r) => r.source === 'Twin'), aLLM = A.find((r) => r.source === 'LLM');
ok('A: off-profile Twin → OFF_PROFILE (the notebook-manufacturer leak guard)', aTwin.disposition === 'OFF_PROFILE');
ok('A: LLM "Notebook packaging" (conf 88) → CHOSEN', aLLM.disposition === 'CHOSEN');
ok('A: CHOSEN row floats to the top', A[0].source === 'LLM' && A[0].disposition === 'CHOSEN');
ok('A: chips present as ASK_FALLBACK change-options', A.filter((r) => r.source === 'Chip').length === 3 && A.filter((r) => r.source === 'Chip').every((r) => r.disposition === 'ASK_FALLBACK'));

// ── Case B: registry already knows the intent (conf 92). Registry wins; an on-profile Twin (conf 85) is OVERRIDDEN. ──
const B = intentLeaderboard({
  registry: { value: 'Factory backup power', confidence: 92 },
  twin: { value: 'Backup power', confidence: 85, offProfile: false },
  llm: { value: 'Primary power', confidence: 84 },
  chips: ['Backup power', 'Primary power', 'Resale'],
  chosenValue: 'Factory backup power',
});
ok('B: Registry (92) → CHOSEN, top precedence', B.find((r) => r.source === 'Registry').disposition === 'CHOSEN');
ok('B: on-profile Twin (85) → OVERRIDDEN by registry', B.find((r) => r.source === 'Twin').disposition === 'OVERRIDDEN');
ok('B: LLM (84) → OVERRIDDEN too', B.find((r) => r.source === 'LLM').disposition === 'OVERRIDDEN');
ok('B: CHOSEN registry floats to top', B[0].source === 'Registry');

// ── Case C: nothing clears the bar → ASK. LLM conf 60, no registry, no twin → chips are the live question. ──
const C = intentLeaderboard({
  registry: null, twin: null,
  llm: { value: 'General use', confidence: 60 },
  chips: ['Resale', 'Own use', 'Manufacturing input'],
  chosenValue: null,
});
ok('C: low-conf LLM (60) → BELOW_THRESHOLD (ask, don\'t pre-fill)', C.find((r) => r.source === 'LLM').disposition === 'BELOW_THRESHOLD');
ok('C: no CHOSEN row (we ask)', !C.some((r) => r.disposition === 'CHOSEN'));
ok('C: chips are live-question options', C.filter((r) => r.source === 'Chip').length === 3);

// ── Case D: on-profile Twin wins when there's no registry. ──
const D = intentLeaderboard({
  registry: null,
  twin: { value: 'Salon use', confidence: 88, offProfile: false },
  llm: { value: 'Personal use', confidence: 82 },
  chips: ['Salon use', 'Personal use'],
  chosenValue: 'Salon use',
});
ok('D: on-profile Twin (88) → CHOSEN', D.find((r) => r.source === 'Twin').disposition === 'CHOSEN');
ok('D: LLM (82, would clear bar) → OVERRIDDEN by Twin precedence', D.find((r) => r.source === 'LLM').disposition === 'OVERRIDDEN');

// ── graceful ──
ok('empty input → empty board, no throw', intentLeaderboard({ chips: [], chosenValue: null }).length === 0);
ok('every row has a disposition + reason', [...A, ...B, ...C, ...D].every((r) => r.disposition && r.reason));
ok('ranking: sources before chips in every case', [A, B, C, D].every((bd) => { const li = bd.findIndex((r) => r.source === 'Chip'); const si = bd.map((r) => r.source !== 'Chip').lastIndexOf(true); return li === -1 || si < li; }));

console.log(`\nintentdispositiontest (page-1 intent leaderboard · Registry/Twin/LLM precedence race · CHOSEN/BELOW_THRESHOLD/OFF_PROFILE/OVERRIDDEN/ASK_FALLBACK · off-profile leak guard · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
