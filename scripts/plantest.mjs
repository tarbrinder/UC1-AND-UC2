// Breadth test for the Intent Planner (P1: intent-ranking). Calls the gateway
// directly with the exact planRequirement prompt and prints specOrder / lead /
// personaOptions so we can confirm the right thing LEADS and personas fit.
// Run: node scripts/plantest.mjs
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
if (!KEY) { console.error('no VITE_LLM_KEY in .env'); process.exit(1); }
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';

const INDIA_CTX =
  'CONTEXT — INDIA B2B ONLY. This is IndiaMART, an India business-to-business marketplace. EVERYTHING you output must be in Indian context. MONEY/BUDGET/PRICE: ALWAYS Indian Rupees with the ₹ symbol and Indian numbering — use bands like "Under ₹50,000", "₹50,000–₹2 lakh", "₹2–10 lakh", "₹10 lakh+", "₹1 crore+". Use lakh/crore, NEVER million/billion, NEVER $/USD/"dollar". Places = Indian cities/states; standards = BIS/ISI/IS; norms = GST, Indian trade terms. Never use foreign currencies, units, places, or examples.';

const buildPrompt = ({ productName, mcatType, quantity, unit, application, isqSpecsWithOptions }) =>
`${INDIA_CTX}
You are planning an IndiaMART RFQ so a SELLER can decide to serve and quote WITHOUT a discovery call.
OPTIMISE FOR LEAD QUALIFICATION, NOT SEARCH: rank attributes by which, once known, infers the MOST about the rest of the requirement AND who the buyer is — the single most-inferent attribute leads. (e.g. hair wax "Usage: Salon vs Personal" implies hold / finish / pack-size / pricing → it leads, even though it is a spec.)
Product: "${productName}"
Category type: ${mcatType || 'unknown'} (P=product, S=service)
Quantity: ${quantity || '?'} ${unit || ''}
Buyer use-case (if any): "${application || ''}"
Category ISQ spec fields WITH options — REFERENCE ONLY (the spec dimension a seller expects; NOT the goal): ${JSON.stringify(isqSpecsWithOptions)}

Think about how THIS trade actually sells, then produce a PLAN:
1. "archetype": commodity | branded_commodity | capital | made_to_spec | project_service | visual_odd_part.
2. "orderMode": "qualifier_first" if "lead" is a non-spec qualifier; "spec_first" otherwise.
3. "specOrder": ALL ISQ spec field names (exactly as listed above), ranked by INFERENCE POWER — highest-intent first (the one that collapses the most uncertainty about the rest of the requirement AND the buyer).
4. "lead": the ONE intent-driver to ask FIRST — it MAY be an existing ISQ spec OR a new non-spec qualifier; pick whichever is highest-intent. Shape: { "source": "spec" | "qualifier", "ref": "<exact ISQ field name if source=spec, else the qualifier question text>" }. (hair wax → {"source":"spec","ref":"Usage"}; VTD → {"source":"qualifier","ref":"Is this for cGMP / pharma use?"}; solar → {"source":"qualifier","ref":"Residential, commercial or a tender?"}.)
   LEAD RULE: for capital / project_service / made_to_spec, a USE / SCOPE / COMPLIANCE qualifier (cGMP, tender, supply-vs-install, new-vs-replacement) almost ALWAYS outranks a single spec — use source:"qualifier". A spec leads ONLY when that spec is itself the dominant use-fork.
   APPLICATION/USAGE RULE (STRICT): if an ISQ spec already captures use/application (named like Usage / Application / End Use / Suitable For / Industry), the lead MUST be THAT spec (source:"spec", orderMode:"spec_first", ref=the exact field name). NEVER create a free-text "primary application / which industry" qualifier, NEVER set qualifier_first for this, NEVER put it in "questions". (e.g. Diesel Generator HAS "Usage" → lead={"source":"spec","ref":"Usage"}, spec_first.)
5. "leadingQuestion": if lead.source=="qualifier", repeat its text here; else "".
6. "mustHaveSpecs": the top 1-4 DECISIVE specs (a subset of specOrder).
7. "personaOptions": 4-6 CATEGORY-TAILORED buyer types — NOT the generic Manufacturer/Stockist/Reseller/Trader/End User. e.g. cosmetics → ["Salon","Retailer","Distributor","Private-label brand","Individual"]; fencing → ["Contractor","Farmer","Wholesaler","Builder"]; cable → ["Contractor","Electrician","Wholesaler","Distributor"].
8. "questions": 3-6 non-spec questions (kind context|persona ONLY) a seller in THIS trade asks. Each: {id, label, options (3-5 chips, REQUIRED), kind, decisive, placement, order, reason}.
   a. CHIPS ONLY — every question MUST have 3-5 specific category-tailored chips; NEVER empty/free-text (form adds "Other…"). If you can't enumerate concrete options (open-ended material/size/application/location), DROP the question.
   b. DO THE HARD WORK on options — real buckets, not lazy yes/no. Cadence GOOD=["One-time","Monthly","Quarterly","Annual contract"]. Budget = ₹ lakh/crore bands sized to product; NEVER $.
   c. ALWAYS include a CATEGORY-RELEVANT SCALE question in the buyer's terms (salon→["Single chair","2–5 chairs","6–15 chairs","Chain"]); NOT generic company-size.
   d. The form already collects these (some HIDDEN) — NEVER ask in ANY phrasing: quantity/order-size; delivery LOCATION (city/state/region/pincode/"where installed"); timeline ("how soon"); payment (terms/advance/credit); GST; firm; contact. ("Which state will it be installed?" = location → FORBIDDEN.)
   e. Scenario signals as chips: repeat-vs-one-time, supply-vs-install, new-vs-expansion, sample/swatch, tender, budget, brand-or-best-rate (only if brand NOT an ISQ field).
   - Do NOT add a buyer-type / identity / "which best describes you" question — "personaOptions" already covers identity and the form renders it.
9. "serveSignals": what the seller needs to decide serve/no-serve.

RULES:
- Category-DEFINING only. No generic chatter, no PII, no seller tone.
- Do NOT duplicate the ISQ fields above as questions.
- BRAND: if ANY ISQ field is about brand/make/manufacturer/OEM, NEVER add a brand question. Only ask "specific brand or best rate?" when brand is ENTIRELY ABSENT from the ISQ fields.
- Tight: at most 8 questions, decisive first.

Return ONLY JSON: { "archetype": "...", "orderMode": "...", "specOrder": ["..."], "lead": { "source": "spec", "ref": "..." }, "leadingQuestion": "", "mustHaveSpecs": ["..."], "personaOptions": ["..."], "questions": [ { "id": "", "label": "", "options": [], "kind": "context", "decisive": true, "placement": "wizard", "order": 1, "reason": "" } ], "serveSignals": ["..."] }`;

