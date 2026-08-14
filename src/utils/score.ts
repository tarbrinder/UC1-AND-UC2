import type { RFQFormData, ISQSpec } from '../types';
import { qtyIsMeaningful } from './formValidation';

export interface ScoreCheck {
  label: string;
  pts: number;
  earned: number;
  done: boolean;
  applicable: boolean;
  group: 'Product' | 'Specs' | 'Details';
}

export interface ScoreDetails {
  total: number;
  checks: ScoreCheck[];
}

export interface ScoreContext {
  /** Whether the category exposes quantity units (and therefore asks quantity). */
  quantityApplicable?: boolean;
  /** Whether purchase frequency is being asked (not already in the specs). */
  frequencyApplicable?: boolean;
  /** Count of spec-adjacent "context" questions offered in the details sheet. */
  intentTotal?: number;
  /** How many of those the buyer has answered. */
  intentAnswered?: number;
  /** Whether buyer-profile (role/industry) is asked — false for tiny retail buys. */
  profileApplicable?: boolean;
  /** Whether GST is asked — true only for a business role (every buyer type except individual/consumer). */
  gstApplicable?: boolean;
  /** Page-2 AI "Smart Questions" surfaced (only scored when loaded — normalized out while loading/errored/empty). */
  aiSpecTotal?: number;
  /** How many of the surfaced AI questions the buyer has answered. */
  aiSpecAnswered?: number;
}

export function calcScore(
  form: Partial<RFQFormData>,
  isqSpecs: ISQSpec[],
  hasImage: boolean,
  ctx: ScoreContext = {}
): ScoreDetails {
  const { quantityApplicable = true, frequencyApplicable = true, profileApplicable = true, gstApplicable = false } = ctx;
  const aiSpecTotal = ctx.aiSpecTotal ?? 0;
  const aiSpecAnswered = Math.min(ctx.aiSpecAnswered ?? 0, aiSpecTotal);

  const checks: ScoreCheck[] = [];
  // Only the points for questions that are actually asked count toward the
  // denominator, so a category that doesn't ask quantity isn't penalised.
  let earned = 0;
  let possible = 0;
  const add = (
    group: ScoreCheck['group'],
    label: string,
    pts: number,
    done: boolean,
    applicable = true,
    earnedPts?: number
  ) => {
    const e = earnedPts !== undefined ? earnedPts : done ? pts : 0;
    checks.push({ label, pts, earned: applicable ? e : 0, done, applicable, group });
    if (!applicable) return;
    possible += pts;
    earned += e;
  };

  add('Product', 'Product name', 10, (form.productName?.trim().length ?? 0) > 2);
  add('Product', 'Quantity', 10, qtyIsMeaningful(form.quantity), quantityApplicable); // only a real number > 0 earns the points (not '.', '0', '1.2.3')
  add('Product', 'Product image', 10, hasImage);

  // Specs score incrementally — each of the first 3 specs is worth a third of
  // the 30 points, so every selection visibly bumps the score (better fill rate).
  const filledSpecs = Object.values(form.dynamicSpecs ?? {}).filter((v) => v?.trim()).length;
  const specTarget = Math.min(3, isqSpecs.length);
  const specEarned = specTarget > 0 ? Math.round((30 * Math.min(filledSpecs, specTarget)) / specTarget) : 0;
  add('Specs', `Specifications (${Math.min(filledSpecs, specTarget)}/${specTarget})`, 30, filledSpecs >= specTarget, isqSpecs.length > 0, specEarned);

  add('Details', 'Delivery location', 8, !!form.deliveryLocation?.trim());
  // #79: the deterministic timeline/payment EDITOR (the old 'more' logistics card) is gone — these now live as
  // Commercial-page questions (LLM 2) and only reach these atoms via seed/recs. So they're BONUS-only: applicable
  // (and always earned) when a value is present, inapplicable when absent — never unearnable dead weight that caps
  // the dial below 100, and never a "fill next" nudge pointing at a field the buyer can no longer see.
  add('Details', 'Delivery timeline', 7, !!form.deliveryTimeline?.trim(), !!form.deliveryTimeline?.trim());
  add('Details', 'Payment terms', 10, !!form.paymentTerms?.trim(), !!form.paymentTerms?.trim());
  add('Details', 'Buyer type', 5, !!form.buyerType?.trim(), profileApplicable);
  // For End Users this captures "Buying for"; for business it's Industry.
  add('Details', 'Profile detail', 5, !!form.industry?.trim(), profileApplicable);
  add('Details', 'Purchase frequency', 5, !!form.requirementFrequency?.trim(), frequencyApplicable);
  // GST — only counts for a business role. "Answered" = Yes/No chosen (null = still unknown, not done).
  add('Details', 'GST', 5, form.gstRegistered === true || form.gstRegistered === false, gstApplicable);

  // Spec-adjacent context answered in the "more details" sheet — graded, so each
  // answer bumps the score and pulls completion up. Only counts when offered.
  const intentTotal = ctx.intentTotal ?? 0;
  const intentAnswered = Math.min(ctx.intentAnswered ?? 0, intentTotal);
  const intentEarned = intentTotal > 0 ? Math.round((6 * intentAnswered) / intentTotal) : 0;
  add(
    'Details',
    `Details for sellers${intentTotal > 0 ? ` (${intentAnswered}/${intentTotal})` : ''}`,
    6,
    intentTotal > 0 && intentAnswered >= intentTotal,
    intentTotal > 0,
    intentEarned
  );

  // Page-2 AI "Smart Questions" — graded like the intent bucket. Only counts when questions are surfaced
  // (aiSpecTotal>0); while page-2 is loading / errored / empty it is inapplicable → normalized OUT, never
  // a scored-zero. So a planner failure or a category with no extra questions never tanks the score.
  const aiSpecEarned = aiSpecTotal > 0 ? Math.round((10 * aiSpecAnswered) / aiSpecTotal) : 0;
  add(
    'Specs',
    `Smart questions${aiSpecTotal > 0 ? ` (${aiSpecAnswered}/${aiSpecTotal})` : ''}`,
    10,
    aiSpecTotal > 0 && aiSpecAnswered >= aiSpecTotal,
    aiSpecTotal > 0,
    aiSpecEarned
  );

  // Normalise to 100 over the applicable points so every category can reach 100.
  const total = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  return { total: Math.min(100, total), checks };
}

export function getScoreColor(score: number): string {
  if (score < 30) return '#ef4444'; // red
  if (score < 50) return '#f97316'; // orange
  if (score < 70) return '#eab308'; // yellow
  if (score < 85) return '#3b82f6'; // blue
  return '#22c55e'; // green
}

export function getScoreLabel(score: number): string {
  if (score < 30) return 'Weak';
  if (score < 50) return 'Fair';
  if (score < 70) return 'Good';
  if (score < 85) return 'Strong';
  return 'Excellent';
}

export function lerpColor(a: string, b: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bv = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bv})`;
}
