// ─── Brain Form Gate ─────────────────────────────────────────────────────────
// The real entry the plan described: take GLID → pick PNS speed (API-only fast vs full transcripts) → fetch
// the Requirement Brain → drop into the DUPLICATED Simple form, pre-seeded by the Form Adapter. Debug throughout.
//
// THE CHOOSER IS NOT A PAGE ANY MORE (owner-locked 2026-07-28). "currently repost bla bla has its own page —
// not ok." It was `phase === 'choose'` here, and the form then opened on its own product stage, so the buyer
// walked through two near-identical "name your product" screens. The chooser now lives ON the form's LANDING,
// beside the product input and the quantity ask — which is also the only place the quantity rule can be
// honoured, because whether a mcat even defines a quantity comes from its ISQ schema and only `commitProduct`
// resolves that. This gate keeps the jobs that are genuinely its own: pick the buyer, fetch the brain, own
// WHICH SEED the form runs on, and the debug/surface chrome.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import IndiaMartHeader from './IndiaMartHeader';
import BrainRFQForm, { type LandingRec } from './BrainRFQForm';
import BrainDebugPanel from './BrainDebugPanel';
import { normalize, fixture, fixtureGlids, bpodToProfileNode, bpodToBuyerFacts, type Recommendation, type RequirementBrainPayload } from '../lib/brains/requirementBrain';
import { recommendationToSeed, buyerSeed, blankSeed, type BrainSeed } from '../lib/brains/formAdapter';
import { fetchCsl, fetchRfq, fetchProfile, fetchWhatsapp, resetSourceHealth } from '../lib/rfq/dataLayer';
import { resetLLMTelemetry } from '../lib/gemini';
import { USE_CASES } from '../lib/brains/useCaseGlids';

type Phase = 'glid' | 'form';

