// ─── Dynamic RFQ — Planner Controller (step 2: LLM 2 + LLM 3 orchestration hook) ─────────────────────────────────
// Extracts the Commercial (LLM 2) and Persona (LLM 3) firing out of BrainRFQForm. Owns: fire-once-per-mcat, the
// fallback→real and no-category→category upgrade re-fires, the deterministic merge-layer dedup (via dropAnswered),
// and the fail/empty auto-skip. LLM 1 (Requirement Brain) stays in the component — it is too entangled with the
// spec-merge / consumption pipeline to extract safely. Pure orchestration lives in plannerController.ts; this hook
// is only the effect shells + their guards, threaded the component's state/refs.
import { useEffect, useRef, type MutableRefObject } from 'react';
import { emitApiError } from '../emit';
import { applyBudget, runCommercialPlanner, runPersonaPlanner } from './llm';
import { haveRealBrain } from './plannerController';
import type { EffortMode, ExecMode, PlannerEnvelope, RequirementBrain, SessionState } from './contracts';

type Stage = 'landing' | 'specs' | 'commercial' | 'persona' | 'results';   // #79: 'more' page deleted

export interface PlannerControllerDeps {
  stage: Stage; mcatId: string; rbBrain: RequirementBrain | null; rfqBrain: RequirementBrain;
  catTopSpecs?: { q: string; pct?: number; vals?: string[] }[];
  // The COMPLETE bi-category-brain payload. Preferred as LLM 2's `category_engine` when present (it CONTAINS
  // top_specs plus personas/keywords/b2b_b2c/top_products/coverage counters); catTopSpecs remains the fallback and
  // still drives the have-category gating, so a missing corpus degrades to exactly the old behaviour.
  catCorpus?: Record<string, unknown> | null;
  commercialPlan: PlannerEnvelope | null; execMode: ExecMode; effort: EffortMode; showGstOnPersona: boolean;
  // The LATEST commercial plan, as a REF (not the value prop). LLM 3 fires in parallel with LLM 2, so at LLM 3's
  // effect-run time the commercial plan does not exist yet; reading it through this ref at LLM 3's RESOLVE (persona
  // resolves after commercial) gives the cross-page dedup without the old page-2 re-fire that caused the "jumping".
  commercialPlanRef: MutableRefObject<PlannerEnvelope | null>;
  // ── ROUTER + PARALLEL FIRE (2026-08-12) ──────────────────────────────────────────────────────────────────
  // includeCommercial/includePersona: the deterministic flow router (from _seed.bulkGate) — a planner NEVER fires
  // for a buyer whose flow omits its page (a retail buyer skips both, the biggest no-waiting win). LLM 2 + LLM 3
  // BOTH fire the moment LLM 1's real brain lands — in parallel, off the one product-commit batch, ONCE each. No
  // page transition re-fires anything. cxLoading/psLoading let an EMPTY plan (resolved while the buyer is on an
  // earlier page) still skip its page when the buyer arrives.
  includeCommercial: boolean; includePersona: boolean;
  cxLoading: boolean; psLoading: boolean;
  // #76 fix: LLM 1 now fires LATE (on page 1), so a fast buyer can reach page 2/3 before the real brain lands. While the
  // brain is still in flight, a planner must WAIT (fire on the REAL brain, not the thin fallback). Once the brain SETTLES
  // (success or failure) brainInFlight goes false, so a failed brain still fires the planner on the fallback (page never blank).
  brainInFlight: boolean;
  // #76 fix: bumped by a "Try again" on a failed planner. Threaded into the effect deps so retry actually RE-RUNS the
  // effect (clearing cxFiredFor/psFiredFor alone can't — a ref change is not a dep). Without it retry stuck the loader.
  plannerRetry: number;
  // C3: every page-1 field that was RENDERED, answered or not. `answeredKeys` only sees VALUES, so a spec the buyer
  // saw and skipped is invisible to the merge layer and gets asked again on page 2. This closes that hole.
  page1Shown: string[];
  // C14: the buyer's self-declared profile. LLM 3 previously received NO profile at all — it was asked to understand
  // the buyer while being shown nothing about him, which is a large part of why persona questions came out generic.
  profile?: unknown;
  // #7 the deterministic BulkB2B persona gate (persona_on_file → prefill · vetoed_by → do not ask · met[] = maturity). From the seed.
  personaGate?: unknown;
  // refs (stable)
  pnsRef: MutableRefObject<unknown>; stageRef: MutableRefObject<Stage>;
  cxFiredFor: MutableRefObject<string>; psFiredFor: MutableRefObject<string>;
  cxUsedFallback: MutableRefObject<boolean>; psUsedFallback: MutableRefObject<boolean>; cxUsedNoCategory: MutableRefObject<boolean>;
  // pre-warm bookkeeping: the page snapshot each planner consumed (→ detect an edit worth re-firing on) + whether
  // its pre-warmed plan resolved EMPTY (→ skip the page on arrival even though the .then ran off-stage).
  cxPage1Snap: MutableRefObject<string>; psPage2Snap: MutableRefObject<string>;
  cxIsEmpty: MutableRefObject<boolean>; psIsEmpty: MutableRefObject<boolean>;
  // actions (stable setters)
  setCxLoading: (b: boolean) => void; setPsLoading: (b: boolean) => void;
  setCommercialPlan: (e: PlannerEnvelope | null) => void; setPersonaPlan: (e: PlannerEnvelope | null) => void; setStage: (s: Stage) => void;
  // C10: surface a FAILED planner instead of silently auto-skipping the page.
  setCxFailed: (b: boolean) => void; setPsFailed: (b: boolean) => void;
  // helpers (recomputed per render; capture current form state)
  session: () => SessionState;
  dropAnswered: (env: PlannerEnvelope, extraShown?: string[]) => PlannerEnvelope;
}

