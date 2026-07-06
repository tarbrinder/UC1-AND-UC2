import MainApp from './MainApp';
import BuyerProfileStandalone from './components/BuyerProfileStandalone';
import OfflineDashboard from './components/OfflineDashboard';
import { getOfflineSnapshot } from './lib/offlineSnapshot';

// ALTERNATE UI ENTRY — ?profile=<GLID> mounts the standalone TrustSEAL card fed by the INDEPENDENT bi-buyer-profile
// endpoint (v16.4 pipeline + server-side LLM tail). Gated here (App has no hooks) so MainApp's hook order is untouched.
// "The endpoint is the UI we just made" — this path renders nothing but the clean card.
export default function App() {
  // P4: a downloaded offline HTML sets window.__EMBEDDED_PULL → maybeHydrateOffline() (main.tsx) seeds it → render the
  // FULL debug dashboard from the baked-in snapshot (no live pull). Gated first so it wins over ?profile= / MainApp.
  if (getOfflineSnapshot()) return <OfflineDashboard />;
  let profileGlid = '';
  try { profileGlid = new URLSearchParams(window.location.search).get('profile') || ''; } catch { /* noop */ }
  if (profileGlid) return <BuyerProfileStandalone glid={profileGlid} />;
  return <MainApp />;
}
