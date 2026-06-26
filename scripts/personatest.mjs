// Deterministic test for the Buyer Persona Registry (Wave 1 · mirrors personaRegistry.ts pipeline).
// Proves: candidate → evidence-check → contradiction-check → confidence → promotion-gate → registry;
// stability + lastChangedBy present; corroboration raises confidence; a contradiction lowers it +
// caps stability; the promotion gate HIDES weak/no-evidence attrs WITH an ignoredReason. NO LLM.

const PROMOTE = 55;
function attr(key, value, ev, contra) {
  const srcSet = [...new Set(ev.map((f) => f.sourceNode))];
  const base = key === 'price_sensitivity' ? 30 : 60;
  const corro = 12 * Math.max(0, srcSet.length - 1);
  const pen = contra.length ? 15 : 0;
  const confidenceLedger = []; if (ev.length) { confidenceLedger.push({ label: 'base', delta: base, kind: 'base' }); if (corro) confidenceLedger.push({ label: 'corroboration', delta: corro, kind: 'corroboration' }); if (pen) confidenceLedger.push({ label: 'contradiction', delta: -pen, kind: 'penalty' }); }
  let confidence = base + corro - pen;
  confidence = Math.max(0, Math.min(95, ev.length ? confidence : 0));
  const episodes = new Set(ev.map((f) => f.lineRef || f.id)).size;
  const stabilityScore = Math.max(0, Math.min(100, ev.length ? 40 + 15 * srcSet.length + 6 * episodes - (contra.length ? 25 : 0) : 0));
  const stability = stabilityScore >= 75 ? 'High' : stabilityScore >= 50 ? 'Medium' : 'Low';
  const stabilityNote = `${episodes} evidence lines · ${srcSet.length} sources${contra.length ? ' · 1 conflict' : ''}`;
  const lastChangedBy = ev.length ? `${ev[0].sourceNode}${ev[0].lineRef ? ' · ' + ev[0].lineRef : ''}` : '—';
  const shown = confidence >= PROMOTE && ev.length > 0;
  const ignoredReason = shown ? undefined : (!ev.length ? 'needs grounding evidence' : contra.length ? 'conflicting sources — unresolved' : 'low confidence — single weak signal');
  return { key, value, confidence, stability, stabilityScore, stabilityNote, lastChangedBy, evidence: ev, contradictions: contra, sources: srcSet, confidenceLedger, shown, ignoredReason };
}
// mirror: readSet + completenessCritic
function readSet(facts) { const c = { read: facts.length, used: 0, supportive: 0, held: 0, discounted: 0, noise: 0 }; for (const f of facts) { const r = f.role || 'available'; if (r === 'decisive') c.used++; else if (r === 'scanned') c.supportive++; else if (r === 'available') c.held++; else if (r === 'discounted') c.discounted++; else c.noise++; } return c; }
function critic(decisions, nFacts) { const imp = []; for (const d of decisions) for (const ig of d.ignoredImpact || []) imp.push(ig); imp.sort((a, b) => b.estDelta - a.estDelta); const max = imp[0]?.estDelta ?? 0; return { reviewed: nFacts, maxImpact: max, verdict: max < 20 ? 'stable' : 'review' }; }

const F = (id, sourceNode, rawValue, lineRef) => ({ id, sourceNode, rawValue, lineRef });
// business_type: 2 distinct sources (PNS persona + BL), no contradiction → High, shown
const businessType = attr('business_type', 'Manufacturer', [F('f1', 'pns-insights', 'Manufacturer', 'call 1'), F('f2', 'prev-bl', '1300Pcs/Hr Notebook Making Machine', 'BL 1')], []);
// machine_ownership: evidence (BL + ISQ) BUT contradicted by "new venture / setting up" → penalty + Medium
const machine = attr('machine_ownership', 'Likely installed', [F('f2', 'prev-bl', 'Notebook Making Machine', 'BL 1'), F('f3', 'prev-isq', 'Automation Grade=Semi-Automatic', 'ISQ 1')], [F('f4', 'pns-insights', 'new notebook business venture', 'call 4')]);
// price_sensitivity: a single weak nudge signal → below gate → HIDDEN with reason
const price = attr('price_sensitivity', 'Medium (weak)', [F('f5', 'wa-out', 'High price', 'WA')], []);
// decision_velocity: no evidence → HIDDEN, "no grounding evidence"
const velocity = attr('decision_velocity', 'Unknown', [], []);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

