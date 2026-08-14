/// <reference types="node" />
// ─── GUARDRAIL 1 — substring containment in field routing / name matching ────
// Run: npm test
//
// Part 1 replays the incidents that actually shipped, against the REAL matchers read off disk, so
// the guard is pinned to production code rather than a copy of it.
// Part 2 sweeps all of src/ for field-routing regexes and name-matching .includes(), and fails on
// anything not already in a documented baseline. The baseline can only shrink: a fixed finding must
// be deleted from it or the "baseline is current" test fails.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWordBounded, leftUnboundedWords, normaliseFieldName } from './wordBoundary.ts';
import {
  scanFieldRoutingRegexes, scanNameIncludes, regexKey, includesKey, extractRegexLiteral, REPO_ROOT,
} from './repoScan.ts';

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — the shipped incidents, replayed against the real source
// ═════════════════════════════════════════════════════════════════════════════

describe('incident 3 — DELIV matched "Capa-CITY" and shipped "1 kg" as the delivery city', () => {
  // Read the live matcher out of formAdapter.ts. If the anchor ever moves, this throws instead of
  // quietly passing — a guard that stops guarding is worse than no guard.
  const DELIV = extractRegexLiteral(
    'src/lib/brains/formAdapter.ts',
    /const\s+DELIV\s*=[\s\S]{0,160}?\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/([gimsuyv]*)\s*\.\s*test/,
    'the DELIV delivery-field matcher',
  );

  test('routes real delivery fields', () => {
    for (const f of ['delivery_city', 'Delivery Location', 'pin_code', 'Pincode', 'delivered to', 'city']) {
      assert.ok(DELIV.test(normaliseFieldName(f)), `DELIV must route ${JSON.stringify(f)} to deliveryLocation`);
    }
  });

  test('never routes a capacity spec into the delivery field', () => {
    // The exact shipped payload: fixture 106815489 carries `Capacity (Weight): 1 kg`.
    for (const f of ['Capacity', 'Velocity', 'Electricity', 'Storage Capacity', 'Capacity (Weight)', 'Load Capacity', 'Tank Capacity']) {
      assert.ok(!DELIV.test(normaliseFieldName(f)), `DELIV must NOT route ${JSON.stringify(f)} — this is the "1 kg delivery city" bug`);
      assert.ok(!DELIV.test(f), `DELIV must NOT route the raw form of ${JSON.stringify(f)} either`);
    }
  });

  test('is word-bounded, including against trap words nobody has thought of yet', () => {
    assertWordBounded(
      DELIV,
      ['delivery_city', 'Delivery Location', 'pin_code'],
      ['Capacity', 'Velocity', 'Electricity', 'Storage Capacity'],
      'formAdapter DELIV',
    );
  });
});

