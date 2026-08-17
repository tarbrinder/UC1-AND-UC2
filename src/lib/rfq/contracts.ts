// ─── Dynamic RFQ — shared contracts (single source of truth) ──────────────────
// Locked against the vFinal build plan. Defined ONCE, referenced everywhere (DRY):
// the question budget, the session state, the standard planner envelope, and the
// Requirement Brain (the canonical runtime object — never called "Briefing").

/** Ask-only budget per planner. Prefills / auto-fills / confirms are EXTRA and never counted. */
export const BUDGET = { min: 2, pref: 3, max: 5 } as const;

/** How a rendered field behaves. The renderer is dumb — it only switches on this. */
export type QuestionUi = 'ask' | 'prefill' | 'suggest' | 'confirm';

export interface Question {
  field: string;                 // stable key (spec name / commercial key / persona key)
  label: string;                 // ≤3–4 words, single line
  ui: QuestionUi;
  value?: string;                // present for prefill / confirm / suggest
  suggestion?: string;           // an alternative the LLM proposed for an already-filled field
  options?: string[];            // option chips (commercial / persona are strictly option-based)
  order: number;
}

/** EVERY planner returns this exact envelope (LLM 1 carries extra fields alongside it). */
export interface PlannerEnvelope {
  planner: 'requirement_brain' | 'commercial' | 'persona';
  version: string;
  questions: Question[];
  metadata: Record<string, unknown>;   // debug-only reasoning / confidence / evidence when in AI-Debug mode
}

/** The canonical runtime object. LLM 1 produces it; LLM 2/3 read it; it rides into submission. */
export interface RequirementBrain {
  understanding: string;
  persona_read: string;
  category_trustworthy: boolean;        // LLM 1's internal trust decision — NO numeric threshold exposed
  evidence: string[];
}

/** LLM 1's full return: the brain + the pre-baked Page-1 payload + spec truths outside the schema. */
export interface RequirementBrainResult {
  brain: RequirementBrain;
  page1: PlannerEnvelope;
  known_truths: { key: string; value: string; source: string }[];
}

/** Known-good truth the buyer already gave us, per field — the merge layer reads this to prefill/skip. */
export type KnownFacts = Record<string, { value: string; source: string }>;

/** The one session state object. Every planner reads its slice; the merge layer dedups against all of it. */
export interface SessionState {
  product: string;
  quantity?: string;
  mcatId?: string;
  page1: Record<string, string>;   // spec answers
  page2: Record<string, string>;   // commercial answers
  page3: Record<string, string>;   // persona answers
}

export const emptySession = (): SessionState => ({ product: '', page1: {}, page2: {}, page3: {} });

/** Fields the buyer has answered anywhere so far — used by the Deterministic Merge Layer to drop
 *  a last-page field that was already asked/filled on Page 1/2/3. Normalised for safe comparison. */
export function answeredKeys(s: SessionState): Set<string> {
  const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Set<string>();
  for (const bag of [s.page1, s.page2, s.page3]) {
    for (const [k, v] of Object.entries(bag)) if (k && v && String(v).trim()) out.add(norm(k));
  }
  return out;
}

/** PNS speed tier — Simulator "PNS Intelligence Mode". */
export type PnsMode = 'api' | 'full';
/** Simulator execution mode. Production Preview = lightweight prompts; AI Debug = verbose prompts + inspector. */
export type ExecMode = 'prod' | 'debug';
/** Reasoning effort for ALL three LLMs (brain + both planners), chosen once on page -1. Intelligence is
 *  mode-INDEPENDENT (owner 2026-07-31): the SAME effort runs in prod and debug — only verbosity differs. Default high. */
export type EffortMode = 'low' | 'medium' | 'high';
/** Simulator surface. */
export type Surface = 'mobile' | 'desktop' | 'standalone';

export interface SimConfig { surface: Surface; exec: ExecMode; pns: PnsMode; effort: EffortMode; }
// `effort` defaults to 'high' to match BrainFormGate's page -1 default, so the two routes reason identically
// instead of the blueprint silently hardcoding a different depth than the shipping form.
export const defaultSim = (): SimConfig => ({ surface: 'standalone', exec: 'prod', pns: 'api', effort: 'high' });
