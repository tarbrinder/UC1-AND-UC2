// ─── Standalone alternate UI (owner: "endpoint is the UI we just made") ──────────────────────────────────────────
// Open with ?profile=<GLID> → this self-fetches the INDEPENDENT bi-buyer-profile-card endpoint (v16.4 pipeline + server-side
// LLM tail), then renders BuyerProfileCard directly from the response (which carries sources + llm_profile). No client-
// side extract, no debug dashboard — the clean TrustSEAL card is the whole page. Single blocking response (owner choice),
// so it can take a few minutes; the message says so.
import { useEffect, useState } from 'react';
import { fetchBuyerProfileLLM } from '../lib/enrichment';
import BuyerProfileCard from './BuyerProfileCard';
import { fetchEnrichment, getEnrichmentRich } from '../lib/enrichment';

export default function BuyerProfileStandalone({ glid }: { glid: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'done' | 'error'; data: unknown; via: string }>({ status: 'loading', data: null, via: '' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', data: null, via: '' });
    (async () => {
      let data: unknown = null; let via = 'bi-buyer-profile-card';
      // 1) try the dedicated server-LLM endpoint (workflow B).
      try { const b = await fetchBuyerProfileLLM(glid); if (b && typeof b === 'object' && ('sources' in b || 'llm_profile' in b)) data = b; } catch { /* fall through */ }
      // 2) FALLBACK — B not imported / failed → use the LIVE main endpoint + client render. GST/Udyam/business_type
      //    still derive deterministically; only the server-LLM narrative overlay is absent. Fast tier for a quick paint.
      if (!data) {
        via = 'main pull (fallback — bi-buyer-profile-card not reachable)';
        try { await fetchEnrichment(glid, { fast: true }); const rich = getEnrichmentRich(); if (rich && typeof rich === 'object' && 'sources' in (rich as Record<string, unknown>)) data = rich; } catch { /* noop */ }
      }
      if (alive) setState({ status: data ? 'done' : 'error', data, via });
    })();
    return () => { alive = false; };
  }, [glid]);

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
        <div className="text-center">
          <div className="mx-auto w-7 h-7 border-2 border-teal-500 border-t-transparent rounded-full animate-spin mb-3" />
          <div className="font-semibold text-gray-800">Pulling buyer profile {glid}…</div>
          <div className="text-[11px] text-gray-400 mt-1">Trying the dedicated bi-buyer-profile-card endpoint, then falling back to the live main pull. Can take a few minutes.</div>
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-rose-600">
        <div className="text-center max-w-md">
          <div className="font-semibold">Couldn't load the profile for GLID {glid}.</div>
          <div className="text-[11px] text-gray-500 mt-1.5">Both the <code>bi-buyer-profile-card</code> endpoint AND the main pull returned nothing — likely the dev server / n8n isn't reachable, or the GLID has no data. (Import the <code>bi-buyer-profile-card</code> workflow to enable the server-LLM path; until then this uses the main endpoint.)</div>
          <button onClick={() => window.location.reload()} className="mt-2 text-[12px] underline text-rose-700">↻ retry</button>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-6xl mx-auto">
        {state.via.startsWith('main') && <div className="mb-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">ℹ Rendered via the main endpoint (the dedicated <code>bi-buyer-profile-card</code> workflow isn't imported/reachable) — GST/Udyam/business-type still derive; the server-LLM narrative overlay is absent.</div>}
        <BuyerProfileCard rich={state.data} glid={glid} />
      </div>
    </div>
  );
}
