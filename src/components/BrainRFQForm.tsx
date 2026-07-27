import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  ArrowLeft, ArrowRight, Search, Mic, Camera, X, Pencil, MapPin, Star, User, Send, Phone,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, BadgeCheck, ShieldCheck, Award, Package, MessageCircle, Clock, CreditCard,
  LogIn, CheckCircle2, SlidersHorizontal, ListPlus, Truck, LocateFixed, RotateCcw, type LucideIcon,
} from 'lucide-react';
import { getJSON, postJSON } from '../lib/api';
import { fetchProductSuggestions, filterProducts, stripQuantityPrefix, parseQuantityFromName } from '../utils/productNames';
import { sanitizeQty, qtyIsMeaningful, isValidGSTIN } from '../utils/formValidation';
import type { ISQSpec, RFQFormData } from '../types';
import { calcScore, getScoreColor, getScoreLabel, type ScoreCheck } from '../utils/score';
import OptionChips from './OptionChips';
import OTPGate from './OTPGate';
import VoiceRecorder from './VoiceRecorder';
import IndiaMartHeader from './IndiaMartHeader';
import SellerSearchProgress from './SellerSearchProgress';
import { searchSellers, type SellerResult } from '../lib/sellerSearch';
import { analyzeImage, voiceToSpecs, hasGeminiKey, inferSpecsFromApplication, runCuratedPlanner, RFQ_LLM_ENABLED, type AiSpecQuestion, type CuratedPlan } from '../lib/gemini';
import { fetchCategoryCorpus, fetchCategoryTopSpecs, fetchProductImages, upsizeImimg } from '../lib/enrichment';
import { matchUnit } from '../lib/quantity';
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
// 'more' = the LAST page = "Your Profile & Delivery" (About You + Logistics&Payment + Contact, combined).
type Stage = 'product' | 'specs' | 'more' | 'results'; // 'aispecs' merged into 'specs' 2026-07-27 — ONE continuous spec page, no tap between prefilled specs and the ranked gap questions (owner-locked)
type CategoryMode = 'simple' | 'category';

// The captured requirement handed back to the host (fixes P1-113). ⚑ DEV-TODO: the real BuyLead-generation API
// consumes this — wire it in `dispatchBuyLead` below (owner: BL API provided later).
export interface RFQSubmission {
  productName: string;
  mcatId: string;
  text: string;                // the lossless requirement text (buildRequirementText)
  quantity: string;
  unit: string;
  specs: Record<string, string>;
  contact: { name: string; mobile: string; email: string };
  imageBase64?: string;
}

interface Props {
  onClose: () => void;
  surface?: Surface;
  categoryMode?: CategoryMode; // 'simple' (default) = NO category corpus (buyer+seller+user only); 'category' = corpus-driven (needs v51 n8n)
  loggedIn?: boolean;          // logged-in buyer: contact collapsed + prefilled, no Login button, no OTP text
  standalone?: boolean;        // full-page route (fills viewport, no popup backdrop) vs dashboard popup
  onSubmit?: (req: RFQSubmission) => void; // host receives the requirement (BL generation); demo falls back to the results screen
}

// Top clickable stepper nodes (owner). Product is the landing (stepper hidden there); the 2 numbered
// steps are Specifications · Your Profile & Delivery. 2026-07-27: prefilled specs + ranked "smart" gap
// questions now render on ONE continuous Specifications page (formerly a separate aispecs stage/stepper node).
const STEPPER: Array<{ label: string; stage: Stage; Icon: LucideIcon }> = [
  { label: 'Product', stage: 'product', Icon: Package },
  { label: 'Specifications', stage: 'specs', Icon: SlidersHorizontal },
  { label: 'Your Profile & Delivery', stage: 'more', Icon: Truck },
];
const stageNodeIdx = (s: Stage): number => (s === 'product' ? 0 : s === 'specs' ? 1 : 2);

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

const TIMELINE = ['Immediate', 'Within 15 Days', '1 Month', 'Flexible'];
const PAYMENT_TERMS = ['Full Advance', 'Credit (Post-Delivery)', 'COD', 'Loan/Finance'];
const CREDIT_PERIODS = ['15 Days', '30 Days', '45 Days', '60 Days', '90 Days'];
const PAYMENT_MODES = ['Online Transfer', 'Cash', 'Cheque'];
const BUSINESS_TYPES = ['Online Business', 'Exporter', 'Manufacturer', 'Retailer', 'Service Provider', 'Wholesaler', 'Individual Buyer'];

// SimpleRFQForm AI calls run on the form's /api/llm proxy path (key injected server-side, never bundled; all pass
// route:'form'). Per-call MODEL routing (owner 2026-07-24): hints + mic → the fast lite tier (3.5-flash-lite);
// image + page-2 AI-specs → the stronger tier (3.6-flash). Standard has no AI. (Buyer-card is separate — its own key.)
const RFQ_MODEL_MIC = 'google/gemini-3.5-flash-lite';   // voiceToSpecs (mic)
const RFQ_MODEL_IMAGE = 'google/gemini-3.6-flash';      // analyzeImage (photo)
const RFQ_MODEL_SPECS = 'google/gemini-3.6-flash';      // runCuratedPlanner (the unified page-1 prefill + page-2 gap-question planner)
const RFQ_MODEL_USECASE = 'google/gemini-3.6-flash';    // inferSpecsFromApplication (use-case assist) — reasoning-heavy → stronger tier
const hasFormLLM = () => RFQ_LLM_ENABLED || hasGeminiKey();

// (DEMO_SELLERS removed 2026-07-23 — the results page now renders REAL ranked sellers from the windmill
//  curated_seller_search API; see src/lib/sellerSearch.ts + the sellerStatus/sellerResults flow.)

// P2-221: drop ONLY a dedicated quantity/unit ISQ row (quantity + its unit are handled separately by the
// Quantity+Unit block via deriveUnits). Token-based: drop a spec when EVERY word in its name is a quantity/unit
// word AND at least one is a core qty/unit term — so "Quantity", "Unit", "Quantity Unit", "Order Quantity",
// "Unit of Measurement", "MOQ", "Number of Units" are dropped, while real specs that merely CONTAIN such a word
// ("Unit Weight", "Control Unit", "Number Of Cores", "Model Number") are KEPT. (Substring matching wrongly kept
// "Quantity Unit"; a whole-name match wrongly missed it — hence the token rule.)
const QTY_UNIT_CORE = new Set(['quantity', 'quantities', 'qty', 'unit', 'units', 'uom', 'moq']);
const QTY_UNIT_FILLER = new Set(['order', 'min', 'minimum', 'of', 'measure', 'measurement', 'required', 'no', 'the', 'number']);
function isQtyUnitField(name: string): boolean {
  const toks = name.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!toks.length) return false;
  return toks.some((t) => QTY_UNIT_CORE.has(t)) && toks.every((t) => QTY_UNIT_CORE.has(t) || QTY_UNIT_FILLER.has(t));
}
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
    .filter((r) => r && r.IM_SPEC_MASTER_DESC && !isQtyUnitField(r.IM_SPEC_MASTER_DESC))
    .slice(0, 30) // P3-305: was 10 — a rich-ISQ category could silently lose buyer specs. 30 covers every real schema.
    .map((r) => {
      // P2-222: split ONLY on '##' (the documented delimiter). The old '/##|,/' fallback shattered legitimate
      // comma-bearing option values ('1,000 kVA' → '1' + '000 kVA'). Live data confirms '##' is always the delimiter.
      const opts = (Array.isArray(r.OPTIONS_DATA) && r.OPTIONS_DATA.length
        ? r.OPTIONS_DATA.map((o) => (o.IM_SPEC_OPTIONS_DESC || '').trim()).filter(Boolean)
        : (r.IM_SPEC_OPTIONS_DESC || '').split('##').map((o) => o.trim()).filter(Boolean)
      ).filter((o) => !/^others?$/i.test(o));
      return { ...r, IM_SPEC_OPTIONS_DESC: opts.join('##') };
    });
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

