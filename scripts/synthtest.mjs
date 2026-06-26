// Deterministic test for the Merged Synthesis Engine (mirrors synthesisEngine.ts).
// Proves: the two arithmetic engines MERGE into one set (4 legacy decisions ∪ all persona candidates, deduped,
// decisionId overlaid); the prompt passes arithmetic+why + schema + raw evidence with "re-verify/fill/extend";
// and the LLM OVERRIDES the value with provenance tags (arithmetic / llm-confirmed / llm-changed / llm-new) +
// a hallucination-grounding flag. NO live LLM (the round-trip is the only async, env-gated piece).

function mergeArithmetic(L, persona) {
  const byKey = new Map();
  for (const a of persona.all) {
    const arithmetic = a.confidenceLedger.length
      ? a.confidenceLedger.map((i) => `${i.delta > 0 ? '+' : ''}${i.delta} ${i.label}`).join(' ') + ` = ${a.confidence}`
      : (a.shown ? `confidence ${a.confidence}` : (a.ignoredReason || 'no grounding evidence'));
    byKey.set(a.key, { key: a.key, label: a.label, group: a.group, value: a.value, confidence: a.confidence, shown: a.shown, sources: a.sources.map(String), arithmetic });
  }
  for (const d of L.decisions) {
    const ex = byKey.get(d.key);
    if (ex) { ex.decisionId = d.id; ex.arithmetic = d.reasoning || ex.arithmetic; ex.shown = true; if (!ex.value || ex.value === '—') ex.value = d.value; }
    else byKey.set(d.key, { key: d.key, label: d.key.replace(/_/g, ' '), group: 'Decisions', value: d.value, confidence: d.confidence, shown: true, sources: d.contributions.map((c) => String(c.source)), arithmetic: d.reasoning, decisionId: d.id });
  }
  return [...byKey.values()];
}
function buildMergedSynthPrompt(merged, bundle) {
  const user = [
    'ATTRIBUTE SCHEMA + ARITHMETIC SIGNAL (one input — you decide each value/confidence/reasoning yourself):',
    ...merged.map((m) => `  ${m.key} [${m.label}] — arithmetic: ${m.value || '—'} (${m.confidence}) · because ${m.arithmetic}`),
    '', 'CATALOG (every node — nothing hidden):',
    ...bundle.catalog.map((c) => `  ${c.node} · ${c.rawCount} lines · ${c.transform} · ${JSON.stringify(c.roles)}`),
    '', 'EVIDENCE (cite these ids in from_evidence):',
    ...bundle.evidence.slice(0, 120).map((e) => `  [${e.evidence_id}] (${e.node}/${e.tag}, ${e.role}) ${e.raw}`),
    '', 'Decide EVERY attribute you can ground (+ add new grounded ones). One reasoning_steps entry per attribute minimum; cite the evidence_id behind each claim.',
  ].join('\n');
  return { system: 'MERGED', user };
}
const norm = (s) => String(s ?? '').trim().toLowerCase();
function mergeWithLLM(merged, llmOut, evidenceIds) {
  const arithByKey = new Map(merged.map((m) => [m.key, m]));
  const llmByKey = new Map();
  for (const a of llmOut?.attributes || []) if (a && a.key) llmByKey.set(a.key, a);
  const out = [];
  const groundOf = (a) => { const cites = (a.reasoning_steps || []).flatMap((s) => s.from_evidence || []); return cites.length > 0 && cites.every((id) => evidenceIds.has(id)); };
  const reasonOf = (a) => (a.reasoning_steps || []).map((s) => ({ claim: s.claim, evidence: s.from_evidence || [], rejected: s.rejected }));
  for (const m of merged) {
    const la = llmByKey.get(m.key);
    if (!la) { if (m.shown) out.push({ key: m.key, label: m.label, group: m.group, value: m.value, confidence: m.confidence, provenance: 'arithmetic', arithmetic: { value: m.value, confidence: m.confidence, explanation: m.arithmetic, decisionId: m.decisionId } }); continue; }
    const changed = norm(la.value) !== norm(m.value);
    out.push({ key: m.key, label: m.label, group: m.group, value: la.value, confidence: la.confidence, provenance: changed ? 'llm-changed' : 'llm-confirmed', arithmetic: { value: m.value, confidence: m.confidence, explanation: m.arithmetic, decisionId: m.decisionId }, llm: { value: la.value, confidence: la.confidence, reasoning: reasonOf(la), grounded: groundOf(la) } });
  }
  for (const la of llmOut?.attributes || []) { if (!la || !la.key || arithByKey.has(la.key)) continue; out.push({ key: la.key, label: la.key.replace(/_/g, ' '), group: 'LLM-surfaced', value: la.value, confidence: la.confidence, provenance: 'llm-new', llm: { value: la.value, confidence: la.confidence, reasoning: reasonOf(la), grounded: groundOf(la) } }); }
  return out;
}
function synthDelta(f) { return { total: f.length, arithmetic: f.filter((x) => x.provenance === 'arithmetic').length, confirmed: f.filter((x) => x.provenance === 'llm-confirmed').length, changed: f.filter((x) => x.provenance === 'llm-changed').length, llmNew: f.filter((x) => x.provenance === 'llm-new').length, ungrounded: f.filter((x) => x.llm && !x.llm.grounded).length }; }
function synthEval(finals) {
  const llm = finals.filter((f) => f.llm); const grounded = llm.filter((f) => f.llm.grounded).length; const ungrounded = llm.length - grounded;
  const groundedPct = llm.length ? Math.round((grounded / llm.length) * 100) : 0;
  const avgConfidence = finals.length ? Math.round(finals.reduce((s, f) => s + (f.confidence || 0), 0) / finals.length) : 0;
  const lowConfidence = finals.filter((f) => (f.confidence || 0) < 50).length;
  const changed = finals.filter((f) => f.provenance === 'llm-changed').length; const llmNew = finals.filter((f) => f.provenance === 'llm-new').length; const arithmeticOnly = finals.filter((f) => f.provenance === 'arithmetic').length;
  const verdict = groundedPct >= 80 && ungrounded <= 2 && lowConfidence <= Math.ceil(finals.length * 0.25) ? 'strong' : 'review';
  return { surfaced: finals.length, llmDecided: llm.length, grounded, ungrounded, groundedPct, avgConfidence, lowConfidence, changed, llmNew, arithmeticOnly, verdict };
}