describe('incident 1 — field:"application" collided with the ISQ spec named "Application"', () => {
  // formAdapter routes these engine-internal context keys OUT of the ISQ spec chips.
  const CONTEXT_SKIP = extractRegexLiteral(
    'src/lib/brains/formAdapter.ts',
    /\/(\^\(order_value(?:(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+))\/([gimsuyv]*)/,
    'the formAdapter context-field skip-list',
  );

  test('routes the engine\'s own context keys', () => {
    for (const f of ['order_value', 'requirement_type', 'purchase_frequency', 'buyer_context']) {
      assert.ok(CONTEXT_SKIP.test(f), `${f} is an engine context key and must be skipped`);
    }
  });

  test('does not swallow a category ISQ spec that happens to be named "Application"', () => {
    // buildEvidence() emits the call-derived use-case as `buyer_context`, never as `application`.
    // The only thing `application` in this list can match is a real ISQ spec the buyer answered —
    // e.g. fixture 106815489, PREFILL `Application = "Ladoo Packaging"`, which is dropped from
    // specValues and therefore never reaches the seller.
    const fixtures = JSON.parse(readFileSync(join(REPO_ROOT, 'src/lib/brains/requirementBrainFixtures.json'), 'utf8')) as
      Record<string, { decisions?: { field: string; action: string; value?: string }[] }>;
    const casualties = Object.entries(fixtures).flatMap(([glid, p]) =>
      (p.decisions ?? [])
        .filter((d) => (d.action === 'PREFILL' || d.action === 'CONFIRM') && CONTEXT_SKIP.test(d.field))
        .filter((d) => !/^(order_value|requirement_type|purchase_frequency|buyer_context)$/i.test(d.field))
        .map((d) => `${glid}: ${d.field} = ${JSON.stringify(d.value)}`));

    assert.ok(
      !CONTEXT_SKIP.test('Application'),
      'formAdapter.ts skip-list matches the ISQ spec name "Application".\n'
      + `      Buyer-stated values dropped in the 3 captured fixtures: ${casualties.length ? casualties.join(' · ') : '(none in this sample)'}\n`
      + '      FIX: drop the `application|` alternative from the two skip-lists in formAdapter.ts\n'
      + '      (brainToSeed + recommendationToSeed). The engine emits the call-derived use-case as\n'
      + '      `buyer_context`; `application` can now only ever match a real ISQ spec.',
    );
  });
});

describe('incident 4 — title.includes("seller") matches reseller / bestseller (live in n8n csl-to-llm1)', () => {
  // The offender lives in the workflow, not this repo: csl-to-llm1 does
  //   if (title.includes('seller') || path.includes('seller')) { profileVisits++; … }
  // which counts the buyer's own seller-panel traffic and inflates "compared N suppliers" for ~41%
  // of buyers. This is the bounded replacement, specified as a test so the fix has a target.
  const SELLER_PAGE = / seller(s)? /;

  test('the naive matcher really does misfire (the bug, demonstrated)', () => {
    const naive = (s: string) => s.toLowerCase().includes('seller');
    for (const s of ['reseller', 'bestseller', 'Top Reseller Programme']) {
      assert.ok(naive(s), `precondition: includes('seller') matches ${JSON.stringify(s)} — that is the bug`);
    }
  });

  test('a bounded matcher accepts real supplier pages and rejects reseller / bestseller', () => {
    assertWordBounded(
      SELLER_PAGE,
      ['/soi/seller/info', 'seller.indiamart.com', 'sellers', 'Seller Profile'],
      ['reseller', 'bestseller', 'resellers', 'Reseller Panel'],
      'seller-page matcher',
    );
  });
});

describe('the boundary probe itself', () => {
  test('flags the pattern that shipped and clears the pattern that fixed it', () => {
    assert.deepEqual(leftUnboundedWords(/deliver|location|city/i).sort(), ['city', 'deliver', 'location']);
    assert.deepEqual(leftUnboundedWords(/ (deliver|delivery|location|city|pincode|pin code) /), []);
    assert.deepEqual(leftUnboundedWords(/^(quantity|qty)$/i), []);
    assert.deepEqual(leftUnboundedWords(/\bcity\b/i), []);
  });

  test('normaliseFieldName keeps underscore-separated names routable', () => {
    // `\b` does not break on "_", which is why /\bcity\b/ alone would miss delivery_city.
    assert.equal(normaliseFieldName('Delivery_City '), ' delivery city ');
    assert.equal(normaliseFieldName('Capacity (Weight)'), ' capacity weight ');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — repo sweep
// ═════════════════════════════════════════════════════════════════════════════

// Pre-existing findings, one line each: why it is here, and what fixing it looks like.
// Adding a line requires a reason. Removing a line is the only way this list is allowed to change.
const REGEX_BASELINE: Record<string, string> = {
  'src/components/RFQModalV3.tsx :: /img|image/i :: img|image':
    'legacy V3 modal — picks the image column out of McatDtl keys. A key like "trimming" cannot occur there today, but the pattern is one column-rename away from misfiring. TODO: /\\b(img|image)\\b/i.',
  'src/components/RFQModalV4.tsx :: /img|image/i :: img|image':
    'identical copy of the V3 line above (V4 is a fork of V3). TODO: fix both together.',
  'src/components/SimpleRFQForm.tsx :: /smart/i :: smart':
    'routes a score-check label to the "aispecs" stage (twice, lines 971 + 1098). Matches any label containing smart — "Smartphone" and "Smart TV" are real category words. TODO: match the check id, not its human label.',
  'src/lib/gemini.ts :: /(\\bquantit|\\bqty\\b|how many|order\\s*size|order\\s*quantit|pieces?\\s*required|number of (pieces|units)|\\bdeliver|\\btimeline\\b|lead\\s*time|how soon|\\burgen|by when|when do you (need|require|want)|\\bpayment|advance payment|credit\\s*(term|period)|\\bgst\\b|pin\\s?code|postal|\\bcity\\b|\\bstate\\b|\\bregion\\b)/i :: how many|how soon|by when|advance payment|postal':
    'FORM_COVERED_RE — suppresses LLM questions the form already asks. Most alternatives are correctly \\b-anchored; these five are not ("…show many", "…postal"). Low blast radius (it only drops a question) but it is the same class. TODO: \\b-anchor the remaining five.',
  'src/lib/offerEnrich.ts :: /interested|mapping|^category$/i :: interested|mapping':
    'finds the category-mapping spec row by field name. "interested" also matches "Not Interested", "mapping" matches "Remapping". TODO: \\b-anchor both.',
};

const INCLUDES_BASELINE: Record<string, string> = {
  'src/components/BrainRFQForm.tsx :: m.label.toLowerCase().includes(q.toLowerCase())':
    'INTENDED — search-as-you-type filter on the product suggest dropdown; substring matching is the feature. Kept in the ledger so the judgement is recorded, not re-litigated. (Moved 2026-07-28 from BrainFormGate.tsx: the chooser page was collapsed into the form\'s landing, so the suggester moved with it — same expression, same judgement, new file.)',
  'src/lib/inspectorData.ts :: norm(x.name).includes(norm(key))':
    'spec lookup by containment — "Capacity" would find "Load Capacity" and vice versa. TODO: exact match on normalised names, then a token-overlap fallback.',
  'src/lib/inspectorData.ts :: norm(k).includes(norm(key))':
    'same containment lookup over the logistics map. TODO: as above.',
  'src/lib/observatoryView.ts :: a.includes(key)':
    'consumption check — "was this critical spec asked?" by substring, so a short spec name reads as consumed by any longer question. Directly inflates the consumption metric. TODO: token-set equality.',
  'src/lib/observatoryView.ts :: key.includes(a)':
    'the reverse direction of the same line. TODO: as above.',
  'src/lib/rfqEvals.ts :: norm(i.chosen).includes(norm(top.label))':
    'eval alignment scored by substring — a chosen option containing the top label scores as aligned. Inflates the eval, which is the one number that is supposed to be honest. TODO: exact/normalised comparison.',
  'src/lib/rfqEvals.ts :: norm(top.label).includes(norm(i.chosen))':
    'the reverse direction of the same line. TODO: as above.',
};

describe('repo sweep — every field-routing regex must be word-bounded', () => {
  const findings = scanFieldRoutingRegexes();
  const includes = scanNameIncludes();

  test('no NEW unbounded field-routing regex', () => {
    const fresh = findings.filter((f) => !(regexKey(f) in REGEX_BASELINE));
    assert.deepEqual(
      fresh.map((f) => `${f.file}:${f.line}  ${f.symbol ? `${f.symbol} = ` : ''}${f.pattern}  routed on \`${f.routedOn}\`  → unbounded: ${f.unbounded.join(', ')}`),
      [],
      'a field-routing regex can be matched inside a longer word (the Capa-CITY class). Anchor it, or add it to REGEX_BASELINE with a reason.',
    );
  });

  test('no NEW name-matching .includes()', () => {
    const fresh = includes.filter((f) => !(includesKey(f) in INCLUDES_BASELINE));
    assert.deepEqual(
      fresh.map((f) => `${f.file}:${f.line}  [${f.kind}] ${f.expr}`),
      [],
      'string containment used for name matching (the reseller / Sweet-Potatoes class). Use normalised equality or token overlap, or add it to INCLUDES_BASELINE with a reason.',
    );
  });

  test('the baseline is current — a fixed finding must be deleted from it', () => {
    const liveRegex = new Set(findings.map(regexKey));
    const liveIncl = new Set(includes.map(includesKey));
    const stale = [
      ...Object.keys(REGEX_BASELINE).filter((k) => !liveRegex.has(k)),
      ...Object.keys(INCLUDES_BASELINE).filter((k) => !liveIncl.has(k)),
    ];
    assert.deepEqual(stale, [], 'these baseline entries no longer match anything — delete them so the list keeps shrinking');
  });

  test('the sweep is actually seeing the code (guard against a scanner that finds nothing)', () => {
    assert.ok(findings.length + includes.length >= 8, 'the scanner returned suspiciously little — it has probably stopped parsing the repo');
  });
});
