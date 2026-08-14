// ─── SPEC HYGIENE ─────────────────────────────────────────────────────────────
// Deterministic, testable rules for deciding what an ISQ row is ALLOWED to become
// in the form. Two live defects motivated this file (owner, 2026-07-28):
//
//   1. "Text" rendered as a QUANTITY UNIT. deriveUnits() harvests
//      IM_SPEC_OPTIONS_DESC off the qty/unit field, and some mcats carry the
//      input-TYPE token ("Text") in that column rather than a real unit. The
//      buyer then picks "Text" as the unit of 100000 and that ships to sellers.
//
//   2. "I am interested in" asked as if it were a SPEC. Its options are sibling
//      MCAT products (Old Newspapers / Waste Paper / Dona Paper Roll ...), not
//      attribute values, so it re-asks the one thing the buyer already told us —
//      the product — and burns a question slot.
//
// FIREWALL NOTE: every rule here can only ever SUPPRESS or CANONICALISE. Nothing
// in this file may invent a value. A false positive deletes a legitimate buyer
// question, so each predicate is deliberately narrow: absent beats wrong, but a
// missing question is also wrong — when in doubt these return false (keep it).

/** Input-TYPE tokens that leak out of IM_SPEC_OPTIONS_DESC. Never real units.
 *  Confirmed in captured payloads: the free-text rows "Grade", "Probable Order Value" and
 *  "Probable Requirement Type" all carry the literal string "Text" in this column.
 *  Entries are matched against normOpt() output, so the punctuated spellings seen in the wild
 *  ("N/A", "Other...", "Drop-down") collapse onto the plain forms listed here. */
const UNIT_NOISE = new Set([
  'text', 'textbox', 'text box', 'freetext', 'free text', 'string',
  // 'number' is deliberately ABSENT (owner call, 2026-07-28). It was in the first draft of this set,
  // but "Number" is a REAL IndiaMART order unit in some mcats ("Number", "Nos"), and no captured payload
  // shows it used as an input-TYPE marker — only "Text" is. The costs are asymmetric: keeping it means at
  // worst one odd-looking option survives in one mcat, whereas dropping it strips the ONLY unit a buyer
  // could have picked, and an empty unit list changes the qty gate's behaviour. 'numeric'/'integer'/
  // 'decimal' stay: those are unambiguous input types and are never order units.
  'numeric', 'integer', 'decimal',
  'dropdown', 'drop down', 'select', 'multiselect', 'multi select', 'checkbox', 'radio',
  'none', 'na', 'n a', 'null', 'undefined', 'other', 'others', 'other...',
]);

const normOpt = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Space-PADDED field-name form, so a matcher can anchor every alternative on a literal ' '.
 *  Two reasons this exists rather than a `\b`/`\W` anchor:
 *   · `\b` and `\W` do NOT break on "_", so an ISQ key arriving as `i_am_interested_in` slips past a
 *     `\W`-anchored pattern entirely — the same underscore hole that made a `\b`-based delivery test
 *     miss `delivery_city`. Field names reach this file in BOTH human ("I am interested in") and key
 *     ("i_am_interested_in") form, so both must route identically.
 *   · padding lets the pattern demand a space on BOTH sides, which is what keeps a phrase from being
 *     matched inside a longer word (the Capa-CITY / re-SELLER class).
 *  Same shape as formAdapter's private `words()`; duplicated on purpose so this leaf module stays
 *  dependency-free (formAdapter does not export it, and importing it would be a cycle risk). */
const normName = (s: string): string => ` ${normOpt(s)} `;

/**
 * True when an option harvested for the Quantity-Unit picker is an input-type
 * artefact rather than a unit. EXACT (normalised) match only — a substring test
 * here would eat real units ("Number of Pieces" contains "number", "Metric
 * Tonne" contains "ton"), which is the containment bug class this repo has been
 * bitten by three times.
 */
export function isUnitNoise(opt: string): boolean {
  const n = normOpt(opt);
  return !n || UNIT_NOISE.has(n);
}

