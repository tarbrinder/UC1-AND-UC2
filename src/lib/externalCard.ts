// ─── EXTERNAL INTELLIGENCE CARD — Befisc/Sign3 (paid APIs) → first-class Buyer-360 intelligence ─────────
// External identity (Befisc) + digital footprint (Sign3) are TRUSTWORTHY paid-API signals — used like PNS
// for identity verification, business vintage, legitimacy, scale and trust. This groups them into a card
// beside the persona, each field tagged with its source. PURE · no LLM. Harnessed in scripts/provtest.mjs.

import type { Ledger } from './ledger';

export interface ExternalField { label: string; value: string; source: 'Befisc' | 'Sign3' }
export interface ExternalCard { present: boolean; befisc: ExternalField[]; sign3: ExternalField[]; count: number; note: string }

const prettify = (tag: string) => tag.replace(/^(befisc|sign3)\./i, '').replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

export function buildExternalCard(L: Ledger): ExternalCard {
  const mk = (node: 'befisc' | 'sign3', src: ExternalField['source']) => L.facts.filter((f) => f.sourceNode === node).map((f) => ({ label: prettify(f.tag), value: f.rawValue, source: src }));
  const befisc = mk('befisc', 'Befisc');
  const sign3 = mk('sign3', 'Sign3');
  return { present: befisc.length + sign3.length > 0, befisc, sign3, count: befisc.length + sign3.length, note: 'verified external intelligence (Befisc + Sign3, paid APIs) · first-class signal' };
}
