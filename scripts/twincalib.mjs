// Phase 3 — Calibration Gate. Stress the Twin compiler on 5 edge cases and assert
// it behaves correctly (degrades, flags shifts, goes stale, resists hallucination).
// Fixtures are minimal raw payloads (real JS objects; pick() handles non-stringified).
// Run: node scripts/twincalib.mjs
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';
const NOW = '2026-06-04T12:00:00Z';

const str = (v) => (v == null ? undefined : String(v).trim() || undefined);
const cleanHtml = (s) => (s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined);
const parseDate = (d) => { if (!d) return NaN; const iso = Date.parse(d); if (!Number.isNaN(iso)) return iso; const m = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/); if (m) { const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase()); if (mon >= 0) return Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon, +m[1]); } return NaN; };

// Replicate deriveEnrichment's evidence-pool + counts from a raw payload.
function buildInputs(raw) {
  const pick = (k) => { for (const el of raw) if (el && k in el) { const v = el[k]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; } };
  const bp = pick('buyer_profile') || {}, pns = pick('pns_data') || [], isq = pick('prev_isq_data') || [], bl = pick('prev_bl_data') || [], wa = pick('whatsapp_data') || [], csl = pick('csl_data') || [];
  const signals = [], applications = [];
  const push = (source, date, signal) => { const t = (signal || '').trim(); if (t) signals.push({ source, date: date || '', signal: t.slice(0, 200) }); };
  const companyDesc = cleanHtml(str(bp.glusr_usr_company_desc) || str(bp.glusr_usr_sellinterest));
  if (companyDesc) push('profile', '', `Own business: ${companyDesc}`);
  if (bp.verified_business_buyer_flag) push('profile', '', 'Verified business buyer');
  if (str(bp.location_preference)) push('profile', '', `Location preference code ${str(bp.location_preference)}`);
  for (const call of pns) { const ed = call?.extracted_data || {}, md = ed.metadata || {}, intent = md.buyer_intent || {};
    push('pns', '', `${str(md.call_purpose) || 'call'} (${str(intent.intent_level) || '?'}): ${str(intent.narrative) || ''}`);
    (ed.lead_tag?.deal_blockers || []).forEach((b) => push('pns', '', `Deal blocker: ${b}`));
    if (str(md.intended_application)) { push('pns', '', `Stated application: ${str(md.intended_application)}`); applications.push(str(md.intended_application)); } }
  for (const b of bl) push('bl_history', String(str(b?.ETO_OFR_POSTDATE_ORIG) || ''), `Enquiry: ${str(b?.ETO_OFR_TITLE) || ''}`);
  for (const r of isq) push('isq', String(str(r?.post_date) || ''), `RFQ: ${str(r?.title) || ''}`);
  if (wa.length) push('whatsapp', String(str(wa[wa.length - 1]?.timestamp) || ''), `${wa.length} WhatsApp messages exchanged`);
  const counts = { pns_calls: pns.length, whatsapp_events: wa.length, bls_created: bl.length, csl_events: csl.length };
  const intentHistory = {}; for (const a of applications) intentHistory[a] = (intentHistory[a] || 0) + 1;
  const historicalCategories = [...new Set([...bl.map((b) => str(b?.ETO_OFR_TITLE)), ...pns.flatMap((c) => (c?.extracted_data?.products || []).map((p) => str(p?.most_specific_category?.name)))].filter(Boolean))];
  return { signals, counts, intentHistory, historicalCategories, companyDesc };
}

