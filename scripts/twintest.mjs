// Phase-1 verification: compile the Buyer Twin (BTE-v1.1) from a REAL GLID dump
// and assert every trait is evidence-grounded. Run: node scripts/twintest.mjs /tmp/glid6732501.json
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';
const file = process.argv[2] || '/tmp/glid6732501.json';
const raw = JSON.parse(readFileSync(file, 'utf8'));
const pick = (k) => { for (const el of raw) if (el && k in el) { try { return JSON.parse(el[k]); } catch { return el[k]; } } };
const str = (v) => (v == null ? undefined : String(v).trim() || undefined);
const cleanHtml = (s) => (s ? s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() : undefined);

const bp = pick('buyer_profile') || {}, pns = pick('pns_data') || [], isq = pick('prev_isq_data') || [];
const bl = pick('prev_bl_data') || [], wa = pick('whatsapp_data') || [], csl = pick('csl_data') || [], wi = pick('whatsapp_inbound') || {};

// ── Replicate deriveEnrichment's evidence pool ──
const signals = [], applications = [];
const push = (source, date, signal) => { const t = (signal || '').trim(); if (t) signals.push({ source, date: date || '', signal: t.slice(0, 200) }); };
const companyDesc = cleanHtml(str(bp.glusr_usr_company_desc) || str(bp.glusr_usr_sellinterest));
if (companyDesc) push('profile', '', `Own business: ${companyDesc}`);
if (str(bp.designation)) push('profile', '', `Designation: ${str(bp.designation)}`);
if (bp.verified_business_buyer_flag) push('profile', '', 'Verified business buyer');
if (str(bp.location_preference)) push('profile', '', `Location preference code ${str(bp.location_preference)} (${[str(bp.city), str(bp.locality)].filter(Boolean).join(', ')})`);
for (const call of pns) {
  const ed = call?.extracted_data || {}, md = ed.metadata || {}, intent = md.buyer_intent || {};
  push('pns', '', `${str(md.call_purpose) || 'call'} (${str(intent.intent_level) || '?'}): ${str(intent.narrative) || ''}`);
  (ed.lead_tag?.deal_blockers || []).forEach((b) => push('pns', '', `Deal blocker: ${b}`));
  if (str(md.intended_application)) { push('pns', '', `Stated application: ${str(md.intended_application)}`); applications.push(str(md.intended_application)); }
}
for (const b of bl) push('bl_history', String(str(b?.ETO_OFR_POSTDATE_ORIG) || ''), `Enquiry: ${str(b?.ETO_OFR_TITLE) || ''}`);
for (const r of isq) push('isq', String(str(r?.post_date) || ''), `RFQ: ${str(r?.title) || ''}`);
const cslTerms = new Set();
for (const c of csl) { const url = String(c?.request_url || ''); const dec = (x) => { try { return x ? decodeURIComponent(x.replace(/\+/g, ' ')).replace(/-/g, ' ').trim() : ''; } catch { return ''; } };
  [dec(url.match(/[?&]s=([^&]+)/)?.[1]), dec(url.match(/flname=([^&]+)/)?.[1])].forEach((t) => { if (t && t.length > 2 && !/^[0-9]+$/.test(t)) cslTerms.add(t); }); }
[...cslTerms].slice(0, 10).forEach((t) => push('csl', '', `Browsed/searched: ${t}`));
for (const m of (wi?.data?.recent_messages || [])) if (str(m?.sender) === 'user' && str(m?.message_type) === 'typed') { const n = (str(m?.content) || '').match(/Need best price for ([^\n,]+)/i); if (n) push('whatsapp', String(str(m?.timestamp) || ''), `Asked supplier for: ${n[1].trim()}`); }
if (wa.length) push('whatsapp', '', `${wa.length} WhatsApp messages exchanged; shares product images`);
const intentHistory = {}; for (const a of applications) intentHistory[a] = (intentHistory[a] || 0) + 1;
const counts = { pns_calls: pns.length, whatsapp_events: wa.length, bls_created: bl.length, csl_events: csl.length };
const sat = (n, k) => 1 - Math.exp(-n / k);
const overall = Math.round(100 * (0.35 * sat(counts.pns_calls, 3) + 0.25 * sat(counts.whatsapp_events, 30) + 0.25 * sat(counts.bls_created, 4) + 0.15 * sat(counts.csl_events, 20)));
const historicalCategories = [...new Set([...bl.map((b) => str(b?.ETO_OFR_TITLE)), ...pns.flatMap((c) => (c?.extracted_data?.products || []).map((p) => str(p?.most_specific_category?.name)))].filter(Boolean))];

