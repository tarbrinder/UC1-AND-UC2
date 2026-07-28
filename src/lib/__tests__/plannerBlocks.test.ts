/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANNER_BLOCKS } from '../consumptionLadder.ts';

// The consumption ladder tells the owner "the planner has no block for this facet, provable without a live
// call." That claim is only true while its block list matches the prompt. It did not: 13 declared, 19 sent.
// An instrument that reports drift must not be the thing that drifts, so this asserts the mirror.
describe('consumption ladder — PLANNER_BLOCKS mirrors the real prompt', () => {
  const src = readFileSync(new URL('../gemini.ts', import.meta.url), 'utf8');
  const i = src.indexOf('export async function runCuratedPlanner');
  const j = src.indexOf('\nexport ', i + 10);
  const body = src.slice(i, j > 0 ? j : undefined);
  const actual = [...body.matchAll(/\[\s*'([a-z_0-9]+)'\s*,/g)].map((m) => m[1]);

  test('the prompt was found (guard against a scanner that matches nothing)', () => {
    assert.ok(i > 0, 'runCuratedPlanner not found in gemini.ts');
    assert.ok(actual.length >= 10, `only ${actual.length} fenced blocks parsed — the extractor is broken, not the list`);
  });

  test('every block the prompt sends is declared', () => {
    const missing = actual.filter((t) => !(PLANNER_BLOCKS as readonly string[]).includes(t));
    assert.deepEqual(missing, [], `PLANNER_BLOCKS is missing blocks the prompt sends: ${missing.join(', ')}. The ladder will wrongly report these facets as "never shown to the planner".`);
  });

  test('every declared block is really sent', () => {
    const stale = (PLANNER_BLOCKS as readonly string[]).filter((t) => !actual.includes(t));
    assert.deepEqual(stale, [], `PLANNER_BLOCKS declares blocks the prompt no longer sends: ${stale.join(', ')}. Delete them.`);
  });
});
