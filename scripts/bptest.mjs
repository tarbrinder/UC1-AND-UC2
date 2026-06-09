// Validate the buyer-profile derivation against a REAL webhook payload.
// Builds the same digest deriveEnrichment emits, then calls deriveBuyerProfile's
// prompt on the gateway. Run: node scripts/bptest.mjs /tmp/glid6732501.json
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';
const file = process.argv[2] || '/tmp/glid6732501.json';
const raw = JSON.parse(readFileSync(file, 'utf8'));
const pick = (k) => { for (const el of raw) if (el && k in el) { try { return JSON.parse(el[k]); } catch { return el[k]; } } };
const str = (v) => (v == null ? undefined : String(v).trim() || undefined);

const bp = pick('buyer_profile') || {};
const pns = pick('pns_data') || [];
const bl = pick('prev_bl_data') || [];
const wa = pick('whatsapp_data') || [];
const callSignals = [], applications = [], domains = new Set(), sq = new Set(), langs = new Set();
let persona;
for (const c of pns) {
  const ed = c.extracted_data || {}; const md = ed.metadata || {};
  const ev = md.call_type?.evidence;
  if (ev && !persona) persona = { type: ev.buyer_persona, scale: ev.quantity_scale, commercial: /commercial/i.test(ev.order_type||''), repeat: ev.repeat_buyer === true };
  const intent = md.buyer_intent || {};
  if (md.call_purpose || intent.intent_level) callSignals.push(`[${md.call_purpose||'call'}/${intent.intent_level||'?'}] ${(intent.narrative||'').slice(0,140)}`);
  if (md.primary_language) langs.add(md.primary_language);
  if (md.intended_application) applications.push(md.intended_application);
  (md.additional_details?.seller_queries||[]).forEach(q => q?.query && sq.add(q.query));
  for (const p of ed.products||[]) { const n = str(p?.most_specific_category?.name); if (n) domains.add(n); }
}
for (const b of bl) { const t = str(b?.ETO_OFR_TITLE); if (t) domains.add(t); }
const dom = [...domains];
const digest = [
  persona?.type ? `Persona evidence: ${persona.type}, scale ${persona.scale||'?'}, ${persona.commercial?'commercial':'order type ?'}, repeat=${persona.repeat}` : '',
  dom.length ? `Categories enquired (${dom.length} → ${dom.length>1?'MULTI-SKU':'single-SKU'}): ${dom.slice(0,12).join('; ')}` : '',
  applications.length ? `Applications: ${[...new Set(applications)].slice(0,6).join('; ')}` : '',
  wa.length ? `WhatsApp messages exchanged: ${wa.length}` : '',
  `Location: ${[str(bp.city),str(bp.state),str(bp.locality)].filter(Boolean).join(', ')} (profile location_preference code=${str(bp.location_preference)||'?'})`,
  langs.size ? `Languages: ${[...langs].join(', ')}` : '',
  sq.size ? `What sellers asked this buyer: ${[...sq].slice(0,8).join('; ')}` : '',
  callSignals.length ? `Recent call signals (purpose/intent → narrative):\n- ${callSignals.slice(0,8).join('\n- ')}` : '',
].filter(Boolean).join('\n');

console.log('=== DIGEST (B1 output) ===\n' + digest + '\n');

const INDIA = 'CONTEXT — INDIA B2B ONLY. IndiaMART. ₹ lakh/crore, never $.';
// EXACT prompt shipped in gemini.ts deriveBuyerProfile (full enum constraints).
const prompt = `${INDIA}
You are building a PERSISTENT buyer profile for an IndiaMART buyer from the signals below. These describe WHO THE BUYER IS (persists across requirements), NOT today's requirement. Deduce only what the evidence supports; be honest with confidence.
BUYER SIGNALS:
${digest}

Return ONLY JSON. For EACH field pick EXACTLY ONE value from its list — NEVER return the list itself or multiple values; omit a field entirely if there's no signal:
{
  "persona": "<one of: Industrial Buyer, Trader, Wholesaler, Retailer, Shopkeeper, Manufacturer, Business Buyer>",
  "maturity": "<one of: New Buyer, Existing Buyer, Repeat Buyer, Business Setup Phase, Execution Phase>",
  "sourcingStyle": "<one of: catalog_driven, spec_driven, brand_driven, application_driven>",
  "buyingPattern": "<one of: trial_first, bulk_first, inventory_builder, one_time_capex, repeat_procurement>",
  "decisionStyle": "<one of: Needs Guidance, Self Driven, Hybrid>",
  "infoSeeking": "<one of: Low, Medium, High>",
  "supplierPreference": "<one of: Manufacturer Preferred, Trader Preferred, No Preference>",
  "localityPreference": "<one of: Local Only, Regional, Pan India>",
  "engagement": "<one of: WhatsApp Friendly, Image Sharing Buyer, Call First Buyer, Low Response Buyer>",
  "responseSensitivity": "<one of: Low Tolerance For Delay, Patient, Unknown>",
  "multiSku": <true or false>,
  "summary": "<one concise line a seller would value>",
  "tags": ["<short>","<behaviour>","<tags>"],
  "confidence": <a number from 0 to 1>
}
Evidence cues: many WhatsApp messages → WhatsApp Friendly; asks for images/catalog → Image Sharing Buyer; wants factory visit / local area → Local Only; "waited, bought elsewhere" → Low Tolerance For Delay; >1 distinct category → multiSku true; machine/setup → Business Setup Phase / one_time_capex.`;

const res = await fetch(ENDPOINT, { method:'POST', headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'}, body: JSON.stringify({ model:'google/gemini-2.5-flash-lite', messages:[{role:'user',content:prompt}], response_format:{type:'json_object'}, max_tokens:700 }) });
const data = await res.json();
console.log('=== DERIVED BUYER PROFILE (B2 output) ===');
try { console.log(JSON.stringify(JSON.parse(data.choices[0].message.content), null, 2)); }
catch { console.log('PARSE ERROR', data.choices?.[0]?.message?.content); }
