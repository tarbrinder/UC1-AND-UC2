// Deterministic test for the Pipeline Trace (Master-Observatory foundation · mirrors pipelineTrace.ts).
// Proves: the full spine of spans (Stage 0 Pull + source spans · 1 Synthesis · 2 Twin · 3 Requirement ·
// 4-7 honest pending RFQ-flow stages); external (Befisc/Sign3) is a FIRST-CLASS source stage; passthrough-vs-
// transform flag is honest; and the CUMULATIVE twinAfter grows monotonically with isNew flags (the evolving
// buyer twin — the pinned rail). NO LLM, NO fetch. ALSO proves: EVERY expected source gets a span — even ones that
// returned no data this pull — flagged status:'empty' with an upstream-gap note (so a silent gap like PNS coming
// back empty is VISIBLE in Pull Sources instead of the node just vanishing).

const ORDER = ['profile-api', 'glusr', 'pns-insights', 'prev-bl', 'prev-isq', 'csl', 'wa-in', 'wa-out', 'befisc', 'sign3'];
const TRANSFORMED = { 'profile-api': false, glusr: false, 'pns-insights': true, 'prev-bl': false, 'prev-isq': false, csl: false, 'wa-in': true, 'wa-out': true, befisc: false, sign3: false };
const TWIN_SECTION = { 'profile-api': 'Identity', glusr: 'Identity', 'pns-insights': 'Sales calls', 'prev-bl': 'Requirements', 'prev-isq': 'Requirements', csl: 'Browsing', 'wa-in': 'Chat', 'wa-out': 'Chat', befisc: 'External', sign3: 'External' };
const LABEL = { 'profile-api': 'Profile API', glusr: 'GLUSR · Account', 'pns-insights': 'PNS Call Insights', 'prev-bl': 'Previous BuyLeads', 'prev-isq': 'Previous ISQ', csl: 'CSL Browse/Search', 'wa-in': 'WhatsApp In', 'wa-out': 'WhatsApp Out', befisc: 'Befisc · External Identity', sign3: 'Sign3 · Social Presence' };
const leaf = (f) => f.lineRef || f.jsonPath.split('.').pop() || f.tag;
const trunc = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);

function buildPipelineTrace(L, persona, opts = {}) {
  const { glid, requirements = [], journey } = opts;
  const spans = [];
  const acc = [];
  const snapshot = (id) => { const m = new Map(); for (const it of acc) { if (!m.has(it.group)) m.set(it.group, []); m.get(it.group).push({ k: it.k, v: it.v, isNew: it.addedBy === id }); } return [...m.entries()].map(([group, items]) => ({ group, items })); };
  const factsBy = new Map(); for (const f of L.facts) { const a = factsBy.get(f.sourceNode) || []; a.push(f); factsBy.set(f.sourceNode, a); }
  const present = ORDER.filter((s) => (factsBy.get(s) || []).length > 0);
  const pullId = 'span-pull';
  spans.push({ id: pullId, parentId: null, kind: 'pull', stageNo: 0, stage: 'Pull Sources', status: 'ok', pending: false, transformed: false, note: `Pulled ${present.length} of ${ORDER.length} sources for GLID ${glid || '—'}${present.length < ORDER.length ? ` · ${ORDER.length - present.length} returned no data` : ''}`, cooked: present.map((s) => ({ label: LABEL[s], value: `${(factsBy.get(s) || []).length} facts` })), twinAfter: [] });
  for (const s of ORDER) {
    const facts = factsBy.get(s) || []; const id = `span-src-${s}`;
    const cooked = facts.slice(0, 10).map((f) => ({ label: leaf(f), value: trunc(f.rawValue), role: f.role }));
    for (const f of facts.slice(0, 6)) acc.push({ group: TWIN_SECTION[s], k: leaf(f), v: trunc(f.rawValue, 40), addedBy: id });
    spans.push({ id, parentId: pullId, kind: 'source', stageNo: 0, stage: LABEL[s], source: s, status: facts.length ? 'ok' : 'empty', pending: false, transformed: TRANSFORMED[s], note: facts.length ? (TRANSFORMED[s] ? 'reshaped / distilled upstream' : 'fields read as-is (passthrough — unchanged)') : 'pulled — 0 fields · this source returned no data in this pull (check the node upstream)', cooked, scores: [{ label: 'facts', value: String(facts.length) }, { label: 'used', value: String(facts.filter((f) => f.coverage === 'used').length) }], twinAfter: snapshot(id) });
  }
  const fuseId = 'span-fuse';
  for (const a of persona.shown) acc.push({ group: `Deduced · ${a.group}`, k: a.label, v: a.value, addedBy: fuseId });
  const allSteps = L.decisions.flatMap((d) => d.reasoningSteps || []);
  spans.push({ id: fuseId, parentId: pullId, kind: 'fuse', stageNo: 1, stage: 'Buyer Synthesis', status: 'ok', pending: false, transformed: true, note: '', cooked: persona.shown.map((a) => ({ label: a.label, value: `${a.value} (${a.confidence})` })), reasoning: allSteps, decisions: L.decisions.map((d) => d.id), scores: [{ label: 'attributes', value: String(persona.shown.length) }, { label: 'reasoning steps', value: String(allSteps.length) }], twinAfter: snapshot(fuseId) });
  const enrId = 'span-enrich';
  spans.push({ id: enrId, parentId: null, kind: 'enrichment', stageNo: 2, stage: 'Buyer Profile Enrichment', status: 'ok', pending: false, transformed: true, note: '', cooked: persona.shown.map((a) => ({ label: a.label, value: a.value })), twinAfter: snapshot(enrId) });
  const twinId = 'span-twin';
  spans.push({ id: twinId, parentId: null, kind: 'twin', stageNo: 3, stage: 'Buyer Twin', status: 'ok', pending: false, transformed: false, note: '', cooked: persona.shown.map((a) => ({ label: a.label, value: a.value })), twinAfter: snapshot(twinId) });
  const reqId = 'span-req';
  if (journey) { acc.push({ group: 'Deduced · Journey', k: 'Operating arc', v: journey.arc, addedBy: reqId }); acc.push({ group: 'Deduced · Journey', k: 'Maturity', v: journey.maturity, addedBy: reqId }); }
  spans.push({ id: reqId, parentId: null, kind: 'requirement', stageNo: 4, stage: 'Requirement Intelligence', status: requirements.length ? 'ok' : 'empty', pending: false, transformed: true, note: '', cooked: requirements.map((r) => ({ label: r.title, value: `${r.specCount} specs` })), twinAfter: snapshot(reqId) });
  const pend = [['span-intent', 'intent', 5, 'Intent Intelligence'], ['span-planner', 'planner', 6, 'Planner'], ['span-rfq', 'rfq', 7, 'RFQ'], ['span-outcome', 'outcome', 8, 'Outcome']];
  for (const [id, kind, stageNo, stage] of pend) spans.push({ id, parentId: null, kind, stageNo, stage, status: 'empty', pending: true, transformed: false, note: '', cooked: [], twinAfter: snapshot(id) });
  return { useCase: 'Buyer Intelligence', glid, spans };
}

