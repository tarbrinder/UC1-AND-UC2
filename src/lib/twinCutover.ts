// ─── P1 CUTOVER — the one switch that moves V3/V4 onto the LLM-native extract twin ──────────────────────────
// Both modals call resolveExtractTwin() in their GLID-fetch handler. When VITE_EXTRACT_PROFILE is ON, it reads the
// eagerly-built merged-twin cache (ensureMergedTwin already fired in fetchEnrichment), waits for it to settle, and
// maps the FinalAttr[] → the layered BuyerTwin/BuyerProfile via the (P0-verified) adapter. On miss/timeout it returns
// null and the caller keeps the legacy deriveBuyerProfile/deriveBuyerTwin path. Default OFF ⇒ this returns null
// immediately ⇒ the form is byte-for-byte unchanged. NOTE: mergedTwinStore guarantees `finals` on a 'done' entry
// (extract path, or its merged fallback), so a single twin authority feeds the form whether or not the rich extract
// succeeded — the only null is genuine timeout/no-key, where legacy is the safety net.

import { waitForMergedTwin } from './mergedTwinStore';
import { finalsToBuyerTwin, finalsToBuyerProfile, type TwinAdapterCtx } from './twinAdapter';
import type { BuyerTwin, BuyerProfile } from './enrichment';

export const EXTRACT_TWIN_ON = ((import.meta.env as unknown as Record<string, string | undefined>).VITE_EXTRACT_PROFILE) !== '0'; // DEFAULT ON (direct-LLM extract twin); set VITE_EXTRACT_PROFILE=0 to fall back to the legacy path. audit 2026-07-13: static per-var read (never the whole import.meta.env object → no secret leak into the bundle)

// Most-recent dated signal → drives twin freshness/last_signal_at. Parses ISO + the "25-MAY-26" form (matches deriveBuyerTwin).
export function lastSignalAt(signals?: Array<{ date?: string }>): string {
  const parse = (d: string): number => {
    if (!d) return NaN;
    const iso = Date.parse(d); if (!Number.isNaN(iso)) return iso;
    const m = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) { const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase()); if (mon >= 0) return Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon, +m[1]); }
    return NaN;
  };
  let best = '', bestT = -1;
  for (const s of signals || []) { const d = s?.date; if (!d) continue; const t = parse(d); if (!Number.isNaN(t) && t > bestT) { bestT = t; best = d; } }
  return best;
}

export async function resolveExtractTwin(glid: string, ctx: TwinAdapterCtx, timeoutMs = 30000): Promise<{ twin: BuyerTwin; profile: BuyerProfile } | null> {
  if (!EXTRACT_TWIN_ON) return null;
  const entry = await waitForMergedTwin(glid, timeoutMs);
  if (!entry || entry.status !== 'done' || !Array.isArray(entry.finals) || !entry.finals.length) return null;
  return { twin: finalsToBuyerTwin(entry.finals, ctx), profile: finalsToBuyerProfile(entry.finals, ctx) };
}
