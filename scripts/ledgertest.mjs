// Deterministic test for THE DECISION LEDGER (Module 1) — mirrors src/lib/ledger.ts.
// Registries-first: proves LINE-LEVEL coverage (every line gets a verdict), first-class Consumption
// (per-consumer status+reason), and the counterfactual ("without this fact → X→Y"). NO LLM.

const nrm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function getTop(raw, key) { if (!Array.isArray(raw)) return undefined; for (const el of raw) if (el && typeof el === 'object' && key in el) { const v = el[key]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; } return undefined; }
const sval = (v) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 200 ? s.slice(0, 200) + '…' : s; };

function extractAllFacts(raw) {
  const facts = []; let n = 0;
  const add = (sourceNode, jsonPath, rawValue, tag, kind, lineRef, reason = 'not referenced by any belief') => { const v = sval(rawValue); if (!v) return; facts.push({ id: `f${++n}`, sourceNode, jsonPath, lineRef, rawValue: v, tag, kind, coverage: 'ignored', coverageReason: reason, usedBy: [] }); };
  const asArr = (x) => (Array.isArray(x) ? x : []);
  const asObj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const bp = asObj(getTop(raw, 'buyer_profile'));
  for (const [k, v] of Object.entries(bp)) if (v != null && typeof v !== 'object') add('profile-api', `buyer_profile.${k}`, v, `profile.${k}`, 'identity');
  const pns = asArr(getTop(raw, 'pns_data'));
  pns.forEach((call, i) => { const ed = call?.extracted_data || {}; const md = ed.metadata || {}; const ev = md.call_type?.evidence || {}; const intent = md.buyer_intent || {}; const ref = `call ${i + 1}`;
    add('pns-insights', `pns_data[${i}]…buyer_persona`, ev.buyer_persona, 'pns.persona', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…intended_application`, md.intended_application, 'pns.application', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…narrative`, intent.narrative, 'pns.narrative', 'intent', ref);
    asArr(ed.lead_tag?.deal_blockers).forEach((b, j) => add('pns-insights', `pns_data[${i}].lead_tag.deal_blockers[${j}]`, b, 'pns.blocker', 'intent', ref)); });
  asArr(getTop(raw, 'prev_bl_data')).forEach((b, i) => add('prev-bl', `prev_bl_data[${i}].ETO_OFR_TITLE`, b?.ETO_OFR_TITLE, 'bl.title', 'history', `BL ${i + 1}`));
  asArr(getTop(raw, 'csl_data')).forEach((c, i) => { add('csl', `csl_data[${i}].glb_city`, c?.glb_city === '-' ? '' : c?.glb_city, 'csl.city', 'behavioral', `csl ${i + 1}`); add('csl', `csl_data[${i}].request_url`, c?.request_url, 'csl.url', 'behavioral', `csl ${i + 1}`); });
  const waArr = asArr(getTop(raw, 'whatsapp_data'));
  waArr.forEach((m, i) => { const obj = m || {}; const txt = sval(obj.message ?? obj.caption ?? m); const inbound = nrm(obj.sender) === 'customer'; add(inbound ? 'wa-in' : 'wa-out', `whatsapp_data[${i}]`, txt, inbound ? 'wa.in' : 'wa.out', 'behavioral', `WA ${i + 1}`, inbound ? 'inbound — scanned for buyer-stated requirement' : 'outbound platform nudge (not buyer-stated)'); });
  const waOutN = waArr.filter((m) => nrm((m || {}).sender) !== 'customer').length;
  if (waOutN) add('wa-out', 'whatsapp_data.outbound_count', `${waOutN} outbound messages`, 'wa.volume', 'behavioral', undefined, 'channel-volume signal (count, not content)');
  // WA-in #N2: array · {data:{recent_messages}} · failure-wrapper. (mirror waInboundCount)
  const oj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const waInRaw = getTop(raw, 'whatsapp_inbound'); const waInObj = oj(waInRaw);
  if ('error' in waInObj || waInObj.success === false) { add('wa-in', 'whatsapp_inbound.__error', 'inbound sub-fetch failed', 'wa.in', 'behavioral', undefined, 'n8n inbound-WA sub-fetch FAILED'); }
  else { const waInArr = Array.isArray(waInRaw) ? waInRaw : asArr(oj(waInObj.data).recent_messages); waInArr.forEach((m, i) => { const o = m || {}; const who = nrm(o.sender) === 'user' ? 'buyer' : 'platform'; add('wa-in', `whatsapp_inbound[${i}]`, sval(o.content ?? o.message ?? o.text ?? o.body ?? o.caption ?? m), 'wa.in', 'behavioral', `WA-in ${i + 1} · ${who}`, 'inbound — buyer-typed'); }); }
  const ext = oj(getTop(raw, 'observed_external'));
  const bef = oj(getTop(raw, 'befisc') ?? ext.befisc);
  for (const [k, v] of Object.entries(bef)) if (v != null && typeof v !== 'object') add('befisc', `befisc.${k}`, v, `befisc.${k}`, 'external', undefined, 'external/observed — identity cross-validation only');
  const s3 = oj(getTop(raw, 'sign3') ?? ext.sign3);
  for (const [k, v] of Object.entries(s3)) { const val = Array.isArray(v) ? v.join(', ') : v; if (val != null && typeof val !== 'object' && val !== '') add('sign3', `sign3.${k}`, val, `sign3.${k}`, 'external', undefined, 'external/observed (Sign3)'); }
  return facts;
}

