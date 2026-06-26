// ─── CATEGORY CONSUMPTION — the richer layers (Phase: consume what v13 now emits) ─────────────
// v12's distill truncated after critical_specs. v13 emits the FULL object, so the form can finally
// consume the actionable layers it was throwing away:
//   • deal_blockers  → PRE-EMPTIVE checks (answer what sellers usually stall on, before they ask)
//   • intent_patterns → application chips + a load-sizing prompt flag
//   • price data      → category-grounded budget bands (kills "Under ₹2 lakh" for a capital generator)
// Pure · deterministic · GENERIC (keyword classification + numeric bands — NO category literals) · NO LLM.

export interface DealBlocker { name?: string; detail?: string; category?: string; frequency?: number }
export interface IntentPattern { intent?: string; frequency?: number }
export interface PriceDistribution { min?: number; median?: number; max?: number }

export type CheckKind = 'logistics' | 'condition' | 'price' | 'warranty' | 'technical' | 'availability' | 'other';
export interface ProactiveCheck { kind: CheckKind; label: string; frequency: number; evidence: string }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Generic blocker → check-kind classification. Keywords only; the same rules work for ANY category
// (a "logistics" blocker is a logistics blocker whether it's a generator or a paper order).
const KIND_RULES: { kind: CheckKind; re: RegExp; label: string }[] = [
  { kind: 'condition', re: /reconditi|refurbish|second.?hand|\bused\b|\bnew\b|model year|run hours|\bage\b/i, label: 'New, or is refurbished / second-hand acceptable?' },
  { kind: 'logistics', re: /logistic|deliver|transport|freight|shipping|dispatch|\bsite\b|installation site/i, label: 'Where is delivery, and who bears freight? (sellers commonly stall here)' },
  { kind: 'price', re: /price|budget|\brate\b|costly|expensive|negotiat|discount|too high/i, label: 'A budget range helps sellers quote in-band (this category negotiates hard)' },
  { kind: 'warranty', re: /warrant|guarantee|\bamc\b|service|after.?sale|support/i, label: 'Warranty / after-sales expectation?' },
  { kind: 'technical', re: /technical|\bload\b|compatib|\bhp\b|\bkva\b|\bkw\b|capacity|voltage|phase/i, label: 'Confirm the load / technical fit so sizing is right' },
  { kind: 'availability', re: /stock|availab|lead.?time|\beta\b/i, label: 'Do you need it in stock / by a date?' },
];

// deal_blockers → the TOP proactive checks the buyer can settle up-front. Deduped by kind, highest
// frequency first, and SUPPRESSED when the form already asked/knows that concept (no double-ask).
export function dealBlockerChecks(blockers: DealBlocker[] | undefined, opts: { knownKinds?: string[]; max?: number } = {}): ProactiveCheck[] {
  const known = new Set((opts.knownKinds || []).map(norm));
  const byKind = new Map<CheckKind, ProactiveCheck>();
  for (const b of blockers || []) {
    const text = `${b.category || ''} ${b.name || ''} ${b.detail || ''}`.trim();
    if (!text) continue;
    const rule = KIND_RULES.find((r) => r.re.test(text));
    const kind: CheckKind = rule ? rule.kind : 'other';
    if (known.has(norm(kind))) continue;       // already addressed → don't surface
    const freq = typeof b.frequency === 'number' ? b.frequency : 0;
    const prev = byKind.get(kind);
    if (!prev || freq > prev.frequency) byKind.set(kind, { kind, label: rule ? rule.label : text.slice(0, 90), frequency: freq, evidence: text.slice(0, 100) });
  }
  return [...byKind.values()].filter((c) => c.kind !== 'other').sort((a, b) => b.frequency - a.frequency).slice(0, opts.max ?? 2);
}

// intent_patterns → application chips (for intent) + whether load-based sizing is a thing in this
// category (so the planner/intent can ask "what load will this power?" → derive capacity).
export function intentPatternHints(patterns: IntentPattern[] | undefined, max = 5): { applications: string[]; loadSizingRelevant: boolean } {
  const ranked = [...(patterns || [])].filter((p) => p && p.intent).sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
  const applications = ranked.map((p) => String(p.intent)).slice(0, max);
  const loadSizingRelevant = ranked.some((p) => /\bload\b|\bhp\b|\bkva\b|\bkw\b|motor|power|run\b|sizing|capacity/i.test(String(p.intent)));
  return { applications, loadSizingRelevant };
}

// price distribution → 4 category-grounded budget bands. Generic round-number bands derived from the
// observed min/median/max (no hardcoded category prices). Returns null when there's no price signal
// (the form then keeps its existing generic bands).
const L = 100000;
function fmtINR(lakh: number): string {
  if (lakh >= 1) return `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(1)} lakh`;
  return `₹${Math.round(lakh * 100)}k`;
}
function roundLakh(v: number): number {
  const l = v / L;
  if (l < 1) return Math.max(0.25, Math.round(l * 4) / 4); // 25k steps below a lakh
  if (l < 10) return Math.round(l);                         // 1-lakh steps
  return Math.round(l / 5) * 5;                             // 5-lakh steps above 10L
}
export function categoryBudgetBands(dist: PriceDistribution | undefined): string[] | null {
  if (!dist || !(Number(dist.max) > 0)) return null;
  const min = Number(dist.min) > 0 ? Number(dist.min) : Number(dist.max) / 10;
  const max = Number(dist.max);
  if (max <= min * 1.2) return null; // no real spread (thin/uniform evidence) → keep the form's generic bands
  const med = Number(dist.median) > 0 ? Number(dist.median) : (min + max) / 2;
  let t1 = roundLakh(Math.max(min, med / 2));
  let t2 = roundLakh(med);
  let t3 = roundLakh(Math.min(max, med * 2));
  // ensure strictly increasing distinct thresholds (t* are in LAKH units → ×L back to rupees to re-round)
  if (t2 <= t1) t2 = roundLakh(t1 * 2 * L);
  if (t3 <= t2) t3 = roundLakh(t2 * 2 * L);
  if (t2 <= t1 || t3 <= t2) return null; // degenerate → fall back to generic bands
  return [`Under ${fmtINR(t1)}`, `${fmtINR(t1)}–${fmtINR(t2)}`, `${fmtINR(t2)}–${fmtINR(t3)}`, `${fmtINR(t3)}+`];
}

// One-line debug summary.
export function formatCategoryConsumption(checks: ProactiveCheck[], apps: string[], bands: string[] | null): string {
  const bits: string[] = [];
  if (checks.length) bits.push(`pre-empt: ${checks.map((c) => c.kind).join('/')}`);
  if (apps.length) bits.push(`apps: ${apps.slice(0, 3).join(', ')}`);
  if (bands) bits.push(`budget: ${bands[0]}…${bands[bands.length - 1]}`);
  return bits.join(' · ');
}