// ── fixture: a small ledger (5 sources WITH facts incl. external; the other 5 expected sources return nothing this pull) + persona + requirement/journey ──
const F = (id, sourceNode, rawValue, jsonPath, tag, coverage, role, lineRef) => ({ id, sourceNode, rawValue, jsonPath, tag, coverage, role, lineRef });
const L = { facts: [
  F('f1', 'profile-api', 'Jaiveer', 'buyer_profile.glusr_usr_name', 'profile.name', 'used', 'decisive'),
  F('f2', 'profile-api', 'Auraiya', 'buyer_profile.city', 'profile.city', 'used', 'scanned'),
  F('f3', 'pns-insights', 'Manufacturer', 'pns.persona', 'pns.persona', 'used', 'decisive', 'call 1'),
  F('f4', 'prev-bl', 'Notebook Making Machine', 'bl.title', 'bl.title', 'used', 'decisive', 'BL 1'),
  F('f5', 'befisc', '8L income', 'befisc.income', 'befisc.income', 'used', 'available'),
  F('f6', 'sign3', '5 social profiles', 'sign3.socialProfiles', 'sign3.social', 'available', 'available'),
], decisions: [
  { id: 'd1', key: 'business_type', value: 'Manufacturer', reasoningSteps: [{ n: 1, claim: 'PNS persona = Manufacturer', fromEvidence: ['f3'], delta: 60, via: 'rule' }, { n: 2, claim: 'BL = machine → corroborates', fromEvidence: ['f4'], delta: 12, via: 'rule' }] },
  { id: 'd2', key: 'scale', value: 'Mid', reasoningSteps: [{ n: 1, claim: 'income band 8L', fromEvidence: ['f5'], delta: 50, via: 'rule' }] },
] };
const persona = { headline: 'Notebook Manufacturer', shown: [
  { key: 'business_type', label: 'Business type', group: 'Identity', value: 'Manufacturer', confidence: 88 },
  { key: 'scale', label: 'Scale', group: 'Scale', value: 'Mid', confidence: 70 },
], hidden: [{ key: 'velocity', label: 'Decision velocity', group: 'Behaviour', value: 'Unknown', confidence: 0 }], all: [] };
const opts = { glid: '268590579', requirements: [{ title: 'Notebook Making Machine', specCount: 2, hasBL: true, hasISQ: true }], journey: { arc: 'Setting up a manufacturing unit', maturity: 'Growing manufacturer', steps: 1 } };

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const T = buildPipelineTrace(L, persona, opts);
const byId = (id) => T.spans.find((s) => s.id === id);
const sources = T.spans.filter((s) => s.kind === 'source');
const pull = byId('span-pull'), fuse = byId('span-fuse'), twin = byId('span-twin'), req = byId('span-req');
const itemCount = (sp) => sp.twinAfter.reduce((n, sec) => n + sec.items.length, 0);

