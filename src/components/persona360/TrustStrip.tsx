// Persona360 — band 0: operator/debug trust strip (K-5). Fixture/debug only:
// in live mode render Pending unless product defines a formula (design §5 TrustStrip).
// Non-interactive (aria-hidden, not an input).

export function TrustStrip({ score, max, mode = 'fixture' }: { score: number; max: number; mode?: 'fixture' | 'live' }) {
  if (mode === 'live') {
    return (
      <div className="flex h-8 items-center bg-white px-4 text-[10px] text-gray-400" aria-hidden="true">
        trustScore · <span className="ml-1 border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-600">formula pending</span>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  return (
    <div className="flex h-8 items-center gap-2 bg-white px-4" aria-hidden="true">
      <span className="text-[10px] text-gray-400">trustScore</span>
      <span className="relative block h-0.5 w-[90px] bg-gray-200">
        <span
          className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-gray-500"
          style={{ left: `${pct}%` }}
        />
      </span>
      <span className="text-[10px] text-gray-500">
        {score} / {max}
      </span>
    </div>
  );
}