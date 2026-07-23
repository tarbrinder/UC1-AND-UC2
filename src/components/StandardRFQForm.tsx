import { useState, useRef, useEffect } from 'react';
import {
  ExternalLink, Plus, Trash2, CheckCircle2, MessageCircle, Package, Truck,
  Check, ArrowLeft, ChevronRight, ChevronUp, ChevronDown, Lock, LogIn, LocateFixed, MapPin, Pencil,
} from 'lucide-react';
import IndiaMartHeader from './IndiaMartHeader';
import { upsizeImimg } from '../lib/enrichment';
import { getJSON } from '../lib/api';
import { emit, emitApiError, EV } from '../lib/emit';
import { resolveRfqTheme, rfqThemeClass } from '../lib/theme';
import { sanitizeQty, qtyIsMeaningful, isValidIndianMobile, isValidGSTIN } from '../utils/formValidation';
import type { StandardProduct, StandardRequirement } from '../lib/standardProducts';

// "Standard Product" RFQ — a KNOWN brand-catalog SKU (from a brands.indiamart.com "Get Best Price"). The product
// is fixed (title / image / url / single-valued specs), so there is NO search and NO AI planner — no LLM at all.
// It mirrors the SimpleRFQForm flow: a Product step → a "Your Profile & Delivery" last step → sent. The 6 catalog
// specs come pre-selected (buyer can untick any), the product URL rides along as a locked custom spec, and the
// catalog photo is pre-set as the buyer's product image. Self-contained SERVICE component — the host receives the
// captured requirement via `onSubmit` (falls back to a demo confirmation when absent).

interface Props {
  product: StandardProduct;
  onClose: () => void;
  onSubmit?: (requirement: StandardRequirement) => void;
  standalone?: boolean;
  loggedIn?: boolean; // Buyer-Profile scenario: host mounts already-authenticated → contact prefilled, no Login button
}

const UNITS = ['Meter', 'Roll', 'Km', 'Piece', 'Nos'];
// Last-page option sets kept IN SYNC with the Simple form (owner: "last page options not in sync with mobile form").
const TIMELINES = ['Immediate', 'Within 15 Days', '1 Month', 'Flexible'];
const PAYMENTS = ['Full Advance', 'Credit (Post-Delivery)', 'COD', 'Loan/Finance'];
const CREDIT_PERIODS = ['15 Days', '30 Days', '45 Days', '60 Days', '90 Days'];
const PAYMENT_MODES = ['Online Transfer', 'Cash', 'Cheque'];
const BUSINESS_TYPES = ['Online Business', 'Exporter', 'Manufacturer', 'Retailer', 'Service Provider', 'Wholesaler', 'Individual Buyer'];

// radio-style pill (single-select within a group)
function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
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

const STEPS = [
  { key: 'product', label: 'Product', Icon: Package },
  { key: 'details', label: 'Your Profile & Delivery', Icon: Truck },
] as const;