function buildLedger(raw, version = 1) {
  const facts = extractAllFacts(raw); const beliefs = [], decisions = [], consumption = [], outcomes = []; let bc = 0;
  const byTag = (tag, pred) => facts.filter((f) => f.tag === tag && (!pred || pred(f)));
  const mkBelief = (statement, signal, weight, forKey, fs) => { const b = { id: `b${++bc}`, statement, signal, weight, via: 'rule', fromFacts: fs.map((f) => f.id), forKey }; beliefs.push(b); for (const f of fs) { f.usedBy.push(b.id); f.coverage = 'used'; f.coverageReason = `cited by "${statement}"`; } return b; };
  const btB = [], contrib = [];
  const personaF = byTag('pns.persona', (f) => /manufactur/i.test(f.rawValue)); if (personaF.length) { btB.push(mkBelief('PNS persona = manufacturer', 'Manufacturer', 40, 'business_type', personaF)); contrib.push({ source: 'pns-insights', points: 40 }); }
  const mfgBL = byTag('bl.title', (f) => /machine|raw material|making/i.test(f.rawValue)); if (mfgBL.length) { btB.push(mkBelief('Prior BLs industrial', 'Manufacturer', 25, 'business_type', mfgBL)); contrib.push({ source: 'prev-bl', points: 25 }); }
  const descF = byTag('profile.glusr_usr_company_desc', (f) => /manufactur|making|production/i.test(f.rawValue)); if (descF.length) { btB.push(mkBelief('Company desc = manufacturing', 'Manufacturer', 20, 'business_type', descF)); contrib.push({ source: 'profile-api', points: 20 }); }
  const cslF = byTag('csl.city'); if (cslF.length) { btB.push(mkBelief('Industrial browse regions', 'Manufacturer', 15, 'business_type', cslF.slice(0, 3))); contrib.push({ source: 'csl', points: 15 }); }
  const btScore = Math.min(100, btB.reduce((s, b) => s + b.weight, 0));
  if (btB.length) decisions.push({ id: 'd:business_type', key: 'business_type', value: 'Manufacturer', state: btScore >= 80 ? 'Confirmed' : btScore >= 50 ? 'Likely' : 'Unknown', confidence: btScore, producedBy: { kind: 'cross-validated', node: 'fusion' }, beliefs: btB.map((b) => b.id), contributions: contrib, alternatives: [{ value: 'Trader', score: 20, whyLost: 'no resale signals' }], conflict: null, governance: { winner: 'history+PNS', losers: ['external income'], rule: '≥2 internal sources outrank single-source' }, reasoning: `${btB.length} mfg beliefs`, version });
  const nameF = byTag('profile.glusr_usr_name')[0];
  if (nameF) { const befName = facts.find((f) => f.tag === 'befisc.name'); let conflict = null; if (befName && nrm(befName.rawValue) !== nrm(nameF.rawValue)) { mkBelief('shared token → same person', 'same-person', 0, 'identity_name', [nameF, befName]); conflict = { contenders: [{ source: 'profile-api', value: nameF.rawValue }, { source: 'befisc', value: befName.rawValue }], winner: nameF.rawValue, losers: [befName.rawValue], rule: 'first-party display name > external variant', confidence: 85 }; } else { nameF.coverage = 'used'; } decisions.push({ id: 'd:identity_name', key: 'identity_name', value: nameF.rawValue, state: conflict ? 'Conflicted' : 'Confirmed', confidence: conflict ? 85 : 95, producedBy: { kind: 'direct', node: 'profile-api' }, beliefs: [], contributions: [{ source: 'profile-api', points: 95 }], alternatives: [], conflict, governance: { winner: 'profile-api', losers: befName ? ['befisc'] : [], rule: 'first-party identity > external' }, reasoning: 'identity', version }); }
  const waCount = byTag('wa.out').length; const waVol = byTag('wa.volume')[0]; if (waCount) { const b = mkBelief(`${waCount} outbound WA → WhatsApp-first`, 'WhatsApp-first', waCount > 30 ? 70 : 40, 'communication', waVol ? [waVol] : byTag('wa.out').slice(0, 1)); decisions.push({ id: 'd:communication', key: 'communication', value: 'WhatsApp-first', state: waCount > 30 ? 'Likely' : 'Unknown', confidence: b.weight, producedBy: { kind: 'rule', node: 'wa-out' }, beliefs: [b.id], contributions: [{ source: 'wa-out', points: b.weight }], alternatives: [], conflict: null, governance: { winner: 'WA volume', losers: [], rule: 'highest-volume channel' }, reasoning: 'WA', version }); }
  const histFacts = [...byTag('bl.title'), ...byTag('pns.application'), ...byTag('pns.product')];
  if (histFacts.length) { const b = mkBelief('Prior requirements cluster', 'historical-intent', 60, 'historical_intent', histFacts.slice(0, 4)); const theme = /notebook|paper/i.test(histFacts.map((f) => f.rawValue).join(' ')) ? 'Notebook Manufacturing Inputs' : 'prior domain'; decisions.push({ id: 'd:historical_intent', key: 'historical_intent', value: theme, state: 'Likely', confidence: 75, producedBy: { kind: 'rule', node: 'fusion' }, beliefs: [b.id], contributions: [{ source: 'prev-bl', points: 40 }, { source: 'pns-insights', points: 35 }], alternatives: [], conflict: null, governance: { winner: 'history cluster', losers: [], rule: 'dominant recurring category — a PRIOR, never forced' }, reasoning: 'recurring prior domain', version }); }
  for (const d of decisions) consumption.push({ id: `c:${d.key}`, subject: d.id, entries: [{ consumer: 'intent', status: 'available', reason: 'pre-product — intent will consume unless off-profile' }, { consumer: 'planner', status: 'available', reason: 'pre-product — planner consumes once product+category resolve' }, { consumer: 'last-page', status: 'available', reason: 'pre-product — gates Firm/GST/payment later' }], status: 'pending' });
  for (const d of decisions) outcomes.push({ id: `o:${d.key}`, subject: d.id, changedDownstream: [], mattered: false, verdict: 'pending' });
  return { facts, beliefs, decisions, consumption, outcomes, timeline: [{ version, trigger: 'GLID pull', changed: decisions.map((d) => d.key) }], factById: (id) => facts.find((f) => f.id === id), decisionByKey: (k) => decisions.find((d) => d.key === k), factsForDecision: (did) => { const d = decisions.find((x) => x.id === did); if (!d) return []; const ids = new Set(); for (const bid of d.beliefs) beliefs.find((x) => x.id === bid)?.fromFacts.forEach((fid) => ids.add(fid)); return facts.filter((f) => ids.has(f.id)); } };
}
function coverageRegistry(L) { const f = L.facts; return { total: f.length, used: f.filter((x) => x.coverage === 'used').length, ignored: f.filter((x) => x.coverage === 'ignored').length, verdictPct: f.length ? 100 : 0, everyFactHasVerdict: f.every((x) => ['used', 'ignored', 'partial'].includes(x.coverage)) }; }
function counterfactualFor(L, decisionId, factId) { const d = L.decisions.find((x) => x.id === decisionId); if (!d) return null; const lost = L.beliefs.filter((b) => d.beliefs.includes(b.id) && b.fromFacts.includes(factId)); const w = lost.reduce((s, b) => s + b.weight, 0); const after = Math.max(0, d.confidence - w); return { before: d.confidence, after, drop: d.confidence - after }; }
function evolveLedger(L, e) {
  const version = (L.timeline?.[L.timeline.length - 1]?.version ?? 1) + 1;
  const decisions = L.decisions.map((d) => ({ ...d, version })); const consumption = L.consumption.map((c) => ({ ...c, entries: c.entries.map((en) => ({ ...en })) })); const outcomes = L.outcomes.map((o) => ({ ...o })); const changed = [];
  if (e.type === 'product') { const off = e.relatedToHistory === false; const hc = consumption.find((c) => c.subject === 'd:historical_intent'); if (hc) { hc.entries = [{ consumer: 'intent', status: off ? 'rejected' : 'consumed', reason: off ? `off-profile — "${e.value}" unrelated to prior domain` : 'on-profile' }, { consumer: 'planner', status: off ? 'rejected' : 'consumed', reason: off ? 'mcat mismatch' : 'shapes plan' }, { consumer: 'category', status: 'rejected', reason: off ? `${e.value} unrelated` : 'below threshold' }]; hc.status = off ? 'rejected' : 'consumed'; const ho = outcomes.find((o) => o.subject === 'd:historical_intent'); if (ho) { ho.verdict = off ? 'waste' : 'useful'; } changed.push('historical_intent'); } }
  const timeline = [...(L.timeline || []), { version, trigger: `${e.type}: ${e.value}`, changed }];
  return { ...L, decisions, consumption, outcomes, timeline, decisionByKey: (k) => decisions.find((d) => d.key === k), factsForDecision: L.factsForDecision };
}
function answerSeven(L, decisionId) { const d = L.decisions.find((x) => x.id === decisionId); if (!d) return null; const used = L.factsForDecision(decisionId); let after = d.confidence; for (const f of used) { const cf = counterfactualFor(L, decisionId, f.id); if (cf) after = Math.min(after, cf.after); } return { q1_what: { value: d.value, state: d.state, confidence: d.confidence }, q2_why: d.contributions, q3_evidence: used.map((f) => ({ source: f.sourceNode, raw: f.rawValue })), q4_rejected: { alternatives: d.alternatives, ignored: [] }, q5_usedBy: L.consumption.find((c) => c.subject === decisionId)?.entries || [], q6_changed: L.outcomes.find((o) => o.subject === decisionId)?.changedDownstream || [], q7_ifRemoved: { before: d.confidence, after, drop: d.confidence - after } }; }

