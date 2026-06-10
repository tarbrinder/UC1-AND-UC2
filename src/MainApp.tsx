import { useState, useEffect } from 'react';
import { Zap, ShieldCheck, Clock, Layers, Mic, FileText } from 'lucide-react';
import RFQModalV3 from './components/RFQModalV3';
import { isDebug } from './lib/debugFlag';

type ModalVariant = 'v1' | 'v2' | 'v3' | 'smart' | null;

const CYCLING_PRODUCTS = [
  'Industrial Pumps',
  'Steel Pipes',
  'Solar Panels',
  'Cotton Fabric',
  'Ball Bearings',
  'Electric Motors',
  'PVC Pipes',
  'LED Bulbs',
  'CNC Machines',
];

const VARIANT_BUTTONS: {
  id: ModalVariant;
  label: string;
  sublabel: string;
  desc: string;
  bg: string;
  textColor: string;
  border?: string;
  Icon: typeof Zap;
}[] = [
  {
    id: 'v1',
    label: 'Quick',
    sublabel: 'Quote',
    desc: 'Quick Quote — 2 min, no signup',
    bg: 'bg-[#2d6a4f]',
    textColor: 'text-white',
    Icon: Zap,
  },
  {
    id: 'v2',
    label: 'Quick',
    sublabel: 'Quote V2',
    desc: 'V2 — Richer specs via dual ISQ APIs',
    bg: 'bg-[#40916c]',
    textColor: 'text-white',
    Icon: Layers,
  },
  {
    id: 'v3',
    label: 'Voice',
    sublabel: 'Quote V3',
    desc: 'V3 — Voice-first, zero typing',
    bg: 'bg-[#52b788]',
    textColor: 'text-white',
    Icon: Mic,
  },
  {
    id: 'smart',
    label: 'Smart',
    sublabel: 'RFQ',
    desc: 'Smart RFQ — AI-matched, best supplier fit',
    bg: 'bg-white',
    textColor: 'text-gray-800',
    border: 'border border-gray-200',
    Icon: FileText,
  },
];

const VARIANT_LABELS: Record<NonNullable<ModalVariant>, string> = {
  v1: 'V1',
  v2: 'V2',
  v3: 'V3',
  smart: 'Smart',
};