// ── fixture ──
const persona = { all: [
  { key: 'business_type', label: 'Business type', group: 'Identity & firm', value: 'Manufacturer', confidence: 67, shown: true, sources: ['pns-insights', 'prev-bl'], confidenceLedger: [{ label: 'base', delta: 60 }, { label: 'corroboration', delta: 12 }, { label: 'contradiction', delta: -5 }] },
  { key: 'scale', label: 'Scale', group: 'Scale & maturity', value: 'Industrial · high', confidence: 62, shown: true, sources: ['prev-bl'], confidenceLedger: [{ label: 'base', delta: 62 }] },
  { key: 'language', label: 'Language', group: 'Comms & engagement', value: 'Hindi', confidence: 70, shown: true, sources: ['wa-in'], confidenceLedger: [{ label: 'base', delta: 70 }] },
  { key: 'decision_velocity', label: 'Decision velocity', group: 'Intent & behavior', value: 'Unknown', confidence: 0, shown: false, sources: [], confidenceLedger: [], ignoredReason: 'needs grounding evidence' },
] };
const L = { decisions: [
  { id: 'd:business_type', key: 'business_type', value: 'Manufacturer', confidence: 67, reasoning: '4 manufacturing beliefs → Manufacturer', contributions: [{ source: 'pns-insights', points: 40 }, { source: 'prev-bl', points: 27 }] },
  { id: 'd:identity_name', key: 'identity_name', value: 'Jaiveer', confidence: 95, reasoning: 'single first-party source', contributions: [{ source: 'profile-api', points: 95 }] },
] };
const bundle = { catalog: [{ node: 'pns-insights', rawCount: 5, transform: 'llm', roles: { decisive: 2 } }], evidence: [{ evidence_id: 'f3', node: 'pns-insights', tag: 'pns.persona', raw: 'Manufacturer', role: 'decisive' }, { evidence_id: 'f4', node: 'befisc', tag: 'befisc.income', raw: '8L', role: 'available' }] };
const evidenceIds = new Set(['f1', 'f2', 'f3', 'f4']);
const llmOut = { attributes: [
  { key: 'business_type', value: 'Manufacturer', confidence: 90, reasoning_steps: [{ claim: 'producer not reseller', from_evidence: ['f3'], delta: 40 }] },
  { key: 'scale', value: 'Mid-market', confidence: 72, reasoning_steps: [{ claim: 'income band 8L', from_evidence: ['f4'], delta: 50, rejected: 'large — no >100-staff signal' }] },
  { key: 'export_orientation', value: 'Domestic-only', confidence: 55, reasoning_steps: [{ claim: 'no export mentions', from_evidence: ['f99'], delta: 30 }] }, // f99 fake → ungrounded
] };

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const merged = mergeArithmetic(L, persona);
const m = (k) => merged.find((x) => x.key === k);
const finals = mergeWithLLM(merged, llmOut, evidenceIds);
const f = (k) => finals.find((x) => x.key === k);
const prompt = buildMergedSynthPrompt(merged, bundle);
const delta = synthDelta(finals);