const sat = (n, k) => 1 - Math.exp(-n / k);
async function compile(raw) {
  const { signals, counts, intentHistory, historicalCategories, companyDesc } = buildInputs(raw);
  const overall = Math.round(100 * (0.35 * sat(counts.pns_calls, 3) + 0.25 * sat(counts.whatsapp_events, 30) + 0.25 * sat(counts.bls_created, 4) + 0.15 * sat(counts.csl_events, 20)));
  let lastT = -1, lastStr = ''; for (const s of signals) { const t = parseDate(s.date); if (!Number.isNaN(t) && t > lastT) { lastT = t; lastStr = s.date; } }
  const days = lastT > 0 ? (Date.parse(NOW) - lastT) / 86400000 : NaN;
  const freshness = Number.isNaN(days) ? 'Unknown' : days < 30 ? 'Fresh' : days < 90 ? 'Moderate' : 'Stale';
  if (!signals.length) return { overall, freshness, present: 0, unknowns: 11, shift: false, currentIntent: null, businessType: '', contradictions: 0 };
  const pool = signals.map((s, i) => `[${i}] (${s.source}${s.date ? ', ' + s.date : ''}) ${s.signal}`).join('\n');
  const prompt = `CONTEXT — INDIA B2B ONLY.
Compile a PERSISTENT BUYER TWIN. Use ONLY the SIGNALS as evidence; NEVER invent. Each trait { "value":<one allowed>, "confidence":0-100, "contradictions_count":0, "evidence":[{source,date,signal copied}] }; omit unsupported traits. NEVER infer brands.
COMPANY: ${companyDesc || '(none)'}
HISTORICAL CATEGORIES: ${historicalCategories.join('; ') || '(none)'}
SIGNALS:
${pool}
Return ONLY JSON: { "business_type":"<Manufacturer/Trader/Wholesaler/Retailer/Service Provider>", "behavioral":{ "whatsapp_affinity":{value:"<Low|Medium|High>",confidence,contradictions_count,evidence}, "catalog_driven":{value:"<true|false>",...}, "image_affinity":{...}, "local_preference":{...}, "response_sensitivity":{...}, "decision_style":{value:"<Needs Guidance|Self Driven|Comparison>",...} }, "commercial":{ "inventory_builder":{value:"<true|false>",...}, "multi_category_buyer":{...}, "bulk_orientation":{value:"<Low|Medium|High>",...}, "trial_first":{...}, "current_active_intent":{value:"<short intent>",confidence,contradictions_count,evidence} }, "recent_intent_clusters":[], "explicit_negative_signals":[], "attribution":{inferred_product_mapping:null,confidence:0}, "unknowns":[], "summary":"" }`;
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 2500 }) });
  let p; try { p = JSON.parse((await res.json()).choices[0].message.content); } catch { return { overall, freshness, present: -1, unknowns: 11, shift: false, currentIntent: null, businessType: '?' }; }
  const SRC = new Set(['pns', 'whatsapp', 'csl', 'bl_history', 'isq', 'profile']);
  const poolSig = signals.map((s) => s.signal);
  const grounded = (sig) => { const x = String(sig).trim(); return x.length >= 8 && poolSig.some((ps) => ps.includes(x.slice(0, 25)) || x.includes(ps.slice(0, 25))); };
  const ok = (t) => t && t.value !== undefined && Array.isArray(t.evidence) && t.evidence.some((e) => e && SRC.has(e.source) && grounded(e.signal));
  const bset = Object.entries(p.behavioral || {}).filter(([, v]) => ok(v)).map(([k]) => k);
  const cset = ['inventory_builder', 'multi_category_buyer', 'bulk_orientation', 'trial_first', 'current_active_intent'].filter((k) => ok((p.commercial || {})[k]));
  const present = bset.length + cset.length;
  const expected = ['whatsapp_affinity', 'catalog_driven', 'image_affinity', 'local_preference', 'response_sensitivity', 'decision_style', 'inventory_builder', 'multi_category_buyer', 'bulk_orientation', 'trial_first', 'current_active_intent'];
  const unknowns = expected.filter((k) => !bset.includes(k) && !cset.includes(k)).length;
  const descRole = (() => { const d = (companyDesc || '').toLowerCase(); if (/manufactur|we make|we produce|production of/.test(d)) return 'Manufacturer'; if (/wholesal|distribut/.test(d)) return 'Wholesaler'; if (/\btrad|reseller/.test(d)) return 'Trader'; if (/retail|boutique|store/.test(d)) return 'Retailer'; if (/service|consult|solution provider/.test(d)) return 'Service Provider'; return ''; })();
  const businessType = str(p.business_type) || descRole || 'Business Buyer';
  const currentIntent = ok((p.commercial || {}).current_active_intent) ? String(p.commercial.current_active_intent.value) : null;
  const desc = (companyDesc || '').toLowerCase();
  const nowText = [String(currentIntent || ''), businessType, ...Object.keys(intentHistory || {})].join(' ').toLowerCase();
  const histTrader = /\btrad|wholesal|distribut|reseller/.test(desc), histMfr = /manufactur|we make|we produce|production of/.test(desc);
  const nowMfr = /manufactur|setup|factory|machine|injection|moulding|production|tooling/.test(nowText), nowTrade = /resale|\btrad|retail|distribut|stock/.test(nowText);
  const shift = (histTrader && nowMfr) || (histMfr && nowTrade);
  const contradictions = [...Object.values(p.behavioral || {}), ...Object.values(p.commercial || {})]
    .filter(ok).reduce((a, t) => a + Math.max(0, Math.round(Number(t.contradictions_count) || 0)), 0);
  // Every intent the twin surfaced — active OR clustered. Used to assert that an
  // off-profile signal is REPRESENTED somewhere, not silently dropped.
  const recentIntents = Array.isArray(p.recent_intent_clusters)
    ? p.recent_intent_clusters.map((c) => String((c && (c.intent ?? c.value)) ?? c ?? '')).join(' | ')
    : '';
  return { overall, freshness, present, unknowns, shift, currentIntent, businessType, contradictions, recentIntents };
}

