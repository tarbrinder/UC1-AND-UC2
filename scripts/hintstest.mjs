// Reproduce the "VEKA auto-detected" bug: does getSpecHints invent a BRAND
// from a product name that never mentioned one? Run: node scripts/hintstest.mjs
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';
const INDIA = 'CONTEXT — INDIA B2B ONLY. IndiaMART. ₹ lakh/crore.';

// Exact getSpecHints prompt shape.
const hints = (productName, isqSpecNames, withOpts) => `${INDIA}
You are a B2B product spec expert for IndiaMART.
Product: "${productName}"
ISQ fields: ${JSON.stringify(isqSpecNames)}
Fields with options: ${JSON.stringify(withOpts)}

Return ONLY JSON:
{
  "knownFromProductName": { "SpecName": "value clearly implied by product name" },
  "redundantISQSpecs": ["spec names not applicable for this product"],
  "isqHints": { "SpecName": "short helpful hint, max 8 words" }
}`;

const CASES = [
  { p: 'upvc windows', specs: { 'Number of Tracks': ['2 Track','3 Track','2.5 Track'], 'Mesh Option': ['With Mesh','Without Mesh'], 'Profile Brand': ['Kommerling','Fenesta','Prominence','VEKA','Simta','Aluplast','DIMEX','NCL','Jaymax','PSP'] } },
  { p: 'TMT Bar', specs: { 'Brand': ['TATA','JSW','SAIL','Vizag','Jindal'], 'Grade': ['Fe 500','Fe 500D','Fe 550'], 'Size': ['8mm','10mm','12mm','16mm'] } },
  { p: 'Cotton Fabric', specs: { 'Brand': ['Arvind','Vardhman','Raymond'], 'GSM': ['80','120','180'], 'Material': ['Cotton','Linen'] } },
  { p: 'Office Chair', specs: { 'Brand': ['Featherlite','Godrej','Nilkamal','Durian'], 'Type': ['Executive','Task','Visitor'], 'Material': ['Mesh','Leather','Fabric'] } },
];

const call = async (prompt) => {
  const r = await fetch(ENDPOINT, { method:'POST', headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'}, body: JSON.stringify({ model:'google/gemini-2.5-flash-lite', messages:[{role:'user',content:prompt}], response_format:{type:'json_object'}, max_tokens:600 }) });
  const d = await r.json(); try { return JSON.parse(d.choices[0].message.content); } catch { return { err: d.choices?.[0]?.message?.content }; }
};

for (const c of CASES) {
  const names = Object.keys(c.specs);
  const out = await call(hints(c.p, names, c.specs));
  const known = out.knownFromProductName || {};
  const brandFields = names.filter(n => /brand|make|manufacturer|oem|company/i.test(n));
  const brandLeak = brandFields.filter(b => known[b]);
  console.log(`\n=== ${c.p} ===`);
  console.log('  knownFromProductName:', JSON.stringify(known));
  if (brandLeak.length) console.log('  ⚠️  BRAND AUTO-DETECTED (bias!):', brandLeak.map(b=>`${b}=${known[b]}`).join(', '));
  else console.log('  ✓ no brand auto-detected');
}
