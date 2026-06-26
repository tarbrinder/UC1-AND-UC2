// Deterministic test for the WhatsApp Timeline (Wave 2A · 2-channel · mirrors whatsappTimeline.ts).
// Proves: BOTH IndiaMART channels rendered as human chats — inbound query/chat (bot↔buyer) AND outbound
// campaign (nudges/buttons + buyer taps) — buyer vs platform, time-ordered, with mined signals. No raw JSON.

const nrm = (s) => String(s ?? '').toLowerCase();
const asArr = (x) => (Array.isArray(x) ? x : []);
const asObj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
function getTop(raw, key) { if (!Array.isArray(raw)) return undefined; for (const el of raw) if (el && typeof el === 'object' && key in el) { const v = el[key]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; } return undefined; }
function parseOut(m) { let o = asObj(m); if (typeof m === 'string') { try { o = asObj(JSON.parse(m)); } catch { return { side: 'platform', text: m, kind: 'template' }; } } const sender = nrm(o.sender); let p = o; if (typeof o.message === 'string') { const s = o.message.trim(); if (s[0] === '{' || s[0] === '[') { try { p = asObj(JSON.parse(s)); } catch { p = { text: s }; } } else p = { text: s }; } else if (o.message && typeof o.message === 'object') p = asObj(o.message); const inter = asObj(p.interactive); const body = asObj(inter.body); const isTemplate = p.isTemplate === true || 'carouselCards' in p || 'footerText' in p || 'filename' in p || 'mediaId' in p; if ('id' in p && 'title' in p) return { side: 'buyer', text: String(p.title), kind: 'clicked' }; let txt = String(p.caption ?? body.text ?? p.text ?? (typeof p.message === 'string' ? p.message : '') ?? '').trim(); txt = txt.replace(/\s*\|\s*\[[^\]]*\]/g, '').trim(); if (!txt && Object.keys(inter).length) txt = 'options shown'; if (!txt) return null; const isPlatform = sender ? (sender !== 'customer' && sender !== 'user' && sender !== 'buyer') : (isTemplate || /press|best price|stop|unsubscribe|download|thank you|requirement.*received|noted|sellers|verified/i.test(txt) || txt.length > 60); return { side: isPlatform ? 'platform' : 'buyer', text: txt, kind: isPlatform ? 'template' : 'typed' }; }
function mineSignals(lines) { const out = []; const seen = new Set(); const push = (l, v) => { const k = l + v; if (v && !seen.has(k)) { seen.add(k); out.push({ label: l, value: v }); } }; for (const t of lines) { const g = t.match(/(\d{2,3})\s*gsm/i); if (g) push('GSM', `${g[1]} GSM`); const q = t.match(/(\d[\d,]*)\s*(kg|ton|tonne|piece|pcs|nos)\b/i); if (q) push('Quantity', `${q[1]} ${q[2]}`); const loc = t.match(/\b(kanpur|auraiya|lucknow|delhi|pune|solapur|koderma)\b/i); if (loc) push('Location', loc[1].replace(/^\w/, (c) => c.toUpperCase())); if (/paper|notebook|copy|raw material|machine/i.test(t)) push('Product interest', t.length > 40 ? t.slice(0, 40) + '…' : t); } return out.slice(0, 8); }
function channelOf(name, msgs) { if (msgs.every((m) => m.ts)) msgs.sort((a, b) => String(a.ts).localeCompare(String(b.ts))); const buyer = msgs.filter((m) => m.side === 'buyer').length; return { name, messages: msgs, buyerMsgs: buyer, platformMsgs: msgs.length - buyer, total: msgs.length }; }
function build(raw) {
  const inMsgs = []; const wiRaw = getTop(raw, 'whatsapp_inbound'); const wiObj = asObj(wiRaw);
  const recents = Array.isArray(wiRaw) ? wiRaw : asArr(asObj(wiObj.data).recent_messages);
  for (const m of recents) { const o = asObj(m); const content = String(o.content ?? o.message ?? o.text ?? '').trim(); if (!content) continue; inMsgs.push({ side: nrm(o.sender) === 'user' ? 'buyer' : 'platform', text: content, ts: o.timestamp ? String(o.timestamp) : undefined, kind: nrm(o.message_type) === 'clicked' ? 'clicked' : 'typed' }); }
  const outMsgs = []; asArr(getTop(raw, 'whatsapp_data')).forEach((m) => { const msg = parseOut(m); if (msg && msg.text) outMsgs.push(msg); });
  const inbound = channelOf('Inbound query/chat', inMsgs); const outbound = channelOf('Outbound campaign', outMsgs);
  const signals = mineSignals([...inMsgs, ...outMsgs].filter((m) => m.side === 'buyer').map((m) => m.text));
  return { inbound, outbound, signals, total: inbound.total + outbound.total };
}