// ── 5 stress fixtures ──
const FIXTURES = {
  '1·BlankSlate (cold buyer)': [{ csl_data: [] }, { pns_data: [] }, { prev_bl_data: [] }, { whatsapp_data: [] }, { buyer_profile: { glid: 'COLD1', first_name: 'New', city: 'Pune', state: 'Maharashtra' } }],
  '2·Conflicting (Trader→Mfr)': [{ buyer_profile: { glid: 'CONF1', glusr_usr_company_desc: 'ABC Traders — wholesale trading and distribution of industrial hardware across India.', verified_business_buyer_flag: 4 } },
    { pns_data: [{ extracted_data: { metadata: { call_purpose: 'requirement', intended_application: 'Factory Setup', buyer_intent: { intent_level: 'High', narrative: 'The buyer is setting up a new manufacturing unit and needs machinery for the factory setup.' } } } }] },
    { prev_bl_data: [{ ETO_OFR_TITLE: 'Injection Moulding Machine', ETO_OFR_POSTDATE_ORIG: '15-MAY-26' }] }],
  '3·Stale (18 months old)': [{ buyer_profile: { glid: 'STALE1', glusr_usr_company_desc: 'Steel pipe trader.' } },
    { prev_bl_data: [{ ETO_OFR_TITLE: 'MS Steel Pipes', ETO_OFR_POSTDATE_ORIG: '10-DEC-24' }, { ETO_OFR_TITLE: 'GI Pipes', ETO_OFR_POSTDATE_ORIG: '05-JAN-25' }] },
    { pns_data: [{ extracted_data: { metadata: { call_purpose: 'requirement', buyer_intent: { intent_level: 'Medium', narrative: 'Buyer wants steel pipes for a construction project.' } } } }] }],
  '4·Sparse (1 WhatsApp msg)': [{ whatsapp_data: [{ sender: 'USER', message: '{"text":"price?"}', timestamp: '' }] }, { buyer_profile: { glid: 'SPARSE1', first_name: 'A' } }],
  '5·WrongSignal (Mfr→Karaoke)': [{ buyer_profile: { glid: 'WRONG1', glusr_usr_company_desc: 'XYZ Manufacturing — we manufacture industrial pumps and valves.', verified_business_buyer_flag: 4 } },
    { prev_bl_data: [{ ETO_OFR_TITLE: 'Karaoke Bluetooth Speaker', ETO_OFR_POSTDATE_ORIG: '28-MAY-26' }, { ETO_OFR_TITLE: 'Industrial Pump', ETO_OFR_POSTDATE_ORIG: '02-FEB-26' }] },
    { pns_data: [{ extracted_data: { metadata: { call_purpose: 'requirement', intended_application: 'Personal', buyer_intent: { intent_level: 'Medium', narrative: 'The buyer is asking about a karaoke bluetooth speaker for personal use.' } } } }] }],
  '6·ContradictoryLocality': [{ buyer_profile: { glid: 'CONTRA1', glusr_usr_company_desc: 'Reseller of building materials.', verified_business_buyer_flag: 4 } },
    { prev_bl_data: [{ ETO_OFR_TITLE: 'Cement', ETO_OFR_POSTDATE_ORIG: '20-MAY-26' }] },
    { pns_data: [
      { extracted_data: { metadata: { call_purpose: 'requirement', buyer_intent: { intent_level: 'High', narrative: 'The buyer insists on a LOCAL supplier in Pune only and wants to visit the shop personally before buying.' } } } },
      { extracted_data: { metadata: { call_purpose: 'requirement', buyer_intent: { intent_level: 'High', narrative: 'The buyer now says he is open to suppliers anywhere in India; pan-India shipping is completely fine for him.' } } } },
    ] }],
};

const CHECKS = {
  '1·BlankSlate (cold buyer)': (r) => [['confidence ≤ 15 (degrades)', r.overall <= 15], ['traits ≈ 0', r.present <= 1], ['unknowns ≥ 8 (planner has work)', r.unknowns >= 8], ['freshness Unknown', r.freshness === 'Unknown']],
  '2·Conflicting (Trader→Mfr)': (r) => [['profile shift FIRES', r.shift === true], ['confidence reasonable', r.overall >= 15]],
  '3·Stale (18 months old)': (r) => [['freshness Stale', r.freshness === 'Stale']],
  '4·Sparse (1 WhatsApp msg)': (r) => [['confidence ≤ 15 (no over-claim)', r.overall <= 15], ['few traits ≤ 3', r.present <= 3]],
  '5·WrongSignal (Mfr→Karaoke)': (r) => [['off-profile signal surfaced (active OR clustered, not dropped)', /audio|speaker|karaoke|personal|entertain/i.test(`${r.currentIntent || ''} ${r.recentIntents || ''}`)], ['business_type still Manufacturer', /manufactur/i.test(r.businessType)]],
  '6·ContradictoryLocality': (r) => [['contradiction detected (count > 0)', r.contradictions > 0]],
};

let passAll = 0, total = 0;
for (const [name, raw] of Object.entries(FIXTURES)) {
  const r = await compile(raw);
  console.log(`\n=== ${name} ===`);
  console.log(`  overall ${r.overall} · freshness ${r.freshness} · traits ${r.present} · unknowns ${r.unknowns} · shift ${r.shift} · contradictions ${r.contradictions} · business_type "${r.businessType}" · current_intent "${r.currentIntent}"`);
  for (const [label, ok] of CHECKS[name](r)) { total++; if (ok) passAll++; console.log(`    ${ok ? '✓' : '✗'} ${label}`); }
}
console.log(`\n════ CALIBRATION: ${passAll}/${total} checks passed ════`);
