import { CheckCircle2, Package, Star, MapPin, X } from 'lucide-react';

interface Props {
  productName: string;
  rfqScore: number;
  onClose: () => void;
}

interface Supplier {
  name: string;
  rating: number;
  reviews: number;
  city: string;
  distance: string;
  verified: boolean;
  responseTime: string;
}

const SUPPLIERS: Supplier[] = [
  {
    name: 'Sunrise Industries',
    rating: 4.8,
    reviews: 512,
    city: 'Mumbai',
    distance: '2.3 km',
    verified: true,
    responseTime: '2h',
  },
  {
    name: 'Global Trade Co',
    rating: 4.6,
    reviews: 287,
    city: 'Pune',
    distance: '8.1 km',
    verified: true,
    responseTime: '4h',
  },
  {
    name: 'Prime Suppliers Ltd',
    rating: 4.4,
    reviews: 124,
    city: 'Thane',
    distance: '14.2 km',
    verified: false,
    responseTime: '1 day',
  },
];

const CONFETTI_COLORS = [
  'bg-teal-400', 'bg-yellow-400', 'bg-pink-400', 'bg-indigo-400',
  'bg-orange-400', 'bg-green-400', 'bg-blue-400', 'bg-red-400',
];

function ConfettiBurst() {
  const pieces = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    top: `${Math.random() * 100}%`,
    left: `${Math.random() * 100}%`,
    rotate: `${Math.floor(Math.random() * 360)}deg`,
    size: Math.random() > 0.5 ? 'w-2 h-2' : 'w-1.5 h-1.5',
  }));

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
      {pieces.map(p => (
        <div
          key={p.id}
          className={`absolute ${p.size} ${p.color} animate-confetti-burst opacity-80`}
          style={{ top: p.top, left: p.left, transform: `rotate(${p.rotate})` }}
        />
      ))}
    </div>
  );
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star
          key={n}
          className={`w-3 h-3 ${n <= Math.round(rating) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-200 fill-gray-200'}`}
        />
      ))}
    </div>
  );
}

export default function SellerResultsModal({ productName, rfqScore, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl animate-modal-in overflow-hidden">
        <ConfettiBurst />

        {/* Header */}
        <div className="bg-gradient-to-br from-teal-500 to-teal-700 px-5 pt-8 pb-6 text-white text-center relative">
          <div className="flex justify-center mb-3">
            <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-white" />
            </div>
          </div>
          <h2 className="text-xl font-bold">RFQ Submitted!</h2>
          <p className="text-teal-100 text-sm mt-1">
            Your enquiry for <span className="font-semibold text-white">{productName}</span> is live
          </p>
          <div className="mt-3 inline-flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1">
            <Star className="w-3.5 h-3.5 text-yellow-300 fill-yellow-300" />
            <span className="text-sm font-semibold">RFQ Score: {rfqScore}/100</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 text-white/70 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Suppliers */}
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Top Matching Suppliers
          </p>

          <div className="space-y-3">
            {SUPPLIERS.map(s => (
              <div
                key={s.name}
                className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 bg-gray-50 hover:bg-teal-50 hover:border-teal-100 transition"
              >
                <div className="w-10 h-10 bg-teal-100 rounded-xl flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5 text-teal-600" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-gray-800 truncate">{s.name}</span>
                    {s.verified && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200 shrink-0">
                        ✓ Verified
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <StarRating rating={s.rating} />
                    <span className="text-[11px] text-gray-500">{s.rating} ({s.reviews})</span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <MapPin className="w-3 h-3 text-gray-400" />
                    <span className="text-[11px] text-gray-500">{s.city} · {s.distance}</span>
                    <span className="text-[11px] text-gray-400 ml-1">Responds in {s.responseTime}</span>
                  </div>
                </div>

                <button
                  type="button"
                  className="shrink-0 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-lg transition"
                >
                  Send Enquiry
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 text-center">
            <button
              type="button"
              className="text-sm font-semibold text-teal-600 hover:text-teal-700 transition"
            >
              View All Suppliers →
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-5">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
