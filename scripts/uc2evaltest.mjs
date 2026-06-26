// Deterministic test for UC2 requirement enrichment (mirrors src/lib/uc2Enrichment.ts mergeUC2LLM + uc2Eval).
// Proves the grounding contract: a corrected/added edit is APPLIED only when it cites ≥1 real fN evidence id AND
// confidence ≥ 50; an ungrounded change is HELD (not shown) and counted as a hallucination; a cited id that isn't
// in the bundle is a LEAK; verdict is honest ('no-llm' when no LLM, 'strong' only when grounded & 0 halluc/leaks).
// NO LLM, NO fetch. `node scripts/uc2evaltest.mjs`.

const GATE_LO = 50;
function resolveEv(ids, byId) { const ev = []; let leaks = 0; for (const id of ids || []) { const e = byId.get(id); if (e) ev.push(e); else leaks++; } return { ev, leaks }; }
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function uc2Eval(edits, leaks, llmApplied) {
  const attempts = edits.filter((x) => x.kind === 'corrected' || x.kind === 'added' || (!x.applied && x.to && x.to !== x.from));
  const changed = edits.filter((x) => x.applied && (x.kind === 'corrected' || x.kind === 'added'));
  const corrected = edits.filter((x) => x.applied && x.kind === 'corrected').length;
  const added = edits.filter((x) => x.applied && x.kind === 'added').length;
  const groundedPct = attempts.length ? Math.round((attempts.filter((x) => x.grounded).length / attempts.length) * 100) : 100;
  const hallucinations = attempts.filter((x) => !x.grounded).length;
  const verdict = !llmApplied ? 'no-llm' : (groundedPct >= 80 && hallucinations === 0 && leaks === 0) ? 'strong' : groundedPct < 50 ? 'thin' : 'mixed';
  return { changed: changed.length, corrected, added, groundedPct, hallucinations, leaks, llmApplied, verdict };
}

function mergeUC2(ctx, out) {
  const byId = new Map(ctx.evidence.map((e) => [e.evidence_id, e]));
  const editsFull = []; let leaks = 0;
  if (out && Array.isArray(out.edits)) {
    for (const e of out.edits) {
      const group = ['title', 'category', 'location', 'spec'].includes(String(e.group)) ? e.group : 'spec';
      const rawKind = String(e.kind || 'kept');
      const kind = ['kept', 'corrected', 'added'].includes(rawKind) ? rawKind : 'kept';
      const { ev, leaks: lk } = resolveEv(e.evidence_ids, byId); leaks += lk;
      const conf = typeof e.confidence === 'number' ? Math.max(0, Math.min(100, e.confidence)) : 0;
      const grounded = !!e.grounded && ev.length > 0;
      const to = String(e.to ?? e.value ?? ''); const from = String(e.from ?? '');
      const locationOverwrite = group === 'location' && kind === 'corrected'; // O28 — never overwrite the operating city
      const tok = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g)) || []);
      const recCat = tok(ctx.selReq && ctx.selReq.category); // product-line lock — block category switch across product lines
      const categorySwitch = group === 'category' && kind === 'corrected' && recCat.size > 0 && ![...tok(to)].some((t) => recCat.has(t));
      const wantsChange = (kind === 'corrected' || kind === 'added') && !!to;
      const applied = wantsChange && grounded && conf >= GATE_LO && !locationOverwrite && !categorySwitch;
      editsFull.push({ field: e.field || group, group, kind: applied ? kind : (wantsChange ? 'kept' : kind), from, to, confidence: conf, grounded, applied, evidence: ev, reason: String(e.reason || '') });
    }
  }
  return { edits: editsFull, eval: uc2Eval(editsFull, leaks, !!out) };
}

// ── fixtures ──
const ctx = { evidence: [
  { evidence_id: 'f1', node: 'pns', tag: 'narrative', raw: 'buyer said brass-plated metal buttons, round shape' },
  { evidence_id: 'f2', node: 'csl', tag: 'search', raw: 'metal buttons 200 pack' },
] };

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

