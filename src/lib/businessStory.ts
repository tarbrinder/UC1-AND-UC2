// ─── BUSINESS STORY (executive summary) — Requirements + Journey + Persona → one narrative ──────────────
// Humans don't read a ledger or a graph; they read a story. This stitches the requirement sequence + the
// journey arc + the headline persona into a single executive line + timeline + inference. PURE · no LLM.
// Harnessed in scripts/reqtest.mjs.

import type { Requirement } from './requirements';
import type { Journey } from './journey';
import type { Persona } from './personaRegistry';

export interface BusinessStory { headline: string; timeline: Array<{ title: string; role: string }>; arc: string; inference: string; line: string; requirements: number }

export function buildBusinessStory(reqs: Requirement[], journey: Journey, persona: Persona | null): BusinessStory {
  const headline = persona?.headline || persona?.all.find((a) => a.key === 'business_type')?.value || 'Buyer';
  const ind = persona?.all.find((a) => a.key === 'industry' && a.shown)?.value;
  const inference = `${journey.maturity}${ind ? ' · ' + ind : ''}`;
  const line = reqs.length
    ? `${headline} — ${journey.arc}. ${reqs.length} requirement${reqs.length === 1 ? '' : 's'} on record → ${journey.maturity}.`
    : `${headline} — awaiting requirement history.`;
  return { headline, timeline: journey.steps, arc: journey.arc, inference, line, requirements: reqs.length };
}
