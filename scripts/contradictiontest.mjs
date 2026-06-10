// Contract test for the Contradiction Engine (L2) — mirrors src/lib/contradiction.ts (repo harness
// pattern). Proves both pilot cases produce the right NUDGES, the personal-conflict signals consolidate
// into ONE nudge (not three), and there are NO false positives (chaos-safe, no category hardcoding).

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ENTITY_RE = /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|enterprises?|industries|traders?|trading|company|co\b|udyog|udhyog|exports?|imports?|solutions?|technologies)\b/i;
const PERSONAL_DISCRETE_CEILING = 25;
const UNIT_DISCRETE = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i;
const isPersonalish = (i) => !!i.isPersonal || /personal|individual|end.?user|home|own use/i.test(i.intentType || '');
function distinctLocations(locs) {
  const clean = (locs || []).filter((l) => l && slug(l.value));
  const groups = [];
  for (const l of clean) {
    const s = slug(l.value);
    const g = groups.find((x) => x.slug.includes(s) || s.includes(x.slug));
    if (g) { if (s.length > g.slug.length) { g.slug = s; g.label = l.value; } g.sources.push(l.source); }
    else groups.push({ slug: s, label: l.value, sources: [l.source] });
  }
  return groups;
}
const SEVERITY_SCORE = { location: 9, persona_vs_order: 8, approval: 6, installation: 6, po_process: 5, buyer_type: 5, supplier_radius: 4 };
function detectContradictions(i) {
  const out = [];
  const personal = isPersonalish(i);
  const push = (n) => out.push({ ...n, score: SEVERITY_SCORE[n.type] ?? 0 });
  const groups = distinctLocations(i.locations);
  if (groups.length >= 2) push({ type: 'location', severity: 'high', options: [...groups.map((g) => g.label).slice(0, 4), 'Other'], evidence: groups.map((g) => g.label), field: 'deliveryCity' });
  if (personal) {
    const ev = [];
    if (ENTITY_RE.test(i.companyName || '')) ev.push('entity');
    if (!!i.profileType && !/individual|end.?user|personal|consumer/i.test(i.profileType)) ev.push('businessProfile');
    if ((i.qty || 0) > PERSONAL_DISCRETE_CEILING && (!i.unit || UNIT_DISCRETE.test(i.unit))) ev.push('bigQty');
    if (ev.length) push({ type: 'persona_vs_order', severity: 'high', options: ['Personal use', 'Business / resale', 'Workshop / fitment', 'Fleet'], evidence: ev, field: 'buyerKind' });
  }
  if (!out.some((n) => n.type === 'persona_vs_order') && i.profileType && i.twinType) {
    if (slug(i.profileType) !== slug(i.twinType) && !i.profileType.includes(i.twinType) && !i.twinType.includes(i.profileType))
      push({ type: 'buyer_type', severity: 'medium', options: [i.profileType, i.twinType, 'Other'], evidence: [], field: 'buyerType' });
  }
  if (/high|local|regional/i.test(i.localPreference || '')) push({ type: 'supplier_radius', severity: 'medium', options: [], evidence: [], field: 'supplierRadius' });
  if (/researcher/i.test(i.authorityRole || '')) push({ type: 'approval', severity: 'medium', options: ['Yes — needs approval', 'No — I can decide', 'Already approved'], evidence: ['authority: Researcher'], field: 'approval' });
  if (/capex/i.test(i.procurementModel || '')) push({ type: 'installation', severity: 'medium', options: ['Yes', 'No', 'Not sure yet'], evidence: ['procurement: Capex'], field: 'installation' });
  if (/procurement/i.test(i.authorityRole || '')) push({ type: 'po_process', severity: 'medium', options: ['PO / tender', 'Direct buy', 'Rate contract'], evidence: ['authority: Procurement'], field: 'po_process' });
  out.sort((a, b) => b.score - a.score);
  return out;
}
const has = (ns, t) => ns.find((n) => n.type === t);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the Tarbrinder tyre case ──
const tarb = detectContradictions({
  locations: [{ source: 'profile', value: 'Amritsar' }, { source: 'Befisc', value: 'Noida UTTAR GAUTAM BUDHA NAGAR 201304 UP' }, { source: 'profile2', value: 'Bengaluru' }],
  companyName: 'Tyresnmore Online Private Limited', profileType: 'Retailer', twinType: 'End User', isPersonal: true, qty: 1000, unit: 'Piece',
});
ok('Tarbrinder: location mismatch nudge fires', !!has(tarb, 'location'));
ok('Tarbrinder: location options include Amritsar + Noida + Bengaluru', (() => { const n = has(tarb, 'location'); return n.options.some((o) => /amritsar/i.test(o)) && n.options.some((o) => /noida/i.test(o)) && n.options.some((o) => /bengaluru/i.test(o)); })());
ok('Tarbrinder: persona-vs-order nudge fires (personal + business signals)', !!has(tarb, 'persona_vs_order'));
ok('Tarbrinder: persona nudge CONSOLIDATES all 3 signals (entity+profile+qty)', has(tarb, 'persona_vs_order').evidence.length === 3);
ok('Tarbrinder: only ONE personal-conflict nudge (no triple-ask)', tarb.filter((n) => n.type === 'persona_vs_order').length === 1);
ok('Tarbrinder: buyer_type NOT separately emitted (folded into persona nudge)', !has(tarb, 'buyer_type'));
ok('Tarbrinder: persona nudge writes buyerKind', has(tarb, 'persona_vs_order').field === 'buyerKind');