// The buyer's browsed categories from the Profile node (bi-bpod → bp.products_of_interest), mapped to the "viewed"
// card shape. Used as the landing's viewed-product fallback when CSL carried none (owner 2026-07-30).
function poiToViewed(profile: unknown): { name: string; mcat?: string; image?: string }[] {
  const poi = (profile as { bp?: { products_of_interest?: Array<Record<string, unknown>> } } | null)?.bp?.products_of_interest;
  if (!Array.isArray(poi)) return [];
  return poi
    .map((x) => ({
      name: String(x.glcat_mcat_name ?? '').trim(),
      mcat: x.glcat_mcat_id != null ? String(x.glcat_mcat_id) : undefined,
      image: typeof x.glcat_mcat_img1 === 'string' ? x.glcat_mcat_img1.replace(/^http:\/\//i, 'https://') : undefined,
    }))
    .filter((v) => v.name);
}

export default function BrainFormGate({ glid: initialGlid }: { glid: string }) {
  const [phase, setPhase] = useState<Phase>(initialGlid ? 'form' : 'glid');
  const [glid, setGlid] = useState(initialGlid || fixtureGlids[0]);
  const [pns, setPns] = useState<'api' | 'full'>('api');
  const [exec, setExec] = useState<'prod' | 'debug'>('prod'); // Simulator: Production Preview vs AI Debug (prompt variant for LLM 2/3)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('high'); // Reasoning effort for ALL 3 LLMs — same in prod & debug (owner: intelligence is mode-independent). Default high; owner picks to experiment.
  const [payload, setPayload] = useState<RequirementBrainPayload | null>(() => (initialGlid ? fixture(initialGlid) : null));
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  // The seed the form runs on. null = the LANDING seed (buyer-level truth, no requirement chosen yet); a
  // value = he tapped one of his own cards, so this requirement's seed replaces it and the form remounts.
  const [pickedSeed, setPickedSeed] = useState<BrainSeed | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [debug, setDebug] = useState(false);
  // #4 — the RAW leaf truth for LLM 1. Landing cards need only csl+rfq (fast), but runRequirementBrain wants the
  // full set (profile + whatsapp too), so all four are fetched at mount and handed to the form; pns is fetched on
  // the form side at commit-time (it needs the mcat). Held as state so the prop updates when the leaves land.
  const [leafTruth, setLeafTruth] = useState<{ csl: unknown; rfq: unknown; profile: unknown; whatsapp: unknown; enquiries?: unknown[]; rfqRequirements?: Array<{ product?: string; mcat?: string; specs?: { name: string; value: string }[] }> } | null>(null);
  // THE surface defaults to the one that matches the actual screen. This was hardcoded to 'mobile', so every
  // desktop visitor landed on the 390px phone column and never saw the desktop landing at all unless they
  // clicked the demo switcher — which is why it kept looking unbuilt. The switcher stays for demoing.
  const [mode, setMode] = useState<'mobile' | 'popup' | 'standalone'>(
    // 768 = the `md` breakpoint the desktop landing's own grid is built around (sm:2-col / lg:3-col).
    () => (typeof window !== 'undefined' && window.innerWidth >= 768 ? 'standalone' : 'mobile'),
  );

  // STAGED-FETCH COMMIT TOKEN (owner 2026-07-29, ask 3). The gate fires TWO overlapping live pulls:
  // stage 1 = load() on mount (no anchor), stage 2 = onPick()'s anchored re-pull. Both are 55–99s cold, so a
  // buyer who picks a card before stage 1 resolves creates a race: whichever RESOLVES last used to win, so a slow
  // no-anchor stage 1 could clobber the anchored stage 2 and silently drop the anchor. This monotonic gen makes
  // the latest-ISSUED pull the only one allowed to commit — a stale earlier resolve is dropped, never applied.
  const fetchGen = useRef(0);
  // #5 — LANDING FETCHES LEAVES ONLY (owner: retire the monolith at mount). The 55–180s bi-requirement-brain is
  // gone from mount; the landing now assembles its cards from the two fast (~3s) leaf webhooks — bi-csl-parser
  // (viewed products + searches) + bi-rfq-details (past requirements). We hand their parsed rows to normalize() as
  // a flat node_raw payload and let hydrateLandingFromNodeRaw() build metadata.recommendations + buyer_memory
  // exactly as it did for a live engine payload — so recs / seeds / the debug panel are UNCHANGED, only the SOURCE
  // moved. Buyer-LEVEL engine truth (decisions / buyer_facts / persona / category) is deliberately absent now: the
  // specs page (#4) re-derives it via runRequirementBrain over the raw leaves, not a monolith-seeded plan.
  const load = (g: string) => {
    const gen = ++fetchGen.current;
    resetSourceHealth(); resetLLMTelemetry();   // per-pull reset — Sources + LLM-call counts reflect THIS pull only
    setGlid(g); setLoading(true); setLive(false);
    setPayload(fixture(g)); // instant real-engine fixture while the leaves load
    setPickedSeed(null); setLeafTruth(null); setFormKey((k) => k + 1);
    setPhase('form');
    // Fire all four leaves once. The LANDING only needs csl+rfq (cards), so it resolves on those; profile+whatsapp
    // are non-blocking and only feed LLM 1's truth (#4) — they must never delay the landing.
    const pC = fetchCsl(g); const pR = fetchRfq(g); const pP = fetchProfile(g); const pW = fetchWhatsapp(g);
    const rfqNode = (rfq: { requirements: { product: string; mcat?: string; status?: string; is_expired?: boolean; recency_days?: number | null; specs: { name: string; value: string }[] }[] } | null) =>
      (rfq?.requirements ?? []).map((r) => ({ product: r.product, mcat: r.mcat, status: r.status, is_expired: r.is_expired, recency_days: r.recency_days, specs: r.specs }));
    Promise.allSettled([pC, pR])
      .then(([cslR, rfqR]) => {
        if (gen !== fetchGen.current) return;
        const csl = cslR.status === 'fulfilled' ? cslR.value : null;
        const rfq = rfqR.status === 'fulfilled' ? rfqR.value : null;
        if (!csl && !rfq) return; // both leaves down → keep the instant fixture rather than blanking the landing
        const viewed = (csl?.viewed_products ?? []).map((v) => ({ name: v.name, mcat: v.mcat, image: v.image, specs: v.specs }));
        const p = normalize({ glid: g, node_raw: { rfq: rfqNode(rfq), csl: { viewed, searches: csl?.searches ?? [], browse_location: csl?.browse_location } } });
        // hydrate hardcodes recent_searches:[]; restore the buyer's searches so the landing suggester still offers "you searched this".
        if (csl?.searches?.length) p.metadata.buyer_memory = { viewed: p.metadata.buyer_memory?.viewed ?? [], recent_searches: csl.searches };
        setPayload(p); setLive(true);
      })
      .catch(() => { /* keep fixture */ })
      .finally(() => { if (gen === fetchGen.current) setLoading(false); });
    // The full truth for LLM 1 — RAW leaf JSON, exactly what runRequirementBrain fences into <truth_*>. Non-blocking.
    Promise.allSettled([pC, pR, pP, pW]).then(([cslR, rfqR, profR, waR]) => {
      if (gen !== fetchGen.current) return;
      const csl = cslR.status === 'fulfilled' ? cslR.value : null;
      const rfq = rfqR.status === 'fulfilled' ? rfqR.value : null;
      const profile = profR.status === 'fulfilled' ? profR.value : null;
      const whatsapp = waR.status === 'fulfilled' ? waR.value : null;
      // rfqRequirements = the PARSED posted requirements (each with its own category_id/mcat + specs). Exposed so the
      // form's commitProduct can reconcile the resolved mcat against the buyer's OWN posted category (Theme-B #5) —
      // previously only the seed consumed them, so the RFQ mcat was structurally invisible to category resolution.
      setLeafTruth({ csl: csl?.raw ?? null, rfq: rfq?.raw ?? null, profile, whatsapp, enquiries: rfq?.enquiries ?? [], rfqRequirements: rfq?.requirements ?? [] });
      // STEP 0 (2026-08-11) — FOLD THE PROFILE INTO THE SEED. The bi-bpod leaf carries the buyer's identity
      // (name/mobile/email/COMPANY), his city/state, his business truth and the bulk-gate signals, but the gate
      // never threaded it into the payload — so contact + user-location shipped empty, company was dropped, and the
      // persona gate ran on nothing. Map bpod → node_raw.profile + metadata.buyer_facts and RE-NORMALIZE: this
      // lights up the form's EXISTING dormant effects (seedIdentity → contact/company prefill, the profile-city
      // effect → user-location) with zero form changes, because seedIdentity is a useMemo over the seed.
      const profileNode = bpodToProfileNode(profile);
      const facts = bpodToBuyerFacts(profile);
      // VIEWED-CARD FALLBACK (owner 2026-07-30): CSL "viewed" is empty for many buyers, but their browsed
      // categories live in the Profile node (bp.products_of_interest). Prefer CSL viewed; else fall back to POI.
      const cslViewed = (csl?.viewed_products ?? []).map((v) => ({ name: v.name, mcat: v.mcat, image: v.image, specs: v.specs }));
      const viewed = cslViewed.length ? cslViewed : poiToViewed(profile);
      // Nothing new to add (profile down AND no viewed fallback needed) → keep the csl+rfq paint.
      if (!profileNode && !facts && !(viewed.length && !cslViewed.length)) return;
      if (!(csl || rfq || profile)) return;
      const p = normalize({ glid: g, node_raw: { rfq: rfqNode(rfq), csl: { viewed, searches: csl?.searches ?? [], browse_location: csl?.browse_location }, ...(profileNode ? { profile: profileNode } : {}) }, ...(facts ? { buyer_facts: facts } : {}) });
      if (csl?.searches?.length) p.metadata.buyer_memory = { viewed: p.metadata.buyer_memory?.viewed ?? [], recent_searches: csl.searches };
      setPayload(p); setLive(true);
    });
  };

  // Direct ?glid= link (no fixture) → fetch on mount so the landing has data.
  const mountFetched = useRef(false);
  useEffect(() => {
    if (initialGlid && !mountFetched.current && !live && !loading) { mountFetched.current = true; load(initialGlid); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recommendations, with a v1 fallback: if the engine didn't emit `recommendations`
  // (live v1), synthesize from primary + project so the landing still shows repost/enrich/new.
  const meta = payload?.metadata;
  const recs: Recommendation[] = useMemo(() => (meta?.recommendations?.length ? meta.recommendations
    : meta?.primary ? [
        { product: meta.primary.product, mcat: meta.primary.mcat, status: meta.primary.status, age_days: meta.primary.age_days,
          is_expired: /expired/i.test(meta.primary.status ?? ''),
          action: /approv|pending|open/i.test(meta.primary.status ?? '') ? 'enrich' : 'repost' },
        ...((meta.project?.items ?? []).map((p): Recommendation => ({ product: p, action: 'new' }))),
      ]
    : []) as Recommendation[], [meta]);

  // ── WHICH SEED (the gate's remaining job on the landing) ──────────────────────────────────────────────
  // He tapped a card. Every card goes through recommendationToSeed, which carries the card (product / mcat /
  // specs / qty). On a leaf payload there are no requirement-scoped Decision Objects to carry (that was the
  // monolith's job — retired at mount in #5), so there is no longer a primary special-case. Swapping the seed
  // remounts the form so its one-shot seed guards (seedCommitFired / seedSpecsApplied / seedQtyApplied) re-arm —
  // it comes straight back up on the same landing, product already named, the quantity rule deciding what's next.
  const onPick = useCallback((picked: LandingRec) => {
    const i = recs.findIndex((r) => r.product === picked.product && r.action === picked.action);
    const r = i >= 0 ? recs[i] : undefined;
    if (!r) return;
    // Every card seeds through recommendationToSeed: on a leaf payload there are no requirement-scoped engine
    // decisions to carry, so the engine's #1 no longer needs brainToSeed (which reads metadata.primary — null on a
    // leaf payload — and would seed an empty productName). The card's product / mcat / specs / qty is all the seed
    // needs; the specs page (#4) fetches the rest of the buyer's truth itself for the resolved mcat.
    setPickedSeed(recommendationToSeed(r, payload ?? undefined));
    setFormKey((k) => k + 1);
    // (The monolith anchor re-pull that used to fire here is gone with the monolith — #5. There is no engine
    // payload to re-anchor; the seed carries the right product and the specs page re-derives everything from the
    // leaves for the resolved mcat.)
  }, [recs, payload]);
  // The LANDING seed: everything true about the BUYER, nothing about a requirement he hasn't picked.
  const landingSeed = useMemo(() => (payload ? buyerSeed(payload) : blankSeed()), [payload]);
  // Stable identity — the form memoises the suggester pool and the sorted card lists off this object.
  // MUST stay above the `phase === 'glid'` early return below: a hook that only runs in one phase changes
  // the hook count between renders, which is a hard React error ("Rendered more hooks than during the
  // previous render") the moment the phase flips.
  const landingData = useMemo(() => ({ recs, memory: payload?.metadata.buyer_memory, onPick }), [recs, payload, onPick]);
  // Closing/exiting: from a PICKED requirement, "back" means back to the untouched landing (drop the seed,
  // remount) — it must not throw him out of the flow. From the landing itself there is nothing behind it
  // but the GLID picker.
  const closeForm = () => {
    if (pickedSeed) { setPickedSeed(null); setFormKey((k) => k + 1); return; }
    setPhase('glid');
  };

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
              <div className="text-[13px] font-semibold text-gray-900">API + PNS (full)</div>
              <div className="text-[11px] text-gray-500">Requests transcription — downgrades to API if unsupported</div>
            </button>
          </div>
          {/* EXECUTION MODE — chosen ONCE here (owner 2026-07-30: "once I've entered the mode it doesn't matter").
              It decides which prompt variant runs (Prod = lightweight; AI Debug = verbose + the 🔬 inspector). It is
              NOT a floating mid-flow toggle any more — surface (below) is the only thing that changes live. */}
          <p className="mt-4 text-[12px] font-medium text-gray-600">Execution mode</p>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <button onClick={() => setExec('prod')} className={`rounded-lg border px-3 py-2 text-left ${exec === 'prod' ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
              <div className="text-[13px] font-semibold text-gray-900">Production ⚡</div>
              <div className="text-[11px] text-gray-500">Light prompts · no debug UI</div>
            </button>
            <button onClick={() => setExec('debug')} className={`rounded-lg border px-3 py-2 text-left ${exec === 'debug' ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
              <div className="text-[13px] font-semibold text-gray-900">AI Debug 🔬</div>
              <div className="text-[11px] text-gray-500">Verbose prompts · inspector</div>
            </button>
          </div>
          {/* REASONING EFFORT — the SAME intelligence knob for all three LLMs (brain + both planners), applied
              identically in Prod and AI-Debug (owner 2026-07-31: only verbosity differs by mode, never the reasoning).
              Higher = deeper reasoning, more latency. Default High; the owner dials it to see the quality/latency curve. */}
          <p className="mt-4 text-[12px] font-medium text-gray-600">Reasoning effort <span className="font-normal text-gray-400">· all 3 LLMs, both modes</span></p>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {([['high', 'High', 'deepest · slower'], ['medium', 'Medium', 'balanced'], ['low', 'Low', 'fastest · shallow']] as const).map(([k, label, sub]) => (
              <button key={k} onClick={() => setEffort(k)} className={`rounded-lg border px-2 py-2 text-center ${effort === k ? 'border-teal-600 bg-teal-50' : 'border-gray-300'}`}>
                <div className="text-[12px] font-semibold text-gray-900">{label}</div>
                <div className="text-[10px] text-gray-500">{sub}</div>
              </button>
            ))}
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
          <button disabled={!glid} onClick={() => load(glid)} className="mt-5 w-full rounded-lg bg-teal-700 py-3 text-sm font-semibold text-white disabled:bg-gray-200 disabled:text-gray-500">Draft requirement →</button>
          <p className="mt-5 text-[12px] font-medium text-gray-600">Or try a scenario</p>
          <div className="mt-1.5 grid grid-cols-1 gap-1.5">
            {USE_CASES.map((u) => (
              <button key={u.label} onClick={() => { setGlid(u.glid); load(u.glid); }} className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 text-left hover:border-teal-300">
                <span className="text-[12.5px] font-medium text-gray-800">{u.label}</span>
                {u.instant && <span className="rounded bg-teal-50 px-1 text-[10px] text-teal-700">instant</span>}
                <span className="ml-auto font-mono text-[10px] text-gray-500">{u.glid}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Phase 2: the form, entered on its LANDING (product + qty + chooser, one page) ──
  const surface: 'mobile' | 'desktop' = mode === 'mobile' ? 'mobile' : 'desktop';
  // DEV chrome only — fixed overlays, so they never take part in the form's own layout.
  // AI EXPLORER GATING (owner: "why do we have debug in non-debug mode"): the 🔬 inspector belongs to AI-Debug
  // mode ONLY. In Production Preview the simulator shows exactly what the buyer sees — no debug affordance. Flip
  // the Prod/AI-Debug toggle to bring the explorer in. (The LLM-call telemetry is still recorded either way; it is
  // only the on-screen inspector that is mode-gated.)
  const debugBtn = payload && exec === 'debug' && (
    <button onClick={() => setDebug((v) => !v)} className="fixed right-3 top-3 z-[60] rounded-lg bg-gray-900/90 px-2.5 py-1 text-[12px] font-semibold text-white">🔬 Debug</button>
  );
  // GLID + data-source chip: it used to ride a bar above the chooser page, which no longer exists. Kept as a
  // fixed chip so a demo still shows WHICH buyer and whether the numbers are live or the fixture.
  const glidChip = (
    <div className="fixed bottom-3 left-3 z-[80] flex items-center gap-1.5 rounded-lg bg-gray-900/90 px-2 py-1 text-[11px] font-semibold text-white">
      <button onClick={() => setPhase('glid')} className="text-white/70 hover:text-white">← GLID</button>
      <span className="font-mono">{glid}</span>
      <span className={`rounded px-1.5 py-0.5 ${loading ? 'bg-amber-400 text-amber-950' : live ? 'bg-teal-400 text-teal-950' : 'bg-white/20 text-white/80'}`}>{loading ? `loading (${pns})…` : live ? 'live' : 'fixture'}</span>
    </div>
  );
  // Surface switcher — reachable even on a deep-linked ?glid= (which skips the phase-1 picker).
  const modeSwitch = (
    <div className="fixed left-3 top-3 z-[80] flex gap-0.5 rounded-lg bg-gray-900/90 p-0.5 text-[11px] font-semibold">
      {(['mobile', 'popup', 'standalone'] as const).map((mo) => (
        <button key={mo} onClick={() => setMode(mo)} className={`rounded px-2 py-1 capitalize ${mode === mo ? 'bg-white text-gray-900' : 'text-white/80 hover:text-white'}`}>{mo}</button>
      ))}
    </div>
  );
  const debugRail = debug && payload && exec === 'debug' && (
    <div className="fixed inset-0 z-[70] bg-white sm:left-auto sm:w-[420px] sm:border-l sm:border-gray-200 sm:shadow-2xl"><BrainDebugPanel p={payload} onClose={() => setDebug(false)} /></div>
  );
  // (The floating Execution + PNS toggles were REMOVED 2026-07-30 — owner: "once I've entered the mode it doesn't
  //  matter." Both are chosen ONCE on the entry screen now. Only the Surface switcher stays floating, because it
  //  alone changes live UI. Deep-linked ?glid= entries skip the entry screen and run in Production by default.)
  const overlays = <>{modeSwitch}{glidChip}{debugBtn}{debugRail}</>;

  const form = (
    <BrainRFQForm
      key={formKey}
      surface={surface} standalone={mode !== 'popup'} loggedIn categoryMode="category"
      brainSeed={pickedSeed ?? landingSeed}
      landing={landingData}
      glid={glid}
      execMode={exec} effortMode={effort} pnsMode={pns}
      leafTruth={leafTruth}
      onClose={closeForm}
    />
  );

  if (mode === 'popup') {
    // Desktop popup = the form paints its OWN modal (bg-black/40 backdrop + centred card).
    // Do NOT double-wrap: BrainRFQForm's popup shell is `fixed inset-0` and would escape any
    // card placed here, giving a double backdrop + a form floating over the whole viewport.
    return (
      <div className="relative h-screen bg-gray-100">
        {form}
        {overlays}
      </div>
    );
  }
  if (mode === 'mobile') {
    // Mobile = a 390px device column centred on a neutral canvas. The form's mobile shell is
    // `absolute inset-0`, so this column (relative) is its containing block and it stays inside.
    return (
      <div className="relative flex h-screen justify-center bg-gray-100">
        <div className="relative h-full w-full max-w-[390px] overflow-hidden bg-white shadow-xl">{form}</div>
        {overlays}
      </div>
    );
  }
  // Standalone = full page.
  return (
    <div className="relative h-screen">
      {form}
      {overlays}
    </div>
  );
}