export default function BrainRFQForm({ onClose, surface, categoryMode = 'category', loggedIn = false, standalone = false, onSubmit, brainSeed }: Props & { brainSeed?: import('../lib/brains/formAdapter').BrainSeed }) {
  const _seed = brainSeed;
  // Freeze the surface ONCE at mount — otherwise a mid-flow viewport crossing 640px (rotate/resize)
  // would silently swap the whole mobile↔desktop chrome on the next state change.
  const [surf] = useState<Surface>(() => surface ?? (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 'desktop' : 'mobile'));
  const isMobile = surf === 'mobile';

  const [stage, setStage] = useState<Stage>(_seed?.startStage ?? 'product');

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
  const [isqSpecs, setIsqSpecs] = useState<ISQSpec[]>([]);
  const [specValues, setSpecValues] = useState<Record<string, string>>(_seed?.specValues ?? {});
  // "Also detected" — buyer-truth facts (from name/photo/mic) that don't fit a buyer ISQ field. Never lost:
  // shown as editable key-value rows below the specs and shipped in the requirement. Buyer edits are preserved.
  const [extraSpecs, setExtraSpecs] = useState<Record<string, string>>({});
  const extraEditedRef = useRef<Set<string>>(new Set()); // extra keys the buyer edited/removed → don't let a re-run clobber them
  const [specsLoading, setSpecsLoading] = useState(false);
  const [mcatId, setMcatId] = useState('');
  // Page-1 buyer-spec hints (from the unified Curated-RFQ planner's field_hints): per-field captions. We never
  // HIDE a spec based on the planner's read — async AI must ENRICH, never yank an already-shown field (hiding
  // caused specs to "appear then vanish" ~1s after the page rendered; we show all buyer specs).
  const [isqHints, setIsqHints] = useState<Record<string, string>>({});
  // Page-2 "smart questions" (the unified planner's ranked `gaps`): options-only questions not already known.
  const [aiSpecs, setAiSpecs] = useState<AiSpecQuestion[]>([]);
  const [aiSpecsLoading, setAiSpecsLoading] = useState(false);
  const [aiSpecsError, setAiSpecsError] = useState(false); // the planner threw/timed-out — distinct from a genuine "0 questions"
  const [aiSpecValues, setAiSpecValues] = useState<Record<string, string>>({});
  const [aiEpoch, setAiEpoch] = useState(0); // bumped when a photo/voice adds specs → re-runs the AI-specs prompt with them
  const [unitsResolved, setUnitsResolved] = useState(false); // true once GetIsq has returned — gates Continue past the loading race
  const [resolveError, setResolveError] = useState(false); // mcat-resolve network failure (distinct from "not a category")
  // Category CORPUS status (debug chip). The form fetches the raw per-call corpus fresh on mcat-known and
  // feeds it WHOLE to the single page-2 planner call — no n8n distill LLM, no cache.
  const catFetchTok = useRef(0);
  const categoryCorpusRef = useRef<unknown>(null); // raw category corpus (or legacy intelligence obj); passed as-is to the planner
  useEffect(() => () => { catFetchTok.current++; }, []); // cancel any in-flight corpus fetch on unmount
  // CATEGORY TOP-SPECS MUST FOLLOW THE PRODUCT THE BUYER ACTUALLY PICKED (owner, 2026-07-28).
  // `_seed.categoryTopSpecs` is captured ONCE at mount for the engine's auto-chosen PRIMARY mcat. Pick a
  // different card (or type a new product) and the planner was still being advised by the old category —
  // e.g. choose "6 Gm Cup Cake Tray" (25188) and it reasoned with mcat 186822's questions. The corpus fetch
  // below already re-keys on mcatId; this makes the distilled top_specs do the same.
  const [catTopSpecs, setCatTopSpecs] = useState(_seed?.categoryTopSpecs);
  const catBrainTok = useRef(0);
  useEffect(() => () => { catBrainTok.current++; }, []);
  useEffect(() => {
    if (!mcatId) { setCatTopSpecs(undefined); return; }
    if (_seed?.mcatId && mcatId === _seed.mcatId) { setCatTopSpecs(_seed.categoryTopSpecs); return; } // seed is for THIS mcat
    setCatTopSpecs(undefined);            // wrong-category advice is worse than none — clear first, then refetch
    const tok = ++catBrainTok.current;
    fetchCategoryTopSpecs(mcatId).then((s) => {
      if (catBrainTok.current !== tok) return;   // stale (mcat changed again / unmounted)
      if (s?.length) { setCatTopSpecs(s); if (plannerFiredFor.current) { plannerFiredFor.current = ''; setAiEpoch((e) => e + 1); } } // re-plan with the RIGHT category
    }).catch((e) => emitApiError('fetchCategoryTopSpecs', e, { mcatId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId]);

  const [deliveryLocation, setDeliveryLocation] = useState(_seed?.deliveryLocation ?? '');
  const [userLocation, setUserLocation] = useState('');    // the buyer's OWN city (mockup "YOUR LOCATION")
  const [sameAsLoc, setSameAsLoc] = useState(true);         // "same as my location" — delivery mirrors user (default on)
  const [geoLoading, setGeoLoading] = useState(false);      // "Use my current location" in flight
  const [deliveryTimeline, setDeliveryTimeline] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [creditPeriod, setCreditPeriod] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [industry, setIndustry] = useState('');
  const [gstRegistered, setGstRegistered] = useState<boolean | null>(null); // null = UNKNOWN (Golden Rule: never assume "No"); only ASKED for a business role (not Individual Buyer)
  const [gstNumber, setGstNumber] = useState('');
  const [requirementNotes, setRequirementNotes] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [detectedCity, setDetectedCity] = useState('');

  const [scoreOpen, setScoreOpen] = useState(false);
  const [locationEditing, setLocationEditing] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [showOTP, setShowOTP] = useState(false);
  const otpVerified = useRef(false);
  const [cardIdx, setCardIdx] = useState(0);
  const [openEnquiry, setOpenEnquiry] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
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
  const exitIntentUsed = useRef(false);              // one-shot exit-intent salvage guard
  // R7 steal — recent searches (localStorage), shown in the product dropdown when the field is empty.
  const [recents, setRecents] = useState<string[]>(() => { try { return (JSON.parse(localStorage.getItem('rfq_recent') || '[]') as string[]).slice(0, 6); } catch { return []; } });
  const pushRecent = (name: string) => {
    const n = name.trim(); if (!n) return;
    try { const cur = (JSON.parse(localStorage.getItem('rfq_recent') || '[]') as string[]).filter((x) => x.toLowerCase() !== n.toLowerCase()); const next = [n, ...cur].slice(0, 6); localStorage.setItem('rfq_recent', JSON.stringify(next)); setRecents(next); } catch { /* ignore */ }
  };

  // Login state (owner scenarios): starts from the `loggedIn` prop; the in-form Login button flips it.
  // Logged-in → autofetch demo contact + treat as already-verified (submit skips OTP) + hide Login button/OTP text.
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
  // Logged-in = "autofetch" demo: pull the buyer's contact AND business details from the account (dummy here),
  // mark OTP already-verified (submit skips the OTP step), and hide the Login CTA + banner. Two ways to reach it:
  // (1) the ?login=1 route flag (starts logged-in), or (2) tapping the in-form "Login" button. Empty-only fills
  // so a value the buyer already typed is never overwritten.
  // ⚑ DEV-TODO (real login / identity — owner: TWO scenarios): if the buyer is logged in, fetch these from the
  //   Buyer Profile / account session (name, mobile, email, business type, industry, GST) and mark OTP-verified;
  //   if NOT logged in, prompt login (or capture + OTP-verify their own number). The literal values below are a
  //   DEMO stand-in — replace them; never ship a hard-coded identity.
  const applyLoggedInDefaults = () => {
    setContactName((n) => n || 'Demo Buyer');
    setContactMobile((m) => m || '9876543210');
    setContactEmail((e) => e || 'tarbrinder.singh@indiamart.com');
    setBuyerType((b) => b || 'Manufacturer');
    setIndustry((i) => i || 'Construction Equipment');
    setGstRegistered((g) => (g === null ? true : g));
    setGstNumber((n) => n || '27AABCU9603R1ZM');
    otpVerified.current = true;
  };
  const handleLogin = () => { setIsLoggedIn(true); applyLoggedInDefaults(); };
  useEffect(() => { if (isLoggedIn) applyLoggedInDefaults(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isLoggedIn]);

  const suggestDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestTokRef = useRef(0); // monotonic guard so a stale suggestion fetch can't overwrite a newer query's results
  const qtyRef = useRef<HTMLInputElement | null>(null);
  const productInputRef = useRef<HTMLInputElement | null>(null);
  // #8 (owner): clicking a scorer action item scrolls its field into view + flashes it momentarily so the buyer
  // sees exactly what to fill. `flashKey` = the slug of the currently-flashing check (see slugCheck/jumpToCheck).
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);
  const suppressFocusOpenRef = useRef(false); // the mount auto-focus must NOT pop the suggestion/recents dropdown — only a genuine focus/tap should
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cardScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAiSpecs = useRef<Record<string, string> | null>(null);
  const plannerFiredFor = useRef('');       // "mcatId:name:aiEpoch:specSig" the unified Curated-RFQ planner already fired for (re-fires on a material change: new mcat, new photo/voice evidence, or a late-arriving ISQ schema)
  const categoryNameRef = useRef('');       // latest category name (McatDtl) for the async AI-spec call
  const photoSpecsRef = useRef<Record<string, string>>({}); // specs a photo/voice extracted → extra INPUT to the AI-specs prompt
  const photoSetKeys = useRef<Set<string>>(new Set()); // ISQ fields whose value came from photo/voice extraction (NOT a buyer edit) → safe to overwrite/clear on a re-extraction (audit #3 photo-reselect)
  // ── Use-case assist ("Help me fill the specs") — its OWN LLM (inferSpecsFromApplication). ──
  // Priority (owner): buyer-edit > use-case > photo/mic > name-hint. useCaseSetKeys marks use-case fills so a later
  // photo/mic can't override them (applyExtractedSpecs skips these) and so a buyer edit still wins (setSpecValue clears).
  const useCaseSetKeys = useRef<Set<string>>(new Set());
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistInput, setAssistInput] = useState('');
  const [assistLoading, setAssistLoading] = useState(false);
  const assistRunRef = useRef(0);                            // monotonic — a stale in-flight inference (product changed) is dropped
  const voiceTargetRef = useRef<'form' | 'assist'>('form');  // where a voice result goes: 'form' = extract specs (product page), 'assist' = dictate the use-case
  const commitGen = useRef(0);              // generation token — a superseded commit's late API responses become no-ops
  const autoAdvancedFor = useRef('');       // mcatId we already auto-advanced past (unit-less) — so Back doesn't re-bounce
  const qtyRedirectedFor = useRef('');      // mcatId we already redirected 'specs'→'product' for a missing qty — so Back doesn't re-loop
  const productNameRef = useRef('');        // live product name for the photo/voice "don't overwrite a typed name" guard
  const sellerSpecsRef = useRef<string[]>([]); // getISQs SELLER-flagged spec names → page-2 AI input (never rendered on page-1)
  const bodyScrollRef = useRef<HTMLDivElement | null>(null); // the flow-body scroller — reset to top on every stage change (P2-216)
  const [showScrollHint, setShowScrollHint] = useState(false); // subtle "more below" amber chevron when the flow body overflows
  const prevStageRef = useRef<Stage>('product');            // for the page_transition funnel event
  const stageRef = useRef<Stage>('product');                // live stage mirror for the popstate/back handler (P1-127)
  const handleExitRef = useRef<() => void>(() => {});        // latest handleExit — lets the Escape handler exit the desktop popup without stale-closure/dep churn
  const voiceRef = useRef<HTMLDivElement | null>(null);      // voice-overlay container for the focus trap (P2-228)
  useFocusTrap(showVoice, voiceRef);                         // P2-228: trap Tab within the voice-input overlay while open
  const popupRef = useRef<HTMLDivElement | null>(null);      // desktop-popup dialog container for the focus trap (audit a11y)
  useFocusTrap(!isMobile && !standalone, popupRef);          // trap Tab within the embedded popup so it can't escape to the dashboard
  const photoMcatRef = useRef('');                           // the mcat the current photo/voice evidence belongs to (P0-01 mcat-scoping)
  const blToastShownRef = useRef(false);                     // one-time "requirement ready" toast when BL becomes eligible
  const dispatchedRef = useRef(false);                       // has a BuyLead been dispatched at all (drives idempotency below)
  const lastDispatchSigRef = useRef('');                     // content signature of the last dispatch — a TRUE duplicate (double-tap) is skipped, but an EDIT re-dispatches as an update (audit #13)
  const pendingUnitRef = useRef('');                         // a spoken unit stashed until the category's unitOptions resolve (P2-205)

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
      const s = stageRef.current;
      if (s === 'product' || s === 'results') { onClose(); return; }
      const prev: Stage = s === 'specs' ? 'product' : 'specs'; // more → specs
      setStage(prev);
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
      if (showVoice) setShowVoice(false);
      else if (scoreOpen) setScoreOpen(false);
      else if (locationEditing) setLocationEditing(false);
      else if (contactOpen) setContactOpen(false);
      else if (!isMobile && !standalone) handleExitRef.current(); // consistency w/ Standard: Esc exits the desktop popup (via handleExit → same lead-salvage). Full-page shells still never close on Esc.
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
  // "Same as my location": turning it ON copies the buyer's city into delivery; OFF frees delivery to edit.
  const toggleSameAs = () => setSameAsLoc((prev) => { const next = !prev; if (next && userLocation) setDeliveryLocation(userLocation); return next; });
  // PRIVACY (2026-07-23): we no longer auto-fire the GPS permission prompt on reaching Delivery — an unprompted
  // permission dialog is a poor first impression and a consent anti-pattern. Location is now tap-to-share only:
  // the buyer taps "Use my current location" (below), which calls useCurrentLocation(). IP-city fallback still
  // fills a sensible default without any prompt, so no one is blocked.

  useEffect(() => { if (committed) setTimeout(() => qtyRef.current?.focus(), 60); }, [committed]);

  // P2-205: a voice-spoken unit stashed before the category's unitOptions loaded → apply it once they resolve.
  useEffect(() => { if (pendingUnitRef.current && unitOptions.length) { setUnit((u) => u || matchUnit(unitOptions, pendingUnitRef.current)); pendingUnitRef.current = ''; } }, [unitOptions]);

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
    const pastFirstSpecPage = stage === 'more' || stage === 'results';
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
    }, 60000)
      .then((res) => { if (run === sellerRunRef.current) { setSellerResults(res.sellers); setSellerStatus('done'); } })
      .catch((e) => { if (run === sellerRunRef.current) setSellerStatus('error'); emitApiError('sellerSearch', e, { mcatId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, mcatId]);

  // Fetch the RAW category corpus as soon as the mcat is known (FRESH every time — no cache). It feeds the
  // page-2 planner (categoryCorpusRef). If it lands AFTER the planner already ran (fallback), bump aiEpoch
  // to re-plan WITH it. Fresh Redash-backed fetch can take a few seconds → fired at commit to hide latency.
  useEffect(() => {
    // SIMPLE mode: never fetch the category corpus — the planner runs on buyer + seller + user input only.
    if (categoryMode !== 'category') { categoryCorpusRef.current = null; return; }
    if (!mcatId) { categoryCorpusRef.current = null; return; }
    const tok = ++catFetchTok.current;
    categoryCorpusRef.current = null;
    fetchCategoryCorpus(mcatId).then((r) => {
      if (catFetchTok.current !== tok) return;                 // stale (mcat changed / unmount)
      if (r.status === 'hit' && r.corpus) {
        categoryCorpusRef.current = r.corpus;
        if (plannerFiredFor.current) { plannerFiredFor.current = ''; setAiEpoch((e) => e + 1); } // planner already ran without it → re-plan with the corpus
      }
    }).catch((e) => emitApiError('fetchCategoryCorpus', e, { mcatId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId]);

  const onProductInput = (val: string) => {
    setProductName(val); productNameRef.current = val; setNotFound(false); setCommitted(false);
    if (suggestDebounce.current) clearTimeout(suggestDebounce.current);
    // P1-103: clearing the name is "start over" — reset product-scoped state so a photo uploaded next is analysed
    // against a fresh (no) schema and against the RIGHT product, not the previous category's ISQ fields.
    if (!val.trim()) {
      // FULL reset (audit #9 owner #3/#5): clearing the product name is "start over", so wipe everything the old
      // product left behind — not just the ISQ set. Otherwise the score still credits a phantom "Product image",
      // and re-typing a name that resolves to the SAME mcat re-attaches the old photo + its specs.
      setMcatId(''); setIsqSpecs([]); setSpecValues({}); setUnitOptions([]); setUnit(''); setUnitsResolved(false);
      setProductImageUrl(''); setProductImages([]); setImageBase64(''); setQuantity('');
      setExtraSpecs({}); setAiSpecs([]); setAiSpecValues({}); setAiSpecsError(false);
      photoSpecsRef.current = {}; photoMcatRef.current = ''; photoSetKeys.current.clear();
      extraEditedRef.current.clear(); pendingAiSpecs.current = null;
      useCaseSetKeys.current.clear(); setAssistInput(''); setAssistOpen(false);
      sellerFiredFor.current = ''; setSellerResults([]); setSellerStatus('idle');
    }
    if (val.trim().length < 2) { setSuggestions([]); setShowDropdown(false); return; }
    setSuggestions(filterProducts(val)); setShowDropdown(true);
    // Monotonic token: a slow fetch for an OLDER query ('t') must not overwrite the newer one's ('tm') results.
    const tok = ++suggestTokRef.current;
    suggestDebounce.current = setTimeout(async () => { const live = await fetchProductSuggestions(val); if (live.length && tok === suggestTokRef.current) setSuggestions(live); }, 200);
  };

  // Derive qty/unit options from raw ISQ rows (mapDisplaySpecs strips these, so read them first).
  const deriveUnits = (rows: unknown): string[] => {
    const flat = (Array.isArray(rows) ? rows : []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s): s is ISQSpec => !!(s && (s as ISQSpec).IM_SPEC_MASTER_DESC));
    const u: string[] = [];
    // Pull unit options ONLY from a field that IS a dedicated quantity/unit field (same token test that hides it
    // from the spec list) — a substring /unit|quantity/ wrongly matched real specs like "Unit Weight" and shipped
    // a bogus order unit (e.g. "1 kg") to sellers (audit).
    for (const qs of flat.filter((s) => isQtyUnitField(s.IM_SPEC_MASTER_DESC))) if (qs.IM_SPEC_OPTIONS_DESC) qs.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter((o) => o && o.toLowerCase() !== 'none').forEach((o) => { if (!u.includes(o)) u.push(o); });
    return u;
  };
  const commitProduct = useCallback(async (name: string) => {
    const myGen = ++commitGen.current; // supersede any in-flight prior commit
    setShowDropdown(false); setResolving(true); setNotFound(false); setResolveError(false); setCommitted(false); setProductName(name); productNameRef.current = name;
    const parsedQty = parseQuantityFromName(name);
    // Reset stale quantity on every (re)commit — re-seed ONLY if the NEW name embeds one. Stops an old
    // product's qty from orphaning under a freshly-reset unit (audit). Voice/photo set qty AFTER this.
    setQuantity(parsedQty?.quantity || '');
    const resolveMcat = async (q: string): Promise<string> => {
      const data = await getJSON<Record<string, string> | Array<Record<string, string>>>(`/api/imimg/models/mcatid-suggestion.php?search_param=${encodeURIComponent(q)}&modid=MY`);
      const it = Array.isArray(data) ? data[0] : data;
      return String(it?.mcat_id ?? it?.MID ?? it?.mcatid ?? it?.mcatId ?? '');
    };
    let id = '';
    try {
      const cleaned = stripQuantityPrefix(name);
      id = await resolveMcat(name);
      if (!id && cleaned && cleaned.toLowerCase() !== name.toLowerCase()) id = await resolveMcat(cleaned);
    } catch (e) { emitApiError('resolveMcat', e, { query: name }); emit(EV.PRODUCT_COMMIT_FAILED, { productName: name, surface: surfaceName }); if (myGen === commitGen.current) { setResolving(false); setResolveError(true); } return; } // network failure ≠ "not a category"
    if (myGen !== commitGen.current) return;
    if (!id) { setResolving(false); setNotFound(true); return; }
    // P0-01 (owner: mcat-scoped + additive) — if this commit is an ENTIRELY DIFFERENT product (different mcat)
    // than the one the mic/photo evidence + image were captured under, DROP them: they're wrong for the new
    // schema and must not autofill / feed the LLM prompts / ship to sellers. Same mcat → keep & merge (additive).
    if (photoMcatRef.current && photoMcatRef.current !== id) {
      photoSpecsRef.current = {}; photoSetKeys.current.clear(); useCaseSetKeys.current.clear(); pendingAiSpecs.current = null; setImageBase64('');
    }
    photoMcatRef.current = id; // evidence added from here on belongs to this product
    setSpecsLoading(true); setUnitsResolved(false); setIsqSpecs([]); setSpecValues({}); setUnitOptions([]); setUnit(''); setProductImageUrl(''); setProductImages([]); setResolving(false); setCommitted(true);
    setMcatId(id); categoryNameRef.current = ''; sellerSpecsRef.current = []; pushRecent(name);
    emit(EV.PRODUCT_COMMITTED, { mcatId: id, productName: name, surface: surfaceName });
    // Re-arm the unified planner's fire-guard so a re-commit (same or new mcat) re-fires it and clears
    // aiSpecsLoading — without this a same-product re-commit hangs the spec page forever.
    plannerFiredFor.current = '';
    // LOSSLESS across a product change: mic/photo evidence (photoSpecsRef) is JOURNEY-level, never wiped —
    // the typed name anchors the NEW category while voice/photo facts survive as autofill candidates
    // against the new schema + evidence input to the AI-specs prompt. Buyer page answers DO reset (by design).
    if (Object.keys(photoSpecsRef.current).length) pendingAiSpecs.current = { ...photoSpecsRef.current };
    setIsqHints({}); setAiSpecs([]); setAiSpecValues({}); setAiSpecsError(false); setAiSpecsLoading(hasFormLLM());
    setExtraSpecs({}); extraEditedRef.current = new Set(); // re-derived by the unified planner from the (surviving) evidence + new name
    setBaq(null); setPlanCorrections([]); setBaqLoading(hasFormLLM()); // clear the OLD product's opening question/strip immediately, not just once the new planner call resolves
    // P2-206: the 3 secondary catalog calls (getISQs enrichment · McatDtl image/category · IMSearchAPI gallery) all
    // depend only on `id`, so fire them CONCURRENTLY with the primary GetIsq below instead of serially after its
    // await. Page-1 spec correctness no longer depends on ordering: getISQs appends by functional merge, and GetIsq's
    // own set (further down) MERGES `fast` over whatever is present rather than replacing it — so whichever resolves
    // first, the authoritative buyer set still leads and no enrichment is clobbered.
    postJSON<{ RESPONSE?: { DATA?: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }> } }>('/api/mimart/api/bmcajax/addressbook/getISQs', { mcatId: id }, 30000)
      .then((isq2) => {
        if (myGen !== commitGen.current) return; // stale product's response — drop it
        const raw = isq2?.RESPONSE?.DATA ?? [];
        const authUnits = deriveUnits(raw);
        if (authUnits.length) { setUnitOptions((prev) => (prev.length ? prev : authUnits)); setUnit((u) => u || matchUnit(authUnits, parsedQty?.unit)); } // recover units if fast GetIsq had failed
        // getISQs carries a per-spec buyer/seller flag. Page 1 stays the BUYER requirement form (GetIsq);
        // SELLER-flagged specs ("2") are NOT rendered on page 1 — they feed the page-2 AI prompt. Any
        // BUYER-flagged getISQs specs ENRICH page 1 (dedup by name).
        const rows = (Array.isArray(raw) ? raw : []) as Array<ISQSpec & { IM_SPEC_MASTER_BUYER_SELLER?: string; OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>;
        const isSeller = (s: { IM_SPEC_MASTER_BUYER_SELLER?: string }) => String(s.IM_SPEC_MASTER_BUYER_SELLER ?? '') === '2';
        const sellerRows = rows.filter(isSeller);
        sellerSpecsRef.current = (sellerRows.length ? sellerRows : rows).map((s) => s.IM_SPEC_MASTER_DESC).filter(Boolean);
        const buyerSpecs = mapDisplaySpecs(rows.filter((s) => s.IM_SPEC_MASTER_DESC && !isSeller(s)));
        if (buyerSpecs.length) setIsqSpecs((prev) => { const have = new Set(prev.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase())); return [...prev, ...buyerSpecs.filter((s) => !have.has(s.IM_SPEC_MASTER_DESC.toLowerCase()))]; });
      }).catch((e) => emitApiError('getISQs', e, { mcatId: id })).finally(() => { if (myGen === commitGen.current) { setSpecsLoading(false); setUnitsResolved(true); } });
    getJSON<Record<string, unknown> & { Response?: { Data?: unknown }; data?: unknown }>(`/api/imimg/index.php?r=postblenq/McatDtl&modid=MY&mcatid=${id}`)
      .then((img) => {
        if (myGen !== commitGen.current) return;
        const d0 = (img?.Response?.Data ?? img?.data ?? img);
        const data = (Array.isArray(d0) ? d0[0] : d0) as Record<string, unknown>;
        if (data && typeof data === 'object') { const nm = data['glcat_mcat_name']; if (typeof nm === 'string' && nm.trim()) categoryNameRef.current = nm.trim(); for (const k of Object.keys(data)) { const v = data[k]; if (/img|image/i.test(k) && typeof v === 'string' && v.startsWith('http')) { setProductImageUrl(v.replace(/^http:\/\//i, 'https://')); break; } } } // https → no mixed-content on a prod https page
      }).catch((e) => emitApiError('McatDtl', e, { mcatId: id }));
    // Front-page GALLERY (IMSearchAPI: real seller-listing photos for this query → hero + up to 3 thumbnails).
    // Images only. First image also backfills the single hero if McatDtl had none. Best-effort; silent on empty.
    fetchProductImages(name, id)
      .then((imgs) => { if (myGen !== commitGen.current || !imgs.length) return; setProductImages(imgs); setProductImageUrl((prev) => prev || imgs[0]); })
      .catch((e) => emitApiError('fetchProductImages', e, { mcatId: id }));
    try {
      const isqJson = await getJSON<{ DATA?: (ISQSpec | ISQSpec[])[] }>(`/api/imimg/index.php?r=Newreqform/GetIsq&modid=MY&mcatid=${id}&cat_type=3&flag=1&isq_format=1&generic_flag=1&country_iso=IN`);
      if (myGen !== commitGen.current) return;
      const flat = (isqJson?.DATA ?? []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s) => s && s.IM_SPEC_MASTER_DESC);
      const unitOpts = deriveUnits(isqJson?.DATA);
      // Use ONLY the qty/unit the API provides. Some mcats carry none (e.g. Diesel Generator) — then
      // quantity + unit are simply hidden (and not required), matching V3.
      // only-if-empty setUnit: the parallel getISQs may have populated units first and the buyer may have already
      // TAPPED one — never clobber a user's selection in this commit-time race (audit).
      if (unitOpts.length) { setUnitOptions((prev) => (prev.length ? prev : unitOpts)); setUnit((u) => u || matchUnit(unitOpts, parsedQty?.unit)); }
      setUnitsResolved(true); // units are known now → Continue can un-gate even for a spec-less category
      const fast = mapDisplaySpecs(flat as Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>);
      // P2-208: clear the spinner as soon as GetIsq answers — even with ZERO display specs (a spec-light category).
      // MERGE (not replace) so a getISQs enrichment that resolved FIRST (P2-206 parallel fire) is preserved: the
      // authoritative buyer `fast` set leads, any extra getISQs buyer-specs already present follow (dedup by name).
      setIsqSpecs((prev) => { const have = new Set(fast.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase())); return [...fast, ...prev.filter((s) => !have.has(s.IM_SPEC_MASTER_DESC.toLowerCase()))]; });
      setSpecsLoading(false);
    } catch (e) { emitApiError('GetIsq', e, { mcatId: id }); /* fall through — the getISQs .finally still settles specsLoading */ }
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
  const [baqLoading, setBaqLoading] = useState(false);
  const [baqAnswers, setBaqAnswers] = useState<Record<string, string>>({});
  // Identity absorbed into the planner (owner-locked 2026-07-27): when the planner ranks a GST-style identity
  // question among its top gaps, it rides the SAME gaps list (kind:'identity') — this just pulls it out so its
  // answer writes to the REAL gstRegistered state (not a throwaway aiSpecValues entry) and P3 knows to hide it.
  const [identityAsk, setIdentityAsk] = useState<{ q: string; options?: string[]; why?: string } | null>(null);
  useEffect(() => {
    if (!committed || !mcatId || !hasFormLLM()) return;
    if (specsLoading) return; // wait for page-1 specs to settle (fires for zero-ISQ categories too, once settled)
    const name = productName;
    const gen = commitGen.current; // guards against a superseded commit (async race — same discipline the old two calls had)
    const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
    const specSig = specNames.slice().sort().join('|');
    const fireKey = `${mcatId}:${name}:${aiEpoch}:${specSig}`;
    if (plannerFiredFor.current === fireKey) return;
    plannerFiredFor.current = fireKey;
    setBaqLoading(true); setAiSpecsLoading(true);
    const buyerSpecOptions: Record<string, string[]> = {};
    for (const s of isqSpecs) buyerSpecOptions[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
    const filled: Record<string, string> = { ...specValues };
    if (quantity) filled['Quantity'] = quantity;
    if (unit) filled['Quantity Unit'] = unit;
    if (deliveryLocation) filled['Delivery location'] = deliveryLocation;
    runCuratedPlanner({
      requirement: name, categoryName: categoryNameRef.current, filled, buyerSpecs: specNames, buyerSpecOptions,
      sellerSpecs: sellerSpecsRef.current, categoryTopSpecs: catTopSpecs,   // live, re-keyed on the SELECTED mcat (not the seed's primary) categoryCorpus: categoryCorpusRef.current,
      buyerFacts: _seed?.buyerFacts, basket: _seed?.basket, buyerSignals: _seed?.buyerSignals,
      entryMode: _seed?.entryMode, model: RFQ_MODEL_SPECS,
    }).then((r) => {
      if (plannerFiredFor.current !== fireKey || gen !== commitGen.current) return;
      // Identity-in-planner (owner-locked 2026-07-27): pull any promoted identity gap OUT of the ranked list
      // first — its answer needs to land on the real gstRegistered state, not a throwaway aiSpecValues entry —
      // then split the REST exactly as before. Code-gated (not just prompt-trusted) on gstOnFile, matching the
      // codebase's "dedup cannot be an LLM promise" discipline: never honor a promoted ask for a fact we hold.
      const identityGap = gstOnFile ? undefined : (r.gaps || []).find((g) => g.kind === 'identity');
      setIdentityAsk(identityGap ? { q: identityGap.q, options: identityGap.options, why: identityGap.why } : null);
      const rankedGaps = (r.gaps || []).filter((g) => g.kind !== 'identity');
      // Split the ONE ranked gap list so the SAME question never appears twice: exactly 2 questions ride the
      // very top (the opening/intent question + the single top-ranked gap); everything else becomes page-2
      // "smart questions". Without this split, banner and page-2 would both render off the identical r.gaps array.
      const bannerGaps = rankedGaps.slice(0, 1);
      const pageGaps = rankedGaps.slice(1);
      setBaq({ ...r, gaps: bannerGaps }); setAiSpecsError(false);
      // PROGRESSIVE TRUTH ENRICHMENT: apply prefills/corrections onto the spec fields (never fabricated — the
      // planner already grounding-guards them) and surface them in the step-1 "filled from your history" strip.
      if (r.prefills?.length) {
        const map: Record<string, string> = {};
        for (const p of r.prefills) if (p.field && p.value) map[p.field] = p.value;
        if (Object.keys(map).length) applyExtractedSpecs(map);
        setPlanCorrections(r.prefills);
      }
      // extras — buyer-stated facts that don't map to any ISQ field name → "Also detected" (preserve buyer edits).
      if (r.extras && Object.keys(r.extras).length) {
        setExtraSpecs((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(r.extras!)) {
            if (!v || extraEditedRef.current.has(k.toLowerCase())) continue;
            if (specNames.some((n) => n.toLowerCase() === k.toLowerCase())) continue; // never shadow a buyer field
            next[k] = v;
          }
          return next;
        });
      }
      setIsqHints(r.field_hints || {});
      // gaps → the page-2 "smart questions" chips, same AiSpecQuestion shape the existing render already expects.
      setAiSpecs(pageGaps.map((g) => ({ fieldName: g.q, options: g.options || [], helperText: g.why, kind: g.kind === 'non_spec' ? 'intent' : 'spec' } as AiSpecQuestion)));
    }).catch((e) => {
      setBaq(null);
      emitApiError('runCuratedPlanner', e, { mcatId, aiEpoch });
      emit(EV.AISPECS_FAILED, { mcatId, aiEpoch, surface: surfaceName });
      // P2-258: on a RE-PLAN (aiEpoch>0, e.g. a photo added on the spec page) KEEP the last-good questions so
      // the buyer isn't force-navigated off the page; only a genuine first-load failure clears them.
      if (plannerFiredFor.current === fireKey && gen === commitGen.current) { setAiSpecsError(true); if (aiEpoch === 0) setAiSpecs([]); }
    }).finally(() => {
      if (plannerFiredFor.current === fireKey && gen === commitGen.current) { setBaqLoading(false); setAiSpecsLoading(false); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, mcatId, isqSpecs, productName, aiEpoch, specsLoading]);

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
        const fieldNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
        const fieldOpts: Record<string, string[]> = {};
        for (const s of isqSpecs) fieldOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
        const r = await analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', 'form', RFQ_MODEL_IMAGE);
        const extracted = { ...(r.specifications || {}), ...(r.additionalSpecifications || {}) };
        if (Object.keys(extracted).length) applyExtractedSpecs(extracted);
      } catch { /* CORS / network — best-effort, the specs from the requirement still stand */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_seed, committed, isqSpecs]);
  useEffect(() => {
    const sv = _seed?.specValues;
    if (!sv || !Object.keys(sv).length || seedSpecsApplied.current) return;
    if (specsLoading || !isqSpecs.length) return;  // wait for the ISQ schema
    seedSpecsApplied.current = true;
    setSpecValues((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(sv)) {
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
  const applyExtractedSpecs = (specs: Record<string, string>) => {
    if (!Object.keys(specs).length) return;
    // A LATER extraction for the SAME product REPLACES the prior photo/voice evidence (audit #3 photo-reselect):
    // without this a re-selected photo would UNION onto — and never correct — the first photo's facts, and the
    // empty-only fill below would keep the stale value. Evaluate BEFORE re-tagging photoMcatRef.
    const replace = photoMcatRef.current === mcatId && Object.keys(photoSpecsRef.current).length > 0;
    if (mcatId) photoMcatRef.current = mcatId; // tag this evidence to the current product (P0-01 mcat-scoping)
    pendingAiSpecs.current = specs; // still seeds the [isqSpecs]-keyed effect for a specs set that arrives LATER
    photoSpecsRef.current = replace ? { ...specs } : { ...photoSpecsRef.current, ...specs };
    // Flush onto the loaded ISQ fields. SNAP each value to the field's real option (audit #10 — no duplicate
    // "Other" chip). Overwrite an EMPTY field OR one a prior extraction set (photoSetKeys); NEVER overwrite a
    // value the buyer typed/picked. On replace, first drop machine-set values the new extraction no longer states.
    setSpecValues((prev) => {
      const next = { ...prev };
      const machineKeys = new Set(photoSetKeys.current);
      if (replace) {
        for (const k of photoSetKeys.current) {
          const restated = Object.keys(specs).some((sk) => sk.toLowerCase() === k.toLowerCase());
          if (!restated) { delete next[k]; machineKeys.delete(k); }
        }
      }
      for (const s of isqSpecs) {
        const field = s.IM_SPEC_MASTER_DESC;
        const hit = Object.keys(specs).find((k) => k.toLowerCase() === field.toLowerCase());
        if (!hit || !specs[hit]) continue;
        if (useCaseSetKeys.current.has(field)) continue; // use-case assist OUTRANKS photo/mic (owner) — don't override
        if (next[field] && !photoSetKeys.current.has(field)) continue; // buyer-owned value — never clobber
        const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
        next[field] = snapToOption(specs[hit], opts);
        machineKeys.add(field);
      }
      photoSetKeys.current = machineKeys; // idempotent assignment (safe under StrictMode double-invoke)
      return next;
    });
    setAiEpoch((e) => e + 1);
  };
  const showFeedback = (msg: string, type: ToastType = 'info') => showToast(msg, type);

  // ── Use-case assist: apply inferred specs with the OWNER priority (use-case > photo/mic > name-hint; never over a
  //    buyer edit). Confidence-gated (≥75). Reads the current specValues (a user action, so it's fresh). ──
  const applyUseCaseSpecs = (specs: Record<string, { value: string; confidence: number }>): number => {
    const next = { ...specValues };
    const uc = new Set(useCaseSetKeys.current);
    let filled = 0;
    for (const s of isqSpecs) {
      const field = s.IM_SPEC_MASTER_DESC;
      const hit = Object.keys(specs).find((k) => k.toLowerCase() === field.toLowerCase());
      if (!hit) continue;
      const sv = specs[hit];
      if (!sv || !sv.value || sv.confidence < 75) continue; // confidence band (matches inferSpecsFromApplication's contract)
      const buyerOwned = !!next[field] && !photoSetKeys.current.has(field) && !useCaseSetKeys.current.has(field);
      if (buyerOwned) continue; // a value the buyer typed/picked outranks the assist
      const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      next[field] = snapToOption(sv.value, opts);
      uc.add(field); // marks it use-case-owned → a later photo/mic won't override (applyExtractedSpecs skips these)
      filled++;
    }
    useCaseSetKeys.current = uc;
    if (filled) setSpecValues(next);
    return filled;
  };

  // "Fill my specs" — run the buyer's use-case through its OWN LLM (inferSpecsFromApplication) and fill the specs.
  const handleAssistSubmit = async () => {
    const application = assistInput.trim();
    if (!application || assistLoading) return;
    if (!hasFormLLM()) { showFeedback('AI assist needs the LLM enabled.', 'warning'); return; }
    // Persist the use-case into the requirement notes (ships + informs the page-2 planner). De-duped.
    setRequirementNotes((prev) => (prev && prev.includes(application) ? prev : prev ? `${prev}; ${application}` : application));
    setAssistLoading(true);
    const token = ++assistRunRef.current;      // stale-drop guard (a newer run / product change supersedes)
    const gen = commitGen.current;
    try {
      const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
      const withOpts: Record<string, string[]> = {};
      for (const s of isqSpecs) withOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      const { specs } = await inferSpecsFromApplication(productName, application, specNames, withOpts, 'form', RFQ_MODEL_USECASE);
      if (token !== assistRunRef.current || gen !== commitGen.current) return; // superseded — drop
      const filled = applyUseCaseSpecs(specs);
      setAiEpoch((e) => e + 1); // let the page-2 planner re-rank with the new use-case context
      setAssistOpen(false); setAssistInput('');
      showFeedback(filled > 0 ? `Filled ${filled} spec${filled > 1 ? 's' : ''} from your use-case` : 'Saved your use-case — pick the specs that apply.', filled > 0 ? 'success' : 'info');
    } catch (e) {
      emitApiError('inferSpecsFromApplication', e, { mcatId }); // keep the popup open so the buyer can retry
      showFeedback("Couldn't auto-fill from that — please pick the specs.", 'warning');
    } finally {
      if (token === assistRunRef.current) setAssistLoading(false);
    }
  };
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
      // Schema-aware extraction (the plan's combined Call A): when the category schema is already
      // loaded, the image call maps values straight onto the real ISQ fields — no separate mapper call.
      const fieldNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
      const fieldOpts: Record<string, string[]> = {};
      for (const s of isqSpecs) fieldOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      const r = await analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', 'form', RFQ_MODEL_IMAGE);
      // A photo auto-commits a product ONLY when the buyer has NOT already provided a name — neither committed
      // (productNameRef) NOR typed-but-uncommitted (productName). Otherwise a product photo could hijack the name
      // the buyer typed (the reported "product name I entered wasn't committed" edge); we attach + extract against
      // the buyer's own product once they commit it instead.
      const committedNew = !!(r.productName && !productNameRef.current.trim() && !productName.trim());
      if (committedNew) await commitProduct(r.productName);
      else if (myGen !== commitGen.current) return; // a DIFFERENT product was committed while extracting → drop this stale result
      const extracted = { ...(r.specifications || {}), ...(r.additionalSpecifications || {}) };
      const gotSomething = !!(r.productName || r.quantity || Object.keys(extracted).length);
      if (r.quantity) setQuantity(String(r.quantity));
      applyExtractedSpecs(extracted);
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
    setShowVoice(false); if (aiBusy || !hasFormLLM()) return;
    const myGen = commitGen.current;
    try {
      setAiBusy('Understanding your requirement…');
      const { base64, mime } = await fileToBase64(blob);
      const r = await voiceToSpecs(base64, mime, productName, isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC), 'form', RFQ_MODEL_MIC);
      // Assist DICTATION: when the mic was opened from the use-case popup, the spoken words go INTO the use-case box
      // (the buyer then taps "Fill my specs" → inferSpecsFromApplication). We do NOT extract specs here.
      if (voiceTargetRef.current === 'assist') {
        voiceTargetRef.current = 'form';
        const t = (r.rawTranscript || '').trim();
        if (t) setAssistInput((prev) => (prev.trim() ? `${prev.trim()} ${t}` : t));
        else showFeedback("Couldn't catch that — try again.", 'warning');
        return;
      }
      const newName = (r.productName && !productNameRef.current.trim()) ? r.productName : '';
      if (newName) await commitProduct(newName);
      else if (myGen !== commitGen.current) return; // product switched mid-extraction → drop stale result
      if (r.quantity) setQuantity(String(r.quantity));
      // P2-205: apply the spoken unit now if the options are loaded, else STASH it — the [unitOptions] effect applies it once they resolve.
      if (r.quantityUnit) { if (unitOptions.length) setUnit(matchUnit(unitOptions, r.quantityUnit)); else pendingUnitRef.current = r.quantityUnit; }
      // Coerce the LLM's enum outputs to our CANONICAL lists (snap "Advance"→"Full Advance"); drop anything that
      // doesn't map to a real option so an off-canon value never ships to sellers or fails to select a chip (audit).
      if (r.deliveryTimeline) { const t = snapToOption(r.deliveryTimeline, TIMELINE); if (TIMELINE.includes(t)) setDeliveryTimeline(t); }
      if (r.paymentTerms) { const p = snapToOption(r.paymentTerms, PAYMENT_TERMS); if (PAYMENT_TERMS.includes(p)) setPaymentTerms(p); }
      // A spoken DELIVERY city sets the DELIVERY field (not the buyer's own IP/GPS-seeded location); if it differs,
      // un-link "same as my location" so both are preserved instead of collapsing origin↔destination (audit).
      if (r.deliveryLocation) { setDeliveryLocation(r.deliveryLocation); if (r.deliveryLocation.trim() && r.deliveryLocation.trim() !== userLocation.trim()) setSameAsLoc(false); }
      if (r.creditPeriod) { const c = snapToOption(r.creditPeriod, CREDIT_PERIODS); if (CREDIT_PERIODS.includes(c)) setCreditPeriod(c); }
      const specs = { ...(r.mappedSpecs || {}) }; (r.customSpecs || []).forEach((c) => { if (c.fieldName) specs[c.fieldName] = c.value; });
      applyExtractedSpecs(specs);
      const gotSomething = !!(r.productName || r.quantity || Object.keys(specs).length);
      emit(EV.INPUT_SOURCE_USED, { source: 'mic', success: gotSomething });
      if (!gotSomething) showFeedback("Couldn't catch that — try again.", 'warning');
    } catch (e) {
      emit(EV.INPUT_SOURCE_USED, { source: 'mic', success: false });
      emitApiError('voiceToSpecs', e, { mcatId });
      showFeedback("Couldn't process the recording — try again.", 'warning');
    } finally { setAiBusy(''); }
  };

  const setSpecValue = (k: string, v: string) => { photoSetKeys.current.delete(k); useCaseSetKeys.current.delete(k); setSpecValues((p) => ({ ...p, [k]: v })); }; // a buyer edit makes the field buyer-owned — neither a later photo/voice extraction nor the use-case assist will overwrite it (audit #3 + use-case priority)
  // "Also detected" edits — mark the key as buyer-touched so a planner re-run never clobbers it.
  const setExtraValue = (k: string, v: string) => { extraEditedRef.current.add(k.toLowerCase()); setExtraSpecs((p) => ({ ...p, [k]: v })); };
  const removeExtra = (k: string) => { extraEditedRef.current.add(k.toLowerCase()); setExtraSpecs((p) => { const n = { ...p }; delete n[k]; return n; }); };

  // V3 rule (RFQModalV3.tsx:1162): anything that isn't an individual/personal/end-user is a BUSINESS role —
  // and a business buyer is asked for GST (an individual/consumer is not). "Individual Buyer" → false.
  const isBusinessRole = !!buyerType && !/individual|personal|end[\s-]?user|consumer|home/i.test(buyerType);
  // ── P3 identity visibility, derived PER FIELD (owner-locked 2026-07-27; corrected 2026-07-28) ──────────────
  // The section-level hide MUST be derived from the per-field flags below, never hand-written — the first cut of
  // this hid the whole "About You" card while Industry was still blank-and-unhandled. Two distinct concepts:
  //   • ASKED elsewhere  → hide the question (genuine double-ask prevention: the planner promoted it to P2).
  //   • KNOWN from file  → do NOT hide. Render it back as a confirm/badge WITH provenance. Hiding a prefill means
  //     the buyer never sees what we assumed, can't correct it, and TUS's CONFIRMED stage can never fire on it.
  const bfIdent = _seed?.buyerFacts as { gst_verified?: boolean; has_gst?: boolean; business_type?: string } | undefined;
  const gstOnFile = !!bfIdent?.gst_verified || !!bfIdent?.has_gst;
  const buyerTypeFromProfile = !!bfIdent?.business_type && buyerType.toLowerCase() === bfIdent.business_type.toLowerCase();
  const showGstQuestion = isBusinessRole && !gstOnFile && !identityAsk;  // asked on P2, or on file → no question here
  const showGstBadge = isBusinessRole && gstOnFile;                       // known → shown back as a verified badge
  const showGstAnswered = isBusinessRole && !gstOnFile && !!identityAsk && gstRegistered !== null; // answered on P2 → echo it
  // Business type + Industry are per-ORDER facts (a registered Manufacturer may buy as a Wholesaler on this order,
  // and Industry is on file nowhere) — so they always render, prefilled+provenanced where we know them, never hidden.
  const showBuyerTypeField = true, showIndustryField = true;
  // The card renders iff at least ONE child does. Today that's always — the honest outcome for this buyer, not a bug.
  // The machinery is real: flip a child flag off and the header disappears with it instead of stranding an empty box.
  const aboutYouHasContent = showBuyerTypeField || showIndustryField || showGstQuestion || showGstBadge || showGstAnswered;

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
  const checkStageIdx = (c: ScoreCheck): number =>
    stageNodeIdx(c.group === 'Product' ? 'product' : c.group === 'Specs' ? 'specs' : 'more'); // buyer + "smart" specs now share ONE stage
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
    (baq?.gaps || []).forEach((g, i) => { const a = baqAnswers[`gap${i}`]; const k = (g.q || '').replace(/\?+\s*$/, '').trim(); if (k && a && a.trim() && !(k in merged)) merged[k] = a.trim(); });
    return Object.entries(merged).filter(([, v]) => v && v.trim());
  }, [specValues, aiSpecValues, aiSpecs, isqSpecs, extraSpecs, baq, baqAnswers]);

  // Compact one-liner for the on-screen "Your requirement" banner.
  const requirementSummary = useMemo(() => {
    const specLine = allSpecEntries.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ');
    return [productName, [quantity, unit].filter(Boolean).join(' '), deliveryLocation, specLine].filter(Boolean).join(' · ');
  }, [productName, quantity, unit, deliveryLocation, allSpecEntries]);

  // FULL requirement text — LOSSLESS: every fact the buyer gave (specs + logistics/payment + notes +
  // firm/GST + location) so nothing collected is dropped from the enquiry / WhatsApp hand-off.
  const buildRequirementText = () => {
    const payment = paymentTerms
      ? [paymentTerms, paymentTerms === 'Credit (Post-Delivery)' && creditPeriod, paymentMode && paymentTerms !== 'Credit (Post-Delivery)' && paymentTerms !== 'Loan/Finance' && paymentMode].filter(Boolean).join(' · ')
      : '';
    return [
      `Requirement: ${productName}`,
      qtyIsMeaningful(quantity) && `Quantity: ${[quantity, unit].filter(Boolean).join(' ')}`,
      ...allSpecEntries.map(([k, v]) => `${k}: ${v}`),
      deliveryLocation && `Deliver to: ${deliveryLocation}`,
      userLocation.trim() && userLocation.trim().toLowerCase() !== deliveryLocation.trim().toLowerCase() && `Buyer location: ${userLocation.trim()}`,
      deliveryTimeline && `Delivery timeline: ${deliveryTimeline}`,
      payment && `Payment: ${payment}`,
      buyerType && `Business type: ${buyerType}`,
      industry.trim() && `Industry: ${industry.trim()}`,
      // Purchase cadence, when relevant, is an LLM-driven AI-spec (page 2) → already in allSpecEntries above.
      // GST only for a business role (never for an individual buyer), and only once answered.
      isBusinessRole && gstRegistered === true && `GST: ${isValidGSTIN(gstNumber) ? gstNumber.trim().toUpperCase() : 'Registered'}`, // ship the number ONLY if it's a valid GSTIN, else just "Registered" (never garbage)
      isBusinessRole && gstRegistered === false && `GST: Not registered`,
      requirementNotes.trim() && `Notes: ${requirementNotes.trim()}`,
    ].filter(Boolean).join('\n');
  };
  const waDeeplink = () => `https://wa.me/?text=${encodeURIComponent(buildRequirementText() + '\n\n— sent via IndiaMART')}`;

  const hasUnits = unitOptions.length > 0;
  // Quantity + Unit are OPTIONAL now (owner) — a committed, resolved product is enough to continue.
  const canContinueProduct = !!productName.trim() && committed && unitsResolved;
  // Owner: if the category offers NO quantity/unit (and none was captured), there's nothing to fill on the
  // product page → skip straight to the specs page. Fires once per commit for a unit-less category.
  useEffect(() => {
    if (committed && unitsResolved && !hasUnits && !quantity.trim() && stage === 'product' && autoAdvancedFor.current !== mcatId) {
      autoAdvancedFor.current = mcatId; // once per product — tapping Back to this product won't re-bounce forward
      setStage('specs');
    }
  }, [committed, unitsResolved, hasUnits, quantity, stage, mcatId]);

  // Owner-locked 2026-07-27: the qty-first gate applies to EVERY entry mode, not just brand-new. Enrich/Repost/
  // Source seeds land directly on 'specs' (formAdapter.startStage), skipping the product-page qty ask entirely —
  // if this mcat DOES define quantity as a real concept and it isn't already filled (seeded), redirect back to
  // 'product' so the buyer is asked for it FIRST, same requirement the brand-new flow already has.
  useEffect(() => {
    if (stage === 'specs' && committed && unitsResolved && hasUnits && !quantity.trim() && qtyRedirectedFor.current !== mcatId) {
      qtyRedirectedFor.current = mcatId; // once per product — tapping Back here won't re-loop
      setStage('product');
    }
  }, [stage, committed, unitsResolved, hasUnits, quantity, mcatId]);

  // Owner (2026-07-23, reversed the earlier auto-skip): on an AI-specs FAILURE we no longer auto-advance past
  // the page. The buyer stays and sees a RETRY (re-fires the unified planner) plus a quiet "continue anyway" —
  // a transient gateway hiccup shouldn't silently rob the buyer of the smart questions. Loader shows while in flight.
  const retryAiSpecs = () => {
    plannerFiredFor.current = '';       // re-arm the once-per-(mcat:name:epoch:specSig) guard
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
      showFeedback('Great — your requirement is ready. You’ll get quotes from verified suppliers.', 'success');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blEligible]);

  // ⚑ DEV-TODO (BuyLead generation API — owner provides it later): POST this RFQSubmission to the real BL endpoint
  //   and gate the results/"sent" UI on its resolution. Include the image, all specs, qty, contact + the lossless
  //   text below. Today it's a STUB: emit the funnel conversion + hand the requirement to the host via onSubmit.
  const dispatchBuyLead = (contactOverride?: { name?: string; mobile?: string }) => {
    const contact = { name: contactOverride?.name || contactName, mobile: contactOverride?.mobile || contactMobile, email: contactEmail };
    const req: RFQSubmission = {
      productName, mcatId, text: buildRequirementText(), quantity, unit,
      specs: Object.fromEntries(allSpecEntries), contact, imageBase64: imageBase64 || undefined,
    };
    // audit #13: block only a TRUE duplicate (double-tap = identical content). If the buyer edited from the
    // results screen, the content signature differs → re-dispatch as an UPDATE so the host gets the edited data
    // (previously dispatchedRef swallowed it and the host kept the pre-edit requirement).
    const sig = JSON.stringify({ t: req.text, s: req.specs, q: req.quantity, u: req.unit, m: contact.mobile });
    if (dispatchedRef.current && sig === lastDispatchSigRef.current) return;
    const isUpdate = dispatchedRef.current;
    dispatchedRef.current = true;
    lastDispatchSigRef.current = sig;
    emit(EV.REQUIREMENT_SUBMITTED, { form: 'simple', surface: surfaceName, mcatId, specCount: allSpecEntries.length, hasQty: qtyIsMeaningful(quantity), usedImage: !!imageBase64, categoryMode, loggedIn: isLoggedIn, update: isUpdate });
    onSubmit?.(req);
  };

  const goBack = () => { if (stage === 'product') return onClose(); if (stage === 'specs') return setStage('product'); if (stage === 'more') return setStage('specs'); setStage('more'); };
  const submit = () => {
    // P1-101: never submit an empty RFQ (also closes the score-jump-to-'more'-with-no-product hole).
    if (!blEligible) { showFeedback('Add a quantity or pick at least one spec to get quotes.', 'warning'); return; }
    if (otpVerified.current) { dispatchBuyLead(); setStage('results'); return; }
    setShowOTP(true);
  };
  // Clickable top stepper: jump only to a VISITED node (index ≤ current) — never skip ahead.
  const goToNode = (target: Stage) => { if (stageNodeIdx(target) <= stageNodeIdx(stage)) setStage(target); };
  // Score-panel deep-link: map a score check to the stage that owns it, so tapping a missing item jumps
  // straight there (forward OR back — it's a shortcut). Product name/image/qty→product; Specifications (buyer
  // specs AND smart questions now share one page)→specs; everything in Details (location/timeline/payment/
  // buyer/profile/GST)→more.
  const checkStage = (c: ScoreCheck): Stage => (c.group === 'Product' ? 'product' : c.group === 'Specs' ? 'specs' : 'more');
  // Stable slug for a check (drops the dynamic "(n/m)" suffix) → matches a field's data-flash attribute.
  const slugCheck = (c: ScoreCheck) => c.label.split('(')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  // Flash ring applied to the target field while flashKey matches (cleared after 1.6s).
  const flashCls = (key: string) => (flashKey === key ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-white rounded-lg transition-shadow' : '');
  const jumpToCheck = (c: ScoreCheck) => {
    if (stage === 'results') return; // P2-256: the results stage is terminal — no jumping back into the flow
    setScoreOpen(false); setLocationEditing(false);
    setStage(checkStage(c));
    const key = slugCheck(c);
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
    // P2-202: never run the lead-salvage nudge after the buyer already converted (OTP verified / reached results).
    if (!exitIntentUsed.current && !otpVerified.current && stage !== 'product' && stage !== 'results') {
      exitIntentUsed.current = true;
      setStage('more'); setContactOpen(true); setScoreOpen(false); setLocationEditing(false);
      showToast('Almost there — just add your contact to get quotes.', 'info');
      return;
    }
    onClose();
  };
  handleExitRef.current = handleExit; // keep the ref pointing at the latest closure (for the Escape handler)
  const scrollCard = (d: 1 | -1) => { const el = cardScrollRef.current; if (!el) return; el.scrollBy({ left: d * el.clientWidth * 0.86, behavior: 'smooth' }); setCardIdx((i) => Math.max(0, Math.min(sellerResults.length - 1, i + d))); };

  const progressPercent = stage === 'specs' ? 50 : stage === 'more' ? 85 : stage === 'results' ? 100 : 0;

  // Persistent trust reassurance (owner/audit: proof lived only on the results screen). Shown at the entry so a
  // wary buyer sees WHY it's safe before typing / handing over details.
  const trustStrip = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
      <span className="flex items-center gap-1"><BadgeCheck size={13} className="text-green-600 shrink-0" /> Verified suppliers</span>
      <span className="flex items-center gap-1"><ShieldCheck size={13} className="text-teal-600 shrink-0" /> Payment protected</span>
      <span className="text-gray-300">·</span><span>100% free</span>
      <span className="text-gray-300">·</span><span>No spam calls</span>
    </div>
  );
  // ── Consent notice (DPDP/TRAI): shown on the final step, at the point of submission. Copy is a reasonable
  //    default — LEGAL to review the exact wording. Links point at IndiaMART's own public legal pages. ──
  const consentNote = (
    <p className="text-[11px] leading-relaxed text-gray-500 pt-1">
      By continuing, you agree to share this requirement with relevant verified suppliers, who may contact you about it, per IndiaMART's{' '}
      <a href="https://www.indiamart.com/terms-of-use.html" target="_blank" rel="noopener noreferrer" className="text-teal-600 underline underline-offset-2 hover:text-teal-700">Terms</a>{' '}and{' '}
      <a href="https://www.indiamart.com/privacy-policy.html" target="_blank" rel="noopener noreferrer" className="text-teal-600 underline underline-offset-2 hover:text-teal-700">Privacy Policy</a>.
    </p>
  );
  // ── The product input row (shared by mobile-Lens front page and desktop two-panel) ──
  const productInputRow = (
    <div data-flash="product-name" className={`relative ${flashCls('product-name')}`}>
      <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100 bg-white">
        {isMobile && <Search className="w-4 h-4 text-gray-300 ml-3.5 shrink-0" />}
        <input
          ref={productInputRef}
          type="text" value={productName}
          aria-label="Product or service name"
          onChange={(e) => onProductInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && productName.trim()) commitProduct(productName.trim()); }}
          onFocus={() => { if (suppressFocusOpenRef.current) { suppressFocusOpenRef.current = false; return; } if (suggestions.length || (recents.length && !productName.trim())) setShowDropdown(true); }}
          onClick={() => { if (suggestions.length || (recents.length && !productName.trim())) setShowDropdown(true); }} // a real tap always counts as "bringing the cursor to the box" — reveals recents even when the field is already auto-focused
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          placeholder={isMobile ? 'What are you looking to buy?' : 'e.g., TMT Bar, Diesel Generator…'}
          className="flex-1 min-w-0 px-4 py-3 text-base sm:text-sm outline-none bg-transparent"
        />
        <button type="button" disabled={!!aiBusy} onClick={() => setShowVoice(true)} aria-label="Speak your requirement" className="flex items-center justify-center px-3 text-green-600 border-l border-gray-100 hover:bg-green-50 py-3 disabled:opacity-40 disabled:cursor-not-allowed"><Mic size={18} /></button>
        <button type="button" data-flash="product-image" disabled={!!aiBusy} onClick={() => fileRef.current?.click()} aria-label="Upload a product photo" className={`px-3 text-teal-600 border-l border-gray-100 hover:bg-teal-50 py-3 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg ${flashCls('product-image')}`}><Camera size={16} /></button>
      </div>
      {resolving && <span className="absolute right-24 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />}
      {showDropdown && (suggestions.length > 0 || (recents.length > 0 && !productName.trim())) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden max-h-52 overflow-y-auto">
          {suggestions.length === 0 && !productName.trim() && recents.length > 0 && (
            <>
              <p className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Recent searches</p>
              {recents.map((r) => (<button key={r} onMouseDown={() => commitProduct(r)} className="w-full flex items-center gap-2 text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700"><Clock size={13} className="text-gray-300 shrink-0" />{r}</button>))}
            </>
          )}
          {suggestions.map((s) => (<button key={s} onMouseDown={() => commitProduct(s)} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700">{s}</button>))}
        </div>
      )}
      {notFound && <p role="alert" className="text-xs text-amber-600 mt-1.5">Couldn&apos;t match that to a category — try a more specific product name.</p>}
      {resolveError && <p role="alert" className="text-xs text-red-500 mt-1.5">Network issue reaching the catalog — <button type="button" onClick={() => commitProduct(productName)} className="font-semibold underline">tap to retry</button>.</p>}
    </div>
  );

  // Quantity + Unit block (once a product is committed). Quantity + Unit render ONLY when the category's
  // API actually provides units; otherwise they are hidden (and not required) — mobile still gets a
  // Continue affordance so the buyer can advance.
  const qtyUnitBlock = committed && (
    <div className="mt-4 space-y-4 animate-field-in">
      {hasUnits ? (
        <>
          {/* Quantity + Unit side-by-side on desktop; stacked on mobile (width). Both optional (owner). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
              <input ref={qtyRef} data-flash="quantity" type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(sanitizeQty(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter' && canContinueProduct) setStage('specs'); }} className={`w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 animate-field-highlight ${flashCls('quantity')}`} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Unit</label>
              <div className="flex flex-wrap gap-2">{unitOptions.map((u) => <RadioChip key={u} label={u} selected={unit === u} onClick={() => setUnit(unitOptions.length === 1 ? u : (unit === u ? '' : u))} />)}</div>
            </div>
          </div>
          {isMobile && <button type="button" disabled={!canContinueProduct} onClick={() => canContinueProduct && setStage('specs')} className={`w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${canContinueProduct ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-gray-100 text-gray-400'}`}>Continue <ArrowRight className="w-4 h-4" /></button>}
        </>
      ) : (
        <div className="space-y-4">
          {/* No API units for this category → qty/unit not required. But if voice/photo/name CAPTURED a
              quantity, show it editable so the buyer can see/correct it (never a hidden-but-submitted fact). */}
          {quantity.trim() && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
              <input ref={qtyRef} data-flash="quantity" type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(sanitizeQty(e.target.value))} className={`w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${flashCls('quantity')}`} />
            </div>
          )}
          {isMobile && <button type="button" disabled={!canContinueProduct} onClick={() => canContinueProduct && setStage('specs')} className={`w-full py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${canContinueProduct ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-gray-100 text-gray-400'}`}>Continue <ArrowRight className="w-4 h-4" /></button>}
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
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mt-1">{getScoreLabel(scoreDetails.total)} · RFQ strength</span>
            </div>
            <div className="space-y-3">
              {(['Product', 'Specs', 'Details'] as const).map((g) => {
                const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
                if (!items.length) return null;
                return (
                  <div key={g}>
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{g}</p>
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
            {nextCheck && <button type="button" onClick={() => jumpToCheck(nextCheck)} className="mt-3 w-full flex items-center justify-between text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 hover:bg-amber-100 transition-colors"><span><span className="font-semibold uppercase tracking-wide text-[10px] text-amber-600">Fill next</span> · {nextCheck.label} <span className="font-semibold">+{nextCheck.pts - nextCheck.earned}</span></span><ArrowRight size={13} /></button>}
          </div>
        </>
      )}
    </div>
  );

  // ── Shared location controls (current-location + your/delivery + same-as). Rendered INLINE on mobile
  //    (owner: "no popups/drawers on mobile → inline sections", P1-106) and inside the DESKTOP anchored popover. ──
  const locationFields = (
    <>
      {/* ① Use my current location (browser GPS → reverse-geocode; falls back to IP city) */}
      <button type="button" onClick={useCurrentLocation} disabled={geoLoading} className="w-full flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-sm font-semibold hover:bg-teal-100 disabled:opacity-60">
        {geoLoading ? <span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" /> : <LocateFixed size={15} />} Use my current location
      </button>
      {/* ② Your location */}
      <div>
        <p className="text-[11px] uppercase font-semibold text-gray-500 tracking-wide mb-1">Your location</p>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
          <input type="text" aria-label="Your location" value={userLocation} onChange={(e) => applyUserCity(e.target.value)} placeholder="Search city…" className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
        </div>
      </div>
      {/* ③ Delivery location (disabled while "same as" is on) */}
      <div>
        <p className="text-[11px] uppercase font-semibold text-gray-500 tracking-wide mb-1">Delivery location</p>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
          <input type="text" aria-label="Delivery location" value={deliveryLocation} disabled={sameAsLoc} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="Search city…" className={`w-full border rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${sameAsLoc ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed' : 'border-gray-200'}`} />
        </div>
      </div>
      {/* ④ Same as my location */}
      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
        <input type="checkbox" checked={sameAsLoc} onChange={toggleSameAs} className="accent-teal-600 w-4 h-4" />
        Delivery is same as my location
      </label>
    </>
  );

  // Location editor: a BOTTOM-SHEET DRAWER on mobile (owner prefers the drawer — inline took too much last-page
  // space), an ANCHORED popover on desktop. Same controls, two presentations via the sm: breakpoint.
  const renderLocationPopover = (align: 'left' | 'right' = 'right') => (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setLocationEditing(false)} />
      <div className={`fixed inset-x-0 bottom-0 z-40 w-full rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left space-y-3 bg-white shadow-[0_-8px_32px_-4px_rgba(30,42,58,0.18)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-3rem)] sm:rounded-xl sm:border sm:p-3 sm:shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)] ${align === 'left' ? 'sm:left-0' : 'sm:right-0'}`} style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-1 sm:hidden" />
        {locationFields}
        <button type="button" onClick={() => setLocationEditing(false)} className="w-full py-2.5 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700">Done</button>
      </div>
    </>
  );

  // ── Spec fields (ALL buyer specs, one list). Shows the unified planner's field_hint when present. ──
  const renderSpecField = (s: ISQSpec) => {
    const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
    const hint = isqHints[s.IM_SPEC_MASTER_DESC];
    // FABRICATION FIREWALL: an OBSERVED-tier seed (engine action CONFIRM) came from something the buyer
    // BROWSED — often a seller's catalogue row — not from anything he said. It is still pre-filled so he
    // doesn't retype it, but it must carry its real source and read as "confirm this", never as his own word.
    // Only badge it while it still holds the seeded value; the moment he edits it, it's his.
    const observedWhy = _seed?.observedFields?.[s.IM_SPEC_MASTER_DESC];
    const stillSeeded = observedWhy && specValues[s.IM_SPEC_MASTER_DESC] === _seed?.specValues?.[s.IM_SPEC_MASTER_DESC];
    return (
      <div key={s.IM_SPEC_MASTER_DESC} className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">{s.IM_SPEC_MASTER_DESC}{hint && <span className="ml-2 font-normal text-gray-500">— {hint}</span>}
          {stillSeeded && <span className="ml-2 font-normal text-amber-700">· {observedWhy} — confirm</span>}
        </label>
        {opts.length > 0 ? <OptionChips ariaLabel={s.IM_SPEC_MASTER_DESC} options={opts} value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(v) => setSpecValue(s.IM_SPEC_MASTER_DESC, v)} />
          : <input type="text" value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(e) => setSpecValue(s.IM_SPEC_MASTER_DESC, e.target.value)} placeholder={hint || `Enter ${s.IM_SPEC_MASTER_DESC.toLowerCase()}`} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400" />}
      </div>
    );
  };

  // Show ALL buyer specs (owner: "show all buyer specs on page 1"). We deliberately DON'T hide any as
  // "redundant" — hiding them asynchronously made specs "appear then vanish" ~1s after the page rendered
  // (the owner-reported bug). The planner still PREFILLS known values + adds hints; it just never removes a field.
  const visibleSpecs = isqSpecs;
  // "Also detected" — extracted buyer-truth that isn't a buyer ISQ field; editable/removable, and shipped.
  const extraKeys = Object.keys(extraSpecs);
  const extrasSection = extraKeys.length > 0 && (
    <div className="pt-3 border-t border-gray-100">
      <p className="text-xs uppercase font-semibold text-gray-500 tracking-wide mb-2 flex items-center gap-1.5"><ListPlus size={13} className="text-teal-500" /> Also detected <span className="font-normal normal-case text-gray-500">— from your photo / voice · edit or remove</span></p>
      <div className="space-y-2">
        {extraKeys.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <span className="text-sm text-gray-600 w-2/5 shrink-0 truncate" title={k}>{k}</span>
            <input value={extraSpecs[k]} onChange={(e) => setExtraValue(k, e.target.value)} aria-label={k} className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <button type="button" onClick={() => removeExtra(k)} aria-label={`Remove ${k}`} className="w-9 h-9 shrink-0 rounded-lg text-gray-500 hover:text-red-500 hover:bg-red-50 flex items-center justify-center"><X size={15} /></button>
          </div>
        ))}
      </div>
    </div>
  );
  const specBody = specsLoading && isqSpecs.length === 0 && extraKeys.length === 0 ? (
    <p className="text-sm text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Fetching category spec fields…</p>
  ) : (
    <div data-flash="specifications" className={`space-y-5 ${flashCls('specifications')}`}>
      {/* Use-case assist entry (ported from Quick Quote): "Not sure what to pick? Tell us your use-case and we'll
          fill it for you" → opens the "Help me fill the specs" popup (its own LLM, prioritized over photo/mic). */}
      {hasFormLLM() && isqSpecs.length > 0 && (
        <button type="button" onClick={() => setAssistOpen(true)} className="w-full flex items-center gap-2 text-left rounded-xl border border-teal-200 bg-teal-50/60 px-3.5 py-2.5 text-sm text-teal-800 hover:bg-teal-50 transition-colors">
          <span className="text-teal-500 shrink-0">✦</span>
          <span className="min-w-0">Not sure what to pick? <span className="font-semibold">Tell us your use-case</span> and we'll fill it for you.</span>
        </button>
      )}
      {/* ALL buyer specs on page 1 (owner 2026-07-21) — the buyer's own requirement-form fields. */}
      {visibleSpecs.map(renderSpecField)}
      {isqSpecs.length === 0 && extraKeys.length === 0 && <p className="text-sm text-gray-500">No standard specs for this product — continue to the smart questions →</p>}
      {extrasSection}
    </div>
  );

  // ── Page 2 · AI specs (the unified planner's ranked `gaps`) — options-only questions ──
  // Filter out any question a late authoritative getISQs has since made a page-1 ISQ field (no dup ask).
  const isqNameSet = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
  const visibleAiSpecs = aiSpecs.filter((q) => !isqNameSet.has(q.fieldName.toLowerCase()));
  const aiSpecsBody = (
    <div data-flash="smart-questions" className={`space-y-5 ${flashCls('smart-questions')}`}>
      {/* (Category-corpus status chip removed — it was a dev/debug line, not for buyers. The corpus still loads
          in the background for Category mode; it's just no longer surfaced.) */}
      {aiSpecsLoading && visibleAiSpecs.length === 0 && !identityAsk && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Preparing smart questions…</p>
          <button type="button" onClick={() => setStage('more')} className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-600 shrink-0">Skip for now</button>
        </div>
      )}
      {!aiSpecsLoading && visibleAiSpecs.length === 0 && !identityAsk && (
        aiSpecsError ? (
          // FAILURE → retry (re-fires the planner) + a quiet continue. We DON'T auto-skip (owner) — a transient
          // gateway blip shouldn't silently drop the smart questions.
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-gray-500">Couldn’t load smart questions right now.</p>
            <div className="flex items-center gap-4">
              <button type="button" onClick={retryAiSpecs} className="flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700"><RotateCcw size={15} /> Retry</button>
              <button type="button" onClick={() => setStage('more')} className="text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700">Continue anyway →</button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">{!hasFormLLM() ? 'You can add any extra details on the next step. →' : 'No extra questions needed — your specs already cover it. Continue →'}</p>
        )
      )}
      {/* Identity-in-planner (owner-locked 2026-07-27): rendered with the SAME chip UI as any other gap question,
          no special treatment — the planner promoted this only because it ranked among the top gaps for THIS
          buyer. Answering it here is what removes the GST ask from P3 (see gstHandledElsewhere). */}
      {identityAsk && (() => {
        const opts = identityAsk.options?.length ? identityAsk.options : ['Yes, registered', 'Not yet'];
        return (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              {identityAsk.q}
              {identityAsk.why && <span className="ml-2 font-normal text-gray-500">— {identityAsk.why}</span>}
            </label>
            <OptionChips ariaLabel={identityAsk.q} options={opts} value={gstRegistered === true ? opts[0] : gstRegistered === false ? opts[1] : ''} onChange={(v) => setGstRegistered(v === opts[0])} />
          </div>
        );
      })()}
      {visibleAiSpecs.map((q) => (
        <div key={q.fieldName} className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            {q.fieldName}
            {q.helperText && <span className="ml-2 font-normal text-gray-500">— {q.helperText}</span>}
            {q.prefill && aiSpecValues[q.fieldName] === q.prefill && <span className="ml-2 font-normal text-teal-600">✦ from your input</span>}
          </label>
          <OptionChips ariaLabel={q.fieldName} options={q.options} value={aiSpecValues[q.fieldName] || ''} onChange={(v) => setAiSpecValues((p) => ({ ...p, [q.fieldName]: v }))} />
        </div>
      ))}
    </div>
  );

  // ── More Details (V3 renderDeliveryPage cards, deterministic) ──
  const showPaymentMode = !!paymentTerms && paymentTerms !== 'Credit (Post-Delivery)' && paymentTerms !== 'Loan/Finance';
  // ── Last page pieces (owner order): Logistics & Payment FIRST, then About You, then Contact (collapsed). ──
  const logisticsBody = (
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        {/* Delivery location = a COMPACT ROW in the card that opens the drawer/popover — SAME on mobile AND desktop
            (owner: the desktop header pill hid the city; use the mobile pattern so the city is always visible). */}
        <div data-flash="delivery-location" className={`mb-4 relative ${flashCls('delivery-location')}`}>
          <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide"><MapPin size={13} className="text-teal-500" /> Delivery location</p>
          <button type="button" onClick={() => { setScoreOpen(false); setLocationEditing((v) => !v); }} className="w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 hover:border-teal-300">
            <span className="truncate flex items-center gap-1.5"><MapPin size={13} className="text-gray-300 shrink-0" />{deliveryLocation || detectedCity || 'Select delivery city'}</span>
            <Pencil size={13} className="text-gray-500 shrink-0" />
          </button>
          {locationEditing && renderLocationPopover('left')}
        </div>
        <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
          <div data-flash="delivery-timeline" className={flashCls('delivery-timeline')}>
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide"><Clock size={13} className="text-teal-500" /> Delivery</p>
            <div className="flex flex-wrap gap-2">{TIMELINE.map((t) => <RadioChip key={t} label={t} selected={deliveryTimeline === t} onClick={() => setDeliveryTimeline(t)} />)}</div>
          </div>
          <div data-flash="payment-terms" className={flashCls('payment-terms')}>
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide"><CreditCard size={13} className="text-teal-500" /> Payment terms</p>
            <div className="flex flex-wrap gap-2">{PAYMENT_TERMS.map((t) => <RadioChip key={t} label={t} selected={paymentTerms === t} onClick={() => setPaymentTerms(t)} />)}</div>
          </div>
        </div>
        {paymentTerms === 'Credit (Post-Delivery)' && (
          <div className="mt-4"><p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Credit period</p><div className="flex flex-wrap gap-2">{CREDIT_PERIODS.map((c) => <RadioChip key={c} label={c} selected={creditPeriod === c} onClick={() => setCreditPeriod(c)} />)}</div></div>
        )}
        {showPaymentMode && (
          <div className="mt-4"><p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Payment mode</p><div className="flex flex-wrap gap-2">{PAYMENT_MODES.map((m) => <RadioChip key={m} label={m} selected={paymentMode === m} onClick={() => setPaymentMode(m)} />)}</div></div>
        )}
      </div>
  );

  // Contact — subtle, collapsed by default, placed AFTER About You on the last page (owner). Logged-out keeps
  // the "(confirmed at OTP)" hint; logged-in is pre-filled + this whole card is hidden.
  const contactBody = (
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <button type="button" onClick={() => setContactOpen((v) => !v)} className="w-full flex items-center justify-between">
          <span className="text-xs uppercase font-semibold text-gray-500 tracking-wide">Contact details</span>
          {contactOpen ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-500" />}
        </button>
        {contactOpen && (
          <div className="space-y-3 mt-4">
            <input type="text" aria-label="Your name" autoComplete="name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400"><span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200">+91</span><input type="tel" aria-label="Mobile number" autoComplete="tel-national" value={contactMobile} onChange={(e) => setContactMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile" className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none" /></div>
            <input type="email" aria-label="Email address (optional)" autoComplete="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <textarea aria-label="Additional requirement details" value={requirementNotes} onChange={(e) => setRequirementNotes(e.target.value)} rows={2} placeholder="Any specific requirement, grade, packaging…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
          </div>
        )}
      </div>
  );

  // ── More Details (stage 'more') = About You. Logged-out shows the Login button + autofetch banner.
  // Identity-in-planner (owner-locked 2026-07-27; CORRECTED 2026-07-28): the card hides only when EVERY child
  // hides (aboutYouHasContent, derived per-field above). A known-from-profile fact is shown BACK with its source,
  // never silently hidden — hiding a prefill breaks the trust receipt and the CONFIRMED stage of TUS. ──
  const moreBody = !aboutYouHasContent ? null : (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="text-xs uppercase font-semibold text-gray-500 tracking-wide">About you <span className="text-gray-500 normal-case font-normal">(optional)</span></p>
          {isLoggedIn
            ? <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 shrink-0"><CheckCircle2 size={14} /> {contactName || 'Logged in'}</span>
            : <button type="button" onClick={handleLogin} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 shrink-0"><LogIn size={13} /> Login</button>}
        </div>
        <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
          {showBuyerTypeField && (
          <div data-flash="buyer-type" className={flashCls('buyer-type')}>
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Business type
              {/* provenance, not a silent fill — the buyer can see WHY it's pre-selected and change it for THIS order */}
              {buyerTypeFromProfile && <span className="ml-2 normal-case font-normal text-teal-600">✦ from your profile</span>}
            </p>
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
        {/* GST, three mutually-exclusive states (V3 rule: business roles only — never an Individual Buyer):
            BADGE     → already verified on file (bp/od/d). Shown back, never re-asked, never silently dropped.
            ECHO      → the planner promoted the ask onto P2 and the buyer answered it there — confirm it landed.
            QUESTION  → genuinely unknown and not asked anywhere else. Golden Rule: null = UNKNOWN, never "No". */}
        {showGstBadge && (
          <div data-flash="gst" className={`mt-4 pt-4 border-t border-gray-100 ${flashCls('gst')}`}>
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST</p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1.5 text-[13px] font-medium text-green-700"><CheckCircle2 size={14} /> GST verified <span className="font-normal text-green-600/80">· from your IndiaMART profile</span></span>
          </div>
        )}
        {showGstAnswered && (
          <div data-flash="gst" className={`mt-4 pt-4 border-t border-gray-100 ${flashCls('gst')}`}>
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST</p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-[13px] font-medium text-teal-800"><CheckCircle2 size={14} /> {gstRegistered ? 'Registered' : 'Not registered'} <span className="font-normal text-teal-700/80">· you answered this above</span></span>
            {gstRegistered === true && (
              <input type="text" aria-label="GST number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} placeholder="GST number (15 digits)" className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            )}
          </div>
        )}
        {showGstQuestion && (
          <div data-flash="gst" className={`mt-4 pt-4 border-t border-gray-100 animate-field-in ${flashCls('gst')}`}>
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
        )}
      </div>
    </div>
  );

  // ── Curated sellers (results) — REAL data ──
  // Cards render the live ranked sellers from the windmill curated_seller_search API (src/lib/sellerSearch.ts),
  // fired back on the specs→page-2 move and streamed in here (sellerStatus: idle/loading→progress, done→cards,
  // error/empty→graceful message). ⚑ DEV-TODO: "Send Enquiry" / Call / WhatsApp are still DEMO CTAs — wire the
  //   real per-seller dispatch using s.id (glusrid); the BuyLead is already generated at submit via
  //   dispatchBuyLead, so gate "Enquiry sent" on a real POST when that endpoint is provided.
  const resultsBody = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 min-w-0 truncate"><span className="font-semibold text-gray-800">Your requirement:</span> {requirementSummary}</p>
        <button type="button" onClick={() => setStage('specs')} aria-label="Edit" className="shrink-0 w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-500 hover:text-teal-600 hover:border-teal-300"><Pencil className="w-3.5 h-3.5" /></button>
      </div>
      {/* Seller results stream in from the real windmill search (fired back on the specs→page-2 move). */}
      {(sellerStatus === 'idle' || sellerStatus === 'loading') && <SellerSearchProgress productName={productName} />}
      {sellerStatus === 'error' && (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/60 px-5 py-6 text-center">
          <p className="text-sm font-semibold text-gray-800">Your requirement is submitted ✅</p>
          <p className="text-xs text-gray-600 mt-1.5">We're still matching you with verified suppliers — quotes will reach you shortly on WhatsApp &amp; email.</p>
        </div>
      )}
      {sellerStatus === 'done' && sellerResults.length === 0 && (
        <div className="rounded-2xl border border-gray-100 bg-gray-50 px-5 py-6 text-center">
          <p className="text-sm font-semibold text-gray-800">Requirement received ✅</p>
          <p className="text-xs text-gray-600 mt-1.5">We're lining up the best suppliers for “{productName}” and will send quotes shortly.</p>
        </div>
      )}
      {sellerStatus === 'done' && sellerResults.length > 0 && (<>
      <div className="flex items-center justify-between">
        <div><h3 className="text-base font-bold text-gray-800">Curated Sellers For You</h3><p className="text-xs text-gray-500">{sellerResults.length} verified supplier{sellerResults.length > 1 ? 's' : ''} matched to your requirement</p></div>
        {!isMobile && <div className="flex gap-1.5"><button type="button" onClick={() => scrollCard(-1)} className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button><button type="button" onClick={() => scrollCard(1)} className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button></div>}
      </div>
      <div ref={cardScrollRef} onScroll={(e) => setCardIdx(Math.round(e.currentTarget.scrollLeft / (e.currentTarget.clientWidth * 0.86)))} className="flex gap-3 overflow-x-auto snap-x snap-mandatory -mx-1 px-1 pb-2 scroll-smooth">
        {sellerResults.map((s, si) => {
          const key = s.id || s.name; const sent = sentTo.has(key); const open = openEnquiry === key;
          const cardImg = s.image || productImages[si] || productImageUrl; // seller's own listing photo, then fallbacks
          return (
            <div key={key} className={`snap-center shrink-0 ${isMobile ? 'w-[86%]' : 'w-[300px]'} bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden`}>
              <div className="relative bg-gray-50" style={{ aspectRatio: '4/3' }}>
                <span className="absolute top-3 left-3 z-10 bg-black/80 text-white text-xs font-semibold px-2.5 py-1 rounded-full">Get Best Price</span>
                {cardImg ? <><img src={cardImg} alt="" className="w-full h-full object-contain p-4" /><span className="absolute bottom-2 left-2 z-10 text-[10px] text-gray-500 bg-white/85 px-1.5 py-0.5 rounded">Representative image</span></> : <div className="w-full h-full flex items-center justify-center"><Package className="w-10 h-10 text-gray-300" /></div>}
              </div>
              <div className="p-4 space-y-2">
                <p className="font-bold text-gray-800">{s.name}</p>
                <p className="flex items-center gap-1 text-sm text-gray-500"><MapPin className="w-3.5 h-3.5" /> {s.city}{s.distanceKm != null && s.distanceKm > 0 ? ` · ${Math.round(s.distanceKm)} km` : ''}</p>
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  {s.gst && <span className="flex items-center gap-1"><BadgeCheck className="w-3.5 h-3.5 text-green-600" /> GST</span>}
                  {s.trustSeal && <span className="flex items-center gap-1"><Award className="w-3.5 h-3.5 text-amber-500" /> TrustSEAL</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {s.tenureYears != null && <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {s.tenureYears} yrs</span>}
                  {s.rating != null && <span className="flex items-center gap-1"><Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" /> {s.rating}{s.reviews > 0 ? ` (${s.reviews})` : ''}</span>}
                </div>
                {open ? (
                  <div className="pt-1 space-y-2 animate-field-in">
                    <textarea readOnly rows={5} value={`Hi ${s.name}, I need:\n${buildRequirementText()}`} className="w-full text-xs text-gray-700 border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 resize-none" />
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => { setSentTo((p) => new Set(p).add(key)); setOpenEnquiry(null); showFeedback(`Enquiry sent to ${s.name}`, 'success'); }} className="flex-1 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold">Send</button>
                      {isMobile && <a href={waDeeplink()} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-[#25D366] text-white text-sm font-semibold"><MessageCircle className="w-4 h-4" /> WhatsApp</a>}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pt-1">
                    <button type="button" onClick={() => setOpenEnquiry(key)} disabled={sent} className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold ${sent ? 'bg-green-50 text-green-700' : 'bg-teal-600 hover:bg-teal-700 text-white'}`}>{sent ? '✓ Enquiry sent' : <><Send className="w-3.5 h-3.5" /> Send Enquiry</>}</button>
                    <button type="button" aria-label="Call" className="w-10 h-10 shrink-0 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600"><Phone className="w-4 h-4" /></button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-center gap-1.5">{sellerResults.map((_, i) => <span key={i} className={`h-1.5 rounded-full transition-all ${i === cardIdx ? 'w-5 bg-teal-500' : 'w-1.5 bg-gray-200'}`} />)}</div>
      </>)}
    </div>
  );

  // ── The single-panel (steps 1/2/results) — V3 chrome. ──
  const singlePanel = (
    // HD FIX: on the standalone full-page route the flow steps used to fill flex-1 edge-to-edge (~1600px) next to
    // the rail — cap + centre them to match the already-capped product page (max-w-2xl) and popup card. Mobile stays
    // full-width; popup is already capped by the card shell.
    <div className={`flex flex-col ${isMobile || standalone ? 'h-full' : 'h-[78vh] min-h-[560px] max-h-[92vh]'} min-h-0 ${standalone ? 'max-w-2xl lg:max-w-3xl w-full mx-auto' : ''}`}>
      <div className="px-5 pt-4 pb-0 flex items-center gap-3 shrink-0">
        {isMobile
          ? <>
              <button onClick={goBack} aria-label="Back" className="w-11 h-11 -ml-1.5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"><ArrowLeft className="w-5 h-5" /></button>
              {/* Carried-forward photo (owner): once a photo is attached it stays VISIBLE on specs/last page on mobile too
                  (desktop shows it in the header thumb below) — tap to change. Shown regardless of AI-extraction success. */}
              {imageBase64 && stage !== 'product' && <button onClick={() => fileRef.current?.click()} aria-label="Your product photo — tap to change" className="w-9 h-9 rounded-lg border border-gray-200 overflow-hidden shrink-0"><img src={`data:image/jpeg;base64,${imageBase64}`} className="w-full h-full object-cover" alt="Your product photo" /></button>}
            </>
          : <button onClick={() => fileRef.current?.click()} aria-label={imageBase64 ? 'Your product photo — tap to change' : 'Add a product photo'} className="w-10 h-10 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-500 hover:border-teal-300 shrink-0 overflow-hidden">{imageBase64 ? <img src={`data:image/jpeg;base64,${imageBase64}`} className="w-full h-full object-cover rounded-xl" alt="Your product photo" /> : <Camera size={16} />}</button>}
        <div className="flex-1 min-w-0">
          <p className="font-bold text-teal-600 text-base leading-tight truncate">{productName}</p>
        </div>
        {/* (Desktop header delivery-pill removed — the city hid there; delivery now lives as a compact row in the
            Logistics card on BOTH surfaces, matching the mobile UI so the city is always visible — owner.) */}
        {!standalone && stage !== 'results' && scoreCircle}
        {/* Keyboard-safe mobile CTA (owner): the footer Next/Get-Quotes sits behind the on-screen keyboard on
            text-input stages, so mirror it into the always-visible header. Footer stays for the non-keyboard case. */}
        {isMobile && stage !== 'results' && (() => {
          const holding = stage === 'specs' && aiSpecsLoading; // P2-203: hold on mobile while smart questions load (was a silent skip)
          return (
            <button type="button" disabled={holding} onClick={() => { if (stage === 'specs') setStage('more'); else submit(); }} className={`flex items-center gap-1 shrink-0 text-white text-sm font-semibold min-h-[40px] px-4 py-2 rounded-lg ${holding ? 'bg-gray-300 cursor-not-allowed' : 'bg-teal-600 hover:bg-teal-700'}`}>
              {holding ? 'Preparing…' : stage === 'more' ? 'Get Quotes' : 'Next'} {!holding && <ArrowRight size={13} />}
            </button>
          );
        })()}
        {!isMobile && !standalone && <button onClick={handleExit} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 ml-1 shrink-0"><X size={14} /></button>}
      </div>
      {/* Clickable stage stepper (owner MSite redesign): a per-stage ICON for every node, colored by
          passed/current/upcoming; the stage NAME shows only for the CURRENT stage on mobile (all labels on
          desktop). Passed icons (idx ≤ current) are clickable to jump back. A green blinking dot sits on the
          "More Details" node while the AI smart-questions are being prepared in the background. */}
      {stage !== 'results' && <>
      <div className="mx-5 mt-3 flex items-center gap-1 shrink-0 overflow-x-auto scroll-auto-hide">
        {STEPPER.map((node, i) => {
          const cur = stageNodeIdx(stage);
          const done = i < cur, active = i === cur, clickable = i <= cur;
          const Icon = node.Icon;
          const running = node.stage === 'specs' && aiSpecsLoading;
          return (
            <div key={node.stage} className="flex items-center gap-1 shrink-0">
              <button type="button" disabled={!clickable} onClick={() => goToNode(node.stage)} aria-label={node.label} aria-current={active ? 'step' : undefined}
                className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[11px] font-semibold transition-colors ${active ? 'text-teal-700' : done ? 'text-teal-600 hover:bg-gray-50' : 'text-gray-300 cursor-default'}`}>
                <span className={`relative w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${active ? 'bg-teal-600 text-white' : done ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'}`}>
                  <Icon size={13} />
                  {running && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 ring-2 ring-white animate-pulse" />}
                </span>
                {/* Show only the ACTIVE label until there's real room (lg+). On narrow/zoomed desktop widths the
                    4 full labels ("Your Profile & Delivery" is long) overflowed the stepper — hide non-active below lg. */}
                <span className={`whitespace-nowrap ${active ? '' : 'hidden lg:inline'}`}>{node.label}</span>
              </button>
              {i < STEPPER.length - 1 && <span className={`h-px shrink-0 ${isMobile ? 'w-3' : 'w-2.5'} ${done ? 'bg-teal-300' : 'bg-gray-200'}`} />}
            </div>
          );
        })}
      </div>
      <div className="mx-5 mt-2 h-0.5 bg-gray-100 rounded-full overflow-hidden shrink-0"><div className="h-full bg-teal-500 rounded-full transition-all duration-500" style={{ width: progressPercent + '%' }} /></div>
      </>}
      {aiBusy && <div role="status" aria-live="polite" className="shrink-0 mx-5 mt-2 px-3 py-1.5 flex items-center gap-2 text-[12px] text-teal-700 bg-teal-50 rounded-lg"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</div>}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div ref={bodyScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-auto-hide px-5 py-5">
          {/* STEP-1 TRANSPARENCY — what the Engine filled / corrected from the buyer's own truth, each with its source. */}
          {stage === 'specs' && planCorrections.length > 0 && (
            <div className="mb-3 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Filled from your history</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {planCorrections.map((p, i) => (
                  <span key={i} className={`inline-flex flex-wrap items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] ${p.corrected_from ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-teal-200 bg-teal-50 text-teal-800'}`}>
                    <span className="font-medium">{p.field}:</span> {p.value}
                    {p.corrected_from ? <span className="text-amber-600">· corrected from {p.corrected_from}</span> : null}
                    <span className="text-gray-400">· {p.source}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* THE BUYER-AWARE FIRST QUESTION — shown above the specs on the landing stage. */}
          {stage === 'specs' && (baqLoading || baq?.opening) && (
            <div className="mb-4 rounded-2xl border border-teal-200 bg-teal-50/70 p-4">
              {baqLoading && !baq ? (
                <div className="flex items-center gap-2 text-[13px] text-teal-700"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Reading what you're after…</div>
              ) : baq?.opening ? (
                <>
                  <p className="text-[15px] font-semibold text-gray-900">{baq.opening.q}</p>
                  {baq.opening.why && <p className="mt-0.5 text-[11.5px] text-teal-700/80">{baq.opening.why}</p>}
                  {baq.opening.options?.length ? (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {baq.opening.options.map((o) => (
                        <button key={o} type="button" onClick={() => setBaqAnswers((a) => ({ ...a, opening: o }))}
                          className={`rounded-full border px-3 py-1.5 text-[13px] ${baqAnswers.opening === o ? 'border-teal-600 bg-teal-600 text-white' : 'border-teal-300 bg-white text-teal-800'}`}>{o}</button>
                      ))}
                    </div>
                  ) : (
                    <input value={baqAnswers.opening ?? ''} onChange={(e) => setBaqAnswers((a) => ({ ...a, opening: e.target.value }))}
                      placeholder="Type your answer" className="mt-2 w-full rounded-lg border border-teal-300 bg-white px-3 py-2 text-sm" />
                  )}
                  {baq.gaps?.length ? (
                    <div className="mt-3 space-y-2.5 border-t border-teal-200/70 pt-3">
                      {baq.gaps.map((g, i) => (
                        <div key={i}>
                          <p className="text-[13.5px] font-medium text-gray-800">{g.q}</p>
                          {g.options?.length ? (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {g.options.map((o) => (
                                <button key={o} type="button" onClick={() => setBaqAnswers((a) => ({ ...a, [`gap${i}`]: o }))}
                                  className={`rounded-full border px-2.5 py-1 text-[12.5px] ${baqAnswers[`gap${i}`] === o ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-gray-300 text-gray-700'}`}>{o}</button>
                              ))}
                            </div>
                          ) : (
                            <input value={baqAnswers[`gap${i}`] ?? ''} onChange={(e) => setBaqAnswers((a) => ({ ...a, [`gap${i}`]: e.target.value }))}
                              placeholder="Type your answer" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
          {stage === 'specs' ? <>{specBody}{aiSpecsBody}</> : stage === 'more' ? <div className="space-y-4">{logisticsBody}{moreBody}{contactBody}{consentNote}</div> : resultsBody}</div>
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
            <span className="sm:hidden text-xs">Step {stageNodeIdx(stage)}/2{stage === 'more' ? ' · Last!' : ''}</span>
            <span className="hidden sm:inline text-sm truncate">Step {stageNodeIdx(stage)} of 2{stage === 'more' ? ' · Last step!' : ''}</span>
          </span>
          {stage === 'specs'
            ? (aiSpecsLoading
              // HOLD while the AI-specs call is in flight (owner-locked): Next is held; the escape
              // ("Skip for now") takes the buyer straight to the last page. Late answers still merge.
              ? <span className="flex items-center gap-3 shrink-0">
                  <button type="button" onClick={() => setStage('more')} className="text-sm text-gray-500 underline underline-offset-2 hover:text-gray-600">Skip for now</button>
                  <span className="flex items-center gap-1.5 bg-gray-100 text-gray-400 text-sm font-semibold px-5 py-2.5 rounded-lg"><span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />Preparing…</span>
                </span>
              : <button onClick={() => setStage('more')} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-teal-700 shrink-0">Next <ArrowRight size={15} /></button>)
            : <button onClick={submit} className="flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 shrink-0">Get Quotes <ArrowRight size={15} /></button>}
        </div>
      )}
      {isMobile && <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={handleExit} className="text-sm text-gray-500 underline underline-offset-2">Exit</button></div>}
    </div>
  );

  // ── Product step: mobile = Lens front page · desktop = V3 two-panel ──
  const productMobile = (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-gray-100 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back" className="w-11 h-11 -ml-1.5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1 min-w-0"><p className="font-bold text-teal-600 text-[15px] leading-tight">Post a Requirement</p><p className="text-[11px] text-gray-500">Tell us what you need</p></div>
      </div>
      {aiBusy && <div className="shrink-0 px-4 py-1.5 flex items-center gap-2 text-[12px] text-teal-700 bg-teal-50"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5">
        <p className="text-sm font-semibold text-gray-700 mb-2">Enter Product/Service name <span className="text-red-500">*</span></p>
        {productInputRow}
        <div className="mt-3">{trustStrip}</div>
        {qtyUnitBlock}
      </div>
      <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={onClose} className="text-sm text-gray-500 underline underline-offset-2">Exit</button></div>
    </div>
  );

  // ── Desktop / standalone FRONT PAGE — two-panel, ~90% of the IndiaMART "Post a Requirement" popup:
  //    left teal panel = product image gallery (hero + selectable thumbnails from IMSearchAPI) + pitch;
  //    right panel = product input + (pre-commit) Requirement Details / (post-commit) Quantity + Next. ──
  const productDesktop = (
    <div className="flex" style={{ minHeight: 580 }}>
      {/* Gallery panel: POPUP ONLY. The standalone page already has the score rail on the left — an extra image
          gallery over-clutters it (owner), so the standalone landing stays a clean single input column. */}
      {!standalone && (
      <div className="hidden sm:flex w-[44%] bg-teal-50/70 p-7 flex-col items-center justify-center gap-5">
        {productImageUrl ? (
          <div className="w-full flex flex-col items-center gap-3">
            <div className="relative w-full rounded-2xl overflow-hidden bg-white shadow-sm ring-1 ring-teal-100" style={{ aspectRatio: '4/3' }}>
              <span className="absolute top-2 left-2 z-10 text-[10px] text-gray-500 bg-white/85 px-2 py-0.5 rounded">Representative image</span>
              {/* Hero uses the 500×500 imimg variant (thumbnails stay small) — kills the stretch-blur. */}
              <img src={upsizeImimg(productImageUrl)} alt={productName} className="w-full h-full object-contain p-4" />
            </div>
            {productImages.length > 1 && (
              <div className="flex gap-2 w-full">
                {productImages.slice(0, 4).map((img) => (
                  <button key={img} type="button" onClick={() => setProductImageUrl(img)} className={`flex-1 rounded-lg overflow-hidden bg-white transition ${productImageUrl === img ? 'ring-2 ring-teal-500' : 'ring-1 ring-gray-200 hover:ring-teal-300'}`} style={{ aspectRatio: '1/1' }}>
                    <img src={img} alt="" className="w-full h-full object-contain p-1.5" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="w-full rounded-2xl bg-white/70 border border-teal-100 flex items-center justify-center" style={{ aspectRatio: '4/3' }}>
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
        )}
        <div className="text-center px-2">
          <p className="font-bold text-teal-700 text-lg leading-snug">{productName ? `Looking to buy ${productName}?` : 'Looking to buy something?'}</p>
          <p className="text-[13px] text-gray-500 mt-1.5">Just complete a few simple steps to get Instant quotes from Verified Suppliers</p>
        </div>
      </div>
      )}
      <div className={`flex-1 flex flex-col p-7 min-w-0 relative ${standalone ? 'max-w-2xl mx-auto w-full' : ''}`}>
        {!standalone && <button onClick={onClose} className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200"><X size={16} /></button>}
        {/* Standalone leads with "What are you looking for?"; the popup has no heading (owner) — straight to input. */}
        {standalone && <div><p className="font-bold text-gray-900 text-2xl leading-tight">What are you looking for?</p><p className="text-sm text-gray-500 mt-1">Enter the product or service name to get started.</p></div>}
        <label className={`block text-sm font-semibold text-gray-700 mb-2 ${standalone ? 'mt-6' : 'mt-1'}`}>Enter Product/Service name <span className="text-red-500">*</span></label>
        {productInputRow}
        <div className="mt-3">{trustStrip}</div>
        {aiBusy && <p role="status" aria-live="polite" className="mt-3 text-[12px] text-teal-700 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</p>}
        {committed ? qtyUnitBlock : (
          <div className="mt-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Requirement Details</label>
            <textarea aria-label="Requirement details" value={requirementNotes} onChange={(e) => setRequirementNotes(e.target.value)} rows={4} placeholder="Describe what you need — grade, size, packaging, brand preference…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
          </div>
        )}
        <button onClick={() => setStage('specs')} disabled={!canContinueProduct} className={`mt-auto w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all ${canContinueProduct ? 'bg-teal-600 text-white hover:bg-teal-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>Next <ArrowRight size={16} /></button>
      </div>
    </div>
  );

  const productStep = isMobile ? productMobile : productDesktop;
  // The front page is a wide two-panel popup (~the IndiaMART target); the rest of the flow stays the
  // narrower single-column width so the steps read comfortably.
  const shellWidth = stage === 'product' ? 'max-w-5xl' : 'max-w-2xl lg:max-w-3xl';

  // Full-page LEFT rail (standalone flow pages only): a persistent RFQ score + breakdown + "fill next", so
  // the standalone form reads as a real page (score on the left) instead of a popup. Reuses scoreDetails.
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
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{g}</p>
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
      {nextCheck && <button type="button" onClick={() => jumpToCheck(nextCheck)} className="w-full text-left text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 hover:bg-amber-100 transition-colors"><span className="flex items-center justify-between"><span className="font-semibold uppercase tracking-wide text-[10px] text-amber-600">Fill next</span><ArrowRight size={12} /></span>{nextCheck.label} <span className="font-semibold">+{nextCheck.pts - nextCheck.earned}</span></button>}
      <button type="button" onClick={handleExit} className="self-start text-sm text-gray-500 underline underline-offset-2 hover:text-gray-600">← Exit</button>
    </aside>
  );

  return (
    <>
      {isMobile ? (
        <div role="dialog" aria-modal="true" aria-label="Post a Requirement" className={`${themeClass} absolute inset-0 z-50 bg-white flex flex-col animate-modal-in`} style={{ height: '100%' }}>
          {stage === 'product' ? productStep : singlePanel}
        </div>
      ) : standalone ? (
        // Standalone full-page route (?rfq=…): a REAL IndiaMART-style page. App shell = IndiaMART header on top,
        // the persistent LEFT score rail, and the form filling the rest full-bleed (no card, no popup X, no gutters).
        <div className={`${themeClass} fixed inset-0 z-50 bg-gray-50 flex flex-col`}>
          <IndiaMartHeader firstName={isLoggedIn && contactName ? contactName.split(' ')[0] : ''} onExit={handleExit} />
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* Score rail is a "Post a Requirement" aid — HIDE it on the results/curated-sellers page (owner:
                once the buyer is picking sellers, the score/checklist is a distraction). Sellers get full width. */}
            {stage !== 'results' && scoreRail}
            {/* Only the product page needs this outer column to scroll; on flow pages singlePanel is h-full and
                its OWN body scrolls (with the scroll-reset ref). Keeping the outer scrollable on flow pages left
                residual scrollTop from the product page, pushing the next stage up out of view (owner's scroll bug). */}
            <div className={`flex-1 min-w-0 bg-white flex flex-col ${stage === 'product' ? 'overflow-y-auto overscroll-contain' : 'overflow-hidden'}`}>
              {stage === 'product' ? productStep : singlePanel}
            </div>
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
          <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
            <div ref={popupRef} role="dialog" aria-modal="true" aria-label="Post a Requirement" className={`${themeClass} relative bg-white rounded-xl w-full ${shellWidth} overflow-hidden animate-modal-in shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)]`}>
              {stage === 'product' ? productStep : singlePanel}
            </div>
          </div>
        </div>
      )}

      {/* Use-case assist popup ("Help me fill the specs") — ported from Quick Quote. Text/speak/photo → the buyer's
          use-case → its own LLM (inferSpecsFromApplication). Fills OUTRANK photo/mic on conflict (never a buyer edit). */}
      {assistOpen && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4" onClick={() => !assistLoading && setAssistOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Help me fill the specs" className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in p-5" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold text-gray-800 flex items-center gap-1.5"><span className="text-teal-500">✦</span> Help me fill the specs</p>
              <button type="button" onClick={() => setAssistOpen(false)} disabled={assistLoading} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 disabled:opacity-50" aria-label="Close"><X size={16} /></button>
            </div>
            {assistLoading ? (
              <div className="py-8 flex flex-col items-center gap-3 text-center" role="status" aria-live="polite">
                <span className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-semibold text-gray-700">Analysing your requirement…</p>
                <p className="text-xs text-gray-500">Matching it to the right specs</p>
              </div>
            ) : (<>
              <p className="text-xs text-gray-500 mb-3">Tell us where / how you'll use {productName || 'it'} — type or speak, even add a photo.</p>
              <textarea value={assistInput} onChange={(e) => setAssistInput(e.target.value)} rows={3} autoFocus placeholder="e.g., silent genset for a 3-floor hospital backup, runs 8 hrs/day" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
              <div className="flex items-center gap-2 mt-3">
                <button type="button" onClick={() => { voiceTargetRef.current = 'assist'; setShowVoice(true); }} className="flex items-center justify-center px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0" aria-label="Speak your use-case" title="Speak"><Mic size={18} /></button>
                <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 shrink-0"><Camera size={15} /> Photo</button>
                <button type="button" onClick={handleAssistSubmit} disabled={!assistInput.trim()} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${!assistInput.trim() ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>Fill my specs <ArrowRight size={15} /></button>
              </div>
            </>)}
          </div>
        </div>
      )}
      {/* MOBILE FIX (2026-07-23): `hidden` (display:none) makes programmatic .click() a no-op on iOS Safari — use
          sr-only (off-screen, still clickable). Dropped `capture="environment"`: it forced the camera and blocked
          gallery/catalog uploads (buyers upload existing product/spec images); the native chooser now offers both.
          iOS converts a Photos pick to JPEG for accept="image/*", so the canvas resize in onPhoto still decodes. */}
      <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.currentTarget.value = ''; }} />
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
      {/* Screen-reader live region (P1-128): announces the current step + RFQ-strength score as they change,
          so non-visual users hear progress the score ring / stepper convey visually. Visually hidden. */}
      <div aria-live="polite" className="sr-only">{`Step: ${stage}. RFQ strength ${scoreDetails.total} out of 100, ${getScoreLabel(scoreDetails.total)}.`}</div>
    </>
  );
}