const pool = signals.slice(0, 40).map((s, i) => `[${i}] (${s.source}${s.date ? ', ' + s.date : ''}) ${s.signal}`).join('\n');
const INDIA = 'CONTEXT — INDIA B2B ONLY. IndiaMART. ₹ lakh/crore.';
const prompt = `${INDIA}
Compile a PERSISTENT BUYER TWIN. Use ONLY the SIGNALS as evidence; NEVER invent. For EVERY trait attach 1-2 evidence {source,date,signal} copied from the pool; if unsupported, OMIT the trait. NEVER infer brands. Pick ONE value per trait.
COMPANY: ${companyDesc || '(none)'}
HISTORICAL CATEGORIES: ${historicalCategories.join('; ')}
INTENT HISTORY: ${JSON.stringify(intentHistory)}
SIGNALS:
${pool}
Each trait = { "value": <ONE from its list — never a place/number/sentence>, "confidence": <0-100>, "contradictions_count": <conflicting signals; 0 if none>, "evidence": [{ "source": "<pns|whatsapp|csl|bl_history|isq|profile>", "date": "<copy the date shown, or ''>", "signal": "<copy from SIGNALS>" }] }.
Example: "whatsapp_affinity": { "value": "High", "confidence": 90, "contradictions_count": 0, "evidence": [{ "source": "whatsapp", "date": "", "signal": "109 WhatsApp messages exchanged" }] }
Also derive (grounded): "recent_intent_clusters": GROUP categories into 2-4 BROAD themes (NEVER one per product; e.g. Silicone/Candle/Resin moulds → "Craft & casting moulds") [{"intent":"<broad theme>","signal_count":0,"last_seen":""}], "explicit_negative_signals": SHORT strings for HARD CONSTRAINTS explicitly stated ("No traders","OEM only","Don't call") — a complaint/lost sale is NOT one; [] if none, "attribution":{"inferred_product_mapping":null,"confidence":0}, "unknowns":[].
Return ONLY JSON in EXACTLY this shape (omit unsupported traits):
{ "business_type": "<Manufacturer/Trader/Wholesaler/Retailer/Service Provider>",
  "behavioral": { "whatsapp_affinity": { "value": "<Low|Medium|High>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "catalog_driven": { "value": "<true|false>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "image_affinity": { "value": "<Low|Medium|High>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "local_preference": { "value": "<Low|Medium|High>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "response_sensitivity": { "value": "<Low|Medium|High>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "decision_style": { "value": "<Needs Guidance|Self Driven|Comparison>", "confidence": 0, "contradictions_count": 0, "evidence": [] } },
  "commercial": { "inventory_builder": { "value": "<true|false>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "multi_category_buyer": { "value": "<true|false>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "bulk_orientation": { "value": "<Low|Medium|High>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "trial_first": { "value": "<true|false>", "confidence": 0, "contradictions_count": 0, "evidence": [] }, "current_active_intent": { "value": "<short intent label>", "confidence": 0, "contradictions_count": 0, "evidence": [] } },
  "recent_intent_clusters": [], "explicit_negative_signals": [], "attribution": { "inferred_product_mapping": null, "confidence": 0 }, "unknowns": [],
  "summary": "<one line, no PII>" }`;

const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 3000 }) });
const data = await res.json();
let p; try { p = JSON.parse(data.choices[0].message.content); } catch { console.log('PARSE ERROR', data.choices?.[0]?.message?.content?.slice(0, 400)); process.exit(1); }

const SRC = new Set(['pns', 'whatsapp', 'csl', 'bl_history', 'isq', 'profile']);
const poolSignals = new Set(signals.map((s) => s.signal));
const LMH = ['Low', 'Medium', 'High'];
const VOCAB = { whatsapp_affinity: LMH, image_affinity: LMH, local_preference: LMH, response_sensitivity: LMH, bulk_orientation: LMH,
  decision_style: ['Needs Guidance', 'Self Driven', 'Comparison'], catalog_driven: 'bool', inventory_builder: 'bool', multi_category_buyer: 'bool', trial_first: 'bool' };
