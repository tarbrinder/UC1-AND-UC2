/// <reference types="node" />
// ─── Word-boundary guard (shared helper) ─────────────────────────────────────
// Bug class (A): SUBSTRING CONTAINMENT IN FIELD ROUTING / NAME MATCHING.
// Three shipped incidents, one live-in-n8n:
//   1. field:'application'          collided with an ISQ spec literally named "Application",
//                                   silently suppressing a call-derived signal.
//   2. overlap()                    merged 'Sweet Packaging Tray' with 'Sweet Potatoes' on the one
//                                   shared token 'sweet' — 7 posted requirements absorbed into the
//                                   wrong cluster across 3 of 10 GLIDs.
//   3. DELIV = /deliver|location|city/i   matched "Capa-CITY", so `Storage Capacity: 1 kg` became
//                                   the buyer's delivery city. Shipped to users.
//   4. (live in n8n csl-to-llm1)    title.includes('seller') matches reseller / bestseller / the
//                                   buyer's own seller-panel traffic → "compared N suppliers"
//                                   inflated for ~41% of buyers.
//
// The common shape is always the same: a WORD is allowed to match INSIDE a longer word.
// Direction matters. A LEFT-unbounded match is the bug — "capa"+"city", "re"+"seller",
// "best"+"seller". A RIGHT-unbounded match is usually deliberate stemming ("manufactur" is meant
// to catch manufacturing/manufacturer), so this guard requires LEFT boundedness and leaves the
// right-hand side to the author.

import assert from 'node:assert/strict';

/** The canonical field-name normaliser. `\b` does NOT break on "_", so `delivery_city` would slip
 *  past a `\bcity\b` matcher; separators are collapsed to spaces and the result is space-padded so
 *  a matcher can anchor its alternatives on ' '. This is the same shape as formAdapter's private
 *  `words()` — import THIS one rather than copying it again. */
export const normaliseFieldName = (s: string): string =>
  ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Literal word-ish runs inside a regex source, as candidates for the boundary probe. */
export function literalWords(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/[a-z][a-z ]{2,}/gi)) {
    const w = m[0].trim();
    if (w.length >= 3) out.add(w);
  }
  return [...out];
}

/**
 * BEHAVIOURAL boundary probe — not a style check. For every literal word in the pattern, prefix it
 * with letters and ask the regex whether it still matches. `/city/i` says yes to "zqcity"
 * (therefore also to "capacity"); `/\bcity\b/i`, `/^city$/i` and `/ city /i` all say no.
 * Returns the words that are left-unbounded, i.e. the ones that can be swallowed by a longer word.
 */
export function leftUnboundedWords(re: RegExp): string[] {
  let probe: RegExp;
  try { probe = new RegExp(re.source, re.flags.replace(/[gy]/g, '')); } catch { return []; }
  const bad: string[] = [];
  for (const w of literalWords(re.source)) {
    try { if (probe.test(`zq${w}`)) bad.push(w); } catch { /* unprobeable pattern */ }
  }
  return bad;
}

/**
 * Assert a field-routing regex is word-bounded.
 *  · every `mustMatch` string matches (raw AND normalised — a router must survive delivery_city),
 *  · every `mustNotMatch` string does NOT match (raw AND normalised),
 *  · and no literal word in the pattern is left-unbounded, so the NEXT trap word nobody thought of
 *    is caught too. That third check is what would have stopped "Capa-CITY" before it shipped.
 */
export function assertWordBounded(
  re: RegExp,
  mustMatch: string[],
  mustNotMatch: string[],
  label = re.toString(),
): void {
  const hit = (s: string) => {
    const r = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
    return r.test(s) || r.test(normaliseFieldName(s));
  };
  for (const s of mustMatch) {
    assert.ok(hit(s), `${label} MUST match ${JSON.stringify(s)} — the router drops a field it is supposed to route`);
  }
  for (const s of mustNotMatch) {
    assert.ok(!hit(s), `${label} MUST NOT match ${JSON.stringify(s)} — substring containment; this is the Capa-CITY / re-SELLER class`);
  }
  const unbounded = leftUnboundedWords(re);
  assert.deepEqual(
    unbounded, [],
    `${label} has left-unbounded alternative(s) ${JSON.stringify(unbounded)}: each one matches inside a longer word `
    + `(e.g. "zq${unbounded[0] ?? ''}"). Anchor with \\b, ^…$, or space-pad the alternatives and normalise the input with normaliseFieldName().`,
  );
}
