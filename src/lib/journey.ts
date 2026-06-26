// ─── BUYER JOURNEY GRAPH (Wave 2D) — stitched requirements → a business arc + maturity ─────────────────
// Once requirements are stitched, the SEQUENCE tells a story: Machine → Raw material → Transport → Power
// → Expansion. This tags each requirement by its role and infers the operating arc + maturity. It's an
// INFERENCE (labelled as such), grounded in the requirement titles. PURE · deterministic · no LLM.
// Harnessed in scripts/reqtest.mjs.

import type { Requirement } from './requirements';

const ROLE_RULES: Array<[RegExp, string]> = [
  [/machine|making/i, 'Machinery'],
  [/raw material|\bpaper\b|\bmaterial\b|gsm/i, 'Raw material'],
  [/tipper|chhota hathi|\btempo\b|\btata\b|\bace\b|truck|transport/i, 'Transport'],
  [/generator|diesel|power|backup/i, 'Power backup'],
  [/manhole|\bfrp\b|cover|cement|construction/i, 'Construction'],
];
function roleOf(title: string): string { for (const [re, r] of ROLE_RULES) if (re.test(title)) return r; return 'Other'; }

export interface JourneyStep { title: string; role: string }
export interface Journey { steps: JourneyStep[]; roles: string[]; arc: string; maturity: string }

export function buildJourney(reqs: Requirement[]): Journey {
  const steps = reqs.map((r) => ({ title: r.title, role: roleOf(r.title) }));
  const roles = [...new Set(steps.map((s) => s.role))];
  const has = (r: string) => roles.includes(r);
  let arc = 'Procurement activity';
  if (has('Machinery') && has('Raw material')) arc = 'Setting up + operating a manufacturing unit';
  else if (has('Machinery')) arc = 'Acquiring production machinery';
  else if (has('Raw material')) arc = 'Procuring production inputs';
  const extras = [has('Transport') ? 'logistics' : '', has('Power backup') ? 'power backup' : '', has('Construction') ? 'facility build-out' : ''].filter(Boolean);
  if (extras.length) arc += ' + ' + extras.join(' + ');
  const breadth = roles.filter((r) => r !== 'Other').length;
  const maturity = breadth >= 3 ? 'Expansion phase' : (has('Machinery') && has('Raw material')) ? 'Growing manufacturer' : breadth >= 1 ? 'Emerging manufacturer' : 'Early enquiry';
  return { steps, roles, arc, maturity };
}
