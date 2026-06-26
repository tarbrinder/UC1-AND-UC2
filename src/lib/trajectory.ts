// ─── Buyer Story / product trajectory (P2.7) ─────────────────────────────────
// The system already knows a buyer's past categories INDIVIDUALLY — but the real story is in their
// SEQUENCE. "Notebook Machine → Raw Material → Paper" is a factory being set up; three Diesel-Generator
// enquiries over a year is routine replenishment; "Office Files → Diesel Generator" out of nowhere is a
// new line or a one-off. Until now categories were a de-duped, UNORDERED bag of themes — never a timeline.
//
// This orders them chronologically and computes a deterministic coarse SHAPE; the human narrative ("arc")
// is inferred by a flash-lite pass (deriveBuyerStory in gemini.ts). The arc is a SOFT planner/intent
// signal — NEVER a hard fact (a sequence SUGGESTS a story, it does not prove one). Pure · NO category
// literals · chaos-safe (no/!categories ⇒ none).

export interface TrajectoryStep { mcat: string; recencyDays?: number }
export type TrajectoryShape = 'none' | 'single' | 'repeat' | 'diversifying';

// Order the buyer's distinct past categories OLDEST → NEWEST (a larger recencyDays = longer ago). De-dups
// by category (keeps the richest/most-recent face); undated entries sink toward the recent end.
export function orderTrajectory(categories: Array<{ mcat?: string; recencyDays?: number }>): TrajectoryStep[] {
  const byCat = new Map<string, TrajectoryStep>();
  for (const c of categories || []) {
    const mcat = (c?.mcat || '').trim();
    if (!mcat) continue;
    const key = mcat.toLowerCase();
    const rd = typeof c?.recencyDays === 'number' ? c.recencyDays : undefined;
    const prev = byCat.get(key);
    if (!prev) byCat.set(key, { mcat, recencyDays: rd });
    else if (typeof rd === 'number' && (prev.recencyDays == null || rd < prev.recencyDays)) prev.recencyDays = rd; // keep most-recent touch
  }
  return [...byCat.values()].sort((a, b) => (b.recencyDays ?? -1) - (a.recencyDays ?? -1));
}

// Coarse, deterministic shape — used to decide whether a narrative is even worth inferring and to label
// the dossier. A story needs ≥2 DISTINCT categories; a single repeated category is "repeat" (replenish).
export function trajectoryShape(categories: Array<{ mcat?: string; recencyDays?: number }>): TrajectoryShape {
  const all = (categories || []).map((c) => (c?.mcat || '').trim().toLowerCase()).filter(Boolean);
  if (all.length === 0) return 'none';
  const distinct = new Set(all);
  if (distinct.size === 1) return all.length > 1 ? 'repeat' : 'single';
  return 'diversifying';
}

// Whether the trajectory is rich enough for a STORY — ≥2 distinct categories in time. (A single data
// point is not a journey; the LLM pass is skipped below this bar so we never narrate from nothing.)
export function hasStory(categories: Array<{ mcat?: string; recencyDays?: number }>): boolean {
  return new Set((categories || []).map((c) => (c?.mcat || '').trim().toLowerCase()).filter(Boolean)).size >= 2;
}
