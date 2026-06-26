// Deterministic test for the A→Z synthesis slice (mirrors enrichLedger + verifyDecision).
// Proves: every decision carries ≥1 GROUNDED reasoning step · colour roles assigned correctly
// (decisive/scanned/available/discounted/noise) · csl plumbing = noise, external = discounted ·
// ignored-impact ranks ISQ order-value/quantity above weaker signals · the verifier CATCHES an
// ungrounded reasoning step (the anti-hallucination guard). NO LLM.

// ── mirror: enrichLedger roles ──
const NOISE_RE = /^(GET|POST|PUT|DELETE) |getCityName|getCityId|unreadMessage|userlastseen|CityFromLatLong|recentData|getGlbcity|WrapperService|WrapperCompService|markovrecom|citydistance|citysuggestor|stdproducts|recommendedmcat|relatedproducts|miniproddetail|widgets\/|\/rating\?|getISQ|finishEnquiry/i;
function enrich(L) {
  const decisiveIds = new Set();
  for (const d of L.decisions) for (const bid of d.beliefs) (L.beliefs.find((b) => b.id === bid)?.fromFacts || []).forEach((fid) => decisiveIds.add(fid));
  for (const f of L.facts) {
    if (decisiveIds.has(f.id) || f.coverage === 'used') f.role = 'decisive';
    else if (f.tag === 'wa.out') f.role = 'noise';
    else if (f.tag === 'csl.url') f.role = NOISE_RE.test(f.rawValue) ? 'noise' : 'scanned';
    else if (f.tag === 'csl.city') f.role = 'scanned';
    else f.role = 'available';
  }
  for (const d of L.decisions) {
    const steps = []; let n = 0;
    for (const bid of d.beliefs) { const b = L.beliefs.find((x) => x.id === bid); if (!b) continue; steps.push({ n: ++n, claim: b.statement, fromEvidence: b.fromFacts.slice(), delta: b.weight, via: b.via }); }
    if (d.conflict) steps.push({ n: ++n, claim: `conflict resolved → ${d.conflict.winner}`, fromEvidence: [], rejected: d.conflict.losers.join(', '), delta: 0, via: 'rule' });
    if (d.alternatives?.length) steps.push({ n: ++n, claim: `chose ${d.value}`, fromEvidence: [], rejected: d.alternatives.map((a) => `${a.value} — ${a.whyLost}`).join(' · '), delta: 0, via: 'rule' });
    if (steps.length) d.reasoningSteps = steps;
  }
  const impactFor = (f) => {
    if (f.tag === 'pns.application') return { delta: 8 };
    if (f.tag === 'csl.searchTerm') return { delta: 8 };
    if (f.tag === 'wa.in') return { delta: 6 };
    if (f.tag === 'pns.product') return { delta: 5 };
    if (f.tag.startsWith('isq')) { if (/order value|lakh|crore/i.test(f.raw ?? f.rawValue)) return { delta: 12 }; if (/\bkg\b|\bton\b|quantity|\b\d{5,}\b/i.test(f.raw ?? f.rawValue)) return { delta: 10 }; if (/business use/i.test(f.raw ?? f.rawValue)) return { delta: 7 }; }
    return null;
  };
  const bt = L.decisions.find((d) => d.key === 'business_type');
  if (bt) { const ranked = []; for (const f of L.facts) { if (f.role !== 'available') continue; const imp = impactFor(f); if (imp) ranked.push({ factId: f.id, tag: f.tag, raw: f.rawValue, estDelta: imp.delta }); } ranked.sort((a, b) => b.estDelta - a.estDelta); if (ranked.length) bt.ignoredImpact = ranked.slice(0, 8); }
  return L;
}

// ── mirror: verifyDecision ──
function verifyDecision(L, d) {
  const factIds = new Set(L.facts.map((f) => f.id));
  const steps = d.reasoningSteps ?? [];
  const ungrounded = [];
  for (const s of steps) for (const id of s.fromEvidence) if (!factIds.has(id)) ungrounded.push(`${s.n}:${id}`);
  const cited = new Set(); for (const s of steps) s.fromEvidence.forEach((id) => cited.add(id));
  const priorSum = d.contributions.reduce((s, c) => s + c.points, 0);
  const checks = [
    { name: 'grounded reasoning', pass: ungrounded.length === 0 },
    { name: 'has reasoning', pass: steps.length > 0 },
    { name: 'grounded conclusion', pass: cited.size > 0 || d.producedBy.kind === 'direct' },
    { name: 'confidence vs prior', pass: Math.abs(d.confidence - Math.min(100, priorSum)) <= 20 || d.contributions.length === 0 },
  ];
  return { ok: checks.every((c) => c.pass), checks };
}

