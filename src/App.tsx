import MainApp from './MainApp';
import BuyerProfileStandalone from './components/BuyerProfileStandalone';
import BrainFormGate from './components/BrainFormGate';
import DynamicRFQ from './components/rfq/DynamicRFQ';
import OfflineDashboard from './components/OfflineDashboard';
import SimpleRFQForm from './components/SimpleRFQForm';
import StandardRFQForm from './components/StandardRFQForm';
import { getStandardProduct } from './lib/standardProducts';
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
  let sidParam = '';
  try {
    const q = new URLSearchParams(window.location.search);
    profileGlid = q.get('profile') || '';
    rfqMode = (q.get('rfq') || '').toLowerCase();
    loginParam = q.get('login') === '1';
    sidParam = q.get('sid') || '';
  } catch { /* noop */ }
  if (profileGlid) return <BuyerProfileStandalone glid={profileGlid} />;
  // ?rfq=brain[&glid=] — GLID gate → PNS-speed → repost/enrich/new chooser → the seeded duplicated Simple form.
  if (rfqMode === 'brain') { const q = new URLSearchParams(window.location.search); return <BrainFormGate glid={q.get('glid') || sidParam || ''} />; }
  // ?rfq=brain2[&glid=] — the NEW Dynamic RFQ (3-LLM: Requirement Brain + Commercial + Persona). Additive; brain untouched.
  if (rfqMode === 'brain2') { const q = new URLSearchParams(window.location.search); return <DynamicRFQ glid={q.get('glid') || sidParam || ''} />; }
  // Standalone full-page RFQ routes: ?rfq=simple (no category corpus) · ?rfq=category (corpus-driven, needs v51 n8n).
  // ?login=1 flips the logged-in scenario. onClose returns to the dashboard.
  if (rfqMode === 'simple' || rfqMode === 'category') {
    return <SimpleRFQForm standalone categoryMode={rfqMode === 'category' ? 'category' : 'simple'} loggedIn={loginParam} onClose={() => { window.location.href = window.location.pathname; }} />;
  }
  // ?rfq=standard&sid=<sid> — brand-catalog "Get Best Price" for a KNOWN product (StandardRFQForm).
  // ⚑ DEV-TODO: production resolves the product from a real brand-product API by sid (the demo seeds one SKU).
  if (rfqMode === 'standard') {
    const prod = getStandardProduct(sidParam || '456523');
    if (prod) return <StandardRFQForm standalone loggedIn={loginParam} product={prod} onClose={() => { window.location.href = window.location.pathname; }} />;
    return <RouteNotFound detail={`No product found for sid "${sidParam}".`} />; // P2-248: don't fall through to the internal dashboard
  }
  // Any OTHER non-empty ?rfq value is a bad/stale link → explicit not-found, not a silent MainApp mount (P2-234).
  if (rfqMode) return <RouteNotFound detail={`"${rfqMode}" is not a valid form.`} />;
  return <MainApp />;
}

// Explicit not-found for a mistyped/stale demo deep link — replaces the silent fall-through into MainApp (GLADMIN).
function RouteNotFound({ detail }: { detail: string }) {
  return (
    <div role="alert" className="min-h-screen flex items-center justify-center p-6 bg-gray-50 text-center">
      <div className="max-w-sm">
        <p className="text-lg font-bold text-gray-800">Page not found</p>
        <p className="text-sm text-gray-500 mt-2">{detail}</p>
        <a href={window.location.pathname} className="inline-block mt-4 px-5 py-2.5 rounded-lg bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800">Go to home</a>
      </div>
    </div>
  );
}
