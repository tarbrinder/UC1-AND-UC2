// ─── PAN DECODE (deterministic, no LLM) — person/entity identification from a PAN ─────────────────────────
// A PAN is 10 chars: [3 alpha series][1 holder-type][1 surname/entity initial][4 digits][1 check letter].
// The 4th char is the entity type (P=Individual, C=Company …); the 5th is the first letter of the holder's
// surname (individual) or entity name. We decode entity type + a surname-initial cross-check + format validity.
// Single-source/deterministic → gets the `deterministic` provenance badge (the LLM does no reasoning here).
// Harnessed in scripts/decodetest.mjs (logic replicated in JS, per the project's no-TS-import test convention).

// 4th-char holder-type map (the authoritative ITD set; E/K appear in some newer/older series).
export const PAN_ENTITY: Record<string, string> = {
  P: 'Individual',
  C: 'Company',
  H: 'Hindu Undivided Family (HUF)',
  F: 'Firm / LLP',
  A: 'Association of Persons (AOP)',
  T: 'Trust',
  B: 'Body of Individuals (BOI)',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
  G: 'Government',
  E: 'LLP / limited liability partnership',
  K: 'Trust (Krish, legacy series)',
};

export interface PanInfo {
  pan: string;
  valid: boolean;            // matches the canonical PAN format
  entityChar: string;        // 4th char
  entityType: string;        // resolved label, or 'Unknown'
  isIndividual: boolean;
  surnameInitial: string;    // 5th char — surname (individual) or entity-name initial
  nameMatch: 'match' | 'mismatch' | 'unknown'; // vs the resolved name's surname initial (only when we have a surname)
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function decodePAN(pan?: string | null, resolvedName?: string | null): PanInfo | null {
  const p = String(pan || '').trim().toUpperCase();
  if (!p) return null;
  const valid = PAN_RE.test(p);
  const entityChar = p.charAt(3);
  const surnameInitial = p.charAt(4);
  const isIndividual = entityChar === 'P';
  // surname-initial cross-check is ONLY meaningful for an individual AND only when we actually have a surname.
  // (A first-name-only resolved name must NOT produce a false mismatch — that was the bug in the draft decoder.)
  let nameMatch: PanInfo['nameMatch'] = 'unknown';
  const parts = String(resolvedName || '').trim().split(/\s+/).filter(Boolean);
  if (isIndividual && valid && parts.length > 1 && /[A-Z]/.test(surnameInitial)) {
    const expected = parts[parts.length - 1].charAt(0).toUpperCase();
    nameMatch = expected === surnameInitial ? 'match' : 'mismatch';
  }
  return { pan: p, valid, entityChar, entityType: PAN_ENTITY[entityChar] || 'Unknown', isIndividual, surnameInitial, nameMatch };
}

// decode a set of PANs (some buyers carry 2 in external data) → list + a distinct-duplicate data-quality flag
export function decodePANs(pans: Array<string | null | undefined>, resolvedName?: string | null): { infos: PanInfo[]; duplicate: boolean } {
  const infos = pans.map((x) => decodePAN(x, resolvedName)).filter((x): x is PanInfo => !!x);
  const distinct = new Set(infos.map((i) => i.pan));
  return { infos, duplicate: infos.length > 1 && distinct.size > 1 }; // two *different* PANs on file = flag
}