// 1) grounded correction → applied; verdict strong
{
  const r = mergeUC2(ctx, { edits: [{ group: 'spec', field: 'Material', kind: 'corrected', from: 'Metal', to: 'Brass-plated Metal', confidence: 85, grounded: true, evidence_ids: ['f1'] }] });
  ok('grounded correction applied', r.edits[0].applied === true && r.edits[0].kind === 'corrected');
  ok('grounded correction verdict strong', r.eval.verdict === 'strong' && r.eval.hallucinations === 0 && r.eval.leaks === 0);
}
// 2) ungrounded correction → held + hallucination
{
  const r = mergeUC2(ctx, { edits: [{ group: 'title', field: 'title', kind: 'corrected', from: 'Buttons', to: 'Gold Buttons', confidence: 90, grounded: false, evidence_ids: [] }] });
  ok('ungrounded correction HELD (not applied)', r.edits[0].applied === false && r.edits[0].kind === 'kept');
  ok('ungrounded correction counted as hallucination', r.eval.hallucinations === 1 && r.eval.verdict !== 'strong');
}
// 3) cited id not in bundle → leak
{
  const r = mergeUC2(ctx, { edits: [{ group: 'spec', field: 'Shape', kind: 'corrected', from: 'Round', to: 'Oval', confidence: 80, grounded: true, evidence_ids: ['f99'] }] });
  ok('phantom citation → leak counted', r.eval.leaks === 1);
  ok('phantom-cited edit not grounded → held', r.edits[0].applied === false);
}
// 4) low-confidence grounded → held by the gate
{
  const r = mergeUC2(ctx, { edits: [{ group: 'spec', field: 'Material', kind: 'corrected', from: 'Metal', to: 'Steel', confidence: 40, grounded: true, evidence_ids: ['f1'] }] });
  ok('below-gate (conf<50) correction held', r.edits[0].applied === false);
}
// 5) grounded ADD → applied
{
  const r = mergeUC2(ctx, { edits: [{ group: 'spec', field: 'Quantity', kind: 'added', from: '', to: '200 Pack', confidence: 75, grounded: true, evidence_ids: ['f2'] }] });
  ok('grounded add applied', r.edits[0].applied === true && r.eval.added === 1);
}
// 6) no edits → clean, verdict strong (nothing to ground)
{
  const r = mergeUC2(ctx, { edits: [] });
  ok('no edits → groundedPct 100 · verdict strong', r.eval.groundedPct === 100 && r.eval.verdict === 'strong' && r.eval.changed === 0);
}
// 7) no LLM (out null) → verdict no-llm (honest)
{
  const r = mergeUC2(ctx, null);
  ok('no-LLM → verdict no-llm', r.eval.verdict === 'no-llm' && r.eval.llmApplied === false);
}
// 8) O28 LOCATION LOCK — a grounded, high-conf location overwrite must NEVER apply (operating city is immutable)
{
  const r = mergeUC2(ctx, { edits: [{ group: 'location', field: 'location', kind: 'corrected', from: 'Auraiya', to: 'Kanpur', confidence: 95, grounded: true, evidence_ids: ['f1'] }] });
  ok('location overwrite blocked (never applied)', r.edits[0].applied === false && r.edits[0].kind === 'kept');
}
// 9) PRODUCT-LINE LOCK — a category "correction" that shares NO token with the recorded product is a cross-product switch → blocked
{
  const ctxM = { evidence: ctx.evidence, selReq: { category: 'Notebook Making Machines' } };
  const switched = mergeUC2(ctxM, { edits: [{ group: 'category', field: 'category', kind: 'corrected', from: 'Notebook Making Machines', to: 'Raw Paper Material', confidence: 90, grounded: true, evidence_ids: ['f1'] }] });
  ok('cross-product category switch blocked (machine→paper)', switched.edits[0].applied === false && switched.edits[0].kind === 'kept');
  const refined = mergeUC2(ctxM, { edits: [{ group: 'category', field: 'category', kind: 'corrected', from: 'Notebook Making Machines', to: 'Motorized Notebook Making Machine', confidence: 90, grounded: true, evidence_ids: ['f1'] }] });
  ok('same-line category refinement still applies (shares token)', refined.edits[0].applied === true);
}

console.log(`\nUC2 enrichment harness: ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