const CASES = [
  // Diesel Generator WITH a Usage spec → tests the APPLICATION/USAGE RULE: lead
  // must be the Usage spec (chips), NOT a free-text "primary application".
  { productName: 'Diesel Generator', mcatType: 'P', quantity: '', unit: '', isqSpecsWithOptions: {
    'Rated Power': ['5 kVA', '15 kVA', '30 kVA', '62.5 kVA'], 'Usage': ['Residential', 'Commercial', 'Industrial', 'Telecom', 'Construction'],
    'Engine Brand': ['Kirloskar', 'Cummins', 'Mahindra'], 'Phase': ['Single', 'Three'], 'Fuel Type': ['Diesel'] } },
  { productName: 'Hair Wax', mcatType: 'P', quantity: '1000', unit: 'Pieces', isqSpecsWithOptions: {
    'Form': ['Wax', 'Clay', 'Gel', 'Pomade'], 'Hold Level': ['Light', 'Medium', 'Strong'], 'Finish': ['Matte', 'Shine'],
    'Usage': ['Salon', 'Personal Use', 'Men', 'Women', 'Unisex'], 'Fragrance': ['Mild', 'Strong', 'Citrus', 'Fruity', 'Woody'],
    'Water Soluble': ['Yes', 'No'], 'Pack Size': ['50 g', '100 g', '500 g', '1 kg'] } },
  // SMBI machinery
  { productName: 'Paper Plate Making Machine', mcatType: 'P', quantity: '1', unit: 'Unit', isqSpecsWithOptions: {
    'Automation Grade': ['Manual', 'Semi-automatic', 'Hydraulic', 'Fully Automatic'], 'Number of Dies': ['Single', 'Double'],
    'Production Capacity': ['1500 pcs/hr', '3000 pcs/hr', '5500 pcs/hr'], 'Power Phase': ['Single Phase', 'Three Phase'] } },
  // Eleczar visual / odd-part components
  { productName: 'Flexible Conduit', mcatType: 'P', quantity: '500', unit: 'Metre', isqSpecsWithOptions: {
    'Material': ['Polyamide', 'Nylon', 'PVC', 'GI'], 'Size': ['PG7', 'PG13', 'PG21', 'PG48'], 'Grade': ['FR', 'Regular'], 'Colour': ['Black', 'Grey'] } },
  // JainBandhu fabric
  { productName: 'Cotton Fabric', mcatType: 'P', quantity: '2000', unit: 'Metre', isqSpecsWithOptions: {
    'Material': ['Cotton', 'Linen', 'Viscose', 'Rayon'], 'GSM': ['80', '120', '180'], 'Width': ['44 inch', '58 inch'] } },
  { productName: 'Power Cable', mcatType: 'P', quantity: '5000', unit: 'Metre', isqSpecsWithOptions: {
    'Conductor Material': ['Aluminium', 'Copper'], 'Number of Cores': ['1', '2', '3', '3.5', '4'],
    'Size': ['6 sq mm', '16 sq mm', '95 sq mm', '240 sq mm'], 'Type': ['Armoured', 'Unarmoured', 'Flexible'],
    'Insulation': ['PVC', 'XLPE'], 'Voltage Grade': ['1.1 kV', '11 kV', '33 kV'] } },
  { productName: 'Vacuum Tray Dryer', mcatType: 'P', quantity: '', unit: '', isqSpecsWithOptions: {
    'Material Grade': ['SS304', 'SS316', 'SS316L'], 'Capacity': ['6 trays', '12 trays', '48 trays'] } },
  { productName: 'Chain Link Fencing', mcatType: 'P', quantity: '2000', unit: 'Running Feet', isqSpecsWithOptions: {
    'Material': ['GI', 'PVC-coated', 'SS'], 'Mesh Size': ['1 inch', '2 inch', '3 inch'], 'Wire Gauge': ['8', '10', '12'],
    'Height': ['4 ft', '6 ft', '8 ft'], 'Coating': ['Galvanized', 'PVC'] } },
];

