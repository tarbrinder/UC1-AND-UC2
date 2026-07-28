// ─── Brain Form Gate ─────────────────────────────────────────────────────────
// The real entry the plan described: take GLID → pick PNS speed (API-only fast vs
// full transcripts) → fetch the Requirement Brain → choose repost / enrich / new →
// drop into the DUPLICATED Simple form, pre-seeded by the Form Adapter. Debug throughout.
import { useEffect, useRef, useState } from 'react';
import IndiaMartHeader from './IndiaMartHeader';
import BrainRFQForm from './BrainRFQForm';
import BrainDebugPanel from './BrainDebugPanel';
import { fetchRequirementBrain, fetchBuyerBrainRecommendations, fixture, fixtureGlids, type Recommendation, type RequirementBrainPayload } from '../lib/brains/requirementBrain';
import { brainToSeed, recommendationToSeed, blankSeed, type BrainSeed } from '../lib/brains/formAdapter';
import { USE_CASES } from '../lib/brains/useCaseGlids';
import { fetchProductSuggestions } from '../utils/productNames';
import { fetchProductImages } from '../lib/enrichment';

type Phase = 'glid' | 'choose' | 'form';
const ACTION_LABEL: Record<string, string> = { enrich: 'Enrich', repost: 'Re-post', new: 'Source' };
const ACTION_TONE: Record<string, string> = { enrich: 'bg-teal-100 text-teal-800', repost: 'bg-amber-100 text-amber-800', new: 'bg-gray-100 text-gray-600' };

