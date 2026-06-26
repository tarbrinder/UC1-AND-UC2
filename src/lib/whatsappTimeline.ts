// ─── WHATSAPP TIMELINE (Wave 2A + 2-channel) — raw webhook JSON → TWO human conversations ──────────────
// IndiaMART runs TWO WhatsApp channels: an INBOUND query/chat channel (whatsapp_inbound — bot ↔ buyer
// conversation) and an OUTBOUND campaign channel (whatsapp_data — AiSensy nudges, buttons, templates +
// the buyer's taps/replies). Both are detailed as chats (platform left · buyer right, time-ordered) and
// the buyer-typed lines across BOTH are mined for stated signals. PURE · deterministic · no LLM.
// Harnessed in scripts/whatsapptest.mjs.

const nrm = (s: unknown) => String(s ?? '').toLowerCase();
function getTop(raw: unknown, key: string): unknown {
  if (!Array.isArray(raw)) return undefined;
  for (const el of raw as Array<Record<string, unknown>>) if (el && typeof el === 'object' && key in el) { const v = el[key]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; }
  return undefined;
}
const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});

export interface WAMsg { side: 'buyer' | 'platform'; text: string; ts?: string; kind: 'typed' | 'clicked' | 'template' | 'enquiry' }
export interface WASignal { label: string; value: string }
export interface WAChannel { name: string; messages: WAMsg[]; buyerMsgs: number; platformMsgs: number; total: number }
export interface WAMeta { counts?: Record<string, number>; buttonTaps?: string[]; productsEnquired?: string[] }
export interface WAConversation { inbound: WAChannel; outbound: WAChannel; signals: WASignal[]; total: number; meta?: WAMeta }

// classify + read an OUTBOUND blob (campaign channel): templates/captions/interactive = platform send;
// short free-text & button-taps ({id,title}) = the buyer replying/tapping.
function parseOut(m: unknown): WAMsg | null {
  let o: Record<string, unknown> = asObj(m);
  if (typeof m === 'string') { try { o = asObj(JSON.parse(m)); } catch { return { side: 'platform', text: m, kind: 'template' }; } }
  const sender = nrm(o.sender);
  // THE real shape: AiSensy outbound items are { sender, message, timestamp } where `message` is itself a JSON
  // STRING (the template payload: {caption, filename, mediaId, …} or {id, title}). Unwrap it so we read the
  // caption, not the raw JSON blob (the previous code dropped/leaked these → "outbound: no messages").
  let p: Record<string, unknown> = o;
  if (typeof o.message === 'string') { const s = (o.message as string).trim(); if (s[0] === '{' || s[0] === '[') { try { p = asObj(JSON.parse(s)); } catch { p = { text: s }; } } else p = { text: s }; }
  else if (o.message && typeof o.message === 'object') p = asObj(o.message);
  const inter = asObj(p.interactive); const body = asObj(inter.body);
  const isTemplate = p.isTemplate === true || 'carouselCards' in p || 'footerText' in p || 'filename' in p || 'mediaId' in p;
  if ('id' in p && 'title' in p) return { side: 'buyer', text: String(p.title), kind: 'clicked' };          // a button the buyer tapped
  let txt = String(p.caption ?? body.text ?? p.text ?? (typeof p.message === 'string' ? p.message : '') ?? '').trim();
  txt = txt.replace(/\s*\|\s*\[[^\]]*\]/g, '').trim();                                                       // strip AiSensy quick-reply suffix " | [YES] | [NO] | [STOP]"
  if (!txt && Object.keys(inter).length) txt = 'options shown';
  if (!txt) return null;
  // explicit sender wins ('API'/'bot' = platform · 'customer'/'user' = buyer); else the content heuristic.
  const isPlatform = sender ? (sender !== 'customer' && sender !== 'user' && sender !== 'buyer')
    : (isTemplate || /press|best price|stop|unsubscribe|download|thank you|requirement.*received|noted|sellers|verified/i.test(txt) || txt.length > 60);
  return { side: isPlatform ? 'platform' : 'buyer', text: txt, kind: isPlatform ? 'template' : 'typed' };
}

function mineSignals(buyerLines: string[]): WASignal[] {
  const out: WASignal[] = []; const seen = new Set<string>();
  const push = (label: string, value: string) => { const k = label + value; if (value && !seen.has(k)) { seen.add(k); out.push({ label, value }); } };
  for (const t of buyerLines) {
    const gsm = t.match(/(\d{2,3})\s*gsm/i); if (gsm) push('GSM', `${gsm[1]} GSM`);
    const qty = t.match(/(\d[\d,]*)\s*(kg|ton|tonne|piece|pcs|nos)\b/i); if (qty) push('Quantity', `${qty[1]} ${qty[2]}`);
    // NO HARDCODING (owner, absolute): detect a place by preposition pattern, not a baked city list.
    const loc = t.match(/\b(?:from|in|at|near|based in|deliver(?:y)?\s+(?:to|in))\s+([A-Z][a-zA-Z]{2,})\b/) || t.match(/\b([a-zA-Z]{3,})\s+(?:se|mein|me)\b/i); if (loc) push('Location', loc[1].replace(/^\w/, (c) => c.toUpperCase()));
    // product interest = a generic enquiry-intent cue (not a baked category list)
    if (/\b(price|rate|need|want|looking for|require|chahiye|interested|quote|best)\b/i.test(t)) push('Product interest', t.length > 40 ? t.slice(0, 40) + '…' : t);
  }
  return out.slice(0, 8);
}

