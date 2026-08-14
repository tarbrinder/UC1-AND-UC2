import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcatPlausible } from '../mcatSanity.ts';

// mcatPlausible is a cheap PRE-FILTER: plausible=true → obviously fine, skip the LLM; plausible=false → zero word
// overlap, so ASK the LLM (title_mcat_mismatch) to confirm whether it's a real mismatch (fly-ash) or a legit
// zero-overlap sub-type (bolt/fastener). It is deliberately NOT the final verdict.

test('mcatSanity — obvious matches short-circuit (plausible=true, no LLM needed)', () => {
  assert.equal(mcatPlausible('Chocolate', 'Compound Chocolate').plausible, true);
  assert.equal(mcatPlausible('Fly Ash Bricks', 'Fly Ash').plausible, true);
  assert.equal(mcatPlausible('TMT Bar', 'TMT Bars').plausible, true);            // plural fold
  assert.equal(mcatPlausible('500W Motor Pump', 'Water Pumps').plausible, true); // shares "pump"
});

test('mcatSanity — zero-overlap cases route to the LLM (plausible=false)', () => {
  assert.equal(mcatPlausible('fly ash', 'Concrete Admixture').plausible, false);   // real mismatch (LLM confirms)
  assert.equal(mcatPlausible('Industrial Steel Bolt', 'Fasteners').plausible, false); // legit sub-type (LLM clears it)
});

test('mcatSanity — never flags on thin input (no false LLM calls on bare model nos.)', () => {
  assert.equal(mcatPlausible('', 'Diesel Generator').plausible, true);
  assert.equal(mcatPlausible('X1', 'Diesel Generator').plausible, true);   // 2-char token dropped → no tokens → plausible
});

test('mcatSanity — exact token only, never substring (the containment-bug class)', () => {
  // "ash" must NOT be considered a match for "washing" via substring
  assert.equal(mcatPlausible('fly ash', 'Washing Machine').plausible, false);
});
