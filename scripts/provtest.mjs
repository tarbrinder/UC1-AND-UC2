// Deterministic test for the Provenance + Depth pass (mirrors ledger.ts helpers + externalCard.ts).
// Proves: Weight Tree (source→belief→fact shares) · Attention Map (influence %) · per-fact Ignored-REASON
// · Fact-Promotion ladder (raw→belief→decision) · Alternative for/against trees · causal Evolution because
// · External card grouping. NO LLM.

const LABEL = { 'profile-api': 'Profile', 'pns-insights': 'PNS', 'prev-bl': 'Prev BL', 'prev-isq': 'Prev ISQ', csl: 'CSL', 'wa-out': 'WA out', 'wa-in': 'WA in', befisc: 'Befisc', sign3: 'Sign3' };
function weightTree(L, id) { const d = L.decisions.find((x) => x.id === id); if (!d) return []; const bySrc = new Map(); for (const bid of d.beliefs) { const b = L.beliefs.find((x) => x.id === bid); if (!b) continue; const facts = b.fromFacts.map((fid) => L.facts.find((f) => f.id === fid)).filter(Boolean); const src = facts[0]?.sourceNode; if (!src) continue; const share = facts.length ? b.weight / facts.length : b.weight; if (!bySrc.has(src)) bySrc.set(src, { source: src, points: 0, beliefs: [] }); const n = bySrc.get(src); n.points += b.weight; n.beliefs.push({ statement: b.statement, weight: b.weight, facts: facts.map((f) => ({ id: f.id, raw: f.rawValue, share: Math.round(share) })) }); } return [...bySrc.values()].sort((a, b) => b.points - a.points); }
function attentionMap(L, id) { const tree = weightTree(L, id); const total = tree.reduce((s, n) => s + n.points, 0) || 1; const rows = []; for (const n of tree) for (const b of n.beliefs) for (const f of b.facts) rows.push({ label: f.raw, source: n.source, points: f.share, pct: Math.round((f.share / total) * 100) }); return rows.sort((a, b) => b.pct - a.pct); }
function ignoredReasonFor(f) { if (f.role === 'decisive' || f.coverage === 'used') return 'used — cited by a decision'; if (f.role === 'discounted') return 'discounted — considered but set aside (conflicting or lower-priority)'; if (f.role === 'noise') return 'noise — request plumbing / platform nudge, no business signal'; if (f.role === 'scanned') return 'scanned — seen, but a weaker signal than what was cited'; return 'available — signal-bearing, but no consumer has needed it yet'; }
function promotionLadder(L, factId) { const f = L.facts.find((x) => x.id === factId); if (!f) return []; const rungs = [{ kind: 'fact', label: f.rawValue }]; const beliefs = L.beliefs.filter((b) => b.fromFacts.includes(factId)); if (!beliefs.length) { rungs.push({ kind: 'belief', label: 'not promoted', detail: ignoredReasonFor(f) }); return rungs; } for (const b of beliefs) { rungs.push({ kind: 'belief', label: b.statement }); for (const d of L.decisions.filter((x) => x.beliefs.includes(b.id))) rungs.push({ kind: 'decision', label: `${d.key} = ${d.value}` }); } return rungs; }
const ALT_FOR_HINT = { Trader: /resal|stock|wholesale|retail|finished.?good/i, Entrepreneur: /new.*venture|startup|setting up|first procurement|new.*business/i };
function factsForDecision(L, id) { const d = L.decisions.find((x) => x.id === id); if (!d) return []; const ids = new Set(); for (const bid of d.beliefs) L.beliefs.find((b) => b.id === bid)?.fromFacts.forEach((fid) => ids.add(fid)); return L.facts.filter((f) => ids.has(f.id)); }
function alternativeTrees(L, id) { const d = L.decisions.find((x) => x.id === id); if (!d) return []; const cited = factsForDecision(L, id); return d.alternatives.map((a) => { const hint = ALT_FOR_HINT[a.value]; const forEv = hint ? L.facts.filter((f) => hint.test(f.rawValue)).slice(0, 3).map((f) => `“${f.rawValue}”`) : []; const against = [a.whyLost, ...cited.slice(0, 2).map((f) => `“${f.rawValue}” supports ${d.value}, not ${a.value}`)]; return { value: a.value, score: a.score, for: forEv.length ? forEv : ['no supporting evidence found in this pull'], against }; }); }
function buildExternalCard(L) { const mk = (node) => L.facts.filter((f) => f.sourceNode === node).map((f) => ({ label: f.tag, value: f.rawValue })); const befisc = mk('befisc'), sign3 = mk('sign3'); return { present: befisc.length + sign3.length > 0, befisc, sign3, count: befisc.length + sign3.length, note: 'verified external intelligence (Befisc + Sign3, paid APIs) · first-class signal' }; }