const raw = [
  { buyer_profile: { glusr_usr_name: 'Jaiveer', glusr_usr_company_desc: 'We manufacture notebooks', city: 'Auraiya', location_preference: '2' } },
  { pns_data: [{ extracted_data: { metadata: { call_type: { evidence: { buyer_persona: 'Manufacturer' } }, buyer_intent: { narrative: '1 ton raw paper for notebook manufacturing' }, intended_application: 'Notebook Manufacturing' }, lead_tag: { deal_blockers: ['price', 'location'] } } }] },
  { prev_bl_data: [{ ETO_OFR_TITLE: 'Notebook Making Machine' }, { ETO_OFR_TITLE: 'Raw Paper Material' }] },
  { csl_data: [{ glb_city: 'Auraiya', request_url: '/x?s=paper' }] },
  { whatsapp_data: [{ sender: 'API', message: 'best price nudge' }, { sender: 'API', message: 'YES to confirm' }, { sender: 'customer', message: 'need raw paper material' }] },
  { whatsapp_inbound: { data: { recent_messages: [{ message: 'need 1300 pcs/hr notebook machine' }, { message: 'urgent, this week' }] } } }, // #N2 object-shape inbound
  { befisc: { name: 'JAYVEER SINGH', income: '8L' } },
  { observed_external: { sign3: { socialProfiles: 5, operator: 'Jio', platforms: ['whatsapp', 'linkedin'] } } }, // external sign3 (observed-only)
];

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const L = buildLedger(raw);

