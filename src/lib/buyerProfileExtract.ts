// ─── BUYER PROFILE EXTRACTOR (LLM-native, NO regex facts) ───────────────────────────────────────────────────
// The "no facts regex" path the owner locked: feed the WHOLE rich n8n response (bi-user-insights — per-source
// summaries) to ONE exhaustive LLM call that extracts the buyer profile, per field { value · state · confidence ·
// sources · evidence · reasoning }. It REUSES the existing render/trace/eval contracts — output maps to FinalAttr
// (synthesisEngine), evidence is the SAME evidence_id (fN) scheme assembleBundle uses, so evMapAll / verifyLLMOutput
// / synthEval / the per-attribute drill all keep working. The deterministic regex/persona path stays as the fallback.
//
// KEY DESIGN: the citable EVIDENCE is the source SUMMARIES flattened (pure structural walk — NOT regex tag-mining).
// The model cites fN ids that resolve to a real summary line, so grounding + the hallucination guard are honest.
// Deterministic + harnessed in scripts/extracttest.mjs (only the gemini round-trip is async/env-gated).

import type { SynthBundle } from './profileSynth';
import type { FinalAttr } from './synthesisEngine';
import type { SynthLLMOut } from './gemini';
import { attrMeta } from './personaRegistry';

export const EXTRACT_PROMPT_VERSION = 'extract-v26'; // v26: WEB-ENGINE SELF-REPORT — fast mode adds Gemini 2.5 Flash + Google Search grounding as a web_osint engine (both modes; Parallel adds/prefers in full). It SELF-REPORTS match_confidence (high/med/low/none) + matched anchors + turnover_source (gst_filed vs directory_declared); composeWebOsint now emits a "web-engine self-report" verdict line FIRST so the LLM trusts web facts ONLY per that verdict (match_confidence=none/low ⇒ namesake, do NOT set attributes) — and the buyerProfileModel webVerified gate honors match_confidence!=='none' end-to-end (Amit-lens: never treat an unconfirmed web hit as fact). v25: CALL EVIDENCE = Go-schema structured extraction — composeCalls/composePnsCalls now emit products/specs/price/qty · buyer_intent · call_outcome · call_type(B2B/persona/order/repeat) · deal_readiness · payment · language from calls[].extraction (n8n v18 audio nodes now do full structured extraction per the Go call-extractor, not just transcription); transcript_en kept as fallback for old pulls. v24: PROMPT HYGIENE — glossary hoisted to TOP (GLID/MCAT/ISQ/RFQ/KYB/GSTIN/PAN/Udyam/CSL/PNS/telecom-circle/buyer-vs-our-turns defined BEFORE first use) + 2 new global rules: SYNTHESIZE-don't-ECHO (reconcile ≥2 sources, never restate one field verbatim) + NAME-THE-VENDOR (cite Befisc vs Sign3 specifically, never generic "external"). web_osint REFRAMED from "LOW-CONFIDENCE/cap-45" → "may contain garbage → VERIFY each field vs a hard anchor (GST/Udyam/PAN name·person·city+address·nature/NIC) → matches=use / mismatches=discard-namesake / can't-tell=unverified-lead; state the verify-verdict; prefer higher-authority citations; never override KYB". composeWebOsint now reads basis[]/proofs[] → each web fact carries its SOURCE URL + excerpt + engine confidence to the LLM (#11). v23: NOISE-STRIP + curated composers for csl/external/identity/pns (was generic-flatten leaking custtype_weight/location_preference/internal ids) + widened SKIP_KEY + 3 global rules: TIMELINE time-proximity (calls/WA/CSL nearest the requirement = context around the offer), NUMBERS signal-vs-noise (only phone/spec/qty/rate/date/tenure/pincode/PAN/GST/agreement — rest ignored), SELLER-GLID (custtype/listing → seller-also-buying signal). v22: web_osint DOWNGRADED to LOW-confidence + STRICT corroboration-gate (use only when it matches a verified GST/Udyam/PAN/company-person/location anchor; else IGNORE — scraper conflates namesakes; never sets an attribute alone, never overrides KYB, caps ~45). v21: V16.2.1 Udyam/MSME source-def (Sign3 pan_to_udyam→udyam_verification) — enterprise_type=authoritative SIZE, NIC industry, org type, address triangulation. v20: V16.2 Web OSINT (Parallel.ai deep web-search) — digital footprint/scale/legitimacy source-def, corroboration + identity_confidence hardening, NEVER overrides KYB. v19: V16 Sign3 multi-vendor triangulation — mobiles/pan_union/gstin_union + gst_detail_union (3-vendor per-field consensus w/ agreement→confidence rubric, pan_advance entity authority, HSN→industry corroboration). v18: IDfy triangulation sources now LIVE end-to-end (backend v15 emits sources.pan_gst_idfy/gst_cert_idfy/epfo → dormant composers activate + 3 separate health nodes; prompt source-defs added v16). v17: PNS calls source — sourcing-basket (products/categories called about → persona/sub_industry; raw-material+machine ⇒ manufacturer), telecom circle = LOW-weight location triangulation, offer_id ⋈ BuyLead, transcript = spoken intent (matched to requirement → UC2). v16: IDfy triangulation source-defs — PAN→GST (multi-state=scale/B2B) · GST Certificate (2nd KYB source; agree-with-Befisc ⇒ high conf; drives b2b_b2c/retail_wholesale/sub_industry + filing compliance) · EPFO (registered-employer size proxy). v15: PAN/GSTIN 4th-char entity → b2b_b2c classifier (C/F/T/H ⇒ B2B high-conf; P ⇒ lean B2C hint, not proof) + retail_wholesale entity tie-breaker. v14: VERIFIED-ADDRESS LOCK — a Befisc/Sign3/GST address that AGREES with the registered Profile city CONFIRMS it & blocks the operating-city flip; a vague PNS "near the seller" is a sourcing hint, NEVER overrides two agreeing addresses (fixes Auraiya→Kanpur misfire). v13: Call-recordings source-def (spoken intent, PNS-tier authority; nearest-dated call → UC2) + composeCalls rich transcript lines. v12: Befisc GST (Advanced) source-def — GSTIN record ⇒ B2B + established + role(business_nature) + sub_industry(SAC desc) + hard operating-city + filing cadence. v11: §C — `sources` must use the closed clean catalog (never "external"/"profile") + bundle routes merged-external fields to Befisc/Sign3 by field name. v10: §D recurring 7-day guard (re-post <7d = re-search, not recurring) · purchase_frequency scoped to the requirement · §H "Preferred sourcing city" · §I strip is_expired from bundle + ban "expired" in reasoning · §J2 retail_wholesale (per-req product+qty, 66% rollup) · §J3 b2b_b2c (PNS b2b_or_b2c else persona). v9: location — telecom SIM circle = low-weight location hint; ≥2 converged buyer signals override the (weak) registered Profile city as operating. v8: simple INDIA-B2B English values+reasoning (professional, not casual/tacky, not Hindi — e.g. "early-stage manufacturer in <industry>") · v7: plain-English first pass · v6: per-attribute confidence_reason + to_100 (why this %, what would make it 100) · v5: PAN-entity ↔ persona reconciliation (Individual-PAN + Manufacturer → "early-stage/aspiring") · urgency back as a delivery_timeline FALLBACK (with explainer) · added payment_mode (explicit-only). v4: removed repeat_buyer/next_best/purchasing_power/urgency; added buyer_maturity/purchase_frequency/delivery_timeline/digital_footprint; WA location → evidence; expired = NEUTRAL

// the new n8n response shape (bi-user-insights): { glid, fetched_at, derived_anchors, sources:{ key:{summary,raw} } }
export interface RichResponse { glid?: string | number; fetched_at?: string; derived_anchors?: Record<string, unknown>; sources?: Record<string, { summary?: unknown; raw?: unknown } | unknown>; }
// one LLM attribute — a strict SUPERSET of SynthLLMOut's attribute (adds state/sources/evidence). reasoning_steps
// drive grounding exactly like the synthesis path, so the per-attribute reasoning drill + grounded badge work free.
export interface ExtractAttr { key: string; value: string; state?: BuyerFieldState; confidence: number; grounded?: boolean; sources?: string[]; evidence?: string[]; reasoning_steps?: Array<{ claim: string; from_evidence?: string[]; rejected?: string; delta?: number }>; confidence_reason?: string; to_100?: string; }
export interface ExtractBuyerProfileOut { attributes: ExtractAttr[] }
export type BuyerFieldState = 'Confirmed' | 'Likely' | 'Conflicted' | 'Unknown';

// human label for each source key (for the catalog + evidence display)
const SRC_LABEL: Record<string, string> = {
  csl: 'CSL · on-site behaviour', pns: 'PNS · sales calls (spoken)', rfq: 'Previous BuyLeads', isq: 'Previous ISQ specs',
  whatsapp_conversations: 'WhatsApp (buyer messages = signal · ours = context)', whatsapp_inbound: 'WhatsApp inbound',
  profile: 'IndiaMART Buyer Profile', usersince: 'GLUSR (tenure)', befisc: 'Befisc · external identity', sign3: 'Sign3 · external trust', gst: 'Befisc GST (KYB)',
  // V10 (owner): the n8n now merges the redundant feeds + triangulates identity before the LLM ever sees them
  requirement: 'Requirement · BuyLeads + answered-ISQ pool (status · recency · category-named)', whatsapp: 'WhatsApp · one timeline (buyer = signal · ours = context)',
  identity: 'IndiaMART Buyer Profile · triangulated name/location/income (Profile ⊕ Befisc ⊕ Sign3)',
  external: 'External · Befisc/Sign3', ext: 'External · Befisc/Sign3',
  calls: 'Call recordings (transcribed)',
  pns_calls: 'PNS calls · sellers called (products · circle · offer_id) + transcribed',
  pan_gst_idfy: 'IDfy PAN→GST (registrations)', gst_cert_idfy: 'IDfy GST Certificate (KYB)', epfo: 'IDfy EPFO (employer)',
  // V16 — Sign3 multi-vendor triangulation union sources (provenance at every hop)
  mobiles: 'Mobiles · triangulated (Profile ⊕ Befisc ⊕ Sign3)', pan_union: 'PAN union (Sign3 ⊕ Befisc) + entity', gstin_union: 'GSTIN union (Sign3 ⊕ IDfy ⊕ Befisc)', gst_detail_union: 'GST detail · 3-vendor consensus',
  web_osint: 'Web OSINT · Parallel.ai (footprint · scale · legitimacy)',
  udyam: 'Udyam · MSME registry (size · NIC industry · org)',
};
// §C — when the feed merges Befisc+Sign3 into ONE "external" source, route EACH evidence line to its true origin by
// field name so "won via external" becomes "won via Sign3" / "won via Befisc" (no ambiguous source ever survives).
// Sign3 = digital-footprint/trust (social, telecom circle, breaches, bank-verified name); Befisc = KYB identity
// (income, PAN, address, DOB, gender). Anything we can't attribute stays the labelled combined "External · Befisc/Sign3".
const SIGN3_FIELD = /social|flipkart|facebook|instagram|linkedin|twitter|platform|circle|telecom|operator|breach|bank.?verified|footprint|maps_review|trust/i;
const BEFISC_FIELD = /income|pan\b|address|dob|date_of_birth|gender|\bage\b|personal_info|document|alternate_phone|kyb/i;
function nodeLabel(src: string, tag: string): string {
  if (src === 'external' || src === 'ext') {
    if (SIGN3_FIELD.test(tag)) return SRC_LABEL.sign3;
    if (BEFISC_FIELD.test(tag)) return SRC_LABEL.befisc;
    return SRC_LABEL.external;
  }
  return SRC_LABEL[src] || src;
}
// plumbing/meta keys inside summaries that are not buyer evidence. v23: widened to strip the numeric NOISE the owner
// flagged — internal IDs, weights, status codes, byte-lengths, txn/uc/request ids, resolved-away raw IDs (_debug_ids,
// stateid, cityid → names already surfaced), account tenure timestamps. KEPT (never matched here): phone, spec numbers,
// quantities/rates, timeline dates, tenure_years, pincode/zip, PAN/GST, offer_id (links a call to a BuyLead), agreement_count.
// v26 (re-audit ZERO-VALUE-NOISE fix): added _meta / __health (whole plumbing subtrees) + the row-count / vendor-list /
// run-id / basis-count scaffolding that was leaking into the citable fN set as pure noise + hallucination bait.
const SKIP_KEY = /^(observed_only|txn_id|api_category|api_name|billable|datetime|message|parse_ok|parse_error|status|status_code|fetched_at|glid|csl_activity|.*weight|glusr_usr_id|glusr_usr_custtype_id|custtype_id|location_preference|http_status|http|audio_bytes|b64_len|mime|serial_number|pwncount|page_index|page_size|execution|_debug_ids|stateid|cityid|fk_.*|last_login|last_modified|unique_id|request_id|uc_id|interaction_id|created_at|modified_at|is_active|revocations|_meta|__health|__raw|contacts_tried|basis_count|proofs_count|fields_returned|run_id|agreement_max|returned|requested|version|error_msg|vendors|node)$/i;

