import MainApp from './MainApp';
import BuyerProfileStandalone from './components/BuyerProfileStandalone';
import OfflineDashboard from './components/OfflineDashboard';
import SimpleRFQForm from './components/SimpleRFQForm';
import { getOfflineSnapshot } from './lib/offlineSnapshot';

// ALTERNATE UI ENTRY — ?profile=<GLID> mounts the standalone TrustSEAL card fed by the INDEPENDENT bi-buyer-profile
// endpoint (v16.4 pipeline + server-side LLM tail). Gated here (App has no hooks) so MainApp's hook order is untouched.
// "The endpoint is the UI we just made" — this path renders nothing but the clean card.
export default function App() {
  // P4: a downloaded offline HTML sets window.__EMBEDDED_PULL → maybeHydrateOffline() (main.tsx) seeds it → render the
  // FULL debug dashboard from the baked-in snapshot (no live pull). Gated first so it wins over ?profile= / MainApp.
  if (getOfflineSnapshot()) return <OfflineDashboard />;
  let profileGlid = '';
  let rfqMode = '';
  let loginParam = false;
  try {
    const q = new URLSearchParams(window.location.search);
    profileGlid = q.get('profile') || '';
    rfqMode = (q.get('rfq') || '').toLowerCase();
    loginParam = q.get('login') === '1';
  } catch { /* noop */ }
  if (profileGlid) return <BuyerProfileStandalone glid={profileGlid} />;
  // Standalone full-page RFQ routes: ?rfq=simple (no category corpus) · ?rfq=category (corpus-driven, needs v51 n8n).
  // ?login=1 flips the logged-in scenario. onClose returns to the dashboard.
  if (rfqMode === 'simple' || rfqMode === 'category') {
    return <SimpleRFQForm standalone categoryMode={rfqMode === 'category' ? 'category' : 'simple'} loggedIn={loginParam} onClose={() => { window.location.href = window.location.pathname; }} />;
  }
  return <MainApp />;
}
