// ─── OFFLINE DASHBOARD (P4) — the downloaded self-contained HTML renders the FULL debug view from baked-in data ───
// main.tsx calls maybeHydrateOffline() before render → module state is seeded + window.__offlineSnapshot is set. This
// mounts the same BuyerLedgerView (fixed inset-0, full-screen); its fetch/external/LLM effects short-circuit to the
// captured data (no network, no LLM), so every band, JSON tree, expander and scroll works exactly like live.
import BuyerLedgerView from './BuyerLedgerView';
import { getOfflineSnapshot } from '../lib/offlineSnapshot';

export default function OfflineDashboard() {
  const snap = getOfflineSnapshot();
  if (!snap) return null;
  const when = String(snap.stampIso || '').slice(0, 19).replace('T', ' ');
  return <BuyerLedgerView glid={snap.glid} title={`📦 Offline snapshot · GLID ${snap.glid}${when ? ` · captured ${when}` : ''}`} onClose={() => { /* offline copy — nothing to close */ }} />;
}
