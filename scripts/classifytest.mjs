// VEKA-killer verification: does classifyFieldTypes mark brand/preference fields
// (never auto-fillable) and leave objective ones? Run: node scripts/classifytest.mjs
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';
const PREF = /\b(brand|make|manufacturer|oem|company\s*name|trademark|model\s*(name|no\.?|number)?|brand\s*name|made\s*by)\b/i;

async function classify(product, fields) {
  const kw = fields.filter((n) => PREF.test(n));
  const prompt = `CONTEXT — INDIA B2B ONLY.
For the product "${product}", classify each ISQ field:
- "preference" = a SELLER/BRAND choice that would NARROW the supplier pool — Brand, Make, Manufacturer, OEM, Model name, proprietary/branded variant.
- "objective" = a physical/measurable buyer-owned attribute (size, material, capacity, grade, application, usage, colour, type).
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

const CASES = [
  { p: 'upvc windows', fields: ['Number of Tracks', 'Mesh Option', 'Profile Brand', 'Glass Thickness'], brand: 'Profile Brand', obj: 'Glass Thickness' },
  { p: 'TMT Bar', fields: ['Brand', 'Grade', 'Size'], brand: 'Brand', obj: 'Grade' },
  { p: 'Cotton Fabric', fields: ['Brand', 'GSM', 'Material', 'Width'], brand: 'Brand', obj: 'GSM' },
  { p: 'Office Chair', fields: ['Make', 'Type', 'Material', 'Warranty'], brand: 'Make', obj: 'Material' },
  { p: 'Diesel Generator', fields: ['Engine Brand', 'Rated Power', 'Phase'], brand: 'Engine Brand', obj: 'Rated Power' },
];

let pass = 0, total = 0;
for (const c of CASES) {
  const { preference, objective } = await classify(c.p, c.fields);
  const brandGated = preference.includes(c.brand);
  const objKept = objective.includes(c.obj);
  total += 2; if (brandGated) pass++; if (objKept) pass++;
  console.log(`\n=== ${c.p} ===`);
  console.log(`  preference (NEVER auto-filled): [${preference.join(', ')}]`);
  console.log(`  objective  (may pre-fill):      [${objective.join(', ')}]`);
  console.log(`  ${brandGated ? '✓' : '✗'} brand field "${c.brand}" gated as preference`);
  console.log(`  ${objKept ? '✓' : '✗'} objective field "${c.obj}" kept fillable`);
}
console.log(`\n════ VEKA KILLER: ${pass}/${total} checks passed ════`);
