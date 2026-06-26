// Deterministic test for the Observatory brain — mirrors src/lib/observatory.ts.
// Asserts the L11–L20 functions that answer the canonical trust/value/governance questions. NO LLM.

const nrm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PRECEDENCE = ['Fallback', 'LLM', 'Category', 'Twin', 'Corroborated', 'ConfirmedHistory', 'VerifiedAPI', 'User'];
const precedenceRank = (s) => { const i = PRECEDENCE.indexOf(s); return i < 0 ? 0 : i; };
function resolveConflict(c) { const ranked = c.contenders.slice().sort((a, b) => precedenceRank(b.source) - precedenceRank(a.source)); const winner = ranked[0]; const losers = ranked.slice(1); return { field: c.field, winner, losers, rule: losers.length ? `${winner.source} > ${losers.map((l) => l.source).join(' > ')} (precedence)` : `${winner.source} (uncontested)` }; }
function nonConsumptionMatrix(fact, rows) { return { fact, rows, everywhereRejected: rows.length > 0 && rows.every((r) => r.available && !r.consumed) }; }
function outputAcceptance(produced, gate, contradicts = () => false) { const accepted = [], rejected = []; for (const p of produced) { if (contradicts(p.key)) rejected.push({ ...p, reason: 'contradicts' }); else if (p.confidence < gate) rejected.push({ ...p, reason: `below ${gate}` }); else accepted.push(p); } return { produced: produced.length, accepted, rejected }; }
function answerImpact(q, changed) { return { question: q, useful: changed.length > 0, changed, verdict: changed.length ? 'USEFUL' : 'WASTE QUESTION' }; }
function evidenceSufficiency(received, needed, rawConf) { const coverage = needed > 0 ? Math.round((received / needed) * 100) : 100; const cap = coverage >= 80 ? 100 : coverage >= 50 ? 80 : coverage >= 25 ? 60 : 45; return { coveragePct: coverage, cappedConfidence: Math.min(rawConf, cap), sufficient: coverage >= 80 }; }
function robustness(sources) { const n = new Set(sources.map(nrm)).size; return { score: Math.min(100, n * 25), fragile: n <= 1 }; }
function confidenceFormula(parts, conflicts = 0) { const sum = parts.reduce((s, p) => s + p.points, 0) - conflicts * 10; const total = Math.max(0, Math.min(100, sum)); return { total, breakdown: `${total} = ${parts.map((p) => `${p.points} ${p.source}`).join(' + ')}` }; }
function dependencyImpact(fact, backing, dropped) { const remaining = backing.filter((s) => nrm(s) !== nrm(dropped)); return { fact, dropped, survives: remaining.length > 0, remaining }; }
function deterministicVsAI(ledger) { return { survives: ledger.filter((d) => d.producedBy.kind !== 'llm'), lost: ledger.filter((d) => d.producedBy.kind === 'llm') }; }
function sourceROI(facts) { const m = new Map(); for (const f of facts) { const e = m.get(f.source) || { c: 0, u: 0 }; e.c++; if (f.used) e.u++; m.set(f.source, e); } return [...m.entries()].map(([source, e]) => ({ source, contributed: e.c, used: e.u, roiPct: e.c ? Math.round((e.u / e.c) * 100) : 0 })).sort((a, b) => b.roiPct - a.roiPct); }
function costPerUse(cost, uses) { return { perUse: uses > 0 ? cost / uses : cost }; }
function topImpact(ds) { return ds.map((d) => ({ id: d.id, impact: (d.consumers || []).length })).sort((a, b) => b.impact - a.impact); }
function impactDiff(before, after) { const keys = new Set([...Object.keys(before), ...Object.keys(after)]); const changed = [], notChanged = []; for (const k of keys) { if (nrm(before[k]) !== nrm(after[k])) changed.push({ field: k, from: before[k], to: after[k] }); else notChanged.push(k); } return { changed, notChanged }; }
function readyVerdict(reqs) { const missing = reqs.filter((r) => r.required && !r.met).map((r) => r.name); return { ready: missing.length === 0, missing }; }
function riskProfile(rows) { return rows.map((r) => ({ ...r, irreversible: r.irreversible || r.cascadesInto.length >= 3 })); }

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// L20 governance
ok('Q63 precedence: User > Twin > LLM', precedenceRank('User') > precedenceRank('Twin') && precedenceRank('Twin') > precedenceRank('LLM'));
const conf = resolveConflict({ field: 'buyer_type', contenders: [{ source: 'Twin', value: 'Manufacturer' }, { source: 'User', value: 'Personal' }] });
ok('Q61 conflict: User wins over Twin', conf.winner.source === 'User' && conf.losers[0].source === 'Twin' && /User > Twin/.test(conf.rule));
ok('Q69 READY: missing category blocks ready', readyVerdict([{ name: 'Buyer', required: true, met: true }, { name: 'Category', required: true, met: false }]).ready === false);
ok('Q68 irreversible when cascades ≥3', riskProfile([{ decision: 'Intent', failureMode: 'x', blastRadius: 'Very High', cascadesInto: ['planner', 'specs', 'matching'], irreversible: false }])[0].irreversible === true);