const F = (id, sourceNode, tag, rawValue, role, lineRef) => ({ id, sourceNode, tag, rawValue, role: role || 'decisive', lineRef });
const facts = [
  F('f1', 'pns-insights', 'pns.persona', 'Manufacturer', 'decisive', 'call 1'), F('f2', 'pns-insights', 'pns.persona', 'Manufacturer', 'decisive', 'call 2'),
  F('f3', 'prev-bl', 'bl.title', 'Notebook Making Machine', 'decisive', 'BL 1'),
  F('f4', 'pns-insights', 'pns.narrative', 'new notebook business venture', 'available', 'call 4'),
  F('f5', 'csl', 'csl.url', 'GET /getCityName', 'noise'),
  F('f6', 'befisc', 'befisc.name', 'JAYVEER SINGH', 'discounted'), F('f7', 'sign3', 'sign3.operator', 'Jio', 'discounted'),
  F('f8', 'prev-isq', 'isq.answer', 'Quantity=100000', 'available'),
];
const beliefs = [
  { id: 'b1', statement: 'PNS persona reads manufacturer', weight: 40, fromFacts: ['f1', 'f2'] },
  { id: 'b2', statement: 'Prior BuyLeads are machines', weight: 25, fromFacts: ['f3'] },
];
const decisions = [{ id: 'd:business_type', key: 'business_type', value: 'Manufacturer', confidence: 65, beliefs: ['b1', 'b2'], contributions: [{ source: 'pns-insights', points: 40 }, { source: 'prev-bl', points: 25 }], alternatives: [{ value: 'Trader', score: 13, whyLost: 'no resale signals' }, { value: 'Entrepreneur', score: 41, whyLost: 'repeated manufacturing signals' }] }];
const L = { facts, beliefs, decisions, factsForDecision: (id) => factsForDecision({ facts, beliefs, decisions }, id) };

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const tree = weightTree(L, 'd:business_type'); const att = attentionMap(L, 'd:business_type'); const alts = alternativeTrees(L, 'd:business_type'); const ext = buildExternalCard(L);

ok('weight tree: 2 sources (PNS 40, Prev BL 25), PNS first', tree.length === 2 && tree[0].source === 'pns-insights' && tree[0].points === 40);
ok('weight tree: PNS +40 split across its 2 calls (20 each)', tree[0].beliefs[0].facts.length === 2 && tree[0].beliefs[0].facts.every((f) => f.share === 20));
ok('attention map: per-fact influence % sums ≈100 across both sources', Math.abs(att.reduce((s, r) => s + r.pct, 0) - 100) <= 3 && att.some((r) => r.source === 'pns-insights') && att.some((r) => r.source === 'prev-bl'));
ok('ignored-reason: noise vs discounted vs available are distinct', /noise/.test(ignoredReasonFor(facts[4])) && /discounted/.test(ignoredReasonFor(facts[5])) && /no consumer/.test(ignoredReasonFor(facts[7])));
ok('promotion ladder: cited fact climbs fact→belief→decision', (() => { const r = promotionLadder(L, 'f1'); return r[0].kind === 'fact' && r.some((x) => x.kind === 'belief') && r.some((x) => x.kind === 'decision' && /Manufacturer/.test(x.label)); })());
ok('promotion ladder: uncited fact shows "not promoted" + reason', (() => { const r = promotionLadder(L, 'f8'); return r.some((x) => /not promoted/.test(x.label)); })());
ok('alt for/against: Entrepreneur has a FOR (new venture) + AGAINST', (() => { const e = alts.find((a) => a.value === 'Entrepreneur'); return e.for.some((s) => /new.*business/i.test(s)) && e.against.length >= 1; })());
ok('alt for/against: Trader has no supporting evidence (honest)', (() => { const t = alts.find((a) => a.value === 'Trader'); return t.for[0] === 'no supporting evidence found in this pull'; })());
ok('external card: groups Befisc + Sign3 (first-class paid-API signal)', ext.present && ext.count === 2 && /first-class signal/.test(ext.note));

console.log(`\nprovtest (final pass · weight tree · attention map · ignored-reason · promotion ladder · alt for/against · external card): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