// ── flatten a source SUMMARY into citable evidence lines (pure structural — NO regex extraction) ──
function flattenInto(node: unknown, src: string, path: string, push: (src: string, tag: string, raw: unknown) => void): void {
  if (node == null || node === '' || node === false) return;
  if (Array.isArray(node)) {
    node.forEach((el, i) => {
      if (el && typeof el === 'object') flattenInto(el, src, path ? `${path}[${i}]` : `[${i}]`, push);
      else if (el != null && el !== '') push(src, path || 'item', el);
    });
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) { if (SKIP_KEY.test(k)) continue; flattenInto(v, src, path ? `${path}.${k}` : k, push); }
    return;
  }
  push(src, path || 'value', node);
}

// ── SELF-DESCRIBING composers (owner: "f44='true' is useless — i don't see all my intended data here") ──
// The generic structural walk exploded each requirement/timeline turn into bare leaf scalars ("true", "30",
// "21-MAY-26") that carry no context. For the two merged sources the buyer profile leans on most, emit ONE rich,
// human-readable line per unit so a single cited fN carries ALL the intended data (title · category · status ·
// expiry · recency · specs · note for a lead; sender · kind · text for a WhatsApp turn). Everything else still
// uses flattenInto. This makes both the LLM input AND the L5 citation drill legible.
const _obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const _arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const _s = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();

function composeRequirements(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const reqs = _arr(sum.requirements);
  if (!reqs.length) return false; // v9.5 shape (items/answered_specs) → let flattenInto handle it
  reqs.forEach((it, i) => {
    const r = _obj(it);
    const title = _s(r.title) || _s(r.category) || 'requirement';
    const parts: string[] = [`BuyLead "${title}"`];
    if (_s(r.category) && _s(r.category) !== title) parts.push(`category ${_s(r.category)}`);
    // V10 §I: is_expired / expiry date are NOT passed to the LLM (expiry is not an intent signal). Keep only
    // liveness-neutral status (drop any literal "expired") + recency. An older lead's CONTENT stays usable memory.
    const status = _s(r.status);
    if (status && !/expired/i.test(status)) parts.push(`status ${status}`);
    if (r.recency_days != null && _s(r.recency_days)) parts.push(`age ${_s(r.recency_days)}d`);
    if (_s(r.posted)) parts.push(`posted ${_s(r.posted)}`);
    const specs = _obj(r.specs); const specStr = Object.entries(specs).map(([k, v]) => `${k}=${_s(v)}`).filter((x) => !/=$/.test(x)).join(', ');
    if (specStr) parts.push(`specs: ${specStr}`);
    // V10 §J2: surface quantity explicitly (retail-vs-wholesale needs product + qty) when carried outside specs
    if (_s(r.quantity)) parts.push(`qty ${_s(r.quantity)}`);
    if (_s(r.description)) parts.push(`note: "${_s(r.description)}"`);
    push(src, `requirement[${i}]`, parts.join(' · '));
  });
  // deterministic products-of-interest (BuyLead titles + answered-ISQ categories) as ONE line the LLM confirms
  const poi = _arr(sum.products_of_interest).map(_s).filter(Boolean);
  if (poi.length) push(src, 'products_of_interest', poi.join(' · '));
  const counts: string[] = [];
  if (sum.active_count != null) counts.push(`active ${_s(sum.active_count)}`);
  if (sum.total_count != null || sum.count != null) counts.push(`total ${_s(sum.total_count ?? sum.count)}`);
  if (counts.length) push(src, 'requirement_counts', counts.join(' · '));
  return true;
}

function composeWhatsApp(summary: unknown, rawNode: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  // v20 audit fix (P0): the merged n8n shape keeps the full 49-turn thread at whatsapp.raw.timeline, NOT summary.timeline
  // — so this used to fall through to flattenInto and the buyer's actual messages NEVER reached the LLM. Fall back to raw.
  const tl = _arr(sum.timeline).length ? _arr(sum.timeline) : _arr(_obj(rawNode).timeline);
  if (!tl.length) return false; // legacy shape → flattenInto
  tl.forEach((t, i) => {
    const o = _obj(t);
    const text = _s(o.text); if (!text) return;
    const side = /buyer|user/i.test(_s(o.side) || _s(o.sender)) ? 'buyer' : 'ours';  // raw.timeline uses `sender`, summary uses `side`
    const kind = _s(o.kind) || 'message';
    const ts = _s(o.ts) ? ` @${_s(o.ts)}` : '';
    push(src, `wa[${i}]·${side}`, `[${side} · ${kind}${ts}] "${text}"${side === 'ours' ? '  (OUR outbound — context only, NOT buyer intent)' : ''}`);
  });
  const taps = _arr(sum.button_taps).map(_s).filter(Boolean);
  if (taps.length) push(src, 'button_taps', `buyer tapped: ${taps.join(' · ')}`);
  const enq = _arr(sum.products_enquired).map(_s).filter(Boolean);
  if (enq.length) push(src, 'products_enquired', `buyer enquired: ${enq.join(' · ')}`);
  // WhatsApp LOCATION → first-class evidence (owner: WA location must reach the LLM, not stay buried in raw turns).
  // buyer-stated location / "Located near me" / sourcing hints + the cities of sellers the buyer engaged with.
  const loc = _arr(sum.location_preference).map(_s).filter(Boolean);
  if (loc.length) push(src, 'location_preference', `buyer location / sourcing hint(s): ${loc.join(' · ')}`);
  const sc = _arr(sum.seller_cities).map(_s).filter(Boolean);
  if (sc.length) push(src, 'seller_cities', `cities of sellers the buyer engaged: ${sc.join(' · ')}`);
  const c = _obj(sum.counts);
  if (Object.keys(c).length) push(src, 'wa_counts', Object.entries(c).map(([k, v]) => `${k} ${_s(v)}`).join(' · '));
  return true;
}

// V11 calls — one rich line per TRANSCRIBED call recording (date · topic · full transcript). Spoken buyer intent
// (high authority, like PNS); the call nearest a requirement's date is also date-matched into UC2. No line cap
// (owner) — the full transcript reaches the LLM. Falls back to flattenInto if the calls shape is absent.
// v18: calls now carry a STRUCTURED extraction (Go call-schema: products/specs/price/qty · lead_tag · payment ·
// metadata{buyer_intent · call_outcome · call_type B2B/persona/order · language · application}). This emits one rich
// evidence line per signal — spoken buyer-seller call = HIGH authority. Falls back to a raw transcript on old pulls.
function emitCallExtraction(o: Record<string, unknown>, src: string, i: number, prefix: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const ex = _obj(o.extraction); if (!Object.keys(ex).length) return false;
  const date = _s(o.date) ? ` (${_s(o.date)})` : '';
  const md = _obj(ex.metadata);
  _arr(ex.products).forEach((p, pi) => {
    const po = _obj(p); const nm = _s(po.product_name); if (!nm) return;
    const specs = _arr(po.specifications).map((sp) => { const so = _obj(sp); return _s(so.name) && _s(so.value) ? `${_s(so.name)}: ${_s(so.value)}${_s(so.unit) ? ' ' + _s(so.unit) : ''}` : ''; }).filter(Boolean);
    const qy = _obj(po.quantity_required); const q = _s(qy.value) ? `qty ${_s(qy.value)}${_s(qy.unit) ? ' ' + _s(qy.unit) : ''}` : '';
    const pr = _obj(po.price); const price = _s(pr.value) ? `rate ${_s(pr.value)}${_s(pr.currency) ? ' ' + _s(pr.currency) : ''}${_s(pr.price_unit) ? '/' + _s(pr.price_unit) : ''}` : '';
    const bits = [specs.length ? `specs ${specs.join(' · ')}` : '', q, price].filter(Boolean);
    push(src, `${prefix}_product[${i}.${pi}]`, `Spoken call${date} — product: ${nm}${bits.length ? ' — ' + bits.join(' · ') : ''} [buyer-seller call, HIGH authority]`);
  });
  const bi = _obj(md.buyer_intent); if (_s(bi.intent_level) || _s(bi.narrative)) push(src, `${prefix}_intent[${i}]`, `Call${date} buyer intent: ${_s(bi.intent_level)}${_s(bi.narrative) ? ` — ${_s(bi.narrative)}` : ''}${_s(bi.reasoning) ? ` (${_s(bi.reasoning)})` : ''}`);
  const co = _obj(md.call_outcome); if (_s(co.category)) push(src, `${prefix}_outcome[${i}]`, `Call${date} outcome: ${_s(co.category)}${_s(co.conclusion_notes) ? ` — ${_s(co.conclusion_notes)}` : ''}`);
  const ct = _obj(md.call_type); const ev = _obj(ct.evidence); const persona = _obj(ev.buyer_persona); const ot = _obj(ev.order_type);
  const ctBits = [_s(ct.type), _s(persona.persona_category) && `persona ${_s(persona.persona_category)}${_s(persona.persona_detail) ? ` (${_s(persona.persona_detail)})` : ''}`, _s(ev.quantity_scale) && `qty-scale ${_s(ev.quantity_scale)}`, _s(ot.order_type_category) && `order ${_s(ot.order_type_category)}`, ev.repeat_buyer === true && 'repeat buyer'].filter(Boolean);
  if (ctBits.length) push(src, `${prefix}_class[${i}]`, `Call${date} classification: ${ctBits.join(' · ')}${_s(ct.reason) ? ` — ${_s(ct.reason)}` : ''}`);
  const ia = _s(md.intended_application); if (ia) push(src, `${prefix}_use[${i}]`, `Call${date} intended application: ${ia}`);
  const lt = _obj(ex.lead_tag); if (_s(lt.deal_readiness)) push(src, `${prefix}_lead[${i}]`, `Call${date} deal readiness: ${_s(lt.deal_readiness)}${_s(lt.deal_readiness_reason) ? ` — ${_s(lt.deal_readiness_reason)}` : ''}`);
  const pay = _obj(ex.payment); if (_s(pay.payment_mode)) push(src, `${prefix}_pay[${i}]`, `Call${date} payment mode (stated): ${_s(pay.payment_mode)}${_s(pay.payment_details) ? ` — ${_s(pay.payment_details)}` : ''}`);
  if (_s(md.primary_language)) push(src, `${prefix}_lang[${i}]`, `Call${date} language: ${_s(md.primary_language)}`);
  return true;
}
// transcript fallback (old-shape pulls) — one line per call
function emitCallTranscript(o: Record<string, unknown>, src: string, i: number, tag: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const te = o.transcript_en;
  const t = Array.isArray(te)
    ? te.map((x) => { const xo = _obj(x); const u = _s(xo.utterance); return u ? `${_s(xo.speaker) || 'Speaker'}: ${u}` : ''; }).filter(Boolean).join('\n')
    : (_s(te) || _s(o.transcript) || _s(o.text));
  if (!t) return false;
  const date = _s(o.date) ? `${_s(o.date)} · ` : '';
  push(src, tag, `Call ${date}transcript${_s(o.language) ? ` [${_s(o.language)}]` : ''}: "${t}"`);
  return true;
}
function composeCalls(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const calls = _arr(sum.calls);
  if (!calls.length) return false;
  calls.forEach((c, i) => { const o = _obj(c); if (!emitCallExtraction(o, src, i, 'call', push)) emitCallTranscript(o, src, i, `call[${i}]`, push); });
  if (_s(sum.brief)) push(src, 'calls_brief', _s(sum.brief));
  return true;
}