export default function BrainFormGate({ glid: initialGlid }: { glid: string }) {
  const [phase, setPhase] = useState<Phase>(initialGlid ? 'choose' : 'glid');
  const [glid, setGlid] = useState(initialGlid || fixtureGlids[0]);
  const [pns, setPns] = useState<'api' | 'full'>('api');
  const [payload, setPayload] = useState<RequirementBrainPayload | null>(() => (initialGlid ? fixture(initialGlid) : null));
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [seed, setSeed] = useState<BrainSeed | null>(null);
  const [debug, setDebug] = useState(false);
  const [productInput, setProductInput] = useState('');
  // THE surface defaults to the one that matches the actual screen. This was hardcoded to 'mobile', so every
  // desktop visitor landed on the 390px phone column and never saw the desktop landing at all unless they
  // clicked the demo switcher — which is why it kept looking unbuilt. The switcher stays for demoing.
  const [mode, setMode] = useState<'mobile' | 'popup' | 'standalone'>(
    // 768 = the `md` breakpoint the desktop landing's own grid is built around (sm:2-col / lg:3-col).
    () => (typeof window !== 'undefined' && window.innerWidth >= 768 ? 'standalone' : 'mobile'),
  );
  const [showAllReqs, setShowAllReqs] = useState(false);   // desktop landing: "+N more" on the requirement grid
  // LEFT PANEL (owner-locked): blank until we know a product, then 3-4 representative images fetched for
  // the entered/picked name. Deliberately NOT fetched for mcats where quantity isn't a real concept — those
  // buyers skip the landing page entirely, so the images would never be seen.
  const [heroImgs, setHeroImgs] = useState<string[]>([]);
  const imgTok = useRef(0);
  const loadHeroImgs = (name: string, mcat?: string) => {
    const q = String(name || '').trim();
    if (q.length < 3) { setHeroImgs([]); return; }
    const tok = ++imgTok.current;
    fetchProductImages(q, mcat).then((r) => { if (imgTok.current === tok) setHeroImgs(r.slice(0, 4)); })
      .catch(() => { if (imgTok.current === tok) setHeroImgs([]); });
  };
  const [apiSuggest, setApiSuggest] = useState<string[]>([]);   // IndiaMART catalogue suggest (debounced)
  const sugTok = useRef(0);
  const pickedRef = useRef('');   // a just-picked label must not immediately re-open its own dropdown
  useEffect(() => {
    const q = productInput.trim();
    if (q.length < 2) { setApiSuggest([]); return; }
    if (q === pickedRef.current) return;   // he chose this one — don't re-suggest it back at him
    const tok = ++sugTok.current;
    const t = setTimeout(() => {
      fetchProductSuggestions(q)
        .then((r) => { if (sugTok.current === tok) setApiSuggest(r); })   // drop a stale query's results
        .catch(() => { if (sugTok.current === tok) setApiSuggest([]); });
    }, 220);
    return () => clearTimeout(t);
  }, [productInput]);

  const load = (g: string) => {
    setGlid(g); setLoading(true); setLive(false);
    setPayload(fixture(g)); // instant real-engine fixture while live runs
    setPhase('choose');
    fetchRequirementBrain(g, { pns })
      .then(async (p) => {
        // If the nested chain came back blank for a heavy buyer, fall back to buyer-brain direct.
        if (!p.metadata.primary && p.decisions.length === 0 && !(p.metadata.recommendations?.length)) {
          const fb = await fetchBuyerBrainRecommendations(g);
          if (fb) { setPayload(fb); setLive(true); return; }
        }
        setPayload(p); setLive(true);
      })
      .catch(() => { /* keep fixture */ })
      .finally(() => setLoading(false));
  };

  // Direct ?glid= link (no fixture) → fetch on mount so the chooser has data.
  const mountFetched = useRef(false);
  useEffect(() => {
    if (initialGlid && !mountFetched.current && !live && !loading) { mountFetched.current = true; load(initialGlid); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recommendations, with a v1 fallback: if the engine didn't emit `recommendations`
  // (live v1), synthesize from primary + project so the chooser still shows repost/enrich/new.
  const meta = payload?.metadata;
  const recs: Recommendation[] = (meta?.recommendations?.length ? meta.recommendations
    : meta?.primary ? [
        { product: meta.primary.product, mcat: meta.primary.mcat, status: meta.primary.status, age_days: meta.primary.age_days,
          is_expired: /expired/i.test(meta.primary.status ?? ''),
          action: /approv|pending|open/i.test(meta.primary.status ?? '') ? 'enrich' : 'repost' },
        ...((meta.project?.items ?? []).map((p): Recommendation => ({ product: p, action: 'new' }))),
      ]
    : []) as Recommendation[];

  // ── Phase 1: take the GLID + pick PNS speed ──
  if (phase === 'glid') {
    return (
      <div className="flex h-screen flex-col bg-gray-50">
        <IndiaMartHeader onExit={() => { window.location.href = window.location.pathname; }} />
        <div className="mx-auto mt-10 w-full max-w-sm px-5">
          <h1 className="text-lg font-semibold text-gray-900">Post a Requirement</h1>
          <p className="mt-1 text-[13px] text-gray-500">Enter a buyer GLID — we'll draft their requirement from their history.</p>
          <input autoFocus value={glid} onChange={(e) => setGlid(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && glid) load(glid); }}
            placeholder="Buyer GLID" className="mt-4 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base" />
          <p className="mt-4 text-[12px] font-medium text-gray-600">Call insights (speed vs depth)</p>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <button onClick={() => setPns('api')} className={`rounded-lg border px-3 py-2 text-left ${pns === 'api' ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
              <div className="text-[13px] font-semibold text-gray-900">API only ⚡</div>
              <div className="text-[11px] text-gray-500">Fast — pre-computed insights</div>
            </button>
            <button onClick={() => setPns('full')} className={`rounded-lg border px-3 py-2 text-left ${pns === 'full' ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
              <div className="text-[13px] font-semibold text-gray-900">API + VANI + PNS</div>
              <div className="text-[11px] text-gray-500">Full — transcribes calls (slower)</div>
            </button>
          </div>
          <p className="mt-4 text-[12px] font-medium text-gray-600">Surface</p>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {([['mobile', 'Mobile', '375px'], ['popup', 'Desktop popup', 'modal'], ['standalone', 'Standalone', 'full page']] as const).map(([k, label, sub]) => (
              <button key={k} onClick={() => setMode(k)} className={`rounded-lg border px-2 py-2 text-center ${mode === k ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
                <div className="text-[12px] font-semibold text-gray-900">{label}</div>
                <div className="text-[10px] text-gray-500">{sub}</div>
              </button>
            ))}
          </div>
          <button disabled={!glid} onClick={() => load(glid)} className="mt-5 w-full rounded-lg bg-teal-700 py-3 text-sm font-semibold text-white disabled:bg-gray-200 disabled:text-gray-400">Draft requirement →</button>
          <p className="mt-5 text-[12px] font-medium text-gray-600">Or try a scenario</p>
          <div className="mt-1.5 grid grid-cols-1 gap-1.5">
            {USE_CASES.map((u) => (
              <button key={u.label} onClick={() => { setGlid(u.glid); load(u.glid); }} className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 text-left hover:border-teal-300">
                <span className="text-[12.5px] font-medium text-gray-800">{u.label}</span>
                {u.instant && <span className="rounded bg-teal-50 px-1 text-[10px] text-teal-700">instant</span>}
                <span className="ml-auto font-mono text-[10px] text-gray-400">{u.glid}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Shared chrome (used by BOTH the chooser and the form) — surface switcher + debug.
  const surface: 'mobile' | 'desktop' = mode === 'mobile' ? 'mobile' : 'desktop';
  const debugBtn = payload && (
    <button onClick={() => setDebug((v) => !v)} className="fixed right-3 top-3 z-[60] rounded-lg bg-gray-900/90 px-2.5 py-1 text-[12px] font-semibold text-white">🔬 Debug</button>
  );
  // Surface switcher — reachable even on a deep-linked ?glid= (which skips the phase-1 picker).
  const modeSwitch = (
    <div className="fixed left-3 top-3 z-[80] flex gap-0.5 rounded-lg bg-gray-900/90 p-0.5 text-[11px] font-semibold">
      {(['mobile', 'popup', 'standalone'] as const).map((mo) => (
        <button key={mo} onClick={() => setMode(mo)} className={`rounded px-2 py-1 capitalize ${mode === mo ? 'bg-white text-gray-900' : 'text-white/80 hover:text-white'}`}>{mo}</button>
      ))}
    </div>
  );
  const debugRail = debug && payload && (
    <div className="fixed inset-0 z-[70] bg-white sm:left-auto sm:w-[420px] sm:border-l sm:border-gray-200 sm:shadow-2xl"><BrainDebugPanel p={payload} onClose={() => setDebug(false)} /></div>
  );

  // ── Phase 2: choose repost / enrich / new — rendered per SURFACE mode (mobile / popup / standalone) ──
  if (phase === 'choose') {
    const glidBar = (
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2">
        <button onClick={() => setPhase('glid')} className="text-[13px] text-gray-500">← GLID</button>
        <span className="text-[13px] font-medium text-gray-700">{glid}</span>
        <span className={`rounded px-2 py-0.5 text-[11px] ${loading ? 'bg-amber-100 text-amber-700' : live ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-500'}`}>{loading ? `loading (${pns})…` : live ? 'live' : 'fixture'}</span>
      </div>
    );
    // ── DESKTOP LANDING (owner, asked repeatedly): the narrow max-w-md column above is a phone layout and
    // reads as a cramped list on a 1280px screen. Desktop gets its own composition:
    //   · a green hero band carrying the one job of this page — name the product (type / snap / speak)
    //   · REQUIREMENTS as a rectangular card grid, grouped by the status the buyer actually thinks in
    //     (Active · Awaiting approval · Expired), 6 visible then "+N more"
    //   · BROWSED products as an image-first carousel, title UNDER the image (standard B2B marketplace
    //     product-tile pattern — the image is the identifier, the title is the label)
    // Requirement cards and browsed tiles are the SAME data (`recs`), split by action: enrich/repost are
    // things he expressed, `new` are things he only looked at. That split is the firewall in the UI.
    const STATUS_OF = (r: Recommendation) =>
      r.is_expired ? { label: 'Expired', cls: 'bg-gray-100 text-gray-600 ring-gray-200' }
      : /pending|await/i.test(String(r.status ?? '')) ? { label: 'Awaiting approval', cls: 'bg-amber-50 text-amber-700 ring-amber-200' }
      : { label: 'Active', cls: 'bg-teal-50 text-teal-700 ring-teal-200' };
    // TIMELINE-SORTED (owner): both lists run newest-first. Undated entries sink to the bottom rather than
    // being dropped or silently treated as "today" — unknown recency is not the same as recent.
    const byRecency = (a: Recommendation, b: Recommendation) =>
      (a.age_days ?? Number.MAX_SAFE_INTEGER) - (b.age_days ?? Number.MAX_SAFE_INTEGER);
    const reqCards = recs.filter((r) => r.action !== 'new').sort(byRecency);
    const browsed = recs.filter((r) => r.action === 'new').sort(byRecency);
    const shownReqs = showAllReqs ? reqCards : reqCards.slice(0, 6);
    // SUGGESTER — one pool, three origins, each labelled so the buyer knows why it is offered: the titles of
    // his own requirements (strongest signal, first), products he viewed, and his past searches. Deduped
    // case-insensitively, max 5, and the list itself scrolls.
    const bmem = payload?.metadata.buyer_memory;
    const SUGGEST: { label: string; kind: string }[] = (() => {
      const seen = new Set<string>(); const out: { label: string; kind: string }[] = [];
      const add = (label: string, kind: string) => {
        const k = String(label ?? '').trim().toLowerCase();
        if (!k || seen.has(k)) return; seen.add(k); out.push({ label: String(label).trim(), kind });
      };
      recs.forEach((r) => add(r.product, r.action === 'new' ? 'you viewed this' : 'your requirement'));
      (bmem?.viewed ?? []).forEach((v) => add(v.name, 'you viewed this'));
      (bmem?.recent_searches ?? []).forEach((q) => add(q, 'you searched this'));
      return out;
    })();
    // His OWN truth first (requirements / viewed / searches), then IndiaMART's catalogue suggest —
    // the same /api/suggest endpoint the Simple form uses. Buyer truth outranks the catalogue, always.
    const q = productInput.trim();
    // Once he starts naming a product he has left the 'continue where you left off' job, so his history
    // collapses out of the way. That also makes a separate 'brand-new requirement' CTA redundant — typing a
    // name IS the brand-new path, and qty/unit are asked on the next page like any other entry.
    const naming = q.length > 0;
    const own = q ? SUGGEST.filter((m) => m.label.toLowerCase().includes(q.toLowerCase())) : [];
    const ownKeys = new Set(own.map((m) => m.label.toLowerCase()));
    const matches = q
      ? [...own, ...apiSuggest.filter((l) => !ownKeys.has(l.toLowerCase())).map((l) => ({ label: l, kind: 'on IndiaMART' }))].slice(0, 5)
      : [];
    // a picked suggestion is a committed name -> load its images immediately
    // Picking a suggestion NAMES the product; it does not submit. The buyer stays on the landing page so he
    // can see the images we found and set/confirm quantity (owner-locked: qty-defined mcats are answered
    // here, qty-undefined mcats skip this page entirely — in which case these images are never fetched).
    const pick = (label: string) => { pickedRef.current = label.trim(); setProductInput(label); loadHeroImgs(label); setApiSuggest([]); };
    const suggestList = (cls: string) => (matches.length ? (
      <div className={`absolute z-20 mt-1 max-h-[220px] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg ${cls}`}>
        {matches.map((m) => (
          <button key={m.label} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.label)}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-teal-50">
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-gray-800">{m.label}</span>
            <span className="shrink-0 text-[10px] text-gray-400">{m.kind}</span>
          </button>
        ))}
      </div>
    ) : null);
    // One phrasing for recency everywhere it appears, so a card, a tile and a chip never disagree.
    const ago = (d?: number | null) =>
      d == null ? null : d === 0 ? 'today' : d === 1 ? 'yesterday'
      : d < 30 ? `${d}d ago` : d < 60 ? 'last month' : `${Math.round(d / 30)} months ago`;
    const freshCls = (d?: number | null) =>
      d == null ? 'text-gray-400' : d < 7 ? 'text-teal-700' : d < 30 ? 'text-gray-500' : 'text-gray-400';
    const openRec = (r: Recommendation) => { const i = recs.indexOf(r); setSeed(i === 0 && payload ? brainToSeed(payload) : recommendationToSeed(r, payload ?? undefined)); setPhase('form'); };
    const startFresh = (name?: string) => {
      const n = (name ?? productInput).trim();
      if (!n) { setSeed(blankSeed()); setPhase('form'); return; }
      const hit = recs.find((r) => r.product.toLowerCase() === n.toLowerCase());
      setSeed(hit ? recommendationToSeed(hit, payload ?? undefined) : { ...blankSeed(), productName: n, buyerFacts: payload?.metadata.buyer_facts as Record<string, unknown> | undefined, basket: recs.map((r) => r.product) });
      setPhase('form');
    };
    // ── COMPACT SURFACE (popup + msite) — same design language as the desktop landing, DECLUTTERED.
    // Owner: "the more the clutter the more the user will flake away." Both narrow surfaces previously
    // rendered a flat 6-card vertical list, which buries the one thing this screen is for: name the product.
    // So: the most recent requirement gets a full card; the rest collapse behind a deliberately small
    // "+N more" text CTA; browsed products become a horizontal carousel showing ~1.5 tiles so the cut-off
    // second tile signals scrollability without spending vertical space.
    const compactBody = (
      <div className="flex-1 overflow-y-auto">
        {/* Compact green band — the desktop hero's job in a fraction of the height. */}
        <div className="bg-gradient-to-br from-teal-700 to-emerald-800 px-4 pb-4 pt-3.5">
          <h2 className="text-[15px] font-bold text-white">Post a requirement, get quotes</h2>
                    <div className="relative mt-3 flex items-center gap-1 rounded-xl bg-white p-1 shadow-sm">
            <input value={productInput} onChange={(e) => setProductInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') startFresh(); }}
              placeholder="What are you looking for?" aria-label="Product name"
              className="min-w-0 flex-1 rounded-lg px-2.5 py-2.5 text-[14px] outline-none placeholder:text-gray-400" />
            <button type="button" onClick={() => startFresh()} aria-label="Add a photo" className="shrink-0 rounded-lg p-2 text-gray-500 active:bg-gray-100">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.2"/></svg>
            </button>
            <button type="button" onClick={() => startFresh()} aria-label="Speak your requirement" className="shrink-0 rounded-lg p-2 text-gray-500 active:bg-gray-100">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>
            </button>
            <button type="button" onClick={() => startFresh()} className="shrink-0 rounded-lg bg-teal-600 px-3.5 py-2.5 text-[13px] font-semibold text-white active:bg-teal-700">Go</button>
              {suggestList('left-0 right-0 top-full')}
          </div>
        </div>

        <div className="px-4 py-4">
          {/* LAST requirement in full; everything older hides behind a small CTA. */}
          {!naming && reqCards.length > 0 && (<>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Continue where you left off</p>
            <div className="mt-2 space-y-2">
              {(showAllReqs ? reqCards : reqCards.slice(0, 1)).map((r, i) => {
                const st = STATUS_OF(r);
                return (
                  <button key={i} onClick={() => openRec(r)} className="flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left active:border-teal-300">
                    {r.image
                      ? <img src={r.image} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-gray-100 bg-gray-50 object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                      : <div className="h-12 w-12 shrink-0 rounded-lg border border-dashed border-gray-200 bg-gray-50" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-gray-900">{r.product}</p>
                      <p className={`mt-0.5 text-[11px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ?? 'date unknown'}</p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${st.cls}`}>{st.label}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${ACTION_TONE[r.action]}`}>{ACTION_LABEL[r.action]} →</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {reqCards.length > 1 && (
              <button onClick={() => setShowAllReqs((v) => !v)} className="mt-1.5 text-[11.5px] font-medium text-teal-700 active:text-teal-800">
                {showAllReqs ? '− Show less' : `+ ${reqCards.length - 1} more requirement${reqCards.length - 1 > 1 ? 's' : ''}`}
              </button>
            )}
          </>)}

          {/* Browsed — ~1.5 tiles visible so the cut edge advertises the scroll. */}
          {!naming && browsed.length > 0 && (<>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Products you viewed</p>
            <div className="scroll-auto-hide -mx-4 mt-2 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1.5">
              {browsed.map((r, i) => (
                <button key={i} onClick={() => openRec(r)} className="w-[62%] max-w-[190px] shrink-0 snap-start rounded-xl border border-gray-200 bg-white p-2 text-left active:border-teal-300">
                  <div className="flex h-[86px] items-center justify-center overflow-hidden rounded-lg bg-gray-50">
                    {r.image
                      ? <img src={r.image} alt="" className="h-full w-full object-contain p-1.5" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                      : <span className="text-[10px] text-gray-300">no image</span>}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-snug text-gray-800">{r.product}</p>
                  <p className={`text-[10px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ? `viewed ${ago(r.age_days)}` : 'viewed recently'}</p>
                </button>
              ))}
            </div>
          </>)}

        </div>
      </div>
    );

    const desktopBody = (
      <div className="flex-1 overflow-y-auto">
        {/* HERO — green ground, one job: name the product. */}
        <div className="bg-gradient-to-br from-teal-700 via-teal-700 to-emerald-800">
          <div className="mx-auto w-full max-w-5xl px-8 py-10">
            <h1 className="text-[26px] font-bold leading-tight text-white">Post a requirement, get quotes</h1>
                        <div className="relative mt-5 flex items-stretch gap-2 rounded-2xl bg-white p-1.5 shadow-lg ring-1 ring-black/5">
              <input value={productInput} onChange={(e) => setProductInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') startFresh(); }}
                placeholder="What are you looking for?" aria-label="Product name"
                className="min-w-0 flex-1 rounded-xl px-4 py-3 text-[15px] outline-none placeholder:text-gray-400" />
              <button type="button" onClick={() => startFresh()} aria-label="Add a photo" title="Add a photo" className="shrink-0 rounded-xl px-3 text-gray-500 hover:bg-gray-50 hover:text-teal-600">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.2"/></svg>
              </button>
              <button type="button" onClick={() => startFresh()} aria-label="Speak your requirement" title="Speak your requirement" className="shrink-0 rounded-xl px-3 text-gray-500 hover:bg-gray-50 hover:text-teal-600">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>
              </button>
              <button type="button" onClick={() => startFresh()} className="shrink-0 rounded-xl bg-teal-600 px-6 text-[14px] font-semibold text-white hover:bg-teal-700">Continue</button>
              {suggestList('left-0 right-0 top-full')}
            </div>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-5xl gap-7 px-8 py-7">
          {/* LEFT PANEL — blank until we know a product (owner: no presumed image on arrival), then the
              representative images for the entered/picked name. Hidden entirely when empty so the right
              column takes the full width rather than sitting beside dead space. */}
          {heroImgs.length > 0 && (
            <aside className="hidden w-[248px] shrink-0 lg:block">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Is this what you mean?</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {heroImgs.map((src, i) => (
                  <div key={i} className="flex h-[104px] items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white">
                    <img src={src} alt="" className="h-full w-full object-contain p-1.5" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] leading-snug text-gray-400">Representative images from IndiaMART — not your own photo. Add yours with the camera above.</p>
            </aside>
          )}
          <div className="min-w-0 flex-1">
          {/* REQUIREMENTS — things he actually expressed. Rectangular cards, status-first. */}
          {!naming && reqCards.length > 0 && (<>
            <div className="flex items-baseline justify-between">
              <h2 className="text-[15px] font-semibold text-gray-900">Continue where you left off</h2>
              <span className="text-[12px] text-gray-500">{reqCards.length} requirement{reqCards.length > 1 ? 's' : ''} · newest first</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shownReqs.map((r, i) => {
                const st = STATUS_OF(r);
                return (
                  <button key={i} onClick={() => openRec(r)}
                    className="group flex flex-col rounded-xl border border-gray-200 bg-white p-3.5 text-left transition-shadow hover:border-teal-300 hover:shadow-md">
                    <div className="flex items-start gap-3">
                      {r.image
                        ? <img src={r.image} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-gray-100 bg-gray-50 object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                        : <div className="h-14 w-14 shrink-0 rounded-lg border border-dashed border-gray-200 bg-gray-50" />}
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-[14px] font-semibold leading-snug text-gray-900">{r.product}</p>
                        <p className={`mt-1 text-[11.5px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ?? 'date unknown'}</p>
                      </div>
                    </div>
                    {r.specs?.length ? <p className="mt-2.5 line-clamp-2 text-[11.5px] leading-relaxed text-gray-500">{r.specs.slice(0, 3).map((s) => `${s.name}: ${s.value}`).join(' · ')}</p> : null}
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-gray-100 pt-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ${st.cls}`}>{st.label}</span>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${ACTION_TONE[r.action]} group-hover:brightness-95`}>{ACTION_LABEL[r.action]} →</span>
                    </div>
                  </button>
                );
              })}
            </div>
            {reqCards.length > 6 && (
              <button onClick={() => setShowAllReqs((v) => !v)} className="mt-3 text-[12.5px] font-medium text-teal-700 hover:text-teal-800">
                {showAllReqs ? '− Show fewer' : `+ ${reqCards.length - 6} more`}
              </button>
            )}
          </>)}

          {/* BROWSED — image-first tiles, title under the image. Framed honestly as "only viewed". */}
          {!naming && browsed.length > 0 && (<>
            <div className="mt-8 flex items-baseline justify-between">
              <h2 className="text-[15px] font-semibold text-gray-900">Products you viewed</h2>
              <span className="text-[12px] text-gray-500">Not requested yet · most recently viewed first</span>
            </div>
            <div className="scroll-auto-hide mt-3 flex snap-x gap-3 overflow-x-auto pb-2">
              {browsed.map((r, i) => (
                <button key={i} onClick={() => openRec(r)}
                  className="w-[168px] shrink-0 snap-start rounded-xl border border-gray-200 bg-white p-2.5 text-left transition-shadow hover:border-teal-300 hover:shadow-md">
                  <div className="flex h-[112px] items-center justify-center overflow-hidden rounded-lg bg-gray-50">
                    {r.image
                      ? <img src={r.image} alt="" className="h-full w-full object-contain p-2" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                      : <span className="text-[11px] text-gray-300">no image</span>}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[12.5px] font-medium leading-snug text-gray-800">{r.product}</p>
                  <p className={`mt-0.5 text-[10.5px] ${freshCls(r.age_days)}`}>{ago(r.age_days) ? `viewed ${ago(r.age_days)}` : 'viewed recently'}</p>
                  {r.specs?.length ? <p className="line-clamp-1 text-[10.5px] text-gray-400">{r.specs.slice(0, 2).map((s) => s.value).join(' · ')}</p> : null}
                </button>
              ))}
            </div>
          </>)}

          </div>
        </div>
      </div>
    );
    // popup + msite share the SAME decluttered body; standalone gets the wide landing below.
    const inner = <>{glidBar}{compactBody}</>;
    if (mode === 'popup') return (
      <div className="relative h-screen bg-gray-100">
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <div className="flex h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl lg:max-w-3xl">{inner}</div>
        </div>
        {modeSwitch}{debugBtn}{debugRail}
      </div>
    );
    if (mode === 'mobile') return (
      <div className="relative flex h-screen justify-center bg-gray-100">
        <div className="relative flex h-full w-full max-w-[390px] flex-col overflow-hidden bg-white shadow-xl">{inner}</div>
        {modeSwitch}{debugBtn}{debugRail}
      </div>
    );
    // standalone = the real desktop page → the wide landing, not the phone column.
    return (
      <div className="relative flex h-screen flex-col bg-gray-50">
        <IndiaMartHeader onExit={() => setPhase('glid')} />
        {glidBar}{desktopBody}
        {modeSwitch}{debugBtn}{debugRail}
      </div>
    );
  }

  // ── Phase 3: the DUPLICATED Simple form, pre-seeded — rendered per SURFACE mode ──
  const form = <BrainRFQForm surface={surface} standalone={mode !== 'popup'} loggedIn categoryMode="category" brainSeed={seed ?? undefined} onClose={() => setPhase('choose')} />;

  if (mode === 'popup') {
    // Desktop popup = the form paints its OWN modal (bg-black/40 backdrop + centred card).
    // Do NOT double-wrap: BrainRFQForm's popup shell is `fixed inset-0` and would escape any
    // card placed here, giving a double backdrop + a form floating over the whole viewport.
    return (
      <div className="relative h-screen bg-gray-100">
        {form}
        {modeSwitch}{debugBtn}{debugRail}
      </div>
    );
  }
  if (mode === 'mobile') {
    // Mobile = a 390px device column centred on a neutral canvas. The form's mobile shell is
    // `absolute inset-0`, so this column (relative) is its containing block and it stays inside.
    return (
      <div className="relative flex h-screen justify-center bg-gray-100">
        <div className="relative h-full w-full max-w-[390px] overflow-hidden bg-white shadow-xl">{form}</div>
        {modeSwitch}{debugBtn}{debugRail}
      </div>
    );
  }
  // Standalone = full page.
  return (
    <div className="relative h-screen">
      {form}
      {modeSwitch}{debugBtn}{debugRail}
    </div>
  );
}