// ── fixture ledger (mirrors a buyer-profile shape) ──
const facts = [
  { id: 'f1', sourceNode: 'pns-insights', tag: 'pns.persona', rawValue: 'Manufacturer', coverage: 'used', usedBy: ['b1'] },
  { id: 'f2', sourceNode: 'pns-insights', tag: 'pns.application', rawValue: 'Notebook Manufacturing', coverage: 'ignored', usedBy: [] },
  { id: 'f3', sourceNode: 'prev-isq', tag: 'isq.answer', rawValue: 'Probable Order Value=Rs. 70 - 74 Lakh', coverage: 'ignored', usedBy: [] },
  { id: 'f4', sourceNode: 'prev-isq', tag: 'isq.answer', rawValue: 'Quantity=100000', coverage: 'ignored', usedBy: [] },
  { id: 'f5', sourceNode: 'csl', tag: 'csl.url', rawValue: 'GET /ajaxrequest/getCityName?cityId=70743 HTTP/1.1', coverage: 'ignored', usedBy: [] },
  { id: 'f6', sourceNode: 'csl', tag: 'csl.searchTerm', rawValue: 'Notebook Making Machines', coverage: 'ignored', usedBy: [] },
  { id: 'f7', sourceNode: 'csl', tag: 'csl.city', rawValue: 'Pune', coverage: 'ignored', usedBy: [] },
  { id: 'f8', sourceNode: 'befisc', tag: 'befisc.income', rawValue: '8L', coverage: 'ignored', usedBy: [] },
  { id: 'f9', sourceNode: 'wa-out', tag: 'wa.out', rawValue: 'YES press kare', coverage: 'ignored', usedBy: [] },
];
const beliefs = [{ id: 'b1', statement: 'PNS persona reads "manufacturer"', signal: 'Manufacturer', weight: 40, via: 'rule', fromFacts: ['f1'], forKey: 'business_type' }];
const decisions = [{ id: 'd:business_type', key: 'business_type', value: 'Manufacturer', confidence: 40, producedBy: { kind: 'cross-validated' }, beliefs: ['b1'], contributions: [{ source: 'pns-insights', points: 40 }], alternatives: [{ value: 'Trader', score: 13, whyLost: 'no resale signals' }], conflict: null }];
const L = enrich({ facts, beliefs, decisions });

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const bt = L.decisions[0];

ok('every decision has ≥1 reasoning step', L.decisions.every((d) => (d.reasoningSteps?.length ?? 0) >= 1));
ok('reasoning steps are GROUNDED (cited fact ids resolve)', verifyDecision(L, bt).checks.find((c) => c.name === 'grounded reasoning').pass);
ok('reasoning includes the rejected alternative (chose X over Trader)', bt.reasoningSteps.some((s) => /Trader/.test(s.rejected || '')));
ok('role · cited persona = decisive', facts.find((f) => f.id === 'f1').role === 'decisive');
ok('role · csl plumbing url = noise', facts.find((f) => f.id === 'f5').role === 'noise');
ok('role · outbound WA nudge = noise', facts.find((f) => f.id === 'f9').role === 'noise');
ok('role · external is now FIRST-CLASS (available/usable, not auto-discounted)', facts.find((f) => f.id === 'f8').role === 'available');
ok('role · csl city = scanned (weak)', facts.find((f) => f.id === 'f7').role === 'scanned');
ok('role · ISQ + searchTerm + application = available', ['f2', 'f3', 'f4', 'f6'].every((id) => facts.find((f) => f.id === id).role === 'available'));
ok('ignored-impact ranks ISQ order value (12) at the TOP', bt.ignoredImpact[0].estDelta === 12 && /order value/i.test(bt.ignoredImpact[0].raw));
ok('ignored-impact includes csl.searchTerm (the field the rule should read)', bt.ignoredImpact.some((i) => i.tag === 'csl.searchTerm'));
ok('ignored-impact excludes noise + decisive (only signal-bearing unused)', bt.ignoredImpact.every((i) => i.tag !== 'csl.url' && i.tag !== 'pns.persona'));
ok('VERIFIER catches an ungrounded reasoning step (anti-hallucination)', (() => { const bad = JSON.parse(JSON.stringify(bt)); bad.reasoningSteps.push({ n: 99, claim: 'invented', fromEvidence: ['f_DOES_NOT_EXIST'], delta: 0, via: 'llm' }); return verifyDecision({ facts }, bad).ok === false; })());
ok('VERIFIER passes the clean decision', verifyDecision(L, bt).ok === true);

console.log(`\nreasoningtest (A→Z synthesis slice · grounded reasoning_steps for every output · colour roles · ignored-impact inverse-counterfactual · anti-hallucination verifier): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