export function usePlannerController(p: PlannerControllerDeps): void {
  // Generation tokens. Each planner now fires EXACTLY ONCE per product (owner 2026-08-12: "all in parallel as soon as
  // the product is committed … and these calls, nothing else"). All three fan out off the single commit batch the
  // moment LLM 1's real brain lands; NOTHING re-fires on a page transition. The token is kept only so a RETRY — which
  // clears cxFiredFor / psFiredFor and re-arms the effect — supersedes any still-in-flight prior call: only the
  // LATEST-ISSUED fire may commit its result or clear loading.
  const cxGen = useRef(0);
  const psGen = useRef(0);
  // ── LLM 2 · Commercial — FIRES ON PAGE 2 (owner 2026-08-14, task #76): when the buyer LANDS ON the commercial page,
  //    so its session() snapshot carries the "form filled so far" — the page-1 specs INCLUDING his own edits (not just
  //    the just-prefilled values a page-1 pre-warm would see). Symmetric with LLM 3 on page 3. The brain landed on page 1,
  //    so it is always available by page 2. FIRES EXACTLY ONCE per product (no page-edit / re-fire — no "jumping"). ──
  useEffect(() => {
    if (!p.mcatId || !p.includeCommercial) return;
    // ARMED on ARRIVAL at page 2+ AND once the brain is ready: fire on the REAL brain if it landed, else wait while it's
    // in flight, else (brain settled without a real one) fire on the fallback so page 2 is never left blank (#76 fix #5).
    const armed = (p.stage === 'commercial' || p.stage === 'persona') && (haveRealBrain(p.rbBrain) || !p.brainInFlight);   // #79: 'more' gone
    if (!armed) return;
    // ONE fire per product. No re-fire on a page edit, a fallback→real upgrade, or a late Category Engine: the category
    // corpus (~1s) is already present when the real brain lands (~7s), so this single fire has it. A retry clears
    // cxFiredFor to re-arm.
    if (p.cxFiredFor.current === p.mcatId) return;
    p.cxFiredFor.current = p.mcatId; p.setCxLoading(true);
    const gen = ++cxGen.current;   // this fire's token — only the LATEST fire may commit (guards a retry's re-arm)
    // Reuse the pns fetched on commit (pnsRef) — no second fetch; whatever landed is used, else null (never waits).
    runCommercialPlanner({ brain: p.rfqBrain, session: p.session(), categoryEngine: p.catCorpus ?? p.catTopSpecs, pns: p.pnsRef.current, profile: p.profile }, p.execMode, p.effort)
      .then((env) => {
        if (gen !== cxGen.current) return;   // superseded by a newer fire — drop this result
        const c = env ? applyBudget(p.dropAnswered(env, p.page1Shown)) : null;
        // Publish the committed plan into the ref LLM 3 reads at ITS resolve, for cross-page dedup without a re-fire.
        p.commercialPlanRef.current = c && c.questions.length ? c : null;
        if (c && c.questions.length) { p.cxIsEmpty.current = false; p.setCxFailed(false); p.setCommercialPlan(c); return; }
        // NULL env = transport/parse FAILURE → show it and let the buyer retry; an env WITH zero questions is a
        // legitimate "nothing to ask" → mark empty and skip (on-stage now, or on arrival via the effect below).
        emitApiError('commercialPlanner', new Error(env ? 'planner returned no questions' : 'planner returned null (parse or transport failure)'), { mcatId: p.mcatId, stage: 'commercial' });
        if (!env) { p.setCxFailed(true); return; }
        p.cxIsEmpty.current = true;
        if (p.stageRef.current === 'commercial') p.setStage('persona');
      })
      .catch((e) => { if (gen !== cxGen.current) return; emitApiError('commercialPlanner', e, { mcatId: p.mcatId, stage: 'commercial' }); p.setCxFailed(true); })
      .finally(() => { if (gen === cxGen.current) p.setCxLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stage, p.mcatId, p.rbBrain, p.includeCommercial, p.brainInFlight, p.plannerRetry]);

  // A pre-warm that resolved EMPTY did so off-stage (buyer was still on page 1), so its .then could not skip. When the
  // buyer arrives at an empty commercial page, skip it — matching the old on-stage auto-skip.
  useEffect(() => {
    if (p.stage === 'commercial' && !p.cxLoading && p.cxIsEmpty.current && p.stageRef.current === 'commercial') p.setStage('persona');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stage, p.cxLoading]);

  // ── LLM 3 · Persona — fires IN PARALLEL with LLM 2 + LLM 4 the moment LLM 1's real brain lands, off the one
  //    product-commit batch (owner 2026-08-12: "all 3 in parallel as soon as the product is committed"). A stage
  //    backstop fires it on arrival if the brain never upgraded. FIRES EXACTLY ONCE — the old page-2 re-fire (the
  //    "questions jumping / triggered after prev-page Next") is gone. Its cross-page dedup against the commercial
  //    questions is done WITHOUT a re-fire: persona resolves AFTER commercial, so its .then reads the current
  //    commercial plan through commercialPlanRef. Full flow only. ──
  useEffect(() => {
    if (!p.mcatId || !p.includePersona) return;
    // FIRES ON PAGE 3 (owner 2026-08-14, task #76): unlike Commercial (which fires the moment LLM 1's brain lands, on
    // page 1), Persona fires only when the buyer REACHES the persona page — so its session() snapshot carries the fullest
    // "form filled so far": page-1 specs AND page-2 commercial answers. haveRealBrain is guaranteed by page 3 (the brain
    // landed on page 1), so no realBrain arm is needed; the stage gate is the trigger. Still ONCE per mcat (no jumping).
    const armed = (p.stage === 'persona') && (haveRealBrain(p.rbBrain) || !p.brainInFlight);   // #79: persona is the last page now — no 'more'
    if (!armed) return;
    if (p.psFiredFor.current === p.mcatId) return;
    p.psFiredFor.current = p.mcatId; p.setPsLoading(true);
    const gen = ++psGen.current;   // this fire's token — only the LATEST fire may commit (guards a retry's re-arm)
    runPersonaPlanner({ brain: p.rfqBrain, session: p.session(), profile: p.profile, personaGate: p.personaGate }, p.execMode, p.effort)
      // dedup persona against every Commercial question SHOWN (answered or not) so a skipped one can't reappear on P3.
      .then((env) => {
        if (gen !== psGen.current) return;   // superseded by a newer fire — drop this result
        // Read the LATEST commercial plan via the ref (not a stale effect closure): by the time persona resolves,
        // commercial has already resolved and published it, so cross-page dedup works with no page-2 re-fire.
        const cx = p.commercialPlanRef.current;
        const c = env ? applyBudget(p.dropAnswered(env, [...p.page1Shown, ...(cx?.questions ?? []).flatMap((q) => [q.field, q.label])])) : null;
        if (c && c.questions.length) { p.psIsEmpty.current = false; p.setPsFailed(false); p.setPersonaPlan(c); return; }
        emitApiError('personaPlanner', new Error(env ? 'planner returned no questions' : 'planner returned null (parse or transport failure)'), { mcatId: p.mcatId, stage: 'persona' });
        if (!env) { p.setPsFailed(true); return; }   // failure is shown, not skipped
        p.psIsEmpty.current = true;
        // #79: persona is the LAST page now — an empty persona no longer auto-skips (it still carries the collapsed
        // contact block + About-You + any GST/verification). The buyer taps Get-Quotes from here.
      })
      .catch((e) => { if (gen !== psGen.current) return; emitApiError('personaPlanner', e, { mcatId: p.mcatId, stage: 'persona' }); p.setPsFailed(true); })
      .finally(() => { if (gen === psGen.current) p.setPsLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.stage, p.mcatId, p.rbBrain, p.includePersona, p.brainInFlight, p.plannerRetry]);

  // (#79: the empty-persona auto-skip to 'more' is REMOVED — persona is the last page now, so there is nowhere to skip
  //  to; an empty persona simply shows the collapsed contact block + About-You and the buyer taps Get-Quotes.)
}