// V14 PNS calls — the buyer's masked-number seller calls. Rich metadata (product/category/circle/offer_id/date) is a
// sourcing-basket + location signal EVEN without a transcript; the transcript (when present) is spoken intent. offer_id
// links a call to a BuyLead (requirement). Circle is a LOW-weight regional location hint.
function composePnsCalls(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const calls = _arr(sum.calls);
  if (!calls.length) return false;
  calls.forEach((c, i) => {
    const o = _obj(c);
    const product = _s(o.product); const mcat = _s(o.mcat); const subcat = _s(o.subcat);
    const circle = _s(o.circle); const date = _s(o.date); const offer = _s(o.offer_id);
    const bits: string[] = [];
    if (product) bits.push(`product called about: ${product}`);
    if (mcat) bits.push(`category: ${mcat}${subcat && subcat !== mcat ? ` / ${subcat}` : ''}`);
    if (offer) bits.push(`offer_id ${offer} (links to a BuyLead requirement)`);
    if (date) bits.push(`on ${date}`);
    if (bits.length) push(src, `pns_call[${i}]`, `PNS seller call — ${bits.join(' · ')} (sourcing-basket signal)`);
    if (circle) push(src, `pns_circle[${i}]`, `Caller telecom circle = ${circle} (region — LOW-weight location hint, never overrides an agreeing city)`);
    // v18: structured extraction (Go call-schema) when present; else the raw transcript (old-shape pulls)
    if (!emitCallExtraction(o, src, i, 'pns', push)) emitCallTranscript(o, src, i, `pns_transcript[${i}]`, push);
  });
  if (_s(sum.brief)) push(src, 'pns_calls_brief', _s(sum.brief));
  return true;
}

// v23 IDENTITY — curated (was generic-flatten, which leaked custtype_weight/location_preference/internal ids as noise).
// Emits only buyer-meaningful lines + the SELLER signal (owner: "if it's a seller GLID, custtype is important").
function composeIdentity(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  if (!Object.keys(s).length) return false;
  const name = _s(s.name); const company = _s(s.company); const desig = _s(s.designation); const ceo = _s(s.ceo_name);
  const loc = [_s(s.city), _s(s.district), _s(s.state)].filter(Boolean).join(', ');
  const idBits: string[] = [];
  if (name) idBits.push(`name: ${name}`);
  if (company) idBits.push(`company: ${company}`);
  if (desig) idBits.push(`designation: ${desig}`);
  if (ceo && ceo.toLowerCase() !== name.toLowerCase()) idBits.push(`CEO/owner: ${ceo}`);
  if (loc) idBits.push(`registered location: ${loc}`);
  if (idBits.length) push(src, 'identity', `Registered IndiaMART profile — ${idBits.join(' · ')}`);
  const since = _s(s.member_since); const ty = _s(s.tenure_years);
  if (since || ty) push(src, 'tenure', `Member since ${since || '?'}${ty ? ` (~${ty} years on IndiaMART)` : ''}`);
  // SELLER signal — custtype / listing status. A GLID that is ALSO a listed seller changes how we read intent.
  const ct = _s(s.glusr_usr_custtype_name) || _s(s.custtype_name);
  const listing = _s(s.listing_status); const paid = _s(s.is_paid);
  const isSeller = /lst|empfcp|fcp|seller|listed/i.test(`${ct} ${listing}`);
  const acctBits = [ct && `custtype ${ct}`, listing && `listing ${listing}`, paid].filter(Boolean);
  if (acctBits.length) push(src, 'account_type', `Account: ${acctBits.join(' · ')}${isSeller ? ' — THIS GLID IS ALSO A LISTED SELLER (its sourcing may be raw material for resale/manufacture, or competitor research — weigh intent accordingly)' : ''}`);
  const emails = _arr(s.emails).map(_s).filter(Boolean); if (emails.length) push(src, 'emails', `email(s): ${emails.join(', ')}`);
  const mobiles = _arr(s.mobiles).map(_s).filter(Boolean); if (mobiles.length) push(src, 'mobiles', `mobile(s): ${mobiles.join(', ')}`);
  const pan = _s(s.pan); if (pan) push(src, 'pan', `PAN on profile: ${pan}`);
  const gst = _s(s.gst); if (gst) push(src, 'gst', `GST on profile: ${gst}`);
  return true;
}

// v23 CSL — curated on-site browsing (was generic-flatten, which leaked glid/_debug_ids/raw counts). IDs already
// resolved to category/city NAMES upstream (Redash); we emit the names + activity, drop the raw ids.
function composeCsl(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  if (!Object.keys(s).length) return false;
  if (_s(s.brief)) push(src, 'csl_brief', _s(s.brief));
  const channel = _s(s.channel); if (channel) push(src, 'channel', `on-site channel/device: ${channel}`);
  const acct = _s(s.account_status);
  if (acct) push(src, 'account_status', `account: ${acct}${s.also_a_seller === true ? ' — ALSO A SELLER (browsing may be sourcing-for-resale or competitor research)' : ''}`);
  const w = _obj(s.window); const sup = _obj(s.suppliers);
  const actBits = [
    _s(w.sessions) && `${_s(w.sessions)} session(s)`,
    _s(sup.profile_visits) && _s(sup.profile_visits) !== '0' && `${_s(sup.profile_visits)} supplier-profile visits`,
    _s(w.from) && _s(w.to) && `window ${_s(w.from)}→${_s(w.to)}`,
  ].filter(Boolean);
  if (actBits.length) push(src, 'activity', `browsing: ${actBits.join(' · ')}`);
  const cats = _arr(s.categories).map(_s).filter(Boolean); if (cats.length) push(src, 'categories', `categories browsed: ${cats.join(' · ')}`);
  const cities = _arr(s.cities_resolved).map(_s).filter(Boolean); if (cities.length) push(src, 'cities', `cities browsed: ${cities.join(' · ')}`);
  _arr(s.evidence).forEach((e, i) => { const o = _obj(e); const t = _s(o.type); const v = _s(o.value); const cnt = _s(o.count); if (t) push(src, `csl_ev[${i}]`, `${t.replace(/_/g, ' ')}${v ? `: ${v}` : ''}${cnt && cnt !== '0' ? ` (×${cnt})` : ''}`); });
  return true;
}

// v23 EXTERNAL — curated Befisc⊕Sign3 identity/trust (was generic-flatten of the summary). Collapses the 30-platform
// boolean maps to a social list + drops breach/serial internals. Cross-source-verified name is a high-trust signal.
function composeExternal(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  if (!Object.keys(s).length) return false;
  const vn = _s(s.verified_name);
  if (vn) { const srcv = _s(s.verified_name_source); const conf = _s(s.verified_name_confidence); const xm = s.name_cross_source_match === true; push(src, 'verified_name', `Verified name: ${vn}${srcv || conf ? ` (${[srcv, conf && `${conf} confidence`].filter(Boolean).join(', ')})` : ''}${xm ? ' — cross-source matched: Befisc & Sign3 agree' : ''}`); }
  // NAME CONFLICT — Sign3-bank name vs Befisc name disagree. The LLM must NOT treat either as canonical; cross-check
  // against GST legal_name / PAN holder. (GLID 22642257: sign3 "Niti Kapoor" vs befisc "AKASH KAPOOR" — GST says AKASH.)
  const befiscName = _s(s.befisc_name);
  if (befiscName && vn && s.name_cross_source_match === false && befiscName.toLowerCase() !== vn.toLowerCase()) {
    push(src, 'name_conflict', `⚠ NAME CONFLICT — Sign3 verified "${vn}" but Befisc returned "${befiscName}"; cross-source match FAILED. Do NOT treat either as the canonical buyer name — reconcile against the GST legal_name / PAN holder, and LOWER identity_confidence.`);
  }
  const pan = _s(s.pan); if (pan) push(src, 'pan', `PAN (external-verified): ${pan}`);
  const g = _s(s.gender); const age = _s(s.age); if (g || age) push(src, 'demographics', `${[g, age && `age ${age}`].filter(Boolean).join(' · ')}`);
  const inc = _s(s.income_band); if (inc) push(src, 'income_band', `income band: ₹${inc} (external estimate)`);
  const fa = _s(_obj(s.location).full_address); if (fa) push(src, 'ext_address', `external address on file: ${fa}`);
  const sp = _arr(s.social_platforms).map(_s).filter(Boolean); const spc = _s(s.social_presence_count);
  if (sp.length) push(src, 'social', `digital footprint: ${sp.join(', ')}${spc ? ` (${spc} platform accounts)` : ''}`);
  const circle = _s(s.telecom_sim_circle); if (circle) push(src, 'telecom_circle', `telecom SIM circle: ${circle} (region — LOW-weight location hint, never overrides an agreeing city)`);
  // P3 (#12): Sign3 email-linked Google-Maps contributor profile — a real digital-footprint signal (was dropped upstream).
  const gmb = _obj(s.google_business); if (_s(gmb.name) || _s(gmb.url) || _s(gmb.ratings) || _s(gmb.reviews)) push(src, 'google_maps', `Google Maps profile: ${[_s(gmb.name) && `"${_s(gmb.name)}"`, _s(gmb.level) && `level ${_s(gmb.level)}`, _s(gmb.ratings) && `${_s(gmb.ratings)} ratings`, _s(gmb.reviews) && `${_s(gmb.reviews)} reviews`, _s(gmb.url)].filter(Boolean).join(' · ')} [Sign3 — digital footprint, not the buyer's location]`);
  if (s.identity_verified === true) push(src, 'identity_verified', 'External identity verified — Befisc & Sign3 records both found');
  return true;
}

// v23 PNS (AI-distilled insights, distinct from pns_calls transcripts). Empty (call_count 0) → emit NOTHING (drop the
// "call_count: 0" noise line) but return true to skip the generic flatten. Non-empty → let flatten walk the insights.
function composePns(summary: unknown, errInfo: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  // v26 (re-audit PNS-401-SILENT fix): PNS is the #1-priority SPOKEN source. When its fetch FAILS (e.g. a 401 expired
  // token), the summary collapses to call_count:0 — which reads identically to "buyer made no calls". That silent
  // masquerade let a phantom top-priority rung sit in the conflict order. Emit an EXPLICIT unavailability line so the
  // LLM (and the reader) know it's a FETCH FAILURE, not absence — never infer "no phone activity" from a broken fetch.
  const err = _obj(errInfo); const errMsg = _s(err.message) || (Object.keys(err).length ? 'upstream error' : '');
  if (errMsg) { push(src, 'unavailable', `PNS spoken-call insights UNAVAILABLE this run — upstream error: ${errMsg.slice(0, 90)}. PNS is the buyer's HIGHEST-priority spoken-intent source; its absence here is a FETCH FAILURE, NOT evidence the buyer made no calls. Do NOT infer "no phone activity" or lower intent from this. (Fix: refresh the PNS token.)`); return true; }
  const cc = Number(s.call_count);
  if (!cc || cc <= 0) return true; // genuine no-calls (no error) → suppress noise, skip flatten
  return false; // real distilled insights present → generic flatten handles the rich fields
}