// ── each personal-conflict signal can trigger independently ──
ok('entity alone + personal → persona_vs_order', !!has(detectContradictions({ companyName: 'ABC Pvt Ltd', isPersonal: true }), 'persona_vs_order'));
ok('big qty alone + personal → persona_vs_order', !!has(detectContradictions({ isPersonal: true, qty: 500, unit: 'Piece' }), 'persona_vs_order'));
ok('business profile alone + personal → persona_vs_order', !!has(detectContradictions({ isPersonal: true, profileType: 'Wholesaler' }), 'persona_vs_order'));

// ── buyer_type ambiguity in a BUSINESS order (no personal flag) ──
ok('business order, profile≠twin → buyer_type nudge', !!has(detectContradictions({ profileType: 'Retailer', twinType: 'Manufacturer' }), 'buyer_type'));

// ── supplier-radius consumption (Jaiveer local preference) ──
const jai = detectContradictions({ localPreference: 'High', buyerCity: 'Auraiya', intentType: 'business' });
ok('Jaiveer: local preference → supplier_radius nudge', !!has(jai, 'supplier_radius'));
ok('Jaiveer: no false personal nudge (business order)', !has(jai, 'persona_vs_order'));

// ── NO false positives (chaos / honest) ──
ok('genuine personal small order, no company → NO persona nudge', !has(detectContradictions({ isPersonal: true, qty: 2, unit: 'Piece' }), 'persona_vs_order'));
ok('single location → NO location nudge', !has(detectContradictions({ locations: [{ source: 'profile', value: 'Amritsar' }] }), 'location'));
ok('"Amritsar" vs "Amritsar, Punjab" → SAME place, no nudge', !has(detectContradictions({ locations: [{ source: 'a', value: 'Amritsar' }, { source: 'b', value: 'Amritsar, Punjab' }] }), 'location'));
ok('business order matching profile (Retailer/Retailer) → no buyer_type nudge', !has(detectContradictions({ profileType: 'Retailer', twinType: 'Retailer' }), 'buyer_type'));
ok('empty input → no nudges, no crash', detectContradictions({}).length === 0);
ok('personal + individual profile → NO persona nudge (profile agrees)', !has(detectContradictions({ isPersonal: true, profileType: 'Individual / End User' }), 'persona_vs_order'));

// ── R2 prioritization: scored + sorted; UI caps to top-2 ──
ok('R2: every nudge carries a score', tarb.every((n) => typeof n.score === 'number' && n.score > 0));
ok('R2: returned sorted by score desc', tarb.every((n, idx) => idx === 0 || tarb[idx - 1].score >= n.score));
ok('R2: location (9) outranks supplier_radius (4)', SEVERITY_SCORE.location > SEVERITY_SCORE.supplier_radius);
const many = detectContradictions({ locations: [{ source: 'a', value: 'Amritsar' }, { source: 'b', value: 'Noida' }], companyName: 'X Pvt Ltd', isPersonal: true, qty: 999, unit: 'Piece', localPreference: 'High', authorityRole: 'researcher' });
ok('R2: top-2 cap picks the 2 highest-priority (location + persona)', (() => { const top2 = many.slice(0, 2).map((n) => n.type); return top2.includes('location') && top2.includes('persona_vs_order'); })());
ok('R2: a low-priority nudge (supplier_radius) is pushed below the cap when bigger ones fire', many.findIndex((n) => n.type === 'supplier_radius') >= 2);

// ── R3 engine action-nudges (the previously-idle engines) ──
ok('R3: Authority=Researcher → approval nudge', !!has(detectContradictions({ authorityRole: 'researcher' }), 'approval'));
ok('R3: Procurement=Capex → installation nudge', !!has(detectContradictions({ procurementModel: 'Capex' }), 'installation'));
ok('R3: Authority=Procurement → PO/tender nudge', !!has(detectContradictions({ authorityRole: 'procurement' }), 'po_process'));
ok('R3: influencer/decision_maker → NO approval/po nudge (only the relevant roles)', (() => { const ns = detectContradictions({ authorityRole: 'influencer' }); return !has(ns, 'approval') && !has(ns, 'po_process'); })());
ok('R3: no procurement model → no installation nudge', !has(detectContradictions({ procurementModel: 'Recurring Supply' }), 'installation'));

console.log(`\ncontradictiontest (location · persona consolidation · buyer-type · supplier-radius · R2 priority+cap · R3 engine-nudges · no false positives): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
