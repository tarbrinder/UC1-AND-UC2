import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  ArrowLeft, ArrowRight, Search, Mic, Camera, X, Pencil, MapPin, Star, User, Send, Phone,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, BadgeCheck, ShieldCheck, Award, Package, MessageCircle, Clock, CreditCard,
  LogIn, CheckCircle2, SlidersHorizontal, ListPlus, Truck, LocateFixed, Store, HelpCircle, Globe, type LucideIcon,
} from 'lucide-react';
import { getJSON, postJSON } from '../lib/api';
import { fetchProductSuggestions, filterProducts, stripQuantityPrefix, parseQuantityFromName } from '../utils/productNames';
import type { ISQSpec, RFQFormData } from '../types';
import { calcScore, getScoreColor, getScoreLabel, type ScoreCheck } from '../utils/score';
import OptionChips from './OptionChips';
import OTPGate from './OTPGate';
import VoiceRecorder from './VoiceRecorder';
import { analyzeImage, voiceToSpecs, hasGeminiKey, getSpecHints, getMissingSpecs, type AiSpecQuestion } from '../lib/gemini';
import { fetchCategoryCorpus, fetchProductImages, upsizeImimg } from '../lib/enrichment';
import { matchUnit } from '../lib/quantity';

// "Post a Requirement → Get Quotes" — the simple RFQ flow. UI is a faithful clone of RFQModalV3
// (two-panel product step · single-panel spec/delivery with the header score-circle + orange progress
// bar + RadioChips + Back/Next footer) with the intelligence stripped: NO twin / enrichment pull /
// planner / use-case questions / category-intel / n8n. The ONLY AI is the opt-in mic + camera, which
// reuse V3's Gemini analyzeImage/voiceToSpecs. Mobile = V3 chrome, EXCEPT the front/product page which
// takes the IndiaMART-Lens treatment. Desktop = V3 popup, all pages.

type Surface = 'mobile' | 'desktop';
// 'more' = the LAST page = "Your Profile & Delivery" (About You + Logistics&Payment + Contact, combined).
type Stage = 'product' | 'specs' | 'aispecs' | 'more' | 'results';
type CategoryMode = 'simple' | 'category';

interface Props {
  onClose: () => void;
  surface?: Surface;
  categoryMode?: CategoryMode; // 'simple' (default) = NO category corpus (buyer+seller+user only); 'category' = corpus-driven (needs v51 n8n)
  loggedIn?: boolean;          // logged-in buyer: contact collapsed + prefilled, no Login button, no OTP text
  standalone?: boolean;        // full-page route (fills viewport, no popup backdrop) vs dashboard popup
}

// Top clickable stepper nodes (owner). Product is the landing (stepper hidden there); the 3 numbered
// steps are Specifications · More Details · Delivery & Payment. specs+aispecs both map to Specifications.
// Owner: "More Details" points at the AI-spec page; the LAST page is "Your Profile & Delivery" (About You +
// payment + delivery). 4 nodes, now 1:1 with stages (product·specs·aispecs·more).
const STEPPER: Array<{ label: string; stage: Stage; Icon: LucideIcon }> = [
  { label: 'Product', stage: 'product', Icon: Package },
  { label: 'Specifications', stage: 'specs', Icon: SlidersHorizontal },
  { label: 'More Details', stage: 'aispecs', Icon: ListPlus },
  { label: 'Your Profile & Delivery', stage: 'more', Icon: Truck },
];
const stageNodeIdx = (s: Stage): number => (s === 'product' ? 0 : s === 'specs' ? 1 : s === 'aispecs' ? 2 : 3);