function channelOf(name: string, msgs: WAMsg[]): WAChannel {
  if (msgs.every((m) => m.ts)) msgs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const buyer = msgs.filter((m) => m.side === 'buyer').length;
  return { name, messages: msgs, buyerMsgs: buyer, platformMsgs: msgs.length - buyer, total: msgs.length };
}

export function buildWhatsAppTimeline(raw: unknown): WAConversation {
  // CHANNEL 1 · inbound query/chat (clean: sender bot/user, content, timestamp)
  const inMsgs: WAMsg[] = [];
  const wiRaw = getTop(raw, 'whatsapp_inbound'); const wiObj = asObj(wiRaw);
  const recents = Array.isArray(wiRaw) ? (wiRaw as unknown[]) : asArr(asObj(wiObj.data).recent_messages);
  for (const m of recents) { const o = asObj(m); const content = String(o.content ?? o.message ?? o.text ?? '').trim(); if (!content) continue; inMsgs.push({ side: nrm(o.sender) === 'user' ? 'buyer' : 'platform', text: content, ts: o.timestamp ? String(o.timestamp) : undefined, kind: nrm(o.message_type) === 'clicked' ? 'clicked' : 'typed' }); }
  // CHANNEL 2 · outbound campaign (AiSensy nudges/buttons + the buyer's taps/replies)
  const outMsgs: WAMsg[] = [];
  asArr(getTop(raw, 'whatsapp_data')).forEach((m) => { const msg = parseOut(m); if (msg && msg.text) outMsgs.push({ ...msg, text: msg.text.length > 140 ? msg.text.slice(0, 140) + '…' : msg.text }); });
  const inbound = channelOf('Inbound query/chat', inMsgs);
  const outbound = channelOf('Outbound campaign', outMsgs);
  const signals = mineSignals([...inMsgs, ...outMsgs].filter((m) => m.side === 'buyer').map((m) => m.text));
  return { inbound, outbound, signals, total: inbound.total + outbound.total };
}

// ─── V10 MERGED-SOURCE adapter — bi-user-insights v9.5 emits ONE sources.whatsapp.summary.timeline
// ([{ts, side:'buyer'|'ours', kind:'message'|'enquiry'|'offer', text}]). Map it to the WAConversation the L2
// band renders (one unified thread → the `inbound` channel; outbound stays empty). Returns null when the merged
// source is absent (caller falls back to buildWhatsAppTimeline on the legacy whatsapp_inbound/whatsapp_data keys).
export function waFromMerged(rich: unknown): WAConversation | null {
  const wa = asObj(asObj(asObj(asObj(rich).sources).whatsapp).summary);
  const timeline = asArr(wa.timeline);
  if (!timeline.length) return null;
  // map kind faithfully (enquiry stays distinct from a templated offer) — DO NOT re-classify side (it's pre-tagged upstream: sender=user→buyer, bot/api→ours)
  const msgs: WAMsg[] = timeline.map((t) => { const o = asObj(t); const side: WAMsg['side'] = nrm(o.side) === 'buyer' ? 'buyer' : 'platform'; const k = nrm(o.kind); const kind: WAMsg['kind'] = k === 'enquiry' ? 'enquiry' : k === 'offer' ? 'template' : k === 'clicked' || k === 'tap' ? 'clicked' : 'typed'; return { side, text: String(o.text ?? '').trim(), ts: o.ts ? String(o.ts) : undefined, kind }; }).filter((m) => m.text);
  const inbound = channelOf('WhatsApp (merged)', msgs);
  const empty: WAChannel = { name: '', messages: [], buyerMsgs: 0, platformMsgs: 0, total: 0 };
  const signals = mineSignals(msgs.filter((m) => m.side === 'buyer').map((m) => m.text));
  const meta: WAMeta = {
    counts: (() => { const c = asObj(wa.counts); const out: Record<string, number> = {}; for (const [k, v] of Object.entries(c)) { const n = Number(v); if (!isNaN(n)) out[k] = n; } return Object.keys(out).length ? out : undefined; })() as Record<string, number> | undefined,
    buttonTaps: asArr(wa.button_taps).map((x) => String(x ?? '').trim()).filter(Boolean),
    productsEnquired: asArr(wa.products_enquired).map((x) => String(x ?? '').trim()).filter(Boolean),
  };
  return { inbound, outbound: empty, signals, total: msgs.length, meta };
}