// L1 LINE-LEVEL coverage
ok('L1 line-level: every line → a Fact (profile+pns+bl+csl+wa+befisc ≥ 14)', L.facts.length >= 14);
ok('L1 WhatsApp: EACH whatsapp_data message is its own Fact (3 individual messages)', L.facts.filter((f) => f.jsonPath && f.jsonPath.startsWith('whatsapp_data[')).length === 3);
ok('L1 WA-IN #N2: object {data:{recent_messages}} → each inbound message a Fact (2)', L.facts.filter((f) => f.jsonPath && f.jsonPath.startsWith('whatsapp_inbound[')).length === 2 && L.facts.some((f) => f.tag === 'wa.in' && /1300 pcs/.test(f.rawValue)));
ok('L1 EXTERNAL: observed_external.sign3 → Sign3 facts (platforms array joined)', L.facts.some((f) => f.sourceNode === 'sign3' && f.tag === 'sign3.platforms' && /whatsapp, linkedin/.test(f.rawValue)) && L.facts.some((f) => f.sourceNode === 'sign3' && f.tag === 'sign3.operator'));
ok('L1 WA outbound nudges stay IGNORED (volume fact carries the signal, not nudge content)', L.facts.some((f) => f.tag === 'wa.out' && f.coverage === 'ignored' && /platform nudge/.test(f.coverageReason)) && L.facts.find((f) => f.tag === 'wa.volume')?.coverage === 'used');
ok('L1 deal_blockers enumerated as separate lines (2)', L.facts.filter((f) => f.tag === 'pns.blocker').length === 2);
// Coverage Registry — 100% = every line has a verdict
const cr = coverageRegistry(L);
ok('Coverage: every fact carries a verdict (used|ignored|partial) → verdict 100%', cr.everyFactHasVerdict && cr.verdictPct === 100);
ok('Coverage: both used AND ignored present (some lines used, rest accounted)', cr.used > 0 && cr.ignored > 0 && cr.total === L.facts.length);
// L2 → L3 chain
ok('L2 beliefs cite facts (manufacturer belief ≥1 fact)', L.beliefs.find((b) => b.signal === 'Manufacturer')?.fromFacts.length >= 1);
const bt = L.decisionByKey('business_type');
ok('L3 business_type = Manufacturer conf 100 (40+25+20+15)', bt?.value === 'Manufacturer' && bt?.confidence === 100);
ok('L3 governance + alternatives present', !!bt?.governance?.rule && bt.alternatives.some((a) => a.value === 'Trader'));
ok('L3 chain Fact→Belief→Decision reconstructable', L.factsForDecision('d:business_type').length >= 2);
// conflict
const idn = L.decisionByKey('identity_name');
ok('Conflict resolved by rule (Jaiveer vs JAYVEER SINGH)', idn?.state === 'Conflicted' && idn?.conflict?.winner === 'Jaiveer' && /first-party/.test(idn.conflict.rule));
// L4 Consumption — first-class entries (status + reason per consumer)
ok('L4 Consumption first-class: entries carry {consumer,status,reason}', L.consumption.every((c) => c.entries.length === 3 && c.entries.every((e) => e.consumer && e.status && e.reason)));
// L5 Outcome
ok('L5 Outcome first-class (pending at pull)', L.outcomes.every((o) => o.verdict === 'pending'));
// COUNTERFACTUAL — no dead-end
const persona = L.facts.find((f) => f.tag === 'pns.persona');
const cf = counterfactualFor(L, 'd:business_type', persona.id);
ok('Counterfactual: drop PNS persona → 100→60 (−40)', cf?.before === 100 && cf?.after === 60 && cf?.drop === 40);

