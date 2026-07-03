import MainApp from './MainApp';
import BuyerProfileStandalone from './components/BuyerProfileStandalone';

// ALTERNATE UI ENTRY — ?profile=<GLID> mounts the standalone TrustSEAL card fed by the INDEPENDENT bi-buyer-profile
// endpoint (v16.4 pipeline + server-side LLM tail). Gated here (App has no hooks) so MainApp's hook order is untouched.
// "The endpoint is the UI we just made" — this path renders nothing but the clean card.
export default function App() {
  let profileGlid = '';
  try { profileGlid = new URLSearchParams(window.location.search).get('profile') || ''; } catch { /* noop */ }
  if (profileGlid) return <BuyerProfileStandalone glid={profileGlid} />;
  return <MainApp />;
}
