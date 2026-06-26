// ─── L1–L7 BAND SHELL (P5) — the reusable primitives the Ledger's "no black box" L1→L7 stack is built from ─────
// One <Band> = one numbered, collapsible layer (L1 nodes → L7 requirement) with a tone, a one-glance status, and a
// body that drills "to the last raw line". The band components (ledgerBands.tsx) compose these; BuyerLedgerView's
// 📋 Ledger tab wires real in-closure data + the existing deep-drill renderers into their slots. Pure/presentational
// — no app imports, no closure deps — so the split is genuine and the pieces are independently testable.

import { type ReactNode } from 'react';

export type BandTone = 'slate' | 'sky' | 'violet' | 'indigo' | 'emerald' | 'amber' | 'teal' | 'rose';

const TONE: Record<BandTone, { chip: string; ring: string; bar: string; text: string }> = {
  slate: { chip: 'bg-slate-100 text-slate-700 border-slate-200', ring: 'border-slate-200', bar: 'bg-slate-400', text: 'text-slate-700' },
  sky: { chip: 'bg-sky-100 text-sky-700 border-sky-200', ring: 'border-sky-200', bar: 'bg-sky-400', text: 'text-sky-700' },
  violet: { chip: 'bg-violet-100 text-violet-700 border-violet-200', ring: 'border-violet-200', bar: 'bg-violet-400', text: 'text-violet-700' },
  indigo: { chip: 'bg-indigo-100 text-indigo-700 border-indigo-200', ring: 'border-indigo-200', bar: 'bg-indigo-400', text: 'text-indigo-700' },
  emerald: { chip: 'bg-emerald-100 text-emerald-700 border-emerald-200', ring: 'border-emerald-200', bar: 'bg-emerald-400', text: 'text-emerald-700' },
  amber: { chip: 'bg-amber-100 text-amber-700 border-amber-200', ring: 'border-amber-200', bar: 'bg-amber-400', text: 'text-amber-700' },
  teal: { chip: 'bg-teal-100 text-teal-700 border-teal-200', ring: 'border-teal-200', bar: 'bg-teal-400', text: 'text-teal-700' },
  rose: { chip: 'bg-rose-100 text-rose-700 border-rose-200', ring: 'border-rose-200', bar: 'bg-rose-400', text: 'text-rose-700' },
};

// The numbered band shell. `code` = "L1"…"L7"/"UC3"; `status` = a one-glance health/count chip; `meta` = small note.
export function Band({ code, title, subtitle, tone = 'slate', status, statusTone, meta, defaultOpen = false, children }: {
  code: string; title: string; subtitle?: string; tone?: BandTone;
  status?: ReactNode; statusTone?: BandTone; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const t = TONE[tone];
  const st = statusTone ? TONE[statusTone] : t;
  return (
    <details open={defaultOpen} className={`group rounded-xl border ${t.ring} bg-white overflow-hidden`}>
      <summary className="cursor-pointer list-none select-none flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50/70">
        <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${t.chip} font-mono`}>{code}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold text-gray-800 truncate">{title}</span>
          {subtitle && <span className="block text-[10.5px] text-gray-400 truncate">{subtitle}</span>}
        </span>
        {status != null && <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border ${st.chip}`}>{status}</span>}
        <span className="shrink-0 text-gray-300 group-open:rotate-90 transition-transform text-[11px]">▶</span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-gray-100">
        {meta && <div className="text-[10.5px] text-gray-400 mb-2">{meta}</div>}
        {children}
      </div>
    </details>
  );
}

// a labelled key→value row (the readable atom L2/L3/L6 are full of)
export function KV({ k, v, mono, tone }: { k: ReactNode; v: ReactNode; mono?: boolean; tone?: 'muted' | 'strong' }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11.5px] py-0.5">
      <span className="text-gray-400 shrink-0">{k}</span>
      <span className={`text-right break-words min-w-0 ${mono ? 'font-mono text-[10.5px]' : ''} ${tone === 'muted' ? 'text-gray-400' : tone === 'strong' ? 'text-gray-900 font-semibold' : 'text-gray-700'}`}>{v}</span>
    </div>
  );
}

// the Confirmed/Likely/Conflicted/Unknown pill (shared with the 3-brain registry states)
export function StatePill({ state }: { state: string }) {
  const tone: Record<string, string> = { Confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200', Likely: 'bg-amber-50 text-amber-700 border-amber-200', Conflicted: 'bg-rose-50 text-rose-700 border-rose-200', Unknown: 'bg-gray-50 text-gray-500 border-gray-200', Fresh: 'bg-emerald-50 text-emerald-700 border-emerald-200', Moderate: 'bg-amber-50 text-amber-700 border-amber-200', Stale: 'bg-gray-50 text-gray-500 border-gray-200' };
  return <span className={`text-[9.5px] px-1 py-0.5 rounded border ${tone[state] || tone.Unknown}`}>{state}</span>;
}

export function MiniBar({ pct, tone = 'teal' }: { pct: number; tone?: BandTone }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return <span className="inline-block w-14 h-1.5 rounded-full bg-gray-100 align-middle overflow-hidden"><span className={`block h-full rounded-full ${TONE[tone].bar}`} style={{ width: `${p}%` }} /></span>;
}

// the "expand to the last raw line" disclosure — the recurring affordance behind every deduction
export function Expand({ label, tone = 'indigo', children, defaultOpen = false }: { label: ReactNode; tone?: BandTone; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group/exp mt-1">
      <summary className={`cursor-pointer list-none text-[10.5px] ${TONE[tone].text} hover:underline select-none`}>＋ {label}</summary>
      <div className="mt-1 rounded-lg bg-gray-50 border border-gray-200 p-2 text-[11px] text-gray-700 whitespace-pre-wrap break-words">{children}</div>
    </details>
  );
}

// a raw source line — the literal floor of the drill (node · value)
export function RawLine({ node, value, hot }: { node?: string; value: string; hot?: boolean }) {
  return (
    <div className={`text-[10.5px] flex items-start gap-1.5 rounded px-1 -mx-1 ${hot ? 'bg-amber-100 ring-1 ring-amber-300' : ''}`}>
      {node && <span className="text-gray-400 shrink-0 font-mono">{node}</span>}
      <span className="flex-1 min-w-0 text-gray-700 break-words">{value}</span>
    </div>
  );
}

// an empty-state line used when a band has no data yet (honest, not blank)
export function BandEmpty({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-gray-400 italic py-1">{children}</div>;
}
