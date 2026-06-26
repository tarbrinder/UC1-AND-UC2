// ─── TWIN ADAPTER — the load-bearing artifact for unifying V3/V4 onto the LLM-native extract twin ───────────
// Maps the flat FinalAttr[] (from buyerProfileExtract → extractBuyerProfileLLM) into the LAYERED BuyerTwin +
// BuyerProfile that ~40 form consumers read, so the cutover (behind VITE_EXTRACT_PROFILE) needs ZERO consumer
// edits. It REPRODUCES the code-assembled fields deriveBuyerTwin builds (twin_confidence saturating formula,
// freshness, layer scaffolding) and RE-DERIVES both deterministic override sites:
//   (1) layer_a_identity.business_type = institutionalRole(...) when the email domain drives it (P0 Identity Hierarchy)
//   (2) BuyerProfile.nature/authority via classifyEmailDomain/classifyDesignation (gated by natureDrives/authorityDrives)
// "No receipts → no trait": a layer_b/c trait is emitted ONLY when a FinalAttr supports it (layers are Optional),
// mirroring deriveBuyerTwin. The consumer-critical fields (current_active_intent, recent_intent_clusters,
// twin_confidence, explicit_negative_signals, business_type, city/company_desc) are ALWAYS populated.

import type { FinalAttr } from './synthesisEngine';
import type { BuyerTwin, BuyerProfile, InferredTrait, TwinEvidence, TwinSource } from './enrichment';
import { classifyEmailDomain, natureDrives, institutionalRole } from './nature';
import { classifyDesignation, authorityDrives } from './authority';

export interface TwinAdapterCtx {
  glid: string;
  nowIso: string;
  identity?: { city?: string; state?: string; language?: string; verified?: boolean; companyDesc?: string | null };
  counts?: { pns_calls?: number; whatsapp_events?: number; bls_created?: number; csl_events?: number };
  historicalCategories?: string[];
  intentHistory?: Record<string, number>;
  lastSignalAt?: string;        // most-recent dated signal (for freshness); '' if none
  totalSignalCount?: number;
  email?: string;               // for the nature override
  designation?: string;         // for the authority override
  companyName?: string;
  explicitNegatives?: string[]; // hard constraints (never-re-ask) — passed from the extract/legacy if available
  observed_external?: BuyerTwin['observed_external'];
  summary?: string;
}

const LMH = (v: string): 'Low' | 'Medium' | 'High' => /high|strong|yes|hot/i.test(v) ? 'High' : /low|weak|no|cold/i.test(v) ? 'Low' : 'Medium';
const isUnknownVal = (v: string): boolean => !v || /^(unknown|—|-|n\/?a|none|not (known|available|specified))$/i.test(String(v).trim());