export default function MainApp() {
  const [activeModal, setActiveModal] = useState<ModalVariant>(null);
  const [productIndex, setProductIndex] = useState(0);
  const [fadeIn, setFadeIn] = useState(true);
  // Step-0 debug staging: the GLID/Pull CTA now lives HERE (on the landing). It stages a GLID and
  // opens Smart with autoPull → the modal runs its existing pull on mount, so the product screen
  // stays clean. ?debug-gated (demo prefill). Opening any card directly = a clean cold run.
  const debug = isDebug(); // sticky within the tab — survives the dep-reopt reload that drops ?debug
  const [stagedGlid, setStagedGlid] = useState('');
  const [stagedIgnoreTwin, setStagedIgnoreTwin] = useState(false);
  const [autoPull, setAutoPull] = useState(false);
  const [stagingOnly, setStagingOnly] = useState(false); // B-step-2: open Smart in staging mode (debug panels first)
  // "Pull" → open Smart in STAGING mode (pulls + shows the pulled-data debug panels at step 0).
  // "Start RFQ →" inside the staging view flips stagingOnly off (same instance, data persists).
  const openStaged = () => { if (!stagedGlid.trim()) return; setAutoPull(true); setStagingOnly(true); setActiveModal('smart'); };

  useEffect(() => {
    const interval = setInterval(() => {
      setFadeIn(false);
      setTimeout(() => {
        setProductIndex((i) => (i + 1) % CYCLING_PRODUCTS.length);
        setFadeIn(true);
      }, 300);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f0f4f8] to-[#e8edf2] flex flex-col items-center justify-center px-4 py-16">

      <div className="flex flex-col items-center text-center max-w-xl w-full space-y-6">

        {/* Lightning bolt icon */}
        <div className="w-16 h-16 rounded-2xl bg-teal-500 shadow-lg flex items-center justify-center animate-float-gentle">
          <Zap className="w-8 h-8 text-white" />
        </div>

        {/* Headline */}
        <div className="space-y-2">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900">
            Get quotes for
          </h1>

          {/* Cycling product pill */}
          <div className="inline-flex items-center justify-center min-w-[200px]">
            <span
              className={`inline-block bg-gray-100 text-gray-700 font-semibold text-2xl sm:text-3xl px-5 py-1.5 rounded-2xl transition-opacity duration-300 ${fadeIn ? 'opacity-100' : 'opacity-0'}`}
            >
              {CYCLING_PRODUCTS[productIndex]}
            </span>
          </div>
        </div>

        {/* Subtitle */}
        <p className="text-gray-500 text-base sm:text-lg leading-relaxed max-w-sm">
          Connect with verified B2B suppliers in under 2 minutes.
          <br />
          Get competitive quotes fast.
        </p>

        {/* Trust badges */}
        <div className="flex items-center justify-center gap-6 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <ShieldCheck className="w-4 h-4 text-teal-600" />
            <span>Verified Suppliers</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <Clock className="w-4 h-4 text-teal-600" />
            <span>Quotes in 24h</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <Zap className="w-4 h-4 text-teal-600" />
            <span>AI-Matched</span>
          </div>
        </div>

        {/* Step-0 debug staging — the Buyer GLID / Pull CTA lives HERE (above the cards so it's the
            first thing in ?debug). "Pull" → staging view (pulled-data debug) → "Start RFQ →" → clean form. */}
        {debug && (
          <div className="w-full max-w-sm rounded-2xl border border-purple-200 bg-purple-50/70 p-3 text-left">
            <p className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide mb-2">🐞 Debug · Buyer GLID (demo prefill)</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={stagedGlid}
                onChange={(e) => setStagedGlid(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') openStaged(); }}
                placeholder="e.g., 268590579"
                className="flex-1 min-w-0 border border-purple-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
              />
              <button
                type="button"
                disabled={!stagedGlid.trim()}
                onClick={openStaged}
                className="px-4 rounded-xl bg-gray-800 text-white text-sm font-semibold hover:bg-gray-900 disabled:opacity-50"
              >
                Pull
              </button>
            </div>
            <label className="flex items-center gap-1.5 mt-2 text-[11px] text-purple-700 cursor-pointer select-none">
              <input type="checkbox" checked={stagedIgnoreTwin} onChange={(e) => setStagedIgnoreTwin(e.target.checked)} className="accent-purple-600" />
              🧪 Ignore Twin (cold run — skip persona/concierge)
            </label>
            <p className="text-[10px] text-purple-400 mt-1.5">Pull → inspect the pulled buyer data (Twin · Dossier · Pipeline · External · raw) → Start the clean RFQ.</p>
          </div>
        )}

        {/* Version buttons */}
        <div className="flex flex-wrap justify-center gap-3 w-full">
          {VARIANT_BUTTONS.map((btn) => {
            const { Icon } = btn;
            return (
              <div key={btn.id} className="flex flex-col items-center gap-2">
                <button
                  onClick={() => { setAutoPull(false); setStagingOnly(false); setActiveModal(btn.id); }}
                  className={`
                    w-[140px] h-[100px] rounded-2xl font-bold flex flex-col items-center justify-center gap-2
                    shadow-md hover:shadow-xl hover:-translate-y-0.5 active:scale-95 transition-all
                    ${btn.bg} ${btn.textColor} ${btn.border ?? ''}
                  `}
                >
                  <Icon size={24} />
                  <div className="text-center leading-tight">
                    <div className="text-sm font-bold">{btn.label}</div>
                    <div className="text-xs font-semibold opacity-90">{btn.sublabel}</div>
                  </div>
                </button>
                <p className="text-xs text-gray-400 text-center w-[140px] leading-snug">
                  {btn.desc}
                </p>
              </div>
            );
          })}
        </div>

      </div>

      {/* Modal */}
      {activeModal && (
        <RFQModalV3
          onClose={() => { setActiveModal(null); setAutoPull(false); setStagingOnly(false); }}
          variantLabel={VARIANT_LABELS[activeModal]}
          initialGlid={stagedGlid}
          autoPull={autoPull && activeModal === 'smart'}
          initialIgnoreTwin={stagedIgnoreTwin}
          stagingOnly={stagingOnly && activeModal === 'smart'}
          onStart={() => setStagingOnly(false)}
        />
      )}
    </div>
  );
}
