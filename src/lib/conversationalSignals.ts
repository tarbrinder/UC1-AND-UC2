// ─── CONVERSATIONAL SIGNAL EXTRACTOR ─────────────────────────────────────────
// The highest-ROI intelligence we were throwing away. A buyer's PNS calls and WhatsApp
// chat carry their requirement in their OWN words — and those words are category-
// independent, buyer-specific, repeatable, actionable:
//
//   "Sir mujhe toh lucknow me chahe"        → wants Lucknow  (even if profile says Noida)
//   "Saare dilli wale phone kar rahe hain"  → rejecting Delhi sellers (location mismatch)
//   "Phone toh aaya but available nahi hai" → supply/stock problem with prior sellers
//   "22.5 Kg" / "100-200"                   → spec + quantity, stated conversationally
//   four "No" callbacks over months         → cold engagement / wrong matches
//
// We mine USER turns only (API turns are templates) and the place/qty embedded in API
// templates only for CONTEXT. Hinglish + English. NO category literals (standing rule):
// places/quantities are captured POSITIONALLY by linguistic structure, never from a list.
//
// PURE + deterministic → this same function is portable to n8n v13's fact_assembler
// (server-side conversational_signals). Until then the FORM runs it client-side on the
// whatsapp_data it already pulls — so the system is fed NOW, not when v13 ships.

export type ConvSignalKind =
  | 'location_preference'  // wants suppliers from <place>
  | 'location_reject'      // does NOT want suppliers from <place>
  | 'quantity_hint'        // a quantity / range stated in chat
  | 'spec_hint'            // a measured spec (22.5 Kg, 5 kVA, 54 GSM…) stated in chat
  | 'supply_issue'         // prior seller had no stock / unavailable
  | 'urgency'              // jaldi / urgent / turant
  | 'budget_sensitive'     // sasta / rate kam / budget tight
  | 'payment_pref'         // cash / advance / credit / udhaar
  | 'photo_shared'         // buyer sent an image (visual, engaged)
  | 'low_engagement';      // repeatedly declining callbacks

export interface ConvSignal {
  kind: ConvSignalKind;
  value: string;       // the extracted value ("lucknow", "100-200", "22.5 Kg", …)
  evidence: string;    // the raw buyer turn it came from (debug-truthful)
  ts?: string;         // message timestamp if known
  confidence: number;  // 0-100
}

export interface ConvSignalResult {
  signals: ConvSignal[];
  locationPreference: string | null;  // strongest "wants <place>"
  locationPreferenceConfidence: number | null; // confidence of that preference → drives chip/confirm/hide
  rejectedLocations: string[];        // places whose sellers the buyer pushed back on
  engagement: 'cold' | 'neutral' | 'warm';
  declineCount: number;               // # of "No"/"Stop" callback declines
  hasPhoto: boolean;
}

// A WhatsApp row as the webhook delivers it: { sender, message (JSON string), timestamp }.
export interface WaRow { sender?: string; message?: string; timestamp?: string }

const STOP = new Set(['me', 'mein', 'm', 'se', 'ka', 'ki', 'ko', 'toh', 'to', 'the', 'a', 'an', 'sir', 'madam', 'ji', 'plz', 'please', 'i', 'we', 'is', 'in', 'at', 'of', 'for', 'and']);

// Pull the human-readable text out of one WA row (messages are JSON-encoded payloads).
function waText(row: WaRow): { text: string; isUser: boolean; isPhoto: boolean } {
  const isUser = String(row?.sender || '').toUpperCase() === 'USER';
  let text = ''; let isPhoto = false;
  try {
    const p = JSON.parse(String(row?.message ?? ''));
    text = p.text || p.title || p.caption || '';
    if (!text && typeof p.callbackPayload === 'string' && !p.callbackPayload.startsWith('{')) text = p.callbackPayload;
    if (p.mimeType && String(p.mimeType).startsWith('image')) isPhoto = true;
  } catch { text = String(row?.message ?? ''); }
  return { text: String(text || '').trim(), isUser, isPhoto };
}