// V11 GST — clean evidence lines from the GSTIN + the GST-Advance registration record (sources.gst.advance), so the
// LLM reads role/industry/registration as plain lines (not nested leaf scalars). The deterministic ribbon reader is
// gstAdvance() in buyerDetails; this is the LLM-facing "parser". Falls back to flattenInto if neither is present.
function composeGst(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const gst = _s(sum.gst);
  const adv = _obj(sum.advance);
  if (!gst && !Object.keys(adv).length) return false;
  const cnt = Number(_s(sum.gst_count));
  if (gst) push(src, 'gstin', `GSTIN ${gst}${cnt > 1 ? ` (+${cnt - 1} more on file)` : ''}`);
  if (Object.keys(adv).length) {
    const parts: string[] = [];
    if (_s(adv.legal_name)) parts.push(`legal name "${_s(adv.legal_name)}"`);
    if (_s(adv.trade_name) && _s(adv.trade_name) !== _s(adv.legal_name)) parts.push(`trade name "${_s(adv.trade_name)}"`);
    if (_s(adv.business_constitution)) parts.push(`constitution ${_s(adv.business_constitution)}`);
    if (_s(adv.current_registration_status)) parts.push(`status ${_s(adv.current_registration_status)}`);
    if (_s(adv.tax_payer_type)) parts.push(`taxpayer ${_s(adv.tax_payer_type)}`);
    if (_s(adv.register_date)) parts.push(`registered ${_s(adv.register_date)}`);
    const nature = _arr(adv.business_nature).map(_s).filter(Boolean);
    if (nature.length) parts.push(`nature: ${nature.join(', ')}`);
    const pad = _obj(adv.primary_business_address);
    if (_s(pad.registered_address) && !/^na$/i.test(_s(pad.registered_address))) parts.push(`registered address ${_s(pad.registered_address)}`);
    const turn = _s(adv.aggregate_turn_over) || _s(adv.gross_total_income);
    if (turn && !/^na$/i.test(turn)) parts.push(`turnover ${turn}`);
    if (parts.length) push(src, 'gst_advance', `GST registration (verified KYB) — ${parts.join(' · ')}`);
    const hsn = _arr(adv.business_details).map((d) => { const o = _obj(d); return `${_s(o.saccd)} ${_s(o.sdes)}`.trim(); }).filter(Boolean);
    if (hsn.length) push(src, 'gst_hsn', `Dealing in (HSN/SAC → industry): ${hsn.join(' | ')}`);
    const sig = _arr(adv.authorized_signatory).map(_s).filter(Boolean);
    if (sig.length) push(src, 'gst_signatories', `authorized signatories: ${sig.join(', ')}`);
  }
  return true;
}

// V12 IDfy — three independent business-classification sources for TRIANGULATION with Befisc. Each is tolerant of
// the raw IDfy shape (result.source_output.*) AND the n8n-normalized shape. They emit clean fN lines so UC1 can
// cross-check Befisc-Advanced vs IDfy (agreement ⇒ high confidence). Fall back to flattenInto if the shape is absent.
const _idfyOut = (summary: unknown): Record<string, unknown> => { const s = _obj(summary); const r = _obj(s.result); const so = _obj(r.source_output); return Object.keys(so).length ? so : s; };
function composePanGstIdfy(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const so = _idfyOut(summary);
  const rows = _arr(so.gst_details);
  if (!rows.length && so.gst_associated_with_pan == null) return false;
  const gstins = rows.map((g) => { const o = _obj(g); return `${_s(o.gst_number)} (${_s(o.gstin_status) || '?'}${_s(o.state) ? ' · ' + _s(o.state) : ''})`; }).filter(Boolean);
  const states = [...new Set(rows.map((g) => _s(_obj(g).state)).filter(Boolean))];
  if (gstins.length) push(src, 'pan_gstins', `PAN → ${gstins.length} GST registration(s) [IDfy]: ${gstins.join(' · ')}${states.length > 1 ? ` — MULTI-STATE (${states.length}: ${states.join(', ')}) ⇒ scale/B2B` : ''}`);
  else push(src, 'pan_gst_none', `PAN → no GST registrations found [IDfy] (gst_associated_with_pan=${_s(so.gst_associated_with_pan)})`);
  return true;
}
function composeGstCertIdfy(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  // n8n-normalized: summary.certificates[]; else a single source_output
  const certs = _arr(s.certificates).length ? _arr(s.certificates) : [ _idfyOut(summary) ];
  let emitted = false;
  certs.forEach((c, i) => {
    const o = _obj(c);
    if (!_s(o.gstin) && !_s(o.legal_name)) return;
    emitted = true;
    const nature = _arr(o.nature_of_business_activity).map(_s).filter(Boolean);
    const parts: string[] = [`GST cert [IDfy] ${_s(o.gstin)}`];
    if (_s(o.legal_name)) parts.push(`legal "${_s(o.legal_name)}"`);
    if (_s(o.trade_name) && _s(o.trade_name) !== _s(o.legal_name)) parts.push(`trade "${_s(o.trade_name)}"`);
    if (_s(o.constitution_of_business)) parts.push(`constitution ${_s(o.constitution_of_business)}`);
    if (_s(o.taxpayer_type)) parts.push(`taxpayer ${_s(o.taxpayer_type)}`);
    if (_s(o.gstin_status)) parts.push(`status ${_s(o.gstin_status)}`);
    if (_s(o.date_of_registration)) parts.push(`registered ${_s(o.date_of_registration)}`);
    if (nature.length) parts.push(`nature: ${nature.join(', ')}`);
    push(src, `cert[${i}]`, parts.join(' · '));
    const filing = _arr(o.filing_details);
    if (filing.length || o.filing_details) push(src, `cert_filing[${i}]`, `GST filing history present [IDfy] for ${_s(o.gstin)} — compliance signal (regular recent filings ⇒ live business)`);
  });
  return emitted;
}
function composeEpfo(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const so = _idfyOut(summary);
  const dets = _arr(so.details).length ? _arr(so.details) : _arr(_obj(summary).establishments);
  if (!dets.length) return false;
  dets.forEach((d, i) => {
    const o = _obj(d);
    const parts = [`EPFO employer [IDfy]: ${_s(o.establishment_name)}`];
    if (_s(o.ownership_type)) parts.push(`ownership ${_s(o.ownership_type)}`);
    if (_s(o.business_activity)) parts.push(`activity ${_s(o.business_activity)}`);
    if (_s(o.working_status)) parts.push(`status ${_s(o.working_status)}`);
    if (_s(o.state)) parts.push(_s(o.state));
    push(src, `epfo[${i}]`, parts.filter(Boolean).join(' · ') + ' — registered employer ⇒ formal org / has staff (B2B-leaning, size proxy)');
  });
  return true;
}

// V16 Sign3 multi-vendor triangulation — one rich fN line per FACT carrying every source (so one evidence id = fact × N vendors,
// never N duplicate lines). Provenance (found_by) rides each line; agreement is stated explicitly so the LLM grounds confidence.
function composeMobiles(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const rows = _arr(_obj(summary).rows);
  if (!rows.length) return false;
  rows.forEach((r, i) => { const o = _obj(r); const m = _s(o.mobile); if (!m) return; const fb = _arr(o.found_by).map(_s).filter(Boolean);
    const tag = fb.length >= 3 ? ' ⇒ TRIPLE-verified' : fb.length >= 2 ? ' ⇒ verified (2 sources)' : ' (single source)';
    push(src, `mobile[${i}]`, `Phone ${m}${o.is_primary ? ' (primary)' : ''} — found by ${fb.join(', ') || '?'}${tag}`);
  });
  return true;
}
function composePanUnion(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary); const rows = _arr(s.rows); if (!rows.length) return false;
  const adv = _arr(_obj(_obj(s.advance).summary).pan_advance);
  rows.forEach((r, i) => { const o = _obj(r); const pan = _s(o.pan); if (!pan) return; const fb = _arr(o.found_by).map(_s).filter(Boolean);
    const a = _obj(adv.find((x) => _s(_obj(x).pan) === pan)); const authType = _s(a.pan_type);
    const ent = authType || _s(o.entity_type_hint);
    const parts = [`PAN ${pan} — found by ${fb.join(', ') || '?'}${fb.length >= 2 ? ' (double-verified)' : ''}`];
    if (ent) parts.push(`entity ${ent}${authType ? ' [NSDL-authoritative pan_type]' : ' [PAN 4th-char, fallback]'}`);
    if (_s(a.fullname)) parts.push(`name ${_s(a.fullname)}`);
    if (_s(a.is_sole_proprietor) && _s(a.is_sole_proprietor) !== 'N') parts.push('sole-proprietor');
    if (_s(a.is_director) && _s(a.is_director) !== 'N') parts.push('company-director');
    push(src, `pan[${i}]`, parts.join(' · '));
  });
  return true;
}
function composeGstinUnion(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary); const per = _arr(s.per); if (!per.length) return false;
  const states = [...new Set(per.map((p) => _s(_obj(p).state)).filter(Boolean))];
  per.forEach((p, i) => { const o = _obj(p); const gstin = _s(o.gstin); if (!gstin) return; const fb = _arr(o.found_by).map(_s).filter(Boolean);
    push(src, `gstin[${i}]`, `GSTIN ${gstin}${_s(o.state) ? ' · ' + _s(o.state) : ''}${_s(o.gstin_status) ? ' · ' + _s(o.gstin_status) : ''} — discovered by ${fb.join(', ') || '?'}${fb.length >= 2 ? ' (multi-vendor)' : ''}`);
  });
  if (states.length > 1) push(src, 'gstin_multistate', `${per.length} GSTIN(s) across ${states.length} states (${states.join(', ')}) ⇒ scale / B2B`);
  return true;
}
function composeGstDetailUnion(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const dets = _arr(_obj(summary).gst_details); if (!dets.length) return false;
  const canonStr = (v: unknown) => Array.isArray(v) ? (v as unknown[]).map(_s).filter(Boolean).join(', ') : _s(v);
  dets.forEach((d) => { const o = _obj(d); const G = _s(o.gstin); const fields = _obj(o.fields);
    Object.keys(fields).forEach((f) => { const fv = _obj(fields[f]); const vbv = _obj(fv.values_by_vendor); const vendors = Object.keys(vbv); if (!vendors.length) return;
      const label = f.replace(/_/g, ' ');
      if (fv.all_agree === true && vendors.length >= 2) push(src, `${G}:${f}`, `${label} = "${canonStr(fv.canonical)}" [GSTIN ${G}] — ✓✓ ${vendors.length} vendors AGREE (${vendors.join(' + ')}) ⇒ high confidence`);
      else if (vendors.length === 1) push(src, `${G}:${f}`, `${label} = "${canonStr(vbv[vendors[0]])}" [GSTIN ${G}] — single-source (${vendors[0]}) ⇒ usable, note single-source`);
      else { const pairs = vendors.map((v) => `${v}: "${canonStr(vbv[v])}"`).join(' vs '); push(src, `${G}:${f}`, `${label} [GSTIN ${G}] — ⚠ vendors DISAGREE: ${pairs} — arbitrate from buyer-behaviour evidence only`); }
    });
  });
  return true;
}

