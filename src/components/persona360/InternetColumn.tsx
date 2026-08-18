// Persona360 — column 4 · INTERNET PROFILE (K-5). Design §5 InternetColumn.
// Live mode: completeness % = pending chip; show "N present · M absent · E errors"
// from pipeline_health counts instead (audit §6) — counts are real, percent is not.
import type { ColumnState, Persona360Data } from '../../lib/persona360Types';
import { activity } from './tokens';
import { ColumnEmpty, ColumnError, ColumnLoading, SectionTitle, StatusBadge, StatusDotRow } from './ui';

export function InternetColumn({
  internet,
  state = 'ready',
  sourcesAbsent,
  onRetry,
  mode = 'fixture',
}: {
  internet: Persona360Data['internet'];
  state?: ColumnState;
  sourcesAbsent?: string[];
  onRetry?: () => void;
  mode?: 'fixture' | 'live';
}) {
  const pctAvailable = mode === 'fixture' || internet.counts !== undefined;
  const hasCounts = internet.counts !== undefined;
  return (
    <section className="bg-white p-4 dark:bg-slate-800">
      <SectionTitle>4 · INTERNET PROFILE</SectionTitle>
      {state === 'loading' && <ColumnLoading rows={5} />}
      {state === 'error' && <ColumnError message="Internet profile sources failed — see source health" onRetry={onRetry} />}
      {state === 'empty' && <ColumnEmpty message="No internet profile data" sourcesAbsent={sourcesAbsent} />}
      {state === 'ready' && (
        <>
          <div className="mb-3 divide-y divide-gray-100">
            {internet.rows.map((r) => (
              <StatusDotRow key={r.label} label={r.label} sub={r.sub} state={r.state} />
            ))}
          </div>

          <div className="mb-4">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">Verified</div>
            <div className="flex flex-wrap gap-1">
              {internet.verifiedTags.map((t) => (
                <span
                  key={t.name}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                    t.verified ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {t.name}
                </span>
              ))}
            </div>
          </div>

          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">Profile completeness</div>
          {pctAvailable ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-semibold text-gray-900">Completeness</span>
                <span className="text-[11px] font-bold text-gray-900">{internet.completeness.pct}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-gray-200">
                <div
                  className="h-1.5 rounded"
                  style={{ width: `${Math.max(0, Math.min(100, internet.completeness.pct))}%`, backgroundColor: activity }}
                />
              </div>
              <div className="mt-1 text-[10px] text-gray-500">
                Missing: {internet.completeness.missing.join(', ')}
              </div>
            </>
          ) : (
            <>
              <div className="mt-1">
                <StatusBadge status="pending">completeness % pending</StatusBadge>
              </div>
              {hasCounts && (
                <div className="mt-1 text-[10px] text-gray-500">
                  {internet.counts!.present} present · {internet.counts!.absent} absent · {internet.counts!.errors} errors
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}