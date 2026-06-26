// ─── OFFER ENRICHMENT (Case 2) — correct a raw BuyLead from the buyer's OWN signals ──────────────────────────
// Take a raw BuyLead (title · location · quantity · specs) and reconcile it against BUYER-ORIGINATED signals
// (PNS calls · CSL searches · prior requirements · inbound WhatsApp · external identity). Conflicted fields are
// struck and REPLACED with the higher-confidence value; gaps the signals imply are ADDED (marked inferred);
// platform-deduced junk is DROPPED. Every change cites its evidence + carries LLM reasoning (offer ledger).
//
// HYBRID (arithmetic skeleton + LLM authority), mirroring the bl_quality / vani_quality_agent split:
//   • deterministic skeleton  = the mechanical, must-be-right parts (price/qty sanity — ports of absurd_quantity;
//     platform-deduced strip via provenance; the baseline action per field).
//   • LLM overlay (the authority) = semantic correction (spec↔signal contradiction, title, location reconcile,
//     gap-fill), grounded in buyer signals only. Generalises vani's isq_quality AUDIT (buyer-said vs recorded)
//     and bl_quality's spec_title (replace ONLY the conflicting term; brand/unit/format/synonym are NOT conflicts).
// Honesty model (user-locked): NO do-no-harm — any field, even a buyer-stated one, is corrected when a
// higher-priority buyer signal contradicts it. platform_generated is excluded from inference entirely.
// PURE (no fetch/LLM here — the LLM round-trip lives in gemini.offerEnrichLLM); NO category hardcoding.

import type { Ledger, SourceNode } from './ledger';
import type { Requirement } from './requirements';
import { partitionLedger, PLATFORM_DEDUCED_RE, SIGNAL_PRIORITY, type Partition } from './provenance';

export const OFFER_PROMPT_VERSION = 'offerEnrich.v1';

export type OfferAction = 'kept' | 'corrected' | 'added' | 'dropped' | 'suggested';
export interface OfferEvidence { signal: string; source: SourceNode; lineRef?: string; factId?: string }
export interface OfferField {
  field: string;                 // 'title' | 'location' | 'quantity' | a spec key
  label: string;
  raw: string;                   // what the BL had ('' for an added field)
  action: OfferAction;
  corrected: string;             // the new value (=== raw when kept)
  confidence: number;            // 0-100
  grounded: boolean;             // backed by ≥1 buyer signal
  inferred?: boolean;            // twin-implied (added; not buyer-stated but grounded)
  deduced?: boolean;             // platform-deduced offer field (Probable Order Value / Req Type) — stays on the LEFT,
                                 // LLM-VALIDATED (kept, or struck+corrected if a buyer signal contradicts), never inferred-from
  mapping?: boolean;             // the recorded "I am interested in" category mapping — the prime mis-map target (e.g. Paper Plate on a Notebook lead)
  evidence: OfferEvidence[];
  arithmeticBaseline?: string;   // what the deterministic skeleton said before the LLM
  method?: string;               // the deterministic RULE that produced the baseline (passthrough / absurd-qty check / deduced) — no black box
  llmReason?: string;
  conflict?: string;             // when signals disagreed: what + which won
}
export interface OfferEval {
  fields: number; corrected: number; added: number; dropped: number; suggested: number;
  groundedPct: number;           // % of CHANGED fields backed by a buyer signal
  hallucinations: number;        // corrected/added but ungrounded (must be 0)
  platformLeaks: number;         // any citation that resolved to a platform fact (must be 0)
  llmApplied: boolean;           // did the LLM authority actually return a verdict? false → skeleton only (no key / call failed)
  verdict: 'strong' | 'mixed' | 'thin' | 'no-llm';
}
export interface OfferEnrichResult {
  offerId?: string; offerTitle: string;
  title: OfferField; location: OfferField; quantity: OfferField;
  specs: OfferField[];           // kept / corrected / added / suggested
  dropped: OfferField[];         // platform-deduced removed (shown struck)
  eval: OfferEval; signalsUsed: number; promptVersion: string;
}

