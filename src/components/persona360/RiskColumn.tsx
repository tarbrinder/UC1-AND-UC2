// Persona360 — column 3 · RISK & FRAUD (K-5). Design §5 RiskColumn + §4 status map.
// Live-mode label rule (audit §3): rating caption must read "seller-side rating
// (also-seller signal)" when sourced from risk.indiamart_seller_rating — never "buyer trust".
import type { ColumnState, Persona360Data } from '../../lib/persona360Types';
import { caution, fraudBg, fraudRule, positive } from './tokens';
import { ColumnEmpty, ColumnError, ColumnLoading, SectionTitle, StatusBadge } from './ui';

const WATCH_CHIP = 'inline-block rounded bg-amber-500 px-2.5 py-1 text-[11px] font-bold tracking-wide text-white';

function RiskScoreBlock({
  score,
  band,
  rawSign3,
  numericAvailable = true,
}: {
  score: number;
  band: string;
  rawSign3?: number | 'unknown';
  numericAvailable?: boolean;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-600">Risk score</span>
        <span className={WATCH_CHIP}>{band}</span>
      </div>
      {numericAvailable ? (
        <>
          <div className="mt-1 text-3xl font-extrabold text-gray-900">
            {score}
            <span className="text-[11px] font-normal text-gray-400"> /100</span>
          </div>
          <div className="mt-2 h-1.5 rounded bg-gray-200">
            <div className="h-1.5 rounded" style={{ width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: caution }} />
          </div>
        </>
      ) : (
        <>
          <div className="mt-1">
            <StatusBadge status="pending">score formula pending</StatusBadge>
          </div>
          {rawSign3 !== undefined && (
            <div className="mt-1 text-[10px] text-gray-500">
              Sign3 fraud-seller score: {String(rawSign3)} (raw, unbanded)
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RiskColumn({
  risk,
  state = 'ready',
  sourcesAbsent,
  onRetry,
}: {
  risk: Persona360Data['risk'];
  state?: ColumnState;
  sourcesAbsent?: string[];
  onRetry?: () => void;
}) {
  const fraudDetail = risk.fraudRead?.detail ?? '';
  const fraudParts = fraudDetail.split('ability to pay');
  return (
    <section className="bg-white p-4 dark:bg-slate-800">
      <SectionTitle>3 · RISK &amp; FRAUD</SectionTitle>
      {state === 'loading' && <ColumnLoading rows={4} />}
      {state === 'error' && <ColumnError message="Risk sources failed — see source health" onRetry={onRetry} />}
      {state === 'empty' && <ColumnEmpty message="No risk data" sourcesAbsent={sourcesAbsent} />}
      {state === 'ready' && (
        <>
          <RiskScoreBlock score={risk.score} band={risk.band} rawSign3={risk.rawSign3} />

          <div className="mb-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">SM risk</div>
              <div className="text-[15px] font-extrabold" style={{ color: positive }}>
                {risk.smRisk}
              </div>
              <div className="text-[10px] text-gray-500">{risk.smNote}</div>
            </div>
            {risk.rating && (
              <div>
                {/* seller-side rating (also-seller signal) — never "buyer trust" (audit §3) */}
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">Rating &amp; grade</div>
                <div className="text-[15px] font-extrabold text-gray-900">
                  {risk.rating.value} · {risk.rating.grade}
                </div>
                <div className="text-[10px] text-gray-500">{risk.rating.count} supplier ratings</div>
              </div>
            )}
          </div>

          <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-gray-500">Financial verification</div>
          <div className="mb-4">
            {risk.financial.map((f) => (
              <div
                key={f.label}
                className="flex items-center justify-between border-b border-gray-100 py-2 text-[11px] last:border-b-0"
              >
                <span className="text-gray-700">{f.label}</span>
                <StatusBadge status={f.status}>{f.statusText ?? f.status}</StatusBadge>
              </div>
            ))}
          </div>

          {risk.fraudRead && (
            <div
              className="rounded-r-md border-l-2 p-3"
              style={{ backgroundColor: fraudBg, borderLeftColor: fraudRule }}
            >
              <div className="text-[10px] font-bold uppercase tracking-wider text-red-700">Fraud read</div>
              <div className="mt-0.5 text-[11px] text-gray-700">
                {fraudParts.length > 1 ? (
                  <>
                    {fraudParts[0]}
                    <strong>ability to pay</strong>
                    {fraudParts.slice(1).join('ability to pay')}
                  </>
                ) : (
                  fraudDetail
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}