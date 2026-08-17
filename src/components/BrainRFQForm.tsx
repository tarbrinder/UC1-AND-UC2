import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  ArrowLeft, ArrowRight, Search, Mic, Camera, X, Pencil, MapPin,
  ChevronRight, ChevronDown, ChevronUp, Clock,
  LogIn, CheckCircle2, ListPlus, LocateFixed, RotateCcw, Sparkles,
} from 'lucide-react';
import { getJSON, postJSON } from '../lib/api';
import { fetchProductSuggestions, filterProducts, stripQuantityPrefix, parseQuantityFromName } from '../utils/productNames';
import { sanitizeQty, qtyIsMeaningful, isValidGSTIN } from '../utils/formValidation';
import { detectAbsurdQty } from '../lib/absurdQty';
import type { ISQSpec, RFQFormData } from '../types';
import { calcScore, getScoreColor, getScoreLabel, type ScoreCheck } from '../utils/score';
import { bes, besReset, besSubmitted } from '../lib/bes';
import { registerRenderedActions } from '../lib/consumptionLadder';
import OptionChips from './OptionChips';
import OTPGate from './OTPGate';
import LocationSearch from './LocationSearch';
import VoiceRecorder from './VoiceRecorder';
import IndiaMartHeader from './IndiaMartHeader';
import CuratedSellerBoard from './CuratedSellerBoard';
import { searchSellers, curateBoard, type SellerResult } from '../lib/sellerSearch';
import { analyzeImage, voiceToSpecs, hasGeminiKey, inferSpecsFromApplication, checkTitleMcatMismatch, checkRetailIntent, assistChat, extractFromChat, RFQ_LLM_ENABLED, type AiSpecQuestion, type CuratedPlan, type CuratedPreAnswer } from '../lib/gemini';
import { mcatPlausible } from '../lib/mcatSanity';
// 3-LLM Dynamic RFQ spine (the Commercial + Persona planners run as their OWN stages after specs).
import { runRequirementBrain, runProfileSynthesizer, type ProfileSynth } from '../lib/rfq/llm';   // LLM 1 stays inline; LLM 2/3 in usePlannerController; LLM 4 (profile synth) fires here on the commit batch
import type { EffortMode, PlannerEnvelope, RequirementBrain } from '../lib/rfq/contracts';
import { buildSession, canonConcept, dropAnswered as mergeLayer, fallbackContext as buildFallbackBrain, haveRealBrain } from '../lib/rfq/plannerController'; // PlannerController — extracted pure orchestration helpers
import { detectLocationConflict, type LocationSignal } from '../lib/rfq/locationConflict'; // #1/#2 spec-page location-conflict prompt
import { usePlannerController } from '../lib/rfq/usePlannerController';   // LLM 2 + LLM 3 orchestration (step 2)
import { distillCategory, fetchCategoryBrainFull, fetchPnsInsights, hasPayload, recordSource } from '../lib/rfq/dataLayer';
import { fetchProductImages, upsizeImimg } from '../lib/enrichment';
import {
  recordDecisionRoutes, decisionKey, RELOCATABLE_LAST_PAGE_FIELDS,
  type BrainSeed, type DecisionRoute, type RelocatableField, type PlacementSurface,
} from '../lib/brains/formAdapter';
import type { ConflictOption } from '../lib/brains/requirementBrain';
import { matchUnit, isRetailCandidate } from '../lib/quantity';
import { reconcilePostedRequirement, type RfqReq } from '../lib/rfq/categoryReconcile';
// SPEC HYGIENE (owner-reported, 2026-07-28) — two ISQ rows that must never become form controls:
//   sanitizeUnitOptions   drops the input-TYPE token ("Text") that IM_SPEC_OPTIONS_DESC leaks into the
//                         quantity-UNIT picker, so the buyer cannot ship "100000 Text" to a seller.
//   isProductInterestField suppresses an "I am interested in" row whose options are sibling MCAT PRODUCTS
//                         (Old Newspapers / Waste Paper / Dona Paper Roll …) — it re-asks the one thing the
//                         buyer already told us, the product, and burns a question slot.
// Both can only ever SUPPRESS; neither may invent a value. See src/lib/specHygiene.ts for the rules + why
// each predicate is deliberately narrow (a false positive deletes a legitimate buyer question).
//   isQtyUnitField        "is this row the dedicated quantity/unit field?" — promoted out of FOUR component
//                         copies (two still had the unbounded /quantity|qty|unit/i "1 kg" defect). One rule.
import { isNonSpecNote, isProductInterestField, isQtyUnitField, sanitizeUnitOptions, cleanBuyerText, isIllegalQuestion, isSupplierPrefField } from '../lib/specHygiene';
import { emit, EV, emitApiError } from '../lib/emit';
import { useToast, type ToastType } from './Toast';
import { useFocusTrap } from '../lib/useFocusTrap';
import { resolveRfqTheme, rfqThemeClass } from '../lib/theme';

// "Post a Requirement → Get Quotes" — the simple RFQ flow. UI is a faithful clone of RFQModalV3
// (two-panel product step · single-panel spec/delivery with the header score-circle + orange progress
// bar + RadioChips + Back/Next footer) with the intelligence stripped: NO twin / enrichment pull /
// planner / use-case questions / category-intel / n8n. The ONLY AI is the opt-in mic + camera, which
// reuse V3's Gemini analyzeImage/voiceToSpecs. Mobile = V3 chrome, EXCEPT the front/product page which
// takes the IndiaMART-Lens treatment. Desktop = V3 popup, all pages.

type Surface = 'mobile' | 'desktop';
// THE PAGES (owner 2026-07-28 — the spec page SPLITS, superseding the earlier "one continuous spec page" lock):
//   'landing' = product name + qty/unit + the repost/enrich/source chooser — ONE surface, not two. The
//               chooser used to be its own page in BrainFormGate, so the buyer walked through two
//               near-identical "name your product" screens before he could type anything.
//   'specs'   = "details I need to fill" — the unanswered specs and every question (conflicts, the planner's
//               opening + ranked gaps, suggestions, the identity/persona asks, promoted last-page fields).
//   'specs2'  = "details prefilled" — specs that already carry a value from ANY source (engine prefill, LLM,
//               photo, mic, typed textbox, repost seed), shown prefilled + editable for confirmation, each one
//               marked with the AI icon (`AiMark`) and rendered as its FULL option group with the value
//               selected. NO receipt strip and no provenance text (owner 2026-07-28 — see AiMark). NO LLM call
//               fires here; the planner is done. Rendered ONLY when the split earns itself (see specGroups).
//   'more'    = the LAST page = "Your Profile & Delivery" (Logistics&Payment + About You + Contact + consent).
//   'results' = the CLOSING page: curated sellers.
type Stage = 'landing' | 'specs' | 'commercial' | 'persona' | 'results';   // #79: 'more' (the last page) deleted — persona/specs is now the last numbered page
type CategoryMode = 'simple' | 'category';

/** One entry on the landing's chooser: a requirement he actually expressed (enrich / repost) or a product
 *  he only viewed ('new'). Structurally the engine's `Recommendation` — declared here so the form depends
 *  on a RENDER shape and not on the brain contract. */
export interface LandingRec {
  product: string; mcat?: string; action: string; status?: string;
  age_days?: number | null; is_expired?: boolean; image?: string | null;
  specs?: { name: string; value: string }[];
}
export interface LandingData {
  recs: LandingRec[];
  /** The buyer's own memory — feeds the suggester's top ranks (his truth outranks the catalogue). */
  memory?: { recent_searches?: string[]; viewed?: { name: string }[] };
  /** He tapped one of his own cards. The HOST swaps the seed (requirement-scoped Decision Objects and all)
   *  and remounts the form, which comes back up on this same landing with the product already named. */
  onPick: (rec: LandingRec) => void;
}

// The captured requirement handed back to the host (fixes P1-113). ⚑ DEV-TODO: the real BuyLead-generation API
// consumes this — wire it in `dispatchBuyLead` below (owner: BL API provided later).
export interface RFQSubmission {
  productName: string;
  mcatId: string;
  text: string;                // the lossless requirement text (buildRequirementText)
  quantity: string;
  unit: string;
  specs: Record<string, string>;
  commercial?: Record<string, string>;   // Page 2 · LLM-2 commercial answers (warranty/delivery/payment/…)
  persona?: Record<string, string>;      // Page 3 · LLM-3 buyer-persona answers (designation/industry/size/…)
  contact: { name: string; mobile: string; email: string };
  cityId?: string;             // canonical IndiaMART city id for the delivery location (resolveCityId; '' until the city endpoint is wired)
  verification?: Record<string, string>;   // #6 optional GST-absent proof (udyam/pan/aadhaar) — ⚑ DPDP-sensitive, separate from seller-facing text; must not ship until KYC endpoint + DPDP review
  imageBase64?: string;
  brain?: RequirementBrain;    // plan §5 — the hidden Requirement-Brain trace for downstream seller-matching (never buyer-facing)
}

interface Props {
  onClose: () => void;
  surface?: Surface;
  categoryMode?: CategoryMode; // 'simple' (default) = NO category corpus (buyer+seller+user only); 'category' = corpus-driven (needs v51 n8n)
  loggedIn?: boolean;          // logged-in buyer: contact collapsed + prefilled, no Login button, no OTP text
  standalone?: boolean;        // full-page route (fills viewport, no popup backdrop) vs dashboard popup
  onSubmit?: (req: RFQSubmission) => void; // host receives the requirement (BL generation); demo falls back to the results screen
  landing?: LandingData;       // the chooser's data — his requirements + viewed products, on the LANDING page
  glid?: string;               // buyer GLID — lets the Commercial planner pull real PNS insights (bi-pns-insights)
  execMode?: 'prod' | 'debug'; // Simulator: prod (lightweight) vs debug (verbose) prompts for LLM 2 / LLM 3
  effortMode?: EffortMode;     // Simulator (page -1): reasoning effort for ALL 3 LLMs — same in prod & debug. Default high.
  pnsMode?: 'api' | 'full';    // Simulator: PNS API-only (fast) vs full transcripts
  // #4 — the RAW leaf truth fetched once at the gate (bi-csl-parser · bi-rfq-details · bi-bpod · bi-whatsapp). LLM 1
  // (runRequirementBrain) synthesises Page 1 from THIS the moment the buyer commits a product (pns is fetched here,
  // on commit, because it needs the mcat). Absent on the legacy dashboard/standalone routes that never had a gate.
  leafTruth?: { csl: unknown; rfq: unknown; profile: unknown; whatsapp: unknown; enquiries?: unknown[]; rfqRequirements?: Array<{ product?: string; mcat?: string; specs?: { name: string; value: string }[] }> } | null;
}

// THE NUMBERED STEPS ARE DYNAMIC (owner 2026-07-28): THREE when the spec page splits, TWO when it does not.
// The LANDING is the entry, not a step: it has its own chrome and renders no stepper at all, so it is
// deliberately absent. The list itself is built inside the component (it depends on the split) — see
// `stepper` / `stepCount` / `stageNodeIdx` there, which are the ONE source every derived value reads:
// progressPercent, the "Step X of N" copy on both surfaces, the stepper's aria-labels, goToNode, goBack,
// goNext, the popstate handler and checkStageIdx. Nothing may hardcode a step count or a neighbour stage.
// Page 1 = "Specifications" (the planner's questions); page 2 = the buyer's own specs, confirmed.
const STEPPER_LABELS = { specs: 'Specifications', commercial: 'Commercial', persona: 'About You' } as const;

// ─── RadioChip (cloned verbatim from RFQModalV3) ───
function RadioChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] border rounded-full text-sm transition-all ${
        selected ? 'border-teal-500 bg-teal-50 text-teal-700 font-medium' : 'border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? 'border-teal-500' : 'border-gray-300'}`}>
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />}
      </span>
      {label}
    </button>
  );
}

// ─── THE AI MARK (owner 2026-07-28) ─────────────────────────────────────────────────────────────────────
// "do we need these lines .. just put an AI icon for pre filled specs.. and of course they go at second spec
// page, and not just filled but with options and options selected just in case user wants to change".
// It replaces the whole "Filled from your history" receipt strip and every per-field provenance line. ONE
// icon, NO text, no tier colours, no per-chip badge: it says "we filled this in for you, change it if you
// like" and nothing about WHERE the value came from (see the privacy lock on personaSource). The accessible
// name is deliberately channel-free too — a screen reader must not read out what the screen does not show.
// This narrows the earlier no-visual-hierarchy lock to exactly this: an icon, and nothing else.
const AiMark = () => (
  <span title="Filled in for you — change it if you like" aria-label="Filled in for you" role="img"
    className="ml-1.5 align-middle text-[13px] font-normal leading-none text-teal-500">✦</span>
);

const TIMELINE = ['Immediate', 'Within 15 Days', '1 Month', 'Flexible'];
const PAYMENT_TERMS = ['Full Advance', 'Credit (Post-Delivery)', 'COD', 'Loan/Finance'];
const CREDIT_PERIODS = ['15 Days', '30 Days', '45 Days', '60 Days', '90 Days'];
const BUSINESS_TYPES = ['Online Business', 'Exporter', 'Manufacturer', 'Retailer', 'Service Provider', 'Wholesaler', 'Individual Buyer'];
// Purchase cadence has never had a last-page control (it arrives as a ranked gap when it earns a slot). It
// gets one now ONLY when the planner explicitly places it there — see RENDERS_BY_DEFAULT in formAdapter.
// The landing chooser's action badges — moved here from BrainFormGate together with the chooser itself.
// 'new' = something he only VIEWED, so the offer is to SOURCE it; the other two are requirements he expressed.
const ACTION_LABEL: Record<string, string> = { enrich: 'Add More Details', repost: 'Repost', new: 'Source' };
const ACTION_TONE: Record<string, string> = { enrich: 'bg-teal-100 text-teal-800', repost: 'bg-amber-100 text-amber-800', new: 'bg-gray-100 text-gray-600' };

// ─── IDENTITY, FROM THE SEED ONLY (P0, 2026-07-28) ──────────────────────────────────────────────────────
// Placeholders the profile channel carries where a real value is withheld. They are NOT identity: filling
// "MASKED" into a name box, or a masked GSTIN into the GST box, ships garbage to a seller under the buyer's
// name. Fully anchored — a real company called "NA Industries" must survive this untouched.
const IDENTITY_PLACEHOLDER = /^(masked|redacted|hidden|xx+|x{2,}\d*|n\/?a|na|nil|none|null|undefined|unknown|-+|0+)$/i;
// #4 known_truths routing (owner 2026-07-30). A qty-like truth from LLM 1 fills the Quantity state (LLM-owned qty,
// CF-3), NOT an "also detected" spec row; identity / contact / context keys are never specs and never render as
// detected specs. Both word-bounded (anchored / \b) so the field-routing substring-guard sweep passes.
const KT_QTY = /^(order\s+)?(qty|quantity)$/i;
// J-fix — TWO-TIER identity/context filter (was one \b-anchored blob that word-dropped real specs like "Physical
// State", "Person Capacity", "Model Name", "Interest Rate"). Tier 1: unambiguous identity/contact tokens that are
// implausible as spec keys → always drop. Tier 2: generic words that ALSO appear in real spec names → drop ONLY when
// the WHOLE key is an identity/context phrase (qualifier + word, or a known phrase), never on bare containment.
const KT_HARD_IDENTITY = /\b(mobile|phone|email|gst|gstin|pincode|address|firm|company|turnover|designation|enquiry|inquiry|contact)\b/i;
const KT_CONTEXT_KEY = /^(buyer|company|contact|delivery|billing|shipping|full|first|last|recent|product)?\s*(name|state|person|city|location|interest|past|previous)$/i;
const KT_CONTEXT_PHRASE = /(delivery\s+state|contact\s+person|company\s+name|buyer\s+name|product\s+interest|recent\s+enquiry|search\s+(browse\s+)?interest)/i;
const isNonSpecKey = (key: string): boolean => { const k = key.trim(); return KT_HARD_IDENTITY.test(k) || KT_CONTEXT_KEY.test(k) || KT_CONTEXT_PHRASE.test(k); };
// The DEMO stand-in, gated and labelled (owner). The five literals below used to be the DEFAULT for every
// logged-in buyer — 'Demo Buyer' / '9876543210' / 'Manufacturer' / 'Construction Equipment' / a fake GSTIN —
// so a notebook-paper buyer submitted his requirement as a Construction Equipment manufacturer, on the very
// page that says "About you". `?demoIdentity=1` is now the only way any of it appears, and when it does the
// last page carries a visible "demo identity" badge so nobody mistakes it for the buyer's own record.
const DEMO_IDENTITY = (() => { try { return new URLSearchParams(window.location.search).get('demoIdentity') === '1'; } catch { return false; } })();
const DEMO_IDENTITY_VALUES = { name: 'Demo Buyer', mobile: '9876543210', email: 'demo.buyer@example.com', buyerType: 'Manufacturer', industry: 'Construction Equipment', gstin: '27AABCU9603R1ZM', persona: 'Demo manufacturer' };

// SimpleRFQForm AI calls run on the form's /api/llm proxy path (key injected server-side, never bundled; all pass
// route:'form'). Per-call MODEL routing (owner 2026-07-24): hints + mic → the fast lite tier (3.5-flash-lite);
// image + page-2 AI-specs → the stronger tier (3.6-flash). Standard has no AI. (Buyer-card is separate — its own key.)
const RFQ_MODEL_MIC = 'google/gemini-3.5-flash-lite';   // voiceToSpecs (mic)
const RFQ_MODEL_IMAGE = 'google/gemini-3.6-flash';      // analyzeImage (photo)
// (RFQ_MODEL_SPECS retired with runCuratedPlanner — LLM 1 runRequirementBrain uses callLLM's default fast tier.)
// Hard ceiling on AUTOMATIC planner runs per product. Legitimate re-plans are few and countable — a new mcat,
// a photo, a voice clip, a late ISQ schema. Anything past this is a feedback loop, and each run is a full call
// carrying up to 200k chars of category corpus. Reset to 0 by an explicit buyer Retry.
const MAX_PLANNER_RUNS = 6;
// SETTLE-DEBOUNCE before the planner fires (owner 2026-07-29, latency #1). The planner used to fire up to 4× —
// once per input that lands in the opening burst (GetIsq, then the getISQs enrichment, then category-brain, then
// its own prefills) — and ~75% of that model-time was thrown away (only the last run survives). A short quiet
// window collapses that burst into ONE fire with the settled inputs; a genuinely-late source (the ~15-30s getISQs
// enrichment) still triggers at most one cheap re-rank, which is the "emit fast, re-rank when slow lands" the
// vision endorses. 700ms is imperceptible against a ~20s planner and the buyer is still on the landing/page-1.
const PLANNER_SETTLE_MS = 700;
const RFQ_MODEL_USECASE = 'google/gemini-3.6-flash';    // inferSpecsFromApplication (use-case assist) — reasoning-heavy → stronger tier
const hasFormLLM = () => RFQ_LLM_ENABLED || hasGeminiKey();

// (DEMO_SELLERS removed 2026-07-23 — the results page now renders REAL ranked sellers from the windmill
//  curated_seller_search API; see src/lib/sellerSearch.ts + the sellerStatus/sellerResults flow.)

// (P2-221's `isQtyUnitField` — "is this row the dedicated quantity/unit field?" — now lives in specHygiene.ts
//  and is imported above. It existed in FOUR component copies, two of which still used the original unbounded
//  /quantity|qty|unit/i and therefore still had the "1 kg delivery unit" defect. One rule, one home.)
// Snap an extracted value to the closest chip OPTION (case/format/whitespace-insensitive) so a mapped value like
// "1-Phase" selects the real chip instead of creating a near-duplicate "Other". No fuzzy match → keep the value
// (OptionChips renders it as a custom "Other" entry). The LLM already does the SEMANTIC map (single→1); this is
// the deterministic safety-net for formatting differences.
function snapToOption(value: string, options: string[]): string {
  if (!value || !options || !options.length) return value;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nums = (s: string) => s.match(/\d+(?:\.\d+)?/g) || []; // numeric runs, for the digit-safe containment guard
  const nv = norm(value);
  if (!nv) return value;
  const exact = options.find((o) => norm(o) === nv);
  if (exact) return exact;
  const vNums = nums(value);
  const contains = options.find((o) => {
    const no = norm(o);
    if (no.length < 2 || !(no.includes(nv) || nv.includes(no))) return false;
    // audit #4: a bare substring match between digit-bearing values is a FALSE positive — "5 kVA"⊂"7.5 kVA",
    // "230"⊂"2300 V", "10"⊂"100 kVA". Only accept containment when the numeric content is identical (or neither
    // side has digits — e.g. "Silent"→"Silent/Canopy" stays valid). Otherwise keep the buyer's value verbatim.
    const oNums = nums(o);
    if (vNums.length || oNums.length) return vNums.length === oNums.length && vNums.every((n, i) => n === oNums[i]);
    return true;
  });
  return contains || value;
}
function mapDisplaySpecs(rows: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>): ISQSpec[] {
  return (rows || [])
    // THE ONE CHOKE POINT for "may this ISQ row become a form control at all". Both GetIsq's `fast` set and
    // getISQs' buyer-spec enrichment run through here, so a row suppressed here is suppressed everywhere that
    // reads `isqSpecs`: the rendered spec list, the planner's `buyerSpecs`/`buyerSpecOptions`, and the score.
    .filter((r) => r && r.IM_SPEC_MASTER_DESC && !isQtyUnitField(r.IM_SPEC_MASTER_DESC) && !isProductInterestField(r.IM_SPEC_MASTER_DESC))
    .slice(0, 30) // P3-305: was 10 — a rich-ISQ category could silently lose buyer specs. 30 covers every real schema.
    .map((r) => {
      // P2-222: split ONLY on '##' (the documented delimiter). The old '/##|,/' fallback shattered legitimate
      // comma-bearing option values ('1,000 kVA' → '1' + '000 kVA'). Live data confirms '##' is always the delimiter.
      const raw = (Array.isArray(r.OPTIONS_DATA) && r.OPTIONS_DATA.length
        ? r.OPTIONS_DATA.map((o) => (o.IM_SPEC_OPTIONS_DESC || '').trim()).filter(Boolean)
        : (r.IM_SPEC_OPTIONS_DESC || '').split('##').map((o) => o.trim()).filter(Boolean));
      // Same hygiene the unit picker uses (owner 2026-07-30 — the "no options on Page 1" report): drop leaked
      // input-TYPE tokens ("Text"/"Textbox"/"Dropdown"/"Select"/"None"/"Other"...) via the EXACT-match noise set,
      // so a free-text/number spec never renders a bogus single "Text" chip while real options ("Number of
      // Pieces") survive. A spec left with zero options correctly falls back to the free-text input.
      const opts = sanitizeUnitOptions(raw);
      return { ...r, IM_SPEC_OPTIONS_DESC: opts.join('##') };
    });
}

// Merge two ISQ spec lists by name; on a name collision KEEP the row that carries OPTIONS (owner 2026-07-30).
// GetIsq's `fast` set frequently arrives option-less while the getISQs enrichment carries OPTIONS_DATA — the old
// de-dup took the leading row wholesale and silently discarded the option-bearing sibling, so a spec like
// "Notebook Size" rendered chip-less. `lead` order is preserved; an option-less lead row is upgraded in place
// with the follower's options.
function mergeSpecsPreferOptions(lead: ISQSpec[], follow: ISQSpec[]): ISQSpec[] {
  const byLc = new Map<string, ISQSpec>();
  const order: string[] = [];
  const add = (s: ISQSpec) => {
    const k = s.IM_SPEC_MASTER_DESC.toLowerCase();
    const existing = byLc.get(k);
    if (!existing) { byLc.set(k, s); order.push(k); return; }
    if (!(existing.IM_SPEC_OPTIONS_DESC || '').trim() && (s.IM_SPEC_OPTIONS_DESC || '').trim())
      byLc.set(k, { ...existing, IM_SPEC_OPTIONS_DESC: s.IM_SPEC_OPTIONS_DESC }); // upgrade the option-less incumbent
  };
  for (const s of lead) add(s);
  for (const s of follow) add(s);
  const merged = order.map((k) => byLc.get(k) as ISQSpec);
  // DEDUP a generic spec that is a whole-word SUFFIX of a more-specific sibling (deep-audit 2026-08-12 #16): mcat
  // 205235 ships BOTH "Diaper Size" and "Size" (both prefilled "S") and the lowercased-name map above keeps both.
  // Drop the generic ("Size"), keep the specific ("Diaper Size"), and carry the dropped row's options if the kept one
  // has none. Whole-word-suffix ONLY — so distinct siblings like "Screen Size" + "Paper Size" are untouched; only a
  // bare trailing "Size" is collapsed onto its longer relative.
  const lc = merged.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase());
  const redundant = new Set<number>();
  for (let i = 0; i < merged.length; i++) {
    for (let j = 0; j < merged.length; j++) {
      if (i === j) continue;
      const si = lc[i], sj = lc[j]; // si redundant iff it is a strict whole-word trailing suffix of sj
      if (sj.length > si.length && sj.endsWith(si) && sj[sj.length - si.length - 1] === ' ') {
        redundant.add(i);
        if (!(merged[j].IM_SPEC_OPTIONS_DESC || '').trim() && (merged[i].IM_SPEC_OPTIONS_DESC || '').trim())
          merged[j] = { ...merged[j], IM_SPEC_OPTIONS_DESC: merged[i].IM_SPEC_OPTIONS_DESC };
        break;
      }
    }
  }
  return merged.filter((_, i) => !redundant.has(i));
}

const fileToBase64 = (file: Blob): Promise<{ base64: string; mime: string }> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve({ base64: s.slice(s.indexOf(',') + 1), mime: (s.match(/^data:([^;]+);/) || [])[1] || file.type || 'image/jpeg' }); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // owner: photos up to 5 MB
// Normalize ANY uploaded image to a model-readable JPEG (owner's HEIC solution): iPhone HEIC won't decode in the
// Gemini model OR the browser preview, so we decode via createImageBitmap → <canvas> → re-encode JPEG, downscaled
// to ≤1600px (also shrinks the base64 payload). Rejects >5 MB. Throws 'too-large' / 'undecodable' so onPhoto can
// show the right message. Fixes P1-120 (+ the HEIC decode gap + P2-239 preview mime).
async function normalizeImage(file: File): Promise<{ base64: string; mime: string }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('too-large');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('undecodable'); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('undecodable');
  ctx.drawImage(bitmap, 0, 0, w, h); bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: 'image/jpeg' };
}

// ─── THE FLOW-ADVANCE CTA · Secondary Indigo ──────────────────────────────────────────────────────────────────
// Owner decision 2026-07-28, resolving a real conflict between this project's "CTAs are teal-700" lock and the
// IndiaMART design guide. The guide's "Primary vs Secondary" rule is explicit: "Post Requirement" is Secondary
// Indigo #2e3192, while Primary Teal is reserved for "Call Supplier" / per-seller inquiry. This form IS the
// post-requirement flow, so its FOUR advance actions — Continue, Next (desktop + mobile) and Get Quotes — carry
// indigo, and every per-seller action stays teal, which is what the guide wants and what the form already did.
// Not a cosmetic swap: white on #2e3192 is 10.66:1, against 4.50:1 for white on teal-600. Hover is the guide's own
// --secondary-hover. Declared ONCE because four hand-copied class strings is how CTAs drift out of sync.
const CTA_ADVANCE = 'bg-[#2e3192] text-white hover:bg-[hsl(239,52%,32%)]';

export default function BrainRFQForm({ onClose, surface, categoryMode = 'category', loggedIn = false, standalone = false, onSubmit, brainSeed, landing, glid, execMode = 'prod', effortMode = 'high', pnsMode = 'api', leafTruth = null }: Props & { brainSeed?: BrainSeed }) {
  const _seed = brainSeed;
  // #4 — live mirror of the raw leaf truth, so the LLM-1 effect reads the freshest value the gate has resolved
  // (the prop can land after mount, since the leaves are ~3s). Consumed by runRequirementBrain on product commit.
  const leafTruthRef = useRef(leafTruth);
  useEffect(() => { leafTruthRef.current = leafTruth; }, [leafTruth]);
  // Freeze the surface ONCE at mount — otherwise a mid-flow viewport crossing 640px (rotate/resize)
  // would silently swap the whole mobile↔desktop chrome on the next state change.
  const [surf] = useState<Surface>(() => surface ?? (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 'desktop' : 'mobile'));
  const isMobile = surf === 'mobile';

  // ALWAYS the landing (owner-locked 2026-07-28). `_seed.startStage` is deliberately no longer read: an
  // enrich/repost seed used to open straight on 'specs', and whether this mcat even DEFINES a quantity is
  // only knowable after the mcat resolves — so that entry skipped the qty ask and then bounced the buyer
  // BACKWARDS onto the product page a second later. The landing now owns the decision from the start: a
  // seeded product arrives here already named, and the two effects near `autoAdvancedFor` either ask for
  // quantity or move him on. (The old bounce is kept below as a backstop, where it is now unreachable.)
  const [stage, setStage] = useState<Stage>('landing');

  const [productName, setProductName] = useState(_seed?.productName ?? '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [productImageUrl, setProductImageUrl] = useState(_seed?.productImage ?? '');
  const [productImages, setProductImages] = useState<string[]>([]); // front-page gallery (IMSearchAPI: hero + up to 3 thumbnails)
  const [imageBase64, setImageBase64] = useState('');

  const [quantity, setQuantity] = useState(_seed?.quantity ?? '');
  const [unit, setUnit] = useState(_seed?.unit ?? '');
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [unitOpen, setUnitOpen] = useState(false);   // Unit UI = dropdown (owner 2026-08-13, "B"): opens after qty; stacked chips looked odd on mobile
  const unitBtnRef = useRef<HTMLButtonElement>(null);
  const [absurdAck, setAbsurdAck] = useState(false); // buyer confirmed an unusually-large quantity → stop re-nagging (owner 2026-08-13, absurd-qty)
  // ── Retail-intent gate (task #75, owner 2026-08-14): after qty commit on a qty-collecting category, an LLM asks
  // whether this is a personal/one-off RETAIL buy; if the buyer confirms it is, the flow drops to the buyer-specs-only
  // 'static' tier. retailChoice is the buyer's OWN answer (not an inferred gate) — the owner-safe version of the
  // 2026-08-11 router revert. retailCheckedFor dedups the LLM per mcat+qty+unit; retailChecking shows the brief spinner.
  const [retailChoice, setRetailChoice] = useState<'retail' | 'business' | null>(null);
  const [showRetailGate, setShowRetailGate] = useState(false);
  const [retailChecking, setRetailChecking] = useState(false);
  const retailCheckedFor = useRef('');               // `${mcatId}:${qty}:${unit}` already asked → never re-spends the LLM / re-prompts
  const [catName, setCatName] = useState('');        // resolved glcat_mcat_name mirror (state, so the MCAT-sanity check can react to it arriving)
  const [mcatMismatch, setMcatMismatch] = useState(false); // fly-ash class (#65): product ↔ category looks wrong → soft "right category?" nudge
  const mcatCheckedFor = useRef('');                 // mcatId we've already run the mismatch check for (once per product)
  const [isqSpecs, setIsqSpecs] = useState<ISQSpec[]>([]);
  const [specValues, setSpecValues] = useState<Record<string, string>>(_seed?.specValues ?? {});
  // Ref mirror of specValues. Needed because a setState UPDATER runs on the next render, so nothing written
  // inside it is readable in the same call — and `applyExtractedSpecs` must know, synchronously, whether it
  // actually changed a field before it re-fires the planner (see the non-terminating-loop note there).
  const specValuesRef = useRef(specValues);
  useEffect(() => { specValuesRef.current = specValues; }, [specValues]);

  // ── THE SPEC PAGE, SPLIT IN TWO (owner 2026-07-28) ──────────────────────────────────────────────────────
  // "i would like to split the questions to two screens if more than 4 specs in one page ... but of course no
  //  LLM on second spec page, LLM has already done its work .. in fact lets keep first page for details i need
  //  to fill, and 2nd spec page for details prefilled ... either by LLM or from photo/mic/textbox/product spec
  //  or repost". This SUPERSEDES the earlier one-continuous-page lock.
  //
  // WHICH GROUP a spec is in is decided by PROVENANCE, not by live emptiness. If it were live, filling the last
  // blank spec on page 1 would delete page 1 out from under the buyer and renumber the stepper mid-flow — the
  // same class of defect as the quantity page that used to bounce him backwards. So the classification is a
  // SNAPSHOT: it keeps absorbing the planner's late async prefills for as long as the buyer has touched
  // nothing, and freezes the instant he edits a spec or leaves the spec pages.
  // "Also detected" — buyer-truth facts (from name/photo/mic) that don't fit a buyer ISQ field. Never lost:
  // shown as editable key-value rows below the specs and shipped in the requirement. Buyer edits are preserved.
  const [extraSpecs, setExtraSpecs] = useState<Record<string, string>>({});
  const [extraSpecSrc, setExtraSpecSrc] = useState<Record<string, string>>({}); // per-key origin (LLM-1 known_truth.source) so an "Also detected" row can name where it came from
  // The planner's ranked `gaps` — options-only questions not already known. Declared up here, out of its state
  // block, because the page count below has to see it (see onPageCount).
  const [aiSpecs, setAiSpecs] = useState<AiSpecQuestion[]>([]);
  // (`specsTouchedRef` + `prefilledSpecNames` + their tracking effect were DELETED 2026-08-01 with the 'specs2'
  //  stage. They existed ONLY to decide which specs sat on the prefilled page and to freeze that grouping on the
  //  buyer's first edit; with one spec page there is no grouping to freeze, and the state had no reader left — it
  //  was recomputing a name list on every keystroke for nobody.)
  // (`specGroups` was DELETED 2026-08-01 with the 'specs2' stage. Its only live consumer was the permanently-false
  //  `split` flag, and the completeness fill that once read its prefilled/unfilled arrays was removed earlier.)
  // ── THE FLOW ROUTER (owner 2026-08-11: "do we need to fire all of this for every buyer?") ─────────────────
  // A DETERMINISTIC router — no new LLM. It reuses the bulk-B2B gate the seed already carries (assessBulkB2B →
  // _seed.bulkGate) to decide how much flow a buyer gets, so a light/retail buyer isn't dragged through the
  // Commercial + Persona pages (and their two LLM calls) he doesn't need — the single biggest "no waiting" win is
  // simply NOT firing planners for buyers who don't warrant them. Derived from the gate ALONE (stable per mount,
  // so it never re-prunes the stepper mid-flow — the renumber hazard called out above); qty is deliberately not a
  // signal (units vary kg/piece/tonne, and order_value≥50k is already folded into the gate).
  //   full        = both dynamic pages — a genuine bulk-B2B buyer (gate fired ≥3 independent signals).
  //   commercial  = Commercial only, skip Persona — a light-B2B buyer (1–2 signals, not vetoed): the intent /
  //                 delivery / payment questions clear a lower bar than a persona read.
  //   static      = neither — a vetoed (B2C / one-off) or signal-less buyer goes straight to the last page.
  const flowMode = useMemo<'full' | 'commercial' | 'static'>(() => {
    // ROUTER re-enabled for ONE trustworthy trigger only (owner 2026-08-14, task #75): the buyer's OWN answer to the
    // retail-intent question. When he confirms "this is a personal / one-off buy", he goes to the buyer-specs-only
    // 'static' tier (no Commercial, no Persona, no profile-synth). The owner's 2026-08-11 revert was about not trusting
    // INFERRED B2C routing (the _seed.bulkGate branch below) — an explicit buyer confirmation is a different, safe
    // signal, so that inferred branch stays OFF. retailChoice only ever flips on the LANDING (the gate fires before the
    // landing→specs advance), so pruning the stepper here never renumbers a numbered step mid-flow.
    if (retailChoice === 'retail') return 'static';
    return 'full';
    // INFERRED bulkGate routing stays disabled (owner 2026-08-11 "revert the b2b/b2c thingy"):
    // const g = _seed?.bulkGate;
    // if (g?.vetoed_by) return 'static'; if ((g?.score ?? 0) === 0) return 'static'; if (g && !g.is_bulk_b2b) return 'commercial';
  }, [retailChoice]);
  const isRetailLite = retailChoice === 'retail';   // buyer confirmed a personal/retail purchase → hide the B2B planner surfaces
  const includeCommercial = flowMode === 'full' || flowMode === 'commercial';
  const includePersona = flowMode === 'full';
  // ── THE ONE SOURCE OF TRUTH for the numbered steps. Everything below derives from this array. ────────────
  // The router prunes Commercial/Persona out of it, and because goNext/goBack/progress/"Step N of M"/the popstate
  // handler all read `stepper`, pruning here redirects the whole flow with no other navigation edits.
  const stepper = useMemo<Array<{ label: string; stage: Stage }>>(() => {
    const steps: Array<{ label: string; stage: Stage }> = [{ label: STEPPER_LABELS.specs, stage: 'specs' }];
    if (includeCommercial) steps.push({ label: STEPPER_LABELS.commercial, stage: 'commercial' });
    if (includePersona) steps.push({ label: STEPPER_LABELS.persona, stage: 'persona' });
    // #79: the 'more' page is DELETED. The last numbered step is now persona (full flow) or specs (retail/static).
    return steps;
  }, [includeCommercial, includePersona]);
  const stepCount = stepper.length;   // the ONE place the "of N" copy comes from
  // #79: the last numbered page (whatever it is), so Get-Quotes / contact / seller-search key off it, not a hardcoded 'more'.
  const lastStage: Stage = stepper[stepper.length - 1]?.stage ?? 'specs';
  const isLastStep = stage === lastStage;
  // Monotonic position in the flow: 0 = the landing (entry), 1..stepCount = the numbered steps, stepCount+1 =
  // the closing page. For a numbered stage the index IS its step number, which is what makes "Step N of M" true.
  const stageNodeIdx = useCallback((s: Stage): number => {
    if (s === 'landing') return 0;
    if (s === 'results') return stepCount + 1;
    const i = stepper.findIndex((n) => n.stage === s);
    return i >= 0 ? i + 1 : 1;   // an unknown stage reads as the first step rather than throwing off "Step N of M"
  }, [stepper, stepCount]);
  // Live mirror for the popstate handler, which is mounted once with [] deps and must still step back through
  // the CURRENT stepper (a hardcoded "more → specs" would skip the prefilled page whenever we split).
  const stepStagesRef = useRef<Stage[]>([]);
  stepStagesRef.current = stepper.map((n) => n.stage);
  // (the empty-planner auto-skip effect lives further down, once mcatId / aiSpecsLoading / plannerFiredFor exist.)
  // (extraSpecs and aiSpecs are declared ABOVE, with the split block — the "more than 4 on one page" count has to
  //  see them, and a useState cannot be read before it is declared. Their explanatory comments moved with them.)
  const extraEditedRef = useRef<Set<string>>(new Set()); // extra keys the buyer edited/removed → don't let a re-run clobber them
  const [specsLoading, setSpecsLoading] = useState(false);
  // #F — true once getISQs has resolved (arrive-or-error), i.e. the SELLER specs are in. Gates LLM 1 so it never
  // fires on an empty sellerSpecsRef when GetIsq clears `specsLoading` first (the seller-specs race). Reset per commit.
  const [sellerSpecsReady, setSellerSpecsReady] = useState(false);
  const [mcatId, setMcatId] = useState('');
  // Page-1 buyer-spec hints (from the unified Curated-RFQ planner's field_hints): per-field captions. We never
  // HIDE a spec based on the planner's read — async AI must ENRICH, never yank an already-shown field (hiding
  // caused specs to "appear then vanish" ~1s after the page rendered; we show all buyer specs).
  const [isqHints, setIsqHints] = useState<Record<string, string>>({});
  const [aiSpecsLoading, setAiSpecsLoading] = useState(false);
  const [aiSpecsError, setAiSpecsError] = useState(false); // the planner threw/timed-out — distinct from a genuine "0 questions"
  const [aiSpecValues, setAiSpecValues] = useState<Record<string, string>>({});
  // LLM 1's ALTERNATIVE for an already-filled buyer spec (ui:'suggest'), keyed by ISQ spec name. Rendered as a
  // non-sticky "suggested" ghost chip beside the spec — tap to accept; the buyer's own value is never overwritten.
  const [llmSuggests, setLlmSuggests] = useState<Record<string, string>>({});
  const [aiEpoch, setAiEpoch] = useState(0); // bumped when a photo/voice adds specs → re-runs the AI-specs prompt with them
  // ── 3-LLM Dynamic RFQ: Commercial (LLM 2) + Persona (LLM 3) run as their OWN stages after specs. ──
  const [commercialPlan, setCommercialPlan] = useState<PlannerEnvelope | null>(null);
  // The latest committed commercial plan, as a REF. LLM 3 (persona) fires in PARALLEL with LLM 2, so the value prop
  // isn't populated at LLM 3's effect-run time; LLM 3 reads this ref at ITS resolve (after commercial resolves) to
  // dedup its questions against the commercial ones — the old cross-page dedup, minus the page-2 re-fire.
  const commercialPlanRef = useRef<PlannerEnvelope | null>(null);
  const [personaPlan, setPersonaPlan] = useState<PlannerEnvelope | null>(null);
  const [cxAnswers, setCxAnswers] = useState<Record<string, string>>({});
  const [psAnswers, setPsAnswers] = useState<Record<string, string>>({});
  const [cxLoading, setCxLoading] = useState(false);
  const [psLoading, setPsLoading] = useState(false);
  // #76 fix: a "Try again" on a failed planner clears its fire-once ref, but clearing a REF does not re-run a useEffect —
  // only a dep change does. This nonce (bumped by retryCx/retryPs, threaded into the planner effect deps) makes retry
  // actually re-fire the planner. Without it the planner stays stuck loading and the new Next-gate traps the buyer.
  const [plannerRetry, setPlannerRetry] = useState(0);
  // C10: a planner that FAILED (transport error / unparseable JSON) is a different state from one that legitimately
  // had nothing to ask. The former gets a visible message + retry; the latter still auto-skips (owner CF-4).
  const [cxFailed, setCxFailed] = useState(false);
  const [psFailed, setPsFailed] = useState(false);
  const cxFiredFor = useRef(''); const psFiredFor = useRef('');
  // Did the last commercial/persona fire run on the thin fallbackContext (LLM 1 not yet landed)? If so, allow ONE
  // upgrade re-fire when the real Requirement Brain arrives (bug-hunt 2026-07-30 — else LLM 2/3 stay pinned to it).
  const cxUsedFallback = useRef(false); const psUsedFallback = useRef(false);
  const cxUsedNoCategory = useRef(false); // did the commercial fire run BEFORE the Category Engine landed? allow ONE re-plan when it does.
  // PARALLEL FIRE bookkeeping: whether a planner's plan came back EMPTY (→ skip the page on arrival). The snapshot
  // refs below are legacy pre-warm bookkeeping, now inert — every planner fires exactly once at commit, so nothing
  // compares a page snapshot to re-fire (owner 2026-08-12: "these calls, nothing else").
  const cxPage1Snap = useRef(''); const psPage2Snap = useRef('');
  const cxIsEmpty = useRef(false); const psIsEmpty = useRef(false);
  // LLM 4 · Profile Synthesizer (2026-08-11) — the last-page buyer profile. Fires on the commit batch (buyer-level
  // truth only, no page dependency), producing the full internal read + the safe autofills.
  const synthFiredFor = useRef(''); const synthGen = useRef(0);
  const [profileSynth, setProfileSynth] = useState<ProfileSynth | null>(null);
  const [, setSynthLoading] = useState(false);   // #79: LLM 4 is debug-only now (no profile card); loading value unused
  // CARRY-FORWARD HARDENING (2026-08-11): the fields the buyer has actually TOUCHED (typed/picked) on pages 2/3.
  // A planner RE-FIRE (item 2) may refresh an UNTOUCHED auto-seeded prefill with its new value, but a field the
  // buyer edited must always stand — so the prefill-seed effect overwrites only fields NOT in these sets.
  const cxTouched = useRef<Set<string>>(new Set()); const psTouched = useRef<Set<string>>(new Set());
  // #④ PNS is fetched ONCE on product commit (for LLM 1) and stashed here; the Commercial planner (LLM 2) reuses
  // it instead of firing a SECOND bi-pns-insights call and blocking the whole stage on it (up to 120s). Whatever
  // has landed by the time the buyer reaches Commercial is used; a not-yet-arrived pns is simply null (never waits).
  const pnsRef = useRef<unknown>(null);
  const [unitsResolved, setUnitsResolved] = useState(false); // true once GetIsq has returned — gates Continue past the loading race
  const [resolveError, setResolveError] = useState(false); // mcat-resolve network failure (distinct from "not a category")
  // Category CORPUS status (debug chip). The form fetches the raw per-call corpus fresh on mcat-known and
  // feeds it WHOLE to the single page-2 planner call — no n8n distill LLM, no cache.
  // CATEGORY TOP-SPECS MUST FOLLOW THE PRODUCT THE BUYER ACTUALLY PICKED (owner, 2026-07-28).
  // `_seed.categoryTopSpecs` is captured ONCE at mount for the engine's auto-chosen PRIMARY mcat. Pick a
  // different card (or type a new product) and the planner was still being advised by the old category —
  // e.g. choose "6 Gm Cup Cake Tray" (25188) and it reasoned with mcat 186822's questions. The corpus fetch
  // below already re-keys on mcatId; this makes the distilled top_specs do the same.
  const [catTopSpecs, setCatTopSpecs] = useState(_seed?.categoryTopSpecs);
  // The COMPLETE bi-category-brain payload for LLM 2 (owner: "recheck if complete category corpus is coming"). Held
  // SEPARATELY from catTopSpecs so the existing {q,pct,vals}[] contract — which gates the no-category re-fire and the
  // seed path — is untouched; this only enriches what LLM 2 reads and what the inspector shows.
  const [catCorpus, setCatCorpus] = useState<Record<string, unknown> | null>(null);
  const catBrainTok = useRef(0);
  useEffect(() => () => { catBrainTok.current++; }, []);
  useEffect(() => {
    // Bump the staleness token on EVERY path (incl. the early returns below), so a fetch still in flight for a
    // PREVIOUS mcat can never commit its corpus after a product switch (audit 2026-08-10). It was previously bumped
    // only on the refetch path, leaving prior fetches live through the seed short-circuit + the `!mcatId` return.
    const tok = ++catBrainTok.current;
    if (!mcatId) { setCatTopSpecs(undefined); setCatCorpus(null); return; }
    // Use the seed's category ONLY when it genuinely has one for THIS mcat. The `.length` guard is the anchor fix:
    // recommendationToSeed now OMITS the category for a card that is not the engine's primary (its category is the
    // primary's, i.e. the wrong product), so without this guard `mcatId === _seed.mcatId` would short-circuit to
    // `undefined` and never re-fetch — the buyer would get NO category insights. Now an absent seed category falls
    // through to a live re-fetch for the resolved mcat.
    // NOTE the reset below must run on EVERY path that leaves this effect, including this seed short-circuit —
    // `catCorpus` was left holding the PREVIOUS mcat's corpus here, so after a product switch LLM 2 could be fed a
    // different category's evidence entirely (found by audit 2026-08-01).
    // Seed short-circuit: use the seed's category for THIS mcat. CRITICAL (2026-08-10): also set catCorpus from the
    // seed's WHOLE category object — it carries personas/keywords/b2b_b2c that the distilled catTopSpecs does NOT, and
    // LLM 2 reads `catCorpus ?? catTopSpecs`. Leaving catCorpus null here fed LLM 2 the stripped feed → generic page 2.
    if (_seed?.mcatId && mcatId === _seed.mcatId && _seed.categoryTopSpecs?.length) { setCatTopSpecs(_seed.categoryTopSpecs); setCatCorpus((_seed.categoryCorpus as Record<string, unknown> | undefined) ?? null); return; }
    setCatTopSpecs(undefined); setCatCorpus(null);   // wrong-category advice is worse than none — clear first, then refetch
    const catT0 = Date.now();
    // ONE fetch, both consumers. The distilled {q,pct,vals} feed is DERIVED from the full payload via
    // distillCategory() instead of a second GET: the node disables Redash caching (max_age:0), so what an earlier
    // comment here called a "cache-warm" was in fact a second full execution of a ~185s-capable pipeline.
    fetchCategoryBrainFull(mcatId).then((full) => {
      if (catBrainTok.current !== tok) return;   // stale (mcat changed again / unmounted)
      const s = distillCategory(full);
      const analysed = typeof full?.calls_analyzed === 'number' ? full.calls_analyzed : undefined;
      // A category with 0 analysed calls is NOT proof the category is empty — the node reports success on a Redash
      // failure or poll timeout too, so "empty" and "broken pipe" are indistinguishable from here. Health is keyed
      // on whether real evidence arrived, and the raw payload (incl. any status/counters) is kept for the panel.
      recordSource('Category · bi-category-brain', { ok: hasPayload(s), ms: Date.now() - catT0, raw: full, cleaned: { top_specs: s, calls_analyzed: analysed } });
      if (full) setCatCorpus(full);
      // Do NOT re-fire LLM 1: category insights are NOT an LLM 1 input (owner-locked, both branches). LLM 2
      // (Commercial) reads the category fresh when it fires on its own stage, so it always sees the right one.
      if (s.length) setCatTopSpecs(s);
    }).catch((e) => { recordSource('Category · bi-category-brain', { ok: false, ms: Date.now() - catT0, raw: null, cleaned: null }); emitApiError('fetchCategoryBrainFull', e, { mcatId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId]);

  const [deliveryLocation, setDeliveryLocation] = useState(_seed?.deliveryLocation ?? '');
  const [userLocation, setUserLocation] = useState('');    // the buyer's OWN city (mockup "YOUR LOCATION")
  const [sameAsLoc, setSameAsLoc] = useState(true);         // "same as my location" — delivery mirrors user (default on)
  const [geoLoading, setGeoLoading] = useState(false);      // "Use my current location" in flight
  const [deliveryTimeline, setDeliveryTimeline] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [creditPeriod, setCreditPeriod] = useState('');
  const [paymentMode] = useState('');   // #79: the setter lived in the deleted logistics page; commercial (LLM 2) covers payment now
  const [buyerType, setBuyerType] = useState('');
  const [industry, setIndustry] = useState('');
  const [purchaseFrequency] = useState('');   // #79: setter lived in the deleted logistics page
  const [gstRegistered, setGstRegistered] = useState<boolean | null>(null); // null = UNKNOWN (Golden Rule: never assume "No"); only ASKED for a business role (not Individual Buyer)
  const [gstNumber, setGstNumber] = useState('');
  const [verifyOpen, setVerifyOpen] = useState(false);   // GST-absent verification spiral (owner #6, last page only)
  const [verifyUdyam, setVerifyUdyam] = useState('');
  const [verifyPan, setVerifyPan] = useState('');
  const [verifyAadhaar, setVerifyAadhaar] = useState('');
  const [requirementNotes, setRequirementNotes] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [companyName, setCompanyName] = useState('');   // buyer's firm — prefilled from profile (bp.contacts_company), like designation/industry
  const [detectedCity, setDetectedCity] = useState('');
  const [locationConfirmed, setLocationConfirmed] = useState(false);   // #1/#2: buyer has acknowledged the location prompt
  const [cityId, setCityId] = useState('');   // canonical city id for the delivery city (resolveCityId; '' until the IndiaMART city endpoint is wired)

  // ── UPFRONT NAME + LOCATION GATE (owner-locked 2026-08-13) ────────────────────────────────────────────────
  // A HARD BLOCK, fired shortly after product commit: a buyer whose name is empty/<3 chars OR whose delivery city
  // is empty/conflicting cannot proceed until BOTH are given. Empty name + wrong/absent city are the dominant
  // BL-audit lead defects a live call agent used to backfill ("BL Approved with Invalid Buyer Name", "City shared
  // & wrongly updated / missing") — the typed form has no such agent, so it asks the buyer directly, ONCE, the
  // moment the async profile (name) + CSL (city / conflict) signals have had ~3s to land.
  const [showIdentityGate, setShowIdentityGate] = useState(false);
  const [gateAsk, setGateAsk] = useState<{ name: boolean; city: boolean; cityConflict: boolean }>({ name: false, city: false, cityConflict: false }); // snapshot of what to ask at open — so a field never vanishes mid-entry
  const [gateCityChosen, setGateCityChosen] = useState(false); // conflict-case hard block: require a DELIBERATE city pick, not a reflexive Continue over the (possibly-wrong) pre-filled city
  const identityGateRef = useRef<HTMLDivElement>(null);
  const discardRef = useRef<HTMLDivElement>(null);
  const retailRef = useRef<HTMLDivElement>(null);    // focus-trap container for the retail-intent confirm modal (#75)
  const identityGateFiredFor = useRef('');   // mcatId we've already armed the gate for (fires once per product)
  const resubmitAfterGate = useRef(false);   // gate opened from the submit backstop → re-attempt submit once satisfied
  // Fresh mirror of the gate's inputs, so the (delayed) arm timer reads current values — not the stale commit-time closure.
  // `conflict` is mirrored here too (keyed on _seed below) because the profile/CSL city signal can land DURING the 3.5s
  // wait, and the arm effect's own deps ([committed, mcatId]) never see it — reading a fresh ref is the fix.
  const gateInputsRef = useRef({ name: '', city: '', locConfirmed: false, conflict: false });
  // Which blocking/soft overlay is open — read by the once-mounted popstate (browser Back) handler, which has [] deps.
  const overlaysRef = useRef({ gate: false, discard: false, retail: false });

  const [scoreOpen, setScoreOpen] = useState(false);
  const [locationEditing, setLocationEditing] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [showOTP, setShowOTP] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);  // close→"discard this requirement?" confirmation (no accidental loss)
  const otpVerified = useRef(false);
  // (cardIdx / openEnquiry / sentTo removed 2026-07-28 — the hero CAROUSEL and the per-card enquiry drawer they
  //  drove are gone with the closing-page rebuild. CuratedSellerBoard shows all six sellers at once, so there is
  //  no carousel index; and `sentTo` was purely local state behind an "Enquiry sent" toast that POSTed nothing.)
  // ── Real seller retrieval (windmill curated_seller_search) ──
  // Fired the moment the buyer leaves the (now-merged) spec page (owner) so the ~30s call overlaps the rest of the
  // flow (more → OTP). Results stream onto the results page; idle/loading shows the progress experience.
  const [sellerResults, setSellerResults] = useState<SellerResult[]>([]);
  const [sellerStatus, setSellerStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const sellerFiredFor = useRef('');   // mcatId the search already fired for (re-fires only on a NEW product)
  const sellerRunRef = useRef(0);      // monotonic — a stale in-flight response (product changed) is ignored

  const [aiBusy, setAiBusy] = useState('');
  const [showVoice, setShowVoice] = useState(false);
  const [scoreDelta, setScoreDelta] = useState(0);   // floating "+N" flash when the score rises
  const { show: showToast } = useToast();            // P3-309: ONE toast system — the global portal ToastProvider (was a 2nd inline toast)
  const [rfqTheme] = useState(resolveRfqTheme);      // IST-based dark theme, resolved once at mount (self-scoped via rfq-root)
  const themeClass = rfqThemeClass(rfqTheme);
  const prevScoreRef = useRef(0);
  // R7 steal — recent searches (localStorage), shown in the product dropdown when the field is empty.
  const [recents, setRecents] = useState<string[]>(() => { try { return (JSON.parse(localStorage.getItem('rfq_recent') || '[]') as string[]).slice(0, 6); } catch { return []; } });
  const pushRecent = (name: string) => {
    const n = name.trim(); if (!n) return;
    try { const cur = (JSON.parse(localStorage.getItem('rfq_recent') || '[]') as string[]).filter((x) => x.toLowerCase() !== n.toLowerCase()); const next = [n, ...cur].slice(0, 6); localStorage.setItem('rfq_recent', JSON.stringify(next)); setRecents(next); } catch { /* ignore */ }
  };

  // Login state (owner scenarios): starts from the `loggedIn` prop; the in-form Login button flips it.
  // Logged-in → autofetch demo contact + treat as already-verified (submit skips OTP) + hide Login button/OTP text.
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
  // Logged-in = "autofetch": pull the buyer's contact AND business details FROM THE SEED the engine built out
  // of his own IndiaMART record (bp/od/d → formAdapter.buyerIdentity / buyerFacts / buyerProfile / buyerPersona),
  // mark OTP already-verified (submit skips the OTP step), and hide the Login CTA + banner. Two ways to reach
  // it: (1) the ?login=1 route flag (starts logged-in), or (2) tapping the in-form "Login" button. Empty-only
  // fills, so a value the buyer already typed is never overwritten.
  //
  // THE FIX (P0, owner-reported 2026-07-28): this function used to set FIVE LITERALS — 'Demo Buyer',
  // '9876543210', buyerType 'Manufacturer', industry 'Construction Equipment' and a fake GSTIN — for every
  // logged-in buyer, while its own comment said "never ship a hard-coded identity". A paper/notebook buyer
  // therefore rendered as "Construction Equipment", and his real PERSONA (which the engine had already read
  // off his own calls and handed to the form) looked MISSING because the literal 'Manufacturer' had been
  // written over the field it belonged in.
  //
  // Absent beats wrong: where the seed holds nothing the field is left EMPTY and the buyer fills it himself.
  // Nothing here invents a value. INDUSTRY in particular is deliberately absent — `buyer_facts` has no
  // industry field and no other source answers it — so it stays blank unless the planner GROUNDS one
  // (see the `r.person` wiring in the planner effect). A demo stand-in survives only behind ?demoIdentity=1.
  const seedIdentity = useMemo(() => {
    const clean = (v: unknown): string => { const s = String(v ?? '').trim(); return !s || IDENTITY_PLACEHOLDER.test(s) ? '' : s; };
    const id = _seed?.buyerIdentity;
    const bf = _seed?.buyerFacts as { business_type?: string; gst_verified?: boolean; has_gst?: boolean } | undefined;
    // The role he buys in: buyer_facts first (the account's own answer), then the KYB nature_of_business.
    // Snapped to a real chip — an off-list role would render as no selection at all, which reads as "we lost it".
    const role = clean(bf?.business_type) || clean(_seed?.buyerProfile?.nature_of_business);
    const mob = clean(id?.mobile).replace(/\D/g, '');
    const gstin = clean(id?.gstin).toUpperCase();
    const d = DEMO_IDENTITY ? DEMO_IDENTITY_VALUES : null;
    return {
      name: clean(id?.name) || d?.name || '',
      mobile: (mob.length >= 10 ? mob.slice(-10) : '') || d?.mobile || '',
      // An email must look like one before it goes in an email box (this channel carries "MASKED" live).
      email: (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(id?.email)) ? clean(id!.email) : '') || d?.email || '',
      buyerType: BUSINESS_TYPES.find((t) => t.toLowerCase() === role.toLowerCase()) || d?.buyerType || '',
      industry: d?.industry || '',
      // Only a VALID GSTIN — the same rule buildRequirementText already applies before shipping one.
      gstin: (isValidGSTIN(gstin) ? gstin : '') || d?.gstin || '',
      gstOnFile: !!(bf?.gst_verified || bf?.has_gst) || !!d,
      // COMPANY — the buyer's firm, prefilled from his profile (bp.contacts_company → seed.buyerProfile.company).
      // An identity passthrough we were dropping (owner 2026-08-11); shown like designation/industry, editable.
      company: clean(_seed?.buyerProfile?.company),
      // HIS PERSONA — computed by the engine from his own calls (bulkGate.persona_on_file mirrors
      // buyerPersona.persona) and, until now, rendered nowhere at all.
      persona: clean(_seed?.bulkGate?.persona_on_file) || clean(_seed?.buyerPersona?.persona) || d?.persona || '',
    };
  }, [_seed]);
  // ── WHERE THE PERSONA CAME FROM — INTERNAL ONLY (P0 privacy, owner 2026-07-28) ─────────────────────────
  // This string is NEVER rendered to the buyer. It used to print under the field as
  // "✦ from your call with a seller — change it if we read you wrong", which told him in one line that we
  // listen to his phone calls. Owner: "nowhere should buyer know that we are listening his calls." It now has
  // exactly two jobs, both internal: it GATES the field (empty ⇒ we hold no persona ⇒ no field, see
  // showPersonaField) and it carries the provenance into the decision-routing ledger / debug panel, where full
  // provenance is still required. If you ever render it again you have re-shipped the leak.
  const [personaValue, setPersonaValue] = useState('');
  const [personaSource, setPersonaSource] = useState('');
  const applyLoggedInDefaults = () => {
    const s = seedIdentity;
    if (s.name) setContactName((n) => n || s.name);
    if (s.mobile) setContactMobile((m) => m || s.mobile);
    if (s.email) setContactEmail((e) => e || s.email);
    if (s.company) setCompanyName((c) => c || s.company);
    if (s.buyerType) setBuyerType((b) => b || s.buyerType);
    if (s.industry) setIndustry((i) => i || s.industry);
    if (s.gstOnFile) setGstRegistered((g) => (g === null ? true : g));
    if (s.gstin) setGstNumber((n) => n || s.gstin);
    otpVerified.current = true;
  };
  const handleLogin = () => { setIsLoggedIn(true); applyLoggedInDefaults(); };
  useEffect(() => { if (isLoggedIn) applyLoggedInDefaults(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isLoggedIn, seedIdentity]);
  // PERSONA precedence (owner-locked): planner/LLM value → else bp/od/d (`persona_on_file`) → else ASK, and the
  // ask still has to pass assessBulkB2B's gate (the planner effect owns that and is not bypassed here). This
  // effect is the SECOND rung: it seeds the on-file value the moment the seed arrives, whether or not the
  // buyer is logged in — a persona is not a login-gated fact. The planner overwrites it only while it is
  // still ours (empty-only writes), so a buyer edit always stands.
  useEffect(() => {
    if (!seedIdentity.persona) return;
    setPersonaValue((v) => v || seedIdentity.persona);
    // INTERNAL provenance (never rendered — see the personaSource declaration). Naming the real channel here is
    // deliberate: the ledger and the debug panel must still be able to say where this value came from.
    setPersonaSource((s) => s || (DEMO_IDENTITY ? 'demo identity — not this buyer' : 'engine · buyer_persona read from his own seller calls'));
  }, [seedIdentity]);
  // NAME AUTOFILL (gate support, 2026-08-13): seed the buyer's name from his profile the moment the seed lands —
  // regardless of login — but ONLY if the profile name is itself usable (≥3 chars). Empty-only, so a typed name
  // always stands. When the profile name is also junk (the 1-char "invalid buyer name" case, e.g. GLID 270467696)
  // this no-ops and the upfront gate asks him directly. Absent beats wrong: we never invent a name.
  useEffect(() => {
    if (seedIdentity.name.trim().length >= 3) setContactName((v) => v || seedIdentity.name);
  }, [seedIdentity]);

  const suggestDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestTokRef = useRef(0); // monotonic guard so a stale suggestion fetch can't overwrite a newer query's results
  const pickedRef = useRef('');    // a just-picked label must not immediately re-open its own dropdown
  const imgFetchedFor = useRef(''); // mcatId the landing's image panel has already fetched for
  // Landing image panel: 'idle' = blank on arrival (owner-locked — never a presumed image), 'loading' = the
  // fetch is in flight, 'done' = whatever came back is what there is (possibly nothing).
  const [imgPanelState, setImgPanelState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [showAllHistory, setShowAllHistory] = useState(false);   // landing chooser: the "+N more" disclosure
  const qtyRef = useRef<HTMLInputElement | null>(null);
  const productInputRef = useRef<HTMLInputElement | null>(null);
  // #8 (owner): clicking a scorer action item scrolls its field into view + flashes it momentarily so the buyer
  // sees exactly what to fill. `flashKey` = the slug of the currently-flashing check (see slugCheck/jumpToCheck).
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);
  const suppressFocusOpenRef = useRef(false); // the mount auto-focus must NOT pop the suggestion/recents dropdown — only a genuine focus/tap should
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingAiSpecs = useRef<Record<string, string> | null>(null);
  const plannerFiredFor = useRef('');       // "mcatId:name:aiEpoch:specSig" the unified Curated-RFQ planner already fired for (re-fires on a material change: new mcat, new photo/voice evidence, or a late-arriving ISQ schema)
  // (the empty-planner auto-skip effect lives further DOWN, right after `plannerRowCount` is computed — it must
  //  read the FRESH question count in the same render the questions arrive, not a round-tripped state that lags a
  //  frame behind and skipped a page that actually had four questions on it. See plannerRowCount.)
  const plannerRuns = useRef(0);            // AUTOMATIC planner runs since the last buyer-initiated retry — hard-capped, see MAX_PLANNER_RUNS
  const categoryNameRef = useRef('');       // latest category name (McatDtl) for the async AI-spec call
  const photoSpecsRef = useRef<Record<string, string>>({}); // specs a photo/voice extracted → extra INPUT to the AI-specs prompt
  const photoSetKeys = useRef<Set<string>>(new Set()); // ISQ fields whose value came from photo/voice extraction (NOT a buyer edit) → safe to overwrite/clear on a re-extraction (audit #3 photo-reselect)
  // ── REPOST-SEED PROVENANCE (P0, 2026-07-28 — the silently-refused correction) ───────────────────────────
  // The live defect on 268590579 / "Exercise Notebook Raw Material": a REPOST seeded GSM="100 GSM" from the
  // buyer's OLD requirement; the engine then read his WhatsApp chat and CORRECTED it to 75. `mergeExtracted`
  // saw a non-empty value that was not in photoSetKeys, classified it as "a value the buyer typed/picked" and
  // refused the correction — so the receipt strip read "GSM: 75 Gsm · corrected from 100 GSM · your WhatsApp
  // chat" while the chip row still had 100 GSM selected. The receipt and the field contradicted each other.
  //
  // A seed value is MACHINE-written truth from a STALE requirement and must never carry buyer-edit precedence:
  //   buyer's own edit THIS SESSION  >  use-case assist  >  engine prefill / photo / mic  >  repost seed  >  empty
  // Every buyer-driven writer (setSpecValue) DELETES the field from here, so from his first tap it is his and
  // nothing machine-written can touch it again.
  const seedSetKeys = useRef<Set<string>>(new Set(Object.keys(_seed?.specValues ?? {})));
  // PER-FIELD SOURCE, for the prefill icon (owner 2026-07-29: "small icons — image / mic / previous requirement /
  // AI"). Only sources we can ATTRIBUTE HONESTLY are tracked: a repost seed, a photo, a mic capture, or AI (the
  // planner's prefills + the use-case / completeness fill). A value with no tracked tag falls back to the AI mark.
  // We never claim a source we cannot verify — the same discipline as the fabrication firewall, applied to
  // provenance. Seeded values start as 'repost'; extraction/planner/use-case paths re-tag as they write.
  const specSrc = useRef<Record<string, 'repost' | 'photo' | 'mic' | 'ai'>>(
    Object.fromEntries(Object.keys(_seed?.specValues ?? {}).map((k) => [k, 'repost' as const]))
  );
  // ── Use-case assist ("Help me fill the specs") — its OWN LLM (inferSpecsFromApplication). ──
  // Priority (owner): buyer-edit > use-case > photo/mic > name-hint. useCaseSetKeys marks use-case fills so a later
  // photo/mic can't override them (applyExtractedSpecs skips these) and so a buyer edit still wins (setSpecValue clears).
  const useCaseSetKeys = useRef<Set<string>>(new Set());
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistInput, setAssistInput] = useState('');
  const [assistLoading, setAssistLoading] = useState(false);
  const [assistMessages, setAssistMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]); // the "Help me fill" is now a mini-CHAT (owner 2026-08-13)
  const [assistChatBusy, setAssistChatBusy] = useState(false);   // the assistant's reply is in flight
  const assistThreadRef = useRef<HTMLDivElement | null>(null);   // the scrollable chat thread — kept pinned to the newest turn
  // task #76 — the buyer's LIVE landing inputs (whatever source), bundled and handed to LLM 1 when he lands on page 1.
  const sessionInputsRef = useRef<{ chat?: string; voice?: string; photo?: string; notes?: string }>({});
  const bundleProductRef = useRef('');   // #76 fix: the product the bundle belongs to — reset the bundle only on a genuine SWITCH, not the first commit (so a photo/mic added to a TYPED-but-uncommitted name survives that first commit)
  const assistRunRef = useRef(0);                            // monotonic — a stale in-flight inference (product changed) is dropped
  const voiceTargetRef = useRef<'form' | 'assist'>('form');  // where a voice result goes: 'form' = extract specs (product page), 'assist' = dictate the use-case
  const commitGen = useRef(0);              // generation token — a superseded commit's late API responses become no-ops
  const autoAdvancedFor = useRef('');       // mcatId we already auto-advanced past (unit-less) — so Back doesn't re-bounce
  const productNameRef = useRef('');        // live product name for the photo/voice "don't overwrite a typed name" guard
  const sellerSpecsRef = useRef<string[]>([]); // getISQs SELLER-flagged spec names → page-2 AI input (never rendered on page-1)
  const bodyScrollRef = useRef<HTMLDivElement | null>(null); // the flow-body scroller — reset to top on every stage change (P2-216)
  const [showScrollHint, setShowScrollHint] = useState(false); // subtle "more below" amber chevron when the flow body overflows
  const prevStageRef = useRef<Stage>('landing');            // for the page_transition funnel event
  const stageRef = useRef<Stage>('landing');                // live stage mirror for the popstate/back handler (P1-127)
  const handleExitRef = useRef<() => void>(() => {});        // latest handleExit — lets the Escape handler exit the desktop popup without stale-closure/dep churn
  const voiceRef = useRef<HTMLDivElement | null>(null);      // voice-overlay container for the focus trap (P2-228)
  useFocusTrap(showVoice, voiceRef);                         // P2-228: trap Tab within the voice-input overlay while open
  useFocusTrap(showIdentityGate, identityGateRef);           // trap Tab within the hard-block name+location gate
  useFocusTrap(showDiscard, discardRef);                     // trap Tab within the discard-confirm modal
  useFocusTrap(showRetailGate, retailRef);                   // trap Tab within the retail-intent confirm modal (#75)
  const popupRef = useRef<HTMLDivElement | null>(null);      // desktop-popup dialog container for the focus trap (audit a11y)
  useFocusTrap(!isMobile && !standalone, popupRef);          // trap Tab within the embedded popup so it can't escape to the dashboard
  const photoMcatRef = useRef('');                           // the mcat the current photo/voice evidence belongs to (P0-01 mcat-scoping)
  const blToastShownRef = useRef(false);                     // one-time "requirement ready" toast when BL becomes eligible
  const dispatchedRef = useRef(false);                       // has a BuyLead been dispatched at all (drives idempotency below)
  const lastDispatchSigRef = useRef('');                     // content signature of the last dispatch — a TRUE duplicate (double-tap) is skipped, but an EDIT re-dispatches as an update (audit #13)
  const pendingUnitRef = useRef('');                         // a spoken unit stashed until the category's unitOptions resolve (P2-205)
  const [qtyUnitTruth, setQtyUnitTruth] = useState('');      // unit token recovered from LLM-1's Quantity known_truth ("500 Packet" → "Packet")
  // Priority of the current unit selection so a TRUTH unit outranks the options[0] auto-default (deep-audit 2026-08-12:
  // the default pick was firing first and the old `u || …` first-writer-wins guard then froze it, shipping "Piece"
  // when the buyer's requirement said "Packet"). Ranks: 0 none · 1 auto-default (options[0]) · 2 truth (seed/KT/name) ·
  // 3 buyer's own pick. A lower rank never overwrites a higher one; equal/higher may re-apply.
  const unitRankRef = useRef(0);
  const applyUnit = useCallback((opts: string[], typed: string | undefined, rank: number) => {
    if (!opts.length || rank < unitRankRef.current) return;
    unitRankRef.current = rank;
    setUnit(matchUnit(opts, typed));
  }, []);

  const surfaceName = standalone ? 'standalone' : 'popup';

  // Funnel: form opens (once per mount). surface/categoryMode/device split the 4 variants (§8 taxonomy).
  // Also auto-focus the product input on open (owner: "go ahead") — P2-214.
  useEffect(() => {
    emit(EV.FORM_OPEN, { form: 'simple', surface: surfaceName, categoryMode, device: surf, loggedIn: isLoggedIn });
    // Auto-focus so the keyboard/cursor is ready — but flag it so the resulting programmatic focus event does
    // NOT open the suggestions/recents dropdown. The dropdown should appear only when the buyer themselves puts
    // the cursor in the box (a real tap/focus) or starts typing — never popped open by default on load.
    setTimeout(() => { suppressFocusOpenRef.current = true; productInputRef.current?.focus(); }, 120);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  // Every stage change: (1) reset the flow-body scroll to top so the new page starts at its heading (P2-216/UI-18),
  // (2) emit the page_transition funnel event (P2-224). Both were missing.
  useEffect(() => {
    stageRef.current = stage;
    bodyScrollRef.current?.scrollTo?.({ top: 0 });
    if (prevStageRef.current !== stage) {
      emit(EV.PAGE_TRANSITION, { form: 'simple', from: prevStageRef.current, to: stage, surface: surfaceName, device: surf });
      prevStageRef.current = stage;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // Subtle "more below" scroll hint (owner) — a small amber chevron at the bottom of the flow body, shown ONLY
  // when the page actually overflows and isn't scrolled to the end. Watches the flow scroller (scroll + content
  // resize) so it appears/disappears live as specs load or the buyer scrolls. Same on all Simple variants.
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) { setShowScrollHint(false); return; }
    const update = () => setShowScrollHint(el.scrollHeight - el.scrollTop - el.clientHeight > 40);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (ro && el.firstElementChild) ro.observe(el.firstElementChild); // content grows async (specs/AI load)
    const t1 = setTimeout(update, 400); const t2 = setTimeout(update, 1500);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); clearTimeout(t1); clearTimeout(t2); };
  }, [stage]);

  // P1-127: make the browser/hardware Back button step through form stages (MSite expectation) instead of
  // leaving the page on the first press. A sentinel history entry is pushed on mount and re-armed after each
  // intercepted Back; at the first stage (or the terminal results stage) Back performs the normal close/exit.
  useEffect(() => {
    // ONLY on full-page shells (mobile MSite / standalone) — where Back-steps-through-stages is the MSite
    // expectation. The embedded desktop popup must NOT hijack the host page's browser Back (it left a stale
    // sentinel that broke the dashboard's Back after closing — audit).
    if (!isMobile && !standalone) return;
    window.history.pushState({ rfq: true }, '');
    const onPop = () => {
      // An open overlay eats Back: the identity gate is a HARD BLOCK (swallow + re-arm); review/discard just close.
      // Without this, browser Back → onClose bypasses the mandatory gate (audit) and discards the requirement.
      if (overlaysRef.current.gate) { window.history.pushState({ rfq: true }, ''); return; }
      if (overlaysRef.current.discard || overlaysRef.current.retail) { setShowDiscard(false); setShowRetailGate(false); window.history.pushState({ rfq: true }, ''); return; }
      const s = stageRef.current;
      if (s === 'landing' || s === 'results') { onClose(); return; }
      // Step back through the SAME (2- or 3-node) stepper the UI renders — read off the live ref, because this
      // listener is mounted once. Hardcoding "more → specs" skipped the prefilled page whenever we split.
      const stages = stepStagesRef.current;
      const i = stages.indexOf(s);
      setStage(i > 0 ? stages[i - 1] : 'landing');
      window.history.pushState({ rfq: true }, ''); // re-arm for the next Back
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P0-02 (owner's reported bug): lock the page behind the popup so it can't scroll (the standalone routes replace
  // the whole page, so nothing is behind them — only the popup mounts need this). overscroll-contain on the
  // backdrop + body scroller (below) stops iOS rubber-band / wheel-chaining to the dashboard.
  useEffect(() => {
    if (isMobile || standalone) return; // consistency: lock the body ONLY for the desktop popup (matches Standard); the mobile/standalone shells are full-page, so the lock was redundant (per this block's own comment)
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [standalone]);

  // Escape closes any open transient overlay — voice sheet, score/location/contact popover (P2-212). The
  // full-page form shell itself never closes on Escape (no accidental data loss); OTPGate handles its own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Overlay state read from a REF (kept fresh below), NOT the deps array — so this effect's dependency list stays a
      // stable size (adding the 3 overlay states to the deps changed the array length across renders and tripped React's
      // "deps size changed" invariant). Identity gate = hard block (swallow Esc); review/discard = close the top overlay.
      if (overlaysRef.current.gate) return;
      if (overlaysRef.current.discard) { setShowDiscard(false); return; }
      if (overlaysRef.current.retail) { setShowRetailGate(false); return; }   // #75: Esc cancels → stays on landing; next Continue advances (business as usual)
      if (showVoice) setShowVoice(false);
      else if (scoreOpen) setScoreOpen(false);
      else if (locationEditing) setLocationEditing(false);
      else if (contactOpen) setContactOpen(false);
      else if (!isMobile && !standalone) handleExitRef.current(); // consistency w/ Standard: Esc exits the desktop popup (via handleExit → discard-confirm). Full-page shells still never close on Esc.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showVoice, scoreOpen, locationEditing, contactOpen]);

  // PRIVACY (audit #15): the third-party IP-geo (ipapi.co, a US processor) no longer fires on bare page load —
  // it's deferred until the buyer COMMITS a product (real intent), so a bounced visitor's IP is never sent. Fires
  // once; the city still pre-fills well before the delivery step. (BigDataCloud reverse-geocode stays tap-only.)
  const ipGeoDoneRef = useRef(false);
  useEffect(() => {
    if (!committed || ipGeoDoneRef.current) return;
    ipGeoDoneRef.current = true;
    let alive = true;
    // IP city seeds the buyer's OWN location; delivery mirrors it (sameAsLoc defaults on) until the buyer diverges.
    // api.ts guards absolute URLs so an embedded VITE_API_BASE deploy won't wrongly prefix this — keep that guard.
    getJSON<{ city?: string }>('https://ipapi.co/json/').then((d) => { if (alive && d?.city) { setDetectedCity(d.city); setUserLocation((v) => v || d.city!); setDeliveryLocation((v) => v || d.city!); } }).catch((e) => emitApiError('ipapi', e));
    return () => { alive = false; };
  }, [committed]);

  // LOCATION PREFILL FROM PROFILE (owner 2026-07-29): the buyer's OWN city always comes from his IndiaMART profile
  // (buyer_facts.city), which is authoritative — it runs on mount and beats the IP-geo guess above (both are
  // empty-only, this one lands first). Delivery mirrors it while "same as my location" is on. If the REQUIREMENT
  // (or a CSL/PNS signal) carried a distinct delivery location, the seed effect further down sets deliveryLocation
  // to that and unlinks sameAsLoc — so profile = where he IS, requirement = where he wants it delivered.
  // STEP 0 (2026-08-11): this used to have `[]` deps, so it read buyer_facts.city ONCE at mount — before the gate
  // threads the (async) bi-bpod profile into the seed, so it always saw an empty city and no-op'd (the dormancy).
  // Now it reacts to the city ARRIVING, and treats the profile city as AUTHORITATIVE over the ipapi guess (the IP
  // lands first and would otherwise pin the buyer to the dev/edge city). A real buyer EDIT (≠ the detected guess)
  // is always preserved; delivery mirror stays empty-only so a distinct requirement delivery is never clobbered.
  const seedCity = ((_seed?.buyerFacts as { city?: string } | undefined)?.city ?? '').trim();
  useEffect(() => {
    if (!seedCity) return;
    setUserLocation((v) => (!v || v === detectedCity) ? seedCity : v);
    if (sameAsLoc) setDeliveryLocation((v) => v || seedCity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedCity, detectedCity]);

  // BROWSE-HINT PREFILL (owner item 4a — GLID 253102197): when there is NO confirmed/profile city but CSL knows where
  // the buyer browses/searches from (Imphal / Guwahati / Dimapur), prefill that as an UNCONFIRMED guess so the upfront
  // gate opens with it ready to CONFIRM instead of an empty box he must fill blind. Empty-only (a profile city or a
  // typed value always wins). cityIsGuessRef marks it a guess → the gate requires a deliberate confirm, never a
  // reflexive Continue over a maybe-wrong IP city.
  const cityIsGuessRef = useRef(false);
  const browseCityHint = (() => {
    const bf = (_seed?.buyerFacts ?? {}) as { browse_city?: string; searched_cities?: string[]; browse_also_seen?: string[] };
    return (bf.browse_city || bf.searched_cities?.[0] || bf.browse_also_seen?.[0] || '').trim();
  })();
  useEffect(() => {
    if (seedCity || !browseCityHint) return;
    setUserLocation((v) => { if (v && v !== detectedCity) return v; cityIsGuessRef.current = true; return browseCityHint; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseCityHint, seedCity, detectedCity]);

  // ── NAME + LOCATION GATE plumbing ─────────────────────────────────────────────────────────────────────────
  // resolveCityId — map a chosen city NAME to IndiaMART's canonical city_id. ⚑ DEV-TODO (owner provides the city
  // endpoint, like the BuyLead POST): there is no frontend city-suggest-with-id API today, so this returns '' and
  // the submission carries the confirmed city NAME. Wire the endpoint here and the id flows through unchanged — no
  // id is ever fabricated (a wrong city_id is worse than an absent one, per the same firewall the specs obey).
  const resolveCityId = async (city: string): Promise<string> => { void city; return ''; };
  // #79 Move A: the ONE place a chosen city is committed (resolve city_id + mark confirmed). The identity gate AND the
  // header city control both call this, so they can never disagree and the 3.5s gate arm can't re-pop over a city the
  // header already set (locationConfirmed is the gate's own "unconfirmed" input via gateInputsRef).
  const commitCity = async (city: string) => { const id = await resolveCityId(city); setCityId(id); setLocationConfirmed(true); };
  // ONE definition of the profile-vs-browsed(CSL) city conflict, shared by the gate and the spec-page banner (was
  // inline in render only). Signals today = browse city + also-seen; CSL cities_resolved + PNS-call city join as the
  // CSL parser (G2) surfaces them into buyer_facts.
  const computeLocationConflict = () => {
    const bf = (_seed?.buyerFacts ?? {}) as { city?: string; browse_city?: string; browse_also_seen?: string[]; searched_cities?: string[] };
    const signals: LocationSignal[] = [];
    if (bf.browse_city) signals.push({ source: 'browse', city: bf.browse_city });
    for (const c of bf.browse_also_seen ?? []) signals.push({ source: 'browse', city: c });
    for (const c of bf.searched_cities ?? []) signals.push({ source: 'target', city: c });   // gap G2 closed (GLID 253102197: Dimapur)
    return detectLocationConflict(bf.city, signals);
  };
  // Keep a fresh mirror of the gate inputs for the delayed arm timer to read (incl. the live conflict verdict, which
  // depends on the async _seed and would otherwise be stale in the timer's commit-time closure).
  useEffect(() => { gateInputsRef.current = { name: contactName, city: userLocation, locConfirmed: locationConfirmed, conflict: computeLocationConflict().conflict }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [contactName, userLocation, locationConfirmed, _seed]);
  // Mirror the open overlays for the once-mounted popstate handler.
  useEffect(() => { overlaysRef.current = { gate: showIdentityGate, discard: showDiscard, retail: showRetailGate }; }, [showIdentityGate, showDiscard, showRetailGate]);
  // ARM THE GATE once per product: ~3.5s after commit (giving the async profile name + CSL city their time to land),
  // evaluate against the FRESH refs and pop the hard block only for buyers who still owe a name or a delivery city.
  // A cold buyer with no profile has both empty → the gate fires and asks; a buyer we already know silently passes.
  useEffect(() => {
    if (!committed || !mcatId || identityGateFiredFor.current === mcatId) return;
    identityGateFiredFor.current = mcatId;
    const t = setTimeout(() => {
      const nameBad = gateInputsRef.current.name.trim().length < 3;
      // A browse-IP guess (cityIsGuessRef) counts as "unconfirmed" alongside a real profile-vs-browse conflict: either way
      // the buyer must deliberately confirm the city rather than Continue past a value we only inferred.
      const unconfirmed = (gateInputsRef.current.conflict || cityIsGuessRef.current) && !gateInputsRef.current.locConfirmed;
      const cityBad = !gateInputsRef.current.city.trim() || unconfirmed;
      const cityConflict = !!gateInputsRef.current.city.trim() && unconfirmed;   // city present but disputed/guessed → require a deliberate pick
      if (nameBad || cityBad) { setGateCityChosen(false); setGateAsk({ name: nameBad, city: cityBad, cityConflict }); setShowIdentityGate(true); }
    }, 3500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, mcatId]);
  // Gate satisfied when every ASKED field is filled (name ≥3 · a city chosen). The conflict that triggered the ask
  // is resolved by the buyer picking a city here — so it is NOT re-checked, which would otherwise deadlock Continue.
  const gateCanContinue = (!gateAsk.name || contactName.trim().length >= 3) && (!gateAsk.city || (!!userLocation.trim() && (!gateAsk.cityConflict || gateCityChosen)));

  // Set the buyer's own city; mirror into delivery when "same as my location" is on.
  const applyUserCity = (city: string) => { setUserLocation(city); if (sameAsLoc) setDeliveryLocation(city); };
  // "Use my current location" (owner: browser GPS). getCurrentPosition → reverse-geocode (BigDataCloud, no key,
  // CORS-open) → city. Falls back to the IP-detected city on denial / error / no-geolocation. User-initiated only.
  const useCurrentLocation = () => {
    const fallback = () => { if (detectedCity) applyUserCity(detectedCity); setGeoLoading(false); };
    if (typeof navigator === 'undefined' || !navigator.geolocation) { fallback(); return; }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const r = await getJSON<{ city?: string; locality?: string; principalSubdivision?: string }>(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const city = (r?.city || r?.locality || r?.principalSubdivision || '').trim();
          if (city) applyUserCity(city); else if (detectedCity) applyUserCity(detectedCity);
        } catch (e) { emitApiError('reverseGeocode', e); if (detectedCity) applyUserCity(detectedCity); }
        finally { setGeoLoading(false); }
      },
      fallback,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };
  // #79: the explicit "same as my location" toggle went away with the 3-input location popover — delivery now mirrors
  // the picked buyer city automatically (sameAsLoc defaults on; the header/banner chooser also pins delivery on a pick).
  // PRIVACY (2026-07-23): we no longer auto-fire the GPS permission prompt on reaching Delivery — an unprompted
  // permission dialog is a poor first impression and a consent anti-pattern. Location is now tap-to-share only:
  // the buyer taps "Use my current location" (below), which calls useCurrentLocation(). IP-city fallback still
  // fills a sensible default without any prompt, so no one is blocked.

  useEffect(() => { if (committed) setTimeout(() => qtyRef.current?.focus(), 60); }, [committed]);
  // Cursor chain (owner 2026-08-13): product → qty (above) → unit. A SINGLE unit is auto-selected (the only choice —
  // no dropdown to open); with >1, the picker opens once the buyer leaves qty with a value. Never per-keystroke.
  useEffect(() => { if (unitOptions.length === 1 && !unit) setUnit(unitOptions[0]); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [unitOptions]);
  const openUnitPicker = () => { setUnitOpen(true); setTimeout(() => unitBtnRef.current?.focus(), 0); };
  useEffect(() => { setAbsurdAck(false); }, [quantity]);   // a NEW quantity un-acks — re-check for absurdity
  // MCAT SANITY (fly-ash class, #65): once the category name resolves, cheaply pre-filter for word-overlap; only a
  // ZERO-overlap product spends an LLM to CONFIRM whether it is a true mismatch (fly ash → Concrete Admixture) or a
  // legit zero-overlap sub-type (bolt → Fasteners). On a confirmed mismatch, surface a soft "right category?" nudge —
  // never auto-change (fabrication firewall). Runs once per product; no key → no nudge (the pre-filter alone false-positives).
  useEffect(() => {
    if (!committed || !mcatId || !catName || !productName.trim() || mcatCheckedFor.current === mcatId) return;
    mcatCheckedFor.current = mcatId;
    setMcatMismatch(false);
    if (mcatPlausible(productName, catName).plausible || !hasFormLLM()) return;
    let alive = true;
    checkTitleMcatMismatch(productName, catName, 'form', RFQ_MODEL_MIC)
      .then((r) => { if (alive && (r.mismatch || r.isIrrelevant)) setMcatMismatch(true); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, mcatId, catName, productName]);

  // P2-205: a voice/seed unit stashed before the category's unitOptions loaded → apply it once they resolve. It is a
  // TRUTH unit (rank 2), so it OVERRIDES an options[0] auto-default that may already be sitting there — but not a
  // buyer's own pick. Always clear pendingUnitRef so it can't re-fire, whether or not applyUnit acted on it.
  useEffect(() => { if (pendingUnitRef.current && unitOptions.length) { applyUnit(unitOptions, pendingUnitRef.current, 2); pendingUnitRef.current = ''; } }, [unitOptions]); // applyUnit is a stable useCallback — omitted from deps (matches the setter/ref convention here)
  // Snap a truth-derived unit ("500 Packet" → "Packet") to a real chip. Fires whether the unit token arrives before OR
  // after unitOptions resolve (both are deps), so it is race-proof, and as a rank-2 truth it overrides an auto-default.
  // If the buyer's stated unit is a clean word the category does NOT offer, OFFER it (prepend) rather than coercing it
  // to unitOptions[0] — never silently ship the wrong unit to sellers.
  useEffect(() => {
    if (!qtyUnitTruth || !unitOptions.length || unitRankRef.current > 2) return; // a buyer pick (rank 3) outranks a truth unit
    const norm = qtyUnitTruth.trim();
    const lc = norm.toLowerCase();
    // A real equivalent already on the list (exact OR startsWith either way, e.g. "Packet"→"Pack") → snap to it and
    // never add a redundant chip. Only when the category has NO equivalent unit do we OFFER the buyer's word.
    const hasMatch = unitOptions.some((o) => { const lo = o.toLowerCase(); return lo === lc || lo.startsWith(lc) || lc.startsWith(lo); });
    if (!hasMatch && /^[a-z]{2,12}$/i.test(norm)) {
      const titled = norm.charAt(0).toUpperCase() + norm.slice(1).toLowerCase();
      setUnitOptions((prev) => prev.some((o) => o.toLowerCase() === titled.toLowerCase()) ? prev : [titled, ...prev]);
      unitRankRef.current = 2; setUnit(titled);
    } else {
      applyUnit(unitOptions, norm, 2);
    }
  }, [qtyUnitTruth, unitOptions]); // applyUnit stable (useCallback) — omitted from deps like the setters above

  useEffect(() => {
    if (!pendingAiSpecs.current || isqSpecs.length === 0) return;
    const ai = pendingAiSpecs.current; pendingAiSpecs.current = null;
    setSpecValues((prev) => {
      const next = { ...prev };
      for (const s of isqSpecs) { const hit = Object.keys(ai).find((k) => k.toLowerCase() === s.IM_SPEC_MASTER_DESC.toLowerCase()); if (hit && ai[hit] && !next[s.IM_SPEC_MASTER_DESC]) next[s.IM_SPEC_MASTER_DESC] = ai[hit]; }
      return next;
    });
  }, [isqSpecs]);

  // On product commit, the UNIFIED Curated-RFQ planner fires (see the single effect further below, near `baq`) —
  // it replaces what used to be TWO separate calls here (getSpecHints for page-1 prefill/hints, getMissingSpecs
  // for page-2 gap questions): ONE understanding→ranking call now prefills page-1 (+ extras + field hints) AND
  // ranks page-2's gaps, fed by the SAME buyer/seller/category context both former calls used.

  // ── Real seller retrieval — fire when the buyer LEAVES the (merged) spec page (owner) ────────────────────
  // The windmill call takes ~30s, so we start it the instant the buyer reaches the last page and let it run
  // while they finish (more → OTP). Fires at the FIRST of more/results, once per product (mcatId). A product
  // change re-fires; a stale in-flight response (product changed) is dropped.
  useEffect(() => {
    if (!mcatId) return;
    // FIRES ON THE PERSONA NEXT TAP (persona → more). NOTE: the old 'specs2 → more' trigger this used to describe
    // quantity + the buyer's ISQ specs, and page 2's COMPLETENESS FILL is still resolving the last empty specs
    // when the buyer arrives on specs2 — firing then would search on an incomplete set. Leaving page 2 for the
    // last page means every buyer spec is settled, and the ~30s windmill call still overlaps the whole last page,
    // so results are ready by the time he reaches the closing page.
    // #79: fires on landing the LAST numbered page (persona for the full flow) — the 'more' page is gone. For a RETAIL
    // buyer whose ONLY page IS specs, firing on specs-arrival would search on empty/prefilled specs (review LOW), so
    // that case fires on RESULTS instead — after submit — with the buyer's final specs. The sellerFiredFor guard keeps
    // it to ONE fire per mcat (full flow fires on persona; the results pass is then a no-op).
    const pastFirstSpecPage = (stage === lastStage && stage !== 'specs') || stage === 'results';
    if (!pastFirstSpecPage || sellerFiredFor.current === mcatId) return;
    sellerFiredFor.current = mcatId;
    const run = ++sellerRunRef.current;
    setSellerResults([]);
    setSellerStatus('loading');
    searchSellers({
      productName: productName.trim(),
      mcatId,
      mcatName: categoryNameRef.current || productName.trim(), // McatDtl glcat_mcat_name; product name as backstop
      specValues,                                              // ONLY page-1 buyer specs (owner) — no extras/smart-Qs
      quantity,
      quantityUnit: unit,
      qtyMeaningful: qtyIsMeaningful(quantity),
      // REAL buyer city — every dist_km on the results page is measured from this (it used to be a hardcoded
      // Ghaziabad fixture, so distances were fiction). Delivery city first (that's where the goods must land),
      // then the buyer's own city, then the IP-detected one; sellerSearch falls back to the fixture only if all
      // three are still empty. ⚑ Known limit: this is read at FIRE time (entering the last page) while the city
      // inputs live ON that page — a city edited afterwards does not re-fire the ~30s search.
      buyerCity: (deliveryLocation || userLocation || detectedCity).trim(),
    }, 60000)
      .then((res) => { if (run === sellerRunRef.current) { setSellerResults(res.sellers); setSellerStatus('done'); } })
      .catch((e) => { if (run === sellerRunRef.current) setSellerStatus('error'); emitApiError('sellerSearch', e, { mcatId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, mcatId]);

  // (Removed 2026-07-30) The RAW category-corpus fetch that fired on every commit is deleted: its result
  // (categoryCorpusRef) was write-only — no current LLM consumes it (category insights are NOT an LLM 1 input, plan
  // #7; the corpus fed the retired curated planner). It was a pure wasted Redash round-trip per product. LLM 2's
  // live category signal comes from catTopSpecs (fetchCategoryTopSpecs), which is untouched.

  const onProductInput = (val: string) => {
    setProductName(val); productNameRef.current = val; setNotFound(false); setCommitted(false);
    if (suggestDebounce.current) clearTimeout(suggestDebounce.current);
    // P1-103: clearing the name is "start over" — reset product-scoped state so a photo uploaded next is analysed
    // against a fresh (no) schema and against the RIGHT product, not the previous category's ISQ fields.
    if (!val.trim()) {
      // FULL reset (audit #9 owner #3/#5): clearing the product name is "start over", so wipe everything the old
      // product left behind — not just the ISQ set. Otherwise the score still credits a phantom "Product image",
      // and re-typing a name that resolves to the SAME mcat re-attaches the old photo + its specs.
      setMcatId(''); setIsqSpecs([]); setSpecValues({}); setUnitOptions([]); setUnit(''); unitRankRef.current = 0; setUnitsResolved(false);
      setProductImageUrl(''); setProductImages([]); setImageBase64(''); setQuantity('');
      setExtraSpecs({}); setAiSpecs([]); setAiSpecValues({}); setAiSpecsError(false);
      photoSpecsRef.current = {}; photoMcatRef.current = ''; photoSetKeys.current.clear(); seedSetKeys.current.clear();
      extraEditedRef.current.clear(); pendingAiSpecs.current = null;
      useCaseSetKeys.current.clear(); setAssistInput(''); setAssistOpen(false);
      sellerFiredFor.current = ''; setSellerResults([]); setSellerStatus('idle');
      setImgPanelState('idle'); imgFetchedFor.current = '';
    }
    if (val.trim().length < 2) { setSuggestions([]); setShowDropdown(false); return; }
    // JUST-PICKED SUPPRESSION: he chose this exact label a moment ago, so don't re-open the dropdown and
    // suggest it back at him (the picked value is written into the box, which re-enters this function).
    if (val.trim() === pickedRef.current) { setSuggestions([]); setShowDropdown(false); return; }
    setSuggestions(filterProducts(val)); setShowDropdown(true);
    // Monotonic token: a slow fetch for an OLDER query ('t') must not overwrite the newer one's ('tm') results.
    const tok = ++suggestTokRef.current;
    // 220ms (owner-locked) — the same debounce the landing's suggester has always run on.
    suggestDebounce.current = setTimeout(async () => { const live = await fetchProductSuggestions(val); if (live.length && tok === suggestTokRef.current) setSuggestions(live); }, 220);
  };

  // ── THE SUGGESTER — one pool, three origins, HIS TRUTH FIRST (owner-locked) ────────────────────────────
  // The buyer's own requirements and the products he viewed rank ABOVE the IndiaMART catalogue, and every
  // row is labelled with WHERE it came from so he knows why he is being offered it. Deduped case-insensitively.
  const ownPool = useMemo(() => {
    const seen = new Set<string>(); const out: { label: string; kind: string }[] = [];
    const add = (label: string, kind: string) => {
      const k = String(label ?? '').trim().toLowerCase();
      if (!k || seen.has(k)) return; seen.add(k); out.push({ label: String(label).trim(), kind });
    };
    (landing?.recs ?? []).forEach((r) => add(r.product, r.action === 'new' ? 'you viewed this' : 'your requirement'));
    (landing?.memory?.viewed ?? []).forEach((v) => add(v.name, 'you viewed this'));
    (landing?.memory?.recent_searches ?? []).forEach((s) => add(s, 'you searched this'));
    return out;
  }, [landing]);

  // Derive qty/unit options from raw ISQ rows (mapDisplaySpecs strips these, so read them first).
  const deriveUnits = (rows: unknown): string[] => {
    const flat = (Array.isArray(rows) ? rows : []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s): s is ISQSpec => !!(s && (s as ISQSpec).IM_SPEC_MASTER_DESC));
    const u: string[] = [];
    // Pull unit options ONLY from a field that IS a dedicated quantity/unit field (same token test that hides it
    // from the spec list) — a substring /unit|quantity/ wrongly matched real specs like "Unit Weight" and shipped
    // a bogus order unit (e.g. "1 kg") to sellers (audit).
    for (const qs of flat.filter((s) => isQtyUnitField(s.IM_SPEC_MASTER_DESC))) if (qs.IM_SPEC_OPTIONS_DESC) qs.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter((o) => o && o.toLowerCase() !== 'none').forEach((o) => { if (!u.includes(o)) u.push(o); });
    // Sanitised HERE, in the single return, so BOTH consumers (`authUnits` off getISQs and `unitOpts` off
    // GetIsq) are covered by construction — no caller can forget. "Text" is an input-TYPE token, never a unit.
    return sanitizeUnitOptions(u);
  };
  const collisionSwapRef = useRef(false);
  const cslAuthorityRef = useRef<'' | 'exact-name' | 'name-containment' | 'catalogue-desc' | 'posted-requirement'>(''); // C11: WHICH signal won the category, for the inspector // this commit re-anchored to the browsed (CSL) or posted-requirement (RFQ) category over a mis-mapped one → discard the wrong-category seed specs
  const rfqDivergeRef = useRef<{ rfq_mcat: string; rfq_product: string } | null>(null); // Theme-B #5: a name-matched posted-requirement mcat that differs from the resolved id (recorded even when we don't swap)
  const commitProduct = useCallback(async (name: string) => {
    const myGen = ++commitGen.current; // supersede any in-flight prior commit
    collisionSwapRef.current = false;   // reset per commit; set true only if the CSL-twin or posted-requirement swap below fires
    rfqDivergeRef.current = null;        // reset the posted-requirement divergence record per commit
    setShowDropdown(false); setResolving(true); setNotFound(false); setResolveError(false); setCommitted(false); setProductName(name); productNameRef.current = name;
    const parsedQty = parseQuantityFromName(name);
    // #① QTY IS NOT PARSED FROM THE PRODUCT NAME (owner 2026-07-30). A machine title like "1300Pcs/Hr Notebook
    // Making Machine" embeds a THROUGHPUT, not an order quantity, and this regex was grabbing it and filling the
    // Quantity box for a category that has no quantity at all. Quantity is now owned by TRUTH + LLM 1 (CF-3: from
    // PNS / repost), never a string parse: reset to empty on every (re)commit so a stale product's qty can't
    // orphan, then the seed effect (a real repost qty) and LLM 1's known_truths fill it. `parsedQty` is kept ONLY
    // for the unit hint below — a real ISQ unit token that safely no-ops when the mcat defines no unit.
    setQuantity('');
    const resolveMcat = async (q: string): Promise<string> => {
      const data = await getJSON<Record<string, string> | Array<Record<string, string>>>(`/api/imimg/models/mcatid-suggestion.php?search_param=${encodeURIComponent(q)}&modid=MY`);
      const it = Array.isArray(data) ? data[0] : data;
      return String(it?.mcat_id ?? it?.MID ?? it?.mcatid ?? it?.mcatId ?? '');
    };
    let id = '';
    const mcatT0 = Date.now();
    cslAuthorityRef.current = '';
    try {
      const cleaned = stripQuantityPrefix(name);
      id = await resolveMcat(name);
      if (!id && cleaned && cleaned.toLowerCase() !== name.toLowerCase()) id = await resolveMcat(cleaned);
    } catch (e) { emitApiError('resolveMcat', e, { query: name }); emit(EV.PRODUCT_COMMIT_FAILED, { productName: name, surface: surfaceName }); if (myGen === commitGen.current) { setResolving(false); setResolveError(true); } return; } // network failure ≠ "not a category"
    if (myGen !== commitGen.current) return;
    if (!id) { setResolving(false); setNotFound(true); return; }
    // PREFER-CSL-MCAT (owner 2026-07-31 · case-audit CRITICAL): if the buyer BROWSED this exact product under a
    // DIFFERENT category than the one it resolved to, and CSL carries that category's ISQ, the resolved category is a
    // name-collision mis-map (a bakery "Tasty Three in One" → transformers). COMMIT THE BROWSED (correct) category —
    // its own getISQs then drives Page-1 specs, the qty/unit block, seller-search AND submission. The product NAME was
    // right; its category + filled specs were not, so we mark this a collision swap and DISCARD the wrong-category seed
    // specs (below). Edge: no twin / no twin-mcat / no browsed ISQ → NO swap, keep the resolved id (soft rescue via
    // the brain's browsed_specs + category_trustworthy:false still applies).
    // C11 (owner 2026-08-03): CSL IS THE CATEGORY AUTHORITY; the typed/RFQ name is the fallback.
    // Evidence (12-buyer study): for 6 of 12 buyers the latest RFQ requirement's mcat appears NOWHERE in CSL — the
    // two disagree about what the buyer wants half the time — and trusting the name over what he actually browsed is
    // the precise root cause of the bakery-snack-as-transformer misroute. CSL is also the only PII-clean source.
    // Matching is layered so authority degrades gracefully instead of all-or-nothing:
    //   1. EXACT name match on a viewed product (the original rule) — highest confidence.
    //   2. STRONG containment either way, on names long enough that containment is not a coincidence.
    //   3. `desc` match — the joined seller-catalogue description, populated 35/35 in the study and read by nothing
    //      until now; it is the strongest free disambiguator in the payload.
    // A swap still REQUIRES the browsed category to carry its own ISQ, so we never trade a working schema for none.
    try {
      const csl = leafTruthRef.current?.csl as { viewed_products?: Array<{ name?: string; mcat?: string; desc?: string }>; category_isq?: unknown[] } | undefined;
      const haveBrowsedIsq = Array.isArray(csl?.category_isq) && csl!.category_isq!.length > 0;
      const want = name.trim().toLowerCase();
      const vps = csl?.viewed_products ?? [];
      const norm = (v?: string) => (v ?? '').trim().toLowerCase();
      const exact = vps.find((v) => norm(v.name) === want);
      const contains = vps.find((v) => {
        const n = norm(v.name);
        return n.length >= 6 && want.length >= 6 && (n.includes(want) || want.includes(n));
      });
      const byDesc = vps.find((v) => { const d = norm(v.desc); return d.length >= 8 && want.length >= 6 && d.includes(want); });
      const twin = exact ?? contains ?? byDesc;
      if (twin?.mcat && twin.mcat !== id && haveBrowsedIsq) {
        id = twin.mcat;
        collisionSwapRef.current = true;
        cslAuthorityRef.current = exact ? 'exact-name' : contains === twin ? 'name-containment' : 'catalogue-desc';
      }
    } catch { /* CSL absent → no swap, name stands */ }
    // POSTED-REQUIREMENT RECONCILIATION (deep-audit 2026-08-12, Theme-B #5): the buyer's OWN posted RFQ requirement
    // carries a category_id — an INDEPENDENT authority the resolver ignored ("RFQ mcat structurally excluded"). When
    // the committed product NAME matches one of his posted requirements but resolved to a DIFFERENT mcat, his posted
    // category is authoritative (he filed it there) → swap, mirroring the CSL swap. CSL stays PRIMARY (browse is
    // acted-on first); the posted requirement is the fallback authority. We RECORD a name-matched divergence for the
    // inspector even when we don't swap. NOTE: a SEMANTIC mismatch (different product string, same need — e.g. a
    // browsed "Mamy Poko Pants Diaper" vs a posted "Cotton Pant Style Diaper") is NOT name-matchable here; the LLM-1
    // brain handles that via truth_rfq + the category-mismatch prompt rule (B1). This is the deterministic same-name/
    // wrong-resolve half.
    try {
      const rec = reconcilePostedRequirement(name, id, collisionSwapRef.current, (leafTruthRef.current?.rfqRequirements ?? []) as RfqReq[]);
      rfqDivergeRef.current = rec.divergence;
      if (rec.swapped) { id = rec.id; collisionSwapRef.current = true; cslAuthorityRef.current = 'posted-requirement'; }
    } catch { /* RFQ requirements absent → no reconciliation, name stands */ }
    // Health row for the resolve step (previously invisible). It records the resolved category AND whether the
    // CSL-collision / posted-requirement swap fired — so the inspector answers "which mcat are we actually asking
    // specs for, and why is it not the one the name resolved to". Everything downstream (getISQs · GetIsq · McatDtl ·
    // category brain · seller search · submission) keys off this final `id`, i.e. the SWAPPED category when a collision
    // was detected. `rfq_divergence` surfaces a posted-requirement mismatch even when we chose not to swap.
    recordSource('Category resolve · mcatid-suggestion', { ok: !!id, ms: Date.now() - mcatT0, raw: { query: name, cleaned: stripQuantityPrefix(name) }, cleaned: { mcat_id: id, collision_swap: collisionSwapRef.current, csl_authority: cslAuthorityRef.current || 'none', rfq_divergence: rfqDivergeRef.current,
      note: collisionSwapRef.current
        ? (cslAuthorityRef.current === 'posted-requirement'
            ? `swapped to the buyer's POSTED-REQUIREMENT category ${id} (name-matched "${rfqDivergeRef.current?.rfq_product ?? ''}"); his filed category outranks the mis-resolved name`
            : `swapped to the CSL-browsed category via ${cslAuthorityRef.current}; wrong-category seed specs discarded`)
        : (rfqDivergeRef.current
            ? `name resolved to ${id}, but the buyer's posted requirement "${rfqDivergeRef.current.rfq_product}" is filed under ${rfqDivergeRef.current.rfq_mcat} — divergence recorded; LLM-1 reconciles via its posted-requirement specs`
            : 'name resolved directly (neither CSL nor the posted requirement contradicted it)') } });
    // P0-01 (owner: mcat-scoped + additive) — if this commit is an ENTIRELY DIFFERENT product (different mcat)
    // than the one the mic/photo evidence + image were captured under, DROP them: they're wrong for the new
    // schema and must not autofill / feed the LLM prompts / ship to sellers. Same mcat → keep & merge (additive).
    if (photoMcatRef.current && photoMcatRef.current !== id) {
      photoSpecsRef.current = {}; photoSetKeys.current.clear(); useCaseSetKeys.current.clear(); pendingAiSpecs.current = null; setImageBase64('');
    }
    photoMcatRef.current = id; // evidence added from here on belongs to this product
    setSpecsLoading(true); setUnitsResolved(false); setIsqSpecs([]); setSpecValues({}); setUnitOptions([]); setUnit(''); setQtyUnitTruth(''); unitRankRef.current = 0; setProductImageUrl(''); setProductImages([]); setResolving(false); setCommitted(true);
    setMcatId(id); categoryNameRef.current = ''; sellerSpecsRef.current = []; setSellerSpecsReady(false); pushRecent(name);
    emit(EV.PRODUCT_COMMITTED, { mcatId: id, productName: name, surface: surfaceName });
    // Re-arm the unified planner's fire-guard so a re-commit (same or new mcat) re-fires it and clears
    // aiSpecsLoading — without this a same-product re-commit hangs the spec page forever.
    plannerFiredFor.current = '';
    plannerRuns.current = 0;   // the run ceiling is PER PRODUCT — a new requirement starts with a full budget
    specValuesRef.current = {}; // specValues was just cleared above; keep the mirror in step for the same tick
    seedSetKeys.current.clear(); // …and its provenance: nothing is seed-owned until the seed effect re-applies
    besReset();   // BES is scored per REQUIREMENT — a new product starts a fresh effort budget
    // LOSSLESS across a product change: mic/photo evidence (photoSpecsRef) is JOURNEY-level, never wiped —
    // the typed name anchors the NEW category while voice/photo facts survive as autofill candidates
    // against the new schema + evidence input to the AI-specs prompt. Buyer page answers DO reset (by design).
    if (Object.keys(photoSpecsRef.current).length) pendingAiSpecs.current = { ...photoSpecsRef.current };
    setIsqHints({}); setAiSpecs([]); setAiSpecValues({}); setLlmSuggests({}); setAiSpecsError(false); setAiSpecsLoading(hasFormLLM());
    setExtraSpecs({}); setExtraSpecSrc({}); extraEditedRef.current = new Set(); // re-derived by the unified planner from the (surviving) evidence + new name
    setBaq(null); setRbBrain(null); setPlanCorrections([]); setBaqLoading(hasFormLLM()); // clear the OLD product's brain/opening/strip immediately, not just once the new planner call resolves
    // C2 (2026-08-03): pages 2 and 3 reset too. This block cleared every page-1 surface but left commercialPlan /
    // personaPlan / cxAnswers / psAnswers standing, so after a product switch the PREVIOUS product's answers were
    // still in the session — and because the merge layer drops anything already answered, they SILENTLY SUPPRESSED
    // the new product's own commercial/persona questions. The fire-once refs must be cleared with them or the
    // planners would decline to re-run for the new mcat.
    setCommercialPlan(null); commercialPlanRef.current = null; setPersonaPlan(null); setCxAnswers({}); setPsAnswers({});
    cxFiredFor.current = ''; psFiredFor.current = '';
    cxUsedFallback.current = false; psUsedFallback.current = false; cxUsedNoCategory.current = false;
    // parallel pre-warm bookkeeping resets with the product too, else a new mcat's pre-warm reads a stale snapshot /
    // empty flag and either declines to fire or wrongly skips the page.
    cxPage1Snap.current = ''; psPage2Snap.current = ''; cxIsEmpty.current = false; psIsEmpty.current = false;
    synthFiredFor.current = ''; setProfileSynth(null);   // LLM 4 re-runs for the new product
    retailCheckedFor.current = ''; setRetailChoice(null); setShowRetailGate(false); setRetailChecking(false);   // #75: a new product = a fresh retail decision (don't carry product A's "retail" onto product B)
    // #76 fix: reset the bundle ONLY on a genuine product SWITCH. A first commit of a TYPED product must PRESERVE a
    // photo/voice slice written before it (that write happened pre-commit; an unconditional reset here wiped it — review #1).
    if (bundleProductRef.current && bundleProductRef.current.toLowerCase() !== name.trim().toLowerCase()) sessionInputsRef.current = {};
    bundleProductRef.current = name.trim();
    cxTouched.current.clear(); psTouched.current.clear();   // a new product's answers start untouched
    // P2-206: the 3 secondary catalog calls (getISQs enrichment · McatDtl image/category · IMSearchAPI gallery) all
    // depend only on `id`, so fire them CONCURRENTLY with the primary GetIsq below instead of serially after its
    // await. Page-1 spec correctness no longer depends on ordering: getISQs appends by functional merge, and GetIsq's
    // own set (further down) MERGES `fast` over whatever is present rather than replacing it — so whichever resolves
    // first, the authoritative buyer set still leads and no enrichment is clobbered.
    const isqT0 = Date.now();
    postJSON<{ RESPONSE?: { DATA?: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }> } }>('/api/mimart/api/bmcajax/addressbook/getISQs', { mcatId: id }, 30000)
      .then((isq2) => {
        if (myGen !== commitGen.current) return; // stale product's response — drop it
        const raw = isq2?.RESPONSE?.DATA ?? [];
        const authUnits = deriveUnits(raw);
        if (authUnits.length) { setUnitOptions((prev) => (prev.length ? prev : authUnits)); applyUnit(authUnits, parsedQty?.unit, parsedQty?.unit ? 2 : 1); } // recover units if fast GetIsq had failed; name-parsed unit=truth, else options[0] default
        // getISQs carries a per-spec buyer/seller flag. Page 1 stays the BUYER requirement form (GetIsq);
        // SELLER-flagged specs ("2") are NOT rendered on page 1 — they feed the page-2 AI prompt. Any
        // BUYER-flagged getISQs specs ENRICH page 1 (dedup by name).
        const rows = (Array.isArray(raw) ? raw : []) as Array<ISQSpec & { IM_SPEC_MASTER_BUYER_SELLER?: string; OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>;
        const isSeller = (s: { IM_SPEC_MASTER_BUYER_SELLER?: string }) => String(s.IM_SPEC_MASTER_BUYER_SELLER ?? '') === '2';
        // A MANDATORY spec renders on Page 1 even if it is seller-flagged — a mandatory buyer question (e.g. MRP,
        // Quantity per Pack) must never be silently dropped by the seller filter (deep-audit 2026-08-12). It is pulled
        // OUT of the seller pool (so LLM 1 doesn't also re-emit it) and INTO the buyer render set below.
        const isMandatory = (s: { IM_MANDATORY?: string }) => String(s.IM_MANDATORY ?? '') === '1';
        const sellerRows = rows.filter((s) => isSeller(s) && !isMandatory(s));
        // R-fix: NO `: rows` fallback — when a category has no seller-flagged rows, the seller list is genuinely empty.
        // The old fallback fed LLM 1 the ENTIRE buyer schema AS seller_specs, so its "add 1-2 NON-overlapping seller
        // specs" rule got fully-overlapping data. `(none)` is the correct seller_specs input for such categories.
        sellerSpecsRef.current = sellerRows.map((s) => s.IM_SPEC_MASTER_DESC).filter(Boolean);
        const buyerSpecs = mapDisplaySpecs(rows.filter((s) => s.IM_SPEC_MASTER_DESC && (!isSeller(s) || isMandatory(s))));
        if (buyerSpecs.length) setIsqSpecs((prev) => mergeSpecsPreferOptions(prev, buyerSpecs)); // #A keep the option-bearing row on a name collision
        // This call GATES LLM 1 (`sellerSpecsReady`) and is the ONLY writer of the seller-spec pool, yet it had no
        // health row — so "the brain never fired" had no instrument pointing at its real cause. It also carries the
        // full buyer/seller split, which the inspector now renders (owner: "show all buyer specs and seller specs so
        // it is visible which spec got selected and why"). Recorded AFTER the split so `cleaned` is the real pools.
        recordSource('Specs · getISQs (buyer+seller split)', { ok: hasPayload(rows), ms: Date.now() - isqT0, raw: raw, cleaned: { buyer_specs: buyerSpecs.map((s) => s.IM_SPEC_MASTER_DESC), seller_specs: sellerSpecsRef.current, buyer_count: buyerSpecs.length, seller_count: sellerSpecsRef.current.length, gates_llm1: true } });
      }).catch((e) => { recordSource('Specs · getISQs (buyer+seller split)', { ok: false, ms: Date.now() - isqT0, raw: null, cleaned: null }); emitApiError('getISQs', e, { mcatId: id }); }).finally(() => { if (myGen === commitGen.current) { setSpecsLoading(false); setUnitsResolved(true); setSellerSpecsReady(true); } });
    getJSON<Record<string, unknown> & { Response?: { Data?: unknown }; data?: unknown }>(`/api/imimg/index.php?r=postblenq/McatDtl&modid=MY&mcatid=${id}`)
      .then((img) => {
        if (myGen !== commitGen.current) return;
        const d0 = (img?.Response?.Data ?? img?.data ?? img);
        const data = (Array.isArray(d0) ? d0[0] : d0) as Record<string, unknown>;
        if (data && typeof data === 'object') { const nm = data['glcat_mcat_name']; if (typeof nm === 'string' && nm.trim()) { categoryNameRef.current = nm.trim(); setCatName(nm.trim()); } for (const k of Object.keys(data)) { const v = data[k]; if (/img|image/i.test(k) && typeof v === 'string' && v.startsWith('http')) { setProductImageUrl(v.replace(/^http:\/\//i, 'https://')); break; } } } // https → no mixed-content on a prod https page
      }).catch((e) => emitApiError('McatDtl', e, { mcatId: id }));
    // (The landing GALLERY is not fetched HERE — it is fetched by the `imgFetchedFor` effect below, which is keyed
    //  on mcatId alone. NOTE: this comment used to claim the fetch was "owner-gated on the category actually
    //  defining a quantity"; that gate is not in the effect, so the description was wrong — corrected 2026-08-01.)
    imgFetchedFor.current = ''; setImgPanelState('idle');
    try {
      const specsT0 = Date.now();
      const isqJson = await getJSON<{ DATA?: (ISQSpec | ISQSpec[])[] }>(`/api/imimg/index.php?r=Newreqform/GetIsq&modid=MY&mcatid=${id}&cat_type=3&flag=1&isq_format=1&generic_flag=1&country_iso=IN`);
      if (myGen !== commitGen.current) return;
      const flat = (isqJson?.DATA ?? []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s) => s && s.IM_SPEC_MASTER_DESC);
      const unitOpts = deriveUnits(isqJson?.DATA);
      // Use ONLY the qty/unit the API provides. Some mcats carry none (e.g. Diesel Generator) — then
      // quantity + unit are simply hidden (and not required), matching V3.
      // only-if-empty setUnit: the parallel getISQs may have populated units first and the buyer may have already
      // TAPPED one — never clobber a user's selection in this commit-time race (audit).
      if (unitOpts.length) { setUnitOptions((prev) => (prev.length ? prev : unitOpts)); applyUnit(unitOpts, parsedQty?.unit, parsedQty?.unit ? 2 : 1); }
      setUnitsResolved(true); // units are known now → Continue can un-gate even for a spec-less category
      const fast = mapDisplaySpecs(flat as Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>);
      // P2-208: clear the spinner as soon as GetIsq answers — even with ZERO display specs (a spec-light category).
      // MERGE (not replace) so a getISQs enrichment that resolved FIRST (P2-206 parallel fire) is preserved: the
      // authoritative buyer `fast` set leads, any extra getISQs buyer-specs already present follow (dedup by name).
      recordSource('Specs · GetIsq', { ok: !!fast.length, ms: Date.now() - specsT0, raw: isqJson, cleaned: fast }); // K: buyer-specs schema = 1 of plan §6's 7 inspector sources (LLM-1 input)
      setIsqSpecs((prev) => mergeSpecsPreferOptions(fast, prev)); // #A fast leads, but an option-less fast row is upgraded with prev's options
      setSpecsLoading(false);
    } catch (e) { recordSource('Specs · GetIsq', { ok: false, ms: 0, raw: null, cleaned: null }); emitApiError('GetIsq', e, { mcatId: id }); /* fall through — the getISQs .finally still settles specsLoading */ }
  }, []);

  // ── BRAIN SEED (Approach A): drive the REAL commit flow from the seed, then re-apply pre-filled specs. ──
  // Seeding committed/mcat directly skipped GetIsq → no spec fields. Instead let commitProduct run the true
  // resolve + GetIsq (loading the ISQ schema), then merge the brain's stated specs onto those fields.
  const seedCommitFired = useRef(false);
  const seedSpecsApplied = useRef(false);
  useEffect(() => {
    if (_seed?.productName && !seedCommitFired.current) {
      seedCommitFired.current = true;
      commitProduct(_seed.productName);
    }
  }, [_seed, commitProduct]);

  // ── The UNIFIED Curated-RFQ planner — ONE understanding→ranking call. This replaces what used to be THREE
  //    separate calls: the buyer-aware opening question, getSpecHints (page-1 prefill + per-field hints +
  //    "also detected" extras), and getMissingSpecs (page-2 gap questions). Fires for EVERY committed product —
  //    seeded (enrich/repost) OR freshly typed (cold-start gets the curated experience too, not just seeded
  //    flows) — and RE-FIRES on a material change: new mcat, new photo/voice evidence (aiEpoch bump), or a
  //    late-arriving ISQ schema (specSig) — mirrors the old hintsKey/aiKey discipline so no evidence is missed.
  const [baq, setBaq] = useState<CuratedPlan | null>(null);
  const [planCorrections, setPlanCorrections] = useState<CuratedPlan['prefills']>([]);
  // #4 — LLM 1's Requirement Brain (understanding · persona_read · category_trustworthy · evidence). Drives the
  // brain LLM 2/3 read (replacing the old baq.understanding derivation), and category_trustworthy drives CF-6
  // (low-confidence category → hide unfilled buyer specs, #6). null until LLM 1 lands / on a fresh product.
  const [rbBrain, setRbBrain] = useState<RequirementBrain | null>(null);
  const [baqLoading, setBaqLoading] = useState(false);
  // #76 fix: LLM 1 (brain) now fires LATE (on page 1), so a fast buyer can reach page 2/3 before it lands. brainInFlight
  // = the brain call is still running; the planners wait for the real brain, and page-2/3 loader + Next-gate hold the buyer.
  const brainInFlight = baqLoading || aiSpecsLoading;
  // Hold Next while the CURRENT page's questions are still being generated, so the buyer can't skip past a loading planner
  // and lose its questions (page 1 is NOT held — its ISQ specs are already on screen; only the LLM-only pages 2/3 wait).
  const nextBlocked = (stage === 'commercial' && (cxLoading || brainInFlight)) || (stage === 'persona' && (psLoading || brainInFlight));
  const [baqAnswers, setBaqAnswers] = useState<Record<string, string>>({});
  // Identity absorbed into the planner (owner-locked 2026-07-27): when the planner ranks a GST-style identity
  // question among its top gaps, it rides the SAME gaps list (kind:'identity') — this just pulls it out so its
  // answer writes to the REAL gstRegistered state (not a throwaway aiSpecValues entry) and P3 knows to hide it.
  // `rank` = where the planner ranked it, so it renders in that position rather than being hoisted to the top.
  const [identityAsk, setIdentityAsk] = useState<{ q: string; options?: string[]; why?: string; rank?: number } | null>(null);
  // ── ITEM 1 · PERSONA, by the SAME mechanism as identity (owner never resolved the placement; the
  //    identity decision already answered it by analogy — there is no persona screen and no "profile
  //    spiral"). A persona question defaults to the last page's Business type / Industry and is promoted
  //    onto the spec page only when it wins a slot in the ranked gaps AND passes the deterministic
  //    bulk-B2B gate. Everything the planner UNDERSTANDS about the persona still happens either way;
  //    only the QUESTION is gated. `personaRoute` is why a rejected one never reached the buyer.
  const [personaAsk, setPersonaAsk] = useState<{ q: string; options?: string[]; why?: string; rank?: number } | null>(null);
  const [personaAnswer, setPersonaAnswer] = useState('');
  const [personaRoute, setPersonaRoute] = useState<DecisionRoute | null>(null);
  // ── ITEM 2 · PRE-ANSWERED questions — intent and non-spec questions the planner answered from the
  //    buyer's own truth. Rendered as a CONFIRM CHIP with its provenance, never as a silent fill: he sees
  //    the question, sees our answer, sees where it came from, and can change it in one tap. Anything he
  //    leaves standing ships; anything he clears does not.
  const [preAnswered, setPreAnswered] = useState<CuratedPreAnswer[]>([]);
  const [preAnswerValues, setPreAnswerValues] = useState<Record<string, string>>({});
  // ── ITEM 3 · where the relocatable last-page fields live for THIS buyer. Defaults to "everything stays
  //    where it is"; only the planner's allow-listed decisions move anything. Contractual fields are not
  //    in the allow-list at all, so no model output can reach them.
  //    `placement` answers ONE question — where does each field render — so no caller can accidentally read
  //    "keep_last_page" as "visible" for a field that has never had a last-page control.
  // C19: the SETTER is gone with `promotedLastPage` — it was a literal no-op (`setPlacement((p) => p)`), so this map
  // has never changed from its initial value. Kept as a frozen constant because the last-page render guards and the
  // debug routing ledger still read it; making it a plain const is what stops a future caller re-animating the
  // deleted spec-page promotion path.
  const [placement] = useState<Record<RelocatableField, PlacementSurface>>(
    () => Object.fromEntries(RELOCATABLE_LAST_PAGE_FIELDS.map((f) => [f, f === 'purchase_frequency' ? 'none' : 'last_page'])) as Record<RelocatableField, PlacementSurface>,
  );
  const [placementRoutes, setPlacementRoutes] = useState<DecisionRoute[]>([]);
  //    Why the form de-duped a planner gap away, keyed by its question AND by any engine_ref it carried, so an
  //    ENGINE ASK that ended up inside a relocated field is reported with the real reason and not the
  //    "the planner never ranked it" defect line — it did rank it; we merged it into a field.
  const [coveredGapReasons, setCoveredGapReasons] = useState<Record<string, string>>({});
  // ─── ONE DECISION SYSTEM — the engine's non-question decisions, and the planner's wording for them ──────
  // The engine emits RESOLVE_CONFLICT / SUGGEST / OFFER alongside its ASKs. They are NOT gap questions, so
  // they never ride `aiSpecs`; each has its own surface below. The planner still ranks and PHRASES them, and
  // hands its wording back via `engine_ref` — `enginePhrasing` is where that wording lands. Nothing here
  // depends on the planner succeeding: if it fails or omits a ref, the engine's own `field`/`why` is used.
  const engineDecisions = useMemo(() => _seed?.engineDecisions ?? [], [_seed]);
  const engineConflicts = useMemo(() => engineDecisions.filter((d) => d.action === 'RESOLVE_CONFLICT'), [engineDecisions]);
  const engineSuggests = useMemo(() => engineDecisions.filter((d) => d.action === 'SUGGEST'), [engineDecisions]);
  // (`engineOffers` deleted 2026-07-28 — an OFFER has no buyer-facing surface any more, so there is nothing to
  //  select it FOR. It still reaches the planner inside `engineDecisions` and it still gets its own
  //  "deliberately not rendered" row in the routing ledger, which walks `engineDecisions` directly.)
  const [enginePhrasing, setEnginePhrasing] = useState<Record<string, { q?: string; why?: string; options?: string[] }>>({});
  const [conflictPicks, setConflictPicks] = useState<Record<string, string>>({});   // engine id → the value the BUYER chose (never pre-selected)
  const [suggestPicks, setSuggestPicks] = useState<Record<string, string>>({});     // engine id → an INFERRED chip the buyer accepted
  // (`dismissedOffers` deleted 2026-07-28 — there is no offer strip to dismiss; see OFFER_NOT_RENDERED below.)
  useEffect(() => {
    if (!committed || !mcatId || !hasFormLLM()) return;
    // TRIGGER MOVED (2026-08-14, task #76): LLM 1 fires when the buyer LANDS ON PAGE 1 (has left the landing), NOT at
    // product commit — so the brain sees EVERYTHING gathered on the landing (mic + photo + chat + manual), not just the
    // product name. commitProduct now only loads the schema; this effect re-runs on the stage transition (stage is in
    // the deps) and fires once the schema + truth have settled (guards below). If the buyer advances before the schema
    // is ready, those guards hold and the effect re-fires the moment it settles — the pendingBrainFire behaviour, free.
    if (stage === 'landing') return;
    if (specsLoading) return; // wait for page-1 specs to settle (fires for zero-ISQ categories too, once settled)
    // #F — the plan's "no hard cap — wait for ALL truth": LLM 1 fires only once EVERY required input is in, not just
    // the Buyer Specs. (a) the leaf truth (csl/rfq/profile/whatsapp) must have SETTLED — leafTruth flips null→object
    // when the gate's allSettled resolves (arrive-or-error); a no-gate route (no glid) has nothing to wait for.
    // (b) the Seller Specs (getISQs) must have resolved (sellerSpecsReady), so a GetIsq-first race can't fire LLM 1
    // on an empty sellerSpecsRef. Both are in the deps below, so a late arrival re-runs this effect. pns is awaited inline.
    if (glid && !leafTruth) return;
    if (!sellerSpecsReady) return;
    // DEBOUNCE: schedule the fire after a quiet window; each input change re-runs this effect, the cleanup clears
    // the pending timer, so only the LAST-settled state fires. Collapses the opening burst (GetIsq → getISQs →
    // category → prefills) into ONE planner run. The fireKey/plannerRuns guards inside still prevent duplicates.
    const __plannerTimer = setTimeout(() => {
    const name = productName;
    const gen = commitGen.current; // guards against a superseded commit (async race — same discipline the old two calls had)
    // #calls (owner 2026-07-30, "why so many calls"): the fireKey deliberately EXCLUDES the spec signature. The ISQ
    // specs stream in over ~2s (GetIsq fast set → getISQs enrichment → mergeSpecsPreferOptions), and keying the fire
    // on specSig minted a NEW fireKey on every mutation — so the Requirement Brain re-fired ~5× per product (each a
    // 7.8k-token call), and re-fetched PNS each time. The leafTruth + sellerSpecsReady gates above already hold the
    // SINGLE fire until specs AND truth have settled, so it reads the FINAL specs; only a genuine evidence change
    // (aiEpoch: a photo/voice add, or an explicit Retry) re-fires. Collapses ~5 brain calls → 1.
    const fireKey = `${mcatId}:${name}:${aiEpoch}`;
    if (plannerFiredFor.current === fireKey) return;
    // BLAST-RADIUS CEILING (belt and braces to the epoch-bump fix in applyExtractedSpecs). aiEpoch is part of
    // the fire-key, so ANY path that bumps it re-fires a full planner call. The cause is fixed at the source;
    // this bounds the damage if a future path reintroduces it. Counts AUTOMATIC runs only — an explicit buyer
    // "Retry" resets the counter, because a buyer asking for it again is never a runaway.
    if (plannerRuns.current >= MAX_PLANNER_RUNS) { setBaqLoading(false); setAiSpecsLoading(false); return; }
    plannerRuns.current++;
    plannerFiredFor.current = fireKey;
    setBaqLoading(true); setAiSpecsLoading(true);
    // #4 — LLM 1 (Requirement Brain) drives Page 1. It synthesises the RAW leaf truth (csl · rfq · profile ·
    // whatsapp · pns) + the category's buyer/seller ISQ schema into Page 1 in ONE shot. NON-BLOCKING: the buyer
    // ISQ specs are already on screen (GetIsq, independent of this call), so LLM 1 only HOT-ENHANCES them
    // (prefills) and appends any question it still needs. Category insights are deliberately NOT fed here (locked
    // decision) — they belong to LLM 2. The old engine-Decision-Layer planner (runCuratedPlanner) is retired.
    //
    // Clear the retired engine-Decision surfaces on every (re)plan so no stale engine UI can render. Their state +
    // render blocks remain until the #4d cleanup pass; nothing feeds them any more.
    setBaq(null); setIdentityAsk(null); setPersonaAsk(null); setPersonaRoute(null);
    setPreAnswered([]); setPlacementRoutes([]); setEnginePhrasing({}); setCoveredGapReasons({});
    const buyerSpecsInput = isqSpecs.map((s) => ({
      name: s.IM_SPEC_MASTER_DESC,
      options: s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [],
      mandatory: String((s as { IM_MANDATORY?: string }).IM_MANDATORY ?? '') === '1',
    }));
    const sellerSpecsInput = sellerSpecsRef.current.map((q) => ({ q }));
    // What we already hold (buyer-filled specs + qty), minus any product-chooser row — telling LLM 1 we "hold" the
    // buyer's product under a spec name makes it reason about a spec that does not exist.
    const alreadyFilled: Record<string, string> = {};
    for (const [k, v] of Object.entries(specValues)) if (!isProductInterestField(k) && !isNonSpecNote(k) && v) alreadyFilled[k] = v;
    if (quantity) alreadyFilled['Quantity'] = quantity;
    const tr = leafTruthRef.current;
    // TOFFEE part 2 (name↔category collision): if the buyer BROWSED a different category (the CSL viewed twin's mcat ≠
    // the committed mcat) and CSL carries that category's ISQ, hand it to LLM 1 as <browsed_specs>. When LLM 1 judges
    // the committed category untrustworthy it drives Page 1 from THESE — the food ISQ the buyer actually browsed —
    // instead of asking transformer specs for a toffee. Absent (undefined) for the normal no-collision case.
    // leafTruth.csl IS the CSL summary object (BrainFormGate stores csl.raw = the summary), so category_isq &
    // viewed_products sit DIRECTLY on it — do NOT reach through a further `.raw` (that was undefined, so the whole
    // browsed_specs / collision path was dead code). Bug-hunt 2026-07-31.
    const cslObj = tr?.csl as { category_isq?: unknown; viewed_products?: { name: string; mcat?: string }[] } | undefined;
    const cslRaw = cslObj as Record<string, unknown> | undefined;
    const browsedTwin = cslObj?.viewed_products?.find((v) => v.name && v.name.toLowerCase() === name.toLowerCase());
    const catIsq = Array.isArray(cslRaw?.category_isq) ? (cslRaw!.category_isq as Array<{ name?: string; for?: string; options?: string[] }>) : [];
    const collision = !!browsedTwin?.mcat && !!mcatId && browsedTwin.mcat !== mcatId && catIsq.length > 0;
    const browsedSpecs = collision
      ? catIsq.filter((q) => (q.for ?? 'buyer') === 'buyer' && q.name)
          .map((q) => ({ name: String(q.name), options: Array.isArray(q.options) ? q.options.map(String).filter((o) => o && o.toLowerCase() !== 'text') : undefined }))
      : undefined;
    // pns needs the mcat, so it is fetched HERE (not at the gate). Best-effort — a slow/absent pns never blocks it.
    // (Owner 2026-07-31: the PNS empty/err is a server-side n8n issue, NOT a frontend await to work around — the 3s
    // race-cap safeguard was reverted at the owner's request. Restores plan #6 "full = wait for all".)
    // `tr?.profile` is passed purely so the source-health row can cross-check the API's row count against the
    // buyer's own call counters (C5). It never changes what is fetched or what the brain receives.
    const pnsP = glid ? fetchPnsInsights(glid, pnsMode, mcatId, 120000, tr?.profile).catch(() => null) : Promise.resolve(null);
    pnsP.then((pns) => { pnsRef.current = pns; return runRequirementBrain({  // #④ stash pns so LLM 2 reuses it (no 2nd fetch)
      product: name, quantity,
      csl: tr?.csl, rfq: tr?.rfq, profile: tr?.profile, whatsapp: tr?.whatsapp, pns,
      enquiries: tr?.enquiries,   // TYPE-E: his direct seller enquiries — highest-intent sourcing signal
      buyerSpecs: buyerSpecsInput, sellerSpecs: sellerSpecsInput, alreadyFilled,
      sessionInputs: sessionInputsRef.current,   // #76: the buyer's LIVE landing inputs (chat/mic/photo/notes) — the freshest signal
      browsedSpecs, browsedCategory: collision ? browsedTwin?.name : undefined,
    }, execMode, effortMode); }).then((result) => {
      if (plannerFiredFor.current !== fireKey || gen !== commitGen.current) return;
      if (!result) { setAiSpecsError(true); return; } // CF-4: LLM 1 fail → keep the buyer ISQ specs as they are
      // COLLISION AUTHORITY (case-audit 2026-07-31, CRITICAL): a deterministic collision (the browsed category ≠ the
      // committed category, WITH a real browsed ISQ) is PROOF the committed category is a name-collision mis-mapping
      // (e.g. a bakery "Tasty Three in One" filed under transformers). It must OVERRIDE the LLM's category_trustworthy
      // — which trusted the mis-category and asked kVA for a cake. Forcing FALSE flips CF-6 to drop the empty
      // mis-category specs and drive Page 1 from browsed_specs (the real, browsed schema). NOTE: re-anchoring mcatId to
      // the browsed category (so seller-search + submission also use it) is the completing follow-up.
      setRbBrain(collision ? { ...result.brain, category_trustworthy: false } : result.brain); setAiSpecsError(false);
      // Split LLM 1's Page-1 questions: ones that ARE buyer ISQ specs become PREFILLS (their chip is already on
      // screen); ones that are NOT become the appended LLM questions (aiSpecs). Product-chooser rows never re-ask.
      const specByLc = new Map(isqSpecs.map((s) => [s.IM_SPEC_MASTER_DESC.toLowerCase(), s.IM_SPEC_MASTER_DESC]));
      // Concept-keyed twin (2026-08-10): the lowercased-exact map missed a REPHRASE — buyer spec "Material" vs LLM-1
      // "Material Type" — so the generated question rendered as a SECOND page-1 row (dup, owner #3) or its prefill
      // seeded a separate chip while the buyer's ISQ chip stayed blank (double-fill, owner #4). Matching by CONCEPT
      // routes a rephrased question/prefill back onto the buyer's own chip. Exact wins first (a genuinely distinct
      // spec keeps its identity); concept only catches what exact missed. First writer wins if two specs share a
      // concept (rare). Also checks the question LABEL, since a coined field key often phrases the concept in the label.
      const specByConcept = new Map<string, string>();
      for (const s of isqSpecs) { const c = canonConcept(s.IM_SPEC_MASTER_DESC); if (c && !specByConcept.has(c)) specByConcept.set(c, s.IM_SPEC_MASTER_DESC); }
      const matchSpec = (field: string, label?: string): string | undefined =>
        specByLc.get(field.toLowerCase()) ?? specByConcept.get(canonConcept(field)) ?? (label ? specByConcept.get(canonConcept(label)) : undefined);
      const prefillMap: Record<string, string> = {};
      const asks: AiSpecQuestion[] = [];
      const aiSeed: Record<string, string> = {};   // prefilled values for GENERATED / SELLER questions → aiSpecValues
      const suggests: Record<string, string> = {}; // buyer-spec name → LLM 1's ALTERNATIVE (a "suggested" chip, never an overwrite)
      // I-fix: per-field CONSUMPTION LEDGER — "what LLM 1 emitted → what the form did with it → why". Published to
      // window.__rfqConsumption for the AI Inspector (ungated on the leaf flow), so the debug follows the form hierarchy.
      const consume: { page1: { field: string; ui: string; matched?: string; action: string }[]; knownTruths: { key: string; value: string; action: string }[] } = { page1: [], knownTruths: [] };
      for (const q of result.page1.questions) {
        if (isProductInterestField(q.field)) { consume.page1.push({ field: q.field, ui: q.ui, action: 'skippedProductChooser' }); continue; }
        const realSpec = matchSpec(q.field, q.label);
        if (realSpec) {
          // A BUYER ISQ spec (its chip is already on screen). prefill/confirm carry its value; suggest keeps the
          // buyer's value AND surfaces LLM 1's alternative as a non-sticky ghost chip (plan: never overwrite).
          if (q.value && (q.ui === 'prefill' || q.ui === 'confirm')) { prefillMap[realSpec] = q.value; consume.page1.push({ field: q.field, ui: q.ui, matched: realSpec, action: 'prefillApplied' }); }
          else if (q.ui === 'suggest') { if (q.value) prefillMap[realSpec] = q.value; if (q.suggestion) suggests[realSpec] = q.suggestion; consume.page1.push({ field: q.field, ui: q.ui, matched: realSpec, action: q.suggestion ? 'suggestShown' : 'prefillApplied' }); }
          else consume.page1.push({ field: q.field, ui: q.ui, matched: realSpec, action: 'droppedSilently' });
        } else if (q.ui === 'ask' && (q.options?.length ?? 0) >= 2) {
          // OPTION-BASED GATE (audit 2026-07-31): a generated/seller ask needs >=2 chips or it renders as a free-text
          // box (OptionChips with no options = just an "Other…" input). Mirrors the planner gate at llm.ts runPlanner.
          asks.push({ fieldName: q.field, options: q.options!, helperText: '', kind: 'spec', rank: q.order } as AiSpecQuestion);
          consume.page1.push({ field: q.field, ui: q.ui, action: 'routedToAiSpecs' });
        } else if (q.ui === 'ask') {
          consume.page1.push({ field: q.field, ui: q.ui, action: 'droppedFewOptions' }); // chip-less ask — never render as free-text on Page 1
        } else if (q.value && (q.ui === 'prefill' || q.ui === 'confirm' || q.ui === 'suggest')) {
          // A GENERATED (low-conf) or SELLER (high-conf) spec that is NOT in the buyer schema but carries a PREFILLED
          // value. The plan requires generated/seller questions to render WITH their prefilled value — route it into
          // aiSpecs and seed aiSpecValues, instead of silently dropping it (the old loop only kept ui:'ask' here).
          asks.push({ fieldName: q.field, options: q.options || [], helperText: '', kind: 'spec', rank: q.order } as AiSpecQuestion);
          aiSeed[q.field] = q.value;
          consume.page1.push({ field: q.field, ui: q.ui, action: 'seededValue' });
        } else consume.page1.push({ field: q.field, ui: q.ui, action: 'droppedSilently' });
      }
      if (Object.keys(prefillMap).length) applyExtractedSpecs(prefillMap, 'ai', false); // refire=false: LLM 1's own prefills must not re-fire it
      setAiSpecs(asks);
      if (Object.keys(aiSeed).length) setAiSpecValues((p) => ({ ...aiSeed, ...p })); // never clobber a value the buyer already picked
      setLlmSuggests(suggests);
      // known_truths — ONLY product-SPEC facts not in the ISQ schema go to "Also detected". The buyer's IDENTITY /
      // CONTACT / CONTEXT (name, mobile, email, location, company, GST, past-product names) are NOT specs and must
      // never render as detected specs (owner 2026-07-30: they were showing under "Also detected"). A qty-like truth
      // fills the real Quantity state instead (LLM-owned qty, CF-3), never an "also detected" row.
      const qtyTruth = result.known_truths.find((k) => KT_QTY.test(k.key.trim()) && /\d/.test(k.value));
      if (qtyTruth) {
        setQuantity((q) => q || sanitizeQty(qtyTruth.value));
        // The KT value is e.g. "500 Packet": sanitizeQty keeps the 500 but the UNIT token was being discarded, so the
        // unit then defaulted to unitOptions[0] (="Piece") — shipping the WRONG unit to sellers (deep-audit 2026-08-12).
        // Recover the trailing non-numeric remainder as the unit and give it a channel (setQtyUnitTruth → the effect
        // below snaps it to a chip, adding it as an option if the category lacks it — never silently coerces Packet→Piece).
        const unitTok = qtyTruth.value.replace(/[0-9.,]+/g, ' ').replace(/\b(qty|quantity|order|approx|about|around|nos|of|per)\b/gi, ' ').trim();
        if (unitTok) setQtyUnitTruth((p) => p || unitTok);
      }
      // Route each known_truth SYNCHRONOUSLY (decision depends only on refs/schema, not React state), so the ledger
      // is accurate and the setExtraSpecs updater stays a pure merge.
      const extraAdds: Record<string, string> = {};
      const extraSrcAdds: Record<string, string> = {};   // origin per kept row so the UI can badge "from your posted requirement" (Theme-B)
      for (const k of result.known_truths) {
        if (!k.value) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'skippedEmpty' }); continue; }
        if (extraEditedRef.current.has(k.key.toLowerCase())) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'skippedEdited' }); continue; }
        if (isProductInterestField(k.key)) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'skippedProductInterest' }); continue; }
        if (specByLc.has(k.key.toLowerCase()) || specByConcept.has(canonConcept(k.key))) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'skippedDuplicateSpec' }); continue; } // concept-aware: a rephrased known-truth of a buyer spec is not shown twice
        if (KT_QTY.test(k.key.trim())) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'routedToQuantity' }); continue; }
        if (isNonSpecKey(k.key)) { consume.knownTruths.push({ key: k.key, value: k.value, action: 'droppedNonSpec' }); continue; } // identity/context → never a spec (J-fix two-tier)
        extraAdds[k.key] = k.value;
        extraSrcAdds[k.key] = (k as { source?: string }).source ?? '';
        consume.knownTruths.push({ key: k.key, value: k.value, action: 'keptAlsoDetected' });
      }
      if (Object.keys(extraAdds).length) { setExtraSpecs((prev) => ({ ...prev, ...extraAdds })); setExtraSpecSrc((prev) => ({ ...prev, ...extraSrcAdds })); }
      // Provenance (owner Q4 — "what was the pool available and why this spec surfaced"): publish the CANDIDATE POOLS
      // LLM 1 actually saw (the seller pool is the load-bearing one — buyer specs already render on screen), so the
      // inspector can show what was available next to what surfaced. Per-candidate ranking is the debug `considered` add.
      try { (window as unknown as { __rfqConsumption?: unknown }).__rfqConsumption = { at: Date.now(), product: name, category_trustworthy: result.brain.category_trustworthy, sellerPool: sellerSpecsInput.map((s) => s.q), buyerPool: buyerSpecsInput.map((s) => s.name), browsedPool: browsedSpecs?.map((s) => s.name) ?? [], ...consume }; } catch { /* noop */ }
    }).catch((e) => {
      emitApiError('runRequirementBrain', e, { mcatId, aiEpoch });
      emit(EV.AISPECS_FAILED, { mcatId, aiEpoch, surface: surfaceName });
      // CF-4: a dead LLM 1 leaves the buyer ISQ specs standing (already rendered) — never blank the page.
      if (plannerFiredFor.current === fireKey && gen === commitGen.current) setAiSpecsError(true);
    }).finally(() => {
      if (plannerFiredFor.current === fireKey && gen === commitGen.current) { setBaqLoading(false); setAiSpecsLoading(false); }
    });
    }, PLANNER_SETTLE_MS);
    return () => clearTimeout(__plannerTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, mcatId, isqSpecs, productName, aiEpoch, specsLoading, leafTruth, sellerSpecsReady, stage]);

  // Q-fix: if a late GetIsq/getISQs promotes a GENERATED/SELLER spec's name into the ISQ schema, migrate its prefilled
  // value from aiSpecValues → specValues under the canonical ISQ name. Both allSpecEntries and visibleAiSpecs drop an
  // aiSpec whose name is now an ISQ name, so without this the value would be stranded (not rendered, not shipped).
  useEffect(() => {
    const names = new Map(isqSpecs.map((s) => [s.IM_SPEC_MASTER_DESC.toLowerCase(), s.IM_SPEC_MASTER_DESC]));
    const moves: Record<string, string> = {};
    let hasPromoted = false;
    for (const [k, v] of Object.entries(aiSpecValues)) {
      const canon = names.get(k.toLowerCase());
      if (!canon) continue;
      hasPromoted = true;
      if (v && !(specValues[canon] || '').trim()) moves[canon] = v;  // fill the ISQ gap; never clobber a buyer value
    }
    if (!hasPromoted) return;
    if (Object.keys(moves).length) setSpecValues((p) => ({ ...moves, ...p }));
    setAiSpecValues((p) => { const n = { ...p }; for (const k of Object.keys(p)) if (names.has(k.toLowerCase())) delete n[k]; return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isqSpecs]);

  // ── DECISION ROUTING LEDGER — the "nothing may be silently dropped" guarantee ─────────────────────────
  // Every engine Decision Object is accounted for on every render pass: it either RENDERED (and we say where,
  // and in whose wording), or it is recorded as suppressed WITH a reason. The reason is the planner's own
  // `dropped_because` when it ranked the decision away, and an explicit defect line when it never ranked it at
  // all. Published via `decisionRoutingReport()` (+ window.__decisionRouting) for the debug panel's suppressed
  // list. SUPPRESS decisions are deliberately absent — the ENGINE already dropped those and the debug panel
  // reads them straight off `p.decisions`; this ledger is about what the FORM did with what it was handed.
  useEffect(() => {
    // The PLANNER's own decisions are accounted for on the same ledger, because "nothing may be silently
    // dropped" was never a rule about engine decisions specifically — it is a rule about the buyer never
    // losing a question without a recorded reason. Three new kinds of row: the persona question and why it
    // was or was not asked, every relocatable last-page field and where it ended up (including the ones a
    // planner tried to move that it may not touch), and every question we answered instead of asking.
    // …plus, since 2026-07-28, the three things the BUYER-FACING privacy sweep took off the screen. Their
    // provenance did not disappear with the pixels — it moved HERE, which is the internal channel the owner
    // exempted ("KEEP full provenance in the DEBUG panel"). Without these rows, deleting the receipt strip
    // would have been the very silent drop this ledger exists to prevent.
    // The provenance goes in `where`, NOT only in `reason`: the debug panel prints `reason` for the rows that did
    // NOT render and `where` for the ones that did, so a rendered row's provenance is only actually readable if
    // it rides `where`. (Same reason PRE_ANSWER below carries its source there.) `reason` keeps the longer note.
    const onPrefillPage = 'spec page';
    const provenanceRoutes: DecisionRoute[] = [
      ...(personaValue && personaSource ? [{
        id: 'planner:person', action: 'PERSON_PREFILL', field: 'business persona', rendered: true,
        where: `last page · "Your business" field, prefilled "${personaValue}" + editable + AI icon; provenance (${personaSource}) internal only`,
        reason: `NOT shown to the buyer: the source line ("✦ from your call with a seller — change it if we read you wrong") was removed on the owner's privacy instruction; he sees the value and the AI mark only.`,
      } as DecisionRoute] : []),
      ...planCorrections.map((p, i) => ({
        id: `planner:prefill${i + 1}`, action: 'PREFILL', field: p.field, rendered: true,
        where: `${onPrefillPage} · spec chip ${p.corrected_from ? `corrected from "${p.corrected_from}" to ` : ''}"${p.value}" + editable + AI icon; provenance (${p.source}) internal only`,
        reason: 'the buyer sees the value and the AI icon; the "Filled from your history" receipt strip that used to print this source was deleted (owner 2026-07-28).',
      } as DecisionRoute)),
      ...Object.entries(_seed?.observedFields ?? {})
        .filter(([f]) => !planCorrections.some((p) => p.field === f) && specValues[f])
        .map(([f, why]) => ({
          id: `engine:observed:${f}`, action: 'CONFIRM', field: f, rendered: true,
          where: `${onPrefillPage} · spec chip "${specValues[f]}" + editable + AI icon; OBSERVED tier, provenance (${why}) internal only`,
          reason: 'an OBSERVED-tier value is shown back for confirmation as an ordinary editable chip — the buyer can change it, and he is not told which channel it came from.',
        } as DecisionRoute)),
    ];
    const plannerRoutes: DecisionRoute[] = [
      ...(personaRoute ? [personaRoute] : []),
      ...placementRoutes,
      ...provenanceRoutes,
      ...preAnswered.map((p, i) => {
        const v = preAnswerValues[p.q] ?? '';
        const corrected = !!v && v !== p.value;
        return {
          id: `planner:pre${i + 1}`, action: 'PRE_ANSWER', field: p.q, rendered: true,
          // The source stays in the LEDGER wording (internal) and is no longer on the chip (buyer-facing).
          where: `${onPrefillPage} · confirm chip + AI icon; provenance (${p.source}) internal only`,
          reason: !v ? `the buyer cleared our answer — nothing ships for this, and that is a wrong pre-answer we should count`
            : corrected ? `the buyer corrected our answer to "${v}" — our "${p.value}" from ${p.source} was wrong`
            : `answered "${p.value}" from ${p.source} instead of asking him`,
          q: p.q,
        } as DecisionRoute;
      }),
    ];
    if (!engineDecisions.length) { recordDecisionRoutes(plannerRoutes); return; }
    const isqLower = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
    const renderedAsk = new Map<string, string>();     // engine id → the wording the buyer actually sees
    for (const q of aiSpecs) if (q.engineRef && !isqLower.has(q.fieldName.toLowerCase())) renderedAsk.set(q.engineRef, q.fieldName);
    for (const g of baq?.gaps || []) if (g.engine_ref) renderedAsk.set(g.engine_ref, g.q);
    const ledger = new Map((baq?.considered || []).filter((c) => c.engine_ref).map((c) => [c.engine_ref as string, c]));
    // Mirrors `renderableSuggests` exactly — the ledger must agree with the screen, or it is worse than useless.
    const answered = (d: { id: string; field: string }) => suggestPicks[d.id] === undefined && !!(specValues[d.field] || aiSpecValues[d.field] || extraSpecs[d.field]);
    const routes: DecisionRoute[] = engineDecisions.map((d) => {
      const phrase = enginePhrasing[d.id]?.q;
      const led = ledger.get(d.id);
      const lost = led?.outcome === 'dropped' ? (led.dropped_because || 'the planner ranked it out') : '';
      if (d.action === 'ASK') {
        const q = renderedAsk.get(d.id);
        if (q) return { id: d.id, action: d.action, field: d.field, rendered: true, where: 'spec page · question', reason: '', q };
        // The form itself may have merged this ASK into a relocated last-page field — that is a real reason and
        // it outranks both the planner's own and the defect fallback, because it is what actually happened.
        const covered = coveredGapReasons[d.id] || coveredGapReasons[decisionKey(d.field)];
        if (covered) return { id: d.id, action: d.action, field: d.field, rendered: false, where: 'merged into a relocated field', reason: covered };
        return { id: d.id, action: d.action, field: d.field, rendered: false, where: 'suppressed', reason: lost || 'the planner never ranked it and it was not in the ledger (planner defect)' };
      }
      if (d.action === 'RESOLVE_CONFLICT') {
        if ((d.conflict?.length ?? 0) >= 2) {
          return { id: d.id, action: d.action, field: d.field, rendered: true,
            where: 'spec page · conflict question, both values as options, nothing pre-selected',
            reason: `the per-option source labels (${(d.conflict || []).map((c: ConflictOption) => c.source).filter(Boolean).join(' vs ') || 'engine-supplied'}) are internal from 2026-07-28 — the buyer sees the options only`, q: phrase };
        }
        return { id: d.id, action: d.action, field: d.field, rendered: false, where: 'suppressed', reason: 'the engine sent fewer than two values — there is nothing for the buyer to choose between' };
      }
      if (d.action === 'SUGGEST') {
        if (answered(d)) return { id: d.id, action: d.action, field: d.field, rendered: false, where: 'suppressed', reason: 'the buyer has already answered this field — a suggestion would only second-guess him' };
        return { id: d.id, action: d.action, field: d.field, rendered: true, where: 'spec page · unselected suggestion chip', reason: '', q: phrase };
      }
      // OFFER — the only action this surface DELIBERATELY renders nothing for. `rendered: false` with the real
      // reason is the honest record; it is NOT the "planner defect" fallback and it is NOT a silent drop.
      return { id: d.id, action: d.action, field: d.field, rendered: false, where: 'deliberately not rendered', reason: OFFER_NOT_RENDERED, q: phrase };
    });
    recordDecisionRoutes([...routes, ...plannerRoutes]);
    // Tell the consumption ladder what this surface ACTUALLY renders, rather than letting it fall back to a
    // hand-dated static map. That map still said ASK/RESOLVE_CONFLICT/SUGGEST/OFFER don't render — true when
    // it was written, false since the dual-planner fix. An instrument built to catch drift had itself drifted
    // within hours, so the declaration now lives HERE, beside the code that does the rendering.
    // Kept in step with the 2026-07-28 spec-page SPLIT: when the split is active the prefilled values are on
    // spec page 2 and every question stays on page 1, so the "where" strings say which.
    //
    // OFFER IS NOW OMITTED ON PURPOSE (owner 2026-07-28). `registerRenderedActions` can only carry a `where`
    // for an action that DOES render — an omitted key becomes {rendered:false, where:"not read by
    // BrainRFQForm"} — so the ladder's Rendered column is correct (no control exists) and the REASON lives one
    // channel over, in the routing ledger row above (`OFFER_NOT_RENDERED`), which the debug panel reads. Making
    // the ladder itself print "deliberately not rendered" needs a one-line change in consumptionLadder.ts
    // (ENGINE_RENDER_MAP.OFFER.where), which is outside this task's file scope — see the report.
    registerRenderedActions('BrainRFQForm', {
      PREFILL: 'spec chips (specValues / quantity / unit / delivery), marked with the AI icon',
      CONFIRM: 'spec chips, prefilled + editable + AI icon; provenance internal (routing ledger), never shown to the buyer',
      ASK: 'inline question in the spec list, planner-ranked and phrased',
      RESOLVE_CONFLICT: 'conflict question in the spec list — both values plus the planner\'s extra options, nothing pre-selected, no sources shown',
      SUGGEST: 'unselected ghost chip, tap to accept',
      // SUPPRESS deliberately omitted — the firewall drops it by design, so "unrendered" is correct.
    });
  }, [engineDecisions, aiSpecs, baq, enginePhrasing, isqSpecs, specValues, aiSpecValues, extraSpecs, suggestPicks,
    personaRoute, placementRoutes, preAnswered, preAnswerValues, coveredGapReasons,
    // the provenance rows the buyer-facing sweep pushed onto this ledger
    personaValue, personaSource, planCorrections, _seed]);

  // EXTRACTION FIELD SET (owner 2026-08-11: "fill ALL available specs from the image"). A photo/voice used to be
  // mapped ONLY onto the buyer ISQ specs; now it is also given the planner's OWN spec questions (aiSpecs), so an
  // image can answer a spec the planner added that isn't in the buyer schema. Options are passed so the model snaps
  // to real chips. (Commercial/persona page-2/3 questions are deliberately NOT included — a product image never
  // carries delivery/payment/persona facts; extractions that match neither are captured as "Also detected" below.)
  const extractionFields = (): { fieldNames: string[]; fieldOpts: Record<string, string[]> } => {
    const fieldOpts: Record<string, string[]> = {};
    for (const s of isqSpecs) fieldOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
    for (const q of aiSpecs) if (!(q.fieldName in fieldOpts)) fieldOpts[q.fieldName] = q.options ?? [];
    return { fieldNames: Object.keys(fieldOpts), fieldOpts };
  };

  // ── LLM-on-image: a seeded product image → analyzeImage → MORE specs, via the same merge path as an
  //    upload. Best-effort: cross-origin image fetch may be CORS-blocked (imimg.com) → skip silently. ──
  const seedImgFired = useRef(false);
  useEffect(() => {
    const url = _seed?.productImage;
    if (!url || seedImgFired.current || !hasFormLLM() || !committed || !isqSpecs.length) return;
    seedImgFired.current = true;
    (async () => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return;
        const { base64, mime } = await fileToBase64(await res.blob());
        const { fieldNames, fieldOpts } = extractionFields();   // buyer ISQ + planner spec questions
        const r = await analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', 'form', RFQ_MODEL_IMAGE);
        const extracted = { ...(r.specifications || {}), ...(r.additionalSpecifications || {}) };
        // Same relation gate as the manual onPhoto path (+ collision-swap guard, like the sibling seed-SPEC effect):
        // a seeded/repost image that shows an UNRELATED product — or one whose mcat was swapped away — must not fold
        // its specs onto this requirement (the "Photo & Title mismatch" defect via the seed back-door).
        if (r.productMatch !== 'unrelated' && !collisionSwapRef.current && Object.keys(extracted).length) applyExtractedSpecs(extracted, 'photo');
      } catch { /* CORS / network — best-effort, the specs from the requirement still stand */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_seed, committed, isqSpecs]);
  useEffect(() => {
    const sv = _seed?.specValues;
    // On a collision swap the seed specs are the WRONG category (transformer specs for a cake) — discard them entirely
    // (owner: "the title was right, the filled specs were not"). The browsed category's own getISQs drives Page 1.
    if (!sv || !Object.keys(sv).length || seedSpecsApplied.current || collisionSwapRef.current) return;
    if (specsLoading || !isqSpecs.length) return;  // wait for the ISQ schema
    seedSpecsApplied.current = true;
    // Mark every field the seed is about to fill as SEED-owned, so the engine's later correction is allowed
    // through (P0 2026-07-28). Computed off the ref MIRROR rather than inside the updater below: a setState
    // updater runs on the next render and can run twice under StrictMode, so nothing written inside it is
    // readable here. Skipping a key whose value is already present keeps this honest — a field the planner
    // prefilled first is engine-owned, not seed-owned.
    const cur = specValuesRef.current;
    const seeded = new Set(seedSetKeys.current);
    // Drop platform-deduced / free-text buyer-note sentinels (Buyer Filled Details, Probable *) so they never seed a
    // page-1 spec value (2026-08-12 audit) — they are notes, not attributes, and would otherwise ship to sellers.
    const seedEntries = Object.entries(sv).filter(([k]) => !isNonSpecNote(k));
    for (const [k, v] of seedEntries) {
      const hit = isqSpecs.find((s) => s.IM_SPEC_MASTER_DESC.toLowerCase() === k.toLowerCase());
      const key = hit ? hit.IM_SPEC_MASTER_DESC : k;
      if (v && !cur[key]) seeded.add(key);
    }
    seedSetKeys.current = seeded;
    setSpecValues((prev) => {
      const next = { ...prev };
      for (const [k, v] of seedEntries) {
        const hit = isqSpecs.find((s) => s.IM_SPEC_MASTER_DESC.toLowerCase() === k.toLowerCase());
        const key = hit ? hit.IM_SPEC_MASTER_DESC : k;
        if (v && !next[key]) next[key] = v;   // never overwrite a value already there
      }
      return next;
    });
  }, [_seed, specsLoading, isqSpecs]);

  // commitProduct (fired by the seed on mount) RESETS quantity/unit (it parses them from the product
  // NAME, which a reposted card doesn't carry). Re-apply the card's own qty/unit/delivery once the
  // product has committed — never overwriting a value the buyer has since typed. Unit rides pendingUnitRef
  // so it's matched to a real chip once the ISQ unit options load (the same path voice uses).
  const seedQtyApplied = useRef(false);
  useEffect(() => {
    if (!_seed || seedQtyApplied.current || !committed) return;
    seedQtyApplied.current = true;
    if (_seed.quantity) setQuantity((q) => q || _seed.quantity);
    if (_seed.unit) pendingUnitRef.current = _seed.unit;
    if (_seed.deliveryLocation) { setDeliveryLocation((d) => d || _seed.deliveryLocation); setSameAsLoc(false); }
    // Identity fields default to P3, "prefilled from bp/od/d if already on file" (owner-locked 2026-07-27) —
    // Business Type + GST-verified are the two identity facts already carried on buyer_facts.
    const bf = _seed.buyerFacts as { business_type?: string; gst_verified?: boolean; has_gst?: boolean } | undefined;
    if (bf?.business_type) { const hit = BUSINESS_TYPES.find((t) => t.toLowerCase() === bf.business_type!.toLowerCase()); if (hit) setBuyerType((v) => v || hit); }
    if (bf?.gst_verified || bf?.has_gst) setGstRegistered((v) => v ?? true);
  }, [_seed, committed]);

  // Feed photo/voice-extracted specs into BOTH pipelines: page-1 fill (pendingAiSpecs → ISQ fields) AND
  // the unified planner's next run (photoSpecsRef/specValues → its `filled` input, via aiEpoch bump).
  // Bumping aiEpoch re-runs the planner with the new context. The product name, once the buyer has typed
  // it, is NEVER overwritten (it's the primary signal) — a photo only ADDS specs; it names the product
  // only when the buyer left it blank.
  // The merge, extracted as a PURE function so the same logic can answer "did anything actually change?"
  // WITHOUT writing state. That question is load-bearing: the epoch bump below re-fires the planner, and an
  // unconditional bump is a non-terminating loop (see applyExtractedSpecs).
  const mergeExtracted = (prev: Record<string, string>, specs: Record<string, string>, replace: boolean) => {
    const next = { ...prev };
    const machineKeys = new Set(photoSetKeys.current);
    const seedKeys = new Set(seedSetKeys.current);
    let changed = false;
    if (replace) {
      for (const k of photoSetKeys.current) {
        const restated = Object.keys(specs).some((sk) => sk.toLowerCase() === k.toLowerCase());
        if (!restated) { if (k in next) changed = true; delete next[k]; machineKeys.delete(k); }
      }
    }
    for (const s of isqSpecs) {
      const field = s.IM_SPEC_MASTER_DESC;
      const hit = Object.keys(specs).find((k) => k.toLowerCase() === field.toLowerCase());
      if (!hit || !specs[hit]) continue;
      if (useCaseSetKeys.current.has(field)) continue; // use-case assist OUTRANKS photo/mic (owner) — don't override
      // BUYER-owned value → never clobber. A value WE wrote is not buyer-owned: a prior photo/mic extraction
      // (photoSetKeys) or a REPOST SEED (seedSetKeys) may both be superseded by a newer read of his own truth.
      // Dropping the seed from this test is the P0 fix — without it the engine's correction was refused.
      if (next[field] && !photoSetKeys.current.has(field) && !seedSetKeys.current.has(field)) continue;
      const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      const v = snapToOption(specs[hit], opts);
      if (next[field] !== v) changed = true;
      next[field] = v;
      machineKeys.add(field);
      seedKeys.delete(field);   // the stale seed value is gone — this field is engine-owned from here on
    }
    return { next, machineKeys, seedKeys, changed };
  };
  const applyExtractedSpecs = (specs: Record<string, string>, source: 'photo' | 'mic' | 'ai' = 'ai', refire = true) => {
    if (!Object.keys(specs).length) return;
    // Tag each extracted field's SOURCE for the prefill icon (photo / mic / AI). Harmless to over-tag a field that
    // does not end up applied — the icon is only read for a field that actually carries a value (see sourceMark).
    for (const k of Object.keys(specs)) specSrc.current[k] = source;
    // A LATER extraction for the SAME product REPLACES the prior photo/voice evidence (audit #3 photo-reselect):
    // without this a re-selected photo would UNION onto — and never correct — the first photo's facts, and the
    // empty-only fill below would keep the stale value. Evaluate BEFORE re-tagging photoMcatRef.
    // BUG-HUNT 2026-07-30 (HIGH): `replace` is a PHOTO/MIC re-extraction correction ONLY. It must NEVER be true for
    // source==='ai' — the LLM-1 prefill pass carries only the specs it chose to restate, so a `replace` delete would
    // silently drop photo/mic-extracted specs (e.g. Size='10 inch') that LLM 1 merely omitted. Gate it on source.
    const replace = source !== 'ai' && photoMcatRef.current === mcatId && Object.keys(photoSpecsRef.current).length > 0;
    if (mcatId) photoMcatRef.current = mcatId; // tag this evidence to the current product (P0-01 mcat-scoping)
    pendingAiSpecs.current = specs; // still seeds the [isqSpecs]-keyed effect for a specs set that arrives LATER
    // Never fold LLM prefills into the photo/mic evidence mirror — they must not masquerade as photo evidence for a
    // later `replace` decision or the planner's held-facts context.
    photoSpecsRef.current = replace ? { ...specs } : source === 'ai' ? photoSpecsRef.current : { ...photoSpecsRef.current, ...specs };
    // Flush onto the loaded ISQ fields. SNAP each value to the field's real option (audit #10 — no duplicate
    // "Other" chip). Overwrite an EMPTY field OR one a prior extraction set (photoSetKeys); NEVER overwrite a
    // value the buyer typed/picked. On replace, first drop machine-set values the new extraction no longer states.
    // EAGER pass over the ref mirror, purely to learn whether this changes anything. A setState updater runs on
    // the NEXT render, so a flag written inside it can never be read here — hence the mirror.
    const eager = mergeExtracted(specValuesRef.current, specs, replace);
    specValuesRef.current = eager.next;   // keep the mirror fresh for a second extraction landing in the same tick
    setSpecValues((prev) => {
      const r = mergeExtracted(prev, specs, replace);
      photoSetKeys.current = r.machineKeys; // idempotent assignment (safe under StrictMode double-invoke)
      seedSetKeys.current = r.seedKeys;     // same: a second invoke recomputes the identical set
      return r.changed ? r.next : prev;     // identity return → React bails out, no wasted render
    });
    // NON-TERMINATING RE-PLAN LOOP (P0, 2026-07-28). This bump used to be UNCONDITIONAL. The planner's own
    // `prefills` route back through here, and a prefill whose field matches no ISQ spec lands nowhere — so
    // `filled` stopped changing, the fire-key `mcat:name:aiEpoch:specSig` changed on aiEpoch ALONE, and the
    // planner re-fired forever with a byte-identical request (up to 200k chars of corpus, maxTokens 8000, at
    // temperature 0.2, so the model re-emitted the same prefills every time). The only terminator was an LLM
    // error. Bump ONLY when a spec field genuinely moved — no new truth, no re-plan.
    // refire=false (owner 2026-07-29, latency #1): the PLANNER'S OWN prefills route back through here; re-planning
    // on them is the loop this guard already bounds, and even a "changed" prefill from the planner's own output
    // must not re-fire it (that was one of the 4 wasted runs).
    // AND ONLY BEFORE THE PLANNER HAS FIRED (owner 2026-07-29, the "tell us more resets the page" bug): a photo/mic
    // add BEFORE the plan runs is input to it (the debounced first fire folds it in); a photo/mic add AFTER the
    // plan has run must MERGE the new specs onto page 2 WITHOUT re-firing — a re-fire flips aiSpecsLoading true,
    // which blanks page 1 to a lone loader and reads as the page resetting under him. New specs still land (they
    // merge into specValues → page 2), and the completeness fill covers any gaps; the plan just doesn't re-run.
    if (eager.changed && refire && !plannerFiredFor.current) setAiEpoch((e) => e + 1);
    // FILL EVERYTHING THE PHOTO/VOICE CAN (owner 2026-08-11). mergeExtracted above only touched the buyer ISQ specs;
    // route the rest: (#1) a value matching one of the planner's OWN spec questions (aiSpecs) fills that chip; (#2) a
    // value matching NEITHER a buyer ISQ nor a planner spec becomes an editable "Also detected" row — so nothing the
    // photo reveals is dropped. Photo/voice ONLY — an 'ai' source is LLM 1's own prefill pass, which owns these two
    // buckets already (routing its prefills here would double-write and could loop).
    if (source !== 'ai') {
      const isqLower = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
      const aiByLower = new Map(aiSpecs.map((q) => [q.fieldName.toLowerCase(), q]));
      // #1 aiSpecs → aiSpecValues (EMPTY-ONLY — never clobber a planner chip the buyer already answered).
      setAiSpecValues((prev) => {
        const nx = { ...prev }; let ch = false;
        for (const [k, val] of Object.entries(specs)) {
          const q = aiByLower.get(k.toLowerCase()); if (!q || !val || nx[q.fieldName]) continue;
          nx[q.fieldName] = snapToOption(val, q.options ?? []); specSrc.current[q.fieldName] = source; ch = true;
        }
        return ch ? nx : prev;
      });
      // #2 leftovers → "Also detected" (skip identity/qty, and any row the buyer edited/removed).
      setExtraSpecs((prev) => {
        const nx = { ...prev }; let ch = false;
        for (const [k, val] of Object.entries(specs)) {
          const kl = k.toLowerCase();
          if (!val || isqLower.has(kl) || aiByLower.has(kl) || extraEditedRef.current.has(k)) continue;
          if (KT_HARD_IDENTITY.test(k) || KT_QTY.test(k) || nx[k] === val) continue;
          nx[k] = val; specSrc.current[k] = source; ch = true;
        }
        return ch ? nx : prev;
      });
    }
  };
  const showFeedback = (msg: string, type: ToastType = 'info') => showToast(msg, type);
  // (#79: reviewRow removed with the Review/consent modal.)

  // ── Use-case assist: apply inferred specs with the OWNER priority (use-case > photo/mic > name-hint; never over a
  //    buyer edit). Confidence-gated (≥75). Reads the current specValues (a user action, so it's fresh). ──
  const applyUseCaseSpecs = (specs: Record<string, { value: string; confidence: number }>): number => {
    const next = { ...specValues };
    const uc = new Set(useCaseSetKeys.current);
    const seedKeys = new Set(seedSetKeys.current);
    let filled = 0;
    for (const s of isqSpecs) {
      const field = s.IM_SPEC_MASTER_DESC;
      const hit = Object.keys(specs).find((k) => k.toLowerCase() === field.toLowerCase());
      if (!hit) continue;
      const sv = specs[hit];
      if (!sv || !sv.value || sv.confidence < 75) continue; // confidence band (matches inferSpecsFromApplication's contract)
      // A REPOST SEED is not buyer-owned either (same P0 as mergeExtracted): the assist outranks a stale
      // requirement's value, and the ladder is buyer edit > use-case > engine/photo/mic > seed.
      const buyerOwned = !!next[field] && !photoSetKeys.current.has(field) && !useCaseSetKeys.current.has(field) && !seedSetKeys.current.has(field);
      if (buyerOwned) continue; // a value the buyer typed/picked outranks the assist
      const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      next[field] = snapToOption(sv.value, opts);
      uc.add(field); // marks it use-case-owned → a later photo/mic won't override (applyExtractedSpecs skips these)
      seedKeys.delete(field);
      specSrc.current[field] = 'ai';   // the use-case assist / completeness fill is AI
      filled++;
    }
    useCaseSetKeys.current = uc;
    seedSetKeys.current = seedKeys;
    if (filled) setSpecValues(next);
    return filled;
  };

  // ── COMPLETENESS FILL — AUTOMATIC FIRE REMOVED (owner 2026-07-30, "3 LLM calls" + "why so many calls") ──────
  // This effect used to fire a 4th LLM call (inferSpecsFromApplication) automatically on the spec page to fill any
  // still-empty ISQ spec before seller search. That is TWO plan violations — a 4th automatic LLM call, and runtime
  // AI on Page 1 (the plan is exactly 3 LLMs and "zero runtime AI on Page 1") — and it was one of the duplicate
  // calls in the 31-call session. LLM 1 (runRequirementBrain) already prefills specs from the buyer's truth (the
  // plan's mechanism), and the buyer can still fill gaps ON DEMAND via the "Fill my specs" button
  // (handleAssistSubmit), which is an explicit action, not an automatic Page-1 AI call. `applyUseCaseSpecs` above
  // is retained — the buyer button still uses it. Re-instate the automatic effect only if seller-search
  // completeness measurably suffers without it (flagged to the owner).

  // Core spec-fill from a chat/use-case transcript: notes + inferSpecsFromApplication → applyUseCaseSpecs. The CALLER
  // owns loading/close state (finalizeAssist / the pending-fill effect). Stale-drop guarded.
  const runChatSpecFill = async (application: string) => {
    if (!application.trim() || !hasFormLLM()) return;
    setRequirementNotes((prev) => (prev && prev.includes(application) ? prev : prev ? `${prev}; ${application}` : application));
    const token = ++assistRunRef.current; const gen = commitGen.current;
    try {
      const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
      const withOpts: Record<string, string[]> = {};
      for (const s of isqSpecs) withOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      const { specs } = await inferSpecsFromApplication(productName, application, specNames, withOpts, 'form', RFQ_MODEL_USECASE);
      if (token !== assistRunRef.current || gen !== commitGen.current) return;   // superseded — drop
      const filled = applyUseCaseSpecs(specs);
      if (!plannerFiredFor.current) setAiEpoch((e) => e + 1);   // fold into the first plan only (post-plan re-fire = the "page reset" bug)
      if (filled > 0) showFeedback(`Filled ${filled} detail${filled > 1 ? 's' : ''} from your chat`, 'success');
    } catch (e) { emitApiError('inferSpecsFromApplication', e, { mcatId }); }
  };
  // Mini-chat send: add the buyer's message, fetch the assistant's next reply. Context is capped to the opening greeting
  // + the last ~13 turns so a long chat (owner: "up to 100 messages") stays bounded in tokens. No spec-filling here.
  const sendAssistMessage = async (text?: string) => {
    // `text` lets the mic send a spoken turn directly (onVoice → here). typeof-guard: onClick would otherwise pass a
    // MouseEvent as `text` and .trim() would throw — so only a real string overrides the input box.
    const t = (typeof text === 'string' ? text : assistInput).trim(); if (!t || assistChatBusy) return;
    const next = [...assistMessages, { role: 'user' as const, text: t }];
    setAssistMessages(next); setAssistInput(''); setAssistChatBusy(true);
    const ctx = next.length > 14 ? [next[0], ...next.slice(-13)] : next;
    try { const reply = await assistChat(ctx, productName, extractionFields().fieldNames); setAssistMessages((m) => [...m, { role: 'assistant', text: reply }]); }
    finally { setAssistChatBusy(false); }
  };
  // Fill specs once the category SCHEMA has loaded — the landing path commits a product, then this fires when isqSpecs
  // arrive, so the chat's specs never race an empty schema (the landing-path bug).
  const pendingChatFillRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingChatFillRef.current && isqSpecs.length) { const tr = pendingChatFillRef.current; pendingChatFillRef.current = null; runChatSpecFill(tr); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isqSpecs]);
  // Keep the chat pinned to the newest message (owner 2026-08-13: "after 4-5 messages chat is not auto scrolling").
  // Scroll the THREAD container only (never scrollIntoView, which would jump the whole page). Runs on every new
  // turn, on the "…" typing bubble, and on open so the greeting/last turn is always in view.
  useEffect(() => {
    const el = assistThreadRef.current;
    if (assistOpen && el) el.scrollTop = el.scrollHeight;
  }, [assistMessages, assistChatBusy, assistOpen]);
  // "Fill my form" (also fires when he closes the chat): ONE structured pass pulls product + quantity + unit from the
  // WHOLE conversation (quantity is context-aware — "60 HP"/"14.9-28" are not order sizes); the product is committed
  // CLEANLY (which fires LLM 1/2/3 on it), and specs fill once the schema is ready — now on the spec page, or via the
  // effect above on the landing.
  const finalizeAssist = async () => {
    const userMsgs = [...assistMessages.filter((m) => m.role === 'user').map((m) => m.text), assistInput.trim()].filter(Boolean);
    if (!userMsgs.length) { setAssistOpen(false); setAssistMessages([]); return; }
    const transcript = userMsgs.join('. ');
    setAssistLoading(true);
    try {
      const ex = await extractFromChat(transcript, productNameRef.current, unitOptions);
      if (!committed && !productNameRef.current.trim() && ex.productName) {
        // ORDERING (fixed #75 review + re-verify): commitProduct RESETS quantity+unit and INTERNALLY loads unitOptions
        // before it resolves, so (a) quantity must be set AFTER the await to survive the reset, but (b) the unit stash
        // must be set BEFORE it — commitProduct never touches pendingUnitRef, so setting it first means it's already
        // there when the []→units change fires the pendingUnitRef effect INSIDE commit (whichever of GetIsq/getISQs
        // wins the race). Setting it after the await loses the unit whenever getISQs populates units first.
        if (ex.unit) pendingUnitRef.current = ex.unit;
        await commitProduct(ex.productName);       // a CLEAN product name → the normal LLM 1/2/3 pipeline fires on it
        if (ex.quantity) { setQuantity(sanitizeQty(ex.quantity)); setAbsurdAck(false); }
        pendingChatFillRef.current = transcript;   // schema loads async → the effect above fills specs when it lands
      } else {
        // Product already committed → unitOptions are current, so qty/unit stick immediately.
        if (ex.quantity) { setQuantity(sanitizeQty(ex.quantity)); setAbsurdAck(false); }
        if (ex.unit) { if (unitOptions.length) applyUnit(unitOptions, ex.unit, 3); else pendingUnitRef.current = ex.unit; }
        await runChatSpecFill(transcript);         // schema already loaded (spec page) → fill specs now
      }
      // #76: hand the WHOLE chat to LLM 1 (set AFTER the fresh-product commit that resets the bundle). This is what
      // finally routes non-schema chat specs to the brain instead of dropping them.
      sessionInputsRef.current.chat = transcript;
    } catch (e) { emitApiError('finalizeAssist', e, { mcatId }); }
    finally { setAssistLoading(false); setAssistOpen(false); setAssistInput(''); setAssistMessages([]); }
  };
  // Open the chat with a warm greeting the first time.
  useEffect(() => {
    if (assistOpen && assistMessages.length === 0) setAssistMessages([{ role: 'assistant', text: `Hi! Tell me about the ${productName || 'product'} you're looking for — what it's for, and any details like size, material, brand or how many you need. I'll fill in the form for you.` }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistOpen]);
  const onPhoto = async (file: File) => {
    if (aiBusy) return;                       // P1-105: serialize — one extraction at a time (no dueling commits)
    const myGen = commitGen.current;          // P1-104/P2-257: guard against a product switch mid-extraction
    try {
      // P3-301: normalize INSIDE the try — a >5MB / undecodable (HEIC) file rejects gracefully with a clear message.
      const { base64, mime } = await normalizeImage(file);
      // ALWAYS carry the decodable photo forward (owner): attach it the MOMENT it normalizes — BEFORE the AI call —
      // so a Gemini failure/timeout or a zero-extraction result never loses it. It shows in the thumbnail + ships to
      // sellers regardless. (Only a >5 MB / undecodable file is dropped — normalizeImage throws above, so no base64.)
      setImageBase64(base64);
      if (!hasFormLLM()) return; // no LLM key → attached, nothing to extract
      setAiBusy('Reading your photo…');
      // Schema-aware extraction (the plan's combined Call A): the image call maps values straight onto the real
      // fields — the buyer ISQ specs AND the planner's own spec questions (extractionFields) — no separate mapper.
      const { fieldNames, fieldOpts } = extractionFields();
      const r = await analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', 'form', RFQ_MODEL_IMAGE);
      // A photo auto-commits a product ONLY when the buyer has NOT already provided a name — neither committed
      // (productNameRef) NOR typed-but-uncommitted (productName). Otherwise a product photo could hijack the name
      // the buyer typed (the reported "product name I entered wasn't committed" edge); we attach + extract against
      // the buyer's own product once they commit it instead.
      const committedNew = !!(r.productName && !productNameRef.current.trim() && !productName.trim());
      if (committedNew) await commitProduct(r.productName);
      else if (myGen !== commitGen.current) return; // a DIFFERENT product was committed while extracting → drop this stale result
      // PRODUCT-FIRST IMAGE RELATION GATE (owner 2026-08-13): if the buyer NAMED the product before this photo and the
      // vision model is confident the image shows an UNRELATED product, REJECT it — drop the attached image and apply
      // no specs, so a mismatched photo (the "Photo & BuyLead Title mismatch" audit defect) never rides onto the lead.
      // Only a POSITIVE 'unrelated' verdict rejects; 'match'/'related'/'unclear' (and blurry/non-product) pass through
      // unchanged. An image-FIRST photo (committedNew) is never gated — there it IS the product (owner: "let it be").
      const productFirst = !committedNew && !!(productNameRef.current.trim() || productName.trim());
      if (productFirst && r.productMatch === 'unrelated') {
        setImageBase64('');   // revert the attach done above — a mismatched photo must not ship
        const named = productName.trim() || productNameRef.current.trim();
        emit(EV.INPUT_SOURCE_USED, { source: 'photo', success: false, rejected: 'unrelated' });
        showFeedback(`This photo looks like ${r.productName || 'a different product'}, not ${named}. Photo removed — please add a photo of ${named}.`, 'warning');
        return;
      }
      const extracted = { ...(r.specifications || {}), ...(r.additionalSpecifications || {}) };
      const gotSomething = !!(r.productName || r.quantity || Object.keys(extracted).length);
      if (r.quantity) setQuantity((q) => q || sanitizeQty(String(r.quantity)));   // #76 LLM0 rule: fill-only-if-empty + sanitize
      applyExtractedSpecs(extracted, 'photo');
      // #76: bundle what the photo REVEALED for LLM 1 (the raw image never reaches any LLM; its findings do). Set after
      // the commit above (which reset the bundle) so it survives; carries non-schema findings the brain can still use.
      const photoFindings = [r.productName, ...Object.entries(extracted).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(' · ');
      if (photoFindings) sessionInputsRef.current.photo = photoFindings;
      // IMAGE-IN-CONTEXT (owner #74): drop what the photo actually revealed INTO the chat, so the assistant can see and
      // reference it (e.g. "the 14.9-28 rear tyre in your photo") instead of being blind to the image.
      if (assistOpen) {
        const found = [r.productName, ...Object.entries(extracted).slice(0, 3).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(' · ');
        setAssistMessages((m) => [...m, { role: 'assistant', text: found ? `From your photo I can see — ${found}. Anything to add or correct?` : "Thanks for the photo — I couldn't read clear details from it, so tell me the key ones." }]);
      }
      emit(EV.INPUT_SOURCE_USED, { source: 'photo', success: gotSomething, extracted: Object.keys(extracted).length });
      if (!gotSomething) showFeedback('Photo added — couldn’t auto-read details, so pick the specs below or type them.', 'warning'); // the photo is kept regardless
    } catch (e) {
      emit(EV.INPUT_SOURCE_USED, { source: 'photo', success: false });
      emitApiError('analyzeImage', e, { mcatId }); // the ONLY AI feature — its outages (401/429/timeout) must be visible in telemetry
      // too-large / undecodable throw BEFORE the photo is attached (no base64) → the photo genuinely can't be used.
      // Any OTHER failure (Gemini/network/timeout) happens AFTER setImageBase64 above → the photo is already kept.
      const msg = e instanceof Error && e.message === 'too-large' ? 'That image is over 5 MB — please pick a smaller photo.'
        : e instanceof Error && e.message === 'undecodable' ? "Couldn't read that image format — try a JPG or PNG."
        : 'Photo added — auto-reading failed, so pick the specs below or type them.';
      showFeedback(msg, 'warning');
    } finally { setAiBusy(''); }
  };
  const onVoice = async (blob: Blob) => {
    bes('voice');
    setShowVoice(false); if (aiBusy || !hasFormLLM()) return;
    const myGen = commitGen.current;
    try {
      setAiBusy('Understanding your requirement…');
      const { base64, mime } = await fileToBase64(blob);
      const r = await voiceToSpecs(base64, mime, productName, extractionFields().fieldNames, 'form', RFQ_MODEL_MIC);
      // Assist DICTATION: when the mic was opened from the use-case popup, the spoken words go INTO the use-case box
      // (the buyer then taps "Fill my specs" → inferSpecsFromApplication). We do NOT extract specs here.
      if (voiceTargetRef.current === 'assist') {
        voiceTargetRef.current = 'form';
        const t = (r.rawTranscript || '').trim();
        // In the CHAT, a spoken turn IS a message — send it and get a reply (owner 2026-08-13: "chat is not taking mic").
        // Not the input box: the buyer had to notice the text and tap Send, which read as "the mic did nothing".
        if (t) sendAssistMessage(t);
        else showFeedback("Couldn't catch that — try again.", 'warning');
        return;
      }
      const newName = (r.productName && !productNameRef.current.trim()) ? r.productName : '';
      if (newName) await commitProduct(newName);
      else if (myGen !== commitGen.current) return; // product switched mid-extraction → drop stale result
      // #76: bundle the spoken words for LLM 1 (AFTER any commit that resets the bundle). LLM0 rule = fill-only-if-empty:
      // don't overwrite a qty the buyer already set; sanitize so a non-numeric ("approx 100") can't ship or void the absurd check.
      if (r.rawTranscript?.trim()) sessionInputsRef.current.voice = r.rawTranscript.trim();
      if (r.quantity) setQuantity((q) => q || sanitizeQty(String(r.quantity)));
      // P2-205: apply the spoken unit now if the options are loaded, else STASH it — the [unitOptions] effect applies it once they resolve.
      if (r.quantityUnit) { if (unitOptions.length) applyUnit(unitOptions, r.quantityUnit, 2); else pendingUnitRef.current = r.quantityUnit; }
      // Coerce the LLM's enum outputs to our CANONICAL lists (snap "Advance"→"Full Advance"); drop anything that
      // doesn't map to a real option so an off-canon value never ships to sellers or fails to select a chip (audit).
      if (r.deliveryTimeline) { const t = snapToOption(r.deliveryTimeline, TIMELINE); if (TIMELINE.includes(t)) setDeliveryTimeline(t); }
      if (r.paymentTerms) { const p = snapToOption(r.paymentTerms, PAYMENT_TERMS); if (PAYMENT_TERMS.includes(p)) setPaymentTerms(p); }
      // A spoken DELIVERY city sets the DELIVERY field (not the buyer's own IP/GPS-seeded location); if it differs,
      // un-link "same as my location" so both are preserved instead of collapsing origin↔destination (audit).
      if (r.deliveryLocation) { setDeliveryLocation(r.deliveryLocation); if (r.deliveryLocation.trim() && r.deliveryLocation.trim() !== userLocation.trim()) setSameAsLoc(false); }
      if (r.creditPeriod) { const c = snapToOption(r.creditPeriod, CREDIT_PERIODS); if (CREDIT_PERIODS.includes(c)) setCreditPeriod(c); }
      const specs = { ...(r.mappedSpecs || {}) }; (r.customSpecs || []).forEach((c) => { if (c.fieldName) specs[c.fieldName] = c.value; });
      applyExtractedSpecs(specs, 'mic');
      const gotSomething = !!(r.productName || r.quantity || Object.keys(specs).length);
      // NEVER DROP A SPOKEN FACT (owner backlog): if the mic caught words but nothing mapped to a structured spec,
      // keep the raw transcript in the requirement notes so it still reaches the seller instead of vanishing.
      const rawT = (r.rawTranscript || '').trim();
      if (!gotSomething && rawT) setRequirementNotes((n) => (n.trim() ? `${n.trim()} ${rawT}` : rawT));
      emit(EV.INPUT_SOURCE_USED, { source: 'mic', success: gotSomething || !!rawT });
      if (!gotSomething) showFeedback(rawT ? 'Added what you said to your requirement details.' : "Couldn't catch that — try again.", rawT ? 'info' : 'warning');
    } catch (e) {
      emit(EV.INPUT_SOURCE_USED, { source: 'mic', success: false });
      emitApiError('voiceToSpecs', e, { mcatId });
      showFeedback("Couldn't process the recording — try again.", 'warning');
    } finally { setAiBusy(''); }
  };

  const setSpecValue = (k: string, v: string) => {
    // BES: a chip tap is light; overwriting a value WE prefilled is a correction — expensive, and evidence
    // our prefill was wrong. Distinguished by whether the field currently holds a machine-set value.
    const wasOurs = photoSetKeys.current.has(k) || useCaseSetKeys.current.has(k) || !!_seed?.specValues?.[k];
    const hadValue = !!specValues[k];
    bes(!v && hadValue ? 'backspace' : wasOurs && hadValue && specValues[k] !== v ? 'correction'
        : (isqSpecs.find((x) => x.IM_SPEC_MASTER_DESC === k)?.IM_SPEC_OPTIONS_DESC ? 'chip' : 'text'), `spec:${k}`);
    // THE ONE buyer-driven writer. Dropping the field from all three machine-provenance sets is what makes it
    // buyer-owned: no later photo/voice extraction, use-case assist OR engine prefill may overwrite it again
    // (audit #3 + use-case priority + the 2026-07-28 repost-seed fix).
    photoSetKeys.current.delete(k); useCaseSetKeys.current.delete(k); seedSetKeys.current.delete(k); setSpecValues((p) => ({ ...p, [k]: v })); };
  // "Also detected" edits — mark the key as buyer-touched so a planner re-run never clobbers it.
  const setExtraValue = (k: string, v: string) => { extraEditedRef.current.add(k.toLowerCase()); setExtraSpecs((p) => ({ ...p, [k]: v })); };
  const removeExtra = (k: string) => { extraEditedRef.current.add(k.toLowerCase()); setExtraSpecs((p) => { const n = { ...p }; delete n[k]; return n; }); };

  // V3 rule (RFQModalV3.tsx:1162): anything that isn't an individual/personal/end-user is a BUSINESS role —
  // and a business buyer is asked for GST (an individual/consumer is not). "Individual Buyer" → false.
  // #③ BUSINESS-vs-INDIVIDUAL now also comes from the PERSONA stage (LLM 3), not only the seed's `buyerType` —
  // the last-page GST ask (owner: "ask GST if not individual; any B2B persona has GST yes/no; skip if in truth")
  // must fire for a B2B buyer even when his type isn't already on file. Signals, in order: an explicit business
  // type he picked in Persona (`psAnswers`), or LLM 1's `persona_read` describing a business. All value-classifier
  // regexes are word-bounded. GST itself is asked ONLY on the last page (removed from the LLM 3 themes).
  const PERSONA_INDIVIDUAL_RE = /\b(individual|personal|end[\s-]?user|consumer|home|household|hobby)\b/i;
  const PERSONA_BUSINESS_RE = /\b(manufacturer|manufacturing|wholesaler|wholesale|distributor|retailer|trader|trading|exporter|importer|b2b|business|company|enterprise|firm|industry|industrial|dealer|supplier|reseller|corporate|institution)\b/i;
  const personaVals = Object.values(psAnswers).filter(Boolean) as string[];
  const personaSaysIndividual = personaVals.some((v) => PERSONA_INDIVIDUAL_RE.test(v));
  const personaSaysBusiness = personaVals.some((v) => PERSONA_BUSINESS_RE.test(v) && !PERSONA_INDIVIDUAL_RE.test(v))
    || (!!rbBrain?.persona_read && PERSONA_BUSINESS_RE.test(rbBrain.persona_read) && !PERSONA_INDIVIDUAL_RE.test(rbBrain.persona_read));
  const isBusinessRole = (!!buyerType && !PERSONA_INDIVIDUAL_RE.test(buyerType)) || (personaSaysBusiness && !personaSaysIndividual);
  // ── P3 identity visibility, derived PER FIELD (owner-locked 2026-07-27; corrected 2026-07-28) ──────────────
  // The section-level hide MUST be derived from the per-field flags below, never hand-written — the first cut of
  // this hid the whole "About You" card while Industry was still blank-and-unhandled. Two distinct concepts:
  //   • ASKED elsewhere  → hide the question (genuine double-ask prevention: the planner promoted it to P2).
  //   • KNOWN from file  → do NOT hide. Render it back as a confirm/badge WITH provenance. Hiding a prefill means
  //     the buyer never sees what we assumed, can't correct it, and TUS's CONFIRMED stage can never fire on it.
  const bfIdent = _seed?.buyerFacts as { gst_verified?: boolean; has_gst?: boolean; business_type?: string } | undefined;
  const gstOnFile = !!bfIdent?.gst_verified || !!bfIdent?.has_gst;
  // GST placement (owner 2026-07-31): a BUSINESS (non-individual) persona is asked GST on the PERSONA page (P3),
  // right where the persona is established — NOT on the last page. The last page only ECHOES the answer (or shows
  // the verified badge if it's on file). Individuals are never asked. gstOnFile → shown as a badge, never asked.
  const showGstOnPersona = isBusinessRole && !gstOnFile;                  // the P3 GST question (yes/no + number)
  const showGstBadge = isBusinessRole && gstOnFile;                       // known → shown back as a verified badge (last page)
  const showGstAnswered = isBusinessRole && !gstOnFile && gstRegistered !== null; // answered on P3 → echo it on the last page
  // Business type + Industry are per-ORDER facts (a registered Manufacturer may buy as a Wholesaler on this order,
  // and Industry is on file nowhere) — so by DEFAULT they always render, prefilled+provenanced where we know them.
  // ITEM 3 (2026-07-28) makes that default overridable by the planner, and only through the allow-list: it may
  // move either of them onto the spec page, or drop one when we already hold the answer (and the drop path seeds
  // the value into state above, so a dropped field still ships — it is one fewer question, never one less fact).
  // Deterministic-merge dedup: if the Persona stage (LLM 3) produced its own questions, its fields (designation /
  // industry / business-type) are asked THERE — drop them from the last page so nothing is asked twice. GST stays,
  // it's a distinct deterministic flow the Persona stage does not own.
  // RENDER-TIME cross-page dedup net (2026-08-12 audit): the persona planner fires in PARALLEL with commercial and can
  // RESOLVE FIRST (this run: persona 18887ms vs commercial 18966ms), so its resolve-time dedup against commercialPlanRef
  // can miss a duplicate. Re-dedup here at paint against the commercial questions' CONCEPTS (canonConcept) — which now
  // maps business_setup_type ≡ setup_stage — so the persona repeat is dropped regardless of resolve order. Deduped ONLY
  // against COMMERCIAL (never the full session) so a persona question the buyer already ANSWERED is never self-dropped.
  const personaRender = useMemo(() => {
    if (!personaPlan) return personaPlan;
    const cxConcepts = new Set((commercialPlan?.questions ?? []).flatMap((q) => [canonConcept(q.field), q.label ? canonConcept(q.label) : '']).filter(Boolean));
    if (!cxConcepts.size) return personaPlan;
    const questions = personaPlan.questions.filter((q) => !cxConcepts.has(canonConcept(q.field)) && !(q.label && cxConcepts.has(canonConcept(q.label))));
    return questions.length === personaPlan.questions.length ? personaPlan : { ...personaPlan, questions };
  }, [personaPlan, commercialPlan]);
  const personaStageActive = (personaRender?.questions?.length ?? 0) > 0;
  const showBuyerTypeField = placement.business_type === 'last_page' && !personaStageActive;
  const showIndustryField = placement.industry === 'last_page' && !personaStageActive;
  // ── HIS PERSONA, on the last page (owner-reported 2026-07-28) ────────────────────────────────────────────
  // The engine computes it (formAdapter `buyerPersona` / `assessBulkB2B.persona_on_file`), the planner can now
  // ground it (`person.persona`), it reached the form — and it rendered NOWHERE, while the literal
  // 'Manufacturer' sat in the Business-type field, which is why the owner read it as "the persona is missing".
  // Shown PREFILLED and EDITABLE with its provenance, which is the owner's standing rule for a known value: a
  // hidden prefill means he never sees what we assumed, cannot correct it, and TUS can never reach CONFIRMED.
  // Keyed on `personaSource` — set only when we filled the value from truth — so it neither appears out of
  // nowhere nor vanishes mid-edit when he clears the box. Suppressed while the ranked persona QUESTION is on
  // screen: that gate (assessBulkB2B) decides the ASK, and the two must never both render.
  const showPersonaField = !personaAsk && !!personaSource && !personaStageActive;
  // COMPANY — an identity passthrough from the profile (bp.contacts_company). Shown once we hold one, editable, like
  // designation/industry (owner 2026-08-11: "we missed company name — prefill it"). Never asked when absent.
  const showCompanyField = !!companyName.trim();
  // The card renders iff at least ONE child does. Today that's always — the honest outcome for this buyer, not a bug.
  // The machinery is real: flip a child flag off and the header disappears with it instead of stranding an empty box.
  const aboutYouHasContent = showPersonaField || showCompanyField || showBuyerTypeField || showIndustryField || showGstBadge || showGstAnswered;

  const scoreDetails = useMemo(() => {
    // P1-109: score the SAME arrays the pages render (visible), not the raw arrays — else the dial can stick
    // <100 with no on-screen field to fill. visSpecs = page-1 minus redundant-and-unanswered; visAi = page-2
    // minus any promoted to a page-1 field. P3-316: answers de-matched by a re-plan simply aren't counted.
    const isqNames = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
    const visAi = aiSpecs.filter((q) => !isqNames.has(q.fieldName.toLowerCase()));
    const visSpecs = isqSpecs; // all buyer specs count toward the score (no redundant-hide)
    const aiTotal = visAi.length;
    const aiAnswered = visAi.filter((q) => (aiSpecValues[q.fieldName] || '').trim()).length;
    return calcScore(
      { productName, quantity, dynamicSpecs: specValues, deliveryLocation, deliveryTimeline, paymentTerms, buyerType, industry, gstRegistered, gstNumber } as Partial<RFQFormData>,
      // quantity stays scored ONLY when the API returned units (unitOptions>0) — unit itself is never scored;
      // frequencyApplicable:false — cadence is now an LLM-driven AI-spec, not a static field.
      visSpecs, !!imageBase64, { quantityApplicable: unitOptions.length > 0, profileApplicable: true, frequencyApplicable: false, gstApplicable: isBusinessRole, aiSpecTotal: aiTotal, aiSpecAnswered: aiAnswered },
    );
  }, [productName, quantity, specValues, deliveryLocation, deliveryTimeline, paymentTerms, buyerType, industry, gstRegistered, gstNumber, isBusinessRole, isqSpecs, imageBase64, unitOptions.length, aiSpecs, aiSpecValues]);

  // The next unfilled, applicable score item — powers the "Fill next" nudge. It must MOVE FORWARD with the buyer:
  // once they've passed a stage, don't keep nagging about a skipped/optional item behind them (e.g. "Product image"
  // while they're on the Details page). So we only surface an unfilled item AT or AHEAD of the current stage; if
  // nothing ahead is unfilled, the nudge simply hides (no stale back-pointer). (V3/V4 behave the same way.)
  // A Specs check maps to the single spec page. (This used to read `prefillStage`, which existed only to point at
  // the second spec page when the 'specs2' split was active; that stage is gone, so 'specs' is the whole story.)
  const checkStageIdx = (c: ScoreCheck): number =>
    stageNodeIdx(c.group === 'Product' ? 'landing' : c.group === 'Specs' ? 'specs' : lastStage);
  const nextCheck = scoreDetails.checks.find((c) => c.applicable && !c.done && checkStageIdx(c) >= stageNodeIdx(stage));

  // R3 steal — score "+N" delta flash: when the total rises, float the gained points near the score for ~1s.
  useEffect(() => {
    const t = scoreDetails.total;
    if (t > prevScoreRef.current) { setScoreDelta(t - prevScoreRef.current); const id = setTimeout(() => setScoreDelta(0), 900); prevScoreRef.current = t; return () => clearTimeout(id); }
    prevScoreRef.current = t;
  }, [scoreDetails.total]);

  // All buyer-provided spec answers (page-1 ISQ + page-2 AI), non-empty, de-duplicated by field name.
  // P1-131 / P2-223: only answers to CURRENTLY-VISIBLE page-2 questions are included — an answer to a question a
  // re-plan removed, or one a late getISQs promoted to a page-1 field, is NOT shipped to sellers (it's invisible
  // to the buyer, so it must not travel). Page-1 answers always count.
  const allSpecEntries = useMemo(() => {
    const isqNames = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
    const visibleAiNames = new Set(aiSpecs.filter((q) => !isqNames.has(q.fieldName.toLowerCase())).map((q) => q.fieldName));
    const merged: Record<string, string> = { ...specValues };
    for (const [k, v] of Object.entries(aiSpecValues)) if (visibleAiNames.has(k)) merged[k] = v;
    for (const [k, v] of Object.entries(extraSpecs)) if (!(k in merged)) merged[k] = v; // "Also detected" facts ship too (lossless)
    // B1 — answer→seller: the unified planner's OPENING + GAP answers are STATED buyer facts, so they MUST reach the
    // submitted lead (not just the screen). Keyed by the question; deduped against specs already carrying the concept.
    if (baq?.opening?.q && baqAnswers.opening?.trim()) { const k = baq.opening.q.replace(/\?+\s*$/, '').trim(); if (k && !(k in merged)) merged[k] = baqAnswers.opening.trim(); }
    // INERT since 2026-07-28 and deliberately kept: `baq.gaps` is emptied when the plan lands, because every
    // ranked gap now renders from `aiSpecs` (whose answers ship via visibleAiNames above), so no answer is lost
    // here. Left in place so that if anyone ever re-populates baq.gaps the answers still reach the lead rather
    // than being silently dropped — the failure this whole block exists to prevent.
    (baq?.gaps || []).forEach((g, i) => { const a = baqAnswers[`gap${i}`]; const k = (g.q || '').replace(/\?+\s*$/, '').trim(); if (k && a && a.trim() && !(k in merged)) merged[k] = a.trim(); });
    // ITEM 2 — a PRE-ANSWERED question ships exactly like an answered one, because that is what it is: he saw
    // the question, saw our answer and its source, and left it standing or changed it. What he CLEARED ships
    // nothing — an answer he rejected is not truth, and the firewall does not care that we were the ones who
    // filled it in. (An INFERRED value he never confirmed must never reach a seller as his own words.)
    for (const p of preAnswered) {
      const v = (preAnswerValues[p.q] ?? '').trim();
      const k = p.q.replace(/\?+\s*$/, '').trim();
      if (k && v && !(k in merged)) merged[k] = v;
    }
    // ITEM 1 — the persona ANSWER (his tap), never the persona we inferred. The inferred one lives in
    // understanding{} and stops there; it is our reading of his behaviour, not something he told anyone.
    if (personaAsk?.q && personaAnswer.trim()) { const k = personaAsk.q.replace(/\?+\s*$/, '').trim(); if (k && !(k in merged)) merged[k] = personaAnswer.trim(); }
    // A RESOLVED CONFLICT is the strongest fact on the page — the buyer just chose between two of his own
    // signals, so it OVERWRITES whatever a prefill put in that field. An unresolved conflict ships nothing:
    // per the firewall, a value the buyer never settled must not reach a seller under his name.
    for (const d of engineConflicts) { const v = conflictPicks[d.id]; if (v && v.trim()) merged[d.field] = v.trim(); }
    // An ACCEPTED suggestion is a buyer tap, so it ships — but only when he actually tapped it (INFERRED tier
    // is never shipped unaccepted). Never shadows a value already present.
    for (const d of engineSuggests) { const v = suggestPicks[d.id]; if (v && v.trim() && !(d.field in merged)) merged[d.field] = v.trim(); }
    // LAST GATE before a seller sees it. A product-chooser row is suppressed on screen, so shipping one would
    // send a fact the buyer was never shown — and it restates the product name that already heads the lead.
    return Object.entries(merged).filter(([k, v]) => v && v.trim() && !isProductInterestField(k) && !isNonSpecNote(k));
  }, [specValues, aiSpecValues, aiSpecs, isqSpecs, extraSpecs, baq, baqAnswers, engineConflicts, conflictPicks, engineSuggests, suggestPicks,
    preAnswered, preAnswerValues, personaAsk, personaAnswer]);

  // (requirementSummary removed 2026-07-28 — it fed the closing page's one-line "Your requirement" banner, which
  //  truncated to 5 specs. CuratedSellerBoard now renders the product and the buyer's filled specs itself, from
  //  `filledSpecs`, so a second summarised copy of the same facts would only be a place for them to disagree.)

  // FULL requirement text — LOSSLESS: every fact the buyer gave (specs + logistics/payment + notes +
  // firm/GST + location) so nothing collected is dropped from the enquiry / WhatsApp hand-off.
  const buildRequirementText = () => {
    const payment = paymentTerms
      ? [paymentTerms, paymentTerms === 'Credit (Post-Delivery)' && creditPeriod, paymentMode && paymentTerms !== 'Credit (Post-Delivery)' && paymentTerms !== 'Loan/Finance' && paymentMode].filter(Boolean).join(' · ')
      : '';
    const base = [
      `Requirement: ${productName}`,
      qtyIsMeaningful(quantity) && `Quantity: ${[quantity, unit].filter(Boolean).join(' ')}`,
      ...allSpecEntries.map(([k, v]) => `${k}: ${v}`),
      deliveryLocation && `Deliver to: ${deliveryLocation}`,
      userLocation.trim() && userLocation.trim().toLowerCase() !== deliveryLocation.trim().toLowerCase() && `Buyer location: ${userLocation.trim()}`,
      deliveryTimeline && `Delivery timeline: ${deliveryTimeline}`,
      payment && `Payment: ${payment}`,
      // Business IDENTITY (type / company / industry / persona) is suppressed for a retail-lite buyer (#75 re-verify):
      // these are profile-INFERRED B2B fields the retail flow hides (moreBody is `!isRetailLite`), so — like the gated
      // commercial/persona planner answers — they must not ride into the seller-facing text for a personal/one-off buy.
      !isRetailLite && buyerType && `Business type: ${buyerType}`,
      !isRetailLite && companyName.trim() && `Company: ${companyName.trim()}`,
      !isRetailLite && industry.trim() && `Industry: ${industry.trim()}`,
      // His persona ships only when it rendered as a field he could see and correct (showPersonaField). An
      // INFERRED persona he was never shown must never reach a seller as his own description of himself —
      // that is the same rule the pre-answer chips run on: shown + provenanced + correctable, then it travels.
      !isRetailLite && showPersonaField && personaValue.trim() && `Your business: ${personaValue.trim()}`,
      // ITEM 3: cadence now has a real field of its own WHEN the planner placed one. When it did not, cadence
      // still arrives as an ordinary ranked gap and is already inside allSpecEntries above — so it ships either
      // way and never twice (an answered gap and an empty field cannot both be non-empty for the same concept).
      purchaseFrequency && `Purchase frequency: ${purchaseFrequency}`,
      // GST only for a business role (never for an individual buyer), and only once answered.
      isBusinessRole && gstRegistered === true && `GST: ${isValidGSTIN(gstNumber) ? gstNumber.trim().toUpperCase() : 'Registered'}`, // ship the number ONLY if it's a valid GSTIN, else just "Registered" (never garbage)
      isBusinessRole && gstRegistered === false && `GST: Not registered`,
      requirementNotes.trim() && `Notes: ${requirementNotes.trim()}`,
    ].filter(Boolean) as string[];
    // LOSSLESS (bug-hunt 2026-07-31): the LLM-2 (commercial) and LLM-3 (persona) ANSWERS live only in cxAnswers /
    // psAnswers and were NEVER shipped — the seller lost every commercial/persona answer the buyer gave. Append them,
    // resolving each machine field key to its human question label, deduped against concepts already emitted above.
    const labelOf = (field: string, plan: PlannerEnvelope | null) => plan?.questions.find((q) => q.field === field)?.label || field;
    const seen = new Set(base.map((l) => l.split(':')[0].trim().toLowerCase()));
    const extra: string[] = [];
    // Mirror the lead-payload gating (#75): a retail-lite buyer never saw the Commercial/Persona pages, so their
    // auto-inferred answers must not ride into the seller-facing text either. Only append pages that were shown.
    const cxToShip = includeCommercial ? cxAnswers : {}; const psToShip = includePersona ? psAnswers : {};
    for (const [f, v] of Object.entries({ ...cxToShip, ...psToShip })) {
      if (!v || !v.trim()) continue;
      const label = labelOf(f, cxAnswers[f] !== undefined ? commercialPlan : personaPlan);
      const key = label.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); extra.push(`${label}: ${v.trim()}`);
    }
    return [...base, ...extra].join('\n');
  };
  // (waDeeplink removed 2026-07-28 with the per-card enquiry drawer it opened. buildRequirementText survives — it
  //  is the lossless requirement text dispatchBuyLead hands to the host.)

  // ── THE QUANTITY RULE, decided ON the landing (owner-locked 2026-07-28) ───────────────────────
  // Whether quantity is even a CONCEPT for a product comes from the mcat's ISQ schema, so it cannot be known
  // until the mcat resolves. `hasUnits` is that answer and `unitsResolved` is "the answer has arrived":
  //   defined + already filled → stay here, shown prefilled and editable   (qtyUnitBlock, seeded value)
  //   defined + not filled     → stay here and ask for it                 (qtyUnitBlock, autofocused)
  //   NOT defined              → skip the ask entirely, straight to the spec page (the effect below) — and
  //                              fetch NO product images at all, since nobody would ever see them.
  const hasUnits = unitOptions.length > 0;
  // Quantity + Unit are OPTIONAL now (owner) — a committed, resolved product is enough to continue.
  const canContinueProduct = !!productName.trim() && committed && unitsResolved;
  // ── Retail-intent gate — the SINGLE funnel for the landing→specs advance (task #75). Source-BLIND: mic, camera, chat
  // and manual entry all write `quantity` through setQuantity, so hooking the ADVANCE (Enter + Continue) — not any one
  // input — catches every path exactly once, with no per-keystroke firing. For a qty-collecting category with a small
  // discrete order it asks the LLM whether this is a personal/retail buy; if so it opens the confirm and holds the
  // advance, otherwise it advances straight through. Fire-once (retailCheckedFor) + generation-guarded (commitGen) +
  // !aiBusy so it never double-fires, never races a product switch, and never collides with an in-flight photo/mic/chat read.
  const tryAdvanceToSpecs = async () => {
    if (retailChecking) return;              // a check is already in flight (e.g. Enter during the Continue spinner) → ignore
    const q = quantity.trim();
    const key = `${mcatId}:${q}:${unit}`;
    // Advance straight through (NO LLM) when: unit-less category (the "qty not coming → default B2B" set), qty not
    // meaningful, an AI read is in flight, no LLM key, the buyer already answered this session, or we already asked
    // for this exact mcat+qty+unit (so an Esc-cancel + re-Continue proceeds as business-as-usual, never re-prompts).
    if (!hasUnits || !qtyIsMeaningful(q) || !!aiBusy || !hasFormLLM() || retailChoice || retailCheckedFor.current === key) { setStage('specs'); return; }
    // Free deterministic pre-filter: only a SMALL DISCRETE order is a retail candidate — bulk counts / bulk units skip the LLM.
    if (!isRetailCandidate(q, unit)) { setStage('specs'); return; }
    const myGen = commitGen.current;
    retailCheckedFor.current = key;          // mark asked up-front so a double-tap can't fire two calls
    setRetailChecking(true);
    let isRetail = false;
    try {
      // categoryNameRef.current (reset per-commit at 1350, set with catName at 1419) — NOT the catName state, which lags
      // a product switch until McatDtl resolves and would feed the check the PREVIOUS product's category.
      const r = await checkRetailIntent(productName, q, unit, categoryNameRef.current, 'form', RFQ_MODEL_MIC);
      if (myGen !== commitGen.current) return;   // product switched mid-check → drop, don't advance; commitProduct already reset retailChecking (never clobber a newer check's live spinner)
      isRetail = r.retail;
    } catch (e) { emitApiError('checkRetailIntent', e, { mcatId }); }
    setRetailChecking(false);
    if (isRetail) setShowRetailGate(true);   // ask the buyer; the modal buttons perform the advance
    else setStage('specs');                   // not retail (or the call failed) → business as usual
  };
  // Case 3: the category offers NO quantity/unit (and none was captured from the name / photo / voice) — so
  // there is nothing left on this page to answer. Skip straight to the spec page. Once per commit.
  useEffect(() => {
    if (committed && unitsResolved && !hasUnits && !quantity.trim() && stage === 'landing' && autoAdvancedFor.current !== mcatId) {
      autoAdvancedFor.current = mcatId; // once per product — tapping Back to this product won't re-bounce forward
      setStage('specs');
    }
  }, [committed, unitsResolved, hasUnits, quantity, stage, mcatId]);

  // (The qty-redirect that used to bounce 'specs'→'landing' for a blank quantity was REMOVED 2026-07-30: the
  // vFinal plan is explicit that "Quantity is captured in parallel and gates NOTHING" (#12). Quantity stays a
  // non-blocking field — the buyer may proceed without it; a real qty still arrives from truth/LLM 1/the buyer.
  // The case-3 auto-advance above (unit-less mcats) is not a gate — it moves the buyer FORWARD, never back.)

  // ── THE LANDING'S IMAGE PANEL — fetched THE MOMENT the product commits ──────────────────────────────────
  // Owner 2026-07-28, REVERSING the earlier `hasUnits` gate: "refer the landing of Simple form the left section
  // ... we had images on left from product search". SimpleRFQForm fires fetchProductImages inside commitProduct,
  // ungated, so the pictures appear as soon as the mcat resolves — the brain form was waiting for the ISQ schema
  // (unitsResolved && hasUnits), which left the popup showing a blank white box while GetIsq was still in flight,
  // exactly the regression he flagged. Now keyed on mcatId alone: same trigger as Simple. The only cost is one
  // cheap IMSearchAPI (non-LLM) call for a product that then skips the landing on the qty rule — harmless, and
  // the owner has explicitly ranked "images like Simple" above avoiding it.
  useEffect(() => {
    if (!mcatId) return;
    if (imgFetchedFor.current === mcatId) return;
    imgFetchedFor.current = mcatId;
    const gen = commitGen.current;                       // a superseded product's late response is a no-op
    const name = productNameRef.current || productName;
    setImgPanelState('loading');
    fetchProductImages(name, mcatId)
      .then((imgs) => {
        if (gen !== commitGen.current) return;
        setImgPanelState('done');
        if (!imgs.length) return;
        setProductImages(imgs); setProductImageUrl((prev) => prev || imgs[0]);   // backfills the hero if McatDtl had none
      })
      .catch((e) => { if (gen === commitGen.current) setImgPanelState('done'); emitApiError('fetchProductImages', e, { mcatId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId]);

  // Owner (2026-07-23, reversed the earlier auto-skip): on an AI-specs FAILURE we no longer auto-advance past
  // the page. The buyer stays and sees a RETRY (re-fires the unified planner) plus a quiet "continue anyway" —
  // a transient gateway hiccup shouldn't silently rob the buyer of the smart questions. Loader shows while in flight.
  const retryAiSpecs = () => {
    plannerFiredFor.current = '';       // re-arm the once-per-(mcat:name:epoch:specSig) guard
    plannerRuns.current = 0;            // an explicit buyer retry is never a runaway — clear the automatic-run ceiling
    setAiSpecsError(false);
    setAiSpecsLoading(true);            // instant loader feedback
    setAiEpoch((e) => e + 1);           // new fireKey → the planner effect re-fires
  };

  // ── BuyLead (BL) eligibility (owner) — a BL is generated when the buyer gave a real signal: a QUANTITY, OR at
  // least one PAGE spec (page-1 ISQ + page-2 AI). The last-page profile/logistics fields are NOT specs — and
  // allSpecEntries is exactly {specValues, aiSpecValues}, so it already excludes them. ──
  // BL-eligible = the buyer gave a real signal. Besides qty / a filled spec, ACCEPT free-text notes, AND accept a
  // committed product in a category that genuinely has nothing to fill (no units + no page-1 specs) — e.g. a
  // service / thin-schema requirement. Without this last clause those buyers hit a hard dead-end (can't submit a
  // fully-typed requirement — the P1 the audit flagged). Last-page profile/logistics fields are NOT specs.
  const blEligible = qtyIsMeaningful(quantity) || allSpecEntries.length > 0 || requirementNotes.trim() !== ''
    || (committed && unitsResolved && !hasUnits && isqSpecs.length === 0);
  useEffect(() => {
    if (blEligible && !blToastShownRef.current) {
      blToastShownRef.current = true;
      emit(EV.BL_ELIGIBLE, { surface: surfaceName });
      // Toast removed (owner 2026-08-12): the "requirement is ready" confirmation was noise mid-flow; BL_ELIGIBLE still fires for analytics.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blEligible]);

  // ⚑ DEV-TODO (BuyLead generation API — owner provides it later): POST this RFQSubmission to the real BL endpoint
  //   and gate the results/"sent" UI on its resolution. Include the image, all specs, qty, contact + the lossless
  //   text below. Today it's a STUB: emit the funnel conversion + hand the requirement to the host via onSubmit.
  const dispatchBuyLead = (contactOverride?: { name?: string; mobile?: string }) => {
    const contact = { name: contactOverride?.name || contactName, mobile: contactOverride?.mobile || contactMobile, email: contactEmail };
    const nonEmpty = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => (v || '').trim()));
    const req: RFQSubmission = {
      productName, mcatId, text: buildRequirementText(), quantity, unit,
      specs: Object.fromEntries(allSpecEntries),
      // Ship Commercial/Persona ONLY for the pages the buyer actually saw. LLM 2/3 fire at product commit — BEFORE the
      // retail gate is answered — and seed cxAnswers/psAnswers; a retail-lite buyer never saw those pages, so shipping
      // their auto-inferred B2B answers would make a "buyer-specs-only" lead carry commercial/persona attributes he
      // never confirmed (#75 review). Gate on the SAME predicates that prune the pages from the stepper.
      commercial: includeCommercial ? nonEmpty(cxAnswers) : {}, persona: includePersona ? nonEmpty(psAnswers) : {},
      contact, cityId: cityId || undefined, imageBase64: imageBase64 || undefined,
      // #6 verification — kept SEPARATE from the seller-facing text; ⚑ owner: do NOT include in the actual BL POST until DPDP-reviewed.
      verification: (() => { const v = nonEmpty({ udyam: verifyUdyam.trim(), pan: verifyPan.trim(), aadhaar: verifyAadhaar.trim() }); return Object.keys(v).length ? v : undefined; })(),
      brain: rbBrain ?? undefined,   // §5 hidden briefing trace for downstream matching
    };
    // audit #13: block only a TRUE duplicate (double-tap = identical content). If the buyer edited from the
    // results screen, the content signature differs → re-dispatch as an UPDATE so the host gets the edited data
    // (previously dispatchedRef swallowed it and the host kept the pre-edit requirement).
    const sig = JSON.stringify({ t: req.text, s: req.specs, cx: req.commercial, ps: req.persona, q: req.quantity, u: req.unit, m: contact.mobile });
    if (dispatchedRef.current && sig === lastDispatchSigRef.current) return;
    const isUpdate = dispatchedRef.current;
    dispatchedRef.current = true;
    lastDispatchSigRef.current = sig;
    emit(EV.REQUIREMENT_SUBMITTED, { form: 'simple', surface: surfaceName, mcatId, specCount: allSpecEntries.length, hasQty: qtyIsMeaningful(quantity), usedImage: !!imageBase64, categoryMode, loggedIn: isLoggedIn, update: isUpdate });
    onSubmit?.(req);
  };

  // BACK / NEXT both walk the SAME `stepper` array the numbers are rendered from, so a 2-node and a 3-node
  // flow need no separate cases and no hardcoded neighbour can go stale. Off-stepper stages keep their own
  // rules: the landing closes the form, the closing page steps back to the last page.
  const goBack = () => {
    if (stage === 'landing') return onClose();
    if (stage === 'results') return setStage(lastStage);   // #79: back from results → the last numbered page (persona/specs), not the deleted 'more'
    const i = stepper.findIndex((n) => n.stage === stage);
    setStage(i > 0 ? stepper[i - 1].stage : 'landing');
  };
  const submit = () => {
    besSubmitted();   // BES: stop the clock at send
    // P1-101: never submit an empty RFQ (also closes the score-jump-to-'more'-with-no-product hole).
    if (!blEligible) { showFeedback('Add a quantity or pick at least one spec to get quotes.', 'warning'); return; }
    // Name backstop (2026-08-13): the upfront gate normally makes this unreachable, but never ship a BuyLead with an
    // invalid/absent buyer name (the "BL Approved with Invalid Buyer Name" audit defect) — re-open the gate instead.
    if (contactName.trim().length < 3) { resubmitAfterGate.current = true; setGateCityChosen(false); setGateAsk({ name: true, city: !userLocation.trim(), cityConflict: false }); setShowIdentityGate(true); showFeedback('Please add your name so suppliers know who to quote to.', 'warning'); return; }
    if (otpVerified.current) { dispatchBuyLead(); setStage('results'); return; }
    setShowOTP(true);
  };
  // Forward one node; from the LAST node "next" is the submit. Used by both the desktop footer and the mobile
  // header CTA so the two can never advance differently.
  const goNext = () => {
    // NO planner re-fire on Next (owner 2026-08-12): LLM 2 + LLM 3 + LLM 4 all fired ONCE, in parallel, at product
    // commit. Advancing a page must never trigger an LLM call — that on-Next re-fire was the "questions jumping /
    // triggered after prev-page Next" the owner saw. Next is pure navigation now.
    const i = stepper.findIndex((n) => n.stage === stage);
    const isLast = !(i >= 0 && i + 1 < stepper.length);
    // #76: hold an INTERMEDIATE page whose questions are still loading (skipping would drop them). #79 fix: the
    // LAST-step submit is NEVER held — persona questions are optional and the desktop Get-Quotes already submits
    // immediately, so mobile must match (this was a mobile-only forced wait on the persona planner, review MEDIUM).
    if (nextBlocked && !isLast) return;
    if (!isLast) { setStage(stepper[i + 1].stage); return; }
    submit();
  };
  // Clickable top stepper: jump only to a VISITED node (index ≤ current) — never skip ahead.
  const goToNode = (target: Stage) => { if (stageNodeIdx(target) <= stageNodeIdx(stage)) setStage(target); };
  // Score-panel deep-link: map a score check to the stage that owns it, so tapping a missing item jumps
  // straight there (forward OR back — it's a shortcut). Product name/image/qty→product; Specifications (buyer
  // specs AND smart questions now share one page)→specs; everything in Details (location/timeline/payment/
  // buyer/profile/GST)→more.
  const checkStage = (c: ScoreCheck): Stage => (c.group === 'Product' ? 'landing' : c.group === 'Specs' ? 'specs' : lastStage);
  // Stable slug for a check (drops the dynamic "(n/m)" suffix) → matches a field's data-flash attribute.
  const slugCheck = (c: ScoreCheck) => c.label.split('(')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  // Flash ring applied to the target field while flashKey matches (cleared after 1.6s).
  const flashCls = (key: string) => (flashKey === key ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-white rounded-lg transition-shadow' : '');
  const jumpToCheck = (c: ScoreCheck) => {
    if (stage === 'results') return; // P2-256: the results stage is terminal — no jumping back into the flow
    setScoreOpen(false); setLocationEditing(false);
    setStage(checkStage(c));
    const key = slugCheck(c);
    // #(owner fold): Buyer type / Profile detail / GST / Your-business now live INSIDE the collapsed Contact/About-you
    // card — open it first so the scroll+flash below can reach the field (a collapsed section renders no data-flash target).
    if (key === 'buyer-type' || key === 'profile-detail' || key === 'gst' || key === 'buyer-persona') setContactOpen(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    // Let the target stage render, then scroll the field into view + flash it. If a field isn't tagged (data-flash),
    // the stage switch alone still lands the buyer on the right page (graceful fallback).
    setTimeout(() => {
      const el = document.querySelector(`[data-flash="${key}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashKey(key);
      flashTimerRef.current = setTimeout(() => setFlashKey(null), 1600);
    }, 90);
  };
  // R1 steal — exit-intent salvage: the FIRST close attempt from a FLOW page jumps to the last page + opens
  // contact + nudges (don't lose the RFQ). A second attempt (or from product/results) closes for real.
  const handleExit = () => {
    // EXPLICIT DISCARD (owner 2026-08-13, 2b): once the buyer has entered real content — a meaningful quantity OR at
    // least one spec — and hasn't converted, a close asks him to confirm the discard instead of silently dropping the
    // requirement. Nothing entered / already-submitted / on the landing → close straight away (nothing to lose). This
    // replaces the old one-shot "add your contact" salvage nudge; "No, keep editing" in the prompt is the recovery.
    // "Already done" = on the landing (nothing to lose) or the results page (already POSTED). NOT otpVerified —
    // that is true for every LOGGED-IN buyer the moment he lands, and a logged-in buyer mid-flow must still be
    // asked before his requirement is thrown away. Conversion always routes through submit()→setStage('results').
    if (stage === 'landing' || stage === 'results') { onClose(); return; }
    // blEligible is the EXACT postable-requirement predicate (qty OR a spec OR requirement notes) — using it here
    // (not a qty/spec-only check) means a notes-only requirement, which IS submittable, is never silently discarded.
    if (blEligible) { setShowDiscard(true); return; }
    onClose();
  };
  handleExitRef.current = handleExit; // keep the ref pointing at the latest closure (for the Escape handler)
  // (scrollCard removed 2026-07-28 — it drove the closing page's horizontal hero carousel. The board shows all six
  //  sellers at once with no scrolling on either axis, which is the whole point of it, so there is nothing to page.)

  // DERIVED from the same array as the stepper and the "Step X of N" copy, so the three can never disagree —
  // whether there are 2 nodes or 3. The landing is 0 (and paints no bar at all); the last step fills it.
  const progressPercent = stage === 'results' ? 100 : Math.round((stageNodeIdx(stage) / stepCount) * 100);

  // (The landing trust-badge row — "Verified suppliers · Payment protected · 100% free · No spam calls" — was
  //  DELETED 2026-07-28 on the owner's instruction, along with the "Post one requirement — verified suppliers
  //  quote you." tagline above the product input. Both were chrome on the one page whose entire job is to get a
  //  product name typed. The results page still carries the real trust proof, where it is load-bearing.)
  // ── Consent notice (DPDP/TRAI): shown on the final step, at the point of submission. Copy is a reasonable
  //    default — LEGAL to review the exact wording. Links point at IndiaMART's own public legal pages. ──
  // (#79: consentNote removed — the consent step is deleted per owner; the DPDP/TRAI disclosure no longer renders.)
  // ── ONE dropdown, three origins. His own requirements and viewed products first, then the IndiaMART
  //    catalogue suggest — each row labelled with where it came from. Buyer truth outranks the catalogue,
  //    always. Capped at 6 rows, and the list itself scrolls.
  const q = productName.trim();
  const own = q ? ownPool.filter((m) => m.label.toLowerCase().includes(q.toLowerCase())) : [];
  const ownKeys = new Set(own.map((m) => m.label.toLowerCase()));
  const suggestMatches = q
    ? [...own, ...suggestions.filter((l) => !ownKeys.has(l.toLowerCase())).map((l) => ({ label: l, kind: 'on IndiaMART' }))].slice(0, 6)
    : [];
  // Picking NAMES the product; it never submits. When the label IS one of his own requirements we hand it
  // back to the host instead of committing a bare name — that card carries his specs, its quantity and (for
  // the engine's primary) the requirement-scoped Decision Objects, and retyping the title would throw all of
  // that away. Everything else is an ordinary commit.
  const pickSuggestion = (label: string) => {
    const name = label.trim();
    pickedRef.current = name;
    setShowDropdown(false); setSuggestions([]);
    const hit = (landing?.recs ?? []).find((r) => r.product.trim().toLowerCase() === name.toLowerCase());
    if (hit && landing) { landing.onPick(hit); return; }
    commitProduct(name);
  };
  // ── The product input row (shared by every landing surface: msite band, popup panel, standalone hero) ──
  const productInputRow = (
    <div data-flash="product-name" className={`relative ${flashCls('product-name')}`}>
      {/* focus-within ring raised from teal-100 (a 1.26:1 contrast — an effectively invisible keyboard focus
          indicator) to teal-500. This is the single highest-traffic control in the form. The decorative
          `ring-1 ring-teal-100` on the image panel below is NOT a focus indicator and stays as it is. */}
      <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-500 bg-white">
        {isMobile && <Search className="w-4 h-4 text-gray-300 ml-3.5 shrink-0" />}
        <input
          ref={productInputRef}
          type="text" value={productName}
          aria-label="Product or service name"
          onChange={(e) => onProductInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && productName.trim()) commitProduct(productName.trim()); }}
          onFocus={() => { if (suppressFocusOpenRef.current) { suppressFocusOpenRef.current = false; return; } if (suggestMatches.length || (recents.length && !q)) setShowDropdown(true); }}
          onClick={() => { if (suggestMatches.length || (recents.length && !q)) setShowDropdown(true); }} // a real tap always counts as "bringing the cursor to the box" — reveals recents even when the field is already auto-focused
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          placeholder={isMobile ? 'What are you looking to buy?' : 'e.g., TMT Bar, Diesel Generator…'}
          className="flex-1 min-w-0 px-4 py-3 text-base sm:text-sm outline-none bg-transparent"
        />
        <button type="button" disabled={!!aiBusy} onClick={() => setShowVoice(true)} aria-label="Speak your requirement" className="flex items-center justify-center px-3 text-green-600 border-l border-gray-100 hover:bg-green-50 py-3 disabled:opacity-40 disabled:cursor-not-allowed"><Mic size={18} /></button>
        <button type="button" data-flash="product-image" disabled={!!aiBusy} onClick={() => fileRef.current?.click()} aria-label="Upload a product photo" className={`px-3 text-teal-600 border-l border-gray-100 hover:bg-teal-50 py-3 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg ${flashCls('product-image')}`}><Camera size={16} /></button>
      </div>
      {resolving && <span className="absolute right-24 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />}
      {showDropdown && (suggestMatches.length > 0 || (recents.length > 0 && !q)) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden max-h-56 overflow-y-auto">
          {!q && recents.length > 0 && (
            <>
              <p className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Recent searches</p>
              {recents.map((r) => (<button key={r} onMouseDown={() => pickSuggestion(r)} className="w-full flex min-h-[44px] items-center gap-2 text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700"><Clock size={13} className="text-gray-300 shrink-0" />{r}</button>))}
            </>
          )}
          {suggestMatches.map((m) => (
            <button key={`${m.kind}:${m.label}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pickSuggestion(m.label)}
              className="w-full flex min-h-[44px] items-center gap-2 text-left px-4 py-2.5 hover:bg-teal-50">
              <span className="min-w-0 flex-1 truncate text-sm text-gray-700">{m.label}</span>
              <span className="shrink-0 text-[11px] text-gray-500">{m.kind}</span>
            </button>
          ))}
        </div>
      )}
      {notFound && <p role="alert" className="text-xs text-amber-600 mt-1.5">Couldn&apos;t match that to a category — try a more specific product name.</p>}
      {resolveError && <p role="alert" className="text-xs text-red-500 mt-1.5">Network issue reaching the catalog — <button type="button" onClick={() => commitProduct(productName)} className="font-semibold underline">tap to retry</button>.</p>}
    </div>
  );

  // Quantity + Unit block (once a product is committed). Quantity + Unit render ONLY when the category's
  // API actually provides units; otherwise they are hidden (and not required) — mobile still gets a
  // Continue affordance so the buyer can advance.
  // `hasUnits` is false in TWO cases that must behave identically, and the second one only became reachable on
  // 2026-07-28 when sanitizeUnitOptions started dropping the input-TYPE token: (a) the mcat's ISQ carries no
  // unit column at all, and (b) every "unit" it carried was noise ("Text"), so the real list is empty. Both
  // mean THIS CATEGORY DEFINES NO ORDER UNIT, which is exactly what the qty gate reads: the landing is skipped,
  // no product images are fetched, quantity is not scored (`quantityApplicable`), and Continue is not blocked —
  // `canContinueProduct` never required a unit. A captured quantity still renders (below) and still ships. The
  // buyer can no longer be forced to pick "Text" as the unit of 100000, because there is no lone chip to force.
  // Absurd-quantity SOFT confirm (owner 2026-08-13; ported from bl_quality/absurd_quantity.py). Rule 1 (non-round large
  // qty) is always on; Rules 2/3 activate once viewed-product prices + MCAT price-IQR are wired (backend data). Never blocks.
  const absurdQty = detectAbsurdQty(quantity);
  const qtyUnitBlock = committed && (
    <div className="mt-4 space-y-4 animate-field-in">
      {hasUnits ? (
        <>
          {/* Quantity + Unit side-by-side on desktop; stacked on mobile (width). Both optional (owner). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              {/* htmlFor/id, not a bare <label>: these two inputs had NO accessible name at all — neither an
                  association nor an aria-label — so a screen reader announced them as unlabelled edit boxes. */}
              <label htmlFor="rfq-quantity" className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
              <input id="rfq-quantity" ref={qtyRef} data-flash="quantity" type="text" inputMode="numeric" value={quantity}
                onChange={(e) => setQuantity(sanitizeQty(e.target.value))}
                onKeyDown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (unitOptions.length > 1 && !unit) openUnitPicker(); else if (canContinueProduct && !aiBusy) tryAdvanceToSpecs(); }}
                onBlur={(e) => { const to = e.relatedTarget as HTMLElement | null; if (to?.closest('[data-continue]')) return; if (qtyIsMeaningful(quantity) && unitOptions.length > 1 && !unit) openUnitPicker(); }}
                className={`w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400 animate-field-highlight ${flashCls('quantity')}`} />
            </div>
            <div role="group" aria-labelledby="rfq-unit-label">
              <p id="rfq-unit-label" className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Unit</p>
              {/* Unit UI = DROPDOWN (owner "B", 2026-08-13). Chips stacked one-per-row on 375px (the odd look). One-line
                  trigger + popover keeps qty & unit side-by-side on every width; a single unit is a static label. */}
              {unitOptions.length === 1 ? (
                <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-base sm:text-sm text-gray-700">{unitOptions[0]}</div>
              ) : (
                <div className="relative" data-unit-picker onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setUnitOpen(false); }}>
                  <button ref={unitBtnRef} type="button" aria-haspopup="listbox" aria-expanded={unitOpen} onClick={() => setUnitOpen((o) => !o)} className="w-full flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400">
                    <span className={unit ? 'text-gray-800' : 'text-gray-400'}>{unit || 'Select unit'}</span>
                    <ChevronDown size={16} className={`text-gray-400 transition-transform ${unitOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {unitOpen && (
                    <div role="listbox" aria-label="Unit" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg animate-modal-in">
                      {unitOptions.map((u) => (
                        <button key={u} type="button" role="option" aria-selected={unit === u} onClick={() => { unitRankRef.current = 3; setUnit(u); setUnitOpen(false); }} className={`w-full px-3 py-2.5 text-left text-sm hover:bg-teal-50 hover:text-teal-700 ${unit === u ? 'bg-teal-50 font-semibold text-teal-700' : 'text-gray-700'}`}>{u}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          {/* No API units for this category → qty/unit not required. But if voice/photo/name CAPTURED a
              quantity, show it editable so the buyer can see/correct it (never a hidden-but-submitted fact). */}
          {quantity.trim() && (
            <div>
              <label htmlFor="rfq-quantity-nounit" className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
              <input id="rfq-quantity-nounit" ref={qtyRef} data-flash="quantity" type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(sanitizeQty(e.target.value))} className={`w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400 ${flashCls('quantity')}`} />
            </div>
          )}
        </div>
      )}
      {quantity.trim() && absurdQty.absurd && !absurdAck && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-start gap-2" role="status">
          <span className="text-amber-600 mt-0.5" aria-hidden="true">⚠</span>
          <p className="text-xs text-amber-800 flex-1">Unusually large — is <b>{quantity}{unit ? ` ${unit}` : ''}</b> the quantity you need?
            <button type="button" onClick={() => setAbsurdAck(true)} className="ml-1.5 font-semibold text-amber-900 underline underline-offset-2">Yes, that's right</button>
          </p>
        </div>
      )}
      {specsLoading && <p className="text-xs text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Loading specifications…</p>}
    </div>
  );

  // ── Score circle (cloned from V3) ──
  const scoreCircle = (
    <div className="relative shrink-0">
      <button type="button" onClick={() => { setLocationEditing(false); setScoreOpen((v) => !v); }} className="relative w-11 h-11 block rounded-full hover:bg-gray-50 transition-colors" aria-label="View RFQ score breakdown">
        <svg viewBox="0 0 44 44" className="w-11 h-11 -rotate-90">
          <circle cx="22" cy="22" r="18" fill="none" stroke="#e5e7eb" strokeWidth="3" />
          <circle cx="22" cy="22" r="18" fill="none" stroke={getScoreColor(scoreDetails.total)} strokeWidth="3" strokeDasharray={`${(scoreDetails.total / 100) * 113.1} 113.1`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.5s ease' }} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-700">{scoreDetails.total}</span>
      </button>
      {scoreDelta > 0 && <span className="absolute -top-1 -right-1 z-10 text-[11px] font-extrabold text-teal-600 animate-score-delta pointer-events-none">+{scoreDelta}</span>}
      {scoreOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setScoreOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-40 w-full max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72 sm:rounded-2xl sm:border" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-2 sm:hidden" />
            <div className="flex flex-col items-center mb-3">
              <span className="text-3xl font-extrabold leading-none" style={{ color: getScoreColor(scoreDetails.total) }}>{scoreDetails.total}</span>
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-1">{getScoreLabel(scoreDetails.total)} · RFQ strength</span>
            </div>
            <div className="space-y-3">
              {(['Product', 'Specs', 'Details'] as const).map((g) => {
                const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
                if (!items.length) return null;
                return (
                  <div key={g}>
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{g}</p>
                    {items.map((c) => (
                      <button type="button" key={c.label} onClick={() => jumpToCheck(c)} className="w-full flex items-center justify-between py-1 px-1 -mx-1 rounded-md hover:bg-gray-50 text-left transition-colors group/row">
                        <span className={`flex items-center gap-2 text-sm ${c.done ? 'text-gray-700' : 'text-gray-500 group-hover/row:text-gray-700'}`}>
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0 ${c.done ? 'bg-teal-500 text-white' : 'border border-gray-300'}`}>{c.done ? '✓' : ''}</span>
                          {c.label}
                        </span>
                        {!c.done ? <span className="flex items-center gap-1 text-xs text-gray-500 font-medium"><span className="opacity-0 group-hover/row:opacity-100 text-teal-500 transition-opacity">Go</span>+{c.pts - c.earned}</span> : <ChevronRight size={13} className="text-gray-200 group-hover/row:text-gray-500" />}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
            {/* R5 steal — "Fill next" nudge: tap to jump straight to the single highest-value unfilled item. */}
            {nextCheck && <button type="button" onClick={() => jumpToCheck(nextCheck)} className="mt-3 w-full flex items-center justify-between text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 hover:bg-amber-100 transition-colors"><span><span className="font-semibold uppercase tracking-wide text-[11px] text-amber-600">Fill next</span> · {nextCheck.label} <span className="font-semibold">+{nextCheck.pts - nextCheck.earned}</span></span><ArrowRight size={13} /></button>}
          </div>
        </>
      )}
    </div>
  );

  // ── Shared location controls (current-location + your/delivery + same-as). Rendered INLINE on mobile
  //    (owner: "no popups/drawers on mobile → inline sections", P1-106) and inside the DESKTOP anchored popover. ──
  // #79: ONE city editor — deduped candidate chips (from the profile-vs-browsed conflict) + free search — shared by
  // the identity gate, the header drawer, and the conflict warning. Replaces the old 3-input popover (a redundant
  // SECOND editor with different UI). Chips/search set the buyer city via applyUserCity (delivery mirrors it while
  // "same as" is on, the default); `onPick` lets the header/banner also pin the delivery city + close/confirm on a
  // discrete pick. `showHint` prints the "confirm / pick a city" copy (suppressed inside the banner, which has its own).
  const cityChooser = (onPick?: (c: string) => void, showHint = true) => {
    const lc = computeLocationConflict();
    const seenCity = new Set<string>();
    const candidates = [lc.profileCity, userLocation, ...lc.conflicting.map((c) => c.city)]
      .map((c) => (c || '').trim())
      .filter((c) => { const k = c.toLowerCase(); if (!c || seenCity.has(k)) return false; seenCity.add(k); return true; });
    return (
      <div>
        {showHint && (lc.conflict && candidates.length > 1
          ? <p className="text-xs text-amber-700 mb-2">We saw more than one city linked to you — pick where suppliers should quote:</p>
          : candidates.length > 0 ? <p className="text-xs text-gray-500 mb-2">Confirm where suppliers should quote, or search another city.</p> : null)}
        {candidates.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2.5">
            {candidates.map((c) => {
              const sel = userLocation.trim().toLowerCase() === c.toLowerCase();
              return (
                <button key={c} type="button" onClick={() => { applyUserCity(c); setGateCityChosen(true); onPick?.(c); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${sel ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-700 hover:border-teal-300 hover:bg-teal-50/50'}`}>
                  <MapPin size={13} className={sel ? 'text-teal-500' : 'text-gray-400'} aria-hidden="true" />{c}
                </button>
              );
            })}
          </div>
        )}
        {/* Typing never auto-commits/closes — onChange fires on a chosen city; a chip tap or the header Done commits. */}
        <LocationSearch value={userLocation} onChange={(c) => { applyUserCity(c); setGateCityChosen(true); }} placeholder={candidates.length ? 'Or search another city…' : 'Search your city…'} />
      </div>
    );
  };

  // Location editor: a BOTTOM-SHEET DRAWER on mobile (owner prefers the drawer — inline took too much last-page
  // space), an ANCHORED popover on desktop. Same controls, two presentations via the sm: breakpoint.
  const renderLocationPopover = (align: 'left' | 'right' = 'right') => (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setLocationEditing(false)} />
      <div className={`fixed inset-x-0 bottom-0 z-40 w-full rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left space-y-3 bg-white shadow-[0_-8px_32px_-4px_rgba(30,42,58,0.18)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-3rem)] sm:rounded-xl sm:border sm:p-3 sm:shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)] ${align === 'left' ? 'sm:left-0' : 'sm:right-0'}`} style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-1 sm:hidden" />
        <p className="text-[11px] uppercase font-semibold text-gray-500 tracking-wide">Delivery city</p>
        {/* GPS is a distinct input method (not redundant with the chips) — kept for a fast "deliver to where I am". */}
        <button type="button" onClick={useCurrentLocation} disabled={geoLoading} className="w-full flex items-center justify-center gap-2 py-2 min-h-[40px] rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-sm font-semibold hover:bg-teal-100 disabled:opacity-60">
          {geoLoading ? <span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" /> : <LocateFixed size={15} />} Use my current location
        </button>
        {/* #79 Move A: the SAME chooser the gate uses (no separate 3-input editor). A chip pins the delivery city + closes. */}
        {cityChooser((c) => { setDeliveryLocation(c); commitCity(c); setLocationEditing(false); })}
        {/* Done commits the current pick (chip / search / GPS) as the delivery city + resolves city_id (same helper the gate uses). */}
        <button type="button" onClick={async () => { const c = (userLocation.trim() || deliveryLocation.trim()); if (c) setDeliveryLocation(c); await commitCity(c); setLocationEditing(false); }} className="w-full py-2.5 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700">Done</button>
      </div>
    </>
  );

  // "DID WE FILL THIS IN FOR HIM?" — the one predicate the AI mark hangs off (owner item 5, 2026-07-28).
  // It reads the SAME three machine-provenance sets that the whole precedence ladder already runs on
  // (engine/photo/mic prefill · use-case assist · repost seed), and every buyer-driven writer deletes its field
  // from all three (see setSpecValue) — so the mark disappears the instant the value becomes HIS, and nothing
  // new has to be tracked to make that true. A field he cleared carries no mark either: no value, nothing filled.
  // Refs are safe to read here: every write to them is paired with a setSpecValues in the same handler, so a
  // render always sees the settled sets.
  const aiFilled = (field: string): boolean =>
    !!(specValues[field] || '').trim()
    && (photoSetKeys.current.has(field) || useCaseSetKeys.current.has(field) || seedSetKeys.current.has(field));
  // PREFILL SOURCE ICON (owner 2026-07-29). A small icon on a prefilled spec telling him WHERE it came from —
  // repost / photo / mic — or the ✦ AI mark for a planner or use-case fill (and as the fallback when the source
  // is unknown). Nothing is shown for a value the buyer typed himself (aiFilled is false once he edits). We only
  // ever show a source we actually recorded; an unattributed value gets the neutral AI mark, never a guessed icon.
  const sourceMark = (field: string): React.ReactNode => {
    if (!aiFilled(field)) return null;
    const src = specSrc.current[field];
    if (src === 'repost') return <span title="From your previous requirement" aria-label="From your previous requirement" role="img" className="ml-1.5 inline-flex align-middle text-teal-500"><RotateCcw size={12} /></span>;
    if (src === 'photo') return <span title="From your photo" aria-label="From your photo" role="img" className="ml-1.5 inline-flex align-middle text-teal-500"><Camera size={12} /></span>;
    if (src === 'mic') return <span title="From what you told us" aria-label="From what you told us" role="img" className="ml-1.5 inline-flex align-middle text-teal-500"><Mic size={12} /></span>;
    return <AiMark />;   // 'ai' or unattributed → the neutral "filled in for you" mark
  };
  // ── Spec fields (ALL buyer specs, one list). Shows the unified planner's field_hint when present. ──
  const renderSpecField = (s: ISQSpec) => {
    bes('question_shown', `spec:${s.IM_SPEC_MASTER_DESC}`);   // BES: screen the buyer had to read, answered or not
    // G-a fix: a spec that arrived PREFILLED (machine source tag) and carries a value counts as a CONFIRM (weight 0.1,
    // the OBSERVED→STATED intent) — else a fully-prefilled page the buyer submits untouched read as 0% answered (the
    // prefill-inversion the owner saw). bes() dedupes by key, so this fires once; a later buyer edit adds its own event.
    if ((specValues[s.IM_SPEC_MASTER_DESC] || '').trim() && specSrc.current[s.IM_SPEC_MASTER_DESC]) bes('confirm', `spec:${s.IM_SPEC_MASTER_DESC}`);
    const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
    const hint = isqHints[s.IM_SPEC_MASTER_DESC];
    // A PREFILLED spec is marked with the AI icon and NOTHING else (owner): no source line, no tier colour, no
    // per-chip badge, and no separate receipt strip. It renders as the SAME label + full option group as an
    // empty spec, with its value selected — including a value that is not in the option list, which OptionChips
    // shows as the selected "Other" chip rather than dropping it. That is the whole of item 5.
    // The provenance (browsed vs stated vs repost-seed vs planner) is kept in the routing ledger for debug.
    return (
      <div key={s.IM_SPEC_MASTER_DESC} className="space-y-2">
        {/* The mark sits on the FIELD NAME, before the hint — it marks the field as one we filled, and trailing
            it after a caption made it read as part of the caption. */}
        <label className="block text-sm font-medium text-gray-700">{s.IM_SPEC_MASTER_DESC}{sourceMark(s.IM_SPEC_MASTER_DESC)}
          {hint && <span className="ml-2 font-normal text-gray-500">— {hint}</span>}
        </label>
        {opts.length > 0 ? <OptionChips ariaLabel={s.IM_SPEC_MASTER_DESC} options={opts} value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(v) => setSpecValue(s.IM_SPEC_MASTER_DESC, v)} />
          : <input type="text" value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(e) => setSpecValue(s.IM_SPEC_MASTER_DESC, e.target.value)} placeholder={hint || `Enter ${s.IM_SPEC_MASTER_DESC.toLowerCase()}`} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400" />}
        {/* LLM 1's ALTERNATIVE for a value the buyer already has — a non-sticky suggestion, never an overwrite
            (plan §Page-1 precedence). Shown only when it differs from the current value; tap to accept. */}
        {llmSuggests[s.IM_SPEC_MASTER_DESC] && llmSuggests[s.IM_SPEC_MASTER_DESC] !== (specValues[s.IM_SPEC_MASTER_DESC] || '') && (
          <button type="button" onClick={() => { setSpecValue(s.IM_SPEC_MASTER_DESC, llmSuggests[s.IM_SPEC_MASTER_DESC]); setLlmSuggests((p) => { const n = { ...p }; delete n[s.IM_SPEC_MASTER_DESC]; return n; }); }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-teal-300 bg-teal-50/40 px-2.5 py-1 text-[12px] text-teal-700 hover:bg-teal-50">
            <span className="text-teal-500">✦</span> Suggested: {llmSuggests[s.IM_SPEC_MASTER_DESC]} · use
          </button>
        )}
      </div>
    );
  };

  // Show ALL buyer specs (owner: "show all buyer specs on page 1"). We deliberately DON'T hide any as
  // "redundant" — hiding them asynchronously made specs "appear then vanish" ~1s after the page rendered
  // (the owner-reported bug). The planner still PREFILLS known values + adds hints; it just never removes a field.
  // CF-6 RESOLVED — owner 2026-08-03: "only in case of mcat change we drop the prefilled specs from the wrong mcat."
  // The OLD rule dropped every UNFILLED buyer spec whenever LLM 1 returned `category_trustworthy:false`. That
  // directly contradicted the standing contract that buyer specs ALWAYS stay on page 1, and it made the contents of
  // the page depend on an LLM boolean — the buyer could lose half his form because a model was unsure.
  // The two rules now agree: buyer specs ALWAYS render. The only thing a category collision removes is the WRONG
  // category's prefilled VALUES, and that is handled deterministically at commit time by `collisionSwapRef` (which
  // discards the seed specs and re-fetches the corrected mcat's ISQ) — not here, and not by an LLM.
  const visibleSpecs = isqSpecs;
  // "Also detected" — extracted buyer-truth that isn't a buyer ISQ field; editable/removable, and shipped.
  const extraKeys = Object.keys(extraSpecs);
  const extrasSection = extraKeys.length > 0 && (
    <div className="pt-3 border-t border-gray-100">
      <p className="text-xs uppercase font-semibold text-gray-500 tracking-wide mb-2 flex items-center gap-1.5"><ListPlus size={13} className="text-teal-500" /> Also detected <span className="font-normal normal-case text-gray-500">— auto-detected · confirm, edit or remove</span></p>
      {/* Provenance: `extraSpecs` is populated from LLM-1 `known_truths`, each now carrying its own `source` fence tag
          (WhatsApp / calls / CSL / past requirements). We badge the ones sourced from his POSTED REQUIREMENT (truth_rfq)
          so a real spec the buyer himself filed — which fell here only because it did not fit the committed category's
          schema (Theme-B category mismatch) — is visibly attributed instead of reading as an anonymous auto-detection. */}
      <div className="space-y-2">
        {extraKeys.map((k) => {
          const fromRfq = /rfq|requirement/i.test(extraSpecSrc[k] || '');
          return (
          <div key={k} className="flex items-center gap-2">
            <span className="text-sm text-gray-600 w-2/5 shrink-0 truncate" title={k}>{k}
              {fromRfq && <span className="ml-1.5 align-middle inline-block text-[11px] font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded px-1 py-0.5">from your posted requirement</span>}
            </span>
            <input value={extraSpecs[k]} onChange={(e) => setExtraValue(k, e.target.value)} aria-label={k} className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <button type="button" onClick={() => removeExtra(k)} aria-label={`Remove ${k}`} className="w-9 h-9 shrink-0 rounded-lg text-gray-500 hover:text-red-500 hover:bg-red-50 flex items-center justify-center"><X size={15} /></button>
          </div>
          );
        })}
      </div>
    </div>
  );
  // ── ONE SPEC LIST, ONE UI (owner 2026-07-28) ───────────────────────────────────────────────────────────
  // The planner's questions used to live in their own teal boxed card floating above the specs — a second,
  // visually louder form on the same page. They are questions about the same requirement, so they now render
  // with the SAME label + chips markup as every ISQ spec, in one continuous list. The ONLY thing that keeps a
  // section of its own is the use-case assist, and it sits at the very top of the page.
  const renderInlineQuestion = (
    key: string, q: string, why: string | undefined, options: string[] | undefined,
    value: string, onChange: (v: string) => void, badge?: React.ReactNode,
  ) => (
    <div key={key} className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">{cleanBuyerText(q)}
        {why && <span className="ml-2 font-normal text-gray-500">— {cleanBuyerText(why)}</span>}
        {badge}
      </label>
      {options?.length
        ? <OptionChips ariaLabel={q} options={options} value={value} onChange={onChange} />
        : <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Type your answer" aria-label={q}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400" />}
    </div>
  );
  // ── ITEM 2 · PRE-ANSWERED questions — a confirm chip, never a silent fill ──────────────────────────────
  // The failure this replaces: `calls.requirement.intended_application` says "Food Packaging Business" and the
  // form asks him what it is for anyway. Now the question still appears, with our answer already selected and
  // WHERE WE GOT IT written next to it, and one tap changes or clears it.
  //
  // It is deliberately NOT hidden. Hiding a known answer would look like the least effort of all, and it is the
  // wrong trade twice over: he never sees what we assumed about him, and TUS's CONFIRMED stage — the whole
  // point of holding truth — can never fire, because nothing was ever put in front of him to confirm.
  //
  // WHAT HE NO LONGER SEES (P0 privacy, owner 2026-07-28): the SOURCE. This row printed "✦ from your call with
  // a seller" next to our answer, i.e. it told the buyer we listen to his phone calls. Owner: "nowhere should
  // buyer know that we are listening his calls, just provide the options available for that question." So the
  // provenance text is gone and the AI mark takes its place — the question, our answer already selected, and
  // the options to change it. `p.source` still travels to the routing ledger and the debug panel unchanged.
  const preAnsweredSection = preAnswered.length > 0 && (
    <>
      {preAnswered.map((p, i) => {
        const v = preAnswerValues[p.q] ?? '';
        const opts = [p.value, ...(p.options || []).filter((o) => o.toLowerCase() !== p.value.toLowerCase())].slice(0, 6);
        const untouched = v === p.value;
        return (
          <div key={`pre-${i}`} className="space-y-2" ref={() => { bes('question_shown', `pre:${p.q}`); if (untouched) bes('confirm', `pre:${p.q}`); }}>
            {/* the AI mark, NOT the provenance. No text: he sees the answer and the options, never the channel. */}
            <label className="block text-sm font-medium text-gray-700">{cleanBuyerText(p.q)}<AiMark />
              {p.why && <span className="ml-2 font-normal text-gray-500">— {cleanBuyerText(p.why)}</span>}
            </label>
            <OptionChips ariaLabel={p.q} options={opts} value={v}
              onChange={(nv) => {
                bes(nv && nv !== p.value ? 'correction' : nv ? 'confirm' : 'backspace', `pre:${p.q}`);
                setPreAnswerValues((prev) => ({ ...prev, [p.q]: nv }));
              }} />
            {!v && <p className="text-[11px] text-amber-700">We had this as “{p.value}”. Pick an answer, or leave it blank and we won’t send it.</p>}
          </div>
        );
      })}
    </>
  );
  // ── ITEM 1 · the PERSONA question — identical chip UI to every other gap, and it only reaches here after
  // the deterministic bulk-B2B gate passed. There is no persona screen; this is one more ranked question.
  // MEMOISED (re-render-storm fix): was an IIFE recomputed every render → a new node fed rankedQuestions each render.
  const personaSection = useMemo(() => {
    if (!personaAsk) return null;
    const opts = personaAsk.options?.length ? personaAsk.options : ['For my own use or production', 'For resale to my customers', 'Both'];
    return (
      <div className="space-y-2" ref={() => bes('question_shown', 'persona')}>
        <label className="block text-sm font-medium text-gray-700">{cleanBuyerText(personaAsk.q)}
          {personaAsk.why && <span className="ml-2 font-normal text-gray-500">— {cleanBuyerText(personaAsk.why)}</span>}
        </label>
        <OptionChips ariaLabel={personaAsk.q} options={opts} value={personaAnswer}
          onChange={(v) => { bes('chip', 'persona'); setPersonaAnswer(v); }} />
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaAsk, personaAnswer]);
  // ── ITEM 3 · a last-page field the planner PROMOTED onto the spec page. Same markup as everything else, and
  // it writes to the REAL state behind the field, so the answer travels through buildRequirementText exactly
  // as it would have from the last page. Nothing here is a copy of the field — it IS the field, moved.
  // C19 (2026-08-03): `promotedLastPage` DELETED. It rendered Delivery timeline, Payment terms, Purchase frequency,
  // Business type and Industry directly inside the SPEC page whenever `placement[f] === 'spec_page'` — i.e. five
  // commercial/persona fields on page 1, the exact leakage the page contract forbids. It was unreachable only
  // because `setPlacement` is a no-op, which makes it a landmine rather than a feature: one real setPlacement call
  // and page 1 sprouts page-2 content. If field relocation returns, it must go through an explicit allow-list that
  // cannot promote a commercial or persona concept onto the spec page.
  // The buyer-aware OPENING question. Same markup as a spec field — the buyer has no reason to know one came
  // from the ISQ schema and the other from the Curated-RFQ planner.
  //
  // The RANKED GAPS deliberately do NOT render here any more (design audit 2026-07-28). They used to be split
  // `slice(0,1)` here and `slice(1)` into the smart-questions block, which put gap #1 at the top of the page and
  // gaps #2-#6 after up to 30 ISQ fields — the planner's ranking destroyed by the render order. They are now one
  // rank-ordered list in `rankedQuestions`, rendered directly beneath the opening question.
  const plannerQuestions = (
    <>
      {/* ONE LOADER, not two (owner 2026-07-28). This and the "Working out what else to ask…" spinner in
          aiSpecsBody are driven by the SAME unified planner call, so both used to spin at once. Suppress this one
          whenever that one will show (aiSpecsLoading) — the lower loader carries the Skip affordance, so it is the
          one to keep. Net effect: at most a single spinner on the spec page at any time. */}
      {baqLoading && !baq && !aiSpecsLoading && (
        <p className="text-sm text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Reading what you're after…</p>
      )}
      {/* A PRE-ANSWERED question already carries its answer — a confirmation, not something he has to fill.
          (Was gated on `!specSplit`; with one spec page it always belongs here.) */}
      {preAnsweredSection}
      {baq?.opening?.q && renderInlineQuestion('planner-opening', baq.opening.q, baq.opening.why, baq.opening.options,
        baqAnswers.opening ?? '', (v) => { bes('chip', 'opening'); setBaqAnswers((a) => ({ ...a, opening: v })); })}
    </>
  );
  // ── RESOLVE_CONFLICT · the A/B widget (fabrication firewall) ────────────────────────────────────────────
  // Two of the buyer's OWN signals disagree on one field. Neither is settled truth, so NEITHER is pre-selected
  // and neither may be shipped until he picks. This is the single most important interaction in the whole form
  // — it is what stops a value the buyer never said reaching a seller — and until now it rendered NOWHERE:
  // `brainToSeed` built `seed.conflicts` and not one line of UI ever read it.
  //
  // P0 PRIVACY (owner 2026-07-28) — THE SOURCES ARE GONE FROM THE SCREEN. Each option used to print the channel
  // it came from underneath it ("your call with a seller" vs "a product you viewed"), plus `o.evidence` as a
  // hover tooltip. That is the exact leak the owner banned: "nowhere should buyer know that we are listening his
  // calls, just provide the options available for that question, conflicted options + few more applicable to
  // that question." So this now renders as an ORDINARY question: the conflicting values FIRST (they are the two
  // real candidates), then whatever extra options the planner phrased for the same question, deduped, with
  // NOTHING pre-selected. `conflict[].source` / `.evidence` still reach the debug panel untouched.
  const renderableConflicts = engineConflicts.filter((d) => (d.conflict?.length ?? 0) >= 2);
  const conflictsSection = renderableConflicts.length > 0 && (
    <div className="space-y-4">
      {renderableConflicts.map((d) => {
        const phrase = enginePhrasing[d.id];
        // Conflicting values first, then the planner's extra options for the same question. Case-insensitive
        // dedupe, because the planner routinely re-states one of the two values in its own option list.
        const seen = new Set<string>();
        const opts: string[] = [];
        for (const o of [...(d.conflict || []).map((c: ConflictOption) => c.value), ...(phrase?.options ?? []), ...(d.options ?? [])]) {
          const v = String(o ?? '').trim();
          const k = v.toLowerCase();
          if (!v || seen.has(k)) continue;
          seen.add(k); opts.push(v);
        }
        return (
          <div key={d.id} className="space-y-2" ref={() => bes('question_shown', `conflict:${d.field}`)}>
            <label className="block text-sm font-medium text-gray-700">
              {phrase?.q || `Which is right for ${d.field.toLowerCase()}?`}
            </label>
            {/* NOTHING pre-selected — that is the fabrication firewall, and it is unchanged: neither value is
                settled truth, so nothing ships for this field until he picks one himself. */}
            <OptionChips ariaLabel={phrase?.q || d.field} options={opts} value={conflictPicks[d.id] || ''}
              onChange={(v) => { bes('chip', `conflict:${d.field}`); setConflictPicks((p) => ({ ...p, [d.id]: v })); }} />
          </div>
        );
      })}
    </div>
  );
  // ── SUGGEST · unselected INFERRED-tier ghost chips ──────────────────────────────────────────────────────
  // A category norm, not anything this buyer said. Dashed and unselected by construction: the moment one is
  // pre-selected it stops being a suggestion and becomes a fabricated buyer fact.
  // Hidden once the buyer has ANSWERED the field himself — a suggestion must never second-guess his own answer.
  // But a field HE filled by tapping this very chip keeps its row (suggestPicks), so he can tap again to undo.
  const renderableSuggests = engineSuggests.filter((d) => suggestPicks[d.id] !== undefined || !(specValues[d.field] || aiSpecValues[d.field] || extraSpecs[d.field]));
  const suggestionsSection = renderableSuggests.length > 0 && (
    <div className="space-y-4">
      {renderableSuggests.map((d) => {
        const opts = d.options?.length ? d.options : (d.value ? [d.value] : []);
        if (!opts.length) return null;
        const isqHit = isqSpecs.find((s) => s.IM_SPEC_MASTER_DESC.toLowerCase() === d.field.toLowerCase());
        const picked = suggestPicks[d.id] || (isqHit ? specValues[isqHit.IM_SPEC_MASTER_DESC] : '') || '';
        return (
          <div key={d.id} className="space-y-2" ref={() => bes('question_shown', `suggest:${d.field}`)}>
            <label className="block text-sm font-medium text-gray-700">{enginePhrasing[d.id]?.q || d.field}
            </label>
            <div className="flex flex-wrap gap-2">
              {opts.map((o) => (
                <button key={o} type="button"
                  onClick={() => {
                    bes('chip', `suggest:${d.field}`);
                    const next = picked === o ? '' : o;   // tap again to un-accept — a suggestion is never sticky
                    setSuggestPicks((p) => ({ ...p, [d.id]: next }));
                    if (isqHit) setSpecValue(isqHit.IM_SPEC_MASTER_DESC, next);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-[13px] ${picked === o ? 'border-teal-600 bg-teal-600 text-white' : 'border-dashed border-gray-300 bg-white text-gray-500 hover:border-teal-300 hover:text-gray-700'}`}>{o}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
  // ── OFFER · NOT RENDERED TO THE BUYER AT ALL (owner 2026-07-28) ─────────────────────────────────────────
  // This was a dismissable cross-sell strip above the spec list: "Source your notebook machine and raw material
  // together? / you have other active needs — source them together?", listing FRP Square Manhole Cover · Tata
  // Chhota Hathi · Exercise Notebook Raw Material. Owner: "what is this section, why we need this" — a
  // rejection. The list is unrelated products (a manhole cover and a mini truck beside notebook material) on a
  // form whose entire job is ONE requirement, so it is clutter at the exact moment the buyer should be naming a
  // spec. There is no strip, no dismiss button and no dismissed-offer state any more.
  //
  // The DECISION is not dropped, only the pixels: every OFFER still reaches the planner inside
  // <engine_decisions>, is still counted in the decision summary, and gets an explicit
  // "deliberately not rendered" row in the routing ledger below (with this reason) so the debug panel and the
  // consumption ladder account for it honestly instead of showing a silent disappearance.
  const OFFER_NOT_RENDERED = 'the buyer UI shows no cross-sell offer strip (owner 2026-07-28: "what is this section, why we need this"). An OFFER lists products unrelated to the requirement in front of him, so it is deliberately not rendered — not lost: it is here, in the summary, and in the planner input.';
  // (REMOVED 2026-08-14, owner + task #76: the spec-page "✦" use-case-assist icon is gone. It was a SECOND entry to the
  //  assist chat mid-form, and on the spec page it risked the aiEpoch re-fire / page-reset (the "jumping" bug) — only the
  //  !plannerFiredFor guard stopped it — and its chat content wasn't routed to the brain. The chat now lives ONLY on the
  //  pre-commit landing ("Fill using AI" FAB), where it commits fresh and LLM 1 fires with the full bundle.)
  // ── THE PLANNER'S QUESTIONS (its ranked `gaps`) — options-only, and rendered as ONE ordered block ────────
  // Filter out any question a late authoritative getISQs has since made a page-1 ISQ field (no dup ask).
  // MEMOISED (2026-08-11 re-render-storm fix): both were computed INLINE every render → a new Set + a new array
  // reference on every commit → `rankedQuestions` (which lists visibleAiSpecs) re-sorted and REBUILT every question
  // node on EVERY re-render, re-firing each node's `ref={() => bes('question_shown')}` callback = the visible
  // "blinking + spec reranking". Harmless before, but the parallel pre-warm (LLM 2/3/4 firing during the spec page)
  // adds a burst of re-renders that exposed it. Stable refs now → the ladder only rebuilds when specs actually change.
  const isqNameSet = useMemo(() => new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase())), [isqSpecs]);
  const visibleAiSpecs = useMemo(() => aiSpecs.filter((q) => !isqNameSet.has(q.fieldName.toLowerCase())), [aiSpecs, isqNameSet]);
  // The persona ask and any PROMOTED last-page field are real questions on this page, so "no extra questions
  // needed" must not be shown over the top of them.
  const hasSpecPageExtras = !!personaAsk || RELOCATABLE_LAST_PAGE_FIELDS.some((f) => placement[f] === 'spec_page');
  // ── THE RANKED QUESTION LIST — every scored question the planner emitted, in ITS order ──────────────────
  // Built as one sorted array rather than three sibling JSX blocks, which is what removes the old
  // banner-gap/page-gap bifurcation: there is now exactly one place a ranked question can render.
  const rankedQuestions = useMemo(() => {
    const items: Array<{ rank: number; node: React.ReactNode }> = [];
    if (identityAsk) {
      const opts = identityAsk.options?.length ? identityAsk.options : ['Yes, registered', 'Not yet'];
      items.push({
        rank: identityAsk.rank ?? 0,
        // Same chip UI as any other gap — no special treatment. Answering it here is what removes the GST ask
        // from the last page (see showGstQuestion / showGstAnswered).
        node: (
          <div key="identity-ask" className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              {identityAsk.q}
              {identityAsk.why && <span className="ml-2 font-normal text-gray-500">— {identityAsk.why}</span>}
            </label>
            <OptionChips ariaLabel={identityAsk.q} options={opts} value={gstRegistered === true ? opts[0] : gstRegistered === false ? opts[1] : ''} onChange={(v) => setGstRegistered(v === opts[0])} />
          </div>
        ),
      });
    }
    // The persona question, when (and only when) the deterministic bulk-B2B gate let it through.
    if (personaAsk && personaSection) items.push({ rank: personaAsk.rank ?? 0, node: <div key="persona-ask">{personaSection}</div> });
    // A question with no rank (an engine ASK the planner never scored, rescued so it is not silently dropped)
    // sorts after every ranked one — a large base, plus its own index so the rescued set keeps its order.
    visibleAiSpecs.forEach((q, i) => items.push({
      rank: q.rank ?? (1e6 + i),
      node: (
        <div key={q.fieldName} className="space-y-2" ref={() => bes('question_shown', `ai:${q.fieldName}`)}>
          <label className="block text-sm font-medium text-gray-700">
            {q.fieldName}
            {q.helperText && <span className="ml-2 font-normal text-gray-500">— {q.helperText}</span>}
          </label>
          <OptionChips ariaLabel={q.fieldName} options={q.options} value={aiSpecValues[q.fieldName] || ''} onChange={(v) => { bes('chip', `ai:${q.fieldName}`); setAiSpecValues((p) => ({ ...p, [q.fieldName]: v })); }} />
        </div>
      ),
    }));
    return items.sort((a, b) => a.rank - b.rank).map((x) => x.node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityAsk, personaAsk, personaSection, visibleAiSpecs, aiSpecValues, gstRegistered]);

  // ── REPORT THE REAL ROW COUNT BACK TO THE SPLIT DECISION ────────────────────────────────────────────────────
  // `rankedQuestions` is the single merged ladder of every question row the spec page renders (engine conflicts,
  // the planner's ranked gaps, the identity ask, the persona ask, the unranked rescued asks), so its length is the
  // honest question count — which nothing further up the component can compute, hence the round trip. Plus the ISQ
  // spec fields and the "also detected" rows. Identity-guarded, so it cannot churn renders.
  // (`plannerRowCount` was DELETED 2026-08-01 — it existed solely to decide the empty-planner auto-skip to the
  //  removed 'specs2' stage. With one spec page an empty planner needs no skip.)
  // EMPTY PLANNER PAGE → SKIP STRAIGHT TO PAGE 2 (owner 2026-07-29: "skip when planner says nothing to fill").
  // MUST read plannerRowCount (the fresh, same-render count), NOT a round-tripped state — the lagged version fired
  // one frame early and skipped a page 1 that had four real questions on it (verified live). Only once the planner
  // has FINISHED (fired + not loading) with a genuine zero does page 1 have nothing to answer, so we drop the buyer
  // onto his specs (page 2). Guarded once per product + forward-only, so Back from page 2 is not bounced forward;
  // and it never fires before the planner has run — except when there is no form LLM (then the skip is immediate).
  // (The empty-planner auto-skip was DELETED with the 'specs2' stage — its only action was setStage('specs2'),
  //  i.e. it could only ever move the buyer onto a page that renders the results body. With one spec page there is
  //  nowhere to skip TO: an empty planner just means the buyer confirms his own specs and taps Next.)
  const aiSpecsBody = (
    <div data-flash="smart-questions" className={`space-y-5 ${flashCls('smart-questions')}`}>
      {/* (Category-corpus status chip removed — it was a dev/debug line, not for buyers. The corpus still loads
          in the background for Category mode; it's just no longer surfaced.) */}
      {aiSpecsLoading && visibleAiSpecs.length === 0 && !identityAsk && !hasSpecPageExtras && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Working out what else to ask…</p>
          <button type="button" onClick={() => { bes('skip'); goNext(); }} className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-600 shrink-0">Skip for now</button>
        </div>
      )}
      {!aiSpecsLoading && visibleAiSpecs.length === 0 && !identityAsk && !hasSpecPageExtras && (
        aiSpecsError ? (
          // FAILURE → retry (re-fires the planner) + a quiet continue. We DON'T auto-skip (owner) — a transient
          // gateway blip shouldn't silently drop the smart questions.
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-gray-500">Couldn’t work out the extra questions right now.</p>
            <div className="flex items-center gap-4">
              <button type="button" onClick={retryAiSpecs} className="flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700"><RotateCcw size={15} /> Retry</button>
              <button type="button" onClick={goNext} className="text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700">Continue anyway →</button>
            </div>
          </div>
        ) : visibleSpecs.length === 0 ? (
          // Only when the page is GENUINELY empty (no spec chips AND no smart questions) does an empty-state line
          // help. When the buyer already sees spec chips above, "No extra questions needed" is contradictory noise
          // (owner 2026-08-11: "if there were questions populated, no need of this message") → render nothing.
          <p className="text-sm text-gray-500">{!hasFormLLM() ? 'You can add any extra details on the next step. →' : 'No extra questions needed — your specs already cover it. Continue →'}</p>
        ) : null
      )}
      {/* ── ONE RANK-ORDERED QUESTION LIST (design audit 2026-07-28) ──────────────────────────────────────
          Identity and persona have to be pulled OUT of the planner's ranked array upstream, because their
          answers must land on the REAL state behind them (gstRegistered / personaAnswer) rather than on a
          throwaway aiSpecValues entry. That is a wiring constraint, not a ranking decision — so they are
          re-inserted HERE at the rank the planner actually gave them, instead of being hoisted above every
          other question just because they render differently inside. Everything competes on one ladder.
          Sorted stably, so two questions the planner ranked equally keep their original relative order. */}
      {rankedQuestions}
      {/* ITEM 3 — the last-page fields the planner MOVED here. Deliberately after the ranked list and not
          inside it: a promoted field is a placement decision, never a scored gap, so it has no rank to sort on
          and giving it a fake one would be inventing a ranking the planner never made. */}
    </div>
  );

  // ── PAGE 1 · "details I need to fill" ───────────────────────────────────────────────────────────────────
  // Every QUESTION lives here — a question is unanswered by definition — plus the specs that are still blank.
  // When there is no split this is the whole, unchanged, single spec page.
  // ── PAGE 1 · "Answer a few things" — PLANNER QUESTIONS ONLY (owner 2026-07-29) ──────────────────────────────
  // The buyer's own ISQ specs are NOT here any more — every one of them lives on page 2, prefilled/filled. Page 1
  // is exclusively the planner's net-new questions: the conflict he must settle, the ranked gaps, the category
  // suggestions. No ISQ "Fetching category specs…" loader here (that belongs to the spec list, now on page 2);
  // while the PLANNER runs, the single loader inside aiSpecsBody shows, and if the planner returns nothing at all
  // this page is auto-skipped to page 2 (see the empty-planner effect).
  // ── PAGE 1 · SPECS — ONE page (vFinal plan; the "Confirm your details" split is gone, #②). Order matches the
  // plan: the buyer ISQ specs are the DEFAULT (prefilled by LLM 1 + the completeness fill, EDITABLE), the LLM's
  // own ranked questions follow, and the "also detected" known-truths key sits at the bottom. Same label+chips
  // markup for every spec (the owner's no-visual-hierarchy lock). No LLM fires from the render — the planner
  // effect already ran on commit.
  // #1/#2 Location conflict — profile (registered) city vs where the buyer is actually browsing from (CSL). On a
  // district mismatch the registered address is likely stale or he is sourcing elsewhere, so the spec page prompts
  // (at the top, before specs) for the real buyer + delivery city. Signals today: browse city + also-seen-in;
  // city_filters and the PNS-call city join once the CSL parser (G2) + FIXED7 surface them. Dismissable once acked.
  const locationConflict = computeLocationConflict();
  const showLocationPrompt = locationConflict.conflict && !locationConfirmed;
  const locationBanner = showLocationPrompt ? (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-start gap-2.5">
        <MapPin size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-800">Where should suppliers quote for?</p>
          <p className="text-xs text-amber-700 mt-0.5 mb-2.5">Your saved city is <b>{locationConflict.profileCity || '—'}</b>, but you seem to be in <b>{locationConflict.conflicting.map((c) => c.city).join(' / ')}</b>. Pick where suppliers should quote.</p>
          {/* #79: the choices live INLINE here now (no separate "Set location" popup) — a pick commits + dismisses the banner. */}
          {cityChooser((c) => { setDeliveryLocation(c); commitCity(c); }, false)}
          <button type="button" onClick={() => setLocationConfirmed(true)} className="mt-2 px-2.5 py-1.5 rounded-lg text-xs text-amber-700 hover:bg-amber-100">Keep {locationConflict.profileCity || 'saved city'}</button>
        </div>
      </div>
    </div>
  ) : null;
  const specBody = (
    <div data-flash="specifications" className={`space-y-5 ${flashCls('specifications')}`}>
      {locationBanner}
      {mcatMismatch && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex items-start gap-2.5">
          <span className="text-amber-600 mt-0.5" aria-hidden="true">⚠</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-800">Is this the right category?</p>
            <p className="text-xs text-amber-700 mt-0.5">We matched <b>{productName}</b> to <b>{catName}</b>. If that isn't right, edit the product name so you get the correct specs.</p>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => { setMcatMismatch(false); setStage('landing'); }} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700">Edit product</button>
              <button type="button" onClick={() => setMcatMismatch(false)} className="px-2.5 py-1.5 rounded-lg text-xs text-amber-700 hover:bg-amber-100">It's correct</button>
            </div>
          </div>
        </div>
      )}
      {specsLoading && isqSpecs.length === 0 && extraKeys.length === 0 && (
        <p className="text-sm text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Fetching category spec fields…</p>
      )}
      {/* Retail-lite (buyer confirmed a personal/one-off buy, #75): show ONLY his own requirement fields (buyer specs +
          any extras). The B2B planner surfaces — conflicts, planner questions, ranked AI gaps, suggestions — are hidden. */}
      {!isRetailLite && conflictsSection}
      {visibleSpecs.map(renderSpecField)}
      {!isRetailLite && plannerQuestions}
      {!isRetailLite && aiSpecsBody}
      {!isRetailLite && suggestionsSection}
      {extrasSection}
      {!specsLoading && isqSpecs.length === 0 && extraKeys.length === 0 && !aiSpecsLoading && aiSpecs.length === 0 && <p className="text-sm text-gray-500">No standard spec fields for this product.</p>}
    </div>
  );

  // ── PAGE 2 & 3 · Commercial (LLM 2) + Persona (LLM 3), fed by the Requirement Brain assembled from the form ──
  const rfqBrain = useMemo<RequirementBrain>(() => {
    // ARCHITECTURE (#4): the CANONICAL Requirement Brain is LLM 1's OWN output (`rbBrain` from runRequirementBrain);
    // LLM 2 (Commercial) and LLM 3 (Persona) read THIS. When it has landed, it is returned verbatim.
    if (rbBrain && (rbBrain.understanding || rbBrain.persona_read)) return rbBrain;
    // FALLBACK CONTEXT (not the Requirement Brain — owner/review 2026-07-30). Until LLM 1 lands, LLM 2/3 must not
    // wait on it (CF-4 / "nothing holds for LLM 1"), so they are fed just-enough context assembled from form state.
    // It is DELIBERATELY not called a brain: it carries no persona_read/evidence and is only a non-blocking stopgap.
    const filled = { ...specValues, ...aiSpecValues };
    const specLine = Object.entries(filled).filter(([, v]) => (v || '').trim()).map(([k, v]) => `${k}: ${v}`).join(', ');
    const fallbackContext = buildFallbackBrain(productName, quantity, unit, specLine);
    return fallbackContext;
  }, [rbBrain, productName, quantity, unit, specValues, aiSpecValues]);
  // N-fix: include extraSpecs ("Also detected") in page1 so LLM 2/3 SEE them and the merge layer dedups against them
  // (they already ship on submit via allSpecEntries). specValues/aiSpecValues win on any key collision.
  const rfqSession = () => buildSession({ product: productName, quantity, mcatId, extraSpecs, specValues, aiSpecValues, cxAnswers, psAnswers });
  // DETERMINISTIC MERGE LAYER (plan §5 — cross-page exclusivity as CODE, not prompt-only; bug-hunt 2026-07-30). Drop
  // any planner question whose field the buyer has already answered/filled on an earlier page, BEFORE applyBudget so
  // the ask-budget counts only net-new questions. answeredKeys unions page1+page2+page3, so persona is deduped
  // against both specs and commercial in one call. Normalises the field key exactly as answeredKeys does.
  const dropAnswered = (env: PlannerEnvelope, extraShown: string[] = []): PlannerEnvelope => mergeLayer(env, rfqSession(), extraShown);
  // #G — publish the LIVE form state for the AI Inspector (plan §6 "live form state"), via a window global (the
  // same channel as window.__llmHealth / __decisionRouting) so the debug panel reads it without prop-threading
  // through the gate. AI-Debug only reads it; it never alters the buyer UI.
  useEffect(() => {
    try { (window as unknown as { __rfqLive?: unknown }).__rfqLive = { product: productName, quantity, unit, specs: { ...specValues, ...aiSpecValues }, commercial: cxAnswers, persona: psAnswers, contactName, userLocation, deliveryLocation, mcatId, mcatMismatch, catName, allSpecEntries, extraSpecs, requirementNotes }; } catch { /* noop */ } // widened for the debug BL-audit self-checklist (#66)
  }, [productName, quantity, unit, specValues, aiSpecValues, cxAnswers, psAnswers]);
  // The complete category corpus, published for the inspector (owner: "all of it is rendered in the debug, like all
  // questions from 1 till last"). `full` is the verbatim node payload; `distilled` is what the {q,pct,vals} contract
  // kept — showing both makes any future drop between them visible instead of silent.
  useEffect(() => {
    try { (window as unknown as { __rfqCategory?: unknown }).__rfqCategory = { at: Date.now(), mcatId, full: catCorpus, distilled: catTopSpecs ?? null }; } catch { /* noop */ }
  }, [mcatId, catCorpus, catTopSpecs]);
  // LLM 4 · Profile Synth — published for the 🔬 inspector ONLY. The FULL profile (incl. internal sales/trust/financial
  // fields + confidence + source + page-routing) is HOD-facing and must NEVER render inside the buyer's form; the buyer
  // sees only the safe high-confidence chips (see profileCard). The debug panel renders this global.
  useEffect(() => {
    try { (window as unknown as { __rfqProfileSynth?: unknown }).__rfqProfileSynth = profileSynth; } catch { /* noop */ }
  }, [profileSynth]);
  // C3 (2026-08-03) — EVERY page-1 field the buyer was SHOWN, answered or not: the buyer ISQ specs, LLM 1's own
  // generated questions, and the "also detected" extras. The merge layer needs this because `buildSession` builds
  // page1 from VALUES only, so a spec that rendered and was left blank is invisible to dedup and page 2 asks it
  // again. Labels are included alongside field names because the concept matcher checks both.
  const page1Shown = useMemo(() => [
    ...isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC),
    ...aiSpecs.map((q) => q.fieldName),
    ...Object.keys(extraSpecs),
  ].filter(Boolean), [isqSpecs, aiSpecs, extraSpecs]);
  // PlannerController (step 2, 2026-07-31): LLM 2 (Commercial) + LLM 3 (Persona) orchestration — the two firing
  // effects, their fire-once + fallback→real + no-category→category upgrade-refire guards, the deterministic
  // merge-layer dedup, and the fail/empty auto-skip — extracted into a hook. LLM 1 stays inline (too entangled).
  usePlannerController({
    stage, mcatId, rbBrain, rfqBrain, catTopSpecs, catCorpus, commercialPlan, commercialPlanRef, execMode, effort: effortMode, showGstOnPersona,
    page1Shown, setCxFailed, setPsFailed, profile: leafTruth?.profile, personaGate: _seed?.bulkGate,
    includeCommercial, includePersona, cxLoading, psLoading, brainInFlight, plannerRetry,
    pnsRef, stageRef, cxFiredFor, psFiredFor, cxUsedFallback, psUsedFallback, cxUsedNoCategory,
    cxPage1Snap, psPage2Snap, cxIsEmpty, psIsEmpty,
    setCxLoading, setPsLoading, setCommercialPlan, setPersonaPlan, setStage,
    session: rfqSession, dropAnswered,
  });
  // ── LLM 4 · Profile Synthesizer — rides the commit batch (fires the moment LLM 1's real brain lands, concurrently
  //    with LLM 2), reading ONLY buyer-level truth so it has no page dependency. Produces the last-page profile: the
  //    FULL internal read for the HOD debug + the buyer-SAFE, grounded, high-confidence subset the buyer sees. The
  //    flowMode==='static' guard below only skips the call in the race where the brain lands AFTER a retail buyer
  //    confirms — in the common ordering the synth has already fired at commit (before the retail answer flips
  //    flowMode), so retail buyers usually still incur ONE synth call. That's harmless: its output is neither shipped
  //    (not in the lead payload) nor shown (profileCard is `!isRetailLite`) — the same wasted-at-commit reality LLM 2/3
  //    already have. Once per mcat; reset with the product (near the commit block above). ──
  useEffect(() => {
    if (!mcatId || !hasFormLLM() || !haveRealBrain(rbBrain)) return;
    // #79: the last page (and its profile card) is gone, so LLM 4's output has no buyer-facing home — SKIP it in prod
    // entirely (not just for static/retail). Kept in AI-Debug so the HOD inspector can still see the profile read.
    if (execMode !== 'debug') return;
    if (synthFiredFor.current === mcatId) return;
    synthFiredFor.current = mcatId; setSynthLoading(true);
    const gen = ++synthGen.current;
    runProfileSynthesizer({ brain: rfqBrain, session: rfqSession(), profile: leafTruth?.profile, personaGate: _seed?.bulkGate, buyerSignals: _seed?.buyerSignals, enquiries: leafTruth?.enquiries }, execMode, effortMode)
      .then((r) => { if (gen === synthGen.current) setProfileSynth(r); })
      .catch((e) => { emitApiError('profileSynth', e, { mcatId }); })
      .finally(() => { if (gen === synthGen.current) setSynthLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId, rbBrain, execMode, flowMode]);
  // PREFILL LOSSLESSNESS (fix 2026-08-01): the renderer displayed `answers[field] ?? q.value`, but `q.value` was
  // never written INTO the answers map — so a prefill/confirm the buyer agreed with by not touching it was invisible
  // to both the merge layer and the submission. Seeding here (never clobbering a buyer edit, and keyed on the
  // envelope identity so a re-plan re-seeds) makes "left it alone" mean "accepted", which is what the UI implies.
  useEffect(() => {
    const seed = (env: PlannerEnvelope | null, set: React.Dispatch<React.SetStateAction<Record<string, string>>>, touched: React.MutableRefObject<Set<string>>) => {
      // 'suggest' joins prefill/confirm: an untouched suggested value the buyer accepts by leaving it must persist too.
      const pre = (env?.questions ?? []).filter((q) => (q.ui === 'prefill' || q.ui === 'confirm' || q.ui === 'suggest') && (q.value ?? '').trim());
      if (!pre.length) return;
      set((prev) => {
        const next = { ...prev }; let changed = false;
        // Seed/REFRESH a prefill unless the buyer has TOUCHED that field — so a re-fire replaces a stale auto-seed
        // (the old `q.field in next` guard blocked that), while a value the buyer typed/picked always stands.
        for (const q of pre) if (!touched.current.has(q.field) && next[q.field] !== q.value!.trim()) { next[q.field] = q.value!.trim(); changed = true; }
        return changed ? next : prev;
      });
    };
    seed(commercialPlan, setCxAnswers, cxTouched);
    seed(personaPlan, setPsAnswers, psTouched);
  }, [commercialPlan, personaPlan]);
  const renderCxPs = (env: PlannerEnvelope | null, loading: boolean, answers: Record<string, string>, setAns: (f: string, v: string) => void, emptyMsg: string, failed = false, onRetry?: () => void) => {
    // C10 (owner 2026-08-03): "on page 2 and page 3 we have nothing to show if some LLM call takes time or fails."
    // Three distinct states now, where there used to be one spinner and a shrug:
    //  · LOADING  — skeleton rows so the page has SHAPE while the planner thinks (a bare sentence reads as broken).
    //  · FAILED   — say so plainly and offer a retry, instead of silently auto-skipping the page.
    //  · EMPTY    — genuinely nothing to ask; the buyer may simply continue.
    if (loading && !env) return (
      <div className="space-y-5" aria-busy="true" aria-live="polite">
        <p className="flex items-center gap-2 text-sm text-gray-500"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />Preparing your questions…</p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse">
            <div className="mb-2 h-3.5 w-40 rounded bg-gray-200" />
            <div className="flex flex-wrap gap-2">
              {[0, 1, 2].map((j) => <div key={j} className="h-9 w-24 rounded-full bg-gray-100" />)}
            </div>
          </div>
        ))}
      </div>
    );
    if (failed && !env) return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-3" role="status">
        <p className="text-sm font-medium text-gray-900">We couldn&apos;t prepare these questions.</p>
        <p className="mt-0.5 text-[12.5px] text-gray-600">Nothing you&apos;ve entered is lost — you can continue, or try again.</p>
        {onRetry && <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-800 hover:bg-amber-50">Try again</button>}
      </div>
    );
    // BUYER-FACING HYGIENE at the render boundary (owner items 4b + 14, 2026-08-13):
    //  · DROP an illegal/irrelevant ask (GST-invoice/tax/payment-protection) that slipped past the prompt guard.
    //  · DOWNGRADE a supplier-type PREFILL/CONFIRM to a plain ASK — a preference from category dominance may never be
    //    pre-committed (UNSTATED-PREFERENCE guard); clear its value so nothing is pre-selected.
    //  · STRIP debug-reasoning markers ("PICKED: …") from every label/option/value so no internal analyst text renders.
    const qs = [...(env?.questions ?? [])]
      .filter((q) => !isIllegalQuestion(q.label, q.options ?? []))
      .sort((a, b) => a.order - b.order)
      .map((q) => {
        const downgrade = isSupplierPrefField(q.field || q.label) && (q.ui === 'prefill' || q.ui === 'confirm');
        const ui = downgrade ? 'ask' : q.ui;
        return { ...q, ui, label: cleanBuyerText(q.label), value: downgrade ? undefined : (q.value != null ? cleanBuyerText(q.value) : q.value), options: (q.options ?? []).map(cleanBuyerText) };
      });
    if (!qs.length) return <p className="text-sm text-gray-500">{emptyMsg}</p>;
    const kind = env?.planner === 'persona' ? 'ps' : 'cx';
    return (
      <div className="space-y-5">
        {qs.map((q) => {
          const shown = answers[q.field] ?? q.value ?? '';
          const prefilled = (q.ui === 'prefill' || q.ui === 'confirm') && !!(q.value ?? '').trim();
          return (
            // BES on pages 2/3 (was Page-1-and-last-page only, so the Buyer Effort Score was blind to exactly the
            // pages the 3-LLM work adds). A prefilled row the buyer leaves alone counts as a 'confirm', not an ask.
            <div key={q.field} ref={() => { bes('question_shown', `${kind}:${q.field}`); if (prefilled && !(q.field in answers)) bes('confirm', `${kind}:${q.field}`); }}>
              <label className="mb-1.5 block text-[14px] font-medium text-gray-900">{q.label}</label>
              {q.options?.length
                ? <OptionChips ariaLabel={q.field} options={q.options} value={shown} onChange={(v) => setAns(q.field, v)} />
                : prefilled
                  // A chip-less prefill/confirm used to render as a bare "Type your answer" text box pre-filled with
                  // OUR guess — the single most expensive interaction in the BES weighting, and the exact free-text
                  // fallback the option-based contract exists to prevent (only ui:'ask' is chip-filtered upstream).
                  // Render it as what it is: a value we already know, with an explicit way to change it.
                  // (OptionChips always renders its own "Other…" custom-value chip, which is the change affordance.)
                  ? <OptionChips ariaLabel={q.field} options={[shown]} value={shown} onChange={(v) => setAns(q.field, v)} />
                  : <input value={shown} onChange={(e) => setAns(q.field, e.target.value)} placeholder="Type your answer" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none" />}
            </div>
          );
        })}
      </div>
    );
  };
  // Retry clears the fire-once guard for that planner so the effect re-runs on the next render.
  const retryCx = () => { cxFiredFor.current = ''; setCxFailed(false); setCxLoading(true); setCommercialPlan(null); commercialPlanRef.current = null; setPlannerRetry((n) => n + 1); };
  const retryPs = () => { psFiredFor.current = ''; setPsFailed(false); setPsLoading(true); setPersonaPlan(null); setPlannerRetry((n) => n + 1); };
  // #76 fix: show the "preparing…" skeleton while the BRAIN is still in flight too (not just the planner) — a fast buyer
  // who reached page 2/3 before LLM 1 landed must see a loader, not a blank page, until the planner can fire on the real brain.
  const commercialBody = renderCxPs(commercialPlan, cxLoading || brainInFlight, cxAnswers, (f, v) => { cxTouched.current.add(f); setCxAnswers((p) => ({ ...p, [f]: v })); }, 'No commercial questions for this product.', cxFailed, retryCx);
  const personaBody = renderCxPs(personaRender, psLoading || brainInFlight, psAnswers, (f, v) => { psTouched.current.add(f); setPsAnswers((p) => ({ ...p, [f]: v })); }, 'No profile questions.', psFailed, retryPs);
  // GST question (yes/no + number) — rendered on the PERSONA page for a business (non-individual) persona (owner
  // 2026-07-31). Writes the REAL gstRegistered/gstNumber state; the last page echoes it. Individuals never see it.
  const gstQuestionBlock = showGstOnPersona ? (
    <div data-flash="gst" className="mt-4 pt-4 border-t border-gray-100">
      <p className="text-xs uppercase font-semibold text-gray-500 mb-1 tracking-wide">GST Registered?</p>
      <p className="text-[11px] text-gray-500 mb-2">Only shared with suppliers you contact.</p>
      <div className="flex flex-wrap gap-2">
        <RadioChip label="Yes" selected={gstRegistered === true} onClick={() => setGstRegistered(gstRegistered === true ? null : true)} />
        <RadioChip label="No" selected={gstRegistered === false} onClick={() => { setGstRegistered(gstRegistered === false ? null : false); setGstNumber(''); }} />
      </div>
      {gstRegistered === true && (
        <input type="text" aria-label="GST number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} placeholder="GST number (15 digits)" className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
      )}
    </div>
  ) : null;

  // GST-ABSENT VERIFICATION SPIRAL (owner #6): a business buyer with NO GST can OPTIONALLY add a business proof so
  // sellers trust him — Udyam / PAN / Aadhaar (+ business photo, a follow-up needing its own upload handler). LAST-PAGE
  // ONLY, always skippable.  ⚑ DPDP + KYC: these are sensitive personal/business IDs — kept in a SEPARATE `verification`
  // object (never the seller-facing requirement text) and must NOT actually ship until the KYC/verification endpoint +
  // a DPDP review are in place (flagged to owner).
  const verificationBlock = (isBusinessRole && gstRegistered === false) ? (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <button type="button" onClick={() => setVerifyOpen((o) => !o)} className="w-full flex items-center justify-between text-left" aria-expanded={verifyOpen}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800">Verify your business <span className="font-normal text-gray-400">(optional)</span></p>
          <p className="text-[11px] text-gray-500 mt-0.5">A verified buyer gets faster, better quotes. You can skip this.</p>
        </div>
        <ChevronDown size={16} className={`shrink-0 text-gray-400 transition-transform ${verifyOpen ? 'rotate-180' : ''}`} />
      </button>
      {verifyOpen && (
        <div className="mt-3 space-y-2.5">
          <input type="text" aria-label="Udyam registration number" value={verifyUdyam} onChange={(e) => setVerifyUdyam(e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, ''))} placeholder="Udyam registration no." className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          <input type="text" aria-label="PAN" value={verifyPan} onChange={(e) => setVerifyPan(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10))} placeholder="PAN (10 characters)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          <input type="text" inputMode="numeric" aria-label="Aadhaar" value={verifyAadhaar} onChange={(e) => setVerifyAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="Aadhaar (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          <p className="text-[11px] text-gray-400">Used only to verify your business. Never shown publicly or shared with sellers.</p>
        </div>
      )}
    </div>
  ) : null;

  // ── More Details (V3 renderDeliveryPage cards, deterministic) ──
  // #9 + concept-registry (2026-08-10): the last page must not re-ask a concept covered ANYWHERE earlier — not only by
  // the LLM-2 commercial plan. The old regex saw page 2 alone, so a Finance / Payment / Credit / Delivery ISQ spec on
  // (#79: coveredConcepts — which fed the last-page payment/timeline suppression — removed with the logistics page.)
  // ── Last-page pieces (#79: delivery is in the header now; logistics deleted). Contact = a COLLAPSED block at the
  //    BOTTOM of the last page (persona, or specs for a retail buyer). ──
  // #(owner): CONTACT + ABOUT YOU — ONE collapsed card (was two separate last-page blocks). Contact inputs always
  // render; the About-You fields (persona/company/business-type/industry/GST echo) fold in below a divider, gated
  // `!isRetailLite && aboutYouHasContent` so a retail/light buyer (whose last page is specs) never sees B2B fields.
  // Collapsed by default (contactOpen=false). A known-from-profile fact is shown BACK with its source, never silently
  // hidden — hiding a prefill breaks the trust receipt and the CONFIRMED stage of TUS.
  const showAboutYou = !isRetailLite && aboutYouHasContent;
  const contactBody = (
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <button type="button" onClick={() => setContactOpen((v) => !v)} className="w-full flex items-center justify-between">
          <span className="text-xs uppercase font-semibold text-gray-500 tracking-wide">Contact details{showAboutYou ? ' / About you' : ''}</span>
          {contactOpen ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-500" />}
        </button>
        {contactOpen && (
          <div className="space-y-3 mt-4">
            <input type="text" aria-label="Your name" autoComplete="name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400"><span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200">+91</span><input type="tel" aria-label="Mobile number" autoComplete="tel-national" value={contactMobile} onChange={(e) => setContactMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile" className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none" /></div>
            <input type="email" aria-label="Email address (optional)" autoComplete="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <textarea aria-label="Additional requirement details" value={requirementNotes} onChange={(e) => setRequirementNotes(e.target.value)} rows={2} placeholder="Any specific requirement, grade, packaging…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
            {/* ── ABOUT YOU (folded in from the old standalone card) — business-only, optional, prefilled from truth ── */}
            {showAboutYou && (
              <div className="pt-4 mt-1 border-t border-gray-100 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs uppercase font-semibold text-gray-500 tracking-wide">About you <span className="text-gray-500 normal-case font-normal">(optional)</span></p>
                  {isLoggedIn
                    ? <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 shrink-0"><CheckCircle2 size={14} /> {contactName || 'Logged in'}</span>
                    : <button type="button" onClick={handleLogin} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 shrink-0"><LogIn size={13} /> Login</button>}
                </div>
                {/* The demo stand-in, when it is switched on, says so on screen — a fabricated identity that looks
                    real is the whole problem this replaced (?demoIdentity=1). */}
                {DEMO_IDENTITY && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
                    Demo identity — these details are a stand-in for a demo, not this buyer&apos;s record.
                  </p>
                )}
                {/* HIS PERSONA — prefilled from truth and editable, marked with the AI icon and nothing else.
                    The owner banned any "from your call" provenance line here; the value shows, is his to change,
                    and personaSource still travels to the routing ledger (PERSON_PREFILL row). Do not add it back. */}
                {showPersonaField && (
                  <div data-flash="buyer-persona" className={flashCls('buyer-persona')}>
                    <label htmlFor="rfq-persona" className="block text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Your business<AiMark /></label>
                    <input id="rfq-persona" type="text" value={personaValue} onChange={(e) => { bes('text', 'persona-field'); setPersonaValue(e.target.value); }}
                      placeholder="e.g., Sweet-shop owner" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400" />
                  </div>
                )}
                <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
                  {showCompanyField && (
                  <div>
                    <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Company <span className="normal-case font-normal text-gray-400">· from your profile</span></p>
                    <input type="text" aria-label="Company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Your firm" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
                  </div>
                  )}
                  {showBuyerTypeField && (
                  <div data-flash="buyer-type" className={flashCls('buyer-type')}>
                    <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Business type</p>
                    <div className="flex flex-wrap gap-2">{BUSINESS_TYPES.map((t) => <RadioChip key={t} label={t} selected={buyerType === t} onClick={() => setBuyerType(buyerType === t ? '' : t)} />)}</div>
                  </div>
                  )}
                  {showIndustryField && (
                  <div data-flash="profile-detail" className={flashCls('profile-detail')}>
                    <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Industry</p>
                    <input type="text" aria-label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g., Construction" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
                  </div>
                  )}
                </div>
                {/* GST echo only (business roles): BADGE = verified on file · ANSWERED = confirmed the P3 question. The
                    real GST Yes/No ask stays a visible persona question (gstQuestionBlock), never inside this fold. */}
                {showGstBadge && (
                  <div data-flash="gst" className={`pt-4 border-t border-gray-100 ${flashCls('gst')}`}>
                    <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST</p>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1.5 text-[13px] font-medium text-green-700"><CheckCircle2 size={14} /> GST verified <span className="font-normal text-green-600/80">· from your IndiaMART profile</span></span>
                  </div>
                )}
                {showGstAnswered && (
                  <div data-flash="gst" className={`pt-4 border-t border-gray-100 ${flashCls('gst')}`}>
                    <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST</p>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-[13px] font-medium text-teal-800"><CheckCircle2 size={14} /> {gstRegistered ? 'Registered' : 'Not registered'} <span className="font-normal text-teal-700/80">· you answered this above</span></span>
                    {gstRegistered === true && (
                      <input type="text" aria-label="GST number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} placeholder="GST number (15 digits)" className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
  );

  // ── LLM 4 · Profile card (last page) ──────────────────────────────────────────────────────────────────────
  // The buyer sees only the SAFE, grounded, high-confidence subset (a de-jargoned "about your business" read); the
  // FULL profile — with per-field confidence, source and a page-routing recommendation — is HOD-only (AI-Debug),
  // because maturity/turnover/deal-readiness/decision-maker are internal sales signals a real buyer must never see.
  // The safe chips are DISPLAY only (grounded context) — they are not shipped to sellers as buyer-stated facts.

  // ── Curated sellers (results) — REAL data ──
  // Cards render the live ranked sellers from the windmill curated_seller_search API (src/lib/sellerSearch.ts),
  // fired back on the specs→page-2 move and streamed in here (sellerStatus: idle/loading→progress, done→cards,
  // error/empty→graceful message). ⚑ DEV-TODO: "Send Enquiry" / Call / WhatsApp are still DEMO CTAs — wire the
  //   real per-seller dispatch using s.id (glusrid); the BuyLead is already generated at submit via
  //   dispatchBuyLead, so gate "Enquiry sent" on a real POST when that endpoint is provided.
  //
  // SHAPE OF THE PAGE (owner: "top 3 as is order, and top 3 by location"): we no longer dump all 20 rows into one
  // carousel. `curateSellers` picks the top 3 by final_rank (hero carousel) + the top 3 by distance (compact rows
  // below), DE-DUPLICATED — a seller that earns both appears once, in the hero, carrying both ribbons. Every ribbon
  // and chip is derived from a field that actually exists in the response; the payload carries NO price, so there
  // is no price ribbon and no "Get Best Price" pill (it used to be a hardcoded string on every card — removed, it
  // was identical on all of them and occupied the slot the earned ribbons now use).
  // ── CLOSING PAGE · the curated-seller board ───────────────────────────────────────────────────────────────
  // CuratedSellerBoard owns this page end to end: the product + filled-specs strip with the pencil, the top-3 row
  // in the API's OWN final_rank order, the nearest-3 row sorted by real distance, and the loading / error / empty
  // states. Six cards — 3x2 on desktop, 2+1 rows on msite — sized to sit in the first fold without scrolling.
  //
  // `onEnquire` IS DELIBERATELY OMITTED, and that is the honest state rather than an oversight. There is no
  // per-seller dispatch endpoint anywhere: `dispatchBuyLead` is a stub that emits the funnel event and hands the
  // whole REQUIREMENT to the host `onSubmit`, and it has already fired by the time this page renders — so calling
  // it again per card would duplicate the BuyLead, not send a targeted enquiry. A card therefore carries no action
  // at all. That replaces a Call button with no onClick and a "Enquiry sent" toast that wrote local state and
  // POSTed nothing (design audit 2026-07-28). Wire it the moment a real per-seller endpoint exists — and confirm
  // to the buyer only after that POST resolves, never optimistically.
  //
  // nearestIsInTop: curateBoard fills row 2 with the nearest sellers NOT already in row 1, so all six cells are
  // distinct suppliers. When the single closest one sits up in row 1, the row-2 note has to say so — otherwise
  // that row's first card silently reads as "the nearest to you" when it is not.
  const board = curateBoard(sellerResults, (deliveryLocation || userLocation || detectedCity).trim());
  const resultsBody = (
    <CuratedSellerBoard
      productName={productName}
      filledSpecs={allSpecEntries.map(([field, value]) => ({ field, value }))}
      onEditSpecs={() => setStage('specs')}
      top={board.top}
      near={board.near}
      nearestIsInTop={board.nearDroppedToTop > 0}
      compact={isMobile}
      loading={sellerStatus === 'idle' || sellerStatus === 'loading'}
      error={sellerStatus === 'error'}
    />
  );

  // ── The single-panel (steps 1/2/results) — V3 chrome. ──
  const singlePanel = (
    // HD FIX: on the standalone full-page route the flow steps used to fill flex-1 edge-to-edge (~1600px) next to
    // the rail — cap + centre them so they stay readable. Widened 2026-07-28 (owner: "use the whole real estate as
    // much as possible") now that the rail carries no images and the flow is a single column: a measure that was
    // sized to sit beside a picture no longer has to. Mobile stays full-width; the popup is capped by shellWidth.
    <div className={`flex flex-col ${isMobile || standalone ? 'h-full' : 'h-[78vh] min-h-[560px] max-h-[92vh]'} min-h-0 ${standalone ? 'max-w-3xl lg:max-w-5xl w-full mx-auto' : ''}`}>
      {/* THE CLOSING PAGE HAS NO SHELL-HEADER PRODUCT IDENTITY (owner directive, 2026-07-28: "photo is not
          required on top when we land on last page"). On `results` the seller board already opens with the
          product name, its top specs and an edit pencil, so the header was printing the product name a SECOND
          time with an empty dashed camera box between the two. Suppressed for that ONE stage only — on landing /
          specs / specs2 / more this box is the real photo-upload affordance and stays exactly as it was. The
          flex-1 spacer is kept so the exit X stays on the right. */}
      <div className="px-5 pt-4 pb-0 flex items-center gap-3 shrink-0">
        {isMobile
          ? <>
              <button onClick={goBack} aria-label="Back" className="w-11 h-11 -ml-1.5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"><ArrowLeft className="w-5 h-5" /></button>
              {/* Carried-forward photo (owner): once a photo is attached it stays VISIBLE on specs/last page on mobile too
                  (desktop shows it in the header thumb below) — tap to change. Shown regardless of AI-extraction success. */}
              {imageBase64 && stage !== 'landing' && stage !== 'results' && <button onClick={() => fileRef.current?.click()} aria-label="Your product photo — tap to change" className="w-9 h-9 rounded-lg border border-gray-200 overflow-hidden shrink-0"><img src={`data:image/jpeg;base64,${imageBase64}`} className="w-full h-full object-cover" alt="Your product photo" /></button>}
            </>
          : stage !== 'results' && <button onClick={() => fileRef.current?.click()} aria-label={imageBase64 ? 'Your product photo — tap to change' : 'Add a product photo'} className="w-10 h-10 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-500 hover:border-teal-300 shrink-0 overflow-hidden">{imageBase64 ? <img src={`data:image/jpeg;base64,${imageBase64}`} className="w-full h-full object-cover rounded-xl" alt="Your product photo" /> : <Camera size={16} />}</button>}
        <div className="relative flex-1 min-w-0">
          {stage !== 'results' && <p className="font-bold text-teal-600 text-base leading-tight truncate">{productName}</p>}
          {/* #79 Move A: the delivery city lives in the HEADER now (visible text, not a hidden pill — honors the
              removed-pill lock), editable from the spec page on. Tapping it opens the location editor as a BOTTOM
              DRAWER on mobile (owner: drawers, never centered popups) / an anchored popover on desktop; Done → commitCity.
              Rendered ONCE here (the old spec-page-banner + logistics-row renders are removed) so it never doubles. */}
          {stage !== 'results' && stage !== 'landing' && (
            <button type="button" onClick={() => { setScoreOpen(false); setLocationEditing((v) => !v); }} className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 hover:text-teal-700 max-w-full" aria-label="Edit delivery city">
              <MapPin size={12} className="text-gray-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{(deliveryLocation || userLocation || detectedCity) ? `Deliver to: ${deliveryLocation || userLocation || detectedCity}` : 'Add delivery city'}</span>
              <Pencil size={10} className="text-gray-400 shrink-0" aria-hidden="true" />
            </button>
          )}
          {locationEditing && stage !== 'results' && stage !== 'landing' && renderLocationPopover('left')}
        </div>
        {/* (Desktop header delivery-pill removed — the city hid there; delivery now lives as a compact row in the
            Logistics card on BOTH surfaces, matching the mobile UI so the city is always visible — owner.) */}
        {!standalone && stage !== 'results' && scoreCircle}
        {/* Keyboard-safe mobile CTA (owner): the footer Next/Get-Quotes sits behind the on-screen keyboard on
            text-input stages, so mirror it into the always-visible header. Footer stays for the non-keyboard case. */}
        {isMobile && stage !== 'results' && (
          // #6 NON-BLOCKING (owner: "nothing holds for LLM 1"): Next is ALWAYS enabled on the spec page. The buyer
          // ISQ specs are already on screen and LLM 1 only HOT-ENHANCES them in the background — the stepper's
          // pulsing dot shows it is still working; the buyer is never made to wait on it. LLM 2/3 are the real gates.
          <button type="button" onClick={goNext} disabled={!isLastStep && nextBlocked} className={`flex items-center gap-1 shrink-0 text-sm font-semibold min-h-[40px] px-4 py-2 rounded-lg ${(!isLastStep && nextBlocked) ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : CTA_ADVANCE}`}>
            {(!isLastStep && nextBlocked) ? <><span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />Preparing…</> : <>{isLastStep ? 'Get Quotes' : 'Next'} <ArrowRight size={13} /></>}
          </button>
        )}
        {!isMobile && !standalone && <button onClick={handleExit} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 ml-1 shrink-0"><X size={14} /></button>}
      </div>
      {/* THE NUMBERED STEPS — 3 when the spec page splits, 2 when it does not (owner 2026-07-28). Rendered from
          the same `stepper` array every other derived value reads, and the circle carries the step NUMBER, so
          what the buyer reads here ("1 · Specifications") is always the count the footer's "Step 1 of N" states.
          The landing is the entry and has no node: it is not a step he can be sent back to a number for. Passed
          nodes are clickable; a green blinking dot sits on Specifications while the smart questions load. */}
      {stage !== 'results' && <>
      <div className="mx-5 mt-3 flex items-center gap-1 shrink-0 overflow-x-auto scroll-auto-hide" role="list" aria-label={`Step ${stageNodeIdx(stage)} of ${stepCount}`}>
        {stepper.map((node, i) => {
          const cur = stageNodeIdx(stage);
          const ni = stageNodeIdx(node.stage);   // the node's OWN flow position = its step number
          const done = ni < cur, active = ni === cur, clickable = ni <= cur;
          const running = node.stage === 'specs' && aiSpecsLoading;
          return (
            <div key={node.stage} role="listitem" className="flex items-center gap-1 shrink-0">
              <button type="button" disabled={!clickable} onClick={() => goToNode(node.stage)} aria-label={`Step ${ni} of ${stepCount} — ${node.label}`} aria-current={active ? 'step' : undefined}
                className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[11px] font-semibold transition-colors ${active ? 'text-teal-700' : done ? 'text-teal-600 hover:bg-gray-50' : 'text-gray-300 cursor-default'}`}>
                <span className={`relative w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold ${active ? 'bg-teal-600 text-white' : done ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'}`}>
                  {done ? '✓' : ni}
                  {running && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 ring-2 ring-white animate-pulse" />}
                </span>
                {/* Show only the ACTIVE label until there's real room (lg+) — "Your Profile & Delivery" is long
                    and both labels together overflowed the stepper at narrow/zoomed desktop widths. */}
                <span className={`whitespace-nowrap ${active ? '' : 'hidden lg:inline'}`}>{node.label}</span>
              </button>
              {i < stepper.length - 1 && <span className={`h-px shrink-0 ${isMobile ? 'w-3' : 'w-2.5'} ${done ? 'bg-teal-300' : 'bg-gray-200'}`} />}
            </div>
          );
        })}
      </div>
      <div className="mx-5 mt-2 h-0.5 bg-gray-100 rounded-full overflow-hidden shrink-0"><div className="h-full bg-teal-500 rounded-full transition-all duration-500" style={{ width: progressPercent + '%' }} /></div>
      </>}
      {aiBusy && <div role="status" aria-live="polite" className="shrink-0 mx-5 mt-2 px-3 py-1.5 flex items-center gap-2 text-[12px] text-teal-700 bg-teal-50 rounded-lg"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</div>}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div ref={bodyScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-auto-hide px-5 py-5">
          {/* TOP OF THE SPEC PAGE (owner 2026-07-28): the use-case assist, and nothing else above the questions.
              Two things that used to sit here are gone:
                · THE OFFER STRIP ("Source your notebook machine and raw material together?") — owner: "what is
                  this section, why we need this". See OFFER_NOT_RENDERED.
                · THE PREFILL RECEIPT ("Filled from your history — Capacity (Weight): 200 g · your call with a
                  seller / Application: Ladoo Packaging · what you typed") — owner: "do we need these lines .. just
                  put an AI icon for pre filled specs". It was also the biggest single leak of the fact that we
                  read his phone calls. Each prefilled spec now carries `AiMark` on its own label instead, and it
                  renders as its full option group with the value selected (spec page 2 when the split fires).
              Nothing was lost: every prefill / observed value / pre-answer is a row in the routing ledger with
              its full provenance, which is what the debug panel reads. */}
          {/* (The spec-page use-case-assist "✦" was REMOVED here 2026-08-14 — see the note at its former const site.
              The assist chat is now landing-only, so nothing renders on the spec page.) */}
          {/* The buyer-aware opening question no longer has a boxed card of its own — it renders inside specBody
              with the same label + chips UI as every other spec (owner 2026-07-28). */}
          {/* aiSpecsBody is no longer a sibling here — it renders INSIDE specBody, between the opening question
              and the ISQ spec list, so the planner's ranked questions are one contiguous run. */}
          {/* #79: the 'more' page is DELETED. Persona is the last page for a full buyer; specs is the last page for a
              retail/static buyer. The last page carries the About-You + verification + a COLLAPSED contact block, and
              its footer button is "Get Quotes" (submit). Delivery city → header; consent step + Review modal removed;
              LLM 4 profile card gone. Contact rides `isLastStep` so it lands on whichever page is actually last. */}
          {stage === 'specs' ? <>{specBody}{isLastStep && contactBody}</>
            : stage === 'commercial' ? <>{commercialBody}{isLastStep && contactBody}</>
            : stage === 'persona' ? <>{personaBody}{gstQuestionBlock}{verificationBlock}{contactBody}</>
            : resultsBody}</div>
        {/* Subtle "more below" hint — appears only when the body overflows + not at the end; tap to scroll on. */}
        {showScrollHint && (
          <button type="button" aria-label="Scroll down for more" onClick={() => bodyScrollRef.current?.scrollBy({ top: bodyScrollRef.current.clientHeight * 0.8, behavior: 'smooth' })} className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center w-7 h-7 rounded-full bg-amber-100/90 text-amber-500 ring-1 ring-amber-200 shadow-[0_2px_8px_-1px_rgba(0,0,0,0.15)] backdrop-blur-sm animate-bounce">
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      {/* Footer = DESKTOP only. On mobile it's redundant: the header has the ← back-arrow + the sticky Next/
          Get-Quotes CTA (keyboard-safe), and the stepper shows the step — so the bottom bar is dropped (owner). */}
      {stage !== 'results' && !isMobile && (
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between gap-2 bg-white shrink-0">
          <button onClick={goBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 font-medium shrink-0">← Back</button>
          <span className="text-teal-600 font-medium text-center min-w-0 px-1 leading-tight">
            <span className="sm:hidden text-xs">Step {stageNodeIdx(stage)}/{stepCount}{isLastStep ? ' · Last!' : ''}</span>
            <span className="hidden sm:inline text-sm truncate">Step {stageNodeIdx(stage)} of {stepCount}{isLastStep ? ' · Last step!' : ''}</span>
          </span>
          {/* The LAST node submits; every earlier node advances through `stepper` via goNext. #6 NON-BLOCKING:
              Next is never held on LLM 1 — the buyer ISQ specs are on screen and LLM 1 only hot-enhances them. */}
          {isLastStep
            ? <button onClick={submit} className={`flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg shrink-0 ${CTA_ADVANCE}`}>Get Quotes <ArrowRight size={15} /></button>
            : <button onClick={goNext} disabled={nextBlocked} className={`flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg shrink-0 ${nextBlocked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : CTA_ADVANCE}`}>{nextBlocked ? <><span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />Preparing…</> : <>Next <ArrowRight size={15} /></>}</button>}
        </div>
      )}
      {isMobile && <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={handleExit} className="text-sm text-gray-500 underline underline-offset-2">Exit</button></div>}
    </div>
  );

  // ═══ THE LANDING (the entry, not a numbered step) ══════════════════════════════════════════════════════
  // ONE surface, three jobs: name the product, set or confirm the quantity, or continue from something he
  // already told us. The chooser used to be a page of its OWN in BrainFormGate, which meant the buyer walked
  // through two near-identical "name your product" screens before he could type a character. It is now the
  // same page as the input and the qty ask; when he leaves it, the next thing he sees is the spec page.
  //
  // Once he starts naming a product he has left the "continue where you left off" job, so his history
  // collapses out of the way. That is also why there is no "Brand-new requirement" CTA — typing a name IS
  // that path, and quantity is asked right here like it is for any other entry.
  const naming = !!productName.trim();
  // NEWEST FIRST, undated entries LAST — unknown recency is not the same as recent, so an undated card sinks
  // instead of being dropped or silently treated as today.
  const byRecency = (a: LandingRec, b: LandingRec) =>
    (a.age_days ?? Number.MAX_SAFE_INTEGER) - (b.age_days ?? Number.MAX_SAFE_INTEGER);
  // Requirements and browsed products are the SAME data, split by action: enrich/repost are things he
  // EXPRESSED, `new` is something he only looked at. That split is the fabrication firewall, in the UI.
  const reqCards = useMemo(() => (landing?.recs ?? []).filter((r) => r.action !== 'new').slice().sort(byRecency), [landing]);
  const browsedCards = useMemo(() => (landing?.recs ?? []).filter((r) => r.action === 'new').slice().sort(byRecency), [landing]);
  const hasHistory = !naming && (reqCards.length > 0 || browsedCards.length > 0);
  // ONE phrasing for recency everywhere it appears, so a card, a tile and a chip never disagree.
  const ago = (d?: number | null) =>
    d == null ? null : d === 0 ? 'today' : d === 1 ? 'yesterday'
    : d < 30 ? `${d}d ago` : d < 60 ? 'last month' : `${Math.round(d / 30)} months ago`;
  const freshCls = (d?: number | null) => (d != null && d < 7 ? 'text-teal-700' : 'text-gray-500');
  const statusOf = (r: LandingRec) =>
    r.is_expired ? { label: '', cls: 'bg-gray-100 text-gray-600 ring-gray-200' }  // enhancement: drop the "Expired" keyword — the "Repost →" CTA carries it
    : /pending|await/i.test(String(r.status ?? '')) ? { label: 'Awaiting approval', cls: 'bg-amber-50 text-amber-700 ring-amber-200' }
    : { label: 'Active', cls: 'bg-teal-50 text-teal-700 ring-teal-200' };

  // TWO CARD UIs, NO PLACEHOLDER (owner 2026-08-13): the empty grey image slot on landing was an eyesore. Now the
  // thumbnail renders ONLY when a real image exists (with-image variant); with none, the card is clean text-only
  // (without-image variant) — no reserved frame. A broken image URL collapses its box on error (falls back to text).
  // A requirement he expressed — status-first, so he reads it the way he thinks about it.
  const recCard = (r: LandingRec, i: number) => {
    const st = statusOf(r);
    return (
      <button key={`${r.action}-${i}-${r.product}`} type="button" onClick={() => landing?.onPick(r)}
        className="group flex flex-col rounded-xl border border-gray-200 bg-white p-3.5 text-left transition-shadow hover:border-teal-300 hover:shadow-md active:border-teal-300">
        <div className="flex items-start gap-3">
          {/* WITH-IMAGE variant only: render the 80×80 thumbnail when a real image exists; otherwise the card is text-only
              (no reserved empty frame). A broken URL collapses the box on error so it never shows an empty grey slot. */}
          {r.image && (
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-gray-100">
              <img src={r.image} alt="" className="absolute inset-0 h-full w-full bg-gray-50 object-contain" onError={(e) => { const b = e.currentTarget.parentElement as HTMLElement | null; if (b) b.style.display = 'none'; }} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[14px] font-semibold leading-snug text-gray-900">{r.product}</p>
            <p className={`mt-0.5 text-[11.5px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ?? 'date unknown'}</p>
            {r.specs?.length ? <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-gray-500">{r.specs.slice(0, 3).map((sp) => `${sp.name}: ${sp.value}`).join(' · ')}</p> : null}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-100 pt-2.5">
          {st.label && <span className={`mr-auto rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${st.cls}`}>{st.label}</span>}
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${ACTION_TONE[r.action] ?? ACTION_TONE.new} group-hover:brightness-95`}>{ACTION_LABEL[r.action] ?? 'Source'} →</span>
        </div>
      </button>
    );
  };
  // Something he only VIEWED — image-first, title under the image (the marketplace product-tile pattern),
  // and framed honestly as "not requested yet".
  const browsedTile = (r: LandingRec, i: number) => (
    <button key={`viewed-${i}-${r.product}`} type="button" onClick={() => landing?.onPick(r)}
      className={`shrink-0 snap-start rounded-xl border border-gray-200 bg-white p-2.5 text-left transition-shadow hover:border-teal-300 hover:shadow-md active:border-teal-300 ${isMobile ? 'w-[62%] max-w-[190px]' : 'w-[168px]'}`}>
      {r.image && (
        <div className={`relative flex items-center justify-center overflow-hidden rounded-lg ${isMobile ? 'h-[86px]' : 'h-[112px]'}`}>
          <img src={r.image} alt="" className="absolute inset-0 h-full w-full bg-gray-50 object-contain p-1.5" onError={(e) => { const b = e.currentTarget.parentElement as HTMLElement | null; if (b) b.style.display = 'none'; }} />
        </div>
      )}
      <p className="mt-1.5 line-clamp-2 text-[12.5px] font-medium leading-snug text-gray-800">{r.product}</p>
      <p className={`text-[11px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ? `viewed ${ago(r.age_days)}` : 'viewed recently'}</p>
      {r.specs?.length ? <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-gray-500">{r.specs.slice(0, 3).map((sp) => `${sp.name}: ${sp.value}`).join(' · ')}</p> : null}
    </button>
  );

  // The chooser. ONE CARD, on EVERY surface (owner 2026-07-28): msite already showed only the most recent
  // requirement with everything older behind a small "+N more" CTA, the owner called that exactly right, and
  // asked for all three surfaces to match. The popup and the standalone page used to open with a 4-card grid.
  // Owner: "the more the clutter the more the user will flake away." `wide` now only chooses the LAYOUT the
  // expanded list uses (a 2-up grid where there is width, a stack on msite), never how many cards show first.
  // The "N requirements · newest first" subtitle is gone with it — the count is already in the expander, and
  // "newest first" describes a sort the buyer cannot see the alternative to.
  const HISTORY_COLLAPSED = 1;
  const historySection = (wide: boolean) => !hasHistory ? null : (
    <div className={wide ? 'mt-7' : 'mt-6'}>
      {reqCards.length > 0 && (<>
        <h2 className="text-[14.5px] font-semibold text-gray-900">Continue where you left off</h2>
        <div className={`mt-2.5 ${wide && showAllHistory ? 'grid grid-cols-1 gap-3 sm:grid-cols-2' : 'space-y-2'}`}>
          {(showAllHistory ? reqCards : reqCards.slice(0, HISTORY_COLLAPSED)).map(recCard)}
        </div>
        {reqCards.length > HISTORY_COLLAPSED && (
          <button type="button" onClick={() => setShowAllHistory((v) => !v)} className="mt-2 text-[12px] font-medium text-teal-700 hover:text-teal-800">
            {showAllHistory ? '− Show fewer' : `+ ${reqCards.length - HISTORY_COLLAPSED} more requirement${reqCards.length - HISTORY_COLLAPSED > 1 ? 's' : ''}`}
          </button>
        )}
      </>)}
      {browsedCards.length > 0 && (<>
        <div className="mt-6 flex items-baseline justify-between gap-3">
          <h2 className="text-[14.5px] font-semibold text-gray-900">Products you viewed</h2>
        </div>
        {/* ~1.5 tiles visible, so the cut-off edge advertises the scroll without spending vertical space. */}
        <div className={`scroll-auto-hide mt-2.5 flex snap-x gap-2.5 overflow-x-auto pb-1.5 ${isMobile ? '-mx-4 px-4' : ''}`}>
          {browsedCards.map(browsedTile)}
        </div>
      </>)}
    </div>
  );

  // ── THE LEFT PANEL (owner-locked) ──────────────────────────────────────────────────────────────────────
  // BLANK on arrival — never a presumed image. Once the product is known (and its category actually defines
  // a quantity, which is the only case where this page is shown at all) it carries 3-4 representative
  // photos, LABELLED so a catalogue image can never be mistaken for the buyer's own. No image panel on
  // msite at all (owner: the image version isn't needed on mobile).
  // No longer takes a `compact` flag: it existed only to hide the value-prop pair on the standalone page, and
  // that pair is now deleted on every surface, so the popup and the page render the identical thing.
  const imageStrip = (
    <>
      {productImages.length > 0 ? (
        <div className="w-full">
          <div className="relative w-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-teal-100" style={{ aspectRatio: '4/3' }}>
            {/* Hero uses the 500×500 imimg variant (thumbnails stay small) — kills the stretch-blur. */}
            <img src={upsizeImimg(productImageUrl || productImages[0])} alt={productName} className="h-full w-full object-contain p-4" />
          </div>
          {productImages.length > 1 && (
            <div className="mt-2 flex gap-2">
              {productImages.slice(0, 4).map((img) => (
                <button key={img} type="button" onClick={() => setProductImageUrl(img)} aria-label="Show this image"
                  className={`min-h-[44px] flex-1 overflow-hidden rounded-lg bg-white transition ${productImageUrl === img ? 'ring-2 ring-teal-500' : 'ring-1 ring-gray-200 hover:ring-teal-300'}`} style={{ aspectRatio: '1/1' }}>
                  <img src={img} alt="" className="h-full w-full object-contain p-1.5" />
                </button>
              ))}
            </div>
          )}
          {/* THE LABEL. Not a tooltip — it sits under the pictures, always, in plain words (owner 2026-07-28:
              "tell the user it is product search, those images are just for reference"). */}
          <p className="mt-2 text-[11px] leading-snug text-gray-500">
            From product search on IndiaMART for “{productName}” — for reference, not your own. Add yours with the camera.
          </p>
        </div>
      ) : imgPanelState === 'loading' ? (
        <div className="flex w-full items-center justify-center rounded-2xl border border-teal-100 bg-white/70" style={{ aspectRatio: '4/3' }}>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal-300 border-t-transparent" />
        </div>
      ) : (
        // NO IMAGES YET → Simple RFQ form's landing illustration (owner 2026-07-29: popup left = "Simple RFQ left
        // section"). A document + a teal paper-plane, plus the "Looking to buy X?" line — the friendly panel Simple
        // shows before a product resolves, instead of a blank white box.
        <div className="flex w-full flex-col items-center gap-4">
          <div className="flex w-full items-center justify-center rounded-2xl border border-teal-100 bg-white/70" style={{ aspectRatio: '4/3' }}>
            <svg width="118" height="118" viewBox="0 0 118 118" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="27" y="24" width="52" height="66" rx="5" fill="#fff" stroke="#99f6e4" strokeWidth="2.5" />
              <line x1="37" y1="40" x2="69" y2="40" stroke="#5eead4" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="37" y1="52" x2="69" y2="52" stroke="#99f6e4" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="37" y1="64" x2="57" y2="64" stroke="#99f6e4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M58 74 L100 58 L82 96 L74 82 Z" fill="#14b8a6" />
              <path d="M100 58 L74 82 L82 96 Z" fill="#0d9488" />
              <path d="M100 58 L74 82" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="px-2 text-center">
            <p className="text-base font-bold leading-snug text-teal-700">{productName ? `Looking to buy ${productName}?` : 'Looking to buy something?'}</p>
            <p className="mt-1 text-[12px] text-gray-500">Just a few simple steps to get quotes from verified suppliers.</p>
          </div>
        </div>
      )}
    </>
  );
  // POPUP left panel — the LANDING ONLY (owner 2026-07-28, reversing "it stays for the whole flow"): "once we
  // move away from landing page why do we need that image section, wrong... use the whole real estate as much as
  // possible." It earns its 38% while the buyer is deciding WHAT to buy; once he is answering specs about a
  // product he has already named, catalogue photos of other sellers' goods are just a third of the popup he
  // cannot use. The flow pages are one full-width column instead (see the popup shell at the bottom).
  const imagePanel = (
    <aside className="hidden w-[38%] shrink-0 flex-col justify-center gap-4 bg-teal-50/70 p-6 sm:flex">
      {imageStrip}
    </aside>
  );

  // The landing's own CTA. Quantity + unit are optional (owner) — a committed, resolved product is enough.
  const landingContinue = (
    <button type="button" data-continue disabled={!canContinueProduct || retailChecking || !!aiBusy} onClick={() => canContinueProduct && tryAdvanceToSpecs()}
      className={`flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold transition-colors ${canContinueProduct && !retailChecking && !aiBusy ? CTA_ADVANCE : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
      {/* #76 fix: hold Continue while a photo/mic is still analyzing — else LLM 1 fires on page 1 before the extraction's
          findings land in the bundle (aiBusy is the extractor's in-flight flag; it clears the moment analysis resolves). */}
      {retailChecking ? <><span className="w-4 h-4 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />Checking…</> : aiBusy ? <><span className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />Reading…</> : <>Continue <ArrowRight size={16} /></>}
    </button>
  );

  // ── MSITE landing: single column, NO image panel (owner). Compact green band carries the one job. ──
  const landingMobile = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 pb-2 pt-3">
        <button onClick={onClose} aria-label="Back" className="-ml-1.5 flex h-11 w-11 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1"><p className="text-[15px] font-bold leading-tight text-teal-600">Post a Requirement</p><p className="text-[11px] text-gray-500">Tell us what you need</p></div>
      </div>
      {aiBusy && <div className="flex shrink-0 items-center gap-2 bg-teal-50 px-4 py-1.5 text-[12px] text-teal-700"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />{aiBusy}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* NEUTRAL hero (owner decision 2026-07-28, design-guide conformance). The guide's colour rules say of
            Primary Teal: "Never use as large area fill" — this band was a teal→emerald gradient at roughly 10% of
            the msite viewport. Surface is the guide's own --background / neutral-100, hsl(220,20%,97%), with its
            border token beneath; teal now survives only where the guide puts it (the title, links, the CTA). Text
            stays on the repo's gray idiom rather than the guide's neutral hsl() ramp, so it matches the headings
            immediately below it — converting gray→neutral globally is the separate token sweep. */}
        {/* ONE HEADING PER LANDING (owner 2026-07-28). This band used to carry a SECOND hero pair — "Post a
            requirement, get quotes / We'll only ask what a seller genuinely needs to quote." — directly under the
            header's "Post a Requirement / Tell us what you need". Owner: "keep only 1 there is repetition …
            'Tell us what you need' is sufficient. use this in desktop and standalone as well." So the band is
            now just the input; the header pair above it is the heading, on all three surfaces. */}
        <div className="bg-[hsl(220,20%,97%)] border-b border-[hsl(220,10%,84%)] px-4 pb-4 pt-3.5">
          {productInputRow}
        </div>
        <div className="px-4 py-4">
          {qtyUnitBlock}
          {committed && <div className="mt-4">{landingContinue}</div>}
          {historySection(false)}
        </div>
      </div>
      <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={onClose} className="text-sm text-gray-500 underline underline-offset-2">Exit</button></div>
    </div>
  );

  // ── POPUP landing: the right half of the two-panel shell. Same height contract as singlePanel so the
  //    image panel beside it stretches to exactly the same box on every page of the flow. ──
  const landingPopup = (
    <div className="relative flex h-[78vh] min-h-[560px] max-h-[92vh] flex-col">
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"><X size={16} /></button>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-auto-hide p-7">
        {/* THE SAME ONE HEADING AS MSITE (owner: "use this in desktop and standalone as well"). Was "What are
            you looking for?" — a third variant of the same sentence across three surfaces. */}
        <div className="pr-10">
          <p className="text-xl font-bold leading-tight text-gray-900">Post a Requirement</p>
          <p className="mt-0.5 text-[13px] text-gray-500">Tell us what you need</p>
        </div>
        <label className="mb-2 mt-5 block text-sm font-semibold text-gray-700">Enter Product/Service name <span className="text-red-500">*</span></label>
        {productInputRow}
        {aiBusy &&<p role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-[12px] text-teal-700"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />{aiBusy}</p>}
        {qtyUnitBlock}
        {historySection(true)}
      </div>
      <div className="shrink-0 border-t border-gray-100 bg-white px-7 py-4">{landingContinue}</div>
    </div>
  );

  // ── STANDALONE landing: a CONTENT COLUMN beside the persistent score rail (owner 2026-07-29: "for standalone
  //    score dial and checklist rail"). NOT a full-width hero and NOT the product-search images (those are the
  //    popup's left panel) — on standalone the left is the score-dial + Product/Specs/Details checklist, exactly
  //    as SimpleRFQForm does on its standalone page. So this is just the input + quantity + his history, in a
  //    readable column; the rail (enabled for the landing in the shell below) provides the left context. ──
  const landingStandalone = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <h1 className="text-[26px] font-bold leading-tight text-gray-900">Post a Requirement</h1>
        <p className="mt-1.5 text-[13.5px] text-gray-600">Tell us what you need</p>
        <div className="mt-5 rounded-xl shadow-[0_4px_12px_-2px_rgba(30,42,58,0.08)]">{productInputRow}</div>
        {aiBusy && <p role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-[12px] text-teal-700"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />{aiBusy}</p>}
        {committed && (
          <div className="mt-4 rounded-xl border border-gray-200 p-4 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)] sm:p-5">
            {qtyUnitBlock}
            <div className="mt-4 max-w-xs">{landingContinue}</div>
          </div>
        )}
        {historySection(true)}
      </div>
    </div>
  );

  const landingStep = isMobile ? landingMobile : standalone ? landingStandalone : landingPopup;
  // POPUP WIDTH (owner 2026-07-28: "make the popup larger across all pages, for desktop we have space").
  // The landing is the two-panel and needs the width; the FLOW pages now need it for a different reason — with
  // the image panel gone they are one full-width column, so the old max-w-5xl left the desktop popup narrower
  // than the screen can carry for no benefit. The CLOSING page keeps its own narrower measure untouched (the
  // seller cards read better in a tighter column, and that page is owned elsewhere).
  const shellWidth = stage === 'results' ? 'max-w-2xl lg:max-w-3xl' : 'max-w-5xl xl:max-w-6xl';

  // Full-page LEFT rail = the STANDALONE surface's left panel on the flow pages. It carries the RFQ score +
  // breakdown + "fill next". The catalogue PHOTOS were removed from it 2026-07-28 (owner: images belong to the
  // landing only) — the DIAL stays, which is the whole reason this rail exists on the flow pages.
  const scoreRail = (
    <aside className="hidden md:flex w-72 lg:w-80 shrink-0 flex-col border-r border-gray-200 bg-white p-6 gap-6 h-full overflow-y-auto scroll-auto-hide">
      <div>
        <p className="font-bold text-teal-600 text-lg leading-tight">Post a Requirement</p>
        <p className="text-xs text-gray-500 mt-0.5">Get quotes from verified suppliers</p>
      </div>
      <div className="flex flex-col items-center">
        <div className="relative w-28 h-28">
          <svg viewBox="0 0 44 44" className="w-28 h-28 -rotate-90">
            <circle cx="22" cy="22" r="18" fill="none" stroke="#e5e7eb" strokeWidth="3" />
            <circle cx="22" cy="22" r="18" fill="none" stroke={getScoreColor(scoreDetails.total)} strokeWidth="3" strokeDasharray={`${(scoreDetails.total / 100) * 113.1} 113.1`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.5s ease' }} />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-3xl font-extrabold" style={{ color: getScoreColor(scoreDetails.total) }}>{scoreDetails.total}</span>
        </div>
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-2">{getScoreLabel(scoreDetails.total)} · RFQ strength</span>
      </div>
      <div className="space-y-3 flex-1 overflow-y-auto scroll-auto-hide">
        {(['Product', 'Specs', 'Details'] as const).map((g) => {
          const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
          if (!items.length) return null;
          return (
            <div key={g}>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{g}</p>
              {items.map((c) => (
                <button type="button" key={c.label} onClick={() => jumpToCheck(c)} className="w-full flex items-center justify-between py-1 px-1 -mx-1 rounded-md hover:bg-gray-50 text-left transition-colors group/row">
                  <span className={`flex items-center gap-2 text-sm ${c.done ? 'text-gray-700' : 'text-gray-500 group-hover/row:text-gray-700'}`}>
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0 ${c.done ? 'bg-teal-500 text-white' : 'border border-gray-300'}`}>{c.done ? '✓' : ''}</span>
                    {c.label}
                  </span>
                  {!c.done ? <span className="flex items-center gap-1 text-xs text-gray-500 font-medium"><span className="opacity-0 group-hover/row:opacity-100 text-teal-500 transition-opacity">Go</span>+{c.pts - c.earned}</span> : <ChevronRight size={13} className="text-gray-200 group-hover/row:text-gray-500" />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {nextCheck && <button type="button" onClick={() => jumpToCheck(nextCheck)} className="w-full text-left text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 hover:bg-amber-100 transition-colors"><span className="flex items-center justify-between"><span className="font-semibold uppercase tracking-wide text-[11px] text-amber-600">Fill next</span><ArrowRight size={12} /></span>{nextCheck.label} <span className="font-semibold">+{nextCheck.pts - nextCheck.earned}</span></button>}
      <button type="button" onClick={handleExit} className="self-start text-sm text-gray-500 underline underline-offset-2 hover:text-gray-600">← Exit</button>
    </aside>
  );

  // ═══ ONE DESIGN LANGUAGE, THREE SURFACES ═══════════════════════════════════════════════════════════════
  // The reference is SimpleRFQForm's desktop popup: a left/right two-panel, image on the left, the work on
  // the right. Each surface speaks it in its own register rather than being handed the same box:
  //   POPUP      — the two-panel itself, and it holds for the WHOLE flow (landing · specs · last page), so
  //                the product the buyer is describing stays on screen while he describes it.
  //   STANDALONE — the same language composed as a PAGE (owner: "standalone shouldn't feel like a stretched-out
  //                popup"): a wide hero + card grid on the landing, and on the flow pages the context RAIL is
  //                the left panel — it carries the score AND the same labelled catalogue photos.
  //   MSITE      — the same components, one column, NO image panel at all (owner).
  // "Fill using AI" FLOATER — LANDING ONLY. Anchored to the FORM PANEL (absolute) so it stays INSIDE the popup/mobile
  // card instead of the viewport corner (owner 2026-08-12: "spilling outside the page"). Each surface panel is a
  // positioning context (mobile = absolute inset-0, popup = relative, standalone content = relative). z-[60] floats
  // above the panel content, below the assist/voice/OTP overlays (z-70/80).
  // Only on the PRE-COMMIT landing (the recommendations / search screen). Once a product is committed the buyer is on
  // the product/quantity "page 1", where a "describe your requirement" entry is redundant (owner 2026-08-12).
  const fillUsingAiFab = stage === 'landing' && !committed && hasFormLLM() ? (
    <button type="button" onClick={() => setAssistOpen(true)} aria-label="Fill using AI — chat to describe your requirement"
      className="absolute bottom-5 right-5 z-[60] flex items-center gap-2 rounded-full bg-teal-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-teal-600/30 transition hover:bg-teal-700 active:scale-95">
      <Sparkles size={16} /> Fill using AI
    </button>
  ) : null;
  return (
    <>
      {isMobile ? (
        <div role="dialog" aria-modal="true" aria-label="Post a Requirement" className={`${themeClass} absolute inset-0 z-50 bg-white flex flex-col animate-modal-in`} style={{ height: '100%' }}>
          {stage === 'landing' ? landingStep : singlePanel}
          {fillUsingAiFab}
        </div>
      ) : standalone ? (
        // Standalone full-page route (?rfq=…): a REAL IndiaMART-style page. App shell = IndiaMART header on top,
        // the persistent LEFT context rail, and the form filling the rest full-bleed (no card, no popup X, no gutters).
        <div className={`${themeClass} fixed inset-0 z-50 bg-gray-50 flex flex-col`}>
          <IndiaMartHeader firstName={isLoggedIn && contactName ? contactName.split(' ')[0] : ''} onExit={handleExit} />
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* The score-dial + checklist rail is the standalone's persistent LEFT panel on EVERY step incl. the
                landing (owner 2026-07-29: "for standalone score dial and checklist rail") — the landing is now a
                content column, not a full-width hero, so the rail sits beside it exactly as SimpleRFQForm does.
                Hidden only on the closing sellers page (owner: once he is picking sellers the checklist distracts). */}
            {stage !== 'results' && scoreRail}
            {/* Each page owns its own scrolling: the landing scrolls its hero+grid, singlePanel scrolls its
                body (with the scroll-reset ref). An outer scroller here left residual scrollTop behind and
                pushed the next stage up out of view (owner's scroll bug). */}
            <div className="relative flex-1 min-w-0 bg-white flex flex-col overflow-hidden">
              {stage === 'landing' ? landingStep : singlePanel}
              {fillUsingAiFab}
            </div>
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
          <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
            <div ref={popupRef} role="dialog" aria-modal="true" aria-label="Post a Requirement" className={`${themeClass} relative bg-white rounded-xl w-full ${shellWidth} overflow-hidden animate-modal-in shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)]`}>
              {/* THE TWO-PANEL IS THE LANDING'S ALONE (owner 2026-07-28). Every other page — specs, the
                  prefilled page, the last page and the closing sellers page — is ONE full-width column, so the
                  flow uses the whole popup instead of leaving a third of it to catalogue photos of a product
                  the buyer has already named. */}
              {stage === 'landing' ? (
                <div className="flex items-stretch">
                  {imagePanel}
                  <div className="min-w-0 flex-1">{landingStep}</div>
                </div>
              ) : singlePanel}
              {fillUsingAiFab}
            </div>
          </div>
        </div>
      )}

      {/* "Fill using AI" FAB now lives INSIDE each surface panel (see fillUsingAiFab above) so it stays within the
          popup/mobile card rather than the viewport corner. */}
      {/* Use-case assist popup ("Help me fill the specs") — ported from Quick Quote. Text/speak/photo → the buyer's
          use-case → its own LLM (inferSpecsFromApplication). Fills OUTRANK photo/mic on conflict (never a buyer edit). */}
      {assistOpen && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4" onClick={() => !assistLoading && setAssistOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Help me fill the specs" className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold text-gray-800 flex items-center gap-1.5"><span className="text-teal-500">✦</span> Help me fill the specs</p>
              <button type="button" onClick={() => finalizeAssist()} disabled={assistLoading} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 disabled:opacity-50" aria-label="Done — fill my form"><X size={16} /></button>
            </div>
            {assistLoading ? (
              <div className="py-8 flex flex-col items-center gap-3 text-center" role="status" aria-live="polite">
                <span className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-semibold text-gray-700">Filling your form…</p>
                <p className="text-xs text-gray-500">Reading everything you told me</p>
              </div>
            ) : (<>
              {/* CHAT thread — the buyer and the assistant go back and forth (text/mic/photo). On "Fill my form" the whole
                  conversation is handed to the same fill pipeline as the old use-case box. */}
              <div ref={assistThreadRef} className="max-h-[46vh] overflow-y-auto space-y-2.5 mb-3 pr-1 scroll-smooth">
                {assistMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-800'}`}>{m.text}</div>
                  </div>
                ))}
                {assistChatBusy && <div className="flex justify-start"><div className="rounded-2xl bg-gray-100 px-3 py-2 text-sm text-gray-400">…</div></div>}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { voiceTargetRef.current = 'assist'; setShowVoice(true); }} className="flex items-center justify-center w-10 h-10 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0" aria-label="Speak" title="Speak"><Mic size={18} /></button>
                <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center justify-center w-10 h-10 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0" aria-label="Add photo" title="Photo"><Camera size={16} /></button>
                <input value={assistInput} onChange={(e) => setAssistInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && assistInput.trim()) { e.preventDefault(); sendAssistMessage(); } }} autoFocus placeholder="Type your answer…" className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
                <button type="button" onClick={() => sendAssistMessage()} disabled={!assistInput.trim() || assistChatBusy} className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${!assistInput.trim() || assistChatBusy ? 'bg-gray-100 text-gray-400' : 'bg-gray-800 text-white hover:bg-gray-900'}`} aria-label="Send"><ArrowRight size={16} /></button>
              </div>
              <button type="button" onClick={finalizeAssist} className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 bg-teal-600 text-white hover:bg-teal-700">Fill my form <Sparkles size={15} /></button>
            </>)}
          </div>
        </div>
      )}
      {/* MOBILE FIX (2026-07-23): `hidden` (display:none) makes programmatic .click() a no-op on iOS Safari — use
          sr-only (off-screen, still clickable). Dropped `capture="environment"`: it forced the camera and blocked
          gallery/catalog uploads (buyers upload existing product/spec images); the native chooser now offers both.
          iOS converts a Photos pick to JPEG for accept="image/*", so the canvas resize in onPhoto still decodes. */}
      <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { const f = e.target.files?.[0]; if (f) { bes('upload'); onPhoto(f); } e.currentTarget.value = ''; }} />
      {/* Voice recorder needs its OWN overlay — VoiceRecorder renders a bare card (no positioning), so without
          this wrapper it was hidden behind the z-50 modal (the "mic not working" bug). Bottom-sheet on mobile. */}
      {showVoice && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={() => setShowVoice(false)}>
          <div ref={voiceRef} role="dialog" aria-modal="true" aria-label="Speak your requirement" className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-[0_12px_32px_-4px_rgba(30,42,58,0.24)] animate-modal-in" style={{ paddingBottom: 'max(env(safe-area-inset-bottom),8px)' }} onClick={(e) => e.stopPropagation()}>
            <VoiceRecorder onRecordingComplete={(blob) => onVoice(blob)} onCancel={() => setShowVoice(false)} />
          </div>
        </div>
      )}
      {showOTP && <OTPGate initialName={contactName} initialMobile={contactMobile} onVerified={(name, mobile) => { if (name) setContactName((n) => n || name); if (mobile) setContactMobile((m) => m || mobile); otpVerified.current = true; setShowOTP(false); dispatchBuyLead({ name, mobile }); setStage('results'); }} onClose={() => setShowOTP(false)} />}
      {/* HARD-BLOCK name+location gate (owner-locked 2026-08-13): no backdrop-dismiss, no close, no skip — Continue is
          the only way out and it's disabled until every ASKED field is valid. Kills the empty-name / wrong-city leads. */}
      {showIdentityGate && (
        <div className="fixed inset-0 z-[85] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4">
          <div ref={identityGateRef} role="dialog" aria-modal="true" aria-label="Confirm your details" className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5 space-y-4" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-bold text-gray-800 text-base">Just two quick details</p>
              <p className="text-xs text-gray-500 mt-0.5">So suppliers know who they're quoting to and where to deliver — you're almost there.</p>
            </div>
            {gateAsk.name && (
              <div>
                <label htmlFor="gate-name" className="block text-sm font-semibold text-gray-700 mb-1">Your name</label>
                <input id="gate-name" type="text" value={contactName} onChange={(e) => setContactName(e.target.value)} autoFocus placeholder="Full name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
                {contactName.trim().length > 0 && contactName.trim().length < 3 && <p className="text-xs text-amber-600 mt-1">Please enter at least 3 characters.</p>}
              </div>
            )}
            {gateAsk.city && (
              // CITY CHOOSER (#78) — the SAME shared chooser the header drawer + conflict banner use (#79): candidate
              // chips (profile + browsed cities) + free search. Continue (below) commits via commitCity, so no onPick here.
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Delivery city</label>
                {cityChooser()}
              </div>
            )}
            <button type="button" disabled={!gateCanContinue} onClick={async () => { await commitCity(userLocation); setShowIdentityGate(false); if (resubmitAfterGate.current) { resubmitAfterGate.current = false; setTimeout(() => submit(), 0); } }} className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${!gateCanContinue ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : CTA_ADVANCE}`}>Continue</button>
          </div>
        </div>
      )}
      {/* DISCARD CONFIRM (owner 2026-08-13, 2b): fired from handleExit only when specs/qty are entered — safe action
          ("keep editing") is the default/primary; discard is the secondary, destructive choice. */}
      {showDiscard && (
        <div className="fixed inset-0 z-[85] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4" onClick={() => setShowDiscard(false)}>
          <div ref={discardRef} role="dialog" aria-modal="true" aria-label="Discard requirement?" className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5 space-y-4" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-bold text-gray-800 text-base">Discard this requirement?</p>
              <p className="text-xs text-gray-500 mt-0.5">Your product, specs and details will be lost — this can't be undone.</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowDiscard(false)} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold ${CTA_ADVANCE}`}>No, keep editing</button>
              <button type="button" onClick={() => { setShowDiscard(false); onClose(); }} className="flex-1 py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50">Yes, discard</button>
            </div>
          </div>
        </div>
      )}
      {/* RETAIL-INTENT CONFIRM (task #75, owner 2026-08-14). Fires only when a qty-collecting category + a small discrete
          order + the LLM all agree this looks like a personal/retail buy. The buyer's answer routes the flow: "personal"
          → the buyer-specs-only 'static' tier; "business" → the full B2B flow. Copy is a TUNABLE placeholder (owner:
          "refine the exact wording later") — the two buttons' SEMANTICS are fixed, only the sentences change. Dismiss
          (backdrop / Esc) cancels without choosing; the next Continue proceeds as business-as-usual (never re-prompts). */}
      {showRetailGate && (
        <div className="fixed inset-0 z-[85] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4" onClick={() => setShowRetailGate(false)}>
          <div ref={retailRef} role="dialog" aria-modal="true" aria-label="Is this a business or a personal purchase?" className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5 space-y-4" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-bold text-gray-800 text-base">Quick check</p>
              <p className="text-xs text-gray-500 mt-1">This looks like something you could buy directly on Amazon or Flipkart. Is <b>{[quantity, unit].filter(Boolean).join(' ') || productName}</b> for your business, or a personal / one-off purchase? We'll keep the form short if it's personal.</p>
            </div>
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => { setRetailChoice('business'); setShowRetailGate(false); setStage('specs'); }} className={`w-full py-2.5 rounded-xl text-sm font-semibold ${CTA_ADVANCE}`}>It's for my business</button>
              <button type="button" onClick={() => { setRetailChoice('retail'); setShowRetailGate(false); setStage('specs'); }} className="w-full py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50">Personal / one-off buy</button>
            </div>
          </div>
        </div>
      )}
      {/* Screen-reader live region (P1-128): announces the current step + RFQ-strength score as they change,
          so non-visual users hear progress the score ring / stepper convey visually. Visually hidden. */}
      <div aria-live="polite" className="sr-only">{`Step: ${stage}. RFQ strength ${scoreDetails.total} out of 100, ${getScoreLabel(scoreDetails.total)}.`}</div>
    </>
  );
}
