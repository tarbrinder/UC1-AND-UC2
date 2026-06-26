// ─── BUYER LEDGER VIEW (Module 1 · Step 4) — the clickable GLID-pull Observatory ───────────────────
// The FIRST renderer over the Decision Ledger (src/lib/ledger.ts). 3 panes:
//   LEFT   = Living Buyer Twin — every attribute clickable (value · state · confidence)
//   CENTER = the selected attribute's FULL chain: Fact → Belief → Decision → Consumption → Outcome
//            (contributions · governance · conflict · alternatives · raw source lines)
//   RIGHT  = Evidence Graph + Coverage — every source node (executive card) → its facts (used/ignored)
// Standalone: it does its OWN pull (other-team path) or reuses an existing pull. No V3/V4 disruption.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildLedger, evolveLedger, counterfactualFor, derivationTimeline, diffLedgerVersions, weightTree, attentionMap, attentionBySource, ignoredReasonFor, promotionLadder, alternativeTrees, type Ledger, type Decision, type Fact, type SourceNode } from '../lib/ledger';
import { buildExternalCard } from '../lib/externalCard';
import { N8N_HOOK } from '../lib/api';
import { buildUC2Enrichment, buildUC2Prompt, mergeUC2LLM, UC2_PROMPT_VERSION, type UC2Context, type UC2LLMOut, type UC2EditFull } from '../lib/uc2Enrichment';
import { nodeCard } from '../lib/nodeCards';
import { synthMeta } from '../lib/profileSynth';
import { pruneTwinLLM, offerEnrichLLM, enrichRequirementLLM, extractBuyerProfileLLM, hasGeminiKey, type SynthLLMOut, type SynthUsage } from '../lib/gemini';
import { readSet, completenessCritic } from '../lib/personaRegistry';
import { buildWhatsAppTimeline, waFromMerged } from '../lib/whatsappTimeline';
import { buildPnsCards } from '../lib/pnsCards';
import { buildRequirements, requirementsFromMerged } from '../lib/requirements';
import { buildOfferSkeleton, buildOfferEnrichPrompt, mergeOfferLLM, type OfferLLMOut } from '../lib/offerEnrich';
import { buildPrunePrompt, applyPrune, synthEval, type FinalAttr } from '../lib/synthesisEngine';
import { bundleFromResponse, buildExtractPrompt, extractedToFinals, type RichResponse } from '../lib/buyerProfileExtract';
import { fetchEnrichment, getEnrichmentRich, getServerTrace, getEnrichmentHealth } from '../lib/enrichment';
import { runExternal } from '../lib/externalRun';
import { getLLMRaw, getLLMHealth } from '../lib/gemini';
import { getEvalRuns, evalTrend } from '../lib/evalLog';
import { identityFromMerged, externalFromMerged, resolveAvailable, resolveBuyerName, decodeIdentityDocs } from '../lib/buyerDetails';
import { attributeLineage } from '../lib/attributeLineage';
import { parseRequirementBrain, resolveRequirement } from '../lib/requirementBrain';
import { stateFromFrequency } from '../lib/brains/threeBrainRegistry';
import { L0Band, L1Band, L3Band, L4Band, L5Band, L6Band, UC2DebugBand, CrawlerBand, L7Band, UC3Band, confidenceChip, type SignalChannel, type OutAttr, type EvalRow, type CatalogRow, type OfferFieldRow, type L6Availability, type L6ProfileRow, type ReqRow, type L1NodeRow } from './bands/ledgerBands';
import { Band, StatePill } from './bands/Band';

// UI declutter (owner): L6 sits on top; everything else folds under ONE "Debug" container in 4 grouped sections.
// L7 (a 2nd requirement-enrichment readable) overlaps L6's Original↔AI-Enriched toggle → dropped from view (flag-gated,
// re-enable by flipping). The stale Evidence-Graph rail measured the RETIRED arithmetic path → hidden behind its flag.
const SHOW_L7: boolean = false;
const SHOW_EVIDENCE_GRAPH: boolean = false;
// 👔 Business / 🤖 AI / ⚙️ Raw level tabs — they only gate the depth of the (now-rare) decision-chain drill; in the
// V10 extract flow that drill almost never renders, so the tabs do nothing visible. Hidden (level fixed at 'system' =
// full depth, so no info is lost). Flip to re-enable.
const SHOW_LEVEL_TABS: boolean = false;

const SOURCE_LABEL: Record<SourceNode, string> = { 'profile-api': 'Profile API', glusr: 'GLUSR', 'pns-insights': 'PNS', 'prev-bl': 'Prev BL', 'prev-isq': 'Prev ISQ', csl: 'CSL', 'wa-out': 'WA·ours', 'wa-in': 'WA·buyer', befisc: 'Befisc', sign3: 'Sign3' };

// Categorize the Offer-Enrichment USER message into its labelled blocks (so the debug panel shows clearly:
// what is the recorded input · what the model was told is decisive · what facts it may cite · what is context-only).

