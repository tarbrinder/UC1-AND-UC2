import { useState, useRef, useEffect } from 'react';
import {
  ExternalLink, Plus, Trash2, CheckCircle2, MessageCircle, Package, Truck,
  Check, ArrowLeft, ChevronRight, Lock, LogIn, LocateFixed,
} from 'lucide-react';
import IndiaMartHeader from './IndiaMartHeader';
import { upsizeImimg } from '../lib/enrichment';
import { getJSON } from '../lib/api';
import { emitApiError } from '../lib/emit';
import { resolveRfqTheme, rfqThemeClass } from '../lib/theme';
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
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [detectingLoc, setDetectingLoc] = useState(false); // P2-251: GPS/IP city detection in flight
  const [businessType, setBusinessType] = useState('');
  const [industry, setIndustry] = useState('');
  // Contact starts EMPTY for a guest (P1-114: never ship a real identity to an anonymous buyer). Identity is
  // filled ONLY once the buyer is logged in — either the host mounts us authenticated (loggedIn prop, the
  // Buyer-Profile scenario) or they tap Login in the Contact card (the login scenario). Mirrors SimpleRFQForm.
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
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
  // Reset the scroll to the top on every step change (P3-314 — the new step used to open mid-scroll).
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [stage]);
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
    if (isMobile || standalone) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, standalone, onClose]);

  // P2-251: parity with the Simple form — prefill delivery location from a coarse IP lookup on mount (only if
  // the buyer hasn't typed one), and offer a "use my current location" GPS button (reverse-geocode, IP fallback).
  // ⚑ DEV-TODO: ipapi.co / bigdatacloud are the demo geo providers; swap for the production geo service.
  useEffect(() => {
    let alive = true;
    getJSON<{ city?: string }>('https://ipapi.co/json/')
      .then((d) => { if (alive && d?.city) setDeliveryLocation((v) => v || d.city!); })
      .catch((e) => emitApiError('ipapi', e));
    return () => { alive = false; };
  }, []);
  const detectLocation = () => {
    setDetectingLoc(true);
    const fallback = () => getJSON<{ city?: string }>('https://ipapi.co/json/')
      .then((d) => { if (d?.city) setDeliveryLocation(d.city); })
      .catch((e) => emitApiError('ipapi', e))
      .finally(() => setDetectingLoc(false));
    if (!('geolocation' in navigator)) { fallback(); return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const r = await getJSON<{ city?: string; locality?: string; principalSubdivision?: string }>(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const city = (r?.city || r?.locality || r?.principalSubdivision || '').trim();
          if (city) setDeliveryLocation(city);
        } catch (e) { emitApiError('reverseGeocode', e); }
        finally { setDetectingLoc(false); }
      },
      () => fallback(),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };

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
      quantity.trim() && `Quantity: ${[quantity.trim(), unit].filter(Boolean).join(' ')}`,
      description.trim() && `Details: ${description.trim()}`,
      timeline && `Delivery timeline: ${timeline}`,
      payment && `Payment terms: ${payment}`,
      deliveryLocation.trim() && `Delivery to: ${deliveryLocation.trim()}`,
      businessType && `Buyer type: ${businessType}`,
      industry.trim() && `Industry: ${industry.trim()}`,
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
      logistics: { deliveryTimeline: timeline, paymentTerms: payment, deliveryLocation: deliveryLocation.trim() },
      profile: { businessType, industry: industry.trim() },
      contact: { name: contactName.trim(), mobile: contactMobile.trim(), email: contactEmail.trim() },
      text: buildText(),
    };
    if (onSubmit) onSubmit(req);
    else setSent(true); // demo fallback — no host handler
  };

  const canSubmit = contactName.trim().length > 0 && contactMobile.trim().length >= 10; // P3-313: name is required, not just a valid mobile

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
          <input type="text" aria-label="Quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g., 500" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Delivery location</label>
            <div className="flex items-center gap-2">
              <input aria-label="Delivery location" value={deliveryLocation} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="City / PIN" className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
              <button type="button" onClick={detectLocation} disabled={detectingLoc} aria-label="Use my current location" className="shrink-0 flex items-center gap-1.5 px-3 h-[44px] rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-xs font-semibold hover:bg-teal-100 disabled:opacity-60">
                {detectingLoc ? <span className="w-4 h-4 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" /> : <LocateFixed size={14} />}<span className="hidden sm:inline">Detect</span>
              </button>
            </div>
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
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 p-4 shadow-[0_1px_3px_0_rgba(30,42,58,0.06)]">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs uppercase font-semibold text-gray-400 tracking-wide">Contact details</p>
          {/* Login scenario (guest only): flips isLoggedIn → applyLoggedInDefaults prefills the buyer's identity.
              ⚑ DEV-TODO: wire the real IndiaMART login/OTP here (today it just seeds the demo identity). */}
          {isLoggedIn
            ? <span className="flex items-center gap-1.5 text-xs font-medium text-green-600"><Check size={13} /> {contactName || 'Logged in'}</span>
            : <button type="button" onClick={() => setIsLoggedIn(true)} className="flex items-center gap-1 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg px-2.5 py-1.5"><LogIn size={13} /> Login</button>}
        </div>
        <div className="space-y-3">
          <input aria-label="Your name" autoComplete="name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-teal-400 focus-within:border-teal-400">
            <span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200">+91</span>
            <input type="tel" aria-label="Mobile number" autoComplete="tel-national" value={contactMobile} onChange={(e) => setContactMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile" className="flex-1 px-3 py-2.5 text-base sm:text-sm outline-none" />
          </div>
          <input type="email" aria-label="Email address (optional)" autoComplete="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email (optional)" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400" />
        </div>
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
        : <button type="button" onClick={submit} disabled={!canSubmit} className={`flex items-center gap-1.5 text-white text-sm font-semibold px-4 py-2 rounded-lg ${canSubmit ? 'bg-teal-600 hover:bg-teal-700' : 'bg-gray-300 cursor-not-allowed'}`}><MessageCircle size={15} /> Get Best Price</button>}
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

  // ── Shells: [top CTA bar] · [scrollable body] · [bottom Exit] — the SAME MSite pattern on every surface
  //    (mobile · standalone · popup): Next/Back on top, Exit on bottom, in sync with the Simple form. ──
  if (isMobile) {
    return (
      <div role="dialog" aria-modal="true" aria-label="Get Best Price" className={`${themeClass} fixed inset-0 z-50 bg-white flex flex-col animate-modal-in`} style={{ height: '100dvh' }}>
        {!sent && topBar}
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{stepBody}</div>
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
            <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{stepBody}</div>
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
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{stepBody}</div>
        {!sent && exitRow}
      </div>
    </div>
  );
}