// L11 non-consumption
const ncm = nonConsumptionMatrix('Notebook Mfg Inputs', [{ consumer: 'Planner', available: true, consumed: false, reason: 'off-profile' }, { consumer: 'Intent', available: true, consumed: false, reason: 'off-profile' }]);
ok('Q14 non-consumption: available everywhere, rejected everywhere', ncm.everywhereRejected === true);

// L12 output acceptance
const oa = outputAcceptance([{ key: 'Phase', confidence: 60 }, { key: 'Cooling', confidence: 95 }, { key: 'Voltage', confidence: 85 }], 75, (k) => k === 'Voltage');
ok('Q5/Q27 acceptance: 1 accepted, 2 rejected (gate + contradiction)', oa.accepted.length === 1 && oa.rejected.length === 2);

// L13 waste-question
ok('Q58 waste: answer changed nothing → WASTE', answerImpact('What phase?', []).useful === false);
ok('Q58 useful: answer changed routing → USEFUL', answerImpact('Budget?', ['budget-band', 'routing']).useful === true);

// L14 sufficiency / robustness / formula
ok('Q43 sufficiency caps thin evidence (1/6 → cap 45)', evidenceSufficiency(1, 6, 90).cappedConfidence === 45);
ok('Q43 sufficiency ok (14/10 → no cap)', evidenceSufficiency(14, 10, 90).cappedConfidence === 90);
ok('Q45 robustness: single-source fragile', robustness(['Befisc']).fragile === true);
ok('Q45 robustness: 4 sources stable', robustness(['PNS', 'BL', 'ISQ', 'WA']).fragile === false && robustness(['PNS', 'BL', 'ISQ', 'WA']).score === 100);
ok('Q50 confidence formula breakdown', confidenceFormula([{ source: 'PNS', points: 40 }, { source: 'WA', points: 15 }, { source: 'BL', points: 10 }, { source: 'ISQ', points: 8 }]).total === 73);

// L15 counterfactual / det-vs-AI
ok('Q44 dependency: drop one of two → survives', dependencyImpact('Manufacturer', ['PNS', 'BL'], 'PNS').survives === true);
ok('Q44 dependency: drop the only source → dies', dependencyImpact('Income', ['Befisc'], 'Befisc').survives === false);
const dva = deterministicVsAI([{ id: 'a', producedBy: { kind: 'code' } }, { id: 'b', producedBy: { kind: 'llm' } }, { id: 'c', producedBy: { kind: 'user' } }]);
ok('Q60 det-vs-AI: 2 survive (code+user), 1 lost (llm)', dva.survives.length === 2 && dva.lost.length === 1);

// L16 ROI / value
const roi = sourceROI([{ source: 'PNS', used: true }, { source: 'PNS', used: false }, { source: 'ISQ', used: true }]);
ok('Q48 source ROI: ISQ 100% ranks above PNS 50%', roi[0].source === 'ISQ' && roi[0].roiPct === 100);
ok('Q52 cost per use', Math.abs(costPerUse(0.0009, 18).perUse - 0.00005) < 0.00001);
ok('Q57 top-impact ranks by consumers', topImpact([{ id: 'x', consumers: ['a'] }, { id: 'y', consumers: ['a', 'b', 'c'] }])[0].id === 'y');

// L17 impact diff
const diff = impactDiff({ profile: 'Mfr', stage: 'Exploring', spec: 'A' }, { profile: 'Mfr', stage: 'Evaluating', spec: 'B' });
ok('Q49 impact diff: 2 changed (stage,spec), 1 not (profile)', diff.changed.length === 2 && diff.notChanged.includes('profile'));

// ledger search
const led = (() => { const rows = [{ id: 'spec:rated_power', surface: 'spec', value: '5 kVA', producedBy: { kind: 'user' }, evidence: [{ rawLine: 'buyer picked power' }] }]; return { search: (term) => { const toks = String(term).toLowerCase().split(/\s+/).map(nrm).filter((t) => t.length >= 2); const hit = (x) => toks.some((t) => nrm(x).includes(t)); return rows.filter((r) => hit(r.id) || hit(r.value) || (r.evidence || []).some((e) => hit(e.rawLine))); } }; })();
ok('ledger search finds by id/value/evidence', led.search('power').length === 1 && led.search('zzz').length === 0);

console.log(`\nobservatorytest (L11–L20: governance precedence/override/READY/irreversible · non-consumption · output-acceptance · waste-Q · sufficiency/robustness/formula · counterfactual/det-vs-AI · ROI/cost/top-impact · impact-diff · ledger-search): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
