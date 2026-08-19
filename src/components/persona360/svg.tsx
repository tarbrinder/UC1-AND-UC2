// Persona360 — hand-rolled SVGs (K-5). No chart deps (design §8): TrustRing donut +
// MonthlyBars grouped bar chart. Ring math borrows the dasharray pattern from
// src/components/ScoreBadge.tsx — but NOT its red→green ramp (see tokens.ts note).
import { caution, trustTrack } from './tokens';

/* ---------------------------------- TrustRing ------------------------------------- */
export function TrustRing({ score, max, size = 64, pending = false }: { score: number; max: number; size?: number; pending?: boolean }) {
  const stroke = 6;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const dashed = `${(pct / 100) * c} ${c}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={pending ? 'Trust score formula pending' : `Trust score ${score} of ${max}`}
    >
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trustTrack} strokeWidth={stroke} />
        {pending ? (
          /* live-mode pending ring: dashed track, no fabricated arc/number */
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={caution} strokeWidth={stroke} strokeDasharray={`2 6`} strokeLinecap="round" opacity={0.5} />
        ) : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={caution}
            strokeWidth={stroke}
            strokeDasharray={dashed}
            strokeLinecap="round"
          />
        )}
      </g>
      <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" className="fill-white text-xl font-extrabold">
        {pending ? '—' : score}
      </text>
      {!pending && (
        <text x="50%" y="70%" textAnchor="middle" dominantBaseline="middle" className="fill-slate-400" style={{ fontSize: 8 }}>
          of {max}
        </text>
      )}
    </svg>
  );
}

/* --------------------------------- MonthlyBars ------------------------------------ */
export interface MonthlyBarDatum {
  month: string;
  calls: number;
  enquiries: number;
  buyleads: number;
}

const SERIES = [
  { key: 'calls', color: '#0B2D4D' as const, label: 'Calls' },
  { key: 'enquiries', color: '#2563EB' as const, label: 'Enquiries' },
  { key: 'buyleads', color: '#F59E0B' as const, label: 'BuyLeads' },
] as const;

const W = 720;
const H = 200;
const MARGIN = { top: 10, right: 8, bottom: 24, left: 28 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const PLOT_H = H - MARGIN.top - MARGIN.bottom;

export function MonthlyBars({ data }: { data: MonthlyBarDatum[] }) {
  const maxVal = Math.max(0, ...data.flatMap((d) => [d.calls, d.enquiries, d.buyleads]));
  const yMax = Math.max(4, Math.ceil(maxVal / 4) * 4); // y axis 0/4/8/12…
  const groupW = PLOT_W / Math.max(1, data.length);
  const barW = 12;
  const barGap = 4;
  const groupInner = SERIES.length * barW + (SERIES.length - 1) * barGap;
  const x0 = (g: number) => MARGIN.left + g * groupW + (groupW - groupInner) / 2;

  const y = (v: number) => MARGIN.top + PLOT_H - (v / yMax) * PLOT_H;
  const ticks = [0, yMax / 4, (2 * yMax) / 4, (3 * yMax) / 4, yMax].map((v) => Math.round(v));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Monthly engagement March to August"
      className="h-44 w-full"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={MARGIN.left} x2={W - MARGIN.right} y1={y(t)} y2={y(t)} stroke="#D1D5DB" strokeDasharray="3 3" />
          <text x={MARGIN.left - 4} y={y(t) + 3} textAnchor="end" style={{ fontSize: 9 }} className="fill-gray-400">
            {t}
          </text>
        </g>
      ))}
      {data.map((d, g) => (
        <g key={d.month}>
          {SERIES.map((s, i) => {
            const v = d[s.key];
            const barH = (v / yMax) * PLOT_H;
            return (
              <rect
                key={s.key}
                x={x0(g) + i * (barW + barGap)}
                y={y(v)}
                width={barW}
                height={barH}
                fill={s.color}
              >
                <title>{`${s.label} ${d.month}: ${v}`}</title>
              </rect>
            );
          })}
          <text
            x={x0(g) + groupInner / 2}
            y={H - 8}
            textAnchor="middle"
            style={{ fontSize: 10, fontWeight: d.month === 'May' ? 700 : 400 }}
            className={d.month === 'May' ? 'fill-slate-900' : 'fill-gray-500'}
          >
            {d.month}
          </text>
        </g>
      ))}
    </svg>
  );
}