import { useState } from 'react';
import { CheckCircle2, Circle, ChevronDown } from 'lucide-react';
import { lerpColor, getScoreLabel, getScoreColor } from '../utils/score';

interface CheckItem {
  label: string;
  pts: number;
  done: boolean;
}

interface Props {
  score: number;
  checks: Array<CheckItem>;
}

function getRingColor(score: number): string {
  // Interpolate: red→orange→yellow→blue→green across 0–100
  const stops = [
    { at: 0,   hex: '#ef4444' }, // red
    { at: 30,  hex: '#f97316' }, // orange
    { at: 50,  hex: '#eab308' }, // yellow
    { at: 70,  hex: '#3b82f6' }, // blue
    { at: 100, hex: '#22c55e' }, // green
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (score >= a.at && score <= b.at) {
      const t = (score - a.at) / (b.at - a.at);
      return lerpColor(a.hex, b.hex, t);
    }
  }
  return getScoreColor(score);
}

export default function ScoreBadge({ score, checks }: Props) {
  const [open, setOpen] = useState(false);

  const ringColor = getRingColor(score);
  const label = getScoreLabel(score);
  const textColor = getScoreColor(score);

  // SVG ring: r=14, circumference ≈ 87.96
  const CIRC = 2 * Math.PI * 14; // 87.96
  const filled = (score / 100) * CIRC;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all select-none"
      >
        {/* Circular ring */}
        <div className="relative w-8 h-8 shrink-0">
          <svg viewBox="0 0 36 36" className="w-8 h-8 -rotate-90">
            <circle
              cx="18" cy="18" r="14"
              fill="none" stroke="#e5e7eb" strokeWidth="3"
            />
            <circle
              cx="18" cy="18" r="14"
              fill="none"
              stroke={ringColor}
              strokeWidth="3"
              strokeDasharray={`${filled} ${CIRC}`}
              strokeLinecap="round"
              style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.6s ease' }}
            />
          </svg>
          {/* Score number — counter-rotate so it reads upright */}
          <span
            className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-gray-700"
            style={{ transform: 'rotate(0deg)' }}
          >
            {score}
          </span>
        </div>

        <span className="text-sm font-semibold" style={{ color: textColor }}>
          {label}
        </span>

        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-100 p-4 z-50">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            RFQ Strength
          </p>

          <div className="space-y-2 mb-3">
            {checks.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                {item.done
                  ? <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
                  : <Circle className="w-4 h-4 text-gray-300 shrink-0" />
                }
                <span className={`text-sm flex-1 ${item.done ? 'text-gray-700' : 'text-gray-400'}`}>
                  {item.label}
                </span>
                <span className={`text-xs font-medium ${item.done ? 'text-teal-600' : 'text-gray-300'}`}>
                  +{item.pts}
                </span>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${score}%`, backgroundColor: ringColor }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