// #11 — build a per-field citation map from Parallel's basis[] (source URL + quoted excerpt + engine confidence).
// Handles BOTH the raw basis[] shape ({field, citations:[{url,excerpts[]}], confidence}) AND the n8n-distilled
// proofs[] shape ({field, url, excerpt, confidence}) so it keeps working after the P3 websearch-parse change.
function webCiteMap(basisOrProofs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const arr = Array.isArray(basisOrProofs) ? basisOrProofs : [];
  for (const b of arr) {
    const o = _obj(b); const field = _s(o.field); if (!field) continue;
    let url = _s(o.url); let ex = _s(o.excerpt); // flat proofs[] shape (P3 websearch-parse)
    if (!url && !ex) { const c0 = _obj(_arr(o.citations)[0]); url = _s(c0.url); ex = _arr(c0.excerpts).map(_s).filter(Boolean)[0] || ''; } // raw basis[] shape
    ex = ex.replace(/^\(last verified:[^)]*\)\s*/i, '').replace(/\s+/g, ' ').trim();
    if (ex.length > 160) ex = ex.slice(0, 157) + '…';
    const conf = _s(o.confidence);
    const bits = [url && `src ${url}`, ex && `"${ex}"`, conf && `web-conf ${conf}`].filter(Boolean);
    if (bits.length) out[field] = ` [${bits.join(' · ')}]`;
  }
  return out;
}
// V16.2 Web/OSINT (Parallel.ai) — one fN evidence line per web fact, EACH carrying its CITATION (source URL + quoted
// excerpt + the engine's confidence) so the LLM can VERIFY the field against an anchor and weigh source authority
// (#11 · verify-then-use). Web is corroboration + digital-footprint / scale / legitimacy; it NEVER overrides KYB.
function composeWebOsint(summary: unknown, basis: unknown, meta: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary);
  if (!Object.keys(s).length) return false;
  const cm = webCiteMap(basis);
  const cite = (f: string) => cm[f] || '';
  const emit = (tag: string, val: string) => { if (val && val.trim()) push(src, tag, val); };
  // v26: the fast-mode web engine (Gemini 2.5 Flash + Google Search grounding) SELF-REPORTS a match_confidence + which
  // anchors it matched (the Jaiveer test returned match_confidence:'none' + refused to fabricate a namesake). Surface
  // that verdict FIRST so the LLM weighs every web fact through the engine's own honesty (Amit's rule: never treat an
  // unconfirmed web hit as fact). Parallel-only pulls carry no match_confidence → the per-field "VERIFY vs anchor" still applies.
  const m = _obj(meta);
  const mc = _s(m.match_confidence); const matchedOn = _arr(m.matched_on).map(_s).filter(Boolean); const eng = _arr(m.web_engines).map(_s).filter(Boolean);
  if (mc) emit('web_match_verdict', `Web-engine self-report: match_confidence=${mc}${matchedOn.length ? ' (matched anchors: ' + matchedOn.join(', ') + ')' : ''}${eng.length ? ' · engine: ' + eng.join('+') : ''} — TRUST the web fields below ONLY per this verdict; match_confidence=none/low ⇒ likely a NAMESAKE, do NOT set any attribute from web.`);
  if (_s(s.business_type)) emit('web_business_type', `Web business type: ${_s(s.business_type)}${_s(s.industry) ? ' · ' + _s(s.industry) : ''} [web — VERIFY vs GST nature / persona before use]${cite('business_type')}`);
  else if (_s(s.industry)) emit('web_industry', `Web industry: ${_s(s.industry)} [web — VERIFY vs GST nature / Udyam NIC]${cite('industry')}`);
  if (_s(s.official_address)) emit('web_address', `Web official address: ${_s(s.official_address)} [web — cross-check vs GST registered address]${cite('official_address')}`);
  if (_s(s.website)) emit('web_website', `Website: ${_s(s.website)} [web — online presence]${cite('website')}`);
  const size = [_s(s.employee_count) && `employees ${_s(s.employee_count)}`, _s(s.turnover_estimate) && `turnover ${_s(s.turnover_estimate)}`, _s(s.year_established) && `established ${_s(s.year_established)}`].filter(Boolean).join(' · ');
  if (size) emit('web_scale', `Scale: ${size} [web — size / vintage signal]${cite('turnover_estimate') || cite('employee_count') || cite('year_established')}`);
  if (_s(s.udyam_number)) emit('web_udyam', `Udyam/MSME (web): ${_s(s.udyam_number)} [web — verify vs Udyam registry]${cite('udyam_number')}`);
  const soc: string[] = [];
  // P3: socials are now flat URL strings (trimmed schema); still accept the old {url,activity_level} object shape.
  (['linkedin', 'facebook', 'instagram', 'twitter_x'] as const).forEach((k) => { const raw = s[k]; const url = typeof raw === 'string' ? _s(raw) : _s(_obj(raw).url); const act = typeof raw === 'string' ? '' : _s(_obj(raw).activity_level); if (url || act) soc.push(`${k}${url ? ' ' + url : ''}${act ? ' (' + act + ')' : ''}`); });
  const gb = _obj(s.google_business); if (gb.exists === true || _s(gb.rating)) soc.push(`Google Business${_s(gb.rating) ? ' ' + _s(gb.rating) + '★' : ''}${_s(gb.reviews_count) ? ' (' + _s(gb.reviews_count) + ' reviews)' : ''}`);
  if (soc.length) emit('web_digital', `Digital footprint: ${soc.join(', ')} [web — digital maturity / legitimacy]${cite('google_business')}`);
  const others = _arr(s.other_businesses).map(_s).filter(Boolean); if (others.length) emit('web_other_biz', `Other businesses (web, UNVERIFIED — verify vs anchors): ${others.join('; ')}${cite('other_businesses')}`);
  const people = _arr(s.key_people).map(_s).filter(Boolean); if (people.length) emit('web_people', `Key people: ${people.join(', ')} [web]${cite('key_people')}`);
  const news = _arr(s.recent_news).map(_s).filter(Boolean); if (news.length) emit('web_news', `Recent activity: ${news.slice(0, 3).join(' | ')} [web]${cite('recent_news')}`);
  return true;
}

// V16.2.1 Udyam / MSME registry (Sign3 pan_to_udyam → udyam_verification) — government MSME record: enterprise_type
// (Micro/Small/Medium = authoritative SIZE), major_activity, org type, NIC industry codes, official address.
function composeUdyam(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const s = _obj(summary); const regs = _arr(s.registrations); if (!regs.length) return false;
  regs.forEach((r, i) => { const o = _obj(r); if (!_s(o.udyam_reg_no)) return;
    const ind = _arr(o.industry).map((x) => { const io = _obj(x); return _s(io.industry) || _s(io.activity); }).filter(Boolean);
    const parts = [`Udyam/MSME ${_s(o.udyam_reg_no)}`];
    if (_s(o.enterprise_name)) parts.push(`"${_s(o.enterprise_name)}"`);
    if (_s(o.enterprise_type)) parts.push(`${_s(o.enterprise_type)} enterprise`);
    if (_s(o.organization_type)) parts.push(_s(o.organization_type));
    if (_s(o.major_activity)) parts.push(`activity ${_s(o.major_activity)}`);
    if (ind.length) parts.push(`NIC industry: ${ind.slice(0, 3).join('; ')}`);
    if (_s(o.date_of_incorporation)) parts.push(`incorporated ${_s(o.date_of_incorporation)}`);
    push(src, `udyam[${i}]`, parts.join(' · ') + ' [MSME registry — authoritative SIZE (Micro/Small/Medium) + NIC industry + org type]');
    if (_s(o.official_address)) push(src, `udyam_addr[${i}]`, `Udyam official address: ${_s(o.official_address)} [MSME — cross-check vs GST/web address]`);
  });
  return true;
}

