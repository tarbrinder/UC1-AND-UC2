// ─── Buyer enrichment (DEBUG / DEMO mode) ─────────────────────────────────────
//
// Pulls the buyer's full IndiaMART history (prior calls, RFQs, buy-leads,
// WhatsApp, profile) from the user-insights webhook to power the form: prefill
// PII + persona, and — when the searched category matches the buyer's history —
// pre-rank specs, prefill known specs / ISQ answers, and reuse the seller's real
// questions. NO PII GUARD for now (debug): we surface everything raw so we can
// trace what shaped the form, then filter later.
// PROD: move behind a server proxy that strips contact + auths the GLID from the
// session (the prior PII-safe contract is preserved in git history).

import { api, N8N_HOOK, BUYER_UNIFIED_HOOK } from './api';

// Debug-only stand-in mobile (key: glusr_usr_ph_mobile) so the mobile→external
// chain (Befisc identity / GST→HSN) can be EXERCISED on a SPECIFIC test GLID whose
// buyer_profile carries no mobile. Scoped to ONE GLID by request ("just for this
// case no other case") and active ONLY under ?debug=1 — so it can never leak a
// number into any other buyer's RFQ, in debug or in a pilot/live run.
const DEBUG_FALLBACK_MOBILE_BY_GLID: Record<string, string> = {
  '268590579': '9784665194',
};
export const debugFallbackMobile = (glid?: string): string => {
  try {
    if (!(typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug'))) return '';
    const g = String(glid ?? '').trim();
    return (g && DEBUG_FALLBACK_MOBILE_BY_GLID[g]) || '';
  } catch {
    return '';
  }
};

export interface EnrichmentProfile {
  glid: string;
  fetchedAt: string; // ISO — for staleness checks on the client
  // Identity — display-safe only. No raw mobile/email/address.
  buyer?: {
    firstName?: string;
    lastName?: string;
    fullName?: string;
    city?: string;
    state?: string;
    companyName?: string;
    designation?: string;
    website?: string;
    gst?: string; // GSTIN from the profile (unique business anchor for OSINT + Verified facts)
    udyam?: string; // Udyam / Udyog Aadhaar registration (unique MSME business anchor)
    customerType?: string; // mapped label, e.g. "Reseller", "Industrialist"
    mobile?: string; // DEBUG: raw contact (no PII guard for now)
    email?: string; // DEBUG
    verifiedBusiness?: boolean;
    mobileVerified?: boolean;
    emailVerified?: boolean;
    locality?: string; // sub-city area, e.g. "Sector - 45"
    locationPreference?: string; // raw code from profile (local/regional/pan-india signal)
    primaryLanguage?: string; // language of the calls
  };
  // Persona signals derived from prior calls + profile (DIRECT — straight from the
  // payload). Higher-order behavioural deductions are produced separately by the
  // LLM (deriveBuyerProfile) from `digest`.
  persona?: {
    type?: string; // "Industrialist", "Wholesaler/Trader", "Shop keeper", …
    scale?: 'Low' | 'Medium' | 'High';
    commercial?: boolean;
    repeatBuyer?: boolean;
    domains?: string[]; // distinct categories seen across calls/BLs (multi-SKU signal)
    multiSku?: boolean; // bought/enquired across >1 distinct category
    whatsappMsgs?: number; // raw WhatsApp message volume
    whatsappAffinity?: 'Low' | 'Medium' | 'High'; // channel preference from volume
  };
  // Compact, LLM-ready summary of the buyer's transcript signals (call purposes,
  // intents, narratives, seller queries, domains) — fed to deriveBuyerProfile to
  // produce the persistent behavioural profile. Kept small so the pass is cheap.
  digest?: string;
  // ── BTE-v1.1 heavy-pass inputs ──
  signals?: TwinSignal[]; // dated, sourced evidence pool the Twin compiler cites from
  companyDesc?: string; // buyer's own business description (HTML-stripped) — who they are
  cslBrowse?: string[]; // recent search/browse terms from CSL logs (live intent)
  cslCity?: string; // most-frequent CSL glb_city — the buyer's likely location when the profile carries none (N3)
  intentHistory?: Record<string, number>; // baseline intent distribution (count per application)
  evidenceBase?: { pns_calls: number; whatsapp_events: number; bls_created: number; csl_events: number };
  // Category history → the client joins on the CURRENT mcat. If it matches, the
  // form prefills known specs / persona and skips planned questions we already have.
  categories?: Array<{
    mcat: string;
    source: 'call' | 'isq' | 'buylead';
    recencyDays?: number; // for time-decay / "is this still right?"
    knownSpecs?: Record<string, string>; // specs the buyer cared about (Bolts=9, Size=27.5)
    sellerQuestions?: string[]; // real SSQs the seller asked for THIS category
    isqAnswers?: Record<string, string>; // prior RFQ ISQ answers
  }>;
}

// Persistent BEHAVIOURAL buyer profile — derived once (by the LLM) from `digest`
// and reused across every future requirement. "The requirement changes daily; the
// buyer rarely changes." These are NOT requirement fields; they persist per GLID.
export interface BuyerProfile {
  persona?: string; // Industrial Buyer / Trader / Wholesaler / Retailer / Shopkeeper / Manufacturer / Business Buyer
  maturity?: string; // New Buyer / Existing Buyer / Repeat Buyer / Business Setup Phase / Execution Phase
  sourcingStyle?: string; // catalog_driven / spec_driven / brand_driven / application_driven
  buyingPattern?: string; // trial_first / bulk_first / inventory_builder / one_time_capex / repeat_procurement
  decisionStyle?: string; // Needs Guidance / Self Driven / Hybrid
  infoSeeking?: 'Low' | 'Medium' | 'High';
  supplierPreference?: string; // Manufacturer Preferred / Trader Preferred / No Preference
  localityPreference?: string; // Local Only / Regional / Pan India
  engagement?: string; // WhatsApp Friendly / Image Sharing Buyer / Call First Buyer / Low Response Buyer
  responseSensitivity?: string; // Low Tolerance For Delay / Patient / Unknown
  multiSku?: boolean;
  summary?: string; // one-line buyer summary for the seller
  tags?: string[]; // short behaviour tags
  confidence?: number; // 0-1 overall confidence in the deduction
  // P0 Nature engine (Tier-2 structural inference). Institution type from the email domain — a
  // first-party signal. Evidence-gated {value, confidence, evidence} so the consume-gate can trust it.
  nature?: string; // e.g. "Academic / Research Institution" · "Government / PSU" · "Corporate / Business"
  natureConfidence?: number; // 0-100
  natureEvidence?: string[];
  // P1 Authority engine (Tier-2 structural inference). Buyer's role/seniority from their DESIGNATION
  // — a first-party signal. Evidence-gated, anti-hallucination: only what the title PROVES (a
  // "Professor" is a Researcher, never auto a Decision-Maker; "Purchase Manager" is Procurement).
  authority?: string; // human label: "Decision-Maker" · "Procurement" · "Researcher" · "Influencer"
  authorityRole?: string; // machine key: decision_maker | procurement | researcher | influencer
  authorityConfidence?: number; // 0-100
  authorityEvidence?: string[];
  // P2 Procurement Model (persistent) — HOW this buyer procures, across requirements (a PRIOR, not
  // today's order). LLM-derived from history; the per-order requirementMode still OUTRANKS it.
  procurementModel?: string; // Project-based | Recurring Supply | Capex | Maintenance/MRO | Replacement | Expansion
  procurementModelConfidence?: number; // 0-100
}

// ════════════════════════════════════════════════════════════════════════════
// BTE-v1.1 — the Buyer Twin (the first-class object EVERY consumer reads).
// "We are not building a Smart RFQ; we're building a Buyer Twin Engine, and the
// RFQ is its first consumer." Each inferred trait carries an EVIDENCE LEDGER so
// every deduction is explainable + auditable — never a black box.
// ════════════════════════════════════════════════════════════════════════════
// 'rfq_session' = first-party behaviour OBSERVED while the buyer filled the RFQ (BTE-v1.3).
// It is source-separated from the 6 historical sources so we never confuse what we SAW the
// buyer do now with what we INFERRED from their past.
export type TwinSource = 'pns' | 'whatsapp' | 'csl' | 'bl_history' | 'isq' | 'profile' | 'rfq_session';
export interface TwinEvidence {
  source: TwinSource;
  date: string; // ISO/display date, or '' if the source carries no timestamp
  signal: string; // the concrete observation, grounded in the signal pool
}
export interface TwinSignal { source: TwinSource; date: string; signal: string; }
// A single deduced trait + the receipts that justify it. No receipts ⇒ dropped.
// v1.2: TEMPORAL + self-aware — carries recency, stability over time, and conflict
// count so confidence is never "magical". last_seen/trait_stability are computed in
// CODE from the grounded evidence (not LLM-guessed); contradictions_count is LLM-flagged.
export interface TemporalInferredTrait {
  value: string | boolean | number;
  confidence: number; // 0-100 — certainty NOW
  trait_stability: number; // 0-100 — consistency over time/interactions (code-derived)
  contradictions_count: number; // conflicting signals seen (keeps confidence honest)
  last_seen: string; // most-recent evidence date ('' if the sources carry no date)
  evidence: TwinEvidence[];
}
// Back-compat alias (existing imports keep working).
export type InferredTrait = TemporalInferredTrait;
// Time-bound intent clustering — recency beats history.
export interface IntentCluster {
  intent: string;
  signal_count: number;
  last_seen: string;
}
export interface BuyerTwin {
  glid: string;
  compiled_at: string; // ISO 8601
  buyer_version: number; // increments on a major profile shift (real versioning = backend)
  major_profile_shift_detected: boolean; // e.g. Trader → Manufacturer evolution
  twin_generation_time_ms?: number; // heavy-pass latency (for tuning)
  total_signal_count?: number; // how many raw signals fed the compile
  // Master gate — dictates TRUST (use it) vs ASK (confirm/discover) globally.
  twin_confidence: {
    overall_score: number; // 0-100, from evidence volume + richness
    evidence_base: { pns_calls: number; whatsapp_events: number; bls_created: number; csl_events: number };
    freshness: 'Fresh' | 'Moderate' | 'Stale' | 'Unknown'; // recency of the latest signal
    last_signal_at: string; // most-recent dated signal ('' if none dated)
  };
  // The Question Planner's queue — dimensions we have NO evidence for. The planner
  // asks from HERE, never from a hardcoded category list.
  explicit_unknowns: string[];
  // Hard constraints the buyer stated — the "Not" profile. NEVER violate these.
  explicit_negative_signals: string[];
  // Layer A — stable identity (DIRECT facts; never LLM-invented except business_type).
  layer_a_identity: {
    city: string;
    state: string;
    business_type: string; // primary role — inferred from company_desc + persona evidence
    secondary_roles?: string[]; // multi-intent buyers aren't a binary (e.g. Manufacturer + Trader)
    language: string;
    verified: boolean;
    company_desc: string | null;
  };
  // Layer B — behavioural twin (built over months). Optional: omitted if no evidence.
  layer_b_behavioral: {
    whatsapp_affinity?: InferredTrait;
    catalog_driven?: InferredTrait;
    image_affinity?: InferredTrait;
    local_preference?: InferredTrait;
    response_sensitivity?: InferredTrait;
    decision_style?: InferredTrait;
  };
  // Layer C — commercial intelligence (the gold). Intent is SPLIT: baseline history
  // vs the active intent for "now" (the anomaly detector).
  layer_c_commercial_intelligence: {
    inventory_builder?: InferredTrait;
    multi_category_buyer?: InferredTrait;
    bulk_orientation?: InferredTrait;
    trial_first?: InferredTrait;
    historical_categories: string[];
    recent_intent_clusters: IntentCluster[]; // time-bound: what they're sourcing for LATELY
    buyer_intent_history: Record<string, number>; // baseline distribution
    current_active_intent?: InferredTrait; // best hypothesis for "now" — confirmed in the RFQ
    // Stub for downstream Matchmaking/Recommendations — what the buyer ultimately sources for.
    attribution_confidence: { inferred_product_mapping: string | null; confidence: number };
  };
  // BTE-v1.3 — PRESENT behaviour, OBSERVED while the buyer fills the RFQ (not history-inferred).
  // Kept as its own layer so the seam between "what we saw them do NOW" and "what we inferred
  // from the PAST" is never blurred. DESCRIBES the buyer (lowest in the decision hierarchy:
  // Current Requirement > Mode > Intent > Verified > Persona/behaviour) — it never originates or
  // overrides the current requirement. Strengthens across sessions (session_count → stability).
  observed_session_behavior?: ObservedSessionBehavior;
  // OBSERVED external footprint (mobile-keyed lookups — Befisc identity + Sign3 digital footprint +
  // World). Attached to the Twin for visibility/persistence, but OBSERVED-only — NEVER a planning
  // input (a lookup can be wrong/stale; it enriches the buyer model, it does not drive specs).
  observed_external?: ObservedExternal;
  summary: string; // one-line, seller-valuable, no PII
}

export interface ObservedExternal {
  fetched_at: string;
  befisc?: { name?: string; pan?: string; income?: string; dob?: string; gender?: string; age?: string; altPhones?: number; email?: string; address?: string };
  sign3?: { socialProfiles?: number; operator?: string; breaches?: number; platforms?: string[]; linked?: string };
  world?: { summary?: string; confidence?: number };
  notes?: string[]; // e.g. "Befisc: Source down (302)"
}

// ── BTE-v1.3: observed in-session RFQ-filling behaviour ───────────────────────
// Every trait carries receipts (rfq_session evidence) and a MODEST confidence — a single
// session is weak evidence, so confidence is capped and trait_stability stays low until the
// same behaviour is seen again across sessions (mergeObservedBehavior raises it).
export interface ObservedSessionBehavior {
  spec_engagement?: InferredTrait;     // High/Medium/Low — hands-on & spec-literate vs delegates detail to seller
  flexibility?: InferredTrait;         // High/Medium — removed specs (×) → open to seller options on those dims
  question_engagement?: InferredTrait; // High/Low — answers the why/persona questions vs skips (transactional)
  urgency_posture?: InferredTrait;     // Immediate/Planned/Flexible — from the delivery-timeline pick
  commercial_posture?: InferredTrait;  // Advance-led/Credit-seeking/COD/Finance-seeking — from the payment pick
  independence?: InferredTrait;        // High/Medium — overrode AI-suggested spec(s); own spec knowledge
  session_count: number;               // how many RFQ sessions this behaviour has been observed across
  observed_at: string;                 // ISO of the latest observation
}

// Pure, generic distiller: in-session RFQ-filling metrics → observed behavioural traits.
// NO category literals — only generic ratios/counts and the form's own universal logistics
// enums (delivery/payment). Exported so the harness and the proxy share one implementation.
export interface SessionBehaviorInput {
  specsFilledByUser: number;   // specs the buyer set/overrode by hand
  specsAvailable: number;      // category (ISQ) specs on offer
  specsOverridden: number;     // AI-suggested specs the buyer REPLACED with their own value (deduped)
  specsRemoved: number;        // specs the buyer explicitly removed (×)
  personaQsAnswered: number;   // why/persona/intent questions answered
  personaQsSkipped: number;    // why/persona/intent questions skipped
  deliveryTimeline?: string;   // raw form value (universal enum)
  paymentTerms?: string;       // raw form value (universal enum)
  observedAt: string;          // ISO timestamp (injected — keeps the fn pure/testable)
}
export function distillSessionBehavior(inp: SessionBehaviorInput): ObservedSessionBehavior {
  const ev = (signal: string): TwinEvidence[] => [{ source: 'rfq_session', date: inp.observedAt.slice(0, 10), signal }];
  const trait = (value: string, confidence: number, stability: number, signal: string, contradictions = 0): InferredTrait =>
    ({ value, confidence: Math.min(60, Math.max(0, Math.round(confidence))), trait_stability: Math.min(60, Math.max(0, Math.round(stability))), contradictions_count: contradictions, last_seen: inp.observedAt.slice(0, 10), evidence: ev(signal) });
  const out: ObservedSessionBehavior = { session_count: 1, observed_at: inp.observedAt };

  // spec_engagement — how hands-on the buyer is with spec detail. Ratio of specs they filled
  // by hand (+ persona answers) against what was on offer. More specs available ⇒ more confident.
  const ratio = inp.specsAvailable > 0 ? inp.specsFilledByUser / inp.specsAvailable : 0;
  const handsOn = inp.specsFilledByUser + inp.personaQsAnswered;
  if (handsOn >= 1) {
    const conf = 35 + Math.min(20, inp.specsAvailable * 2); // up to ~55 with a rich spec set
    const sig = `Filled ${inp.specsFilledByUser}/${inp.specsAvailable} specs by hand + answered ${inp.personaQsAnswered} detail question(s)`;
    if (ratio >= 0.5 || inp.specsFilledByUser >= 6) out.spec_engagement = trait('High', conf, 30, sig);
    else if (ratio >= 0.2 || inp.specsFilledByUser >= 2) out.spec_engagement = trait('Medium', conf - 5, 28, sig);
    else out.spec_engagement = trait('Low', conf - 10, 26, `${sig} — delegates spec detail to the seller`);
  }

  // flexibility — removing a spec (×) is an explicit "this dimension isn't a hard constraint for me".
  if (inp.specsRemoved >= 1) {
    out.flexibility = trait(inp.specsRemoved >= 2 ? 'High' : 'Medium', 30 + inp.specsRemoved * 6, 28,
      `Removed ${inp.specsRemoved} spec(s) (×) — open to seller options on those dimensions`);
  }

  // question_engagement — answers the why/persona questions vs skips them (low patience / transactional).
  const qTotal = inp.personaQsAnswered + inp.personaQsSkipped;
  if (qTotal >= 1) {
    const sig = `Answered ${inp.personaQsAnswered}, skipped ${inp.personaQsSkipped} of the why/persona question(s)`;
    if (inp.personaQsSkipped > 0 && inp.personaQsAnswered === 0) out.question_engagement = trait('Low', 40, 30, `${sig} — transactional / time-pressed; ask less`);
    else if (inp.personaQsAnswered >= 2 && inp.personaQsSkipped === 0) out.question_engagement = trait('High', 45, 32, `${sig} — cooperative`);
    else out.question_engagement = trait('Medium', 38, 28, sig);
  }

  // urgency_posture — interprets the universal delivery-timeline enum (generic keyword, not a category).
  const dt = (inp.deliveryTimeline || '').toLowerCase();
  if (dt) {
    const val = /immediate|urgent|today|asap|24 ?h|same.?day/.test(dt) ? 'Immediate'
      : /flex|no rush|anytime|whenever/.test(dt) ? 'Flexible' : 'Planned';
    out.urgency_posture = trait(val, 50, 35, `Chose delivery: "${inp.deliveryTimeline}"`);
  }

  // commercial_posture — interprets the universal payment-terms enum.
  const pt = (inp.paymentTerms || '').toLowerCase();
  if (pt) {
    const val = /advance/.test(pt) ? 'Advance-led'
      : /credit|post.?delivery|net ?\d/.test(pt) ? 'Credit-seeking'
      : /loan|finance|emi/.test(pt) ? 'Finance-seeking'
      : /cod|cash/.test(pt) ? 'COD' : 'Stated';
    out.commercial_posture = trait(val, 50, 35, `Chose payment: "${inp.paymentTerms}"`);
  }

  // independence — the buyer REPLACED AI-suggested spec(s) with their own value. A clean,
  // keystroke-safe "I know my spec better than your guess" signal (deduped per spec). Only emits
  // on an actual override; 0 overrides is ambiguous (accepted, or no suggestion existed) ⇒ omit.
  if (inp.specsOverridden >= 1) {
    out.independence = trait(inp.specsOverridden >= 2 ? 'High' : 'Medium', 35 + inp.specsOverridden * 6, 28,
      `Overrode ${inp.specsOverridden} AI-suggested spec(s) with own value — strong own spec knowledge`);
  }

  return out;
}

// Merge a PRIOR observation (e.g. from a previous session) with the CURRENT one. Re-seeing the
// SAME value raises stability/confidence (the trait is consistent over time); a DIFFERENT value
// keeps the most recent and records a contradiction (the trait is volatile). Prior traits not
// re-observed this session are CARRIED FORWARD (still behaviour we have). This is the flywheel:
// every RFQ makes the next read a little stronger. Pure ⇒ harness-tested.
export function mergeObservedBehavior(prior: ObservedSessionBehavior | null | undefined, curr: ObservedSessionBehavior): ObservedSessionBehavior {
  if (!prior) return curr;
  const keys = ['spec_engagement', 'flexibility', 'question_engagement', 'urgency_posture', 'commercial_posture', 'independence'] as const;
  const merged: ObservedSessionBehavior = { session_count: (prior.session_count || 1) + 1, observed_at: curr.observed_at };
  for (const k of keys) {
    const p = prior[k]; const c = curr[k];
    if (p && c) {
      const same = String(p.value) === String(c.value);
      merged[k] = {
        value: c.value, // most recent wins
        confidence: Math.min(75, Math.round(same ? Math.max(p.confidence, c.confidence) + 8 : (p.confidence + c.confidence) / 2)),
        trait_stability: same ? Math.min(85, p.trait_stability + 15) : Math.max(20, p.trait_stability - 12),
        contradictions_count: p.contradictions_count + (same ? 0 : 1),
        last_seen: c.last_seen,
        evidence: [...p.evidence, ...c.evidence].slice(-6),
      };
    } else {
      merged[k] = c || p; // carry forward whichever side has it
    }
  }
  return merged;
}

// ── SERVER-SIDE ONLY ──────────────────────────────────────────────────────────
// Pure transform: raw 7-source webhook payload → PII-safe EnrichmentProfile.
// Operates on raw PII; MUST run on the proxy, never in the browser. Exported so
// the proxy and tests can share one implementation. `nowIso` is injected so the
// function stays pure/testable.
export function deriveEnrichment(raw: unknown, nowIso: string): EnrichmentProfile | null {
  if (!Array.isArray(raw)) return null;
  const pick = (key: string): unknown => {
    for (const el of raw as Array<Record<string, unknown>>) {
      if (el && key in el) {
        const v = el[key];
        if (typeof v === 'string') {
          try { return JSON.parse(v); } catch { return v; }
        }
        return v;
      }
    }
    return undefined;
  };
  const bp = (pick('buyer_profile') as Record<string, unknown>) || {};
  const pns = (pick('pns_data') as Array<Record<string, unknown>>) || [];
  const isq = (pick('prev_isq_data') as Array<Record<string, unknown>>) || [];
  const bl = (pick('prev_bl_data') as Array<Record<string, unknown>>) || [];
  const wa = (pick('whatsapp_data') as unknown[]) || [];
  const csl = (pick('csl_data') as Array<Record<string, unknown>>) || [];
  const wi = (pick('whatsapp_inbound') as Record<string, unknown>) || {};
  // Transcript signals accumulated for the LLM behavioural pass.
  const callSignals: string[] = [];
  const applications: string[] = [];
  const sellerQueriesAll = new Set<string>();
  const langs = new Set<string>();

  const str = (v: unknown) => (v == null ? undefined : String(v).trim() || undefined);
  const cleanHtml = (s?: string) =>
    s ? s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() : undefined;
  const daysSince = (d: unknown) => {
    const t = Date.parse(String(d));
    return Number.isFinite(t) ? Math.round((Date.parse(nowIso) - t) / 86_400_000) : undefined;
  };

  // Persona from the most recent informative call.
  let persona: EnrichmentProfile['persona'];
  const categories: NonNullable<EnrichmentProfile['categories']> = [];
  for (const call of pns) {
    const ed = (call?.extracted_data as Record<string, unknown>) || {};
    const ev = (((ed.metadata as Record<string, unknown>)?.call_type as Record<string, unknown>)?.evidence) as
      | Record<string, unknown>
      | undefined;
    if (ev && !persona) {
      const scale = str(ev.quantity_scale);
      persona = {
        type: str(ev.buyer_persona),
        scale: scale === 'Low' || scale === 'Medium' || scale === 'High' ? scale : undefined,
        commercial: /commercial/i.test(String(ev.order_type || '')),
        repeatBuyer: ev.repeat_buyer === true,
      };
    }
    // Per-call behavioural signals → digest for the LLM profile pass.
    const md = (ed.metadata as Record<string, unknown>) || {};
    const purpose = str(md.call_purpose);
    const intent = (md.buyer_intent as Record<string, unknown>) || {};
    const lvl = str(intent.intent_level);
    const narr = str(intent.narrative);
    if (purpose || lvl || narr) callSignals.push(`[${purpose || 'call'}/${lvl || '?'}] ${(narr || '').slice(0, 140)}`);
    const lang = str(md.primary_language); if (lang) langs.add(lang);
    const app = str(md.intended_application); if (app) applications.push(app);
    const sq = ((md.additional_details as Record<string, unknown>)?.seller_queries as Array<Record<string, unknown>>) || [];
    sq.forEach((q) => { const t = str(q?.query); if (t) sellerQueriesAll.add(t); });
    for (const p of (ed.products as Array<Record<string, unknown>>) || []) {
      const mcat = str((p?.most_specific_category as Record<string, unknown>)?.name);
      if (!mcat) continue;
      const knownSpecs: Record<string, string> = {};
      for (const s of (p?.specifications as Array<Record<string, unknown>>) || []) {
        const n = str(s?.name); const val = str(s?.value);
        if (n && val) knownSpecs[n] = val;
      }
      categories.push({
        mcat,
        source: 'call',
        sellerQuestions: sq.map((q) => str(q?.query)).filter(Boolean) as string[],
        knownSpecs: Object.keys(knownSpecs).length ? knownSpecs : undefined,
      });
    }
  }
  for (const r of isq) {
    const mcat = str(r?.title);
    if (!mcat) continue;
    const isqAnswers: Record<string, string> = {};
    for (const a of (r?.isq as Array<Record<string, unknown>>) || []) {
      const n = str(a?.IM_SPEC_MASTER_DESC); const val = str(a?.ISQ_RESPONSE);
      if (n && val) isqAnswers[n] = val;
    }
    categories.push({ mcat, source: 'isq', recencyDays: daysSince(r?.post_date), isqAnswers });
  }
  for (const b of bl) {
    const mcat = str(b?.ETO_OFR_TITLE);
    if (mcat) categories.push({ mcat, source: 'buylead', recencyDays: daysSince(b?.ETO_OFR_POSTDATE_ORIG) });
  }

  // ── Direct behavioural signals (no LLM) ──
  const domains = [...new Set(categories.map((c) => c.mcat).filter(Boolean))];
  const waMsgs = wa.length;
  const affinity: 'Low' | 'Medium' | 'High' | undefined =
    waMsgs > 30 ? 'High' : waMsgs > 5 ? 'Medium' : waMsgs > 0 ? 'Low' : undefined;
  if (domains.length || waMsgs) {
    persona = {
      ...(persona || {}),
      domains: domains.length ? domains : undefined,
      multiSku: domains.length > 1,
      whatsappMsgs: waMsgs || undefined,
      whatsappAffinity: affinity,
    };
  }

  // ── BTE-v1.1 evidence pool: dated, sourced signals the Twin compiler cites ──
  // Built from the structured sources so every Twin trait can show its receipts.
  const signals: TwinSignal[] = [];
  const push = (source: TwinSource, date: string, signal?: string) => {
    const t = (signal || '').trim();
    if (t) signals.push({ source, date: date || '', signal: t.slice(0, 200) });
  };
  // profile — who they are (their own business description is gold)
  const companyDesc = cleanHtml(str(bp.glusr_usr_company_desc) || str(bp.glusr_usr_sellinterest));
  if (companyDesc) push('profile', '', `Own business: ${companyDesc}`);
  if (str(bp.designation)) push('profile', '', `Designation: ${str(bp.designation)}`);
  if (bp.verified_business_buyer_flag) push('profile', '', 'Verified business buyer');
  if (str(bp.location_preference))
    push('profile', '', `Location preference code ${str(bp.location_preference)} (${[str(bp.city), str(bp.locality)].filter(Boolean).join(', ')})`);
  // pns — narratives, blockers, applications (the richest evidence)
  for (const call of pns) {
    const ed = (call?.extracted_data as Record<string, unknown>) || {};
    const md = (ed.metadata as Record<string, unknown>) || {};
    const intent = (md.buyer_intent as Record<string, unknown>) || {};
    push('pns', '', `${str(md.call_purpose) || 'call'} (${str(intent.intent_level) || '?'}): ${str(intent.narrative) || ''}`);
    ((ed.lead_tag as Record<string, unknown>)?.deal_blockers as string[] | undefined)?.forEach((b) => push('pns', '', `Deal blocker: ${b}`));
    if (str(md.intended_application)) push('pns', '', `Stated application: ${str(md.intended_application)}`);
  }
  // bl + isq — what they enquired, when
  for (const b of bl) push('bl_history', String(str(b?.ETO_OFR_POSTDATE_ORIG) || ''), `Enquiry: ${str(b?.ETO_OFR_TITLE) || ''}`);
  for (const r of isq) {
    const ans = ((r?.isq as Array<Record<string, unknown>>) || [])
      .map((a) => `${str(a?.IM_SPEC_MASTER_DESC)}=${str(a?.ISQ_RESPONSE)}`)
      .filter((x) => !/undefined/.test(x))
      .slice(0, 5)
      .join(', ');
    push('isq', String(str(r?.post_date) || ''), `RFQ: ${str(r?.title) || ''}${ans ? ` (${ans})` : ''}`);
  }
  // csl — browse/search terms = live intent; glb_city = where the buyer browses from (N3)
  const cslTerms = new Set<string>();
  const cityFreq: Record<string, number> = {};
  for (const c of csl) {
    const gc = str(c?.glb_city);
    if (gc && gc !== '-') cityFreq[gc] = (cityFreq[gc] || 0) + 1;
    const url = String(c?.request_url || '');
    const dec = (x?: string) => {
      try { return x ? decodeURIComponent(x.replace(/\+/g, ' ')).replace(/-/g, ' ').trim() : ''; } catch { return ''; }
    };
    [dec(url.match(/[?&]s=([^&]+)/)?.[1]), dec(url.match(/flname=([^&]+)/)?.[1])].forEach((term) => {
      if (term && term.length > 2 && !/^[0-9]+$/.test(term)) cslTerms.add(term);
    });
  }
  const cslBrowse = [...cslTerms].slice(0, 10);
  // N3: the buyer's likely city when the profile has none — most-frequent CSL browse city.
  const cslCity = Object.entries(cityFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
  cslBrowse.forEach((t) => push('csl', '', `Browsed/searched: ${t}`));
  // whatsapp_inbound — user-typed enquiries + image affinity
  const wiData = (wi?.data as Record<string, unknown>) || {};
  let waImageShared = !!Number(wiData.has_image);
  for (const m of (wiData.recent_messages as Array<Record<string, unknown>>) || []) {
    if (str(m?.sender) === 'user' && str(m?.message_type) === 'typed') {
      const need = (str(m?.content) || '').match(/Need best price for ([^\n,]+)/i);
      if (need) push('whatsapp', String(str(m?.timestamp) || ''), `Asked supplier for: ${need[1].trim()}`);
    }
  }
  // N4: the buyer's name often appears ONLY in the WhatsApp template greeting ("Hi *SANJAY*,")
  // when the profile carries none — capture it as a name fallback (debug + contact prefill).
  let waName: string | undefined;
  for (const m of wa as Array<Record<string, unknown>>) {
    if (str(m?.sender) === 'USER' && /image\/jpeg|mimeType/i.test(String(m?.message || ''))) waImageShared = true;
    if (!waName) { const mm = String(m?.message || '').match(/\bHi\s*\*([^*,\n]{2,40})\*/i); if (mm) waName = mm[1].trim(); }
  }
  const titleCase = (x?: string) => (x ? x.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : x);
  const waNameTitled = titleCase(waName);
  if (waMsgs) push('whatsapp', '', `${waMsgs} WhatsApp messages exchanged${waImageShared ? '; shares product images' : ''}`);
  // baseline intent distribution (count per stated application)
  const intentHistory: Record<string, number> = {};
  for (const a of applications) intentHistory[a] = (intentHistory[a] || 0) + 1;

  // ── Compact digest for the LLM behavioural pass ──
  const digestParts = [
    // The buyer's OWN business description — carries the establishment year + what they make/trade, so
    // the profile pass can read maturity correctly (an "Established 1995…" firm is NOT a setup-phase business).
    companyDesc ? `Own business (from profile): ${companyDesc.slice(0, 300)}` : '',
    persona?.type ? `Persona evidence: ${persona.type}, scale ${persona.scale || '?'}, ${persona.commercial ? 'commercial' : 'order type ?'}, repeat=${persona.repeatBuyer}` : '',
    domains.length ? `Categories enquired (${domains.length} → ${domains.length > 1 ? 'MULTI-SKU' : 'single-SKU'}): ${domains.slice(0, 12).join('; ')}` : '',
    applications.length ? `Applications: ${[...new Set(applications)].slice(0, 6).join('; ')}` : '',
    waMsgs ? `WhatsApp messages exchanged: ${waMsgs}` : '',
    [str(bp.city), str(bp.state), str(bp.locality)].filter(Boolean).length
      ? `Location: ${[str(bp.city), str(bp.state), str(bp.locality)].filter(Boolean).join(', ')} (profile location_preference code=${str(bp.location_preference) || '?'})`
      : '',
    langs.size ? `Languages: ${[...langs].join(', ')}` : '',
    sellerQueriesAll.size ? `What sellers asked this buyer: ${[...sellerQueriesAll].slice(0, 8).join('; ')}` : '',
    callSignals.length ? `Recent call signals (purpose/intent → narrative):\n- ${callSignals.slice(0, 8).join('\n- ')}` : '',
  ].filter(Boolean);

  return {
    glid: str(bp.glid) || '',
    fetchedAt: nowIso,
    buyer: {
      firstName: str(bp.first_name) || str(bp.ceo_fname) || waNameTitled, // N4: WhatsApp greeting name fallback
      lastName: str(bp.last_name) || str(bp.ceo_lname),
      fullName: [str(bp.first_name), str(bp.last_name)].filter(Boolean).join(' ') || waNameTitled || undefined,
      city: str(bp.city),
      state: str(bp.state),
      companyName: str(bp.company_name),
      designation: str(bp.designation),
      website: str(bp.website),
      // Strong UNIQUE business anchors when the profile carries them — these make a World/OSINT search
      // precise (vs a broad name+location search that returns namesakes).
      gst: str(bp.glusr_usr_gst) || str(bp.gstin) || str(bp.gst),
      udyam: str(bp.udyam) || str(bp.udyam_no) || str(bp.udyog_aadhar) || str(bp.glusr_usr_udyam),
      customerType: str(bp.glusr_usr_custtype_name),
      mobile: str(bp.glusr_usr_ph_mobile) || str(bp.mobile1) || str(bp.mobile) || debugFallbackMobile(str(bp.glid) || str(bp.Gluser_id)),
      email: str(bp.email1),
      verifiedBusiness: bp.verified_business_buyer_flag === true || bp.verified_business_buyer_flag === 'Y' || Number(bp.verified_business_buyer_flag) > 0,
      mobileVerified: !!str(bp.mobile_verified),
      emailVerified: !!str(bp.email_verified),
      locality: str(bp.locality),
      locationPreference: str(bp.location_preference),
      primaryLanguage: [...langs][0],
    },
    persona,
    categories,
    digest: digestParts.join('\n') || undefined,
    signals: signals.slice(0, 40),
    companyDesc,
    cslBrowse,
    cslCity,
    intentHistory,
    evidenceBase: { pns_calls: pns.length, whatsapp_events: waMsgs, bls_created: bl.length, csl_events: csl.length },
  };
}

// ── CLIENT (DEBUG) ────────────────────────────────────────────────────────────
// Calls the raw webhook directly (via the Vite proxy for CORS) and derives the
// profile client-side. Returns { profile, raw } so debug mode can show the raw
// payload too. Returns nulls on any failure → the form runs cold (additive).
// ── SERVER TRACE (n8n · E1) — the `_trace` the E1 node appends to the buyer-pull response. Captured
//    here (where the response lands) into a module store the V4 Observatory reads. null when E1 is
//    inactive / absent — the UI then shows "not active" rather than fabricating server data. ──
export interface ServerTraceNode { node?: string; status?: string; items_out?: number; confidence?: number | null; latency_ms?: number | null; output_keys?: string[]; output_sample?: string | null }
export interface ServerTrace { schema?: string; summary?: { trace_id?: string; session_id?: string; glid?: string; bl?: string; execution_id?: string | null; node_count?: number; nodes_ok?: number; nodes_missing?: number; total_items?: number; emitted_at?: string }; nodes?: ServerTraceNode[] }
let lastServerTrace: ServerTrace | null = null;
export function getServerTrace(): ServerTrace | null { return lastServerTrace; }
// raw buyer-pull response kept for the lineage resolver (fact → exact JSON path → value). Last pull only.
let lastRaw: unknown = null;
export function getEnrichmentRaw(): unknown { return lastRaw; }
// the ORIGINAL rich {sources:{…}} response (only when the bi-user-insights endpoint was used) — for the LLM-native
// extract path, which reads the per-source summaries. null when on the legacy -advanced endpoint.
let lastRich: unknown = null;
export function getEnrichmentRich(): unknown { return lastRich; }
let lastUnified: unknown = null;                                    // bi-buyer-unified response (last pull) — the buyer{} superset source of truth
export function getBuyerUnified(): unknown { return lastUnified; }

// ── bi-user-insights adapter (dual-mode) ──────────────────────────────────────────────────────────────────
// The new flow returns { glid, derived_anchors, sources:{ key:{summary,raw} } }. The legacy regex path (getTop)
// expects an ARRAY of singly-keyed objects ([{csl_data},{pns_data},…]). normalizeNewUserInsights reshapes the new
// shape → legacy so the FALLBACK regex path keeps working; an OLD-shape (array) response passes through unchanged
// (safe during a canary window where both endpoints are live). The EXTRACT path does NOT use this — it reads the
// rich {sources} directly via buyerProfileExtract.bundleFromResponse (no regex). derived_anchors are stored
// separately (identity prefill HINT) and NEVER injected into facts (keeps the ledger deterministic).
let lastAnchors: Record<string, unknown> | null = null;
export function getEnrichmentAnchors(): Record<string, unknown> | null { return lastAnchors; }
export function isNewUserInsightsShape(raw: unknown): raw is { sources: Record<string, { summary?: unknown; raw?: unknown }>; derived_anchors?: Record<string, unknown> } {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'sources' in (raw as Record<string, unknown>) && typeof (raw as { sources?: unknown }).sources === 'object';
}
// Helpers shared by normalizeNewUserInsights + the inline copy in mergedTwinStore.richToLegacy — keep them in sync.
const _obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const _arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// v7 `sources.isq.summary.isq_offers` ({mcat_id, specs:["Name: Value"]}) → the legacy {title, isq:[{IM_SPEC_MASTER_DESC,
// ISQ_RESPONSE}]} shape both deriveEnrichment AND ledger.buildLedger read. Pure reshape (no regex mining).
export function isqOffersToLegacy(isqSummary: unknown): Array<Record<string, unknown>> {
  return _arr(_obj(isqSummary).isq_offers).map((o) => {
    const oo = _obj(o);
    return {
      title: oo.category || oo.mcat_id, post_date: '', requirement_type: oo.requirement_type, probable_order_value: oo.probable_order_value,
      isq: _arr(oo.specs).map((sp) => { const t = String(sp); const i = t.indexOf(': '); return i > 0 ? { IM_SPEC_MASTER_DESC: t.slice(0, i), ISQ_RESPONSE: t.slice(i + 2) } : { IM_SPEC_MASTER_DESC: t, ISQ_RESPONSE: '' }; }),
    };
  });
}
// Reshape a rich {sources} response → the legacy array of singly-keyed objects. CRUCIAL: pns/bl/wa nest the array the
// legacy consumers ITERATE — deriveEnrichment does `for…of` (throws "X is not iterable" on the wrapper object) and
// buildLedger does asArr() (silently empties). Both want the INNER array, so we unwrap pns.raw.data /
// rfq.raw.RESPONSE.DATA.Listing / wa.raw.data.records. profile/whatsapp_inbound/befisc/sign3 are already the right
// shape. Verified against deriveEnrichment + ledger.buildLedger field reads. NOTE: the EXTRACT path does NOT use this.
export function normalizeNewUserInsights(raw: unknown): unknown {
  if (!isNewUserInsightsShape(raw)) { lastAnchors = null; return raw; }            // old shape → identity passthrough
  const s = raw.sources as Record<string, { summary?: unknown; raw?: unknown } | undefined>;
  lastAnchors = (raw.derived_anchors && typeof raw.derived_anchors === 'object') ? raw.derived_anchors : null;
  const rawOf = (k: string) => { const v = s[k]; return v && typeof v === 'object' && 'raw' in v ? (v as { raw?: unknown }).raw : v; };
  const sumOf = (k: string) => { const v = s[k]; return v && typeof v === 'object' && 'summary' in v ? (v as { summary?: unknown }).summary : undefined; };
  const pnsCalls = _arr(_obj(rawOf('pns')).data);                                                  // pns.raw = {Code,data:[calls]}
  const blListing = _arr(_obj(_obj(_obj(rawOf('rfq')).RESPONSE).DATA).Listing);                    // rfq.raw.RESPONSE.DATA.Listing
  const waRecords = _arr(_obj(_obj(rawOf('whatsapp_conversations')).data).records);                // wa.raw.data.records
  const usRaw = _obj(rawOf('usersince')); const usrx = _obj(usRaw.glusr_extra).glusr_usr_id ? usRaw.glusr_extra : rawOf('usersince'); // unwrap nested glusr_extra
  const legacy: Array<Record<string, unknown>> = [
    { csl_data: rawOf('csl') }, { pns_data: pnsCalls }, { buyer_profile: rawOf('profile') },
    { prev_bl_data: blListing }, { prev_isq_data: isqOffersToLegacy(sumOf('isq')) },
    { whatsapp_data: waRecords }, { whatsapp_inbound: rawOf('whatsapp_inbound') },
    { befisc: rawOf('befisc') }, { sign3: rawOf('sign3') }, { glusr_extra: usrx },
  ].filter((o) => { const v = Object.values(o)[0]; return v != null && !(Array.isArray(v) && v.length === 0); });
  // P7 · if the v9 node now carries a top-level requirement_brain (BUYER side), append it so UC2/L7 works
  // WITHOUT the dual-fetch. It's a FALLBACK: the parallel -advanced requirement_brain (which also has category
  // criticals) is unshifted ahead of it in fetchEnrichment, so the richer one still wins when both are present.
  const topRB = (raw as { requirement_brain?: unknown }).requirement_brain;
  if (topRB && typeof topRB === 'object') legacy.push({ requirement_brain: topRB });
  return legacy;
}
export function extractServerTrace(raw: unknown): ServerTrace | null {
  const pick = (o: unknown): ServerTrace | null => {
    if (o && typeof o === 'object' && '_trace' in o) { const t = (o as { _trace?: unknown })._trace; if (t && typeof t === 'object') return t as ServerTrace; }
    return null;
  };
  if (Array.isArray(raw)) { for (const it of raw) { const t = pick(it); if (t) return t; } return null; }
  return pick(raw);
}

// L1 · per-node health (n8n emits __health on the bi-user-insights response; the default -advanced path does not).
export interface HealthNode { node: string; ok: boolean; source?: string; latency_ms?: number; output_count?: number; keys?: number; status?: string; version?: string; fetched_at?: string; error_msg?: string; requested?: number }
let lastHealth: HealthNode[] = [];
export function getEnrichmentHealth(): HealthNode[] { return lastHealth; }

// OFFLINE HYDRATION (P4) — seed the module state from a captured snapshot so the dashboard renders WITHOUT a network
// pull (the downloaded self-contained HTML). No fetch, no LLM; consumers read these getters exactly as on a live pull.
export function seedEnrichment(snap: { rich?: unknown; raw?: unknown; serverTrace?: ServerTrace | null; health?: HealthNode[]; unified?: unknown }): void {
  if (snap.rich !== undefined) lastRich = snap.rich;
  if (snap.unified !== undefined) lastUnified = snap.unified;
  if (snap.raw !== undefined) lastRaw = snap.raw;
  if (snap.serverTrace !== undefined) lastServerTrace = snap.serverTrace ?? null;
  if (Array.isArray(snap.health)) lastHealth = snap.health;
}
export function extractHealth(raw: unknown): HealthNode[] {
  const h = raw && typeof raw === 'object' ? (raw as { __health?: unknown }).__health : undefined;
  const rows: HealthNode[] = Array.isArray(h) ? h.map((n) => { const o = (n && typeof n === 'object') ? (n as Record<string, unknown>) : {}; return { node: String(o.node || ''), ok: o.ok !== false, source: o.source != null ? String(o.source) : undefined, latency_ms: typeof o.latency_ms === 'number' ? o.latency_ms : undefined, output_count: typeof o.output_count === 'number' ? o.output_count : (typeof o.count === 'number' ? o.count : undefined), keys: typeof o.keys === 'number' ? o.keys : undefined, status: o.status != null ? String(o.status) : undefined, version: o.version != null ? String(o.version) : undefined, fetched_at: o.fetched_at != null ? String(o.fetched_at) : undefined, error_msg: o.error_msg != null ? String(o.error_msg) : undefined, requested: typeof o.requested === 'number' ? o.requested : undefined }; }) : [];
  // web-OSINT runs TWO engines (Parallel + Gemini-grounded) whose health is nested at sources.web_osint.__health.{parallel,gemini}
  // and is OMITTED from the top-level array — surface each as its own row so the Gemini engine's status is visible (it runs in
  // BOTH fast + full; Parallel only on full). Without this the whole web layer shows no health, especially on a fast pull.
  try {
    const wo = (raw as { sources?: { web_osint?: { __health?: unknown } } } | null)?.sources?.web_osint?.__health;
    if (wo && typeof wo === 'object') {
      for (const eng of ['parallel', 'gemini'] as const) {
        const e = (wo as Record<string, unknown>)[eng];
        if (e && typeof e === 'object') {
          const o = e as Record<string, unknown>;
          rows.push({ node: `web_osint · ${eng}`, ok: o.ok !== false, status: o.status != null ? String(o.status) : undefined, version: o.version != null ? String(o.version) : undefined, output_count: typeof o.proofs_count === 'number' ? o.proofs_count : (typeof o.basis_count === 'number' ? o.basis_count : undefined), fetched_at: o.fetched_at != null ? String(o.fetched_at) : undefined });
        }
      }
    }
  } catch { /* noop */ }
  return rows;
}
// (v11) pickRequirementBrain removed with the dual-fetch — requirement_brain now rides the single response's
// top-level field, recovered in normalizeNewUserInsights (lines ~666-670). One webhook, one call.

// DEDUP GUARD — "why are there always two runs, I fired once": the pull had NO in-flight guard, so it fired twice
// (React StrictMode double-invokes effects in dev via main.tsx; the landing auto-pull + a manual pull; or V3+V4 both
// mounting). Each unguarded call = a separate ~7-min n8n execution. This map coalesces concurrent callers for the SAME
// glid onto ONE fetch → n8n Executions shows a SINGLE run per GLID. Entry clears on settle, so a later re-pull works.
const enrichInFlight = new Map<string, Promise<{ profile: EnrichmentProfile | null; raw: unknown }>>();
export async function fetchEnrichment(glid: string, opts?: { fast?: boolean }): Promise<{ profile: EnrichmentProfile | null; raw: unknown }> {
  if (!glid?.trim()) return { profile: null, raw: null };
  // fast=1 (respond-after-facts): the workflow gates web_osint + udyam OFF (v16.5) → responds at the ~164s fast tier.
  // Deduped SEPARATELY from the full pull (different key) so the frontend can fire both in parallel: fast paints first,
  // full upgrades with web_osint/udyam. On a v16.4-or-earlier endpoint fast=1 is simply ignored (full pull) — safe.
  const _key = glid.trim() + (opts?.fast ? ':fast' : '');
  const _inflight = enrichInFlight.get(_key);
  if (_inflight) return _inflight; // a pull for this GLID is already running — share it, don't fire a 2nd execution
  const _run = (async (): Promise<{ profile: EnrichmentProfile | null; raw: unknown }> => {
  try {
    // `-advanced` is the v12 path: same 7 buyer sources PLUS the appended `requirement_brain`
    // item (Buyer Brain facts + known specs/intent) that the form-side resolver consumes. The
    // response is a strict superset of the old path, so existing get()-by-key parsing is unaffected.
    // TIMEOUT = SAFETY BACKSTOP ONLY (not the normal path). The n8n workflow is genuinely slow — observed
    // runs are 2m30s–3m12s because "Respond to Webhook2" waits for the slow EBI/Firecrawl + category
    // branches before responding (see the workflow: the buyer FACTS are ready in ~15-20s, but the response
    // is gated on the slowest branch). So the deadline must sit ABOVE the real pull time or it would abort a
    // working-but-slow pull. 240s lets a legit pull finish while still capping a TRUE infinite hang.
    // The real fix is server-side (respond after FACTS, async the EBI/category branches) + a non-blocking
    // client pull — a 3-minute blocking loader is the UX bug, not the timeout.
    // ENDPOINT (flag-gated): default = -advanced (current). VITE_BI_USER_INSIGHTS='1' → the new lean-CSL flow,
    // whose response is the rich {sources:{…}} shape. Default OFF = byte-for-byte current behaviour.
    const BI = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BI_USER_INSIGHTS) !== '0'; // DEFAULT ON (v9 is the live flow); set VITE_BI_USER_INSIGHTS=0 to fall back to -advanced
    const path = N8N_HOOK; // owner consolidated every n8n call onto one hook (api.ts N8N_HOOK); BI now only switches response-shape handling, not the URL
    const g = encodeURIComponent(glid.trim());
    // SINGLE FETCH (v11) — the dual-fetch is GONE (fixes the "4 executions"). The old second call hit the IDENTICAL
    // N8N_HOOK, so it was a pure duplicate. requirement_brain now rides the SAME response's top-level field
    // (recovered in normalizeNewUserInsights), so UC2/L7 keep working with ONE call. (StrictMode still double-invokes in dev.)
    // V16.2 pulls run ~7-10 min (Parallel web-OSINT + IDfy/Sign3 async polls). The old 240s (4min) abort fired BEFORE
    // n8n responded → screen fell back to "No buyer data". Bumped to 660s (11 min) to cover the real runtime.
    // (Proper fix is speeding up the pull — de-Wait the async poll loops — but this unblocks the dashboard now.)
    const res = await fetch(api(`/api/imworkflow/webhook/${path}?glid=${g}${opts?.fast ? '&fast=1' : ''}`), { signal: AbortSignal.timeout(660000) });
    if (!res.ok) return { profile: null, raw: null };
    const _resp = await res.json();
    // n8n "Respond to Webhook" may emit the single final-assemble item WRAPPED IN AN ARRAY ([{ glid, sources, … }]).
    // Unwrap to the {sources} object so the rich consumers (requirementsFromMerged / bundleFromResponse / identity / L1)
    // read it — obj(array) is {} and would silently blank every merged source (specs, category, buyer details).
    const rich = Array.isArray(_resp) ? (_resp.find((x) => x && typeof x === 'object' && 'sources' in x) ?? _resp[0] ?? _resp) : _resp;
    // flag-on → normalize the rich shape to legacy for ALL getTop() consumers (deriveEnrichment, lineage), but feed
    // the RICH response to ensureMergedTwin so the LLM extract path can read the per-source summaries.
    const legacy = BI ? normalizeNewUserInsights(rich) : rich; // normalizeNewUserInsights appends the response's top-level requirement_brain (no dual-fetch)
    lastRich = BI ? rich : null;                   // original rich {sources} → the LLM-native extract path
    lastRaw = legacy;                              // legacy shape → lineage resolver + getTop consumers unaffected
    lastServerTrace = extractServerTrace(legacy); // capture n8n E1 `_trace` if present (null otherwise)
    lastHealth = extractHealth(rich);              // L1 — per-node __health (BI path only; [] on -advanced)
    // EAGER synthesis — fired here so EVERY real pull (V3/V4/Observatory) builds the twin once, cached per GLID.
    // Dashboard = purely FRONTEND LLM (owner): the eager extract twin is built client-side from the raw pull. The unified
    // n8n LLM (bi-buyer-unified) is NOT used here — it powers ONLY the standalone (pure-backend replica).
    try { import('./mergedTwinStore').then((m) => m.ensureMergedTwin(glid.trim(), BI ? rich : legacy)).catch(() => undefined); } catch { /* noop */ }
    // deriveEnrichment is the legacy regex profile (built for the -advanced array shape). The BI-normalized
    // shape can differ per source (e.g. pns_data arrives as an object, not the array it iterates) → guard it so a
    // throw NEVER drops `raw`. The extract path + the ledger/trace consume `raw`/`rich`, not this profile, so
    // null here is a safe degrade. Default OFF (-advanced) → old array shape → computes exactly as before.
    let profile: EnrichmentProfile | null = null;
    try { profile = deriveEnrichment(legacy, new Date().toISOString()); } catch { profile = null; }
    return { profile, raw: legacy };
  } catch {
    return { profile: null, raw: null };
  }
  })();
  enrichInFlight.set(_key, _run);
  try { return await _run; } finally { enrichInFlight.delete(_key); }
}

// ── B · independent server-side-LLM buyer-profile endpoint (bi-buyer-profile-CARD) ────────────────────────────
// Calls the SEPARATE, self-contained "Buyer Profile Card" workflow on its OWN unique path `bi-buyer-profile-card`
// (never fires bi-user-insights-v10x, and distinct from the teammate's older `bi-buyer-profile` so we never call that).
// That workflow = the v17 pipeline + a DEDICATED profile-llm node → returns { glid, sources, derived_anchors,
// llm_profile (the card's reasoned attributes: business_type/stage/turnover/sourcing/…/story, each {value,confidence,
// reason,inferred}), __health }. The alternate UI (BuyerProfileCard / BuyerProfileStandalone) renders this directly —
// no client-side extract. Same dev-proxy (/api/imworkflow → imworkflow.intermesh.net), just a different webhook path.
const profileInFlight = new Map<string, Promise<unknown>>();
export async function fetchBuyerProfileLLM(glid: string): Promise<unknown> {
  if (!glid?.trim()) return null;
  const key = glid.trim();
  const hit = profileInFlight.get(key);
  if (hit) return hit;
  const run = (async (): Promise<unknown> => {
    try {
      const res = await fetch(api(`/api/imworkflow/webhook/bi-buyer-profile-card?glid=${encodeURIComponent(key)}`), { signal: AbortSignal.timeout(660000) });
      if (!res.ok) return null;
      const resp = await res.json();
      // n8n Respond may wrap the single item in an array — unwrap to the object carrying sources/llm_profile
      return Array.isArray(resp) ? (resp.find((x) => x && typeof x === 'object' && ('sources' in x || 'llm_profile' in x)) ?? resp[0] ?? resp) : resp;
    } catch { return null; }
  })();
  profileInFlight.set(key, run);
  try { return await run; } finally { profileInFlight.delete(key); }
}

// ── bi-buyer-unified — ONE endpoint, ONE LLM → buyer{} superset (UC1 profile + dashboard card). UC2 stays a separate call.
// Returns { glid, sources (DETERMINISTIC passthrough incl __health), derived_anchors, buyer:{ <attr>:{value,confidence,
// reason,grounded,sources[]} } }. Deduped in-flight (the StrictMode/double-run fix), 660s backstop, array-unwrap — mirrors
// fetchBuyerProfileLLM. Registry facts (GST/PAN/company/address/tenure/socials) are NEVER in buyer{} — they ride sources.*.
type BuyerUnified = { glid?: string; sources?: Record<string, unknown>; derived_anchors?: Record<string, unknown>; buyer?: Record<string, { value: string; confidence: number; reason?: string; grounded?: boolean; sources?: string[] }>; __health?: unknown };
const unifiedInFlight = new Map<string, Promise<BuyerUnified | null>>();
export async function fetchBuyerUnified(glid: string, opts?: { fast?: boolean }): Promise<BuyerUnified | null> {
  if (!glid?.trim()) return null;
  const g = glid.trim();
  const key = g + (opts?.fast ? ':fast' : '');   // fast tier gates Parallel web + Udyam OFF server-side; deduped separately from full
  const hit = unifiedInFlight.get(key);
  if (hit) return hit;
  const run = (async (): Promise<BuyerUnified | null> => {
    try {
      const res = await fetch(api(`/api/imworkflow/webhook/${BUYER_UNIFIED_HOOK}?glid=${encodeURIComponent(g)}${opts?.fast ? '&fast=1' : ''}`), { signal: AbortSignal.timeout(660000) });
      if (!res.ok) return null;
      const resp = await res.json();
      const u = Array.isArray(resp) ? (resp.find((x) => x && typeof x === 'object' && ('buyer' in x || 'sources' in x)) ?? resp[0] ?? resp) : resp;
      if (u && typeof u === 'object') { lastUnified = u; return u as BuyerUnified; }
      return null;
    } catch { return null; }
  })();
  unifiedInFlight.set(key, run);
  try { return await run; } finally { unifiedInFlight.delete(key); }
}

// ── CATEGORY BRAIN (mcat-keyed, cacheable, channel-agnostic) ──────────────────
// Separate call from the buyer pull: the buyer pull runs at GLID-fetch time (no product yet),
// but Category intelligence needs an mcat — known only AFTER the product resolves. So the form
// fires this when the mcat is committed. `mode=category` is a cheap READ; it returns the cached
// insights (`status:'hit'`) or `status:'building'` if the 7-day cache is cold. Reads never build —
// a cold mcat must be built once (fetchCategoryBuild) and then polled. NO category literals here.
export type CategoryIntelStatus = 'hit' | 'building' | 'error';
export interface CategoryIntelResult { status: CategoryIntelStatus; insights: unknown | null; mcatId: string }

export async function fetchCategoryIntel(mcatId: string, opts?: { fresh?: boolean }): Promise<CategoryIntelResult> {
  const id = String(mcatId || '').trim();
  if (!id) return { status: 'error', insights: null, mcatId: id };
  try {
    const fresh = opts?.fresh ? '&fresh=1' : '';
    const res = await fetch(api(`/api/imworkflow/webhook/${N8N_HOOK}?mode=category&mcat_id=${encodeURIComponent(id)}${fresh}`), { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { status: 'error', insights: null, mcatId: id };
    const raw = await res.json();
    const item = Array.isArray(raw) ? raw.find((x) => x && (x.category_insights !== undefined || x.category_cache !== undefined)) : raw;
    const rawInsights = (item && (item as Record<string, unknown>).category_insights) || null;
    // CRITICAL: n8n caches + returns category_insights as a JSON STRING (JSON.stringify(entry)).
    // Parse it so the resolver/consumer receive a real object — without this, category_intelligence
    // is a string, critical_specs is undefined, and catCriticals stays 0 on a HIT (silent consumption
    // failure: "Category intelligence used: No" despite a successful build). Already-object payloads
    // (defensive / future shape) pass through. A non-empty string that fails to parse → no usable
    // insights → keep polling (treat as still-building) rather than feeding garbage downstream.
    let insights: unknown = rawInsights;
    if (typeof rawInsights === 'string') { try { insights = JSON.parse(rawInsights); } catch { insights = null; } }
    if (insights && typeof insights === 'object') return { status: 'hit', insights, mcatId: id };
    // Any non-hit is "keep polling": cold cache, fresh-requested, or a malformed/unparseable entry.
    return { status: 'building', insights: null, mcatId: id };
  } catch {
    return { status: 'error', insights: null, mcatId: id };
  }
}

// Kick ONE category build (slow: ~3 min, Redash→LLM distill). DEBUG/testing convenience — in
// production a pre-warm job builds and the form only ever READS. Fire-and-forget; the caller polls
// fetchCategoryIntel until `hit`. The form guards this to once-per-mcat so it can't restart the
// build clock (the race that returns `building` forever).
export async function fetchCategoryBuild(mcatId: string, opts?: { fresh?: boolean }): Promise<void> {
  const id = String(mcatId || '').trim();
  if (!id) return;
  const fresh = opts?.fresh ? '&fresh=1' : '';
  try { await fetch(api(`/api/imworkflow/webhook/${N8N_HOOK}?mode=build_category&mcat_id=${encodeURIComponent(id)}${fresh}`), { signal: AbortSignal.timeout(25000) }); } catch { /* fire-and-forget */ }
}

// ─── Shared product-token normaliser (the ONE matcher) ────────────────────────
// Every "does the current product relate to the buyer's history?" check (off-profile
// detection, category match, repeat-purchase, persona match) MUST tokenise the same
// way — otherwise they disagree and split a returning buyer in two (the cable-lug
// bug: off-profile said "new area", matchCategory said "no match"). Generic +
// linguistic — NO category literals (the standing rule). Two things the old per-call
// tokenisers got wrong:
//   • length floor ≥4 DROPPED 3-letter heads ("lug"/"rod"/"pin"/"oil") — so "Panel
//     Lug" never connected to "cable lug(s)". Floor is now ≥3.
//   • exact match, so a plural ("lugs") never equalled its singular ("lug"). Each
//     token is singularised → "lugs"→"lug" matches "Panel Lug"→"lug".
// Conservative stemming (ss/us/is kept, sibilant+es handled, -ies→-y) so we never
// over-merge: "glass"≠"glas"; "pins"→"pin" but "pinch" stays "pinch".
const TOKEN_STOPWORDS = new Set([
  'for', 'the', 'and', 'with', 'from', 'your', 'our', 'this', 'that', 'any', 'all', 'per', 'via', 'new', 'use',
]);
function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'; // batteries → battery
  if (/(ss|us|is)$/.test(w)) return w; // glass / status / axis — unchanged
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // boxes → box, batches → batch
  if (w.endsWith('s')) return w.slice(0, -1); // lugs → lug, pumps → pump
  return w;
}
export function coreTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || TOKEN_STOPWORDS.has(w)) continue;
    out.add(singularize(w));
  }
  return out;
}

// Join helper: does the buyer have history in the category they're now searching?
// Fuzzy (token overlap via coreTokens) so "Oil Expellers" matches "Oil Expeller"/"Oil
// Mill" AND "cable lugs" matches "Panel Lug".
type EnrichmentCategory = NonNullable<EnrichmentProfile['categories']>[number];
export function matchCategory(
  profile: EnrichmentProfile | null,
  currentMcat: string
): EnrichmentCategory | undefined {
  if (!profile?.categories?.length || !currentMcat) return undefined;
  const cur = coreTokens(currentMcat);
  if (!cur.size) return undefined;
  let best: { cat: NonNullable<EnrichmentProfile['categories']>[number]; score: number } | undefined;
  for (const c of profile.categories) {
    const ct = coreTokens(c.mcat);
    const overlap = [...cur].filter((t) => ct.has(t)).length;
    const score = overlap / Math.max(1, Math.min(cur.size, ct.size));
    if (overlap > 0 && (!best || score > best.score)) best = { cat: c, score };
  }
  return best && best.score >= 0.5 ? best.cat : undefined;
}
