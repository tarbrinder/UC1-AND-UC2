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

import { api } from './api';

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
}

// ════════════════════════════════════════════════════════════════════════════
// BTE-v1.1 — the Buyer Twin (the first-class object EVERY consumer reads).
// "We are not building a Smart RFQ; we're building a Buyer Twin Engine, and the
// RFQ is its first consumer." Each inferred trait carries an EVIDENCE LEDGER so
// every deduction is explainable + auditable — never a black box.
// ════════════════════════════════════════════════════════════════════════════
export type TwinSource = 'pns' | 'whatsapp' | 'csl' | 'bl_history' | 'isq' | 'profile';
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
  summary: string; // one-line, seller-valuable, no PII
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
export async function fetchEnrichment(glid: string): Promise<{ profile: EnrichmentProfile | null; raw: unknown }> {
  if (!glid?.trim()) return { profile: null, raw: null };
  try {
    const res = await fetch(api(`/api/imworkflow/webhook/user-insights-glid123?glid=${encodeURIComponent(glid.trim())}`));
    if (!res.ok) return { profile: null, raw: null };
    const raw = await res.json();
    return { profile: deriveEnrichment(raw, new Date().toISOString()), raw };
  } catch {
    return { profile: null, raw: null };
  }
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