const call = async (c) => {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages: [{ role: 'user', content: buildPrompt(c) }], response_format: { type: 'json_object' }, max_tokens: 2048 }),
  });
  const data = await res.json();
  let p; try { p = JSON.parse(data.choices?.[0]?.message?.content ?? '{}'); } catch { p = { parseError: true }; }
  return { finish: data.choices?.[0]?.finish_reason, p };
};

for (const c of CASES) {
  const { finish, p } = await call(c);
  console.log('\n=== ' + c.productName + ' === (finish:' + finish + ')');
  if (p.parseError) { console.log('  PARSE ERROR'); continue; }
  console.log('  archetype : ' + p.archetype + '   order: ' + p.orderMode);
  console.log('  LEAD      : ' + (p.lead ? `[${p.lead.source}] ${p.lead.ref}` : '(none)'));
  console.log('  specOrder : ' + (p.specOrder || []).join(' > '));
  console.log('  personas  : ' + (p.personaOptions || []).join(' / '));
  for (const q of p.questions || []) {
    const opts = (q.options || []).length ? `  {${q.options.join(' | ')}}` : '';
    console.log(`    [${q.placement}/${q.kind}${q.decisive ? '*' : ''}] ${q.label}${opts}`);
  }
  // ── Assertions (the never-miss safety net) ──────────────────────────────────
  const qs = p.questions || [];
  // India-context guard: any $/USD/dollar that slipped through.
  const bad = JSON.stringify(p).match(/\$\s?\d|USD|dollar/gi);
  if (bad) console.log('  ⚠️  NON-₹ CURRENCY: ' + [...new Set(bad)].join(', '));
  // Chips-only: every NON-spec question must carry ≥2 option chips (no free text).
  const chipless = qs.filter((q) => q.kind !== 'spec' && (q.options || []).length < 2).map((q) => q.label);
  if (chipless.length) console.log('  ⚠️  FREE-TEXT (needs chips): ' + chipless.join(' | '));
  // Never re-ask a dedicated form field (quantity/delivery/timeline/payment).
  const COVERED = /(\bquantit|\bqty\b|how many|order\s*size|order\s*quantit|pieces?\s*required|number of (pieces|units)|\bdeliver|\btimeline\b|lead\s*time|how soon|\burgen|by when|when do you (need|require|want)|\bpayment|advance payment|credit\s*(term|period)|\bgst\b|pin\s?code|postal|\bcity\b|\bstate\b|\bregion\b)/i;
  const covered = qs.filter((q) => COVERED.test(q.label || '')).map((q) => q.label);
  if (covered.length) console.log('  ⚠️  RE-ASKS FORM FIELD: ' + covered.join(' | '));
  if (!bad && !chipless.length && !covered.length) console.log('  ✓ chips-only · ₹-only · no form-field dupes');
}
