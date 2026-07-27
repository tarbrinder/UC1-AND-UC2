// AI-SPECS PLANNER — INVARIANT HARNESS  (run: `node scripts/aispecs-invariants.mjs`)
//
// getMissingSpecs (src/lib/gemini.ts) enforces its guarantees in the DETERMINISTIC PARSER, so they hold no
// matter what the LLM returns. This harness feeds adversarial "LLM outputs" through a faithful MIRROR of that
// parser and asserts every invariant the owner requires:
//   1. never duplicate a page-1 BUYER SPEC — by normalised name AND by option-overlap synonym (e.g. "Rated
//      Power"↔"Power (kVA)", "Genset Type"↔"Enclosure Type")
//   2. never duplicate QUANTITY / order-size / MOQ (page-1 field)
//   3. options-only — every gap question has >= 2 concrete options, no "Other"
//   4. no BRAND/MAKE/MODEL as an OPEN ask (evidence-backed prefill is allowed)
//   5. <= 5 gap-fill questions; evidence-PREFILLED questions are uncapped
//   6. a prefill must be EVIDENCE-BACKED (no fabricated buyer preference)
//   7. malformed / truncated JSON -> [] (never throws, never blanks silently)
//
// ⚠ This is a MIRROR of the parser (guards copied verbatim). If gemini.ts changes, sync here — or (recommended)
//    extract `parseAiSpecs` into a pure module and port this to a vitest that imports the real function.

// ---- mirror of the gemini.ts parser (keep in sync) ----
const norm = (s) => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const BRAND_Q = /\b(brand|manufacturer|oem|make)\b|\bmodel\s*(name|no\.?|number)\b|preferred\s+(supplier|vendor|brand)|\b(vendor|supplier)\b/i;
const QTY_Q = /\b(quantity|qty|order\s*(size|quantity)|volume|units?\s*(required|needed|per)|no\.?\s*of\s*(units|pieces|pcs)|how\s*many|moq|minimum\s*order)\b/i;
const FORM_FIELD_Q = /(\bdeliver\w*\s*(time|timeline|date|schedule|lead|when|by|day|week|location|address|area|city|region|state|pin)|\btimeline\b|\blead\s*time|\bhow\s*soon|\bwhen\s+do\s+you\s+(need|want|require)|\burgen|\bpayment|\badvance\s*payment|\bcredit\s*(term|period|day)|\bgst\b|\bpin\s*code|\bpincode|\bpostal|\binstall\w*\s*(location|address|site|city)|\blocation\b|\bwhere\b|\bshipping\b|\bregion\b|\bsupply\s*(location|area|city|point|address)|\bsite\s*(location|address)|\bcompany\s*size|\bbusiness\s*type|\btype\s*of\s*business|\bindustry\b)/i;

function parseAiSpecs(text, buyerSpecs = [], evidenceFacts = {}, buyerSpecOptions = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { questions: [] }; }
  const evidenceCorpus = Object.values(evidenceFacts).map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  const evidenceBacks = (v) => { const lv = v.toLowerCase().trim(); return evidenceCorpus.some((e) => e.includes(lv) || lv.includes(e)); };
  const seen = new Set(buyerSpecs.map(norm));
  // synonym dedup by OPTION OVERLAP (mirror of gemini.ts)
  const buyerOptSets = Object.values(buyerSpecOptions || {})
    .map((opts) => new Set((opts || []).map(norm).filter(Boolean)))
    .filter((s) => s.size >= 2);
  const optMatches = (a, bset) => bset.has(a) || [...bset].some((b) => (b.length >= 3 && a.includes(b)) || (a.length >= 3 && b.includes(a)));
  const optOverlapsBuyer = (options) => {
    const ns = options.map(norm).filter(Boolean);
    if (ns.length < 2) return false;
    return buyerOptSets.some((bset) => { const m = ns.filter((o) => optMatches(o, bset)).length; return m * 2 > ns.length; });
  };
  const out = [];
  let gapCount = 0;
  for (const q of parsed.questions || []) {
    const name = String(q?.fieldName || '').trim();
    if (!name || seen.has(norm(name))) continue;
    let options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean).filter((o) => o.toLowerCase() !== 'other') : [];
    let prefill = q.prefill ? String(q.prefill).trim() : '';
    if (prefill && !evidenceBacks(prefill)) prefill = '';
    if (prefill && !options.some((o) => o.toLowerCase() === prefill.toLowerCase())) options = [prefill, ...options];
    if (QTY_Q.test(name)) continue;
    if (FORM_FIELD_Q.test(name)) continue;
    if (BRAND_Q.test(name) && !prefill) continue;
    if (!prefill && optOverlapsBuyer(options)) continue;
    if (!prefill && options.length < 2) continue;
    if (prefill && !options.length) options = [prefill];
    seen.add(norm(name));
    const item = { fieldName: name, options, kind: (q.kind === 'intent' || q.kind === 'context') ? q.kind : 'spec', ...(prefill ? { prefill } : {}) };
    if (prefill) { out.push(item); continue; }
    if (gapCount >= 5) continue;
    gapCount++; out.push(item);
  }
  return out;
}