// ── build the SynthBundle (catalog + fN evidence + empty arithmeticPrior) from the rich response SUMMARIES ──
export function bundleFromResponse(resp: RichResponse): SynthBundle {
  const sources = (resp && typeof resp === 'object' && resp.sources && typeof resp.sources === 'object') ? resp.sources as Record<string, { summary?: unknown }> : {};
  const evidence: SynthBundle['evidence'] = [];
  const perSource: Record<string, number> = {};
  let n = 0;
  const push = (src: string, tag: string, raw: unknown) => {
    const v = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (!v || v === '-' || v === 'null' || v === 'undefined') return;
    // v26: a zero-valued count / returned / requested is plumbing ("0 records") — never a citable buyer fact; drop it.
    if ((v === '0' || v === 'false') && /(?:^|[._[])(count|returned|requested|agreement|records?|total)\b/i.test(tag)) return;
    evidence.push({ evidence_id: `f${++n}`, node: nodeLabel(src, tag), tag, raw: v, role: 'available' }); // V10 (owner #4/#13 · §C source-routed): NO per-line cap — a GSM value / sourcing city / trial qty buried past char 220 must reach the LLM. Cost optimized LATER.
    perSource[src] = (perSource[src] || 0) + 1;
  };
  // derived_anchors → first-class identity evidence (so identity fields can cite them)
  if (resp.derived_anchors && typeof resp.derived_anchors === 'object') flattenInto(resp.derived_anchors, 'profile', 'anchor', push);
  // V10 (owner: "nothing in between"): when the n8n emits the MERGED sources, the LLM sees ONLY them — the legacy
  // split feeds are superseded (they're still emitted for back-compat display consumers, but feeding both would
  // double-count the same BuyLeads/WA turns and inflate the context). Merged absent ⇒ fall back to the legacy keys.
  const superseded = new Set<string>();
  if (sources.requirement) { superseded.add('rfq'); superseded.add('isq'); }
  if (sources.whatsapp) { superseded.add('whatsapp_conversations'); superseded.add('whatsapp_inbound'); }
  for (const [src, val] of Object.entries(sources)) {
    if (superseded.has(src)) continue;
    const summary = (val && typeof val === 'object' && 'summary' in (val as Record<string, unknown>)) ? (val as { summary?: unknown }).summary : val;
    // self-describing composers for the two merged sources (one rich line per lead / per turn); else generic walk
    if (src === 'requirement' && composeRequirements(summary, src, push)) continue;
    if (src === 'whatsapp') { const wv = (val && typeof val === 'object') ? (val as Record<string, unknown>) : {}; if (composeWhatsApp(summary, wv.raw ?? wv, src, push)) continue; }
    if (src === 'calls' && composeCalls(summary, src, push)) continue;
    if (src === 'pns_calls' && composePnsCalls(summary, src, push)) continue;
    if (src === 'pns') { const pv = (val && typeof val === 'object') ? (val as Record<string, unknown>) : {}; const err = _obj(pv.raw).error ?? pv.error; if (composePns(summary, err, src, push)) continue; }
    if (src === 'identity' && composeIdentity(summary, src, push)) continue;
    if (src === 'csl' && composeCsl(summary, src, push)) continue;
    if (src === 'external' && composeExternal(summary, src, push)) continue;
    if (src === 'gst' && composeGst(summary, src, push)) continue;
    if (src === 'pan_gst_idfy' && composePanGstIdfy(summary, src, push)) continue;
    if (src === 'gst_cert_idfy' && composeGstCertIdfy(summary, src, push)) continue;
    if (src === 'epfo' && composeEpfo(summary, src, push)) continue;
    if (src === 'mobiles' && composeMobiles(summary, src, push)) continue;
    if (src === 'pan_union' && composePanUnion(summary, src, push)) continue;
    if (src === 'gstin_union' && composeGstinUnion(summary, src, push)) continue;
    if (src === 'gst_detail_union' && composeGstDetailUnion(summary, src, push)) continue;
    if (src === 'web_osint') {
      const wv = (val && typeof val === 'object') ? (val as Record<string, unknown>) : {};
      const basis = wv.proofs ?? wv.basis ?? _obj(summary).proofs ?? _obj(summary).basis;
      // v26 (re-audit OSINT-NAMESAKE fix): the card render is gated by webVerified, but the EXTRACT BUNDLE is built here
      // and was still shipping the namesake web fields (switchgear f155–f160) to the LLM — forcing it to spend attention
      // rejecting poison the pipeline already knows is unanchored. WITHHOLD web from the bundle when the search was
      // name-only (no company_name/GSTIN anchor) OR the engine self-reported match_confidence=none; emit ONE honest line.
      const wq = _obj(wv.query); const anchored = !!_s(wq.company_name) || !!_s(wq.gst_number);
      const mc = _s(wv.match_confidence).toLowerCase();
      if (!anchored || mc === 'none') { push(src, 'web_withheld', `Web/OSINT WITHHELD from this profile — ${anchored ? 'the web engine self-reported NO CONFIRMED MATCH (match_confidence=none)' : 'the search was UNANCHORED (no verified company_name / GSTIN to disambiguate)'}, so any returned firm is a likely NAMESAKE and is NOT used for any attribute. Absence of web data carries NO penalty.`); continue; }
      if (composeWebOsint(summary, basis, wv, src, push)) continue;
    }
    if (src === 'udyam' && composeUdyam(summary, src, push)) continue;
    flattenInto(summary, src, '', push);
  }
  // v26 (re-audit EMPTY-KYB-VERBOSE fix): a KYB/registry source that returned NOTHING used to leak 3–4 scaffolding lines
  // (_meta/__health/count:0 — now stripped). Replace that silence with ONE honest absence line per empty registry so the
  // LLM knows the triangulation rung is genuinely empty (not fetched-and-hidden) — absence, not error, no penalty.
  const KYB_ABSENCE: Record<string, string> = { gst_detail_union: 'GST 3-vendor consensus (Sign3⊕IDfy⊕Befisc)', gstin_union: 'GSTIN union', gst_cert_idfy: 'IDfy GST certificate', pan_gst_idfy: 'IDfy PAN→GST registrations', epfo: 'IDfy EPFO employer record', udyam: 'Udyam / MSME registration' };
  for (const [k, label] of Object.entries(KYB_ABSENCE)) {
    if (sources[k] && !superseded.has(k) && !(perSource[k] > 0)) push(k, 'absent', `No ${label} found for this buyer — the registry returned nothing this run (ABSENCE of a record, not a fetch error). Do not treat as disqualifying; absence carries no penalty.`);
  }
  const catalog = Object.keys(perSource).map((src) => ({ node: SRC_LABEL[src] || src, api: 'bi-user-insights_my', transform: 'llm' as const, rawCount: perSource[src], roles: { available: perSource[src] } }));
  return { catalog, evidence, arithmeticPrior: [] };
}

// ── the exhaustive extraction prompt (source guide · provenance · priority · golden rule · hallucination guard · schema) ──
export const EXTRACT_BUYER_PROFILE_SYSTEM = [
  'You are the BUYER PROFILE EXTRACTOR for an India B2B marketplace (IndiaMART RFQ / BuyLead). From the buyer evidence',
  'below you extract a STRUCTURED BUYER PROFILE — one attribute per line — grounded ONLY in the evidence ids, never invented.',
  '',
  'YOUR JOB (responsibilities — frozen): ANSWER the frozen Buyer Profile questions below. Do NOT summarize, do NOT invent,',
  'do NOT editorialize, do NOT rank beyond what a question asks. Answer ONLY from the supplied evidence ids, and prefer',
  'sources per the priority order stated for each question. Every answer = value + confidence + grounded reasoning citing real fN.',
  'SIMPLE INDIA-B2B ENGLISH (MANDATORY — every VALUE and every reasoning_step): write in clear, professional Indian-B2B English — the plain business terms a procurement / sourcing reader uses (manufacturer, wholesaler, distributor, trader, retailer, importer, OEM). Keep it SIMPLE but PROFESSIONAL — not casual or tacky, and NEVER Hindi. NO jargon-stacking, NO parenthetical qualifiers, NO slash-separated synonyms. e.g. write "early-stage manufacturer in paper & notebooks" — NOT the verbose "Early-stage / aspiring Manufacturer (individual proprietor) · Paper & Notebook Manufacturing", and NOT the over-casual "early-stage maker". Each answer = ONE short professional phrase. (The KEY/question name is fixed — only the value and reasoning get this wording.)',
  'GLOSSARY — IndiaMART terms (each defined here, BEFORE first use below):',
  '- GLID = the buyer\'s unique IndiaMART user id · MCAT = product micro-category (a numeric id already resolved to a category NAME) · ISQ = the category spec questions a buyer answers on a BuyLead (spec name + value) · RFQ / BuyLead = a posted buyer requirement / enquiry.',
  '- KYB = Know-Your-Business (registry-verified business identity) · GSTIN = 15-char GST id (2-digit prefix = state; 5th char = entity type) · PAN = 10-char tax id (4th char: P Individual · C Company · F Firm/LLP · H HUF · T Trust) · Udyam = government MSME registration (authoritative SIZE band).',
  '- CSL = the buyer\'s on-site click / search browse log · PNS = IndiaMART cloud-telephony (masked-number seller calls + AI-distilled / transcribed insights) · telecom circle = the SIM\'s region (a LOW-weight location hint) · "buyer turns" = the buyer\'s own messages / actions (SIGNAL) vs "our turns" = our outbound offers / prompts (CONTEXT only, never the buyer\'s intent).',
  '',
  'TIMELINE / TIME-PROXIMITY (v23): the evidence carries dated events (requirement posted-dates, call dates, WhatsApp turn timestamps, the CSL browse window). When you reason about the CURRENT / most-recent requirement, the calls · WhatsApp turns · CSL browsing CLOSEST IN TIME to that requirement are the relevant context AROUND it — weight them highest; distant activity is background history. When explaining offer-relevant intent, prefer citing the dated fN nearest the requirement.',
  'NUMBERS = SIGNAL vs NOISE (v23): a number is MEANINGFUL only when it is a phone number, a spec / quantity / rate / price / dimension, a date or timeline value, account tenure (years / member-since), a pincode, a PAN / GSTIN, or a vendor-agreement count. Any OTHER bare number in the evidence (internal ids, weights, status codes, byte-lengths, preference codes) is NOISE — ignore it; never surface it in a value or reasoning_step. Category / city / product NAMES have already been resolved from their ids — always use the NAME, never a raw numeric id.',
  'SELLER-GLID (v23): if the evidence shows this GLID is ALSO a listed seller (custtype empFCP / FCP · listing_status LST · also_a_seller), state it — a seller sourcing on IndiaMART may be buying raw material for its own resale / manufacture, or doing competitor research. Factor that into persona / intent rather than reading it as a pure end-buyer.',
  'SYNTHESIZE — do NOT ECHO (mandatory): you are an intelligence engine, not a copy machine. When two or more sources bear on the SAME attribute, RECONCILE them instead of restating a single field verbatim. If they AGREE, state the conclusion ONCE and NAME the agreeing sources (that agreement is what raises confidence). If they CONFLICT, surface BOTH values and CHOOSE one with an explicit reason (per the PRIORITY order + real buyer-behaviour evidence). Every multi-source attribute\'s reasoning_steps MUST show this cross-source reconciliation (which sources agreed or disagreed, and why) — never a bare "source X says Y".',
  'NAME THE VENDOR (mandatory): the paid identity layer is TWO distinct vendors — Befisc (KYB identity: income band, PAN, address, DOB, gender) and Sign3 (digital-footprint / trust: social presence, telecom circle, breaches, bank-verified name). When you cite an identity-layer fact, name the SPECIFIC vendor ("Sign3 bank-verified name…", "Befisc income band…") — NEVER the generic word "external". The evidence lines are already vendor-tagged; carry that vendor name into your reasoning and the sources array.',
  '',
  'SOURCE DEFINITIONS (each evidence id is tagged with its source — what the data IS, and how to trust it):',
  '- PNS · sales calls = AI-distilled insights from IndiaMART cloud-telephony recordings of seller↔buyer phone calls — the buyer SPOKE → HIGHEST trust for intent / requirement / location.',
  '- WhatsApp · one timeline = the buyer\'s WhatsApp activity merged into ONE chronological thread. Turns tagged side:buyer (their own messages/enquiries → first-class signal) are interleaved with side:ours (our offers/prompts → CONTEXT only, never the buyer\'s intent).',
  '- CSL · on-site behaviour = the buyer\'s on-site searches + product/category views (a "×N" suffix = repeat count = signal strength).',
  '- Requirement = the buyer\'s posted BuyLeads (the requirement spine: title · recency_days) plus a SEPARATE pool of the ISQ specs they answered (category NAME + spec values = reusable buyer memory). An older lead is PAST demand, but its specs / category / products REMAIN fully usable buyer-memory evidence — cite them freely for persona / products_of_interest / procurement. Use recency_days for how recent each lead is.',
  '- identity = name + location + income TRIANGULATED across Profile, Befisc and Sign3, with agreement flags. company_known:false means UNKNOWN — NEVER infer "Individual" from a blank company.',
  '- Profile / GLUSR = the buyer\'s registered identity + account tenure (member-since / last-active).',
  '- Befisc = paid external identity lookup (verified name, income band). Sign3 = paid external digital-footprint / trust (verified name, social-presence count). Income band = a purchasing-power HINT, not a hard driver. (phone_circle / SIM telecom-circle = a LOW-WEIGHT, region-level location HINT — a SIM can roam, so use it ONLY to corroborate other location signals, never to decide location alone.)',
  '- Befisc GST (Advanced) = the FULL registered-business record for the buyer\'s GSTIN (legal_name · trade_name · constitution · status · registration date · registered-address city · business_nature[] · SAC/HSN codes + DESCRIPTIONS · authorized signatories · turnover · GSTR filing cadence). HIGHEST-TRUST identity. WHEN PRESENT: the buyer is DEFINITIVELY a registered B2B business — set b2b_b2c=B2B and treat business_persona / buyer_maturity as an ESTABLISHED registered entity (high confidence; do not call them early-stage). Derive sub_industry from the SAC/HSN DESCRIPTIONS, and the retail / wholesale / manufacturer / service ROLE (retail_wholesale) from business_nature[]. The registered-address city is a HARD operating-location confirmation — it OUTRANKS converged browse/SIM signals for the operating city. An actively-filing GSTR cadence = a live, compliant business.',
  '',
  '- IDfy PAN→GST = all GST registrations under the buyer\'s PAN (independent of Befisc). MANY registrations / MULTI-STATE ⇒ scale + B2B; a single registration ⇒ smaller / retail. Cross-checks Befisc\'s PAN→GST.',
  '- IDfy GST Certificate = a SECOND, independent GSTIN→profile source (same fields as Befisc GST-Advanced: constitution · nature_of_business[] · taxpayer_type · registration date · filing history). TRIANGULATION: when IDfy and Befisc AGREE on constitution / nature / status, treat it as HIGH confidence (two independent KYB sources) and say so; if only ONE source has it, use it but note single-source; if they CONFLICT, surface both and lower confidence. Derive b2b_b2c + retail_wholesale + sub_industry from whichever source has nature_of_business[] (Wholesale/Manufacturer/Import/Export ⇒ B2B; Retail-only ⇒ retail). Filing history = compliance/live-business signal.',
  '- IDfy EPFO = registered-employer record for the buyer\'s firm name(s). Present ⇒ a formal org with staff (B2B-leaning, a SIZE proxy); business_activity cross-checks industry. Absent is NOT disqualifying (small/new firms need not be EPFO-registered).',
  '- Mobiles (V16 triangulation) = the buyer phone(s) cross-checked across Profile, Befisc and Sign3. A number confirmed by >=2 sources is VERIFIED; all 3 = TRIPLE-verified — a strong identity-trust signal (feed identity_confidence).',
  '- PAN union (V16) = the buyer PAN(s) from Sign3 phone_to_pan + Befisc, deduped + source-tagged, PLUS Sign3 pan_advance (NSDL-authoritative pan_type: Individual / Company / Firm / HUF / Trust, and sole-proprietor / director flags). ENTITY AUTHORITY: for b2b_b2c, PREFER pan_advance.pan_type OVER the PAN 4th-char heuristic; use the 4th char only as a fallback when pan_type is absent. A PAN found by >=2 vendors is higher-trust.',
  '- GSTIN union (V16) = every GSTIN for the buyer from Sign3 pan_gst_search + IDfy pan_gst_link + Befisc + Profile, deduped with found_by tags. Multi-state count ⇒ scale / B2B. A GSTIN discovered by MULTIPLE vendors is higher-confidence than a single-vendor hit.',
  '- GST detail · 3-vendor consensus (V16, PRIMARY KYB) = per FIELD (legal_name · constitution · taxpayer_type · status · nature_of_business/HSN · registration date) a canonical value + which vendors AGREE across Sign3 gst_validate ∥ IDfy ind_gst_certificate ∥ Befisc FFFQ. AGREEMENT → CONFIDENCE: >=3 vendors agree ⇒ 90-95; 2 agree ⇒ 75-85 (cite the majority, note any dissent); single-source ⇒ 50-70; all disagree ⇒ 40-60 (surface ALL values, do NOT silently pick one — arbitrate ONLY from agreement_count + real buyer-behaviour evidence, NEVER invent a vendor-reliability / recency reason). Use >=2-vendor-AGREED fields as the PRIMARY basis for business_persona / sub_industry / b2b_b2c / retail_wholesale. HSN / nature → industry: when >=2 vendors carry the same nature-of-business / HSN family, treat the industry deduction as CORROBORATED and raise confidence per the rubric. This consensus source OUTRANKS any single KYB source (Befisc-Advanced / IDfy-cert alone) when they agree.',
  '- Web OSINT (Parallel.ai web search) = public web data (JustDial, TradeIndia, DnB, importer lists, KnowYourGST, company directories, news, socials) and, per field, the SOURCE URL(s) + the exact quoted EXCERPT + the engine\'s own confidence. It is RAW and MAY CONTAIN GARBAGE — web results can conflate similarly-named firms/people or carry stale entries — so do NOT trust it blindly, but do NOT ignore it either. REASON + VERIFY EACH web field against a HARD ANCHOR for THIS buyer before using it. ANCHORS = the GST / Udyam / PAN legal or trade NAME · the PAN holder / GST-verified PERSON · the GST / profile CITY + registered ADDRESS · the GST nature / Udyam NIC INDUSTRY. VERDICT per web field: (1) CLEARLY MATCHES an anchor (same firm / person / city / industry, or the cited excerpt names the verified GSTIN / PAN / address) → USE it, and let it ADD DETAIL (e.g. refine GST "electronics" → "CCTV / access-control security hardware", add a website / social / Google-Business presence, corroborate a turnover band or founding year) at a confidence set by how strong the match + the citation are; (2) CLEARLY MISMATCHES (a different city / industry / person with no tie to any anchor) → DISCARD as a namesake / bad result, do not surface it; (3) CAN\'T TELL (no anchor to test against) → treat as an UNVERIFIED LEAD only — mention it as "unverified, from web" at low confidence, never as fact. Prefer HIGHER-AUTHORITY citations (a firm\'s IndiaMART / GST-lookup / TradeIndia listing that quotes the verified GSTIN outweighs a random directory). ALWAYS STATE YOUR VERIFY-VERDICT in the reasoning (which anchor it matched or failed, citing the web fN + its source URL). Web NEVER overrides KYB — legal_name / entity / GSTIN / PAN / registered address stay canonical; on a conflict keep KYB and note the web discrepancy. Absent / timed-out web = NO penalty.',
  '- Udyam / MSME (V16.2.1, Sign3 pan_to_udyam → udyam_verification) = the buyer\'s government MSME registration. enterprise_type is the AUTHORITATIVE SIZE band — Micro / Small / Medium (use it DIRECTLY for buyer_maturity / scale, outranking web employee_count guesses). major_activity (Trading / Manufacturing / Service) + NIC industry codes & descriptions drive sub_industry and retail_wholesale; organization_type (Proprietary / Partnership / Pvt Ltd) corroborates the KYB constitution + b2b_b2c; date_of_incorporation = vintage; official_address triangulates the GST / web address (agreement ⇒ raise identity_confidence). A present Udyam = a REGISTERED MSME (B2B-leaning, formal). HIGH trust (govt registry). Absent is NOT disqualifying (not every business registers for Udyam).',
  '- Call recordings (transcribed) = the buyer\'s SALES-CALL transcripts (date · topic · translated-to-English text). SPOKEN buyer intent — HIGH authority (treat like PNS). Use for buyer_intent, business_persona, intended application, products, and any explicit payment/delivery/quantity the buyer says. The call NEAREST a requirement\'s posted date is the strongest enrichment signal for THAT requirement (also date-matched into UC2 downstream). Cite the call date.',
  '- PNS calls = the buyer\'s masked-number calls TO SELLERS. Each carries rich metadata EVEN without a transcript: the PRODUCT called about (like a mini order/BuyLead title), the CATEGORY (mcat/sub), the caller TELECOM CIRCLE, an OFFER_ID (links the call to a BuyLead requirement), and the date. (a) The set of products/categories across calls = the buyer\'s SOURCING BASKET → business_persona + sub_industry + intended application; a buyer calling about BOTH raw material AND the MACHINES to make it is a MANUFACTURER/producer, not a trader — weight this heavily. (b) The telecom CIRCLE is a LOW-weight regional location hint only (a circle spans many cities) — it may corroborate a region but NEVER overrides an agreeing city (verified-address lock still governs). (c) The transcript (when present) is SPOKEN intent — same HIGH authority as call recordings; the call matching a requirement\'s offer_id (else nearest date/category) enriches THAT requirement (date-matched into UC2). Cite the product + date.',
  'PRIORITY when evidence conflicts (higher wins): PNS / Call-recordings > WhatsApp(buyer) > Befisc/Sign3 > CSL > Requirement(BuyLeads/ISQ).',
  'PROVENANCE: infer ONLY from buyer-originated evidence; never infer a trait from our outbound messages (WhatsApp side:ours = products WE pitched, NOT products the buyer wants), matched sellers,',
  'or platform-deduced fields (Probable Order Value / Requirement Type) — validate against them at most.',
  '',
  'ANSWER THESE FROZEN BUYER USE-CASES (triangulate across the cited sources in the priority order; emit ONE attribute per use-case, combined — do NOT split into redundant rows):',
  '- location_sourcing_preference = where the buyer OPERATES + every distinct city they SOURCE-FROM. Emit BOTH the operating city AND ALL sourcing cities when they differ (e.g. "Operates in Auraiya · Sources from Kanpur, Delhi") — do NOT collapse multiple sourcing cities to one. SIGNAL WEIGHT: the registered Profile city is a WEAK anchor (often stale / a head-office) — buyer-BEHAVIOUR signals outrank it. OPERATING-CITY RULE: when >=2 INDEPENDENT buyer signals — CSL browse city · telecom SIM circle (region-level hint) · a BuyLead-stated city · a spoken PNS location — CONVERGE on a city that differs from the registered Profile city, AND no verified external ADDRESS confirms the registered city, then the CONVERGED city is the likely OPERATING city (say so; the registered city may be stale) at MODERATE confidence. VERIFIED-ADDRESS LOCK (decisive): if a verified external ADDRESS — Befisc / Sign3 / GST registered-address — names the SAME city as the registered Profile city, that city is CONFIRMED as operating: KEEP it and DO NOT flip, even when PNS mentions another city. A spoken "near the seller" / "in <seller-city>" is a SOURCING / proximity hint, NOT a verified operating address, and can NEVER override two agreeing address sources. Only an EXPLICIT PNS operating statement ("we operate from / our factory/office is in X") may override a verified address; a vague "lives near the seller in X" may NOT. If signals are MIXED / sparse, KEEP the registered city, LOWER the confidence, add "verify location". Browse / filter cities that do NOT converge are SOURCE-FROM hints, not the operating city. Your reasoning MUST name which signals converged. Priority for the OPERATING city: spoken PNS > >=2 converged buyer signals > Befisc/Sign3 verified address > registered Profile city.',
  '- business_persona = business_type AND industry as ONE (format "<type> · <industry>", both DERIVED from this buyer\'s own evidence — never a default category). Priority: PNS persona > BuyLead/ISQ product cluster > CSL. (Displayed as "Buyer Persona".) RECONCILE WITH PAN (in PLAIN words): if the anchor "pan_entity" is "Individual" yet the persona reads "Manufacturer", do NOT call them an established company — when setup / just-starting signals are present, say it in simple B2B terms, e.g. "early-stage manufacturer in <industry>" (NOT the verbose "Early-stage / aspiring Manufacturer (individual proprietor)", and NOT the over-casual "maker"). (An individual can still run a registered business; external may simply not have returned the GST-linked PAN — so never treat the Individual PAN as proof they are NOT manufacturing.)',
  '- buyer_maturity = where the business is in its life — say it in simple B2B terms: "early-stage business" (setting up a new unit / first venture / just installed machines) vs "established business". Read it from PNS seller-discovery questions ("Are you setting up a unit or already working?", "Have you installed the machines?", "What did you do before this?") and new-venture / startup call narratives. Use "early-stage business" ONLY when those signals appear; otherwise "established business". (Displayed as "Buyer Maturity"; avoid jargon like "New-entrant" and over-casual phrasing.)',
  '- products_of_interest = the buyer\'s product lines. RANK by relevance to the buyer\'s CURRENT / core line (most recent + repeated categories first); DEMOTE clearly off-core one-offs (e.g. a stray vehicle / hardware lead for a paper buyer). Surface the top 3 most-relevant. If fewer than 3 are clearly on-core, fill with the next best, but mark them as the lower-relevance tail. Cite the evidence ids for each.',
  '- buyer_intent = the buyer\'s CURRENT purchasing SERIOUSNESS + STAGE as ONE read (Low/Medium/High + lifecycle stage: Browsing / Comparing / Ready-to-buy). Read it from CURRENT-STAGE signals ONLY, in this order: PNS call seriousness + callback-urgency (spoken intent is strongest), recent on-site browsing (CSL repeat views = active research), live WhatsApp activity (real enquiries, not one-tap auto-replies), and recent BuyLeads. An OLDER prior BuyLead is PAST demand — it is NOT evidence of low intent; judge intent purely from the live signals above and do NOT downgrade for old leads. Only when there are NO live signals at all (no recent calls, no browsing, no live WhatsApp, no recent leads) is the buyer genuinely Dormant. Equally, do NOT call them "Hot" off a single one-tap WhatsApp "YES" auto-reply.',
  '- identity_confidence = how corroborated the identity is: High when name AND city agree across >=2 of {Profile, Befisc, Sign3}; Medium with one strong verified source; Low otherwise. This is a TRUST signal, not a behavioral trait.',
  '- delivery_timeline = the buyer\'s required DELIVERY timeframe — emit ONLY when EXPLICITLY stated (a spec/ISQ field, or the buyer literally said "same day" / "within 15 days" / "this month" / a date). Output the concrete timeframe verbatim. If NOT explicitly stated, OMIT delivery_timeline and emit "urgency" instead (see below).',
  '- urgency = a FALLBACK for delivery_timeline — emit ONLY when no explicit delivery timeframe exists. Value Low/Medium/High deduced from PNS callback-urgency + live engagement. Your FIRST reasoning_step MUST state: "no explicit delivery-timeline signal in the evidence — urgency deduced as the fallback (rule)." If delivery_timeline IS emitted, OMIT urgency. (This makes WHO decided the fallback explicit: a deterministic rule chose urgency; the LLM only explains the urgency value.)',
  '- payment_mode = the buyer\'s payment preference (Advance / Credit / COD / part-advance, etc.) — emit ONLY when EXPLICITLY stated on a call or in chat; otherwise OMIT (it surfaces in the "still-ask" needs-input list, never guessed).',
  '- price_vs_quality = ONE axis (Price-sensitive / Balanced / Quality-led) from WhatsApp objections + PNS rate-talk.',
  '- procurement_model = One-time / Recurring / Bulk (distinct repeat purchases SPACED OUT over time = recurring; the SAME requirement re-posted within ~7 days is a RE-SEARCH — the buyer had not found a supplier yet — NOT recurring).',
  '- purchase_frequency = for THIS requirement\'s product line, how often the buyer procures it — One-time / Occasional / Recurring (state the cadence when evidenced, e.g. "Recurring · distinct leads ~3 weeks apart") — from PNS order_types(Recurring) + the cadence of DISTINCT prior BuyLeads spaced >7 days apart. A re-post within ~7 days does NOT count (re-search, not recurring). Recurring ONLY when genuine repeat procurement is evidenced. (This is shown WITH the requirement, not as a buyer-wide trait.)',
  '- communication = preferred channel + responsiveness + language as ONE (e.g. "Phone+WhatsApp · highly responsive · Hindi").',
  '- digital_footprint = the buyer\'s verified digital tenure + presence as ONE: IndiaMART member-since / tenure + social-platform presence (e.g. Instagram, Facebook, Flipkart) + telecom circle, drawn from identity/external. State ONLY what the evidence carries — do NOT invent a per-platform "since N years" if the data has only presence, and do NOT invent a member-since if absent.',
  '- retail_wholesale = is the buyer MOSTLY RETAIL or MOSTLY WHOLESALE across their requirements? Classify EACH requirement retail-vs-wholesale from its PRODUCT + QUANTITY (small / consumer-scale qty = retail; bulk / commercial-scale qty = wholesale). Quantity is CATEGORY-RELATIVE — judge "bulk" per product (50 units may be bulk for machinery, retail for fasteners); NEVER hard-code a number. Roll up: >66% of judged requirements wholesale → "Mostly wholesale"; >66% retail → "Mostly retail"; otherwise "Mixed". Your reasoning MUST list the per-requirement retail/wholesale call it rolled up. ENTITY TIE-BREAKER (light): an Individual-PAN (4th char P) buying consumer-scale qty leans retail; a registered entity (C / F) buying bulk leans wholesale — use ONLY to break a near-50/50 tie; the product+qty rollup decides. OMIT if fewer than 2 requirements carry a usable product+qty.',
  '- b2b_b2c = is the buyer B2B or B2C? Use the PNS "b2b_or_b2c" signal DIRECTLY when present (cite it). DETERMINISTIC ENTITY SIGNAL (near-certain, free): the PAN 4th char — OR the entity char embedded in the GSTIN — classifies the legal entity. C (Company) / F (Firm or LLP) / T (Trust) / H (HUF) ⇒ B2B at HIGH confidence (a registered NON-individual entity); cite the entity char / GSTIN. P (Individual / proprietor) ⇒ a LEAN B2C / small-retail HINT only, NEVER proof — an individual can still run a registered business, so a P-PAN defers to PNS, a clear business persona, or a GSTIN whenever those indicate B2B. Else infer from persona: a reseller / distributor / manufacturer / retailer / institution buying for a business = B2B; an individual buying for personal/household use = B2C. OMIT if neither signal nor a clear persona exists.',
  '(Identity name/mobile/email/GST/PAN, income/purchasing-power band, age/gender/DOB and trust score are handled DETERMINISTICALLY upstream (single-source passthrough) — do NOT emit them here.)',
  '',
  'GOLDEN RULE: if there is no supporting evidence for a use-case, OMIT it (state "Unknown", confidence 0) — NEVER guess.',
  'HALLUCINATION GUARD: every attribute MUST carry reasoning_steps; every step MUST cite >=1 real evidence id (fN).',
  '  Set "grounded": false if the VALUE introduces any term/spec/place NOT present in or entailed by the cited lines',
  '  (e.g. a transliteration, an embellishment, an over-specific number). Only set "grounded": true when every word of the',
  '  value is supported by the cited evidence. confidence >=70 only when >=2 ids agree OR one strong spoken (PNS) id.',
  '  CONFIDENCE FORMULA (interpretable, not a vibe): evidence quality + source authority (PNS / WhatsApp-buyer highest)',
  '  + cross-source agreement − contradictions − missing/weak evidence. So 2+ high-authority sources agree → 85-95; one',
  '  strong spoken (PNS) signal → 75-90; a single weak/indirect signal → 50-70; contradicted or thin → below 50 (grounded likely false).',
  '  India-B2B patterns (trial-before-bulk, price sensitivity, local-supplier preference, recurring procurement) apply ONLY when cited.',
  '',
  'OUTPUT — strict JSON: { "attributes": [ {',
  '  "key": "business_persona|buyer_maturity|sub_industry|products_of_interest|buyer_intent|scale|',
  '          procurement_model|purchase_frequency|communication|price_vs_quality|delivery_timeline|urgency|payment_mode|location_sourcing_preference|identity_confidence|digital_footprint|retail_wholesale|b2b_b2c",  // V11: identity_confidence = trust signal; NO raw name/PAN/DOB/income as a behavioral attribute (those are deterministic upstream).',
  '  "value": "<concise value>",',
  '  "state": "Confirmed|Likely|Conflicted|Unknown",',
  '  "confidence": 0-100,        // YOUR honest self-assessed confidence (use the CONFIDENCE FORMULA above)',
  '  "confidence_reason": "<ONE plain line: WHY this number, per the formula — e.g. \'2 sources agree incl. a spoken PNS call → 90\'>",',
  '  "to_100": "<the single thing that would raise it to 100 — e.g. \'a recent BuyLead\', \'a 2nd independent source\', or \'an explicit buyer statement\'. If already 100, \"\">",',
  '  "grounded": true|false,     // YOUR honest self-assessment: is every word of the value supported by the cited lines?',
  '  "sources": [/* name sources ONLY from this closed catalog — NEVER "external" or "profile": "PNS" | "WhatsApp" | "CSL" | "Requirement" | "IndiaMART Buyer Profile" | "Befisc" | "Sign3" | "Befisc GST" */],',
  '  "reasoning_steps": [ { "claim": "<why>", "from_evidence": ["f3","f12"], "rejected": "<alt ruled out, optional>", "delta": <+points> } ]',
  '} ] }',
  'Extract every use-case you can ground; OMIT use-cases with no evidence (do not emit Unknown rows). Return ONLY the JSON.',
].join('\n');

// v7 ships `source_registry` (per-source trust + role flags) + `source_priority` (per-dimension order). When present we
// render them as AUTHORITATIVE guidance so the pipeline owns provenance/priority (instead of our static copy drifting).
export interface SourceGuide { source_registry?: Record<string, Record<string, unknown>> | null; source_priority?: Record<string, unknown> | null }
function renderSourceGuide(g?: SourceGuide | null): string {
  if (!g) return '';
  const reg = g.source_registry && typeof g.source_registry === 'object' ? g.source_registry : null;
  const pri = g.source_priority && typeof g.source_priority === 'object' ? g.source_priority : null;
  const out: string[] = [];
  if (reg) {
    out.push('SOURCE GUIDE — AUTHORITATIVE (from the live pipeline; overrides the generic guide; trust + role per source):');
    for (const [k, v] of Object.entries(reg)) {
      const r = v as Record<string, unknown>;
      const inf = ['persona', 'intent', 'requirement_generation', 'trust_score'].filter((d) => r[`should_influence_${d}`] === true).map((d) => d.replace('_generation', '').replace('_score', '')).join('/');
      out.push(`- ${SRC_LABEL[k] || k} [trust:${r.trust_level || '?'}]${r.observed_only ? ' OBSERVED-ONLY (corroboration, never primary intent)' : ''} — ${String(r.purpose || r.description || '')}${inf ? ` · influences: ${inf}` : ' · influences: none'}`);
    }
  }
  if (pri) {
    const fmt = (d: string) => Array.isArray((pri as Record<string, unknown>)[d]) ? ((pri as Record<string, unknown>)[d] as unknown[]).map((x) => SRC_LABEL[String(x)] || String(x)).join(' > ') : null;
    const rows = ['persona', 'intent', 'requirement', 'trust'].map((d) => { const f = fmt(d); return f ? `  ${d}: ${f}` : ''; }).filter(Boolean);
    if (rows.length) { out.push('', 'CONFLICT PRIORITY — AUTHORITATIVE (higher wins; use these orders per dimension):', ...rows); }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export function buildExtractPrompt(bundle: SynthBundle, anchors?: Record<string, unknown> | null, guide?: SourceGuide | null): { system: string; user: string; evidenceIds: Set<string> } {
  const anchorLine = anchors && Object.keys(anchors).length ? 'IDENTITY ANCHORS (pre-resolved — corroborate, treat as identity not intent): ' + JSON.stringify(anchors) : '';
  const user = [
    renderSourceGuide(guide),
    anchorLine,
    `BUYER EVIDENCE — cite these ids (fN) in from_evidence (the ONLY citable evidence; ${bundle.evidence.length} lines):`,
    ...bundle.evidence.map((e) => `  [${e.evidence_id}] (${e.node} · ${e.tag}) ${e.raw}`),
    '',
    'Extract the buyer profile per the schema. Cite real fN ids in every reasoning step. OMIT ungrounded fields.',
  ].filter(Boolean).join('\n');
  return { system: EXTRACT_BUYER_PROFILE_SYSTEM, user, evidenceIds: new Set(bundle.evidence.map((e) => e.evidence_id)) };
}

// deterministic state when the model omits it (keeps the STATE pill honest)
function deriveState(value: string, confidence: number, grounded: boolean, hasRejected: boolean): BuyerFieldState {
  const v = String(value || '').trim();
  if (!v || /^(unknown|—|-|n\/?a|none)$/i.test(v)) return 'Unknown';
  if (hasRejected) return 'Conflicted';
  if (grounded && confidence >= 70) return 'Confirmed';
  if (grounded && confidence >= 50) return 'Likely';
  return grounded ? 'Likely' : 'Unknown';
}

// ── map the LLM output → FinalAttr[] (mirror of synthesisEngine.llmFinals + the additive `state`) ──
export function extractedToFinals(out: ExtractBuyerProfileOut | SynthLLMOut | null, evidenceIds: Set<string>): FinalAttr[] {
  const attrs = (out && Array.isArray((out as ExtractBuyerProfileOut).attributes)) ? (out as ExtractBuyerProfileOut).attributes : [];
  const finals: FinalAttr[] = [];
  for (const la of attrs as ExtractAttr[]) {
    if (!la || !la.key) continue;
    const steps = la.reasoning_steps || [];
    const cites = steps.flatMap((s) => s.from_evidence || []);
    const idsResolve = cites.length > 0 && cites.every((id) => evidenceIds.has(id)); // code cross-check: do all cited ids exist?
    const resolveCount = cites.filter((id) => evidenceIds.has(id)).length;
    // V10 (owner #12): the model SELF-REPORTS grounded (value-entailment, not just id-existence). Trust it; fall back to
    // the id-resolution cross-check only when the field is absent. confidence is the model's honest self-assessment (no floor).
    const grounded = (typeof la.grounded === 'boolean') ? la.grounded : idsResolve;
    const hasRejected = steps.some((s) => !!s.rejected);
    const reasoning = steps.map((s) => ({ claim: s.claim, evidence: s.from_evidence || [], rejected: s.rejected }));
    const m = attrMeta(la.key);
    const confidence = la.confidence ?? 0;
    const state = (la.state && ['Confirmed', 'Likely', 'Conflicted', 'Unknown'].includes(la.state)) ? la.state : deriveState(la.value, confidence, grounded, hasRejected);
    finals.push({
      key: la.key, label: m.label, group: m.group, value: la.value, confidence,
      provenance: 'llm-confirmed', state,
      method: `LLM extraction (${EXTRACT_PROMPT_VERSION}) — self-grounded:${grounded} · cited ${cites.length} id(s), ${resolveCount} resolve${la.sources && la.sources.length ? ' · sources: ' + la.sources.join(', ') : ''}`,
      llm: { value: la.value, confidence, reasoning, grounded, confidenceReason: la.confidence_reason, to100: la.to_100 },
    });
  }
  return finals;
}