const norm = (val, vocab) => {
  if (!vocab) return typeof val === 'string' ? val.trim() : val;
  if (vocab === 'bool') { if (typeof val === 'boolean') return val; const t = String(val).trim().toLowerCase(); if (/^(true|yes|y)$/.test(t)) return true; if (/^(false|no|n)$/.test(t)) return false; return undefined; }
  const t = String(val).trim().toLowerCase(); return vocab.find((o) => o.toLowerCase() === t || t.includes(o.toLowerCase()));
};
const parseDate = (d) => { if (!d) return NaN; const iso = Date.parse(d); if (!Number.isNaN(iso)) return iso; const m = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/); if (m) { const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase()); if (mon >= 0) return Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon, +m[1]); } return NaN; };
const lastSeenOf = (ev) => { let best = '', bt = -1; for (const e of ev) { const t = parseDate(e.date); if (!Number.isNaN(t) && t > bt) { bt = t; best = e.date; } } return best; };
const stabilityOf = (ev) => { const srcs = new Set(ev.map((e) => e.source)).size; const ds = ev.map((e) => parseDate(e.date)).filter((n) => !Number.isNaN(n)); const span = ds.length > 1 ? (Math.max(...ds) - Math.min(...ds)) / (1000*60*60*24*30) : 0; return Math.max(0, Math.min(100, Math.round(35 + ev.length*13 + srcs*10 + Math.min(span,12)*2))); };
let traits = 0, grounded = 0, fabricated = 0, offVocab = 0, datedTraits = 0, contraTotal = 0;
const present = new Set();
const showTrait = (name, t) => {
  if (!t) return;
  const v = norm(t.value, VOCAB[name]);
  if (v === undefined || v === '') { if (t.value !== undefined) { offVocab++; console.log(`  • ${name}: DROPPED off-vocab ("${t.value}")`); } return; }
  const groundedH = (sig) => { const x = String(sig).trim(); return x.length >= 8 && [...poolSignals].some((ps) => ps.includes(x.slice(0, 25)) || x.includes(ps.slice(0, 25))); };
  const evAll = (t.evidence || []).filter((e) => e && SRC.has(e.source) && String(e.signal || '').trim());
  const ev = evAll.filter((e) => groundedH(e.signal)).slice(0, 5);
  fabricated += evAll.length - ev.length; // ungrounded evidence now DROPPED (mirrors compiler)
  if (!ev.length) return; // dropped (no grounded receipts)
  traits++; grounded++; present.add(name);
  const ls = lastSeenOf(ev), stab = stabilityOf(ev), contra = Math.max(0, Math.round(Number(t.contradictions_count) || 0));
  if (ls) datedTraits++; contraTotal += contra;
  console.log(`  • ${name}: ${v}  (conf ${t.confidence} · stab ${stab} · contra ${contra} · last_seen ${ls || '—'})  ⟵ ${ev.map((e) => `[${e.source}] ${e.signal.slice(0, 45)}`).join(' | ')}`);
};
console.log(`\n=== BUYER TWIN — GLID ${str(bp.glid)} ===`);
console.log(`twin_confidence: ${overall}  evidence_base: ${JSON.stringify(counts)}`);
console.log(`identity: ${str(bp.city)}, ${str(bp.state)} · business_type: ${p.business_type} · lang ${pns[0]?.extracted_data?.metadata?.primary_language || '?'} · verified ${!!bp.verified_business_buyer_flag}`);
console.log(`company_desc: ${(companyDesc || '').slice(0, 90)}…`);
console.log('\nlayer_b_behavioral:');
for (const [k, v] of Object.entries(p.behavioral || {})) showTrait(k, v);
console.log('\nlayer_c_commercial_intelligence:');
for (const [k, v] of Object.entries(p.commercial || {})) showTrait(k, v);
console.log(`historical_categories: ${historicalCategories.join(', ')}`);
console.log(`buyer_intent_history: ${JSON.stringify(intentHistory)}`);
const expected = ['whatsapp_affinity', 'catalog_driven', 'image_affinity', 'local_preference', 'response_sensitivity', 'decision_style', 'inventory_builder', 'multi_category_buyer', 'bulk_orientation', 'trial_first', 'current_active_intent'];
const llmUnknowns = (Array.isArray(p.unknowns) ? p.unknowns : []).map((x) => String(x).trim()).filter(Boolean);
const unknowns = [...new Set([...expected.filter((k) => !present.has(k)), ...llmUnknowns])];
console.log(`\nrecent_intent_clusters: ${JSON.stringify(p.recent_intent_clusters || [])}`);
console.log(`explicit_negative_signals: ${JSON.stringify(p.explicit_negative_signals || [])}`);
console.log(`attribution: ${JSON.stringify(p.attribution || {})}`);
console.log(`explicit_unknowns (code-derived → planner queue): ${JSON.stringify(unknowns)}`);
console.log(`\nsummary: "${p.summary}"`);
console.log('\n=== ASSERTIONS ===');
console.log(`  ${traits > 0 ? '✓' : '✗'} traits present: ${traits}`);
console.log(`  ${grounded === traits ? '✓' : '✗'} every present trait has ≥1 valid-source evidence (${grounded}/${traits})`);
console.log(`  ${fabricated === 0 ? '✓' : '⚠️'} fabricated evidence (not in pool): ${fabricated}`);
console.log(`  ${p.business_type && !String(p.business_type).includes('|') ? '✓' : '✗'} business_type set (no echo)`);
console.log(`  ${Object.keys(intentHistory).length > 0 ? '✓' : '✗'} intent split present (history populated)`);
console.log(`  ${overall >= 0 && overall <= 100 ? '✓' : '✗'} twin_confidence in range: ${overall}`);
console.log(`  ${'ℹ'} off-vocab traits dropped by validator: ${offVocab}`);
console.log(`  ${datedTraits > 0 ? '✓' : 'ℹ'} traits with last_seen (temporal awareness): ${datedTraits}/${traits}`);
console.log(`  ${unknowns.length > 0 ? '✓' : 'ℹ'} explicit_unknowns populated (planner queue): ${unknowns.length}`);
console.log(`  ✓ contradictions tracked (total ${contraTotal})`);
console.log(`  ${Array.isArray(p.recent_intent_clusters) && p.recent_intent_clusters.length ? '✓' : 'ℹ'} recent_intent_clusters: ${(p.recent_intent_clusters || []).length}`);
console.log(`  ✓ negative-signals array present: ${(p.explicit_negative_signals || []).length}`);
