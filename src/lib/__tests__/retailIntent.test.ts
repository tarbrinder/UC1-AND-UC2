import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetailCandidate } from '../quantity.ts';

// isRetailCandidate is the cheap deterministic PRE-FILTER for the retail-intent gate (task #75). candidate=true → a
// small discrete order worth the LLM's category-relative check (checkRetailIntent — is "2 t-shirts" retail vs "2 CNC
// machines" not); candidate=false → definitely business-scale, so the gate skips the LLM entirely. It is deliberately
// NOT the final verdict — it only decides whether to spend the call.

test('retailIntent pre-filter — small discrete orders ARE candidates (spend the LLM)', () => {
  assert.equal(isRetailCandidate(1, 'Piece'), true);
  assert.equal(isRetailCandidate(2, 'Nos'), true);
  assert.equal(isRetailCandidate(10, 'Set'), true);
  assert.equal(isRetailCandidate('5', 'Pair'), true);
  assert.equal(isRetailCandidate(25, ''), true);          // unit-less small count still a candidate
});

test('retailIntent pre-filter — sizeable/wholesale counts are NOT candidates (skip the LLM)', () => {
  assert.equal(isRetailCandidate(200, 'Piece'), false);   // bulk band
  assert.equal(isRetailCandidate(5000, 'Nos'), false);    // wholesale band
  assert.equal(isRetailCandidate(26, 'Piece'), false);    // just over the small band (>25)
});

test('retailIntent pre-filter — a BULK UNIT at any count is never a candidate', () => {
  assert.equal(isRetailCandidate(1, 'Tonne'), false);     // a single tonne is business-scale
  assert.equal(isRetailCandidate(2, 'Truck'), false);
  assert.equal(isRetailCandidate(1, 'Container'), false);
  assert.equal(isRetailCandidate(5, 'Kg'), false);        // kg is a bulk unit in classifyOrderScale
});

test('retailIntent pre-filter — no/!meaningful quantity is not a candidate (nothing to judge)', () => {
  assert.equal(isRetailCandidate('', 'Piece'), false);
  assert.equal(isRetailCandidate(0, 'Piece'), false);
  assert.equal(isRetailCandidate(undefined, undefined), false);
});