/**
 * Drop input-type artefacts from a derived unit list, preserving order + dedupe.
 *
 * Non-array input yields [] rather than throwing: every caller builds this list from a raw ISQ
 * payload (`IM_SPEC_OPTIONS_DESC.split('##')`), so an absent/renamed column arrives as undefined.
 * A hygiene rule that crashes the form is a worse outcome than the unit dropdown it was cleaning.
 */
export function sanitizeUnitOptions(opts: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of Array.isArray(opts) ? opts : []) {
    const t = String(o).trim();
    if (!t || isUnitNoise(t)) continue;
    if (!out.some((k) => normOpt(k) === normOpt(t))) out.push(t);
  }
  return out;
}

// A NARROW name rule. Only phrasings that ask WHICH PRODUCT, never phrasings that
// ask about a product ATTRIBUTE. "Paper Type", "Machine Type", "Product Type",
// "Material" and "Grade" are all legitimate ISQ specs in captured data and must not
// match — which is why there is no bare `type` / `product` alternative here.
//
// Every alternative is space-anchored on BOTH sides and matched against normName()
// output, never against the raw name. Anchoring is not cosmetic here: an earlier
// `(^|\W)…(\W|$)` form (a) missed every snake_case key because neither `\b` nor `\W`
// breaks on "_", and (b) tripped the repo's own left-boundedness sweep, because the
// "i am interested in" alternative could be re-entered mid-word through its shorter
// "interested in" sibling.
const INTEREST_NAME =
  / (i am interested in|interested in|looking (?:to buy|for)|product required|required product|select (?:your )?product|which product|product you (?:need|want|require)) /;

// ─── Is this row the dedicated QUANTITY/UNIT field? ──────────────────────────
// Promoted here (2026-07-28) because it existed in FOUR component copies and two of them —
// RFQModalV3.tsx:2555 and RFQModalV4.tsx, both live via MainApp — still used the ORIGINAL
// unbounded `/quantity|qty|unit/i.test(name)`. That substring test is the "1 kg" defect: it
// matches real specs like "Unit Weight", harvests their options as order units, and ships a
// bogus unit to sellers. Token-based instead: a row is the qty/unit field only when EVERY word
// in its name is a quantity/unit word AND at least one is a core term. So "Quantity", "Unit",
// "Quantity Unit", "Order Quantity", "Unit of Measurement", "MOQ" and "Number of Units" match,
// while "Unit Weight", "Control Unit", "Number Of Cores" and "Model Number" do not. (A whole-name
// equality test was tried first and wrongly missed "Quantity Unit" — hence tokens, not either extreme.)
const QTY_UNIT_CORE = new Set(['quantity', 'quantities', 'qty', 'unit', 'units', 'uom', 'moq']);
const QTY_UNIT_FILLER = new Set(['order', 'min', 'minimum', 'of', 'measure', 'measurement', 'required', 'no', 'the', 'number']);

export function isQtyUnitField(name: string): boolean {
  // Letters-only tokenisation, byte-for-byte the component rule this replaces. NOT normOpt(), which
  // keeps digits: "Quantity 2" would then tokenise as ["quantity","2"], the "2" would satisfy neither
  // set, and the row would stop being recognised as the qty field. Promoting a helper must not change
  // its behaviour.
  const toks = String(name).toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!toks.length) return false;
  return toks.some((t) => QTY_UNIT_CORE.has(t)) && toks.every((t) => QTY_UNIT_CORE.has(t) || QTY_UNIT_FILLER.has(t));
}

/**
 * True when an ISQ row is really a product CHOOSER masquerading as a spec, so it
 * should be suppressed (the buyer already named the product).
 *
 * Name-pattern only, by design. An options-shape heuristic ("do the options look
 * like sibling products?") was considered and left out, and the captured data says
 * why: the legitimate spec "Product Type" is answered with a PRODUCT NAME ("Bijli
 * Crackers"), and "Machine Components" with what read as product/service names
 * ("Cut Stitch Square", "Cutting Only"). Any shape test that flags product-looking
 * options therefore deletes those real questions. `_options` stays unused for that
 * reason — specHygiene.test.ts asserts it is inert. Extend this ONLY with a fixture
 * that proves the new case and leaves every negative case in that file green.
 */
