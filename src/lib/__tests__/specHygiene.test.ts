/// <reference types="node" />
// ─── SPEC HYGIENE — the two shipped defects, pinned ───────────────────────────
// Run: npm test
//
// specHygiene.ts exists to SUPPRESS two things the ISQ payload asks the form to render:
//   1. an input-TYPE token ("Text") offered as a QUANTITY UNIT, and
//   2. a sibling-product CHOOSER ("I am interested in") offered as an attribute question.
//
// Both rules are one-directional — they delete. So this file spends most of its assertions on the
// NEGATIVE side: the real units and the real ISQ specs that must survive untouched. A false positive
// here silently removes a legitimate buyer question or a legitimate order unit, which is a worse
// outcome than the defect being fixed, and it fails invisibly (nothing appears in the UI to notice).
//
// The negative sets are not invented. They were mined from every captured ISQ payload in the repo —
// 76 distinct IM_SPEC_MASTER_DESC values and the real Quantity-Unit option vocabulary. Only the
// SCHEMA side is reproduced below (spec names + unit vocabulary, which are MCAT metadata); the
// buyer-supplied ANSWER values in those captures live under a gitignored PII path and stay there.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUnitNoise, sanitizeUnitOptions, isProductInterestField, isNonSpecNote, cleanBuyerText, isIllegalQuestion, isSupplierPrefField } from '../specHygiene.ts';
import { REPO_ROOT } from './repoScan.ts';

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 1 — "Text" rendered as a quantity unit
// ═════════════════════════════════════════════════════════════════════════════

/** Input-TYPE tokens that leak out of IM_SPEC_OPTIONS_DESC. Every one MUST be dropped.
 *  "Text" is not hypothetical: in the captured payloads the free-text rows "Grade",
 *  "Probable Order Value" and "Probable Requirement Type" all carry the literal string
 *  "Text" in their options column — that is where the buyer's unit dropdown got it. */
const UNIT_NOISE_INPUTS = [
  'Text', 'text', ' TEXT ', 'Textbox', 'Dropdown', 'Select', 'None', 'NA', 'null', 'Other', 'Other...',
];

/** Real order units. EVERY one of these contains a noise token as a substring, or sits one careless
 *  `.includes()` away from one — "Number of Pieces" contains "number", "Metric Tonne" contains "ton",
 *  "Text Book Sets" contains "text", "Selection"/"Nonetheless" contain "select"/"none". This is the
 *  containment class that has shipped three times in this repo, so the rule must be EXACT-match. */
// "Number" is here rather than in UNIT_NOISE_INPUTS on purpose (owner call, 2026-07-28): it is a real
// order unit in some mcats, no capture shows it used as an input-TYPE marker, and dropping it would strip
// the only unit such a buyer could pick. See the comment on UNIT_NOISE in specHygiene.ts.
const REAL_UNITS = [
  'Number', 'Number of Pieces', 'Metric Tonne', 'Text Book Sets', 'Nos', 'Piece', 'kg', 'Kilogram', 'Metre',
  'Square Feet', 'Litre', 'Dozen', 'Bag', 'Roll', 'Ream', 'Bundle', 'Carton', 'Set', 'Pair', 'Ton', 'Quintal',
];

/** The real Quantity-Unit option vocabulary, exactly as captured off getISQs. Nothing here is noise,
 *  so sanitizeUnitOptions must return it unchanged apart from the case-duplicate collapse. */
const CAPTURED_UNIT_VOCAB = [
  'Piece', 'Kg', 'Pack', 'Bottle', 'Quintal', 'Tonne (MT)', 'Tonne', 'Box', 'Bag', 'Dozen',
];

