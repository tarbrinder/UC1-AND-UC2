// Deterministic test for the CONVERSATIONAL SIGNAL EXTRACTOR — mirrors src/lib/conversationalSignals.ts.
// Fixtures are the REAL live WhatsApp turns from glid 68151813 (Amit), the data the user pasted.
// The buyer's own words are the gold: location want/reject, supply issue, qty/spec, engagement.
// Hinglish + English. NO category literals. NO LLM, NO network.

const STOP = new Set(['me','mein','m','se','ka','ki','ko','toh','to','the','a','an','sir','madam','ji','plz','please','i','we','is','in','at','of','for','and']);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function waText(row) {
  const isUser = String(row?.sender || '').toUpperCase() === 'USER';
  let text = '', isPhoto = false;
  try { const p = JSON.parse(String(row?.message ?? '')); text = p.text || p.title || p.caption || ''; if (!text && typeof p.callbackPayload === 'string' && !p.callbackPayload.startsWith('{')) text = p.callbackPayload; if (p.mimeType && String(p.mimeType).startsWith('image')) isPhoto = true; } catch { text = String(row?.message ?? ''); }
  return { text: String(text || '').trim(), isUser, isPhoto };
}
function placeBefore(text, cueRe) {
  const m = text.match(cueRe); if (!m) return null;
  const before = text.slice(0, m.index).trim().split(/\s+/);
  for (let i = before.length - 1; i >= 0; i--) { const w = before[i].toLowerCase().replace(/[^a-z]/g, ''); if (w && !STOP.has(w) && w.length >= 3) return w; }
  return null;
}
const WANT_CUE = /\b(?:me|mein|m)\s+chah|chahiye|chahe|chaiye|chahta|chahye/i;
const EN_LOC_CUE = /\b(?:from|near)\s+([a-z]{3,})\b/i;
const WANT_CONTEXT = /\b(want|need|chahiye|chahe|prefer|supplier|sellers?|only|sirf)\b/i;
const REJECT_CUE = /\bwale?\b/i;
const SUPPLY_RE = /available\s*nahi|not\s*available|out\s*of\s*stock|stock\s*nahi|nahi\s*mila|maal\s*nahi|product\s*nahi/i;
const URGENT_RE = /\burgent|jaldi|asap|turant|abhi\s*chahiye|emergency|aaj\s*hi|today\s*itself|immediately\b/i;
const BUDGET_RE = /\bsasta|sasti|budget|kam\s*rate|rate\s*kam|low\s*price|cheap|tight|kam\s*paise|economical\b/i;
const PAY_RE = /\bcash|advance|udhaar|udhar|credit|cod\b|online\s*payment|neft|upi\b/i;
const QTY_RANGE_RE = /\b(\d{1,6}(?:\.\d+)?\s*[-–]\s*\d{1,6}(?:\.\d+)?)\b/;
const QTY_UNIT_RE = /\b(\d{1,6}(?:\.\d+)?)\s*(kg|kgs|ton|tonne|tons|pcs|piece|pieces|nos|units?|sets?|meter|metre|mtr|box(?:es)?|litre|liter|ltr)\b/i;
const SPEC_RE = /\b(\d{1,6}(?:\.\d+)?)\s*(kva|kw|hp|gsm|mm|cm|inch|"|ft|feet|volt|v|amp|amps|watt|w|bar|psi|micron|gauge)\b/i;
const SPEC_DECIMAL_WT = /\b(\d+\.\d+)\s*(kg|kgs|ton|tonne|litre|liter|ltr|ml|gram|grams)\b/i;

function extractConversationalSignals(waData, pnsHints) {
  const rows = Array.isArray(waData) ? waData : [];
  const signals = [];
  const push = (kind, value, evidence, confidence, ts) => { if (!value) return; signals.push({ kind, value, evidence: String(evidence).slice(0, 140), confidence, ts }); };
  let declineCount = 0, hasPhoto = false;
  const scanText = (text, ts, fromUser) => {
    if (!text) return; const low = text.toLowerCase();
    if (fromUser) {
      const want = placeBefore(low, WANT_CUE); if (want) push('location_preference', want, text, 80, ts);
      else if (WANT_CONTEXT.test(low)) { const em = low.match(EN_LOC_CUE); if (em && em[1] && !STOP.has(em[1])) push('location_preference', em[1], text, 75, ts); }
      const rej = REJECT_CUE.test(low) ? placeBefore(low, REJECT_CUE) : null;
      if (rej && /(phone|call|kar\s*rahe|sab|saare|sare)/i.test(low)) push('location_reject', rej, text, 70, ts);
      if (SUPPLY_RE.test(low)) push('supply_issue', 'prior seller unavailable / no stock', text, 70, ts);
      if (URGENT_RE.test(low)) push('urgency', 'buyer signalled urgency', text, 65, ts);
      if (BUDGET_RE.test(low)) push('budget_sensitive', 'price/budget sensitivity', text, 60, ts);
      if (PAY_RE.test(low)) { const mm = low.match(PAY_RE); push('payment_pref', mm ? mm[0] : 'payment terms', text, 60, ts); }
      const spec = text.match(SPEC_RE) || text.match(SPEC_DECIMAL_WT); if (spec) push('spec_hint', spec[0].trim(), text, 70, ts);
      const range = text.match(QTY_RANGE_RE); const unit = text.match(QTY_UNIT_RE);
      if (range) push('quantity_hint', range[1].replace(/\s+/g, ''), text, 65, ts); else if (unit && !SPEC_DECIMAL_WT.test(text)) push('quantity_hint', unit[0].trim(), text, 65, ts);
      if (/^(no|stop|nahi|cancel)\b/i.test(low)) declineCount++;
    }
  };
  for (const row of rows) { const { text, isUser, isPhoto } = waText(row); if (isPhoto && isUser) { hasPhoto = true; push('photo_shared', 'buyer shared a photo', '[image]', 55, row.timestamp); } scanText(text, row.timestamp, isUser); }
  for (const h of pnsHints || []) scanText(String(h || ''), undefined, true);
  if (declineCount >= 2) push('low_engagement', `${declineCount} callback declines`, 'repeated "No"', Math.min(50 + declineCount * 8, 85));
  const prefs = signals.filter((s) => s.kind === 'location_preference').sort((a, b) => b.confidence - a.confidence);
  const locationPreference = prefs.length ? prefs[0].value : null;
  const locationPreferenceConfidence = prefs.length ? prefs[0].confidence : null;
  const rejectedLocations = [...new Set(signals.filter((s) => s.kind === 'location_reject').map((s) => s.value))].filter((r) => norm(r) !== norm(locationPreference || ''));
  const engagement = declineCount >= 3 || signals.some((s) => s.kind === 'supply_issue') ? 'cold' : (hasPhoto || signals.some((s) => s.kind === 'quantity_hint' || s.kind === 'spec_hint')) ? 'warm' : 'neutral';
  return { signals, locationPreference, locationPreferenceConfidence, rejectedLocations, engagement, declineCount, hasPhoto };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const mk = (sender, obj, ts) => ({ sender, message: JSON.stringify(obj), timestamp: ts });

// ── THE LIVE FIXTURE — Amit's exact WhatsApp turns (glid 68151813) ──
const live = [
  mk('USER', { callbackPayload: 'Yes', text: 'Yes' }, '2025-11-04T13:29:34Z'),
  mk('USER', { id: 'Config#...#22.5 Kg', title: '22.5 Kg' }, '2025-11-04T13:29:49Z'),
  mk('USER', { text: '100-200' }, '2025-11-04T13:30:08Z'),
  mk('USER', { mimeType: 'image/jpeg', url: 'https://x/y.jpg' }, '2025-11-04T13:30:28Z'),
  mk('USER', { text: 'Phone toh aaya but available nahi hai' }, '2025-11-05T11:09:52Z'),
  mk('USER', { text: 'Sir mujhe toh lucknow me chahe' }, '2025-11-05T11:10:39Z'),
  mk('USER', { text: 'Saare dilli wale phone kar rahe hain' }, '2025-11-05T11:10:48Z'),
  mk('API', { text: 'As per your request, sellers of *Eicher Tafe Tractor* in *Noida*.' }, '2026-06-05T11:21:41Z'),
  mk('USER', { callbackPayload: '{"id":"x"}', text: 'No' }, '2026-06-06T10:41:03Z'),
  mk('USER', { callbackPayload: '{"id":"y"}', text: 'No' }, '2026-06-06T10:41:06Z'),
  mk('USER', { callbackPayload: '{"id":"z"}', text: 'No' }, '2026-06-12T09:48:55Z'),
  mk('USER', { callbackPayload: '{"id":"w"}', text: 'No' }, '2026-06-13T12:04:49Z'),
];
const r = extractConversationalSignals(live);
const has = (kind, val) => r.signals.some((s) => s.kind === kind && (val === undefined || norm(s.value) === norm(val)));

// ════ THE HEADLINE: location preference vs profile city ════
ok('LOCATION WANT: "lucknow me chahe" → location_preference = lucknow', r.locationPreference === 'lucknow');
ok('LOCATION WANT: confidence surfaced (80) → chip band (≥70)', r.locationPreferenceConfidence === 80);
ok('LOCATION REJECT: "dilli wale phone kar rahe" → rejects dilli', r.rejectedLocations.includes('dilli'));
ok('reject ≠ preference (never reject what you want)', !r.rejectedLocations.includes('lucknow'));

// ── the other live signals ──
ok('SUPPLY: "available nahi hai" → supply_issue', has('supply_issue'));
ok('SPEC: "22.5 Kg" → spec_hint (kg unit)', has('spec_hint', '22.5 kg') || r.signals.some((s)=>s.kind==='spec_hint'&&/22\.5/.test(s.value)));
ok('QTY: "100-200" → quantity_hint range', has('quantity_hint', '100-200'));
ok('PHOTO: image turn → photo_shared + hasPhoto', has('photo_shared') && r.hasPhoto === true);
ok('ENGAGEMENT: 4 "No" + supply issue → cold', r.engagement === 'cold');
ok('DECLINES: counts the four "No" callbacks', r.declineCount === 4);

// ── API templates are CONTEXT, not buyer intent: "in *Noida*" must NOT become a preference ──
ok('API template "in Noida" is NOT read as the buyer wanting Noida', r.locationPreference !== 'noida');

// ── generic English variants (no category literals, no hardcoded cities) ──
const eng = extractConversationalSignals([
  mk('USER', { text: 'I want suppliers from Kanpur only' }, 't1'),
  mk('USER', { text: 'budget is tight, need low price' }, 't2'),
  mk('USER', { text: 'urgent requirement, need it today itself' }, 't3'),
  mk('USER', { text: 'payment will be cash' }, 't4'),
  mk('USER', { text: '5 kVA generator' }, 't5'),
]);
ok('EN want: "from Kanpur" → location_preference kanpur', eng.locationPreference === 'kanpur');
ok('EN budget: "tight, low price" → budget_sensitive', eng.signals.some((s) => s.kind === 'budget_sensitive'));
ok('EN urgency: "today itself" → urgency', eng.signals.some((s) => s.kind === 'urgency'));
ok('EN payment: "cash" → payment_pref', eng.signals.some((s) => s.kind === 'payment_pref' && /cash/.test(s.value)));
ok('EN spec: "5 kVA" → spec_hint', eng.signals.some((s) => s.kind === 'spec_hint' && /kva/i.test(s.value)));

// ── PNS hints (the other goldmine) also feed the extractor ──
const pns = extractConversationalSignals([], ['raw material for notebook manufacturing, 54 GSM, 0.5-1 ton recurring']);
ok('PNS: "54 GSM" → spec_hint from a PNS hint', pns.signals.some((s) => s.kind === 'spec_hint' && /gsm/i.test(s.value)));
ok('PNS: "0.5-1 ton" → quantity_hint', pns.signals.some((s) => s.kind === 'quantity_hint'));

// ── degrade gracefully ──
ok('no WA data → empty result, no crash', (() => { const z = extractConversationalSignals(null); return z.signals.length === 0 && z.locationPreference === null && z.engagement === 'neutral'; })());
ok('only API templates → no buyer signals', (() => { const z = extractConversationalSignals([mk('API', { text: 'Reply YES to confirm' }, 't')]); return z.signals.length === 0; })());
ok('junk message JSON → no crash', (() => { const z = extractConversationalSignals([{ sender: 'USER', message: 'not json at all', timestamp: 't' }]); return Array.isArray(z.signals); })());

console.log(`\nconvsignaltest (location want/reject vs profile · supply · qty/spec · engagement · Hinglish+EN · PNS · graceful — live Amit fixtures): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
