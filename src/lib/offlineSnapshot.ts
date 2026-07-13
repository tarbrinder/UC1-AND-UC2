// ─── OFFLINE SNAPSHOT (P4) — the downloaded self-contained HTML boots the SAME app from baked-in data ────────────
// The ⬇ Download button captures everything the live dashboard rendered from (rich + legacy + LLM prompts/outputs +
// extract result + prune + per-offer enrichment) into ONE snapshot, injects it as `window.__EMBEDDED_PULL` inside a
// pre-built single-file copy of the app, and downloads it. Opening that file offline: maybeHydrateOffline() seeds the
// module state + sets `__ledgerDemoRaw` (so BuyerLedgerView's fetch/external effects skip the network/paid APIs) and
// `__offlineSnapshot` (so the extract/prune/offer/uc2 effects use the CAPTURED LLM output instead of calling the LLM).
// Result: the debug view is fully interactive offline — every band, JSON tree, expand/collapse, scroll — like live.
import { seedEnrichment } from './enrichment';
import { seedLLMRaw } from './gemini';

export interface OfflineSnapshot {
  v: number;
  glid: string;
  stampIso: string;
  rich: unknown;                        // getEnrichmentRich() — the {sources} object (card + L1/L3 + extract input)
  legacy: unknown;                      // the normalized legacy shape the ledger builds from (deterministic, no network)
  serverTrace: unknown;                 // n8n E1 trace (null if absent)
  health: unknown[];                    // per-node __health (L1)
  llmRaw: Record<string, unknown>;      // getLLMRaw() — exact prompts + outputs (L4/L5)
  extractOut: unknown;                  // the extract LLM output (msynth.out) → finals/persona
  extractUsage: unknown;                // token usage/cost
  extractMs: number;
  pruneKeep: string[] | null;           // the twin-prune keep-set
  uc2Map: Record<string, unknown>;      // captured per-offer requirement enrichment (may be partial)
  observedExternal?: unknown;           // audit P1: the client-fetched Befisc/Sign3 external identity (window.__buyerTwin.observed_external) — WITHOUT this the offline copy showed fewer verified anchors than the live view
  readZoom?: number;
}

// Called at boot (main.tsx) BEFORE React renders. Returns the snapshot when this is an offline HTML, else null.
export function maybeHydrateOffline(): OfflineSnapshot | null {
  const w = window as unknown as { __EMBEDDED_PULL?: OfflineSnapshot } & Record<string, unknown>;
  const snap = w.__EMBEDDED_PULL;
  if (!snap || typeof snap !== 'object' || !snap.glid) return null;
  w.__offlineSnapshot = snap;
  w.__ledgerDemoRaw = snap.legacy;                       // fetch + external effects short-circuit → no network / paid API
  // audit P1: re-seed the captured Befisc/Sign3 external identity (GLID-keyed, so withObservedExternal accepts it) so the
  // offline copy shows the SAME verified anchors as the live view it reproduces.
  try { if (snap.observedExternal) { (w as { __buyerTwin?: Record<string, unknown> }).__buyerTwin = { ...((w as { __buyerTwin?: Record<string, unknown> }).__buyerTwin || {}), observed_external: snap.observedExternal, observed_external_glid: snap.glid }; } } catch { /* noop */ }
  try { seedEnrichment({ rich: snap.rich, raw: snap.legacy, serverTrace: (snap.serverTrace ?? null) as never, health: (Array.isArray(snap.health) ? snap.health : []) as never }); } catch { /* noop */ }
  try { seedLLMRaw((snap.llmRaw || {}) as Record<string, never>); } catch { /* noop */ }
  return snap;
}

// Read the offline snapshot from anywhere (BuyerLedgerView effects) — presence = offline mode.
export function getOfflineSnapshot(): OfflineSnapshot | null {
  return (window as unknown as { __offlineSnapshot?: OfflineSnapshot }).__offlineSnapshot || null;
}