// Place token after a "wants here" cue. POSITIONAL — we read the word the buyer put next to
// the cue, never a hardcoded city list. Keeps the buyer's own spelling ("dilli", "lucknow").
function placeBefore(text: string, cueRe: RegExp): string | null {
  // "<place> me chahe" / "<place> wale" → the token immediately BEFORE the cue
  const m = text.match(cueRe);
  if (!m) return null;
  const before = text.slice(0, m.index).trim().split(/\s+/);
  for (let i = before.length - 1; i >= 0; i--) {
    const w = before[i].toLowerCase().replace(/[^a-z]/g, '');
    if (w && !STOP.has(w) && w.length >= 3) return w;
  }
  return null;
}

const WANT_CUE = /\b(?:me|mein|m)\s+chah|chahiye|chahe|chaiye|chahta|chahye/i;       // Hinglish: "<place> me chahe"
const EN_LOC_CUE = /\b(?:from|near)\s+([a-z]{3,})\b/i;                                // English: "from/near <place>"
const WANT_CONTEXT = /\b(want|need|chahiye|chahe|prefer|supplier|sellers?|only|sirf)\b/i; // gate EN location to a real ask
const REJECT_CUE = /\bwale?\b/i;                                                      // "<place> wale phone kar rahe"
const SUPPLY_RE = /available\s*nahi|not\s*available|out\s*of\s*stock|stock\s*nahi|nahi\s*mila|maal\s*nahi|product\s*nahi/i;
const URGENT_RE = /\burgent|jaldi|asap|turant|abhi\s*chahiye|emergency|aaj\s*hi|today\s*itself|immediately\b/i;
const BUDGET_RE = /\bsasta|sasti|budget|kam\s*rate|rate\s*kam|low\s*price|cheap|tight|kam\s*paise|economical\b/i;
const PAY_RE = /\bcash|advance|udhaar|udhar|credit|cod\b|online\s*payment|neft|upi\b/i;
const QTY_RANGE_RE = /\b(\d{1,6}(?:\.\d+)?\s*[-–]\s*\d{1,6}(?:\.\d+)?)\b/;
const QTY_UNIT_RE = /\b(\d{1,6}(?:\.\d+)?)\s*(kg|kgs|ton|tonne|tons|pcs|piece|pieces|nos|units?|sets?|meter|metre|mtr|box(?:es)?|litre|liter|ltr)\b/i;
const SPEC_RE = /\b(\d{1,6}(?:\.\d+)?)\s*(kva|kw|hp|gsm|mm|cm|inch|"|ft|feet|volt|v|amp|amps|watt|w|bar|psi|micron|gauge)\b/i;
const SPEC_DECIMAL_WT = /\b(\d+\.\d+)\s*(kg|kgs|ton|tonne|litre|liter|ltr|ml|gram|grams)\b/i; // a DECIMAL weight (22.5 Kg) is a capacity SPEC, not an order qty

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// MAIN. Mine the buyer's PNS + WhatsApp turns into structured, category-independent signals.
export function extractConversationalSignals(waData: unknown, pnsHints?: string[]): ConvSignalResult {
  const rows: WaRow[] = Array.isArray(waData) ? (waData as WaRow[]) : [];
  const signals: ConvSignal[] = [];
  const push = (kind: ConvSignalKind, value: string, evidence: string, confidence: number, ts?: string) => {
    if (!value) return; signals.push({ kind, value, evidence: evidence.slice(0, 140), confidence, ts });
  };

  let declineCount = 0; let hasPhoto = false;

  const scanText = (text: string, ts: string | undefined, fromUser: boolean) => {
    if (!text) return;
    const low = text.toLowerCase();
    // location want (USER only — a template "in Noida" is NOT the buyer asking)
    if (fromUser) {
      // location want — Hinglish "<place> me chahe" (place BEFORE cue), else English "from/near <place>" (place AFTER, gated by a want context)
      const want = placeBefore(low, WANT_CUE);
      if (want) push('location_preference', want, text, 80, ts);
      else if (WANT_CONTEXT.test(low)) { const em = low.match(EN_LOC_CUE); if (em && em[1] && !STOP.has(em[1])) push('location_preference', em[1], text, 75, ts); }
      const rej = REJECT_CUE.test(low) ? placeBefore(low, REJECT_CUE) : null;
      // only treat "<place> wale" as a reject when paired with a complaint cue (calling/phone/sab)
      if (rej && /(phone|call|kar\s*rahe|sab|saare|sare)/i.test(low)) push('location_reject', rej, text, 70, ts);
      if (SUPPLY_RE.test(low)) push('supply_issue', 'prior seller unavailable / no stock', text, 70, ts);
      if (URGENT_RE.test(low)) push('urgency', 'buyer signalled urgency', text, 65, ts);
      if (BUDGET_RE.test(low)) push('budget_sensitive', 'price/budget sensitivity', text, 60, ts);
      if (PAY_RE.test(low)) { const mm = low.match(PAY_RE); push('payment_pref', mm ? mm[0] : 'payment terms', text, 60, ts); }
      // a DECIMAL weight (22.5 Kg) or a spec-unit value (5 kVA, 54 GSM) is a SPEC; integer+unit / a range is a QUANTITY
      const spec = text.match(SPEC_RE) || text.match(SPEC_DECIMAL_WT); if (spec) push('spec_hint', spec[0].trim(), text, 70, ts);
      const range = text.match(QTY_RANGE_RE); const unit = text.match(QTY_UNIT_RE);
      if (range) push('quantity_hint', range[1].replace(/\s+/g, ''), text, 65, ts);
      else if (unit && !SPEC_DECIMAL_WT.test(text)) push('quantity_hint', unit[0].trim(), text, 65, ts);
      // decline tracking ("No"/"Stop" to a callback confirmation)
      if (/^(no|stop|nahi|cancel)\b/i.test(low)) declineCount++;
    }
  };

  for (const row of rows) {
    const { text, isUser, isPhoto } = waText(row);
    if (isPhoto && isUser) { hasPhoto = true; push('photo_shared', 'buyer shared a photo', '[image]', 55, row.timestamp); }
    scanText(text, row.timestamp, isUser);
  }
  for (const h of pnsHints || []) scanText(String(h || ''), undefined, true);

  if (declineCount >= 2) push('low_engagement', `${declineCount} callback declines`, 'repeated "No" to seller callbacks', Math.min(50 + declineCount * 8, 85));

  // ── rollups ──
  // strongest location preference = highest-confidence, then most recent
  const prefs = signals.filter((s) => s.kind === 'location_preference').sort((a, b) => b.confidence - a.confidence);
  const locationPreference = prefs.length ? prefs[0].value : null;
  const locationPreferenceConfidence = prefs.length ? prefs[0].confidence : null;
  const rejectedLocations = [...new Set(signals.filter((s) => s.kind === 'location_reject').map((s) => s.value))]
    .filter((r) => norm(r) !== norm(locationPreference || '')); // don't reject what you prefer
  const engagement: ConvSignalResult['engagement'] =
    declineCount >= 3 || signals.some((s) => s.kind === 'supply_issue') ? 'cold'
      : (hasPhoto || signals.some((s) => s.kind === 'quantity_hint' || s.kind === 'spec_hint')) ? 'warm'
        : 'neutral';

  return { signals, locationPreference, locationPreferenceConfidence, rejectedLocations, engagement, declineCount, hasPhoto };
}

// One-line human summary for the debug panel.
export function formatConvSignals(r: ConvSignalResult): string {
  if (!r.signals.length) return '';
  const bits: string[] = [];
  if (r.locationPreference) bits.push(`wants ${r.locationPreference}`);
  if (r.rejectedLocations.length) bits.push(`not ${r.rejectedLocations.join('/')}`);
  const kinds = [...new Set(r.signals.map((s) => s.kind))].filter((k) => k !== 'location_preference' && k !== 'location_reject');
  if (kinds.length) bits.push(kinds.map((k) => k.replace(/_/g, ' ')).join(', '));
  bits.push(`engagement ${r.engagement}`);
  return bits.join(' · ');
}