ok('MERGE: business_type unified into ONE entry with the decisionId overlaid', m('business_type') && m('business_type').decisionId === 'd:business_type' && merged.filter((x) => x.key === 'business_type').length === 1);
ok('MERGE: persona schema kept incl. HELD slot (decision_velocity, shown=false, "needs grounding")', m('decision_velocity') && m('decision_velocity').shown === false && /needs grounding/.test(m('decision_velocity').arithmetic));
ok('MERGE: legacy-only decision (identity_name) added under Decisions with its id', m('identity_name') && m('identity_name').group === 'Decisions' && m('identity_name').decisionId === 'd:identity_name');
ok('MERGE: business_type arithmetic explanation carries the decision reasoning', /manufacturing beliefs/.test(m('business_type').arithmetic));
ok('PROMPT: arithmetic = ONE input + decide-each instruction + evidence to cite', /you decide each/.test(prompt.user) && /business_type \[Business type\] — arithmetic: Manufacturer/.test(prompt.user) && /cite these ids in from_evidence/.test(prompt.user) && /Decide EVERY attribute/.test(prompt.user));
ok('LLM OVERRIDES value: scale → "Mid-market" (not the arithmetic "Industrial · high")', f('scale').value === 'Mid-market' && f('scale').provenance === 'llm-changed' && f('scale').arithmetic.value === 'Industrial · high');
ok('LLM confirm: business_type stays Manufacturer → llm-confirmed (arithmetic kept beside)', f('business_type').provenance === 'llm-confirmed' && f('business_type').value === 'Manufacturer' && f('business_type').arithmetic.value === 'Manufacturer');
ok('LLM silent on a shown arithmetic attr (language) → provenance arithmetic, value stands', f('language').provenance === 'arithmetic' && f('language').value === 'Hindi');
ok('LLM silent on a HELD attr (decision_velocity) → NOT surfaced', !f('decision_velocity'));
ok('NEW attribute the LLM surfaced (export_orientation) → llm-new under LLM-surfaced', f('export_orientation') && f('export_orientation').provenance === 'llm-new' && f('export_orientation').group === 'LLM-surfaced');
ok('GROUNDING: business_type cites a real id → grounded; export_orientation cites f99 → ungrounded', f('business_type').llm.grounded === true && f('export_orientation').llm.grounded === false);
ok('DELTA counts: total 5 · arithmetic 2 · confirmed 1 · changed 1 · llmNew 1 · ungrounded 1', delta.total === 5 && delta.arithmetic === 2 && delta.confirmed === 1 && delta.changed === 1 && delta.llmNew === 1 && delta.ungrounded === 1);
ok('LLM reasoning is STRUCTURED per attribute (claim + cited evidence id + rejected branch)', f('scale').llm.reasoning[0].claim.includes('income band 8L') && f('scale').llm.reasoning[0].evidence.includes('f4') && /large/.test(f('scale').llm.reasoning[0].rejected));

// ── EVAL band (agentic observability) ──
const ev = synthEval(finals);
ok('EVAL: surfaced 5 · llmDecided 3 · grounded 2 · ungrounded 1 · groundedPct 67', ev.surfaced === 5 && ev.llmDecided === 3 && ev.grounded === 2 && ev.ungrounded === 1 && ev.groundedPct === 67);
ok('EVAL: changed 1 · llmNew 1 · arithmeticOnly 2 · avgConfidence reported', ev.changed === 1 && ev.llmNew === 1 && ev.arithmeticOnly === 2 && ev.avgConfidence > 0);
ok('EVAL: verdict = review (groundedPct 67 < 80 → flagged)', ev.verdict === 'review');

console.log(`\nsynthtest (Merged Synthesis Engine · arithmetic merge + decisionId · prompt re-verify/fill/extend · LLM overrides + provenance + grounding + eval band): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