ok('full spine present (pull + 10 source spans + fuse + enrichment + twin + req + 4 pending = 19 spans)', T.spans.length === 19);
ok('Stage 0 = Pull, first span, kind pull', T.spans[0].id === 'span-pull' && pull.kind === 'pull' && pull.stageNo === 0);
ok('one source span per EXPECTED source (10, incl. empties), all stage 0, child of pull', sources.length === 10 && sources.every((s) => s.stageNo === 0 && s.parentId === 'span-pull'));
ok('EMPTY sources are SHOWN, flagged status:empty + upstream-gap note (csl/wa-in returned no data); present ones stay ok', byId('span-src-csl').status === 'empty' && /no data in this pull/.test(byId('span-src-csl').note) && byId('span-src-wa-in').status === 'empty' && byId('span-src-glusr').status === 'empty' && byId('span-src-profile-api').status === 'ok' && byId('span-src-pns-insights').status === 'ok');
ok('pull note reports present-of-expected + how many came back empty', /Pulled 5 of 10 sources/.test(pull.note) && /5 returned no data/.test(pull.note));
ok('EXTERNAL is a first-class source stage (Befisc + Sign3 present)', sources.some((s) => s.source === 'befisc') && sources.some((s) => s.source === 'sign3'));
ok('passthrough-vs-transform honest (PNS transformed; profile/BL/befisc/sign3 passthrough)', byId('span-src-pns-insights').transformed === true && byId('span-src-profile-api').transformed === false && byId('span-src-befisc').transformed === false && byId('span-src-sign3').transformed === false);
ok('Stage 1 Synthesis: decisions + reasoning steps carried', fuse.stageNo === 1 && fuse.decisions.length === 2 && fuse.reasoning.length === 3);
ok('Stage 3 Twin (now AFTER enrichment): twinAfter has RAW Identity AND Deduced · Identity', twin.stageNo === 3 && twin.twinAfter.some((s) => s.group === 'Identity') && twin.twinAfter.some((s) => s.group === 'Deduced · Identity'));
ok('Stage 2 Enrichment (now BEFORE twin): existing↔new before/after stage present (kind enrichment, stageNo 2)', byId('span-enrich') && byId('span-enrich').kind === 'enrichment' && byId('span-enrich').stageNo === 2 && byId('span-enrich').pending === false);
ok('Stage 4 Requirement: ok status + journey arc/maturity in twin', req.stageNo === 4 && req.status === 'ok' && req.twinAfter.some((s) => s.group === 'Deduced · Journey' && s.items.length === 2));
ok('Stages 5-8 are honest PENDING spine stages', ['span-intent', 'span-planner', 'span-rfq', 'span-outcome'].every((id) => byId(id).pending === true && byId(id).status === 'empty'));
ok('pull twin is empty (nothing believed yet — only gathered)', itemCount(pull) === 0);
ok('twinAfter grows monotonically (pull ≤ first source ≤ fuse ≤ twin ≤ req)', itemCount(pull) <= itemCount(sources[0]) && itemCount(sources[0]) <= itemCount(fuse) && itemCount(fuse) <= itemCount(twin) && itemCount(twin) <= itemCount(req));
ok('deductions ADD to the twin at Fusion (fuse item count > last source)', itemCount(fuse) > itemCount(sources[sources.length - 1]));
ok('isNew flags the items a stage ADDED (fuse flags deduced; source flags its own raw)', fuse.twinAfter.some((s) => s.items.some((i) => i.isNew)) && byId('span-src-profile-api').twinAfter.some((s) => s.items.some((i) => i.isNew)));
ok('twin span flags nothing new (carry-forward snapshot)', twin.twinAfter.every((s) => s.items.every((i) => !i.isNew)));
ok('requirement stage flags ONLY the journey items as new', req.twinAfter.filter((s) => s.items.some((i) => i.isNew)).every((s) => s.group === 'Deduced · Journey'));

console.log(`\npipelinetest (Master-Observatory · OTEL span spine · Stage 0-7 · external-as-stage · passthrough/transform · cumulative evolving twin + isNew): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
