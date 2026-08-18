// Persona360 — shared atoms (K-5). SectionTitle, FieldRow, StatusBadge, StatusDotRow,
// Hairline + per-column state placeholders. All styling keyed on the VerifyStatus union —
// no free-string status styling anywhere (design §0.4).
import type { ReactNode } from 'react';
import type { SignalState, VerifyStatus } from '../../lib/persona360Types';

/* ---------------------------------- SectionTitle ---------------------------------- */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-gray-700">
      {children}
    </div>
  );
}

/* ----------------------------------- FieldRow ------------------------------------- */
export function FieldRow({
  label,
  sub,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-gray-100 py-2 last:border-b-0">
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      {children != null && <div className="mt-0.5">{children}</div>}
      {sub != null && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

/* ---------------------------------- StatusBadge ----------------------------------- */
const BADGE_CLASSES: Record<VerifyStatus, string> = {
  verified: 'bg-green-600 text-white',
  active: 'bg-green-600 text-white',
  not_registered: 'bg-red-600 text-white',
  no_match: 'bg-orange-500 text-white',
  no_presence: 'bg-red-600 text-white',
  notified: 'bg-red-600 text-white',
  no_bounce: 'bg-green-600 text-white',
  unrated: 'bg-gray-200 text-gray-600',
  missing: 'bg-gray-200 text-gray-500',
  pending: 'border border-amber-400 bg-amber-50 text-amber-600',
  not_checked: 'bg-gray-100 text-gray-600',
};

export function StatusBadge({ status, children }: { status: VerifyStatus; children?: ReactNode }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${BADGE_CLASSES[status]}`}>
      {children ?? status}
    </span>
  );
}

/* ---------------------------------- StatusDotRow ---------------------------------- */
const DOT_COLORS: Record<SignalState, string> = {
  good: 'bg-green-600',
  caution: 'bg-amber-500',
  bad: 'bg-red-600',
};

export function StatusDotRow({ label, sub, state }: { label: string; sub?: string; state: SignalState }) {
  return (
    <div className="flex items-start gap-2 py-2">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_COLORS[state]}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-gray-900">{label}</div>
        {sub != null && <div className="text-[10px] text-gray-500">{sub}</div>}
      </div>
    </div>
  );
}

/* ----------------------------------- Hairline ------------------------------------- */
export function Hairline({ className = '' }: { className?: string }) {
  return <div className={`border-t border-gray-200 ${className}`} aria-hidden="true" />;
}

/* --------------------------- Column state placeholders ----------------------------- */
export function ColumnLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-gray-100" />
      ))}
    </div>
  );
}

export function ColumnError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="py-3 text-[11px] text-red-600">
      {message ?? 'Sources failed — see source health'}
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 underline">
          retry
        </button>
      )}
    </div>
  );
}

export function ColumnEmpty({ sourcesAbsent, message = 'No data' }: { sourcesAbsent?: string[]; message?: string }) {
  return (
    <div className="py-3 text-[11px] text-gray-400">
      {message}
      {sourcesAbsent && sourcesAbsent.length > 0 && (
        <span className="text-gray-300"> — absent: {sourcesAbsent.join(', ')}</span>
      )}
    </div>
  );
}