export function isProductInterestField(name: string, _options: readonly string[] = []): boolean {
  return INTEREST_NAME.test(normName(name));
}

// Platform-deduced + free-text buyer-note SENTINEL rows that must never become a product SPEC. In captured payloads
// these carry IM_SPEC_MASTER_ID '-1' and IM_SPEC_OPTIONS_DESC 'Text'. Mirrors requirements.ts makeReq (owner rule,
// 2026): "Probable Order Value" / "Probable Requirement Type" are SYSTEM-deduced (dropped as specs), and "Buyer
// Filled Details" is the buyer's own free-text note → routed to NOTES, not specs. The brain form has no notes
// surface, so left unfiltered a garbled chat phrase ("Tino, Kanpur btao") leaked onto Page 1, into LLM 1's
// <already_filled>, and onto the submitted RFQ as if it were a machine attribute. EXACT normalised match only
// (never substring) — a real spec must never be caught. Extend only with a fixture in specHygiene.test.ts.
const NON_SPEC_NOTE = new Set(['buyer filled details', 'probable order value', 'probable requirement type']);
export function isNonSpecNote(name: string): boolean {
  return NON_SPEC_NOTE.has(normOpt(name));
}

/**
 * Strip DEBUG-reasoning markers from any BUYER-FACING string (owner item 14, 2026-08-13).
 * The planner's AI-debug mode is instructed (DEBUG_SUFFIX in llm.ts) to prefix a chosen option with "PICKED: "
 * (and a weighed-but-dropped one with "DROPPED: ") — internal analyst text that must NEVER reach the buyer's form.
 * The reported leak was a page-2 option rendering literally "PICKED: Manufacturer / Authorized Dealer — Aligns …".
 * Deterministic + render-time so it holds regardless of prod/debug: only removes the leading marker, never real content.
 */
export function cleanBuyerText(s: string | undefined | null): string {
  return String(s ?? '').replace(/^\s*(?:picked|dropped|weighed)\s*[:\-–—]\s*/i, '').trim();
}

/**
 * Backstop for the ILLEGAL-QUESTION guard (owner item 4b): a planner question/option about invoicing / tax-treatment /
 * payment-protection that slips past the prompt rule must never render. GST registration is asked deterministically
 * elsewhere, so a planner GST-invoice ask is both illegal and a duplicate. Narrow by design — matches the question
 * INTENT, not a bare "tax"/"gst" substring, so a legitimate spec ("Tax Invoice Printer") is never dropped.
 */
// Require the illegal INTENT, not a bare product word: "GST/Tax invoice REQUIREMENT/REQUIRED/NEEDED", "invoice
// requirement", "required for business records", "(buyer) payment protection", "escrow". "Tax Invoice Printer" and
// "GST Billing Software" are real products and must NOT match — hence the mandatory intent token after "invoice".
const ILLEGAL_Q = /(?:gst|tax)\s*invoice\s*(?:requirement|required|needed)|\binvoice\s*(?:requirement|required|needed)\b|required\s*for\s*business\s*records|(?:buyer\s*)?payment\s*protection|\bescrow\b/i;
export function isIllegalQuestion(label: string, options: readonly string[] = []): boolean {
  const hay = [label, ...options].join(' · ').replace(/[_-]+/g, ' ');
  return ILLEGAL_Q.test(hay);
}

/**
 * True when a planner field is a supplier-TYPE / preferred-supplier preference (owner item 14). Such a preference may
 * only be ASKED/suggested from category dominance, never prefilled/confirmed (llm.ts UNSTATED-PREFERENCE guard); this
 * predicate lets the frontend enforce the downgrade deterministically if a prefill/confirm slips through.
 */
const SUPPLIER_PREF = /(supplier|vendor|seller)\s*(type|category|preference)|preferred\s*(supplier|vendor|seller)|manufacturer\s*(vs|or)\s*(trader|wholesaler|dealer)/i;
export function isSupplierPrefField(fieldOrLabel: string): boolean {
  // Normalise snake_case/kebab-case field keys ("supplier_type", "preferred-seller") to spaces so the intent matches.
  return SUPPLIER_PREF.test(String(fieldOrLabel ?? '').replace(/[_-]+/g, ' '));
}