export default function StandardRFQForm({ product, onClose, onSubmit, standalone = false, loggedIn = false }: Props) {
  const [surf] = useState<'mobile' | 'desktop'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 'desktop' : 'mobile',
  );
  const isMobile = surf === 'mobile';

  const [stage, setStage] = useState<'product' | 'details'>('product');
  // all 6 catalog specs ride along by default; the buyer can untick any they don't want quoted
  const [selectedSpecs, setSelectedSpecs] = useState<Set<string>>(() => new Set(product.specs.map((s) => s.name)));
  const [description, setDescription] = useState(product.description);
  const [customSpecs, setCustomSpecs] = useState<{ name: string; value: string }[]>([]);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('Meter');
  // logistics + about-you (mirror the SimpleRFQForm last page)
  const [timeline, setTimeline] = useState('');
  const [payment, setPayment] = useState('');
  const [creditPeriod, setCreditPeriod] = useState('');   // shown only when payment = Credit (in sync with Simple)
  const [paymentMode, setPaymentMode] = useState('');      // shown for non-credit/loan payments
  const [userLocation, setUserLocation] = useState('');    // buyer's own location (vs delivery) — Simple-form model
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [sameAsLoc, setSameAsLoc] = useState(true);        // delivery = my location (default on)
  const [locationEditing, setLocationEditing] = useState(false); // location drawer/popover open
  const [detectingLoc, setDetectingLoc] = useState(false); // GPS/IP city detection in flight
  const [businessType, setBusinessType] = useState('');
  const [industry, setIndustry] = useState('');
  const [gstRegistered, setGstRegistered] = useState<boolean | null>(null); // null = UNKNOWN; asked only for a business role
  const [gstNumber, setGstNumber] = useState('');
  // Contact starts EMPTY for a guest (P1-114: never ship a real identity to an anonymous buyer). Identity is
  // filled ONLY once the buyer is logged in — either the host mounts us authenticated (loggedIn prop, the
  // Buyer-Profile scenario) or they tap Login in the Contact card (the login scenario). Mirrors SimpleRFQForm.
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
  const [contactOpen, setContactOpen] = useState(!loggedIn); // Contact card is COLLAPSIBLE (in sync with Simple); collapsed once logged-in/prefilled
  const [sent, setSent] = useState(false);
  const submittedRef = useRef(false); // one-shot guard so a double-tap can't fire onSubmit twice (P2-252)

  // ⚑ DEV-TODO (owner: "two scenarios for the developer"): replace this demo identity with the REAL source —
  //   (a) Buyer-Profile fetch when mounted logged-in (GET the authenticated buyer's name/mobile/email), or
  //   (b) the actual IndiaMART login/OTP flow behind the Login button below. The hardcoded values are DEMO ONLY.
  const applyLoggedInDefaults = () => {
    setContactName((n) => n || 'Tarbrinder Singh');
    setContactMobile((m) => m || '8283830681');
  };
  useEffect(() => { if (isLoggedIn) applyLoggedInDefaults(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isLoggedIn]);

  const [heroBroken, setHeroBroken] = useState(false); // P3-310: a dead catalog image URL falls back to the Package glyph
  const [rfqTheme] = useState(resolveRfqTheme);        // IST-based dark theme (self-scoped via rfq-root)
  const themeClass = rfqThemeClass(rfqTheme);
  const hero = heroBroken ? '' : product.image;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [showScrollHint, setShowScrollHint] = useState(false); // subtle "more below" amber chevron (in sync with Simple)
  // Funnel telemetry (in sync with the Simple form so Standard opens/steps/conversions are measurable once the
  // analytics sink is wired) — form open once on mount, then a page_transition per step.
  useEffect(() => { emit(EV.FORM_OPEN, { form: 'standard', surface: standalone ? 'standalone' : (isMobile ? 'mobile' : 'popup'), sid: product.sid, loggedIn }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { emit(EV.PAGE_TRANSITION, { form: 'standard', to: stage }); }, [stage]);
  // Reset the scroll to the top on every step change (P3-314 — the new step used to open mid-scroll).
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [stage]);
  // "More below" hint — appears only when the body overflows + not scrolled to the end.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) { setShowScrollHint(false); return; }
    const update = () => setShowScrollHint(el.scrollHeight - el.scrollTop - el.clientHeight > 40);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (ro && el.firstElementChild) ro.observe(el.firstElementChild);
    const t1 = setTimeout(update, 400); const t2 = setTimeout(update, 1500);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); clearTimeout(t1); clearTimeout(t2); };
  }, [stage, sent]);
  // Popup (host-embed) shell: lock the host page behind the modal so it can't scroll (P2-250). The standalone/mobile
  // shells replace the whole page, so nothing is behind them — only the popup mount needs this.
  useEffect(() => {
    if (isMobile || standalone) return;
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isMobile, standalone]);
  // Escape closes the popup modal (P2-212). The mobile/standalone shells are full-page routes — Escape there
  // would navigate the buyer away mid-fill, so it's scoped to the popup embed only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (locationEditing) { setLocationEditing(false); return; } // close the location drawer first (any shell)
      if (!isMobile && !standalone) onClose();                    // then the popup modal (full-page shells don't exit on Escape)
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, standalone, onClose, locationEditing]);

  // Location model IN SYNC with the Simple form: buyer's own location + delivery location + "same as" toggle.
  const applyUserCity = (city: string) => { setUserLocation(city); setSameAsLoc((same) => { if (same) setDeliveryLocation(city); return same; }); };
  const toggleSameAs = () => setSameAsLoc((prev) => { const next = !prev; if (next) setDeliveryLocation(userLocation); return next; });
  // Prefill from a coarse IP lookup on mount (only if empty). ⚑ DEV-TODO: ipapi.co / bigdatacloud are demo geo providers.
  useEffect(() => {
    let alive = true;
    getJSON<{ city?: string }>('https://ipapi.co/json/')
      .then((d) => { if (alive && d?.city) { setUserLocation((v) => v || d.city!); setDeliveryLocation((v) => v || d.city!); } })
      .catch((e) => emitApiError('ipapi', e));
    return () => { alive = false; };
  }, []);
  const detectLocation = () => {
    setDetectingLoc(true);
    const fallback = () => getJSON<{ city?: string }>('https://ipapi.co/json/')
      .then((d) => { if (d?.city) applyUserCity(d.city); })
      .catch((e) => emitApiError('ipapi', e))
      .finally(() => setDetectingLoc(false));
    if (!('geolocation' in navigator)) { fallback(); return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const r = await getJSON<{ city?: string; locality?: string; principalSubdivision?: string }>(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const city = (r?.city || r?.locality || r?.principalSubdivision || '').trim();
          if (city) applyUserCity(city);
        } catch (e) { emitApiError('reverseGeocode', e); }
        finally { setDetectingLoc(false); }
      },
      () => fallback(),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };
  // Derived (mirror Simple): GST asked only for a business role; payment-mode shown for non-credit/loan payments.
  const isBusinessRole = !!businessType && !/individual|personal|end[\s-]?user|consumer|home/i.test(businessType);
  const showPaymentMode = !!payment && payment !== 'Credit (Post-Delivery)' && payment !== 'Loan/Finance';

  const toggleSpec = (name: string) =>
    setSelectedSpecs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const addCustom = () => setCustomSpecs((c) => [...c, { name: '', value: '' }]);
  const setCustom = (i: number, k: 'name' | 'value', v: string) =>
    setCustomSpecs((c) => c.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const removeCustom = (i: number) => setCustomSpecs((c) => c.filter((_, j) => j !== i));

  // specs the buyer kept + the product URL (always) + any custom rows they filled in
  const chosenSpecs = () => product.specs.filter((s) => selectedSpecs.has(s.name));
  const carriedCustom = () => [
    { name: 'Product page', value: product.url },
    ...customSpecs.filter((c) => c.name.trim() && c.value.trim()),
  ];

  const buildText = (): string =>
    [
      `Requirement (exact product): ${product.title}`,
      ...chosenSpecs().map((s) => `${s.name}: ${s.value}`),
      ...carriedCustom().map((c) => `${c.name.trim()}: ${c.value.trim()}`),
      qtyIsMeaningful(quantity) && `Quantity: ${[quantity.trim(), unit].filter(Boolean).join(' ')}`,
      description.trim() && `Details: ${description.trim()}`,
      timeline && `Delivery timeline: ${timeline}`,
      payment && `Payment terms: ${[payment, payment === 'Credit (Post-Delivery)' && creditPeriod, showPaymentMode && paymentMode].filter(Boolean).join(' · ')}`,
      deliveryLocation.trim() && `Delivery to: ${deliveryLocation.trim()}`,
      userLocation.trim() && userLocation.trim() !== deliveryLocation.trim() && `Buyer location: ${userLocation.trim()}`,
      businessType && `Buyer type: ${businessType}`,
      industry.trim() && `Industry: ${industry.trim()}`,
      isBusinessRole && gstRegistered === true && `GST: ${isValidGSTIN(gstNumber) ? gstNumber.trim().toUpperCase() : 'Registered'}`, // valid GSTIN only, else "Registered"
      isBusinessRole && gstRegistered === false && `GST: Not registered`,
    ]
      .filter(Boolean)
      .join('\n');

  const submit = () => {
    if (submittedRef.current) return; // P2-252: guard against a fast double-tap firing onSubmit twice
    submittedRef.current = true;
    const req: StandardRequirement = {
      sid: product.sid,
      productTitle: product.title,
      productUrl: product.url,
      imageUrl: product.image,
      specs: Object.fromEntries(chosenSpecs().map((s) => [s.name, s.value])),
      customSpecs: carriedCustom(),
      description: description.trim(),
      quantity: quantity.trim(),
      unit,
      logistics: { deliveryTimeline: timeline, paymentTerms: payment, creditPeriod: payment === 'Credit (Post-Delivery)' ? creditPeriod : '', paymentMode: showPaymentMode ? paymentMode : '', deliveryLocation: deliveryLocation.trim(), buyerLocation: userLocation.trim() },
      profile: { businessType, industry: industry.trim(), gstRegistered: isBusinessRole ? gstRegistered : null, gstNumber: isBusinessRole && gstRegistered ? gstNumber.trim() : '' },
      contact: { name: contactName.trim(), mobile: contactMobile.trim(), email: contactEmail.trim() },
      text: buildText(),
    };
    emit(EV.REQUIREMENT_SUBMITTED, { surface: standalone ? 'standalone' : (isMobile ? 'mobile' : 'popup'), sid: product.sid, hasQty: qtyIsMeaningful(quantity), specCount: chosenSpecs().length, loggedIn: isLoggedIn, form: 'standard' });
    if (onSubmit) onSubmit(req);
    else setSent(true); // demo fallback — no host handler
  };

  const canSubmit = contactName.trim().length > 0 && isValidIndianMobile(contactMobile); // name required + a REAL Indian mobile (not just 10 digits — audit)
  // Terminal CTA never dies silently: if the form isn't submittable, OPEN the contact card, surface a specific
  // reason, and focus the first empty required field — instead of a greyed-out button with no explanation (audit).
  const nameRef = useRef<HTMLInputElement | null>(null);
  const mobileRef = useRef<HTMLInputElement | null>(null);
  const [showContactError, setShowContactError] = useState(false);
  const handleGetQuotes = () => {
    if (canSubmit) { submit(); return; }
    setContactOpen(true);
    setShowContactError(true);
    setTimeout(() => { (contactName.trim() ? mobileRef : nameRef).current?.focus(); }, 60);
  };

  // ── Stepper (2 nodes, mirrors the Simple form) ──
  const stepper = (
    <div className="flex items-center gap-1.5 px-1">
      {STEPS.map((s, i) => {
        const active = s.key === stage;
        const done = STEPS.findIndex((x) => x.key === stage) > i;
        const clickable = done;
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && setStage(s.key as 'product' | 'details')}
              className={`flex items-center gap-1.5 ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span
                className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                  active ? 'bg-teal-600 text-white' : done ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'
                }`}
              >
                {done ? <Check size={14} /> : <s.Icon size={14} />}
              </span>
              {(active || !isMobile) && (
                <span className={`text-xs font-medium ${active ? 'text-teal-700' : done ? 'text-teal-600' : 'text-gray-400'}`}>{s.label}</span>
              )}
            </button>
            {i < STEPS.length - 1 && <span className={`w-5 sm:w-8 h-px ${done ? 'bg-teal-300' : 'bg-gray-200'}`} />}
          </div>
        );
      })}
    </div>
  );

  // ── Step 1 · Product ──
  const productStep = (
    <div className="space-y-6">
      {/* Fixed catalog identity */}
      <div className="flex gap-4 items-start">
        <div className="w-24 h-24 sm:w-28 sm:h-28 shrink-0 rounded-xl border border-gray-200 bg-white overflow-hidden flex items-center justify-center">
          {hero ? <img src={upsizeImimg(hero)} alt={product.title} onError={() => setHeroBroken(true)} className="w-full h-full object-contain p-1.5" /> : <Package className="w-8 h-8 text-gray-300" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-gray-900 text-base sm:text-lg leading-snug">{product.title}</p>
          {product.priceOnwards && (
            <p className="text-sm text-gray-500 mt-0.5">{product.priceOnwards} <span className="text-gray-400">onwards</span></p>
          )}
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-100 rounded-full px-2.5 py-1 hover:bg-teal-100"
          >
            Requesting exactly this <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {/* Quantity + Unit — moved to the TOP (owner), above the specifications */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
          <input type="text" aria-label="Quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(sanitizeQty(e.target.value))} placeholder="e.g., 500" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 animate-field-highlight" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Unit</label>
          <div className="flex flex-wrap gap-2">{UNITS.map((u) => <Chip key={u} label={u} selected={unit === u} onClick={() => setUnit(u)} />)}</div>
        </div>
      </div>

      {/* 6 fixed catalog specs — pre-selected toggles (no options; a configured SKU has one value each) */}
      <div>
        <p className="text-xs uppercase font-semibold text-gray-500 tracking-wide">Product specifications</p>
        <p className="text-xs text-gray-400 mt-0.5 mb-3">All included by default — untick any you don&apos;t need quoted.</p>
        <div className="space-y-2">
          {product.specs.map((s) => {
            const on = selectedSpecs.has(s.name);
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => toggleSpec(s.name)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                  on ? 'border-teal-300 bg-teal-50/60' : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${on ? 'bg-teal-600 border-teal-600 text-white' : 'border-gray-300 text-transparent'}`}>
                  <Check size={13} />
                </span>
                <span className="text-sm text-gray-600 flex-1 min-w-0">{s.name}</span>
                <span className="text-sm font-semibold text-gray-800 truncate">{s.value}</span>
              </button>
            );
          })}
          {/* product URL — a locked custom spec, always carried */}
          <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-teal-200 bg-teal-50/40">
            <span className="w-5 h-5 rounded-md bg-teal-600 flex items-center justify-center shrink-0 text-white"><Lock size={12} /></span>
            <span className="text-sm text-gray-600 flex-1 min-w-0">Product page <span className="text-gray-400">(custom spec)</span></span>
            <a href={product.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-teal-700 hover:underline inline-flex items-center gap-1 truncate">
              Always included <ExternalLink size={11} />
            </a>
          </div>
        </div>

        {/* buyer-added custom specs */}
        <div className="mt-3">
          {customSpecs.map((c, i) => {
            // P2-249/P3-307: a row with only ONE of name/value is silently dropped at submit. Flag it inline so
            // the buyer knows it won't be sent (instead of it vanishing without a trace).
            const halfFilled = (!!c.name.trim()) !== (!!c.value.trim());
            return (
            <div key={i} className="mb-2">
              <div className="flex items-center gap-2">
                <input aria-label={`Custom spec ${i + 1} name`} value={c.name} onChange={(e) => setCustom(i, 'name', e.target.value)} placeholder="Spec name" className={`flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${halfFilled ? 'border-amber-300' : 'border-gray-200'}`} />
                <input aria-label={`Custom spec ${i + 1} value`} value={c.value} onChange={(e) => setCustom(i, 'value', e.target.value)} placeholder="Value" className={`flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${halfFilled ? 'border-amber-300' : 'border-gray-200'}`} />
                <button type="button" onClick={() => removeCustom(i)} aria-label="Remove spec" className="w-9 h-9 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0"><Trash2 size={15} /></button>
              </div>
              {halfFilled && <p role="alert" className="text-[11px] text-amber-600 mt-1 ml-1">Add both a name and a value — this row won&apos;t be sent otherwise.</p>}
            </div>
            );
          })}
          <button type="button" onClick={addCustom} className="flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-800"><Plus size={15} /> Add custom spec</button>
        </div>
      </div>

      {/* Description — pre-filled from the catalog, editable */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
        <textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 resize-none leading-relaxed" />
      </div>
    </div>
  );

  // ── Location controls (IN SYNC with the Simple form): current-location + your/delivery + same-as. Rendered in a
  //    bottom-sheet DRAWER on mobile / anchored popover on desktop, opened from a compact row. ──
  const locationFields = (
    <>
      <button type="button" onClick={detectLocation} disabled={detectingLoc} className="w-full flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-sm font-semibold hover:bg-teal-100 disabled:opacity-60">
        {detectingLoc ? <span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" /> : <LocateFixed size={15} />} Use my current location
      </button>
      <div>
        <p className="text-[11px] uppercase font-semibold text-gray-400 tracking-wide mb-1">Your location</p>
        <div className="relative"><MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
          <input aria-label="Your location" value={userLocation} onChange={(e) => applyUserCity(e.target.value)} placeholder="Search city…" className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" /></div>
      </div>
      <div>
        <p className="text-[11px] uppercase font-semibold text-gray-400 tracking-wide mb-1">Delivery location</p>
        <div className="relative"><MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
          <input aria-label="Delivery location" value={deliveryLocation} disabled={sameAsLoc} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="Search city…" className={`w-full border rounded-lg pl-8 pr-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400 ${sameAsLoc ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed' : 'border-gray-200'}`} /></div>
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
        <input type="checkbox" checked={sameAsLoc} onChange={toggleSameAs} className="accent-teal-600 w-4 h-4" /> Delivery is same as my location
      </label>
    </>
  );
  const renderLocationDrawer = () => (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:bg-transparent" onClick={() => setLocationEditing(false)} />
      <div className="fixed inset-x-0 bottom-0 z-40 w-full rounded-t-2xl border-t border-gray-100 p-4 animate-modal-in text-left space-y-3 bg-white shadow-[0_-8px_32px_-4px_rgba(30,42,58,0.18)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-2 sm:right-0 sm:w-80 sm:max-w-[calc(100vw-3rem)] sm:rounded-xl sm:border sm:p-3 sm:shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)]" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-1 sm:hidden" />
        {locationFields}
        <button type="button" onClick={() => setLocationEditing(false)} className="w-full py-2.5 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700">Done</button>
      </div>
    </>
  );

  // ── Step 2 · Your Profile & Delivery ──
  const detailsStep = (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 p-4 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide mb-3">Delivery & Payment</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">When do you need it?</label>
            <div className="flex flex-wrap gap-2">{TIMELINES.map((t) => <Chip key={t} label={t} selected={timeline === t} onClick={() => setTimeline(timeline === t ? '' : t)} />)}</div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Payment terms</label>
            <div className="flex flex-wrap gap-2">{PAYMENTS.map((p) => <Chip key={p} label={p} selected={payment === p} onClick={() => setPayment(payment === p ? '' : p)} />)}</div>
          </div>
          {payment === 'Credit (Post-Delivery)' && (
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Credit period</label><div className="flex flex-wrap gap-2">{CREDIT_PERIODS.map((c) => <Chip key={c} label={c} selected={creditPeriod === c} onClick={() => setCreditPeriod(creditPeriod === c ? '' : c)} />)}</div></div>
          )}
          {showPaymentMode && (
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Payment mode</label><div className="flex flex-wrap gap-2">{PAYMENT_MODES.map((m) => <Chip key={m} label={m} selected={paymentMode === m} onClick={() => setPaymentMode(paymentMode === m ? '' : m)} />)}</div></div>
          )}
          <div className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Delivery location</label>
            <button type="button" onClick={() => setLocationEditing((v) => !v)} className="w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 hover:border-teal-300">
              <span className="truncate flex items-center gap-1.5"><MapPin size={13} className="text-gray-300 shrink-0" />{deliveryLocation || 'Select delivery city'}</span>
              <Pencil size={13} className="text-gray-400 shrink-0" />
            </button>
            {locationEditing && renderLocationDrawer()}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 p-4 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide mb-3">About you</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">You are a</label>
            <div className="flex flex-wrap gap-2">{BUSINESS_TYPES.map((b) => <Chip key={b} label={b} selected={businessType === b} onClick={() => setBusinessType(businessType === b ? '' : b)} />)}</div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Company / industry <span className="text-gray-400 font-normal">(optional)</span></label>
            <input aria-label="Company or industry (optional)" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g., electrical contracting" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          </div>
          {/* GST — asked only for a BUSINESS role (every type except Individual), in sync with the Simple form.
              Golden Rule: gstRegistered starts null (UNKNOWN) — never assume "No". */}
          {isBusinessRole && (
            <div className="pt-2 border-t border-gray-100">
              <label className="block text-sm font-medium text-gray-700 mb-2">GST Registered?</label>
              <div className="flex flex-wrap gap-2">
                <Chip label="Yes" selected={gstRegistered === true} onClick={() => setGstRegistered(gstRegistered === true ? null : true)} />
                <Chip label="No" selected={gstRegistered === false} onClick={() => { setGstRegistered(gstRegistered === false ? null : false); setGstNumber(''); }} />
              </div>
              {gstRegistered === true && (
                <input type="text" aria-label="GST number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15))} placeholder="GST number (15 digits)" className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 p-4 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        {/* COLLAPSIBLE contact card (in sync with the Simple form). Header toggles it; the Login button (guest) or the
            verified-name badge (logged-in) sits alongside. ⚑ DEV-TODO: wire the real IndiaMART login/OTP behind Login. */}
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setContactOpen((v) => !v)} className="flex items-center gap-2 min-w-0">
            <span className="text-xs uppercase font-semibold text-gray-400 tracking-wide">Contact details</span>
            {contactOpen ? <ChevronUp size={16} className="text-gray-400 shrink-0" /> : <ChevronDown size={16} className="text-gray-400 shrink-0" />}
          </button>
          {isLoggedIn
            ? <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 truncate"><Check size={13} className="shrink-0" /> {contactName || 'Logged in'}</span>
            : <button type="button" onClick={() => { setIsLoggedIn(true); setContactOpen(true); }} className="flex items-center gap-1 shrink-0 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg px-2.5 py-1.5"><LogIn size={13} /> Login</button>}
        </div>
        {showContactError && !canSubmit && (
          <p role="alert" className="mt-2 text-xs font-medium text-red-500">Enter your name and a valid 10-digit mobile number to get quotes.</p>
        )}
        {contactOpen && (
          <div className="space-y-3 mt-4">
            <input ref={nameRef} aria-label="Your name" autoComplete="name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400">
              <span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200">+91</span>
              <input ref={mobileRef} type="tel" aria-label="Mobile number" autoComplete="tel-national" value={contactMobile} onChange={(e) => setContactMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile" className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none" />
            </div>
            <input type="email" aria-label="Email address (optional)" autoComplete="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          </div>
        )}
      </div>
    </div>
  );

  // ── Top action bar (owner: "Next / prev on TOP" — MSite pattern) — Back + the primary CTA. Shared by ALL
  //    shells (mobile · standalone · popup) so the CTA is on top everywhere, not a bottom footer. ──
  const topBar = (
    <div className="shrink-0 flex items-center justify-between gap-2 px-5 sm:px-7 h-14 border-b border-gray-100 bg-white">
      {stage === 'details'
        ? <button type="button" onClick={() => setStage('product')} aria-label="Back" className="flex items-center gap-1.5 -ml-1 text-sm font-semibold text-gray-600 hover:text-gray-800"><ArrowLeft size={16} /> Back</button>
        : <span className="font-bold text-teal-600 text-[15px]">Get Best Price</span>}
      {stage === 'product'
        ? <button type="button" onClick={() => setStage('details')} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-teal-700">Next <ChevronRight size={15} /></button>
        : <button type="button" onClick={handleGetQuotes} aria-disabled={!canSubmit} className={`flex items-center gap-1.5 min-h-[40px] text-white text-sm font-semibold px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 ${canSubmit ? '' : 'opacity-90'}`}><MessageCircle size={15} /> Get Best Price</button>}
    </div>
  );

  // ── Exit at the BOTTOM (owner: "exit on bottom", NOT in the header) — sticky footer, all shells ──
  const exitRow = (
    <div className="shrink-0 border-t border-gray-100 py-3 text-center bg-white"><button type="button" onClick={onClose} className="text-sm text-gray-400 underline underline-offset-2 hover:text-gray-600">Exit</button></div>
  );

  // ── Scrollable step content (stepper + the current step) ──
  const stepBody = sent ? (
    <div className="flex flex-col items-center text-center gap-3 p-8">
      <span className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center"><CheckCircle2 className="w-7 h-7 text-green-600" /></span>
      <p className="text-lg font-bold text-gray-800">Requirement sent</p>
      <p className="text-sm text-gray-500 max-w-xs">
        We&apos;ve shared your requirement for <span className="font-medium text-gray-700">{product.title}</span> with verified suppliers. You&apos;ll get quotes shortly.
      </p>
      <button type="button" onClick={onClose} className="mt-2 px-6 py-2.5 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700">Done</button>
    </div>
  ) : (
    <div className="p-5 sm:p-7">
      <div className="mb-6">{stepper}</div>
      {stage === 'product' ? productStep : detailsStep}
    </div>
  );

  // Scrollable body + the subtle "more below" hint (same as the Simple form) — shared by all 3 shells.
  const scrollBody = (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{stepBody}</div>
      {showScrollHint && (
        <button type="button" aria-label="Scroll down for more" onClick={() => bodyRef.current?.scrollBy({ top: bodyRef.current.clientHeight * 0.8, behavior: 'smooth' })} className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center w-7 h-7 rounded-full bg-amber-100/90 text-amber-500 ring-1 ring-amber-200 shadow-[0_2px_8px_-1px_rgba(0,0,0,0.15)] backdrop-blur-sm animate-bounce">
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );

  // ── Shells: [top CTA bar] · [scrollable body] · [bottom Exit] — the SAME MSite pattern on every surface
  //    (mobile · standalone · popup): Next/Back on top, Exit on bottom, in sync with the Simple form. ──
  if (isMobile) {
    return (
      <div role="dialog" aria-modal="true" aria-label="Get Best Price" className={`${themeClass} fixed inset-0 z-50 bg-white flex flex-col animate-modal-in`} style={{ height: '100dvh' }}>
        {!sent && topBar}
        {scrollBody}
        {!sent && exitRow}
      </div>
    );
  }
  if (standalone) {
    return (
      <div className={`${themeClass} fixed inset-0 z-50 bg-gray-50 flex flex-col`}>
        <IndiaMartHeader firstName={isLoggedIn && contactName ? contactName.split(' ')[0] : ''} />
        <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
          <div className="w-full max-w-2xl flex flex-col bg-white overflow-hidden sm:my-6 sm:rounded-xl sm:shadow-[0_4px_12px_-2px_rgba(30,42,58,0.08)]">
            {!sent && topBar}
            {scrollBody}
            {!sent && exitRow}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6">
      <div role="dialog" aria-modal="true" aria-label="Get Best Price" className={`${themeClass} relative bg-white rounded-xl w-full max-w-2xl max-h-[calc(100dvh-3rem)] flex flex-col overflow-hidden animate-modal-in shadow-[0_12px_32px_-4px_rgba(30,42,58,0.12)]`}>
        {!sent && topBar}
        {scrollBody}
        {!sent && exitRow}
      </div>
    </div>
  );
}