// ── deterministic helpers (ports of bl_quality/absurd_quantity) ──────────────────────────────────────────────
// "₹ 8 Lakh / Piece" → 800000 ; "20,000" → 20000 ; "1.5 crore" → 15000000
export function parsePriceInr(s: string): number | null {
  if (!s) return null;
  const t = String(s).replace(/,/g, '');
  const m = t.match(/\d[\d.]*/); if (!m) return null;        // first REAL number (must start with a digit — skips the dot in "Rs.")
  const n = parseFloat(m[0]); if (!isFinite(n)) return null;
  if (/crore|\bcr\b/i.test(t)) return n * 1e7;               // multiplier may sit anywhere (ranges: "70 - 74 Lakh")
  if (/lakh|lac/i.test(t)) return n * 1e5;
  if (/\dk\b|\bk\b/i.test(t)) return n * 1e3;
  return n;
}
// 3 arithmetic rules from absurd_quantity (round-number, price-as-quantity); threshold 1000.
export function quantitySanity(qty: number, viewedPrices: number[] = []): { absurd: boolean; reason: string } {
  if (!isFinite(qty) || qty <= 0) return { absurd: false, reason: '' };
  if (qty > 1000 && qty % 10 !== 0) return { absurd: true, reason: `non-round bulk quantity (${qty}) — likely a typo / mis-entry` };
  if (viewedPrices.some((p) => Math.abs(p - qty) < 1)) return { absurd: true, reason: `quantity (${qty}) equals a viewed product price — price likely entered as quantity` };
  return { absurd: false, reason: '' };
}

