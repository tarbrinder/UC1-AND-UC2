import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { X, Mic, Camera, ChevronDown, ChevronUp, MapPin, ArrowRight, LogIn, Pencil, Clock, CreditCard, User, Phone, CheckCircle2 } from 'lucide-react';
import type { RFQFormData, ISQSpec, FormStep } from '../types';
import { filterProducts, fetchProductSuggestions, stripQuantityPrefix, parseQuantityFromName } from '../utils/productNames';
import { calcScore, getScoreColor, getScoreLabel } from '../utils/score';
import { localDB } from '../lib/supabase';
import { voiceToSpecs, analyzeImage, getSpecHints, inferSpecsFromApplication, explainSpec, summarizeRequirement, generateEnrichmentQuestions, planRequirement, refineQuestions, deduceLogistics, deriveBuyerProfile, deriveBuyerTwin, classifyFieldTypes, deriveIntent, deriveBuyerStory, hasGeminiKey, getLLMHealth, onLLMActivity } from '../lib/gemini';
import { resolveExtractTwin, lastSignalAt, EXTRACT_TWIN_ON } from '../lib/twinCutover';
import { createCoverageRegistry, type FactSource } from '../lib/coverage';
import type { SpecGuide } from '../lib/gemini';
import { stripPII } from '../utils/pii';
import { classifySegment } from '../lib/questions/segment';
import { DEPTH_BY_SEGMENT } from '../lib/questions/types';
import type { DynQuestion, RequirementPlan, RequirementIntent } from '../lib/questions/types';
import { fetchEnrichment, fetchCategoryIntel, fetchCategoryBuild, matchCategory, debugFallbackMobile, coreTokens, distillSessionBehavior, mergeObservedBehavior } from '../lib/enrichment';
import type { EnrichmentProfile, BuyerProfile, BuyerTwin, ObservedSessionBehavior, ObservedExternal } from '../lib/enrichment';
import { runExternal, firecrawlOsint } from '../lib/externalRun';
import { isDebug } from '../lib/debugFlag';
import { classifyEmailDomain, natureDrives, institutionalRole } from '../lib/nature';
import { classifyDesignation, authorityDrives, authorityPlannerHint } from '../lib/authority';
import { resolveIdentity, identityLine } from '../lib/identity';
import type { IdentityResolution } from '../lib/identity';
import { distillSourceThemes } from '../lib/distill';
import { classifyOrderScale } from '../lib/quantity';
import { orderTrajectory, trajectoryShape, hasStory } from '../lib/trajectory';
import { tierBuyerIntelligence, decideTransfer, categoryRelatedness } from '../lib/transfer';
import { consume, formatDrivers } from '../lib/consumption';
import { checkConsistency } from '../lib/consistency';
import { scoreCompleteness } from '../lib/completeness';
import { classifyProcurement } from '../lib/procurement';
import { parseRequirementBrain, resolveRequirement } from '../lib/requirementBrain';
import type { RequirementBrainInput } from '../lib/requirementBrain';
import { extractConversationalSignals, formatConvSignals } from '../lib/conversationalSignals';
import { scoreRFQ, tallyUtilization } from '../lib/rfqScorecard';
import { plannerGate, gateHeadline, plannerInputsReady } from '../lib/plannerGate';
import type { GateSources } from '../lib/plannerGate';
import { renderMode } from '../lib/confidenceRender';
import { buildQuestionGraph } from '../lib/questionGraph';
import { buildCEOSummary } from '../lib/ceoSummary';
import { dealBlockerChecks, intentPatternHints, categoryBudgetBands, formatCategoryConsumption } from '../lib/categoryConsumption';
import type { DealBlocker, IntentPattern, PriceDistribution } from '../lib/categoryConsumption';
import { categoryConfidence, categoryConfidenceLine } from '../lib/categoryConfidence';
import type { CategoryPayload } from '../lib/categoryConfidence';
import { categoryLeaderboard, dispositionSummary } from '../lib/categoryDisposition';
import { intentLeaderboard, intentSummary, type IntentInput } from '../lib/intentDisposition';
import { questionQualityEval, intentQualityEval, categoryQualityEval, fusionQualityEval, plannerQualityEval, rfqQualityEval, leadQualityEval, outcomeEval, evaluateRFQ } from '../lib/rfqEvals';
import { pushEvalRun, getEvalRuns, evalTrend } from '../lib/evalLog';
import { PROMPTS_VERSION } from '../lib/gemini';
import { govern, STATE_ICON, cleanEvidence } from '../lib/governance';
import type { AttrState } from '../lib/governance';
import { detectContradictions } from '../lib/contradiction';
import type { Nudge } from '../lib/contradiction';
import type { ExternalRunResult, ExternalSeed } from '../lib/externalRun';
import type { WorldOsint } from '../lib/worldEnrichment';
import { SEED_QUESTIONS } from '../lib/questions/seed';

// Phase-2 feature flag: dynamic Quick-Questions engine. Off → today's form.
const QUESTION_ENGINE = true;
// Append ?debug=1 to surface each generated question's "why we ask" rationale.
const DEBUG_FROM_URL = isDebug(); // sticky within the tab — survives the dep-reopt reload that drops ?debug
// Confidence-&-Bias Gate keyword net (universal procurement terms, not category-
// specific) — brand/preference fields must never be auto-filled (the VEKA killer).
const PREFERENCE_RE = /\b(brand|make|manufacturer|oem|company\s*name|trademark|model\s*(name|no\.?|number)?|brand\s*name|made\s*by)\b/i;
// Human-readable reason a field is gated as preference (for the gate_decisions log).
const prefReason = (key: string): string =>
  /\b(brand|make|manufacturer|oem|made\s*by)\b/i.test(key) ? 'brand'
    : /\bmodel\b/i.test(key) ? 'model'
    : /\b(company\s*name|trademark)\b/i.test(key) ? 'company/trademark'
    : 'preference';

// Live compiled Twin from the window cache — survives stale closures captured
// inside useCallbacks (the spec-load / spec-help handlers don't list buyerTwin
// in their deps, so reading the cache gives the freshest Twin at call time).
const liveTwin = (): BuyerTwin | undefined =>
  (window as unknown as { __buyerTwin?: BuyerTwin }).__buyerTwin;

// PII-free, brand-free buyer background for LLM prompts (Phase 5a — "Twin
// everywhere" / Dumbledore's tote bag): carries WHO the buyer is into every LLM
// decision WITHOUT leaking contact info and WITHOUT ever naming a brand / make /
// model (that would bias the seller pool — the VEKA rule). Emits only the traits
// that actually exist on the Twin (no fabrication).
function twinPromptContext(t: BuyerTwin | null | undefined): string {
  if (!t) return '';
  const lc = t.layer_c_commercial_intelligence;
  const lb = t.layer_b_behavioral;
  const id = t.layer_a_identity;
  const isTrue = (tr?: { value: unknown }) => !!tr && (tr.value === true || tr.value === 'true');
  return [
    id.business_type ? `business type: ${id.business_type}` : '',
    id.secondary_roles && id.secondary_roles.length ? `also: ${id.secondary_roles.join('/')}` : '',
    lc.current_active_intent ? `likely buying for: ${lc.current_active_intent.value}` : '',
    lc.bulk_orientation && lc.bulk_orientation.value ? `scale: ${lc.bulk_orientation.value} volume` : '',
    isTrue(lc.inventory_builder) ? 'stocks inventory' : '',
    isTrue(lc.multi_category_buyer) ? 'buys across categories' : '',
    lb.decision_style && lb.decision_style.value ? `decision style: ${lb.decision_style.value}` : '',
    lb.local_preference && lb.local_preference.value === 'High' ? 'prefers local suppliers' : '',
  ].filter(Boolean).join(' · ');
}

// P5b — distil the Twin into PLANNER inputs (the "ruthless editor"). `known` =
// only HIGH-confidence (≥80) facts the planner must NOT re-ask → this is what
// produces "known buyer ⇒ fewer questions". `offProfile` = the CURRENT product
// shares no token with the buyer's history/active-intent → circuit-breaker, so we
// don't fast-track the usual intent (the "pump-maker buys a karaoke mic" case).
// Brand / PII are NEVER included (the VEKA rule).
// P1.4 — the buyer's EXPLICIT "no X / avoid X / without X" constraints, parsed into banned phrases so a
// spec VALUE naming a rejected thing is never auto-suggested. (Inclusion constraints like "OEM only" are
// left to the planner prompt — they don't map to one banned spec value.) Pure → unit-tested.
function parseNegativeBans(signals: string[]): string[] {
  const bans: string[] = [];
  for (const s of signals || []) {
    const m = String(s).toLowerCase().match(/\b(?:no|not|never|avoid|without|don'?t|dont|except)\s+([a-z][a-z0-9 -]{2,40})/);
    if (m) { const phrase = m[1].replace(/\b(please|thanks?|suppliers?|sellers?|vendors?|me|us)\b/g, ' ').replace(/\s+/g, ' ').trim(); if (phrase.length >= 3) bans.push(phrase); }
  }
  return bans;
}
function violatesNegativeBan(text: string, bans: string[]): boolean {
  const t = (text || '').toLowerCase();
  return bans.some((b) => { const tok = b.split(/\s+/).find((w) => w.length >= 4) || (b.length >= 4 ? b : ''); return !!tok && t.includes(tok); });
}

function buildTwinPlanInput(
  t: BuyerTwin,
  productName: string,
  isCovered?: (concept: string) => boolean
): { known: string; whyKnown: string[]; unknowns: string[]; negativeSignals: string[]; confidence: number; offProfile: boolean } {
  const lc = t.layer_c_commercial_intelligence;
  const lb = t.layer_b_behavioral;
  const id = t.layer_a_identity;
  const hi = (v?: { value: unknown; confidence?: number }) => !!v && typeof v.confidence === 'number' && v.confidence >= 80;
  const isTrue = (tr?: { value: unknown }) => !!tr && (tr.value === true || tr.value === 'true');
  // Collect the human-readable known facts AND the trait KEYS that qualified — the
  // keys become `why_fast_track` in debug (ChatGPT/Gemini ask: show WHICH signals
  // drove the decision, so a low accept-rate points straight at the noisy trait).
  const knownParts: string[] = [];
  const whyKnown: string[] = [];
  const add = (cond: boolean, label: string, key: string) => { if (cond) { knownParts.push(label); whyKnown.push(key); } };
  add(!!id.business_type, `business type: ${id.business_type}`, 'business_type');
  add(hi(lc.current_active_intent), `usually buying for: ${lc.current_active_intent?.value}`, 'current_active_intent');
  add(hi(lc.bulk_orientation), `scale: ${lc.bulk_orientation?.value} volume`, 'bulk_orientation');
  add(hi(lb.local_preference) && lb.local_preference?.value === 'High', 'prefers local suppliers', 'local_preference');
  add(hi(lc.inventory_builder) && isTrue(lc.inventory_builder), 'builds inventory (recurring)', 'inventory_builder');
  add(isTrue(lc.multi_category_buyer), 'buys across categories', 'multi_category_buyer');
  const known = knownParts.join(' · ');
  // #1: ONE shared tokeniser (coreTokens: ≥3 chars + plural-stem) so "cable lug(s)"
  // connects to a "Panel Lug" history — the old ≥4 filter dropped "lug" and called a
  // returning buyer off-profile.
  const hist = [...(lc.historical_categories || []), lc.current_active_intent?.value ? String(lc.current_active_intent.value) : '']
    .filter(Boolean)
    .join(' ');
  const pt = coreTokens(productName);
  const ht = coreTokens(hist);
  const overlap = [...pt].some((w) => ht.has(w));
  const offProfile = hist.trim().length > 0 && pt.size > 0 && !overlap;
  return {
    known,
    whyKnown,
    // P1.3 — drop unknowns we've ALREADY learned this session (covered in the registry) so the planner
    // spends its scarce question slots only on the genuinely-open unknowns (prioritised first by the prompt).
    unknowns: (t.explicit_unknowns || []).filter((u) => !(isCovered && isCovered(u))),
    negativeSignals: t.explicit_negative_signals || [],
    confidence: t.twin_confidence?.overall_score ?? 0,
    offProfile,
  };
}

// P5c — bundle the Twin's highest-confidence COMMERCIAL traits into ONE concierge
// confirmation ("we found these likely details — still correct?"). Multi-trait by
// design (ChatGPT): confirming several at once feels like a concierge, not an
// interrogation. PII-free, brand-free; highest-signal first; capped at 5 bullets.
function conciergeTraits(t: BuyerTwin): string[] {
  const lc = t.layer_c_commercial_intelligence;
  const lb = t.layer_b_behavioral;
  const id = t.layer_a_identity;
  const hi = (v?: { value: unknown; confidence?: number }) => !!v && typeof v.confidence === 'number' && v.confidence >= 70;
  const isTrue = (tr?: { value: unknown }) => !!tr && (tr.value === true || tr.value === 'true');
  const out: string[] = [];
  if (id.business_type) out.push(id.business_type);
  if (hi(lc.current_active_intent)) out.push(`Buying for: ${lc.current_active_intent!.value}`);
  if (hi(lc.bulk_orientation)) out.push(`${lc.bulk_orientation!.value} volume / bulk`);
  if (hi(lc.inventory_builder) && isTrue(lc.inventory_builder)) out.push('Inventory builder (recurring)');
  if (isTrue(lc.multi_category_buyer)) out.push('Buys across categories');
  if (hi(lb.local_preference) && lb.local_preference!.value === 'High') out.push('Prefers local suppliers');
  // Drop junk/empty traits ("Unknown", "Buying for: Unknown", "N/A") — never show a
  // blank or meaningless bullet in the concierge card.
  const JUNK = /(^|:\s*)(unknown|n\/?a|none|undefined|—|-)\s*$/i;
  return out.map((x) => (x || '').trim()).filter((x) => x && !JUNK.test(x)).slice(0, 5);
}

// One card in the "details for sellers" wizard — either a generated non-spec
// question, or a soft buyer-profile field (role/industry/size/frequency).
type PanelItem =
  | { kind: 'dyn'; q: DynQuestion }
  | { kind: 'role' }
  | { kind: 'industry' }
  | { kind: 'size' }
  | { kind: 'frequency' };

// P (Quick Re-post): one of the buyer's prior requirements, ready to re-post ("Buy again").
type PriorReq = { title: string; source: 'call' | 'isq' | 'buylead'; recencyDays?: number; specs: Record<string, string>; specCount: number };

// Phase-2/3 FOUNDATION — Requirement Understanding ("Final RFQ Vision"): one explainable persona/
// requirement dimension. Built from the Twin/profile the system ALREADY computes (no new LLM).
type RUDim = { dim: string; value: string; confidence: number; source: string; evidence: string; usedBy: string; state: AttrState };
// Deterministic trait → buyer-facing-dimension maps (pure; mirrored by requnderstandingtest.mjs).
const RU_AWARENESS: Record<string, string> = { spec_driven: 'Specification-driven', brand_driven: 'Brand-driven', catalog_driven: 'Catalog / price-driven', application_driven: 'Solution-driven' };
const RU_SUPPORT: Record<string, string> = { 'Needs Guidance': 'Needs consultation', 'Self Driven': 'Self-sufficient', Hybrid: 'Some guidance' };
const RU_COMMS: Record<string, string> = { 'WhatsApp Friendly': 'WhatsApp-first', 'Image Sharing Buyer': 'WhatsApp-first (images)', 'Call First Buyer': 'Phone-first', 'Low Response Buyer': 'Low engagement' };

// Lightweight analytics — pushes to GTM's dataLayer if present, else no-ops.
// Lets us watch the details-wizard funnel (open / skip / complete) in prod.
// Funnel context auto-attached to EVERY tracked event. glid = the buyer; bl_id =
// the BuyLead/requirement key minted at quantity capture, so two requirements in
// one session never blur together — every event traces to ONE requirement.
const trackingCtx: { glid: string; bl_id: string } = { glid: '', bl_id: '' };
function track(event: string, data: Record<string, unknown> = {}) {
  try {
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ event, glid: trackingCtx.glid, bl_id: trackingCtx.bl_id, ...data, ts: Date.now() });
  } catch {
    /* no-op */
  }
}

// Map the planner's non-spec questions (context/persona) into the panel's
// ─── Buyer-profile readers (robust to the webhook's wrapper shapes) ───────────
// The buyer_profile sub-fetch returns EITHER the buyer's record OR a status wrapper,
// e.g. { Execution, Gluser_id, Message:'Gluser data not found', status:'0', unique_id }
// (a GLID with no profile) — or an auth-failure code. Detect that wrapper HONESTLY
// (the old check only matched uppercase STATUS/CODE and silently rendered blanks),
// and DEEP-READ identity fields so a found-but-nested profile still resolves.
//
// Deep-search the (possibly wrapped/nested) profile for the first non-empty value
// among `keys` (case-insensitive) — so e.g. glusr_usr_ph_mobile resolves whether it
// sits at the top level or under a data wrapper.
function profileVal(bp: unknown, keys: string[]): string {
  if (!bp || typeof bp !== 'object') return '';
  const want = keys.map((k) => k.toLowerCase());
  const seen = new Set<unknown>();
  const stack: unknown[] = [bp];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (want.includes(k.toLowerCase()) && v != null && String(v).trim()) return String(v).trim();
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return '';
}
// True when the profile is a not-found / auth-failed wrapper rather than a real record.
function profileMissing(bp: unknown): boolean {
  if (!bp || typeof bp !== 'object') return true;
  const o = bp as Record<string, unknown>;
  // Any real identity field present (even nested) → it's a genuine profile, not a wrapper.
  if (profileVal(o, ['company_name', 'ceo_fname', 'first_name', 'glusr_usr_ph_mobile', 'mobile1'])) return false;
  const msg = String(o.Message ?? o.message ?? '').toLowerCase();
  if (/not found|no data|no record|fail|invalid|unauthor|denied/.test(msg)) return true;
  if (o.APP_AUTH_FAILURE_CODE || o.CODE) return true;
  if (String(o.status ?? o.STATUS ?? '').trim() === '0') return true; // {status:'0'} = sub-fetch returned nothing
  if (o.Execution || o.unique_id) return true; // bare status wrapper, no identity payload
  return false;
}
// A short, honest reason for the debug dump ("Gluser data not found", "status 0", …).
function profileFailReason(bp: unknown): string {
  if (!bp || typeof bp !== 'object') return 'no profile record returned';
  const o = bp as Record<string, unknown>;
  const msg = String(o.Message ?? o.message ?? '').trim();
  if (msg) return msg;
  if (o.APP_AUTH_FAILURE_CODE || o.CODE) return `auth/code ${String(o.APP_AUTH_FAILURE_CODE ?? o.CODE)}`;
  if (String(o.status ?? o.STATUS ?? '').trim() === '0') return 'status 0 (no data for this GLID)';
  return 'profile fields empty';
}

// Distil the OBSERVED external run (Befisc identity + Sign3 footprint + World) into a compact shape
// attached to the Buyer Twin. OBSERVED-only — never a planning input. Returns null if nothing landed.
function buildObservedExternal(ext: ExternalRunResult): ObservedExternal | null {
  const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});
  const s = (x: unknown) => (x == null ? '' : String(x).trim());
  const find = (name: string) => ext.sources.find((src) => src.source === name);
  const out: ObservedExternal = { fetched_at: ext.ranAt };
  const notes: string[] = [];

  const bef = find('Befisc');
  if (bef?.status === 'ok' && bef.value) {
    const v = obj(bef.value); const pi = obj(v.personal_information); const docs = obj(v.document_data);
    const pan = Array.isArray(docs.pan) && docs.pan.length ? s(obj((docs.pan as unknown[])[0]).value) : '';
    const emails = Array.isArray(v.email) ? (v.email as unknown[]).map((e) => s(obj(e).value)).filter(Boolean) : [];
    const a0 = Array.isArray(v.address) && v.address.length ? obj((v.address as unknown[])[0]) : {};
    const befisc = {
      name: s(pi.full_name) || undefined, gender: s(pi.gender) || undefined, age: s(pi.age) || undefined,
      dob: s(pi.date_of_birth) || undefined, income: s(pi.income) || undefined, pan: pan || undefined,
      altPhones: Array.isArray(v.alternate_phone) ? (v.alternate_phone as unknown[]).length : undefined,
      email: emails[0], address: [s(a0.detailed_address), s(a0.state), s(a0.pincode)].filter(Boolean).join(', ') || undefined,
    };
    if (Object.values(befisc).some((x) => x != null && x !== '')) out.befisc = befisc;
  } else if (bef && !['ok', 'not_run', 'creds_pending'].includes(bef.status)) {
    notes.push(`Befisc: ${bef.detail || bef.status}`);
  }

  const sg = find('Sign3');
  if (sg?.status === 'ok' && sg.value) {
    const v = obj(sg.value); const pdRoot = obj(v.phone_data); const pd = obj(pdRoot.primary_data);
    const meta = obj(pd.phone_meta); const ld = obj(pdRoot.linked_data); const br = obj(ld.breach_details);
    const platforms = Object.entries(obj(pd.account_details)).filter(([, x]) => obj(x).user_exist === true).map(([k]) => k);
    out.sign3 = {
      socialProfiles: pd.social_profile_count != null ? Number(pd.social_profile_count) : undefined,
      operator: s(meta.operator) || undefined,
      breaches: br.number_of_breaches != null ? Number(br.number_of_breaches) : undefined,
      platforms: platforms.length ? platforms.slice(0, 12) : undefined,
      linked: s(ld.key) || undefined,
    };
  } else if (sg && !['ok', 'not_run', 'creds_pending'].includes(sg.status)) {
    notes.push(`Sign3: ${sg.detail || sg.status}`);
  }

  const w = find('World');
  if (w?.status === 'ok' && w.value) out.world = { summary: s(obj(w.value).summary) || undefined, confidence: w.confidence };

  if (notes.length) out.notes = notes;
  return (out.befisc || out.sign3 || out.world || out.notes) ? out : null;
}
// #N2: whatsapp_inbound arrives three ways — a real message array, a {data:{recent_messages}}
// object, or an n8n sub-fetch FAILURE wrapper ({error}/success:false). The failure wrapper has
// ~7 metadata keys (headers/params/error/…) that the old Object.keys() count mistook for "7
// inbound messages". Count it as ZERO and flag `failed` so debug shows the real source failure.
function waInboundCount(v: unknown): { count: number; failed: boolean } {
  if (Array.isArray(v)) return { count: v.length, failed: false };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o || o.success === false) return { count: 0, failed: true };
    const rm = (o.data as Record<string, unknown> | undefined)?.recent_messages;
    if (Array.isArray(rm)) return { count: rm.length, failed: false };
  }
  return { count: 0, failed: false };
}
// Resolve the profile mobile (key: glusr_usr_ph_mobile), with a clearly-labelled
// debug-only fallback so the mobile→external chain can be exercised on test GLIDs
// whose profile carries none. `debugInjected` flags the fallback for honest display.
function resolveMobile(bp: unknown, glidHint?: string): { mobile: string; debugInjected: boolean } {
  const real = profileVal(bp, ['glusr_usr_ph_mobile', 'mobile1', 'mobile']);
  if (real) return { mobile: real, debugInjected: false };
  const glid = (glidHint && String(glidHint).trim()) || profileVal(bp, ['glid', 'gluser_id']);
  const fb = debugFallbackMobile(glid); // GLID-scoped, ?debug-only (268590579 → 9784665194)
  if (fb) return { mobile: fb, debugInjected: true };
  return { mobile: '', debugInjected: false };
}

// DynQuestion shape, ordered as the planner intends (leading qualifier first).
// spec/identity/logistics questions are handled by spec-triage / existing fields.
function planToDynQuestions(plan: RequirementPlan): DynQuestion[] {
  // dynAnswers is keyed by id → a collision makes one card read another's answer (the
  // budget = "One-time purchase" bleed). The planner de-collides at the source, but this
  // is the boundary into the form's answer map, so we re-assert the invariant defensively:
  // any duplicate id (from a cache, refine merge, or LLM reuse) gets a unique suffix here.
  const seenId = new Set<string>();
  return (plan.questions || [])
    .filter((q) => q.kind === 'context' || q.kind === 'persona')
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((q, i) => {
      let id = (q.id || '').trim() || `plan-${i}`;
      if (seenId.has(id)) id = `${id}__${i}`;
      seenId.add(id);
      return {
      id,
      label: q.label,
      options: q.options || [],
      multi: false,
      slot: (q.kind === 'persona' ? 'persona' : 'specs') as DynQuestion['slot'],
      bucket: (q.kind === 'persona' ? 'persona' : 'requirement') as DynQuestion['bucket'],
      optional: true,
      reason: q.reason || '',
      groundedIn: q.groundedIn || (q.reason ? `(reason) ${q.reason}` : ''), // A1: registry grounding for debug audit
      source: 'llm' as const,
      tier: q.tier, // P6: a wizard INTENT-tier answer is a valid spec re-rank trigger
      };
    });
}
// One LLM pass that shaped the form — captured for debug provenance so HOD can
// see WHICH prompt ran and WHAT was passed to it (not just the question's meaning).
interface PromptTrace {
  prompt: string; // function/prompt name, e.g. "planRequirement"
  model: string; // model id, or "—" for non-LLM derivations
  purpose: string; // what this pass decided
  inputs: string; // compact signature of everything passed in
}
// One auto-fill verdict from the Confidence-&-Bias Gate — the debug paper trail
// that answers "why did/didn't this field fill?" (ChatGPT review item).
interface GateDecision {
  field: string; // the spec field the engine tried to set
  classification: 'preference' | 'objective';
  action: 'filled' | 'blocked_autofill' | 'blocked_manual' | 'suggested';
  reason: string; // 'brand' | 'model' | 'preference' | 'inferred' | 'user-set' | …
  at?: string; // path that attempted it: 'product-name' | 'cascade' | 'voice' | 'image' | 'ai'
}
import { getJSON, postJSON } from '../lib/api';
import { useToast } from './Toast';
import LocationSearch from './LocationSearch';
import VoiceRecorder from './VoiceRecorder';
import OTPGate from './OTPGate';
import SellerResultsModal from './SellerResultsModal';

interface Props {
  onClose: () => void;
  variantLabel?: string;
  // Step-0 (landing) staging: the GLID/Pull CTA now lives on the landing. When it stages a GLID and
  // opens Smart with autoPull, the modal runs its EXISTING pull on mount — so the flow is byte-identical
  // and the product screen stays clean. (initialGlid is ignored unless autoPull is true.)
  initialGlid?: string;
  autoPull?: boolean;
  initialIgnoreTwin?: boolean;
  // B-step-2: when true, render the step-0 STAGING view (pulled-data debug panels) instead of the
  // form — so the buyer data is inspectable on the landing right after a Pull. onStart flips to the
  // clean form on the SAME instance (data persists, no re-pull).
  stagingOnly?: boolean;
  onStart?: () => void;
}

const EMPTY_FORM: RFQFormData = {
  productName: '',
  mcatId: '',
  mcatType: '',
  quantity: '',
  unit: '',
  imageBase64: '',
  imageMimeType: '',
  dynamicSpecs: {},
  clientLocation: '',
  deliveryLocation: '',
  deliveryTimeline: '',
  paymentTerms: '',
  creditPeriod: '',
  paymentMode: '',
  buyerType: '',
  industry: '',
  companySize: '',
  gstRegistered: null, // UNKNOWN until the buyer answers — we never assume "No" because we couldn't fetch it
  gstNumber: '',
  requirementFrequency: '',
  contactName: '',
  contactMobile: '',
  contactEmail: '',
  additionalDetails: '',
  requirementNotes: '',
  voiceTranscript: '',
  voiceDurationSeconds: 0,
};

// ─── RadioChip ────────────────────────────────────────────────────────────────
function RadioChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 border rounded-full text-sm transition-all ${
        selected
          ? 'border-teal-500 bg-teal-50 text-teal-700 font-medium'
          : 'border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      <span
        className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
          selected ? 'border-teal-500' : 'border-gray-300'
        }`}
      >
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />}
      </span>
      {label}
    </button>
  );
}

// ─── OtherChip ────────────────────────────────────────────────────────────────
function OtherChip({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open && !value)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 border border-dashed border-gray-300 rounded-full text-sm text-gray-400 hover:border-gray-400"
      >
        Other...
      </button>
    );
  return (
    <input
      autoFocus
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (!value) setOpen(false);
      }}
      placeholder="Specify..."
      className="px-3 py-2 border border-teal-400 rounded-full text-sm outline-none w-32 focus:ring-2 focus:ring-teal-100"
    />
  );
}

// Read an upload into base64. Images are downscaled (max 1280px, JPEG) to keep
// the payload small & fast; PDFs (spec sheets) pass through untouched.
async function fileToAnalyzable(
  file: File
): Promise<{ base64: string; mime: string; isPdf: boolean }> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const readAsDataURL = () =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  if (isPdf || !file.type.startsWith('image/')) {
    const dataUrl = await readAsDataURL();
    return { base64: dataUrl.split(',')[1] || '', mime: file.type || 'application/pdf', isPdf };
  }

  try {
    const dataUrl = await readAsDataURL();
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = dataUrl;
    });
    const MAX = 1280;
    let { width, height } = img;
    if (width > MAX || height > MAX) {
      const scale = MAX / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    ctx.drawImage(img, 0, 0, width, height);
    const out = canvas.toDataURL('image/jpeg', 0.82);
    return { base64: out.split(',')[1] || '', mime: 'image/jpeg', isPdf: false };
  } catch {
    const dataUrl = await readAsDataURL();
    return { base64: dataUrl.split(',')[1] || '', mime: file.type, isPdf: false };
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function RFQModalV3({ onClose, variantLabel, initialGlid, autoPull, initialIgnoreTwin, stagingOnly, onStart }: Props) {
  const [step, setStep] = useState<FormStep>(0);
  const [showAllSpecs, setShowAllSpecs] = useState(false); // reveal the long tail of specs
  const [page1Choice, setPage1Choice] = useState<'' | 'business' | 'personal'>(''); // page-1 seed qualifier
  // Spec display order, locked once (plan-applied OR on first spec touch) so a
  // late planner result never reorders specs under the buyer.
  const [lockedSpecOrder, setLockedSpecOrder] = useState<string[] | null>(null);
  // Non-spec questions are woven INTO the form: slot==='specs' renders inline on
  // the spec page; 'requirement'/'persona' render at the top of the final step.
  const [dynQuestions, setDynQuestions] = useState<DynQuestion[]>([]);
  const [dynAnswers, setDynAnswers] = useState<Record<string, string>>({});
  const [dynLoading, setDynLoading] = useState(false);
  // Global LLM-activity loader: true whenever ANY model call is in flight (intent / planner / refine /
  // deduce / profile / twin) so EVERY processing gap — especially the after-Continue / after-Next
  // transitions — shows a moving "working…" bar instead of looking frozen ("specs not coming").
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmBusyLabel, setLlmBusyLabel] = useState('');
  // Non-LLM async work that also deserves a loader: fetching the spec schema from the IndiaMART ISQ
  // APIs (mcat-resolve → GetIsq → getISQs). These are network round-trips, NOT model calls, so the
  // LLM signal above doesn't see them — without this the spec page can sit blank ("specs not coming")
  // while the API is in flight. true = a spec/category fetch is running.
  const [specsLoading, setSpecsLoading] = useState(false);
  useEffect(() => onLLMActivity((n, label) => { setLlmBusy(n > 0); if (n > 0 && label) setLlmBusyLabel(label); }), []);
  // Map the in-flight call's technical label → buyer-friendly copy for the loader pill.
  const llmBusyText = (label: string): string => (({
    deriveIntent: 'Understanding your need…',
    planRequirement: 'Prioritising your specs…',
    refineQuestions: 'Refining the questions…',
    deduceLogistics: 'Working out delivery & terms…',
    deriveBuyerProfile: 'Reading your profile…',
    deriveBuyerTwin: 'Building your buyer profile…',
    inferSpecsFromApplication: 'Filling in your specs…',
    getSpecHints: 'Fetching spec help…',
    explainSpec: 'Looking that up…',
    summarizeRequirement: 'Summarising…',
    classifyFieldTypes: 'Organising fields…',
    analyzeImage: 'Reading your image…',
    voiceToSpecs: 'Transcribing your voice…',
  } as Record<string, string>)[label] || 'Working…');
  const dynGenSig = useRef(''); // de-dupes generation per product/qty/role signature
  // Intent Planner — SHADOW MODE: computed at commit, surfaced under ?debug=1 to
  // compare against the case studies. Does NOT drive the UI yet.
  const [reqPlan, setReqPlan] = useState<RequirementPlan | null>(null);
  // P5b: the question-budget metric — proves "known buyer ⇒ fewer questions".
  const [questionBudget, setQuestionBudget] = useState<{ asked: number; twinSkipped: number; mode: string; tiers: string; why: string[] } | null>(null);
  // P5c: Concierge confirmation — bundle the Twin's high-conf traits into ONE
  // "still correct?" card before specs. State machine: none → pending → accepted
  // | changed. `twinMuted` flips on "Something changed" → re-plan in discovery.
  const [conciergeState, setConciergeState] = useState<'none' | 'pending' | 'accepted' | 'changed'>('none');
  // A3 (testing): force a COLD run — skip Twin/Profile derivation + concierge — so
  // testing multiple personas in one session never bleeds a stale persona in. The Twin
  // is NOT destroyed by product change (it's the same buyer); this is the explicit opt-out.
  const [ignoreTwin, setIgnoreTwin] = useState(false);
  // A5: Knowledge Coverage Registry — the requirement's system-of-record. Every stage
  // records facts here under a normalised concept; readers consult it to never re-ask.
  const coverage = useRef(createCoverageRegistry());
  // A6: Intent-First — the journey-adapted purpose question + the buyer's answer.
  const [requirementIntent, setRequirementIntent] = useState<RequirementIntent | null>(null);
  // Page-1 intent DECISION provenance (debug): the registry/Twin/LLM candidates + the winner, captured
  // at decision time so the first-page debug panel can show the precedence race (it used to show nothing).
  const intentDecisionRef = useRef<IntentInput | null>(null);
  const intentCandidatesRef = useRef<Array<{ label: string; score: number; reason: string }> | null>(null); // LLM's own scored end-use ranking (deriveIntent intent_candidates) — observability
  const [intentDecisionTick, setIntentDecisionTick] = useState(0); // bump to re-render the panel when the decision lands
  const [execOpen, setExecOpen] = useState(true); // per-page Executive Summary toggle (debug) — on EVERY page
  const intentSig = useRef(''); // fire deriveIntent once per product+kind
  const intentResolved = useRef(false); // deriveIntent finished (success OR fail) → Continue may pass
  // A1 safety (G): time-box waiting for the Twin so a missing/slow Twin never blocks the intent.
  const [twinWaitTimedOut, setTwinWaitTimedOut] = useState(false);
  // When the tester flips it ON mid-session, drop the live Twin/Profile + concierge so
  // the form goes cold immediately (re-pulling a GLID with it OFF rebuilds normally).
  useEffect(() => {
    if (!ignoreTwin) return;
    setBuyerTwin(null);
    setBuyerProfile(null);
    setConciergeState('none');
    setPriorObserved(null); // BTE-v1.3: going cold → drop the prior-session behaviour read too
    const w = window as unknown as { __buyerTwin?: unknown; __buyerProfile?: unknown };
    w.__buyerTwin = undefined;
    w.__buyerProfile = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ignoreTwin]);
  const twinMuted = useRef(false);
  const [conciergeStat, setConciergeStat] = useState<{ yes: number; total: number }>({ yes: 0, total: 0 });
  const [blId, setBlId] = useState(''); // BuyLead/requirement key — minted at quantity capture; on every funnel event
  const planSig = useRef('');
  // Buyer enrichment (history-powered). DEBUG: GLID entered on the product page.
  const [glidInput, setGlidInput] = useState('');
  const [enrichment, setEnrichment] = useState<EnrichmentProfile | null>(null);
  const [buyerProfile, setBuyerProfile] = useState<BuyerProfile | null>(null); // LLM-derived persistent profile
  const [buyerTwin, setBuyerTwin] = useState<BuyerTwin | null>(null); // BTE-v1.1 heavy-pass Twin (Phase 1; rendered Phase 2)
  const [buyerStory, setBuyerStory] = useState<{ story: string; arc: string; confidence: number; relatedness: number; relationship: string } | null>(null); // P2.7 — narrative arc from the category timeline
  const buyerStoryRef = useRef<{ story: string; arc: string; confidence: number; relatedness: number; relationship: string } | null>(null); // fresh value for planner closures
  const buyerStorySig = useRef(''); // derive the story once per (buyer × current product), no loop
  const [enrichmentRaw, setEnrichmentRaw] = useState<unknown>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  // Category Brain (mcat-keyed, fetched separately once the product resolves). Status drives the
  // "learning this category" loader. catBuildKicked guards ONE build per mcat → can't restart the
  // 3-min build clock (the race). catPollTimer is the read-poll handle.
  const [categoryIntel, setCategoryIntel] = useState<unknown | null>(null);
  const [categoryStatus, setCategoryStatus] = useState<'idle' | 'building' | 'hit' | 'error'>('idle');
  const catBuildKicked = useRef<Set<string>>(new Set());
  const catPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase A/P0 — READY-gate time-box. categoryWaitElapsed releases the gate so a slow/cold category
  // never stalls the buyer (prod ~2.5s; fresh/debug waits for the live build, with a Start-anyway escape).
  const [categoryWaitElapsed, setCategoryWaitElapsed] = useState(false);
  // Default to READING the cached category (instant when pre-warmed; ~2.5s soft-timeout when cold, then
  // proceed + re-rank). Fresh-build (force a live 3-5 min rebuild) is now an explicit debug toggle — it
  // was defaulting ON in debug, which trapped the buyer behind a 5-min build (the 326s wait in the trace).
  const [freshCategory, setFreshCategory] = useState(false);
  // P1.5 — DEPENDENCY/TIMING TRACE. Each module marks start/done (ms since modal open) + status +
  // what it waited for. Makes "who ran too early / timed out / wasn't consumed" VISIBLE (the dry run
  // that showed the planner firing before category). Ref-based (no re-render churn); the debug panel
  // reads it on each render. window.__moduleTrace mirrors it for the console.
  const traceT0 = useRef(0);
  const moduleTrace = useRef<Record<string, { start?: number; done?: number; status?: string; waited?: string }>>({});
  const traceMark = (key: string, patch: { start?: boolean; done?: boolean; status?: string; waited?: string }) => {
    if (!traceT0.current) traceT0.current = Date.now();
    const now = Date.now() - traceT0.current;
    const e = moduleTrace.current[key] || (moduleTrace.current[key] = {});
    if (patch.start && e.start == null) e.start = now;
    if (patch.done) e.done = now;
    if (patch.status) e.status = patch.status;
    if (patch.waited) e.waited = patch.waited;
    (window as unknown as { __moduleTrace?: unknown }).__moduleTrace = moduleTrace.current;
  };
  const specsRevealed = useRef(false); // one-way latch: once the gate opens, never flip back to the loader (re-ranks happen in place)
  const [locPrefAnswer, setLocPrefAnswer] = useState<string | null>(null); // Phase B: buyer's answer to the supplier-location consume (chip undo / confirm)
  // P0 Pipeline Health: a point-in-time snapshot of the GLID pull (webhook timing /
  // record count / profile-auth) so an HOD can see "did the data even arrive?".
  // Twin/planner are read LIVE from state at render (they resolve after the pull).
  const [pull, setPull] = useState<null | {
    glid: string; ok: boolean; records: number; ms: number;
    profileAuthFailed: boolean; profilePartial: boolean; twinMs: number | null;
  }>(null);
  // E: live External pull (Befisc/Sign3 identity + confidence-gated OSINT web search).
  const [external, setExternal] = useState<ExternalRunResult | null>(null);
  const [enrichedSpecs, setEnrichedSpecs] = useState<Set<string>>(new Set()); // specs prefilled from history
  const [removedSpecs, setRemovedSpecs] = useState<Set<string>>(new Set()); // specs the buyer explicitly removed (× on the final requirement) — never re-fill
  // P (Quick Re-post): the prior requirement the buyer chose to "Buy again" (drives the review banner,
  // the recurring requirement-mode signal, and 🔁 spec provenance). repostMeta carries the per-spec
  // source date + whether it was custom-added (drift: not in the current ISQ schema) for the badge.
  const [repostSource, setRepostSource] = useState<{ title: string; recencyDays?: number } | null>(null);
  const [repostMeta, setRepostMeta] = useState<Record<string, { recencyDays?: number; custom: boolean }>>({});
  // Inference cascade: the LEAD answer (e.g. Usage=Salon) pre-fills the dependent
  // specs (strong hold / matte / bulk). These are AI-suggested + editable.
  const [cascadeSpecs, setCascadeSpecs] = useState<Set<string>>(new Set());
  const [cascadeFrom, setCascadeFrom] = useState(''); // the lead answer that drove the cascade
  const [cascadeRationale, setCascadeRationale] = useState(''); // the LLM's one-line "why" for the cascade fills (the "gold" sentence)
  const cascadeConf = useRef<Record<string, number>>({}); // #71a: per-spec cascade confidence (Kraft 95 vs Ply 82) — drives the Truth-Table conf, not a flat 82
  const cascadeSig = useRef('');
  // Refinement 2 (sequencing): when the funnel has an INTENT-tier wizard question,
  // hold the (cold-ranked) specs behind a placeholder until the buyer answers it and
  // the intent re-plan completes — so they never see the wrong order, then it reveals
  // re-ranked. Always skippable. replanPending covers the async re-plan gap.
  const [intentGateSkipped, setIntentGateSkipped] = useState(false);
  // P1: last-page fields the buyer tapped "change" on — re-reveals the full input over the
  // confirmable summary we show for known/deduced values.
  const [editFields, setEditFields] = useState<Set<string>>(new Set());
  const [, setReplanPending] = useState(false); // value unread; setter sequences the re-plan spec reveal
  // P6: intent-driven spec RE-RANKING (the one behaviour change). On the FIRST
  // intent answer we re-run the planner and reorder the still-UNTOUCHED specs;
  // touched specs + the lead stay pinned (anti-jitter). Fires at most once.
  const replannedOnce = useRef(false);
  const [specRankMoves, setSpecRankMoves] = useState<Record<string, { from: number; to: number }>>({}); // name → orig#/new# for the "moved" badge
  const [replanFlash, setReplanFlash] = useState(''); // transient "🔄 Re-planned after: X" banner
  // Debug provenance: every prompt that shaped the form + what was passed to it.
  const [promptTraces, setPromptTraces] = useState<PromptTrace[]>([]);
  const [gateDecisions, setGateDecisions] = useState<GateDecision[]>([]); // bias-gate paper trail
  const [planTrace, setPlanTrace] = useState(''); // compact inputs fed to planRequirement
  const [debug, setDebug] = useState(DEBUG_FROM_URL); // on-screen debug / trace toggle
  const [form, setForm] = useState<RFQFormData>(EMPTY_FORM);
  const [isqSpecs, setIsqSpecs] = useState<ISQSpec[]>([]);
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [productImageUrl, setProductImageUrl] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('rfq_recent_searches') || '[]');
    } catch {
      return [];
    }
  });
  const [showDropdown, setShowDropdown] = useState(false);
  // T1: the qty is "committed" only on blur / Enter / Continue — NOT on every keystroke — so the
  // intent + requirement-mode compute on the FINAL qty, never on a partial "1" of "100".
  const [qtyCommitted, setQtyCommitted] = useState(false);
  // DEBOUNCED quantity — the intent + planner effects key on THIS, not raw form.quantity, so typing
  // "10000" no longer fires deriveIntent/planRequirement on 1→10→100→1000 (wasted LLM calls + wrong
  // intermediate bucket decisions). Settles 700ms after typing stops, or immediately on commit (Continue).
  const [qtyDebounced, setQtyDebounced] = useState('');
  useEffect(() => {
    if (qtyCommitted) { setQtyDebounced(form.quantity); return; } // explicit commit → no wait
    const t = setTimeout(() => setQtyDebounced(form.quantity), 700);
    return () => clearTimeout(t);
  }, [form.quantity, qtyCommitted]);
  const [productSuggestions, setProductSuggestions] = useState<string[]>([]);
  const [isqHints, setIsqHints] = useState<Record<string, string>>({});
  const [knownFromProductName, setKnownFromProductName] = useState<Record<string, string>>({});
  const [redundantISQSpecs, setRedundantISQSpecs] = useState<string[]>([]);
  // Confidence-&-Bias Gate: spec fields classified as brand/preference — NEVER auto-filled.
  const [preferenceSpecs, setPreferenceSpecs] = useState<Set<string>>(new Set());
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [imageAnalyzing, setImageAnalyzing] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  // Where a finished voice recording goes: the main product field, or the Assist box.
  const [voiceTarget, setVoiceTarget] = useState<'main' | 'assist'>('main');
  const [showOTP, setShowOTP] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [detectedLocation, setDetectedLocation] = useState('');
  const [locationEditing, setLocationEditing] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [scoreDelta, setScoreDelta] = useState<number | null>(null);
  const [missingDismissed, setMissingDismissed] = useState(false);
  // The "almost there" helper only appears when the user tries to leave.
  const [missingPromptShown, setMissingPromptShown] = useState(false);
  // Tier-1 "Assist" — infer specs from the buyer's use-case
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistInput, setAssistInput] = useState('');
  const [assistLoading, setAssistLoading] = useState(false);
  const [autoFilledSpecs, setAutoFilledSpecs] = useState<Set<string>>(new Set());
  const [manualSpecs, setManualSpecs] = useState<Set<string>>(new Set());
  // BTE-v1.3 — in-session behaviour observation. overriddenSpecs = specs where the buyer REPLACED an
  // AI-suggested value with their own (deduped; the keystroke-safe "I know my spec" signal);
  // priorObserved = behaviour seen in this GLID's PAST sessions (loaded at Twin build) so the read
  // compounds session-over-session.
  const [overriddenSpecs, setOverriddenSpecs] = useState<Set<string>>(new Set());
  const [priorObserved, setPriorObserved] = useState<ObservedSessionBehavior | null>(null);
  const [assistNudge, setAssistNudge] = useState(0);
  // Tier-2 per-spec "Not sure?" help (on-demand, bucketized + context-aware)
  const [specHelp, setSpecHelp] = useState<Record<string, { loading?: boolean; guide?: SpecGuide }>>({});
  // "Details for sellers" bottom-sheet wizard — one card at a time.
  const [intentSheetOpen, setIntentSheetOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState<Set<string>>(new Set()); // clickable Reason-Chain: which questions are expanded
  const evalLogSig = useRef(''); // dedupe eval-over-time persistence (push once per distinct eval state)
  const [panelIndex, setPanelIndex] = useState(0);
  // Snapshot of the panel's cards taken when it opens — keeps the list stable
  // for the whole session so cards never reshuffle/grow under the buyer (jitter).
  const [panelFrozen, setPanelFrozen] = useState<PanelItem[] | null>(null);
  // Adaptive look-ahead: refine not-yet-shown questions as answers come in.
  const [panelRefining, setPanelRefining] = useState(false);
  const refineSig = useRef(''); // de-dupes refine per knowledge-state
  const panelIndexRef = useRef(0); // live cursor — refine never mutates cards ≤ this (anti-jitter)
  const buyerTypeManual = useRef(false); // buyer explicitly picked a role → never auto-override
  const offProfileTracked = useRef(''); // analytics: fire rfq_off_profile once per product
  const questionsResolvedSig = useRef(''); // analytics: fire the shown/hidden summary once per plan signature
  const sessionStartRef = useRef(performance.now()); // BTE-v1.3: form open → submit, for fill-duration (decisiveness)
  const [buyerTypeDeducedFrom, setBuyerTypeDeducedFrom] = useState(''); // debug: which spec implied the role
  // Last-page belief: deduced logistics/profile (timeline/payment) + confidence.
  const [deducedLogistics, setDeducedLogistics] = useState<Record<string, { value: string; confidence: number; reason: string }>>({});
  const logisticsSig = useRef('');

  const committedProduct = useRef('');
  const committedMcatId = useRef('');
  const committedValid = useRef(true);
  const isqSpecsRef = useRef<ISQSpec[]>([]);
  const exitIntentUsed = useRef(false);
  const intentAutoOpened = useRef(false); // auto-open the details sheet once
  const specTouched = useRef(false); // buyer has picked/edited a spec → lock spec order
  // Desktop-only hover-to-open for the score module.
  const scoreHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canHover = useRef(false);
  // Bumped whenever the product changes / a new analysis starts, so a late
  // in-flight image/text result for an old product is dropped.
  const analysisToken = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toast = useToast();

  // Scroll to top on step / spec-page change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [step]);

  // Reveal the scrollbar only while actively scrolling, then fade it away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      el.classList.add('is-scrolling');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('is-scrolling'), 900);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, [step]);

  // Detect hover-capable (desktop) pointers once.
  useEffect(() => {
    canHover.current = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
  }, []);

  // IP geolocation
  useEffect(() => {
    fetch('https://ipapi.co/json/')
      .then((r) => r.json())
      .then((d) => {
        if (d?.city) setDetectedLocation(d.city + (d.region ? `, ${d.region}` : ''));
      })
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (inputWrapperRef.current && !inputWrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const setField = useCallback(
    (key: keyof RFQFormData, value: string | boolean | number | Record<string, string>) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const setSpec = useCallback((key: string, value: string) => {
    setForm((prev) => ({ ...prev, dynamicSpecs: { ...prev.dynamicSpecs, [key]: value } }));
  }, []);

  // A spec the user tapped/typed themselves — protected from AI overwrite, and
  // its "Suggested" badge is cleared.
  const markManualSpec = useCallback((key: string, value: string) => {
    specTouched.current = true; // lock spec order to what the buyer currently sees
    track('rfq_spec_edited', { spec: key }); // buyer set/changed a spec by hand (accepted or overrode a suggestion)
    setSpec(key, value);
    setManualSpecs((prev) => new Set(prev).add(key));
    setAutoFilledSpecs((prev) => {
      if (!prev.has(key)) return prev;
      // BTE-v1.3: the buyer is REPLACING an AI-suggested value → an override (deduped). The
      // keystroke-safe "I know my spec better than your guess" signal → independence trait.
      setOverriddenSpecs((o) => (o.has(key) ? o : new Set(o).add(key)));
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [setSpec]);

  // ── gate_decisions (ChatGPT review): record EVERY auto-fill verdict — filled,
  // blocked_autofill (brand/preference), blocked_manual — so debug can answer
  // "why did/didn't this field fill?" without guesswork. Bounded ring + window.
  const logGate = useCallback((d: GateDecision) => {
    setGateDecisions((prev) => [...prev.slice(-29), d]);
    const w = window as unknown as { __gateDecisions?: GateDecision[] };
    w.__gateDecisions = [...(w.__gateDecisions || []).slice(-99), d];
    // VEKA KPI: surface every blocked brand/preference auto-fill into the funnel.
    if (d.action === 'blocked_autofill') track('rfq_gate_blocked', { field: d.field, reason: d.reason, at: d.at });
  }, []);

  // P1.4 — banned phrases parsed from the Twin's EXPLICIT negative constraints (e.g. "no plastic" →
  // never auto-suggest Material=Plastic). A stated buyer aversion must never be re-proposed. Questions /
  // personaOptions are gated separately in the planner prompt.
  const negativeBans = useMemo(() => parseNegativeBans(buyerTwin?.explicit_negative_signals || []), [buyerTwin]);

  // Apply an AI-inferred value only if the user hasn't set that field by hand —
  // and NEVER a brand/preference field (Confidence-&-Bias Gate / VEKA Killer).
  // PREFERENCE_RE is a belt to preferenceSpecs in case classifyFieldTypes hasn't
  // resolved yet, so a brand can't slip through on an early auto-fill race.
  const applyAiSpec = useCallback((key: string, value: string, at = 'ai'): boolean => {
    if (!value) return false;
    if (removedSpecs.has(key)) {
      logGate({ field: key, classification: 'objective', action: 'blocked_manual', reason: 'buyer removed it (×)', at });
      return false; // the buyer explicitly deleted this spec — never re-fill it
    }
    if (manualSpecs.has(key)) {
      logGate({ field: key, classification: 'objective', action: 'blocked_manual', reason: 'user-set', at });
      return false;
    }
    if (preferenceSpecs.has(key) || PREFERENCE_RE.test(key)) {
      logGate({ field: key, classification: 'preference', action: 'blocked_autofill', reason: prefReason(key), at });
      return false;
    }
    if (negativeBans.length && violatesNegativeBan(`${key} ${value}`, negativeBans)) {
      logGate({ field: key, classification: 'objective', action: 'blocked_autofill', reason: 'buyer explicitly rejected this', at }); // P1.4
      return false;
    }
    setSpec(key, value);
    setAutoFilledSpecs((prev) => new Set(prev).add(key));
    logGate({ field: key, classification: 'objective', action: 'filled', reason: 'inferred', at });
    return true;
  }, [removedSpecs, manualSpecs, setSpec, preferenceSpecs, logGate, negativeBans]);

  // × on the final-requirement chip — the buyer drops a spec they don't want. Clears the value AND
  // marks it removed so the cascade/auto-fill never silently re-adds it (applyAiSpec blocks it above).
  const removeSpec = (key: string) => {
    setForm((prev) => { const next = { ...prev.dynamicSpecs }; delete next[key]; return { ...prev, dynamicSpecs: next }; });
    setRemovedSpecs((p) => new Set(p).add(key));
    const drop = (s: Set<string>) => { const n = new Set(s); n.delete(key); return n; };
    setManualSpecs(drop); setCascadeSpecs(drop); setAutoFilledSpecs(drop); setEnrichedSpecs(drop);
    track('rfq_spec_removed', { spec: key });
  };

  // Record one prompt pass for the debug "📡 Prompt trace" panel (what ran +
  // what was passed). Keeps the last dozen on-screen; mirrors to window for the
  // console. Cheap no-op cost when debug is off (state still small).
  const logPrompt = useCallback((t: PromptTrace) => {
    setPromptTraces((prev) => [...prev.slice(-11), t]);
    const w = window as unknown as { __promptTraces?: PromptTrace[] };
    w.__promptTraces = [...(w.__promptTraces || []).slice(-49), t];
  }, []);

  // Persistent buyer-profile signals as a known-facts map — fed to the look-ahead
  // and last-page deduction so EVERY downstream LLM call uses who the buyer is.
  const buyerProfileKnown = useCallback((): Record<string, string> => {
    const k: Record<string, string> = {};
    const b = buyerProfile;
    if (!b) return k;
    if (b.persona) k['Buyer persona'] = b.persona;
    if (b.maturity) k['Buyer maturity'] = b.maturity;
    if (b.localityPreference) k['Locality preference'] = b.localityPreference;
    if (b.engagement) k['Preferred channel'] = b.engagement;
    if (b.sourcingStyle) k['Sourcing style'] = b.sourcingStyle;
    if (b.buyingPattern) k['Buying pattern'] = b.buyingPattern;
    if (b.supplierPreference) k['Supplier preference'] = b.supplierPreference;
    if (b.responseSensitivity) k['Response sensitivity'] = b.responseSensitivity;
    if (b.multiSku) k['Multi-SKU buyer'] = 'yes';
    return k;
  }, [buyerProfile]);

  // ── Point 2: shared "what the buyer has told us so far" context ──────────────
  // The page-1 INTENT answer + buyer-kind + order size — the upstream signals that the
  // spec-side LLM calls (cascade fill, refine, "Not sure?" help) historically MISSED
  // (they predate intent moving to page 1). Threaded into all of them so every stage is
  // shaped by the same chain — not just the planner. Filled specs / profile are appended
  // per-call. PII-free. Sourced from `requirementIntent` (recorded in the A5 registry).
  const requirementContext = useCallback((): string => {
    const bits: string[] = [];
    if (page1Choice) bits.push(`Buying for ${page1Choice === 'personal' ? 'personal use' : 'their business'}`);
    if (form.quantity) bits.push(`Order size: ${form.quantity}${form.unit ? ' ' + form.unit : ''}`);
    // The A5 Coverage Registry is the SYSTEM-OF-RECORD — every active/confirmed fact any stage
    // learned: the page-1 intent, spec picks, cascade fills, deduced logistics, Verified external
    // truths, high-conf twin traits. Emit the WHOLE current truth (authority-ranked, source-tagged)
    // so EVERY downstream LLM call (cascade fill, refine, help) sees the complete, de-duplicated
    // picture — never a hand-assembled subset. Intent flows through as its registry fact. The
    // registry holds NO raw PII (name/mobile/email are dedicated fields), so this stays PII-free.
    const facts = coverage.current.facts()
      .filter((f) => f.status === 'active' || f.status === 'confirmed')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 24)
      .map((f) => `${f.concept.replace(/_/g, ' ')} = ${f.value} [${f.source}]`);
    const lead = bits.length ? bits.join('. ') + '. ' : '';
    const known = facts.length ? `What we already know (system-of-record — do NOT re-ask or contradict these): ${facts.join('; ')}. ` : '';
    return lead + known;
  }, [page1Choice, form.quantity, form.unit]);

  const frequencyApplicable = !isqSpecs.some((s) =>
    /frequenc|usage|consumption|repeat|per\s*(day|week|month|year)/i.test(s.IM_SPEC_MASTER_DESC)
  );
  const buyerSegment = classifySegment({
    productName: form.productName,
    mcatType: form.mcatType,
    buyerType: form.buyerType,
    quantity: Number(form.quantity) || 0,
    hasUnits: unitOptions.length > 0,
  });
  // Tiny consumer-scale buy (a few units of a unit-priced product) → skip the
  // buyer-profile questions. Quantity-based so it never flips when the buyer
  // later picks a role (which would otherwise collapse the section mid-use).
  const qtyNum = Number(form.quantity) || 0;
  const isRetailQty = unitOptions.length > 0 && qtyNum > 0 && qtyNum <= 5;
  // #1: the intent question must wait for QUANTITY *and* UNIT when the category has qty units
  // (Kg/Tonne/Piece/…) — both drive the requirement-mode (A10) that shapes the intent chips +
  // last-page deductions, so we don't fire before the order's size/nature is actually known.
  // When there's no qty unit, there's nothing to wait for. Profile-pull wait is separate (twinPending).
  const qtyReady = unitOptions.length === 0 || (qtyNum > 0 && !!form.unit);
  // ── A10: requirement-mode — the CURRENT order's nature (from qty + unit-type + archetype). ──
  // This is the HIGH-weight signal that outranks the persisted persona for THIS order's
  // payment/delivery/budget: a single discrete unit of a non-capital good is a one-off /
  // retail-style buy (advance/COD, quick delivery) EVEN for a habitual bulk/credit buyer; a single
  // CAPITAL unit (one machine) is NOT retail; a single BULK unit (1 KG) is a likely-unset
  // placeholder (uncertain). The persona never changes — this only governs requirement-specific
  // fields, and on conflict we ASK rather than assert (deduceLogistics lowers confidence → #3 asks).
  // Unit tiers — so qty "1" is read CORRECTLY by product/unit, not blindly: a heavy/bulk unit
  // (1 Tonne TMT) is a real B2B order; a discrete unit (1 Piece diaper) is retail/one-off; a small
  // measure unit (1 Kg) could be a sample. NO category literals — these are generic unit words.
  const UNIT_DISCRETE = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i;
  const UNIT_BULK = /tonne|quintal|\bmt\b|\bton\b|truck|container|\bkl\b/i;
  const UNIT_MEASURE = /\bkg\b|kilogram|\bgram|\bgm\b|litre|liter|\bml\b|\bmeter|\bmetre|\bcm\b|\bft\b|feet|inch|yard|sq\b|sqft|cubic/i;
  // ── Requirement Mode v2 (R): "what KIND of purchase is this?" — the single business
  // interpretation procurement people make. Fused (deterministic, NO new LLM) from the journey
  // (deriveIntent) + qty + unit-tier + archetype + repeat-signal. EPHEMERAL: recomputed per
  // requirement, NEVER persisted (only the Twin persona persists). It is the PRIMARY driver of
  // requirement-specific deductions — persona is a prior, not the dominant signal.
  // Priority: emergency (explicit breakdown/replacement — most time-critical, beats the archetype)
  // → product NATURE (capital → project) → tiny (sample, dominates the pattern even for a repeat
  // buyer) → recurring → bulk → one-off. (Prototype/Development: phase 2.)
  type ReqMode = 'sample_trial' | 'one_off_retail' | 'recurring' | 'bulk' | 'capital' | 'project' | 'emergency' | 'unknown';
  const requirementMode = (): { mode: ReqMode; paymentLean: 'advance' | 'credit' | 'either'; retailish: boolean; descriptor: string } => {
    const q = qtyNum;
    const unit = form.unit || '';
    const arche = reqPlan?.archetype || '';
    const journey = (requirementIntent?.journey || '').toLowerCase();
    // Read the INTENT ANSWER text too, not just the coarse journey enum — the LLM may classify
    // "TMT for Infrastructure projects" as journey=industrial, but the answer itself says "project".
    const intentVal = (requirementIntent?.value || '').toLowerCase();
    const projectish = journey === 'project' || arche === 'project_service' || /\b(project|tender|turnkey|infrastructure)\b/.test(intentVal);
    const emergencyish = journey === 'maintenance' || /\b(replace|replacement|breakdown|repair|urgent|emergency|spare)\b/.test(intentVal);
    // A re-post ("Buy again") IS a repeat purchase by definition → feeds the recurring signal. It still
    // sits BELOW emergency/capital/project in the hierarchy, so re-posting a broken motor stays emergency.
    // ── HEADLINE GOVERNANCE FIX (G1): the OFF-PROFILE guard ──────────────────────────────────────
    // A buyer's PERSONA buying-pattern (repeat_procurement) must NOT make an UNRELATED current order
    // "recurring" → that is the "Repeat Buyer → Recurring → Credit" hallucination both pilot cases hit
    // (the notebook manufacturer's LED order, the tyre buyer's personal order). Re-post and current-
    // product repeat-overlap ARE current-order signals and still count; the persona pattern counts ONLY
    // when this requirement is ON-profile. Off-profile ⇒ mode derives from the CURRENT order alone.
    const personaRecurs = !offProfileNow() && /repeat_procurement|inventory_builder/i.test(buyerProfile?.buyingPattern || '');
    const recurs = !!repostSource || !!repeatSignal() || personaRecurs;
    const tiny = q > 0 && q <= 2 && !UNIT_BULK.test(unit); // 1–2 units / 1 kg — a sample/one-off; dominates the repeat pattern
    // Emergency FIRST: an explicit breakdown/replacement (intent answer or maintenance journey) is the
    // most behaviour-defining signal and beats the derived archetype — a capital MOTOR being *replaced*
    // is an urgent advance-pay buy (speed > price), not a capex project. Mirrors the project intent-text fix.
    if (emergencyish) return { mode: 'emergency', paymentLean: 'advance', retailish: true, descriptor: `${q} ${unit} for maintenance/replacement — speed > price; immediate delivery, advance OK` };
    if (arche === 'capital') return { mode: 'capital', paymentLean: 'credit', retailish: false, descriptor: `${q || '?'} ${unit} — CAPITAL equipment; installation/commissioning matter, credit/loan plausible` };
    if (projectish) return { mode: 'project', paymentLean: 'credit', retailish: false, descriptor: `${q} ${unit} for a PROJECT/turnkey scope — milestone/credit terms, project timeline` };
    if (tiny) return { mode: 'sample_trial', paymentLean: 'advance', retailish: true, descriptor: `${q} ${unit} — a SAMPLE/trial/one-off tiny order; advance/COD + quick delivery, NOT credit (even for a repeat/bulk buyer)` };
    if (recurs) return { mode: 'recurring', paymentLean: 'credit', retailish: false, descriptor: `a RECURRING/replenishment order (bought before / repeat pattern) — credit terms + cadence appropriate` };
    if (q > 0 && (UNIT_BULK.test(unit) || q > 10)) return { mode: 'bulk', paymentLean: 'either', retailish: false, descriptor: `${q} ${unit} — a BULK/stocking order; size to qty, freight matters` };
    if (q > 0 && q <= 10 && UNIT_DISCRETE.test(unit)) return { mode: 'one_off_retail', paymentLean: 'advance', retailish: true, descriptor: `${q} ${unit} — a small ONE-OFF order; advance/COD likely` };
    if (q > 0) return { mode: 'bulk', paymentLean: 'either', retailish: false, descriptor: `${q} ${unit} — a sized order` };
    return { mode: 'unknown', paymentLean: 'either', retailish: false, descriptor: '' };
  };
  // ── Phase-2/3 FOUNDATION: Requirement Understanding (the "Final RFQ Vision" spine) ──
  // Assembles the persona/requirement dimensions the system can ALREADY justify — each as
  // {value, confidence, source, evidence, usedBy} — from the Twin + profile + registry + mode it
  // ALREADY computes (NO new LLM call; pure consumption). Dimensions not yet inferable show as
  // "— (phase 2)" so the gaps are explicit. Debug-only today (does NOT touch the frozen buyer flow);
  // it is the explainable object the post-pilot Requirement-Understanding-Engine v2 will deepen and
  // wire into the live flow. Directly realises the roadmap's "every dimension shows in debug:
  // value · confidence · source · evidence · used-by" requirement.
  const requirementUnderstanding = (): RUDim[] => {
    const tw = ignoreTwin ? null : liveTwin();
    const bp = buyerProfile;
    const lb = tw?.layer_b_behavioral;
    const lc = tw?.layer_c_commercial_intelligence;
    const rm = requirementMode();
    const ev1 = (t?: { evidence?: Array<{ signal?: string }> }) => (t?.evidence || []).map((e) => e?.signal).filter(Boolean)[0] || '';
    const out: RUDim[] = [];
    // Every dimension is GOVERNED (G0): weak/no-evidence ⇒ Unknown (never a confident guess). opts.hasEv
    // forces the verdict from the real signal; opts.userOrVerified marks buyer-stated/Verified ⇒ Confirmed.
    const add = (dim: string, value: string, confidence: number, source: string, evidence: string, usedBy: string, opts: { hasEv?: boolean; userOrVerified?: boolean; contradicted?: boolean } = {}) => {
      const g = govern({ value, confidence, source, evidence: evidence ? [evidence] : [], hasEvidence: opts.hasEv, userOrVerified: opts.userOrVerified, contradicted: opts.contradicted });
      out.push({ dim, value: g.value, confidence: g.confidence, source: g.source, evidence, usedBy, state: g.state });
    };

    // 1 — Who is the buyer (role + lifecycle). User pick ⇒ Confirmed.
    const role = canonicalBuyerType();
    add('Who is the buyer', [role, bp?.maturity].filter(Boolean).join(' · '), role ? (form.buyerType ? 100 : 85) : 0,
      form.buyerType ? 'User' : 'Twin/Profile', (cleanEvidence(tw?.layer_a_identity?.company_desc) || bp?.summary || '').slice(0, 70), 'GST/Firm gating · planner persona',
      { hasEv: !!role, userOrVerified: !!form.buyerType });
    // 2 — Use case / active intent (CURRENT requirement wins; else the Twin's history-derived intent)
    const curIntent = requirementIntent?.value || '';
    const ai = lc?.current_active_intent;
    // Evidence must match the VALUE shown. When the current requirement intent is the value (User
    // picked / journey-derived), the evidence is that selection — NOT the Twin's stale history quote
    // (the bug: "Primary power source · User" showed evidence "Seeking raw material for notebook…").
    const intentEvidence = curIntent
      ? `${requirementIntent?.locked ? 'buyer selected' : 'journey-derived'}: “${curIntent}”${requirementIntent?.journey ? ` · ${requirementIntent.journey} journey` : ''}${requirementIntent?.question ? ` (Q: ${requirementIntent.question.replace(/\s*\?$/, '')})` : ''}`
      : ev1(ai);
    add('Use case / intent', curIntent || String(ai?.value || ''), curIntent ? (requirementIntent?.locked ? 100 : requirementIntent?.confidence || 0) : ai?.confidence || 0,
      curIntent ? (requirementIntent?.locked ? 'User' : 'Derived') : 'Twin', intentEvidence, 'intent question · spec re-rank · planner',
      { hasEv: !!(curIntent || ai?.value), userOrVerified: !!(curIntent && requirementIntent?.locked) });
    // 3 — Buyer maturity (history; persists across requirements — distinct from the current-order stage)
    add('Buyer maturity', bp?.maturity || '', bp?.maturity ? 80 : 0, 'Profile', 'new / existing / repeat from history', 'question depth · education level', { hasEv: !!bp?.maturity });
    // 4 — Requirement stage (CURRENT journey: exploring → evaluating → finalizing) — SPLIT from maturity (E2)
    const reqStage = step >= 2 ? 'Finalizing' : (curIntent || dynQuestions.some((q) => dynAnswers[q.id])) ? 'Evaluating options' : 'Exploring';
    add('Requirement stage', reqStage, 65, 'Current journey', `step ${step} · intent ${curIntent ? 'set' : 'open'}`, 'requirement mode · question depth', { hasEv: true });
    // 5 — Purchase urgency — the CURRENT order (emergency mode) proves it strongest; otherwise a
    // genuinely delay-averse buyer profile (responseSensitivity = "Low Tolerance For Delay") is a softer,
    // honest signal. P1.5 — this finally CONSUMES responseSensitivity, which the "seller SLA" label had
    // been promising but never actually read. "Patient"/Unknown gives NO urgency (no guessing).
    const delayAverse = /low tolerance|delay/i.test(bp?.responseSensitivity || '');
    const urg = rm.mode === 'emergency' ? 'Immediate' : delayAverse ? 'Time-sensitive' : '';
    add('Purchase urgency', urg, rm.mode === 'emergency' ? 75 : delayAverse ? 60 : 0, rm.mode === 'emergency' ? 'Current order (mode)' : 'Profile', rm.mode === 'emergency' ? rm.descriptor.slice(0, 50) : delayAverse ? `responseSensitivity: ${bp?.responseSensitivity}` : '', 'delivery deduction · seller SLA', { hasEv: rm.mode === 'emergency' || delayAverse });
    // 6 — Income band (OBSERVED) — Befisc income, shown as observed income NOT inferred "purchasing power"
    // (ChatGPT: income ≠ buying power for a business; GST turnover/employees are stronger — wait for them).
    const income = String(tw?.observed_external?.befisc?.income || '').trim();
    add('Income band (observed)', income ? `₹${income}` : '', income ? 70 : 0, 'External (Befisc)', income ? `Befisc income ${income} — observed, not a turnover/buying-power proxy` : '', 'budget bands (advisory until GST/Udyam)', { hasEv: !!income });
    // 7 — Local supplier preference (now drives the supplier-radius nudge, L3)
    const loc = String(lb?.local_preference?.value || '') || bp?.localityPreference || '';
    add('Local supplier preference', loc, loc ? 70 : 0, 'Twin/Profile', tw?.layer_a_identity?.city || '', 'supplier matching · supplier-radius nudge', { hasEv: !!loc });
    // 8 — Buyer awareness
    const aware = bp?.sourcingStyle ? RU_AWARENESS[bp.sourcingStyle] || bp.sourcingStyle : '';
    add('Buyer awareness', aware, aware ? 70 : 0, 'Profile', `sourcing: ${bp?.sourcingStyle || '?'} · info-seeking: ${bp?.infoSeeking || '?'}`, 'question tone · supplier matching', { hasEv: !!aware });
    // 9 — Preferred communication — ONLY with a REAL WhatsApp signal (volume / affinity). Kills the hallucinated "WhatsApp-first 75%" when WA affinity = ?.
    const waMsgs = Number(enrichment?.persona?.whatsappMsgs || 0);
    const waAff = String(enrichment?.persona?.whatsappAffinity || '');
    const waReal = waMsgs > 0 || /high|medium/i.test(waAff) || !!lb?.whatsapp_affinity?.value;
    const comm = waReal ? (bp?.engagement ? RU_COMMS[bp.engagement] || bp.engagement : 'WhatsApp-first') : '';
    add('Preferred communication', comm, comm ? 70 : 0, 'Twin/Profile', waReal ? `WA affinity ${waAff || lb?.whatsapp_affinity?.value || 'present'} · ${waMsgs} msgs` : 'no WhatsApp signal', 'seller routing', { hasEv: waReal });
    // 10 — Support required — ONLY a genuine "needs guidance" signal; "self-driven" is NOT evidence of a support need. Kills the "Self-sufficient 60%" guess.
    const sup = bp?.decisionStyle === 'Needs Guidance' ? RU_SUPPORT['Needs Guidance'] || 'Needs consultation' : '';
    add('Support required', sup, sup ? 60 : 0, 'Profile', `decision: ${bp?.decisionStyle || '?'}`, 'question depth (Needs Guidance → simpler) · seller heads-up', { hasEv: bp?.decisionStyle === 'Needs Guidance' });
    return out;
  };

  // Keyword-based so category-tailored personas (Salon, Distributor, Retailer…)
  // still gate GST/Firm correctly — anything that isn't an individual is business.
  const isBusinessRole = !!form.buyerType && !/individual|personal|end[\s-]?user|consumer|home/i.test(form.buyerType);
  const showProfile = !isRetailQty;
  const fullProfile = ['b2b_bulk', 'reseller', 'capital'].includes(buyerSegment);
  // P3 GST relevance by PROCUREMENT CONTEXT: an INSTITUTION (academic/gov) or a CAPITAL/PROJECT buy needs a
  // GST invoice even at qty 1 — the old qty-only gate (b2b_bulk/reseller/capital) wrongly SKIPPED GST for
  // IIT-Kanpur's single-unit lab buy. This adds GST for those contexts without asking every small B2B buyer.
  // NB: read reqPlan.archetype directly (NOT requirementMode(), which references offProfileNow declared
  // far below — calling it this early in the component body is a TDZ crash). archetype 'capital'/'project'
  // is what requirementMode() keys 'capital' off, so this is equivalent and safe here.
  const gstRelevantByContext = /academic|research|government|psu/i.test(buyerProfile?.nature || '') || /capital|project/i.test(reqPlan?.archetype || '');

  // ── Unified "details for sellers" wizard model ─────────────────────────────
  // Every non-spec question (context → persona) plus the soft buyer-profile
  // fields live in ONE bottom-sheet wizard, shown one card at a time. Spec pages
  // and the last step only surface a chip that opens it. Profile cards are gated
  // by segment ("who you are" comes after intent). GST/Firm stay on the last step.
  // Capped so an engaged buyer isn't fatigued (≤6 cards). Context first, a little
  // persona, then the gated profile cards — profile is high seller-value, so it
  // survives the cap while persona/frequency are trimmed first.
  // The PLANNER owns every context/persona question now — category-tailored,
  // chips-only. The ONLY hardcoded card left is the identity "role" (it sets
  // buyerType, which still gates GST/Firm on the last step). The old generic
  // industry / company-size / frequency cards are GONE: they asked dumb,
  // irrelevant things (e.g. "company size 1-10?" / free-text "industry" to a
  // salon). Their intent — scale + cadence — is now planner questions phrased in
  // the buyer's own terms (e.g. "Salon size? Single chair / 2-5 chairs / Chain"),
  // refined live as answers come in (see the refineAhead look-ahead effect).
  // Dumbledore: if a spec the buyer already picked IS one of the persona types
  // (e.g. Usage=Salon and personas=[Salon,Retailer,…]), we ALREADY know who they
  // are — don't re-ask "which best describes you?". Deduce buyerType and drop the
  // role card. (Set via the effect below; here we just decide whether to show it.)
  const personaSpecMatch = (() => {
    const personas = reqPlan?.personaOptions || [];
    if (!personas.length) return null;
    // Token overlap, not exact: a spec value "Salon" must match a compound persona
    // like "Salon / Hairdresser". coreTokens (≥3 + plural-stem + stopwords) so weak
    // words ("use","for") don't cause spurious matches but real 3-letter heads do.
    for (const [name, val] of Object.entries(form.dynamicSpecs)) {
      if (!val || !val.trim()) continue;
      const vt = coreTokens(val);
      if (!vt.size) continue;
      const hit = personas.find((p) => { const pt = coreTokens(p); return [...vt].some((t) => pt.has(t)); });
      if (hit) return { buyerType: hit, fromSpec: name, fromVal: val.trim() };
    }
    return null;
  })();
  // P1.4: hide a panel question when ANY authoritative stage already covered its concept —
  // not just Intent (broadened from the old Intent-only guard). Self-hide guard: a fact whose
  // rawKey IS this question's own label is the question's OWN answer, so it must NOT hide it
  // (else an answered card vanishes). Never yank a card the buyer already answered.
  // SUPPRESSION POLICY (pilot audit, the #1 over-personalisation guard): only EXPLICIT,
  // current-session sources may fully HIDE a question — the buyer's own answers (User/LastPage),
  // the page-1 Intent, a directly-answered Spec, or the question engine itself (Planner).
  // INFERRED / standing-pattern sources (Twin, History, Cascade, Verified, Enrichment, Deduced)
  // may PREFILL, suggest, or shape options — but NEVER silently suppress a question on their own.
  // This kills "History says monthly → cadence hidden → buyer changed business → never asked".
  // A deduced cadence/budget still reaches the planner via requirementContext (so the planner
  // PROMPT can soft-skip it and pre-rank), but it stays visible + confirmable, never silently dropped.
  const COVER_HIDE_SOURCES = ['User', 'LastPage', 'Intent', 'Spec', 'Planner'];
  const coverHides = (label: string): boolean => {
    const f = coverage.current.coveredBy(label);
    if (!f || f.rawKey === label) return false; // self-hide guard: a question never hides itself
    return COVER_HIDE_SOURCES.includes(f.source);
  };
  // A3 / G1: off-profile is true ONLY if the product misses BOTH the Twin's history AND the
  // enrichment categories. The Twin's historical_categories is LLM-shaped and can omit a
  // category that enrichment clearly has (the cable-lug "Panel Lug" case) — consulting both
  // sources (each via the shared coreTokens matcher) kills the last "new area" false-positive.
  const offProfileNow = (): boolean => {
    const tw = ignoreTwin ? null : liveTwin();
    if (!tw) return false;
    if (!buildTwinPlanInput(tw, form.productName).offProfile) return false; // twin says on-profile → done
    return !matchCategory(enrichment, form.productName); // twin missed, but does enrichment match? if yes → NOT off-profile
  };
  // ── P2.1/P2.3: distil the Twin's intent clusters into human themes (NO new LLM call) —
  //    "Industrial Chemicals · Cleaning Supplies" instead of "WhatsApp 660 · CSL 100". ──
  const twinThemes = (): string[] => {
    const tw = ignoreTwin ? null : liveTwin();
    const lc = tw?.layer_c_commercial_intelligence;
    if (!lc) return [];
    // P5: fuse recent clusters + historical categories + intent history → ranked, de-duped themes
    // (the inline version read recent_intent_clusters alone and went blank when that was sparse).
    return distillSourceThemes({
      recentClusters: lc.recent_intent_clusters,
      historicalCategories: lc.historical_categories,
      intentHistory: lc.buyer_intent_history,
    }).themes;
  };
  // ── P2.2: repeat-purchase detection — does the CURRENT product token-overlap a prior
  //    buy-lead title? Generic ≥4-char token overlap (same approach as personaSpecMatch);
  //    NO category literals. Surfaces "likely replenishment", the single highest-value signal. ──
  const repeatSignal = (): { title: string; date: string } | null => {
    const arr = Array.isArray(enrichmentRaw) ? (enrichmentRaw as Array<Record<string, unknown>>) : [];
    const o = arr.find((x) => x && x.prev_bl_data !== undefined);
    let bl: unknown = o ? o.prev_bl_data : undefined;
    if (typeof bl === 'string') { try { bl = JSON.parse(bl); } catch { bl = []; } }
    if (!Array.isArray(bl)) return null;
    const cur = coreTokens(form.productName); // #1: ≥3 + plural-stem → "cable lug(s)" ↔ "Panel Lug"
    if (!cur.size) return null;
    for (const b of bl as Array<Record<string, unknown>>) {
      const title = String(b?.ETO_OFR_TITLE || b?.title || '');
      const tt = coreTokens(title);
      if ([...cur].some((t) => tt.has(t))) return { title, date: String(b?.ETO_OFR_POSTDATE_ORIG || b?.date || '') };
    }
    return null;
  };
  // ── P (Quick Re-post): the buyer's prior requirements, ready to "Buy again". Built from
  //    enrichment.categories (BL titles + ISQ/known specs) — de-duped by title (case-insensitive,
  //    specs merged across records), richest source + earliest recency kept as the face, recency-
  //    sorted, capped at 6. PII-free (titles + spec values only), generic (NO category literals).
  //    Feeds the step-0 "Buy again" cards and the one-screen Re-post Review. ──
  const priorRequirements = (): PriorReq[] => {
    const cats = enrichment?.categories || [];
    const byTitle = new Map<string, PriorReq>();
    const rank = (s: string) => (s === 'isq' ? 3 : s === 'call' ? 2 : 1); // ISQ (has spec answers) richest
    for (const c of cats) {
      const title = (c.mcat || '').trim();
      if (!title) continue;
      const specs = { ...(c.isqAnswers || {}), ...(c.knownSpecs || {}) };
      const key = title.toLowerCase();
      const prev = byTitle.get(key);
      const mergedSpecs = { ...(prev?.specs || {}), ...specs };
      const recency = [prev?.recencyDays, c.recencyDays].filter((x): x is number => typeof x === 'number');
      byTitle.set(key, {
        title: prev?.title || title,
        source: !prev || rank(c.source) > rank(prev.source) ? c.source : prev.source,
        recencyDays: recency.length ? Math.min(...recency) : undefined,
        specs: mergedSpecs,
        specCount: Object.keys(mergedSpecs).length,
      });
    }
    return [...byTitle.values()]
      .sort((a, b) => (a.recencyDays ?? 1e9) - (b.recencyDays ?? 1e9) || b.specCount - a.specCount)
      .slice(0, 6);
  };
  // Spec-drift matcher: a prior spec maps to the CURRENT ISQ spec that shares the most core tokens
  // (same generic tokenizer as repeatSignal — NO category literals). 0 shared tokens → no match
  // (the caller adds it as a custom "added from your last order" spec). Returns the current spec name.
  const matchPriorSpec = (priorName: string, currentNames: string[]): string | null => {
    const p = coreTokens(priorName);
    if (!p.size) return null;
    let best: string | null = null, bestN = 0;
    for (const cn of currentNames) {
      const overlap = [...coreTokens(cn)].filter((t) => p.has(t)).length;
      if (overlap > bestN) { bestN = overlap; best = cn; }
    }
    return bestN > 0 ? best : null;
  };
  const dynCards = dynQuestions
    .filter((q) => {
      if (!(q.slot === 'specs' || q.slot === 'requirement' || q.slot === 'persona')) return false;
      if (dynAnswers[q.id]) return true; // already answered → keep visible (don't yank)
      return !coverHides(q.label);
    })
    .slice(0, 3) // HARD CAP: Intent-First means ≤3 planner questions (the buyer already told us WHY)
    .map((q) => ({ kind: 'dyn', q } as PanelItem));
  const panelItems: PanelItem[] = [
    ...dynCards,
    // Identity stays a dedicated card (drives buyerType → GST/Firm gating) UNLESS
    // a spec already told us who they are (personaSpecMatch) or it was settled on
    // page 1 ("personal" → End User). Don't re-ask what we already know.
    // Fix #1: skip the role card when we already KNOW the buyer type (concierge-confirmed,
    // page-1 personal, or a spec told us) — never re-ask what's already established.
    ...(showProfile && page1Choice !== 'personal' && !personaSpecMatch && !form.buyerType ? [{ kind: 'role' } as PanelItem] : []),
  ].slice(0, 4); // ≤3 planner questions + at most the one identity/role card
  const isPanelItemAnswered = (it: PanelItem): boolean => {
    if (it.kind === 'dyn') return !!dynAnswers[it.q.id];
    if (it.kind === 'role') return !!form.buyerType;
    if (it.kind === 'industry') return !!form.industry;
    if (it.kind === 'size') return !!form.companySize;
    return !!form.requirementFrequency; // frequency
  };
  const panelItemLabel = (it: PanelItem): string =>
    it.kind === 'dyn'
      ? it.q.label
      : it.kind === 'role'
      ? 'Which best describes you?'
      : it.kind === 'industry'
      ? 'Which industry are you in?'
      : it.kind === 'size'
      ? 'How big is your company?'
      : 'How often will you buy this?';
  const panelTotal = panelItems.length;
  const panelAnswered = panelItems.filter(isPanelItemAnswered).length;
  const openPanel = () => {
    setAssistOpen(false);
    intentAutoOpened.current = true;
    setPanelFrozen(panelItems); // freeze the list for this session
    const firstUnanswered = panelItems.findIndex((it) => !isPanelItemAnswered(it));
    setPanelIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
    setIntentSheetOpen(true);
    track('rfq_panel_open', { total: panelItems.length, answered: panelAnswered });
  };

  // Score rewards answering the panel's *shown* non-spec (context + persona) cards.
  const panelDynQs = panelItems.flatMap((it) => (it.kind === 'dyn' ? [it.q] : []));
  const scoreDetails = calcScore(form, isqSpecs, !!form.imageBase64, {
    quantityApplicable: unitOptions.length > 0,
    frequencyApplicable,
    intentTotal: panelDynQs.length,
    intentAnswered: panelDynQs.filter((q) => dynAnswers[q.id]).length,
    profileApplicable: !isRetailQty,
  });

  // Flash a "+X" near the score whenever it climbs, so users notice progress.
  const prevScore = useRef(scoreDetails.total);
  useEffect(() => {
    const diff = scoreDetails.total - prevScore.current;
    prevScore.current = scoreDetails.total;
    if (diff > 0) {
      setScoreDelta(diff);
      const t = setTimeout(() => setScoreDelta(null), 1300);
      return () => clearTimeout(t);
    }
  }, [scoreDetails.total]);

  // First still-incomplete, applicable check — what to nudge the user to fill next.
  const nextCheck = scoreDetails.checks.find((c) => c.applicable && !c.done);

  // Prefetch the panel questions as soon as a category's specs load (right after
  // product commit), so they're ready before the buyer reaches the spec page —
  // no "Finding…" wait. Sig-guarded inside, so re-runs are cheap no-ops.
  // #4/#9: on STEP 0 hold the FIRST plan until the page-1 intent AND the Twin have
  // settled, so the initial plan is already intent-shaped (no application="" cold plan,
  // no visible re-rank) instead of firing 3-4× (cold → +profile → +twin → re-rank).
  // handleNext/enterStep2 also call ensureReqPlan directly — the guaranteed path — so a
  // stalled Twin/intent never hangs the spec page (the buyer moving forward forces it).
  useEffect(() => {
    if (isqSpecs.length === 0) return;
    if (step === 0) {
      const intentSettled = !!requirementIntent?.value || intentGateSkipped || intentResolved.current;
      const twinPending = !ignoreTwin && !!pull?.ok && !pull?.profileAuthFailed && !buyerTwin;
      if (!intentSettled || twinPending) return; // wait for full context before the first plan
    }
    ensureReqPlan(isqSpecs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // T4: form.quantity/unit/qtyCommitted included so a committed qty/unit change re-runs the
    // planner (planSig now carries the requirement-mode bucket + unit).
  }, [isqSpecs, unitOptions, buyerProfile, requirementIntent?.value, intentGateSkipped, step, pull, buyerTwin, ignoreTwin, qtyDebounced, form.unit, qtyCommitted, categoryStatus, categoryWaitElapsed]);

  // ── Funnel key (bl_id) ──────────────────────────────────────────────────────
  // IndiaMART mints a BuyLead ID the moment a quantity is captured. We mirror that:
  // one bl_id per requirement, reset on product change — so two requirements in the
  // same session never blur together. EVERY tracked event carries glid + bl_id.
  useEffect(() => {
    if (form.quantity && String(form.quantity).trim() && !blId) {
      const id = `bl-${Math.floor(Math.random() * 1e9).toString(36)}-${Date.now().toString(36).slice(-5)}`;
      trackingCtx.bl_id = id; // set sync so this event + later ones carry it
      setBlId(id);
      track('rfq_buylead_minted', { quantity: form.quantity, product: form.productName });
    }
  }, [form.quantity, form.productName, blId]);
  // Keep the funnel context current so track() auto-attaches glid + bl_id everywhere.
  useEffect(() => {
    trackingCtx.glid = enrichment?.glid || glidInput || '';
    trackingCtx.bl_id = blId;
  }, [enrichment, glidInput, blId]);
  // Top-of-funnel impression (once, on open).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { traceT0.current = Date.now(); track('rfq_modal_open', { variant: variantLabel ?? 'V3' }); }, []);

  // ── Requirement-Brain resolver (Phase 1 · "RFQ = Reflexes") ──────────────────
  // The n8n webhook (v12+) appends a `requirement_brain` item: BUYER BRAIN (known specs/intent +
  // facts) and CATEGORY BRAIN (critical_specs ranked by seller-frequency + common_followups). This
  // memo parses it (→ null until v12 is deployed, so everything below degrades to today's behaviour)
  // and runs the PURE resolver: reprioritise the ISQ schema by seller-frequency, surface criticals
  // the schema is missing, and compute  ask = (critical + followups) − known.  `knownDropped` proves
  // the "never ask what's already known" guardrail fired. The view is ephemeral — never cached.
  const parsedBrain = useMemo(() => parseRequirementBrain(enrichmentRaw), [enrichmentRaw]);
  // The buyer pull's brain has the BUYER half; the CATEGORY half arrives from the separate mcat
  // fetch (categoryIntel). Merge them so the resolver's subtraction (critical − known) can fire.
  const requirementBrain = useMemo(() => {
    if (!parsedBrain && !categoryIntel) return null;
    // GATE AT THE SOURCE: only merge category intel when confidence says it's trustworthy (consume).
    // An EMPTY/contaminated category — 0 PNS calls, or critical_specs with no evidence base (a stale
    // VALVE cache surfaced on a roof-rails mcat with 0 calls + 29 specs) — is NOT merged. The resolver
    // then yields buyer-memory only and ZERO category criticals, so the planner, the trace, and every
    // debug panel agree instead of one reading "29 consumed" while another says "empty/ignore".
    if (!categoryIntel || !categoryConfidence(categoryIntel as CategoryPayload).consume) return parsedBrain;
    return { ...(parsedBrain || {}), category_intelligence: categoryIntel as RequirementBrainInput['category_intelligence'] };
  }, [parsedBrain, categoryIntel]);
  const resolvedRequirement = useMemo(() => resolveRequirement(requirementBrain, {
    isqSpecNames: isqSpecs.filter((s) => !redundantISQSpecs.includes(s.IM_SPEC_MASTER_DESC)).map((s) => s.IM_SPEC_MASTER_DESC),
    answeredSpecNames: Object.entries(form.dynamicSpecs).filter(([, v]) => (v || '').trim()).map(([k]) => k),
    intentKnown: !!requirementIntent?.value,
  }), [requirementBrain, isqSpecs, redundantISQSpecs, form.dynamicSpecs, requirementIntent?.value]);

  // ── Conversational signals (P2) ──────────────────────────────────────────────
  // Mine the buyer's OWN words from WhatsApp/PNS — category-independent, buyer-specific intent the
  // fact layer was throwing away: location want/reject ("lucknow me chahe" vs "dilli wale phone kar
  // rahe"), supply complaints, stated qty/spec, engagement. Client-side interim of n8n v13's
  // conversational_signals; the resolver prefers server signals when they arrive. Null-safe → [].
  const convSignals = useMemo(() => {
    const arr = Array.isArray(enrichmentRaw) ? (enrichmentRaw as Array<Record<string, unknown>>) : [];
    let wa: unknown = arr.find((x) => x && x.whatsapp_data !== undefined)?.whatsapp_data;
    if (typeof wa === 'string') { try { wa = JSON.parse(wa); } catch { wa = []; } }
    return extractConversationalSignals(wa);
  }, [enrichmentRaw]);

  // ── Question Graph (Phase C) — link the intent to the specs it IMPLIES (option token-overlap), so a
  // spec already answered by the intent ("Notebook Manufacturing" ⟹ Usage = Notebooks) is prefilled,
  // not asked twice. Pure, no category literals. ──
  const questionGraph = useMemo(() => buildQuestionGraph([
    ...(requirementIntent?.value ? [{ id: '__intent', kind: 'intent' as const, name: 'Use case', answered: requirementIntent.value }] : []),
    ...isqSpecs.map((s) => ({
      id: s.IM_SPEC_MASTER_DESC, kind: 'spec' as const, name: s.IM_SPEC_MASTER_DESC,
      options: s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [],
      answered: form.dynamicSpecs[s.IM_SPEC_MASTER_DESC] || '',
    })),
  ]), [requirementIntent?.value, isqSpecs, form.dynamicSpecs]);
  // CONSUME (conservative): record a high-confidence implied spec into the registry (Derived) so the
  // existing concept-coverage layer prefills/dedups it — the buyer never answers what the intent already said.
  useEffect(() => {
    for (const imp of questionGraph.implied) {
      if (imp.confidence >= 70 && !coverage.current.isCovered(imp.specName) && !(form.dynamicSpecs[imp.specName] || '').trim()) {
        coverage.current.record(imp.specName, imp.impliedValue, 'Deduced', imp.confidence);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionGraph]);

  // ── Category Brain fetch: build ONCE, then poll the cheap read (Task 22) ──────
  // The buyer pull can't carry category intel (it runs before the product is known). Once the mcat
  // resolves, READ mode=category. Cold cache → kick ONE build (3-min Redash→LLM distill) and POLL the
  // read every 25s up to ~5 min until it caches. Reads never build → polling can't restart the clock
  // (the race the user kept hitting). Prod note: a pre-warm job should build; the form would then only read.
  useEffect(() => {
    const mcat = (form.mcatId || '').trim();
    if (catPollTimer.current) { clearTimeout(catPollTimer.current); catPollTimer.current = null; }
    if (!mcat) { setCategoryIntel(null); setCategoryStatus('idle'); return; }
    let cancelled = false;
    setCategoryIntel(null); setCategoryStatus('idle');
    traceMark('category', { start: true, status: 'fetching' });
    const poll = async (attempt: number) => {
      if (cancelled) return;
      const res = await fetchCategoryIntel(mcat, { fresh: freshCategory });
      if (cancelled) return;
      // DIAGNOSTIC (ChatGPT ask): mirror the raw fetch on window so a dry run can tell
      // build-FAILED (always status:'building'/'error', insights null across all polls) apart
      // from built-NOT-consumed (status:'hit' with insights but catCriticals 0 downstream).
      (window as unknown as { __category?: unknown }).__category = { mcat, attempt, status: res.status, hasInsights: !!res.insights, insights: res.insights ?? null };
      if (res.status === 'hit') { setCategoryIntel(res.insights); setCategoryStatus('hit'); traceMark('category', { done: true, status: 'hit' }); return; }
      if (res.status === 'error') { setCategoryStatus('error'); traceMark('category', { done: true, status: 'error' }); return; }
      setCategoryStatus('building');
      // Don't let a late building poll un-terminate the trace: if the wait-timer already
      // marked the category done (timed-out), keep that terminal status — overwriting it
      // back to 'building' is what produced the impossible "done · building" reading.
      if (!moduleTrace.current.category?.done) traceMark('category', { status: 'building' });
      if (!catBuildKicked.current.has(mcat)) { catBuildKicked.current.add(mcat); fetchCategoryBuild(mcat, { fresh: freshCategory }); } // build ONCE
      if (attempt < 12) catPollTimer.current = setTimeout(() => poll(attempt + 1), 25000); // ~5 min ceiling
    };
    poll(0);
    return () => { cancelled = true; if (catPollTimer.current) { clearTimeout(catPollTimer.current); catPollTimer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.mcatId, freshCategory]);

  // ── Category wait time-box (P0, single source of truth). Once a product is committed on the spec
  // step, give category a budget: prod ~2.5s then proceed (re-rank later); fresh/debug waits for the
  // live build (Start-anyway also releases). Guarantees the gate + planner NEVER wait forever — even
  // if the mcat never resolves. Re-armed when product / mcat / fresh changes.
  useEffect(() => {
    if (step !== 1 || !form.productName.trim()) return;
    setCategoryWaitElapsed(false);
    const t = setTimeout(() => { setCategoryWaitElapsed(true); if (!moduleTrace.current.category?.done) traceMark('category', { done: true, status: 'timed-out' }); }, freshCategory ? 300000 : 2500);
    return () => clearTimeout(t);
  }, [step, form.mcatId, form.productName, freshCategory]);

  // Planner-gate sources — ONE builder, used by both the execution gate (defers planRequirement until
  // category is ready) and the render gate (holds the question page). plannerDone = plan ready OR not running.
  const gateSourcesNow = (): GateSources => ({
    hasGlid: !!pull || enrichLoading,
    buyerReady: !enrichLoading,
    // Step-0 pre-plan micro-fix: category is relevant the moment a product is committed (mcat resolved),
    // not only on the spec page — so the planner DEFERS instead of firing a category-less pre-plan on
    // step 0 (the transient ⚠ the trace exposed). The wait-timer still provides the timeout → no deadlock.
    needsCategory: !!(form.mcatId || '').trim() || (step === 1 && !!form.productName.trim()),
    mcatResolved: !!(form.mcatId || '').trim(),
    categoryStatus,
    categoryWaitElapsed,
    plannerDone: !!(reqPlan && ((reqPlan.specOrder?.length ?? 0) || (reqPlan.mustHaveSpecs?.length ?? 0))) || !dynLoading,
  });

  // CATEGORY CONFIDENCE — the gate (defined FIRST; BOTH the criticals path and the richer-layers path
  // gate on it). rich → consume + fuse · thin → consume only · empty → IGNORE (buyer-only). Derived
  // from structural facts (calls/criticals/blockers/price), NOT the distill's miscalibrated self-score.
  const categoryConf = useMemo(() => categoryConfidence(categoryIntel as CategoryPayload | null), [categoryIntel]);

  // P0 — category criticals (ranked by seller-frequency) + common followups, fed to the planner as
  // sellerQuestions so intent / spec-order / panel questions actually CONSUME category intel. GATED on
  // categoryConf.consume: an EMPTY/untrustworthy category (0 calls, or a stale/contaminated cache that
  // has critical_specs but no evidence base) feeds ZERO criticals — otherwise its specs leak to the
  // planner and the trace falsely reads "consumed" (a 0-call VALVE cache did exactly this on a
  // roof-rails RFQ). Empty until the category brain lands; the planner re-fires then (sig carries |catH).
  const categorySellerQs = (): string[] => (requirementBrain && categoryConf.consume
    ? [...resolvedRequirement.criticalRanked.map((c) => c.maps_to_isq || c.name), ...resolvedRequirement.ask].filter(Boolean)
    : []);

  // The RICHER category layers v13 now emits — consumed into planner shaping (deal_blockers → a
  // proactive check, intent_patterns → applications + load-sizing, price → category-grounded budget
  // bands). Defensive: empty until category lands; also gated on categoryConf.consume below.
  const categoryConsumed = useMemo(() => {
    const ci = (categoryIntel || {}) as Record<string, unknown>;
    // GATE: an empty/untrustworthy category contributes NOTHING — the form falls back to buyer-only.
    if (!categoryConfidence(ci as CategoryPayload).consume) return { checks: [], applications: [] as string[], loadSizingRelevant: false, bands: null as string[] | null };
    const checks = dealBlockerChecks(ci.deal_blockers as DealBlocker[] | undefined, { max: 2 });
    const hints = intentPatternHints(ci.intent_patterns as IntentPattern[] | undefined);
    const bands = categoryBudgetBands(ci.price_distribution_inr as PriceDistribution | undefined);
    return { checks, applications: hints.applications, loadSizingRelevant: hints.loadSizingRelevant, bands };
  }, [categoryIntel]);

  // DIAGNOSTIC (pairs with window.__category): the CONSUMED view — what category actually
  // contributed downstream. If window.__category shows a hit WITH insights but criticals is 0
  // here, that's a consumption bug (not a build one); if it's always building, it's the build.
  useEffect(() => {
    (window as unknown as { __categoryConsumed?: unknown }).__categoryConsumed = {
      status: categoryStatus,
      confidence: categoryConf.score,
      band: categoryConf.band,
      consume: categoryConf.consume,
      fuse: categoryConf.fuse,
      criticals: categorySellerQs().length,
      checks: categoryConsumed.checks.map((c) => c.kind),
      applications: categoryConsumed.applications,
      bands: categoryConsumed.bands,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryStatus, categoryConf, categoryConsumed, requirementBrain, resolvedRequirement]);

  // CONSUME the conversational location preference (Change #4): record it as a known fact ONCE, so
  // the registry treats "supplier location" as answered (suppresses re-asking) and the scorecard
  // counts it as used. The buyer-facing banner below confirms it. From history → source 'History'.
  const locPrefSig = useRef('');
  useEffect(() => {
    const lp = convSignals.locationPreference;
    if (!lp || locPrefSig.current === lp.toLowerCase()) return;
    locPrefSig.current = lp.toLowerCase();
    coverage.current.record('supplier location preference', lp.charAt(0).toUpperCase() + lp.slice(1), 'History', 80);
  }, [convSignals.locationPreference]);

  // Eligible spec names ordered by the plan's intent ranking (when applyPlan).
  const computeSpecOrder = (applyPlan: boolean): string[] => {
    const eligible = isqSpecs
      .filter((s) => !redundantISQSpecs.includes(s.IM_SPEC_MASTER_DESC))
      .map((s) => s.IM_SPEC_MASTER_DESC);
    const planBase = (reqPlan?.specOrder?.length ? reqPlan.specOrder : reqPlan?.mustHaveSpecs) || [];
    // Requirement-Brain (Phase 1, defensive): if the planner hasn't ordered yet but the category
    // brain HAS (deterministic seller-frequency), fall back to its reprioritised order. The planner
    // order still wins whenever present → ZERO change to today's behaviour (brain is null pre-v12).
    const base = planBase.length ? planBase : (requirementBrain ? resolvedRequirement.specOrder : []);
    // If the plan's LEAD is a spec, it must be #1 — float it ahead of specOrder so
    // "Usage leads" actually shows Usage first (not just inside the top-3).
    const leadSpec = reqPlan?.lead?.source === 'spec' ? reqPlan.lead.ref : '';
    const rank = leadSpec ? [leadSpec, ...base.filter((s) => s !== leadSpec)] : base;
    if (!applyPlan || !rank.length) return eligible;
    return [...eligible].sort(
      (a, b) => (rank.indexOf(a) === -1 ? 99 : rank.indexOf(a)) - (rank.indexOf(b) === -1 ? 99 : rank.indexOf(b))
    );
  };

  // Lock the spec order ONCE — the moment the plan is applied (capturing the
  // intent ranking, e.g. Usage-first) OR the buyer touches a spec (capturing
  // whatever they currently see) — so a late planner result never reshuffles.
  useEffect(() => {
    if (step !== 1 || isqSpecs.length === 0 || lockedSpecOrder) return;
    const planReady = !!(reqPlan && ((reqPlan.specOrder?.length ?? 0) || (reqPlan.mustHaveSpecs?.length ?? 0)));
    if (planReady || specTouched.current) setLockedSpecOrder(computeSpecOrder(planReady));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isqSpecs, reqPlan, lockedSpecOrder, form.dynamicSpecs]);

  // ── Progressive inference cascade ────────────────────────────────────────────
  // Dumbledore grows knowledgeable as the buyer reveals more. The SIGNAL is every
  // spec the buyer has set themselves (manual) PLUS the lead value (even if name-
  // detected). Whenever that signal grows — the lead is answered, or the buyer
  // picks ANY further spec — we re-infer the LIKELY values of the still-EMPTY
  // specs from EVERYTHING known so far, and pre-fill them as editable "Suggested"
  // chips. Re-runs once per distinct signal; only fills empty, non-manual specs
  // (never clobbers a pick or a shown suggestion → no jitter, no loop).
  useEffect(() => {
    // RE-POST: NO spec cascade — anywhere. A re-post is a tight "review & post" of a known order; we
    // never auto-infer dependent specs from a lead, even after the buyer edits/adds a spec.
    if (!QUESTION_ENGINE || !hasGeminiKey() || isqSpecs.length === 0 || repostSource) return;
    // SPEC-AUTOFILL POLICY — buyer-driven, NEVER intent/planner-driven. We only assist AFTER the buyer has
    // invested (filled ≥2 specs themselves), and then fill at most 2 of the closest-matching still-empty
    // specs. The planner lead / name-detected spec is NOT a trigger: it used to fire this cascade on a
    // fresh page, pre-filling 4-5 "Suggested" chips before the buyer had touched anything. Re-post stays
    // fully exempt (repostSource gate above). Explicit "Tell us your use-case" fill is a separate path.
    const CASCADE_MIN_MANUAL = 2; // hold back until the buyer has set at least this many specs themselves
    const CASCADE_MAX_FILL = 8;   // #71a: upper safety bound only — real gating is the ≥75 confidence band (not a count cap)
    const manualEntries = [...manualSpecs]
      .filter((n) => (form.dynamicSpecs[n] || '').trim())
      .sort()
      .map((n) => `${n}=${form.dynamicSpecs[n]}`);
    if (manualEntries.length < CASCADE_MIN_MANUAL) return; // not enough buyer signal → no auto-fill at all
    const signalEntries = manualEntries; // signal = the buyer's OWN picks only (never the lead / intent)
    const sig = signalEntries.join('|');
    if (cascadeSig.current === sig) return;
    cascadeSig.current = sig; // claim synchronously so async re-runs no-op (no loop)
    // 2) Targets: specs still EMPTY and not manual.
    const targets = isqSpecs.filter((s) => {
      const n = s.IM_SPEC_MASTER_DESC;
      if (manualSpecs.has(n)) return false;
      if (preferenceSpecs.has(n) || PREFERENCE_RE.test(n)) return false; // bias gate: never infer brand/preference
      return !(form.dynamicSpecs[n] || '').trim();
    });
    if (targets.length === 0) return;
    const names = targets.map((s) => s.IM_SPEC_MASTER_DESC);
    const withOpts = targets.reduce<Record<string, string[]>>((acc, s) => {
      acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC
        ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean)
        : [];
      return acc;
    }, {});
    // 3) Context = EVERYTHING known so far (manual + already-suggested + notes).
    const knownStr = Object.entries(form.dynamicSpecs)
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const bpfHint = buyerProfile ? ` Buyer is: ${[buyerProfile.persona, buyerProfile.multiSku ? 'multi-SKU' : '', buyerProfile.buyingPattern].filter(Boolean).join(', ')}.` : '';
    // G1: lead with the buyer's stated PURPOSE + order size (requirementContext) so the cascade
    // infers specs from intent ("Bulk supply to car washes"), not just the lead spec.
    const application = `${requirementContext()}${form.requirementNotes ? form.requirementNotes + '. ' : ''}Known so far — ${knownStr}.${bpfHint}`;
    logPrompt({
      prompt: 'inferSpecsFromApplication · cascade',
      model: 'gemini-2.5-flash-lite',
      purpose: `${signalEntries.length} known signal(s) → infer ${names.length} still-empty spec(s)`,
      inputs: `${requirementContext()}signal=[${sig}] · targets=[${names.join(', ')}]`,
    });
    inferSpecsFromApplication(form.productName, application, names, withOpts)
      .then(({ specs, rationale }) => {
        const applied: string[] = [];
        // #71a CONFIDENCE BANDS (replaces the arbitrary ≤2 cap): fill EVERY inference the cascade is
        // confident about (≥75; it omits <70 itself), so a strong category-typical value like "3 Ply"
        // lands instead of being dropped by a counter. Per-spec confidence is stored so the Truth Table
        // shows the real number (Kraft 95 vs Ply 82), not a flat 82. Upper bound 8 guards runaway only.
        for (const [k, sv] of Object.entries(specs || {})) {
          if (applied.length >= CASCADE_MAX_FILL) break;
          const m = names.find((n) => n.toLowerCase() === k.toLowerCase());
          if (m && sv.value && sv.confidence >= 75 && applyAiSpec(m, String(sv.value))) { applied.push(m); cascadeConf.current[m] = sv.confidence; }
        }
        if (applied.length) {
          setCascadeSpecs((p) => new Set([...p, ...applied]));
          setCascadeFrom(signalEntries.join(' · '));
          if (rationale) setCascadeRationale(String(rationale)); // the "why" sentence → Truth Table + provenance
          track('rfq_cascade', { signal: sig, filled: applied });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqPlan, form.dynamicSpecs, dynAnswers, dynQuestions, isqSpecs, manualSpecs, applyAiSpec, logPrompt, buyerProfile, preferenceSpecs, repostSource]);

  // ── P6: Intent-driven spec RE-RANKING (the one behaviour change) ─────────────
  // North Star made visible: the moment the buyer reveals INTENT (the lead spec/
  // qualifier answer), re-run the planner WITH that answer and reorder the still-
  // UNTOUCHED specs by the new inference ranking. The lead + any manually-touched
  // spec stay PINNED at their current index (anti-jitter). Fires AT MOST ONCE per
  // product, reuses planRequirement (no new prompt type). If nothing actually
  // moves, it's a no-op (no flash, no churn). Reviewer-approved (all three).
  useEffect(() => {
    if (!QUESTION_ENGINE || !hasGeminiKey() || isqSpecs.length === 0) return;
    if (replannedOnce.current || !reqPlan) return;
    // 1) Capture the INTENT answer. A6: the deriveIntent gate answer is the STRONGEST
    // signal — if present, it drives the (single) re-plan that seeds the plan for this
    // purpose. Else fall back to the lead spec / qualifier (same detection as the cascade).
    const lead = reqPlan.lead;
    let answer = '';
    let viaIntentGate = false;
    if (requirementIntent?.value) {
      answer = `${(requirementIntent.question || 'Purpose').replace(/\s*\?$/, '')}=${requirementIntent.value}`;
      viaIntentGate = true;
    } else if (lead?.source === 'spec' && (form.dynamicSpecs[lead.ref] || '').trim()) {
      answer = `${lead.ref}=${form.dynamicSpecs[lead.ref]}`;
    } else if (lead?.source === 'qualifier') {
      const q = dynQuestions.find((d) => d.label.trim() === lead.ref.trim());
      if (q && dynAnswers[q.id]) answer = `${lead.ref}=${dynAnswers[q.id]}`;
    }
    // FALLBACK: the lead may be an UNTOUCHED spec (e.g. tote bags lead = GSM) while the
    // buyer revealed real intent through a wizard INTENT-tier question ("primary use =
    // Retail shopping bags"). That answer is an equally-strong (often stronger) re-rank
    // signal — honour it so the funnel adapts even when the lead spec isn't the carrier.
    if (!answer) {
      // ROBUST intent detection: the LLM tags tier inconsistently (it may label the
      // use-case question 'constraint' not 'intent'), so fall back to the FIRST
      // requirement-bucket wizard question (planner-ordered = the lead conceptual one).
      const gq = dynQuestions.find((q) => q.tier === 'intent') || dynQuestions.find((q) => q.bucket === 'requirement');
      if (gq && (dynAnswers[gq.id] || '').trim()) { answer = `${gq.label.replace(/\s*\?$/, '')}=${dynAnswers[gq.id]}`; viaIntentGate = true; }
    }
    if (!answer) return; // no intent revealed yet → nothing to re-rank on
    replannedOnce.current = true; // claim synchronously → fire exactly once
    if (viaIntentGate) setReplanPending(true); // hold the spec reveal until this re-plan lands (sequencing)
    // 2) Re-run the planner with the intent folded into the use-case.
    const isqSpecsWithOptions = isqSpecs.reduce<Record<string, string[]>>((acc, s) => {
      acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC
        ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean)
        : [];
      return acc;
    }, {});
    const matched = matchCategory(enrichment, form.productName);
    const tw = liveTwin();
    const twinBase = tw ? buildTwinPlanInput(tw, form.productName, coverage.current.isCovered) : undefined;
    const twinForPlan = twinBase ? { ...twinBase, offProfile: twinBase.offProfile || twinMuted.current } : undefined;
    const application = `${requirementContext()}${form.requirementNotes ? form.requirementNotes + '. ' : ''}Buyer just revealed intent → ${answer}. Now that this buyer's end-use is known, re-rank specOrder with the BUYER ANSWERABILITY rule weighing heavily: lead with the attributes THIS buyer can decide on confidently from that intent, and push DOWN fine-grained fabrication/material metrics they would more likely ask a supplier to recommend (unless their profile shows they are a technical/repeat buyer). Importance to the seller still matters, but a high-impact spec the buyer can't answer should NOT lead.`;
    logPrompt({
      prompt: 'planRequirement · re-rank (P6)',
      model: 'gemini-2.5-flash-lite',
      purpose: `intent revealed (${answer}) → re-rank still-untouched specs`,
      inputs: `intent=[${answer}] · pinned=[lead+manual] · specs=[${Object.keys(isqSpecsWithOptions).join(', ')}]`,
    });
    planRequirement({
      productName: form.productName,
      mcatType: form.mcatType,
      quantity: form.quantity,
      unit: form.unit,
      application,
      isqSpecsWithOptions,
      prior: (matched || categorySellerQs().length)
        ? { persona: enrichment?.persona?.type || enrichment?.buyer?.customerType, knownSpecs: matched?.knownSpecs, sellerQuestions: [...new Set([...(matched?.sellerQuestions || []), ...categorySellerQs()])], isqAnswers: matched?.isqAnswers }
        : undefined,
      buyerProfile: buyerProfile || undefined,
      twin: twinForPlan,
      buyerKind: page1Choice === 'business' || page1Choice === 'personal' ? page1Choice : undefined,
      observedContext: observedExternalContext() || undefined, // Befisc/Sign3/identity as a SOFT signal
      buyerStory: buyerStoryRef.current ? `${buyerStoryRef.current.arc}${buyerStoryRef.current.story ? ' — ' + buyerStoryRef.current.story : ''}` : undefined, // P2.7 narrative arc (SOFT, never a hard fact)
      categoryDealBlockers: categoryConsumed.checks.map((c) => c.label), // v13 deal_blockers → proactively cover the top seller stall-point
      categoryApplications: categoryConsumed.applications,               // v13 intent_patterns → frame the intent question
      categoryBudgetBands: categoryConsumed.bands || undefined,          // v13 price → category-grounded budget options (no generic ₹ guesses)
      // Intelligence Consumption: of the transferable intelligence, which traits should DRIVE this product's
      // plan vs stay carried-but-quiet (a research-authority must not dominate a generic commodity).
      ...(() => { const c = consume(transferDecision().transfer, { archetype: reqPlan?.archetype, orderScale: classifyOrderScale(form.quantity, form.unit).band }); const pc = classifyProcurement({ nature: buyerProfile?.nature, authorityRole: buyerProfile?.authorityRole, journey: requirementIntent?.journey || undefined, intentText: requirementIntent?.value || undefined, orderScaleBand: classifyOrderScale(form.quantity, form.unit).band, requirementMode: requirementMode().mode }); return { intelligenceDrivers: formatDrivers(c.drivers) || undefined, intelligenceQuiet: c.quiet.map((q) => q.value).join(' · ') || undefined, procurementContext: pc.context !== 'unknown' ? `${pc.label} · GST ${pc.implications.gstLikely ? 'needed' : 'not needed'} · approval: ${pc.implications.approvalFlow}` : undefined }; })(),
    })
      .then((newPlan) => {
        if (!newPlan) return;
        const newRank = (newPlan.specOrder?.length ? newPlan.specOrder : newPlan.mustHaveSpecs) || [];
        if (!newRank.length) return;
        const currentOrder = lockedSpecOrder ?? computeSpecOrder(true);
        // 3) Anti-jitter merge: PIN only the specs the USER actually touched (manual
        //    picks) at their CURRENT index; reorder everything else by the new ranking.
        //    We do NOT auto-pin the lead spec — when it's UNTOUCHED, an intent-driven
        //    re-rank MUST be able to demote it (e.g. GSM #1 → lower once use=Retail is
        //    known). A user-ANSWERED lead is already in manualSpecs, so it stays pinned
        //    in that case (e.g. Pump Design Type=Submersible). Best of both.
        const pinned = new Set([...manualSpecs].filter((n) => (form.dynamicSpecs[n] || '').trim()));
        const merged: (string | undefined)[] = new Array(currentOrder.length).fill(undefined);
        currentOrder.forEach((name, i) => { if (pinned.has(name)) merged[i] = name; });
        const remaining = [
          ...newRank.filter((n) => currentOrder.includes(n) && !pinned.has(n)),
          ...currentOrder.filter((n) => !pinned.has(n) && !newRank.includes(n)),
        ];
        let r = 0;
        for (let i = 0; i < merged.length; i++) if (merged[i] === undefined) merged[i] = remaining[r++];
        const finalOrder = merged.filter(Boolean) as string[];
        // 4) Record only the specs that actually moved (orig# → new#) for the badge.
        const moves: Record<string, { from: number; to: number }> = {};
        finalOrder.forEach((name, to) => {
          const from = currentOrder.indexOf(name);
          if (from !== -1 && from !== to) moves[name] = { from, to };
        });
        if (!Object.keys(moves).length) return; // nothing moved → no-op (no jitter, no flash)
        setLockedSpecOrder(finalOrder); // override the earlier lock — the one allowed re-rank
        setSpecRankMoves(moves);
        setReplanFlash(answer); // persists on the spec page (clears on product change) — matches the persistent "moved" badges
        track('rfq_replanned', { after: answer, moved: Object.keys(moves).length });
      })
      .catch(() => {})
      .finally(() => { if (viaIntentGate) setReplanPending(false); }); // reveal the (re-ranked) specs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqPlan, form.dynamicSpecs, dynAnswers, dynQuestions, isqSpecs, requirementIntent]);

  // Auto-open the details wizard once, after the first spec is filled (so it
  // doesn't ambush on arrival); afterwards it collapses to a reopenable chip.
  useEffect(() => {
    if (step !== 1 || dynLoading || intentAutoOpened.current || panelItems.length === 0) return;
    if (repostSource) return; // P: a re-post lands on the single Review screen — never ambush it with the wizard (the chip stays tappable)
    if (conciergeState === 'pending') return; // P5c: the concierge confirm must come FIRST — don't auto-open the wizard over it
    if (requirementIntent && !requirementIntent.value && !intentGateSkipped) return; // A6: the intent gate comes FIRST
    // qualifier-first plans (capital/project/service) lead with the qualifier —
    // open immediately. spec-first waits until the buyer has filled a spec —
    // EXCEPT when an INTENT-tier question is gating the specs (Refinement 2): then
    // open immediately so the buyer answers intent BEFORE the (held) specs reveal.
    const qualifierFirst = reqPlan?.orderMode === 'qualifier_first';
    const filledOne = Object.values(form.dynamicSpecs).some((v) => v && v.trim());
    const intentQ = dynQuestions.find((q) => q.tier === 'intent') || dynQuestions.find((q) => q.bucket === 'requirement');
    const intentUnanswered = !!intentQ && !((dynAnswers[intentQ.id] || '').trim()) && !intentGateSkipped;
    if (!qualifierFirst && !filledOne && !intentUnanswered) return;
    intentAutoOpened.current = true;
    setPanelFrozen(panelItems); // freeze the list for this session
    const firstUnanswered = panelItems.findIndex((it) => !isPanelItemAnswered(it));
    setPanelIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
    setIntentSheetOpen(true);
    track('rfq_panel_open', { auto: true, total: panelItems.length, answered: panelAnswered });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, dynLoading, dynQuestions, form.dynamicSpecs, conciergeState]);

  // Keep a live cursor ref so the look-ahead never rewrites a card the buyer is
  // on or has passed (that would be the jitter we fight). Only cards strictly
  // AHEAD of this index may be refined.
  useEffect(() => { panelIndexRef.current = panelIndex; }, [panelIndex]);

  // ── A5: write captured facts into the Knowledge Coverage Registry ────────────
  // Every stage's answers flow into one system-of-record (idempotent + lifecycle-aware),
  // so the reader (A5b) can skip anything already known across intent → planner → specs →
  // last page. Recording is SAFE (no behaviour change) — it only populates the registry.
  useEffect(() => {
    const cov = coverage.current;
    // Wizard / planner question answers (intent-tier → 'Intent', else 'Planner').
    for (const q of dynQuestions) {
      const a = (dynAnswers[q.id] || '').trim();
      if (a) cov.record(q.label, a, q.tier === 'intent' ? 'Intent' : 'Planner', 100);
    }
    // Spec values, tagged by who filled them.
    for (const [k, v] of Object.entries(form.dynamicSpecs)) {
      if (!v || !v.trim()) continue;
      const src: FactSource = manualSpecs.has(k) ? 'User' : enrichedSpecs.has(k) ? 'Enrichment' : cascadeSpecs.has(k) || autoFilledSpecs.has(k) ? 'Cascade' : 'User';
      const conf = src === 'User' ? 100 : src === 'Enrichment' ? 90 : (cascadeConf.current[k] ?? 82); // #71a: real per-spec cascade confidence

      cov.record(k, v, src, conf);
    }
    // Deduced logistics (timeline/payment beliefs). #3: ONLY record once confident enough
    // to be APPLIED to the form (≥0.8 — the same threshold setField uses below). A sub-0.8
    // deduction stays a soft suggestion, never a registry "truth" — otherwise the Truth Table
    // / Why-Asked assert a value ("Delivery = Flexible") that the form is still asking for.
    for (const [k, d] of Object.entries(deducedLogistics)) {
      if (d && d.value && (d.confidence || 0) >= 0.8) cov.record(k, d.value, 'Deduced', Math.round((d.confidence || 0) * 100));
    }
    // External → Registry bridge: consume ONLY Tier-1 VERIFIED, STRUCTURED business facts from
    // window.__ebi — GST / HSN / Udyam / NIC (unique, government-grade identifiers). World/OSINT and
    // Befisc/Sign3 identity stay OBSERVED-ONLY (shown in debug, never a planning input): a web match
    // on a generic name (e.g. "M Enterprises") could be the WRONG company, so promoting it to a
    // 'Verified' fact would manufacture bogus truth. World/OSINT graduates to Verified only once it
    // carries a real anchor-strength/confidence score (post-pilot). Recorded as 'Verified' (outranks
    // Twin, below User) so a buyer correction still overrides a GST guess.
    const ebi = (window as unknown as { __ebi?: { externalEvidenceLedger?: Array<Record<string, unknown>>; crossValidation?: { verifiedFacts?: Array<Record<string, unknown>> } } }).__ebi;
    const TIER1 = /gst|hsn|udyam|nic/i; // NOT world/osint (observed-only until confidence-scored)
    for (const e of ebi?.externalEvidenceLedger || []) {
      const src = String(e?.source || '');
      const val = String((e?.value_summary as string) || (e?.value as string) || '').trim();
      if (val && TIER1.test(src)) cov.record(src, val, 'Verified', typeof e?.confidence === 'number' ? (e.confidence as number) : 90);
    }
    // P4 — the agreement ladder graduates observed→Verified: a BUSINESS attribute (company / city)
    // corroborated by ≥3 INDEPENDENT sources is recorded as Verified. Personal identity (name / email /
    // pan) stays OBSERVED-only (debug, never planning) — agreement raises trust, it never unlocks PII.
    for (const f of ebi?.crossValidation?.verifiedFacts || []) {
      const key = String(f?.key || '');
      const val = String(f?.value || '').trim();
      if (val && /^(company|city)$/.test(key)) cov.record(`cross:${key}`, val, 'Verified', typeof f?.confidence === 'number' ? (f.confidence as number) : 92);
    }
    // P1.2 — record the Twin's confidently-compiled buyer role as an INFERRED fact (source 'Twin', which
    // NEVER suppresses a question — Golden Rule: a guess prefills/shapes, it never silently hides a card).
    // It shows as "Likely" in the system-of-record, and when the buyer's OWN buyer-type pick (User) or a
    // Verified business fact later states the SAME value, the record() lifecycle graduates it Observed/
    // Likely → Confirmed (corroboration). A DIFFERENT buyer answer OVERRIDES it (the buyer corrects the
    // guess). This closes the verification feedback loop with NO profile re-derivation and NO new suppression.
    const twinRole = String(buyerTwin?.layer_a_identity?.business_type || '').trim();
    if (twinRole && !/^(unknown|n\/?a)$/i.test(twinRole)) cov.record('Buyer type', twinRole, 'Twin', 50);
    // P3.9 — trial_first: a buyer who samples/trials before committing to bulk. Soft 'Twin' fact (never
    // suppresses) so the plan can frame a trial/sample option and it corroborates if the buyer confirms.
    const trialFirst = buyerTwin?.layer_c_commercial_intelligence?.trial_first;
    if (trialFirst && (trialFirst.value === true || String(trialFirst.value) === 'true') && typeof trialFirst.confidence === 'number' && trialFirst.confidence >= 60) cov.record('buying approach', 'Samples / trials before bulk', 'Twin', 50);
    // P2.6 — the ORDER-SCALE signal (1 piece vs 1000 pieces) → a SOFT 'Deduced' fact so the planner's
    // business-model / stage / commercial reasoning sees the magnitude explicitly (it flows through
    // requirementContext → planRequirement). Deduced = lowest authority, so it fills the "how big is
    // this order" Unknown but NEVER overturns a Confirmed buyer truth (a User/Verified fact always wins).
    const scale = classifyOrderScale(form.quantity, form.unit);
    if (scale.band !== 'unknown') {
      // CONSISTENCY (P1) — fix at the SOURCE: do NOT assert "personal use / sample / skip-credit" for a
      // BUSINESS or CAPITAL buyer. A single unit is then a normal procurement, not a consumer sample —
      // which is what made IIT-Kanpur's 1-piece capital buy read "personal" while ALSO deducing credit +
      // installation. Keep the qty band; neutralise the framing so the engines can't contradict.
      const businessCtx = page1Choice === 'business'
        || /capital|project|made_to_spec/i.test(reqPlan?.archetype || '')
        || /academic|research|government|psu/i.test(buyerProfile?.nature || '');
      const impl = (businessCtx && (scale.band === 'single' || scale.band === 'small'))
        ? `${scale.band} order — a single / low-volume BUSINESS purchase (not bulk); commercial terms still apply`
        : scale.implication;
      cov.record('order scale', `${scale.band} — ${impl}`, 'Deduced', 70);
    }
    (window as unknown as { __coverage?: unknown }).__coverage = cov; // debug introspection (window.__coverage.facts())
  }, [dynQuestions, dynAnswers, form.dynamicSpecs, form.quantity, form.unit, page1Choice, reqPlan, buyerProfile, manualSpecs, cascadeSpecs, enrichedSpecs, autoFilledSpecs, deducedLogistics, buyerTwin, external]);

  // #8: pre-record the buyer's STANDING cadence (and, only on a same-category repeat, budget)
  // from the persistent profile / prior order — so the planner doesn't re-ask "how often?" /
  // "what budget?" when the buyer's established pattern already answers it. Gated on a confident
  // profile; recorded as Deduced (honest source) at hide-worthy confidence (coverHides drops the
  // planner card); the buyer's own later answer still overrides it (authority). Generic mapping,
  // NO category literals — budget only from a SAME-category prior order value, never a guess.
  useEffect(() => {
    const cov = coverage.current;
    const bp = buyerProfile;
    if (bp && (bp.confidence ?? 0) >= 0.6 && bp.buyingPattern && !cov.isCovered('cadence')) {
      const PATTERN_CADENCE: Record<string, string> = {
        one_time_capex: 'One-time purchase',
        repeat_procurement: 'Recurring / repeat order',
        inventory_builder: 'Recurring / repeat order',
      };
      const cad = PATTERN_CADENCE[bp.buyingPattern];
      if (cad) cov.record('cadence', cad, 'Deduced', 85);
    }
    const matched = matchCategory(enrichment, form.productName);
    if (matched?.isqAnswers && !cov.isCovered('budget')) {
      const ov = Object.entries(matched.isqAnswers).find(([k]) => /order value|budget|probable/i.test(k));
      if (ov && ov[1]) cov.record('budget', String(ov[1]), 'Deduced', 82);
    }
  }, [buyerProfile, enrichment, form.productName]);

  // ── A6: Intent-First — derive the journey-adapted purpose question once per product ──
  // Single flash-lite call seeded by product + qty (default 1) + who's-buying + HIGH-conf
  // Twin truths only. Result is staged in `requirementIntent`; the gate + planner-seed wiring
  // consumes it next. Fires once per product+kind; never overwrites a locked (answered) intent.
  useEffect(() => {
    // Intent is now the PAGE-1 hero (replaces who's-buying), so fire as soon as the product
    // is committed on step 0. Still allowed on the spec step (1) as a fallback if page-1
    // generation hadn't landed before Continue. Never on the last step (step 2).
    if (!QUESTION_ENGINE || !hasGeminiKey() || step > 1 || !form.productName.trim()) return;
    // A6 / G6: allow the WHY question even for a category with NO ISQ specs — but only once the
    // product is COMMITTED + valid (not mid-fetch), so we don't fire on a transient empty list.
    if (isqSpecs.length === 0 && !(committedValid.current && committedProduct.current === form.productName.trim())) return;
    // #1: wait for QUANTITY when the category has a qty unit — the intent must not fire (or show)
    // until product + qty are both in. (No unit → qtyReady is true immediately.)
    if (!qtyReady) return;
    // T1: wait for the qty to be COMMITTED (blur / Enter / Continue), not mid-typing, so we don't
    // derive on a partial "1" of "100". (No unit → nothing to commit, fires immediately.)
    if (unitOptions.length > 0 && !qtyCommitted) return;
    // A1 (G): WAIT for the Twin even when buyer_profile auth FAILED — the Twin is built from the
    // OTHER six sources (PNS/BL/ISQ/WhatsApp/CSL) and is exactly the rich signal the intent needs.
    // The old `!pull?.profileAuthFailed` term fired deriveIntent twin-BLIND for profile-fail buyers
    // (common on this flaky webhook), so a conf-95 "Notebook Manufacturing Inputs" was missed and the
    // intent fell back to a generic product-surface guess ("Record keeping"). Only skip after a short
    // safety timeout, so a Twin that never lands can't permanently block Continue.
    const twinPending = !ignoreTwin && !!pull?.ok && !buyerTwin && !twinWaitTimedOut;
    if (twinPending) return;
    const kind = page1Choice === 'business' || page1Choice === 'personal' ? page1Choice : undefined;
    // T4: key on the requirement-mode bucket + unit so a committed qty/unit CHANGE (retail↔bulk,
    // Piece→Tonne) re-derives the intent chips. A locked (answered) intent still persists below.
    // A2 (G): include the Twin's high-conf active-intent in the signature so a Twin that lands AFTER
    // a (timed-out) twin-blind derivation RE-DERIVES rather than freezing the stale generic guess.
    const twAiSig = String((ignoreTwin ? null : liveTwin())?.layer_c_commercial_intelligence?.current_active_intent?.value || '');
    const sig = `${form.productName.trim().toLowerCase()}|${kind || ''}|${requirementMode().mode}|${(form.unit || '').toLowerCase()}|${twAiSig}|${buyerStoryRef.current?.arc || ''}`;
    if (intentSig.current === sig) return;
    intentSig.current = sig;
    intentResolved.current = false; // a fresh intent derivation is now in-flight (gates Continue)
    const tw = ignoreTwin ? null : liveTwin();
    const tb = tw ? buildTwinPlanInput(tw, form.productName) : undefined;
    // #2 + G3: feed the buyer's distilled context to the chips at MODERATE confidence (≥40) — but
    // ONLY when the current product is ON-PROFILE (relates to their history). OFF-PROFILE (a new area,
    // e.g. an electronics buyer asking for "potatoes"), pass NOTHING so the LLM derives PURELY from the
    // current product — never anchoring the new requirement on the unrelated historical domain.
    // ("Weight what they're asking now; stitch history only if related; else persist with current.")
    // INTELLIGENCE TRANSFER (replaces the old binary off-profile mute): tier the buyer's intelligence and
    // carry A (who they are) + B (how they buy) ALWAYS; C (their categories) only when the new product is
    // RELATED. Even off-profile, "manufacturer · large · regional · credit" still informs intent — only
    // category intel is gated. This is the Jaiveer fix at its root: paper no longer mutes his manufacturer
    // identity. Relatedness = wider of full-history lexical overlap and the Buyer Story's semantic score.
    const histCats = [...new Set([
      ...((enrichment?.categories || []).map((c) => c.mcat).filter(Boolean) as string[]),
      ...(((tw?.layer_c_commercial_intelligence?.historical_categories) || []) as string[]),
    ])];
    const tItems = tierBuyerIntelligence({
      profile: buyerProfile,
      twinBusinessType: tw?.layer_a_identity?.business_type,
      region: tw?.layer_a_identity?.city || enrichment?.buyer?.city,
      language: tw?.layer_a_identity?.language,
      verified: !!tw?.layer_a_identity?.verified,
      historicalCategories: histCats,
      themes: twinThemes(),
    });
    const tDec = decideTransfer(tItems, Math.max(categoryRelatedness(form.productName, histCats, coreTokens), buyerStoryRef.current?.relatedness ?? 0));
    // CONSUMPTION: of everything that transferred, weight what should ACTUALLY shape this product's intent —
    // drop routing-only facts (language/channel), and down-weight authority/procurement for a plain commodity
    // (the office-chair fix). Only the drivers seed deriveIntent; the rest stay carried-but-quiet.
    const tCons = consume(tDec.transfer, { orderScale: classifyOrderScale(form.quantity, form.unit).band, archetype: reqPlan?.archetype });
    const twinTruths = tb && tb.confidence >= 40 ? formatDrivers(tCons.drivers) : formatDrivers(tCons.drivers.filter((i) => i.tier === 'A')); // low-confidence twin → carry only hard buyer facts
    (window as unknown as { __transfer?: unknown; __consumption?: unknown }).__transfer = tDec;
    (window as unknown as { __consumption?: unknown }).__consumption = tCons; // debug introspection
    logPrompt({ prompt: 'deriveIntent (A6)', model: 'gemini-2.5-flash-lite', purpose: 'journey-adapted purpose question, asked before the planner', inputs: `product="${form.productName}" · qty=${form.quantity || 'unspecified'} · kind=${kind || '?'} · twin=[${twinTruths || 'none'}]` });
    // #7: pass the REAL quantity (or empty → "not specified"); never fabricate a "1" that the
    // buyer didn't type — the journey/derivation must not reason on a phantom order size.
    deriveIntent({ productName: form.productName, quantity: form.quantity, unit: form.unit, buyerKind: kind, twinTruths, observedContext: observedExternalContext() || undefined, orderScale: classifyOrderScale(form.quantity, form.unit).band, buyerStory: buyerStoryRef.current ? `${buyerStoryRef.current.arc}${buyerStoryRef.current.story ? ' — ' + buyerStoryRef.current.story : ''}` : undefined,
      // BUYER×CATEGORY FUSION (gated): only when the category is RICH (categoryConf.fuse) do we pass
      // its real use-cases to frame the intent question around the buyer's operation. Thin/empty/cold
      // category → undefined → buyer-only framing (the safe default). It stays a CONFIRM question.
      categoryFusion: categoryConf.fuse && categoryConsumed.applications.length ? { applications: categoryConsumed.applications } : undefined })
      .then((res) => {
        intentResolved.current = true; // derivation done (even if it produced nothing) → Continue unblocks
        if (!res) return;
        // #1 REGISTRY-FIRST intent pre-check: consult the Coverage Registry before deciding to
        // ask. If it ALREADY knows the intent with high confidence (from ANY source — history-
        // derived, a prior fact) trust IT (the registry is the source of truth); else use
        // deriveIntent's own high-conf derivation (product name / twin truths). Either way the
        // page-1 hero shows a one-tap "we understood this is for X — change?" confirmation rather
        // than the chip question. Below the bar → ask the chip question. The buyer can always edit.
        const reg = coverage.current.coveredBy('intent');
        const regKnown = !!reg && reg.confidence >= 80;
        const derivedKnown = !!res.derivedIntent && res.confidence >= 80;
        const twNow = ignoreTwin ? null : liveTwin();
        const twAI = twNow?.layer_c_commercial_intelligence?.current_active_intent;
        const twinKnown = !!twAI && typeof twAI.confidence === 'number' && twAI.confidence >= 80 && !!twAI.value;
        const offProfile = twNow ? buildTwinPlanInput(twNow, form.productName).offProfile : false;
        // G2: ON-PROFILE, the Twin's evidence-backed active-intent (many signals, conf ≥80) is a BETTER
        // derived default than a one-shot LLM guess — PREFER it. The LLM is given the Twin but can still
        // misfire (e.g. it read a notebook MANUFACTURER's "notebook paper" as "resale" when it's a
        // manufacturing INPUT). OFF-PROFILE (a genuinely new area), the product-specific LLM derivation
        // wins — the historical active-intent doesn't apply. Either way it stays a one-tap CONFIRMATION
        // (source 'derived', NOT locked), recorded as History (a prior — never suppresses). The CURRENT
        // requirement always wins: the buyer confirms or changes it on the page-1 hero.
        // G3: the Twin's active-intent is used ONLY on-profile (preferTwin). OFF-PROFILE it is NEVER
        // used — not even as a fallback — so an unrelated product (potatoes) can't inherit a historical
        // intent (desktop peripherals). Precedence: current registry answer > on-profile Twin intent >
        // the LLM's product derivation > ask the chip question (value null). No off-profile twin leak.
        const preferTwin = twinKnown && !offProfile;
        const value = regKnown ? reg!.value : preferTwin ? String(twAI!.value) : derivedKnown ? res.derivedIntent : null;
        const conf = regKnown ? reg!.confidence : preferTwin ? (twAI!.confidence as number) : derivedKnown ? res.confidence : 0;
        // Correct the journey when the Twin-preferred intent reads as a manufacturing/processing INPUT,
        // so requirement-mode + planner don't treat a manufacturing input as resale.
        const journey = preferTwin && /manufactur|production|raw material|\binput|industrial|processing/i.test(String(twAI!.value)) ? 'industrial' : res.journey;
        // A confident LLM derivation records as Intent; an on-profile Twin-preferred value records as History (prior).
        if (derivedKnown && !regKnown && !preferTwin) coverage.current.record('primary use', res.derivedIntent, 'Intent', res.confidence);
        else if (preferTwin && !regKnown) coverage.current.record('primary use', String(twAI!.value), 'History', twAI!.confidence as number);
        // DEBUG provenance: snapshot the precedence race so the first-page panel can explain WHY this
        // value won — which candidates existed, their confidence, and who was overridden/off-profile.
        intentDecisionRef.current = {
          registry: reg ? { value: reg.value, confidence: reg.confidence } : null,
          twin: twAI && twAI.value ? { value: String(twAI.value), confidence: typeof twAI.confidence === 'number' ? twAI.confidence : 0, offProfile } : null,
          llm: res.derivedIntent ? { value: res.derivedIntent, confidence: res.confidence } : null,
          chips: res.chips || [],
          chosenValue: value,
          threshold: 80,
        };
        intentCandidatesRef.current = res.intentCandidates && res.intentCandidates.length ? res.intentCandidates : null;
        setIntentDecisionTick((t) => t + 1);
        setRequirementIntent((prev) => (prev && prev.locked ? prev : {
          value, journey, question: res.question, chips: res.chips,
          confidence: conf, source: 'derived', locked: false,
        }));
      })
      .catch(() => { intentResolved.current = true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isqSpecs, form.productName, qtyDebounced, form.unit, qtyCommitted, unitOptions, page1Choice, ignoreTwin, pull, buyerTwin, twinWaitTimedOut]);

  // A1 safety (G): time-box the wait for the Twin. If a pull succeeded but the Twin hasn't landed in
  // 2.5s (slow/failed derivation), let the intent derive twin-blind rather than hang Continue. Resets
  // the moment the Twin arrives (so the intent effect re-runs WITH the Twin) or when there's no pull.
  useEffect(() => {
    if (ignoreTwin || !pull?.ok || buyerTwin) { setTwinWaitTimedOut(false); return; }
    const t = setTimeout(() => setTwinWaitTimedOut(true), 2500);
    return () => clearTimeout(t);
  }, [pull?.ok, buyerTwin, ignoreTwin]);

  // ── Auto-resolve "who's buying" from the Twin/persona ────────────────────────
  // The page-1 business/personal toggle is GONE (intent replaces it). When a GLID is
  // pulled, the buyer kind is implied by their profile — derive it silently so we never
  // ask. Cold buyers stay '' until the chosen intent journey implies a kind (answerIntent).
  // Role-based + journey-based only; NO category literals. personal → End User (so the
  // spec-step role card is skipped, mirroring the old toggle); business → role collected later.
  useEffect(() => {
    if (page1Choice) return; // already known (derived earlier, or inferred from intent)
    const tw = ignoreTwin ? null : liveTwin();
    const role = String(tw?.layer_a_identity?.business_type || enrichment?.persona?.type || '').trim();
    if (!role) return;
    if (/individual|personal|end[\s-]?user|consumer|household|home\s*buyer/i.test(role)) {
      setPage1Choice('personal');
      if (!form.buyerType) setField('buyerType', 'End User');
    } else {
      setPage1Choice('business');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyerTwin, enrichment, ignoreTwin, page1Choice]);

  // ── Adaptive look-ahead ──────────────────────────────────────────────────────
  // As soon as we know something (the lead spec from the spec page, page-1
  // context, the role, or a prior panel answer), re-tailor the UPCOMING, not-yet-
  // answered questions to this exact buyer — in their own terms (Usage=Salon →
  // "How big is your salon? Single chair / 2-5 / Chain"). Runs while the sheet is
  // open, once per distinct knowledge-state; only mutates cards ahead of the
  // cursor; debug-traced. This is the mechanism that stops the form asking dumb
  // generic things anywhere downstream.
  useEffect(() => {
    if (!intentSheetOpen || !QUESTION_ENGINE || !hasGeminiKey()) return;
    const items = panelFrozen;
    if (!items) return;
    // What we already know — feed it all to the refiner.
    const known: Record<string, string> = {};
    for (const [k, v] of Object.entries(form.dynamicSpecs)) if (v && v.trim()) known[k] = v;
    if (form.buyerType) known['Buyer type'] = form.buyerType;
    if (page1Choice) known['Buying for'] = page1Choice === 'personal' ? 'Personal use' : 'Business';
    // G2 + registry-as-source-of-truth: order size + EVERY active/confirmed registry fact
    // (intent, spec picks, cascade fills, deduced logistics, Verified external) — so look-ahead
    // re-tailors upcoming questions/options to the FULL known truth, never re-asks/contradicts it.
    if (form.quantity) known['Order size'] = `${form.quantity}${form.unit ? ' ' + form.unit : ''}`;
    for (const f of coverage.current.facts()) if (f.status === 'active' || f.status === 'confirmed') known[f.concept.replace(/_/g, ' ')] = f.value;
    for (const it of items) if (it.kind === 'dyn' && dynAnswers[it.q.id]) known[it.q.label] = dynAnswers[it.q.id];
    Object.assign(known, buyerProfileKnown()); // who the buyer is (persistent profile)
    const sig = JSON.stringify(known);
    if (!Object.keys(known).length || refineSig.current === sig) return;
    refineSig.current = sig; // claim synchronously
    // Refine only cards strictly AHEAD of the cursor and not yet answered.
    const cursor = panelIndexRef.current;
    const upcoming = items
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => i > cursor && it.kind === 'dyn' && !dynAnswers[(it as { q: DynQuestion }).q.id])
      .map(({ it }) => {
        const q = (it as { q: DynQuestion }).q;
        return { id: q.id, label: q.label, options: q.options || [] };
      });
    if (!upcoming.length) return;
    setPanelRefining(true);
    logPrompt({
      prompt: 'refineQuestions · look-ahead',
      model: 'gemini-2.5-flash-lite',
      purpose: 'tailor upcoming questions to what the buyer already told us',
      inputs: `known=${sig} · upcoming(${upcoming.length})=[${upcoming.map((u) => u.label).join(' | ')}]`,
    });
    refineQuestions({ productName: form.productName, known, upcoming })
      .then((rev) => {
        if (!rev || !Object.keys(rev).length) return;
        setPanelFrozen((prev) => {
          if (!prev) return prev;
          return prev.map((it, i) => {
            // Anti-jitter: never touch the current card or any the buyer passed.
            if (i <= panelIndexRef.current || it.kind !== 'dyn') return it;
            const r = rev[it.q.id];
            if (!r || r.drop) return it; // ignore drops (index shifts = jitter)
            const options = (r.options?.length ?? 0) >= 2 ? r.options : it.q.options;
            return { ...it, q: { ...it.q, label: r.label || it.q.label, options, genBy: 'refine', genInputs: sig } };
          });
        });
      })
      .finally(() => setPanelRefining(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentSheetOpen, panelFrozen, form.dynamicSpecs, form.buyerType, page1Choice, dynAnswers, form.productName, buyerProfile, buyerProfileKnown, logPrompt]);

  // Auto-set buyerType when a spec already revealed it (Usage=Salon ∈ personas),
  // so the role card is skipped and the last step still gates GST/Firm correctly.
  // Never overrides a manual pick; runs once per deduction; debug-traced.
  useEffect(() => {
    if (personaSpecMatch && !form.buyerType && !buyerTypeManual.current) {
      setField('buyerType', personaSpecMatch.buyerType);
      setBuyerTypeDeducedFrom(`${personaSpecMatch.fromSpec}=${personaSpecMatch.fromVal}`);
      track('rfq_buyertype_deduced', personaSpecMatch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaSpecMatch?.buyerType, form.buyerType]);

  // V3: ALSO skip the role card when the TWIN confidently knows the buyer's role — don't re-ask
  // "who are you" when we already know. Auto-set it (mirroring the spec→persona path above) so the
  // last step still gates GST/Firm correctly. Marked deduced (buyerTypeDeducedFrom), so
  // renderBuyerKindNote surfaces a "change" to recover/correct it — never a silent hidden field.
  // Derives ONLY from the Twin's layer_a identity (the canonical source) — NOT buyerProfile.persona,
  // which resolves earlier and can disagree (a profile "Manufacturer" vs a Twin "Trader" race). The
  // Twin outranks the profile, so trusting it avoids seeding a stale role we then can't correct.
  // Never overrides a manual pick, a spec-derived role, or the personal journey; off for ignoreTwin.
  useEffect(() => {
    if (form.buyerType || buyerTypeManual.current || personaSpecMatch || ignoreTwin) return;
    if (!showProfile || page1Choice === 'personal') return; // retail/personal → no business role to derive
    // Use the Nature-aware canonical resolver — an ACADEMIC/GOVERNMENT buyer is seeded as an
    // institution, never the Twin's LLM "Manufacturer" guess. Corporate falls back to the raw Twin type.
    const role = canonicalBuyerType();
    if (role && !/unknown|individual|end[\s-]?user|consumer|home/i.test(role)) {
      const institutional = !!(buyerProfile?.nature && /academic|research|government|psu/i.test(buyerProfile.nature));
      setField('buyerType', role);
      setBuyerTypeDeducedFrom(institutional ? 'your institution profile' : 'your business profile');
      track('rfq_buyertype_deduced', { buyerType: role, from: institutional ? 'nature' : 'twin' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.buyerType, personaSpecMatch?.buyerType, showProfile, page1Choice, buyerTwin, buyerProfile]);

  // ── Analytics (pilot diagnostics) ────────────────────────────────────────────
  // rfq_off_profile: fires once when the current product diverges from the buyer's history
  // (discovery mode) — lets us measure off-profile success/abandonment in the pilot.
  useEffect(() => {
    const p = form.productName.trim().toLowerCase();
    if (!p || offProfileTracked.current === p) return;
    if (offProfileNow()) { offProfileTracked.current = p; track('rfq_off_profile', { product: form.productName, glid: enrichment?.glid || glidInput || '' }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.productName, buyerTwin, enrichment]);
  // rfq_questions_resolved: once per plan signature, how many planner questions are SHOWN vs
  // HIDDEN-by-coverage — the duplicate-question + suppression-correctness metric both audits asked for.
  useEffect(() => {
    if (step !== 1 || dynLoading) return;
    const llmQs = dynQuestions.filter((q) => q.slot === 'specs' || q.slot === 'requirement' || q.slot === 'persona');
    if (!llmQs.length) return;
    const hidden = llmQs.filter((q) => !dynAnswers[q.id] && coverHides(q.label));
    const shown = llmQs.length - hidden.length;
    const sig = `${form.productName}|${llmQs.map((q) => q.id).join(',')}|${shown}/${hidden.length}`;
    if (questionsResolvedSig.current === sig) return;
    questionsResolvedSig.current = sig;
    track('rfq_questions_resolved', { shown, hidden: hidden.length, hiddenLabels: hidden.map((q) => q.label).slice(0, 8) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, dynLoading, dynQuestions, dynAnswers, form.productName]);

  // ── Last-page belief (the Dumbledore payoff) ─────────────────────────────────
  // On reaching the last step, deduce the logistics we'd otherwise ask BLANK
  // (delivery timeline, payment terms) from EVERYTHING known — enrichment history,
  // persona, specs, panel answers. Pre-fill the ones we're ≥80% sure of (rendered
  // editable as "✦ noted — tap to change"); ask only the rest. Re-runs only when
  // the knowledge state changes; never overrides a value the buyer already set.
  useEffect(() => {
    if (step !== 2 || !QUESTION_ENGINE || !hasGeminiKey()) return;
    const known: Record<string, string> = {};
    for (const [k, v] of Object.entries(form.dynamicSpecs)) if (v && v.trim()) known[k] = v;
    for (const q of dynQuestions) if (dynAnswers[q.id]) known[q.label] = dynAnswers[q.id];
    if (form.buyerType) known['Buyer type'] = form.buyerType;
    // #6: the last-page deduction must know the buyer's stated PURPOSE too (it drove the whole
    // plan) — the requirementContext chain reached cascade/refine/help but missed this call.
    if (requirementIntent?.value) known['Primary use / intent'] = requirementIntent.value;
    if (form.quantity) known['Quantity'] = `${form.quantity} ${form.unit || ''}`.trim();
    // A10: the CURRENT order's mode is the HIGH-weight signal — it outranks the persisted persona
    // for payment/delivery. A one-off single unit → advance/COD even for a Manufacturer/credit buyer.
    const rmDed = requirementMode();
    if (rmDed.descriptor) {
      known['CURRENT ORDER MODE (weigh ABOVE the buyer persona for payment/delivery)'] = `${rmDed.mode}: ${rmDed.descriptor}`;
      known['Payment lean for THIS order'] = rmDed.paymentLean; // advance | credit | either
    }
    if (enrichment?.persona?.type) known['Persona'] = enrichment.persona.type;
    if (enrichment?.persona?.scale) known['Order scale'] = enrichment.persona.scale;
    if (enrichment?.persona?.repeatBuyer) known['Repeat buyer'] = 'yes';
    if (enrichment?.buyer?.city) known['City'] = enrichment.buyer.city;
    Object.assign(known, buyerProfileKnown()); // who the buyer is (persistent profile)
    // A5 / G4: pull EVERY active/confirmed registry fact (cascade specs, pre-recorded cadence
    // #8, Verified external) into `known` — same source-of-truth the cascade/refine use — so the
    // last-page deduction sees the full picture, not a hand-built subset.
    for (const f of coverage.current.facts()) if (f.status === 'active' || f.status === 'confirmed') known[f.concept.replace(/_/g, ' ')] = f.value;
    const sig = JSON.stringify(known);
    if (logisticsSig.current === sig || !Object.keys(known).length) return;
    logisticsSig.current = sig;
    const fields = (
      [
        { id: 'deliveryTimeline', label: 'Delivery timeline', options: ['Immediate', 'Within 15 Days', '1 Month', 'Flexible'] },
        { id: 'paymentTerms', label: 'Payment terms', options: ['Full Advance', 'Credit (Post-Delivery)', 'COD', 'Loan/Finance'] },
      ] as const
    ).filter((f) => !form[f.id]);
    if (!fields.length) return;
    logPrompt({
      prompt: 'deduceLogistics',
      model: 'gemini-2.5-flash-lite',
      purpose: 'pre-fill last-page logistics from what we know (apply ≥0.8, ask the rest)',
      inputs: `known=${sig} · fields=[${fields.map((f) => f.id).join(', ')}]`,
    });
    deduceLogistics({ productName: form.productName, known, fields: fields as unknown as { id: string; label: string; options: string[] }[] })
      .then((res) => {
        if (!res || !Object.keys(res).length) return;
        setDeducedLogistics((p) => ({ ...p, ...res }));
        for (const [id, d] of Object.entries(res)) {
          if (d.confidence >= 0.8 && !form[id as 'deliveryTimeline' | 'paymentTerms']) {
            setField(id as keyof RFQFormData, d.value);
          }
        }
        track('rfq_logistics_deduced', res);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.dynamicSpecs, dynAnswers, form.buyerType, enrichment, buyerProfile, buyerProfileKnown, form.productName, requirementIntent?.value]);

  // On reaching the last step, replace the raw notes with a clean, PII-free
  // one-line summary for suppliers (runs once; PII is also scrubbed regardless).
  // The supplier-facing requirement line is finalised at submit time (see
  // finalizeRequirement), so it captures every answer typed on the final step
  // and is always PII-scrubbed. (IndiaMART sells buyer contact as a paid lead —
  // the requirement text must never expose phone/email/name.)

  const progressPercent = step === 0 ? 0 : step === 1 ? 50 : 85;

  // ─── Product input ──────────────────────────────────────────────────────────
  const handleProductInputChange = (value: string) => {
    setField('productName', value);
    const local = filterProducts(value);
    setProductSuggestions(local);
    setShowDropdown(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (value.length > 1) {
        try {
          // Try the raw query and a quantity-stripped variant ("100 m jute rope"
          // → "jute rope") so inline quantities don't break autosuggest.
          const cleaned = stripQuantityPrefix(value);
          const [remote, remoteCleaned] = await Promise.all([
            fetchProductSuggestions(value),
            cleaned.toLowerCase() !== value.toLowerCase()
              ? fetchProductSuggestions(cleaned)
              : Promise.resolve([] as string[]),
          ]);
          const merged = [...remote, ...remoteCleaned];
          for (const l of local) {
            if (!merged.some((r) => r.toLowerCase() === l.toLowerCase())) merged.push(l);
          }
          // de-dupe
          const seen = new Set<string>();
          const deduped = merged.filter((m) => {
            const k = m.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          setProductSuggestions(deduped.slice(0, 10));
        } catch {}
      }
    }, 350);
  };

  const addRecentSearch = (name: string) => {
    setRecentSearches((prev) => {
      const next = [name, ...prev.filter((r) => r !== name)].slice(0, 5);
      localStorage.setItem('rfq_recent_searches', JSON.stringify(next));
      return next;
    });
  };

  const handleProductCommit = useCallback(
    async (name: string, opts?: { trusted?: boolean }): Promise<{ valid: boolean; specs: ISQSpec[] }> => {
      setField('productName', name);
      setShowDropdown(false);
      setQtyCommitted(false); // T1: a new product → qty must be re-entered/committed before intent fires
      addRecentSearch(name);
      let fetchedSpecs: ISQSpec[] = [];
      setSpecsLoading(true); // show the global loader while the IndiaMART ISQ/mcat APIs are in flight

      // Validate it's a real B2B product. The mcatid-suggestion API fuzzy-matches
      // any string, so use the autocomplete suggest API: a genuine product returns
      // real suggestions, while junk returns nothing. Buyers also type the quantity
      // inline ("100 m jute rope") which breaks raw autosuggest, so we also try a
      // quantity-stripped variant before deciding it's invalid.
      // TRUSTED bypass (re-post): a "Buy again" title is a GENUINE prior requirement of THIS
      // buyer (from their BL/ISQ history) — it must NOT be re-validated through the autosuggest
      // gate, which wrongly rejects long/qualified historical titles ("1300Pcs/Hr Notebook
      // Making Machine") that return no clean autosuggest match. Trust it and resolve its mcat.
      let valid = true;
      if (!opts?.trusted) {
        try {
          const cleaned = stripQuantityPrefix(name);
          const lists = await Promise.all([
            fetchProductSuggestions(name),
            cleaned.toLowerCase() !== name.toLowerCase()
              ? fetchProductSuggestions(cleaned)
              : Promise.resolve([] as string[]),
          ]);
          const real = lists.flat().filter((s) => {
            const t = s.toLowerCase().trim();
            return t !== name.toLowerCase().trim() && t !== cleaned.toLowerCase().trim();
          });
          valid = real.length > 0;
        } catch {
          valid = true; // never block on a network error
        }
      }
      committedValid.current = valid;

      if (!valid) {
        setForm((prev) => ({ ...prev, dynamicSpecs: {}, mcatId: '' }));
        setIsqSpecs([]);
        isqSpecsRef.current = [];
        setUnitOptions([]);
        setProductImageUrl('');
        setIsqHints({});
        setKnownFromProductName({});
        setRedundantISQSpecs([]);
        setPreferenceSpecs(new Set());
        committedMcatId.current = '';
        committedProduct.current = name;
        setSpecsLoading(false);
        return { valid: false, specs: [] };
      }

      // Pull an inline quantity out of the name, e.g. "100 meter jute rope".
      const parsedQty = parseQuantityFromName(name);
      if (parsedQty?.quantity) setField('quantity', parsedQty.quantity);

      try {
        const resolveMcat = async (q: string): Promise<string> => {
          const data = await getJSON<Record<string, string> | Array<Record<string, string>>>(
            `/api/imimg/models/mcatid-suggestion.php?search_param=${encodeURIComponent(q)}&modid=MY`
          );
          // API may return array or single object; key may be mcat_id, MID, or mcatid
          const it = Array.isArray(data) ? data[0] : data;
          return String(it?.mcat_id ?? it?.MID ?? it?.mcatid ?? it?.mcatId ?? '');
        };
        // A verbose historical/re-post title ("1300Pcs/Hr Notebook Making Machine") resolves to a
        // category better once the qty/qualifier prefix is stripped — fall back to the cleaned form.
        let mcatId = await resolveMcat(name);
        const cleanedName = stripQuantityPrefix(name);
        if (!mcatId && cleanedName && cleanedName.toLowerCase() !== name.toLowerCase()) {
          mcatId = await resolveMcat(cleanedName);
        }

        if (mcatId && mcatId !== committedMcatId.current) {
          // Product changed → invalidate any in-flight image/text analysis and
          // clear the manual/suggested tracking for the previous product.
          analysisToken.current++;
          setManualSpecs(new Set());
          setAutoFilledSpecs(new Set());
          setAssistNudge(0);
          setShowAllSpecs(false);
          setPage1Choice('');
          planSig.current = '';
          setReqPlan(null);
          setQuestionBudget(null);
          setConciergeState('none');
          twinMuted.current = false;
          setBlId(''); // new product = new requirement = new BuyLead key
          trackingCtx.bl_id = '';
          setPanelFrozen(null);
          setLockedSpecOrder(null);
          specTouched.current = false;
          setEnrichedSpecs(new Set());
          setRemovedSpecs(new Set()); // new product = fresh spec set; clear prior removals
          setRepostSource(null); // P: a manual product change cancels any re-post (handleRepost re-sets it AFTER this)
          setRepostMeta({});
          setCascadeSpecs(new Set());
          setCascadeFrom('');
          setCascadeRationale('');
          cascadeSig.current = '';
          replannedOnce.current = false;
          setSpecRankMoves({});
          setReplanFlash('');
          setIntentGateSkipped(false);
          setReplanPending(false);
          coverage.current.reset(); // A5: new product = fresh requirement memory
          setRequirementIntent(null); // A6: new product = fresh intent
          intentSig.current = '';
          refineSig.current = '';
          setPanelRefining(false);
          buyerTypeManual.current = false;
          setBuyerTypeDeducedFrom('');
          setDeducedLogistics({});
          logisticsSig.current = '';
          setPromptTraces([]);
          setGateDecisions([]);
          setPlanTrace('');
          // Reset spec state
          setForm((prev) => ({ ...prev, dynamicSpecs: {} }));
          setIsqSpecs([]);
          isqSpecsRef.current = [];
          setUnitOptions([]);
          setProductImageUrl('');
          setIsqHints({});
          setKnownFromProductName({});
          setRedundantISQSpecs([]);
          setPreferenceSpecs(new Set());

          // ── Shared spec helpers (used by BOTH ISQ APIs so they produce identical display specs) ──
          // map raw rows from EITHER API → display specs (non-qty, ≤10, options cleaned; GetIsq uses
          // '##' separators, getISQs comma/OPTIONS_DATA — handle both).
          const mapDisplaySpecs = (rows: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>): ISQSpec[] =>
            (rows || [])
              .filter((r) => r && r.IM_SPEC_MASTER_DESC && !/quantity|qty|unit/i.test(r.IM_SPEC_MASTER_DESC))
              .slice(0, 10)
              .map((r) => {
                const opts = (
                  Array.isArray(r.OPTIONS_DATA) && r.OPTIONS_DATA.length
                    ? r.OPTIONS_DATA.map((o) => (o.IM_SPEC_OPTIONS_DESC || '').trim()).filter(Boolean)
                    : (r.IM_SPEC_OPTIONS_DESC || '').split(/##|,/).map((o) => o.trim()).filter(Boolean)
                ).filter((o) => !/^others?$/i.test(o));
                return { ...r, IM_SPEC_OPTIONS_DESC: opts.join('##') };
              });
          const runSpecHints = (displaySpecs: ISQSpec[]): void => {
            if (!hasGeminiKey() || displaySpecs.length === 0) return;
            const specsWithOptions = displaySpecs.reduce<Record<string, string[]>>((acc, s) => {
              if (s.IM_SPEC_OPTIONS_DESC) acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean);
              return acc;
            }, {});
            classifyFieldTypes(name, displaySpecs.map((s) => s.IM_SPEC_MASTER_DESC))
              .then((cls) => { setPreferenceSpecs(new Set(cls.preference)); logPrompt({ prompt: 'classifyFieldTypes (bias gate)', model: 'gemini-2.5-flash-lite', purpose: 'mark brand/preference fields → never auto-filled', inputs: `preference=[${cls.preference.join(', ')}]` }); })
              .catch(() => {});
            getSpecHints(name, displaySpecs.map((s) => s.IM_SPEC_MASTER_DESC), specsWithOptions, twinPromptContext(liveTwin()))
              .then((hints) => {
                setIsqHints(hints.isqHints ?? {});
                setKnownFromProductName(hints.knownFromProductName ?? {});
                setRedundantISQSpecs(hints.redundantISQSpecs ?? []);
                logPrompt({ prompt: 'getSpecHints', model: 'gemini-2.5-flash-lite', purpose: `name-detect specs (${Object.keys(hints.knownFromProductName ?? {}).length}) + hints + ${(hints.redundantISQSpecs ?? []).length} not-applicable`, inputs: `product="${name}" · ISQ(${displaySpecs.length})=[${displaySpecs.map((s) => s.IM_SPEC_MASTER_DESC).join(', ')}] · twin=[${twinPromptContext(liveTwin()) || 'none'}]` });
                const known = hints.knownFromProductName ?? {};
                Object.keys(known).filter((k) => known[k] && PREFERENCE_RE.test(k)).forEach((k) => logGate({ field: k, classification: 'preference', action: 'blocked_autofill', reason: prefReason(k), at: 'product-name' }));
                // RE-POST (trusted): do NOT auto-fill specs from the product name — a re-post only carries
                // the buyer's OWN prior specs; no AI fills anything. (Other flows keep name-detect.)
                if (!opts?.trusted) setForm((prev) => { const merged = { ...prev.dynamicSpecs }; for (const [k, v] of Object.entries(known)) { if (v && !merged[k] && !PREFERENCE_RE.test(k)) merged[k] = v; } return { ...prev, dynamicSpecs: merged }; });
              })
              .catch(() => {});
          };
          // Apply a display-spec set to the UI (+ AI hints). `fetchedSpecs` (the function's return) tracks
          // the latest applied set so ensureReqPlan seeds off real specs.
          const applySpecs = (displaySpecs: ISQSpec[]): void => {
            setIsqSpecs(displaySpecs);
            isqSpecsRef.current = displaySpecs;
            fetchedSpecs = displaySpecs;
            runSpecHints(displaySpecs);
          };

          // 1) GetIsq (FAST, ~30ms) — qty/unit options AND the display specs. We render the specs
          //    IMMEDIATELY so the spec page never waits on the slow API. (Previously we discarded
          //    GetIsq's display specs and blocked on the 15-30s getISQs below.)
          try {
            const isqJson = await getJSON<{ DATA?: (ISQSpec | ISQSpec[])[] }>(
              `/api/imimg/index.php?r=Newreqform/GetIsq&modid=MY&mcatid=${mcatId}&cat_type=3&flag=1&isq_format=1&generic_flag=1&country_iso=IN`
            );
            // DATA[0] is itself an array of specs; flatten one level
            const raw: (ISQSpec | ISQSpec[])[] = isqJson?.DATA ?? [];
            const flat = raw.flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s) => s && s.IM_SPEC_MASTER_DESC);
            const qtySpecs = flat.filter((s) => /quantity|qty|unit/i.test(s.IM_SPEC_MASTER_DESC));
            const unitOpts: string[] = [];
            for (const qs of qtySpecs) {
              if (qs.IM_SPEC_OPTIONS_DESC) {
                qs.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter((o) => Boolean(o) && o.toLowerCase() !== 'none').forEach((o) => { if (!unitOpts.includes(o)) unitOpts.push(o); });
              }
            }
            setUnitOptions(unitOpts);
            if (unitOpts.length > 0) {
              const typedUnit = parsedQty?.unit;
              const matched = typedUnit && unitOpts.find((o) => o.toLowerCase() === typedUnit || o.toLowerCase().startsWith(typedUnit) || typedUnit.startsWith(o.toLowerCase()));
              setField('unit', matched || unitOpts[0]);
            }
            // The INSTANT display specs — GetIsq already carries them (e.g. Power / Phase / Enclosure).
            const fast = mapDisplaySpecs(flat as Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>);
            if (fast.length) applySpecs(fast);
          } catch {}

          // 2) getISQs (the bmcajax ISQ API — m.indiamart.com/api/bmcajax/addressbook/getISQs, {mcatId})
          //    is the AUTHORITATIVE source for the ISQ spec list (NOT for QT — qty/unit come from GetIsq
          //    above). It's slow (15-30s, sometimes hangs through our dev proxy), so we run it in the
          //    BACKGROUND and NEVER block on it: GetIsq SEEDS the page instantly, then whenever getISQs
          //    returns its specs we ADOPT them (it's the canonical/richer ISQ set the form is built on).
          //    If it hangs/empties, the GetIsq seed stands — so the page is never blank, never frozen.
          postJSON<{ RESPONSE?: { DATA?: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }> } }>(
            '/api/mimart/api/bmcajax/addressbook/getISQs',
            { mcatId },
            30000
          )
            .then((isq2Json) => {
              const isqSpecs = mapDisplaySpecs(isq2Json?.RESPONSE?.DATA ?? []);
              // getISQs is authoritative for ISQ → adopt its specs whenever it returns any (replacing the
              // GetIsq seed). User-entered values persist (form.dynamicSpecs is keyed by spec name).
              if (isqSpecs.length > 0) applySpecs(isqSpecs);
            })
            .catch(() => {});

          // 3) Product image (cosmetic) — non-blocking so a slow image API never delays the form.
          getJSON<Record<string, unknown> & { Response?: { Data?: unknown }; data?: unknown }>(
            `/api/imimg/index.php?r=postblenq/McatDtl&modid=MY&mcatid=${mcatId}`
          )
            .then((imgJson) => {
              const data = (imgJson?.Response?.Data ?? imgJson?.data ?? imgJson) as Record<string, unknown>;
              if (data && typeof data === 'object') {
                for (const key of Object.keys(data)) {
                  const val = data[key];
                  if (/img|image/i.test(key) && typeof val === 'string' && val.startsWith('http')) {
                    setProductImageUrl(val);
                    break;
                  }
                }
              }
            })
            .catch(() => {});

          committedMcatId.current = mcatId;
          setField('mcatId', mcatId);
          traceMark('mcat', { start: true, done: true, status: `resolved ${mcatId}` });
        } else if (mcatId && mcatId === committedMcatId.current) {
          // Same product re-committed — keep specs already loaded.
          fetchedSpecs = isqSpecsRef.current;
        }
        committedProduct.current = name;
        track('rfq_product_committed', { product: name, specs: fetchedSpecs.length });
      } catch (err) {
        console.error('MCAT fetch error', err);
        // The product-details lookup failed (network/gateway). Let the user
        // continue — specs just won't pre-load — but tell them why.
        toast.show('Couldn’t load product details. You can still continue.', 'warning');
      } finally {
        setSpecsLoading(false);
      }
      return { valid: true, specs: fetchedSpecs };
    },
    [setField, toast]
  );

  // ─── Voice ──────────────────────────────────────────────────────────────────
  const handleVoiceRecordingComplete = async (blob: Blob, _duration: number) => {
    setShowVoiceRecorder(false);
    setVoiceProcessing(true);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        if (!hasGeminiKey()) {
          toast.show('Add VITE_GEMINI_API_KEY in .env to enable voice extraction', 'warning');
          setVoiceProcessing(false);
          return;
        }
        const base64Audio = (reader.result as string).split(',')[1];
        try {
          const extracted = await voiceToSpecs(
            base64Audio,
            blob.type || 'audio/webm',
            form.productName,
            isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC)
          );

          // Assist mic: just drop the transcript into the Help box for review.
          if (voiceTarget === 'assist') {
            setAssistInput((prev) =>
              (prev ? `${prev} ${extracted.rawTranscript || ''}` : extracted.rawTranscript || '').trim()
            );
            setVoiceTarget('main');
            setVoiceProcessing(false);
            setAssistOpen(true);
            if (!extracted.rawTranscript) toast.show('Could not catch that — please try again', 'warning');
            return;
          }

          // Apply the extracted fields directly to the form.
          let applied = false;
          if (extracted.productName && !form.productName) {
            handleProductCommit(extracted.productName);
            applied = true;
          }
          if (extracted.quantity) {
            setField('quantity', String(extracted.quantity).replace(/[^0-9]/g, ''));
            setQtyCommitted(true); // T1/New-C: a spoken qty is an explicit commit → intent + planner re-run
            applied = true;
          }
          if (extracted.quantityUnit) {
            setField('unit', extracted.quantityUnit);
            setQtyCommitted(true);
            applied = true;
          }
          if (extracted.deliveryLocation) {
            setField('deliveryLocation', extracted.deliveryLocation);
            applied = true;
          }
          // Apply spoken LOGISTICS so the last page shows them pre-selected. These were the gap:
          // deliveryTimeline was extracted but never applied; payment/credit weren't extracted at
          // all — so "Mumbai, 10 days, credit 45 days" landed nowhere on the last page.
          if (extracted.deliveryTimeline) { setField('deliveryTimeline', extracted.deliveryTimeline); applied = true; }
          if (extracted.paymentTerms) { setField('paymentTerms', extracted.paymentTerms); applied = true; }
          if (extracted.creditPeriod) { setField('creditPeriod', extracted.creditPeriod); applied = true; }
          if (Array.isArray(extracted.customSpecs)) {
            for (const cs of extracted.customSpecs) if (cs?.fieldName && cs?.value) { setSpec(cs.fieldName, cs.value); applied = true; }
          }
          if (extracted.mappedSpecs) {
            // A7 / G7: route voice-mapped specs through applyAiSpec so a spoken value never
            // silently OVERWRITES a spec the buyer already picked by hand (manual-no-overwrite).
            for (const [k, v] of Object.entries(extracted.mappedSpecs)) {
              if (v && applyAiSpec(k, v)) applied = true;
            }
          }
          toast.show(
            applied ? 'Voice captured — details auto-filled' : 'Could not catch that — please try again',
            applied ? 'success' : 'warning'
          );
        } catch {
          toast.show('Voice processing failed — please try again', 'warning');
        } finally {
          setVoiceProcessing(false);
        }
      };
    } catch {
      setVoiceProcessing(false);
    }
  };

  // ─── Image / analysis helpers ────────────────────────────────────────────────
  const optionsMapOf = (specs: ISQSpec[]) =>
    specs.reduce<Record<string, string[]>>((acc, s) => {
      if (s.IM_SPEC_OPTIONS_DESC)
        acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean);
      return acc;
    }, {});

  // Shared spec-fill from an image (+ optional use-case text), against the given
  // spec list. Never overwrites manual picks; never changes the product name;
  // drops its result if the product changed while it was running.
  const runImageSpecFill = useCallback(
    async (base64: string, mime: string, productName: string, specs: ISQSpec[], application = '') => {
      if (!hasGeminiKey() || !base64) return 0;
      const token = ++analysisToken.current;
      const result = await analyzeImage(
        base64,
        mime,
        productName,
        specs.map((s) => s.IM_SPEC_MASTER_DESC),
        optionsMapOf(specs),
        application
      );
      if (token !== analysisToken.current) return 0; // stale — product changed
      const specNames = specs.map((s) => s.IM_SPEC_MASTER_DESC);
      const extras: string[] = [];
      let filled = 0;
      for (const [k, v] of Object.entries(result.specifications || {})) {
        if (!v) continue;
        const match = specNames.find((n) => n.toLowerCase() === k.toLowerCase());
        if (match) {
          if (applyAiSpec(match, v as string)) filled++;
        } else {
          extras.push(`${k}: ${v}`);
        }
      }
      for (const [k, v] of Object.entries(result.additionalSpecifications || {}))
        if (v) extras.push(`${k}: ${v}`);
      if (extras.length) {
        setForm((prev) => {
          const joined = extras.join(', ');
          const note = prev.requirementNotes && !prev.requirementNotes.includes(joined)
            ? `${prev.requirementNotes}; ${joined}`
            : joined;
          return { ...prev, requirementNotes: note };
        });
      }
      if (filled > 0) setAssistNudge((n) => n + filled);
      return filled;
    },
    [applyAiSpec]
  );

  // Upload policy:
  //  • Step 0  → identify the product (only if the name is empty); commit pulls specs.
  //  • Step 1  → run image spec-fill against the current category's specs.
  //  • Step 2  → attach/replace only (no LLM, never touches name or specs).
  const handleImageUpload = async (file: File) => {
    let prepared: { base64: string; mime: string; isPdf: boolean };
    try {
      prepared = await fileToAnalyzable(file);
    } catch {
      toast.show('Couldn’t read that file — please try another', 'warning');
      return;
    }
    setField('imageBase64', prepared.base64);
    setField('imageMimeType', prepared.mime);

    if (step === 2) {
      toast.show('Attached to your enquiry', 'success');
      return;
    }
    if (prepared.isPdf) {
      toast.show('PDF attached for suppliers', 'success');
      return; // image_url analysis is for images only
    }
    if (!hasGeminiKey()) return;

    setImageAnalyzing(true);
    try {
      if (step === 0) {
        // Identify only — never override a name the user already typed.
        if (!form.productName.trim()) {
          const token = ++analysisToken.current;
          const result = await analyzeImage(prepared.base64, prepared.mime, '', [], {});
          if (token === analysisToken.current && result.productName) {
            await handleProductCommit(result.productName); // commit re-fills from the image
          } else if (!result.productName) {
            toast.show('Couldn’t identify the product — please type it', 'warning');
          }
        } else {
          toast.show('Photo attached', 'success');
        }
      } else {
        // Step 1 — fill specs from the image against the current category.
        const filled = await runImageSpecFill(
          prepared.base64,
          prepared.mime,
          form.productName,
          isqSpecsRef.current
        );
        toast.show(
          filled > 0 ? `Filled ${filled} spec${filled > 1 ? 's' : ''} from your photo` : 'Photo attached',
          'success'
        );
      }
    } catch {
      toast.show('Image analysis failed — please try again', 'warning');
    } finally {
      setImageAnalyzing(false);
    }
  };

  // ─── Tier-1 Assist: infer specs from the buyer's use-case ────────────────────
  const handleAssistSubmit = async () => {
    const application = stripPII(assistInput.trim());
    if (!application) return;
    if (!hasGeminiKey()) {
      toast.show('AI assist needs the LLM key configured', 'warning');
      return;
    }
    // Save the use-case into the requirement notes (raw; summarised later).
    setForm((prev) => ({
      ...prev,
      requirementNotes:
        prev.requirementNotes && !prev.requirementNotes.includes(application)
          ? `${prev.requirementNotes}; ${application}`
          : prev.requirementNotes || application,
    }));
    setAssistLoading(true);
    try {
      let filled = 0;
      if (form.imageBase64 && !form.imageMimeType.includes('pdf')) {
        // Image + text together — one combined call against the current specs.
        filled = await runImageSpecFill(
          form.imageBase64,
          form.imageMimeType,
          form.productName,
          isqSpecs,
          application
        );
      } else {
        // Text only.
        const token = ++analysisToken.current;
        const specsWithOptions = optionsMapOf(isqSpecs);
        const { specs } = await inferSpecsFromApplication(
          form.productName,
          application,
          isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC),
          specsWithOptions
        );
        if (token === analysisToken.current) {
          const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
          for (const [k, sv] of Object.entries(specs || {})) {
            if (!sv?.value || sv.confidence < 75) continue; // #71a: confidence band (per-spec)
            const match = specNames.find((n) => n.toLowerCase() === k.toLowerCase());
            if (match && applyAiSpec(match, sv.value)) { filled++; cascadeConf.current[match] = sv.confidence; }
          }
          if (filled > 0) setAssistNudge((n) => n + filled);
        }
      }
      // Success → close the sheet and clear input.
      setAssistOpen(false);
      setAssistInput('');
      toast.show(
        filled > 0
          ? `Filled ${filled} spec${filled > 1 ? 's' : ''} from your input`
          : 'Saved your requirement — pick the specs that apply',
        'success'
      );
    } catch {
      // Keep the sheet open on error so the buyer can retry.
      toast.show('Couldn’t auto-fill — please pick the specs', 'warning');
    } finally {
      setAssistLoading(false);
    }
  };

  // ─── Tier-2: explain a single spec on demand ─────────────────────────────────
  const handleSpecHelp = async (specName: string, options: string[]) => {
    // Toggle closed if already shown.
    if (specHelp[specName] && !specHelp[specName].loading) {
      setSpecHelp((prev) => {
        const next = { ...prev };
        delete next[specName];
        return next;
      });
      return;
    }
    if (!hasGeminiKey()) {
      toast.show('AI help needs the LLM key configured', 'warning');
      return;
    }
    setSpecHelp((prev) => ({ ...prev, [specName]: { loading: true } }));
    try {
      const guide = await explainSpec(form.productName, specName, options, {
        quantity: form.quantity,
        unit: form.unit,
        filledSpecs: form.dynamicSpecs,
        application: [requirementContext(), form.requirementNotes].filter(Boolean).join(' '), // G5: intent-aware help
        twinContext: twinPromptContext(liveTwin()), // Twin everywhere (Phase 5a)
        // Use the buyer's own uploaded photo (never the API sample) for context.
        imageBase64: form.imageBase64,
        imageMimeType: form.imageMimeType,
      });
      setSpecHelp((prev) => ({ ...prev, [specName]: { guide } }));
    } catch {
      setSpecHelp((prev) => {
        const next = { ...prev };
        delete next[specName];
        return next;
      });
      toast.show('Couldn’t fetch help — please try again', 'warning');
    }
  };

  // ─── Navigation ─────────────────────────────────────────────────────────────
  const handleNext = async () => {
    if (step === 0) {
      if (!form.productName.trim()) {
        toast.show('Please enter a product name', 'warning');
        return;
      }
      // Quantity is only asked (and required) when the API provides quantity units.
      if (unitOptions.length > 0 && (!form.quantity.trim() || Number(form.quantity) <= 0)) {
        toast.show('Please enter a valid quantity (greater than 0)', 'warning');
        return;
      }
      // T1: pressing Continue COMMITS the qty (the buyer may have typed without blurring) — this
      // lets the intent effect fire on the final qty; the gate below then blocks this press until it shows.
      if (!qtyCommitted) setQtyCommitted(true);
      // #1: don't leave page 1 until the intent question has been TRIGGERED (shown) — the buyer
      // should see it (they may skip it). Only blocks while the derivation is genuinely in-flight;
      // releases on answer (requirementIntent set), Skip, or a failed/empty derivation (intentResolved).
      // INTENT ASK/CONFIRM/SKIP MATRIX (precedence, first match wins) — pinned by scripts/intentskiptest.mjs:
      //   repost → skip · explicit-purpose-in-product-text → skip · off-profile → ask · contradiction → ask
      //   · Twin confidence ≥80 → confirm · product implies intent → confirm · else (cold/new) → ask.
      // handleRepost + the Skip button set intentGateSkipped; deriveIntent decides ask-vs-confirm via confidence.
      // Intent comes FIRST — even for a category with NO ISQ specs (a committed valid product like
      // "cord"), so a vague/no-spec product still gets the clarifying question instead of skipping it.
      const productCommittedValid = committedValid.current && committedProduct.current === form.productName.trim();
      if (QUESTION_ENGINE && hasGeminiKey() && (isqSpecs.length > 0 || productCommittedValid) && qtyReady && !requirementIntent && !intentGateSkipped && !intentResolved.current) {
        toast.show('One quick question first — tell us the planned use', 'info');
        return;
      }
      setShowDropdown(false);
      let specs = isqSpecs;
      if (form.productName !== committedProduct.current) {
        const result = await handleProductCommit(form.productName);
        if (!result.valid) {
          toast.show('Please enter a valid product/service name', 'warning');
          return;
        }
        specs = result.specs;
      } else if (!committedValid.current) {
        toast.show('Please enter a valid product/service name', 'warning');
        return;
      }
      // ALWAYS go to the spec page for a valid product — even with 0 ISQ specs. The planner is
      // product-keyed (runs regardless of specs) and produces a clarifying question, so a vague
      // product like "cord" (no category match) still gets engaged on step 1 instead of being
      // silently skipped to logistics (the #1 "no planner question" / #3 "no spec page" bug).
      setStep(1);
      setShowAllSpecs(false);
      // Prefetch the plan + panel questions now, ready before the spec page.
      ensureReqPlan(specs);
      // If a photo is attached, read it against THIS category's specs now
      // (covers "added image first, then typed/changed the product").
      if (specs.length > 0 && form.imageBase64 && hasGeminiKey()) {
        setImageAnalyzing(true);
        runImageSpecFill(form.imageBase64, form.imageMimeType, form.productName, specs).finally(() =>
          setImageAnalyzing(false)
        );
      }
    } else if (step === 1) {
      // Single spec page now (top-3 + "more" expander), so always advance.
      enterStep2(isqSpecs);
    } else if (step === 2) {
      if (!form.contactName.trim()) {
        setContactOpen(true);
        toast.show('Please enter your name', 'warning');
        return;
      }
      if (!/^\d{10}$/.test(form.contactMobile)) {
        setContactOpen(true);
        toast.show('Please enter a valid 10-digit mobile number', 'warning');
        return;
      }
      setShowOTP(true);
    }
  };

  // Enter the final step (delivery + contact). Woven questions were already
  // prefetched on the way into the spec page; ensure once more for no-spec
  // categories that skip step 1 entirely.
  const enterStep2 = (specs: ISQSpec[]) => {
    setStep(2);
    ensureReqPlan(specs);
  };

  // ── P (Quick Re-post): the buyer tapped "Buy again" on a prior requirement card.
  // Commit the title (fetches the CURRENT ISQ schema), drift-map the prior spec answers
  // onto it (matches → prefilled chip; non-matches → custom spec with an "added from your
  // last order" badge), record History provenance + a recurring cadence, SKIP the intent
  // question (a re-order needs no "what's it for"), then fast-forward to the single Re-post
  // Review screen (the spec page, all specs revealed). The buyer reviews/edits and posts. ──
  const handleRepost = async (pr: PriorReq) => {
    setShowDropdown(false);
    track('rfq_repost_selected', { title: pr.title, specs: pr.specCount, recencyDays: pr.recencyDays ?? -1 });
    // 1) Commit the product — this fetches the live ISQ schema AND resets enrichedSpecs/manual/
    //    intent/qty (so we apply onto a clean slate). Everything below runs AFTER the reset.
    //    trusted:true — a re-post title is a genuine prior requirement, so skip the autosuggest gate.
    const result = await handleProductCommit(pr.title, { trusted: true });
    if (!result.valid) {
      toast.show('Couldn’t load that product just now — please type it', 'warning');
      return;
    }
    const currentNames = result.specs.map((s) => s.IM_SPEC_MASTER_DESC);
    // 1a) Carry the prior QTY + UNIT into the form (they live in pr.specs as "Quantity"/"Quantity Unit").
    //     A re-post must NOT re-derive or nudge them — it's a deliberate re-order quantity → freeze it
    //     (qtyCommitted=true so the T4 re-derive + T3 "just 1?" nudge never fire for a re-post).
    const qKey = Object.keys(pr.specs).find((k) => /^\s*quantity\s*$/i.test(k));
    const uKey = Object.keys(pr.specs).find((k) => /^\s*(?:quantity\s*unit|unit)\s*$/i.test(k));
    const priorQty = qKey ? String(pr.specs[qKey]).replace(/[^0-9.]/g, '') : '';
    const priorUnit = uKey ? String(pr.specs[uKey]).trim() : '';
    if (priorQty) { setField('quantity', priorQty); setQtyCommitted(true); }
    if (priorUnit) setField('unit', priorUnit);
    // 2) Drift-map prior specs → current schema (SKIPPING the qty/unit keys carried above). matched →
    //    applyAiSpec (editable, won't override a brand/preference field — VEKA gate still applies);
    //    unmatched → custom spec key.
    const used = new Set<string>();
    const enriched = new Set<string>();
    const meta: Record<string, { recencyDays?: number; custom: boolean }> = {};
    for (const [name, value] of Object.entries(pr.specs)) {
      if (!value || !value.trim() || name === qKey || name === uKey) continue;
      const m = matchPriorSpec(name, currentNames.filter((c) => !used.has(c)));
      if (m) {
        if (applyAiSpec(m, value, 'repost')) { used.add(m); enriched.add(m); meta[m] = { recencyDays: pr.recencyDays, custom: false }; }
      } else {
        // Drift: a spec the buyer cared about last time that this category's schema doesn't expose.
        setSpec(name, value);
        enriched.add(name);
        meta[name] = { recencyDays: pr.recencyDays, custom: true };
      }
    }
    setEnrichedSpecs((prev) => new Set([...prev, ...enriched]));
    setRepostMeta(meta);
    setRepostSource({ title: pr.title, recencyDays: pr.recencyDays });
    // 3) LOCK the spec order to the ISQ schema order so the planner can NEVER re-rank the re-posted
    //    specs — they stay exactly as the buyer left them last time ("specs as-is", no churn).
    setLockedSpecOrder(currentNames);
    // 3) Registry: a re-post IS a recurring/replenishment signal — record it with History provenance
    //    (beats AI guesses, below the current-session answer). Feeds requirementContext + Truth Table.
    coverage.current.record('cadence', 'Recurring — re-order (buy again)', 'History', 85);
    // 4) Skip the intent question — the buyer is re-ordering a known requirement, not stating a new use.
    setIntentGateSkipped(true);
    intentResolved.current = true;
    setRequirementIntent(null);
    // 5) Fast-forward to the single Re-post Review screen: the spec page with EVERY spec revealed.
    setShowAllSpecs(true);
    setStep(1);
    ensureReqPlan(result.specs);
    if (result.specs.length === 0) enterStep2(result.specs); // no-spec category → straight to review/delivery
  };

  // Generate the woven non-spec questions once per product/qty/role signature.
  // Stores ALL slots; the renderers split them (specs → inline on the spec page,
  // requirement/persona → top of the final step), so nothing is ever dropped.
  const ensureDynQuestions = (specs: ISQSpec[]) => {
    // EVERY early return must clear dynLoading — this is reached as ensureReqPlan's fallback (which
    // already set dynLoading=true), so a silent return here would hang the "Finding…" spinner forever
    // (seen on 0-spec / off-profile products once they started landing on the spec page).
    if (!QUESTION_ENGINE || !hasGeminiKey()) { setDynLoading(false); return; }
    const segment = classifySegment({
      productName: form.productName,
      mcatType: form.mcatType,
      buyerType: form.buyerType,
      quantity: Number(form.quantity) || 0,
      hasUnits: unitOptions.length > 0,
    });
    const sig = `${form.productName}|${segment}|${form.quantity}|${form.buyerType}`;
    if (dynGenSig.current === sig) { setDynLoading(false); return; } // already generated for this context
    dynGenSig.current = sig;
    const depth = DEPTH_BY_SEGMENT[segment];
    if (depth.maxQuestions === 0) {
      setDynQuestions([]);
      setDynLoading(false);
      return;
    }
    setDynLoading(true);
    // Tell the generator what the form already covers, so it never duplicates.
    const formAlreadyHas = [
      'Delivery Timeline', 'Payment Mode', 'Payment Terms', 'Preferred Supplier Type',
      'Delivery City', 'Industry', 'Company Size', 'GST', 'Purchase Frequency', 'Role',
    ];
    // Pass every spec WITH its options so the generator never re-asks a spec or an
    // attribute already covered by an option (e.g. "noise" when "Silent" is an option).
    const isqSpecsWithOptions = specs.reduce<Record<string, string[]>>((acc, s) => {
      acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC
        ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean)
        : [];
      return acc;
    }, {});
    const genInputs = `product="${form.productName}" · segment=${segment} · qty=${form.quantity || '?'} ${form.unit || ''} · ISQ(${specs.length})=[${specs.map((s) => s.IM_SPEC_MASTER_DESC).join(', ')}] · maxQ=${depth.maxQuestions}`;
    logPrompt({
      prompt: 'generateEnrichmentQuestions (fallback)',
      model: 'gemini-2.5-flash-lite',
      purpose: 'flat non-spec question generation (planner unavailable)',
      inputs: genInputs,
    });
    generateEnrichmentQuestions({
      productName: form.productName,
      segment,
      quantity: form.quantity,
      unit: form.unit,
      specsChosen: form.dynamicSpecs,
      isqSpecNames: specs.map((s) => s.IM_SPEC_MASTER_DESC),
      isqSpecsWithOptions,
      coveredElsewhere: formAlreadyHas,
      seed: SEED_QUESTIONS,
      maxQuestions: depth.maxQuestions,
      askPersona: depth.askPersona,
      askBusiness: false, // business/PII lives on the last step
    })
      .then((qs) => setDynQuestions(qs.map((q) => ({ ...q, genBy: 'generator' as const, genInputs }))))
      .catch(() => {
        setDynQuestions([]);
        dynGenSig.current = ''; // allow a retry on the next entry
      })
      .finally(() => setDynLoading(false));
  };

  // Intent Planner — SHADOW. Runs once per product; result is inspected (debug),
  // not yet used to drive order/triage/placement.
  // PRIMARY generation path: the Intent Planner reads the category, decides the
  // shape, and drives the panel questions + spec triage. If it fails, we fall
  // back to the flat generator (ensureDynQuestions).
  const ensureReqPlan = (specs: ISQSpec[]) => {
    if (!QUESTION_ENGINE || !hasGeminiKey() || !form.productName) return;
    // P0 TIMING GATE — the planner must CONSUME category intel, so defer planRequirement until its
    // inputs are ready (buyer hydrated · mcat resolved · category hit/error/time-boxed). Fresh/debug
    // waits for the live build; prod releases at the ~2.5s box and re-plans when category lands (sig
    // carries category below). This is the fix for "planner ran before category." Never deadlocks.
    const gNow = gateSourcesNow();
    if (!plannerInputsReady(gNow)) return;
    moduleTrace.current.planner = {}; // reflect the LATEST plan run (re-plans when category lands → start moves after category.done)
    traceMark('planner', { start: true, waited: `buyer ${gNow.buyerReady ? '✓' : '…'} · mcat ${gNow.mcatResolved ? '✓' : '…'} · category ${gNow.categoryStatus}` });
    // Key the plan on the PRODUCT only. The plan describes the category's SELLING
    // SHAPE (archetype / lead / specOrder / personas), which is stable per product;
    // qty & unit are passed to the planner as soft context but populate a beat
    // apart on commit (the unit auto-selects after the product commits), so
    // including them re-fired the planner a second time for no benefit — a wasted
    // LLM call that also risked swapping the plan mid-view. Product-only keying
    // runs it exactly once. (On product change, planSig is reset to '' elsewhere.)
    // Re-plan once if the persistent buyer profile arrives after the first plan —
    // it's high signal (who the buyer is) and reshapes questions/personas/specs.
    // P5b: distil the Twin for the planner (fast-track / cold-discover / circuit-
    // breaker). Re-key the plan when a high-confidence (or off-profile) Twin arrives
    // so it re-plans ONCE with the buyer's known facts — that's the question cut.
    const tw = liveTwin();
    const twinBase = tw ? buildTwinPlanInput(tw, form.productName, coverage.current.isCovered) : undefined;
    // P5c: "Something changed" mutes the Twin for THIS session → reuse the
    // off-profile path (discovery: no fast-track, lead intent/scale, no cap).
    // A3 / G1: only treat as off-profile if the enrichment categories ALSO miss (the Twin's
    // history can omit a category enrichment has). twinMuted (a "Not you?" mute) still forces it.
    const twinForPlan = twinBase ? { ...twinBase, offProfile: (twinBase.offProfile && !matchCategory(enrichment, form.productName)) || twinMuted.current } : undefined;
    // P0.2: seed the FIRST plan with the page-1 intent so specs land already-shaped
    // (no jarring re-rank, no gear flash). The P6 re-rank stays as a fallback for buyers
    // who skip the page-1 intent and instead answer a wizard question later.
    const ri = requirementIntent;
    const intentApp = ri?.value ? `Buyer's stated purpose: ${(ri.question || 'Purpose').replace(/\s*\?+\s*$/, '')} = ${ri.value}.` : '';
    // A6 / G6: when qty is 1 on a NON-discrete (bulk/measure) unit, it's almost always a
    // placeholder the buyer didn't change — tell the planner to treat order size as uncertain
    // (so it doesn't size budget/scale chips off a phantom "1").
    const qtyNote = (Number(form.quantity) > 0 && Number(form.quantity) <= 1 && !!form.unit && !/piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i.test(form.unit))
      ? 'Note: the stated quantity (1) looks like an unset placeholder — treat the order size as UNCERTAIN.' : '';
    // A10: a one-off / single-unit order shapes the WHOLE plan — tell the planner so it asks
    // one-off-appropriate questions (no bulk-cadence / scale / budget interrogation for a single unit).
    const rmPlan = requirementMode();
    const rmNote = rmPlan.mode !== 'unknown' ? `CURRENT ORDER MODE = ${rmPlan.mode}: ${rmPlan.descriptor}. Ask only ${rmPlan.mode}-appropriate questions.` : '';
    const sig =
      form.productName.trim().toLowerCase() +
      (buyerProfile ? '|bpf' : '') +
      (page1Choice ? `|${page1Choice}` : '') + // re-plan when who's-buying changes (A4)
      (ri?.value ? `|i${ri.value.slice(0, 16).toLowerCase()}` : '') + // re-plan once when the intent lands
      `|rm${rmPlan.mode}|u${(form.unit || '').toLowerCase()}` + // T4: re-plan when the requirement-mode bucket or unit changes (qty 1→500, Piece→Tonne)
      (categoryStatus === 'hit' ? '|catH' : '') + // P0: re-plan ONCE when category intel lands → planner consumes criticals/seller-frequency
      (twinForPlan && (twinForPlan.confidence >= 60 || twinForPlan.offProfile) ? `|twin${Math.round(twinForPlan.confidence)}${twinForPlan.offProfile ? 'x' : ''}` : '');
    if (planSig.current === sig) return;
    planSig.current = sig;
    setDynLoading(true);
    // SAFETY NET: a hung planRequirement LLM call must never spin "Finding…" forever. If this plan
    // is still the pending one after ~14s, stop the spinner (the spec page then shows whatever specs
    // exist + lets the buyer proceed). Resolve/catch clears dynLoading first in the happy path.
    const thisSig = sig;
    setTimeout(() => { if (planSig.current === thisSig) setDynLoading(false); }, 14000);
    const isqSpecsWithOptions = specs.reduce<Record<string, string[]>>((acc, s) => {
      acc[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC
        ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean)
        : [];
      return acc;
    }, {});
    // Enrichment: if the buyer has history in this (or a related) category, prefill
    // the specs they already gave, and feed the planner that history.
    const matched = matchCategory(enrichment, form.productName);
    if (matched?.knownSpecs) {
      const specNames = specs.map((s) => s.IM_SPEC_MASTER_DESC);
      const applied: string[] = [];
      for (const [k, v] of Object.entries(matched.knownSpecs)) {
        const m = specNames.find((n) => n.toLowerCase() === k.toLowerCase());
        if (m && v && applyAiSpec(m, v)) applied.push(m);
      }
      if (applied.length) {
        setEnrichedSpecs((p) => new Set([...p, ...applied]));
        logPrompt({
          prompt: 'enrichment · matchCategory',
          model: '—',
          purpose: `prefilled ${applied.length} spec(s) from buyer history (matched "${matched.mcat}")`,
          inputs: `glid=${enrichment?.glid || glidInput} · knownSpecs=${JSON.stringify(matched.knownSpecs)}`,
        });
      }
    }
    // Build a compact signature of EVERYTHING fed to the planner — debug shows
    // this verbatim so HOD can see what shaped the plan (and every question).
    const specNamesAll = Object.keys(isqSpecsWithOptions);
    // catCriticals(N) = category criticals + common-followups fed to the planner as sellerQuestions.
    // The proof of consumption ChatGPT asked for: N>0 ⇒ category reached the planner (was sellerQs(0)).
    const catN = categorySellerQs().length;
    const priorBlk = matched
      ? `prior{persona=${enrichment?.persona?.type || enrichment?.buyer?.customerType || '?'}, knownSpecs(${Object.keys(matched.knownSpecs || {}).length}), sellerQs(${(matched.sellerQuestions || []).length}), catCriticals(${catN}), isqAns(${Object.keys(matched.isqAnswers || {}).length})}`
      : `no-history · catCriticals(${catN})`;
    const bpfBlk = buyerProfile
      ? `buyerProfile{${[buyerProfile.persona, buyerProfile.localityPreference, buyerProfile.engagement, buyerProfile.multiSku ? 'multi-SKU' : '', buyerProfile.sourcingStyle].filter(Boolean).join(', ')}}`
      : 'no-buyer-profile';
    const twinBlk = twinForPlan
      ? `twin{conf=${twinForPlan.confidence}, off=${twinForPlan.offProfile}, known=[${twinForPlan.known || 'none'}], unknowns=${twinForPlan.unknowns.length}}`
      : 'no-twin';
    const planInputs = `product="${form.productName}" · mcatType=${form.mcatType || '?'} · qty=${form.quantity || '?'} ${form.unit || ''} · application="${form.requirementNotes || ''}" · ISQ(${specNamesAll.length})=[${specNamesAll.join(', ')}] · ${priorBlk} · ${bpfBlk} · ${twinBlk}`;
    setPlanTrace(planInputs);
    logPrompt({
      prompt: 'planRequirement',
      model: 'gemini-2.5-flash-lite',
      purpose: 'decide RFQ shape — archetype, lead, specOrder, personas, panel questions',
      inputs: planInputs,
    });
    planRequirement({
      productName: form.productName,
      mcatType: form.mcatType,
      quantity: form.quantity,
      unit: form.unit,
      // RC: the planner consumes the SAME registry source-of-truth as cascade/refine/help/deduce —
      // intent + qty + mode lead, then the full active/confirmed registry block (do-not-re-ask).
      application: [intentApp, qtyNote, rmNote, form.requirementNotes || '', requirementContext()].filter(Boolean).join(' '),
      isqSpecsWithOptions,
      prior: (matched || categorySellerQs().length)
        ? {
            persona: enrichment?.persona?.type || enrichment?.buyer?.customerType,
            knownSpecs: matched?.knownSpecs,
            sellerQuestions: [...new Set([...(matched?.sellerQuestions || []), ...categorySellerQs()])],
            isqAnswers: matched?.isqAnswers,
          }
        : undefined,
      buyerProfile: buyerProfile || undefined,
      twin: twinForPlan,
      buyerKind: page1Choice === 'business' || page1Choice === 'personal' ? page1Choice : undefined,
      observedContext: observedExternalContext() || undefined, // Befisc/Sign3/identity as a SOFT signal
      buyerStory: buyerStoryRef.current ? `${buyerStoryRef.current.arc}${buyerStoryRef.current.story ? ' — ' + buyerStoryRef.current.story : ''}` : undefined, // P2.7 narrative arc (SOFT, never a hard fact)
      categoryDealBlockers: categoryConsumed.checks.map((c) => c.label), // v13 deal_blockers → proactively cover the top seller stall-point
      categoryApplications: categoryConsumed.applications,               // v13 intent_patterns → frame the intent question
      categoryBudgetBands: categoryConsumed.bands || undefined,          // v13 price → category-grounded budget options (no generic ₹ guesses)
      // Intelligence Consumption: of the transferable intelligence, which traits should DRIVE this product's
      // plan vs stay carried-but-quiet (a research-authority must not dominate a generic commodity).
      ...(() => { const c = consume(transferDecision().transfer, { archetype: reqPlan?.archetype, orderScale: classifyOrderScale(form.quantity, form.unit).band }); const pc = classifyProcurement({ nature: buyerProfile?.nature, authorityRole: buyerProfile?.authorityRole, journey: requirementIntent?.journey || undefined, intentText: requirementIntent?.value || undefined, orderScaleBand: classifyOrderScale(form.quantity, form.unit).band, requirementMode: requirementMode().mode }); return { intelligenceDrivers: formatDrivers(c.drivers) || undefined, intelligenceQuiet: c.quiet.map((q) => q.value).join(' · ') || undefined, procurementContext: pc.context !== 'unknown' ? `${pc.label} · GST ${pc.implications.gstLikely ? 'needed' : 'not needed'} · approval: ${pc.implications.approvalFlow}` : undefined }; })(),
    })
      .then((plan) => {
        traceMark('planner', { done: true, status: plan ? `planned (${categorySellerQs().length} category criticals)` : 'failed' });
        if (!plan) {
          // Planner failed → fall back to the flat generator.
          planSig.current = '';
          dynGenSig.current = '';
          ensureDynQuestions(specs);
          return;
        }
        setReqPlan(plan);
        (window as unknown as { __reqPlan?: RequirementPlan }).__reqPlan = plan;
        // P5b metric: how few questions did a known buyer get vs what was skipped.
        // why_fast_track / why_discovery — the signals that drove the mode (ChatGPT/
        // Gemini ask). Diagnostic: a low concierge accept-rate points at the trait here.
        const why = plan.twinMode === 'fast_track' ? (twinForPlan?.whyKnown ?? [])
          : plan.twinMode === 'off_profile' ? [twinMuted.current ? 'something_changed' : 'off_profile_product']
          : plan.twinMode === 'cold_discover' ? ['low_confidence', `conf=${twinForPlan?.confidence ?? 0}`]
          : (twinForPlan ? ['no_high_conf_facts'] : ['no_twin']);
        (window as unknown as { __twinWhy?: string[] }).__twinWhy = why;
        setQuestionBudget({
          asked: plan.questions.length,
          twinSkipped: plan.twinResolved?.length ?? 0,
          mode: plan.twinMode ?? 'none',
          tiers: plan.questions.map((q) => q.tier ?? '?').join(' → ') || '—',
          why,
        });
        // P5c: fast-track AND we actually have traits to confirm → gate the specs
        // behind the concierge card. Only flip from 'none' (never re-trigger after
        // the buyer has already answered Yes / Something-changed).
        const cTwin = liveTwin();
        const cTraits = cTwin ? conciergeTraits(cTwin) : [];
        // Never assert a stale persona when the CURRENT product is off-profile vs the
        // buyer's history (e.g. industrial-filtration buyer now asking for a gas tandoor)
        // — that's the discovery case; the planner already led with intent. Suppress concierge.
        // P0.3: the Twin confirmation is FOLDED into the page-1 intent note (renderPage1TwinNote)
        // — no separate "Welcome Back" screen on the spec step. We still log the impression
        // when confirmable traits exist (the note would have shown). Fast-track question-cutting
        // is unaffected: it lives in the planner (twinResolved), not in this gate.
        if (plan.twinMode === 'fast_track' && cTraits.length > 0 && !twinForPlan?.offProfile) {
          track('concierge_impression', { traits: cTraits.length, twin_confidence: cTwin?.twin_confidence?.overall_score ?? null, why });
        }
        // Tag each panel question with WHICH prompt produced it + WHAT was passed,
        // so debug can explain how/why it surfaced (HOD provenance ask).
        setDynQuestions(
          planToDynQuestions(plan).map((q) => ({ ...q, genBy: 'planner' as const, genInputs: planInputs }))
        );
        setDynLoading(false);
        track('rfq_req_plan', {
          product: form.productName,
          archetype: plan.archetype,
          orderMode: plan.orderMode,
          leadingQuestion: plan.leadingQuestion,
          mustHaveSpecs: plan.mustHaveSpecs,
          questionCount: plan.questions.length,
        });
      })
      .catch(() => {
        planSig.current = '';
        dynGenSig.current = '';
        ensureDynQuestions(specs); // fallback
      });
  };

  const handleBack = () => {
    if (step === 1) {
      setStep(0);
    } else if (step === 2) {
      // Step 1 now always exists for a valid product (even with 0 ISQ specs → planner questions),
      // so logistics → spec page → product.
      setStep(committedValid.current ? 1 : 0);
    }
  };

  // Demo "login" — in production this would open IndiaMART SSO and pull the
  // verified profile. Here it autofetches the saved contact details.
  const handleLogin = () => {
    setLoggedIn(true);
    setField('contactName', 'Rajesh Kumar');
    setField('contactMobile', '9876543210');
    setField('contactEmail', 'rajesh.kumar@example.com');
    setContactOpen(true);
    toast.show('Logged in — details autofetched', 'success');
  };

  // DEBUG: pull buyer history for a GLID and power the form from it.
  const handleGlidFetch = async (glidOverride?: string, ignoreTwinOverride?: boolean) => {
    const g = (glidOverride ?? glidInput).trim();
    if (!g) return;
    // When the landing auto-pulls, ignoreTwin state may not have flushed yet — honour the override.
    const skipTwin = ignoreTwinOverride ?? ignoreTwin;
    setEnrichLoading(true);
    traceMark('buyer', { start: true, status: 'pulling' });
    const t0 = performance.now();
    const { profile, raw } = await fetchEnrichment(g);
    const pullMs = Math.round(performance.now() - t0);
    setEnrichment(profile);
    setEnrichmentRaw(raw);
    setEnrichLoading(false);
    traceMark('buyer', { done: true, status: profile ? 'pulled' : 'empty' });
    // P0: snapshot webhook health + detect the buyer_profile sub-fetch auth-failure
    // (it can fail alone while the other 6 sources are fine).
    const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    // #11: the webhook delivers buyer_profile as a JSON *string* — parse it before any
    // profileMissing check, or `typeof !== 'object'` flags a real (mobile-bearing) record
    // as "auth-failed". (The Raw Dump's get() already parses, which is why it disagreed.)
    const bpv0raw = arr.find((x) => x && x.buyer_profile !== undefined)?.buyer_profile;
    let bp0u: unknown = Array.isArray(bpv0raw) ? bpv0raw[0] : bpv0raw;
    if (typeof bp0u === 'string') { try { bp0u = JSON.parse(bp0u); } catch { /* leave as string → treated as missing */ } }
    const bp0 = bp0u as Record<string, unknown> | undefined;
    const profileAuthFailed = !!bp0 && profileMissing(bp0);
    // Partial profile: a genuine record came back (not auth-failed) but identity is blank —
    // only a mobile, no name/company. Distinct from a true auth failure (an empty wrapper).
    const profilePartial = !!bp0 && !profileAuthFailed && !profileVal(bp0, ['company_name', 'first_name', 'ceo_fname']);
    setPull({ glid: g, ok: !!profile, records: arr.length, ms: pullMs, profileAuthFailed, profilePartial, twinMs: null });
    (window as unknown as { __enrichment?: unknown }).__enrichment = { profile, raw };
    if (profile) {
      track('rfq_enrichment', { glid: g, categories: profile.categories?.length || 0, persona: profile.persona?.type });
      toast.show('Buyer history pulled — prefilling what we know', 'success');
      // ── E: External world pull — Befisc/Sign3 identity + confidence-gated OSINT. ──
      // Debug-only, NON-BLOCKING, additive. The OSINT web step runs ONLY on a strong anchor
      // (company/GST/website) — never a bare mobile — so no bogus data is returned. Befisc/Sign3
      // run live once Part C creds land (env); until then each reports 'creds_pending'. The web
      // search is performed by an injected provider (window.__osintProvider — Claude/WebSearch in
      // the demo, a backend in prod). Observed Befisc/Sign3 identity NEVER feeds the Twin/registry.
      {
        const seed: ExternalSeed = {
          mobile: profile.buyer?.mobile,
          companyName: profile.buyer?.companyName,
          gstin: profile.buyer?.gst,       // strong unique anchors from the profile, when present
          udyam: profile.buyer?.udyam,
          website: profile.buyer?.website,
          name: profile.buyer?.fullName || profile.buyer?.firstName,
          city: profile.buyer?.city || profile.cslCity,
          industry: (form.productName || '').trim() || undefined, // product = a disambiguating anchor (empty at cold pull)
          glid: g,
        };
        const osintFn = async (sd: ExternalSeed): Promise<WorldOsint> => {
          const p = (window as unknown as { __osintProvider?: (s: ExternalSeed) => Promise<WorldOsint> }).__osintProvider;
          // Default = REAL Firecrawl web search (proxied; key server-side). A wired window.__osintProvider overrides.
          return typeof p === 'function' ? await p(sd) : await firecrawlOsint(sd);
        };
        runExternal(seed, { nowIso: new Date().toISOString(), osintFn })
          .then((res) => {
            setExternal(res);
            const w = window as unknown as { __ebi?: unknown; __externalSeed?: unknown };
            w.__ebi = { externalEvidenceLedger: res.externalEvidenceLedger, sources: res.sources, gate: res.gate, ran_at: res.ranAt, crossValidation: res.crossValidation };
            w.__externalSeed = seed;
          })
          .catch(() => {});
      }
      // ── P1 CUTOVER (flag VITE_EXTRACT_PROFILE) — consume the LLM-native extract twin (no regex/digest). On a
      //    settled twin, set profile+twin from the P0-verified adapter and SKIP the two legacy derive blocks below.
      //    On miss/timeout, resolveExtractTwin → null and the legacy path stands. Default OFF ⇒ byte-for-byte legacy. ──
      if (EXTRACT_TWIN_ON && hasGeminiKey() && !skipTwin) {
        const tw0e = performance.now();
        resolveExtractTwin(g, {
          glid: g, nowIso: new Date().toISOString(),
          identity: { city: profile.buyer?.city || '', state: profile.buyer?.state || '', language: profile.buyer?.primaryLanguage || '', verified: !!profile.buyer?.verifiedBusiness, companyDesc: profile.companyDesc || null },
          counts: profile.evidenceBase || { pns_calls: 0, whatsapp_events: 0, bls_created: 0, csl_events: 0 },
          historicalCategories: [...new Set((profile.categories || []).map((cat) => cat.mcat).filter(Boolean))],
          intentHistory: profile.intentHistory || {},
          lastSignalAt: lastSignalAt(profile.signals),
          email: profile.buyer?.email, designation: profile.buyer?.designation, companyName: profile.buyer?.companyName,
        }).then((ex) => {
          if (!ex) return; // miss/timeout → legacy below already ran (gated only by flag, see note) — twin stays from eager merged
          setBuyerProfile(ex.profile); (window as unknown as { __buyerProfile?: unknown }).__buyerProfile = ex.profile;
          setBuyerTwin(ex.twin); (window as unknown as { __buyerTwin?: unknown }).__buyerTwin = ex.twin;
          try { const raw = localStorage.getItem(`rfq_obs_${g}`); setPriorObserved(raw ? (JSON.parse(raw) as ObservedSessionBehavior) : null); } catch { setPriorObserved(null); }
          setPull((p) => (p ? { ...p, twinMs: Math.round(performance.now() - tw0e) } : p));
          track('rfq_buyer_twin', { glid: g, score: ex.twin.twin_confidence.overall_score, via: 'extract' });
        }).catch(() => {});
      }
      // Derive the PERSISTENT behavioural profile (compounds across requirements).
      if (!EXTRACT_TWIN_ON && profile.digest && hasGeminiKey() && !skipTwin) {
        // P0 Nature engine (Tier-2 structural inference): classify the email domain — a first-party
        // signal we already hold — and FEED it to the profile LLM so it stops mislabeling (an
        // iitk.ac.in academic was tagged "Manufacturer"). Anti-hallucination: institution-type only.
        const emailNature = classifyEmailDomain(profile.buyer?.email, profile.buyer?.companyName);
        // P1 Authority engine (Tier-2 structural): classify the buyer's DESIGNATION — a first-party
        // signal — into a buying-process role. Evidence-gated, anti-hallucination (a "Professor" is a
        // Researcher, never auto a Decision-Maker). Feeds the same LLM hint + a deterministic stamp.
        const authority = classifyDesignation(profile.buyer?.designation);
        const natureHint = natureDrives(emailNature)
          ? `[STRUCTURAL SIGNAL — email domain] This buyer's email domain indicates: ${emailNature.value} (high confidence; ${emailNature.evidence[0]}). Factor this into persona/business_type: an Academic / Government / Institutional buyer is RESEARCH / INSTITUTIONAL procurement — NOT a manufacturer / trader / reseller. Do NOT invent a person's role (e.g. professor / CEO) — only the institution type is evidenced.\n\n`
          : '';
        const authorityHint = authorityDrives(authority)
          ? `[STRUCTURAL SIGNAL — designation] The buyer's job title indicates ${authorityPlannerHint(authority)} (${authority.evidence[0]}). Use it for persona/decisionStyle — but only what the TITLE proves; do NOT invent budget authority a title does not carry.\n\n`
          : '';
        logPrompt({
          prompt: 'deriveBuyerProfile',
          model: 'gemini-2.5-flash-lite',
          purpose: 'persistent buyer profile (persona/maturity/style/engagement) from history digest + email-domain nature + designation authority',
          inputs: `glid=${g} · digest(${profile.digest.length} chars) · emailNature=${emailNature.institutionType} · authority=${authority.authorityRole}`,
        });
        deriveBuyerProfile(natureHint + authorityHint + profile.digest)
          .then((bpf) => {
            // Stamp the DETERMINISTIC, evidence-gated Nature (authoritative over the LLM guess for
            // academic/gov/corporate domains). Generic/unknown → leave the LLM's persona untouched.
            if (natureDrives(emailNature)) { bpf.nature = emailNature.value; bpf.natureConfidence = emailNature.confidence; bpf.natureEvidence = emailNature.evidence; }
            // Stamp the DETERMINISTIC, evidence-gated Authority (role from designation).
            if (authorityDrives(authority)) { bpf.authority = authority.value; bpf.authorityRole = authority.authorityRole; bpf.authorityConfidence = authority.confidence; bpf.authorityEvidence = authority.evidence; }
            setBuyerProfile(bpf);
            (window as unknown as { __buyerProfile?: unknown }).__buyerProfile = bpf;
            track('rfq_buyer_profile', { glid: g, persona: bpf.persona, nature: bpf.nature || null, authority: bpf.authority || null, procurementModel: bpf.procurementModel || null, confidence: bpf.confidence });
          })
          .catch(() => {});
      }
      // ── BTE-v1.1 Heavy pass: compile the Buyer Twin (Phase 1, additive). ──
      // Evidence-grounded; stored on window for the Phase-2 debug view + verification.
      if (!EXTRACT_TWIN_ON && profile.signals?.length && hasGeminiKey() && !skipTwin) {
        logPrompt({
          prompt: 'deriveBuyerTwin',
          model: 'gemini-2.5-flash-lite',
          purpose: 'compile persistent Buyer Twin (BTE-v1.1) with evidence ledgers',
          inputs: `glid=${g} · signals(${profile.signals.length}) · evidence=${JSON.stringify(profile.evidenceBase || {})}`,
        });
        const tw0 = performance.now();
        deriveBuyerTwin({
          glid: g,
          nowIso: new Date().toISOString(),
          identity: {
            city: profile.buyer?.city || '',
            state: profile.buyer?.state || '',
            language: profile.buyer?.primaryLanguage || '',
            verified: !!profile.buyer?.verifiedBusiness,
            companyDesc: profile.companyDesc || null,
          },
          signals: profile.signals,
          counts: profile.evidenceBase || { pns_calls: 0, whatsapp_events: 0, bls_created: 0, csl_events: 0 },
          historicalCategories: [...new Set((profile.categories || []).map((cat) => cat.mcat).filter(Boolean))],
          intentHistory: profile.intentHistory || {},
        })
          .then((twin) => {
            // P0 IDENTITY HIERARCHY (Nature > Identity > Business Type > Behaviour): a high-confidence,
            // evidence-gated Academic/Government Nature OUTRANKS the LLM-guessed business_type. An
            // iitk.ac.in buyer is a Research Institution, NOT a "Manufacturer" — overriding it HERE, at the
            // single Twin source, propagates the correct identity to EVERY consumer at once: the planner's
            // `known`, the transfer + consumption engines, canonicalBuyerType, the buyer-type nudge, and the
            // seller-facing context. (Corporate/generic Nature returns '' → a real manufacturer is untouched.)
            const instRole = institutionalRole(classifyEmailDomain(profile.buyer?.email, profile.buyer?.companyName), classifyDesignation(profile.buyer?.designation).authorityRole);
            if (instRole && twin.layer_a_identity) twin.layer_a_identity.business_type = instRole;
            setBuyerTwin(twin);
            (window as unknown as { __buyerTwin?: unknown }).__buyerTwin = twin;
            // BTE-v1.3: load behaviour OBSERVED in this GLID's past RFQ sessions so the read
            // compounds (stability grows when the same behaviour recurs). Client-side pilot
            // store — the production path is the lead store (saveSubmission) round-tripping it.
            try { const raw = localStorage.getItem(`rfq_obs_${g}`); setPriorObserved(raw ? (JSON.parse(raw) as ObservedSessionBehavior) : null); } catch { setPriorObserved(null); }
            setPull((p) => (p ? { ...p, twinMs: Math.round(performance.now() - tw0) } : p));
            track('rfq_buyer_twin', { glid: g, score: twin.twin_confidence.overall_score });
          })
          .catch(() => {});
      }
    } else {
      toast.show('No history found for that GLID', 'warning');
    }
  };

  // Step-0 (landing) staged a GLID + opened Smart with autoPull → run the EXISTING pull once here,
  // on mount. The trigger moved to the landing; the pull + downstream flow are byte-identical. We
  // seed glidInput/ignoreTwin for the flow AND pass them as overrides so the pull never reads stale state.
  const autoPulledRef = useRef(false);
  useEffect(() => {
    const g = (initialGlid || '').trim();
    if (autoPull && !autoPulledRef.current && g) {
      autoPulledRef.current = true;
      setGlidInput(g);
      if (initialIgnoreTwin) setIgnoreTwin(true);
      handleGlidFetch(g, !!initialIgnoreTwin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire the OBSERVED external footprint (Befisc identity + Sign3 + World) ONTO the Buyer Twin — so
  // the buyer model carries it. OBSERVED-only: shown on the Twin, NEVER fed to the planner/registry
  // (the external bridge already takes only Tier-1 Verified GST/HSN; Befisc/Sign3 are tier 'observed').
  // Merged once per external run; the ranAt ref-guard prevents the setBuyerTwin→re-render loop.
  const extMergedRef = useRef('');
  useEffect(() => {
    if (!external || !buyerTwin) return;
    if (extMergedRef.current === external.ranAt) return;
    extMergedRef.current = external.ranAt;
    const obs = buildObservedExternal(external);
    if (obs) {
      setBuyerTwin((t) => (t ? { ...t, observed_external: obs } : t));
      (window as unknown as { __buyerTwin?: unknown }).__buyerTwin = { ...buyerTwin, observed_external: obs };
    }
  }, [external, buyerTwin]);

  // Prefill PII from the buyer profile (no overwrite of anything typed).
  useEffect(() => {
    const b = enrichment?.buyer;
    if (!b) return;
    setForm((prev) => ({
      ...prev,
      contactName: prev.contactName || b.fullName || b.firstName || '',
      contactMobile: prev.contactMobile || (b.mobile && /^\d{10}$/.test(b.mobile) ? b.mobile : prev.contactMobile),
      contactEmail: prev.contactEmail || b.email || '',
      additionalDetails: prev.additionalDetails || b.companyName || '',
      // N3: fall back to the buyer's CSL browse-city when the profile carries no city, so we
      // seed a real location (e.g. Jaipur/Kanpur) instead of letting an IP/geo default
      // (the test machine's city) win. Profile city always takes precedence.
      clientLocation: prev.clientLocation || b.city || enrichment?.cslCity || '',
      deliveryLocation: prev.deliveryLocation || [b.city, b.state].filter(Boolean).join(', ') || enrichment?.cslCity || '',
      // Verified business buyer ⇒ almost certainly GST-registered → pre-fill (editable).
      gstRegistered: b.verifiedBusiness ? true : prev.gstRegistered, // verified→Yes; else keep UNKNOWN (never force false)
    }));
    setLoggedIn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrichment]);

  // Browser geolocation → city (reverse-geocoded). Works on Chrome & Safari with
  // user permission; falls back to the IP-detected city if denied/unavailable.
  const fetchMyLocation = () => {
    const applyCity = (label: string) => {
      if (!label) return;
      setField('clientLocation', label);
      setForm((prev) => (prev.deliveryLocation ? prev : { ...prev, deliveryLocation: label }));
    };
    if (!('geolocation' in navigator)) {
      if (detectedLocation) applyCity(detectedLocation);
      else toast.show('Location not available on this device', 'warning');
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const r = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
          );
          const d = await r.json();
          const city = d.city || d.locality || d.principalSubdivision || '';
          const region = d.principalSubdivision && d.principalSubdivision !== city ? `, ${d.principalSubdivision}` : '';
          applyCity(city ? `${city}${region}` : detectedLocation);
        } catch {
          applyCity(detectedLocation);
        } finally {
          setGeoLoading(false);
        }
      },
      () => {
        setGeoLoading(false);
        if (detectedLocation) applyCity(detectedLocation);
        else toast.show('Couldn’t get location — please type your city', 'warning');
      },
      { timeout: 8000, maximumAge: 600000 }
    );
  };

  // Desktop hover-intent for the score module (keeps open while over the panel).
  const openScoreHover = () => {
    if (!canHover.current) return;
    if (scoreHoverTimer.current) clearTimeout(scoreHoverTimer.current);
    scoreHoverTimer.current = setTimeout(() => {
      setLocationEditing(false);
      setScoreOpen(true);
    }, 120);
  };
  const scheduleCloseScore = () => {
    if (!canHover.current) return;
    if (scoreHoverTimer.current) clearTimeout(scoreHoverTimer.current);
    scoreHoverTimer.current = setTimeout(() => setScoreOpen(false), 200);
  };
  const cancelCloseScore = () => {
    if (scoreHoverTimer.current) clearTimeout(scoreHoverTimer.current);
  };

  const handleClose = () => {
    // Exit-intent from the spec step: send them to the last step (only name +
    // mobile needed) and surface the "almost there" helper, instead of losing it.
    if (step === 1 && !exitIntentUsed.current) {
      exitIntentUsed.current = true;
      setStep(2);
      setContactOpen(true);
      setMissingPromptShown(true);
      toast.show('Almost there — just your contact to get quotes', 'info');
      return;
    }
    // On the last step, the first close attempt reveals what's still missing
    // rather than closing outright.
    if (step === 2) {
      const stillMissing =
        !form.deliveryTimeline || !form.paymentTerms || !form.buyerType;
      if (stillMissing && !missingPromptShown) {
        setMissingPromptShown(true);
        return;
      }
    }
    if (form.productName && step > 0) {
      if (window.confirm('Leave this form? Your progress will be lost.')) {
        onClose();
      }
    } else {
      onClose();
    }
  };

  // Build the clean, PII-free requirement line for suppliers. Folds the buyer's
  // notes + every woven answer into one professional sentence (LLM when
  // available), then strips any contact info regardless. Never throws.
  const finalizeRequirement = async (): Promise<string> => {
    const notes = form.requirementNotes.trim();
    const dynText = dynQuestions
      .filter((q) => dynAnswers[q.id])
      .map((q) => `${q.label.replace(/\?$/, '')}: ${dynAnswers[q.id]}`)
      .join('; ');
    const combined = [notes, dynText].filter(Boolean).join('. ');
    if (!combined) return '';
    if (!hasGeminiKey()) return stripPII(combined);
    try {
      const specsText = Object.entries(form.dynamicSpecs)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const s = await summarizeRequirement(form.productName, combined, specsText);
      return stripPII(s || combined);
    } catch {
      return stripPII(combined);
    }
  };

  const handleOTPVerified = async (verifiedName: string, verifiedMobile: string) => {
    const requirementForSuppliers = await finalizeRequirement();
    localDB.saveSubmission({
      product: form.productName,
      quantity: form.quantity,
      unit: form.unit,
      delivery_location: form.deliveryLocation,
      delivery_timeline: form.deliveryTimeline,
      payment_terms: form.paymentTerms,
      payment_mode: form.paymentMode,
      buyer_type: form.buyerType,
      industry: form.industry,
      additional_details: form.additionalDetails,
      requirement_notes: requirementForSuppliers,
      product_specifications: JSON.stringify(form.dynamicSpecs),
      enrichment_answers: JSON.stringify(dynAnswers),
      contact_mobile: verifiedMobile,
      contact_name: verifiedName,
      contact_email: form.contactEmail,
      rfq_score: scoreDetails.total,
      funnel_variant: variantLabel ?? 'V3',
      // ── Buyer intelligence travels WITH the lead — nothing is lost. ──
      // PII preserved as-is (debug stance), plus the persistent behavioural profile
      // that compounds across this buyer's future requirements.
      buyer_glid: enrichment?.glid || glidInput || '',
      buyer_pii: enrichment?.buyer ? JSON.stringify(enrichment.buyer) : '',
      buyer_persona_signals: enrichment?.persona ? JSON.stringify(enrichment.persona) : '',
      buyer_profile_derived: buyerProfile ? JSON.stringify(buyerProfile) : '',
      buyer_history_categories: JSON.stringify((enrichment?.categories || []).map((c) => c.mcat)),
      buyer_deduced_logistics: JSON.stringify(deducedLogistics),
      // BTE-v1.3 — the OBSERVED in-session behaviour travels with the lead so it compounds.
      buyer_observed_behavior: JSON.stringify(observedBehavior),
      // OBSERVED external footprint (Befisc identity + Sign3 + World) travels with the lead too.
      buyer_observed_external: buyerTwin?.observed_external ? JSON.stringify(buyerTwin.observed_external) : '',
      // P3 — the composite identity resolution (anchors + agreement/conflict + confidence).
      buyer_identity: identity ? JSON.stringify(identity) : '',
      // P4 — the cross-source agreement ladder (which facts corroborated → graduated to Verified).
      buyer_external_crossval: external?.crossValidation ? JSON.stringify(external.crossValidation) : '',
      // P1.1 — the coverage system-of-record (every confirmed fact, incl. resolved contradiction nudges:
      // supplier radius / approval / installation / PO) travels with the lead so sellers + the next
      // session inherit the buyer's own answers, not just our guesses.
      buyer_coverage_facts: JSON.stringify(coverage.current.facts()),
    });
    // BTE-v1.3 — persist the observed behaviour per-GLID (client-side pilot store) so the NEXT
    // RFQ from this buyer starts already knowing how they behave. session_count grows each time.
    try {
      const g = enrichment?.glid || glidInput || '';
      if (g) localStorage.setItem(`rfq_obs_${g}`, JSON.stringify(observedBehavior));
    } catch { /* storage disabled — non-fatal */ }
    track('rfq_behavior_observed', {
      sessions: observedBehavior.session_count,
      spec_engagement: observedBehavior.spec_engagement?.value ?? null,
      flexibility: observedBehavior.flexibility?.value ?? null,
      question_engagement: observedBehavior.question_engagement?.value ?? null,
      urgency_posture: observedBehavior.urgency_posture?.value ?? null,
      commercial_posture: observedBehavior.commercial_posture?.value ?? null,
      independence: observedBehavior.independence?.value ?? null,
      fill_duration_ms: Math.round(performance.now() - sessionStartRef.current),
    });
    // ── Funnel close: the one event that answers most KPIs for this requirement ──
    track('rfq_completed', {
      product: form.productName,
      twin_mode: questionBudget?.mode ?? 'none',
      questions_asked: questionBudget?.asked ?? 0,
      twin_skipped: questionBudget?.twinSkipped ?? 0,
      concierge: conciergeState, // accepted | changed | none
      twin_confidence: buyerTwin?.twin_confidence?.overall_score ?? null,
      specs_total: isqSpecs.length,
      specs_filled: Object.values(form.dynamicSpecs).filter((v) => v && v.trim()).length,
      specs_autofilled: autoFilledSpecs.size,
      specs_cascade: cascadeSpecs.size,
      brand_blocked: gateDecisions.filter((d) => d.action === 'blocked_autofill').length,
      score: scoreDetails.total,
    });
    setShowOTP(false);
    setShowSuccess(true);
  };

  // Slim chip that opens the details wizard — shown on the spec page and the
  // last step. Reflects answered/total across all panel cards.
  const renderPanelChip = () => {
    if (panelItems.length === 0)
      return dynLoading ? (
        <p className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
          Finding a few quick things sellers ask…
        </p>
      ) : null;
    const done = panelAnswered >= panelTotal;
    return (
      <button
        type="button"
        onClick={openPanel}
        className="w-full flex items-center gap-2 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl px-3 py-2.5 text-left hover:from-amber-100 hover:to-orange-100 transition-colors"
      >
        <span className="text-amber-500 text-base shrink-0">✨</span>
        <span className="text-sm text-amber-800 flex-1">
          {panelAnswered > 0 ? (
            <><span className="font-semibold">{panelAnswered}/{panelTotal}</span> details added — sellers quote sharper</>
          ) : (
            <><span className="font-semibold">{panelTotal} quick thing{panelTotal > 1 ? 's' : ''}</span> sellers ask → sharper quotes, fewer calls</>
          )}
        </span>
        {done ? <CheckCircle2 size={16} className="text-green-600 shrink-0" /> : <ArrowRight size={15} className="text-amber-500 shrink-0" />}
      </button>
    );
  };

  // ─── Spec page renderer ──────────────────────────────────────────────────────
  // One spec field — chips/free-text + hint + "Not sure?" help.
  const renderSpecField = (spec: ISQSpec) => {
    const options = spec.IM_SPEC_OPTIONS_DESC
      ? spec.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean)
      : [];
    const currentVal = form.dynamicSpecs[spec.IM_SPEC_MASTER_DESC] || '';
    const hint = isqHints[spec.IM_SPEC_MASTER_DESC];
    const knownVal = knownFromProductName[spec.IM_SPEC_MASTER_DESC];
    const isSuggested = autoFilledSpecs.has(spec.IM_SPEC_MASTER_DESC);
    return (
      <div key={spec.IM_SPEC_MASTER_DESC} className="space-y-5">
        <div>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <p className="text-sm font-semibold text-gray-800">{spec.IM_SPEC_MASTER_DESC}</p>
          {repostMeta[spec.IM_SPEC_MASTER_DESC] ? (
            <span className="text-[10px] bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded-full">🔁 from last order</span>
          ) : (knownVal || isSuggested) && (
            <span className="text-[10px] bg-teal-50 text-teal-600 border border-teal-100 px-1.5 py-0.5 rounded-full">
              ✦ {isSuggested ? 'Suggested' : 'Detected'}
            </span>
          )}
          {debug && (() => {
            const n = spec.IM_SPEC_MASTER_DESC;
            // Source + WHICH prompt produced this value (data provenance).
            const [src, via] = manualSpecs.has(n)
              ? ['manual', 'buyer']
              : cascadeSpecs.has(n)
              ? [`cascade←${cascadeFrom || 'lead'}`, 'inferSpecsFromApplication·cascade']
              : enrichedSpecs.has(n)
              ? ['enriched(history)', 'enrichment·matchCategory']
              : autoFilledSpecs.has(n)
              ? ['AI-suggest', 'inferSpecsFromApplication·assist']
              : knownFromProductName[n]
              ? ['name-detect', 'getSpecHints']
              : ['API-ISQ', 'getISQs API'];
            const isLead = reqPlan?.lead?.source === 'spec' && reqPlan.lead.ref === n;
            const rank = (reqPlan?.specOrder || []).indexOf(n);
            const isPref = preferenceSpecs.has(n) || PREFERENCE_RE.test(n);
            return (
              <span className="text-[9px] font-mono px-1 rounded bg-gray-100 text-gray-500 break-all">
                {isPref ? '🔒 preference·no-autofill · ' : ''}{src} · via {via}{isLead ? ' · LEAD' : ''}{rank >= 0 ? ` · #${rank + 1}` : ''} · opts:{options.length ? `API(${options.length})` : 'free'}
              </span>
            );
          })()}
        </div>
        {debug && (() => {
          const n = spec.IM_SPEC_MASTER_DESC;
          const val = (form.dynamicSpecs[n] || '').trim();
          const p = fieldProvenance(n, val);
          const rank = (lockedSpecOrder ?? reqPlan?.specOrder ?? []).indexOf(n);
          const moved = specRankMoves[n];
          const specReason = reqPlan?.specReasons?.[n]; // P3 "gold": planner's WHY-HERE sentence
          return (
            <div className="text-[10px] mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-slate-50 border border-slate-100 rounded px-1.5 py-1">
              {rank >= 0 && <span className="text-purple-600 font-semibold">🤖 Ranked #{rank + 1}</span>}
              {moved && <span className="text-orange-600 font-semibold">🔄 moved #{moved.from + 1}→#{moved.to + 1}</span>}
              <span className="text-gray-600">{p.icon} {val ? `filled by ${p.src}` : p.src === 'Gate' ? 'blocked by Gate' : 'not filled'}</span>
              {val && p.conf != null && <span className={trustClass(p.trust)}>{p.trust} ({p.conf})</span>}
              {specReason && <span className="basis-full text-purple-500 italic">💡 Why here: {specReason}</span>}
              {val && p.evidence && <span className="basis-full text-gray-400 italic break-all">— {p.evidence}</span>}
            </div>
          );
        })()}
        {options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {options.map((opt) => (
              <RadioChip
                key={opt}
                label={opt}
                selected={currentVal === opt}
                onClick={() => markManualSpec(spec.IM_SPEC_MASTER_DESC, currentVal === opt ? '' : opt)}
              />
            ))}
            <OtherChip
              value={options.includes(currentVal) ? '' : currentVal}
              onChange={(v) => markManualSpec(spec.IM_SPEC_MASTER_DESC, v)}
            />
          </div>
        ) : (
          <input
            type="text"
            value={currentVal}
            onChange={(e) => markManualSpec(spec.IM_SPEC_MASTER_DESC, e.target.value)}
            placeholder={hint || `Enter ${spec.IM_SPEC_MASTER_DESC.toLowerCase()}`}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
          />
        )}
        {/* Bias gate: brand/preference fields are never pre-filled — nudge "open to
            all" so the buyer keeps the widest seller pool (more quotes). */}
        {!currentVal && (preferenceSpecs.has(spec.IM_SPEC_MASTER_DESC) || PREFERENCE_RE.test(spec.IM_SPEC_MASTER_DESC)) && (
          <p className="text-[11px] text-gray-400 mt-1">Leave blank = open to all brands → more quotes.</p>
        )}
        {!currentVal && (
          <div className="flex items-center gap-2 mt-1">
            {hint && (
              <p className="text-xs text-gray-400 flex-1 min-w-0 truncate">💡 {hint}</p>
            )}
            <button
              type="button"
              onClick={() => handleSpecHelp(spec.IM_SPEC_MASTER_DESC, options)}
              className="text-xs text-teal-600 hover:text-teal-700 font-medium shrink-0 ml-auto"
            >
              Not sure?
            </button>
          </div>
        )}
        {!currentVal && specHelp[spec.IM_SPEC_MASTER_DESC] && (
          <div className="mt-2 bg-teal-50 border border-teal-100 rounded-xl px-3 py-2.5">
            {specHelp[spec.IM_SPEC_MASTER_DESC].loading ? (
              <span className="flex items-center gap-2 text-xs text-teal-700">
                <span className="w-3.5 h-3.5 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                Thinking…
              </span>
            ) : (
              (() => {
                const guide = specHelp[spec.IM_SPEC_MASTER_DESC].guide;
                if (!guide) return null;
                return (
                  <>
                    {guide.intro && <p className="text-xs text-teal-800 mb-2">{guide.intro}</p>}
                    {guide.buckets?.length > 0 && (
                      <div className="space-y-1.5">
                        {guide.buckets.map((b, i) => (
                          <div key={i} className="flex items-baseline gap-2 text-xs">
                            <span className="font-semibold text-teal-800 shrink-0">{b.label}</span>
                            <span className="text-teal-700 flex-1 min-w-0">— {b.scenario}</span>
                            {b.likely && (
                              <span className="shrink-0 text-[9px] font-semibold text-teal-700 bg-white border border-teal-200 rounded-full px-1.5 py-0.5">
                                Likely for you
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {guide.note && (
                      <p className="text-[11px] text-teal-600 mt-2 italic">{guide.note}</p>
                    )}
                  </>
                );
              })()
            )}
          </div>
        )}
        </div>
      </div>
    );
  };

  // ─── Buyer Twin — seller-facing one-liner (NO PII) for "Your Requirement" ────
  // A2 / G3: ONE canonical buyer-type, used by the seller line, Truth Table, and debug, so
  // we never show "Manufacturer" in one place and a different role (or "Unknown") in another.
  // ── BTE-v1.3 — OBSERVED in-session behaviour ────────────────────────────────
  // Distil how the buyer is filling THIS RFQ into behavioural traits, then merge with what we
  // observed in their PAST sessions. This DESCRIBES the buyer (lowest in the hierarchy) — it
  // never originates or overrides the current requirement. PII-free; safe to share with sellers.
  const observedBehavior = useMemo<ObservedSessionBehavior>(() => {
    const answered = dynQuestions.filter((q) => dynAnswers[q.id]).length;
    // P0.2 SOURCE-AWARE PERSONA — behaviour reshapes ONLY from the buyer's own actions, never from
    // auto-filled values (the RFQ must not learn from itself: deduced Credit → "seeks credit terms"
    // was circular). A logistics field shapes commercial/urgency posture ONLY when it's a MANUAL pick
    // (or the buyer changed the deduced value); an auto-deduced value (≥0.8 and unchanged) is suppressed.
    const manualLogistics = (id: string, val: string): string => {
      const d = deducedLogistics[id];
      const autoFilled = !!d && (d.confidence ?? 0) >= 0.8 && val.trim() === String(d.value || '').trim();
      return autoFilled ? '' : val;
    };
    const current = distillSessionBehavior({
      specsFilledByUser: manualSpecs.size,
      specsAvailable: isqSpecs.length,
      specsOverridden: overriddenSpecs.size,
      specsRemoved: removedSpecs.size,
      personaQsAnswered: answered,
      personaQsSkipped: intentGateSkipped ? 1 : 0,
      deliveryTimeline: manualLogistics('deliveryTimeline', form.deliveryTimeline),
      paymentTerms: manualLogistics('paymentTerms', form.paymentTerms),
      observedAt: new Date().toISOString(),
    });
    return mergeObservedBehavior(priorObserved, current);
  }, [manualSpecs, isqSpecs.length, overriddenSpecs, removedSpecs, dynQuestions, dynAnswers, intentGateSkipped, form.deliveryTimeline, form.paymentTerms, deducedLogistics, priorObserved]);
  // P3 Identity Resolution (the "Dinesh mechanism") — stitch first-party anchors (name/mobile/company/
  // email/city/state) with any observed-external PAN into one composite identity + confidence score.
  // OBSERVED-only (it can fold in external PAN/GST): a confidence + dossier signal, NEVER a planner
  // spec-driver (locked rule). Recomputes when the profile or the external pull lands.
  const identity = useMemo<IdentityResolution | null>(() => {
    if (!enrichment?.buyer) return null;
    const b = enrichment.buyer;
    const bef = buyerTwin?.observed_external?.befisc;
    const res = resolveIdentity({
      name: b.fullName || [b.firstName, b.lastName].filter(Boolean).join(' '),
      altNames: [bef?.name].filter((x): x is string => !!x), // N6 — reconcile profile name vs Befisc name
      mobile: b.mobile,
      company: b.companyName,
      email: b.email,
      pan: bef?.pan,
      city: b.city || enrichment.cslCity,
      state: b.state,
    });
    (window as unknown as { __identity?: unknown }).__identity = res;
    return res;
  }, [enrichment, buyerTwin?.observed_external]);
  // Distil the OBSERVED external footprint (Befisc identity + Sign3 digital + composite identity) into
  // a SOFT planner signal — PII-light: entity / demographics / location / consumer-marketplace presence.
  // Per the user's directive we now FEED external into the planner CONTEXT (labelled observed, may be
  // stale, NEVER a hard/Verified fact). Highest value for a COLD buyer (no history) — it's the only
  // signal we have. Returns '' when nothing observed.
  const befiscState = (addr?: string): string => {
    const m = (addr || '').match(/\b(Andhra Pradesh|Arunachal Pradesh|Assam|Bihar|Chhattisgarh|Goa|Gujarat|Haryana|Himachal Pradesh|Jharkhand|Karnataka|Kerala|Madhya Pradesh|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|Odisha|Punjab|Rajasthan|Sikkim|Tamil Nadu|Telangana|Tripura|Uttar Pradesh|Uttarakhand|West Bengal|Delhi|Jammu|Ladakh|Puducherry|Chandigarh|Goa)\b/i);
    const pin = (addr || '').match(/\b\d{6}\b/);
    return [m ? m[1] : '', pin ? pin[0] : ''].filter(Boolean).join(' ');
  };
  // P2.7 — BUYER STORY: order the buyer's past categories into a timeline and infer the narrative arc
  // (setting up / expanding / replenishing / diversifying) via ONE flash-lite pass. A SOFT signal fed to
  // the planner — it explains an odd current product; it is never a hard fact. Derived once per
  // (buyer × current product); the ref keeps the value fresh for the planner closures.
  const trajectory = useMemo(() => orderTrajectory(enrichment?.categories || []), [enrichment]);
  useEffect(() => {
    if (!hasGeminiKey() || !hasStory(enrichment?.categories || []) || !form.productName.trim()) return;
    const sig = `${enrichment?.glid || ''}|${trajectory.map((t) => t.mcat).join('>')}|${form.productName.trim().toLowerCase()}`;
    if (buyerStorySig.current === sig) return;
    buyerStorySig.current = sig;
    logPrompt({ prompt: 'deriveBuyerStory', model: 'gemini-2.5-flash-lite', purpose: 'narrative arc from the category timeline', inputs: `timeline=[${trajectory.map((t) => t.mcat).join(' → ')}] · current="${form.productName}"` });
    deriveBuyerStory({ timeline: trajectory, currentProduct: form.productName })
      .then((s) => { if (s.arc || s.story) { setBuyerStory(s); buyerStoryRef.current = s; (window as unknown as { __buyerStory?: unknown }).__buyerStory = s; } })
      .catch(() => {});
  }, [enrichment, trajectory, form.productName, logPrompt]);

  // ─── Intelligence Transfer (the Buyer Memory decision) — replaces the BINARY off-profile mute ───
  // Tiers the buyer's compiled intelligence (A always · B usually · C if related · D never) and decides
  // what may carry to THIS requirement. Relatedness = the WIDER of the deterministic full-history lexical
  // overlap and the Buyer Story's SEMANTIC business-relatedness — and it gates ONLY Tier C, so an unrelated
  // product (Jaiveer → "Diesel Generator") still carries who-they-are + how-they-buy without leaking
  // "notebook inputs". For Jaiveer → "Paper" the story scores it a core input, so category intel carries too.
  const transferDecision = useCallback(() => {
    const tw = ignoreTwin ? null : liveTwin();
    const id = tw?.layer_a_identity;
    const histCats = [...new Set([
      ...((enrichment?.categories || []).map((c) => c.mcat).filter(Boolean) as string[]),
      ...(((tw?.layer_c_commercial_intelligence?.historical_categories) || []) as string[]),
    ])];
    const items = tierBuyerIntelligence({
      profile: buyerProfile,
      twinBusinessType: id?.business_type,
      region: id?.city || enrichment?.buyer?.city,
      language: id?.language,
      verified: !!id?.verified,
      entityType: identity?.entityType,
      historicalCategories: histCats,
      themes: twinThemes(),
      knownSpecs: matchCategory(enrichment, form.productName)?.knownSpecs,
    });
    const lexical = categoryRelatedness(form.productName, histCats, coreTokens);
    const semantic = buyerStoryRef.current?.relatedness ?? 0;
    return decideTransfer(items, Math.max(lexical, semantic));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyerProfile, enrichment, identity, ignoreTwin, form.productName]);

  const observedExternalContext = (): string => {
    const bef = buyerTwin?.observed_external?.befisc;
    const s3 = buyerTwin?.observed_external?.sign3;
    const id = identity;
    const bits: string[] = [];
    if (id?.entityType) bits.push(`entity: ${id.entityType}`);
    if (bef?.gender) bits.push(String(bef.gender).toLowerCase());
    if (bef?.age) bits.push(`age ~${bef.age}`);
    if (bef?.income) bits.push(`income ${bef.income}`);
    const loc = befiscState(bef?.address) || id?.gstState || '';
    if (loc) bits.push(`location ${loc}`);
    const platforms = s3?.platforms || [];
    if (platforms.length) bits.push(`active on ${platforms.slice(0, 4).join('/')} (consumer-marketplace presence)`);
    // synthesized read — an individual PAN / consumer-marketplace presence with no company ⇒ personal
    const consumerSig = platforms.some((p) => /flipkart|snapdeal|amazon|meesho|myntra|ajio|facebook|instagram/i.test(p));
    const indiv = /individual|proprietor/i.test(id?.entityType || '');
    if ((indiv || consumerSig) && !enrichment?.buyer?.companyName) bits.push('→ reads as a PERSONAL / individual buyer');
    return bits.join(' · ');
  };
  // L2 Contradiction Engine — turn detected clashes (location / persona-vs-order / buyer-type) + the
  // local-preference CONSUMPTION (supplier radius) into polite NUDGES. Recomputes as the buyer types.
  const contradictions = useMemo<Nudge[]>(() => {
    if (!enrichment?.buyer && !buyerTwin) return [];
    const b = enrichment?.buyer;
    const bef = buyerTwin?.observed_external?.befisc;
    // best-effort city out of a Befisc postal address: the comma-segment just before the 6-digit PIN.
    const befCity = (() => {
      const segs = String(bef?.address || '').split(',').map((s) => s.trim()).filter(Boolean);
      const pin = segs.findIndex((s) => /\b\d{6}\b/.test(s));
      const c = pin > 0 ? segs[pin - 1] : '';
      return /^[A-Za-z .]{3,20}$/.test(c) ? c : '';
    })();
    const locations = [
      { source: 'profile', value: b?.city || '' },
      { source: 'CSL', value: enrichment?.cslCity || '' },
      { source: 'Befisc', value: befCity },
    ].filter((l) => l.value);
    const res = detectContradictions({
      locations,
      companyName: b?.companyName,
      // Prefer the human-readable persona (LLM "Retailer") over a raw customerType code ("empFCP").
      profileType: buyerProfile?.persona || b?.customerType || enrichment?.persona?.type,
      twinType: buyerTwin?.layer_a_identity?.business_type,
      intentType: requirementIntent?.journey || requirementIntent?.value || undefined,
      isPersonal: page1Choice === 'personal',
      qty: qtyNum,
      unit: form.unit,
      localPreference: buyerProfile?.localityPreference || String(buyerTwin?.layer_b_behavioral?.local_preference?.value || ''),
      buyerCity: b?.city,
      // R3 — feed the (previously idle) engines so they drive action nudges.
      authorityRole: buyerProfile?.authorityRole,
      procurementModel: buyerProfile?.procurementModel,
      // P3.8 — cross-signal: the qty order-scale × role, and the current product vs the buyer's whole history.
      orderScale: classifyOrderScale(qtyNum, form.unit).band,
      offProfileNewProduct: !!buyerTwin && !!form.productName.trim() && buildTwinPlanInput(buyerTwin, form.productName).offProfile && !matchCategory(enrichment, form.productName),
      // P0 identity hierarchy — a confident institutional Nature resolves the buyer type → suppress the
      // "which buyer type?" nudge (don't ask IIT-Kanpur to choose between Business Buyer and Manufacturer).
      nature: buyerProfile?.nature,
      natureConfidence: buyerProfile?.natureConfidence,
    });
    (window as unknown as { __contradictions?: unknown }).__contradictions = res;
    return res;
  }, [enrichment, buyerTwin, buyerProfile, requirementIntent, page1Choice, qtyNum, form.unit, form.productName]);
  const [nudgeAnswers, setNudgeAnswers] = useState<Record<string, string>>({});
  const [ceoView, setCeoView] = useState(false); // L4 — plain-language Executive view toggle
  const answerNudge = (n: Nudge, opt: string) => {
    setNudgeAnswers((prev) => ({ ...prev, [n.type]: opt }));
    // Wire the clean field writes (consumption — the buyer's answer flows into the form).
    if (n.field === 'buyerKind') {
      if (/personal/i.test(opt)) setPage1Choice('personal');
      else if (/business|resale|workshop|fleet/i.test(opt)) setPage1Choice('business');
    }
    if (n.field === 'deliveryCity' && opt && opt !== 'Other') setForm((p) => ({ ...p, deliveryLocation: opt }));
    if (n.field === 'buyerType' && opt && opt !== 'Other') setField('buyerType', opt); // the buyer's own type pick → canonicalBuyerType + planner consume it
    // P1.1 — EVERY resolved nudge becomes a CONFIRMED fact in the system-of-record (coverage registry,
    // User authority = 100). That makes it flow into requirementContext → planner / cascade / help ("do
    // NOT re-ask or contradict"), show in the Truth Table, and travel with the lead. Previously the
    // supplier-radius / approval / installation / PO answers died inert in nudgeAnswers state.
    if (opt && opt !== 'Other') {
      const concept = ({ supplier_radius: 'supplier radius', approval: 'approval needed', installation: 'installation support', po_process: 'procurement process', scale_vs_role: 'order context', new_direction: 'new direction' } as Record<string, string>)[n.type];
      if (concept) coverage.current.record(concept, opt, 'User', 100);
    }
    track('rfq_nudge_answered', { type: n.type, answer: opt });
  };
  const observedTraits = (o: ObservedSessionBehavior) =>
    [o.spec_engagement, o.flexibility, o.question_engagement, o.urgency_posture, o.commercial_posture, o.independence].filter(Boolean);
  // Human, seller-facing one-liner from the observed traits (most actionable first). PII-free.
  const observedBehaviorLine = (o: ObservedSessionBehavior): string => {
    const phrase: Record<string, string> = {
      'urgency_posture:Immediate': 'needs it fast', 'urgency_posture:Flexible': 'timing-flexible', 'urgency_posture:Planned': 'planned timeline',
      'commercial_posture:Advance-led': 'pays advance', 'commercial_posture:Credit-seeking': 'seeks credit terms', 'commercial_posture:COD': 'prefers COD', 'commercial_posture:Finance-seeking': 'needs financing',
      'spec_engagement:High': 'hands-on with specs', 'spec_engagement:Medium': 'gives spec detail', 'spec_engagement:Low': 'open on spec detail',
      'flexibility:High': 'flexible on several specs', 'flexibility:Medium': 'flexible on a spec',
      'question_engagement:High': 'shares context', 'question_engagement:Low': 'prefers a quick form',
      'independence:High': 'overrides AI suggestions', 'independence:Medium': 'tweaks a suggestion',
    };
    const order: Array<keyof ObservedSessionBehavior> = ['urgency_posture', 'commercial_posture', 'spec_engagement', 'flexibility', 'independence', 'question_engagement'];
    const parts: string[] = [];
    for (const k of order) { const tr = o[k]; if (tr && typeof tr === 'object' && 'value' in tr) { const p = phrase[`${k}:${(tr as { value: unknown }).value}`]; if (p) parts.push(p); } }
    return parts.slice(0, 4).join(' · ');
  };

  // IDENTITY HIERARCHY (P0): Nature > Identity > Business Type > Buying Behaviour.
  const canonicalBuyerType = (t?: BuyerTwin | null): string => {
    const tw = t ?? liveTwin();
    const nat = (buyerProfile?.nature || '').toLowerCase();
    const natConf = buyerProfile?.natureConfidence ?? 0;
    const pick = (form.buyerType || '').trim();
    // A high-confidence, evidence-gated ACADEMIC / GOVERNMENT Nature is the TOP of the hierarchy. It
    // outranks an LLM-guessed business_type AND a buyer-type pick that CONTRADICTS it ("Manufacturer" for
    // an iitk.ac.in buyer — which only got picked because the nudge wrongly offered it). A DELIBERATE
    // institutional pick still stands. Corporate / generic Nature falls through (a real manufacturer is
    // untouched), where a user pick > the Twin's business_type > the profile persona.
    const institutional = /academic|research/.test(nat) ? (buyerProfile?.authorityRole === 'procurement' ? 'Institution — Procurement' : 'Research / Academic Institution')
      : /government|psu/.test(nat) ? 'Government / PSU' : '';
    if (institutional && natConf >= 80) {
      if (pick && /institut|research|academ|government|psu|college|univers|\blab\b|\bdept\b|department|faculty/i.test(pick)) return pick; // respect a deliberate institutional pick
      return institutional; // Nature wins over a non-institutional pick / business_type guess
    }
    if (pick) return pick; // a user pick wins for non-institutional buyers
    return (tw?.layer_a_identity?.business_type || '').trim() || (buyerProfile?.persona || '').trim() || '';
  };
  const twinContextLine = (t: BuyerTwin): string => {
    const lc = t.layer_c_commercial_intelligence;
    const lb = t.layer_b_behavioral;
    const isTrue = (tr?: { value: unknown }) => tr && (tr.value === true || tr.value === 'true');
    // "likely for" is SHARED WITH SELLERS, so it must reflect the CURRENT requirement — never the
    // buyer's historical business active-intent. Else a personal / off-profile buy (a trader buying
    // diapers for his newborn) wrongly tells sellers "likely for: Manufacturing inputs". Prefer the
    // current requirement intent; fall back to the Twin's active-intent ONLY on-profile with no current
    // intent yet (hierarchy: current requirement > persona/history).
    const off = buildTwinPlanInput(t, form.productName).offProfile;
    const likelyFor = (requirementIntent?.value || '').trim() || (off ? '' : String(lc.current_active_intent?.value || ''));
    return [
      canonicalBuyerType(t), // A2: the single canonical role (not raw business_type)
      isTrue(lc.multi_category_buyer) ? 'multi-SKU' : '',
      lb.whatsapp_affinity?.value === 'High' ? 'WhatsApp-first' : '',
      lb.local_preference?.value === 'High' ? 'local-only' : lb.local_preference?.value === 'Medium' ? 'local-leaning' : '',
      isTrue(lc.inventory_builder) ? 'inventory-builder' : '',
      likelyFor ? `likely for: ${likelyFor}` : '',
    ].filter(Boolean).join(' · ');
  };

  // ─── Twin Debug View (BTE-v1.2) — full evidence ledger; click a trait to expand ──
  // "If the Twin is wrong, everything downstream is wrong" — so we see it first.
  const renderTwinDebug = () => {
    const t = buyerTwin;
    if (!t) return null;
    const lc = t.layer_c_commercial_intelligence;
    const traitRow = (name: string, tr?: import('../lib/enrichment').InferredTrait) =>
      tr ? (
        <details key={name} className="border-l-2 border-indigo-200 pl-2">
          <summary className="cursor-pointer select-none">
            <b>{name}</b>: {String(tr.value)} <span className="text-indigo-400">· conf {tr.confidence} · stab {tr.trait_stability} · contra {tr.contradictions_count}{tr.last_seen ? ` · seen ${tr.last_seen}` : ''}</span>
          </summary>
          <ul className="list-disc ml-4 mt-0.5 text-indigo-600">
            {tr.evidence.map((e, i) => (
              <li key={i} className="break-words">[{e.source}{e.date ? ` ${e.date}` : ''}] {e.signal}</li>
            ))}
          </ul>
        </details>
      ) : null;
    return (
      <div className="border border-indigo-200 bg-indigo-50 rounded-xl p-3 text-[11px] text-indigo-900 space-y-1">
        <p className="font-bold">🧬 Buyer Twin (BTE-v1.2) — click any trait for its evidence ledger</p>
        {(() => {
          const eb = t.twin_confidence.evidence_base;
          const sat = (n: number, k: number) => 1 - Math.exp(-n / k);
          const terms = { PNS: 0.35 * sat(eb.pns_calls, 3), WA: 0.25 * sat(eb.whatsapp_events, 30), BL: 0.25 * sat(eb.bls_created, 4), CSL: 0.15 * sat(eb.csl_events, 20) };
          const tot = Object.values(terms).reduce((a, b) => a + b, 0) || 1;
          const pct = (x: number) => Math.round((x / tot) * 100);
          const fr = t.twin_confidence.freshness;
          const dot = fr === 'Fresh' ? '🟢' : fr === 'Moderate' ? '🟡' : fr === 'Stale' ? '🔴' : '⚪';
          return (
            <>
              <p><b>twin_confidence (evidence-volume — HOW MUCH data, not persona-fit):</b> {t.twin_confidence.overall_score}/100 · {dot} {fr}{t.twin_confidence.last_signal_at ? ` (last ${t.twin_confidence.last_signal_at})` : ''} · v{t.buyer_version}{t.major_profile_shift_detected ? ' · ⚠ profile-shift' : ''} <span className="text-indigo-400">· {t.total_signal_count ?? 0} signals · {t.twin_generation_time_ms ?? 0}ms</span></p>
              <p><b>confidence sources:</b> PNS {pct(terms.PNS)}% · WA {pct(terms.WA)}% · BL {pct(terms.BL)}% · CSL {pct(terms.CSL)}% <span className="text-indigo-400">(counts {eb.pns_calls}/{eb.whatsapp_events}/{eb.bls_created}/{eb.csl_events})</span></p>
            </>
          );
        })()}
        <p><b>identity (PII · debug-only):</b> {[t.layer_a_identity.business_type, ...(t.layer_a_identity.secondary_roles?.length ? [`+${t.layer_a_identity.secondary_roles.join('/')}`] : []), t.layer_a_identity.city, t.layer_a_identity.state, t.layer_a_identity.language, t.layer_a_identity.verified ? 'verified✓' : ''].filter(Boolean).join(' · ')}</p>
        {/* #10: the Twin's business_type and the Profile's persona are TWO lenses on the same
            buyer (what they ARE vs how they BUY), produced by two passes with different vocab —
            show them side-by-side as facets, not a contradiction, with the right confidence label. */}
        {buyerProfile?.persona && buyerProfile.persona.toLowerCase() !== (t.layer_a_identity.business_type || '').toLowerCase() && (
          <p className="text-indigo-500">↳ role (Twin): <b>{t.layer_a_identity.business_type || '—'}</b> · persona (Profile): <b>{buyerProfile.persona}</b>{buyerProfile.confidence != null ? ` · persona-fit ${Math.round(buyerProfile.confidence * 100)}%` : ''} — same buyer, two lenses (NOT a conflict)</p>
        )}
        {t.layer_a_identity.company_desc && <p className="text-indigo-500 break-words"><b>company:</b> {cleanEvidence(t.layer_a_identity.company_desc) ? t.layer_a_identity.company_desc.slice(0, 180) : <span className="text-gray-400 italic">— buyer-typed gibberish, ignored as evidence (N5)</span>}</p>}
        <p className="font-semibold pt-1">behavioral:</p>
        {Object.entries(t.layer_b_behavioral).map(([k, v]) => traitRow(k, v))}
        <p className="font-semibold pt-1">commercial intelligence:</p>
        {traitRow('inventory_builder', lc.inventory_builder)}
        {traitRow('multi_category_buyer', lc.multi_category_buyer)}
        {traitRow('bulk_orientation', lc.bulk_orientation)}
        {traitRow('trial_first', lc.trial_first)}
        {traitRow('current_active_intent', lc.current_active_intent)}
        <p><b>recent intent clusters:</b> {lc.recent_intent_clusters.map((c) => `${c.intent}(${c.signal_count}${c.last_seen ? ', ' + c.last_seen : ''})`).join(' · ') || '—'}</p>
        <p><b>intent history:</b> {JSON.stringify(lc.buyer_intent_history)} · <b>categories:</b> {lc.historical_categories.length}</p>
        <p><b>explicit_unknowns (planner queue):</b> {t.explicit_unknowns.join(', ') || '—'}</p>
        <p><b>negative signals (never violate):</b> {t.explicit_negative_signals.join(' · ') || '—'}</p>
        <p><b>attribution:</b> {lc.attribution_confidence.inferred_product_mapping || '—'} ({lc.attribution_confidence.confidence})</p>
        {/* BTE-v1.3 — PRESENT behaviour, observed live as the buyer fills the form. Source-separated
            from the history-derived layers above (evidence reads [rfq_session]). DESCRIBES the buyer;
            never drives the requirement. Strengthens across sessions (session_count → stability). */}
        {observedTraits(observedBehavior).length > 0 && (() => {
          const o = observedBehavior;
          return (
            <>
              <p className="font-semibold pt-1 text-emerald-700">👁 observed this session (RFQ-filling behaviour · {o.session_count > 1 ? `seen across ${o.session_count} sessions` : 'first session'}):</p>
              <p className="text-emerald-600 -mt-0.5 text-[10px]">first-party — what the buyer DID in the form now; describes, never overrides the current requirement</p>
              {traitRow('spec_engagement', o.spec_engagement)}
              {traitRow('flexibility', o.flexibility)}
              {traitRow('question_engagement', o.question_engagement)}
              {traitRow('urgency_posture', o.urgency_posture)}
              {traitRow('commercial_posture', o.commercial_posture)}
              {traitRow('independence', o.independence)}
            </>
          );
        })()}
        {t.observed_external && (() => {
          const e = t.observed_external;
          const b = e.befisc; const g = e.sign3;
          return (
            <>
              <p className="font-semibold pt-1 text-fuchsia-700">🌐 observed external (mobile lookup{e.fetched_at ? ` · ${e.fetched_at.slice(0, 10)}` : ''} · OBSERVED — not a planning input):</p>
              {b && <p className="text-fuchsia-700 break-words">Befisc: {[b.name && `name ${b.name}`, b.gender, b.age && `age ${b.age}`, b.dob && `dob ${b.dob}`, b.income && `income ₹${b.income}`, b.pan && `PAN ${b.pan}`, b.altPhones ? `+${b.altPhones} alt phone(s)` : '', b.email && `email ${b.email}`, b.address && `addr ${b.address}`].filter(Boolean).join(' · ') || '—'}</p>}
              {g && <p className="text-fuchsia-700 break-words">Sign3: {[g.socialProfiles != null && `${g.socialProfiles} social profiles`, g.operator && `operator ${g.operator}`, g.breaches != null && `${g.breaches} breach(es)`, g.linked && `linked ${g.linked}`, g.platforms?.length && `on: ${g.platforms.join(', ')}`].filter(Boolean).join(' · ')}</p>}
              {e.world?.summary && <p className="text-fuchsia-700 break-words">World: {e.world.summary}{e.world.confidence != null ? ` (conf ${e.world.confidence})` : ''}</p>}
              {e.notes?.length ? <p className="text-fuchsia-500">⚠ {e.notes.join(' · ')}</p> : null}
            </>
          );
        })()}
        <p className="italic">“{t.summary}”</p>
      </div>
    );
  };

  // ─── P5c: Concierge confirmation — handlers + telemetry + the card ──────────
  const bumpConciergeStat = (accepted: boolean) => {
    setConciergeStat((p) => ({ yes: p.yes + (accepted ? 1 : 0), total: p.total + 1 }));
    const w = window as unknown as { __conciergeStat?: { yes: number; total: number } };
    const cur = w.__conciergeStat || { yes: 0, total: 0 };
    w.__conciergeStat = { yes: cur.yes + (accepted ? 1 : 0), total: cur.total + 1 };
  };
  const onConciergeChanged = () => {
    setConciergeState('changed');
    twinMuted.current = true; // mute the Twin for THIS session → discovery
    bumpConciergeStat(false);
    track('rfq_concierge_confirm', { accepted: false, glid: enrichment?.glid || glidInput });
    // Re-plan in discovery mode so the planner relearns the buyer's CURRENT reality
    // (off-profile path: lead intent/scale, drop the fast-track cap).
    planSig.current = '';
    dynGenSig.current = '';
    ensureReqPlan(isqSpecs);
  };
  // (concierge-confirm block removed — it was orphaned/unrendered dead code flagged by tsc noUnusedLocals)

  // ── Debug: internal pull broken down by n8n source (PNS/CSL/WA in+out/BL/ISQ/profile) ──
  // ── P0: Pipeline Health — "did the data even arrive, and where did it break?" ──
  // The FIRST thing an HOD reads: one panel, every stage green/amber/red, ONE failure
  // reason. Webhook is a captured snapshot (timing/records); twin+planner are read live.
  const renderPipelineHealth = () => {
    if (!pull && !Array.isArray(enrichmentRaw)) return null;
    const arr = Array.isArray(enrichmentRaw) ? (enrichmentRaw as Array<Record<string, unknown>>) : [];
    const get = (k: string) => arr.find((x) => x && x[k] !== undefined)?.[k];
    const cnt = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v as object).length : v ? 1 : 0);
    const SOURCES: Array<[string, string]> = [
      ['buyer_profile', 'Profile'], ['pns_data', 'PNS'], ['csl_data', 'CSL'],
      ['whatsapp_data', 'WA-out'], ['whatsapp_inbound', 'WA-in'], ['prev_bl_data', 'Prev-BL'], ['prev_isq_data', 'Prev-ISQ'],
    ];
    const records = pull?.records ?? arr.length;
    const webhookOk = records > 0;
    const profileFail = pull?.profileAuthFailed ?? false;
    const profilePartial = pull?.profilePartial ?? false;
    const twinBuilt = !!buyerTwin;
    const twinConf = buyerTwin?.twin_confidence?.overall_score ?? null;
    const plannerRan = !!(reqPlan && ((reqPlan.specOrder?.length ?? 0) || (reqPlan.mustHaveSpecs?.length ?? 0)));
    const llm = hasGeminiKey();
    // Single failure reason (priority order) — what an HOD repeats back.
    const reason = !webhookOk ? 'webhook-empty — GLID returned no records'
      : !llm ? 'cold-start — no LLM key (twin/planner disabled)'
      : profileFail ? 'profile-auth-failed — buyer_profile sub-fetch blocked (other 6 sources OK)'
      : profilePartial ? 'partial-profile — mobile present, name/company blank (sparse record, not a failure)'
      : !twinBuilt ? 'twin-pending — heavy pass not done yet (or no signals)'
      : !plannerRan ? 'planner-waiting — needs a product to plan'
      : 'ok — all stages healthy';
    const dot = (ok: boolean, warn = false) => (warn ? '🟡' : ok ? '🟢' : '🔴');
    const verdictColor = reason.startsWith('ok') ? 'text-green-700' : webhookOk ? 'text-amber-600' : 'text-red-600';
    return (
      <div className="border border-slate-300 bg-slate-50 rounded-xl p-3 text-[11px] text-slate-800 space-y-1">
        <p className="font-bold">🩺 Pipeline Health — GLID {pull?.glid || enrichment?.glid || glidInput}</p>
        <p>{dot(webhookOk)} <b>Webhook</b> <code>…user-insights-glid123</code> · {records} records · {pull ? `${pull.ms}ms` : 'live'}</p>
        <p className="flex flex-wrap gap-x-2">
          <span className="font-semibold">7 sources:</span>
          {SOURCES.map(([k, lbl]) => {
            const isProfile = k === 'buyer_profile';
            const isWaIn = k === 'whatsapp_inbound';
            const waI = isWaIn ? waInboundCount(get(k)) : null; // #N2: error wrapper ≠ messages
            const c = isWaIn ? waI!.count : cnt(get(k));
            const warn = (isProfile && (profileFail || profilePartial)) || (isWaIn && waI!.failed);
            const tag = isProfile && profileFail ? '⚠auth' : isProfile && profilePartial ? '⚠partial' : isWaIn && waI!.failed ? '✗err' : `(${c})`;
            return <span key={k}>{dot(c > 0 && !warn, warn)} {lbl}{tag}</span>;
          })}
        </p>
        <p>{dot(twinBuilt)} <b>Buyer Twin</b> {twinBuilt ? `· evidence-volume ${twinConf}/100 · ${pull?.twinMs != null ? pull.twinMs + 'ms' : 'built'}` : llm ? '· building / no signals' : '· skipped (no LLM key)'}</p>
        <p>{dot(plannerRan)} <b>Planner</b> {plannerRan ? `· ${reqPlan?.archetype} · ${reqPlan?.orderMode}` : '· awaiting product'}</p>
        <p className={'font-semibold pt-0.5 ' + verdictColor}>Verdict: {reason}</p>
      </div>
    );
  };

  // ── E: External Pull Health — did the Befisc/Sign3/World pulls + their calls succeed? ──
  // The answer to "does debug show if the external pulls were successful": per source, an
  // explicit status (✓ ok · ∅ no-record · ✗ failed · ⏸ creds-pending · ⏭ skipped-low-confidence
  // · 🔒 blocked) + latency + the anchor it hinged on. Surfaces the anti-bogus OSINT gate.
  // A4 (G12): LLM Call Health — the internal analog of the External panel. Per logical call,
  // did it fire, succeed (network), and how long. Reads the gemini.ts ring (window.__llmHealth).
  const renderLLMCallHealth = () => {
    const recs = getLLMHealth();
    if (!recs.length) return null;
    const byLabel = new Map<string, typeof recs>();
    for (const r of recs) { const a = byLabel.get(r.label) || []; a.push(r); byLabel.set(r.label, a); }
    const rows = [...byLabel.entries()].map(([label, rs]) => {
      const last = rs[rs.length - 1];
      const okN = rs.filter((r) => r.ok).length;
      const avg = Math.round(rs.reduce((sum, r) => sum + r.ms, 0) / rs.length);
      return { label, count: rs.length, okN, last, avg };
    }).sort((a, b) => b.last.at - a.last.at);
    return (
      <div className="border border-sky-200 bg-sky-50 rounded-xl p-3 text-[11px] text-sky-900 space-y-1">
        <p className="font-bold">🤖 LLM Call Health — did each call fire + succeed (network) + latency</p>
        {rows.map((r) => (
          <p key={r.label}>
            {r.last.ok ? '🟢' : '🔴'} <b>{r.label}</b> — {r.last.ok ? '✓ ok' : `✗ ${r.last.status || 'network error'}`} · {r.last.ms}ms{r.count > 1 ? ` · ${r.okN}/${r.count} ok · avg ${r.avg}ms` : ''} · {r.last.bytes}B
          </p>
        ))}
        <p className="text-sky-400">network-level — a parse failure surfaces downstream as the caller's fallback · console: window.__llmHealth</p>
      </div>
    );
  };

  // A1: Option Provenance — prove EVERY surfaced non-spec question/chip traces to the
  // registry (qty / category / profile / history). Spec fields+options are the ONLY
  // exempt source (they come from the IndiaMART ISQ API). An ungrounded card here is a bug.
  // Phase-2/3 foundation panel — the "Final RFQ Vision" table on existing intelligence.
  // Audit visibility: HOW related is the CURRENT product to the buyer's history → whether the Twin's
  // intent/history is allowed to influence this requirement at all. Makes the on/off-profile weighting
  // decision auditable ("why did the engine trust history?"). Generic token-overlap, NO category literals.
  const historyInfluence = (): { on: boolean; score: number; shared: string[] } => {
    const tw = ignoreTwin ? null : liveTwin();
    if (!tw || !form.productName.trim()) return { on: false, score: 0, shared: [] };
    const lc = tw.layer_c_commercial_intelligence;
    const hist = [...(lc?.historical_categories || []), String(lc?.current_active_intent?.value || '')].filter(Boolean).join(' ');
    const pt = coreTokens(form.productName);
    const ht = coreTokens(hist);
    const shared = [...pt].filter((t) => ht.has(t));
    const score = pt.size ? Math.round((shared.length / pt.size) * 100) / 100 : 0;
    return { on: shared.length > 0, score, shared };
  };
  // L4 — Executive (CEO) View: the SAME governed intelligence in plain language, NO engine names.
  // What we know (Confirmed) · what we think (Likely) · what looks unusual (contradictions) · what we
  // still need · what the AI saved. Reads the governed RU dims + the contradiction engine + spec list.
  const renderExecutiveView = () => {
    const dims = requirementUnderstanding();
    // Phase C — formalised bucketing (tested in ceosummarytest) + a readiness% headline.
    const ceo = buildCEOSummary({
      dims: dims.map((d) => ({ label: d.dim, value: d.value, state: d.state, confidence: d.confidence, source: d.source })),
      missingRequired: isqSpecs.filter((s) => !(form.dynamicSpecs[s.IM_SPEC_MASTER_DESC] || '').trim() && !coverage.current.isCovered(s.IM_SPEC_MASTER_DESC)).map((s) => s.IM_SPEC_MASTER_DESC),
      conflicts: contradictions.filter((n) => !nudgeAnswers[n.type]).map((n) => n.evidence?.join(' · ') || n.question),
      offProfile: !!buyerTwin && !!form.productName.trim() && buildTwinPlanInput(buyerTwin, form.productName).offProfile && !matchCategory(enrichment, form.productName),
    });
    const know = dims.filter((d) => d.state === 'Confirmed');
    const think = dims.filter((d) => d.state === 'Likely');
    const weak = dims.filter((d) => d.state === 'Weak');
    const openNudges = contradictions.filter((n) => !nudgeAnswers[n.type]);
    const needed = isqSpecs.filter((s) => !form.dynamicSpecs[s.IM_SPEC_MASTER_DESC]).map((s) => s.IM_SPEC_MASTER_DESC).slice(0, 6);
    const engineSpecs = new Set<string>([...enrichedSpecs, ...cascadeSpecs, ...autoFilledSpecs]);
    const avoided = engineSpecs.size + (reqPlan?.twinResolved?.length || 0);
    const deduced = Object.values(deducedLogistics).filter((d) => d && d.value && (d.confidence || 0) >= 0.8).length;
    // Commercial headline (ChatGPT: CEOs buy business impact, not "questions skipped"). Buyer-effort-
    // reduced % + an estimate of seller back-and-forth avoided (each pre-filled/deduced field + each
    // contradiction caught up-front is roughly one follow-up call/message the seller won't need).
    const universe = Math.max(1, isqSpecs.length + (reqPlan?.twinResolved?.length || 0) + deduced);
    const effortPct = Math.min(100, Math.round(((avoided + deduced) / universe) * 100));
    const followupsAvoided = avoided + deduced + openNudges.length;
    const Row = ({ icon, label, val }: { icon: string; label: string; val: string }) => (
      <p className="leading-snug"><span className="mr-1">{icon}</span><b>{label}:</b> {val}</p>
    );
    return (
      <div className="border-2 border-slate-300 bg-white rounded-xl p-3 text-[12.5px] text-slate-800 space-y-2 shadow-sm">
        <p className="font-bold text-slate-900 text-[13px]">👔 Buyer snapshot</p>
        <div className="flex flex-wrap gap-2 -mt-0.5">
          <span className="rounded-full bg-indigo-600 text-white font-bold px-2.5 py-0.5 text-[11px]">{ceo.readiness}% understood</span>
          <span className="rounded-full bg-emerald-600 text-white font-bold px-2.5 py-0.5 text-[11px]">Buyer effort reduced ~{effortPct}%</span>
          <span className="rounded-full bg-slate-700 text-white font-semibold px-2.5 py-0.5 text-[11px]">≈{followupsAvoided} seller follow-ups avoided</span>
        </div>
        <div className="space-y-0.5">
          <p className="font-semibold text-emerald-700">✓ What we know</p>
          {know.length ? know.map((d) => <Row key={d.dim} icon="✓" label={d.dim} val={d.value} />) : <p className="text-slate-400 pl-4">— still learning</p>}
        </div>
        <div className="space-y-0.5">
          <p className="font-semibold text-amber-700">~ What we think (likely)</p>
          {think.length ? think.map((d) => <Row key={d.dim} icon="~" label={d.dim} val={d.value} />) : <p className="text-slate-400 pl-4">—</p>}
        </div>
        {weak.length > 0 && (
          <div className="space-y-0.5">
            <p className="font-semibold text-yellow-600">◦ Early signals (low confidence)</p>
            {weak.map((d) => <Row key={d.dim} icon="◦" label={d.dim} val={d.value} />)}
          </div>
        )}
        {openNudges.length > 0 && (
          <div className="space-y-0.5">
            <p className="font-semibold text-red-600">⚠ What looks unusual</p>
            {openNudges.map((n) => <p key={n.type} className="leading-snug pl-1">⚠ {n.evidence.join(' · ') || n.question}</p>)}
          </div>
        )}
        <div className="space-y-0.5">
          <p className="font-semibold text-slate-600">? What we still need</p>
          <p className="pl-4 text-slate-500">{needed.length ? needed.join(' · ') : '— nothing, ready to send'}</p>
        </div>
        <p className="pt-1 border-t border-slate-200 text-slate-600">⚡ <b>What the AI saved:</b> {avoided} question{avoided === 1 ? '' : 's'} skipped · {deduced} field{deduced === 1 ? '' : 's'} auto-completed · {openNudges.length} thing{openNudges.length === 1 ? '' : 's'} double-checked</p>
      </div>
    );
  };

  // L5 — Verification dashboard: governance at a glance (the 4+1 states) + nudge confirm/change tally.
  // This is the self-improving loop's scoreboard — confirmed / likely / weak / unknown / contradicted.
  const renderVerificationDashboard = () => {
    const dims = requirementUnderstanding();
    const by = (s: AttrState) => dims.filter((d) => d.state === s).length;
    const total = dims.length || 1;
    const pct = (n: number) => Math.round((n / total) * 100);
    const raised = contradictions.length;
    const answered = Object.keys(nudgeAnswers).length;
    return (
      <div className="border border-slate-300 bg-slate-50 rounded-xl p-3 text-[11px] text-slate-800 space-y-1">
        <p className="font-bold">📊 Verification dashboard — governance at a glance</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span className="text-emerald-700">✓ Confirmed {by('Confirmed')} ({pct(by('Confirmed'))}%)</span>
          <span className="text-amber-700">~ Likely {by('Likely')}</span>
          <span className="text-yellow-600">◦ Weak {by('Weak')}</span>
          <span className="text-gray-400">? Unknown {by('Unknown')}</span>
          <span className="text-red-600">⚠ Contradicted {by('Contradicted')}</span>
        </div>
        <p>Nudges raised: <b>{raised}</b> · answered: <b>{answered}</b> · open: <b>{Math.max(0, raised - answered)}</b></p>
        <p className="text-slate-400">Golden Rule: every attribute is Confirmed / Likely / Weak / Unknown / Contradicted — never an unsupported "fact". Confirm/Change happens via the nudge chips on the form.</p>
      </div>
    );
  };

  // L2 — the buyer-facing NUDGE banner (VISIBLE, not debug-gated): a polite clarifying chip per detected
  // contradiction / consumption gap. Answered nudges drop off; tap writes the field via answerNudge.
  const renderNudges = () => {
    // R2 — contradictions arrive pre-sorted by priority; show only the TOP 2 so RFQ friction never returns.
    const open = contradictions.filter((n) => !nudgeAnswers[n.type]).slice(0, 2);
    if (!open.length) return null;
    const ICON: Record<string, string> = { location: '📍', persona_vs_order: '🤔', buyer_type: '🪪', supplier_radius: '📡' };
    return (
      <div className="border border-amber-300 bg-amber-50 rounded-xl p-3 text-[12px] text-amber-900 space-y-2">
        <p className="font-bold text-amber-800">⚡ A couple of quick checks — for sharper quotes</p>
        {open.map((n) => (
          <div key={n.type} className="border-l-2 border-amber-400 pl-2">
            <p className="font-medium">{ICON[n.type] || '•'} {n.question}</p>
            {debug && n.evidence.length > 0 && <p className="text-amber-500 text-[10px]">why: {n.evidence.join(' · ')}</p>}
            <div className="flex flex-wrap gap-1.5 mt-1">
              {n.options.map((o) => (
                <button key={o} type="button" onClick={() => answerNudge(n, o)} className="rounded-full border border-amber-400 bg-white px-2.5 py-1 text-amber-800 hover:bg-amber-100 font-medium">{o}</button>
              ))}
            </div>
          </div>
        ))}
        {Object.keys(nudgeAnswers).length > 0 && <p className="text-amber-500 text-[10px]">✓ noted: {Object.entries(nudgeAnswers).map(([k, v]) => `${k} = ${v}`).join(' · ')}</p>}
      </div>
    );
  };

  const renderRequirementUnderstanding = () => {
    const dims = requirementUnderstanding();
    const known = dims.filter((d) => d.confidence > 0).length;
    const hi = historyInfluence();
    return (
      <div className="border border-indigo-200 bg-indigo-50 rounded-xl p-3 text-[11px] text-indigo-900 space-y-1">
        <p className="font-bold">🧠 Requirement Understanding — the “Final RFQ Vision” ({known}/{dims.length} known · existing Twin/profile intelligence, NO new LLM · Phase-2/3 foundation)</p>
        <p className={hi.on ? 'text-indigo-700' : 'text-amber-700'}>🧭 History influence: <b>{hi.on ? 'ON' : 'OFF'}</b> · current-vs-history similarity <b>{hi.score}</b> {hi.on ? `· shared: [${hi.shared.join(', ')}] → Twin intent/history may shape this requirement` : `· no shared category tokens → OFF-PROFILE: history weight ≈ 0, intent derives from the CURRENT product only (G3)`}</p>
        {dims.map((d) => {
          const sc = d.state === 'Confirmed' ? 'text-emerald-700' : d.state === 'Likely' ? 'text-amber-700' : d.state === 'Weak' ? 'text-yellow-600' : d.state === 'Contradicted' ? 'text-red-600' : 'text-gray-400';
          return (
          <div key={d.dim} className="border-l-2 border-indigo-200 pl-1.5 my-0.5">
            <p><b>{d.dim}:</b> <span className={d.confidence ? 'text-indigo-800 font-semibold' : 'text-gray-400'}>{d.value}</span> <span className={`${sc} font-semibold`}>{STATE_ICON[d.state]} {d.state}</span>{d.confidence ? <span className="text-indigo-400"> · {d.confidence}% · {d.source}</span> : null}</p>
            {d.confidence ? <p className="text-indigo-400">{d.evidence ? `evidence: ${d.evidence} · ` : ''}used by: {d.usedBy}</p> : null}
          </div>
        );})}
        <p className="text-indigo-400">value · <b>state</b> (Confirmed / Likely / Unknown / Contradicted — Golden Rule: no evidence ⇒ Unknown, never a guess) · confidence · source · evidence · used-by.</p>
      </div>
    );
  };

  // ⏱ P1.5 DEPENDENCY TRACE — module timing & ordering. The acid test: planner.start must be AFTER
  // category.done (hit or timed-out). If the planner started before category finished, category was
  // too late to shape intent / spec-order / panel questions (the dry-run bug). Reads the ref live.
  const renderDependencyTrace = () => {
    const order = ['buyer', 'mcat', 'category', 'planner'] as const;
    const rows = order.map((k) => ({ k, ...(moduleTrace.current[k] || {}) })).filter((r) => r.start != null || r.done != null || r.status);
    if (!rows.length) return null;
    const label: Record<string, string> = { buyer: 'Buyer Brain (pull)', mcat: 'MCAT resolve', category: 'Category Brain', planner: 'Planner' };
    const fmt = (n?: number) => (n == null ? '…' : `${(n / 1000).toFixed(1)}s`);
    const cat = moduleTrace.current.category; const plan = moduleTrace.current.planner;
    // HONEST verdict: "consumed" requires the category to have actually HIT (data arrived) AND
    // the planner to have run after that hit. A timed-out / still-building category sets cat.done
    // (we gave up waiting) but delivered NOTHING — catCriticals(0) — so it must NOT read as a ✓.
    // This is the dry-run finding: trace said "✓ planner ran after category" while the category
    // was still building and zero criticals reached the planner.
    const catDone = cat?.done; const planStart = plan?.start;
    const plannerRan = planStart != null && cat?.start != null;
    const catArrived = cat?.status === 'hit';
    const ranAfter = catDone != null && planStart != null && planStart >= catDone;
    const ranBefore = catDone != null && planStart != null && planStart < catDone;
    // ChatGPT: "planner waited ≠ planner consumed." The planner stamps its criticals count into its
    // own status ("planned (N category criticals)"). Read it LIVE so the verdict reflects ACTUAL
    // consumption — a category can HIT and still contribute 0 criticals (a consumption bug, distinct
    // from a timing/build one). catN: null = planner not run / unknown, 0 = hit-but-nothing-consumed.
    const catN = (() => { const m = /\((\d+)\s+category critical/.exec(plan?.status || ''); return m ? Number(m[1]) : null; })();
    let vTone = 'text-amber-600'; let vText = '… planner has not run yet';
    if (plannerRan) {
      if (catArrived && ranAfter) {
        if (catN === 0) { vTone = 'text-amber-600'; vText = '⚠ category HIT but 0 criticals consumed — shape unchanged (see window.__categoryConsumed)'; }
        else { vTone = 'text-emerald-700'; vText = `✓ category consumed — ${catN ?? 'N'} criticals shaped the questions`; }
      }
      else if (ranBefore) { vTone = 'text-red-600'; vText = '⚠ planner ran BEFORE category resolved'; }
      else { vTone = 'text-amber-600'; vText = `⚠ category NOT consumed (${cat?.status || '—'}) — questions are buyer + ISQ only`; }
    }
    // The explicit YES/NO signal ChatGPT asked for — separate from "did the planner WAIT?".
    const consumed = catArrived && ranAfter && (catN == null || catN > 0);
    return (
      <div className="border border-cyan-300 bg-cyan-50 rounded-xl p-3 text-[11px] text-cyan-900 space-y-0.5">
        <p className="font-bold">⏱ Dependency Trace — module timing &amp; ordering <span className={vTone}>{vText}</span></p>
        {rows.map((r) => (
          <p key={r.k}><b>{label[r.k] || r.k}</b> · start {fmt(r.start)} → done {fmt(r.done)}{r.status ? ` · ${r.status}` : ''}{r.waited ? ` · waited: ${r.waited}` : ''}</p>
        ))}
        {plannerRan && <p className="font-semibold">Planner consumed category: <span className={consumed ? 'text-emerald-700' : 'text-red-600'}>{consumed ? `YES (${catN ?? 'N'} criticals)` : 'NO'}</span> · waited ≠ consumed</p>}
        <p className="text-cyan-500">Rule: category must HIT (data arrived) AND planner.start ≥ that hit AND criticals &gt; 0 → it shaped the questions. Waiting or a timed-out/building category contributes nothing. window.__moduleTrace · window.__categoryConsumed</p>
      </div>
    );
  };

  // 🕸 QUESTION GRAPH (Phase C) — which specs the intent already answers (asked once, not twice).
  const renderQuestionGraph = () => {
    const g = questionGraph;
    if (!g.implied.length) return null;
    return (
      <div className="border border-violet-300 bg-violet-50 rounded-xl p-3 text-[11px] text-violet-900 space-y-0.5">
        <p className="font-bold">🕸 Question Graph — intent ⟹ implied specs (dedup: asked once, not twice)</p>
        {g.implied.map((i) => (
          <p key={i.specId}><b>{i.specName}</b> = <span className="text-emerald-700 font-semibold">{i.impliedValue}</span> · implied by intent “{i.viaValue}” · {i.confidence}% → prefilled, not re-asked</p>
        ))}
      </div>
    );
  };

  // 🏭 CATEGORY CONSUMPTION — the richer v13 layers actually shaping this RFQ (proactive checks from
  // deal_blockers, applications from intent_patterns, category-grounded budget bands). Debug-visible proof.
  const renderCategoryConsumption = () => {
    const cc = categoryConsumed;
    const conf = categoryConf;
    // Show whenever a category verdict exists (hit) — even an EMPTY one — so the gate decision and
    // buyer-only fallback are visible, not silently absent.
    if (categoryStatus !== 'hit' && !cc.checks.length && !cc.applications.length && !cc.bands) return null;
    const bandColor = conf.band === 'rich' ? 'text-emerald-700' : conf.band === 'thin' ? 'text-amber-700' : 'text-red-600';
    return (
      <div className="border border-amber-300 bg-amber-50 rounded-xl p-3 text-[11px] text-amber-900 space-y-0.5">
        <p className="font-bold">🏭 Category consumption (v13 layers) <span className={bandColor}>· {conf.score}/100 {conf.band.toUpperCase()} → {conf.fuse ? 'consume + fuse' : conf.consume ? 'consume only' : 'IGNORE (buyer-only)'}</span></p>
        <p className="text-amber-600">{categoryConfidenceLine(conf)}</p>
        {conf.consume ? (
          <>
            {cc.checks.length || cc.applications.length || cc.bands ? <p className="text-amber-700">{formatCategoryConsumption(cc.checks, cc.applications, cc.bands)}</p> : null}
            {cc.checks.map((c) => <p key={c.kind}>• proactive [{c.kind} · {c.frequency}%] → planner: {c.label}</p>)}
            {cc.bands ? <p>• budget bands → planner (verbatim): {cc.bands.join(' · ')}</p> : null}
            {cc.applications.length ? <p>• applications → intent: {cc.applications.slice(0, 4).join(' · ')}{cc.loadSizingRelevant ? ' · (load-sizing relevant)' : ''}</p> : null}
          </>
        ) : <p className="text-red-600 font-semibold">category empty/untrustworthy → NOT shaping this RFQ (buyer intelligence only)</p>}
      </div>
    );
  };

  // 🏅 CANDIDATE LEADERBOARD — EVERY category insight, ranked by seller-frequency, with its
  // DISPOSITION (asked / spec / intent / last-page / known / deprioritised + why). Answers
  // "why wasn't Site-Ready asked?" deterministically — it shows where each insight actually went.
  const renderCategoryDisposition = () => {
    if (categoryStatus !== 'hit' || !categoryConf.consume) return null;
    const known = coverage.current.facts().filter((f) => f.status === 'active' || f.status === 'confirmed').map((f) => (f.concept || '').replace(/_/g, ' '));
    const board = categoryLeaderboard({
      criticals: resolvedRequirement.criticalRanked,
      blockers: categoryConsumed.checks.map((c) => ({ label: c.label, kind: c.kind, frequency: c.frequency })),
      applications: categoryConsumed.applications,
      askedLabels: dynQuestions.filter((q) => q.source === 'llm').map((q) => q.label),
      specNames: isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC).filter(Boolean),
      intentValue: requirementIntent?.value || '',
      knownConcepts: known,
    });
    if (!board.length) return null;
    (window as unknown as { __leaderboard?: unknown }).__leaderboard = board;
    const dc: Record<string, string> = { ASKED: 'text-emerald-700', SPEC: 'text-teal-700', INTENT: 'text-blue-700', LAST_PAGE: 'text-indigo-700', KNOWN: 'text-slate-500', DEPRIORITIZED: 'text-rose-600' };
    return (
      <div className="border border-amber-300 bg-amber-50 rounded-xl p-3 text-[11px] text-amber-900 space-y-0.5">
        <p className="font-bold">🏅 Category Candidate Leaderboard — ranked + disposition <span className="font-normal text-amber-600">({dispositionSummary(board)})</span></p>
        {board.map((r, i) => (
          <p key={i}>{String(i + 1).padStart(2)}. <b>{r.name}</b> <span className="text-amber-500">[{r.kind} · freq {r.priority}]</span> → <span className={dc[r.disposition] || ''}>{r.disposition}</span> · {r.reason}{r.coveredBy && r.disposition !== 'DEPRIORITIZED' ? ` (${r.coveredBy})` : r.coveredBy ? ` → ${r.coveredBy}` : ''}</p>
        ))}
        <p className="text-amber-400">Every category insight traces to a disposition. Panel cap is 3 → high-freq non-spec blockers compete; lower ones DEPRIORITIZED. window.__leaderboard</p>
      </div>
    );
  };

  // 🔗 REASON-CHAIN — decision provenance per question (the "why this, why not that" view that
  // takes this past a LangSmith trace). Pure UNIFICATION of signals that already exist (planner
  // reasons + resolver subtraction + question-graph implications + coverage registry + category) —
  // NO new intelligence. Answers, for THIS RFQ: what was asked & because-of-what, and what was
  // suppressed & because-of-what.
  const renderReasonChain = () => {
    const asked = dynQuestions.filter((q) => q.source === 'llm');
    const cov = coverage.current;
    const known = cov.facts().filter((f) => f.status === 'active' || f.status === 'confirmed');
    const implied = questionGraph.implied || [];
    const rr = resolvedRequirement;
    const catRich = categoryConf.fuse;
    if (!asked.length && !known.length && !implied.length && !rr.knownDropped.length) return null;
    // for an asked question, assemble its "because" reasons from every contributing signal.
    const becauseFor = (label: string, reason?: string, groundedIn?: string, genBy?: string): string[] => {
      const why: string[] = [];
      const crit = rr.criticalRanked.find((c) => (c.maps_to_isq || c.name || '').toLowerCase() === label.toLowerCase() || (c.name || '').toLowerCase() === label.toLowerCase());
      if (crit && categoryConf.consume) why.push(`category-critical (seller freq ${crit.seller_frequency ?? '—'}${catRich ? ', rich' : ''})`);
      const blk = categoryConsumed.checks.find((c) => reason && reason.toLowerCase().includes(c.kind));
      if (blk) why.push(`category deal-blocker [${blk.kind} ${blk.frequency}%]`);
      if (genBy === 'planner') why.push('planner');
      else if (genBy === 'refine') why.push('refined from prior answers');
      else if (genBy === 'generator') why.push('seller-question generator');
      if (groundedIn) why.push(`grounded: ${groundedIn.replace(/^\(reason\)\s*/, '')}`);
      else if (reason) why.push(reason);
      return why.length ? why : ['(no recorded grounding)'];
    };
    return (
      <div className="border border-fuchsia-300 bg-fuchsia-50 rounded-xl p-3 text-[11px] text-fuchsia-900 space-y-1">
        <p className="font-bold">🔗 Reason-Chain — why each question (decision provenance · unifies planner · resolver · graph · registry · category)</p>
        <p className="font-semibold text-emerald-800">ASKED ({asked.length}) <span className="font-normal text-fuchsia-400">— click a question to expand its reasons</span></p>
        {asked.map((q) => {
          const open = reasonOpen.has(q.id);
          const reasons = becauseFor(q.label, q.reason, q.groundedIn, q.genBy);
          return (
            <div key={q.id} className="pl-2">
              <button type="button" onClick={() => setReasonOpen((s) => { const n = new Set(s); if (n.has(q.id)) n.delete(q.id); else n.add(q.id); return n; })} className="text-left font-semibold text-fuchsia-800 hover:underline">
                {open ? '▼' : '▶'} {q.label.replace(/\s*\?$/, '')}
              </button>
              {open ? <div className="pl-4 pb-1"><p className="text-emerald-700">Asked because:</p>{reasons.map((r, i) => <p key={i} className="pl-2">✓ {r}</p>)}</div>
                : <span className="text-fuchsia-400"> — {reasons.length} reason{reasons.length === 1 ? '' : 's'}</span>}
            </div>
          );
        })}
        {asked.length === 0 && <p className="pl-2 text-fuchsia-400">— no planner questions (buyer fully known, or off-profile lead)</p>}
        <p className="font-semibold text-rose-700">SUPPRESSED — asked of others, not you</p>
        {implied.map((i) => (
          <p key={`imp-${i.specId}`} className="pl-2"><b>{i.specName}</b> — not asked: implied by intent “{i.viaValue}” → {i.impliedValue} ({i.confidence}%)</p>
        ))}
        {rr.knownDropped.map((d) => {
          const f = known.find((k) => (k.concept || '').replace(/_/g, ' ').toLowerCase() === d.toLowerCase());
          return <p key={`kd-${d}`} className="pl-2"><b>{d}</b> — not asked: already known{f ? ` (${f.value} · ${f.source})` : ''}</p>;
        })}
        {rr.knownInSchema.map((k) => (
          <p key={`kis-${k}`} className="pl-2"><b>{k}</b> — not asked: buyer memory (answered before, no category needed)</p>
        ))}
        {!implied.length && !rr.knownDropped.length && !rr.knownInSchema.length && <p className="pl-2 text-fuchsia-400">— nothing suppressed yet (no known facts to subtract)</p>}
        <p className="text-fuchsia-400">Every question traces to a signal; every suppression traces to a known fact or an intent implication.</p>
      </div>
    );
  };

  // 🧾 RFQ DECISION AUDIT — the measure half: did the intelligence actually reduce questions /
  // reuse what we knew? Computed from live state (no new LLM). ChatGPT: "mandatory."
  const renderScorecard = () => {
    const facts = resolvedRequirement.registryFacts.length;
    const conv = convSignals.signals.length;
    const repostMatched = repostSource ? Object.values(repostMeta).filter((m) => !m.custom).length : 0;
    // P1 RECONCILE — count the SAME work the AI-Impact panel does (was 0/34 vs AI-Impact's 7). Every
    // avoided question is the engine USING a known fact instead of asking: engine-filled specs
    // (twin/cascade/autofill) ∪ planner twin-skips ∪ deduced logistics ∪ resolver subtraction
    // (knownDropped + knownInSchema) ∪ repost ∪ a consumed location pref — deduped where they overlap.
    const engineSpecs = new Set<string>([...enrichedSpecs, ...cascadeSpecs, ...autoFilledSpecs]);
    const twinSkipped = reqPlan?.twinResolved?.length || 0;
    const deducedCount = Object.values(deducedLogistics).filter((d) => d && d.value && (d.confidence || 0) >= 0.8).length;
    const resolverAvoided = new Set<string>([...resolvedRequirement.knownDropped, ...resolvedRequirement.knownInSchema].map((s) => s.toLowerCase())).size;
    const questionsAvoided = engineSpecs.size + twinSkipped + deducedCount + resolverAvoided + repostMatched + (convSignals.locationPreference ? 1 : 0);
    const autoFilled = engineSpecs.size + deducedCount;
    // A2 HONESTY: factsUsed counts EVERY kind of consumption, not just avoided questions (the old
    // "2/44 used" lie). Category criticals that shaped specs, conversational signals, the locked intent
    // and the buyer persona ALL count. tallyUtilization grows the knowable base by the same category
    // contribution so the ratio stays meaningful. Mirrors the AI-Impact panel's accounting.
    const categoryConsumedNow = categoryStatus === 'hit' && categorySellerQs().length > 0;
    const { factsUsed, factsAvailable } = tallyUtilization({
      questionsAvoided,
      conversationalSignalsUsed: conv,
      categoryCriticalsUsed: categoryConsumedNow ? Math.min(categorySellerQs().length, 15) : 0,
      categoryEnhancers: categoryConsumedNow ? ((categoryConsumed.bands ? 1 : 0) + Math.min(categoryConsumed.checks.length, 3)) : 0,
      intentUsed: requirementIntent?.value ? 1 : 0,
      personaUsed: buyerProfile && reqPlan ? 1 : 0,
      registryFacts: facts,
      conversationalAvailable: conv,
      isqSpecs: isqSpecs.length,
    });
    // A3 RECONCILE: count only UNRESOLVED cross-signal conflicts (a nudge the buyer answered is no
    // longer "open"). These are the contradiction NUDGES — distinct from the requirement-dim
    // "Contradicted" state in the verification dashboard; the scorecard line is relabelled to say so.
    const openConflicts = contradictions.filter((n) => !nudgeAnswers[n.type]).length;
    const sc = scoreRFQ({
      factsAvailable, factsUsed,
      questionsAsked: (lockedSpecOrder ?? computeSpecOrder(false)).length,
      questionsAvoided, autoFilled,
      contradictions: openConflicts,
      locationPreferenceReused: !!convSignals.locationPreference,
      prevRequirementReused: !!repostSource || facts > 0,
      // "Used" = category HIT *and* it actually produced criticals (parsed → non-empty). A hit with
      // empty/malformed critical_specs honestly reads "No" — so this matches the trace's "consumed"
      // line instead of the weaker "did it merely arrive?". (waited ≠ consumed.)
      categoryIntelUsed: categoryConsumedNow,
      buyerIntelUsed: !!requirementBrain,
      conversationalSignalsUsed: conv,
    });
    const gradeColor = sc.grade === 'A' ? 'text-emerald-700' : sc.grade === 'B' ? 'text-teal-700' : sc.grade === 'C' ? 'text-amber-700' : 'text-red-600';
    return (
      <div className="border border-slate-300 bg-slate-50 rounded-xl p-3 text-[11px] text-slate-800 space-y-0.5">
        <p className="font-bold">🧾 RFQ Decision Audit — is the intelligence helping? <span className={gradeColor}>{sc.grade} · {sc.confidence}%</span></p>
        {sc.lines.map((l, i) => <p key={i} className="text-slate-600">• {l}</p>)}
        <p className="text-slate-400">utilization = facts used ÷ known · category intel is an enhancer (last 20–30%), NOT a gate — note this scores even while category is “{categoryStatus}”.</p>
      </div>
    );
  };

  // 🎓 RFQ EVALS — the quality layer (was this GOOD?), distinct from the harnesses (is it CORRECT?)
  // and the scorecard (did intelligence get USED?). Scores Question / Category / Fusion / Planner
  // quality so a "valid but mediocre" RFQ can't hide. Live + window.__rfqEval for over-time tracking.
  const renderEvals = () => {
    const llmQs = dynQuestions.filter((q) => q.source === 'llm');
    if (!reqPlan && !llmQs.length && categoryStatus !== 'hit') return null;
    const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC).filter(Boolean);
    const qq = questionQualityEval({ questions: llmQs.map((q) => ({ label: q.label, grounded: !!(q.groundedIn || q.reason), optionCount: (q.options || []).length, tier: q.tier })), specNames, maxCards: 3 });
    // INTENT QUALITY — scores the first-page decision off deriveIntent's self-ranked candidates (specificity + margin + alignment).
    const iq = intentQualityEval({ chosen: requirementIntent?.value || null, candidates: intentCandidatesRef.current || [] });
    const cq = categoryQualityEval(categoryConf.score, categoryConf.band);
    const fusionFired = categoryConf.fuse && categoryConsumed.applications.length > 0;
    const buyerHasOperation = !!(buyerProfile?.persona || buyerTwin?.layer_a_identity?.business_type || requirementBrain);
    const fq = fusionQualityEval({ band: categoryConf.band, fusionFired, buyerHasOperation });
    const groundedQ = llmQs.filter((q) => !!(q.groundedIn || q.reason)).length;
    const pq = plannerQualityEval({ archetype: reqPlan?.archetype, hasLead: !!reqPlan?.lead, mustHaveCount: reqPlan?.mustHaveSpecs?.length || 0, questionCount: llmQs.length, groundedQuestions: groundedQ });
    const ev = evaluateRFQ([qq, iq, cq, fq, pq]);
    // BUSINESS EVALS (proxy / leading indicators) — "is this a good RFQ / lead?", from the RFQ shape.
    const mustHaves = reqPlan?.mustHaveSpecs || [];
    const mustFilled = mustHaves.filter((s) => (form.dynamicSpecs[s] || '').trim() || coverage.current.isCovered(s)).length;
    const openConf = contradictions.filter((n) => !nudgeAnswers[n.type]).length;
    const verified = !!buyerTwin?.layer_a_identity?.verified;
    const isBiz = /business|manufactur|trader|retail|resell|distributor|wholesal/i.test(`${buyerProfile?.persona || ''} ${form.buyerType || ''}`);
    const engagement = Math.round((buyerTwin?.twin_confidence?.overall_score ?? 0) / 10);
    const rq = rfqQualityEval({ mustHaveTotal: mustHaves.length, mustHaveFilled: mustFilled, hasQuantity: !!String(form.quantity || '').trim(), hasIntent: !!requirementIntent?.value, hasLocation: !!(form.deliveryLocation || '').trim(), identityVerified: verified, openContradictions: openConf });
    const lq = leadQualityEval({ identityVerified: verified, hasCompany: isBiz, hasGST: form.gstRegistered === true, maturity: buyerProfile?.maturity || '', intentLocked: !!requirementIntent?.locked, engagementSignals: engagement });
    // OUTCOME (predicted, leading) — grounded in the buyer's real deal_readiness (a PNS 'behavior' fact).
    const dealReadiness = resolvedRequirement.registryFacts.find((f) => /deal.?readiness/i.test(f.key || ''))?.value;
    const rfqComplete = mustHaves.length > 0 && mustFilled >= mustHaves.length;
    const oc = outcomeEval({ dealReadiness, rfqComplete, openBlockers: openConf, buyerEngagement: engagement, intentLocked: !!requirementIntent?.locked });
    const bizEv = evaluateRFQ([rq, lq, oc]);
    (window as unknown as { __rfqEval?: unknown }).__rfqEval = { system: ev, business: bizEv };
    // EVAL-OVER-TIME: persist this run once per distinct eval state (drift visible across versions).
    const logSig = `${ev.pct}:${bizEv.pct}:${step}:${form.productName}`;
    if (step >= 1 && evalLogSig.current !== logSig) {
      evalLogSig.current = logSig;
      pushEvalRun({ ts: Date.now(), product: form.productName, promptsVersion: PROMPTS_VERSION, systemPct: ev.pct, businessPct: bizEv.pct, outcomeScore: oc.score, categoryBand: categoryConf.band });
    }
    const trend = evalTrend(getEvalRuns());
    const gradeC = (g: string) => g === 'A' ? 'text-emerald-700' : g === 'B' ? 'text-teal-700' : g === 'C' ? 'text-amber-700' : 'text-red-600';
    const dimRow = (d: { name: string; score: number; max: number; note: string }) => { const dc = d.score >= d.max * 0.8 ? 'text-emerald-700' : d.score >= d.max * 0.5 ? 'text-amber-700' : 'text-red-600'; return <p key={d.name}>• <b>{d.name}</b> <span className={dc}>{d.score}/{d.max}</span> — {d.note}</p>; };
    return (
      <div className="border border-indigo-300 bg-indigo-50 rounded-xl p-3 text-[11px] text-indigo-900 space-y-0.5">
        <p className="font-bold">🎓 RFQ Evals — SYSTEM quality (was it GOOD?), not regression <span className={gradeC(ev.grade)}>{ev.grade} · {ev.pct}%</span></p>
        {ev.dimensions.map(dimRow)}
        {ev.issues.length ? <p className="text-red-600">⚠ {ev.issues.length} dimension(s) below bar — the eval catches “valid but mediocre” that the harness passes</p> : <p className="text-emerald-700">✓ all dimensions above bar</p>}
        <p className="font-bold pt-1">📈 BUSINESS evals — leading indicators + grounded outcome <span className={gradeC(bizEv.grade)}>{bizEv.grade} · {bizEv.pct}%</span></p>
        {bizEv.dimensions.map(dimRow)}
        {trend.runs > 1 ? <p className="font-semibold pt-1">📉 Eval-over-time: {trend.runs} runs @ {PROMPTS_VERSION} · avg system {trend.avgSystem}% · business {trend.avgBusiness}% · drift {trend.systemDelta >= 0 ? '+' : ''}{trend.systemDelta} · <span className={trend.regression ? 'text-red-600' : 'text-emerald-700'}>{trend.regression ? '⚠ version regression' : 'stable'}</span></p> : null}
        <p className="text-indigo-400">RFQ/Lead Quality = leading indicators (RFQ shape) · Outcome = predicted from real deal_readiness (PNS) — NOT a measured post-RFQ outcome (needs seller-response/conversion pipeline). window.__rfqEval · window.__evalLog</p>
      </div>
    );
  };

  // 📋 NODE LOGS — per-module input · output · latency · confidence (the LangSmith-grade log layer
  // that was missing). Unifies moduleTrace (latency) + the live state (in/out/confidence) + the LLM
  // call health (model · ms · bytes · ok). Answers "what did each node receive, return, and how long".
  const renderNodeLogs = () => {
    const mt = moduleTrace.current;
    const llm = getLLMHealth();
    const lat = (e?: { start?: number; done?: number }) => (e?.start != null && e?.done != null ? `${((e.done - e.start) / 1000).toFixed(1)}s` : e?.start != null ? '…running' : '—');
    const facts = resolvedRequirement.registryFacts.length;
    const llmQs = dynQuestions.filter((q) => q.source === 'llm').length;
    const nodes = [
      { name: 'Buyer Brain', input: 'glid pull', output: `${buyerProfile?.persona || enrichment?.persona?.type || '?'} · ${facts} facts`, conf: buyerTwin?.twin_confidence?.overall_score, lat: lat(mt.buyer) },
      { name: 'MCAT resolve', input: form.productName || '—', output: form.mcatId || '(unresolved)', conf: undefined as number | undefined, lat: lat(mt.mcat) },
      { name: 'Category Brain', input: `mcat ${form.mcatId || '—'}`, output: `${categorySellerQs().length} criticals · ${categoryConf.band} · ${categoryIntel ? ((categoryIntel as Record<string, unknown>).category_confidence ? 'distill-v15+' : 'distill-pre-v15') : 'no-build'}`, conf: categoryConf.score, lat: lat(mt.category) },
      { name: 'Planner', input: 'product + twin + category', output: `${reqPlan?.archetype || '—'} · ${llmQs} cards`, conf: undefined as number | undefined, lat: lat(mt.planner) },
    ].filter((n) => n.lat !== '—');
    if (!nodes.length && !llm.length) return null;
    // Cost/token roll-up (ChatGPT C): tokens + est USD across all LLM calls, + category cache hit/miss.
    const totTok = llm.reduce((s, c) => s + (c.promptTokens || 0) + (c.completionTokens || 0), 0);
    const totReason = llm.reduce((s, c) => s + (c.reasoningTokens || 0), 0);
    const totCost = llm.reduce((s, c) => s + (c.costUsd || 0), 0);
    const cacheState = categoryStatus === 'hit' ? 'HIT' : categoryStatus === 'building' ? 'MISS (building)' : categoryStatus === 'error' ? 'ERROR' : categoryStatus;
    (window as unknown as { __nodeLogs?: unknown }).__nodeLogs = { nodes, llm, totals: { tokens: totTok, reasoningTokens: totReason, costUsd: totCost, calls: llm.length, categoryCache: cacheState } };
    return (
      <div className="border border-slate-400 bg-white rounded-xl p-3 text-[11px] text-slate-800 space-y-0.5">
        <p className="font-bold">📋 Node Logs — input · output · latency · confidence</p>
        {nodes.map((n) => <p key={n.name}>• <b>{n.name}</b> · {n.lat} · in: {n.input} · out: {n.output}{n.conf != null ? ` · conf ${n.conf}` : ''}</p>)}
        <p className="font-semibold pt-1">💰 Totals: {llm.length} LLM calls · {totTok.toLocaleString()} tokens{totReason ? ` (${totReason.toLocaleString()} reasoning)` : ''} · ~${totCost.toFixed(4)} · category cache: {cacheState}</p>
        <p className="font-semibold pt-1">LLM calls ({llm.length}) — label@version · model · latency · tokens(in→out) · ~cost</p>
        {llm.slice(-12).map((c, i) => <p key={i} className={c.ok ? '' : 'text-red-600'}>• {c.label}<span className="text-slate-400">@{c.promptVersion || '?'}</span> · {(c.model || '').replace('google/', '')} · {c.ms}ms · {(c.promptTokens || 0)}→{(c.completionTokens || 0)}tok{c.reasoningTokens ? ` (${c.reasoningTokens}r)` : ''} · ~${(c.costUsd || 0).toFixed(4)} · {c.ok ? 'ok' : 'FAIL ' + c.status}</p>)}
        {llm.length === 0 ? <p className="text-slate-400">— no LLM calls yet</p> : null}
        <p className="text-slate-400">rates approx (relative cost, not billing) · window.__nodeLogs · window.__llmHealth</p>
      </div>
    );
  };

  const renderOptionProvenance = () => {
    const qs = dynQuestions.filter((q) => q.source === 'llm');
    if (!qs.length && !reqPlan && !repostSource) return null;
    return (
      <div className="border border-violet-200 bg-violet-50 rounded-xl p-3 text-[11px] text-violet-900 space-y-1">
        <p className="font-bold">🧭 Option Provenance — non-spec questions must derive from the registry (A1)</p>
        {(() => { const rm = requirementMode(); return <p className="text-violet-700">🧠 Requirement Mode (R): <b>{rm.mode}</b> · payment-lean <b>{rm.paymentLean}</b> <span className="text-violet-400">— {rm.descriptor || 'awaiting qty/intent'} · EPHEMERAL (this order only; persona is a prior, not the driver)</span></p>; })()}
        {/* The governance engines (Transfer · Consumption · Consistency · Completeness · Procurement) — shown HERE on the spec page where the product context exists (they're current-requirement signals). */}
        {(() => { const td = transferDecision(); if (!td.transfer.length && !td.withhold.length) return null; const byTier = (t: string) => td.transfer.filter((i) => i.tier === t).length; const c = consume(td.transfer, { archetype: reqPlan?.archetype, orderScale: classifyOrderScale(form.quantity, form.unit).band }); return (<>
          <p className="text-sky-700">🧠 Transfer: relatedness <b>{td.relatedness}/100</b> → {td.categoryTransfers ? 'category intel CARRIES' : 'category intel WITHHELD'} · carries A:{byTier('A')} B:{byTier('B')} C:{byTier('C')} · {td.withhold.filter((i) => i.tier === 'D').length} product-specs never portable</p>
          <p className="text-teal-700">🎚 Consumption: process <b>{c.processMatters ? 'MATTERS' : 'minimal'}</b> → drivers [{c.drivers.map((d) => d.key.replace(/^(history|theme):\s*/, '')).slice(0, 6).join(', ') || 'none'}] · quiet [{c.quiet.map((q) => q.key.replace(/^(history|theme):\s*/, '')).join(', ') || 'none'}]</p>
        </>); })()}
        {(() => { const rm2 = requirementMode(); const conflicts = checkConsistency({ buyerKind: page1Choice, buyerType: canonicalBuyerType(), journey: requirementIntent?.journey, orderScaleBand: classifyOrderScale(form.quantity, form.unit).band, orderScaleImplication: coverage.current.coveredBy('order scale')?.value || '', requirementMode: rm2.mode, paymentLean: rm2.paymentLean, installation: coverage.current.coveredBy('installation support')?.value || '' }); return <p className={conflicts.length ? 'text-red-600' : 'text-emerald-600'}>🧪 Consistency: {conflicts.length ? `${conflicts.length} CONFLICT — ${conflicts.map((cf) => cf.a + ' ✕ ' + cf.b).join(' · ')}` : '✓ facts coexist'}</p>; })()}
        {(() => { const comp = scoreCompleteness({ mustHaveSpecs: reqPlan?.mustHaveSpecs || [], allSpecNames: isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC), isFilled: (n) => !!(form.dynamicSpecs[n] || '').trim() || coverage.current.isCovered(n), hasQuantity: !!(form.quantity || '').trim(), hasIntent: !!(requirementIntent?.value || '').trim() || coverage.current.isCovered('intent') }); return <p className={comp.sellerReady ? 'text-emerald-700' : 'text-orange-600'}>📊 Completeness: <b>{comp.pct}%</b> {comp.sellerReady ? '✓ seller-ready — STOP asking' : `· still needed: ${comp.missingRequired.join(', ')}`} · {comp.optional.length} optional</p>; })()}
        {(() => { const pc = classifyProcurement({ nature: buyerProfile?.nature, authorityRole: buyerProfile?.authorityRole, journey: requirementIntent?.journey || undefined, intentText: requirementIntent?.value || undefined, orderScaleBand: classifyOrderScale(form.quantity, form.unit).band, requirementMode: requirementMode().mode }); if (pc.context === 'unknown') return null; return <p className="text-amber-700">🏷 Procurement: <b>{pc.label}</b> · GST {pc.implications.gstLikely ? 'needed' : 'not needed'} · approval: {pc.implications.approvalFlow}</p>; })()}
        {(() => { const rb = resolvedRequirement; if (!requirementBrain) return <p className="text-fuchsia-400">🧩 Requirement Brain (n8n v12): not in this pull — resolver wired & degrading to planner order. Deploy v12 to feed it.</p>; return <p className="text-fuchsia-700">🧩 Requirement Brain: {rb.criticalRanked.length} category criticals · ask [{rb.ask.slice(0, 6).join(', ') || 'none'}]{rb.knownDropped.length ? <> · <span className="text-emerald-700">NOT asking (known): {rb.knownDropped.join(', ')}</span></> : ''}{rb.addedSpecs.length ? ` · +added: ${rb.addedSpecs.join(', ')}` : ''}{rb.knownInSchema.length ? <> · <span className="text-emerald-700">reuse {rb.knownInSchema.length} known (no category needed): {rb.knownInSchema.join(', ')}</span></> : ''} · {rb.registryFacts.length} facts · <span className={categoryStatus === 'hit' ? 'text-emerald-700' : categoryStatus === 'building' ? 'text-indigo-600' : 'text-fuchsia-400'}>category {categoryStatus}</span></p>; })()}
        {convSignals.signals.length ? <p className="text-rose-700">💬 Conversational ({convSignals.signals.length}): {formatConvSignals(convSignals)}{convSignals.locationPreference ? <> · <span className="font-semibold">location pref: {convSignals.locationPreference}</span></> : ''}</p> : null}
        {repostSource && (() => { const ms = Object.values(repostMeta); const matched = ms.filter((m) => !m.custom).length; const custom = ms.filter((m) => m.custom).length; return <p className="text-teal-700">🔁 Re-post (P): <b>{repostSource.title}</b> from {agoLabel(repostSource.recencyDays)} · {matched} spec{matched === 1 ? '' : 's'} prefilled + {custom} drift-added · intent SKIPPED · cadence=recurring (History, auth 75)</p>; })()}
        <p className="text-violet-500">Spec fields + their options = IndiaMART ISQ API [exempt]. EVERY other question/chip must be grounded in qty / category / profile / history.</p>
        {qs.length ? qs.map((q) => (
          <p key={q.id}>
            {q.groundedIn ? '🟢' : '🔴'} <b>{q.label}</b>
            {q.options?.length ? <span className="text-violet-400"> [{q.options.slice(0, 4).join(' · ')}]</span> : null}
            {' — '}
            {q.groundedIn ? <span className="text-emerald-700">grounded: {q.groundedIn}</span> : <span className="text-red-600">⚠ UNGROUNDED — should have been dropped</span>}
          </p>
        )) : <p className="text-violet-400">No planner questions surfaced (e.g. a tiny commodity order → budget/scale correctly suppressed by A0).</p>}
      </div>
    );
  };

  // Run World/OSINT via the REAL Firecrawl web search — fired post-product so the query carries the
  // richest anchors (company/name + city + industry). Returns traceable source URLs, never a fabricated
  // profile. A wired window.__osintProvider would override it with a different backend.
  const runWorldDemo = async () => {
    const b = enrichment?.buyer;
    const seed: ExternalSeed = {
      mobile: b?.mobile,
      companyName: b?.companyName || (form.additionalDetails || '').trim() || undefined,
      gstin: b?.gst,
      udyam: b?.udyam,
      website: b?.website,
      name: b?.fullName || b?.firstName,
      city: b?.city || enrichment?.cslCity,
      industry: (form.productName || '').trim() || undefined, // product = a disambiguating anchor for OSINT
      glid: enrichment?.glid || glidInput || undefined,
    };
    try {
      const wp = (window as unknown as { __osintProvider?: (s: ExternalSeed) => Promise<WorldOsint> }).__osintProvider;
      const res = await runExternal(seed, { nowIso: new Date().toISOString(), osintFn: typeof wp === 'function' ? wp : firecrawlOsint });
      setExternal(res);
      const w = window as unknown as { __ebi?: unknown; __externalSeed?: unknown };
      w.__ebi = { externalEvidenceLedger: res.externalEvidenceLedger, sources: res.sources, gate: res.gate, ran_at: res.ranAt, crossValidation: res.crossValidation };
      w.__externalSeed = seed;
      track('rfq_world_demo_run', { hasCompany: !!seed.companyName });
    } catch { /* no-op */ }
  };
  const renderExternalPullHealth = () => {
    const demoBtn = (
      <button type="button" onClick={runWorldDemo} className="rounded-full border border-fuchsia-300 px-2 py-0.5 text-fuchsia-700 hover:bg-fuchsia-100 font-medium">▶ Run World search (Firecrawl)</button>
    );
    if (!external) {
      return (
        <div className="border border-fuchsia-200 bg-fuchsia-50 rounded-xl p-3 text-[11px] text-fuchsia-900 space-y-1">
          <p className="font-bold">🌐 External Pull Health — Befisc · Sign3 · World</p>
          <p className="text-fuchsia-600">No external run yet. {demoBtn} <span className="text-fuchsia-400">— REAL web search via Firecrawl (proxied, key server-side); returns traceable source URLs. Override with <b>window.__osintProvider</b> for a different backend.</span></p>
        </div>
      );
    }
    const ICON: Record<string, string> = { ok: '🟢', no_record: '🟡', failed: '🔴', creds_pending: '⏸', skipped_low_confidence: '⏭', not_run: '⏸', blocked: '🔒' };
    const LABEL: Record<string, string> = {
      ok: '✓ ok', no_record: '∅ ran · nothing found', failed: '✗ failed', creds_pending: 'creds pending (Part C — add env keys)',
      skipped_low_confidence: 'skipped — low-confidence anchor (anti-bogus)', not_run: 'not run', blocked: '🔒 creds rejected',
    };
    const sd = external.seed;
    const seedBits = [sd.mobile && `mobile ${sd.mobile}`, sd.companyName && `company "${sd.companyName}"`, sd.gstin && `GST ${sd.gstin}`, sd.website, sd.city].filter(Boolean).join(' · ') || '—';
    return (
      <div className="border border-fuchsia-200 bg-fuchsia-50 rounded-xl p-3 text-[11px] text-fuchsia-900 space-y-1">
        <p className="font-bold flex items-center gap-2 flex-wrap">🌐 External Pull Health — Befisc · Sign3 · World (status · latency · anchor) {demoBtn}</p>
        <p className="text-fuchsia-600">seed: {seedBits}</p>
        <p>OSINT gate: <b className={external.gate.osintEligible ? 'text-emerald-700' : 'text-amber-600'}>{external.gate.osintEligible ? `eligible (${external.gate.strongest})` : `skipped (${external.gate.strongest})`}</b> — {external.gate.reason}</p>
        {external.crossValidation && external.crossValidation.facts.length > 0 && (
          <div className="mt-1 pt-1 border-t border-fuchsia-200">
            <p className="font-semibold">🔗 P4 Cross-validation (agreement ladder = confidence):</p>
            {external.crossValidation.facts.map((f, i) => (
              <p key={i} className={f.tier === 'verified' ? 'text-emerald-700' : f.tier === 'corroborated' ? 'text-amber-700' : 'text-fuchsia-600'}>
                {f.tier === 'verified' ? '✅' : f.tier === 'corroborated' ? '🤝' : '•'} <b>{f.key}</b> = {f.value} — {f.agreement}× [{f.sources.join(' + ')}] → <b>{f.tier}</b> · conf {f.confidence}{f.tier === 'verified' && /^(company|city)$/.test(f.key) ? ' · → Registry Verified ✓' : ''}
              </p>
            ))}
            <p className="text-fuchsia-400">1 source = observed · 2 = corroborated · 3+ = Verified. Business facts (company/city) at Verified graduate into the Coverage Registry; personal identity (name/email/pan) stays observed-only.</p>
          </div>
        )}
        {external.sources.map((src) => {
          // "show what we got": curated fields from each OK source. Observed-only (never planning).
          const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});
          const s = (x: unknown) => (x == null ? '' : String(x));
          const v = obj(src.value);
          let detail: import('react').ReactNode = null;
          if (src.status === 'ok' && src.source === 'Befisc') {
            const pi = obj(v.personal_information); const docs = obj(v.document_data);
            const pan = Array.isArray(docs.pan) && docs.pan.length ? s(obj((docs.pan as unknown[])[0]).value) : '';
            const alt = Array.isArray(v.alternate_phone) ? (v.alternate_phone as unknown[]).length : 0;
            const emails = Array.isArray(v.email) ? (v.email as unknown[]).map((e) => s(obj(e).value)).filter(Boolean) : [];
            const a0 = Array.isArray(v.address) && v.address.length ? obj((v.address as unknown[])[0]) : {};
            const bits = [s(pi.full_name) && `name ${s(pi.full_name)}`, s(pi.gender), s(pi.age) && `age ${s(pi.age)}`, s(pi.date_of_birth) && `dob ${s(pi.date_of_birth)}`, s(pi.income) && `income ₹${s(pi.income)}`, pan && `PAN ${pan}`, alt ? `+${alt} alt phone(s)` : '', emails.length ? `email ${emails[0]}` : '', (s(a0.state) || s(a0.pincode)) ? `addr ${[s(a0.detailed_address), s(a0.state), s(a0.pincode)].filter(Boolean).join(', ')}` : ''].filter(Boolean).join(' · ');
            detail = bits ? <span className="block ml-4 text-fuchsia-700 break-words">↳ {bits}</span> : null;
          } else if (src.status === 'ok' && src.source === 'Sign3') {
            const pdRoot = obj(v.phone_data); const pd = obj(pdRoot.primary_data); const meta = obj(pd.phone_meta);
            const ld = obj(pdRoot.linked_data); const br = obj(ld.breach_details); const accts = obj(pd.account_details);
            const platforms = Object.entries(accts).filter(([, x]) => obj(x).user_exist === true).map(([k]) => k);
            const bits = [s(pd.social_profile_count) && `${s(pd.social_profile_count)} social profiles`, s(meta.operator) && `operator ${s(meta.operator)}`, s(br.number_of_breaches) ? `${s(br.number_of_breaches)} breach(es)` : '', s(ld.key) ? `linked ${s(ld.key)}` : '', platforms.length ? `on: ${platforms.slice(0, 8).join(', ')}` : ''].filter(Boolean).join(' · ');
            detail = bits ? <span className="block ml-4 text-fuchsia-700 break-words">↳ {bits}</span> : null;
          }
          return (
            <div key={src.source}>
              <p>
                {ICON[src.status] || '·'} <b>{src.source}</b> <span className="text-fuchsia-400">({src.tier})</span> — {LABEL[src.status] || src.status}
                {src.ms ? ` · ${src.ms}ms` : ''}{src.anchor ? ` · via ${src.anchor}` : ''}{src.confidence != null ? ` · conf ${src.confidence}` : ''}
                {src.detail ? <span className="text-fuchsia-500"> — {src.detail}</span> : ''}
                {src.status === 'ok' && src.source === 'World' && !!(src.value as { summary?: string })?.summary ? <span className="text-emerald-700"> → “{String((src.value as { summary?: string }).summary).slice(0, 120)}”</span> : null}
                {src.source === 'World' && Array.isArray((src.value as { match_basis?: string[] })?.match_basis) && (src.value as { match_basis?: string[] }).match_basis!.length ? <span className="text-fuchsia-500"> · matched on: [{(src.value as { match_basis: string[] }).match_basis.join(', ')}]</span> : null}
              </p>
              {detail}
            </div>
          );
        })}
        {(() => { const verified = (() => { try { return (coverage.current.facts() || []).filter((f) => f.source === 'Verified'); } catch { return []; } })(); return verified.length ? (
          <p className="text-emerald-700">↪ STITCHED INTO THE ENGINE: {verified.length} Verified fact(s) recorded from external → fed the planner + Truth Table (Used-By: YES). {verified.slice(0, 3).map((f) => `${f.rawKey}=${f.value}`).join(' · ')}</p>
        ) : (
          <p className="text-fuchsia-400">No Verified external facts recorded yet — run World (demo) above, or wire a real provider.</p>
        ); })()}
        <p className="text-fuchsia-400">Stitch rule: ONLY structured government-grade truths (GST/HSN/Udyam/NIC, anti-bogus-gated) → recorded as <b>Verified</b> facts → feed the planner/Truth-Table. <b>World/OSINT + Befisc/Sign3 identity stay OBSERVED-only</b> (shown here, NOT a planning input) — a web match on a generic name could be the wrong company; World graduates to Verified only once confidence-scored (post-pilot). mobile→GST→HSN chain (Part C). World now runs a REAL Firecrawl web search by default (traceable source URLs); window.__osintProvider can override it with another backend.</p>
      </div>
    );
  };

  // ── P4: Decision Timeline — the chronological story, replayed from window.dataLayer ──
  // No new plumbing: track() already stamps every funnel event with ts + glid + bl_id.
  // Reads them back in order so an HOD can narrate pull → twin → gate → user → submit.
  const renderDecisionTimeline = () => {
    const dl = (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer;
    if (!Array.isArray(dl) || !dl.length) return null;
    const s = (v: unknown) => (v == null ? '' : String(v));
    const LABELS: Record<string, (d: Record<string, unknown>) => string> = {
      rfq_modal_open: () => '📂 Modal opened',
      rfq_product_committed: (d) => `📦 Product committed: ${s(d.product) || s(d.productName)}`,
      rfq_buylead_minted: (d) => `🆔 BuyLead minted · bl_id ${s(d.bl_id)}`,
      rfq_enrichment: (d) => `🗂️ GLID enriched · ${s(d.categories)} categories · persona ${s(d.persona) || '—'}`,
      rfq_buyer_profile: (d) => `🧬 Buyer profile derived · ${s(d.persona)} · persona-fit ${Math.round((Number(d.confidence) || 0) * 100)}%`,
      rfq_buyer_twin: (d) => `🧬 Buyer Twin built · evidence-volume ${s(d.score)}/100`,
      concierge_impression: () => '🤝 Concierge "we remember you" shown',
      rfq_replanned: (d) => `🔄 Re-planned after: ${s(d.after)}`,
      rfq_gate_blocked: (d) => `🔒 Gate blocked ${s(d.field)} (${s(d.reason)})`,
      rfq_completed: () => '✅ RFQ submitted',
    };
    const t0 = Number(dl.find((d) => d.ts)?.ts) || 0;
    const rows = dl.filter((d) => LABELS[s(d.event)]).map((d) => ({
      label: LABELS[s(d.event)](d),
      dt: Number(d.ts) && t0 ? `+${((Number(d.ts) - t0) / 1000).toFixed(1)}s` : '',
      bl: s(d.bl_id),
    }));
    if (!rows.length) return null;
    return (
      <div className="border border-cyan-200 bg-cyan-50 rounded-xl p-3 text-[11px] text-cyan-900">
        <p className="font-bold mb-1">🕓 Decision Timeline ({rows.length} events · every step carries glid + bl_id)</p>
        <ol className="space-y-0.5">
          {rows.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-cyan-400 tabular-nums w-12 shrink-0">{r.dt}</span>
              <span className="flex-1">{r.label}</span>
              {r.bl ? <span className="text-cyan-400 shrink-0">bl {r.bl.slice(-6)}</span> : null}
            </li>
          ))}
        </ol>
        <p className="text-cyan-400 mt-1">source: window.dataLayer</p>
      </div>
    );
  };

  // ── Buyer Intelligence Dossier — ONE consolidated HOD view (assembly of existing data) ──
  // Six sections: Internal Truths · Verified Business Truths · Current Requirement ·
  // Contradictions · Missing Data · Used-By matrix. Fact-oriented; the detailed panels
  // below remain as drill-downs. No new logic — reuses enrichment / registry / twin / __ebi.
  const renderBuyerDossier = () => {
    if (!form.productName.trim()) return null;
    const arr = Array.isArray(enrichmentRaw) ? (enrichmentRaw as Array<Record<string, unknown>>) : [];
    const get = (k: string) => { const o = arr.find((x) => x && x[k] !== undefined); let v: unknown = o ? o[k] : undefined; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } } return v; };
    const cnt = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v as object).length : v ? 1 : 0);
    const s = (v: unknown) => (v == null ? '' : String(v));
    const bpv = get('buyer_profile'); const bp = (Array.isArray(bpv) ? bpv[0] : bpv) as Record<string, unknown> | undefined;
    const profileFailed = !!bp && profileMissing(bp);
    const eb = enrichment?.evidenceBase;
    const { mobile, debugInjected: mobileInjected } = resolveMobile(bp);
    const gst = profileVal(bp, ['glusr_usr_gst', 'gstin', 'gst']);
    const internal: Array<[string, number]> = arr.length ? [
      ['PNS', cnt(get('pns_data'))], ['WhatsApp', cnt(get('whatsapp_data')) + waInboundCount(get('whatsapp_inbound')).count],
      ['Prev BL', cnt(get('prev_bl_data'))], ['Prev ISQ', cnt(get('prev_isq_data'))], ['CSL', cnt(get('csl_data'))],
    ] : [];
    const ebi = (window as unknown as { __ebi?: { externalEvidenceLedger?: Array<Record<string, unknown>> } }).__ebi;
    const ext = ebi?.externalEvidenceLedger || [];
    // Contradictions: (a) internal history × external keywords, (b) Twin × current product (off-profile),
    // (c) registry overrides (Twin guessed, user corrected).
    const cats = (enrichment?.categories || []).map((c) => s(c.mcat)).filter(Boolean);
    const offP = offProfileNow(); // A3: twin history AND enrichment categories both miss
    const overrides = coverage.current.facts().filter((f) => f.status === 'overridden');
    const contradictions: string[] = [];
    if (offP) contradictions.push(`Twin history (${cats.slice(0, 2).join(', ') || 'prior cats'}) ✕ current product "${form.productName}" → OFF-PROFILE (discovery)`);
    overrides.forEach((f) => contradictions.push(`${f.concept}: "${f.value}" (${f.source}) → overridden by a higher-authority answer`));
    // Missing data
    const gaps: string[] = [];
    if (profileFailed) gaps.push(`buyer_profile not returned (${profileFailReason(bp)})${mobileInjected ? ` — using debug mobile ${mobile} to exercise the external chain` : ' → no name/mobile/GST'}`);
    else if (arr.length && !mobile) gaps.push('no mobile on profile → external lookups blocked');
    if (arr.length && !gst && !ext.length) gaps.push('no GST/HSN → no verified business domain');
    if (!ext.length) gaps.push('Verified Business Truths not wired (sandbox)');
    if (!arr.length) gaps.push('no GLID pulled → cold (no internal history)');
    const ri = requirementIntent;
    const Sec = 'mt-1.5';
    return (
      <div className="border-2 border-indigo-300 bg-white rounded-xl p-3 text-[11px] text-slate-800 space-y-1">
        <p className="font-bold text-sm text-indigo-900">🕵️ Buyer Intelligence Dossier</p>
        <div className={Sec}>
          <p className="font-semibold text-indigo-600">① Internal Truths <span className="text-emerald-600 font-normal">· used by Twin: YES</span></p>
          {internal.length ? <p>{internal.map(([k, n]) => `${k}(${n})`).join(' · ')}{eb ? ` · evidence: ${[eb.bls_created && eb.bls_created + ' BLs', eb.whatsapp_events && eb.whatsapp_events + ' WA', eb.csl_events && eb.csl_events + ' CSL'].filter(Boolean).join(', ')}` : ''}</p> : <p className="text-gray-400">— no GLID pulled (cold)</p>}
          {/* P2.1/P2.3: themes, not counts — what the buyer actually sources for (Twin clusters) */}
          {twinThemes().length > 0 && <p className="text-indigo-500">themes: <b>{twinThemes().join(' · ')}</b> <span className="text-indigo-300">(sources for — distilled from WA/CSL/BL, not raw counts)</span></p>}
          {/* P2.7 — BUYER STORY: the narrative arc across the category timeline (oldest → newest). SOFT signal. */}
          {trajectory.length >= 2 && (
            <p className="text-violet-600">🧭 Buyer Story: <b>{buyerStory?.arc || (trajectoryShape(enrichment?.categories || []) === 'repeat' ? 'Routine replenishment' : 'reading the journey…')}</b>
              {buyerStory?.story ? <span className="text-violet-500"> — {buyerStory.story}{typeof buyerStory.confidence === 'number' ? ` (conf ${buyerStory.confidence})` : ''}</span> : null}
              <span className="text-violet-300"> · timeline: {trajectory.map((t) => t.mcat).join(' → ')} · SOFT (explains an odd product, never a hard fact)</span>
            </p>
          )}
          {/* Transfer · Consumption · Consistency · Completeness · Procurement render on the SPEC page
              (renderOptionProvenance), where the product context they reason over actually exists — not in
              this pre-product staging dossier where they'd be product-less. (Chaos-test UX fix.) */}
        </div>
        <div className={Sec}>
          <p className="font-semibold text-fuchsia-600">② Verified Business Truths <span className="font-normal text-gray-400">· GST/HSN/Udyam/NIC/Website</span></p>
          {ext.length ? ext.map((e, i) => <p key={i}>🌐 {s(e.source)}: {s(e.value_summary) || s(e.key_used)} · used by Twin: {e.used_by_twin ? 'YES' : 'NO'}</p>) : <p className="text-fuchsia-500">not wired (sandbox) — Befisc Profile-Advance + World available; HSN/Udyam creds-blocked</p>}
        </div>
        <div className={Sec}>
          <p className="font-semibold text-teal-600">③ Current Requirement</p>
          <p>{form.productName} · qty {form.quantity || '1'} {form.unit || ''} · {page1Choice || 'kind ?'}{ri?.value ? ` · intent: ${ri.value} (journey ${ri.journey}, conf ${ri.confidence}${ri.locked ? ', 🔒' : ''})` : ri ? ' · intent: pending' : ''}{reqPlan ? ` · planner: ${reqPlan.archetype}/${reqPlan.orderMode}${reqPlan.twinMode && reqPlan.twinMode !== 'none' ? '/' + reqPlan.twinMode : ''}` : ''}</p>
          {/* P2.2: the single highest-value signal — surfaced, not buried in the BL list */}
          {(() => { const r = repeatSignal(); return r ? <p className="text-amber-700 font-medium">⚡ Repeat order — previously bought "{r.title}"{r.date ? ` (${r.date})` : ''} → likely replenishment</p> : null; })()}
        </div>
        <div className={Sec}>
          <p className="font-semibold text-rose-600">④ Contradictions{contradictions.length ? '' : ' — none'}</p>
          {contradictions.map((c, i) => <p key={i} className="text-rose-700">⚠ {c}</p>)}
        </div>
        <div className={Sec}>
          <p className="font-semibold text-amber-600">⑤ Missing Data{gaps.length ? '' : ' — none'}</p>
          {gaps.map((g, i) => <p key={i} className="text-amber-700">• {g}</p>)}
        </div>
        <div className={Sec}>
          <p className="font-semibold text-slate-600">⑥ Used By</p>
          <p>Internal (PNS/WA/BL/CSL/ISQ) → Twin <b className="text-emerald-700">YES</b> · Planner <b className="text-emerald-700">YES</b></p>
          <p>Requirement Intent → Planner <b className="text-emerald-700">YES</b> (seeds the plan)</p>
          <p>External (Befisc/Sign3/World) → Twin <b className="text-gray-500">NO</b> · Planner <b className="text-gray-500">NO</b> (observed-only)</p>
        </div>
      </div>
    );
  };

  // ── A6: the LIVE intent gate — the journey-adapted WHY question, asked FIRST ──
  // Answering it locks requirement_intent, records it to the registry (concept "intent",
  // source Intent → A5b hides any Application/Usage spec + de-dups the planner's own intent
  // question), and P6 re-ranks the specs for the answer. Always skippable.
  const answerIntent = (val: string) => {
    setRequirementIntent((prev) => (prev ? { ...prev, value: val, confidence: 100, source: 'buyer', locked: true } : prev));
    const ri = requirementIntent;
    // Cold buyer (no Twin to derive kind from): infer who's-buying from the chosen journey,
    // so segment/planner still get a kind signal now the explicit toggle is gone. Journey-based.
    if (!page1Choice && ri?.journey) {
      const j = ri.journey.toLowerCase();
      if (/personal|individual|home|consumer/.test(j)) { setPage1Choice('personal'); if (!form.buyerType) setField('buyerType', 'End User'); }
      else if (/retail|resale|industrial|project|maintenance|wholesale|trade|business/.test(j)) setPage1Choice('business');
    }
    // Record under the CANONICAL "intent" concept (via a stable synonym), NOT the LLM's
    // free-form question text — which may slug to its own concept and then fail to de-dup the
    // planner's own use-case/usage/application question (the double-ask we just saw). Folding
    // to "intent" lets A5b (coveredBy(...).source==='Intent') hide every redundant use question.
    coverage.current.record('primary use', val, 'Intent', 100);
    track('rfq_intent_answered', { value: val, journey: ri?.journey || 'unknown' });
  };
  // ── P0.5: smart spec-step progress — shown ONLY while the planner (the one genuine
  //    dependency for spec ORDER) is deciding. Background work (Twin/external/intent) never
  //    blocks. A reassurance checklist, not a blocking gear. ──
  // Phase A — orchestration loader. The spec/question page opens ONLY when the gate is READY; until
  // then this shows a truthful per-source checklist (what's done / pending / skipped). The buyer is
  // never stuck: WAITING_CATEGORY offers "Start anyway" (proceed now, re-rank when category lands).
  const renderSpecProgress = (gate: ReturnType<typeof plannerGate>, onStartAnyway: () => void) => (
    <div className="rounded-2xl border border-teal-200 bg-teal-50/60 p-5 space-y-2.5 animate-[fadeIn_0.3s_ease]" aria-busy="true">
      <p className="text-sm font-semibold text-gray-800">{gateHeadline(gate.status)}</p>
      <ul className="space-y-1.5 text-[13px] text-gray-600">
        {gate.checklist.filter((r) => r.state !== 'skip').map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            {r.state === 'done'
              ? <CheckCircle2 size={14} className="text-teal-500 shrink-0" />
              : <span className="inline-block w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin shrink-0" />}
            {r.label}
          </li>
        ))}
      </ul>
      {gate.status === 'WAITING_CATEGORY' && (
        <button type="button" onClick={onStartAnyway} className="text-[12px] font-medium text-teal-600 hover:text-teal-700 underline underline-offset-2">
          Start anyway — we'll sharpen as it loads →
        </button>
      )}
      {debug && (
        <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer select-none pt-1">
          <input type="checkbox" checked={freshCategory} onChange={(e) => setFreshCategory(e.target.checked)} className="accent-teal-600" />
          fresh build (force live category, wait for it) · {gate.status}
        </label>
      )}
    </div>
  );

  // ── P0.3: page-1 Twin-context note — folds the old "Welcome Back" concierge screen into
  //    one subtle line under the intent. Off-profile → discovery variant. "Not you?" reuses
  //    the discovery reset (onConciergeChanged). PII-free, never blocks. ──
  const renderPage1TwinNote = () => {
    const tw = ignoreTwin ? null : liveTwin();
    if (!tw) return null; // cold / no-Twin → nothing
    // INTELLIGENCE TRANSFER: we ALWAYS carry who-they-are + how-they-buy (Tier A/B); only their past
    // CATEGORIES (Tier C) are gated by relatedness. So we NEVER tell a known buyer "a new area for you" —
    // that is FALSE (their manufacturer identity still applies) and destroys trust. When the category
    // doesn't transfer, show an HONEST, quiet line (debug-only); never the old misleading one.
    const tDec = transferDecision();
    if (twinMuted.current || !tDec.categoryTransfers) {
      const carried = tDec.transfer.filter((i) => i.tier !== 'D').length;
      return debug && carried ? <p className="text-[11px] text-gray-400 mt-1.5">Carrying your buyer profile · {carried} fact{carried === 1 ? '' : 's'} still apply. This specific category looks new for you, so we'll tailor the specifics.</p> : null;
    }
    const repeat = repeatSignal(); // P2.2: RFQ-specific repeat-order signal beats a generic persona line
    const traits = conciergeTraits(tw).slice(0, 2);
    if (!repeat && !traits.length) return null; // Twin exists but nothing nameable → no note
    return (
      <p className="text-[11px] text-gray-400 mt-1.5">
        {repeat
          ? <>⚡ Looks like a repeat order — you bought <span className="text-gray-600 font-medium">{repeat.title}</span> before{repeat.date ? ` (${repeat.date})` : ''}.</>
          : <>Based on your history — {traits.join(' · ')}.</>}
        <button type="button" onClick={onConciergeChanged} className="ml-1.5 text-gray-500 underline underline-offset-2 hover:text-gray-700">Not you?</button>
      </p>
    );
  };

  // ── P0.4: who's-buying is AUTO-RESOLVED (no longer a question). Show it as a glanceable,
  //    confirmable note so a buyer can still correct it (e.g. a manufacturer buying gifts). ──
  const renderBuyerKindNote = () => {
    // V3 recovery: a role we DEDUCED (from the Twin/profile, or a spec the buyer picked) is shown
    // as a confirmable note — NEVER silently applied — so the buyer can correct it. "change" clears
    // it + flags manual, which re-opens the role card in the wizard and stops re-derivation.
    const deducedRole = !!form.buyerType && !!buyerTypeDeducedFrom && !buyerTypeManual.current
      && page1Choice !== 'personal' && !/individual|end[\s-]?user|personal|consumer/i.test(form.buyerType);
    if (deducedRole) {
      const fromLabel = buyerTypeDeducedFrom.includes('=') ? 'from your answer' : 'from your profile';
      return (
        <p className="text-[11px] text-gray-400 mt-3">
          Buying as <span className="font-medium text-gray-600">{form.buyerType}</span> <span className="text-gray-300">· {fromLabel}</span>
          <button type="button"
            onClick={() => { buyerTypeManual.current = true; setBuyerTypeDeducedFrom(''); setField('buyerType', ''); }}
            className="ml-1.5 text-gray-400 underline underline-offset-2 hover:text-gray-600">change</button>
        </p>
      );
    }
    if (!page1Choice) return null; // unknown/cold → the chosen intent journey infers it
    if (!debug) return null; // (#5) buyer-facing UI stays clean; the kind is auto-derived. Toggle is debug-only.
    const isBiz = page1Choice === 'business';
    return (
      <p className="text-[11px] text-gray-400 mt-3">
        Buying for <span className="font-medium text-gray-600">{isBiz ? 'business' : 'personal use'}</span>
        <button type="button"
          onClick={() => { const next = isBiz ? 'personal' : 'business'; setPage1Choice(next); setField('buyerType', next === 'personal' ? 'End User' : ''); }}
          className="ml-1.5 text-gray-400 underline underline-offset-2 hover:text-gray-600">switch to {isBiz ? 'personal' : 'business'}</button>
      </p>
    );
  };

  // ── P (Quick Re-post): "Buy again" cards on step 0. Once a GLID is pulled and the buyer has
  //    prior requirements, surface them as one-tap re-post cards (title · how long ago · #specs
  //    saved). Tapping runs handleRepost → prefill + fast-forward to the Re-post Review. Hidden
  //    once a re-post is in progress, and for cold buyers with no history. ──
  const agoLabel = (d?: number) =>
    d == null ? 'previously' : d < 1 ? 'today' : d < 30 ? `${d}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`;
  const renderRepostCards = () => {
    if (repostSource) return null; // already re-posting
    const prs = priorRequirements();
    if (!prs.length) return null;
    return (
      <div className="mt-4">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">🔁 Buy again — your past requirements</label>
        {/* Horizontal CAROUSEL — a long vertical list doesn't fit mSite; fixed-width cards scroll-snap.
            Each card carries the title, age + spec count, and a couple of saved spec values for context. */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {prs.map((pr, i) => {
            const specHints = Object.entries(pr.specs).slice(0, 2).map(([k, v]) => `${k}: ${v}`);
            return (
              <button
                key={pr.title + i}
                type="button"
                onClick={() => handleRepost(pr)}
                className="snap-start shrink-0 w-[200px] text-left rounded-xl border border-teal-200 bg-teal-50/40 hover:bg-teal-50 hover:border-teal-300 px-3 py-2.5 transition-colors flex flex-col"
              >
                <span className="font-semibold text-sm text-gray-800 leading-snug line-clamp-2">{pr.title}</span>
                <span className="text-[11px] text-gray-500 mt-1">
                  {agoLabel(pr.recencyDays)}{pr.specCount ? ` · ${pr.specCount} spec${pr.specCount > 1 ? 's' : ''}` : ''}
                </span>
                {specHints.length ? <span className="text-[10px] text-teal-700/80 mt-1 line-clamp-2">{specHints.join(' · ')}</span> : null}
                <span className="mt-auto pt-1.5 text-[11px] text-teal-700 font-semibold">Re-post →</span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">← swipe · tap to re-post — we’ll prefill what you told us last time, you just review &amp; post.</p>
      </div>
    );
  };

  // ── Page-1 Intent hero — the WHY question (Twin-inspired chips), REPLACING the old
  //    business/personal toggle. Shimmer while deriveIntent lands (a real dependency);
  //    compact once answered; skippable — never blocks Continue. ──
  const renderPage1Intent = () => {
    const ri = requirementIntent;
    const engineLive = QUESTION_ENGINE && hasGeminiKey();
    // answered → compact confirmation + a "change" affordance
    if (ri && ri.value) {
      // Intent pre-check: a 'derived' value was inferred (product name / history) → soft one-tap
      // confirmation, not a claim the buyer chose it. A 'buyer' value was picked from the chips.
      const derived = ri.source === 'derived';
      return (
        <div className="mt-4 animate-field-in">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{derived ? 'We understood your requirement' : 'Your requirement'}</label>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded-full bg-teal-50 border border-teal-300 text-teal-800 px-3.5 py-1.5 text-sm font-medium">{derived ? `For: ${ri.value}` : ri.value}</span>
            <button type="button" onClick={() => setRequirementIntent((p) => (p ? { ...p, value: null, confidence: 0, source: 'derived', locked: false } : p))} className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2">{derived ? 'not right? change' : 'change'}</button>
          </div>
          {renderPage1TwinNote()}
        </div>
      );
    }
    // skipped → don't nag
    if (intentGateSkipped) return null;
    // chips ready, not answered → the hero question
    if (ri && ri.chips.length) {
      return (
        <div className="mt-4 animate-field-in">
          <label className="block text-sm font-semibold text-gray-800 mb-1">{ri.question}</label>
          {debug && <p className="text-xs text-gray-400 mb-2.5">This shapes the whole form — we'll ask only what matters for your answer.</p>}
          <div className="flex flex-wrap gap-2">
            {ri.chips.map((c) => (
              <RadioChip key={c} label={c} selected={false} onClick={() => answerIntent(c)} />
            ))}
            <button type="button" onClick={() => { setIntentGateSkipped(true); track('rfq_intent_skipped', { reason: 'user_skip', product: form.productName }); }} className="rounded-full border border-dashed border-gray-300 px-4 py-2 text-sm text-gray-400 hover:text-gray-600">Skip</button>
          </div>
          {renderPage1TwinNote()}
          {debug && <p className="text-[10px] text-teal-600 mt-1.5">🎯 page-1 intent · journey {ri.journey} · deriveIntent (Twin-seeded)</p>}
        </div>
      );
    }
    // product committed + qty in (when applicable) but chips still generating → smart shimmer.
    // (qtyReady keeps the loader from flashing before the buyer has entered quantity.)
    if (engineLive && isqSpecs.length > 0 && form.productName.trim() && qtyReady) {
      return (
        <div className="mt-4 animate-field-in" aria-busy="true">
          <label className="block text-sm font-semibold text-gray-700 mb-2 inline-flex items-center gap-1.5">
            <span className="animate-pulse">✨</span> Tailoring your first question…
          </label>
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 w-28 rounded-full bg-gray-100 animate-pulse" style={{ animationDelay: `${i * 140}ms` }} />
            ))}
          </div>
        </div>
      );
    }
    return null;
  };
  const renderIntentGate = () => {
    const ri = requirementIntent;
    if (!ri || ri.value || intentGateSkipped) return null;
    return (
      <div className="rounded-2xl border border-teal-300 bg-gradient-to-br from-teal-50 to-emerald-50 p-5 space-y-3 animate-[fadeIn_0.3s_ease]">
        <p className="text-[15px] font-semibold text-gray-800">{ri.question}</p>
        {debug && <p className="text-xs text-gray-500 -mt-1.5">This shapes the whole form — we'll ask only what matters for your answer.</p>}
        <div className="flex flex-wrap gap-2 pt-0.5">
          {ri.chips.map((c) => (
            <button key={c} type="button" onClick={() => answerIntent(c)} className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:border-teal-400 hover:bg-teal-50 transition-colors">{c}</button>
          ))}
          <button type="button" onClick={() => { setIntentGateSkipped(true); track('rfq_intent_skipped', { reason: 'user_skip', product: form.productName }); }} className="rounded-full border border-dashed border-gray-300 px-4 py-2 text-sm text-gray-400 hover:text-gray-600">Skip</button>
        </div>
        {debug && <p className="text-[10px] text-teal-600">🎯 A6 intent gate · journey {ri.journey} · deriveIntent</p>}
      </div>
    );
  };

  // ── A6: Requirement Intent (debug) — the journey-adapted purpose question ──
  const renderIntentDebug = () => {
    const ri = requirementIntent;
    if (!ri) return null;
    return (
      <div className="border border-rose-200 bg-rose-50 rounded-xl p-3 text-[11px] text-rose-900 space-y-0.5">
        <p className="font-bold">🎯 Requirement Intent (A6 · deriveIntent · journey-first)</p>
        <p><b>journey:</b> {ri.journey} · <b>Q:</b> "{ri.question}"</p>
        <p><b>chips:</b> {ri.chips.join(' · ')}</p>
        <p><b>answered:</b> {ri.value ? <span className="text-rose-700 font-semibold">{ri.value} · conf {ri.confidence} · {ri.source}{ri.locked ? ' · 🔒 locked' : ''}</span> : '— not answered yet'}</p>
        <p className="text-rose-400">A6 core LIVE (single call, journey-adapted) · gate + planner-seed wiring is the next additive step</p>
      </div>
    );
  };

  // ── First-page (step 0) INTENT — candidate leaderboard. Debug mode used to show NOTHING on the
  //    landing page despite the deriveIntent call. This makes the PRECEDENCE RACE legible: every
  //    candidate source (Registry prior · Twin active-intent · LLM derivation) with its confidence
  //    and DISPOSITION (CHOSEN / BELOW_THRESHOLD / OFF_PROFILE / OVERRIDDEN), plus the chip options. ──
  const renderPage1IntentDebug = () => {
    const ri = requirementIntent;
    const dec = intentDecisionRef.current;
    const cands = intentCandidatesRef.current; // LLM's own scored end-use ranking
    const dc: Record<string, string> = { CHOSEN: 'text-emerald-700 font-semibold', BELOW_THRESHOLD: 'text-amber-600', OFF_PROFILE: 'text-rose-600', OVERRIDDEN: 'text-slate-500', ASK_FALLBACK: 'text-blue-700' };
    if (!dec) {
      return (
        <div className="border border-rose-200 bg-rose-50 rounded-xl p-3 text-[11px] text-rose-900 space-y-0.5 mt-3">
          <p className="font-bold">🎯 First-Page Intent — candidate leaderboard</p>
          <p className="text-rose-500">{QUESTION_ENGINE && hasGeminiKey() ? 'deriving… (deriveIntent in flight) — the precedence race appears here the moment it lands' : 'engine off — no derivation on this page'}</p>
        </div>
      );
    }
    const board = intentLeaderboard(dec);
    (window as unknown as { __intentBoard?: unknown }).__intentBoard = board;
    const last = getLLMHealth().filter((r) => r.label === 'deriveIntent').slice(-1)[0];
    return (
      <div className="border border-rose-300 bg-rose-50 rounded-xl p-3 text-[11px] text-rose-900 space-y-0.5 mt-3">
        <p className="font-bold">🎯 First-Page Intent — candidate leaderboard <span className="font-normal text-rose-500">({intentSummary(board, dec.chosenValue)})</span></p>
        <p className="text-rose-600"><b>journey:</b> {ri?.journey || '—'} · <b>Q:</b> "{ri?.question || '—'}" · <b>re-derived:</b> {intentDecisionTick}× · <b>bar:</b> {dec.threshold ?? 80}</p>
        {board.map((r, i) => (
          <p key={i}>{String(i + 1).padStart(2)}. <b>{r.source}</b> "{r.value}" <span className="text-rose-400">[conf {r.source === 'Chip' ? 'n/a' : r.confidence}]</span> → <span className={dc[r.disposition] || ''}>{r.disposition}</span> · {r.reason}</p>
        ))}
        {cands && cands.length > 0 && (
          <div className="mt-1 pt-1 border-t border-rose-200">
            <p className="font-semibold text-rose-700">🏆 LLM end-use ranking (deriveIntent self-scored — the "Manufacturing 92 / Commercial 71 / Residential 12" view):</p>
            {cands.map((c, i) => (
              <p key={'c' + i}>{String(i + 1).padStart(2)}. <b>{c.label}</b> <span className="text-rose-500">[{c.score}]</span>{c.reason ? ` · ${c.reason}` : ''}</p>
            ))}
          </div>
        )}
        <p className="text-rose-400 pt-0.5">Precedence: registry prior ≥{dec.threshold ?? 80} › on-profile Twin active-intent ≥{dec.threshold ?? 80} › LLM derivation ≥{dec.threshold ?? 80} › ask the chips. LLM self-scored end-use ranking shown above (intent-v5).{last ? ` · LLM ${last.model} ${last.promptVersion || ''} ${Math.round(last.ms)}ms${typeof last.costUsd === 'number' ? ' $' + last.costUsd.toFixed(5) : ''}` : ''} · window.__intentBoard</p>
      </div>
    );
  };

  // ── EXECUTIVE SUMMARY — a one-glance "what the engine knows + did" read of THIS page, on EVERY page,
  //    toggleable (execOpen). Distinct from the verbose traces below it: this is the CEO summary. ──
  const renderExecSummary = (page: 0 | 1 | 2) => {
    const facts = coverage.current.facts().filter((f) => f.status === 'active' || f.status === 'confirmed');
    const intentLine = requirementIntent?.value
      ? `${requirementIntent.value} · ${requirementIntent.locked ? 'buyer-picked' : 'derived ' + (requirementIntent.confidence || 0)}`
      : intentGateSkipped ? 'skipped by buyer' : 'asking…';
    const catLine = categoryStatus === 'hit'
      ? `${categoryConf.fuse ? 'RICH' : categoryConf.consume ? 'THIN' : 'EMPTY'} (${categoryConf.score}) · ${categoryConf.consume ? (categoryConf.fuse ? 'consumed + fused' : 'consumed, no fusion') : 'gated → buyer-only'}`
      : categoryStatus === 'building' ? 'building…' : categoryStatus === 'error' ? 'fetch error → buyer-only' : categoryStatus === 'idle' ? '—' : 'no data';
    const rows: Array<[string, string]> = [];
    if (page === 0) {
      rows.push(['Product', `${form.productName || '—'}${form.quantity ? ` · ${form.quantity} ${form.unit || ''}`.trimEnd() : ''}`]);
      rows.push(['Buyer kind', page1Choice || 'auto-deriving…']);
      rows.push(['Intent', intentLine]);
      rows.push(['Category', catLine]);
      rows.push(['Buyer Twin', pull?.ok ? (buyerTwin ? 'loaded' : 'loading…') : 'no GLID (cold)']);
    } else if (page === 1) {
      const asked = dynQuestions.filter((q) => q.source === 'llm');
      rows.push(['Intent', intentLine]);
      rows.push(['Category', catLine]);
      rows.push(['Specs', `${Object.values(form.dynamicSpecs).filter(Boolean).length}/${isqSpecs.length} filled`]);
      rows.push(['Planner Qs', `${asked.length} of ≤3${reqPlan?.archetype ? ` · ${reqPlan.archetype}` : ''}`]);
      rows.push(['Known facts', `${facts.length} active/confirmed`]);
    } else {
      rows.push(['Intent', intentLine]);
      rows.push(['GST', form.gstRegistered === null ? 'unknown (not assumed — Golden Rule)' : form.gstRegistered ? 'registered' : 'not registered']);
      rows.push(['Deliver to', `${form.deliveryLocation || form.clientLocation || '—'}${form.deliveryTimeline ? ` · ${form.deliveryTimeline}` : ''}`]);
      rows.push(['Payment', form.paymentTerms || 'not set']);
      rows.push(['Known facts', `${facts.length} active/confirmed`]);
    }
    const title = page === 0 ? 'Landing' : page === 1 ? 'Specs & Planner' : 'Delivery & Payment';
    return (
      <div className="border border-violet-300 bg-violet-50 rounded-xl px-3 py-2 text-[11px] text-violet-900 mb-2">
        <button type="button" onClick={() => setExecOpen((v) => !v)} className="w-full flex items-center justify-between font-bold">
          <span>📋 Executive Summary · {title}</span>
          <span className="text-violet-400 font-normal">{execOpen ? '▾ hide' : '▸ show'}</span>
        </button>
        {execOpen && (
          <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
            {rows.map(([k, v], i) => (<p key={i} className="truncate"><span className="text-violet-400">{k}:</span> <b>{v}</b></p>))}
          </div>
        )}
      </div>
    );
  };

  // ── A5: Knowledge Coverage Registry (debug) — the requirement's system-of-record ──
  // Shows every known fact (concept · value · source · conf · lifecycle status) + the
  // shadowed (overridden/rejected) trail. This is what the de-dup reader (A5b) consults.
  const renderCoverageRegistry = () => {
    const facts = coverage.current.facts();
    if (!facts.length) return null;
    const known = facts.filter((f) => f.status === 'active' || f.status === 'confirmed');
    const shadow = facts.filter((f) => f.status === 'overridden' || f.status === 'rejected');
    // A5b: which specs the reader is hiding (already answered by a question) — the proof it reduces the form.
    const hiddenSpecs = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC).filter((n) => {
      const f = coverage.current.coveredBy(n);
      return !!f && (f.source === 'Intent' || f.source === 'Planner' || f.source === 'LastPage');
    });
    return (
      <div className="border border-sky-200 bg-sky-50 rounded-xl p-3 text-[11px] text-sky-900 space-y-0.5">
        <p className="font-bold">🗃️ Knowledge Coverage Registry ({known.length} known{shadow.length ? ` · ${shadow.length} shadowed` : ''})</p>
        {known.map((f, i) => (
          <p key={i}>✓ <b>{f.concept}</b> = {f.value} <span className="text-sky-500">· {f.source} · conf {f.confidence} · {f.status}</span></p>
        ))}
        {shadow.map((f, i) => (
          <p key={'s' + i} className="text-sky-400"><s>{f.concept} = {f.value}</s> · {f.source} · {f.status}</p>
        ))}
        {hiddenSpecs.length > 0 && (
          <p className="text-emerald-700 font-semibold pt-0.5">🙈 {hiddenSpecs.length} spec(s) hidden — already answered by a question: {hiddenSpecs.join(', ')}</p>
        )}
        <p className="text-sky-400">A5b reader: a spec is hidden only when a QUESTION (intent/planner) already covered its concept</p>
      </div>
    );
  };

  // ── Raw Fetch Dump (debug, page-1) — EVERYTHING we pulled, before the spec step ──
  // The pre-spec audit: every source's actual content (PNS transcripts, WhatsApp,
  // buyer_profile incl. mobile, prev requirements + ISQ answers, CSL, external),
  // the mobile→GST chain explicitly, and a GAPS list of what came back empty/failed.
  // PII shown in full (debug-only form, never to sellers).
  const renderRawFetchDump = () => {
    const raw = enrichmentRaw;
    if (!Array.isArray(raw)) return null;
    const arr = raw as Array<Record<string, unknown>>;
    const get = (k: string) => { const o = arr.find((x) => x && x[k] !== undefined); let v: unknown = o ? o[k] : undefined; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } } return v; };
    const s = (v: unknown) => (v == null ? '' : String(v));
    const asArr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
    const bpv = get('buyer_profile'); const bp = (Array.isArray(bpv) ? bpv[0] : bpv) as Record<string, unknown> | undefined;
    const profileFailed = !!bp && profileMissing(bp);
    const { mobile, debugInjected: mobileInjected } = resolveMobile(bp);
    const profileGst = profileVal(bp, ['glusr_usr_gst', 'gstin', 'gst']);
    const pns = asArr(get('pns_data'));
    const bl = asArr(get('prev_bl_data'));
    const isq = asArr(get('prev_isq_data'));
    const csl = asArr(get('csl_data'));
    const waOut = get('whatsapp_data'); const waOutN = Array.isArray(waOut) ? waOut.length : 0;
    const waInInfo = waInboundCount(get('whatsapp_inbound')); const waInN = waInInfo.count; // #N2: error wrapper → 0, not its key-count
    // External (sandbox) — and the mobile→GST chain (Befisc), if published.
    const ebi = (window as unknown as { __ebi?: { externalEvidenceLedger?: Array<Record<string, unknown>> } }).__ebi;
    const ext = ebi?.externalEvidenceLedger || [];
    const befiscGst = ext.find((e) => /gst|befisc/i.test(s(e.source)) && /gst/i.test(s(e.value_summary) + s(e.key_used)));
    // PNS transcript rows
    const pnsRows = pns.slice(0, 6).map((p) => {
      const ed = (p?.extracted_data as Record<string, unknown>) || p;
      const md = (ed?.metadata as Record<string, unknown>) || {};
      const intent = (md?.buyer_intent as Record<string, unknown>) || {};
      const sq = asArr((md?.additional_details as Record<string, unknown>)?.seller_queries).map((q) => s(q?.query)).filter(Boolean);
      const prods = asArr(ed?.products).map((pr) => s((pr?.most_specific_category as Record<string, unknown>)?.name)).filter(Boolean);
      return { purpose: s(md?.call_purpose), level: s(intent?.intent_level), narr: s(intent?.narrative), app: s(md?.intended_application), lang: s(md?.primary_language), sq, prods };
    });
    // Gaps — what's empty / failed / not wired (so we see what we're missing).
    const gaps: string[] = [];
    if (profileFailed) gaps.push(`buyer_profile not returned for this GLID — ${profileFailReason(bp)} (name/company/mobile/GST unavailable)`);
    if (!mobile && !profileFailed) gaps.push('no mobile on buyer_profile → cannot run mobile→GST/Udyam lookups');
    if (mobile && !befiscGst) gaps.push(`${mobileInjected ? `mobile ${mobile} (DEBUG override — profile had none)` : `mobile present (${mobile})`} but mobile→GST (Befisc) NOT wired in live form — run ebi_sandbox.mjs`);
    if (!profileGst && !befiscGst) gaps.push('no GST captured (neither on profile nor via Befisc) → no HSN / nature-of-business');
    if (!pns.length) gaps.push('0 PNS calls — no call transcripts/intent narratives');
    if (waInInfo.failed) gaps.push('whatsapp_inbound — n8n sub-fetch FAILED (404 error wrapper) → inbound chat not captured (other sources OK)');
    if (!waOutN && !waInN && !waInInfo.failed) gaps.push('0 WhatsApp (in+out) — no chat affinity signal');
    if (!isq.length) gaps.push('0 prev ISQ answers — no prior spec values to pre-fill');
    if (!bl.length) gaps.push('0 prev requirements (BL) — no prior buy-lead history');
    if (!ext.length) gaps.push('External (Befisc/Sign3/World) NOT wired in live form — window.__ebi empty (sandbox only)');
    const Sec = ({ title, children }: { title: string; children: React.ReactNode }) => (
      <div className="pt-1"><p className="font-semibold text-slate-600">{title}</p>{children}</div>
    );
    return (
      <div className="border border-slate-300 bg-white rounded-xl p-3 text-[11px] text-slate-800 space-y-1.5 max-h-[420px] overflow-y-auto">
        <p className="font-bold text-slate-800">🔬 Raw Fetch Dump — everything pulled for GLID {enrichment?.glid || glidInput} (debug · pre-spec · PII shown)</p>
        {/* Identity + mobile→GST chain */}
        <Sec title="👤 Identity + Mobile→GST chain (buyer_profile)">
          {profileFailed && <p className="text-amber-600">⚠ buyer_profile not returned for this GLID — <b>{profileFailReason(bp)}</b>{mobileInjected ? ' · using the debug mobile below to exercise the chain' : ' (the other 6 sources may still be present below)'}</p>}
          {!profileFailed && (
            <>
              <p>name: <b>{[bp?.ceo_fname, bp?.ceo_lname].filter(Boolean).join(' ') || s(bp?.first_name) || '—'}</b> · {s(bp?.designation) || s(bp?.glusr_usr_dsg) || ''} · {s(bp?.company_name) || '—'} · {[s(bp?.city), s(bp?.state)].filter(Boolean).join(', ')}</p>
              <p>🧾 GST on profile: <b className={profileGst ? 'text-green-700' : 'text-gray-400'}>{profileGst || '— none on profile'}</b></p>
            </>
          )}
          {(!profileFailed || mobileInjected) && (
            <>
              <p>📞 mobile (key glusr_usr_ph_mobile): <b className={mobile ? 'text-green-700' : 'text-red-600'}>{mobile || '✗ not present'}</b>{mobileInjected ? <span className="text-fuchsia-600"> · debug override (profile had none)</span> : (bp?.mobile_verified ? ' · verified✓' : '')}</p>
              <p>🔗 mobile→GST (Befisc): {befiscGst ? <b className="text-green-700">{s(befiscGst.value_summary) || 'found'}</b> : <span className="text-amber-600">not wired (sandbox) — would call Befisc with {mobile || 'mobile'}{mobileInjected ? ' (debug)' : ''}</span>}</p>
            </>
          )}
        </Sec>
        {/* PNS transcripts */}
        <Sec title={`📞 PNS calls / transcripts (${pns.length})`}>
          {pnsRows.length ? pnsRows.map((r, i) => (
            <p key={i} className="border-l-2 border-slate-200 pl-1.5 my-0.5">[{r.purpose || 'call'}/{r.level || '?'}{r.lang ? '·' + r.lang : ''}] {r.narr ? `"${r.narr.slice(0, 140)}"` : ''}{r.app ? ` · app: ${r.app}` : ''}{r.prods.length ? ` · mcat: ${r.prods.join(', ')}` : ''}{r.sq.length ? ` · seller-asked: ${r.sq.slice(0, 3).join(' / ')}` : ''}</p>
          )) : <p className="text-gray-400">—</p>}
        </Sec>
        {/* WhatsApp */}
        <Sec title={`💬 WhatsApp (out ${waOutN} · in ${waInN}${waInInfo.failed ? ' · ✗ inbound fetch failed' : ''})`}>
          <p className="text-slate-500 break-words">{(Array.isArray(waOut) && waOut.length) ? JSON.stringify(waOut.slice(0, 2)).slice(0, 180) : '—'}</p>
        </Sec>
        {/* Prev requirements + ISQ */}
        <Sec title={`📦 Prev requirements (BL ${bl.length}) + ISQ answers (${isq.length})`}>
          {bl.slice(0, 5).map((b, i) => (<p key={'b' + i}>BL: <b>{s(b?.ETO_OFR_TITLE) || s(b?.title) || '?'}</b>{s(b?.ETO_OFR_POSTDATE_ORIG) ? ` · ${s(b?.ETO_OFR_POSTDATE_ORIG)}` : ''}</p>))}
          {isq.slice(0, 5).map((r, i) => { const ans = asArr(r?.isq).map((a) => `${s(a?.IM_SPEC_MASTER_DESC)}=${s(a?.ISQ_RESPONSE)}`).filter((x) => !x.endsWith('=')); return (<p key={'i' + i}>ISQ “{s(r?.title)}”: {ans.length ? ans.join(' · ') : '(no answers)'}</p>); })}
          {!bl.length && !isq.length && <p className="text-gray-400">—</p>}
        </Sec>
        {/* CSL + category insights */}
        <Sec title={`🔎 CSL searches (${csl.length}) + category insights`}>
          <p>distinct prior categories ({(enrichment?.categories || []).length}): {[...new Set((enrichment?.categories || []).map((c) => `${c.mcat}(${c.source})`))].slice(0, 10).join(', ') || '—'}</p>
          <p>persona (direct): {[enrichment?.persona?.type, enrichment?.persona?.scale, enrichment?.persona?.repeatBuyer ? 'repeat' : '', enrichment?.persona?.multiSku ? `multi-SKU(${enrichment?.persona?.domains?.length})` : ''].filter(Boolean).join(' · ') || '—'}</p>
        </Sec>
        {/* External */}
        <Sec title="🌐 External (Befisc · Sign3 · World) — observed, sandbox">
          {ext.length ? ext.map((e, i) => (<p key={i}>{s(e.source)} · {s(e.value_summary) || s(e.key_used)} · conf {s(e.confidence)} · used-by-twin {e.used_by_twin ? 'YES' : 'NO'}</p>)) : <p className="text-fuchsia-500">not wired in live form — run scripts/ebi_sandbox.mjs → window.__ebi</p>}
        </Sec>
        {/* Gaps */}
        <Sec title={`🕳️ Gaps / not captured (${gaps.length}) — what we're missing`}>
          {gaps.length ? gaps.map((g, i) => (<p key={i} className="text-rose-600">• {g}</p>)) : <p className="text-green-600">none — all expected sources present</p>}
        </Sec>
        <p className="text-slate-400">raw: window.__enrichment.raw · external: window.__ebi</p>
      </div>
    );
  };

  // ── P1+P1A: Unified Buyer Intelligence Ledger (INTERNAL + EXTERNAL in one panel) ──
  // Internal n8n sources (our truth, conf 95, all feed the Twin) + External observed
  // evidence (Befisc/Sign3/World — sandbox, NOT a planning input) each tagged
  // Used-By-Twin YES/NO, plus a programmatic Contradictions block. The contradiction
  // detector is purely structural (token-overlap, NO category literals) per the
  // standing "no hardcoding any category" rule.
  const renderBuyerIntelligenceLedger = () => {
    const raw = enrichmentRaw;
    const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    const get = (k: string) => { const o = arr.find((x) => x && x[k] !== undefined); let v: unknown = o ? o[k] : undefined; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } } return v; };
    const cnt = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v as object).length : v ? 1 : 0);
    const s = (v: unknown) => (v == null ? '' : String(v));
    const bpv = get('buyer_profile'); const bp = (Array.isArray(bpv) ? bpv[0] : bpv) as Record<string, unknown> | undefined;
    const profileFailed = !!bp && profileMissing(bp);
    const pns = get('pns_data'); const bl = get('prev_bl_data');
    const blTitles = Array.isArray(bl) ? (bl as Array<Record<string, unknown>>).map((x) => x?.ETO_OFR_TITLE || x?.title).filter(Boolean).slice(0, 3) : [];
    // INTERNAL rows: [label, count, detail]. All internal sources FEED the Twin (used=YES).
    const internal: Array<{ label: string; n: number; ok: boolean; warn?: boolean; detail?: string }> = arr.length ? [
      { label: 'Buyer profile', n: bp && !profileFailed ? 1 : 0, ok: !!bp && !profileFailed, warn: profileFailed, detail: profileFailed ? 'auth failed upstream — other 6 OK' : (bp ? `${[bp.ceo_fname, bp.ceo_lname].filter(Boolean).join(' ') || s(bp.first_name) || '?'} · ${s(bp.company_name) || '?'}` : '') },
      { label: 'PNS calls', n: cnt(pns), ok: cnt(pns) > 0 },
      { label: 'CSL searches', n: cnt(get('csl_data')), ok: cnt(get('csl_data')) > 0 },
      { label: 'WhatsApp out', n: cnt(get('whatsapp_data')), ok: cnt(get('whatsapp_data')) > 0 },
      { label: 'WhatsApp in', n: waInboundCount(get('whatsapp_inbound')).count, ok: waInboundCount(get('whatsapp_inbound')).count > 0 },
      { label: 'Prev requirements', n: cnt(bl), ok: cnt(bl) > 0, detail: blTitles.join(' / ') },
      { label: 'Prev ISQ answers', n: cnt(get('prev_isq_data')), ok: cnt(get('prev_isq_data')) > 0 },
    ] : [];
    // EXTERNAL evidence — read window.__ebi defensively (sandbox shapes vary). Observed,
    // not a planning input (DPDP set aside) → used_by_twin defaults to NO until wired.
    const ebi = (window as unknown as { __ebi?: { externalEvidenceLedger?: Array<Record<string, unknown>>; evidence?: Array<Record<string, unknown>> } }).__ebi;
    const extRaw = (ebi?.externalEvidenceLedger || ebi?.evidence || []) as Array<Record<string, unknown>>;
    const external = extRaw.map((e) => ({
      source: s(e.source) || '?',
      summary: s(e.value_summary || e.summary || e.value || '').slice(0, 60),
      conf: typeof e.confidence === 'number' ? (e.confidence as number) : null,
      used: e.used_by_twin === true,
    }));
    // CONTRADICTIONS — structural token-overlap between internal history vs external registry/world.
    // Two fixes vs the old version that false-flagged "PVC Bag history ✕ a company that MAKES PVC bags":
    //   (1) tokenise the FULL value_summary (the World product list), NOT the 60-char-truncated `external`;
    //   (2) ≥3-char tokens so distinctive short product words ("pvc", "bag", "box", "rim") count.
    // Generic business stopwords + common 3-char fillers only (NEVER category words).
    const STOP = new Set(['product', 'products', 'trading', 'trader', 'traders', 'service', 'services', 'supplier', 'suppliers', 'manufacturer', 'manufacturers', 'wholesale', 'wholesaler', 'retail', 'retailer', 'company', 'india', 'limited', 'private', 'export', 'exporter', 'import', 'importer', 'industries', 'industrial', 'goods', 'item', 'items', 'material', 'materials', 'the', 'and', 'for', 'are', 'our', 'was', 'has', 'new', 'pvt', 'ltd', 'with', 'from', 'about']);
    const tok = (xs: string[]) => new Set(xs.flatMap((x) => (String(x).toLowerCase().match(/[a-z]{3,}/g) || [])).filter((w) => !STOP.has(w)));
    const internalCats = (enrichment?.categories || []).map((c) => s(c.mcat)).filter(Boolean);
    const externalKw = extRaw.map((e) => s(e.value_summary || e.summary || e.value || '')).filter(Boolean); // FULL text (not truncated)
    const aTok = tok(internalCats), bTok = tok(externalKw);
    const contradictions: Array<{ a: string; b: string; fa: string; fb: string }> = [];
    if (aTok.size && bTok.size && ![...aTok].some((w) => bTok.has(w))) {
      contradictions.push({ a: 'IndiaMART history', b: 'External registry/world', fa: internalCats.slice(0, 2).join(', '), fb: external.map((e) => e.summary).filter(Boolean).slice(0, 2).join(', ') });
    }
    if (!internal.length && !external.length) return null;
    const dot = (ok: boolean, warn = false) => (warn ? '🟡' : ok ? '🟢' : '⚪');
    return (
      <div className="border border-indigo-200 bg-indigo-50 rounded-xl p-3 text-[11px] text-indigo-900 space-y-1.5">
        <p className="font-bold">🌍 Buyer Intelligence Ledger — internal + external, with Used-By-Twin</p>
        {internal.length > 0 && (
          <div>
            <p className="text-indigo-500 font-semibold">INTERNAL · n8n · conf 95 · our own truth (all feed the Twin)</p>
            {internal.map((r) => (
              <p key={r.label}>{dot(r.ok, r.warn)} <b>{r.label}</b> ({r.n}){r.detail ? ` · ${r.detail}` : ''} <span className="text-emerald-600">· used by Twin: YES</span></p>
            ))}
          </div>
        )}
        <div>
          <p className="text-fuchsia-600 font-semibold">EXTERNAL · observed evidence — NOT a planning input (DPDP set aside)</p>
          {external.length > 0 ? (
            external.map((e, i) => (
              <p key={i}>🌐 <b>{e.source}</b>{e.summary ? ` · "${e.summary}"` : ''}{e.conf != null ? ` · conf ${e.conf}` : ''} <span className={e.used ? 'text-emerald-600' : 'text-gray-400'}>· used by Twin: {e.used ? 'YES' : 'NO'}</span></p>
            ))
          ) : (
            <p className="text-fuchsia-500">Not wired into the live form (sandbox). Run <code>scripts/ebi_sandbox.mjs</code> → publish <code>window.__ebi</code>. Befisc Profile-Advance + Sign3 + World/OSINT work now; GST→HSN/Udyam await endpoint codes.</p>
          )}
        </div>
        <div>
          <p className="text-rose-600 font-semibold">⚠ CONTRADICTIONS{contradictions.length ? '' : ' — none detected'}</p>
          {contradictions.map((c, i) => (
            <p key={i} className="text-rose-700">{c.a}: <b>{c.fa || '—'}</b> ✕ {c.b}: <b>{c.fb || '—'}</b> → <span className="font-semibold">Review needed (MEDIUM)</span></p>
          ))}
        </div>
        <p className="text-indigo-400">raw: window.__enrichment.raw · window.__ebi</p>
      </div>
    );
  };

  // ── Provenance: for ANY captured field, where did the value come from + how sure ──
  // Single source of truth reused by the Truth Table (last page) AND per-spec bars (P3).
  type Trust = 'VERIFIED' | 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED' | 'OPEN';
  type Prov = { src: string; icon: string; conf: number | null; evidence: string; trust: Trust };
  // Trust badge (Gemini): User/API = VERIFIED · Twin/AI >80 = HIGH · 60-80 = MEDIUM · <60 = LOW ·
  // Gate = OPEN (a preference field left open ON PURPOSE → more competitive quotes; NOT "blocked").
  const trustOf = (src: string, conf: number | null): Trust =>
    src === 'Gate' ? 'OPEN' : src === 'User' ? 'VERIFIED' : conf == null ? 'MEDIUM' : conf >= 80 ? 'HIGH' : conf >= 60 ? 'MEDIUM' : 'LOW';
  const trustClass = (t: Trust) =>
    t === 'VERIFIED' ? 'text-green-700 font-semibold' : t === 'HIGH' ? 'text-blue-700 font-semibold' : t === 'MEDIUM' ? 'text-amber-600' : t === 'LOW' ? 'text-red-600' : t === 'OPEN' ? 'text-teal-600 font-semibold' : 'text-gray-400';
  const fieldProvenance = (key: string, value: string): Prov => {
    const base = ((): Omit<Prov, 'trust'> => {
      const d = deducedLogistics[key];
      if (d && d.value) return { src: 'Deduced', icon: '🧠', conf: Math.round((d.confidence || 0) * 100), evidence: d.reason || 'inferred from known signals' };
      if (preferenceSpecs.has(key) && !(value && value.trim())) return { src: 'Gate', icon: '🔓', conf: null, evidence: 'left open on purpose → more competitive quotes' };
      if (manualSpecs.has(key)) return { src: 'User', icon: '👤', conf: 100, evidence: 'picked by buyer' };
      if (repostMeta[key]) return { src: 'History', icon: '🔁', conf: 90, evidence: `re-posted from your ${agoLabel(repostMeta[key].recencyDays)} order${repostMeta[key].custom ? ' (added — not in this category)' : ''}` };
      if (enrichedSpecs.has(key)) return { src: 'Twin/History', icon: '🧬', conf: 90, evidence: 'from past requirements' };
      if (cascadeSpecs.has(key)) return { src: 'Cascade', icon: '✨', conf: cascadeConf.current[key] ?? 82, evidence: cascadeRationale || (cascadeFrom ? `inferred from ${cascadeFrom}` : 'inferred from your answers') };
      if (autoFilledSpecs.has(key)) return { src: 'AI', icon: '✨', conf: 75, evidence: 'AI-suggested' };
      if (value && value.trim()) return { src: 'User', icon: '👤', conf: 100, evidence: 'selected by buyer' };
      return { src: '—', icon: '', conf: null, evidence: '' };
    })();
    return { ...base, trust: trustOf(base.src, base.conf) };
  };

  // ── Final RFQ Truth Table — every captured field · value · source · conf · evidence ──
  // The centerpiece: an HOD reads this one panel to see exactly what the engine produced
  // and where each fact came from (User / Twin / Cascade / Deduced / Gate-blocked).
  const renderTruthTable = () => {
    const rows: Array<{ field: string; value: string; prov: Prov }> = [];
    const push = (field: string, value: string, prov: Omit<Prov, 'trust'>) => { if (value && value.trim()) rows.push({ field, value, prov: { ...prov, trust: trustOf(prov.src, prov.conf) } }); };
    // Fact-Origin (ChatGPT): for a Twin-derived fact, show WHAT it was derived FROM — the
    // raw evidence counts — so an HOD's "why does the Twin think that?" is answered in-row.
    const eb = enrichment?.evidenceBase;
    const twinOrigin = eb ? [eb.bls_created && `${eb.bls_created} BLs`, eb.whatsapp_events && `${eb.whatsapp_events} WA`, eb.csl_events && `${eb.csl_events} CSL`, eb.pns_calls && `${eb.pns_calls} PNS`].filter(Boolean).join(' · ') : '';
    const canonBt = canonicalBuyerType(); // A2: one canonical value (form > twin > profile)
    if (canonBt) push('Buyer Type', canonBt, form.buyerType
      ? (buyerTypeDeducedFrom ? { src: 'Twin', icon: '🧬', conf: 85, evidence: `deduced from ${buyerTypeDeducedFrom}${twinOrigin ? ' · derived from ' + twinOrigin : ''}` } : { src: 'User', icon: '👤', conf: 100, evidence: 'picked by buyer' })
      : { src: 'Twin', icon: '🧬', conf: 70, evidence: `canonical role (Twin/Profile)${twinOrigin ? ' · from ' + twinOrigin : ''}` });
    if (form.quantity) push('Quantity', `${form.quantity}${form.unit ? ' ' + form.unit : ''}`, { src: 'User', icon: '👤', conf: 100, evidence: 'typed on step 1' });
    for (const [k, v] of Object.entries(form.dynamicSpecs)) if (v && v.trim()) push(k, v, fieldProvenance(k, v));
    for (const k of preferenceSpecs) if (!(form.dynamicSpecs[k] || '').trim()) push(k, '— open to all', { src: 'Gate', icon: '🔓', conf: null, evidence: 'left open on purpose → more competitive quotes' });
    for (const q of dynQuestions) { const a = dynAnswers[q.id]; if (a) push(q.label.replace(/\s*\?$/, ''), a, { src: 'User', icon: '👤', conf: 100, evidence: 'answered' }); }
    if (form.deliveryTimeline) push('Delivery Timeline', form.deliveryTimeline, fieldProvenance('deliveryTimeline', form.deliveryTimeline));
    if (form.paymentTerms) push('Payment Terms', form.paymentTerms, fieldProvenance('paymentTerms', form.paymentTerms));
    if (form.deliveryLocation) push('Delivery Location', form.deliveryLocation, { src: 'User', icon: '👤', conf: 100, evidence: 'selected' });
    // A5b — Registry → Final RFQ sync: surface anything the registry KNOWS that no visible
    // field already shows (e.g. a cadence the planner captured), so "whatever is answered or
    // inferred appears in the final requirement" holds even without a rendered field.
    const cov = coverage.current;
    const shownConcepts = new Set(rows.map((r) => cov.conceptOf(r.field)));
    for (const f of cov.facts()) {
      if (f.status !== 'active' && f.status !== 'confirmed') continue;
      if (shownConcepts.has(f.concept)) continue;
      shownConcepts.add(f.concept);
      const icon = f.source === 'User' ? '👤' : f.source === 'Twin' ? '🧬' : f.source === 'Deduced' ? '🧠' : f.source === 'Cascade' ? '✨' : '🗃️';
      const label = (f.rawKey || f.concept).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      push(label, f.value, { src: f.source, icon, conf: f.confidence, evidence: `from ${f.evidence.join(', ') || f.source}` });
    }
    if (!rows.length) return null;
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded-xl p-3 text-[11px] text-emerald-900 mt-3 overflow-x-auto">
        <p className="font-bold mb-1.5">🧾 Final RFQ — Truth Table (field · value · source · conf · evidence)</p>
        <table className="w-full border-collapse">
          <thead><tr className="text-emerald-500 text-left"><th className="pr-2 py-0.5">Field</th><th className="pr-2">Value</th><th className="pr-2">Source</th><th className="pr-2">Conf</th><th className="pr-2">Trust</th><th>Evidence</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-emerald-100 align-top">
                <td className="pr-2 py-0.5 font-semibold">{r.field}</td>
                <td className="pr-2">{r.value}</td>
                <td className="pr-2 whitespace-nowrap">{r.prov.icon} {r.prov.src}</td>
                <td className="pr-2">{r.prov.conf == null ? '—' : r.prov.conf}</td>
                <td className={'pr-2 whitespace-nowrap ' + trustClass(r.prov.trust)}>{r.prov.trust}</td>
                <td className="text-emerald-600">{r.prov.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── AI Contribution Summary — "what value did the AI create on this RFQ?" ──
  // The first thing an HOD/CPO reads. Pure counts from existing state, no new calls.
  const renderAiContribution = () => {
    const answered = dynQuestions.filter((q) => dynAnswers[q.id]).length;
    const user = manualSpecs.size + (form.buyerType && !buyerTypeDeducedFrom ? 1 : 0) + (form.quantity ? 1 : 0) + answered;
    const twin = enrichedSpecs.size + (buyerTypeDeducedFrom ? 1 : 0);
    const cascade = cascadeSpecs.size;
    // #3: count only deductions confident enough to APPLY (≥0.8) — a sub-0.8 guess is still
    // asked, so it isn't "effort saved". Keeps this count consistent with the form + Truth Table.
    const deduced = Object.values(deducedLogistics).filter((d) => d && d.value && (d.confidence || 0) >= 0.8).length;
    const blocked = preferenceSpecs.size;
    const twinSkipped = reqPlan?.twinResolved?.length || 0;
    // Distinct spec fields the engine filled so the buyer never typed them (no double-count).
    const engineSpecs = new Set<string>([...enrichedSpecs, ...cascadeSpecs, ...autoFilledSpecs]);
    const avoided = engineSpecs.size + twinSkipped;
    // External signals actually consumed by the Twin (Used-By-Twin=YES) — sandbox window.__ebi.
    const ebi = (window as unknown as { __ebi?: { externalEvidenceLedger?: Array<{ used_by_twin?: boolean }> } }).__ebi;
    const extUsed = Array.isArray(ebi?.externalEvidenceLedger) ? ebi!.externalEvidenceLedger!.filter((e) => e?.used_by_twin).length : 0;
    // Buyer-effort-reduced: of all the fields/questions the buyer COULD have faced
    // (category specs + twin-skipped questions + deduced logistics), what % did the engine handle.
    const universe = Math.max(1, isqSpecs.length + twinSkipped + deduced);
    const effort = Math.min(100, Math.round(((avoided + deduced) / universe) * 100));
    return (
      <div className="border border-violet-300 bg-violet-50 rounded-xl p-3 text-[11px] text-violet-900">
        <div className="flex items-center justify-between mb-1.5">
          <p className="font-bold">🤖 AI Impact — what the engine did for this RFQ</p>
          <span className="rounded-full bg-emerald-100 border border-emerald-300 text-emerald-700 font-bold px-2 py-0.5 text-[11px]">Buyer effort reduced ~{effort}%</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span>⏭ Questions avoided: <b>{avoided}</b></span>
          <span>🧬 Twin filled: <b>{twin}</b></span>
          <span>✨ Cascade inferred: <b>{cascade}</b></span>
          <span>🧠 Deduced: <b>{deduced}</b></span>
          <span>🌐 External signals used: <b>{extUsed}</b></span>
          <span>🔒 Gate blocks: <b>{blocked}</b></span>
          <span>👤 Manual entry: <b>{user}</b></span>
        </div>
      </div>
    );
  };

  // ── P-why: Why Asked / Why Skipped — make the Twin's question-cut undeniable ──
  // Pure reuse: specOrder (asked) + specReasons (needed-for) vs twinResolved /
  // enrichedSpecs / deducedLogistics (skipped, with the confidence that justified it).
  const renderWhyAskedSkipped = () => {
    const order = lockedSpecOrder ?? reqPlan?.specOrder ?? [];
    const twinConf = buyerTwin?.twin_confidence?.overall_score ?? null;
    // ASKED = specs we still surface to the buyer (not pre-filled from history, not gate-blocked prefs).
    // A spec covered by a QUESTION (intent/planner) is HIDDEN from the form (A5b) — it must
    // show as SKIPPED here, not ASKED, so this panel matches the actual form. Also exclude
    // redundant (name-detected not-applicable) specs, exactly like the spec render.
    const coveredByQ = (n: string) => { const f = coverage.current.coveredBy(n); return !!f && (f.source === 'Intent' || f.source === 'Planner' || f.source === 'LastPage'); };
    const asked = order.filter((n) => !enrichedSpecs.has(n) && !preferenceSpecs.has(n) && !redundantISQSpecs.includes(n) && !coveredByQ(n));
    const skippedCovered = order.filter((n) => coveredByQ(n)); // answered by the intent/planner question
    const skippedTwin = reqPlan?.twinResolved || []; // planner cut these — Twin already knew
    const skippedHistory = [...enrichedSpecs]; // pre-filled from past requirements
    // #3: only count a deduction as SKIPPED when it was confident enough to APPLY (≥0.8) — a
    // low-confidence guess is still ASKED on the form, so it must not show here as "skipped".
    const skippedDeduced = Object.entries(deducedLogistics).filter(([, d]) => d && d.value && (d.confidence || 0) >= 0.8).map(([k, d]) => ({ k, c: Math.round((d.confidence || 0) * 100) }));
    if (!asked.length && !skippedCovered.length && !skippedTwin.length && !skippedHistory.length && !skippedDeduced.length) return null;
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 text-[11px] text-amber-900 space-y-1">
        <p className="font-bold">🧭 Why Asked / Why Skipped — the Twin's question cut</p>
        {asked.length > 0 && (
          <div>
            <p className="text-amber-500 font-semibold">ASKED ({asked.length}) — open for this buyer</p>
            {asked.slice(0, 12).map((n) => (
              <p key={n}>❓ <b>{n}</b> — {reqPlan?.specReasons?.[n] ? `needed: ${reqPlan.specReasons[n]}` : 'Twin had no value for this (conf 0) → ask'}</p>
            ))}
          </div>
        )}
        {(skippedCovered.length > 0 || skippedTwin.length > 0 || skippedHistory.length > 0 || skippedDeduced.length > 0) && (
          <div className="pt-0.5">
            <p className="text-emerald-600 font-semibold">SKIPPED — the buyer never had to answer these</p>
            {skippedCovered.map((n) => (<p key={'cv' + n}>✅ <b>{n}</b> — already answered by the intent question → hidden</p>))}
            {skippedTwin.map((t) => (<p key={'tw' + t}>✅ <b>{t}</b> — Twin already knew{twinConf != null ? ` (conf ${twinConf})` : ''} → not asked</p>))}
            {skippedHistory.map((n) => (<p key={'hi' + n}>✅ <b>{n}</b> — auto-filled from past requirements (conf 90)</p>))}
            {skippedDeduced.map(({ k, c }) => (<p key={'de' + k}>✅ <b>{k}</b> — deduced from known signals ({c}%)</p>))}
          </div>
        )}
      </div>
    );
  };

  const renderSpecPage = () => {
    // Triage: show only the top 3 relevant specs (API importance order, minus
    // ones the AI flagged as not-applicable); the long tail hides behind a
    // "+ more" expander so the page stays light.
    // A5b reader (Level-1 + Level-2 ONLY): hide a spec whose concept a QUESTION
    // (Intent or Planner) has already answered — so the buyer is never re-asked what
    // they just told the wizard (e.g. intent "Retail" → the "Application/Usage" spec
    // disappears). NEVER hides a spec the user filled directly, NEVER semantic guesses.
    const coveredByQuestion = (name: string) => {
      const f = coverage.current.coveredBy(name);
      return !!f && (f.source === 'Intent' || f.source === 'Planner' || f.source === 'LastPage');
    };
    const eligible = isqSpecs.filter(
      (s) => !redundantISQSpecs.includes(s.IM_SPEC_MASTER_DESC) && !coveredByQuestion(s.IM_SPEC_MASTER_DESC)
    );
    // V1 recovery: specs A5b HID because a question (Intent/Planner) already covered the concept.
    // Hidden by default is correct (don't re-ask what the buyer told us) — but if that inference was
    // WRONG the buyer must be able to reach them. Surface under the "+more" expander as an editable
    // "set from your answer — adjust" section so a deduped spec is never silently unrecoverable.
    const coveredSpecs = isqSpecs.filter(
      (s) => !redundantISQSpecs.includes(s.IM_SPEC_MASTER_DESC) && coveredByQuestion(s.IM_SPEC_MASTER_DESC)
    );
    // Use the LOCKED order if set; otherwise the live plan-applied order (the lock
    // effect freezes it on plan-apply / first touch so it never reshuffles after).
    const planReady = !!(reqPlan && ((reqPlan.specOrder?.length ?? 0) || (reqPlan.mustHaveSpecs?.length ?? 0)));
    const orderNames = lockedSpecOrder ?? computeSpecOrder(planReady);
    const rankOf = (name: string) => (orderNames.indexOf(name) === -1 ? 99 : orderNames.indexOf(name));
    const ordered = [...eligible].sort((a, b) => rankOf(a.IM_SPEC_MASTER_DESC) - rankOf(b.IM_SPEC_MASTER_DESC));
    const topSpecs = ordered.slice(0, 3);
    const moreSpecs = ordered.slice(3);
    // P0.1: deterministic spec-step phase — replaces the old concierge/intent/planner
    // three-way race. Intent is captured on PAGE 1 (renderPage1Intent); the gate below is
    // ONLY a fallback for a deriveIntent that resolved after the buyer clicked Continue.
    // The planner is the one genuine dependency for specs: hold (smart progress) while it is
    // in flight AND no usable plan exists yet — otherwise show specs. A queued P6 re-rank
    // reorders in place via the existing rank-move animation, so we never block on it.
    const intentGatePending = !!requirementIntent && !requirementIntent.value && !intentGateSkipped;
    // P1-fix: hold specs behind the smart-progress loader during ANY active plan computation
    // (initial plan OR the intent-seeded re-plan) — so specs reveal ONCE, in final order, with
    // the panel question ready. Kills "see specs → planner lands → specs re-rank". The P6
    // user-driven re-rank (replanPending) is intentionally NOT held — it animates in place after
    // the buyer answers a panel question (an expected adapt), via the existing rank-move anim.
    // PERF — the spec page must NEVER flip back to a full-screen loader once it has specs to show.
    // We reveal specs the moment they exist (raw ISQ importance order) and let the planner RE-RANK
    // IN PLACE; a re-plan firing as the profile / Twin / intent land AFTER Continue re-ranks silently
    // (and the order locks on first plan-apply anyway, so it won't even reshuffle) — it must not re-
    // block. Only a genuine cold-start (no plan yet AND nothing rendered) shows the progress checklist.
    // This is what kills the "spec page not coming / taking too long" multi-loader stall.
    const plannerPending = dynLoading && isqSpecs.length > 0 && !planReady;
    // Phase A/P0 — READY gate. Hold the question page behind the orchestration loader until the brains
    // it consumes are ready (buyer pull done · mcat resolved · category hit-or-time-boxed · planner done).
    // Uses the SAME gateSourcesNow() as the planner-execution gate, so the render and the planner agree.
    // The mcatResolved input means the latch can't open in the pre-mcat window (the bug that let category
    // load after the planner). One-way latch: once opened, a later re-plan re-ranks IN PLACE, never re-blocks.
    const gate = plannerGate(gateSourcesNow());
    if (gate.ready) specsRevealed.current = true;
    const holdForGate = !specsRevealed.current && !gate.ready;
    // P (Re-post): specs the buyer cared about last time that THIS category's ISQ schema doesn't
    // expose (drift) — they were applied as custom keys (repostMeta[].custom) and aren't in the
    // normal spec list, so render them in their own "added from your last order" section.
    const isqNames = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC));
    const repostCustom = repostSource
      ? Object.entries(repostMeta).filter(([k, m]) => m.custom && !isqNames.has(k) && (form.dynamicSpecs[k] || '').trim())
      : [];
    return (
      <div className="space-y-5">
        {repostSource && (
          <div className="rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-[12px] text-teal-900 animate-[fadeIn_0.3s_ease]">
            <div className="flex items-center gap-2">
              <span className="text-base">🔁</span>
              <span>Re-posting <b>{repostSource.title}</b> from your {agoLabel(repostSource.recencyDays)} order — we prefilled what you told us last time. Review &amp; update below, then post.</span>
            </div>
          </div>
        )}
        {replanFlash && (
          <div className="flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-[12px] text-orange-800 animate-[fadeIn_0.3s_ease]">
            <span className="text-base">🔄</span>
            <span>{debug ? <>Re-planned after: <b>{replanFlash}</b> — reordered the specs that matter most for this</> : <>We reordered these to match your answer</>}</span>
          </div>
        )}
        {/* Category Brain is still being learned (cold mcat → 3-min build). Non-blocking: specs render
            below in ISQ order now and re-rank by seller-frequency the moment it lands. (Task 22) */}
        {categoryStatus === 'building' && (
          <div className="flex items-start gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-[12px] text-indigo-900 animate-[fadeIn_0.3s_ease]">
            <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-indigo-300 border-t-indigo-600 animate-spin" />
            <div>
              <p className="font-semibold">Learning this category from seller data…</p>
              <p className="text-indigo-700 text-[11px]">Analysing historical RFQs · seller questions · buyer responses · ISQ patterns — your questions sharpen when ready (usually 1–3 min). You can keep going now.{debug ? ' [mode=category · build-once + poll]' : ''}</p>
            </div>
          </div>
        )}
        {/* Pulled-data debug panels (🧠 Enrichment · 🕵️ Dossier · 🩺 Pipeline · 🌐 External · 🤖 LLM ·
            🧬 Twin · Ledger) moved to the step-0 STAGING view (landing "Pull"). The FLOW panels — which
            describe the LIVE requirement, not the pull — stay here on the spec page. */}
        {/* L2 — buyer-facing nudges (location mismatch / personal-vs-business / supplier radius). VISIBLE. */}
        {renderNudges()}
        {/* CONSUME the conversational location preference — CONFIDENCE-GATED (Phase B · Gap 1 + Gap 3):
            ≥70 chip (assert, with an undo) · 40-69 confirm (a real question) · <40 hide. Answering writes
            it as a User-authority fact (upgrades the History fact), so it travels with the lead. */}
        {convSignals.locationPreference && (() => {
          const X = convSignals.locationPreference.charAt(0).toUpperCase() + convSignals.locationPreference.slice(1);
          const mode = renderMode(convSignals.locationPreferenceConfidence);
          if (mode === 'hide') return null;
          const rej = convSignals.rejectedLocations.length ? ` (and ${convSignals.rejectedLocations.join('/')} sellers kept calling)` : '';
          const answer = (val: string) => { coverage.current.record('supplier location preference', val, 'User', 100); setLocPrefAnswer(val); };
          if (locPrefAnswer) return (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 animate-[fadeIn_0.3s_ease]">
              <span className="text-base">📍</span><span>Sourcing preference noted: <b>{locPrefAnswer}</b>.</span>
            </div>
          );
          if (mode === 'chip') return (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] text-rose-900 animate-[fadeIn_0.3s_ease]">
              <span className="text-base">📍</span>
              <span>You wanted <b>{X}</b> suppliers{rej} — we'll prioritise {X}/nearby sellers for these quotes.
                <button type="button" onClick={() => answer('Anywhere in India')} className="ml-1.5 underline underline-offset-2 hover:text-rose-700">Not {X}?</button>
              </span>
            </div>
          );
          return ( // confirm band (40-69): a real question that changes the requirement
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900 animate-[fadeIn_0.3s_ease]">
              <p className="font-medium">📍 Prefer suppliers from <b>{X}</b>?{rej}</p>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <button type="button" onClick={() => answer(X)} className="rounded-full border border-amber-400 bg-white px-2.5 py-1 text-amber-800 hover:bg-amber-100 font-medium">Yes — prefer {X}</button>
                <button type="button" onClick={() => answer('Anywhere in India')} className="rounded-full border border-amber-400 bg-white px-2.5 py-1 text-amber-800 hover:bg-amber-100 font-medium">Anywhere in India</button>
              </div>
            </div>
          );
        })()}
        {debug && renderExecSummary(1)}
        {debug && renderRequirementUnderstanding()}
        {debug && renderDependencyTrace()}
        {debug && renderCategoryConsumption()}
        {debug && renderCategoryDisposition()}
        {debug && renderReasonChain()}
        {debug && renderQuestionGraph()}
        {debug && renderScorecard()}
        {debug && renderEvals()}
        {debug && renderNodeLogs()}
        {debug && renderOptionProvenance()}
        {debug && renderIntentDebug()}
        {debug && renderCoverageRegistry()}
        {debug && renderWhyAskedSkipped()}
        {debug && reqPlan && (
          <div className="border border-purple-200 bg-purple-50 rounded-xl p-3 text-[11px] text-purple-900 space-y-1">
            <p className="font-bold">🧭 Intent plan (live · ?debug)</p>
            <p className="text-purple-500"><b>via:</b> planRequirement [gemini-2.5-flash-lite]</p>
            {planTrace && <p className="text-purple-500 break-words"><b>passed:</b> {planTrace}</p>}
            <p><b>archetype:</b> {reqPlan.archetype} · <b>order:</b> {reqPlan.orderMode}</p>
            {questionBudget && (
              <p className="text-purple-700 font-semibold">
                🎯 asked {questionBudget.asked} · twin-skipped {questionBudget.twinSkipped} · mode {questionBudget.mode} · tiers {questionBudget.tiers}
              </p>
            )}
            {questionBudget && questionBudget.why.length > 0 && (
              <p className="text-purple-600">
                {questionBudget.mode === 'fast_track' ? '⚡ why_fast_track' : (questionBudget.mode === 'off_profile' || questionBudget.mode === 'cold_discover') ? '🔎 why_discovery' : 'ℹ️ why'}: [{questionBudget.why.join(', ')}]
                <span className="text-purple-400"> · window.__twinWhy</span>
              </p>
            )}
            <p className="text-purple-600">
              🤝 concierge: {conciergeState}
              {conciergeStat.total > 0 ? ` · accept-rate ${Math.round((conciergeStat.yes / conciergeStat.total) * 100)}% (${conciergeStat.yes}/${conciergeStat.total})` : ''}
              <span className="text-purple-400"> · window.__conciergeStat</span>
            </p>
            {reqPlan.twinResolved && reqPlan.twinResolved.length > 0 && (
              <p className="text-emerald-700"><b>twin already knew (not asked):</b> {reqPlan.twinResolved.join(' · ')}</p>
            )}
            {reqPlan.lead && <p><b>lead:</b> [{reqPlan.lead.source}] {reqPlan.lead.ref}</p>}
            {reqPlan.leadingQuestion && <p><b>leads with:</b> {reqPlan.leadingQuestion}</p>}
            <p><b>must-have specs:</b> {reqPlan.mustHaveSpecs.join(', ') || '—'}</p>
            {cascadeFrom && <p><b>cascade:</b> {cascadeFrom} → {[...cascadeSpecs].join(', ') || '(none)'}</p>}
            {buyerTypeDeducedFrom && <p><b>buyerType:</b> {form.buyerType} (deduced from {buyerTypeDeducedFrom} — role card skipped)</p>}
            {(() => {
              // 🏆 CANDIDATE QUESTION LEADERBOARD — every question the planner WEIGHED, ranked by its own
              // self-score, with SELECTED (asked, ≤3) vs SUPPRESSED (lost to the cap / covered elsewhere) + why.
              // The deterministic answer to "why wasn't Site-Ready asked?" — it shows where it placed and why it lost.
              const asked = reqPlan!.questions.map((q) => ({ label: q.label, score: typeof q.priority === 'number' ? q.priority : null, status: 'SELECTED' as const, reason: q.reason || q.groundedIn || '', tag: `${q.tier || '?'}·${q.placement}/${q.kind}${q.decisive ? '·★' : ''}` }));
              const supp = (reqPlan!.considered || []).map((c) => ({ label: c.label, score: c.score as number | null, status: 'SUPPRESSED' as const, reason: c.reason, tag: '' }));
              const rows = [...asked, ...supp].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
              return (
                <div className="mt-1 pt-1 border-t border-purple-200">
                  <p className="font-semibold text-purple-800">🏆 Candidate Question Leaderboard <span className="font-normal text-purple-500">(selected {asked.length} of ≤3 · {supp.length} suppressed · planner self-scored, plan-v7)</span></p>
                  {rows.map((r, i) => (
                    <p key={i}>{String(i + 1).padStart(2)}. <b>{r.label}</b> <span className="text-purple-400">[{r.score ?? '—'}]</span> → <span className={r.status === 'SELECTED' ? 'text-emerald-700 font-semibold' : 'text-rose-600'}>{r.status}</span>{r.reason ? ` · ${r.reason}` : ''}{r.tag ? ` · ${r.tag}` : ''}</p>
                  ))}
                  {!reqPlan!.considered && <p className="text-purple-400">scores + suppressed list populate when the planner runs on plan-v7 (older cached plans carry no <code>priority</code>/<code>considered</code>).</p>}
                </div>
              );
            })()}
            <p><b>serve signals:</b> {reqPlan.serveSignals.join(' · ') || '—'}</p>
          </div>
        )}
        {debug && promptTraces.length > 0 && (
          <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 text-[11px] text-amber-900 space-y-1">
            <p className="font-bold">📡 Prompt trace ({promptTraces.length}) — what ran &amp; what was passed</p>
            <ol className="list-decimal ml-4 space-y-1">
              {promptTraces.map((t, i) => (
                <li key={i}>
                  <b>{t.prompt}</b> <span className="text-amber-500">[{t.model}]</span> — {t.purpose}
                  <br />
                  <span className="text-amber-600 break-words">passed: {t.inputs}</span>
                </li>
              ))}
            </ol>
            <p className="text-amber-400">also in console: window.__promptTraces</p>
          </div>
        )}
        {debug && gateDecisions.length > 0 && (
          <div className="border border-rose-200 bg-rose-50 rounded-xl p-3 text-[11px] text-rose-900 space-y-1">
            <p className="font-bold">🔒 gate_decisions ({gateDecisions.length}) — every auto-fill verdict (VEKA paper trail)</p>
            <ol className="list-decimal ml-4 space-y-0.5">
              {gateDecisions.map((d, i) => (
                <li key={i}>
                  <b>{d.field}</b> ·{' '}
                  <span className={d.action === 'filled' ? 'text-emerald-600' : 'text-rose-600 font-semibold'}>{d.action}</span>{' '}
                  <span className="text-rose-400">[{d.classification} · {d.reason}{d.at ? ` · ${d.at}` : ''}]</span>
                </li>
              ))}
            </ol>
            <p className="text-rose-400">also in console: window.__gateDecisions</p>
          </div>
        )}
        {/* P0.3: the concierge "Welcome Back" screen is GONE — the Twin confirmation is now
            a subtle note on the PAGE-1 intent (renderPage1TwinNote). No spec-step gating. */}
        {/* Tier-1 Assist entry */}
        {(
          assistNudge > 0 ? (
            <div className="flex items-start gap-2 bg-teal-50 border border-teal-200 rounded-xl px-3 py-2.5">
              <span className="text-teal-600 text-sm shrink-0 mt-0.5">✦</span>
              <p className="text-xs text-teal-700 flex-1">
                Filled <span className="font-semibold">{assistNudge}</span>{' '}
                spec{assistNudge > 1 ? 's' : ''} from your use-case — tap any chip to change or remove.
              </p>
              <button
                onClick={() => setAssistNudge(0)}
                className="text-teal-500 hover:text-teal-700 shrink-0"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAssistOpen(true)}
              className="w-full flex items-center gap-2 bg-gradient-to-r from-teal-50 to-emerald-50 border border-teal-200 rounded-xl px-3 py-2.5 text-left hover:from-teal-100 hover:to-emerald-100 transition-colors"
            >
              <span className="text-teal-600 text-base shrink-0">✦</span>
              <span className="text-sm text-teal-700 flex-1">
                Not sure what to pick? <span className="font-semibold">Tell us your use-case</span> and we'll fill it for you.
              </span>
              <ArrowRight size={15} className="text-teal-500 shrink-0" />
            </button>
          )
        )}
        {intentGatePending ? (
          /* Page-1 late-fallback: deriveIntent resolved AFTER Continue — capture it here
             rather than dropping it. The common path answers intent on page 1. */
          renderIntentGate()
        ) : holdForGate ? (
          /* READY gate (Phase A): hold the question page until buyer/category/planner are ready —
             then reveal ONCE, in final order. Latched, so a later re-plan re-ranks in place (below). */
          renderSpecProgress(gate, () => setCategoryWaitElapsed(true))
        ) : (
          <>
            {plannerPending && (
              /* Specs are already shown — the planner is only refining their ORDER in the background.
                 A slim inline note, never a blocking screen, so the page comes forward immediately. */
              <div className="flex items-center gap-2 text-[12px] text-teal-600 mb-1 animate-[fadeIn_0.3s_ease]">
                <span className="inline-block w-3 h-3 border-2 border-teal-400 border-t-transparent rounded-full animate-spin shrink-0" />
                Prioritising these for you…
              </div>
            )}
            {topSpecs.map(renderSpecField)}

            {/* The long tail of specs + any A5b-hidden (covered-by-answer) specs stay behind an
                opt-in expander, so a deduped spec is reachable for recovery, never silently lost. */}
            {(moreSpecs.length > 0 || coveredSpecs.length > 0) &&
              (showAllSpecs ? (
                <div className="space-y-5">
                  {moreSpecs.map(renderSpecField)}
                  {coveredSpecs.length > 0 && (
                    <div className="space-y-5 pt-1 border-t border-dashed border-gray-200">
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide pt-2">Set from your earlier answers — adjust if we got it wrong</p>
                      {coveredSpecs.map(renderSpecField)}
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAllSpecs(true)}
                  className="text-sm text-teal-600 hover:text-teal-700 font-medium"
                >
                  {moreSpecs.length > 0
                    ? `+ ${moreSpecs.length} more spec${moreSpecs.length > 1 ? 's' : ''} (optional)`
                    : `Adjust ${coveredSpecs.length} detail${coveredSpecs.length > 1 ? 's' : ''} we set from your answers`}
                </button>
              ))}

            {/* P (Re-post): spec-drift — values from the past order that this category's schema
                doesn't have a field for. Shown as editable custom specs with an "added" badge. */}
            {repostCustom.length > 0 && (
              <div className="space-y-3 pt-1">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Also from your last order</p>
                {repostCustom.map(([name, m]) => (
                  <div key={name} className="animate-field-in">
                    <div className="flex items-center gap-2 mb-1.5">
                      <label className="text-sm font-semibold text-gray-800">{name}</label>
                      <span className="text-[10px] font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-1.5 py-0.5">🔁 added from your {agoLabel(m.recencyDays)} order</span>
                    </div>
                    <input
                      type="text"
                      value={form.dynamicSpecs[name] || ''}
                      onChange={(e) => markManualSpec(name, e.target.value)}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Non-spec context + persona + soft profile live in the details wizard. P0: the planner panel
            questions (budget/brand/scale) are ALSO held behind the READY gate — they're planner output,
            so they must not appear before category either (the leak the dry run exposed). */}
        {!holdForGate && renderPanelChip()}
      </div>
    );
  };

  // ─── One woven non-spec question (chip-block or free text) ───────────────────
  // Reused inline on the spec page (slot==='specs') and at the top of the final
  // step (requirement/persona). Always optional — never blocks submit.
  const renderDynQuestion = (q: DynQuestion, onPick?: () => void) => {
    const val = dynAnswers[q.id] || '';
    const opts = q.options || [];
    return (
      <div key={q.id} className="animate-field-in">
        <p className="text-sm font-semibold text-gray-800 mb-2">{q.label}</p>
        {debug && (q.reason || q.genBy) && (
          <div className="text-[10px] text-amber-700 mb-2 -mt-1 space-y-0.5 bg-amber-50 border border-amber-100 rounded px-1.5 py-1">
            {q.genBy && (
              <p>
                📡 surfaced by{' '}
                <b>
                  {q.genBy === 'planner'
                    ? 'planRequirement'
                    : q.genBy === 'generator'
                    ? 'generateEnrichmentQuestions'
                    : q.genBy === 'refine'
                    ? 'refineQuestions (look-ahead)'
                    : q.genBy}
                </b>
                {' · '}slot={q.slot}
              </p>
            )}
            {q.reason && <p className="italic">ⓘ why: {q.reason}</p>}
            {q.genInputs && <p className="text-amber-500 break-words">passed: {q.genInputs}</p>}
          </div>
        )}
        {opts.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {opts.map((o) => (
              <RadioChip
                key={o}
                label={o}
                selected={val === o}
                onClick={() => {
                  const next = val === o ? '' : o;
                  setDynAnswers((p) => ({ ...p, [q.id]: next }));
                  if (next && !q.multi) onPick?.();
                }}
              />
            ))}
            {q.multi ? null : (
              <OtherChip
                value={opts.includes(val) ? '' : val}
                onChange={(v) => setDynAnswers((p) => ({ ...p, [q.id]: v }))}
              />
            )}
          </div>
        ) : (
          <input
            type="text"
            value={val}
            onChange={(e) => setDynAnswers((p) => ({ ...p, [q.id]: stripPII(e.target.value) }))}
            placeholder="Type your answer"
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
          />
        )}
      </div>
    );
  };

  // ─── "Details for sellers" wizard — one card at a time ───────────────────────
  const renderPanelItemBody = (item: PanelItem, autoAdvance: () => void) => {
    if (item.kind === 'dyn') return renderDynQuestion(item.q, autoAdvance);
    if (item.kind === 'role') {
      // Category-tailored personas from the planner (Salon/Retailer/Distributor…),
      // falling back to the generic roles when the plan has none.
      const roleOpts = reqPlan?.personaOptions?.length
        ? reqPlan.personaOptions
        : ['End User', 'Manufacturer', 'Stockist', 'Reseller', 'Trader'];
      return (
        <div className="animate-field-in">
          <p className="text-sm font-semibold text-gray-800 mb-2">Which best describes you?</p>
          <div className="flex flex-wrap gap-2">
            {roleOpts.map((r) => (
              <RadioChip key={r} label={r} selected={form.buyerType === r} onClick={() => { buyerTypeManual.current = true; setField('buyerType', r); autoAdvance(); }} />
            ))}
          </div>
        </div>
      );
    }
    if (item.kind === 'industry')
      return (
        <div className="animate-field-in">
          <p className="text-sm font-semibold text-gray-800 mb-2">Which industry are you in?</p>
          <input
            type="text"
            value={form.industry}
            onChange={(e) => setField('industry', e.target.value)}
            placeholder="e.g., Construction, Hospital, Manufacturing"
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
          />
        </div>
      );
    if (item.kind === 'size')
      return (
        <div className="animate-field-in">
          <p className="text-sm font-semibold text-gray-800 mb-2">How big is your company?</p>
          <div className="flex flex-wrap gap-2">
            {['1-10', '11-50', '51-200', '200+'].map((s) => (
              <RadioChip key={s} label={s} selected={form.companySize === s} onClick={() => { setField('companySize', s); autoAdvance(); }} />
            ))}
          </div>
        </div>
      );
    return (
      <div className="animate-field-in">
        <p className="text-sm font-semibold text-gray-800 mb-2">How often will you buy this?</p>
        <div className="flex flex-wrap gap-2">
          {['One-time', 'Weekly', 'Monthly', 'Annual'].map((f) => (
            <RadioChip key={f} label={f} selected={form.requirementFrequency === f} onClick={() => { setField('requirementFrequency', f); autoAdvance(); }} />
          ))}
        </div>
      </div>
    );
  };

  const renderIntentSheet = () => {
    // Render from the frozen snapshot so the list never reshuffles mid-session.
    const items = panelFrozen ?? panelItems;
    if (items.length === 0) return null;
    const idx = Math.min(panelIndex, items.length - 1);
    const item = items[idx];
    const isLast = idx >= items.length - 1;
    const closePanel = (reason: string) => {
      track('rfq_panel_close', { reason, index: idx, answered: panelAnswered, total: items.length });
      setIntentSheetOpen(false);
    };
    const advance = () => {
      if (isLast) {
        track('rfq_panel_complete', { answered: panelAnswered, total: items.length });
        setIntentSheetOpen(false);
      } else setPanelIndex(idx + 1);
    };
    const autoAdvance = () => setTimeout(() => setPanelIndex((i) => (i + 1 >= items.length ? i : i + 1)), 280);
    const isProfileCard = item.kind !== 'dyn';
    return (
      <div
        className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
        onClick={() => closePanel('backdrop')}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="A few details for sharper quotes"
          className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5 max-h-[85vh] overflow-y-auto scroll-auto-hide"
          style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="sr-only" aria-live="polite">
            Question {idx + 1} of {items.length}. {panelItemLabel(item)}
          </span>
          <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-3 sm:hidden" />
          <div className="flex items-start justify-between mb-1">
            <p className="font-bold text-gray-800 flex items-center gap-1.5">
              <span className="text-amber-500">✨</span> A few details → sharper quotes
            </p>
            <button
              onClick={() => closePanel('x')}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200 shrink-0"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3">Optional — accurate quotes, fewer back-and-forth calls.</p>
          {/* progress (decorative; the live region above announces position) */}
          <div className="flex items-center gap-1.5 mb-4" aria-hidden="true">
            {items.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${i === idx ? 'w-5 bg-teal-500' : i < idx ? 'w-1.5 bg-teal-300' : 'w-1.5 bg-gray-200'}`}
              />
            ))}
            <span className="ml-auto text-[11px] text-gray-400 font-medium">{idx + 1} of {items.length}</span>
          </div>
          {panelRefining && (
            <p className="text-[11px] text-teal-600 mb-3 flex items-center gap-1.5 -mt-2">
              <span className="w-3 h-3 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
              Tailoring the next questions to your answers…
            </p>
          )}
          {isProfileCard && (
            <p className="text-[11px] text-gray-400 mb-2">Helps sellers know who's buying — pitch right, skip the qualifying call.</p>
          )}
          {renderPanelItemBody(item, autoAdvance)}
          {/* footer */}
          <div className="flex items-center justify-between mt-6">
            <button
              onClick={() => (idx === 0 ? closePanel('back') : setPanelIndex(idx - 1))}
              className="text-sm text-gray-500 hover:text-gray-700 font-medium"
            >
              {idx === 0 ? 'Close' : '← Back'}
            </button>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { track('rfq_panel_skip', { card: item.kind, index: idx }); advance(); }}
                className="text-sm text-gray-400 hover:text-gray-600 font-medium"
              >
                Skip
              </button>
              <button
                onClick={advance}
                className="bg-teal-600 text-white text-sm font-semibold px-5 py-2 rounded-xl hover:bg-teal-700 transition-colors"
              >
                {isLast ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── P1.6: Last-page relevance — the debug verdict panel. Answers "can I see if last-page
  //    questions are relevant, and are they hidden?" Per field: RELEVANT (asked) · DEDUCED
  //    (prefilled summary) · REDUNDANT (covered by another stage → hidden) · SKIPPED
  //    (segment-gated) · VERIFIED. PII/contact/location are always shown (never gated). ──
  const renderLastPageRelevance = () => {
    const rows: Array<{ verdict: string; cls: string; field: string; detail: string }> = [];
    const add = (verdict: string, cls: string, field: string, detail: string) => rows.push({ verdict, cls, field, detail });
    if (form.additionalDetails.trim()) add('REDUNDANT', 'text-emerald-700', 'Firm Name', `known ("${form.additionalDetails.trim()}") → confirmable summary, not asked`);
    else if (isBusinessRole && fullProfile) add('RELEVANT', 'text-amber-600', 'Firm Name', 'business + bulk, not on file → asked');
    else add('SKIPPED', 'text-gray-400', 'Firm Name', 'not a business/bulk buyer → not asked');
    if (enrichment?.buyer?.verifiedBusiness) add('VERIFIED', 'text-emerald-700', 'GST', 'verified-business flag on profile');
    else if (isBusinessRole && fullProfile) add('RELEVANT', 'text-amber-600', 'GST', 'business + bulk, no GSTIN on file → asked (Tier-1/Befisc creds-blocked)');
    else if (isBusinessRole && gstRelevantByContext) add('RELEVANT', 'text-amber-600', 'GST', 'institution / capital buy → GST invoice needed even at qty 1 (P3 procurement context)');
    else add('SKIPPED', 'text-gray-400', 'GST', 'not a business/bulk buyer → not asked');
    ([['deliveryTimeline', 'Delivery'], ['paymentTerms', 'Payment Terms']] as const).forEach(([id, lbl]) => {
      const d = deducedLogistics[id];
      const v = String((form as unknown as Record<string, unknown>)[id] ?? '');
      if (d && d.confidence >= 0.8 && v) add('DEDUCED', 'text-teal-700', lbl, `${v} (${Math.round(d.confidence * 100)}%) — "${d.reason}" → confirmable summary`);
      else add('RELEVANT', 'text-amber-600', lbl, 'not confidently deduced → asked');
    });
    dynQuestions
      .filter((q) => (q.slot === 'specs' || q.slot === 'requirement' || q.slot === 'persona') && !dynAnswers[q.id] && coverHides(q.label))
      .forEach((q) => add('REDUNDANT', 'text-emerald-700', q.label, `covered by ${coverage.current.coveredBy(q.label)?.source} → hidden`));
    add('ALWAYS', 'text-gray-500', 'Contact + delivery location', 'PII / location — never gated');
    return (
      <div className="border border-cyan-200 bg-cyan-50 rounded-xl p-3 text-[11px] text-cyan-900 space-y-0.5 mb-4">
        <p className="font-bold">🧮 Last-page relevance — asked · deduced · hidden (per field)</p>
        {rows.map((r, i) => <p key={i}><span className={`font-semibold ${r.cls}`}>{r.verdict}</span> · <b>{r.field}</b> — {r.detail}</p>)}
        <p className="text-cyan-400">RELEVANT = asked · DEDUCED = prefilled summary · REDUNDANT = covered → hidden · SKIPPED = segment-gated</p>
      </div>
    );
  };

  // ─── Delivery page renderer ──────────────────────────────────────────────────

  const renderDeliveryPage = () => {
    // ── Conditional field logic ──
    // Profile gating (showProfile / fullProfile / isBusinessRole) is computed at
    // component scope and shared with the details wizard. Role/Industry/Size/
    // Frequency now live in that wizard; only validated GST/Firm stay here.
    // Payment mode options depend on the chosen payment term.
    // Payment mode applies only when the mode is decided UP FRONT. Credit (Post-Delivery) → the
    // Credit Period is the relevant detail and mode is settled at payment time; Loan/Finance → the
    // financing is the detail. Both hide Payment Mode. Full Advance / COD → mode matters now.
    const paymentModeOptions =
      form.paymentTerms === 'Loan/Finance' || form.paymentTerms === 'Credit (Post-Delivery)'
        ? []
        : ['Online Transfer', 'Cash', 'Cheque'];
    const showPaymentMode = !!form.paymentTerms && paymentModeOptions.length > 0;

    // "✦ noted" badge on a field we pre-filled by deduction (≥80% confidence) — so
    // the buyer sees we already know it and can still tap to change. In debug it
    // also shows the confidence + reason (provenance of a DEDUCED value).
    const deducedTag = (id: string) => {
      const d = deducedLogistics[id];
      if (!d || d.confidence < 0.8) return null;
      return (
        <span className="normal-case ml-1 text-[10px] font-medium text-teal-600 bg-teal-50 border border-teal-100 rounded-full px-1.5 py-0.5">
          ✦ noted{debug ? ` (${Math.round(d.confidence * 100)}% · ${d.reason})` : ' — tap to change'}
        </span>
      );
    };

    // ── P1.3: a confidently-deduced (≥0.8) value renders as a confirmable one-line SUMMARY
    //    instead of a full chip question; "change" re-reveals the input/chips. Indian B2B:
    //    payment/credit is sensitive, so the buyer always SEES the deduced value (not silently
    //    applied) and can correct it. ──
    const fieldVal = (id: string): string => String((form as unknown as Record<string, unknown>)[id] ?? '');
    const isDeduced = (id: string) => (deducedLogistics[id]?.confidence ?? 0) >= 0.8 && !!fieldVal(id).trim();
    const showSummary = (id: string) => isDeduced(id) && !editFields.has(id);
    const summaryRow = (id: string, value: string, sub?: string) => (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="rounded-full bg-teal-50 border border-teal-200 text-teal-800 px-3 py-1 text-sm font-medium normal-case">{value}</span>
        {sub && <span className="text-[11px] text-gray-400 normal-case">{sub}</span>}
        <button type="button" onClick={() => setEditFields((s) => new Set([...s, id]))} className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 normal-case">change</button>
      </div>
    );

    // High-level groups still to fill — drives the dynamic "almost there" helper.
    const missingGroups: string[] = [];
    if (!form.deliveryTimeline) missingGroups.push('Delivery details');
    if (!form.paymentTerms) missingGroups.push('Payment terms');

    // Live summary of everything captured — the supplier-facing recap.
    // Each chip carries an optional removeKey — a SPEC the buyer can drop with × (Qty/Buyer/answers
    // are core and stay). Removing clears the value AND blocks the cascade from re-adding it.
    const summaryChips: Array<{ text: string; removeKey?: string }> = [
      form.quantity ? { text: `Qty: ${form.quantity}${form.unit ? ` ${form.unit}` : ''}` } : null,
      form.buyerType ? { text: `Buyer: ${form.buyerType}` } : null,
      ...Object.entries(form.dynamicSpecs)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => ({ text: `${k}: ${v}`, removeKey: k })),
      // Quick-Questions: show the question (key) + the answer (value), not a bare value.
      ...dynQuestions.filter((q) => dynAnswers[q.id]).map((q) => ({ text: `${q.label.replace(/\s*\?$/, '')}: ${dynAnswers[q.id]}` })),
    ].filter(Boolean) as Array<{ text: string; removeKey?: string }>;

    return (
    <div>
      {/* Mobile-only delivery-location pill (desktop shows it in the header) */}
      <div className="sm:hidden relative mb-4">
        <button
          type="button"
          onClick={() => setLocationEditing((v) => !v)}
          className="flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-sm text-gray-700 transition-colors"
          aria-label="Change delivery location"
        >
          <MapPin size={14} className="text-teal-500 shrink-0" />
          <span className="truncate">
            {form.deliveryLocation || detectedLocation || 'Select city'}
          </span>
          <Pencil size={12} className="text-gray-400 shrink-0" />
        </button>
        {locationEditing && renderLocationPopover('left')}
      </div>

      {/* Details wizard chip — finish any remaining non-spec / profile cards */}
      {(panelItems.length > 0 || dynLoading) && (
        <div className="mb-5">{renderPanelChip()}</div>
      )}

      {/* P1.6: last-page relevance verdicts (debug) */}
      {debug && renderExecSummary(2)}
      {debug && renderLastPageRelevance()}

      {/* "Almost there" helper — only surfaces when the user tries to leave */}
      {missingGroups.length > 0 && missingPromptShown && !missingDismissed && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 mb-4">
          <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">!</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-800">
              Almost there — just {missingGroups.length}{' '}
              {missingGroups.length === 1 ? 'thing' : 'things'} missing:
            </p>
            <p className="text-xs text-amber-700 mt-0.5">{missingGroups.join(', ')}</p>
          </div>
          <button
            onClick={() => setMissingDismissed(true)}
            className="text-amber-500 hover:text-amber-700 shrink-0"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* ── Card: Logistics & Payment ── */}
      <div className="rounded-2xl border border-gray-100 p-4 sm:p-5 mb-4">
        <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide mb-4">
          Logistics &amp; Payment
        </p>
        <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
          <div>
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
              <Clock size={13} className="text-teal-500" /> Delivery {!showSummary('deliveryTimeline') && deducedTag('deliveryTimeline')}
            </p>
            {showSummary('deliveryTimeline') ? summaryRow('deliveryTimeline', form.deliveryTimeline, debug ? `deduced ${Math.round((deducedLogistics['deliveryTimeline']?.confidence || 0) * 100)}% — ${deducedLogistics['deliveryTimeline']?.reason || ''}` : 'noted from your history') : (
            <div className="flex flex-wrap gap-2">
              {['Immediate', 'Within 15 Days', '1 Month', 'Flexible'].map((t) => (
                <RadioChip
                  key={t}
                  label={t}
                  selected={form.deliveryTimeline === t}
                  onClick={() => setField('deliveryTimeline', t)}
                />
              ))}
            </div>
            )}
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
              <CreditCard size={13} className="text-teal-500" /> Payment terms {!showSummary('paymentTerms') && deducedTag('paymentTerms')}
            </p>
            {showSummary('paymentTerms') ? summaryRow('paymentTerms', form.paymentTerms, debug ? `deduced ${Math.round((deducedLogistics['paymentTerms']?.confidence || 0) * 100)}% — ${deducedLogistics['paymentTerms']?.reason || ''}` : 'noted from your history') : (
            <div className="flex flex-wrap gap-2">
              {['Full Advance', 'Credit (Post-Delivery)', 'COD', 'Loan/Finance'].map((t) => (
                <RadioChip
                  key={t}
                  label={t}
                  selected={form.paymentTerms === t}
                  onClick={() => setField('paymentTerms', t)}
                />
              ))}
            </div>
            )}
          </div>
        </div>

        {/* Credit period — only when Credit terms are chosen */}
        {form.paymentTerms === 'Credit (Post-Delivery)' && (
          <div className="mt-4">
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
              Credit period
            </p>
            <div className="flex flex-wrap gap-2">
              {['15 Days', '30 Days', '45 Days', '60 Days', '90 Days'].map((c) => (
                <RadioChip
                  key={c}
                  label={c}
                  selected={form.creditPeriod === c}
                  onClick={() => setField('creditPeriod', c)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Payment mode — only relevant once a payment term is chosen */}
        {showPaymentMode && (
          <div className="mt-4">
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
              Payment mode
            </p>
            <div className="flex flex-wrap gap-2">
              {paymentModeOptions.map((m) => (
                <RadioChip
                  key={m}
                  label={m}
                  selected={form.paymentMode === m}
                  onClick={() => setField('paymentMode', m)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Card: Your business — GST/Firm, for business+bulk buyers OR an institution/capital buy
          (P3: an academic/gov institution or a capital/project purchase needs a GST invoice even at
          qty 1 — the IIT-Kanpur single-unit lab buy was wrongly skipped before). ── */}
      {isBusinessRole && (fullProfile || gstRelevantByContext) && (
        <div className="rounded-2xl border border-gray-100 p-4 sm:p-5 mb-4">
          <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide mb-4">Your business</p>
          <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Firm Name</p>
              {/* P1.2: firm known from the buyer's profile → confirmable summary, not a blank field. */}
              {form.additionalDetails.trim() && !editFields.has('firm') ? summaryRow('firm', form.additionalDetails.trim(), 'from your profile') : (
              <input
                type="text"
                value={form.additionalDetails}
                onChange={(e) => setField('additionalDetails', e.target.value)}
                placeholder="Company / firm name"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
              />
              )}
            </div>
            <div>
              <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST Registered?</p>
              <div className="flex gap-2">
                <RadioChip label="Yes" selected={form.gstRegistered === true} onClick={() => setField('gstRegistered', true)} />
                <RadioChip label="No" selected={form.gstRegistered === false} onClick={() => setField('gstRegistered', false)} />
              </div>
              {form.gstRegistered === null && (
                <p className="text-[11px] text-amber-600 mt-1.5">We couldn't verify your GST from your profile — please select (we won't assume you're unregistered).</p>
              )}
              {form.gstRegistered === true && (
                <input
                  type="text"
                  value={form.gstNumber}
                  onChange={(e) => setField('gstNumber', e.target.value.toUpperCase().slice(0, 15))}
                  placeholder="GST number (15 digits)"
                  className="w-full mt-2 border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Card: Contact details (collapsible) — Login lives here now ── */}
      <div className="rounded-2xl border border-gray-100 p-4 sm:p-5">
        <div className="w-full flex items-center justify-between">
          <button
            onClick={() => setContactOpen((v) => !v)}
            className="flex items-center gap-2 flex-1 text-left"
          >
            <span className="text-xs uppercase font-semibold text-gray-400 tracking-wide">
              Contact Details
            </span>
            {contactOpen ? (
              <ChevronUp size={16} className="text-gray-400" />
            ) : (
              <ChevronDown size={16} className="text-gray-400" />
            )}
          </button>
          {loggedIn ? (
            <span className="flex items-center gap-1 text-teal-600 text-xs font-semibold border border-teal-200 bg-teal-50 rounded-full px-2.5 py-1">
              <CheckCircle2 size={12} /> {form.contactName.split(' ')[0] || 'Verified'}
            </span>
          ) : (
            <button
              onClick={handleLogin}
              className="flex items-center gap-1.5 text-teal-600 text-sm border border-teal-500 rounded-lg px-3 py-1 hover:bg-teal-50 transition-colors"
            >
              <LogIn size={13} /> Login
            </button>
          )}
        </div>
        {contactOpen && (
          <div className="flex flex-col sm:grid sm:grid-cols-2 gap-3 sm:gap-4 mt-4">
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
                <User size={12} /> Name <span className="text-red-500">*</span>
              </p>
              <input
                type="text"
                value={form.contactName}
                onChange={(e) => setField('contactName', e.target.value)}
                placeholder="Your name"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
              />
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">
                <Phone size={12} /> Mobile <span className="text-red-500">*</span>
              </p>
              <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400">
                <span className="px-3 text-sm text-gray-500 border-r border-gray-200 py-2.5 bg-gray-50">
                  +91
                </span>
                <input
                  type="tel"
                  inputMode="numeric"
                  value={form.contactMobile}
                  onChange={(e) => setField('contactMobile', e.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
                  placeholder="Mobile number"
                  className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none min-w-0"
                />
              </div>
            </div>
            <input
              type="email"
              value={form.contactEmail}
              onChange={(e) => setField('contactEmail', e.target.value)}
              placeholder="Email address (optional)"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 sm:col-span-2"
            />
          </div>
        )}
      </div>

      {/* ── Card: Your requirement — recap + free text, right before Get Quotes ── */}
      <div className="rounded-2xl border border-gray-100 p-4 sm:p-5 mt-4">
        <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide mb-2">
          Your Requirement
        </p>
        {/* Buyer context — surfaced for sellers (NO PII). The intelligence that
            powered the form now LANDS in the requirement. PII shows only in debug. */}
        {buyerTwin && twinContextLine(buyerTwin) && (
          <div className="mb-3 space-y-1">
            <p className="text-[11px] text-teal-700 bg-teal-50 border border-teal-100 rounded-lg px-2.5 py-1.5">
              <span className="font-semibold">Buyer context</span> (shared with sellers): {twinContextLine(buyerTwin)}
            </p>
            {/* Deduced PERSONA — the high-confidence dimensions that DON'T already appear above
                (stage / urgency / power / awareness / support). So the persona we inferred LANDS in the
                requirement, not just in debug. Strengthens seller matching; the buyer sees what we assumed. */}
            {(() => {
              const inContext = /manufactur|trader|retail|wholesal|distribut|multi-sku|whatsapp|local|inventory|likely for/i;
              const extra = requirementUnderstanding().filter((d) => d.confidence > 0 && !/use case|who is the buyer/i.test(d.dim) && !inContext.test(d.value));
              return extra.length ? (
                <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5">
                  <span className="font-semibold text-gray-600">Buyer profile (deduced):</span> {extra.map((d) => `${d.dim.replace(/^(Buyer |Preferred |Purchase |Procurement )/, '')} — ${d.value}`).join(' · ')}
                </p>
              ) : null;
            })()}
            {debug && (
              <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 break-words">
                🐞 PII (debug only — never shown to sellers): {[enrichment?.buyer?.fullName, enrichment?.buyer?.mobile, enrichment?.buyer?.email, enrichment?.buyer?.companyName, [enrichment?.buyer?.city, enrichment?.buyer?.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')} · twin evidence-volume {buyerTwin.twin_confidence.overall_score}/100
              </p>
            )}
          </div>
        )}
        {/* BTE-v1.3 — how the buyer FILLED this RFQ, as a seller-facing behaviour line (PII-free).
            Shows even with no Twin (it's pure in-session signal). The way they fill the form tells
            the seller how to pitch (fast vs flexible, advance vs credit, hands-on vs delegating). */}
        {(() => {
          const line = observedBehaviorLine(observedBehavior);
          return line ? (
            <p className="mb-3 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5">
              <span className="font-semibold">Buyer behaviour</span> (how they filled this RFQ): {line}
              {observedBehavior.session_count > 1 && <span className="text-emerald-600"> · seen across {observedBehavior.session_count} sessions</span>}
            </p>
          ) : null;
        })()}
        {summaryChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {summaryChips.map((s) => (
              <span
                key={s.text}
                className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full pl-2.5 pr-1 py-1 max-w-full"
              >
                <span className="truncate">{s.text}</span>
                {s.removeKey ? (
                  <button
                    type="button"
                    onClick={() => removeSpec(s.removeKey!)}
                    aria-label={`Remove ${s.removeKey}`}
                    title="Remove this — not relevant"
                    className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-300 hover:text-gray-700 leading-none"
                  >×</button>
                ) : <span className="pr-1.5" />}
              </span>
            ))}
          </div>
        )}
        {debug && renderAiContribution()}
        {debug && renderTruthTable()}
        {debug && renderDecisionTimeline()}
        <textarea
          value={form.requirementNotes}
          onChange={(e) => setField('requirementNotes', stripPII(e.target.value))}
          rows={3}
          placeholder="Anything else suppliers should know? (size, brand, deadline, application…)"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none"
        />
        <p className="text-[11px] text-gray-400 mt-1.5">
          Shared with suppliers — please don't include phone, email or personal contact here.
        </p>
      </div>
    </div>
    );
  };

  // ─── Location popover — your location + delivery location, with geolocation ───
  const renderLocationPopover = (align: 'left' | 'right' = 'right') => (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setLocationEditing(false)} />
      {/* Bottom-sheet on mobile, anchored popover on desktop */}
      <div
        className={`fixed inset-x-0 bottom-0 z-40 w-full rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left space-y-3 bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-3rem)] sm:rounded-2xl sm:border sm:p-3 ${
          align === 'left' ? 'sm:left-0' : 'sm:right-0'
        }`}
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-1 sm:hidden" />
        <button
          onClick={fetchMyLocation}
          disabled={geoLoading}
          className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-teal-600 border border-teal-200 bg-teal-50 rounded-xl px-3 py-2 hover:bg-teal-100 transition-colors disabled:opacity-60"
        >
          {geoLoading ? (
            <span className="w-4 h-4 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <MapPin size={14} />
          )}
          {geoLoading ? 'Locating…' : 'Use my current location'}
        </button>
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Your location
          </p>
          <LocationSearch
            value={form.clientLocation}
            onChange={(v) => setField('clientLocation', v)}
          />
        </div>
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Delivery location
          </p>
          <LocationSearch
            value={form.deliveryLocation}
            onChange={(v) => setField('deliveryLocation', v)}
          />
        </div>
        <button
          onClick={() => setLocationEditing(false)}
          className="w-full py-2 rounded-xl bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700 transition-colors"
        >
          Done
        </button>
      </div>
    </>
  );

  // ─── Score breakdown popover ─────────────────────────────────────────────────
  const renderScorePopover = () => {
    const groups = ['Product', 'Specs', 'Details'] as const;
    return (
      <>
        <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setScoreOpen(false)} />
        {/* Bottom-sheet on mobile, anchored popover on desktop */}
        <div
          className="fixed inset-x-0 bottom-0 z-40 w-full max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72 sm:max-w-[85vw] sm:max-h-[70vh] sm:overflow-y-auto sm:rounded-2xl sm:border"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelCloseScore}
          onMouseLeave={scheduleCloseScore}
        >
          <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-2 sm:hidden" />
          <div className="flex flex-col items-center mb-3">
            <span
              className="text-3xl font-extrabold leading-none"
              style={{ color: getScoreColor(scoreDetails.total) }}
            >
              {scoreDetails.total}
            </span>
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mt-1">
              {getScoreLabel(scoreDetails.total)} · RFQ strength
            </span>
          </div>
          <div className="space-y-3 sm:max-h-60 sm:overflow-y-auto scroll-auto-hide pr-1">
            {groups.map((g) => {
              const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
              if (!items.length) return null;
              return (
                <div key={g}>
                  <p className="text-[10px] font-semibold text-gray-300 uppercase tracking-wide mb-1">
                    {g}
                  </p>
                  {items.map((c) => (
                    <div key={c.label} className="flex items-center justify-between py-1">
                      <span
                        className={`flex items-center gap-2 text-sm ${
                          c.done ? 'text-gray-700' : 'text-gray-400'
                        }`}
                      >
                        <span
                          className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0 ${
                            c.done ? 'bg-teal-500 text-white' : 'border border-gray-300'
                          }`}
                        >
                          {c.done ? '✓' : ''}
                        </span>
                        {c.label}
                      </span>
                      {!c.done && (
                        <span className="text-xs text-gray-400 font-medium">+{c.pts - c.earned}</span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {nextCheck && (
            <div className="mt-3 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide">
                  Fill next
                </p>
                <p className="text-sm font-semibold text-amber-800 truncate">
                  {nextCheck.label} <span className="text-amber-500">+{nextCheck.pts - nextCheck.earned}</span>
                </p>
              </div>
              <ArrowRight size={16} className="text-amber-500 shrink-0 ml-2" />
            </div>
          )}
        </div>
      </>
    );
  };

  // 🧠 Enrichment dump (DIRECT webhook fields + LLM-derived profile) — pulled-data debug, shown in
  // the step-0 staging view. Extracted from the spec page so the pulled-data panels live in ONE place.
  const renderEnrichmentDump = () => (!enrichment ? null : (
    <div className="border border-blue-200 bg-blue-50 rounded-xl p-3 text-[11px] text-blue-900 space-y-1">
      <p className="font-bold">🧠 Enrichment (GLID {enrichment.glid || glidInput})</p>
      <p className="text-blue-400">↓ DIRECT from webhook fields (no LLM)</p>
      <p><b>PII:</b> {[enrichment.buyer?.fullName, enrichment.buyer?.designation, enrichment.buyer?.companyName, enrichment.buyer?.city, enrichment.buyer?.state, enrichment.buyer?.locality, enrichment.buyer?.mobile, enrichment.buyer?.email, enrichment.buyer?.verifiedBusiness ? 'verified✓' : '', enrichment.buyer?.primaryLanguage].filter(Boolean).join(' · ')} <span className="text-blue-400">→ preserved at last step + in payload</span></p>
      <p><b>persona (direct):</b> {[enrichment.persona?.type, enrichment.persona?.scale, enrichment.persona?.commercial ? 'commercial' : '', `repeat=${enrichment.persona?.repeatBuyer}`, enrichment.persona?.multiSku ? `multi-SKU(${enrichment.persona?.domains?.length})` : '', enrichment.persona?.whatsappAffinity ? `WA:${enrichment.persona.whatsappAffinity}(${enrichment.persona.whatsappMsgs})` : ''].filter(Boolean).join(' · ')}</p>
      <p><b>history:</b> {(enrichment.categories || []).map((c) => `${c.mcat}(${c.source})`).join(', ') || '—'}</p>
      {(() => { const m = matchCategory(enrichment, form.productName); return m ? <p><b>MATCHED “{m.mcat}”:</b> specs {JSON.stringify(m.knownSpecs || {})} · sellerAsked {JSON.stringify(m.sellerQuestions || [])}</p> : <p className="text-blue-400">no category match for “{form.productName || '—'}”</p>; })()}
      {buyerProfile && Object.keys(buyerProfile).length > 0 && (
        <div className="mt-1 pt-1 border-t border-blue-200">
          <p className="text-blue-400">↓ LLM-DERIVED via deriveBuyerProfile (persists across requirements)</p>
          <p><b>🧬 profile:</b> {[buyerProfile.persona, buyerProfile.maturity, buyerProfile.sourcingStyle, buyerProfile.buyingPattern, buyerProfile.decisionStyle, buyerProfile.infoSeeking && `info:${buyerProfile.infoSeeking}`, buyerProfile.supplierPreference, buyerProfile.localityPreference, buyerProfile.engagement, buyerProfile.responseSensitivity, buyerProfile.multiSku ? 'multi-SKU' : ''].filter(Boolean).join(' · ')}{typeof buyerProfile.confidence === 'number' ? ` · conf ${Math.round(buyerProfile.confidence * 100)}%` : ''}</p>
          {buyerProfile.summary && <p className="italic">“{buyerProfile.summary}”</p>}
          {buyerProfile.tags?.length ? <p><b>tags:</b> {buyerProfile.tags.join(', ')}</p> : null}
          {buyerProfile.nature && (
            <p className="mt-1 pt-1 border-t border-blue-200"><b>🏛 Nature:</b> {buyerProfile.nature} <span className="text-blue-400">· conf {buyerProfile.natureConfidence ?? '—'} · source email-domain · evidence: {(buyerProfile.natureEvidence || []).join('; ') || '—'} · used by: planner (bpfLine + nature rule)</span></p>
          )}
          {buyerProfile.authority && (
            <p><b>🎖 Authority:</b> {buyerProfile.authority} <span className="text-blue-400">· conf {buyerProfile.authorityConfidence ?? '—'} · source designation · evidence: {(buyerProfile.authorityEvidence || []).join('; ') || '—'} · used by: planner (bpfLine + authority rule)</span></p>
          )}
          {buyerProfile.procurementModel && (
            <p><b>📦 Procurement model:</b> {buyerProfile.procurementModel} <span className="text-blue-400">· conf {buyerProfile.procurementModelConfidence ?? '—'} · source history (LLM, persistent prior) · used by: planner (bpfLine) — current order mode still outranks</span></p>
          )}
        </div>
      )}
      {buyerTwin && (
        <p className="text-blue-500 mt-1 pt-1 border-t border-blue-200">
          🧬 <b>Buyer Twin v1.2</b> below ↓ — full evidence ledger · window.__buyerTwin
        </p>
      )}
      {identity && identity.anchorCount > 0 && (
        <p className="mt-1 pt-1 border-t border-blue-200"><b>🪪 Identity (composite):</b> {identityLine(identity)} <span className="text-blue-400">· source first-party + observed-external (PAN) · window.__identity</span>{identity.conflicts.length > 0 && <span className="text-red-500"> · ⚠ {identity.conflicts.join('; ')}</span>}</p>
      )}
      {(() => { const oc = observedExternalContext(); return oc ? (
        <p className="mt-1 pt-1 border-t border-blue-200"><b>🛰 Observed → planner:</b> {oc} <span className="text-blue-400">· Befisc/Sign3/identity distilled to a SOFT signal · now FED to planRequirement + deriveIntent (weighed, never a hard/Verified fact)</span></p>
      ) : null; })()}
      <p className="text-blue-400">raw: {enrichmentRaw ? 'window.__enrichment' : '—'} · profile: window.__buyerProfile · identity: window.__identity</p>
    </div>
  ));

  // ─── B-step-2: Step-0 STAGING view ────────────────────────────────────────────
  // Shown when opened from the landing's "Pull" (stagingOnly). Renders the PULLED-data debug
  // panels — reusing the existing renderers in-scope (no state lift) — then "Start RFQ →" flips
  // this same instance to the clean form (onStart), so the data persists (no re-pull).
  const renderStagingView = () => (
    <div className="p-6 space-y-3 max-h-[88vh] overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900">Buyer data {pull?.glid ? <span className="text-gray-400 font-normal">· GLID {pull.glid}</span> : ''}</p>
          <p className="text-xs text-gray-500">Review what we pulled, then start — the product screen stays clean.</p>
        </div>
        <button type="button" onClick={handleClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200 shrink-0"><X size={16} /></button>
      </div>
      {enrichLoading && (
        <p className="text-sm text-gray-400 flex items-center gap-2"><span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Pulling buyer history…</p>
      )}
      {!enrichLoading && !enrichment && (
        <p className="text-sm text-amber-600">No history pulled{pull && !pull.ok ? ' — the webhook returned nothing for that GLID.' : '.'} You can still start a cold RFQ.</p>
      )}
      {enrichment?.buyer && (
        <p className="text-[11px] text-green-700 bg-green-50 border border-green-100 rounded-lg px-2.5 py-1.5">✓ {enrichment.buyer.fullName || enrichment.buyer.firstName || 'Buyer'}{enrichment.buyer.city ? ` · ${enrichment.buyer.city}` : ''}{enrichment.persona?.type ? ` · ${enrichment.persona.type}` : ''}{enrichment.categories?.length ? ` · ${enrichment.categories.length} prior cats` : ''}</p>
      )}
      {/* L4 — Executive (CEO) view toggle: plain-language snapshot vs the engineer panels. */}
      {enrichment && (
        <button type="button" onClick={() => setCeoView((v) => !v)} className="self-start rounded-full border border-slate-400 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
          {ceoView ? '🔧 Show engineer view' : '👔 Executive view (plain English)'}
        </button>
      )}
      {ceoView && enrichment && renderExecutiveView()}
      {/* the PULLED-data debug panels — the same renderers the spec page used, now shown here at step 0 */}
      {!ceoView && (<>
        {renderVerificationDashboard()}
        {renderEnrichmentDump()}
        {renderPipelineHealth()}
        {renderExternalPullHealth()}
        {renderLLMCallHealth()}
        {renderBuyerDossier()}
        {renderTwinDebug()}
        {renderBuyerIntelligenceLedger()}
        {enrichmentRaw != null && renderRawFetchDump()}
      </>)}
      <button
        type="button"
        onClick={() => onStart?.()}
        className="w-full mt-2 rounded-xl bg-teal-600 text-white font-semibold py-3 hover:bg-teal-700 flex items-center justify-center gap-2 sticky bottom-0"
      >
        Start RFQ <ArrowRight size={16} />
      </button>
    </div>
  );

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm overflow-y-auto"
      style={{ WebkitOverflowScrolling: 'touch', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Debug/trace toggle — flip to trace every source, reason & decision. */}
      <button
        type="button"
        onClick={() => setDebug((d) => !d)}
        className={`fixed top-2 right-2 z-[70] text-[11px] font-mono px-2.5 py-1 rounded-md shadow transition-colors ${
          debug ? 'bg-purple-600 text-white' : 'bg-white/90 text-gray-500 border border-gray-200 hover:bg-white'
        }`}
        title="Toggle debug / traceability"
      >
        🐞 {debug ? 'debug ON' : 'debug'}
      </button>
      <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl lg:max-w-3xl overflow-hidden animate-modal-in"
      >
        {/* GLOBAL processing loader — shows on EVERY step whenever ANY model call / data processing is
            in flight (intent → planner → refine → deduce, profile, twin), so the form never looks frozen
            between Continue/Next and the next screen ("specs not coming"). Thin top sweep + a floating
            pill naming what's running. Absolutely-positioned pill → no layout shift. */}
        <div className="h-1 w-full overflow-hidden bg-gray-100">
          {(llmBusy || specsLoading) && <div className="h-full w-1/3 bg-teal-500 rounded-full animate-[progress-bar_1.1s_ease-in-out_infinite]" />}
        </div>
        {(llmBusy || specsLoading) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[68] flex items-center gap-1.5 bg-teal-600 text-white text-[11px] font-medium px-3 py-1 rounded-full shadow-lg pointer-events-none animate-[fadeIn_0.2s_ease]">
            <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            {specsLoading && !llmBusy ? 'Loading specifications…' : llmBusyText(llmBusyLabel)}
          </div>
        )}
        {stagingOnly ? renderStagingView() : step === 0 ? (
          /* ── TWO PANEL LAYOUT ── */
          <div className="flex h-full" style={{ minHeight: 520 }}>
            {/* LEFT PANEL — hidden on mobile */}
            <div className="hidden sm:flex w-[42%] bg-teal-50 p-6 flex-col items-center justify-center gap-4 relative">
              {form.imageBase64 ? (
                /* User's own uploaded photo takes priority over the API sample */
                <div
                  className="relative w-full rounded-2xl overflow-hidden bg-white shadow-sm"
                  style={{ aspectRatio: '4/3' }}
                >
                  <span className="absolute top-2 left-2 text-[10px] text-teal-600 bg-white/80 px-2 py-0.5 rounded">
                    Your photo
                  </span>
                  <img
                    src={`data:${form.imageMimeType};base64,${form.imageBase64}`}
                    alt={form.productName || 'Uploaded'}
                    className="w-full h-full object-cover"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-2 right-2 flex items-center gap-1 text-[10px] text-gray-500 bg-white/80 px-2 py-1 rounded-lg"
                  >
                    <Camera size={10} /> Replace
                  </button>
                </div>
              ) : productImageUrl ? (
                <div
                  className="relative w-full rounded-2xl overflow-hidden bg-white shadow-sm"
                  style={{ aspectRatio: '4/3' }}
                >
                  <span className="absolute top-2 left-2 text-[10px] text-gray-400 bg-white/80 px-2 py-0.5 rounded">
                    Sample image
                  </span>
                  <img
                    src={productImageUrl}
                    alt={form.productName}
                    className="w-full h-full object-contain p-4"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-2 right-2 flex items-center gap-1 text-[10px] text-gray-500 bg-white/80 px-2 py-1 rounded-lg"
                  >
                    <Camera size={10} /> Add yours
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full rounded-2xl border-2 border-dashed border-teal-200 bg-white flex flex-col items-center justify-center gap-2 p-8 hover:border-teal-300 transition-colors"
                  style={{ aspectRatio: '4/3' }}
                >
                  <Camera size={32} className="text-teal-400" />
                  <span className="text-sm text-teal-500 font-medium">Upload photo</span>
                </button>
              )}

              <div className="text-center">
                <p className="font-bold text-teal-700">
                  {form.productName
                    ? `Looking to buy ${form.productName}?`
                    : 'Looking to buy something?'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Just complete a few simple steps to get
                  <br />
                  Instant quotes from Verified Suppliers
                </p>
              </div>
            </div>

            {/* RIGHT PANEL */}
            <div className="flex-1 flex flex-col p-6 min-w-0 relative">
              {/* Close — top-right, consistent with steps 2 & 3 */}
              <button
                onClick={handleClose}
                className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200"
              >
                <X size={16} />
              </button>
              <label className="block text-sm font-semibold text-gray-700 mb-2 pr-10">
                Enter Product/Service name <span className="text-red-500">*</span>
              </label>

              <div className="relative" ref={inputWrapperRef}>
                <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100">
                  <input
                    type="text"
                    value={form.productName}
                    onChange={(e) => handleProductInputChange(e.target.value)}
                    onFocus={() => setShowDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && form.productName) handleProductCommit(form.productName);
                    }}
                    onBlur={(e) => {
                      // T2: clicking truly OUTSIDE the box finalises the typed product. Skip when focus
                      // moves to a suggestion / Speak / Camera inside the wrapper — those have their own
                      // handlers (the suggestion's onMouseDown already commits), so we never double-commit
                      // or overwrite a picked suggestion with the half-typed text.
                      const rt = e.relatedTarget as Node | null;
                      if (rt && inputWrapperRef.current?.contains(rt)) return;
                      const name = form.productName.trim();
                      if (name && name !== committedProduct.current) handleProductCommit(name);
                    }}
                    placeholder="e.g., TMT Bar, Diesel Generator..."
                    className="flex-1 min-w-0 px-4 py-3 text-base sm:text-sm outline-none bg-transparent"
                  />
                  <button
                    onClick={() => {
                      setVoiceTarget('main');
                      setShowVoiceRecorder(true);
                    }}
                    className="flex items-center justify-center px-3 text-green-600 border-l border-gray-100 hover:bg-green-50 py-3 transition-colors"
                    aria-label="Speak your requirement" title="Speak"
                  >
                    <Mic size={18} />
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 text-gray-400 border-l border-gray-100 hover:bg-gray-50 py-3 transition-colors"
                  >
                    <Camera size={16} />
                  </button>
                </div>

                {/* Dropdown */}
                {showDropdown &&
                  (productSuggestions.length > 0 ||
                    (recentSearches.length > 0 && !form.productName)) && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden max-h-52 overflow-y-auto">
                      {!form.productName && recentSearches.length > 0 && (
                        <>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-4 pt-3 pb-1">
                            Recent Searches
                          </p>
                          {recentSearches.map((r) => (
                            <button
                              key={r}
                              onMouseDown={() => handleProductCommit(r)}
                              className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 flex items-center gap-2"
                            >
                              <ArrowRight size={12} className="text-gray-400" /> {r}
                            </button>
                          ))}
                        </>
                      )}
                      {productSuggestions.map((s) => (
                        <button
                          key={s}
                          onMouseDown={() => handleProductCommit(s)}
                          className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
              </div>

              {/* GLID + Pull + Ignore-Twin + all pulled-data debug panels live on the LANDING now:
                  "Pull" opens the step-0 STAGING view (debug panels), "Start RFQ →" flips to this clean
                  product screen with the data already pulled. Only the result is confirmed here. */}
              <div className="mt-4">
                {enrichLoading && (
                  <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
                    Pulling buyer history…
                  </p>
                )}
                {enrichment?.buyer && (
                  <p className="text-[11px] text-green-600 mt-1.5">
                    ✓ {enrichment.buyer.fullName || enrichment.buyer.firstName || 'Buyer'}
                    {enrichment.buyer.city ? ` · ${enrichment.buyer.city}` : ''}
                    {enrichment.persona?.type ? ` · ${enrichment.persona.type}` : ''}
                    {enrichment.categories?.length ? ` · ${enrichment.categories.length} prior cats` : ''}
                  </p>
                )}
                {/* Pulled-data debug (raw dump + Twin/Dossier/Pipeline/External/LLM/Ledger) now lives in the
                    step-0 STAGING view (landing "Pull"), not on the product screen. */}
              </div>

              {/* P (Quick Re-post): "Buy again" cards — appear once a GLID with prior requirements is pulled. */}
              {renderRepostCards()}

              {/* Quantity + Unit — only when the API provides quantity units */}
              {unitOptions.length > 0 && (
                <div className="mt-4 space-y-4 animate-field-in" key={committedMcatId.current}>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Quantity <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={form.quantity}
                      // T1: typing un-commits; the qty is committed on blur / Enter (and on Continue) so
                      // the intent + requirement-mode compute on the FINAL value, never a partial keystroke.
                      onChange={(e) => { setField('quantity', e.target.value.replace(/[^0-9]/g, '')); setQtyCommitted(false); }}
                      onBlur={() => setQtyCommitted(true)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { setQtyCommitted(true); (e.currentTarget as HTMLInputElement).blur(); } }}
                      placeholder="e.g., 500"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 animate-field-highlight"
                    />
                    {/* T3: gentle "just 1?" check ONLY for a small MEASURE unit (Kg/Litre/Metre) where 1
                        is genuinely unusual for B2B. Never for a BULK unit (1 Tonne/Quintal is a real
                        order) nor a DISCRETE unit (1 Piece is fine) — those nudges were wrong. */}
                    {form.quantity === '1' && !!form.unit && UNIT_MEASURE.test(form.unit) && (
                      <p className="mt-1.5 text-[11px] text-amber-600">Just 1 {form.unit}? For business orders that’s often a sample — update it if you need more.</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Unit <span className="text-red-500">*</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {unitOptions.map((u) => (
                        <RadioChip
                          key={u}
                          label={u}
                          selected={form.unit === u}
                          onClick={() => setField('unit', u)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Page-1 Intent hero — the WHY question (Twin-inspired chips) REPLACES the old
                  business/personal toggle. Buyer-kind is auto-derived from the Twin (or inferred
                  from the chosen journey for cold buyers), so we never ask "who's buying" outright.
                  P0.4: a glanceable confirmable buyer-kind note sits above it. */}
              {debug && renderExecSummary(0)}
              {renderBuyerKindNote()}
              {renderPage1Intent()}
              {debug && renderPage1IntentDebug()}

              <button
                onClick={handleNext}
                className={`mt-auto w-full py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
                  form.productName
                    ? 'bg-teal-600 text-white hover:bg-teal-700'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {form.productName ? 'Continue' : 'Next'}
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        ) : (
          /* ── SINGLE PANEL (steps 1 & 2) ── */
          <div className="flex flex-col max-h-[88vh]">
            {/* Header */}
            <div className="px-5 pt-4 pb-0 flex items-center gap-3 shrink-0">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-10 h-10 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-400 hover:border-teal-300 shrink-0 overflow-hidden"
              >
                {form.imageBase64 ? (
                  <img
                    src={`data:${form.imageMimeType};base64,${form.imageBase64}`}
                    className="w-full h-full object-cover rounded-xl"
                    alt=""
                  />
                ) : (
                  <Camera size={16} />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-teal-600 text-base leading-tight truncate">
                  {form.productName}
                </p>
                <p className="text-xs text-gray-400 truncate">
                  {step === 1 ? 'Specifications' : 'Delivery & Payment'}
                </p>
              </div>

              {/* Delivery-location pill (final step) — desktop header */}
              {step === 2 && (
                <div className="relative shrink-0 hidden sm:block">
                  <button
                    type="button"
                    onClick={() => {
                      setScoreOpen(false);
                      setLocationEditing((v) => !v);
                    }}
                    className="flex items-center gap-1 max-w-[150px] px-2.5 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-xs text-gray-700 transition-colors"
                    aria-label="Change delivery location"
                  >
                    <MapPin size={12} className="text-teal-500 shrink-0" />
                    <span className="truncate">
                      {form.deliveryLocation || detectedLocation || 'Select city'}
                    </span>
                    <Pencil size={11} className="text-gray-400 shrink-0" />
                  </button>
                  {locationEditing && renderLocationPopover('right')}
                </div>
              )}

              {/* Score circle — hover (desktop) / tap (mobile) to see the breakdown */}
              <div
                className="relative shrink-0"
                onMouseEnter={openScoreHover}
                onMouseLeave={scheduleCloseScore}
              >
                <button
                  type="button"
                  onClick={() => {
                    setLocationEditing(false);
                    setScoreOpen((v) => !v);
                  }}
                  className="relative w-11 h-11 block rounded-full hover:bg-gray-50 transition-colors"
                  aria-label="View RFQ score breakdown"
                >
                  <svg viewBox="0 0 44 44" className="w-11 h-11 -rotate-90">
                    <circle cx="22" cy="22" r="18" fill="none" stroke="#e5e7eb" strokeWidth="3" />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke={getScoreColor(scoreDetails.total)}
                      strokeWidth="3"
                      strokeDasharray={`${(scoreDetails.total / 100) * 113.1} 113.1`}
                      strokeLinecap="round"
                      style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.5s ease' }}
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-700">
                    {scoreDetails.total}
                  </span>
                </button>
                {scoreDelta !== null && (
                  <span
                    className="absolute -top-1 -right-1 text-[11px] font-bold text-green-600 animate-score-delta pointer-events-none"
                    style={{ textShadow: '0 1px 2px rgba(255,255,255,0.9)' }}
                  >
                    +{scoreDelta}
                  </span>
                )}
                {scoreOpen && renderScorePopover()}
              </div>

              <button
                onClick={handleClose}
                className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200 ml-1 shrink-0"
              >
                <X size={14} />
              </button>
            </div>

            {/* Orange progress bar */}
            <div className="mx-5 mt-3 h-0.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
              <div
                className="h-full bg-orange-400 rounded-full transition-all duration-500"
                style={{ width: progressPercent + '%' }}
              />
            </div>

            {/* Scrollable body */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scroll-auto-hide px-5 py-5 space-y-5">
              {step === 1 && renderSpecPage()}
              {step === 2 && renderDeliveryPage()}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between bg-white shrink-0">
              <button
                onClick={handleBack}
                className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
              >
                ← Back
              </button>
              <span className="text-sm text-teal-600 font-medium">
                {step === 2 ? 'Last step!' : '1 more step'}
              </span>
              <button
                onClick={handleNext}
                className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-teal-700 transition-all"
              >
                {step === 2 ? 'Get Quotes' : 'Next'}
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImageUpload(f);
          }}
        />
      </div>
      </div>

      {intentSheetOpen && renderIntentSheet()}

      {assistOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
          onClick={() => !assistLoading && setAssistOpen(false)}
        >
          <div
            className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold text-gray-800 flex items-center gap-1.5">
                <span className="text-teal-500">✦</span> Help me fill the specs
              </p>
              <button
                onClick={() => setAssistOpen(false)}
                className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            {assistLoading ? (
              <div className="py-8 flex flex-col items-center gap-3 text-center">
                <span className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-semibold text-gray-700">Analysing your requirement…</p>
                <p className="text-xs text-gray-400">Matching it to the right specs</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-3">
                  Tell us where / how you'll use {form.productName || 'it'} — type or speak, even add a photo.
                </p>
                <textarea
                  value={assistInput}
                  onChange={(e) => setAssistInput(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="e.g., rebar for a 3-storey house foundation in a seismic zone"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none"
                />
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => {
                      setVoiceTarget('assist');
                      setShowVoiceRecorder(true);
                    }}
                    className="flex items-center justify-center px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0"
                    aria-label="Speak your requirement" title="Speak"
                  >
                    <Mic size={18} />
                  </button>
                  <button
                    onClick={() => {
                      setAssistOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 shrink-0"
                  >
                    <Camera size={15} /> Photo
                  </button>
                  <button
                    onClick={handleAssistSubmit}
                    disabled={!assistInput.trim()}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                      !assistInput.trim()
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-teal-600 text-white hover:bg-teal-700'
                    }`}
                  >
                    Fill my specs <ArrowRight size={15} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showVoiceRecorder && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
          onClick={() => setShowVoiceRecorder(false)}
        >
          <div
            className="bg-white w-full sm:w-auto sm:min-w-[320px] rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <VoiceRecorder
              onRecordingComplete={handleVoiceRecordingComplete}
              onCancel={() => {
                setShowVoiceRecorder(false);
                if (voiceTarget === 'assist') {
                  setVoiceTarget('main');
                  setAssistOpen(true);
                }
              }}
            />
          </div>
        </div>
      )}
      {(voiceProcessing || imageAnalyzing) && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl px-6 py-5 flex items-center gap-3">
            <span className="w-5 h-5 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-semibold text-gray-700">
              {voiceProcessing ? 'Transcribing your voice…' : 'Analyzing image…'}
            </span>
          </div>
        </div>
      )}
      {showOTP && (
        <OTPGate onVerified={handleOTPVerified} onClose={() => setShowOTP(false)} />
      )}
      {showSuccess && (
        <SellerResultsModal
          productName={form.productName}
          rfqScore={scoreDetails.total}
          onClose={() => {
            setShowSuccess(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}
