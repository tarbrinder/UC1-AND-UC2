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
const SEVERITY_SCORE = { location: 9, persona_vs_order: 8, scale_vs_role: 7, approval: 6, installation: 6, new_direction: 6, po_process: 5, buyer_type: 5, supplier_radius: 4 };
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
  const natureResolved = /academic|research|government|psu/i.test(i.nature || '') && (i.natureConfidence || 0) >= 80;
  if (!natureResolved && !out.some((n) => n.type === 'persona_vs_order') && i.profileType && i.twinType) {
    if (slug(i.profileType) !== slug(i.twinType) && !i.profileType.includes(i.twinType) && !i.twinType.includes(i.profileType))
      push({ type: 'buyer_type', severity: 'medium', options: [i.profileType, i.twinType, 'Other'], evidence: [], field: 'buyerType' });
  }
  if (/high|local|regional/i.test(i.localPreference || '')) push({ type: 'supplier_radius', severity: 'medium', options: [], evidence: [], field: 'supplierRadius' });
  if (/researcher/i.test(i.authorityRole || '')) push({ type: 'approval', severity: 'medium', options: ['Yes — needs approval', 'No — I can decide', 'Already approved'], evidence: ['authority: Researcher'], field: 'approval' });
  if (/capex/i.test(i.procurementModel || '')) push({ type: 'installation', severity: 'medium', options: ['Yes', 'No', 'Not sure yet'], evidence: ['procurement: Capex'], field: 'installation' });
  if (/procurement/i.test(i.authorityRole || '')) push({ type: 'po_process', severity: 'medium', options: ['PO / tender', 'Direct buy', 'Rate contract'], evidence: ['authority: Procurement'], field: 'po_process' });
  // P3.8 cross-signal: bulk/wholesale role placing a SINGLE/sample order
  const bulkRole = /trader|wholesal|distributor|stockist|reseller/i.test(`${i.profileType || ''} ${i.twinType || ''}`);
  if (bulkRole && i.orderScale === 'single' && !personal) push({ type: 'scale_vs_role', severity: 'medium', options: ['Sample / trial', 'For own use', 'Same as usual (bulk)', 'New requirement'], evidence: ['usual: bulk role', 'this order: single'], field: 'scale_context' });
  // P3.8 cross-signal: the current product is unrelated to the buyer's entire history
  if (i.offProfileNewProduct) push({ type: 'new_direction', severity: 'medium', options: ['A new line / expansion', 'A one-off or project', 'Just trying it out'], evidence: ['off-profile product'], field: 'new_direction' });
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

// ── history ↔ external-world token-overlap (the inline check in RFQModalV3) ──
// Bug it guards: "Frosted PVC Bag" history was flagged as CONTRADICTING a World result for a company
// that LITERALLY MAKES PVC bags — because the old check used a 60-char-truncated summary + ≥4-char tokens
// (dropping "pvc"/"bag"). Fix: FULL summary + ≥3-char tokens. A real domain mismatch must still flag.
const HV_STOP = new Set(['product', 'products', 'trading', 'trader', 'traders', 'service', 'services', 'supplier', 'suppliers', 'manufacturer', 'manufacturers', 'wholesale', 'wholesaler', 'retail', 'retailer', 'company', 'india', 'limited', 'private', 'export', 'exporter', 'import', 'importer', 'industries', 'industrial', 'goods', 'item', 'items', 'material', 'materials', 'the', 'and', 'for', 'are', 'our', 'was', 'has', 'new', 'pvt', 'ltd', 'with', 'from', 'about']);
const hvTok = (xs) => new Set(xs.flatMap((x) => (String(x).toLowerCase().match(/[a-z]{3,}/g) || [])).filter((w) => !HV_STOP.has(w)));
const historyVsWorld = (cats, world) => { const a = hvTok(cats), b = hvTok(world); return !!(a.size && b.size && ![...a].some((w) => b.has(w))); };
const hvOLD = (cats, world) => { const t = (xs) => new Set(xs.flatMap((x) => (String(x).toLowerCase().match(/[a-z]{4,}/g) || [])).filter((w) => !HV_STOP.has(w))); const a = t(cats), b = t(world.map((s) => String(s).slice(0, 60))); return !!(a.size && b.size && ![...a].some((w) => b.has(w))); };
const TT_HISTORY = ['Frosted PVC Bag', 'A4 Paper Rim', 'Customised Wooden Stamps'];
const TT_WORLD = ['Shri Tirumala Traders - Retailer from New Delhi, India | About Us. Established in 1992, we are Manufacturer, Trader and Retailer of Office File, Button File Folder, Jute Gift Bag, Jute File Folder, PVC Bag, Portfolio Bag and more.'];
ok('HV: FIXED — PVC-bag history vs a company that MAKES PVC bags → NO contradiction', historyVsWorld(TT_HISTORY, TT_WORLD) === false);
ok('HV: the OLD truncated/≥4 version WOULD have false-flagged it (the bug was real)', hvOLD(TT_HISTORY, TT_WORLD) === true);
ok('HV: genuinely unrelated history vs world → contradiction still flags', historyVsWorld(['Diesel Generator', 'Forklift'], ['Sharma Events — wedding planner and decoration in Mumbai']) === true);
ok('HV: no external evidence → no contradiction', historyVsWorld(['PVC Bag'], []) === false);
ok('HV: no history → no contradiction', historyVsWorld([], TT_WORLD) === false);
ok('HV: short distinctive product word ("box") now overlaps → no false contradiction', historyVsWorld(['Corrugated Box'], ['We make box and carton packaging']) === false);