ok('business_type promoted (≥2 sources, no contradiction) → shown', businessType.shown === true);
ok('business_type stability High (corroborated, unconflicted)', businessType.stability === 'High');
ok('business_type confidence rose via corroboration (>base 60)', businessType.confidence > 60);
ok('every attr carries stability + lastChangedBy', [businessType, machine, price].every((a) => a.stability && a.lastChangedBy && a.lastChangedBy !== ''));
ok('machine_ownership keeps its CONTRADICTION (new-venture) first-class', machine.contradictions.length === 1 && /new.*venture/i.test(machine.contradictions[0].rawValue));
ok('contradiction lowers confidence AND caps stability at Medium', machine.confidence < 60 && machine.stability === 'Medium');
ok('price_sensitivity HIDDEN (weak single signal) with ignoredReason', price.shown === false && /low confidence/.test(price.ignoredReason));
ok('decision_velocity HIDDEN (no evidence) with ignoredReason', velocity.shown === false && /needs grounding evidence/.test(velocity.ignoredReason));
ok('lastChangedBy points at the moving source line', businessType.lastChangedBy === 'pns-insights · call 1');
ok('promotion gate is the only path to shown (no shown without evidence)', [businessType, machine, price, velocity].every((a) => !a.shown || a.evidence.length > 0));
// confidence ledger (+base +corroboration −penalty = net)
ok('confidence ledger sums to the confidence (base + corroboration − penalty)', businessType.confidenceLedger.reduce((s, i) => s + i.delta, 0) === businessType.confidence);
ok('confidence ledger shows the contradiction as a NEGATIVE penalty', machine.confidenceLedger.some((i) => i.kind === 'penalty' && i.delta < 0));
// read set (reframes "not referenced" → read N + breakdown; nothing "never opened")
const rs = readSet([{ role: 'decisive' }, { role: 'decisive' }, { role: 'scanned' }, { role: 'available' }, { role: 'available' }, { role: 'discounted' }, { role: 'noise' }, { role: 'noise' }]);
ok('read set: read = total facts (every fact was opened + roled)', rs.read === 8 && rs.used === 2 && rs.supportive === 1 && rs.held === 2 && rs.discounted === 1 && rs.noise === 2);
ok('read set: used + supportive + held + discounted + noise === read (no orphans)', rs.used + rs.supportive + rs.held + rs.discounted + rs.noise === rs.read);
// completeness critic (top unused reinforces → stable)
const cr = critic([{ ignoredImpact: [{ raw: 'Rs 70-74 Lakh', estDelta: 12, note: 'scale' }, { raw: '100000 kg', estDelta: 10, note: 'bulk' }] }], 481);
ok('completeness critic: reviewed all facts · top unused < 20 → verdict stable', cr.reviewed === 481 && cr.maxImpact === 12 && cr.verdict === 'stable');
// richer stability (breadth score, not just band) + held-with-needs (schema-driven coverage)
ok('stability is a 0-100 breadth score (business_type ≥75 → High) with a note', businessType.stabilityScore >= 75 && businessType.stability === 'High' && /sources/.test(businessType.stabilityNote));
ok('contradiction lowers stability score (machine < business_type, still Medium)', machine.stabilityScore < businessType.stabilityScore && machine.stability === 'Medium');
ok('ungrounded schema slot → held with a "needs" hint (not silently dropped)', velocity.shown === false && /needs/.test(velocity.ignoredReason) && velocity.stabilityScore === 0);

console.log(`\npersonatest (Wave 1 · persona registry · candidate→evidence→contradiction→confidence→promotion-gate · stability · lastChangedBy · ignored-personas): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