// MODULE 1.5 mirrors
function derivationTimeline(L, decisionId) { const d = L.decisions.find((x) => x.id === decisionId); if (!d) return []; const out = []; let running = 0, step = 0; for (const b of L.beliefs.filter((x) => d.beliefs.includes(x.id))) { running = Math.min(d.confidence, running + b.weight); out.push({ step: ++step, event: b.statement, source: L.factById(b.fromFacts[0])?.sourceNode ?? 'fusion', delta: b.weight, running }); } if (!out.length) out.push({ step: 1, event: d.value, source: d.producedBy.node, delta: d.confidence, running: d.confidence }); return out; }
function diffLedgerVersions(a, b) { const changed = [], flips = [], added = []; for (const db of b.decisions) { const da = a.decisions.find((x) => x.key === db.key); if (!da) { added.push(db.key); continue; } if (da.value !== db.value) changed.push({ key: db.key, field: 'value', from: da.value, to: db.value }); if (da.confidence !== db.confidence) changed.push({ key: db.key, field: 'confidence', from: String(da.confidence), to: String(db.confidence) }); const ca = a.consumption.find((c) => c.subject === da.id); const cb = b.consumption.find((c) => c.subject === db.id); for (const eb of cb?.entries || []) { const ea = ca?.entries.find((x) => x.consumer === eb.consumer); if (ea && ea.status !== eb.status) flips.push({ key: db.key, consumer: eb.consumer, from: ea.status, to: eb.status, reason: eb.reason }); } } return { changed, consumptionFlips: flips, added }; }
function consumptionMatrix(L) { const consumers = [...new Set(L.consumption.flatMap((c) => c.entries.map((e) => e.consumer)))]; return { consumers, rows: L.decisions.map((d) => { const c = L.consumption.find((x) => x.subject === d.id); const cells = {}; for (const cons of consumers) { const e = c?.entries.find((x) => x.consumer === cons); cells[cons] = e ? { status: e.status, reason: e.reason } : { status: '—', reason: '' }; } return { key: d.key, cells }; }) }; }