// ── P1.1: nudge RESOLUTION routing (mirror answerNudge) — every answer must be CONSUMED, not inert ──
// Returns what a tapped option writes: a form field and/or a CONFIRMED coverage fact (system-of-record).
function resolveNudge(field, type, opt) {
  const out = { page1Choice: null, deliveryLocation: null, buyerType: null, fact: null };
  if (field === 'buyerKind') {
    if (/personal/i.test(opt)) out.page1Choice = 'personal';
    else if (/business|resale|workshop|fleet/i.test(opt)) out.page1Choice = 'business';
  }
  if (field === 'deliveryCity' && opt && opt !== 'Other') out.deliveryLocation = opt;
  if (field === 'buyerType' && opt && opt !== 'Other') out.buyerType = opt;
  if (opt && opt !== 'Other') {
    const concept = { supplier_radius: 'supplier radius', approval: 'approval needed', installation: 'installation support', po_process: 'procurement process' }[type];
    if (concept) out.fact = { concept, value: opt, source: 'User' };
  }
  return out;
}
ok('resolve: buyerKind "Personal use" → page1Choice=personal', resolveNudge('buyerKind', 'persona_vs_order', 'Personal use').page1Choice === 'personal');
ok('resolve: buyerKind "Business / resale" → page1Choice=business', resolveNudge('buyerKind', 'persona_vs_order', 'Business / resale').page1Choice === 'business');
ok('resolve: deliveryCity "Amritsar" → deliveryLocation=Amritsar', resolveNudge('deliveryCity', 'location', 'Amritsar').deliveryLocation === 'Amritsar');
ok('resolve: buyerType "Manufacturer" → form.buyerType=Manufacturer', resolveNudge('buyerType', 'buyer_type', 'Manufacturer').buyerType === 'Manufacturer');
ok('resolve: supplier_radius "Within the state" → CONFIRMED fact (was inert before)', (() => { const f = resolveNudge('supplierRadius', 'supplier_radius', 'Within the state').fact; return f && f.concept === 'supplier radius' && f.value === 'Within the state' && f.source === 'User'; })());
ok('resolve: approval "Yes — needs approval" → CONFIRMED fact', (() => { const f = resolveNudge('approval', 'approval', 'Yes — needs approval').fact; return f && f.concept === 'approval needed' && f.source === 'User'; })());
ok('resolve: installation "Yes" → CONFIRMED fact', resolveNudge('installation', 'installation', 'Yes').fact?.concept === 'installation support');
ok('resolve: po_process "PO / tender" → CONFIRMED fact', resolveNudge('po_process', 'po_process', 'PO / tender').fact?.concept === 'procurement process');
ok('resolve: "Other" writes nothing (no spurious field/fact)', (() => { const r = resolveNudge('buyerType', 'buyer_type', 'Other'); return r.buyerType === null && r.fact === null; })());

// ── P3.8: cross-signal contradictions (qty-scale × role; trajectory/off-profile × current product) ──
const scaleMismatch = detectContradictions({ profileType: 'Wholesaler', twinType: 'Trader', orderScale: 'single' });
ok('scale_vs_role: a known wholesaler ordering a SINGLE qty fires the nudge', !!has(scaleMismatch, 'scale_vs_role'));
ok('scale_vs_role: NOT fired for a wholesaler on a bulk order (normal)', !has(detectContradictions({ profileType: 'Wholesaler', orderScale: 'wholesale' }), 'scale_vs_role'));
ok('scale_vs_role: NOT fired for an end-user on a single order (normal personal buy)', !has(detectContradictions({ profileType: 'End User', orderScale: 'single' }), 'scale_vs_role'));
ok('scale_vs_role: suppressed when the buyer is personal (no business-role clash)', !has(detectContradictions({ profileType: 'Wholesaler', orderScale: 'single', isPersonal: true }), 'scale_vs_role'));
const newDir = detectContradictions({ offProfileNewProduct: true });
ok('new_direction: an off-profile product (unrelated to all history) fires the nudge', !!has(newDir, 'new_direction'));
ok('new_direction: NOT fired when the product is on-profile', !has(detectContradictions({ offProfileNewProduct: false }), 'new_direction'));
ok('new_direction: options are new-line / one-off / trying-out (shape intent as fresh)', has(newDir, 'new_direction').options.length === 3);
ok('cross-signal nudges carry a field a tap can route back (P1.1 loop)', has(scaleMismatch, 'scale_vs_role').field === 'scale_context' && has(newDir, 'new_direction').field === 'new_direction');
ok('priority: scale_vs_role (7) outranks supplier_radius (4) in the top-N cut', SEVERITY_SCORE.scale_vs_role > SEVERITY_SCORE.supplier_radius);

// P0 identity hierarchy — a confident institutional Nature SUPPRESSES the "which buyer type?" nudge.
ok('IIT-K: buyer_type nudge SUPPRESSED when Nature=Academic conf 95 (not asked)', !has(detectContradictions({ profileType: 'Business Buyer', twinType: 'Manufacturer', nature: 'Academic / Research Institution', natureConfidence: 95 }), 'buyer_type'));
ok('buyer_type nudge STILL fires for a corporate buyer with conflicting profile/twin (no Nature lock)', !!has(detectContradictions({ profileType: 'Retailer', twinType: 'Manufacturer', nature: 'Corporate / Business', natureConfidence: 90 }), 'buyer_type'));
ok('buyer_type nudge fires when Nature confidence is low (<80)', !!has(detectContradictions({ profileType: 'Retailer', twinType: 'Manufacturer', nature: 'Academic / Research Institution', natureConfidence: 50 }), 'buyer_type'));

console.log(`\ncontradictiontest (location · persona consolidation · buyer-type · supplier-radius · R2 priority+cap · R3 engine-nudges · history↔world overlap · no false positives): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