// ─── RadioChip (cloned verbatim from RFQModalV3) ───
function RadioChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 border rounded-full text-sm transition-all ${
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

// SimpleRFQForm-ONLY LLM key (owner: for this form and nothing else). Passed as a per-call override to
// analyzeImage / voiceToSpecs / getSpecHints / getMissingSpecs — V3/V4 + the buyer pipeline keep the
// default VITE_LLM_KEY. `undefined` when absent → callLLM falls back to the default. Models (owner):
// image + mic → gemini-2.5-flash, auto-spec hints → flash-lite, page-2 AI specs → flash.
const RFQ_LLM_KEY = ((import.meta.env.VITE_RFQ_LLM_KEY as string) || '').trim() || undefined;
// The RFQ key is provisioned for flash-lite ONLY (flash → 401 team_model_access_denied), so every form
// call runs on flash-lite. Flip to 'google/gemini-2.5-flash' here (image/mic + page-2) once the key
// gains flash access — the owner asked for flash on those, but the key blocks it today.
const RFQ_MODEL = 'google/gemini-2.5-flash-lite'; // all form calls (image/mic/hints/page-2) run on flash-lite
const hasFormLLM = () => !!RFQ_LLM_KEY || hasGeminiKey();

const DEMO_SELLERS = [
  { name: 'Sunrise Traders', city: 'Mumbai', gst: true, trustSeal: true, paymentProtected: true, tenureYears: 5, rating: 4.7, reviews: 312 },
  { name: 'Ecomx', city: 'New Delhi', gst: true, trustSeal: true, paymentProtected: true, tenureYears: 2, rating: 4.4, reviews: 65 },
  { name: 'Prime Industries', city: 'Thane', gst: true, trustSeal: false, paymentProtected: true, tenureYears: 4, rating: 4.3, reviews: 95 },
];

function mapDisplaySpecs(rows: Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>): ISQSpec[] {
  return (rows || [])
    .filter((r) => r && r.IM_SPEC_MASTER_DESC && !/quantity|qty|unit/i.test(r.IM_SPEC_MASTER_DESC))
    .slice(0, 10)
    .map((r) => {
      const opts = (Array.isArray(r.OPTIONS_DATA) && r.OPTIONS_DATA.length
        ? r.OPTIONS_DATA.map((o) => (o.IM_SPEC_OPTIONS_DESC || '').trim()).filter(Boolean)
        : (r.IM_SPEC_OPTIONS_DESC || '').split(/##|,/).map((o) => o.trim()).filter(Boolean)
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

export default function SimpleRFQForm({ onClose, surface, categoryMode = 'simple', loggedIn = false, standalone = false }: Props) {
  // Freeze the surface ONCE at mount — otherwise a mid-flow viewport crossing 640px (rotate/resize)
  // would silently swap the whole mobile↔desktop chrome on the next state change.
  const [surf] = useState<Surface>(() => surface ?? (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 'desktop' : 'mobile'));
  const isMobile = surf === 'mobile';

  const [stage, setStage] = useState<Stage>('product');

  const [productName, setProductName] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [productImageUrl, setProductImageUrl] = useState('');
  const [productImages, setProductImages] = useState<string[]>([]); // front-page gallery (IMSearchAPI: hero + up to 3 thumbnails)
  const [imageBase64, setImageBase64] = useState('');

  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [isqSpecs, setIsqSpecs] = useState<ISQSpec[]>([]);
  const [specValues, setSpecValues] = useState<Record<string, string>>({});
  const [specsLoading, setSpecsLoading] = useState(false);
  const [mcatId, setMcatId] = useState('');
  // Page-1 buyer-spec hints (fast getSpecHints): product-name pre-fills + not-applicable + field hints.
  const [isqHints, setIsqHints] = useState<Record<string, string>>({});
  const [redundantISQSpecs, setRedundantISQSpecs] = useState<string[]>([]);
  // Page-2 AI specs (getMissingSpecs over the live category node): the best 5 options-only questions.
  const [aiSpecs, setAiSpecs] = useState<AiSpecQuestion[]>([]);
  const [aiSpecsLoading, setAiSpecsLoading] = useState(false);
  const [aiSpecsError, setAiSpecsError] = useState(false); // getMissingSpecs threw/timed-out — distinct from a genuine "0 questions"
  const [aiSpecValues, setAiSpecValues] = useState<Record<string, string>>({});
  const [aiEpoch, setAiEpoch] = useState(0); // bumped when a photo/voice adds specs → re-runs the AI-specs prompt with them
  const [unitsResolved, setUnitsResolved] = useState(false); // true once GetIsq has returned — gates Continue past the loading race
  const [resolveError, setResolveError] = useState(false); // mcat-resolve network failure (distinct from "not a category")
  // Category CORPUS status (debug chip). The form fetches the raw per-call corpus fresh on mcat-known and
  // feeds it WHOLE to the single page-2 planner call — no n8n distill LLM, no cache.
  const [catStatus, setCatStatus] = useState<{ state: 'idle' | 'fetching' | 'ready' | 'none' | 'error'; count: number }>({ state: 'idle', count: 0 });
  const catFetchTok = useRef(0);
  const categoryCorpusRef = useRef<unknown>(null); // raw category corpus (or legacy intelligence obj); passed as-is to the planner
  useEffect(() => () => { catFetchTok.current++; }, []); // cancel any in-flight corpus fetch on unmount

  const [deliveryLocation, setDeliveryLocation] = useState('');
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

  const [aiBusy, setAiBusy] = useState('');
  const [showVoice, setShowVoice] = useState(false);
  const [scoreDelta, setScoreDelta] = useState(0);   // floating "+N" flash when the score rises
  const [toast, setToast] = useState('');            // transient bottom toast (exit-intent nudge)
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
  const applyLoggedInDefaults = () => {
    setContactName((n) => n || 'Tarbrinder Singh');
    setContactMobile((m) => m || '8283830681');
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
  const qtyRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cardScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAiSpecs = useRef<Record<string, string> | null>(null);
  const hintsFiredFor = useRef('');         // mcatId getSpecHints already fired for (once per product)
  const aiFiredFor = useRef('');            // "mcatId:aiEpoch" getMissingSpecs already fired for (re-fires when a photo/voice adds specs)
  const categoryNameRef = useRef('');       // latest category name (McatDtl) for the async AI-spec call
  const photoSpecsRef = useRef<Record<string, string>>({}); // specs a photo/voice extracted → extra INPUT to the AI-specs prompt
  const commitGen = useRef(0);              // generation token — a superseded commit's late API responses become no-ops
  const autoAdvancedFor = useRef('');       // mcatId we already auto-advanced past (unit-less) — so Back doesn't re-bounce
  const productNameRef = useRef('');        // live product name for the photo/voice "don't overwrite a typed name" guard
  const sellerSpecsRef = useRef<string[]>([]); // getISQs SELLER-flagged spec names → page-2 AI input (never rendered on page-1)

  useEffect(() => {
    let alive = true;
    // IP city seeds the buyer's OWN location; delivery mirrors it (sameAsLoc defaults on) until the buyer diverges.
    getJSON<{ city?: string }>('https://ipapi.co/json/').then((d) => { if (alive && d?.city) { setDetectedCity(d.city); setUserLocation((v) => v || d.city!); setDeliveryLocation((v) => v || d.city!); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
        } catch { if (detectedCity) applyUserCity(detectedCity); }
        finally { setGeoLoading(false); }
      },
      fallback,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };
  // "Same as my location": turning it ON copies the buyer's city into delivery; OFF frees delivery to edit.
  const toggleSameAs = () => setSameAsLoc((prev) => { const next = !prev; if (next && userLocation) setDeliveryLocation(userLocation); return next; });

  useEffect(() => { if (committed) setTimeout(() => qtyRef.current?.focus(), 60); }, [committed]);

  useEffect(() => {
    if (!pendingAiSpecs.current || isqSpecs.length === 0) return;
    const ai = pendingAiSpecs.current; pendingAiSpecs.current = null;
    setSpecValues((prev) => {
      const next = { ...prev };
      for (const s of isqSpecs) { const hit = Object.keys(ai).find((k) => k.toLowerCase() === s.IM_SPEC_MASTER_DESC.toLowerCase()); if (hit && ai[hit] && !next[s.IM_SPEC_MASTER_DESC]) next[s.IM_SPEC_MASTER_DESC] = ai[hit]; }
      return next;
    });
  }, [isqSpecs]);

  // On product commit → TWO parallel LLM calls, once per mcat:
  //  (1) getSpecHints (fast) — pre-fill page-1 buyer specs the product name implies, flag not-applicable
  //      ones (redundant), attach a per-field hint.
  //  (2) getMissingSpecs (page 2 "AI specs") — over the LIVE n8n category node → the best 5 options-only
  //      questions a seller needs, deduped vs page-1. Fired NOW so page 2 is ready on arrival.
  useEffect(() => {
    if (!committed || !mcatId || !hasFormLLM()) return;
    const name = productName;
    const gen = commitGen.current; // guards the two LLM fires against a superseded commit (same-mcat name variants clobber otherwise — audit)
    const specNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
    // (1) page-1 hints — re-runs per product IDENTITY (mcat + name) AND when new mic/photo evidence lands
    // (aiEpoch), so a photo added to an already-committed product also refreshes page-1 (not just page-2).
    // Needs a schema to hint on; AI specs below does NOT (product+category alone is a valid input),
    // so a zero-ISQ category still gets its AI-specs page instead of a stuck loader.
    const hintsKey = `${mcatId}:${name}:${aiEpoch}`;
    if (isqSpecs.length > 0 && hintsFiredFor.current !== hintsKey) {
      hintsFiredFor.current = hintsKey;
      const withOpts: Record<string, string[]> = {};
      for (const s of isqSpecs) withOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      getSpecHints(name, specNames, withOpts, '', photoSpecsRef.current, RFQ_LLM_KEY).then((h) => {
        if (hintsFiredFor.current !== hintsKey || gen !== commitGen.current) return;
        setIsqHints(h.isqHints || {});
        setRedundantISQSpecs(h.redundantISQSpecs || []);
        if (h.knownFromProductName && Object.keys(h.knownFromProductName).length) {
          setSpecValues((prev) => { const next = { ...prev }; for (const [k, v] of Object.entries(h.knownFromProductName)) { const hit = specNames.find((n) => n.toLowerCase() === k.toLowerCase()); if (hit && v && !next[hit]) next[hit] = v; } return next; });
        }
      }).catch(() => {});
    }
    // (2) page-2 AI specs — SNAPSHOT fires on Landing NEXT (stage leaves 'product'), NOT at commit:
    // avoids a wasted call when the buyer changes product / adds a photo while still on the landing
    // page, and still hides its latency inside the Buyer-Specs dwell time. Re-fires only on a material
    // change: new mcat, or new mic/photo evidence (aiEpoch bump).
    if (stage === 'product') return;
    const aiKey = `${mcatId}:${aiEpoch}`;
    if (aiFiredFor.current !== aiKey) {
      aiFiredFor.current = aiKey;
      setAiSpecsLoading(true);
      const buyerAnswered = { ...specValues };
      const evidenceSnapshot = { ...photoSpecsRef.current };
      (async () => {
        // Page-1 spec → its options, so the planner sees what each buyer spec already captures and won't
        // re-ask it under a synonym (e.g. "Enclosure Type" vs "Genset Type").
        const buyerSpecOptions: Record<string, string[]> = {};
        for (const s of isqSpecs) buyerSpecOptions[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
        try {
          // ONE planning call: buyer intent (product/photo/mic) + page-1 specs + seller-flagged names +
          // the RAW category corpus passed WHOLE (categoryCorpusRef; null → planner uses its intent+spec fallback).
          const qs = await getMissingSpecs({ productName: name, categoryName: categoryNameRef.current, buyerSpecs: specNames, buyerSpecOptions, filledSpecs: buyerAnswered, evidenceFacts: evidenceSnapshot, sellerSpecs: sellerSpecsRef.current, categoryCorpus: categoryCorpusRef.current, apiKey: RFQ_LLM_KEY, model: RFQ_MODEL });
          if (aiFiredFor.current === aiKey && gen === commitGen.current) {
            setAiSpecs(qs); setAiSpecsError(false);
            // Evidence-backed questions arrive PRE-ANSWERED (lossless): seed the prefill as the selected
            // value — the buyer can still change it, and a buyer-set value is never overwritten.
            setAiSpecValues((prev) => { const next = { ...prev }; for (const q of qs) if (q.prefill && !next[q.fieldName]) next[q.fieldName] = q.prefill; return next; });
          }
        } catch { if (aiFiredFor.current === aiKey && gen === commitGen.current) { setAiSpecs([]); setAiSpecsError(true); } } // a thrown/timed-out call is NOT "0 questions" — flag it so the page shows the right copy
        finally { if (aiFiredFor.current === aiKey && gen === commitGen.current) setAiSpecsLoading(false); }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, mcatId, isqSpecs, productName, aiEpoch, stage]);

  // Fetch the RAW category corpus as soon as the mcat is known (FRESH every time — no cache). It feeds the
  // page-2 planner (categoryCorpusRef). If it lands AFTER the planner already ran (fallback), bump aiEpoch
  // to re-plan WITH it. Fresh Redash-backed fetch can take a few seconds → fired at commit to hide latency.
  useEffect(() => {
    // SIMPLE mode: never fetch the category corpus — the planner runs on buyer + seller + user input only.
    if (categoryMode !== 'category') { categoryCorpusRef.current = null; setCatStatus({ state: 'idle', count: 0 }); return; }
    if (!mcatId) { categoryCorpusRef.current = null; setCatStatus({ state: 'idle', count: 0 }); return; }
    const tok = ++catFetchTok.current;
    categoryCorpusRef.current = null;
    setCatStatus({ state: 'fetching', count: 0 });
    fetchCategoryCorpus(mcatId).then((r) => {
      if (catFetchTok.current !== tok) return;                 // stale (mcat changed / unmount)
      if (r.status === 'hit' && r.corpus) {
        categoryCorpusRef.current = r.corpus;
        setCatStatus({ state: 'ready', count: r.count });
        if (aiFiredFor.current) { aiFiredFor.current = ''; setAiEpoch((e) => e + 1); } // planner already ran without it → re-plan with the corpus
      } else {
        setCatStatus({ state: r.status === 'error' ? 'error' : 'none', count: 0 });
      }
    }).catch(() => { if (catFetchTok.current === tok) setCatStatus({ state: 'error', count: 0 }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcatId]);

  const onProductInput = (val: string) => {
    setProductName(val); productNameRef.current = val; setNotFound(false); setCommitted(false);
    if (suggestDebounce.current) clearTimeout(suggestDebounce.current);
    if (val.trim().length < 2) { setSuggestions([]); setShowDropdown(false); return; }
    setSuggestions(filterProducts(val)); setShowDropdown(true);
    suggestDebounce.current = setTimeout(async () => { const live = await fetchProductSuggestions(val); if (live.length) setSuggestions(live); }, 200);
  };

  // Derive qty/unit options from raw ISQ rows (mapDisplaySpecs strips these, so read them first).
  const deriveUnits = (rows: unknown): string[] => {
    const flat = (Array.isArray(rows) ? rows : []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s): s is ISQSpec => !!(s && (s as ISQSpec).IM_SPEC_MASTER_DESC));
    const u: string[] = [];
    for (const qs of flat.filter((s) => /quantity|qty|unit/i.test(s.IM_SPEC_MASTER_DESC))) if (qs.IM_SPEC_OPTIONS_DESC) qs.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter((o) => o && o.toLowerCase() !== 'none').forEach((o) => { if (!u.includes(o)) u.push(o); });
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
    } catch { if (myGen === commitGen.current) { setResolving(false); setResolveError(true); } return; } // network failure ≠ "not a category"
    if (myGen !== commitGen.current) return;
    if (!id) { setResolving(false); setNotFound(true); return; }
    setSpecsLoading(true); setUnitsResolved(false); setIsqSpecs([]); setSpecValues({}); setUnitOptions([]); setUnit(''); setProductImageUrl(''); setProductImages([]); setResolving(false); setCommitted(true);
    setMcatId(id); categoryNameRef.current = ''; sellerSpecsRef.current = []; pushRecent(name);
    // Re-arm the LLM fire-guards so a re-commit (same or new mcat) re-fires getSpecHints/getMissingSpecs
    // and clears aiSpecsLoading — without this a same-product re-commit hangs the aispecs page forever.
    hintsFiredFor.current = ''; aiFiredFor.current = '';
    // LOSSLESS across a product change: mic/photo evidence (photoSpecsRef) is JOURNEY-level, never wiped —
    // the typed name anchors the NEW category while voice/photo facts survive as autofill candidates
    // against the new schema + evidence input to the AI-specs prompt. Buyer page answers DO reset (by design).
    if (Object.keys(photoSpecsRef.current).length) pendingAiSpecs.current = { ...photoSpecsRef.current };
    setIsqHints({}); setRedundantISQSpecs([]); setAiSpecs([]); setAiSpecValues({}); setAiSpecsError(false); setAiSpecsLoading(hasFormLLM());
    try {
      const isqJson = await getJSON<{ DATA?: (ISQSpec | ISQSpec[])[] }>(`/api/imimg/index.php?r=Newreqform/GetIsq&modid=MY&mcatid=${id}&cat_type=3&flag=1&isq_format=1&generic_flag=1&country_iso=IN`);
      if (myGen !== commitGen.current) return;
      const flat = (isqJson?.DATA ?? []).flatMap((s) => (Array.isArray(s) ? s : [s])).filter((s) => s && s.IM_SPEC_MASTER_DESC);
      const unitOpts = deriveUnits(isqJson?.DATA);
      // Use ONLY the qty/unit the API provides. Some mcats carry none (e.g. Diesel Generator) — then
      // quantity + unit are simply hidden (and not required), matching V3.
      setUnitOptions(unitOpts);
      setUnit(unitOpts.length ? matchUnit(unitOpts, parsedQty?.unit) : '');
      setUnitsResolved(true); // units are known now → Continue can un-gate even for a spec-less category
      const fast = mapDisplaySpecs(flat as Array<ISQSpec & { OPTIONS_DATA?: Array<{ IM_SPEC_OPTIONS_DESC?: string }> }>);
      if (fast.length) { setIsqSpecs(fast); setSpecsLoading(false); }
    } catch { /* fall through — getISQs .finally still settles specsLoading */ }
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
      }).catch(() => {}).finally(() => { if (myGen === commitGen.current) { setSpecsLoading(false); setUnitsResolved(true); } });
    getJSON<Record<string, unknown> & { Response?: { Data?: unknown }; data?: unknown }>(`/api/imimg/index.php?r=postblenq/McatDtl&modid=MY&mcatid=${id}`)
      .then((img) => {
        if (myGen !== commitGen.current) return;
        const d0 = (img?.Response?.Data ?? img?.data ?? img);
        const data = (Array.isArray(d0) ? d0[0] : d0) as Record<string, unknown>;
        if (data && typeof data === 'object') { const nm = data['glcat_mcat_name']; if (typeof nm === 'string' && nm.trim()) categoryNameRef.current = nm.trim(); for (const k of Object.keys(data)) { const v = data[k]; if (/img|image/i.test(k) && typeof v === 'string' && v.startsWith('http')) { setProductImageUrl(v.replace(/^http:\/\//i, 'https://')); break; } } } // https → no mixed-content on a prod https page
      }).catch(() => {});
    // Front-page GALLERY (IMSearchAPI: real seller-listing photos for this query → hero + up to 3 thumbnails).
    // Images only. First image also backfills the single hero if McatDtl had none. Best-effort; silent on empty.
    fetchProductImages(name, id)
      .then((imgs) => { if (myGen !== commitGen.current || !imgs.length) return; setProductImages(imgs); setProductImageUrl((prev) => prev || imgs[0]); })
      .catch(() => {});
  }, []);

  // Feed photo/voice-extracted specs into BOTH pipelines: page-1 fill (pendingAiSpecs → ISQ fields) AND
  // the page-2 AI-specs prompt (photoSpecsRef → getMissingSpecs input). Bumping aiEpoch re-runs page 2
  // with the new context. The product name, once the buyer has typed it, is NEVER overwritten (it's the
  // primary signal) — a photo only ADDS specs; it names the product only when the buyer left it blank.
  const applyExtractedSpecs = (specs: Record<string, string>) => {
    if (!Object.keys(specs).length) return;
    pendingAiSpecs.current = specs; // still seeds the [isqSpecs]-keyed effect for a specs set that arrives LATER
    photoSpecsRef.current = { ...photoSpecsRef.current, ...specs };
    // Flush NOW onto any already-loaded ISQ field (empty-only) — the [isqSpecs] effect won't re-run when
    // the schema is unchanged, so a late photo/voice value must be written directly or it's lost.
    setSpecValues((prev) => {
      const next = { ...prev };
      for (const s of isqSpecs) { const hit = Object.keys(specs).find((k) => k.toLowerCase() === s.IM_SPEC_MASTER_DESC.toLowerCase()); if (hit && specs[hit] && !next[s.IM_SPEC_MASTER_DESC]) next[s.IM_SPEC_MASTER_DESC] = specs[hit]; }
      return next;
    });
    setAiEpoch((e) => e + 1);
  };
  const onPhoto = async (file: File) => {
    const { base64, mime } = await fileToBase64(file); setImageBase64(base64);
    if (!hasFormLLM()) return;
    try {
      setAiBusy('Reading your photo…');
      // Schema-aware extraction (the plan's combined Call A): when the category schema is already
      // loaded, the image call maps values straight onto the real ISQ fields — no separate mapper call.
      const fieldNames = isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC);
      const fieldOpts: Record<string, string[]> = {};
      for (const s of isqSpecs) fieldOpts[s.IM_SPEC_MASTER_DESC] = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
      const r = await analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', RFQ_LLM_KEY, RFQ_MODEL);
      if (r.productName && !productNameRef.current.trim()) await commitProduct(r.productName);
      if (r.quantity) setQuantity(String(r.quantity));
      applyExtractedSpecs({ ...(r.specifications || {}), ...(r.additionalSpecifications || {}) });
    } catch { /* photo still attached */ } finally { setAiBusy(''); }
  };
  const onVoice = async (blob: Blob) => {
    setShowVoice(false); if (!hasFormLLM()) return;
    try { const { base64, mime } = await fileToBase64(blob); setAiBusy('Understanding your requirement…'); const r = await voiceToSpecs(base64, mime, productName, isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC), RFQ_LLM_KEY, RFQ_MODEL); if (r.productName && !productNameRef.current.trim()) await commitProduct(r.productName); if (r.quantity) setQuantity(String(r.quantity)); if (r.quantityUnit && unitOptions.length) setUnit(matchUnit(unitOptions, r.quantityUnit)); if (r.deliveryTimeline) setDeliveryTimeline(r.deliveryTimeline); if (r.paymentTerms) setPaymentTerms(r.paymentTerms); const specs = { ...(r.mappedSpecs || {}) }; (r.customSpecs || []).forEach((c) => { if (c.fieldName) specs[c.fieldName] = c.value; }); applyExtractedSpecs(specs); } catch { /* ignore */ } finally { setAiBusy(''); }
  };

  const setSpecValue = (k: string, v: string) => setSpecValues((p) => ({ ...p, [k]: v }));

  // V3 rule (RFQModalV3.tsx:1162): anything that isn't an individual/personal/end-user is a BUSINESS role —
  // and a business buyer is asked for GST (an individual/consumer is not). "Individual Buyer" → false.
  const isBusinessRole = !!buyerType && !/individual|personal|end[\s-]?user|consumer|home/i.test(buyerType);

  const scoreDetails = useMemo(() => {
    // AI "Smart Questions" (page-2) → scored (owner). aiSpecTotal>0 only once questions surfaced, so a
    // loading / errored / empty page-2 is normalized OUT (never a scored-zero). Prefilled = answered.
    const aiTotal = aiSpecs.length;
    const aiAnswered = aiSpecs.filter((q) => (aiSpecValues[q.fieldName] || '').trim()).length;
    return calcScore(
      { productName, quantity, dynamicSpecs: specValues, deliveryLocation, deliveryTimeline, paymentTerms, buyerType, industry, gstRegistered, gstNumber } as Partial<RFQFormData>,
      // quantity stays scored ONLY when the API returned units (unitOptions>0) — unit itself is never scored;
      // frequencyApplicable:false — cadence is now an LLM-driven AI-spec, not a static field.
      isqSpecs, !!imageBase64, { quantityApplicable: unitOptions.length > 0, profileApplicable: true, frequencyApplicable: false, gstApplicable: isBusinessRole, aiSpecTotal: aiTotal, aiSpecAnswered: aiAnswered },
    );
  }, [productName, quantity, specValues, deliveryLocation, deliveryTimeline, paymentTerms, buyerType, industry, gstRegistered, gstNumber, isBusinessRole, isqSpecs, imageBase64, unitOptions.length, aiSpecs, aiSpecValues]);

  // The next unfilled, applicable score item — powers the "Fill next" nudge in the score popover + rail.
  const nextCheck = scoreDetails.checks.find((c) => c.applicable && !c.done);

  // R3 steal — score "+N" delta flash: when the total rises, float the gained points near the score for ~1s.
  useEffect(() => {
    const t = scoreDetails.total;
    if (t > prevScoreRef.current) { setScoreDelta(t - prevScoreRef.current); const id = setTimeout(() => setScoreDelta(0), 900); prevScoreRef.current = t; return () => clearTimeout(id); }
    prevScoreRef.current = t;
  }, [scoreDetails.total]);

  // All buyer-provided spec answers (page-1 ISQ + page-2 AI), non-empty, de-duplicated by field name.
  const allSpecEntries = useMemo(() => {
    const merged: Record<string, string> = { ...specValues, ...aiSpecValues };
    return Object.entries(merged).filter(([, v]) => v && v.trim());
  }, [specValues, aiSpecValues]);

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
      quantity && `Quantity: ${[quantity, unit].filter(Boolean).join(' ')}`,
      ...allSpecEntries.map(([k, v]) => `${k}: ${v}`),
      deliveryLocation && `Deliver to: ${deliveryLocation}`,
      userLocation.trim() && userLocation.trim().toLowerCase() !== deliveryLocation.trim().toLowerCase() && `Buyer location: ${userLocation.trim()}`,
      deliveryTimeline && `Delivery timeline: ${deliveryTimeline}`,
      payment && `Payment: ${payment}`,
      buyerType && `Business type: ${buyerType}`,
      industry.trim() && `Industry: ${industry.trim()}`,
      // Purchase cadence, when relevant, is an LLM-driven AI-spec (page 2) → already in allSpecEntries above.
      // GST only for a business role (never for an individual buyer), and only once answered.
      isBusinessRole && gstRegistered === true && `GST: ${gstNumber.trim() || 'Registered'}`,
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

  const goBack = () => { if (stage === 'product') return onClose(); if (stage === 'specs') return setStage('product'); if (stage === 'aispecs') return setStage('specs'); if (stage === 'more') return setStage('aispecs'); setStage('more'); };
  const submit = () => { if (otpVerified.current) { setStage('results'); return; } setShowOTP(true); };
  // Clickable top stepper: jump only to a VISITED node (index ≤ current) — never skip ahead.
  const goToNode = (target: Stage) => { if (stageNodeIdx(target) <= stageNodeIdx(stage)) setStage(target); };
  // Score-panel deep-link: map a score check to the stage that owns it, so tapping a missing item jumps
  // straight there (forward OR back — it's a shortcut). Product name/image/qty→product; Specifications→specs;
  // Smart questions→aispecs; everything in Details (location/timeline/payment/buyer/profile/GST)→more.
  const checkStage = (c: ScoreCheck): Stage => (c.group === 'Product' ? 'product' : c.group === 'Specs' ? (/smart/i.test(c.label) ? 'aispecs' : 'specs') : 'more');
  const jumpToCheck = (c: ScoreCheck) => { setScoreOpen(false); setLocationEditing(false); setStage(checkStage(c)); };
  // R1 steal — exit-intent salvage: the FIRST close attempt from a FLOW page jumps to the last page + opens
  // contact + nudges (don't lose the RFQ). A second attempt (or from product/results) closes for real.
  const handleExit = () => {
    if (!exitIntentUsed.current && stage !== 'product' && stage !== 'results') {
      exitIntentUsed.current = true;
      setStage('more'); setContactOpen(true); setScoreOpen(false); setLocationEditing(false);
      setToast('Almost there — just add your contact to get quotes.');
      setTimeout(() => setToast(''), 3500);
      return;
    }
    onClose();
  };
  const scrollCard = (d: 1 | -1) => { const el = cardScrollRef.current; if (!el) return; el.scrollBy({ left: d * el.clientWidth * 0.86, behavior: 'smooth' }); setCardIdx((i) => Math.max(0, Math.min(DEMO_SELLERS.length - 1, i + d))); };

  const progressPercent = stage === 'specs' ? 33 : stage === 'aispecs' ? 55 : stage === 'more' ? 85 : stage === 'results' ? 100 : 0;

  // ── The product input row (shared by mobile-Lens front page and desktop two-panel) ──
  const productInputRow = (
    <div className="relative">
      <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100 bg-white">
        {isMobile && <Search className="w-4 h-4 text-gray-300 ml-3.5 shrink-0" />}
        <input
          type="text" value={productName}
          onChange={(e) => onProductInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && productName.trim()) commitProduct(productName.trim()); }}
          onFocus={() => { if (suggestions.length || (recents.length && !productName.trim())) setShowDropdown(true); }}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          placeholder={isMobile ? 'What are you looking to buy?' : 'e.g., TMT Bar, Diesel Generator…'}
          className="flex-1 min-w-0 px-4 py-3 text-base sm:text-sm outline-none bg-transparent"
        />
        <button type="button" onClick={() => setShowVoice(true)} aria-label="Speak" className="flex items-center justify-center px-3 text-green-600 border-l border-gray-100 hover:bg-green-50 py-3"><Mic size={18} /></button>
        <button type="button" onClick={() => fileRef.current?.click()} aria-label="Camera" className="px-3 text-teal-600 border-l border-gray-100 hover:bg-teal-50 py-3"><Camera size={16} /></button>
      </div>
      {resolving && <span className="absolute right-24 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />}
      {showDropdown && (suggestions.length > 0 || (recents.length > 0 && !productName.trim())) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden max-h-52 overflow-y-auto">
          {suggestions.length === 0 && !productName.trim() && recents.length > 0 && (
            <>
              <p className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Recent searches</p>
              {recents.map((r) => (<button key={r} onMouseDown={() => commitProduct(r)} className="w-full flex items-center gap-2 text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700"><Clock size={13} className="text-gray-300 shrink-0" />{r}</button>))}
            </>
          )}
          {suggestions.map((s) => (<button key={s} onMouseDown={() => commitProduct(s)} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-teal-50 hover:text-teal-700">{s}</button>))}
        </div>
      )}
      {notFound && <p className="text-xs text-amber-600 mt-1.5">Couldn&apos;t match that to a category — try a more specific product name.</p>}
      {resolveError && <p className="text-xs text-red-500 mt-1.5">Network issue reaching the catalog — <button type="button" onClick={() => commitProduct(productName)} className="font-semibold underline">tap to retry</button>.</p>}
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
              <input ref={qtyRef} type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && canContinueProduct) setStage('specs'); }} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 animate-field-highlight" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Unit</label>
              <div className="flex flex-wrap gap-2">{unitOptions.map((u) => <RadioChip key={u} label={u} selected={unit === u} onClick={() => setUnit(unit === u ? '' : u)} />)}</div>
            </div>
          </div>
          {isMobile && <button type="button" disabled={!canContinueProduct} onClick={() => canContinueProduct && setStage('specs')} className={`w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${canContinueProduct ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-gray-100 text-gray-300'}`}>Continue <ArrowRight className="w-4 h-4" /></button>}
        </>
      ) : (
        <div className="space-y-4">
          {/* No API units for this category → qty/unit not required. But if voice/photo/name CAPTURED a
              quantity, show it editable so the buyer can see/correct it (never a hidden-but-submitted fact). */}
          {quantity.trim() && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
              <input ref={qtyRef} type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ''))} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            </div>
          )}
          {isMobile && <button type="button" disabled={!canContinueProduct} onClick={() => canContinueProduct && setStage('specs')} className={`w-full py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${canContinueProduct ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-gray-100 text-gray-300'}`}>Continue <ArrowRight className="w-4 h-4" /></button>}
        </div>
      )}
      {specsLoading && <p className="text-xs text-gray-400 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Loading specifications…</p>}
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
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mt-1">{getScoreLabel(scoreDetails.total)} · RFQ strength</span>
            </div>
            <div className="space-y-3">
              {(['Product', 'Specs', 'Details'] as const).map((g) => {
                const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
                if (!items.length) return null;
                return (
                  <div key={g}>
                    <p className="text-[10px] font-semibold text-gray-300 uppercase tracking-wide mb-1">{g}</p>
                    {items.map((c) => (
                      <button type="button" key={c.label} onClick={() => jumpToCheck(c)} className="w-full flex items-center justify-between py-1 px-1 -mx-1 rounded-md hover:bg-gray-50 text-left transition-colors group/row">
                        <span className={`flex items-center gap-2 text-sm ${c.done ? 'text-gray-700' : 'text-gray-500 group-hover/row:text-gray-700'}`}>
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0 ${c.done ? 'bg-teal-500 text-white' : 'border border-gray-300'}`}>{c.done ? '✓' : ''}</span>
                          {c.label}
                        </span>
                        {!c.done ? <span className="flex items-center gap-1 text-xs text-gray-400 font-medium"><span className="opacity-0 group-hover/row:opacity-100 text-teal-500 transition-opacity">Go</span>+{c.pts - c.earned}</span> : <ChevronRight size={13} className="text-gray-200 group-hover/row:text-gray-400" />}
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

  // ── Delivery-location popover (rebuilt to the mockup: current-location + your/delivery + same-as) ──
  const renderLocationPopover = (align: 'left' | 'right' = 'right') => (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setLocationEditing(false)} />
      <div className={`fixed inset-x-0 bottom-0 z-40 w-full rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left space-y-3 bg-white shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-3rem)] sm:rounded-xl sm:border sm:p-3 ${align === 'left' ? 'sm:left-0' : 'sm:right-0'}`} style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-1 sm:hidden" />
        {/* ① Use my current location (browser GPS → reverse-geocode; falls back to IP city) */}
        <button type="button" onClick={useCurrentLocation} disabled={geoLoading} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-sm font-semibold hover:bg-teal-100 disabled:opacity-60">
          {geoLoading ? <span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" /> : <LocateFixed size={15} />} Use my current location
        </button>
        {/* ② Your location */}
        <div>
          <p className="text-[11px] uppercase font-semibold text-gray-400 tracking-wide mb-1">Your location</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
            <input type="text" value={userLocation} onChange={(e) => applyUserCity(e.target.value)} placeholder="Search city…" className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          </div>
        </div>
        {/* ③ Delivery location (disabled while "same as" is on) */}
        <div>
          <p className="text-[11px] uppercase font-semibold text-gray-400 tracking-wide mb-1">Delivery location</p>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
            <input type="text" value={deliveryLocation} disabled={sameAsLoc} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="Search city…" className={`w-full border rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${sameAsLoc ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed' : 'border-gray-200'}`} />
          </div>
        </div>
        {/* ④ Same as my location */}
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
          <input type="checkbox" checked={sameAsLoc} onChange={toggleSameAs} className="accent-teal-600 w-4 h-4" />
          Delivery is same as my location
        </label>
        <button type="button" onClick={() => setLocationEditing(false)} className="w-full py-2.5 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700">Done</button>
      </div>
    </>
  );

  // ── Spec fields (ALL buyer specs, one list). Shows the getSpecHints per-field hint when present. ──
  const renderSpecField = (s: ISQSpec) => {
    const opts = s.IM_SPEC_OPTIONS_DESC ? s.IM_SPEC_OPTIONS_DESC.split('##').map((o) => o.trim()).filter(Boolean) : [];
    const hint = isqHints[s.IM_SPEC_MASTER_DESC];
    return (
      <div key={s.IM_SPEC_MASTER_DESC} className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">{s.IM_SPEC_MASTER_DESC}{hint && <span className="ml-2 font-normal text-gray-400">— {hint}</span>}</label>
        {opts.length > 0 ? <OptionChips options={opts} value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(v) => setSpecValue(s.IM_SPEC_MASTER_DESC, v)} />
          : <input type="text" value={specValues[s.IM_SPEC_MASTER_DESC] || ''} onChange={(e) => setSpecValue(s.IM_SPEC_MASTER_DESC, e.target.value)} placeholder={hint || `Enter ${s.IM_SPEC_MASTER_DESC.toLowerCase()}`} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400" />}
      </div>
    );
  };

  // Hide specs the product name makes not-applicable (getSpecHints.redundantISQSpecs), but never hide one
  // the buyer already answered.
  const visibleSpecs = isqSpecs.filter((s) => !redundantISQSpecs.includes(s.IM_SPEC_MASTER_DESC) || specValues[s.IM_SPEC_MASTER_DESC]);
  const specBody = specsLoading && isqSpecs.length === 0 ? (
    <p className="text-xs text-gray-400 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Fetching category spec fields…</p>
  ) : isqSpecs.length === 0 ? (
    <p className="text-sm text-gray-400">No standard specs for this product — continue to the smart questions →</p>
  ) : (
    <div className="space-y-5">
      {/* ALL buyer specs on page 1 (owner 2026-07-21) — these are the buyer's own requirement-form fields;
          no top-3 + "+more" split (that hid half the buyer specs and read as redundant vs page 2). */}
      {visibleSpecs.map(renderSpecField)}
    </div>
  );

  // ── Page 2 · AI specs (getMissingSpecs over the live category node) — options-only questions ──
  // Filter out any question a late authoritative getISQs has since made a page-1 ISQ field (no dup ask).
  const isqNameSet = new Set(isqSpecs.map((s) => s.IM_SPEC_MASTER_DESC.toLowerCase()));
  const visibleAiSpecs = aiSpecs.filter((q) => !isqNameSet.has(q.fieldName.toLowerCase()));
  const aiSpecsBody = (
    <div className="space-y-5">
      {/* Category-corpus status (Category mode only). It is a NON-BLOCKING enrichment: if the n8n/Redash corpus
          errors or is slow, the planner runs on the same buyer+seller+intent inputs — one source is just absent.
          So error/none read as "Using smart fallback", never a scary red "Error". */}
      {categoryMode === 'category' && (
        <div className="flex items-center flex-wrap gap-2 text-xs bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
          <span className="font-semibold text-gray-500">Category corpus</span>
          <span className={`inline-flex items-center gap-1.5 font-medium ${catStatus.state === 'ready' ? 'text-green-600' : catStatus.state === 'fetching' ? 'text-amber-600' : 'text-gray-400'}`}>
            {catStatus.state === 'fetching' && <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />}
            {catStatus.state === 'ready' ? (catStatus.count ? `${catStatus.count} calls ✓` : 'loaded ✓') : catStatus.state === 'fetching' ? 'Fetching…' : (catStatus.state === 'error' || catStatus.state === 'none') ? 'Using smart fallback' : '—'}
            {mcatId && <span className="text-gray-400 font-normal">· mcat {mcatId}</span>}
          </span>
        </div>
      )}
      {aiSpecsLoading && visibleAiSpecs.length === 0 && (
        <p className="text-xs text-gray-400 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />Preparing smart questions…</p>
      )}
      {!aiSpecsLoading && visibleAiSpecs.length === 0 && (
        <p className="text-sm text-gray-400">{aiSpecsError ? 'Couldn’t load smart questions right now — you can continue anyway. →' : 'No extra questions needed — your specs already cover it. Continue →'}</p>
      )}
      {visibleAiSpecs.map((q) => (
        <div key={q.fieldName} className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            {q.fieldName}
            {q.helperText && <span className="ml-2 font-normal text-gray-400">— {q.helperText}</span>}
            {q.prefill && aiSpecValues[q.fieldName] === q.prefill && <span className="ml-2 font-normal text-teal-600">✦ from your input</span>}
          </label>
          <OptionChips options={q.options} value={aiSpecValues[q.fieldName] || ''} onChange={(v) => setAiSpecValues((p) => ({ ...p, [q.fieldName]: v }))} />
        </div>
      ))}
    </div>
  );

  // ── More Details (V3 renderDeliveryPage cards, deterministic) ──
  const showPaymentMode = !!paymentTerms && paymentTerms !== 'Credit (Post-Delivery)' && paymentTerms !== 'Loan/Finance';
  // ── Last page pieces (owner order): Logistics & Payment FIRST, then About You, then Contact (collapsed). ──
  const logisticsBody = (
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        {/* MOBILE: delivery location lives HERE (header is crowded on MSite). Desktop keeps the header pill. */}
        {isMobile && (
          <div className="mb-4 relative">
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide"><MapPin size={13} className="text-teal-500" /> Delivery location</p>
            <button type="button" onClick={() => { setScoreOpen(false); setLocationEditing((v) => !v); }} className="w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 hover:border-teal-300">
              <span className="truncate flex items-center gap-1.5"><MapPin size={13} className="text-gray-300 shrink-0" />{deliveryLocation || detectedCity || 'Select delivery city'}</span>
              <Pencil size={13} className="text-gray-400 shrink-0" />
            </button>
            {locationEditing && renderLocationPopover('left')}
          </div>
        )}
        <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
          <div>
            <p className="flex items-center gap-1.5 text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide"><Clock size={13} className="text-teal-500" /> Delivery</p>
            <div className="flex flex-wrap gap-2">{TIMELINE.map((t) => <RadioChip key={t} label={t} selected={deliveryTimeline === t} onClick={() => setDeliveryTimeline(t)} />)}</div>
          </div>
          <div>
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
          <span className="text-xs uppercase font-semibold text-gray-400 tracking-wide">Contact details</span>
          {contactOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </button>
        {contactOpen && (
          <div className="space-y-3 mt-4">
            <input type="text" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400"><span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200">+91</span><input type="tel" value={contactMobile} onChange={(e) => setContactMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile" className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none" /></div>
            <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <textarea value={requirementNotes} onChange={(e) => setRequirementNotes(e.target.value)} rows={2} placeholder="Any specific requirement, grade, packaging…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
          </div>
        )}
      </div>
  );

  // ── More Details (stage 'more') = About You. Logged-out shows the Login button + autofetch banner. ──
  const moreBody = (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 p-4 sm:p-5 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide">About you <span className="text-gray-300 normal-case font-normal">(optional)</span></p>
          {isLoggedIn
            ? <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 shrink-0"><CheckCircle2 size={14} /> {contactName || 'Logged in'}</span>
            : <button type="button" onClick={handleLogin} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 shrink-0"><LogIn size={13} /> Login</button>}
        </div>
        <div className="flex flex-col sm:grid sm:grid-cols-2 gap-4 sm:gap-6">
          <div>
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Business type</p>
            <div className="flex flex-wrap gap-2">{BUSINESS_TYPES.map((t) => <RadioChip key={t} label={t} selected={buyerType === t} onClick={() => setBuyerType(buyerType === t ? '' : t)} />)}</div>
          </div>
          <div>
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">Industry</p>
            <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g., Construction" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          </div>
        </div>
        {/* GST — asked only for a BUSINESS role (every Business type except "Individual Buyer"), per the V3 rule.
            Golden Rule: gstRegistered starts null (UNKNOWN) — we never assume "No". */}
        {isBusinessRole && (
          <div className="mt-4 pt-4 border-t border-gray-100 animate-field-in">
            <p className="text-xs uppercase font-semibold text-gray-500 mb-2 tracking-wide">GST Registered?</p>
            <div className="flex flex-wrap gap-2">
              <RadioChip label="Yes" selected={gstRegistered === true} onClick={() => setGstRegistered(gstRegistered === true ? null : true)} />
              <RadioChip label="No" selected={gstRegistered === false} onClick={() => { setGstRegistered(gstRegistered === false ? null : false); setGstNumber(''); }} />
            </div>
            {gstRegistered === true && (
              <input type="text" value={gstNumber} onChange={(e) => setGstNumber(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} placeholder="GST number (15 digits)" className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ── Curated sellers (results) ──
  const resultsBody = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 min-w-0 truncate"><span className="font-semibold text-gray-800">Your requirement:</span> {requirementSummary}</p>
        <button type="button" onClick={() => setStage('specs')} aria-label="Edit" className="shrink-0 w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-500 hover:text-teal-600 hover:border-teal-300"><Pencil className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex items-center justify-between">
        <div><h3 className="text-base font-bold text-gray-800">Curated Sellers For You</h3><p className="text-xs text-gray-400">Hand-picked against your specs &amp; quantity</p></div>
        {!isMobile && <div className="flex gap-1.5"><button type="button" onClick={() => scrollCard(-1)} className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button><button type="button" onClick={() => scrollCard(1)} className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button></div>}
      </div>
      <div ref={cardScrollRef} onScroll={(e) => setCardIdx(Math.round(e.currentTarget.scrollLeft / (e.currentTarget.clientWidth * 0.86)))} className="flex gap-3 overflow-x-auto snap-x snap-mandatory -mx-1 px-1 pb-2 scroll-smooth">
        {DEMO_SELLERS.map((s) => {
          const sent = sentTo.has(s.name); const open = openEnquiry === s.name;
          return (
            <div key={s.name} className={`snap-center shrink-0 ${isMobile ? 'w-[86%]' : 'w-[300px]'} bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden`}>
              <div className="relative bg-gray-50" style={{ aspectRatio: '4/3' }}>
                <span className="absolute top-3 left-3 z-10 bg-black/80 text-white text-xs font-semibold px-2.5 py-1 rounded-full">Get Best Price</span>
                {productImageUrl ? <img src={productImageUrl} alt="" className="w-full h-full object-contain p-4" /> : <div className="w-full h-full flex items-center justify-center"><Package className="w-10 h-10 text-gray-300" /></div>}
              </div>
              <div className="p-4 space-y-2">
                <p className="font-bold text-gray-800">{s.name}</p>
                <p className="flex items-center gap-1 text-sm text-gray-500"><MapPin className="w-3.5 h-3.5" /> {s.city}</p>
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  {s.gst && <span className="flex items-center gap-1"><BadgeCheck className="w-3.5 h-3.5 text-green-600" /> GST</span>}
                  {s.trustSeal && <span className="flex items-center gap-1"><Award className="w-3.5 h-3.5 text-amber-500" /> TrustSEAL</span>}
                  {s.paymentProtected && <span className="flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-teal-600" /> Payment Protected</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500"><span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {s.tenureYears} yrs</span><span className="flex items-center gap-1"><Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" /> {s.rating} ({s.reviews})</span></div>
                {open ? (
                  <div className="pt-1 space-y-2 animate-field-in">
                    <textarea readOnly rows={5} value={`Hi ${s.name}, I need:\n${buildRequirementText()}`} className="w-full text-xs text-gray-700 border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 resize-none" />
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => { setSentTo((p) => new Set(p).add(s.name)); setOpenEnquiry(null); }} className="flex-1 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold">Send</button>
                      {isMobile && <a href={waDeeplink()} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-[#25D366] text-white text-sm font-semibold"><MessageCircle className="w-4 h-4" /> WhatsApp</a>}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pt-1">
                    <button type="button" onClick={() => setOpenEnquiry(s.name)} disabled={sent} className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold ${sent ? 'bg-green-50 text-green-700' : 'bg-teal-600 hover:bg-teal-700 text-white'}`}>{sent ? '✓ Enquiry sent' : <><Send className="w-3.5 h-3.5" /> Send Enquiry</>}</button>
                    <button type="button" aria-label="Call" className="w-10 h-10 shrink-0 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600"><Phone className="w-4 h-4" /></button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-center gap-1.5">{DEMO_SELLERS.map((_, i) => <span key={i} className={`h-1.5 rounded-full transition-all ${i === cardIdx ? 'w-5 bg-teal-500' : 'w-1.5 bg-gray-200'}`} />)}</div>
    </div>
  );

  // ── The single-panel (steps 1/2/results) — V3 chrome ──
  const singlePanel = (
    <div className={`flex flex-col ${isMobile || standalone ? 'h-full' : 'h-[78vh] min-h-[560px] max-h-[92vh]'} min-h-0`}>
      <div className="px-5 pt-4 pb-0 flex items-center gap-3 shrink-0">
        {isMobile
          ? <button onClick={goBack} aria-label="Back" className="w-9 h-9 -ml-1 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"><ArrowLeft className="w-5 h-5" /></button>
          : <button onClick={() => fileRef.current?.click()} className="w-10 h-10 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-400 hover:border-teal-300 shrink-0 overflow-hidden">{productImageUrl ? <img src={productImageUrl} className="w-full h-full object-cover rounded-xl" alt="" /> : <Camera size={16} />}</button>}
        <div className="flex-1 min-w-0">
          <p className="font-bold text-teal-600 text-base leading-tight truncate">{productName}</p>
        </div>
        {stage === 'more' && !isMobile && (
          // Delivery-location pill in the header on DESKTOP only (space). On MOBILE the top is cluttered
          // (score + sticky CTA), so the location moves INTO the Logistics & Payment card (owner 2026-07-21).
          <div className="relative shrink-0">
            <button type="button" onClick={() => { setScoreOpen(false); setLocationEditing((v) => !v); }} className="flex items-center gap-1 max-w-[110px] sm:max-w-[150px] px-2.5 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-xs text-gray-700 transition-colors" aria-label="Change delivery location">
              <MapPin size={12} className="text-teal-500 shrink-0" />
              <span className="truncate">{deliveryLocation || detectedCity || 'Select city'}</span>
              <Pencil size={11} className="text-gray-400 shrink-0" />
            </button>
            {locationEditing && renderLocationPopover('right')}
          </div>
        )}
        {!standalone && stage !== 'results' && scoreCircle}
        {/* Keyboard-safe mobile CTA (owner): the footer Next/Get-Quotes sits behind the on-screen keyboard on
            text-input stages, so mirror it into the always-visible header. Footer stays for the non-keyboard case. */}
        {isMobile && stage !== 'results' && (
          <button type="button" onClick={() => { if (stage === 'specs') setStage('aispecs'); else if (stage === 'aispecs') setStage('more'); else submit(); }} className="flex items-center gap-1 shrink-0 bg-teal-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-teal-700">
            {stage === 'more' ? 'Get Quotes' : 'Next'} <ArrowRight size={13} />
          </button>
        )}
        {!isMobile && !standalone && <button onClick={handleExit} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200 ml-1 shrink-0"><X size={14} /></button>}
      </div>
      {/* Clickable stage stepper (owner MSite redesign): a per-stage ICON for every node, colored by
          passed/current/upcoming; the stage NAME shows only for the CURRENT stage on mobile (all labels on
          desktop). Passed icons (idx ≤ current) are clickable to jump back. A green blinking dot sits on the
          "More Details" node while the AI smart-questions are being prepared in the background. */}
      <div className="mx-5 mt-3 flex items-center gap-1 shrink-0 overflow-x-auto scroll-auto-hide">
        {STEPPER.map((node, i) => {
          const cur = stageNodeIdx(stage);
          const done = i < cur, active = i === cur, clickable = i <= cur;
          const Icon = node.Icon;
          const running = node.stage === 'aispecs' && aiSpecsLoading;
          return (
            <div key={node.stage} className="flex items-center gap-1 shrink-0">
              <button type="button" disabled={!clickable} onClick={() => goToNode(node.stage)} aria-label={node.label} aria-current={active ? 'step' : undefined}
                className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[11px] font-semibold transition-colors ${active ? 'text-teal-700' : done ? 'text-teal-600 hover:bg-gray-50' : 'text-gray-300 cursor-default'}`}>
                <span className={`relative w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${active ? 'bg-teal-600 text-white' : done ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'}`}>
                  <Icon size={13} />
                  {running && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 ring-2 ring-white animate-pulse" />}
                </span>
                {(active || !isMobile) && <span className="whitespace-nowrap">{node.label}</span>}
              </button>
              {i < STEPPER.length - 1 && <span className={`h-px shrink-0 ${isMobile ? 'w-3' : 'w-2.5'} ${done ? 'bg-teal-300' : 'bg-gray-200'}`} />}
            </div>
          );
        })}
      </div>
      <div className="mx-5 mt-2 h-0.5 bg-gray-100 rounded-full overflow-hidden shrink-0"><div className="h-full bg-orange-400 rounded-full transition-all duration-500" style={{ width: progressPercent + '%' }} /></div>
      {aiBusy && <div className="shrink-0 mx-5 mt-2 px-3 py-1.5 flex items-center gap-2 text-[12px] text-teal-700 bg-teal-50 rounded-lg"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-auto-hide px-5 py-5">{stage === 'specs' ? specBody : stage === 'aispecs' ? aiSpecsBody : stage === 'more' ? <div className="space-y-4">{logisticsBody}{moreBody}{contactBody}</div> : resultsBody}</div>
      {/* Footer = DESKTOP only. On mobile it's redundant: the header has the ← back-arrow + the sticky Next/
          Get-Quotes CTA (keyboard-safe), and the stepper shows the step — so the bottom bar is dropped (owner). */}
      {stage !== 'results' && !isMobile && (
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between gap-2 bg-white shrink-0">
          <button onClick={goBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 font-medium shrink-0">← Back</button>
          <span className="text-teal-600 font-medium text-center min-w-0 px-1 leading-tight">
            <span className="sm:hidden text-xs">Step {stageNodeIdx(stage)}/3{stage === 'more' ? ' · Last!' : ''}</span>
            <span className="hidden sm:inline text-sm truncate">Step {stageNodeIdx(stage)} of 3{stage === 'more' ? ' · Last step!' : ''}</span>
          </span>
          {stage === 'specs'
            ? <button onClick={() => setStage('aispecs')} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-teal-700 shrink-0">Next <ArrowRight size={15} /></button>
            : stage === 'aispecs'
            ? (aiSpecsLoading
              // HOLD while the AI-specs call is in flight (owner-locked): Next is held; the escape
              // ("Skip for now") takes the buyer straight to the last page. Late answers still merge.
              ? <span className="flex items-center gap-3 shrink-0">
                  <button type="button" onClick={() => setStage('more')} className="text-sm text-gray-400 underline underline-offset-2 hover:text-gray-600">Skip for now</button>
                  <span className="flex items-center gap-1.5 bg-gray-100 text-gray-400 text-sm font-semibold px-5 py-2.5 rounded-lg"><span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />Preparing…</span>
                </span>
              : <button onClick={() => setStage('more')} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-teal-700 shrink-0">Next <ArrowRight size={15} /></button>)
            : <button onClick={submit} className="flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 shrink-0">Get Quotes <ArrowRight size={15} /></button>}
        </div>
      )}
      {isMobile && <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={handleExit} className="text-sm text-gray-400 underline underline-offset-2">Exit</button></div>}
    </div>
  );

  // ── Product step: mobile = Lens front page · desktop = V3 two-panel ──
  const productMobile = (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-gray-100 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back" className="w-9 h-9 -ml-1 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1 min-w-0"><p className="font-bold text-teal-600 text-[15px] leading-tight">Post a Requirement</p><p className="text-[11px] text-gray-400">Tell us what you need</p></div>
      </div>
      {aiBusy && <div className="shrink-0 px-4 py-1.5 flex items-center gap-2 text-[12px] text-teal-700 bg-teal-50"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
        <p className="text-sm font-semibold text-gray-700 mb-2">Enter Product/Service name <span className="text-red-500">*</span></p>
        {productInputRow}
        {qtyUnitBlock}
      </div>
      <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-center"><button type="button" onClick={onClose} className="text-sm text-gray-400 underline underline-offset-2">Exit</button></div>
    </div>
  );

  // ── Desktop / standalone FRONT PAGE — two-panel, ~90% of the IndiaMART "Post a Requirement" popup:
  //    left teal panel = product image gallery (hero + selectable thumbnails from IMSearchAPI) + pitch;
  //    right panel = product input + (pre-commit) Requirement Details / (post-commit) Quantity + Next. ──
  const productDesktop = (
    <div className="flex" style={{ minHeight: 580 }}>
      {/* Gallery panel: always in the popup; on the STANDALONE landing it's hidden until a product is committed
          (no giant empty box), so the empty landing is a clean single input column. */}
      {(!standalone || committed) && (
      <div className="hidden sm:flex w-[44%] bg-teal-50/70 p-7 flex-col items-center justify-center gap-5">
        {productImageUrl ? (
          <div className="w-full flex flex-col items-center gap-3">
            <div className="relative w-full rounded-2xl overflow-hidden bg-white shadow-sm ring-1 ring-teal-100" style={{ aspectRatio: '4/3' }}>
              <span className="absolute top-2 left-2 z-10 text-[10px] text-gray-400 bg-white/85 px-2 py-0.5 rounded">Representative image</span>
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
      <div className={`flex-1 flex flex-col p-7 min-w-0 relative ${standalone && !committed ? 'max-w-2xl mx-auto w-full' : ''}`}>
        {!standalone && <button onClick={onClose} className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200"><X size={16} /></button>}
        {/* Standalone leads with "What are you looking for?"; the popup has no heading (owner) — straight to input. */}
        {standalone && <div><p className="font-bold text-gray-900 text-2xl leading-tight">What are you looking for?</p><p className="text-sm text-gray-400 mt-1">Enter the product or service name to get started.</p></div>}
        <label className={`block text-sm font-semibold text-gray-700 mb-2 ${standalone ? 'mt-6' : 'mt-1'}`}>Enter Product/Service name <span className="text-red-500">*</span></label>
        {productInputRow}
        {aiBusy && <p className="mt-3 text-[12px] text-teal-700 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />{aiBusy}</p>}
        {committed ? qtyUnitBlock : (
          <div className="mt-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Requirement Details</label>
            <textarea value={requirementNotes} onChange={(e) => setRequirementNotes(e.target.value)} rows={4} placeholder="Describe what you need — grade, size, packaging, brand preference…" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none" />
          </div>
        )}
        <button onClick={() => setStage('specs')} disabled={!canContinueProduct} className={`mt-auto w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all ${canContinueProduct ? 'bg-teal-600 text-white hover:bg-teal-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>Next <ArrowRight size={16} /></button>
      </div>
    </div>
  );

  // IndiaMART top nav for the STANDALONE full-page routes (owner: "use the same header, remove location +
  // search + Get Best Price"). Recreated wordmark (no logo asset in repo). Nav items are chrome (non-functional).
  const standaloneHeader = (
    <header className="shrink-0 h-16 bg-[#2e3192] text-white flex items-center gap-6 px-6 shadow-[0_1px_3px_0_rgba(30,42,58,0.2)]">
      <div className="flex items-center gap-2 select-none">
        <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center shrink-0"><span className="text-[#e4002b] font-black text-lg leading-none">M</span></span>
        <span className="text-xl font-extrabold tracking-tight lowercase">indiamart<span className="text-[9px] align-super font-semibold">®</span></span>
      </div>
      <div className="flex-1" />
      <nav className="flex items-center gap-6">
        {[{ Icon: Store, label: 'Seller Tools' }, { Icon: MessageCircle, label: 'Messages' }, { Icon: HelpCircle, label: 'Help' }, { Icon: Globe, label: 'Exporters' }].map(({ Icon, label }) => (
          <span key={label} className="flex flex-col items-center gap-0.5 text-white/90 cursor-default"><Icon size={18} /><span className="text-[11px]">{label}</span></span>
        ))}
        <span className="flex items-center gap-1.5 cursor-default"><span className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center"><User size={16} /></span><span className="text-sm">Hi {(contactName || 'Tarbrinder').split(' ')[0]}</span><ChevronDown size={14} className="text-white/70" /></span>
      </nav>
    </header>
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
        <p className="text-xs text-gray-400 mt-0.5">Get quotes from verified suppliers</p>
      </div>
      <div className="flex flex-col items-center">
        <div className="relative w-28 h-28">
          <svg viewBox="0 0 44 44" className="w-28 h-28 -rotate-90">
            <circle cx="22" cy="22" r="18" fill="none" stroke="#e5e7eb" strokeWidth="3" />
            <circle cx="22" cy="22" r="18" fill="none" stroke={getScoreColor(scoreDetails.total)} strokeWidth="3" strokeDasharray={`${(scoreDetails.total / 100) * 113.1} 113.1`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.5s ease' }} />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-3xl font-extrabold" style={{ color: getScoreColor(scoreDetails.total) }}>{scoreDetails.total}</span>
        </div>
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-2">{getScoreLabel(scoreDetails.total)} · RFQ strength</span>
      </div>
      <div className="space-y-3 flex-1 overflow-y-auto scroll-auto-hide">
        {(['Product', 'Specs', 'Details'] as const).map((g) => {
          const items = scoreDetails.checks.filter((c) => c.group === g && c.applicable);
          if (!items.length) return null;
          return (
            <div key={g}>
              <p className="text-[10px] font-semibold text-gray-300 uppercase tracking-wide mb-1">{g}</p>
              {items.map((c) => (
                <button type="button" key={c.label} onClick={() => jumpToCheck(c)} className="w-full flex items-center justify-between py-1 px-1 -mx-1 rounded-md hover:bg-gray-50 text-left transition-colors group/row">
                  <span className={`flex items-center gap-2 text-sm ${c.done ? 'text-gray-700' : 'text-gray-500 group-hover/row:text-gray-700'}`}>
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0 ${c.done ? 'bg-teal-500 text-white' : 'border border-gray-300'}`}>{c.done ? '✓' : ''}</span>
                    {c.label}
                  </span>
                  {!c.done ? <span className="flex items-center gap-1 text-xs text-gray-400 font-medium"><span className="opacity-0 group-hover/row:opacity-100 text-teal-500 transition-opacity">Go</span>+{c.pts - c.earned}</span> : <ChevronRight size={13} className="text-gray-200 group-hover/row:text-gray-400" />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {nextCheck && <button type="button" onClick={() => jumpToCheck(nextCheck)} className="w-full text-left text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 hover:bg-amber-100 transition-colors"><span className="flex items-center justify-between"><span className="font-semibold uppercase tracking-wide text-[10px] text-amber-600">Fill next</span><ArrowRight size={12} /></span>{nextCheck.label} <span className="font-semibold">+{nextCheck.pts - nextCheck.earned}</span></button>}
      <button type="button" onClick={handleExit} className="self-start text-sm text-gray-400 underline underline-offset-2 hover:text-gray-600">← Exit</button>
    </aside>
  );

  return (
    <>
      {isMobile ? (
        <div className="fixed inset-0 z-50 bg-white flex flex-col animate-modal-in" style={{ height: '100dvh' }}>
          {stage === 'product' ? productStep : singlePanel}
        </div>
      ) : standalone ? (
        // Standalone full-page route (?rfq=…): a REAL IndiaMART-style page. App shell = IndiaMART header on top,
        // the persistent LEFT score rail, and the form filling the rest full-bleed (no card, no popup X, no gutters).
        <div className="fixed inset-0 z-50 bg-gray-50 flex flex-col">
          {standaloneHeader}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {scoreRail}
            <div className="flex-1 min-w-0 bg-white overflow-y-auto flex flex-col">
              {stage === 'product' ? productStep : singlePanel}
            </div>
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
            <div className={`relative bg-white rounded-xl w-full ${shellWidth} overflow-hidden animate-modal-in shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)]`}>
              {stage === 'product' ? productStep : singlePanel}
            </div>
          </div>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.currentTarget.value = ''; }} />
      {showVoice && <VoiceRecorder onRecordingComplete={(blob) => onVoice(blob)} onCancel={() => setShowVoice(false)} />}
      {showOTP && <OTPGate initialName={contactName} initialMobile={contactMobile} onVerified={() => { otpVerified.current = true; setShowOTP(false); setStage('results'); }} onClose={() => setShowOTP(false)} />}
      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[70] bg-gray-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[90vw] text-center animate-modal-in">{toast}</div>}
    </>
  );
}