const num = (s: string): number => { const m = String(s || '').replace(/,/g, '').match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
const fld = (field: string, label: string, raw: string, action: OfferAction, extra: Partial<OfferField> = {}): OfferField => ({ field, label, raw, action, corrected: raw, confidence: action === 'kept' ? 50 : 0, grounded: false, evidence: [], ...extra });

// ── the deterministic skeleton: the baseline BEFORE the LLM (the arithmetic input) ───────────────────────────
export interface OfferSkeleton { result: OfferEnrichResult; partition: Partition; registered: string; sourcingHints: string[] }
export function buildOfferSkeleton(offer: Requirement, L: Ledger): OfferSkeleton {
  const partition = partitionLedger(L);
  const offerId = offer.facts.find((f) => f.tag === 'bl.offerid')?.rawValue;

  // registered location (profile/glusr) + sourcing hints (CSL search text — where the buyer actually shops)
  const locFact = (re: RegExp) => L.facts.find((f) => re.test(f.tag) && (f.sourceNode === 'profile-api' || f.sourceNode === 'glusr'))?.rawValue.trim();
  const registered = [locFact(/\bcity\b/i), locFact(/\bstate\b/i)].filter(Boolean).join(', ') || (L.facts.find((f) => /location/i.test(f.tag))?.rawValue.trim() ?? '');
  const sourcingHints = [...new Set(partition.buyer.filter((f) => f.sourceNode === 'csl' && /search/i.test(f.tag)).map((f) => f.rawValue.trim()))].filter(Boolean);

  // viewed prices (for the qty sanity rule) — CSL price facts
  const viewedPrices = partition.buyer.filter((f) => f.sourceNode === 'csl' && /price/i.test(f.tag)).map((f) => parsePriceInr(f.rawValue)).filter((n): n is number => n != null);

  // quantity (if the BL recorded one — usually a spec keyed quantity)
  const qtySpec = offer.specs.find((s) => /quantity|qty\b|order size/i.test(s.k));
  const qtyRaw = qtySpec ? qtySpec.v : '';
  const qtyVal = num(qtyRaw);
  const qtyCheck = quantitySanity(qtyVal, viewedPrices);

  const title = fld('title', 'Title', offer.title, 'kept', { confidence: offer.title.trim().split(/\s+/).length >= 3 ? 60 : 35, arithmeticBaseline: offer.title, method: 'recorded BL title (passthrough) — LLM validates vs PNS product + searches' });
  const location = fld('location', 'Location', registered, 'kept', { arithmeticBaseline: registered, confidence: 55, method: 'registered city from profile-api/glusr city+state (passthrough) — stays the lead location unless a buyer signal overrides' });
  const quantity = fld('quantity', 'Quantity', qtyRaw, qtyCheck.absurd ? 'corrected' : 'kept', { arithmeticBaseline: qtyRaw || '(none)', confidence: qtyCheck.absurd ? 30 : 50, method: `recorded qty + absurd-quantity check (price-as-qty / non-round bulk)${qtyCheck.absurd ? ` → flagged: ${qtyCheck.reason}` : ' → passed'}`, llmReason: qtyCheck.reason || undefined });

  // specs: real buyer-answered specs + platform-deduced fields. Deduced fields STAY on the lead (deduced:true) and are
  // LLM-VALIDATED (kept, or struck+corrected only if a buyer signal contradicts) — never dropped, never used to infer.
  const specs: OfferField[] = []; const dropped: OfferField[] = [];
  const addDeduced = (k: string, v: string) => { if (k && !specs.some((s) => s.deduced && s.field === k)) specs.push(fld(k, k, v, 'kept', { deduced: true, arithmeticBaseline: v, confidence: 55, method: 'platform-deduced field (PLATFORM_DEDUCED_RE match on key/value) — validated vs buyer signals, NEVER used to infer', llmReason: 'platform-deduced — IndiaMART derived this; validated vs buyer signals, never used as buyer intent' })); };
  for (const s of offer.specs) {
    if (/quantity|qty\b|order size/i.test(s.k)) continue; // handled as the quantity field
    // the "I am interested in" mapping → a canonical `category` field (the prime mis-map target). Lower base
    // confidence so a contradicting buyer signal (title + PNS product + searches) wins the correction.
    if (/interested|mapping/i.test(s.k)) { specs.push(fld('category', 'Category (mapping)', s.v, 'kept', { mapping: true, arithmeticBaseline: s.v, confidence: 45, method: 'recorded "I am interested in" mapping (the prime mis-map target) — VALIDATE vs title + PNS product + searches', llmReason: 'recorded "I am interested in" mapping — VALIDATE vs title + PNS product + searches; correct (action corrected) if they disagree' })); continue; }
    if (PLATFORM_DEDUCED_RE.test(s.k) || PLATFORM_DEDUCED_RE.test(s.v)) addDeduced(s.k, s.v);
    else specs.push(fld(s.k, s.k, s.v, 'kept', { arithmeticBaseline: s.v, confidence: 55, method: `recorded ISQ spec "${s.k}" (passthrough) — LLM validates vs call narrative + searches` }));
  }
  // platform-deduced fields usually live in the BL FACTS (not offer.specs) — pull them too.
  for (const fc of offer.facts) {
    if (fc.tag === 'isq.answer' && PLATFORM_DEDUCED_RE.test(fc.rawValue)) { const eq = fc.rawValue.indexOf('='); addDeduced(eq >= 0 ? fc.rawValue.slice(0, eq).trim() : 'deduced field', eq >= 0 ? fc.rawValue.slice(eq + 1).trim() : fc.rawValue); }
  }

  const result: OfferEnrichResult = {
    offerId, offerTitle: offer.title, title, location, quantity, specs, dropped,
    eval: offerEval({ title, location, quantity, specs, dropped }, 0, false), signalsUsed: partition.buyer.length, promptVersion: OFFER_PROMPT_VERSION,
  };
  return { result, partition, registered, sourcingHints };
}

// ── the prompt (system = generalised vani isq_quality AUDIT + bl_quality spec_title discipline) ──────────────
export const OFFER_ENRICH_SYSTEM = [
  "You RECONSTRUCT the buyer's TRUE requirement for an India B2B BuyLead. You are given the recorded BuyLead (title,",
  'location, quantity, specs, "I am interested in"/mapping) and the buyer\'s OWN signals: PNS call insights (persona,',
  'quantity_scale, order_type, intended_application, narrative, most-specific product/category, seller questions,',
  'deal-blockers), on-site searches + browse + sourcing city (CSL), inbound WhatsApp (the buyer\'s messages), prior',
  'requirements / ISQ, verified external identity. Reconstruct what the buyer ACTUALLY wants — NOT what the form captured.',
  '',
  'WHAT MAY FEED INFERENCE (provenance):',
  '- Use ONLY buyer-originated signals. CONTEXT-ONLY (never cite, never carry forward): OUR WhatsApp messages (seller',
  '  shares / marketing — a seller name + location WE sent is NOT what the buyer asked for), sellers IndiaMART matched,',
  '  and platform-DEDUCED fields (Probable Order Value / Requirement Type) — those you only VALIDATE, never infer from.',
  "- WhatsApp is two-way: the SIGNAL is the BUYER's own messages/replies; our messages are only context for the reply.",
  '',
  'PRIORITY WHEN SIGNALS CONFLICT (higher wins; before-posting signals weigh high):',
  `  ${SIGNAL_PRIORITY}.`,
  '  No recorded field is sacred — a buyer signal overrides it, even one the buyer typed (e.g. a wrong "I am',
  '  interested in"). State the conflict + which signal won in "conflict".',
  '',
  'RECONSTRUCTION RULES:',
  '- CATEGORY MISMATCH (do this FIRST): if the title, the "I am interested in"/mapping, the PNS product-category and',
  '  the searches disagree, reconstruct the TRUE product from the strongest buyer signals (title + PNS product +',
  '  searches) and CORRECT the wrong mapping. Emit this as a field named EXACTLY "category":',
  '  action "corrected" (with the true product as value) when the recorded mapping disagrees, "kept" when it matches.',
  '- SPECS: if a spec varies across signals, output a RANGE (e.g. GSM "54/60"). Prefer the buyer\'s stated/searched',
  '  value over the recorded one. Multi-option tolerant; dimension notation equivalent ("10x10"="10×10"="10 by 10").',
  '  Specs are OFTEN stated inside a PNS call NARRATIVE (e.g. "54 GSM", "0.5 to 1 ton") — READ the narrative text and',
  '  extract them; a spec the buyer SPOKE on a call outranks the recorded form value. (Decisive ones are pre-surfaced.)',
  "- QUANTITY: prefer the call's quantity (pns.quantity_scale) over the form. If signals show a first / TRIAL order",
  '  (pns.order_type, "starting a new unit", a small spoken qty) prefer the LOWER trial quantity over the form\'s bulk.',
  '- BUYER STAGE — add a "buyer_stage" field: Exploration (learning / unclear specs) · Evaluation (comparing / price)',
  '  · Final (specific SKU, ready to close).',
  '- SUPPLIER-LOCATION PREFERENCE — add a "supplier_location" field: where the buyer SOURCES from (search city / call —',
  '  the sourcing region the buyer named). This is SEPARATE from the BuyLead location (that stays the registered city). Add',
  '  "local suppliers preferred" only if transport-cost / locality signals exist.',
  '- APPLICATION — add an "application" field from pns.intended_application. TIMELINE — add only if a signal states it.',
  '- INDIA B2B PATTERNS — apply ONLY when signals support: trial-first, price-sensitive, local-supplier preference,',
  '  WhatsApp-driven negotiation, multi-supplier comparison.',
  '',
  'VALIDATE-NOT-DROP: platform-deduced fields (Probable Order Value / Requirement Type) → action kept if no buyer',
  '  signal contradicts; action corrected (buyer value) only if one does. NEVER drop them, NEVER infer from them.',
  'Location: keep the registered city (action kept) unless a buyer signal gives a different BuyLead location.',
  '',
  'HALLUCINATION GUARD: never invent. Every corrected / added value MUST cite >=1 buyer-signal id and grounded=true.',
  '  confidence >=70 only when >=2 signals agree or one strong spoken (call) signal. No supporting signal → keep the',
  '  recorded value (action kept); do not change, do not add.',
  '',
  'OUTPUT — strict JSON, one entry per field you assessed or added:',
  '{ "fields": [ { "field": "title|location|quantity|<spec>|category|buyer_stage|supplier_location|application|timeline",',
  '  "action": "kept|corrected|added|suggested", "value": "<final value or range>", "confidence": 0-100,',
  '  "grounded": true|false, "inferred": true|false, "evidence_ids": ["f12","f30"],',
  '  "reason": "<1-2 sentences>", "conflict": "<what disagreed + which signal won, else empty>" } ] }',
  'Cite ONLY buyer-signal ids; never cite platform-generated context.',
].join('\n');

export function buildOfferEnrichPrompt(sk: OfferSkeleton, offer: Requirement): { system: string; user: string; evidenceIds: string[] } {
  const { result, partition, registered, sourcingHints } = sk;
  // priority-order the buyer facts so DECISIVE sources (call · ISQ · BL · buyer-WA · searches) are NEVER truncated
  // by the cap — identity sources sort last. resolveEvidence matches by id, so reordering is display-only.
  const SRC_RANK: Partial<Record<SourceNode, number>> = { 'pns-insights': 0, 'prev-isq': 1, 'prev-bl': 2, 'wa-in': 3, csl: 4, befisc: 5, sign3: 6, 'profile-api': 7, glusr: 8, 'wa-out': 9 };
  const ev = [...partition.buyer].sort((a, b) => (SRC_RANK[a.sourceNode] ?? 9) - (SRC_RANK[b.sourceNode] ?? 9)); // V10 (owner #4/#13): NO 200-cap — a decisive late-sorted PNS narrative (RAW-PAPER/Kanpur/54-GSM) must never fall off. Cost LATER.
  const evidenceIds = ev.map((f) => f.id);
  // a buyer often has SEVERAL PNS calls → surface ALL distinct values, not just the first (the calls can disagree;
  // the priority rule + trial-over-bulk then decides). Specs stated INSIDE a narrative (GSM, qty) are extracted too.
  const pnsAll = (tag: string) => [...new Set(partition.buyer.filter((f) => f.sourceNode === 'pns-insights' && f.tag === tag).map((f) => f.rawValue.trim()).filter(Boolean))];
  const interested = result.specs.find((s) => s.mapping || /interested|mapping|^category$/i.test(s.field));
  const narrative = partition.buyer.filter((f) => f.sourceNode === 'pns-insights' && /narrative/i.test(f.tag)).map((f) => f.rawValue).join('  ');
  const gsmHits = [...new Set([...narrative.matchAll(/(\d{2,3})\s*GSM/gi)].map((m) => m[1]))];
  const qtyNarr = narrative.match(/(\d+(?:\.\d+)?)\s*(?:to|–|—|-)\s*(\d+(?:\.\d+)?)\s*(?:ton|tonne|kg|quintal|kilo)/i) || narrative.match(/(\d+(?:\.\d+)?)\s*(?:ton|tonne|kg|quintal)\b/i);
  const trialFlag = /\btrial\b|sample|starting (?:a )?(?:new )?(?:unit|business|venture)|new (?:unit|venture)|first order/i.test(narrative);
  const products = pnsAll('pns.product'); const applications = pnsAll('pns.application'); const qtyScales = pnsAll('pns.qty_scale'); const orderTypes = pnsAll('pns.order_type');
  // surface the decisive comparison so the model can't miss the category / spec / quantity reconstruction
  const decisive = [
    'DECISIVE SIGNALS (reconcile these FIRST — category · specs · quantity):',
    `  recorded title: ${offer.title}`,
    interested ? `  recorded "I am interested in" / mapping (CORRECT this if it disagrees with title + call + searches): ${interested.raw}` : '',
    products.length ? `  call · product / category (all calls): ${products.join(' | ')}` : '',
    applications.length ? `  call · application (all calls): ${applications.join(' | ')}` : '',
    gsmHits.length ? `  call · GSM stated in narrative: ${gsmHits.join(' / ')} GSM  (a spoken spec OUTRANKS the recorded form value)` : '',
    `  recorded quantity: ${result.quantity.raw || '(none)'}`,
    qtyNarr ? `  call · quantity stated in narrative: ${qtyNarr[0].trim()}${trialFlag ? '  (TRIAL / new unit — prefer this LOWER qty over the form bulk)' : ''}` : '',
    qtyScales.length ? `  call · quantity scale(s): ${qtyScales.join(' | ')}` : '',
    orderTypes.length ? `  call · order type(s): ${orderTypes.join(' | ')}` : '',
    sourcingHints.length ? `  sourcing city signal (→ supplier_location): ${sourcingHints.slice(0, 4).join(' | ')}` : '',
  ].filter(Boolean);
  const user = [
    'RAW BUYLEAD (what IndiaMART recorded — reconstruct the TRUE requirement):',
    `  title: ${offer.title}`,
    `  location (registered — keep unless a buyer signal gives a different lead location): ${registered || '(none)'}`,
    `  quantity: ${result.quantity.raw || '(none)'}`,
    ...result.specs.filter((s) => !s.deduced).map((s) => `  spec · ${s.field}: ${s.raw}`),
    ...(() => { const d = result.specs.filter((s) => s.deduced); return d.length ? ['', 'PLATFORM-DEDUCED fields (VALIDATE — keep, or correct only if a buyer signal contradicts; never cite as evidence):', ...d.map((s) => `  ${s.field}: ${s.raw}`)] : []; })(),
    '',
    ...decisive,
    '',
    'BUYER-ORIGINATED SIGNALS — cite these ids (the ONLY evidence you may use):',
    ...ev.map((f) => `  [${f.id}] (${f.sourceNode}/${f.tag}) ${f.rawValue}`),
    ...(partition.platform.length ? ['', 'PLATFORM-GENERATED — CONTEXT ONLY, never cite, never carry forward (incl. OUR WhatsApp messages):', ...partition.platform.map((f) => `  (${f.sourceNode}/${f.tag}) ${f.rawValue}`)] : []), // V10 (owner #4/#13): no 30-cap on platform context.
    '',
    'Reconstruct: FIX category mismatch first, then specs (range), quantity (trial over bulk), and ADD buyer_stage · supplier_location · application · timeline where grounded. VALIDATE (never drop) platform-deduced fields. Return the JSON.',
  ].join('\n');
  return { system: OFFER_ENRICH_SYSTEM, user, evidenceIds };
}

// ── LLM merge: overlay the authority's verdict onto the skeleton, resolve evidence, apply the confidence gate ──
export interface OfferLLMField { field: string; action?: string; value?: string; confidence?: number; grounded?: boolean; inferred?: boolean; evidence_ids?: string[]; reason?: string; conflict?: string }
export interface OfferLLMOut { fields: OfferLLMField[] }

function resolveEvidence(ids: string[] | undefined, partition: Partition): { ev: OfferEvidence[]; leaks: number } {
  const ev: OfferEvidence[] = []; let leaks = 0;
  const buyerById = new Map(partition.buyer.map((f) => [f.id, f] as const));
  const platById = new Map(partition.platform.map((f) => [f.id, f] as const));
  for (const id of ids || []) {
    const bf = buyerById.get(id);
    if (bf) { ev.push({ signal: bf.rawValue, source: bf.sourceNode, lineRef: bf.lineRef, factId: bf.id }); continue; }
    if (platById.get(id)) leaks++; // the LLM cited a platform fact → leak (dropped from evidence, counted)
  }
  return { ev, leaks };
}

const GATE_HI = 70, GATE_MED = 50; // high → apply ; medium → suggest (show both) ; low → keep raw
// canonicalise field names so the LLM's "category" reconciles with the skeleton's mapping field (and the buyer's
// recorded "I am interested in"). Without this, a category mis-map fix lands on NO field and is silently dropped.
const canonField = (s: string): string => { const x = String(s || '').toLowerCase().trim(); return /^(category|i am interested in|interested in|mapping|product category|true product|item)$/.test(x) ? 'category' : x; };

export function mergeOfferLLM(sk: OfferSkeleton, out: OfferLLMOut | null): OfferEnrichResult {
  const base = sk.result;
  if (!out || !Array.isArray(out.fields)) return { ...base, eval: offerEval(base, 0, false) }; // no LLM verdict → honest 'no-llm', not a false 'strong'
  const partition = sk.partition;
  const byField = new Map(out.fields.map((f) => [canonField(f.field), f] as const));
  let platformLeaks = 0;

  const apply = (target: OfferField): OfferField => {
    const llm = byField.get(canonField(target.field)); if (!llm) return target;
    const { ev, leaks } = resolveEvidence(llm.evidence_ids, partition); platformLeaks += leaks;
    const conf = typeof llm.confidence === 'number' ? Math.max(0, Math.min(100, llm.confidence)) : target.confidence;
    let action = (['kept', 'corrected', 'added', 'dropped', 'suggested'].includes(String(llm.action)) ? llm.action : target.action) as OfferAction;
    const grounded = !!llm.grounded && ev.length > 0;
    if (target.deduced && action === 'dropped') action = 'kept'; // deduced fields are validated in place, NEVER dropped
    // confidence gate: medium-confidence changes become suggestions (show both); low-confidence revert to raw.
    if ((action === 'corrected' || action === 'added') && conf < GATE_HI) action = conf >= GATE_MED ? 'suggested' : 'kept';
    const corrected = action === 'kept' ? target.raw : String(llm.value ?? target.corrected);
    return { ...target, action, corrected, confidence: conf, grounded, inferred: !!llm.inferred, deduced: target.deduced, evidence: ev, llmReason: llm.reason || target.llmReason, conflict: llm.conflict || undefined };
  };

  const title = apply(base.title);
  const location = apply(base.location);
  const quantity = apply(base.quantity);
  const specs = base.specs.map(apply);
  // LLM-named fields NOT already in the skeleton — land them whether the model called it 'added' OR 'corrected'/'suggested'.
  // (A category mis-map fix can arrive as action:"corrected" with no matching skeleton field; the old 'added'-only
  //  guard silently dropped it. Now any grounded new field is surfaced — added if ≥70, else suggested.)
  const have = new Set(specs.map((s) => canonField(s.field)));
  for (const llm of out.fields) {
    const key = canonField(llm.field);
    if (['added', 'corrected', 'suggested'].includes(String(llm.action)) && !['title', 'location', 'quantity'].includes(key) && !have.has(key)) {
      const { ev, leaks } = resolveEvidence(llm.evidence_ids, partition); platformLeaks += leaks;
      const conf = typeof llm.confidence === 'number' ? Math.max(0, Math.min(100, llm.confidence)) : 0;
      const grounded = !!llm.grounded && ev.length > 0;
      const label = (llm.field || key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); // buyer_stage → "Buyer Stage"
      if (grounded) { specs.push({ field: llm.field || key, label, raw: '', action: conf >= GATE_HI ? 'added' : 'suggested', corrected: String(llm.value ?? ''), confidence: conf, grounded, inferred: true, evidence: ev, method: 'LLM-added — no recorded baseline; surfaced from buyer signals (cites buyer evidence ids)', llmReason: llm.reason, conflict: llm.conflict || undefined }); have.add(key); }
    }
  }
  const merged = { title, location, quantity, specs, dropped: base.dropped };
  return { ...base, ...merged, eval: offerEval(merged, platformLeaks, true) };
}

// ── eval band (FAANG-grade honesty: hallucinations + platform leaks must be 0) ───────────────────────────────
export function offerEval(r: { title: OfferField; location: OfferField; quantity: OfferField; specs: OfferField[]; dropped: OfferField[] }, platformLeaks = 0, llmApplied = true): OfferEval {
  const all = [r.title, r.location, r.quantity, ...r.specs];
  const changed = all.filter((f) => f.action === 'corrected' || f.action === 'added' || f.action === 'suggested');
  const corrected = all.filter((f) => f.action === 'corrected').length;
  const added = all.filter((f) => f.action === 'added').length;
  const suggested = all.filter((f) => f.action === 'suggested').length;
  const dropped = r.dropped.length;
  const groundedPct = changed.length ? Math.round((changed.filter((f) => f.grounded).length / changed.length) * 100) : 100;
  const hallucinations = changed.filter((f) => !f.grounded).length;
  // 'no-llm' is NOT success: the LLM authority never returned a verdict (no key / call failed) → all-kept is the
  // skeleton, not a validation. Only call it 'strong' when the LLM actually ran AND every change is grounded.
  const verdict: OfferEval['verdict'] = !llmApplied ? 'no-llm' : (groundedPct >= 80 && hallucinations === 0 && platformLeaks === 0) ? 'strong' : groundedPct < 50 ? 'thin' : 'mixed';
  return { fields: all.length, corrected, added, dropped, suggested, groundedPct, hallucinations, platformLeaks, llmApplied, verdict };
}
