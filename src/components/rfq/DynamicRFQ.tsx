// ─── Dynamic RFQ — orchestrator (Page 0 → 1 → 2 → 3 → Deterministic Merge) ────
// Additive: reachable at ?rfq=brain2, the live ?rfq=brain flow is untouched.
// Staged leaf fetch · product-commit gate · LLM-1 hot-enhance (CF-5·A) · planner
// chain with failure fallbacks (LLM2 fail→P3, LLM3 fail→last) · deterministic merge.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { answeredKeys, defaultSim, emptySession, type PlannerEnvelope, type Question, type RequirementBrain, type SessionState, type SimConfig } from '../../lib/rfq/contracts';
import { dropAnswered } from '../../lib/rfq/plannerController';
import { fetchBuyerSpecs, fetchCsl, fetchPnsInsights, fetchProfile, fetchRfq, fetchSellerSpecs, fetchWhatsapp, resolveMcat, type BuyerSpec, type CslResult, type RfqRequirement } from '../../lib/rfq/dataLayer';
import { applyBudget, runCommercialPlanner, runPersonaPlanner, runRequirementBrain } from '../../lib/rfq/llm';
import QuestionRenderer from './QuestionRenderer';

type Stage = 'landing' | 'specs' | 'commercial' | 'persona' | 'delivery' | 'done';
const shortLabel = (s: string) => s.split(/[/(]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');

// Deterministic last-page fields (the Merge Layer renders those NOT already answered on P1/P2/P3).
const LAST_PAGE: Question[] = [
  { field: 'Delivery Location', label: 'Delivery location', ui: 'ask', order: 0 },
  { field: 'Delivery Timeline', label: 'Delivery timeline', ui: 'ask', options: ['Immediate', 'Within 15 days', '1 month', 'Flexible'], order: 1 },
  { field: 'Payment Terms', label: 'Payment terms', ui: 'ask', options: ['Advance', 'On delivery', 'Credit 30 days', 'Negotiable'], order: 2 },
];

function specsToEnvelope(specs: BuyerSpec[], prefills: Record<string, string>): PlannerEnvelope {
  return {
    planner: 'requirement_brain', version: 'default',
    questions: specs.map((s, i) => ({
      field: s.name, label: shortLabel(s.name),
      ui: prefills[s.name] ? 'prefill' : 'ask', value: prefills[s.name],
      options: s.options.length ? s.options : undefined, order: i,
    })),
    metadata: { source: 'buyer-specs-default' },
  };
}

export default function DynamicRFQ({ glid, sim: simIn }: { glid: string; sim?: SimConfig }) {
  const sim = simIn ?? defaultSim();
  const [stage, setStage] = useState<Stage>('landing');
  const [session, setSession] = useState<SessionState>(() => ({ ...emptySession() }));
  const [landingLoading, setLandingLoading] = useState(true);
  const [csl, setCsl] = useState<CslResult | null>(null);
  const [rfq, setRfq] = useState<{ requirements: RfqRequirement[] } | null>(null);
  const truth = useRef<{ csl: unknown; rfq: unknown; profile: unknown; whatsapp: unknown; pns: unknown }>({ csl: null, rfq: null, profile: null, whatsapp: null, pns: null });
  const truthReady = useRef<Promise<void> | null>(null);
  const [brain, setBrain] = useState<RequirementBrain | null>(null);
  const [busy, setBusy] = useState('');           // stage-loading label
  const [env, setEnv] = useState<Record<Stage, PlannerEnvelope | null>>({ landing: null, specs: null, commercial: null, persona: null, delivery: null, done: null });
  const buyerSpecs = useRef<BuyerSpec[]>([]);
  const sellerSpecs = useRef<{ q: string; pct?: number; vals?: string[] }[]>([]);

  // ── Page 0: fire all leaves in parallel; combined loader waits for CSL + RFQ ──
  useEffect(() => {
    if (!glid) { setLandingLoading(false); return; }
    const pC = fetchCsl(glid).then((r) => { truth.current.csl = r?.raw ?? null; setCsl(r); return r; });
    const pR = fetchRfq(glid).then((r) => { truth.current.rfq = r?.raw ?? null; setRfq(r); return r; });
    const pP = fetchProfile(glid).then((r) => { truth.current.profile = r; });
    const pW = fetchWhatsapp(glid).then((r) => { truth.current.whatsapp = r; });
    const pN = fetchPnsInsights(glid, sim.pns).then((r) => { truth.current.pns = r; });
    truthReady.current = Promise.allSettled([pC, pR, pP, pW, pN]).then(() => undefined);
    Promise.allSettled([pC, pR]).then(() => setLandingLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glid]);

  // Landing cards: past requirements (repost) + viewed products (new), de-duped.
  const cards = useMemo(() => {
    const seen = new Set<string>();
    const out: { product: string; mcat?: string; qty?: string; specs: Record<string, string>; kind: 'repost' | 'viewed' }[] = [];
    for (const r of rfq?.requirements ?? []) {
      const k = r.product.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ product: r.product, mcat: r.mcat, specs: Object.fromEntries(r.specs.map((s) => [s.name, s.value])), kind: 'repost' });
    }
    for (const v of csl?.viewed_products ?? []) {
      const k = v.name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ product: v.name, mcat: v.mcat, specs: Object.fromEntries((v.specs ?? []).map((s) => [s.name, s.value])), kind: 'viewed' });
    }
    return out.slice(0, 6);
  }, [rfq, csl]);

  const commitGen = useRef(0);
  const commit = useCallback(async (product: string, quantity: string, prefills: Record<string, string>) => {
    if (!product.trim()) return;
    const gen = ++commitGen.current;
    const next: SessionState = { ...emptySession(), product: product.trim(), quantity: quantity.trim() || undefined, page1: { ...prefills } };
    setSession(next); setStage('specs'); setBrain(null);
    // Spec APIs on product-name commit (mcat-derived).
    const mcatId = await resolveMcat(product) ?? undefined;
    if (gen !== commitGen.current) return;
    next.mcatId = mcatId; setSession({ ...next });
    const [bs, ss] = await Promise.all([mcatId ? fetchBuyerSpecs(mcatId) : Promise.resolve([]), mcatId ? fetchSellerSpecs(mcatId) : Promise.resolve([])]);
    if (gen !== commitGen.current) return;
    buyerSpecs.current = bs; sellerSpecs.current = ss;
    // Page 1 renders the Buyer-Specs default IMMEDIATELY (CF-5·A).
    setEnv((e) => ({ ...e, specs: specsToEnvelope(bs, prefills) }));
    // LLM 1 fires after ALL truth arrives (no cap), then hot-enhances Page 1.
    setBusy('Reading your requirement…');
    await (truthReady.current ?? Promise.resolve());
    if (gen !== commitGen.current) { setBusy(''); return; }
    const result = await runRequirementBrain({
      product, quantity, csl: truth.current.csl, rfq: truth.current.rfq, profile: truth.current.profile,
      whatsapp: truth.current.whatsapp, pns: truth.current.pns, buyerSpecs: bs, sellerSpecs: ss, alreadyFilled: prefills,
    }, sim.exec, sim.effort);
    setBusy('');
    if (gen !== commitGen.current) return;
    if (result) { setBrain(result.brain); setEnv((e) => ({ ...e, specs: result.page1 })); }  // hot-swap; buyer edits in `session.page1` win in the renderer
    // result null → keep the Buyer-Specs default (deterministic fallback).
  }, [sim.exec, sim.effort]);

  const setVal = (page: 'page1' | 'page2' | 'page3', field: string, value: string) =>
    setSession((s) => ({ ...s, [page]: { ...s[page], [field]: value } }));

  // ── Planner chain with failure fallbacks ──
  const runNextPlanner = useCallback(async (kind: 'commercial' | 'persona') => {
    if (!brain) { setStage(kind === 'commercial' ? 'persona' : 'delivery'); return; }
    setBusy(kind === 'commercial' ? 'Preparing commercial questions…' : 'Preparing a few profile questions…');
    const runner = kind === 'commercial' ? runCommercialPlanner : runPersonaPlanner;
    // categoryEngine: the distilled {q,pct,vals} feed. The planner prompt handles BOTH this and the full corpus
    // shape; ?rfq=brain (the shipping route) passes the full corpus, this blueprint passes the distilled one.
    const res = await runner({ brain, session, categoryEngine: sellerSpecs.current, pns: truth.current.pns }, sim.exec, sim.effort);
    setBusy('');
    if (!res) { setStage(kind === 'commercial' ? 'persona' : 'delivery'); return; }  // LLM2 fail→P3, LLM3 fail→last
    // C20 (2026-08-03): the blueprint route ran the SAME three prompts but never called the deterministic merge
    // layer — only applyBudget — so it had no cross-page dedup at all and could ask a page-1 spec again on page 2.
    // Mirrors usePlannerController: dedup by concept against everything answered so far, then cap.
    const capped = applyBudget(dropAnswered(res, session));
    setEnv((e) => ({ ...e, [kind]: capped }));
    setStage(kind === 'commercial' ? 'commercial' : 'persona');
  }, [brain, session, sim.exec, sim.effort]);

  // Deterministic Merge Layer: last-page fields NOT already answered on P1/P2/P3.
  const deliveryQuestions = useMemo(() => {
    const done = answeredKeys(session);
    const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
    return LAST_PAGE.filter((q) => !done.has(norm(q.field)));
  }, [session]);

  if (!glid) return <Shell><p className="text-gray-500">Add <code>?glid=&lt;buyer&gt;</code> to the URL.</p></Shell>;

  // ── Render ──
  if (stage === 'landing') return <Landing loading={landingLoading} cards={cards} onCommit={commit} />;

  const pageEnv = env[stage];
  const values = stage === 'specs' ? session.page1 : stage === 'commercial' ? session.page2 : stage === 'persona' ? session.page3 : {};
  const pageKey = stage === 'specs' ? 'page1' : stage === 'commercial' ? 'page2' : 'page3';

  return (
    <Shell>
      <Stepper stage={stage} />
      <div className="mt-1 flex items-center gap-2 text-[12px] text-gray-500"><span className="font-semibold text-gray-800">{session.product}</span>{session.quantity && <span>· Qty {session.quantity}</span>}</div>
      {busy && <div className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-[12.5px] text-teal-800">✦ {busy}</div>}

      <div className="mt-5">
        {stage === 'delivery' ? (
          <>
            <h2 className="mb-3 text-[16px] font-semibold text-gray-900">Delivery & payment</h2>
            <QuestionRenderer questions={deliveryQuestions} values={session.page3 /* reuse a bag */} onChange={(f, v) => setVal('page3', f, v)} />
          </>
        ) : stage === 'done' ? (
          <Done session={session} />
        ) : (
          <QuestionRenderer questions={pageEnv?.questions ?? []} values={values} onChange={(f, v) => setVal(pageKey as 'page1' | 'page2' | 'page3', f, v)} />
        )}
      </div>

      {brain?.category_trustworthy === false && stage === 'specs' && (
        <p className="mt-4 text-[11.5px] text-gray-400">Category schema was thin — these questions were drafted from your requirement.</p>
      )}

      <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-4">
        <button onClick={() => back(stage, setStage)} className="text-[13px] text-gray-500 hover:text-gray-800">← Back</button>
        {stage !== 'done' && (
          <button disabled={!!busy} onClick={() => advance(stage, setStage, runNextPlanner)}
            className="rounded-lg bg-teal-700 px-5 py-2.5 text-[13.5px] font-semibold text-white disabled:bg-gray-200">
            {stage === 'delivery' ? 'Find suppliers →' : 'Next →'}
          </button>
        )}
      </div>
    </Shell>
  );
}

