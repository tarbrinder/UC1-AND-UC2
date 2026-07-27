import { useEffect, useState } from 'react';
import { Search, MapPin, BadgeCheck, SlidersHorizontal, Star, Sparkles } from 'lucide-react';

// Engaging "we're matching you" experience shown on the results page WHILE the ~30s seller-search runs (owner:
// "some funny UI/UX … ah! seller found in your location … to keep the user engaged"). Because the call is fired
// back on the specs→aispecs move, most of the 30s is already spent by the time the buyer lands here, so this
// usually shows only briefly. Messages rotate; a bar creeps toward (but never reaches) 100% until real results
// swap it out. Purely cosmetic — it holds no real data, so it can never mislead.
const STEPS = [
  { Icon: Search, text: 'Scanning verified suppliers…' },
  { Icon: MapPin, text: 'Found sellers near you 📍' },
  { Icon: BadgeCheck, text: 'Ah! GST-verified suppliers spotted ✅' },
  { Icon: SlidersHorizontal, text: 'Matching against your specs…' },
  { Icon: Star, text: 'Ranking by rating & proximity ⭐' },
  { Icon: Sparkles, text: 'Curating your top matches…' },
];

export default function SellerSearchProgress({ productName }: { productName?: string }) {
  const [i, setI] = useState(0);
  const [pct, setPct] = useState(8);

  useEffect(() => {
    const msg = setInterval(() => setI((p) => (p + 1) % STEPS.length), 3200); // rotate the fun copy
    // Ease toward ~92% over ~28s and stop — the bar completes only when real results replace this block.
    const bar = setInterval(() => setPct((p) => (p >= 92 ? 92 : p + Math.max(1, Math.round((92 - p) * 0.06)))), 700);
    return () => { clearInterval(msg); clearInterval(bar); };
  }, []);

  const { Icon, text } = STEPS[i];
  return (
    <div role="status" aria-live="polite" className="rounded-2xl border border-teal-100 bg-gradient-to-b from-teal-50/70 to-white px-5 py-8 flex flex-col items-center text-center">
      <div className="relative w-14 h-14 mb-4">
        <span className="absolute inset-0 rounded-full bg-teal-200/50 animate-ping" />
        <span className="relative w-14 h-14 rounded-full bg-teal-600 text-white flex items-center justify-center shadow-sm">
          <Icon className="w-6 h-6" />
        </span>
      </div>
      <p className="text-sm font-semibold text-gray-800 min-h-[20px] transition-all">{text}</p>
      <p className="text-xs text-gray-500 mt-1">
        {productName ? <>Finding the best <span className="font-medium text-gray-700">{productName}</span> suppliers for you</> : 'Finding the best suppliers for you'}
      </p>
      <div className="w-full max-w-[240px] h-1.5 bg-teal-100 rounded-full mt-5 overflow-hidden">
        <div className="h-full bg-teal-500 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-gray-400 mt-2">Usually takes a few seconds — hang tight</p>
    </div>
  );
}
