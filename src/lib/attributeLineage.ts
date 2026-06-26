// ─── ATTRIBUTE LINEAGE (ChatGPT review — "why THIS answer won") ───────────────────────────────────────────
// Distinct from raw provenance: provenance says "where the value came from"; lineage says WHY it won — which
// source was authoritative, which sources merely supported, which alternatives were ruled out (conflicts), and
// what the LLM decided. PURE — a structuring of data the extract LLM already emits (reasoning_steps.from_evidence
// = supporters/evidence; reasoning_steps.rejected = conflicts). No new capture. Harnessed in scripts/attrlineagetest.mjs.

import type { FinalAttr } from './synthesisEngine';

export interface AttributeLineage {
  question: string;             // the buyer question (attribute label)
  finalValue: string;
  confidence: number;
  provenance: 'llm' | 'deterministic';
  winningSource: string;        // the most-authoritative cited source (per the Source Priority Matrix)
  supportingSources: string[];  // other cited sources that agreed
  conflictingSources: string[]; // alternatives the LLM explicitly ruled out (reasoning_steps.rejected)
  evidenceIds: string[];
  llmDecision: string;          // the lead claim — one line of "why"
  grounded: boolean;
}

// Authority rank (higher wins) by source-label substring — mirrors the Source Priority Matrix in the constitution.
const RANK: Array<[RegExp, number]> = [
  [/PNS/i, 6], [/WhatsApp/i, 5], [/Identity|Profile/i, 4], [/external|Befisc|Sign3/i, 4], [/GST/i, 4],
  [/Requirement|BuyLead|ISQ/i, 3], [/CSL/i, 2],
];
function rank(label: string): number { for (const [re, n] of RANK) if (re.test(label)) return n; return 1; }
const short = (label: string): string => String(label || '').split(/[·(⊕]/)[0].trim();

export function attributeLineage(f: FinalAttr, resolveNode: (id: string) => string | undefined): AttributeLineage {
  const steps = f.llm?.reasoning || [];
  const ids: string[] = [];
  const nodes = new Set<string>();
  const conflicts = new Set<string>();
  for (const s of steps) {
    for (const id of (s.evidence || [])) { ids.push(id); const n = resolveNode(id); if (n) nodes.add(short(n)); }
    if (s.rejected) conflicts.add(String(s.rejected));
  }
  const ranked = [...nodes].sort((a, b) => rank(b) - rank(a));
  return {
    question: f.label,
    finalValue: f.value,
    confidence: f.confidence,
    provenance: f.llm ? 'llm' : 'deterministic',
    winningSource: ranked[0] || (f.llm ? 'LLM (no cited source)' : 'deterministic (single source)'),
    supportingSources: ranked.slice(1),
    conflictingSources: [...conflicts],
    evidenceIds: [...new Set(ids)],
    llmDecision: steps[0]?.claim || f.value,
    grounded: f.llm?.grounded !== false,
  };
}
