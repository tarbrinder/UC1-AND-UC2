// Persona360 — column 2 · SOURCING (K-5). Design §5 SourcingColumn.
import type { ColumnState, Persona360Data } from '../../lib/persona360Types';
import { navy } from './tokens';
import { ColumnEmpty, ColumnError, ColumnLoading, FieldRow, SectionTitle } from './ui';

function PriceQualitySlider({ label, position, evidence, mode = 'fixture' }: { label: string; position: number; evidence?: string; mode?: 'fixture' | 'live' }) {
  // Live mode: price-vs-quality is an LLM/audit-gap field the final-assemble payload does not
  // carry a numeric for. Never render a fabricated slider position — show a pending chip.
  if (mode === 'live') {
    return (
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-600">Price vs quality</span>
          <span className="text-[12px] text-gray-400">pending</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg,#F59E0B,#E5E7EB 45%,#2563EB)' }} />
        {evidence && <div className="mt-1 text-[10px] italic text-gray-500">{evidence}</div>}
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, position));
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-600">Price vs quality</span>
        <span className="text-[12px] font-bold" style={{ color: navy }}>
          {label}
        </span>
      </div>
      <div
        className="relative mt-2 h-1.5 rounded-full"
        style={{ background: 'linear-gradient(90deg,#F59E0B,#E5E7EB 45%,#2563EB)' }}
      >
        <span
          className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-gray-900"
          style={{ left: `calc(${pct}% - 1px)` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-gray-400">
        <span>Lowest price</span>
        <span>Premium quality</span>
      </div>
      {evidence && <div className="mt-1 text-[10px] italic text-gray-500">{evidence}</div>}
    </div>
  );
}

function CityShareBars({ cities, note, mode = 'fixture' }: { cities: Persona360Data['sourcing']['cities']; note?: string; mode?: 'fixture' | 'live' }) {
  // Live mode: share % is a formula gap (audit §5) — the workflow derives the city LIST from
  // search/browse cities but not the enquiry share split. Show names without fabricated bars.
  const left = mode === 'live' ? cities.map((c) => ({ name: c.name })) : cities;
  return (
    <div className="mb-4">
      <div className="space-y-2">
        {left.map((c) => (
          <div key={c.name} className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-gray-900">{c.name}</span>
            {mode !== 'live' && <span className="text-[11px] text-gray-600">{(c as Persona360Data['sourcing']['cities'][number]).sharePct}%</span>}
          </div>
        ))}
        {mode === 'live' && left.length === 0 && <div className="py-2 text-[11px] text-gray-400">No procurement cities</div>}
      </div>
      {note && <div className="mt-2 text-[10px] italic text-gray-400">{note}</div>}
      {mode === 'live' && left.length > 0 && (
        <div className="mt-1 text-[10px] text-gray-400">derived from search/browse cities (share split pending)</div>
      )}
    </div>
  );
}

export function SourcingColumn({
  sourcing,
  state = 'ready',
  sourcesAbsent,
  onRetry,
  mode = 'fixture',
}: {
  sourcing: Persona360Data['sourcing'];
  state?: ColumnState;
  sourcesAbsent?: string[];
  onRetry?: () => void;
  mode?: 'fixture' | 'live';
}) {
  return (
    <section className="bg-white p-4 dark:bg-slate-800">
      <SectionTitle>2 · SOURCING</SectionTitle>
      {state === 'loading' && <ColumnLoading rows={4} />}
      {state === 'error' && <ColumnError message="Sourcing sources failed — see source health" onRetry={onRetry} />}
      {state === 'empty' && <ColumnEmpty message="No sourcing data" sourcesAbsent={sourcesAbsent} />}
      {state === 'ready' && (
        <>
          <PriceQualitySlider
            label={sourcing.priceQuality.label}
            position={sourcing.priceQuality.position}
            evidence={sourcing.priceQuality.evidence}
            mode={mode}
          />

          <div className="mb-4 grid grid-cols-2 gap-3">
            <FieldRow label="Annual procurement" sub={sourcing.annualProcurement.basis}>
              <div className="text-[15px] font-extrabold text-gray-900">{sourcing.annualProcurement.display || (mode === 'live' ? '—' : '')}</div>
            </FieldRow>
            <FieldRow label="Order pattern" sub={sourcing.orderPattern.note}>
              <div className="text-[15px] font-extrabold text-gray-900">{sourcing.orderPattern.display || (mode === 'live' ? '—' : '')}</div>
            </FieldRow>
          </div>

          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">
            Procurement cities · share of enquiries
          </div>
          <CityShareBars cities={sourcing.cities} note={sourcing.deliveryNote} mode={mode} />

          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">Products of interest</div>
          <ol className="space-y-0.5">
            {sourcing.products.map((p, i) => (
              <li key={p} className={`text-[11px] ${i === 0 ? 'font-semibold' : ''} text-gray-800`}>
                <span className="mr-1 text-gray-400">{i + 1}</span>
                {p}
              </li>
            ))}
            {sourcing.products.length === 0 && mode === 'live' && <li className="text-[11px] text-gray-400">No products of interest</li>}
          </ol>
        </>
      )}
    </section>
  );
}