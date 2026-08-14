import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAbsurdQty, parsePriceInr } from '../absurdQty.ts';

test('absurdQty — threshold: never flags qty <= 1000', () => {
  assert.equal(detectAbsurdQty(500).absurd, false);
  assert.equal(detectAbsurdQty(1000).absurd, false);
  assert.equal(detectAbsurdQty('999').absurd, false);
});

test('absurdQty — Rule 1: non-round large qty flags, round does not', () => {
  assert.equal(detectAbsurdQty(43869).absurd, true);   // ones digit 9
  assert.equal(detectAbsurdQty(10980).absurd, false);  // ends in 0
  assert.equal(detectAbsurdQty(5000).absurd, false);
  assert.equal(detectAbsurdQty(5001).absurd, true);
});

test('absurdQty — Rule 2: qty equal to a viewed-product price', () => {
  const r = detectAbsurdQty(800000, { productPrices: ['₹ 8 Lakh / Piece', '₹ 200 / Kg'] });
  assert.equal(r.absurd, true);
  assert.match(r.reason, /price/);
  // a round qty that is NOT a listed price is not flagged by Rule 2 (and 8000 ends in 0 so Rule 1 is silent too)
  assert.equal(detectAbsurdQty(8000, { productPrices: ['₹ 8 Lakh / Piece'] }).absurd, false);
});

test('absurdQty — Rule 3: within MCAT IQR, no GST, no company', () => {
  assert.equal(detectAbsurdQty(15000, { mcatQ1: 10000, mcatQ3: 20000, gstFlag: 0, companyFlag: 0 }).absurd, true);
  // has GST → Rule 3 suppressed (and 15000 ends in 0 → Rule 1 silent) → not absurd
  assert.equal(detectAbsurdQty(15000, { mcatQ1: 10000, mcatQ3: 20000, gstFlag: 1, companyFlag: 0 }).absurd, false);
  // outside the band → not flagged
  assert.equal(detectAbsurdQty(50000, { mcatQ1: 10000, mcatQ3: 20000, gstFlag: 0, companyFlag: 0 }).absurd, false);
});

test('parsePriceInr — Indian formats', () => {
  assert.equal(parsePriceInr('₹ 8 Lakh / Piece'), 800000);
  assert.equal(parsePriceInr('₹ 1.45 Crore / Piece'), 14500000);
  assert.equal(parsePriceInr('₹ 2.50 / Piece'), 2.5);
  assert.equal(parsePriceInr(''), null);
});
