import { useEffect, useState } from 'react';
import { CheckCircle2, Star, MapPin, Package } from 'lucide-react';

interface Props {
  productName: string;
  onClose: () => void;
}

const SELLERS = [
  { name: 'Sunrise Traders', rating: 4.7, reviews: 312, location: 'Mumbai', distance: '2.4 km', verified: true },
  { name: 'Global Supplies Co.', rating: 4.5, reviews: 184, location: 'Pune', distance: '8.1 km', verified: true },
  { name: 'Prime Industries', rating: 4.3, reviews: 95, location: 'Thane', distance: '12.3 km', verified: false },
];

export default function SuccessModal({ productName, onClose }: Props) {
  const [confetti, setConfetti] = useState<{ x: number; y: number; c: string }[]>([]);

  useEffect(() => {
    const items = Array.from({ length: 20 }).map(() => ({
      x: Math.random() * 100,
      y: Math.random() * 100,
      c: ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4'][Math.floor(Math.random() * 5)],
    }));
    setConfetti(items);
    setTimeout(() => setConfetti([]), 1200);
  }, []);

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden relative">
        {confetti.map((c, i) => (
          <div
            key={i}
            className="absolute w-2 h-2 rounded-sm pointer-events-none opacity-0 animate-ping"
            style={{
              left: `${c.x}%`,
              top: `${c.y}%`,
              background: c.c,
              animationDelay: `${i * 30}ms`,
              animationDuration: '0.6s',
            }}
          />
        ))}
        <div className="bg-gradient-to-br from-green-500 to-emerald-600 p-6 text-center text-white">
          <CheckCircle2 className="w-12 h-12 mx-auto mb-2" />
          <h2 className="text-xl font-bold">RFQ Submitted!</h2>
          <p className="text-green-100 text-sm mt-1">
            Matching you with verified suppliers for <strong>{productName}</strong>
          </p>
        </div>

        <div className="p-5">
          <p className="text-sm font-semibold text-gray-500 mb-3">Top Matching Suppliers</p>
          <div className="space-y-3">
            {SELLERS.map((s, i) => (
              <div
                key={i}
                className="border border-gray-100 rounded-xl p-3 flex items-center gap-3 hover:border-indigo-200 transition-all"
                style={{ animationDelay: `${i * 100 + 200}ms` }}
              >
                <div className="w-10 h-10 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-lg flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5 text-indigo-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-gray-800">{s.name}</span>
                    {s.verified && (
                      <span className="text-[10px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full font-medium border border-green-200">
                        Verified
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <div className="flex items-center gap-0.5">
                      <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                      <span className="text-xs text-gray-600">{s.rating} ({s.reviews})</span>
                    </div>
                    <span className="text-gray-300">·</span>
                    <div className="flex items-center gap-0.5 text-xs text-gray-500">
                      <MapPin className="w-3 h-3" />
                      {s.location} · {s.distance}
                    </div>
                  </div>
                </div>
                <button className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors shrink-0">
                  Enquire
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={onClose}
            className="mt-4 w-full py-2.5 text-sm font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