function advance(stage: Stage, setStage: (s: Stage) => void, runNextPlanner: (k: 'commercial' | 'persona') => void) {
  if (stage === 'specs') return runNextPlanner('commercial');
  if (stage === 'commercial') return runNextPlanner('persona');
  if (stage === 'persona') return setStage('delivery');
  if (stage === 'delivery') return setStage('done');
}
function back(stage: Stage, setStage: (s: Stage) => void) {
  const order: Stage[] = ['landing', 'specs', 'commercial', 'persona', 'delivery', 'done'];
  const i = order.indexOf(stage); if (i > 0) setStage(order[i - 1]);  // back-edit allowed, no replan (v1 tradeoff)
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-gray-50"><div className="mx-auto max-w-xl px-5 py-8">{children}</div></div>;
}
function Stepper({ stage }: { stage: Stage }) {
  const steps: [Stage, string][] = [['specs', 'Specs'], ['commercial', 'Commercial'], ['persona', 'Profile'], ['delivery', 'Delivery']];
  const idx = steps.findIndex(([s]) => s === stage);
  return (
    <div className="flex items-center gap-1.5">
      {steps.map(([s, label], i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${i <= idx ? 'bg-teal-600 text-white' : 'bg-gray-200 text-gray-500'}`}>{i + 1}</span>
          <span className={`text-[12px] ${i === idx ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>{label}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-4 bg-gray-200" />}
        </div>
      ))}
    </div>
  );
}

function Landing({ loading, cards, onCommit }: { loading: boolean; cards: { product: string; mcat?: string; qty?: string; specs: Record<string, string>; kind: 'repost' | 'viewed' }[]; onCommit: (p: string, q: string, prefills: Record<string, string>) => void; }) {
  const [product, setProduct] = useState('');
  const [qty, setQty] = useState('');
  return (
    <Shell>
      <h1 className="text-[22px] font-bold text-gray-900">Post a Requirement</h1>
      <p className="mt-1 text-[13px] text-gray-500">Tell us what you need — we'll draft it from your history.</p>
      <div className="mt-5 flex gap-2">
        <input autoFocus value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Product or service name"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-[14px] focus:border-teal-500 focus:outline-none" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-[14px] focus:border-teal-500 focus:outline-none" />
      </div>
      <button disabled={!product.trim()} onClick={() => onCommit(product, qty, {})}
        className="mt-3 w-full rounded-lg bg-teal-700 py-2.5 text-[14px] font-semibold text-white disabled:bg-gray-200">Continue →</button>

      {loading && <p className="mt-6 text-[13px] text-gray-400">✦ Loading your history…</p>}
      {!loading && !!cards.length && (
        <div className="mt-7">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">Continue where you left off</p>
          <div className="space-y-2">
            {cards.map((c, i) => (
              <button key={`${c.product}-${i}`} onClick={() => onCommit(c.product, c.qty ?? '', c.specs)}
                className="w-full rounded-xl border border-gray-200 bg-white p-3 text-left hover:border-teal-300 hover:shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-gray-900">{c.product}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.kind === 'repost' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>{c.kind === 'repost' ? 'Repost' : 'Viewed'}</span>
                </div>
                {!!Object.keys(c.specs).length && <p className="mt-1 line-clamp-1 text-[11.5px] text-gray-500">{Object.entries(c.specs).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

function Done({ session }: { session: SessionState }) {
  const payload = { product: session.product, quantity: session.quantity, specifications: session.page1, commercial: session.page2, persona: session.page3 };
  return (
    <div>
      <h2 className="text-[18px] font-bold text-gray-900">✓ Requirement ready</h2>
      <p className="mt-1 text-[13px] text-gray-500">This is the compiled RFQ payload (next: curated seller search).</p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white p-3 text-[11px] text-gray-700">{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
