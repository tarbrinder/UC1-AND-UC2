// Deterministic test for the AI INSPECTOR data layer — mirrors src/lib/inspectorData.ts.
// Proves each hovered element kind yields the right provenance: intent→alternatives+source-race,
// planner→why-selected+suppressed, spec→source/status (inference flagged), lastpage→suggested+conf,
// profile→buyer brain. Graceful on missing state. NO LLM.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function intentPayload(state) {
  const i = state.intent; const sections = [];
  if (i.candidates && i.candidates.length) sections.push({ title: 'Alternatives considered (LLM-scored)', rows: i.candidates.map((c, n) => ({ label: `${n + 1}. ${c.label}`, score: c.score, tone: norm(c.label) === norm(i.value || '') ? 'good' : 'muted' })) });
  if (i.decision) { const d = i.decision; const bar = d.threshold ?? 80; const rows = [];
    if (d.registry) rows.push({ label: 'Registry (prior)', score: d.registry.confidence, tone: d.registry.confidence >= bar ? 'good' : 'muted' });
    if (d.twin) rows.push({ label: 'Buyer Twin (active-intent)', score: d.twin.confidence, tone: d.twin.offProfile ? 'bad' : d.twin.confidence >= bar ? 'good' : 'muted' });
    if (d.llm) rows.push({ label: 'LLM derivation', score: d.llm.confidence, tone: d.llm.confidence >= bar ? 'good' : 'muted' });
    if (rows.length) sections.push({ title: `Source precedence (bar ${bar})`, rows }); }
  sections.push({ title: 'Evidence', rows: [{ label: 'journey', value: i.journey }] });
  return { kind: 'intent', title: '🎯 INTENT DECISION', decision: i.value || (i.question ? 'asking the buyer' : 'deriving…'), sections };
}
function plannerPayload(state, key) {
  const p = state.planner; const q = p.questions.find((x) => x.id === key || norm(x.label) === norm(key)); const sections = [];
  if (q) sections.push({ title: 'Why selected', rows: [{ label: 'priority', score: q.priority, tone: 'good' }, { label: 'grounded in', value: q.groundedIn, tone: q.groundedIn ? 'info' : 'warn' }] });
  if (p.considered && p.considered.length) sections.push({ title: 'Suppressed / considered (lost)', rows: p.considered.map((c) => ({ label: c.label, score: c.score, tone: 'bad' })) });
  const used = p.questions.length; const max = p.budgetMax ?? 3;
  sections.push({ title: 'Question budget', rows: [{ label: 'used / max', value: `${used} / ${max}`, tone: used <= max ? 'good' : 'bad' }, { label: 'suppressed', value: String(p.considered?.length ?? 0), tone: 'muted' }] });
  const lowConf = (p.considered || []).filter((c) => c.score < 60);
  if (lowConf.length) sections.push({ title: 'Wanted to ask, lacked confidence', rows: lowConf.map((m) => ({ label: m.label, score: m.score, tone: 'warn' })) });
  return { kind: 'planner-q', title: '🧭 PLANNER QUESTION', decision: q ? q.label : 'question', sections };
}
function failureMode(state) {
  const c = state.category; const conf = state.confidence || {}; const qCount = state.planner?.questions?.length ?? 0;
  if ((conf.buyer ?? 100) < 35 && (conf.category ?? 100) < 35) return { risk: 'bad', label: 'HIGH · thin evidence (cold buyer + empty category)' };
  if (c && c.status === 'hit' && c.band === 'empty') return { risk: 'warn', label: 'MEDIUM · weak category confidence — buyer-only' };
  if (qCount > 3) return { risk: 'warn', label: `MEDIUM · over-questioning (${qCount} > 3 cap)` };
  if ((conf.overall ?? 0) >= 65) return { risk: 'good', label: 'LOW · grounded decisions' };
  return { risk: 'info', label: 'LOW · nominal' };
}
function specPayload(state, key, autofilled) {
  const s = (state.specs || []).find((x) => norm(x.name) === norm(key) || norm(x.name).includes(norm(key))); const sections = [];
  if (s) { const src = s.source || 'unknown'; const isInf = /cascade|inferred|deduc|infer/i.test(src);
    sections.push({ title: 'Decision', rows: [{ label: 'status', value: s.status || (autofilled ? 'AUTO-FILLED' : 'ASKED'), tone: autofilled ? 'good' : 'info' }, { label: 'source', value: src, tone: isInf ? 'warn' : src === 'user' ? 'good' : 'info' }] }); }
  return { kind: autofilled ? 'autofilled-spec' : 'spec', title: autofilled ? '🧩 SPEC · AUTO-FILLED' : '🧩 SPEC DECISION', decision: s ? s.name : key, sections };
}
function lastpagePayload(state, key) {
  const log = state.logistics || {}; const entry = log[key]; const sections = [];
  if (entry) sections.push({ title: 'Decision', rows: [{ label: 'suggested', value: entry.value, tone: 'good' }, { label: 'confidence', score: entry.confidence, tone: entry.confidence >= 70 ? 'good' : entry.confidence >= 40 ? 'warn' : 'bad' }] });
  else sections.push({ title: 'Decision', rows: [{ label: key, value: 'asked (no deduction)', tone: 'info' }] });
  return { kind: 'lastpage', title: '📦 LOGISTICS DECISION', decision: entry ? `${key}: ${entry.value}` : key, sections };
}
function profilePayload(state) { const b = state.buyer || {}; return { kind: 'profile', title: '🧠 BUYER BRAIN', decision: b.nature || b.persona || 'buyer', sections: [{ title: 'Buyer Brain', rows: [{ label: 'identity', value: b.nature || b.persona || '—' }] }] }; }
function buildInspectorPayload(target, state) {
  if (!target) return null; const [kind, ...rest] = target.split(':'); const key = rest.join(':');
  switch (kind) {
    case 'intent': case 'intent-chip': return state.intent ? intentPayload(state) : null;
    case 'planner-q': case 'planner-option': return state.planner ? plannerPayload(state, key) : null;
    case 'spec': return specPayload(state, key, false);
    case 'autofilled-spec': return specPayload(state, key, true);
    case 'lastpage': return lastpagePayload(state, key);
    case 'persona': case 'profile': case 'requirement': case 'confirm': return profilePayload(state);
    default: return null;
  }
}

