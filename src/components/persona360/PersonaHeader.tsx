// Persona360 — band H: navy identity header + trust ring (K-5). Design §5 PersonaHeader.
import type { Persona360Data } from '../../lib/persona360Types';
import { caution, navy } from './tokens';
import { TrustRing } from './svg';

const SIGNAL_DOT: Record<string, string> = {
  good: 'bg-green-500',
  caution: 'bg-amber-500',
  bad: 'bg-red-500',
};

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className="text-[11px] text-white">{value}</div>
    </div>
  );
}

export function PersonaHeader({ data }: { data: Persona360Data }) {
  const { identity, trust } = data;
  const meta: { label: string; value: string }[] = [
    { label: 'AGE / GENDER', value: [identity.age, identity.gender].filter(Boolean).join(' · ') },
    { label: 'MEMBER SINCE', value: identity.memberSince ?? '—' },
    { label: 'MOBILE', value: identity.phoneMasked ?? '—' },
    { label: 'EMAIL', value: identity.emailMasked ?? '—' },
  ];
  return (
    <header style={{ backgroundColor: navy }} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-extrabold text-white">{identity.name}</h1>
          <span className="rounded border border-slate-400/60 px-1.5 text-[10px] text-slate-200">
            GLID {data.glid}
          </span>
        </div>
        {identity.badges.map((b) => (
          <span
            key={b}
            className="mt-1 inline-block rounded-sm bg-amber-500 px-2 py-0.5 text-[10px] font-bold"
            style={{ color: navy }}
          >
            {b}
          </span>
        ))}
        <p className="mt-1 text-[12px] text-slate-300">{identity.description}</p>
        <div className="mt-2 flex flex-wrap gap-6">
          {meta.map((m) => (
            <MetaPair key={m.label} label={m.label} value={m.value} />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <TrustRing score={trust.score} max={trust.max} />
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-amber-400">Trust score</div>
          <div className="text-[13px] font-bold" style={{ color: caution }}>
            {trust.recommendation}
          </div>
          <ul className="mt-1 space-y-0.5">
            {trust.signals.map((s) => (
              <li key={s.label} className="flex items-center gap-1.5 text-[11px] text-slate-200">
                <span className={`h-1.5 w-1.5 rounded-full ${SIGNAL_DOT[s.state]}`} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </header>
  );
}