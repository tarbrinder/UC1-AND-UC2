// ─── CEO / UNIFIED REQUIREMENT SUMMARY (Phase C) ──────────────────────────────
// The intelligence already exists (Requirement Understanding dims · completeness · contradictions);
// what's missing is the one-glance synthesis a CEO (or a seller) reads before acting:
//   What we KNOW · What we THINK · What we still NEED · What looks UNUSUAL
// Pure bucketing over the existing signals — no new intelligence, no LLM. The "Golden Rule" holds:
// a dim with no evidence is "still need", never a guess in the "know" column.

export interface SummaryDim {
  label: string;
  value: string;
  state: 'Confirmed' | 'Likely' | 'Weak' | 'Unknown' | 'Contradicted';
  confidence: number;
  source?: string;
}
export interface CEOSummaryInput {
  dims: SummaryDim[];
  missingRequired?: string[]; // completeness.missingRequired (must-have specs not yet filled)
  conflicts?: string[];       // consistency/contradiction one-liners
  offProfile?: boolean;       // current product unrelated to history
}
export interface CEOSummary {
  know: Array<{ label: string; value: string; source?: string }>;   // Confirmed
  think: Array<{ label: string; value: string; confidence: number }>; // Likely / Weak (with caveat)
  stillNeed: string[];   // Unknown dims + missing must-have specs
  unusual: string[];     // Contradicted dims + conflicts + off-profile
  readiness: number;     // % of dims that are Confirmed or Likely (how complete the picture is)
}

export function buildCEOSummary(input: CEOSummaryInput): CEOSummary {
  const dims = input.dims || [];
  const know = dims.filter((d) => d.state === 'Confirmed' && d.value).map((d) => ({ label: d.label, value: d.value, source: d.source }));
  const think = dims.filter((d) => (d.state === 'Likely' || d.state === 'Weak') && d.value).map((d) => ({ label: d.label, value: d.value, confidence: d.confidence }));
  const unknownDims = dims.filter((d) => d.state === 'Unknown').map((d) => d.label);
  const stillNeed = [...new Set([...(input.missingRequired || []), ...unknownDims])];
  const unusual = [
    ...dims.filter((d) => d.state === 'Contradicted').map((d) => `${d.label}: ${d.value || 'conflicting signals'}`),
    ...(input.conflicts || []),
    ...(input.offProfile ? ['New area for this buyer — current product is unrelated to their history'] : []),
  ];
  const denom = dims.length || 1;
  const readiness = Math.round(((know.length + think.length) / denom) * 100);
  return { know, think, stillNeed, unusual, readiness };
}

// One-line headline for the panel header.
export function ceoHeadline(s: CEOSummary): string {
  return `${s.readiness}% understood · ${s.know.length} known · ${s.think.length} inferred · ${s.stillNeed.length} open${s.unusual.length ? ` · ${s.unusual.length} to check` : ''}`;
}