export function finalsToBuyerTwin(finals: FinalAttr[], ctx: TwinAdapterCtx): BuyerTwin {
  const byKey = new Map<string, FinalAttr>();
  for (const f of finals || []) if (f && f.key) byKey.set(f.key, f);
  const val = (k: string): string => { const f = byKey.get(k); return f && !isUnknownVal(String(f.value)) ? String(f.value) : ''; };
  const conf = (k: string): number => { const f = byKey.get(k); return f ? Math.max(0, Math.min(100, Math.round(f.confidence || 0))) : 0; };
  const evOf = (k: string): TwinEvidence[] => {
    const f = byKey.get(k); if (!f || !f.llm) return [];
    return (f.llm.reasoning || []).slice(0, 2).map((r) => ({ source: 'profile' as TwinSource, date: '', signal: r.claim }));
  };
  // a FinalAttr → InferredTrait (only when the final has a real value); else undefined (trait omitted)
  const trait = (k: string, shape: 'LMH' | 'bool' | 'str' = 'str'): InferredTrait | undefined => {
    const v = val(k); if (!v) return undefined;
    const value = shape === 'LMH' ? LMH(v) : shape === 'bool' ? /yes|true|high|^repeat/i.test(v) : v;
    const f = byKey.get(k);
    const contradictions = f?.llm?.reasoning?.some((r) => r.rejected) ? 1 : 0;
    return { value, confidence: conf(k), trait_stability: Math.max(40, conf(k) - 10), contradictions_count: contradictions, last_seen: ctx.lastSignalAt || '', evidence: evOf(k) };
  };

  // ── twin_confidence — EXACT copy of deriveBuyerTwin's saturating formula ──
  const c = { pns_calls: ctx.counts?.pns_calls || 0, whatsapp_events: ctx.counts?.whatsapp_events || 0, bls_created: ctx.counts?.bls_created || 0, csl_events: ctx.counts?.csl_events || 0 };
  const sat = (n: number, k: number) => 1 - Math.exp(-n / k);
  const overall = Math.round(100 * (0.35 * sat(c.pns_calls, 3) + 0.25 * sat(c.whatsapp_events, 30) + 0.25 * sat(c.bls_created, 4) + 0.15 * sat(c.csl_events, 20)));
  const days = ctx.lastSignalAt ? (Date.parse(ctx.nowIso) - Date.parse(ctx.lastSignalAt)) / 86_400_000 : NaN;
  const freshness: BuyerTwin['twin_confidence']['freshness'] = Number.isNaN(days) ? 'Unknown' : days < 30 ? 'Fresh' : days < 90 ? 'Moderate' : 'Stale';

  // ── layer_a identity + business_type override (P0 Identity Hierarchy) ──
  const nature = classifyEmailDomain(ctx.email, ctx.companyName);
  const authority = classifyDesignation(ctx.designation);
  const company = byKey.get('company_identity');
  const companyDesc = ctx.identity?.companyDesc ?? (company && typeof company.value === 'object' ? null : (val('company_identity') || null));
  let businessType = val('business_type') || 'Business Buyer';
  if (natureDrives(nature)) businessType = institutionalRole(nature, authorityDrives(authority) ? authority.authorityRole : undefined) || businessType;

  // ── layer_c commercial intelligence (always populate the load-bearing fields) ──
  const activeIntentVal = val('current_active_intent') || val('products_of_interest') || val('buyer_persona') || val('industry');
  const clustersSrc = (ctx.historicalCategories && ctx.historicalCategories.length) ? ctx.historicalCategories : (val('products_of_interest') ? val('products_of_interest').split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);
  const recent_intent_clusters = clustersSrc.slice(0, 4).map((intent) => ({ intent, signal_count: 1, last_seen: ctx.lastSignalAt || '' }));

  const twin: BuyerTwin = {
    glid: ctx.glid,
    compiled_at: ctx.nowIso,
    buyer_version: 1,
    major_profile_shift_detected: false,
    total_signal_count: ctx.totalSignalCount ?? (finals || []).length,
    twin_confidence: { overall_score: overall, evidence_base: c, freshness, last_signal_at: ctx.lastSignalAt || '' },
    explicit_unknowns: (finals || []).filter((f) => f && f.state === 'Unknown').map((f) => f.key),
    explicit_negative_signals: dedupe([...(ctx.explicitNegatives || []), ...deriveNegatives(finals)]),
    layer_a_identity: {
      city: ctx.identity?.city || '',
      state: ctx.identity?.state || '',
      business_type: businessType,
      secondary_roles: val('industry') && val('industry') !== businessType ? [val('industry')] : undefined,
      language: val('language') || ctx.identity?.language || '',
      verified: !!ctx.identity?.verified,
      company_desc: companyDesc,
    },
    layer_b_behavioral: omitUndef({
      whatsapp_affinity: /whatsapp/i.test(val('preferred_channel')) ? trait('preferred_channel', 'LMH') : undefined,
      local_preference: trait('location_sourcing_preference', 'LMH'),
      response_sensitivity: trait('responsiveness', 'LMH'),
      decision_style: byKey.has('buyer_persona') ? trait('buyer_persona') : undefined,
    }),
    layer_c_commercial_intelligence: {
      historical_categories: ctx.historicalCategories || [],
      recent_intent_clusters,
      buyer_intent_history: ctx.intentHistory || {},
      bulk_orientation: trait('scale', 'LMH'),
      trial_first: trait('procurement_model', 'bool'),
      multi_category_buyer: clustersSrc.length > 1 ? { value: true, confidence: 70, trait_stability: 60, contradictions_count: 0, last_seen: ctx.lastSignalAt || '', evidence: [] } : undefined,
      current_active_intent: activeIntentVal ? { value: activeIntentVal, confidence: conf('current_active_intent') || conf('products_of_interest') || conf('buyer_persona') || 50, trait_stability: 50, contradictions_count: 0, last_seen: ctx.lastSignalAt || '', evidence: evOf('products_of_interest') } : undefined,
      attribution_confidence: { inferred_product_mapping: val('products_of_interest') || null, confidence: conf('products_of_interest') },
    },
    observed_external: ctx.observed_external,
    summary: ctx.summary || buildSummary(businessType, activeIntentVal, ctx.identity?.city),
  };
  return twin;
}