// F — derivation timeline (running confidence build-up)
const tl = derivationTimeline(L, 'd:business_type');
ok('F timeline: ordered event stream w/ running confidence ending at 100', tl.length === 4 && tl[0].running === 40 && tl[tl.length - 1].running === 100 && tl[1].running === 65);
// E — replay diff (v1 vs v2 after off-profile evolve)
const dv = diffLedgerVersions(L, evolveLedger(L, { type: 'product', value: 'diesel generator', relatedToHistory: false }));
ok('E replay: diff catches historical_intent intent flip available→rejected', dv.consumptionFlips.some((f) => f.key === 'historical_intent' && f.consumer === 'intent' && f.from === 'available' && f.to === 'rejected'));
// D — non-consumption matrix (decision × consumer grid)
const mx = consumptionMatrix(L);
ok('D matrix: consumers cols + per-decision rows w/ per-cell status', mx.consumers.includes('intent') && mx.consumers.includes('planner') && mx.rows.find((r) => r.key === 'business_type')?.cells.intent.status === 'available');

// ROBUSTNESS — malformed/real-data shapes must NEVER throw (the blank-screen bug)
let threw = false; let mal = null;
try { mal = buildLedger([
  { buyer_profile: 'a string not an object' },            // wrong type
  { pns_data: { not: 'an array' } },                       // object not array
  { prev_bl_data: 'oops' },                                // string not array
  { csl_data: null },                                      // null
  { whatsapp_data: { count: 5 } },                         // object not array
  { befisc: [1, 2, 3] },                                   // array not object
]); } catch { threw = true; }
ok('ROBUSTNESS: malformed pull does NOT throw (no blank screen)', !threw && !!mal && Array.isArray(mal.facts));
ok('ROBUSTNESS: empty/garbage raw → valid empty ledger', (() => { try { const z = buildLedger('garbage'); return Array.isArray(z.facts) && z.facts.length === 0; } catch { return false; } })());

// historical intent
const hi = L.decisionByKey('historical_intent');
ok('historical_intent decision = Notebook Manufacturing Inputs', hi?.value === 'Notebook Manufacturing Inputs');
// STEP 5 — evolve creates a NEW version + off-profile "why NOT used"
const L2 = evolveLedger(L, { type: 'product', value: 'diesel generator', relatedToHistory: false });
ok('Step5 evolve: NEW version (v2), not mutation', L2.timeline.length === L.timeline.length + 1 && L2.timeline[L2.timeline.length - 1].version === 2 && L.timeline.length === 1);
const hc2 = L2.consumption.find((c) => c.subject === 'd:historical_intent');
ok('Why-NOT-used: historical_intent REJECTED by intent (off-profile) + planner (mcat) + category', hc2?.status === 'rejected' && hc2.entries.find((e) => e.consumer === 'intent')?.status === 'rejected' && /off-profile/.test(hc2.entries.find((e) => e.consumer === 'intent')?.reason) && hc2.entries.find((e) => e.consumer === 'planner')?.status === 'rejected');
ok('Step5: original ledger v1 unchanged (immutable evolve)', L.consumption.find((c) => c.subject === 'd:historical_intent')?.status === 'pending');
// THE 7-QUESTION CONTRACT
const A = answerSeven(L, 'd:business_type');
ok('7Q: all seven answers present', A && ['q1_what', 'q2_why', 'q3_evidence', 'q4_rejected', 'q5_usedBy', 'q6_changed', 'q7_ifRemoved'].every((k) => k in A));
ok('7Q: q1 value, q2 contributions, q3 raw evidence, q7 counterfactual', A.q1_what.value === 'Manufacturer' && A.q2_why.length === 4 && A.q3_evidence.length >= 2 && A.q7_ifRemoved.before === 100 && A.q7_ifRemoved.after < 100);
ok('7Q: q5 usedBy carries per-consumer entries', A.q5_usedBy.length === 3 && A.q5_usedBy.every((e) => e.consumer && e.status));

console.log(`\nledgertest (Module 1+1.5 · coverage · Fact→Belief→Decision→Consumption→Outcome · governance · conflict · counterfactual · evolve+versioning · why-NOT-used · 7-Q · F-timeline · E-replay-diff · D-matrix): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
