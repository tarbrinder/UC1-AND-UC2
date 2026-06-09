import { useState, useEffect } from 'react';
import { Zap, ShieldCheck, Clock, Layers, Mic, FileText } from 'lucide-react';
import RFQModalV3 from './components/RFQModalV3';

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

        {/* Version buttons */}
        <div className="flex flex-wrap justify-center gap-3 w-full">
          {VARIANT_BUTTONS.map((btn) => {
            const { Icon } = btn;
            return (
              <div key={btn.id} className="flex flex-col items-center gap-2">
                <button
                  onClick={() => setActiveModal(btn.id)}
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
          onClose={() => setActiveModal(null)}
          variantLabel={VARIANT_LABELS[activeModal]}
        />
      )}
    </div>
  );
}