export function finalsToBuyerProfile(finals: FinalAttr[], ctx: TwinAdapterCtx): BuyerProfile {
  const byKey = new Map<string, FinalAttr>();
  for (const f of finals || []) if (f && f.key) byKey.set(f.key, f);
  const v = (k: string): string | undefined => { const f = byKey.get(k); return f && !isUnknownVal(String(f.value)) ? String(f.value) : undefined; };
  const cf = (k: string): number | undefined => { const f = byKey.get(k); return f ? f.confidence : undefined; };
  const shown = (finals || []).filter((f) => f && f.state && f.state !== 'Unknown');
  const profile: BuyerProfile = {
    persona: v('buyer_persona') || v('business_type'),
    maturity: v('maturity') || v('buyer_stage'),
    procurementModel: v('procurement_model'),
    supplierPreference: v('supplier_preference'),
    localityPreference: v('location_sourcing_preference'),
    engagement: v('preferred_channel'),
    responseSensitivity: v('responsiveness'),
    multiSku: undefined,
    summary: ctx.summary,
    confidence: shown.length ? Math.round(shown.reduce((s, a) => s + a.confidence, 0) / shown.length) / 100 : undefined,
  };
  // override site (2): nature (email-domain) + authority (designation) — first-party, anti-hallucination
  const nature = classifyEmailDomain(ctx.email, ctx.companyName);
  if (natureDrives(nature)) { profile.nature = nature.value; profile.natureConfidence = nature.confidence; profile.natureEvidence = nature.evidence; }
  const authority = classifyDesignation(ctx.designation);
  if (authorityDrives(authority)) { profile.authority = authority.value; profile.authorityRole = authority.authorityRole; profile.authorityConfidence = authority.confidence; profile.authorityEvidence = authority.evidence; }
  if (v('procurement_model')) profile.procurementModelConfidence = cf('procurement_model');
  return profile;
}

// ── small helpers ──
function dedupe(a: string[]): string[] { const seen = new Set<string>(); const out: string[] = []; for (const x of a) { const k = String(x).toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(x); } } return out; }
function omitUndef<T extends Record<string, unknown>>(o: T): T { const out = {} as Record<string, unknown>; for (const k in o) if (o[k] !== undefined) out[k] = o[k]; return out as T; }
function buildSummary(bt: string, intent: string, city?: string): string { return [bt, intent ? `sourcing ${intent}` : '', city ? `from ${city}` : ''].filter(Boolean).join(' · ') || 'Buyer'; }
// Best-effort negative-constraint extraction from finals (full parity needs the extract to emit explicit_negative_signals;
// until then ctx.explicitNegatives carries them + this catches hard-constraint phrasings in supplier_preference values).
function deriveNegatives(finals: FinalAttr[]): string[] {
  const out: string[] = [];
  for (const f of finals || []) {
    const v = String(f?.value || '');
    if (/\b(no traders?|oem only|don'?t call|manufacturer only|no resell|local only)\b/i.test(v)) out.push(v);
  }
  return out;
}