describe('defect 1 — "Text" reached the Quantity-Unit dropdown', () => {
  test('the shipped filter really does let "Text" through (the bug, demonstrated)', () => {
    // deriveUnits() filtered exactly one token: `o.toLowerCase() !== 'none'`. Replayed here so the
    // fix has a documented "before". The buyer saw Quantity 100000 · Unit ▾ [Text, kg].
    const shipped = (opts: string[]) => opts.filter((o) => o && o.toLowerCase() !== 'none');
    assert.deepEqual(shipped(['Text', 'kg']), ['Text', 'kg'], 'precondition: the old filter keeps "Text" — that is the defect');
    assert.deepEqual(sanitizeUnitOptions(['Text', 'kg']), ['kg'], 'sanitizeUnitOptions must drop it and keep the real unit');
  });

  test('every input-type artefact is classified as noise and dropped', () => {
    const survivors = UNIT_NOISE_INPUTS.filter((o) => !isUnitNoise(o));
    assert.deepEqual(survivors, [], `these are input-type tokens, never units: ${survivors.join(' · ')}`);
    assert.deepEqual(sanitizeUnitOptions([...UNIT_NOISE_INPUTS, 'kg']), ['kg'], 'a list of nothing but artefacts must reduce to the real units only');
  });

  test('every real unit survives — the rule matches whole values, never substrings', () => {
    const casualties = REAL_UNITS.filter((u) => isUnitNoise(u));
    assert.deepEqual(
      casualties, [],
      `real order units were classified as noise: ${casualties.join(' · ')}.\n`
      + '      Each of these CONTAINS a noise token. isUnitNoise must compare the whole normalised\n'
      + '      value against the noise set — a substring/containment test here ships a form with no\n'
      + '      unit to choose, which is the Capa-CITY class applied to the unit dropdown.',
    );
    assert.deepEqual(sanitizeUnitOptions(REAL_UNITS), REAL_UNITS, 'sanitizeUnitOptions must pass a pure unit list through untouched');
  });

  test('a noise token glued into a longer word does not make that word noise', () => {
    // The trap words nobody has thought of yet: if the rule ever drifts to containment, these go first.
    for (const w of ['Textile', 'Context', 'Numbers', 'Selection', 'Nonetheless', 'Nano', 'Other Sizes', 'Strings', 'Nullah']) {
      assert.equal(isUnitNoise(w), false, `${JSON.stringify(w)} merely CONTAINS a noise token — it must survive`);
    }
    for (const t of UNIT_NOISE_INPUTS.map((s) => s.trim()).filter(Boolean)) {
      assert.equal(isUnitNoise(`${t}ium`), false, `${JSON.stringify(`${t}ium`)} is a different value from ${JSON.stringify(t)} and must survive`);
      assert.equal(isUnitNoise(`pre${t}`), false, `${JSON.stringify(`pre${t}`)} is a different value from ${JSON.stringify(t)} and must survive`);
    }
  });

  test('the real captured Quantity-Unit vocabulary survives intact', () => {
    assert.deepEqual(
      sanitizeUnitOptions(CAPTURED_UNIT_VOCAB), CAPTURED_UNIT_VOCAB,
      'this is the live option list off getISQs — the hygiene rule must be invisible to it',
    );
  });

  test('order is preserved and duplicates collapse case-insensitively', () => {
    // Order is the seller-facing default: the first option is what the buyer gets pre-selected, so a
    // rule that reorders silently changes the unit shipped on every requirement.
    assert.deepEqual(sanitizeUnitOptions(['Piece', 'Kg', 'Text', 'kg', 'KG', 'piece', 'Bag']), ['Piece', 'Kg', 'Bag']);
    assert.deepEqual(sanitizeUnitOptions(['Metric Tonne', 'metric  tonne', 'METRIC-TONNE']), ['Metric Tonne'], 'separator and case variants are the same unit; the first spelling wins');
  });

  test('empty, whitespace and non-array input are safe', () => {
    assert.deepEqual(sanitizeUnitOptions([]), []);
    assert.deepEqual(sanitizeUnitOptions(['', '   ', '\t', 'kg']), ['kg']);
    assert.equal(isUnitNoise(''), true);
    assert.equal(isUnitNoise('   '), true);
    // The list is built from a raw payload column, so an absent/renamed column arrives as undefined.
    // A hygiene rule that throws takes the whole form down — worse than the dropdown it was cleaning.
    for (const bad of [undefined, null, 0, 'kg', {}]) {
      assert.deepEqual(sanitizeUnitOptions(bad as unknown as string[]), [], `non-array input ${JSON.stringify(bad) ?? 'undefined'} must yield [] and never throw`);
    }
    assert.deepEqual(sanitizeUnitOptions([null, undefined, 'kg'] as unknown as string[]), ['kg'], 'holes inside the array must not become unit options');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 2 — "I am interested in" asked as if it were a spec
// ═════════════════════════════════════════════════════════════════════════════

/** Phrasings that ask WHICH PRODUCT. The buyer already named the product, so these burn a slot. */
const PRODUCT_CHOOSERS = [
  'I am interested in', 'Interested In', 'Looking for', 'Looking to buy',
  'Product Required', 'Required Product', 'Select Product', 'Which product do you need',
];

/** Legitimate buyer questions that must NEVER be suppressed. "Product Type" and "Product Form" are
 *  the load-bearing entries: both are real ISQ specs in captured data (GLID 244092512 answered
 *  "Product Type" with a real value), so a rule with a bare `product` alternative would delete them.
 *  "Product Description" is a real free-text ISQ and must survive too. */
const LEGITIMATE_SPECS = [
  'Paper Type', 'Machine Type', 'Product Type', 'Material', 'Material Grade', 'Grade', 'GSM',
  'Automation Grade', 'Cutting Machine Size', 'Fuel Type', 'Condition', 'Surface Finish',
  'Vehicle Type', 'Machine Components', 'Application', 'Usage/Application', 'Brand', 'Capacity',
  'Colour', 'Size', 'Packaging Type', 'Certification', 'Warranty', 'Power Source', 'Voltage',
  'Body Material', 'End Use', 'Product Description',
];

/** EVERY distinct IM_SPEC_MASTER_DESC found in the repo's captured ISQ payloads (28 files, 76 names).
 *  Exactly one of them is the defect. The assertion below is "76 in, 1 out, and it is that one" —
 *  which is a far stronger statement than any hand-picked negative list, because it is the real
 *  category schema the form actually renders. */
const CAPTURED_SPEC_NAMES = [
  'Additional Requirements', 'Application', 'Attachment Type', 'Automation Grade', 'Box Type',
  'Brand', 'Buyer Filled Details', 'Capacity', 'Capacity (Weight)', 'Color', 'Compatible Tractor Brand',
  'Compatible Tractor Model', 'Condition', 'Cutter Bar Width', 'Cutting Machine Size', 'Design',
  'Device Category', 'Duration', 'Engine Power', 'Finance/Loan Requirement', 'Finish', 'Finish Material',
  'Form', 'Fuel Type', 'GSM', 'Grade', 'Height', 'I am interested in', 'Length', 'Machine Components',
  'Machine Type', 'Material', 'Material Grade', 'Mesh Size', 'Mobility Type', 'Model',
  'Model Name/number', 'Motor Power', 'Net Type', 'Number of Modules', 'Number of Shots',
  'Operation Mode', 'Orientation', 'Origin', 'Other Details', 'Pack Size', 'Packaging Capacity',
  'Packaging Size', 'Packaging Type', 'Physical State', 'Pouch Type', 'Probable Order Value',
  'Probable Requirement Type', 'Product Form', 'Product Type', 'Production Capacity', 'Quantity',
  'Quantity Unit', 'Rated Power', 'Screen Size', 'Seal Type', 'Shape', 'Size', 'Source Material',
  'Steering Capacity', 'Storage Capacity', 'Surface Finish', 'Thickness', 'Transparency', 'Type',
  'Type of Requirement', 'Usage/Application', 'Vehicle Type', 'Wheel Diameter', 'Width', 'Wire Size',
];

describe('defect 2 — a product chooser masquerading as a spec', () => {
  test('the product-chooser phrasings are suppressed', () => {
    const missed = PRODUCT_CHOOSERS.filter((n) => !isProductInterestField(n));
    assert.deepEqual(missed, [], `these re-ask the product the buyer already named: ${missed.join(' · ')}`);
  });

  test('…in snake_case KEY form too — neither \\b nor \\W breaks on "_"', () => {
    // Field names reach this rule in both human and key form (the engine's own decision stream carries
    // `order_value`, `requirement_type`, `purchase_frequency`). A `(^|\W)…(\W|$)` anchor matched the
    // human form and silently missed EVERY key form — the same underscore hole that made a \b-based
    // delivery test miss `delivery_city`. Separators must be normalised to spaces before matching.
    const keys = PRODUCT_CHOOSERS.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    const missed = keys.filter((k) => !isProductInterestField(k));
    assert.deepEqual(missed, [], `snake_case keys route differently from their human labels: ${missed.join(' · ')}`);
  });

  test('legitimate ISQ attributes are NEVER suppressed', () => {
    const casualties = LEGITIMATE_SPECS.filter((n) => isProductInterestField(n));
    assert.deepEqual(
      casualties, [],
      `real buyer questions would be deleted: ${casualties.join(' · ')}.\n`
      + '      This failure mode is invisible — the question simply never renders, and the seller gets\n'
      + '      a requirement missing the one attribute that decides the quote. Narrow the rule; do not\n'
      + '      add a bare `type` / `product` / `interested` alternative.',
    );
  });

  test('all 76 real ISQ spec names survive — except the one that is the defect', () => {
    const tripped = CAPTURED_SPEC_NAMES.filter((n) => isProductInterestField(n));
    assert.ok(CAPTURED_SPEC_NAMES.length >= 76, 'the mined name list has shrunk — restore it, do not trim the evidence');
    assert.deepEqual(
      tripped, ['I am interested in'],
      'the rule must fire on exactly one real spec name. Anything else in this list is a real question '
      + 'being deleted; an empty list means the defect is no longer being caught at all.',
    );
  });

  test('the committed fixtures\' own decision fields all survive', () => {
    // Read live rather than hardcoded, so a fixture that adds a new field is checked automatically.
    // These include full-sentence engine questions ("What is this for?", "How soon do you need it?")
    // which are the closest thing in real data to the chooser phrasings.
    const fixtures = JSON.parse(readFileSync(join(REPO_ROOT, 'src/lib/brains/requirementBrainFixtures.json'), 'utf8')) as
      Record<string, { decisions?: { field: string }[] }>;
    const fields = [...new Set(Object.values(fixtures).flatMap((p) => (p.decisions ?? []).map((d) => d.field)))].filter(Boolean);
    assert.ok(fields.length >= 20, `only ${fields.length} fixture fields parsed — the reader is broken, not the rule`);
    const casualties = fields.filter((f) => isProductInterestField(f));
    assert.deepEqual(casualties, [], `fields the engine really emits would be dropped: ${casualties.join(' · ')}`);
  });

  test('no chooser phrase matches inside a longer word', () => {
    for (const w of ['Uninterested in', 'Disinterested in', 'Overlooking format', 'Byproduct Required', 'Preselect Product Code']) {
      assert.equal(isProductInterestField(w), false, `${JSON.stringify(w)} only CONTAINS a chooser phrase — the re-SELLER class`);
    }
    // Glue letters onto BOTH ends of EVERY word, so no alternative survives as whole words. Gluing one
    // end only is not a valid negative for a multi-word phrase: "zqI am interested in" still contains
    // the whole words "interested in", and that genuinely IS the chooser — suppressing it would be the
    // false-negative mirror of the bug. Every literal word must be whole for the rule to fire.
    for (const p of PRODUCT_CHOOSERS) {
      const glued = p.trim().split(/\s+/).map((w) => `zq${w}zq`).join(' ');
      assert.equal(isProductInterestField(glued), false, `no word of the phrase is intact, so this is a different question: ${JSON.stringify(glued)}`);
    }
  });

  test('blank and missing names are kept, not suppressed', () => {
    // "When in doubt, keep it": an unnamed row is a data problem, not a licence to delete a question.
    for (const n of ['', '   ', undefined, null]) {
      assert.equal(isProductInterestField(n as unknown as string), false, 'an empty name must not be treated as a product chooser');
    }
  });

  test('the options argument is inert — there is deliberately no options-shape heuristic', () => {
    // An "do these options look like sibling products?" rule cannot work, and the captured data says
    // why: the legitimate spec "Product Type" is answered with a PRODUCT NAME ("Bijli Crackers"), and
    // "Machine Components" with what read as product/service names ("Cut Stitch Square", "Cutting
    // Only"). Any shape test that flags product-looking options deletes those real questions. So the
    // second argument must stay unused. This test is the tripwire: if someone starts reading it, the
    // negative sets above have to be re-proved on real fixtures first.
    const siblingProducts = ['Old Newspapers', 'Paper Plate Raw Material', 'Waste Paper', 'Dona Paper Roll', 'Carton Scrap', 'Other...'];
    for (const n of ['Product Type', 'Machine Components', 'Material', 'Source Material', 'Grade']) {
      assert.equal(
        isProductInterestField(n, siblingProducts), false,
        `${JSON.stringify(n)} is a real ISQ spec — its options must not decide whether the question is asked`,
      );
    }
    // …and the name rule alone still catches the defect, with or without options.
    assert.equal(isProductInterestField('I am interested in', siblingProducts), true);
    assert.equal(isProductInterestField('I am interested in', []), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 3 — platform-deduced / free-text buyer-note sentinels rendered as SPECS
// ═════════════════════════════════════════════════════════════════════════════
// "Buyer Filled Details" (buyer free-text note), "Probable Order Value" and "Probable Requirement
// Type" (platform-deduced) carry IM_SPEC_MASTER_ID '-1' / options "Text". requirements.ts routes
// them to notes / drops them; the brain form must NOT ship them as product attributes. A garbled
// chat phrase ("Tino, Kanpur btao") under "Buyer Filled Details" leaked onto Page 1 in a live run.
describe('isNonSpecNote — sentinel note/deduced rows are not product specs', () => {
  test('flags the three sentinels, case/spacing-insensitively', () => {
    for (const n of ['Buyer Filled Details', 'buyer filled details', '  Buyer  Filled  Details ', 'Probable Order Value', 'Probable Requirement Type', 'PROBABLE ORDER VALUE']) {
      assert.equal(isNonSpecNote(n), true, `${JSON.stringify(n)} must be suppressed from specs`);
    }
  });
  test('never over-matches a real ISQ spec (exact match only)', () => {
    for (const n of ['Automation Grade', 'Machine Components', 'Cutting Machine Size', 'Production Capacity', 'Finance/Loan Requirement', 'Material', 'Grade', 'Order Value', 'Requirement Type', 'Buyer Type', 'Details', 'Probable Yield']) {
      assert.equal(isNonSpecNote(n), false, `${JSON.stringify(n)} is a legitimate spec and must survive`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFECT 4 — buyer-facing hygiene (owner items 4b + 14, 2026-08-13)
// ═════════════════════════════════════════════════════════════════════════════
// (a) cleanBuyerText strips the AI-debug "PICKED:/DROPPED:" markers that leaked onto page 2
//     ("PICKED: Manufacturer / Authorized Dealer — Aligns with …"); it must NEVER touch real content.
// (b) isIllegalQuestion drops a GST-invoice / tax / payment-protection ask (Indian B2B), but must
//     NOT over-match a legitimate spec that merely contains "tax"/"gst".
// (c) isSupplierPrefField flags supplier-type preference fields (never prefill), without eating real specs.
describe('cleanBuyerText — strips debug-reasoning markers only', () => {
  test('removes PICKED/DROPPED/WEIGHED prefixes (any separator, case-insensitive)', () => {
    assert.equal(cleanBuyerText('PICKED: Manufacturer / Authorized Dealer'), 'Manufacturer / Authorized Dealer');
    assert.equal(cleanBuyerText('dropped - Wholesaler'), 'Wholesaler');
    assert.equal(cleanBuyerText('WEIGHED — Trader'), 'Trader');
    assert.equal(cleanBuyerText('  picked:  10 kg'), '10 kg');
  });
  test('leaves clean buyer text untouched (incl. embedded but non-prefix words)', () => {
    for (const s of ['Manufacturer', 'Delivery timeline', 'Hand-picked cotton', 'Payment terms', '']) {
      assert.equal(cleanBuyerText(s), s.trim());
    }
    assert.equal(cleanBuyerText(null), '');
  });
});
describe('isIllegalQuestion — drops illegal asks, keeps real specs', () => {
  test('flags GST-invoice / tax-invoice / payment-protection / escrow questions', () => {
    assert.equal(isIllegalQuestion('GST Invoice Requirement', ['Required For Business Records', 'Not Required']), true);
    assert.equal(isIllegalQuestion('Tax invoice needed?'), true);
    assert.equal(isIllegalQuestion('Buyer payment protection plan'), true);
    assert.equal(isIllegalQuestion('Escrow preference'), true);
  });
  test('never drops a legitimate spec that merely contains gst/tax', () => {
    for (const q of ['Tax Invoice Printer', 'GST Billing Software', 'Delivery timeline', 'Preferred brand', 'Order quantity']) {
      assert.equal(isIllegalQuestion(q), false, `${JSON.stringify(q)} is a real spec/question and must survive`);
    }
  });
});
describe('isSupplierPrefField — flags supplier-type preference only', () => {
  test('flags supplier-type / preferred-supplier fields', () => {
    for (const f of ['supplier_type', 'Preferred supplier category', 'preferred_seller', 'Vendor type', 'manufacturer vs trader']) {
      assert.equal(isSupplierPrefField(f), true, `${JSON.stringify(f)} must be flagged`);
    }
  });
  test('does not flag real product specs', () => {
    for (const f of ['Material', 'Brand', 'Delivery timeline', 'Capacity', 'Automation Grade', 'Application']) {
      assert.equal(isSupplierPrefField(f), false, `${JSON.stringify(f)} is a real spec and must not be flagged`);
    }
  });
});
