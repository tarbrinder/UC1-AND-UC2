// ─── Knowledge Coverage Registry (A5) ────────────────────────────────────────
// The requirement's SYSTEM-OF-RECORD. Every fact any stage learns — the buyer's
// intent answer, a planner question answer, a high-confidence Twin trait, a spec
// pick, a cascade fill, a deduced value, a last-page answer — is recorded here
// under a NORMALISED concept. Every stage consults it (`isCovered`) before
// rendering a question/spec, so nothing is ever asked twice across intent →
// planner → specs → last page.
//
// Facts carry a LIFECYCLE (active | confirmed | overridden | rejected) so a
// contradiction (Twin: weekly, User: monthly) is REPRESENTED, not lost — the
// higher-authority value goes `active`, the older one `overridden`, and a
// lower-authority contradiction is kept as `rejected` for the debug trail.
//
// HARD RULE: concept folding is GENERIC (universal B2B concepts only) — NO
// category names, NO product/spec literals. Adding a category here is a bug.

export type FactStatus = 'active' | 'confirmed' | 'overridden' | 'rejected';
export type FactSource =
  | 'User' | 'Intent' | 'Planner' | 'Twin' | 'Cascade' | 'Deduced' | 'Spec' | 'LastPage' | 'Enrichment' | 'Verified';

export interface CoverageFact {
  concept: string; // normalised concept key (e.g. "intent", "cadence", "budget")
  rawKey: string; // the original field/question label — kept for provenance display
  value: string;
  source: FactSource;
  confidence: number; // 0..100
  status: FactStatus;
  evidence: string[]; // the source labels that support this fact (≥1; grows on corroboration)
  created_at: number; // first recorded
  updated_at: number; // last status/evidence change
}

// Who wins when two facts disagree on the same concept. The buyer's own answers
// outrank everything; deductions/Twin guesses rank lowest.
const AUTHORITY: Record<FactSource, number> = {
  // Verified third-party business truth (GST/HSN/Udyam/Website) outranks our own guesses
  // (Twin/Planner/Cascade/Deduced) but a buyer's own answer still overrides it.
  User: 100, LastPage: 95, Intent: 92, Spec: 85, Verified: 78, Planner: 70, Cascade: 55, Enrichment: 52, Twin: 50, Deduced: 40,
};

// Generic concept synonyms — fold many phrasings to ONE concept. Universal B2B
// concepts ONLY (intent / cadence / budget / scale / timeline). Location, payment,
// quantity, GST, firm, contact are dedicated form fields handled OUTSIDE the registry.
const CONCEPT_GROUPS: Record<string, string[]> = {
  intent: ['use case', 'use-case', 'usage', 'application', 'purpose', 'end use', 'end-use', 'suitable for', 'meant for', 'used for', 'primary use', 'requirement type', 'what will you use', 'what is this for'],
  cadence: ['frequency', 'how often', 'cadence', 'repeat order', 'recurring', 'replenish', 'reorder', 'purchase frequency'],
  budget: ['budget', 'price range', 'price band', 'estimated spend', 'spend per'],
  scale: ['scale', 'order volume', 'order size', 'project size', 'setup size', 'how big', 'units per', 'covers per'],
  timeline: ['timeline', 'how soon', 'lead time', 'urgency', 'delivery time', 'when do you need'],
};

// Normalise any field/question label to a canonical concept key. Falls back to a
// slugged version of the label itself, so two identically-named specs still de-dupe.
export function normalizeConcept(rawKey: string): string {
  // Split camelCase first so a raw key ("paymentTerms") folds to the SAME concept as its
  // spaced label ("Payment Terms") — else the Truth-Table dedup misses it and double-rows.
  const k = (rawKey || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  if (!k) return '';
  for (const [concept, syns] of Object.entries(CONCEPT_GROUPS)) {
    if (syns.some((s) => k.includes(s))) return concept;
  }
  return k.replace(/\s*\?+\s*$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface CoverageRegistry {
  record: (rawKey: string, value: string, source: FactSource, confidence: number, now?: number) => void;
  isCovered: (rawKeyOrConcept: string) => boolean; // active|confirmed fact exists for this concept
  coveredBy: (rawKeyOrConcept: string) => CoverageFact | null;
  conceptOf: (rawKey: string) => string;
  facts: () => CoverageFact[];
  reset: () => void;
}

export function createCoverageRegistry(): CoverageRegistry {
  let store: CoverageFact[] = [];
  const activeFor = (concept: string) =>
    store.find((f) => f.concept === concept && (f.status === 'active' || f.status === 'confirmed'));

  const record: CoverageRegistry['record'] = (rawKey, value, source, confidence, now = Date.now()) => {
    const concept = normalizeConcept(rawKey);
    const v = (value == null ? '' : String(value)).trim();
    if (!concept || !v) return;
    const prior = activeFor(concept);
    if (prior) {
      if (prior.value.toLowerCase() === v.toLowerCase()) {
        // Same value re-stated by a DIFFERENT, equal/higher-authority source → CONFIRMED
        // (independent corroboration). Same source re-stating (effect re-run) is a no-op.
        if (source !== prior.source && AUTHORITY[source] >= AUTHORITY[prior.source]) {
          prior.status = 'confirmed';
          if (!prior.evidence.includes(rawKey)) prior.evidence.push(rawKey);
          prior.updated_at = now;
        }
        return;
      }
      if (AUTHORITY[source] >= AUTHORITY[prior.source]) {
        prior.status = 'overridden'; // a higher (or equal) authority changed the answer
        prior.updated_at = now;
      } else {
        // A lower-authority source contradicts an active higher-authority fact — keep it
        // visible as `rejected` (the debug trail), but it never becomes the answer.
        store.push({ concept, rawKey, value: v, source, confidence, status: 'rejected', evidence: [rawKey], created_at: now, updated_at: now });
        return;
      }
    }
    store.push({ concept, rawKey, value: v, source, confidence, status: 'active', evidence: [rawKey], created_at: now, updated_at: now });
  };

  return {
    conceptOf: normalizeConcept,
    record,
    isCovered: (k) => !!activeFor(normalizeConcept(k)),
    coveredBy: (k) => activeFor(normalizeConcept(k)) || null,
    facts: () => store.slice(),
    reset: () => { store = []; },
  };
}