// ---- fixtures: adversarial "LLM outputs" that MUST be cleaned ----
const J = (o) => JSON.stringify(o);
const fixtures = [
  {
    name: 'diesel — drops dup/synonym/qty/brand, keeps valid, caps at 5',
    buyerSpecs: ['Power (kVA)', 'Brand', 'Enclosure Type', 'Finance/Loan Requirement'],
    buyerSpecOptions: {
      'Power (kVA)': ['5 kVA', '10 kVA', '15 kVA', '25 kVA'],
      'Enclosure Type': ['Silent/Canopy', 'Open/Non-Silent'],
    },
    evidence: {},
    text: J({ questions: [
      { fieldName: 'Power', options: ['5 kVA', '10 kVA'] },                    // norm("Power")=="power"==norm("Power (kVA)") -> exact dup, DROP
      { fieldName: 'Rated Power', options: ['5 kVA', '25 kVA'] },              // SYNONYM: options overlap "Power (kVA)" -> DROP (option-overlap dedup)
      { fieldName: 'Genset Type', options: ['Silent', 'Open'] },              // SYNONYM: options ⊂ "Enclosure Type" -> DROP (option-overlap dedup)
      { fieldName: 'Preferred Brand', options: ['Kirloskar', 'Cummins'] },     // brand open -> drop
      { fieldName: 'Order Quantity', options: ['1-5', '5-10'] },               // quantity -> drop
      { fieldName: 'Phase', options: ['Single Phase', 'Three Phase'] },        // keep
      { fieldName: 'Cooling', options: ['Air', 'Water'] },                     // keep
      { fieldName: 'Application', options: ['Backup', 'Prime', 'Standby'], kind: 'intent' }, // keep
      { fieldName: 'Fuel Tank Capacity', options: ['Standard', 'Extended'] },  // keep
      { fieldName: 'Warranty', options: ['1 yr', '2 yr'] },                    // keep (5th)
      { fieldName: 'Delivery Speed', options: ['Immediate', '15 days'] },      // 6th gap -> capped out
    ] }),
    expect: (r) => {
      const names = r.map((q) => q.fieldName.toLowerCase());
      assert(!names.includes('power'), 'dropped exact-name buyer-spec dup ("Power" == "Power (kVA)")');
      assert(!names.includes('rated power'), 'dropped SYNONYM by option-overlap ("Rated Power" ~ "Power (kVA)")');
      assert(!names.includes('genset type'), 'dropped SYNONYM by option-overlap ("Genset Type" ~ "Enclosure Type")');
      assert(!names.some((n) => /brand/.test(n)), 'dropped brand open-ask');
      assert(!names.some((n) => /quantity/.test(n)), 'dropped Order Quantity');
      assert(r.filter((q) => !q.prefill).length <= 5, 'gap questions <= 5');
      assert(r.every((q) => q.options.length >= 2), 'every question >= 2 options');
      assert(names.includes('phase') && names.includes('cooling'), 'kept genuine gaps (Phase, Cooling)');
    },
  },
  {
    name: 'synonym guard is NARROW — a distinct concept sharing ONE option is kept',
    buyerSpecs: ['Enclosure Type'],
    buyerSpecOptions: { 'Enclosure Type': ['Silent/Canopy', 'Open/Non-Silent'] },
    evidence: {},
    text: J({ questions: [
      { fieldName: 'Cooling', options: ['Air-cooled', 'Water-cooled'] },       // no option overlap -> KEEP (not a false synonym drop)
      { fieldName: 'Mounting', options: ['Open frame', 'Skid'] },             // "Open frame" contains no ⊂ match to full "open non silent"; kept
    ] }),
    expect: (r) => {
      const names = r.map((q) => q.fieldName.toLowerCase());
      assert(names.includes('cooling'), 'distinct concept (Cooling) NOT falsely dropped');
      assert(r.length >= 1, 'narrow synonym guard did not over-drop');
    },
  },
  {
    name: 'prefill — evidence-backed kept & uncapped; fabricated prefill stripped',
    buyerSpecs: ['Power (kVA)'],
    buyerSpecOptions: {},
    evidence: { Power: '30 kVA', Usage: 'construction site' },
    text: J({ questions: [
      { fieldName: 'Site Type', options: ['Factory', 'Construction site'], prefill: 'Construction site' }, // evidence -> keep prefilled
      { fieldName: 'Colour', options: ['Red', 'Blue'], prefill: 'Green' },     // fabricated (no evidence) -> prefill stripped, kept as normal gap
      { fieldName: 'A', options: ['1', '2'] }, { fieldName: 'B', options: ['1', '2'] },
      { fieldName: 'C', options: ['1', '2'] }, { fieldName: 'D', options: ['1', '2'] },
      { fieldName: 'E', options: ['1', '2'] }, { fieldName: 'F', options: ['1', '2'] }, // 6 gaps -> only 5 kept + the prefilled one (uncapped)
    ] }),
    expect: (r) => {
      const site = r.find((q) => /site type/i.test(q.fieldName));
      assert(site && site.prefill === 'Construction site', 'evidence prefill kept');
      const colour = r.find((q) => /colour/i.test(q.fieldName));
      assert(colour && !colour.prefill, 'fabricated prefill stripped');
      assert(r.filter((q) => !q.prefill).length <= 5, 'gaps capped at 5 even with a prefilled extra');
      assert(r.some((q) => q.prefill), 'prefilled question survived beyond the cap');
    },
  },
  {
    name: 'options gate — <2 options and "Other"-only dropped/cleaned',
    buyerSpecs: [],
    buyerSpecOptions: {},
    evidence: {},
    text: J({ questions: [
      { fieldName: 'Free text thing', options: [] },                          // 0 opts -> drop
      { fieldName: 'Yes or no', options: ['Yes'] },                           // 1 opt -> drop
      { fieldName: 'Finish', options: ['Matte', 'Glossy', 'Other'] },         // keep, "Other" filtered
    ] }),
    expect: (r) => {
      assert(r.length === 1 && /finish/i.test(r[0].fieldName), 'only the >=2-option question survived');
      assert(!r[0].options.some((o) => /^other$/i.test(o)), '"Other" filtered out');
    },
  },
  {
    name: 'last-page fields (delivery/timeline/payment/location/GST/business/industry) dropped; legit specs kept',
    buyerSpecs: [],
    buyerSpecOptions: {},
    evidence: { Timeline: 'urgent' },
    text: J({ questions: [
      { fieldName: 'Required Delivery Timeline', options: ['Immediate', 'Within 15 Days'] },        // last-page field -> DROP (the exact leak owner flagged)
      { fieldName: 'Delivery Timeline', options: ['Immediate', 'Flexible'], prefill: 'urgent' },     // even PREFILLED, a dedicated field -> DROP
      { fieldName: 'Payment Terms', options: ['Advance', 'Credit'] },                                // -> DROP
      { fieldName: 'Delivery Location', options: ['North', 'South'] },                               // -> DROP
      { fieldName: 'GST Registration', options: ['Yes', 'No'] },                                     // -> DROP
      { fieldName: 'Business Type', options: ['Manufacturer', 'Trader'] },                           // -> DROP
      { fieldName: 'Industry', options: ['Construction', 'Textile'] },                               // -> DROP
      { fieldName: 'Lead Time', options: ['1 week', '2 weeks'] },                                    // -> DROP
      { fieldName: 'Delivery Pressure', options: ['4 bar', '6 bar'] },                               // legit pump spec -> KEEP
      { fieldName: 'Installation Type', options: ['Indoor', 'Outdoor'] },                            // legit context -> KEEP
      { fieldName: 'Purchase Frequency', options: ['One-time', 'Monthly'] },                         // intentional AI-spec (product-vs-service) -> KEEP
    ] }),
    expect: (r) => {
      const names = r.map((q) => q.fieldName.toLowerCase());
      for (const bad of ['required delivery timeline', 'delivery timeline', 'payment terms', 'delivery location', 'gst registration', 'business type', 'industry', 'lead time']) {
        assert(!names.includes(bad), `dropped last-page field "${bad}"`);
      }
      assert(names.includes('delivery pressure'), 'kept legit product spec "Delivery Pressure"');
      assert(names.includes('installation type'), 'kept legit context "Installation Type"');
      assert(names.includes('purchase frequency'), 'kept intentional AI-spec "Purchase Frequency"');
    },
  },
  {
    name: 'ANY location/where question dropped (supply/site/shipping/region/pincode) — not just "delivery …"',
    buyerSpecs: [],
    buyerSpecOptions: {},
    evidence: {},
    text: J({ questions: [
      { fieldName: 'Supply Location', options: ['North', 'South'] },                 // leaked before (no "deliver" prefix) -> DROP
      { fieldName: 'Site Location', options: ['Indoor', 'Outdoor site'] },           // -> DROP
      { fieldName: 'Where will you use it?', options: ['Factory', 'Warehouse'] },    // -> DROP
      { fieldName: 'Shipping Address Type', options: ['Home', 'Office'] },           // -> DROP
      { fieldName: 'Region', options: ['North India', 'South India'] },              // -> DROP
      { fieldName: 'Pincode Area', options: ['Metro', 'Non-metro'] },                // -> DROP
      { fieldName: 'Coverage Area', options: ['Small', 'Large'] },                   // legit product spec (no supply/deliver prefix) -> KEEP
      { fieldName: 'Installation Type', options: ['Wall', 'Floor'] },                // legit context -> KEEP
    ] }),
    expect: (r) => {
      const names = r.map((q) => q.fieldName.toLowerCase());
      for (const bad of ['supply location', 'site location', 'where will you use it?', 'shipping address type', 'region', 'pincode area']) {
        assert(!names.includes(bad), `dropped location question "${bad}"`);
      }
      assert(names.includes('coverage area'), 'kept legit "Coverage Area"');
      assert(names.includes('installation type'), 'kept legit "Installation Type"');
    },
  },
  { name: 'malformed JSON -> [] (never throws)', buyerSpecs: [], buyerSpecOptions: {}, evidence: {}, text: '{ questions: [broken', expect: (r) => assert(Array.isArray(r) && r.length === 0, 'malformed -> empty array') },
];

// ---- runner ----
let failed = 0;
function assert(cond, msg) { if (!cond) { failed++; console.log(`    ✗ ${msg}`); } else { console.log(`    ✓ ${msg}`); } }
for (const f of fixtures) {
  console.log(`\n• ${f.name}`);
  try { f.expect(parseAiSpecs(f.text, f.buyerSpecs, f.evidence, f.buyerSpecOptions)); }
  catch (e) { failed++; console.log(`    ✗ threw: ${e.message}`); }
}
console.log(failed ? `\n❌ ${failed} assertion(s) failed` : `\n✅ all invariants hold`);
process.exit(failed ? 1 : 0);
