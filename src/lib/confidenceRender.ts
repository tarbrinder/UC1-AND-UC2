// ─── CONFIDENCE-AWARE RENDERING (the Golden Rule, applied) ────────────────────
// ChatGPT Gap 3: a derived signal should render BY CONFIDENCE, never as a flat "likely":
//   ≥70  → CHIP     — confident enough to assert (show it, let the buyer correct)
//   40-69 → CONFIRM  — plausible but unsure → ASK a one-tap confirmation
//   <40  → HIDE     — too weak to surface (Golden Rule: no guessing in the buyer's face)
// Pure + deterministic. One helper so every consumer (location pref, urgency, derived specs…) gates
// the same way instead of each inventing a threshold.

export type RenderMode = 'chip' | 'confirm' | 'hide';

export interface ConfidenceThresholds { chip: number; confirm: number }
export const DEFAULT_THRESHOLDS: ConfidenceThresholds = { chip: 70, confirm: 40 };

export function renderMode(confidence: number | null | undefined, t: ConfidenceThresholds = DEFAULT_THRESHOLDS): RenderMode {
  const c = typeof confidence === 'number' && isFinite(confidence) ? confidence : 0;
  if (c >= t.chip) return 'chip';
  if (c >= t.confirm) return 'confirm';
  return 'hide';
}

// Should this signal be surfaced at all? (convenience)
export function shouldSurface(confidence: number | null | undefined, t?: ConfidenceThresholds): boolean {
  return renderMode(confidence, t) !== 'hide';
}
