// Persona360 — band 5 · ENGAGEMENT (K-5). Design §5 EngagementBand.
// Live mode: month buckets are an audit gap → EmptyState ("monthly engagement
// aggregation pending") unless frontend aggregation from dated rows is later approved;
// metric cards render only sums that exist.
import type { Persona360Data } from '../../lib/persona360Types';
import { activity, caution, navy } from './tokens';
import { MonthlyBars } from './svg';

const LEGEND = [
  { label: 'Calls', color: navy },
  { label: 'Enquiries', color: activity },
  { label: 'BuyLeads', color: caution },
];

export function EngagementBand({
  engagement,
  monthlyAvailable = true,
  mode = 'fixture',
}: {
  engagement: Persona360Data['engagement'];
  monthlyAvailable?: boolean;
  mode?: 'fixture' | 'live';
}) {
  return (
    <section className="bg-white p-4 dark:bg-slate-800">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[12px] font-bold text-gray-900">
          Engagement on IndiaMART · {engagement.windowMonths} months
        </div>
        <div className="flex items-center gap-3">
          {LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1 text-[10px] text-gray-600">
              <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: l.color }} aria-hidden="true" />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="grid grid-cols-2 gap-3">
          {engagement.metrics.map((m) => (
            <div key={m.label} className="rounded-md border border-gray-200 bg-white p-3 dark:bg-slate-900">
              <div className="text-2xl font-extrabold text-gray-900">{m.value}</div>
              <div className="text-[10px] text-gray-500">{m.label}</div>
            </div>
          ))}
        </div>

        <div className="min-w-0">
          {monthlyAvailable ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[12px] font-bold text-gray-900">Monthly demand pattern</span>
                {engagement.annotation && (
                  <span className="text-[11px] text-gray-500">— {engagement.annotation}</span>
                )}
              </div>
              <div className="mt-2">
                <MonthlyBars data={engagement.monthly} />
              </div>
            </>
          ) : (
            <div className="py-6 text-[11px] text-gray-400">
              {mode === 'live' ? 'monthly engagement aggregation pending' : 'No monthly data'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}