// INV-2 · colour roles — same legend everywhere a raw/transformed line appears.
const ROLE_META: Record<string, { dot: string; text: string; chip: string; label: string }> = {
  decisive:   { dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50 border-emerald-200 text-emerald-700', label: 'decisive' },
  scanned:    { dot: 'bg-sky-400',     text: 'text-sky-700',     chip: 'bg-sky-50 border-sky-200 text-sky-700',           label: 'scanned' },
  available:  { dot: 'bg-amber-400',   text: 'text-amber-700',   chip: 'bg-amber-50 border-amber-200 text-amber-700',     label: 'available' },
  discounted: { dot: 'bg-rose-400',    text: 'text-rose-600',    chip: 'bg-rose-50 border-rose-200 text-rose-600',        label: 'discounted' },
  noise:      { dot: 'bg-gray-300',    text: 'text-gray-400',    chip: 'bg-gray-50 border-gray-200 text-gray-400',        label: 'noise' },
};
const roleMeta = (r?: string) => ROLE_META[r || 'available'] || ROLE_META.available;
function RoleLegend() {
  return (<div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500">{Object.values(ROLE_META).map((m) => (<span key={m.label} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${m.dot}`} />{m.label}</span>))}</div>);
}
// INV-1 · universal "+" drill — wherever a summary appears, a + opens the raw underneath (native, no state).
function Plus({ label, children }: { label: string; children: ReactNode }) {
  return (<details className="group inline-block align-top w-full"><summary className="cursor-pointer list-none text-[11px] text-indigo-600 hover:text-indigo-800 select-none">＋ {label}</summary><div className="mt-1 rounded-lg bg-gray-50 border border-gray-200 p-2 text-[11px] text-gray-700 whitespace-pre-wrap break-words">{children}</div></details>);
}

function Bar({ pct, tone = 'bg-teal-400' }: { pct: number; tone?: string }) {
  return <span className="inline-block w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden align-middle"><span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>;
}

// a numbered section divider for the 4 grouped sections inside the one Debug container
function DebugGroup({ n, label }: { n: string; label: string }) {
  return (<div className="flex items-center gap-2 pt-1"><span className="shrink-0 w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-bold flex items-center justify-center">{n}</span><span className="text-[11px] font-semibold text-slate-600">{label}</span></div>);
}

// STAGED LOADER (owner: "put stages — got previous requirements, got CSL… no need to poll"). We DON'T poll n8n (that
// would hang); since we know exactly which nodes the pull runs, we tick through the known stages on a TIMER — labelled
// an estimate, not live truth. The last stage holds until the real data arrives (parent unmounts this on `ledger`).
const LOAD_STAGES = [
  'Connecting to n8n', 'Fetching previous requirements (BuyLeads + ISQ)', 'Pulling on-site behaviour (CSL)',
  'Reading the WhatsApp timeline', 'Resolving identity (Profile ⊕ GLUSR)', 'Loading PNS sales-call insights',
  'Triangulating external (Befisc ⊕ Sign3)', 'Checking GST (KYB)', 'Building the buyer twin',
];
function StagedLoader({ glid, complete }: { glid?: string; complete?: boolean }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    setStage(0);
    const id = setInterval(() => setStage((s) => { const next = Math.min(s + 1, LOAD_STAGES.length - 1); if (next >= LOAD_STAGES.length - 1) clearInterval(id); return next; }), 2200);
    return () => clearInterval(id);
  }, []);
  // `complete` (owner: "mark done then move") — the n8n response arrived: snap EVERY stage to done before the card shows.
  const shown = complete ? LOAD_STAGES.length : stage;
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-sm p-5">
        <div className="flex items-center gap-2 mb-1">
          {complete ? <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-[10px] font-bold">✓</span> : <span className="w-4 h-4 rounded-full border-2 border-teal-500 border-t-transparent animate-spin" />}
          <span className="text-[14px] font-semibold text-gray-800">{complete ? `Buyer ${glid || ''} ready — opening…` : `Pulling buyer ${glid || ''}…`}</span>
        </div>
        <div className="text-[11px] text-gray-400 mb-3">{complete ? 'All sources in. Building the view…' : 'Live pull from n8n — can take ~3 min. Stages below are an estimate of what\'s running (not live polling).'}</div>
        <div className="space-y-1.5">
          {LOAD_STAGES.map((label, i) => {
            const done = i < shown; const active = !complete && i === stage;
            return (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] ${done ? 'bg-emerald-100 text-emerald-600' : active ? 'bg-teal-100 text-teal-600' : 'bg-gray-100 text-gray-300'}`}>{done ? '✓' : active ? <span className="w-2 h-2 rounded-full border border-teal-500 border-t-transparent animate-spin" /> : '•'}</span>
                <span className={done ? 'text-gray-500' : active ? 'text-gray-800 font-medium' : 'text-gray-300'}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// External (Befisc / Sign3 / World) is a SEPARATE mobile→external fetch — it is NOT in the webhook raw.
// The form stores the normalised result on window.__buyerTwin.observed_external. Merge it in as one more
// raw element so the ledger's extractor surfaces the External (Befisc/Sign3) nodes on a real pull. When no
// external pull ran (demo / no mobile), this is a no-op and those nodes correctly stay absent.
function withObservedExternal(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const obs = (window as unknown as { __buyerTwin?: { observed_external?: unknown } }).__buyerTwin?.observed_external;
  if (!obs || typeof obs !== 'object') return raw;
  const already = (raw as Array<Record<string, unknown>>).some((el) => el && typeof el === 'object' && ('observed_external' in el || 'befisc' in el || 'sign3' in el));
  return already ? raw : [...raw, { observed_external: obs }];
}

export default function BuyerLedgerView({ glid, onClose, presetLedger, title, onOpenForm }: { glid: string; onClose: () => void; presetLedger?: Ledger; title?: string; onOpenForm?: (variant: 'v3' | 'v4', glid: string) => void }) {
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [openNode, setOpenNode] = useState<SourceNode | null>(null);
  // 📋 L1–L7 Ledger is the headline ("no black box") view for a real buyer pull; the RFQ-state preset opens on the timeline.
  const tab = 'ledger' as const; // V10: L1–L7 Ledger is the sole view (legacy tabs retired)
  const [level, setLevel] = useState<'business' | 'ai' | 'system'>('system');
  const [prevLedger, setPrevLedger] = useState<Ledger | null>(null); // for Replay (Run A vs Run B diff)
  const [highlightFact, setHighlightFact] = useState<string | null>(null); // an evidence id (fN) clicked in the LLM reasoning → jump + highlight its source line
  const [sampleOfferIdx, setSampleOfferIdx] = useState(0); // #3 enrichment "sample offer" picker — latest (0) auto-selected

  useEffect(() => {
    if (presetLedger) return; // a pre-built ledger (e.g. RFQ ledger) — no pull needed
    const demo = (window as unknown as { __ledgerDemoRaw?: unknown }).__ledgerDemoRaw;
    if (demo) { setRaw(demo); return; }
    // V10 (owner-locked #7): NO caching — always pull fresh n8n so the rich extract input is current + matches THIS glid.
    // (Removed the getEnrichmentRaw() reuse that served a prior/stale pull and silently forced the merged fallback.)
    if (!glid.trim()) return;
    setLoading(true);
    fetchEnrichment(glid).then(({ raw }) => setRaw(raw)).catch(() => undefined).finally(() => setLoading(false));
  }, [glid]);

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  // Loader "finish then move" (owner): when the n8n pull returns, don't jump mid-stage — snap all loader stages to
  // done for a beat, THEN reveal the card. pullFinishing keeps the (all-done) loader up briefly on the loading→false edge.
  const [pullFinishing, setPullFinishing] = useState(false);
  const wasLoading = useRef(false);
  useEffect(() => {
    if (loading) { setPullFinishing(false); wasLoading.current = true; return; }   // a (re)pull started → clear any stale finishing flag
    if (wasLoading.current) { setPullFinishing(true); wasLoading.current = false; const t = setTimeout(() => setPullFinishing(false), 650); return () => clearTimeout(t); }
  }, [loading]);
  useEffect(() => {
    if (presetLedger) { setLedger(presetLedger); setBuildError(null); return; }
    if (!raw) { setLedger(null); setBuildError(null); return; }
    try { (window as unknown as { __enrichment?: unknown }).__enrichment = raw; } catch { /* noop — diagnosis hook (inspect the real pull shape) */ }
    try { setLedger(buildLedger(withObservedExternal(raw))); setBuildError(null); }
    catch (e) { setBuildError(String((e as Error)?.message || e)); setLedger(null); try { (window as unknown as { __ledgerError?: unknown }).__ledgerError = e; } catch { /* noop */ } }
  }, [raw, presetLedger]);

  // ── EXTERNAL at pull-time — the standalone Observatory pull doesn't run the form's Befisc/Sign3 fetch, so
  //    external (the paid identity APIs) was always absent here. Fire runExternal (mobile → Befisc + Sign3) ONCE
  //    after the ledger builds, set observed_external, then bump `raw` to rebuild → the External card + befisc/
  //    sign3 facts surface in the Pull formatted layer + the persona. (V3/V4 run their own; OSINT/Firecrawl is
  //    anchor-gated + post-product, so it correctly stays out of a bare buyer pull.) Skipped for demo data. ──
  const [extState, setExtState] = useState<'idle' | 'running' | 'done' | 'skip'>('idle');
  useEffect(() => {
    if (presetLedger || !ledger || extState !== 'idle') return;
    if ((window as unknown as { __ledgerDemoRaw?: unknown }).__ledgerDemoRaw) { setExtState('skip'); return; } // never hit paid APIs for injected demo data
    const w = window as unknown as { __buyerTwin?: { observed_external?: unknown } };
    if (w.__buyerTwin?.observed_external) { setExtState('done'); return; } // already fetched (e.g. by the form)
    if (ledger.facts.some((f) => f.sourceNode === 'befisc' || f.sourceNode === 'sign3')) { setExtState('done'); return; } // n8n ebi_data already carried external — don't re-hit the paid API
    const pf = ledger.facts.filter((f) => f.sourceNode === 'profile-api');
    const byPath = (re: RegExp) => pf.find((f) => re.test(f.jsonPath))?.rawValue?.trim();
    const mobile = byPath(/mobile|ph_?mobile|glusr_phone|phone/i);
    if (!mobile) { setExtState('skip'); return; }
    setExtState('running');
    runExternal({ mobile, name: byPath(/first_name|\bname\b/i), city: byPath(/\bcity\b/i), companyName: byPath(/company/i), glid }, { nowIso: new Date().toISOString() })
      .then((res) => {
        const obs: { befisc?: unknown; sign3?: unknown } = {};
        const bef = res.sources.find((s) => s.source === 'Befisc' && s.status === 'ok'); if (bef && bef.value) obs.befisc = bef.value;
        const s3 = res.sources.find((s) => s.source === 'Sign3' && s.status === 'ok'); if (s3 && s3.value) obs.sign3 = s3.value;
        if (obs.befisc || obs.sign3) { (window as unknown as { __buyerTwin?: unknown }).__buyerTwin = { ...(w.__buyerTwin || {}), observed_external: obs }; setRaw((prev: unknown) => (Array.isArray(prev) ? [...prev] : prev)); }
        setExtState('done');
      })
      .catch(() => setExtState('done'));
  }, [ledger, presetLedger, extState, glid]);
  const synth = useMemo(() => (ledger ? synthMeta(ledger) : null), [ledger]);
  const rset = useMemo(() => (ledger ? readSet(ledger) : null), [ledger]);
  const critic = useMemo(() => (ledger ? completenessCritic(ledger) : null), [ledger]);
  // V10 (v9.5 merged-only): read the merged sources.whatsapp / sources.requirement when present; else fall back to the legacy parse.
  const waConvo = useMemo(() => waFromMerged(getEnrichmentRich()) || (raw ? buildWhatsAppTimeline(raw) : null), [raw]);
  const pnsCards = useMemo(() => (ledger ? buildPnsCards(ledger) : []), [ledger]);
  const requirements = useMemo(() => { const m = requirementsFromMerged(getEnrichmentRich()); return m.length ? m : (ledger ? buildRequirements(ledger) : []); }, [ledger]);
  const external = useMemo(() => (ledger ? buildExternalCard(ledger) : null), [ledger]);
  // ── Master Observatory · MERGED SYNTHESIS (the production buyer-twin builder) — arithmetic prior + EAGER
  //    V10: the ONE extract LLM over the source SUMMARIES (no regex/persona/arithmetic) IS the twin. The arithmetic
  //    merged-synth path has been physically removed (owner: "no arithmetic anywhere"). ──
  // LLM-NATIVE extract path — bundle the source SUMMARIES → ONE exhaustive extraction → FinalAttr. This is the sole authority.
  const extractOn = true; // V10: extract is the only twin builder (the legacy merged/arithmetic path is deleted)
  const extractSynth = useMemo(() => {
    if (!extractOn) return null; const rich = getEnrichmentRich(); if (!rich) return null;
    try { const bundle = bundleFromResponse(rich as RichResponse); const rr = rich as { derived_anchors?: Record<string, unknown>; source_registry?: Record<string, Record<string, unknown>>; source_priority?: Record<string, unknown> };
      // V14: feed the DECODED PAN entity into the anchors so the persona use-case can reconcile (Individual-PAN vs Manufacturer).
      let anchors: Record<string, unknown> | null = rr.derived_anchors || null;
      try { const pe = decodeIdentityDocs(identityFromMerged(rich), externalFromMerged(rich)).entityType; if (pe && pe !== 'Unknown') anchors = { ...(anchors || {}), pan_entity: pe }; } catch { /* noop */ }
      const p = buildExtractPrompt(bundle, anchors, { source_registry: rr.source_registry || null, source_priority: rr.source_priority || null }); return { bundle, prompt: { system: p.system, user: p.user }, evidenceIds: p.evidenceIds }; } catch { return null; }
  }, [extractOn, ledger]);
  // V10 (owner-locked #1/#2/#8): EXTRACT is the ONLY twin authority — "n8n → one LLM → display, nothing inbetween".
  // The merged/arithmetic path is retired as an authority (its symbols survive only in dead ternary branches below,
  // physically removed in the P-B cleanup). synthCtx is the extract context ONLY — never the flash-lite merged fallback,
  // so the same GLID can no longer flip extract↔merged by entry-path timing (the #1 non-determinism in the audit).
  const synthCtx = extractSynth;
  const [msynth, setMsynth] = useState<{ status: 'idle' | 'loading' | 'done' | 'error' | 'no-key'; out: SynthLLMOut | null; ms: number; usage: SynthUsage | null }>({ status: 'idle', out: null, ms: 0, usage: null });
  useEffect(() => { setMsynth({ status: 'idle', out: null, ms: 0, usage: null }); }, [ledger]);
  useEffect(() => {
    if (!synthCtx || msynth.status !== 'idle') return; // L1–L7 Ledger needs the extract twin for L5/L6/L7
    if (!hasGeminiKey()) { setMsynth({ status: 'no-key', out: null, ms: 0, usage: null }); return; }
    setMsynth({ status: 'loading', out: null, ms: 0, usage: null });
    const t0 = performance.now();
    const call = extractBuyerProfileLLM(synthCtx.prompt.system, synthCtx.prompt.user); // V10: the ONE extract call — no arithmetic synth
    call
      .then(({ out, usage }) => setMsynth(out ? { status: 'done', out, ms: Math.round(performance.now() - t0), usage } : { status: 'error', out: null, ms: Math.round(performance.now() - t0), usage }))
      .catch(() => setMsynth({ status: 'error', out: null, ms: Math.round(performance.now() - t0), usage: null }));
  }, [synthCtx, msynth.status]);
  const rawFinals = useMemo<FinalAttr[]>(() => { if (!synthCtx) return []; return extractedToFinals(msynth.out, synthCtx.evidenceIds); }, [synthCtx, msynth.out]); // V10: extract is the ONLY twin builder — no arithmetic merge
  // CRITIC / PRUNE pass — after the synthesis, a fast 2nd LLM call returns the keep-set; non-kept attrs are flagged
  // pruned → held. Pure LLM judgment (no per-category gate). finals = the pruned set the rest of the screen renders.
  const [prune, setPrune] = useState<{ status: 'idle' | 'loading' | 'done' | 'skip'; keep: string[] | null }>({ status: 'idle', keep: null });
  useEffect(() => { setPrune({ status: 'idle', keep: null }); }, [ledger]);
  useEffect(() => {
    if (msynth.status !== 'done' || !rawFinals.length || prune.status !== 'idle') return;
    if (!hasGeminiKey()) { setPrune({ status: 'skip', keep: null }); return; }
    setPrune({ status: 'loading', keep: null });
    const p = buildPrunePrompt(rawFinals);
    pruneTwinLLM(p.system, p.user).then((keep) => setPrune({ status: 'done', keep })).catch(() => setPrune({ status: 'done', keep: null }));
  }, [msynth.status, rawFinals, prune.status]);
  const finals = useMemo<FinalAttr[]>(() => applyPrune(rawFinals, prune.keep), [rawFinals, prune.keep]);
  // ── OFFER ENRICHMENT (Case 2) — correct the selected BuyLead from BUYER-ORIGINATED signals. Deterministic
  // skeleton is instant; the LLM authority overlays it LAZILY (fires only when the user opens the Offer sub-view).
  const [enrichMode, setEnrichMode] = useState<'profile' | 'offer'>('profile');
  const offerIdx = Math.min(sampleOfferIdx, Math.max(0, requirements.length - 1));
  const offerSkeleton = useMemo(() => (ledger && requirements.length ? buildOfferSkeleton(requirements[offerIdx], ledger) : null), [ledger, requirements, offerIdx]);
  const [offerLLM, setOfferLLM] = useState<{ status: 'idle' | 'loading' | 'done' | 'skip'; out: OfferLLMOut | null }>({ status: 'idle', out: null });
  useEffect(() => { setOfferLLM({ status: 'idle', out: null }); }, [ledger, offerIdx]);
  useEffect(() => {
    if (enrichMode !== 'offer' || !offerSkeleton || offerLLM.status !== 'idle') return;
    if (!hasGeminiKey()) { setOfferLLM({ status: 'skip', out: null }); return; }
    setOfferLLM({ status: 'loading', out: null });
    const p = buildOfferEnrichPrompt(offerSkeleton, requirements[offerIdx]);
    offerEnrichLLM(p.system, p.user).then((out) => setOfferLLM({ status: 'done', out })).catch(() => setOfferLLM({ status: 'done', out: null }));
  }, [enrichMode, offerSkeleton, offerLLM.status, requirements, offerIdx]);
  const offerResult = useMemo(() => (offerSkeleton ? (offerLLM.out ? mergeOfferLLM(offerSkeleton, offerLLM.out) : offerSkeleton.result) : null), [offerSkeleton, offerLLM.out]);
  useEffect(() => { try { (window as unknown as { __offerEnrich?: unknown }).__offerEnrich = offerResult; } catch { /* noop */ } }, [offerResult]);
  // ── UC2 · requirement enrichment/correction (the AI-Enriched path) — ONE grounded Gemini call per selected lead,
  // fired eagerly (gated on a key) so the UC2·debug band + the L6 AI-Enriched toggle are ready on view. Context =
  // the base-truth requirement + buyer-profile finals (corroboration, not re-derived) + the fN evidence bundle +
  // category criticals (requirement_brain) + identity anchors. No-key → deterministic dummy fallback.
  const PROFILE_CTX_KEYS = ['location_sourcing_preference', 'business_persona', 'buyer_maturity', 'sub_industry', 'products_of_interest', 'buyer_intent', 'purchase_frequency', 'procurement_model', 'digital_footprint'];
  // UC2 context for ANY requirement index (so each enriched requirement gets its OWN debug block, not just the selected).
  const uc2CtxFor = (i: number): UC2Context | null => {
    const selReq = requirements[i]; if (!selReq) return null;
    const rich = getEnrichmentRich() as { derived_anchors?: { city?: string; state?: string } } | null;
    const anchors = rich?.derived_anchors; const anchorLoc = [anchors?.city, anchors?.state].filter(Boolean).join(', ') || undefined;
    const evidence = (synthCtx?.bundle.evidence || []).map((e) => ({ evidence_id: e.evidence_id, node: e.node, tag: e.tag, raw: e.raw }));
    const profile = PROFILE_CTX_KEYS.map((k) => finals.find((f) => f.key === k)).filter((f): f is NonNullable<typeof f> => !!f).map((f) => ({ key: f.key, label: f.label, value: f.value }));
    let addSpecs: string[] = [];
    try { const rb = parseRequirementBrain(getEnrichmentRich()); const rr = resolveRequirement(rb, { isqSpecNames: selReq.specs.map((s) => s.k), answeredSpecNames: selReq.specs.map((s) => s.k), intentKnown: false }); addSpecs = (rr.addedSpecs || []).slice(0, 8); } catch { /* noop */ }
    // O36 — pass deterministic external context (Befisc age/gender/income) so UC2 reasoning can read "young, first-venture".
    const ext = externalFromMerged(getEnrichmentRich());
    const external = ext && (ext.age || ext.gender || ext.incomeBand) ? { age: ext.age, gender: ext.gender, incomeBand: ext.incomeBand } : undefined;
    return { selReq: { title: selReq.title, category: selReq.category, categoryId: selReq.categoryId, location: anchorLoc, specs: selReq.specs, specsStatus: selReq.specsStatus, description: selReq.description }, profile, evidence, addSpecs, anchors: anchors ? { city: anchors.city, state: anchors.state } : undefined, external };
  };
  const uc2Ctx = useMemo<UC2Context | null>(() => uc2CtxFor(offerIdx), [requirements, offerIdx, finals, synthCtx]); // eslint-disable-line react-hooks/exhaustive-deps
  // L6 card 3-way view: Original (frozen) · Buyer Profile (default, AI profile + drills) · Requirement (UC2-enriched).
  // The requirement-enrichment LLM is LAZY — fires ONLY on the Requirement tab, so profile vs requirement calls are distinct.
  const [cardMode, setCardMode] = useState<'original' | 'profile' | 'requirement'>('profile');
  useEffect(() => { setCardMode('profile'); }, [ledger]);
  // UC2 is PER-REQUIREMENT (owner): a MAP keyed by offer index keeps a debug block for EVERY requirement enriched this
  // pull. The lazy effect writes map[offerIdx]; per-call cost is captured from the LLM health ring right after the call.
  type Uc2Entry = { status: 'idle' | 'loading' | 'done' | 'no-key'; out: UC2LLMOut | null; usage: SynthUsage | null; costUsd?: number };
  const [uc2Map, setUc2Map] = useState<Record<number, Uc2Entry>>({});
  useEffect(() => { setUc2Map({}); }, [ledger]);                                  // reset enrichment history each pull
  const uc2LLM: Uc2Entry = uc2Map[offerIdx] || { status: 'idle', out: null, usage: null };
  useEffect(() => {
    if (cardMode !== 'requirement') return;       // lazy: only enrich when the user opens the Requirement tab
    if (!uc2Ctx || uc2LLM.status !== 'idle') return;
    if (!hasGeminiKey()) { setUc2Map((m) => ({ ...m, [offerIdx]: { status: 'no-key', out: null, usage: null } })); return; }
    const idx = offerIdx; const p = buildUC2Prompt(uc2Ctx);
    setUc2Map((m) => ({ ...m, [idx]: { status: 'loading', out: null, usage: null } }));
    enrichRequirementLLM(p.system, p.user)
      .then(({ out, usage }) => { const h = getLLMHealth().filter((r) => r.label === 'uc2Enrich').slice(-1)[0]; setUc2Map((m) => ({ ...m, [idx]: { status: 'done', out, usage, costUsd: h?.costUsd } })); })
      .catch(() => setUc2Map((m) => ({ ...m, [idx]: { status: 'done', out: null, usage: null } })));
  }, [uc2Ctx, uc2LLM.status, cardMode, offerIdx]);
  const uc2Result = useMemo(() => (uc2Ctx && uc2LLM.out ? mergeUC2LLM(uc2Ctx, uc2LLM.out) : null), [uc2Ctx, uc2LLM.out]);
  // evidence_id → evidence line, for resolving the clickable citations to a human-readable "node · value"
  const evMapAll = useMemo(() => new Map((synthCtx?.bundle.evidence || []).map((e) => [e.evidence_id, e] as const)), [synthCtx]);
  // "LLM decides what surfaces" (the approved generic rule, no per-attribute gate): once the LLM has spoken, an
  // attribute it did NOT touch (provenance 'arithmetic' = arithmetic-only) is HELD, not surfaced — so the prompt's
  // omissions (redundant / hedged / benign-default) actually lean the twin. A value the LLM couldn't fill (unknown)
  // is also held. BEFORE the call returns, nothing is held (the arithmetic baseline shows provisionally so the twin
  // is never blank while flash-lite runs).
  // V10 (owner #7): hallucination guard is LOAD-BEARING — an LLM attribute whose citations don't resolve (grounded:false)
  // is HELD (moved to the held drawer), never surfaced as the twin. So groundedPct of the SHOWN twin reflects reality.
  const heldAttr = (f: FinalAttr) => { const v = String(f.value || '').trim(); const unknownVal = !v || /^(unknown|—|-|n\/?a|none|not (known|available|specified)|tbd|\?)$/i.test(v); return unknownVal || f.pruned || (msynth.status === 'done' && f.provenance === 'arithmetic') || (!!f.llm && !f.llm.grounded); };
  // WHY each held attribute is held (for the L5 held drawer — the governance made visible)
  const heldReason = (f: FinalAttr): string => { const v = String(f.value || '').trim(); const unknownVal = !v || /^(unknown|—|-|n\/?a|none|not (known|available|specified)|tbd|\?)$/i.test(v); if (unknownVal) return 'unknown — no value'; if (f.pruned) return 'pruned by critic'; if (!!f.llm && !f.llm.grounded) return 'ungrounded — citations don\'t entail the value'; if (msynth.status === 'done' && f.provenance === 'arithmetic') return 'arithmetic-only — LLM didn\'t surface it'; return 'held'; };
  // click an evidence id (fN) in the LLM reasoning → scroll to + flash that exact line in the L3 "evidence sent" list.
  // The line lives nested inside Debug › L3 › node › evidence — all collapsed — so we open EVERY ancestor <details>.
  const jumpToFact = (id: string) => setHighlightFact(id);
  useEffect(() => {
    if (!highlightFact) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-fact-id="${highlightFact}"]`);
      if (!el) return;
      for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) { if (n.tagName === 'DETAILS') (n as HTMLDetailsElement).open = true; }
      (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
      const cls = ['ring-2', 'ring-amber-300', 'bg-amber-100', 'rounded']; // all literal elsewhere in source → safe from Tailwind purge
      el.classList.add(...cls);
      setTimeout(() => el.classList.remove(...cls), 1800);
    }, 260);
    return () => clearTimeout(t);
  }, [highlightFact]);

  const factsBySource = useMemo(() => {
    const m = new Map<SourceNode, Fact[]>();
    for (const f of ledger?.facts || []) { const a = m.get(f.sourceNode) || []; a.push(f); m.set(f.sourceNode, a); }
    return m;
  }, [ledger]);
  const cov = useMemo(() => {
    const facts = ledger?.facts || []; return { total: facts.length, used: facts.filter((f) => f.coverage === 'used').length, ignored: facts.filter((f) => f.coverage === 'ignored').length };
  }, [ledger]);

  // ── SHARED: the FULL per-decision chain (HOD → contributions → weight/attention → governance/conflict →
  //    alternatives → reasoning → Belief↔raw+counterfactual → ignored-impact → derivation → verify →
  //    consumption/outcome). ONE source of truth — rendered inline under an expanded persona attribute so
  //    NOTHING from the old Decisions tab goes missing. (Decisions tab keeps its own copy, retired off-nav.)
  const decisionDetail = (dec: Decision): ReactNode => {
    if (!ledger) return null;
    const beliefs = ledger.beliefs.filter((b) => dec.beliefs.includes(b.id));
    const consumption = ledger.consumption.find((c) => c.subject === dec.id);
    const outcome = ledger.outcomes.find((o) => o.subject === dec.id);
    const vfy = synth?.verify.find((v) => v.key === dec.key)?.result || null;
    return (
      <div className="space-y-4">
        {dec.reasoning && <p className="text-[12px] text-gray-500">{dec.reasoning}</p>}
        {/* HOD MODE — the one-glance "why" (Layer 10) */}
        {(() => {
          const cited = ledger.factsForDecision(dec.id);
          const srcs = [...new Set(cited.map((f) => SOURCE_LABEL[f.sourceNode]))];
          const topEv = (dec.reasoningSteps || []).filter((s) => s.delta > 0).slice(0, 3).map((s) => s.claim);
          const contra = dec.conflict ? `${dec.conflict.losers.join(', ')} (conflict)` : (dec.alternatives[0] ? `${dec.alternatives[0].value} — ${dec.alternatives[0].whyLost}` : 'none flagged');
          const risk = dec.conflict || dec.confidence < 60 ? 'Medium–High' : dec.confidence >= 80 ? 'Low' : 'Medium';
          return (
            <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-3">
              <p className="text-[10px] uppercase tracking-wide text-teal-600 font-semibold mb-1">👔 HOD — why {dec.value}?</p>
              <div className="text-[12px] text-gray-700"><b>{srcs.length} source{srcs.length === 1 ? '' : 's'}:</b> {srcs.join(' · ') || '—'} · <b>confidence {dec.confidence}</b> · <b>risk:</b> <span className={risk === 'Low' ? 'text-emerald-700' : 'text-amber-700'}>{risk}</span></div>
              {(rset || critic) && <div className="text-[12px] text-gray-600 mt-0.5">{rset && (() => { const q = Math.round(((rset.used + rset.supportive + rset.held) / Math.max(1, rset.read)) * 100); return <><b>data quality:</b> {q}% signal <span className="text-gray-400">({rset.read} facts read)</span></>; })()}{critic && <> · <b>decision stable:</b> <span className={critic.verdict === 'stable' ? 'text-emerald-700' : 'text-amber-700'}>{critic.verdict === 'stable' ? 'yes' : 'review'}</span></>}</div>}
              {topEv.length > 0 && <div className="text-[12px] text-gray-600 mt-1"><b>top evidence:</b> {topEv.join(' · ')}</div>}
              <div className="text-[12px] text-gray-500 mt-0.5"><b>top contradiction:</b> {contra}</div>
            </div>
          );
        })()}

        {/* contributions */}
        {dec.contributions.length > 0 && (
          <div><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">Confidence contributions</p>
            {dec.contributions.map((c, i) => (<div key={i} className="flex items-center gap-2 mb-0.5"><span className="min-w-[90px] text-gray-500">{SOURCE_LABEL[c.source] || c.source}</span><Bar pct={c.points} /><b className="text-teal-700">+{c.points}</b></div>))}
          </div>
        )}

        {/* L5 · WEIGHT TREE + L2 · ATTENTION MAP + L2b source rollup (HOD: PNS 41% · BL 24% · External 18%) */}
        {level !== 'business' && (() => { const tree = weightTree(ledger, dec.id); const att = attentionMap(ledger, dec.id); const bySrc = attentionBySource(ledger, dec.id); if (!tree.length) return null; return (
          <div className="rounded-xl border border-gray-150 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">🌳 Weight tree — every point, sourced</p>
            {tree.map((n, i) => (
              <div key={i} className="mb-1">
                <div className="text-gray-700"><b>{SOURCE_LABEL[n.source]}</b> <span className="text-teal-700">+{n.points}</span></div>
                {n.beliefs.map((b, j) => b.facts.map((f, k) => (<div key={j + '-' + k} className="pl-3 text-[11px] text-gray-500">{f.ref ? f.ref + ': ' : ''}“{f.raw.length > 44 ? f.raw.slice(0, 44) + '…' : f.raw}” <span className="text-teal-600">+{f.share}</span></div>)))}
              </div>
            ))}
            {bySrc.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-1"><span className="text-[10px] text-gray-400">attention by source:</span>{bySrc.map((r, i) => (<span key={i} className="text-[10px] px-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-100">{r.pct}% {SOURCE_LABEL[r.source]}</span>))}</div>}
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mt-2 mb-1">🎯 Attention — influence % (per line)</p>
            {att.slice(0, 6).map((r, i) => (<div key={i} className="flex items-center gap-2 mb-0.5 text-[11px]"><span className="min-w-[40px] text-gray-700 font-medium text-right">{r.pct}%</span><Bar pct={r.pct} tone="bg-indigo-400" /><span className="flex-1 min-w-0 text-gray-500 truncate">{SOURCE_LABEL[r.source]}{r.ref ? ' · ' + r.ref : ''}: {r.label}</span></div>))}
          </div>
        ); })()}

        {/* governance + conflict */}
        {dec.governance && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
            <p className="text-[10px] uppercase tracking-wide text-indigo-500 font-semibold mb-1">⚖️ Governance — who was allowed to decide</p>
            <div><b className="text-emerald-700">winner:</b> {dec.governance.winner}</div>
            {dec.governance.losers.length > 0 && <div><b className="text-rose-600">lost:</b> {dec.governance.losers.join(', ')}</div>}
            <div className="text-gray-500 mt-0.5"><b>rule:</b> {dec.governance.rule}</div>
          </div>
        )}
        {dec.conflict && (
          <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
            <p className="text-[10px] uppercase tracking-wide text-rose-500 font-semibold mb-1">⚠ Conflict resolved</p>
            {dec.conflict.contenders.map((c, i) => (<div key={i} className={c.value === dec.conflict!.winner ? 'text-emerald-700' : 'text-rose-600 line-through'}>{c.source}: {c.value}</div>))}
            <div className="text-gray-500 mt-0.5"><b>rule:</b> {dec.conflict.rule} · conf {dec.conflict.confidence}</div>
          </div>
        )}

        {/* alternatives — for vs against (L6) */}
        {dec.alternatives.length > 0 && (
          <div><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">Alternative universes — for vs against (L6)</p>
            {alternativeTrees(ledger, dec.id).map((a, i) => (
              <details key={i} className="mb-1 rounded-lg border border-gray-150 p-2">
                <summary className="cursor-pointer list-none text-gray-700">✗ <b>{a.value}</b> ({a.score}) <span className="text-[10px] text-indigo-600">＋ for / against</span></summary>
                <div className="mt-1 pl-2 text-[11px]">
                  <div className="text-emerald-700">for:</div>{a.for.map((f, j) => <div key={'f' + j} className="pl-2 text-gray-600">• {f}</div>)}
                  <div className="text-rose-600 mt-0.5">against:</div>{a.against.map((f, j) => <div key={'a' + j} className="pl-2 text-gray-600">• {f}</div>)}
                </div>
              </details>
            ))}
          </div>
        )}

        {/* REASONING — grounded, step-by-step, drillable (reasoning for EVERY output) */}
        {dec.reasoningSteps && dec.reasoningSteps.length > 0 && (() => { let run = 0; return (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <p className="text-[10px] uppercase tracking-wide text-indigo-500 font-semibold">🧠 Reasoning — grounded, step by step <span className="text-gray-400 normal-case">({dec.producedBy.kind === 'llm' ? 'LLM' : 'rule'})</span></p>
              <RoleLegend />
            </div>
            {dec.reasoningSteps.map((s) => { run = Math.min(100, run + s.delta); return (
              <div key={s.n} className="mb-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-gray-400 w-4 text-[11px]">{s.n}</span>
                  <span className="flex-1 text-gray-800">{s.claim}{s.delta ? <span className="text-teal-700 text-[11px]"> (+{s.delta} → {run})</span> : null}</span>
                  <span className={`text-[9px] px-1 rounded border ${s.via === 'llm' ? 'border-indigo-200 text-indigo-600' : 'border-gray-200 text-gray-400'}`}>{s.via}</span>
                </div>
                {s.rejected && <div className="pl-6 text-[11px] text-rose-500">✗ rejected: {s.rejected}</div>}
                {level !== 'business' && s.fromEvidence.map((fid) => { const f = ledger.factById(fid); if (!f) return null; const rm = roleMeta(f.role); return (
                  <div key={fid} className="pl-6 mt-0.5 text-[11px]">
                    <span className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${rm.dot}`} /><span className={rm.text}>{rm.label}</span></span>
                    <span className="text-gray-400"> · {SOURCE_LABEL[f.sourceNode]}{f.lineRef ? ' · ' + f.lineRef : ''}:</span> “{f.rawValue}”
                    {level === 'system' && <Plus label="raw line">{f.jsonPath}{'\n'}{f.rawValue}</Plus>}
                  </div>); })}
                {level === 'business' && s.fromEvidence.length > 0 && <div className="pl-6 text-[11px] text-gray-400">from {s.fromEvidence.length} cited line{s.fromEvidence.length === 1 ? '' : 's'} (AI/System to drill)</div>}
              </div>); })}
          </div>); })()}

        {/* the chain: Belief → Facts (raw lines) + counterfactual */}
        <div><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">🔗 Chain · Belief → raw source line</p>
          {beliefs.length === 0 && <div className="text-gray-400 text-[12px]">direct fact — no interpretation step</div>}
          {beliefs.map((b) => (
            <div key={b.id} className="mb-2 rounded-lg border border-gray-150 p-2">
              <div className="font-medium text-gray-800">🧩 {b.statement} <span className="text-[11px] text-teal-700">(+{b.weight})</span></div>
              {level !== 'business' && b.fromFacts.map((fid) => { const f = ledger.factById(fid); if (!f) return null; const cf = counterfactualFor(ledger, dec.id, fid); return (
                <div key={fid} className="text-[11px] text-gray-500 mt-1 pl-3 border-l-2 border-gray-200">
                  <span className="text-gray-400">{SOURCE_LABEL[f.sourceNode]}{f.lineRef ? ' · ' + f.lineRef : ''}{level === 'system' ? ' · ' + f.jsonPath : ''}</span><br />“{f.rawValue}”
                  {cf && cf.drop > 0 && <span className="block text-rose-500">↳ counterfactual: without this line → {cf.before}→{cf.after} (−{cf.drop})</span>}
                </div>); })}
              {level === 'business' && <div className="text-[11px] text-gray-400 mt-0.5 pl-3">from {b.fromFacts.length} source line{b.fromFacts.length === 1 ? '' : 's'} (switch to AI/System to see them)</div>}
            </div>
          ))}
        </div>

        {/* IGNORED-IMPACT — the inverse counterfactual: unused facts ranked by would-be Δ */}
        {dec.ignoredImpact && dec.ignoredImpact.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
            <p className="text-[10px] uppercase tracking-wide text-amber-600 font-semibold mb-1">⚠ Ignored — facts that would move this most</p>
            {dec.ignoredImpact.map((ig, i) => (<div key={i} className="text-[11px] flex items-start gap-2 mb-0.5">
              <span className="text-amber-700 font-semibold w-8 shrink-0">+{ig.estDelta}</span>
              <span className="flex-1 min-w-0"><span className="text-gray-700">“{ig.raw}”</span> <span className="text-gray-400">· {ig.note}</span></span>
              <span className="text-[9px] px-1 rounded border border-amber-200 text-amber-600 shrink-0">{ig.tag}</span>
            </div>))}
            <div className="text-[10px] text-gray-400 mt-1">signal-bearing lines no rule consumed yet — what the model would gain (inverse counterfactual).</div>
          </div>
        )}

        {/* F · DERIVATION TIMELINE — how confidence built up, source by source */}
        {(() => { const tl = derivationTimeline(ledger, dec.id); return tl.length > 1 ? (
          <div><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">📈 Derivation timeline — how confidence built</p>
            {tl.map((ev) => (<div key={ev.step} className="flex items-center gap-2 text-[11px] mb-0.5"><span className="text-gray-400 w-4">{ev.step}</span><span className="flex-1 min-w-0 text-gray-600">{ev.event} <span className="text-gray-400">({SOURCE_LABEL[ev.source as SourceNode] || ev.source})</span></span><span className="text-teal-700">+{ev.delta}</span><Bar pct={ev.running} tone="bg-teal-400" /><b className="text-gray-700 w-7 text-right">{ev.running}</b></div>))}
          </div>
        ) : null; })()}

        {/* VERIFY (deterministic guard) + the resolved synthesis PROMPT behind a + (INV-1) */}
        {vfy && (
          <div className="rounded-xl border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">✓ Verify — grounding guard <span className={vfy.ok ? 'text-emerald-600' : 'text-rose-600'}>{vfy.ok ? '· all pass' : '· FLAGGED'}</span></p>
              <span className="text-[10px] text-gray-400">synthesis: {synth?.mode === 'llm' ? 'LLM (gemini)' : 'rule (deterministic)'}</span>
            </div>
            {vfy.checks.map((c, i) => (<div key={i} className="text-[11px] flex items-start gap-1.5"><span className={c.pass ? 'text-emerald-600' : 'text-rose-600'}>{c.pass ? '✓' : '✗'}</span><span className="flex-1 min-w-0"><b className="text-gray-700">{c.name}</b> <span className="text-gray-400">— {c.detail}</span></span></div>))}
            {synth && level === 'system' && <div className="mt-2"><Plus label={`resolved synthesis prompt (${synth.mode})`}>{`system:\n${synth.prompt.system}\n\nuser (bundle):\n${synth.prompt.user}`}</Plus></div>}
          </div>
        )}

        {/* L4 Consumption + L5 Outcome */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-gray-150 p-3"><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">Consumption (L4)</p>
            {(consumption?.entries || []).map((e, i) => (<div key={i}><b className={e.status === 'consumed' ? 'text-emerald-700' : e.status === 'rejected' ? 'text-rose-600' : 'text-gray-500'}>{e.consumer}: {e.status}</b> <span className="text-gray-400">— {e.reason}</span></div>))}
            <div className="text-gray-400 mt-0.5">status: {consumption?.status}</div>
          </div>
          <div className="rounded-xl border border-gray-150 p-3"><p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">Outcome (L5)</p>
            <div>verdict: <b>{outcome?.verdict}</b></div>
            <div className="text-gray-400 mt-0.5">{outcome?.verdict === 'pending' ? 'did-it-matter resolves once the RFQ proceeds' : outcome?.changedDownstream.join(', ')}</div>
          </div>
        </div>
      </div>
    );
  };

  // ── SHARED: one merged-attribute's FULL drill (arithmetic → LLM reasoning w/ clickable evidence → decision
  //    chain). ONE source of truth, used by BOTH the Synthesis stage ③ and the Enrichment new-profile (#6):
  //    click an attribute → reasoning → cited evidence (node · value) → click a citation to jump + highlight
  //    that exact raw line in Pull. No hopping between sections. ──
  // P7 — CLEAN 3-tier reasoning drill (owner: "simple reason · src · why, click → jump to src line"). No more
  // wall-of-text. Tier 1 = value · confidence% · provenance badge. Lineage strip = why THIS won (winner ·
  // supports · ruled-out). Tier 2 = concise WHY lines + clickable evidence chips. Tier 3 = raw decision chain.
  const shortNode = (id: string): string => { const e = evMapAll.get(id); const n = e ? (SOURCE_LABEL[e.node as SourceNode] || e.node) : ''; return String(n).split(/[·(⊕]/)[0].trim(); };
  const finalAttrDetail = (f: FinalAttr): ReactNode => {
    const dec = f.arithmetic?.decisionId && ledger ? ledger.decisions.find((x) => x.id === f.arithmetic!.decisionId) : null;
    const steps = f.llm?.reasoning || [];
    const lin = attributeLineage(f, (id) => { const e = evMapAll.get(id); return e ? (SOURCE_LABEL[e.node as SourceNode] || e.node) : undefined; });
    return (
      <div className="text-[11px] space-y-1.5">
        {/* TIER 1 — headline (confidence % is click-to-expand: how it's scored · why this number · what would make it 100) */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-800">{f.value || '—'}</span>
          {confidenceChip(f.confidence, !!f.llm, f.llm?.confidenceReason, f.llm?.to100)}
          <span className={`text-[8px] uppercase font-bold tracking-wide px-1 py-px rounded border ${f.llm ? 'text-violet-700 bg-violet-50 border-violet-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>{f.llm ? 'LLM' : 'deterministic'}</span>
          {f.llm && f.llm.grounded === false && <span className="text-[9px] text-rose-500" title="no matching evidence">⚠ ungrounded</span>}
        </div>
        {/* LINEAGE STRIP — why this answer won (Attribute Lineage) */}
        {f.llm && (
          <div className="text-[9.5px] text-gray-500 flex flex-wrap items-center gap-x-1.5">
            <span>won via <b className="text-gray-700">{lin.winningSource}</b></span>
            {lin.supportingSources.length ? <span>· supports {lin.supportingSources.join(', ')}</span> : null}
            {lin.conflictingSources.length ? <span className="text-rose-500">· ruled out {lin.conflictingSources.join('; ')}</span> : null}
          </div>
        )}
        {/* TIER 2 — each WHY line is itself CLICKABLE (owner: many chips inline looked messy). The line reveals its
            source chips on click; each chip then reveals the exact raw line + a working jump to the prompt (L3). */}
        {steps.length > 0 && (
          <div className="space-y-1">
            {steps.map((r, i) => { const ev = r.evidence || []; return (
              <details key={i} className="text-gray-600 leading-snug">
                <summary className="cursor-pointer list-none flex items-baseline gap-1 hover:text-gray-800">
                  <span className="text-gray-300 shrink-0">▸</span>
                  <span className="flex-1 min-w-0">{r.claim}</span>
                  {ev.length > 0 && <span className="shrink-0 text-[9px] text-indigo-400 whitespace-nowrap">{ev.length} source{ev.length === 1 ? '' : 's'}</span>}
                </summary>
                {ev.length > 0 && (
                  <div className="mt-1 ml-4 flex flex-wrap gap-1">
                    {ev.map((id) => { const e = evMapAll.get(id); return (
                      <details key={id} className="inline-block align-baseline">
                        <summary className="cursor-pointer list-none inline-flex items-baseline gap-0.5 rounded px-1 text-[9.5px] text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700" title="show the exact line sent to the LLM"><span className="font-mono">[{id}]</span><span className="text-gray-400">{e ? shortNode(id) : '⚠'}</span><span>▾</span></summary>
                        <div className="mt-0.5 rounded bg-indigo-50/70 border border-indigo-200 p-1.5 text-[10px] text-gray-700 not-italic font-normal">
                          {e ? (<>
                            <div className="text-gray-500">{e.node}{e.tag ? <span className="text-gray-400"> · {e.tag}</span> : null} <span className="text-gray-300">(exact LLM-input line)</span></div>
                            <div className="font-mono text-gray-800 break-words mt-0.5">“{e.raw}”</div>
                            <button type="button" onClick={() => jumpToFact(id)} className="mt-1 text-[9px] text-indigo-400 hover:text-indigo-600 hover:underline">↗ jump to this line in the prompt (L3)</button>
                          </>) : <span className="text-rose-500">[{id}] is NOT in the evidence bundle sent to the LLM — likely a hallucinated citation</span>}
                        </div>
                      </details>
                    ); })}
                  </div>
                )}
              </details>
            ); })}
          </div>
        )}
        {/* TIER 3 — raw decision chain (full weight · attention · governance · alternatives) behind one expand */}
        {dec && <details className="mt-0.5"><summary className="cursor-pointer list-none text-[10px] text-indigo-600">＋ raw — decision chain (weight · attention · governance · alternatives)</summary><div className="mt-1">{decisionDetail(dec)}</div></details>}
      </div>
    );
  };

  // ── SHARED: the Evidence Graph rail (n8n authoritative cards · coverage · every source node → its facts
  //    with role chips, ignored-reason & promotion ladder). Always-visible right rail on the Persona tab. ──
  const evidenceRail = (): ReactNode => {
    if (!ledger) return null;
    const st = getServerTrace();
    return (
      <>
        {st?.nodes?.length ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-2">
            <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold mb-1">🛰 n8n authoritative (E1) · {st.nodes.length} nodes</p>
            {st.nodes.slice(0, 10).map((n, i) => (<div key={i} className="text-[11px] text-gray-600">{n.node}: {n.items_out ?? 0} items{n.confidence != null ? ` · conf ${n.confidence}` : ''}{n.latency_ms != null ? ` · ${Math.round(n.latency_ms)}ms` : ''}</div>))}
            <div className="text-[10px] text-gray-400 mt-0.5">authoritative server cards — supersede the static dictionary below</div>
          </div>
        ) : (<div className="text-[10px] text-gray-400">🛰 n8n authoritative cards: enable E1 to populate (dictionary cards below meanwhile)</div>)}
        <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">📊 Coverage — not a single line untouched</p>
        <div className="flex items-center gap-2 text-[12px]"><Bar pct={cov.total ? (cov.used / cov.total) * 100 : 0} tone="bg-emerald-400" /><span><b className="text-emerald-700">{cov.used}</b> used · <b className="text-gray-500">{cov.ignored}</b> not-yet-referenced · {cov.total} facts</span></div>
        <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mt-2">🌳 Evidence Graph — every source node</p>
        {[...factsBySource.keys()].map((src) => { const card = nodeCard(src); const facts = factsBySource.get(src) || []; const used = facts.filter((f) => f.coverage === 'used').length; const open = openNode === src; return (
          <div key={src} className="rounded-xl border border-gray-150">
            <button onClick={() => setOpenNode(open ? null : src)} className="w-full text-left px-3 py-2 hover:bg-gray-50">
              <div className="flex items-center justify-between"><b className="text-gray-800">{card?.title || src}</b><span className="text-[10px] text-gray-400">{used}/{facts.length} used {open ? '▾' : '▸'}</span></div>
              <div className="text-[11px] text-gray-400">{card?.kind} · {card?.purpose}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {(() => { const counts: Record<string, number> = {}; for (const f of facts) { const r = f.role || 'available'; counts[r] = (counts[r] || 0) + 1; } return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => { const rm = roleMeta(r); return (<span key={r} className={`text-[9px] px-1 rounded border ${rm.chip}`}>{n} {rm.label}</span>); }); })()}
                <span className="text-[9px] px-1 rounded border border-gray-200 text-gray-400">{src === 'pns-insights' ? 'llm' : 'rule'}</span>
              </div>
            </button>
            {open && (
              <div className="px-3 pb-2 space-y-1 border-t border-gray-100 pt-1.5">
                {card?.input && <div className="text-[11px] text-gray-400">in: {card.input} · out: {card.output}</div>}
                {card?.technical && <div className="text-[10px] text-gray-400 font-mono bg-gray-50 rounded p-1 leading-tight">technical: {card.technical}</div>}
                {facts.map((f) => { const rm = roleMeta(f.role); return (
                  <details key={f.id} className="text-[11px]">
                    <summary className="cursor-pointer list-none flex items-start gap-1.5"><span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${rm.dot}`} /><span className="flex-1 min-w-0"><span className="text-gray-400">{f.lineRef || f.jsonPath.split('.').pop()}: </span>{f.rawValue} <span className={rm.text}>· {rm.label}</span></span></summary>
                    <div className="pl-3 mt-0.5 mb-1 text-[10px] text-gray-500"><div>why: {ignoredReasonFor(f)}</div><div className="mt-0.5">ladder: {promotionLadder(ledger, f.id).map((r) => r.kind === 'fact' ? 'raw' : r.kind === 'belief' ? `→ ${r.label}` : `→ ✓ ${r.label}`).join(' ')}</div></div>
                  </details>
                ); })}
              </div>
            )}
          </div>
        ); })}
      </>
    );
  };

  // ── Master Observatory · the expandable BODY of one timeline stage (uniform shell: inputs → transformation →
  //    reasoning → output → diff → confidence → counterfactuals → verification, per what the stage actually has) ──

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-50 text-[13px] text-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="font-bold text-gray-900 text-[15px]">{title || '📊 Profile & Requirement Enrichment Analysis'}</h2>
          <span className="text-gray-400">GLID {glid || '—'}</span>
          {ledger && <span className="text-[11px] text-gray-400">· v{ledger.timeline[ledger.timeline.length - 1]?.version ?? 1} · {ledger.decisions.length} decisions · {ledger.facts.length} facts</span>}
        </div>
        <div className="flex items-center gap-3">
          {/* 3-LEVEL view (Business / AI / System) — vestigial in V10 (gates only the rare decision drill); hidden behind SHOW_LEVEL_TABS, level stays 'system' = full depth */}
          {SHOW_LEVEL_TABS && (
            <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 text-[11px] font-semibold">
              {(['business', 'ai', 'system'] as const).map((lv) => (<button key={lv} onClick={() => setLevel(lv)} className={`rounded-md px-2 py-1 capitalize transition ${level === lv ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{lv === 'business' ? '👔 Business' : lv === 'ai' ? '🤖 AI' : '⚙️ Raw'}</button>))}
            </div>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm rounded-full border border-gray-200 px-3 py-1">✕ close</button>
        </div>
      </div>

      {/* V10: the L1–L7 Ledger is the sole view (legacy Observatory/Twin/System tabs retired — the extract twin is the one authority). */}
      {ledger && (
        <div className="flex items-center px-5 py-1.5 border-b border-gray-200 bg-white shrink-0 text-[12px] font-semibold">
          <span className="rounded-lg px-3 py-1 bg-teal-50 text-teal-700 border border-teal-200">📊 Profile & Requirement Enrichment</span>
        </div>
      )}

      {/* Evolution strip (Step 5) — every event = a NEW ledger version; simulate shows "why NOT used" live */}
      {ledger && (
        <div className="px-5 py-1.5 border-b border-gray-100 bg-gray-50 flex items-center gap-2 text-[11px] shrink-0 overflow-x-auto">
          <span className="text-gray-400 shrink-0">🔁 evolution:</span>
          {ledger.timeline.map((t, i) => (<span key={i} className="text-gray-600 shrink-0">v{t.version} <span className="text-gray-400">({t.trigger})</span>{i < ledger.timeline.length - 1 ? ' →' : ''}</span>))}
          <span className="flex-1" />
          <button onClick={() => { if (ledger) { setPrevLedger(ledger); setLedger(evolveLedger(ledger, { type: 'product', value: 'diesel generator', relatedToHistory: false })); } }} className="shrink-0 rounded-full border border-indigo-200 text-indigo-700 px-2 py-0.5 hover:bg-indigo-50">▶ simulate off-profile product</button>
          <button onClick={() => { setPrevLedger(null); setLedger(raw ? buildLedger(withObservedExternal(raw)) : null); }} className="shrink-0 rounded-full border border-gray-200 text-gray-500 px-2 py-0.5 hover:bg-gray-100">↺ reset</button>
        </div>
      )}

      {/* E · REPLAY — Run A vs Run B diff (shown after an evolve) */}
      {ledger && prevLedger && (() => { const d = diffLedgerVersions(prevLedger, ledger); return (
        <div className="px-5 py-1.5 border-b border-amber-100 bg-amber-50/60 text-[11px] shrink-0 overflow-x-auto">
          <b className="text-amber-700">🔁 Replay v{prevLedger.timeline[prevLedger.timeline.length - 1]?.version} → v{ledger.timeline[ledger.timeline.length - 1]?.version}:</b>{' '}
          {d.changed.map((c, i) => <span key={i} className="text-gray-600">{c.key}.{c.field} {c.from}→{c.to}{i < d.changed.length - 1 ? ' · ' : ''}</span>)}
          {d.consumptionFlips.map((f, i) => <span key={'f' + i} className="text-rose-600"> · {f.key}→{f.consumer}: {f.from}→{f.to} ({f.reason})</span>)}
          {!d.changed.length && !d.consumptionFlips.length && <span className="text-gray-400">no change</span>}
          {(ledger.timeline[ledger.timeline.length - 1]?.because || []).map((b, i) => <div key={'why' + i} className="text-gray-500 mt-0.5">↳ {b}</div>)}
        </div>
      ); })()}

      {(loading || pullFinishing) && <StagedLoader glid={glid} complete={!loading} />}
      {!loading && buildError && <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"><div className="text-rose-600 font-semibold">⚠ Couldn't build the ledger from this pull</div><div className="text-[12px] text-gray-500 max-w-md">{buildError}</div><div className="text-[11px] text-gray-400">The raw pull is on <code>window.__enrichment</code> / <code>window.__ledgerError</code> for diagnosis — the screen no longer blanks.</div></div>}
      {!loading && !buildError && !ledger && <div className="flex-1 flex items-center justify-center text-gray-400">No buyer data. Pull a GLID first.</div>}

      {/* ═══ 📋 L1–L7 LEDGER — the "no black box" stack: nodes → signals → LLM input → prompt → output → UC1 → UC2 → UC3 ═══ */}
      {ledger && !pullFinishing && tab === 'ledger' && (() => {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        // L1 · nodes & health
        const health = getEnrichmentHealth().map((h) => ({ node: h.node, ok: h.ok, latency_ms: h.latency_ms, output_count: h.output_count, source: h.source }));
        // L1 coverage TRUTH (V10 #8): the dead-ledger "used/ignored" measured the retired arithmetic path. The honest number
        // is what the ONE extract LLM actually SAW (bundle.evidence sent) → what it CITED (finals[].llm.reasoning[].evidence),
        // with structural plumbing (ids, timestamps, parse flags) excluded from the denominator so "ignored" isn't inflated by noise.
        const PLUMBING = /(execution[_-]?ms|cityid|stateid|country_iso|unique_id|fcp_flag|logincount|credits|txn_id|parse_ok|parse_error|datetime|\bfk_|_id$)/i;
        const sentEv = synthCtx?.bundle.evidence || [];
        const citedIds = new Set(finals.flatMap((f) => (f.llm?.reasoning || []).flatMap((r) => r.evidence || [])));
        const covByNode = new Map<string, { label: string; sent: number; cited: number }>();
        let covNoise = 0;
        for (const e of sentEv) {
          if (PLUMBING.test(e.tag)) { covNoise++; continue; }
          const row = covByNode.get(e.node) || { label: e.node, sent: 0, cited: 0 };
          row.sent++; if (citedIds.has(e.evidence_id)) row.cited++;
          covByNode.set(e.node, row);
        }
        const sources = [...covByNode.values()].sort((a, b) => b.cited - a.cited || b.sent - a.sent);
        const covLLM = { sent: sources.reduce((s, r) => s + r.sent, 0), cited: sources.reduce((s, r) => s + r.cited, 0), noise: covNoise };
        const endpoint = N8N_HOOK; // single hook now (api.ts) — L1 label reflects the one path every pull uses
        // L2 · readable buyer signals
        const channels: SignalChannel[] = [];
        if (waConvo?.inbound.total) channels.push({ key: 'wa-in', label: `📲 WhatsApp (${waConvo.inbound.buyerMsgs} buyer · ${waConvo.inbound.platformMsgs} ours)`, count: waConvo.inbound.total, tone: 'sky', sample: waConvo.inbound.messages.find((m) => m.side === 'buyer' && m.text && m.text.length > 4)?.text, body: (
          <div>
            <div className="space-y-1">{waConvo.inbound.messages.map((m, i) => (
              <div key={i} className={`flex ${m.side === 'buyer' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[82%] rounded-lg px-2 py-1 text-[10.5px] ${m.side === 'buyer' ? 'bg-sky-100 text-sky-900' : 'bg-gray-100 text-gray-500'}`}>
                  <div className="flex items-center gap-1 text-[8.5px] uppercase tracking-wide opacity-60">{m.side === 'buyer' ? 'buyer' : 'ours'}{(m.kind === 'enquiry' || m.kind === 'clicked') && <span className="px-1 rounded bg-white/70 normal-case">{m.kind === 'clicked' ? 'tap' : 'enquiry'}</span>}{m.ts && <span className="font-mono normal-case">{m.ts}</span>}</div>
                  <div className="break-words">{m.text}</div>
                </div>
              </div>
            ))}</div>
            {waConvo.meta?.buttonTaps && waConvo.meta.buttonTaps.length > 0 && <div className="mt-1.5 pt-1 border-t border-gray-200 text-[10px]"><span className="text-gray-400">button taps: </span>{waConvo.meta.buttonTaps.map((t, i) => <span key={i} className="text-[9.5px] px-1 rounded bg-sky-50 text-sky-700 border border-sky-200 mr-1">{t}</span>)}</div>}
            {waConvo.meta?.productsEnquired && waConvo.meta.productsEnquired.length > 0 && <div className="mt-1 text-[10px]"><span className="text-gray-400">products enquired: </span><span className="text-gray-600">{waConvo.meta.productsEnquired.join(' · ')}</span></div>}
            {waConvo.signals.length > 0 && <div className="mt-1 pt-1 border-t border-gray-200 flex flex-wrap gap-1">{waConvo.signals.map((s, i) => (<span key={i} className="text-[9.5px] px-1 rounded bg-sky-50 text-sky-700 border border-sky-200">{s.label}: {s.value}</span>))}</div>}
          </div>
        ) });
        if (waConvo?.outbound.total) channels.push({ key: 'wa-out', label: '📤 WhatsApp · ours', count: waConvo.outbound.total, tone: 'slate', body: (<div className="space-y-0.5">{waConvo.outbound.messages.map((m, i) => (<div key={i} className="text-[10.5px] text-gray-500">{m.text}</div>))}</div>) });
        if (pnsCards.length) channels.push({ key: 'pns', label: '📞 PNS calls', count: pnsCards.length, tone: 'violet', sample: pnsCards[0]?.summary, body: (<div className="space-y-1">{pnsCards.map((c, i) => (<div key={i} className="rounded border border-gray-200 p-1.5"><div className="text-[10px] font-semibold text-gray-600">{c.call}{c.intent ? ` · intent ${c.intent}` : ''}{c.persona ? ` · ${c.persona}` : ''}</div>{c.summary && <div className="text-[10.5px] text-gray-500 mt-0.5">{c.summary}</div>}{c.signals.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{c.signals.map((s, j) => (<span key={j} className="text-[9px] px-1 rounded bg-violet-50 text-violet-700 border border-violet-200">{s.label}: {s.value}</span>))}</div>}</div>))}</div>) });
        if (requirements.length) { const activeCt = requirements.filter((r) => !r.isExpired).length; channels.push({ key: 'rfq', label: `📑 Prev Requirements / BLs (${activeCt} active · ${requirements.length - activeCt} expired)`, count: requirements.length, tone: 'emerald', sample: requirements.map((r) => r.title).slice(0, 3).join(' · '), body: (<div className="space-y-1">{requirements.map((r, i) => { const rState = r.isExpired ? 'Stale' : (r.recencyDays != null ? (r.recencyDays <= 15 ? 'Fresh' : r.recencyDays <= 45 ? 'Moderate' : 'Stale') : null); return (<div key={i} className="rounded border border-gray-200 p-1.5"><div className="flex items-start gap-2"><span className="flex-1 min-w-0 text-[10.5px] font-semibold text-gray-700 break-words">{r.title}</span>{rState && <StatePill state={rState} />}{r.isExpired && <span className="text-[8.5px] px-1 rounded border bg-rose-50 text-rose-600 border-rose-200 shrink-0">EXPIRED</span>}</div>{(r.category || r.posted || r.expiry || r.recencyDays != null) && <div className="text-[9.5px] text-gray-400 flex flex-wrap gap-x-2 mt-0.5">{r.category && <span>{r.category}</span>}{r.posted && <span>· posted {r.posted}</span>}{r.expiry && <span>· exp {r.expiry}</span>}{r.recencyDays != null && <span>· {r.recencyDays}d old</span>}</div>}{r.specs.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{r.specs.map((s, j) => (<span key={j} className="text-[9px] px-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{s.k}: {s.v}</span>))}</div>}{r.description && <div className="text-[10px] text-gray-500 mt-0.5 italic">“{r.description}”</div>}{r.buyerNotes.filter((n) => n !== r.description).map((n, j) => (<div key={j} className="text-[10px] text-gray-500 mt-0.5 italic">“{n}”</div>))}</div>); })}</div>) }); }
        if (external?.present) channels.push({ key: 'ext', label: '🛡 External (Befisc / Sign3)', count: external.count, tone: 'amber', body: (<div className="space-y-0.5">{[...external.befisc, ...external.sign3].map((f, i) => (<div key={i} className="flex justify-between gap-2 text-[10.5px]"><span className="text-gray-400">{f.label} <span className="text-gray-300">· {f.source}</span></span><span className="text-gray-700">{f.value}</span></div>))}</div>) });
        // L3 · LLM input (the ONE extract call — system + user are two parts of it)
        const richResp = getEnrichmentRich() as { sources?: Record<string, unknown>; source_registry?: Record<string, Record<string, unknown>>; source_priority?: Record<string, unknown> } | null;
        const rawIO = getLLMRaw();
        const io = rawIO['extractBuyerProfile'];
        const catalog: CatalogRow[] = (synthCtx?.bundle.catalog || []).map((c) => { const lines = (synthCtx?.bundle.evidence || []).filter((e) => e.node === c.node); return { node: c.node, label: SOURCE_LABEL[c.node as SourceNode] || c.node, sent: lines.length, transform: c.transform, evidence: lines.map((e) => ({ id: e.evidence_id, tag: e.tag, raw: e.raw })) }; });
        const reg = richResp?.source_registry || null;
        const sourceGuideNode = reg ? (
          <div className="text-[10px] space-y-1">
            {Object.entries(reg).map(([k, vv]) => { const v = vv as Record<string, unknown>; const inf = ['persona', 'intent', 'requirement_generation', 'trust_score'].filter((d) => v[`should_influence_${d}`] === true).map((d) => d.replace('_generation', '').replace('_score', '')).join('/'); return (<div key={k}><b className="text-gray-700">{SOURCE_LABEL[k as SourceNode] || k}</b> <span className="text-gray-400">[trust {String(v.trust_level || '?')}]{v.observed_only ? ' · observed-only (corroboration, never primary intent)' : ''}</span><div className="text-gray-500">{String(v.purpose || v.description || '')}</div><div className="text-gray-400">influences: {inf || 'none'}</div></div>); })}
          </div>
        ) : <div className="text-[10px] text-gray-400">No source_registry on this pull (legacy path).</div>;
        // L5 · output
        const outAttrs: OutAttr[] = finals.map((f) => { const held = heldAttr(f); return { key: f.key, label: f.label, value: f.value, group: f.group, state: f.state, confidence: Math.round(f.confidence || 0), provenance: f.provenance, grounded: f.llm?.grounded, held, heldReason: held ? heldReason(f) : undefined }; });
        const ev = finals.length ? synthEval(finals) : null;
        const evalRows: EvalRow[] = ev ? [{ label: 'grounded %', score: ev.groundedPct }, { label: 'avg conf', score: ev.avgConfidence }] : [];
        const l5status = msynth.status === 'done' ? 'done' : msynth.status === 'loading' ? 'loading…' : msynth.status === 'no-key' ? 'no key' : msynth.status === 'error' ? 'error' : '…';
        // L6 · offer enrichment — each field carries a reasoning/evidence drill
        const offerFieldDrill = (f: { llmReason?: string; method?: string; confidence?: number; grounded?: boolean; action: string }): ReactNode => (f.llmReason || f.method) ? (<div className="text-[10px] text-gray-600">{f.llmReason || f.method}{f.confidence != null ? ` · conf ${f.confidence}` : ''}{f.grounded ? <span className="text-emerald-600"> · grounded</span> : f.action !== 'kept' ? <span className="text-rose-500"> · ungrounded ⚠</span> : null}</div>) : undefined;
        const offerFields: OfferFieldRow[] = [];
        if (offerResult) {
          for (const f of [offerResult.title, offerResult.location, offerResult.quantity]) if (f) offerFields.push({ label: f.label, before: f.raw, after: f.corrected, action: f.action, drill: offerFieldDrill(f) });
          for (const s of offerResult.specs) offerFields.push({ label: s.label, before: s.raw, after: s.corrected, action: s.deduced && s.action === 'kept' ? 'kept' : s.action, drill: offerFieldDrill(s) });
          for (const s of offerResult.dropped) offerFields.push({ label: s.label, before: s.raw, after: '', action: 'dropped', drill: offerFieldDrill(s) });
        }
        const offerPicker = requirements.length > 1 ? (
          <select value={offerIdx} onChange={(e) => setSampleOfferIdx(Number(e.target.value))} className="text-[11px] rounded px-1.5 py-1 bg-white/95 text-gray-700 border-0 max-w-[240px]">
            {requirements.map((r, i) => (<option key={i} value={i}>{r.title}{r.isExpired ? ' (expired)' : ''}</option>))}
          </select>
        ) : undefined;
        const enrichControl = enrichMode !== 'offer' ? <button type="button" onClick={() => setEnrichMode('offer')} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700">▶ enrich (LLM)</button> : undefined;
        // L7 · requirement enrichment (requirement_brain → the subtraction math)
        const reqBrain = parseRequirementBrain(raw);
        const isqNames = [...new Set(requirements.flatMap((r) => r.specs.map((s) => s.k)))];
        const resolved = resolveRequirement(reqBrain, { isqSpecNames: isqNames, answeredSpecNames: [], intentKnown: !!pnsCards.find((c) => c.intent) });
        const droppedSet = new Set(resolved.knownDropped.map(norm).concat(resolved.knownInSchema.map(norm)));
        const reqRows: ReqRow[] = resolved.criticalRanked.map((c) => { const freq = c.seller_frequency ?? 0; const key = c.name || c.maps_to_isq || ''; const suppressed = droppedSet.has(norm(c.maps_to_isq || c.name || '')); return { key, value: freq ? `${freq}% sellers ask` : undefined, reasoning: `category critical${c.maps_to_isq ? ` (maps to ISQ "${c.maps_to_isq}")` : ''} — seller-frequency ${freq || '?'}%`, suppressed, suppressionReason: suppressed ? 'buyer already provided this — guardrail dropped it' : undefined, categoryState: stateFromFrequency(freq) }; });
        const reqDropped = resolved.knownDropped.map((k) => ({ key: k, reason: 'already known (buyer memory)' }));
        const reqCoverage = { rfq_keys: resolved.criticalRanked.length, matched_buyer: resolved.knownInSchema.length, matched_category: resolved.criticalRanked.length, suppressed: resolved.knownDropped.length };
        // ── L0 · LLM run strip — every model call THIS pull (latest per label), tokens, cost ──
        const LEDGER_LABELS = ['extractBuyerProfile', 'twinPrune', 'offerEnrich', 'uc2Enrich'];
        const lastByLabel = new Map<string, ReturnType<typeof getLLMHealth>[number]>();
        for (const r of getLLMHealth()) if (LEDGER_LABELS.includes(r.label)) lastByLabel.set(r.label, r);
        const l0calls = [...lastByLabel.values()].map((r) => ({ label: r.label, model: r.model, in: r.promptTokens || 0, out: r.completionTokens || 0, reasoning: r.reasoningTokens || 0, costUsd: r.costUsd || 0, ms: r.ms || 0, ok: r.ok }));
        const l0totals = { calls: l0calls.length, in: l0calls.reduce((s, c) => s + c.in, 0), out: l0calls.reduce((s, c) => s + c.out, 0), reasoning: l0calls.reduce((s, c) => s + c.reasoning, 0), costUsd: l0calls.reduce((s, c) => s + c.costUsd, 0), ms: l0calls.reduce((s, c) => s + c.ms, 0), grounded: ev?.groundedPct, verdict: ev?.verdict };
        const extractCost = l0calls.find((c) => c.label === 'extractBuyerProfile')?.costUsd;
        // L5 · eval drill (why the scores) + prune visibility
        const ungroundedAttrs = finals.filter((f) => f.llm && !f.llm.grounded);
        const lowConfAttrs = finals.filter((f) => (f.confidence || 0) < 50);
        const evalDetail = ev ? (
          <div className="text-[10.5px] space-y-1">
            <div className="text-gray-600">verdict <b>{ev.verdict}</b> · grounded {Math.round(ev.groundedPct)}% ({ev.grounded}/{ev.llmDecided} LLM attrs) · avg conf {Math.round(ev.avgConfidence)} · changed {ev.changed} · new {ev.llmNew}</div>
            {ungroundedAttrs.length > 0 && <div><span className="text-rose-500">ungrounded ({ungroundedAttrs.length}):</span> <span className="text-gray-600">{ungroundedAttrs.map((f) => f.label).join(', ')}</span></div>}
            {lowConfAttrs.length > 0 && <div><span className="text-amber-600">low-confidence ({lowConfAttrs.length}):</span> <span className="text-gray-600">{lowConfAttrs.map((f) => `${f.label} ${Math.round(f.confidence || 0)}%`).join(', ')}</span></div>}
            {ungroundedAttrs.length === 0 && lowConfAttrs.length === 0 && <div className="text-emerald-600">all shown attributes grounded and ≥50% confident.</div>}
          </div>
        ) : null;
        const pruneInfo = { kept: finals.length, of: rawFinals.length, status: prune.status };
        // harness coverage + eval-over-time (drift by prompt-version)
        const evRuns = getEvalRuns(); const evTrendD = evRuns.length ? evalTrend(evRuns) : null;
        const HARNESS_SUITES = [
          { name: 'extracttest', checks: 'bundleFromResponse · evidence composers · extractedToFinals · grounding' },
          { name: 'reqtest', checks: 'requirement stitch (BL ⨝ ISQ) + v10.1 requirementsFromMerged' },
          { name: 'whatsapptest', checks: 'two-channel timeline + waFromMerged (side/kind/meta)' },
          { name: 'synthtest', checks: 'merged synthesis engine + synthEval' },
          { name: 'rfqevalstest', checks: 'evaluateRFQ scorers (question/intent/category/lead/outcome)' },
          { name: 'identitytest', checks: 'identity resolution (PAN entity · GST state · agreement)' },
          { name: 'externaltest', checks: 'Befisc/Sign3 external card' },
          { name: 'uc2evaltest', checks: 'UC2 enrichment — grounding gate · hallucination/leak · verdict honesty' },
          { name: 'evallogtest', checks: 'eval persistence + drift-by-version' },
        ];
        const harnessNode = (
          <div className="text-[10.5px] space-y-1">
            {evTrendD ? <div className="text-gray-600">eval runs logged: <b>{evTrendD.runs}</b> · avg system {Math.round(evTrendD.avgSystem)}% · last {Math.round(evTrendD.lastSystem)}% · {evTrendD.regression ? <span className="text-rose-600">⚠ regression vs first run</span> : <span className="text-emerald-600">stable / improving</span>}</div> : <div className="text-gray-400">No eval runs logged in this browser yet (run the offline harness to populate the rolling log).</div>}
            <div className="text-gray-400 mt-1">offline suites — run via <span className="font-mono">node scripts/&lt;name&gt;.mjs</span> (Node-side, not in this view):</div>
            {HARNESS_SUITES.map((h) => (<div key={h.name} className="flex gap-2"><span className="font-mono text-slate-600 w-28 shrink-0">{h.name}</span><span className="text-gray-500">{h.checks}</span></div>))}
          </div>
        );
        // ── L6 · Buylead Details (selected requirement) + Buyer Details (identity ⊕ external, verified ticks) ──
        const selReq = requirements[offerIdx] || null;
        const idn = identityFromMerged(richResp);
        const ext = externalFromMerged(richResp);
        const availability: L6Availability[] = resolveAvailable(idn, ext);
        if ((waConvo?.inbound.buyerMsgs ?? 0) > 0) availability.push({ key: 'whatsapp', label: 'WhatsApp', present: true, verified: true, value: `${waConvo!.inbound.buyerMsgs} buyer message${waConvo!.inbound.buyerMsgs === 1 ? '' : 's'}`, source: 'WhatsApp timeline', note: 'buyer actively messaged on WhatsApp (live channel)' });
        const humanizeSince = (s?: string): string | undefined => { if (!s) return undefined; const t = /^\d{4}$/.test(s.trim()) ? Date.parse(`${s.trim()}-01-01`) : Date.parse(s); if (isNaN(t)) return s; const yrs = (Date.now() - t) / (365.25 * 24 * 3600 * 1000); if (yrs >= 1) { const y = Math.floor(yrs); return `${y}+ year${y === 1 ? '' : 's'}`; } const m = Math.max(0, Math.round(yrs * 12)); return m >= 1 ? `${m} month${m === 1 ? '' : 's'}` : 'new (this year)'; };
        const poiAttr = finals.find((f) => f.key === 'products_of_interest') || null;
        const poiChanged = !!(poiAttr && selReq?.category && !norm(poiAttr.value).includes(norm(selReq.category)));
        // owner: Products of Interest = max 3, product NAMES only (strip any "(…)" spec parentheticals)
        const poiNames = (poiAttr?.value || '').split(/[,;]/).map((s) => s.replace(/\([^)]*\)/g, '').trim()).filter(Boolean).slice(0, 3);
        const productsOfInterest = poiAttr ? { value: poiNames.join(', '), changed: poiChanged, drill: finalAttrDetail(poiAttr) } : null;
        // location is clickable → reveals the location_sourcing_preference deduction (so it's NOT repeated as a profile row)
        const locAttr = finals.find((f) => f.key === 'location_sourcing_preference') || null;
        const locationDrill = locAttr ? finalAttrDetail(locAttr) : undefined;
        // Location CORRECTION (owner): when the AI's deduced OPERATING city differs from the recorded BuyLead location,
        // strike the recorded and show the operating city — the recorded value was really a sourcing/registration city.
        const recordedLoc = idn ? ([idn.city, idn.state].filter(Boolean).join(', ') || '') : '';
        const operatingCity = (locAttr?.value.match(/operates in\s+([^·|]+)/i)?.[1] || '').trim().replace(/[.;]+$/, '');
        const locationCorrected = (operatingCity && recordedLoc && norm(operatingCity) !== norm(recordedLoc) && !norm(operatingCity).includes(norm(idn?.city || ' ')))
          ? { from: recordedLoc, to: operatingCity } : undefined;
        const titleDrill = selReq ? (<div className="text-[10.5px] text-gray-600 space-y-0.5">{selReq.offerId && <div>offer id: <span className="font-mono">{selReq.offerId}</span></div>}{selReq.status && <div>status: {selReq.status}{selReq.isExpired ? ' (expired)' : ''}</div>}{selReq.posted && <div>posted: {selReq.posted}</div>}{selReq.expiry && <div>expiry: {selReq.expiry}</div>}{selReq.recencyDays != null && <div>age: {selReq.recencyDays}d</div>}{selReq.category && <div>category: {selReq.category}{selReq.categoryId ? ` (#${selReq.categoryId})` : ''}</div>}{selReq.orderValue && <div>probable order value: {selReq.orderValue} <span className="text-gray-400">(system-deduced)</span></div>}{selReq.requirementType && <div>requirement type: {selReq.requirementType} <span className="text-gray-400">(system-deduced)</span></div>}{selReq.productOrService && <div>type: {selReq.productOrService}</div>}{selReq.verified != null && selReq.verified !== '' && <div>verified flag: {selReq.verified}</div>}{selReq.queryId && <div>query id: <span className="font-mono">{selReq.queryId}</span></div>}</div>) : undefined;
        // V11 — LLM-derived (>1 source) buyer-profile rows. Headline is the VALUE ONLY; confidence% + LLM badge show
        // ON CLICK (finalAttrDetail drill). identity_confidence + digital_footprint are NOT here (id-conf renders below
        // Available; digital_footprint/social-presence dropped per owner — not useful, data is presence-only).
        const PROFILE_KEYS = ['business_persona', 'buyer_maturity', 'sub_industry', 'buyer_intent', 'scale', 'price_vs_quality', 'procurement_model', 'purchase_frequency', 'communication', 'delivery_timeline', 'urgency', 'payment_mode', 'digital_footprint'];
        const llmRows: L6ProfileRow[] = PROFILE_KEYS.map((k) => finals.find((f) => f.key === k)).filter((f): f is NonNullable<typeof f> => !!f).map((f) => ({ label: f.label, value: f.value, drill: finalAttrDetail(f), prov: 'llm' as const }));
        // identity_confidence → its OWN row right below the Available block (trust signal about the anchors). % on click.
        const idConfAttr = finals.find((f) => f.key === 'identity_confidence') || null;
        const identityConfidence = idConfAttr ? { value: idConfAttr.value, drill: finalAttrDetail(idConfAttr) } : undefined;
        // DETERMINISTIC identity anchors → into the AVAILABLE block (owner) with ✓ (profile) / ✓✓ (cross-source) ticks.
        const resolvedName = resolveBuyerName(idn, ext);
        const gstFetched = (() => { const r = getEnrichmentRich() as { derived_anchors?: { gst?: string }; sources?: { gst?: { summary?: { gst?: string; gsts?: string[]; gst_count?: number } } } } | null; const sg = r?.sources?.gst?.summary; return { gst: String(r?.derived_anchors?.gst || sg?.gst || ''), gsts: Array.isArray(sg?.gsts) ? sg!.gsts! : [], count: sg?.gst_count || 0 }; })();
        const idnForDocs = (idn || gstFetched.gst) ? ({ emails: [], mobiles: [], ...(idn || {}), gst: (idn?.gst || gstFetched.gst) || undefined } as typeof idn) : idn;
        const docs = decodeIdentityDocs(idnForDocs, ext, resolvedName?.name);
        if (resolvedName) availability.push({ key: 'name', label: 'Name', present: true, verified: resolvedName.confidence >= 85, value: resolvedName.name, source: resolvedName.source, note: `${resolvedName.full ? 'full name' : 'first name only'} · ${resolvedName.confidence}% (${resolvedName.source})` });
        if (docs.pan) availability.push({ key: 'pan', label: 'PAN', present: true, verified: docs.pan.nameMatch === 'match', value: `${docs.pan.pan} · ${docs.pan.entityType}${docs.pan.nameMatch !== 'unknown' ? ` · surname ${docs.pan.nameMatch}` : ''}${docs.panDuplicate ? ' · ⚠ 2 distinct PANs' : ''}`, source: 'Befisc / identity', note: `4th char "${docs.pan.entityChar}" → ${docs.pan.entityType}; format ${docs.pan.valid ? 'valid' : 'invalid'}` });
        if (docs.gst) availability.push({ key: 'gst', label: 'GST', present: true, verified: true, value: `${docs.gst.gstin} · ${docs.gst.state} · ${docs.gst.entityType}${gstFetched.count > 1 ? ` (+${gstFetched.count - 1} more)` : ''}`, source: 'Mobile/Email→GST', note: `state ${docs.gst.stateCode} → ${docs.gst.state}; embedded PAN ${docs.gst.pan}` });
        // de-dup by key — prefer the POPULATED row (resolveAvailable may carry an empty pan/gst placeholder)
        const availMap = new Map<string, L6Availability>(); for (const a of availability) { const ex = availMap.get(a.key); if (!ex || (!ex.present && a.present) || (a.present && a.value && !ex.value)) availMap.set(a.key, a); }
        const availFinal = [...availMap.values()];
        // GST Verified ribbon badge — present ONLY when the GST node returned a decodable GSTIN (else hidden).
        const gstVerified = docs.gst ? { gstin: docs.gst.gstin, state: docs.gst.state, entity: docs.gst.entityType, count: gstFetched.count || gstFetched.gsts.length || 1, list: gstFetched.gsts.length ? gstFetched.gsts : [docs.gst.gstin] } : null;
        // Q76 — "still ask": frozen buyer questions NOT deduced (LLM omitted = couldn't ground) or below-confidence → ask the buyer.
        const ASK_LABELS: Record<string, string> = { business_persona: 'Buyer Persona', buyer_maturity: 'Buyer Maturity', buyer_intent: 'Buyer Intent', procurement_model: 'Procurement Model', purchase_frequency: 'Purchase Frequency', price_vs_quality: 'Price vs Quality', communication: 'Communication', delivery_timeline: 'Delivery Timeline', payment_mode: 'Payment Mode', location_sourcing_preference: 'Location & Sourcing' };
        const stillAsk = Object.keys(ASK_LABELS).filter((k) => { if (k === 'delivery_timeline') return !finals.some((f) => f.key === 'delivery_timeline' || f.key === 'urgency'); const f = finals.find((x) => x.key === k); return !f || (f.confidence ?? 0) < 60; }).map((k) => ASK_LABELS[k]);
        // DETERMINISTIC profile rows that stay on the right (NOT identity anchors): purchasing power only. Detail on click.
        const detRows: L6ProfileRow[] = [];
        if (ext?.incomeBand) detRows.push({ label: 'Purchasing power', value: ext.incomeBand, prov: 'det', drill: (<div className="text-[10.5px] text-gray-600">{ext.incomeBand} — deterministic, Befisc income (single source). No LLM reasoning.</div>) });
        const profileRows: L6ProfileRow[] = [...detRows, ...llmRows];
        const ageGender = [ext?.age && `${ext.age}y`, ext?.gender].filter(Boolean).join(' · ') || undefined; // own row between Response & Available (owner)
        const ageGenderDrill = ageGender ? (
          <div className="text-[10.5px] text-gray-600 space-y-0.5">
            <div className="font-semibold text-gray-800">{ageGender}</div>
            <div><span className="text-gray-400">how it's known: </span>deterministic — read straight from the paid external identity lookup (Befisc). A single verified source, passed through as-is; this is not an LLM guess.</div>
            <div><span className="text-emerald-600">to reach full confidence: </span>a second independent source confirming the same age/gender.</div>
          </div>
        ) : undefined;
        const buyerDetails = (idn || profileRows.length || availFinal.length) ? { name: resolvedName?.name || idn?.name, memberSince: humanizeSince(idn?.memberSince), responseCalls: pnsCards.length, responseReplies: waConvo?.inbound.buyerMsgs ?? 0, ageGender, ageGenderDrill, availability: availFinal, identityConfidence, profileRows } : null;
        const selectedReqCard = selReq ? { title: selReq.title, posted: selReq.posted, expiry: selReq.expiry, status: selReq.status, isExpired: selReq.isExpired, recencyDays: selReq.recencyDays, category: selReq.category, location: idn ? ([idn.city, idn.state].filter(Boolean).join(', ') || undefined) : undefined, specs: selReq.specs, specsStatus: selReq.specsStatus, buyerInfo: selReq.buyerInfo, commercials: selReq.commercials } : null;
        const offerEvalCard = offerResult ? { groundedPct: offerResult.eval.groundedPct, hallucinations: offerResult.eval.hallucinations, verdict: offerResult.eval.verdict } : null;
        // UC2 · requirement enrichment/correction (base truth → AI-enriched). REAL grounded LLM path when a key is
        // present (uc2Result.enrichment); deterministic dummy fallback otherwise (no key / call failed/pending).
        // Rich drill for a UC2 edit (mirrors finalAttrDetail): clean value · confidence chip · reason · evidence chips
        // (each clickable to its raw fN line + jump-to-prompt). This is what each LEFT-column enriched spec expands to.
        const uc2EditDrill = (e: UC2EditFull): ReactNode => (
          <div className="text-[11px] space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-800">{e.to || '—'}</span>
              {confidenceChip(e.confidence, true, e.confidenceReason, e.to100)}
              <span className="text-[8px] uppercase font-bold tracking-wide px-1 py-px rounded border text-violet-700 bg-violet-50 border-violet-200">LLM</span>
              {!e.grounded && <span className="text-[9px] text-rose-500" title="no matching evidence">⚠ ungrounded</span>}
            </div>
            {e.reason && <div className="text-gray-600 leading-snug">{e.reason}</div>}
            {e.evidence.length > 0 && (
              <details>
                <summary className="cursor-pointer list-none text-[9.5px] text-indigo-400 hover:text-indigo-600">{e.evidence.length} source{e.evidence.length === 1 ? '' : 's'} ▾</summary>
                <div className="mt-1 ml-2 flex flex-wrap gap-1">
                  {e.evidence.map((ev) => (
                    <details key={ev.evidence_id} className="inline-block align-baseline">
                      <summary className="cursor-pointer list-none inline-flex items-baseline gap-0.5 rounded px-1 text-[9.5px] text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700"><span className="font-mono">[{ev.evidence_id}]</span><span className="text-gray-400">{ev.node}</span><span>▾</span></summary>
                      <div className="mt-0.5 rounded bg-indigo-50/70 border border-indigo-200 p-1.5 text-[10px] text-gray-700 not-italic font-normal">
                        <div className="text-gray-500">{ev.node}{ev.tag ? <span className="text-gray-400"> · {ev.tag}</span> : null}</div>
                        <div className="font-mono text-gray-800 break-words mt-0.5">“{ev.raw}”</div>
                        <button type="button" onClick={() => jumpToFact(ev.evidence_id)} className="mt-1 text-[9px] text-indigo-400 hover:text-indigo-600 hover:underline">↗ jump to this line in the prompt (L3)</button>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
        const uc2 = (() => {
          const base = uc2Result ? uc2Result.enrichment : (selReq ? buildUC2Enrichment({
            title: selReq.title, category: selReq.category,
            location: idn ? ([idn.city, idn.state].filter(Boolean).join(', ') || undefined) : undefined,
            specs: selReq.specs,
            addSpecs: ['Delivery Timeline', 'Payment Terms'], // generic procurement attrs (never category-specific)
            derivedCount: availability.filter((a) => a.present).length + profileRows.length + (productsOfInterest ? 1 : 0),
          }) : null);
          if (!base || !uc2Result) return base; // dummy fallback (no real edits) → no rich drills
          const edits = uc2Result.edits;
          const editFor = (group: string, field?: string) => edits.find((e) => e.group === group && e.applied && (field == null || norm(e.field) === norm(field)));
          // scalar fields (title/location/category) are only ever populated from a 'corrected' edit — match that kind so the drill describes the shown before→after
          const attach = <T extends { drill?: ReactNode }>(o: T | undefined, group: string): T | undefined => { if (!o) return o; const e = edits.find((x) => x.group === group && x.applied && x.kind === 'corrected'); return e ? { ...o, drill: uc2EditDrill(e) } : o; };
          return {
            ...base,
            specs: base.specs.map((s) => { const e = editFor('spec', s.k); return e && (s.kind === 'corrected' || s.kind === 'added') ? { ...s, drill: uc2EditDrill(e) } : s; }),
            title: attach(base.title, 'title'),
            location: attach(base.location, 'location'),
            category: attach(base.category, 'category'),
          };
        })();
        // P11 — PNS hero-signal coverage: which PNS price/qty/GSM/application/location lines were cited (consumed)
        // by the extract twin OR UC2 vs left unaccounted. Makes "PNS never silently dropped" measurable per pull.
        const pnsCoverage = (() => {
          const ev = synthCtx?.bundle.evidence || [];
          const HERO = /price|quantit|gsm|spec|applicat|deal_block|location|buyer_loc|persona|intent|product/i;
          const hero = ev.filter((e) => /PNS/i.test(e.node) && HERO.test(e.tag));
          if (!hero.length) return null;
          const cited = new Set<string>();
          for (const ff of finals) for (const s of (ff.llm?.reasoning || [])) for (const id of (s.evidence || [])) cited.add(id);
          for (const e of (uc2Result?.edits || [])) for (const ev2 of e.evidence) cited.add(ev2.evidence_id);
          const consumed = hero.filter((e) => cited.has(e.evidence_id)).length;
          return { consumed, unaccounted: hero.length - consumed, total: hero.length };
        })();
        // PER-REQUIREMENT enrichment debug — one block for EVERY requirement enriched this pull (owner: "more blocks as
        // I enrich more"). Each carries its own prompt input · output · applied/held edits · eval · tokens & cost.
        const enrichedReqs = Object.keys(uc2Map).map(Number).filter((i) => uc2Map[i] && uc2Map[i].status !== 'idle').sort((a, b) => a - b).map((i) => {
          const entry = uc2Map[i]; const ctx = uc2CtxFor(i);
          const result = (ctx && entry.out) ? mergeUC2LLM(ctx, entry.out) : null;
          const promptIO = ctx ? (() => { const pp = buildUC2Prompt(ctx); return { system: pp.system, user: pp.user }; })() : null;
          const usage = entry.usage ? { in: entry.usage.promptTokens, out: entry.usage.completionTokens, reasoning: entry.usage.reasoningTokens, ms: entry.usage.ms, costUsd: entry.costUsd } : null;
          return { idx: i, title: requirements[i]?.title || `Requirement #${i + 1}`, status: entry.status, result, promptIO, usage };
        });
        // ── L1 unified node model (owner: "every node in health will have raw what LLM saw, and our readable version") ──
        // Joins n8n __health (ok/latency/count) + rich.sources {summary, raw} + OUR humanised readable, on a canonical
        // node id. GST is included even though n8n emits no __health row for it (decoded from rich.sources.gst).
        const canonNode = (k: string): string => { const s = k.toLowerCase(); if (/gst/.test(s)) return 'gst'; if (/csl/.test(s)) return 'csl'; if (/req|buylead|isq|rfq/.test(s)) return 'requirement'; if (/whats|wa[-_]/.test(s)) return 'whatsapp'; if (/ident|profile|glusr/.test(s)) return 'identity'; if (/pns/.test(s)) return 'pns'; if (/ext|befisc|sign3/.test(s)) return 'external'; return s; };
        const NODE_LABEL: Record<string, string> = { requirement: 'Requirement · BuyLeads ⨝ ISQ', whatsapp: 'WhatsApp · one timeline', pns: 'PNS · sales calls (spoken)', identity: 'Identity · Profile ⊕ GLUSR', external: 'External · Befisc ⊕ Sign3', csl: 'CSL · on-site behaviour', gst: 'GST · Mobile/Email→GST (KYB)' };
        const NODE_ORDER = ['requirement', 'whatsapp', 'pns', 'identity', 'external', 'csl', 'gst'];
        const readableByNode: Record<string, ReactNode> = {};
        for (const c of channels) { const cn = canonNode(c.key); readableByNode[cn] = readableByNode[cn] ? (<div className="space-y-1.5">{readableByNode[cn]}{c.body}</div>) : c.body; }
        if (idn && !readableByNode['identity']) readableByNode['identity'] = (
          <div className="text-[10.5px] space-y-0.5">
            {idn.name && <div><span className="text-gray-400">name: </span>{idn.name}</div>}
            {idn.company && <div><span className="text-gray-400">company: </span>{idn.company}</div>}
            {(idn.city || idn.state) && <div><span className="text-gray-400">location: </span>{[idn.city, idn.state].filter(Boolean).join(', ')}</div>}
            {idn.memberSince && <div><span className="text-gray-400">member since: </span>{idn.memberSince}</div>}
            {idn.emails.length > 0 && <div><span className="text-gray-400">emails: </span>{idn.emails.join(', ')}</div>}
            {idn.mobiles.length > 0 && <div><span className="text-gray-400">mobiles: </span>{idn.mobiles.join(', ')}</div>}
          </div>
        );
        if (gstVerified) readableByNode['gst'] = (
          <div className="text-[10.5px] space-y-0.5">
            <div><b className="font-mono">{gstVerified.gstin}</b></div>
            <div className="text-gray-500">{gstVerified.state} · {gstVerified.entity}</div>
            {gstVerified.list.length > 1 && <div className="text-gray-400">all GSTINs: {gstVerified.list.join(', ')}</div>}
          </div>
        );
        const richSrcEntries = (richResp?.sources && typeof richResp.sources === 'object') ? Object.entries(richResp.sources as Record<string, unknown>) : [];
        const summaryByNode: Record<string, unknown> = {}; const rawByNode: Record<string, unknown> = {};
        for (const [k, node] of richSrcEntries) { const cn = canonNode(k); const n = (node && typeof node === 'object') ? node as Record<string, unknown> : {}; summaryByNode[cn] = 'summary' in n ? n.summary : node; if ('raw' in n) rawByNode[cn] = n.raw; }
        const healthByNode: Record<string, { ok: boolean; latency_ms?: number; output_count?: number }> = {};
        for (const h of health) healthByNode[canonNode(h.node)] = h;
        const seenNodes = new Set<string>();
        const nodeRows: L1NodeRow[] = [];
        for (const cn of [...NODE_ORDER, ...Object.keys(healthByNode), ...Object.keys(summaryByNode), ...Object.keys(rawByNode)]) {
          if (seenNodes.has(cn)) continue; seenNodes.add(cn);
          const h = healthByNode[cn]; const hasReadable = readableByNode[cn] != null; const hasSummary = cn in summaryByNode; const hasRaw = cn in rawByNode;
          if (!h && !hasReadable && !hasSummary && !hasRaw) continue;
          nodeRows.push({ key: cn, label: NODE_LABEL[cn] || cn, ok: h?.ok, latency_ms: h?.latency_ms, output_count: h?.output_count, readable: readableByNode[cn], summary: hasSummary ? summaryByNode[cn] : undefined, raw: hasRaw ? rawByNode[cn] : undefined });
        }
        return (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-gray-50/40">
            <div className="max-w-6xl mx-auto space-y-2.5">
              {/* L6 — the Buylead / Buyer card on TOP (the product). Everything else is the debug pipeline behind it. */}
              <L6Band picker={offerPicker} selectedReq={selectedReqCard} uc2={uc2} productsOfInterest={productsOfInterest} requirementCount={requirements.length} buyerDetails={buyerDetails} retailLead={selReq?.retailLead} titleDrill={titleDrill} locationDrill={locationDrill} locationCorrected={locationCorrected} fields={offerFields} offerEval={offerEvalCard} enrichControl={enrichControl} gstVerified={gstVerified} stillAsk={stillAsk} mode={cardMode} onMode={setCardMode} defaultOpen />
              {/* Debug ABOVE (owner) — everything else folds under ONE collapsed Debug container, in 4 clearly-grouped sections */}
              <Band code="Debug" title="Debug — how the profile & each requirement were built" subtitle="nodes · the buyer-profile LLM · per-requirement enrichment · web verify" tone="slate" defaultOpen={false}>
                <div className="space-y-2.5">
                  <div className="text-[11px] text-gray-400">The pipeline behind the card above — every step expands to its last raw line.</div>
                  <DebugGroup n="1" label="Nodes & Health — shared: every source raw · what the LLM saw · our readable view" />
                  <L1Band nodes={nodeRows} cov={covLLM} endpoint={endpoint} defaultOpen drill={SHOW_EVIDENCE_GRAPH ? <details className="mt-1"><summary className="cursor-pointer list-none text-[10.5px] text-slate-600">＋ evidence graph — every node → its facts (role · used/ignored · ladder)</summary><div className="mt-1 space-y-2">{evidenceRail()}</div></details> : undefined} />
                  <DebugGroup n="2" label="Buyer Profile (one-time) — the ONE extract: sent · raw prompt · output · run cost · grounding" />
                  <L3Band model={io?.model || 'google/gemini-2.5-flash'} maxTokens={io?.maxTokens ?? 16000} temperature={io?.temperature ?? 0} promptVersion={io?.promptVersion} catalog={catalog} sources={sources} signalCount={synthCtx?.bundle.evidence.length || 0} usage={msynth.usage ? { inputTokens: msynth.usage.promptTokens, outputTokens: msynth.usage.completionTokens, reasoningTokens: msynth.usage.reasoningTokens, ms: msynth.ms, costUsd: extractCost } : null} sourceGuide={sourceGuideNode} />
                  <L4Band system={io?.system || synthCtx?.prompt.system} user={io?.user || synthCtx?.prompt.user} output={getLLMRaw()['extractBuyerProfile']?.output} />
                  <L5Band attrs={outAttrs} evalRows={evalRows} evalDrill={evalDetail} prune={pruneInfo} status={l5status} drillFor={(key) => { const f = finals.find((x) => x.key === key); return f ? finalAttrDetail(f) : null; }} />
                  <L0Band calls={l0calls} totals={l0totals} evalDetail={evalDetail} harness={harnessNode} promptVersion={io?.promptVersion || 'extract-v8'} />
                  <DebugGroup n="3" label={`Requirement Enrichment (per requirement) — ${enrichedReqs.length || 'no'} requirement${enrichedReqs.length === 1 ? '' : 's'} enriched this pull`} />
                  {enrichedReqs.length === 0
                    ? <div className="text-[11px] text-gray-400 italic px-1">Open the <b>Requirement</b> tab on the card above to enrich a requirement — each one you enrich gets its own debug block here.</div>
                    : enrichedReqs.map((r) => (
                      <UC2DebugBand key={r.idx} reqTitle={r.title} status={r.status} model="google/gemini-2.5-flash" promptVersion={UC2_PROMPT_VERSION} usage={r.usage} evalRes={r.result?.eval ?? null} edits={r.result?.edits} input={r.promptIO} rawOutput={r.idx === offerIdx ? getLLMRaw()['uc2Enrich']?.output : undefined} coverage={r.idx === offerIdx ? pnsCoverage : null} />
                    ))}
                  {SHOW_L7 && <L7Band rows={reqRows} added={resolved.addedSpecs} ask={resolved.ask} dropped={reqDropped} coverage={reqCoverage} hasBrain={!!reqBrain} />}
                  <DebugGroup n="4" label="Web verify (OSINT) — on-demand entity scrape" />
                  <CrawlerBand glid={String((getEnrichmentRich() as { glid?: string | number } | null)?.glid || '')} />
                </div>
              </Band>
              {/* UC3 BELOW Debug (owner) — greyed "Upcoming", not clickable; the form wiring is kept behind it for later */}
              <UC3Band glid={glid} onOpenForm={onOpenForm} upcoming />
            </div>
          </div>
        );
      })()}

      {/* in-flight toaster — fires for ANY live LLM call: the extract twin, the critic prune, AND the per-offer
          requirement (UC2) / offer enrichment (so changing the offer or hitting "enrich" shows it). Poppy gradient. */}
      {ledger && (() => {
        const busy = msynth.status === 'loading' || prune.status === 'loading' || uc2LLM.status === 'loading' || offerLLM.status === 'loading';
        if (!busy) return null;
        const label = (msynth.status === 'loading' || prune.status === 'loading') ? 'Fetching buyer profile…'
          : uc2LLM.status === 'loading' ? 'Enriching the requirement…'
          : 'Enriching the offer…';
        return (
          <div className="fixed bottom-5 right-5 z-[60] flex items-center gap-2.5 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-xl shadow-fuchsia-500/30 px-4 py-2.5 text-[13px] font-semibold ring-2 ring-white/40">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/80 border-t-transparent animate-spin" />
            {label}
          </div>
        );
      })()}
    </div>
  );
}