function searchInspector(state, termRaw) {
  const tokens = String(termRaw || '').toLowerCase().split(/\s+/).map(norm).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const hit = (s) => { if (!s) return false; const n = norm(s); return tokens.some((t) => n.includes(t)); }; const out = [];
  for (const c of state.intent?.candidates || []) if (hit(c.label)) out.push({ surface: 'Intent', label: c.label, disposition: norm(c.label) === norm(state.intent?.value || '') ? 'CHOSEN' : 'candidate' });
  for (const q of state.planner?.questions || []) if (hit(q.label)) out.push({ surface: 'Planner', label: q.label, disposition: 'ASKED' });
  for (const c of state.planner?.considered || []) if (hit(c.label)) out.push({ surface: 'Planner', label: c.label, disposition: 'SUPPRESSED', detail: c.reason });
  for (const c of state.category?.criticals || []) if (hit(c.name)) out.push({ surface: 'Category', label: c.name, disposition: 'critical-spec' });
  for (const s of state.specs || []) if (hit(s.name)) out.push({ surface: 'Spec', label: s.name, disposition: s.status || (s.value ? 'FILLED' : 'ASKED') });
  for (const [k, d] of Object.entries(state.logistics || {})) if (hit(k) || hit(d.value)) out.push({ surface: 'Logistics', label: k, disposition: 'deduced' });
  return out;
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const has = (p, t) => p.sections.some((s) => s.title === t);
const sec = (p, t) => p.sections.find((s) => s.title === t);

const STATE = {
  intent: { value: 'Manufacturing backup', journey: 'industrial', question: 'What will this power?', confidence: 88, source: 'derived', locked: false,
    candidates: [{ label: 'Manufacturing backup', score: 92, reason: 'manufacturer + genset' }, { label: 'Commercial backup', score: 55, reason: 'business' }, { label: 'Residential', score: 12, reason: 'unlikely' }],
    decision: { registry: null, twin: { value: 'Resale', confidence: 90, offProfile: true }, llm: { value: 'Manufacturing backup', confidence: 88 }, chosenValue: 'Manufacturing backup', threshold: 80 } },
  planner: { archetype: 'capital', questions: [{ id: 'pq-1', label: 'Do you need installation?', tier: 'constraint', priority: 91, reason: 'top blocker', groundedIn: 'category blocker 41%' }, { id: 'pq-2', label: 'How often?', priority: 70 }], considered: [{ label: 'Site readiness', score: 83, reason: 'covered by Installation' }, { label: 'Fuel storage', score: 71, reason: 'below the 3-cap' }], twinResolved: ['budget'] },
  specs: [{ name: 'Rated Power', value: '100 kVA', source: 'user', status: 'ASKED', priority: 98, sellerFreq: 87 }, { name: 'Phase', priority: 89 }, { name: 'Fuel Type', value: 'Diesel', source: 'cascade-inferred', status: 'AUTO-FILLED', priority: 80 }],
  logistics: { payment: { value: 'Credit', confidence: 90, reason: 'manufacturer + capital equipment' }, delivery: { value: 'Within city', confidence: 42, reason: 'weak signal' } },
  buyer: { nature: 'Manufacturer', authority: 'Owner', maturity: 'Execution', twinConfidence: 87, evidenceCount: 42, verified: true, offProfile: false },
  llmCalls: [{ label: 'deriveIntent', ms: 1820, model: 'gemini-2.5-flash-lite', promptVersion: 'intent-v5', promptTokens: 1400, completionTokens: 420, costUsd: 0.0006 }],
};

// ── intent ──
const ip = buildInspectorPayload('intent', STATE);
ok('intent: title + decision', ip.title === '🎯 INTENT DECISION' && ip.decision === 'Manufacturing backup');
ok('intent: alternatives ranked, chosen marked good', sec(ip, 'Alternatives considered (LLM-scored)').rows[0].score === 92 && sec(ip, 'Alternatives considered (LLM-scored)').rows[0].tone === 'good');
ok('intent: source precedence present', has(ip, 'Source precedence (bar 80)'));
ok('intent: off-profile Twin flagged bad (no-leak guard visible)', sec(ip, 'Source precedence (bar 80)').rows.find((r) => /Twin/.test(r.label)).tone === 'bad');

// ── planner ──
const pp = buildInspectorPayload('planner-q:pq-1', STATE);
ok('planner: title + decision', pp.title === '🧭 PLANNER QUESTION' && /installation/i.test(pp.decision));
ok('planner: why-selected shows priority', sec(pp, 'Why selected').rows[0].score === 91);
ok('planner: suppression ledger present (Site readiness lost)', has(pp, 'Suppressed / considered (lost)') && sec(pp, 'Suppressed / considered (lost)').rows[0].label === 'Site readiness');
ok('planner: question budget section (2 / 3)', has(pp, 'Question budget') && sec(pp, 'Question budget').rows[0].value === '2 / 3');
const ppLow = buildInspectorPayload('planner-q:pq-1', { ...STATE, planner: { ...STATE.planner, considered: [{ label: 'Runtime requirement', score: 40, reason: 'lacked confidence' }] } });
ok('planner: missing-Q ledger surfaces low-confidence considered (<60)', has(ppLow, 'Wanted to ask, lacked confidence') && sec(ppLow, 'Wanted to ask, lacked confidence').rows[0].label === 'Runtime requirement');

// ── failure-mode classification ──
ok('failure-mode: cold buyer + empty category → HIGH risk', failureMode({ confidence: { buyer: 20, category: 10 } }).risk === 'bad');
ok('failure-mode: hit + empty band → MEDIUM (weak category)', failureMode({ category: { status: 'hit', band: 'empty' }, confidence: { buyer: 80, category: 80 } }).label.includes('MEDIUM'));
ok('failure-mode: over-questioning (>3) → MEDIUM', /over-question/i.test(failureMode({ planner: { questions: [1, 2, 3, 4] }, confidence: {} }).label));
ok('failure-mode: healthy overall ≥65 → LOW good', failureMode({ confidence: { overall: 80 } }).risk === 'good');

// ── spec (asked vs auto-filled inference guard) ──
const sp = buildInspectorPayload('spec:Rated Power', STATE);
ok('spec: ASKED + user source good', sec(sp, 'Decision').rows.find((r) => r.label === 'source').tone === 'good');
const af = buildInspectorPayload('autofilled-spec:Fuel Type', STATE);
ok('autofilled spec: title AUTO-FILLED', af.title === '🧩 SPEC · AUTO-FILLED');
ok('autofilled spec: inference source flagged warn (hallucination guard)', sec(af, 'Decision').rows.find((r) => r.label === 'source').tone === 'warn');

// ── lastpage ──
const lp = buildInspectorPayload('lastpage:payment', STATE);
ok('lastpage: suggested Credit, high conf good', lp.decision === 'payment: Credit' && sec(lp, 'Decision').rows.find((r) => r.label === 'confidence').tone === 'good');
const lp2 = buildInspectorPayload('lastpage:delivery', STATE);
ok('lastpage: low-conf delivery flagged warn', sec(lp2, 'Decision').rows.find((r) => r.label === 'confidence').tone === 'warn');

// ── inspector search (the "trace search") ──
const SEARCH_STATE = { ...STATE, planner: { ...STATE.planner, considered: [{ label: 'Site readiness', score: 83, reason: 'covered by Installation' }] } };
const siteHits = searchInspector(SEARCH_STATE, 'site ready');
ok('search "site ready" → finds it SUPPRESSED in planner (the trace-search win)', siteHits.length === 1 && siteHits[0].surface === 'Planner' && siteHits[0].disposition === 'SUPPRESSED');
ok('search "site ready" → carries the suppression reason', /installation/i.test(siteHits[0].detail || ''));
ok('search "power" → finds the Rated Power spec across surfaces', searchInspector(STATE, 'power').some((h) => h.surface === 'Spec' && /power/i.test(h.label)));
ok('search "backup" → finds CHOSEN intent candidate', searchInspector(STATE, 'backup').some((h) => h.surface === 'Intent' && h.disposition === 'CHOSEN'));
ok('search "payment" → finds deduced logistics', searchInspector(STATE, 'payment').some((h) => h.surface === 'Logistics'));
ok('search too-short (<2) → empty', searchInspector(STATE, 'x').length === 0);
ok('search no-match → empty array (graceful)', searchInspector(STATE, 'zzzznomatch').length === 0);

// ── profile + graceful ──
ok('profile: BUYER BRAIN', buildInspectorPayload('profile', STATE).title === '🧠 BUYER BRAIN');
ok('null target → null', buildInspectorPayload(null, STATE) === null);
ok('unknown kind → null', buildInspectorPayload('mystery:x', STATE) === null);
ok('intent kind but no intent state → null (graceful)', buildInspectorPayload('intent', {}) === null);

console.log(`\ninspectordatatest (AI Inspector data layer · intent alternatives+source-race · planner why+suppressed · spec inference-guard · lastpage confidence · profile · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
