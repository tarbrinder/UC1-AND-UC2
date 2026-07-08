// ─── Standalone alternate UI (owner) — the PURE-BACKEND replica of the dashboard card ────────────────────────────────
// Open with ?profile=<GLID>. Fetches the INDEPENDENT bi-buyer-unified endpoint (ONE server-side LLM) and renders
// BuyerProfileCard by SIMPLE KEY-MATCH on { sources, buyer } — no client extract, no debug. FAST-ONLY (owner 2026-07-08):
// one fast pull fills the FIXED attribute set; there is no "run full" — every hit returns the same closed schema.
// (Web OSINT + Udyam are gated OFF at the fast tier; the attribute KEYS are identical regardless — the fast pull just
// grounds fewer of them when web/Udyam are absent.) Same attributes as the dashboard UC1/card — the LLM runs INSIDE n8n.
import { useEffect, useState } from 'react';
import { fetchBuyerUnified, fetchEnrichment, getEnrichmentRich } from '../lib/enrichment';
import BuyerProfileCard from './BuyerProfileCard';

export default function BuyerProfileStandalone({ glid }: { glid: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'done' | 'error'; data: unknown; via: string }>({ status: 'loading', data: null, via: '' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', data: null, via: '' });
    (async () => {
      let data: unknown = null;
      let via = 'bi-buyer-unified · fast';
      // PRIMARY — the unified server-LLM endpoint returns { sources (deterministic), buyer{} }; the card key-matches it.
      try { const b = await fetchBuyerUnified(glid, { fast: true }); if (b && typeof b === 'object' && ('sources' in b || 'buyer' in b)) data = b; } catch { /* fall through */ }
      // Last-resort fallback — keeps the demo alive if the endpoint isn't imported yet.
      if (!data) {
        via = 'main pull (fallback — bi-buyer-unified not reachable)';
        try { await fetchEnrichment(glid, { fast: true }); const rich = getEnrichmentRich(); if (rich && typeof rich === 'object' && 'sources' in (rich as Record<string, unknown>)) data = rich; } catch { /* noop */ }
      }
      if (!alive) return;
      setState(data ? { status: 'done', data, via } : { status: 'error', data: null, via });
    })();
    return () => { alive = false; };
  }, [glid]);

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
        <div className="text-center">
          <div className="mx-auto w-7 h-7 border-2 border-teal-500 border-t-transparent rounded-full animate-spin mb-3" />
          <div className="font-semibold text-gray-800">Pulling buyer profile {glid} (fast tier)…</div>
          <div className="text-[11px] text-gray-400 mt-1">bi-buyer-unified fast pull — the server LLM fills the fixed attribute set. No debug.</div>
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-rose-600">
        <div className="text-center max-w-md">
          <div className="font-semibold">Couldn't load the profile for GLID {glid}.</div>
          <div className="text-[11px] text-gray-500 mt-1.5">The <code>bi-buyer-unified</code> endpoint returned nothing and the fallback main pull was empty — likely the n8n workflow isn't imported/reachable, or the GLID has no data. Import <code>bi-buyer-unified</code> to enable this pure-API card.</div>
          <button onClick={() => window.location.reload()} className="mt-2 text-[12px] underline text-rose-700">↻ retry</button>
        </div>
      </div>
    );
  }
  const isFallback = state.via.startsWith('main');
  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="mb-2 text-[10px] text-gray-500">Rendered via <code className="text-gray-700">{state.via}</code> — pure API, no client LLM / no debug.{isFallback && ' (bi-buyer-unified unreachable → deterministic sources only)'}</div>
        <BuyerProfileCard rich={state.data} glid={glid} />
      </div>
    </div>
  );
}