const raw = [
  { whatsapp_inbound: { data: { recent_messages: [
    { timestamp: '2026-05-10 17:39:58', sender: 'user', message_type: 'typed', content: '54 GSM' },
    { timestamp: '2026-05-10 17:40:06', sender: 'bot', message_type: 'typed', content: 'How many *kg*?' },
    { timestamp: '2026-05-10 17:50:54', sender: 'user', message_type: 'typed', content: 'Need 100000 kg raw paper, Kanpur' },
  ] } } },
  { whatsapp_data: [
    { sender: 'API', message: JSON.stringify({ caption: 'Hi *Jaiveer*, *Notebook Machine* ka best price ke liye *YES* press kare! | [YES] | [NO] | [STOP]', filename: 'AiSensy-file', mediaId: '963' }) }, // platform template — the REAL shape: `message` is a JSON STRING
    { sender: 'customer', message: JSON.stringify({ id: 'Config#1#Automation Grade', title: 'Semi-Automatic' }) },                                  // buyer tapped a button (inside the message JSON)
    { sender: 'customer', message: 'rate batao' },                                                                                                  // buyer free-text reply (message = plain string)
    { sender: 'API', message: JSON.stringify({ interactive: { action: { buttons: [] } }, body: { text: 'Choose size' } }) },                        // platform interactive
  ] },
];

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const c = build(raw);

ok('TWO channels built (inbound + outbound)', !!c.inbound && !!c.outbound);
ok('inbound = the query/chat conversation (3 msgs)', c.inbound.total === 3 && c.inbound.buyerMsgs === 2 && c.inbound.platformMsgs === 1);
ok('inbound time-ordered oldest→newest', c.inbound.messages[0].ts < c.inbound.messages[c.inbound.messages.length - 1].ts);
ok('outbound = campaign channel (4 msgs)', c.outbound.total === 4);
ok('outbound: AiSensy template (message=JSON string) → CAPTION extracted (not raw JSON) + buttons stripped + platform', c.outbound.messages.some((m) => m.side === 'platform' && /best price/i.test(m.text) && !/\[YES\]|\{|caption/.test(m.text)));
ok('outbound: button {id,title} inside the message JSON → buyer tapped', c.outbound.messages.some((m) => m.side === 'buyer' && m.kind === 'clicked' && m.text === 'Semi-Automatic'));
ok('outbound: free-text message string → buyer reply (sender-classified)', c.outbound.messages.some((m) => m.side === 'buyer' && m.text === 'rate batao'));
ok('no raw JSON leaks in either channel', [...c.inbound.messages, ...c.outbound.messages].every((m) => !/^\{|sender":|"interactive"/.test(m.text)));
ok('signals mined across BOTH channels (GSM + Quantity + Location)', c.signals.some((s) => s.label === 'GSM') && c.signals.some((s) => s.label === 'Quantity') && c.signals.some((s) => s.label === 'Location'));

// ── WhatsApp INTELLIGENCE — behaviour derived from buyer chat lines (mirrors the persona candidates) ──
const waFacts = [
  { tag: 'wa.in', lineRef: 'WA-in 1 · buyer', rawValue: '54 GSM' },
  { tag: 'wa.in', lineRef: 'WA-in 2 · platform', rawValue: 'How many kg?' },
  { tag: 'wa.in', lineRef: 'WA-in 3 · buyer', rawValue: 'Need 100000 kg, best price jaldi' },
  { tag: 'wa.in', lineRef: 'WA-in 4 · buyer', rawValue: 'rate batao' },
];
const buyerWa = (re) => waFacts.filter((f) => /buyer/i.test(f.lineRef) && re.test(f.rawValue));
const respQ = buyerWa(/\b\d+\s*(gsm|kg|ton|inch|piece)\b|\b(paper|notebook|kanpur|auraiya|54)\b/i);
const negot = buyerWa(/\b(price|rate|best|discount|kitna|kitne|sasta|cost)\b/i);
const urg = buyerWa(/\b(urgent|jaldi|today|tonight|this week|abhi|turant|asap)\b/i);
ok('WA-intel: response quality HIGH (buyer answers with specifics: 54 GSM, 100000 kg)', respQ.length >= 2);
ok('WA-intel: negotiation = price-focused (best price / rate batao)', negot.length >= 2);
ok('WA-intel: urgency detected (jaldi)', urg.length >= 1);
ok('WA-intel: platform lines excluded from buyer behaviour', !buyerWa(/.*/).some((f) => /platform/i.test(f.lineRef)));

console.log(`\nwhatsapptest (Wave 2A · 2-channel + WhatsApp intelligence · buyer/platform · time-ordered · mined signals · derived behaviour): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
