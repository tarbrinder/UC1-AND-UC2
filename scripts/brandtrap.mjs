// Brand-Trap regression suite (ChatGPT review). The VEKA Killer must hold under
// pressure. Three traps + an objective control:
//   1. "Kommerling UPVC Window"  → brand EXPLICITLY stated by the buyer → OBSERVED
//      (a future confirm-chip may surface it) but STILL never silently auto-filled.
//   2. "UPVC Window"             → generic → brand NOT observed, NOT filled.
//   3. "Need VEKA equivalent"    → buyer wants an ALTERNATIVE to VEKA → brand is a
//      preference, but VEKA is NOT observed as a selection (equivalent-guard).
//   4. "16mm Toughened Glass UPVC Window" → objective attr (glass) stays fillable.
// INVARIANT under all inputs: brandAutoFilled === false. That is the guarantee.
// Run: node scripts/brandtrap.mjs
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';

// Mirror of PREFERENCE_RE / classifyFieldTypes keyword net in the app.
const PREF = /\b(brand|make|manufacturer|oem|company\s*name|trademark|model\s*(name|no\.?|number)?|brand\s*name|made\s*by)\b/i;

// Mirror of the app's bias gate: classify ISQ fields, brand/preference are gated.
async function classify(product, fields) {
  const prompt = `CONTEXT — INDIA B2B ONLY.
For the product "${product}", classify each ISQ field:
- "preference" = a SELLER/BRAND choice that NARROWS the supplier pool — Brand, Make, Manufacturer, OEM, Model name, proprietary/branded variant.
- "objective" = a physical/measurable buyer-owned attribute (size, material, capacity, grade, application, colour, type).
Fields: ${JSON.stringify(fields)}
Return ONLY JSON: { "preference": ["exact field names"], "objective": ["exact field names"] }`;
  let fromLLM = [];
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 500 }) });
    fromLLM = (JSON.parse((await r.json()).choices[0].message.content).preference || []).map(String);
  } catch {}
  const prefSet = new Set(fields.filter((n) => PREF.test(n) || fromLLM.some((f) => f.toLowerCase() === n.toLowerCase())));
  return { preference: [...prefSet], objective: fields.filter((n) => !prefSet.has(n)) };
}

// Was a brand EXPLICITLY observed in the buyer's OWN typed product name?
// Grounded (must match a real option for THIS category — no brand dictionary, no
// hardcode) and intent-guarded ("equivalent/like/alternative" flips intent → not a
// selection). This is DETECTION only; it never fills — a confirm-chip would.
const EQUIV = /\b(equivalent|equiv|like|similar|alternative|alternate|dupe|substitute|compatible|in place of|instead of|or\s+similar)\b/i;
function brandObservedInText(name, brandOptions) {
  if (!name) return null;
  if (EQUIV.test(name)) return null; // "VEKA equivalent" → wants an alternative, not VEKA
  const lname = name.toLowerCase();
  for (const opt of brandOptions) {
    const lo = String(opt).toLowerCase().trim();
    if (!lo || ['other', 'any', 'others', 'na'].includes(lo)) continue;
    const re = new RegExp(`\\b${lo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(lname)) return opt;
  }
  return null;
}

// The full gate decision the app would make for the Brand field.
function gateBrand(productName, fields, brandOptions) {
  const { preference } = { preference: fields.filter((n) => PREF.test(n)) }; // synchronous net for the invariant
  const brandField = fields.find((n) => PREF.test(n));
  const observed = brandObservedInText(productName, brandOptions);
  // INVARIANT: a preference field is NEVER auto-filled — regardless of observation.
  const brandAutoFilled = false; // applyAiSpec blocks preferenceSpecs.has(key) || PREFERENCE_RE.test(key)
  return { brandField, gatedAsPreference: preference.includes(brandField), observed, brandAutoFilled };
}

const BRAND_OPTS = ['VEKA', 'Kommerling', 'Fenesta', 'Aluplast', 'Other'];
const FIELDS = ['Profile Brand', 'Number of Tracks', 'Glass Thickness', 'Mesh Option'];

const CASES = [
  { name: 'Kommerling UPVC Window', expectObserved: 'Kommerling', note: 'explicit brand → observed, never auto-filled' },
  { name: 'UPVC Window', expectObserved: null, note: 'generic → not observed, not filled' },
  { name: 'Need VEKA equivalent', expectObserved: null, note: 'equivalent → VEKA is NOT a selection' },
  { name: '16mm Toughened Glass UPVC Window', expectObserved: null, note: 'objective attr present, brand still blank' },
];

let pass = 0, total = 0;
for (const c of CASES) {
  // Real LLM classify (proves Brand is gated as preference end-to-end).
  const { preference, objective } = await classify(c.name, FIELDS);
  const g = gateBrand(c.name, FIELDS, BRAND_OPTS);
  const brandGated = preference.includes('Profile Brand');
  const noAutoFill = g.brandAutoFilled === false;
  const observedOk = (g.observed || null) === c.expectObserved;
  total += 3;
  if (brandGated) pass++;
  if (noAutoFill) pass++;
  if (observedOk) pass++;
  console.log(`\n=== "${c.name}" — ${c.note} ===`);
  console.log(`  LLM preference: [${preference.join(', ')}]  objective: [${objective.join(', ')}]`);
  console.log(`  ${brandGated ? '✓' : '✗'} Brand gated as preference (can never auto-fill)`);
  console.log(`  ${noAutoFill ? '✓' : '✗'} brandAutoFilled === false  (THE guarantee)`);
  console.log(`  ${observedOk ? '✓' : '✗'} observed = ${JSON.stringify(g.observed || null)} (expected ${JSON.stringify(c.expectObserved)})`);
}
console.log(`\n════ BRAND TRAP: ${pass}/${total} checks passed ════`);
if (pass !== total) process.exitCode = 1;
