/// <reference types="node" />
// ─── PERSONA360 LIVE ADAPTER · mapFinalToPersona360 — data-contract referee ─────────────
// Run: npm test   (glob: src/lib/__tests__/*.test.ts, node --test)
//
// Referee: @batman. Contract sources (read directly from the workflow + docs):
//   · n8n "08 — Intelligence Parser"    → the PRIMARY input shape — the sync
//                                         buyer-intelligence webhook responds with exactly
//                                         this output (persona/sourcing/risk/internet_profile)
//   · n8n "final-assemble" node jsCode  → the LEGACY/FALLBACK shape (async buyer-persona-async
//                                         fixtures — sources{}/buyer, no 08-parser sections)
//   · docs/persona360-data-audit.md     → gap rules (no invented scores, Sign3 raw/unknown,
//                                         seller-rating = seller-side, pending-over-fabricate)
//   · src/lib/persona360Types.ts        → Persona360Data (output contract)
//
// INPUT  = the synchronous buyer-intelligence webhook response — the 08 — Intelligence
//   Parser output:
//   { glid, fetched_at, persona{…}, sourcing{…}, risk{…}, internet_profile{…},
//     needs_input, __health, __source_priority, __sources_present, __sources_absent }
//   (cache hits return the SAME shape — cache-store sits AFTER the parser, so the cached
//   payload is the 08-parser output too).
//   LEGACY/FALLBACK input = the final-assemble payload:
//   { glid, fetched_at, sources: { identity, external, pan_union, mobiles,
//     gst_detail_union, udyam, pns, requirement, web_osint, csl, buyerprofile,
//     conflict_tickets, ... }, sources_present, sources_absent, pipeline_health,
//     __health, buyer, needs_input, __llm_health }   ← chief-ruling 2026-08: 'buyer'
//   (flat LLM attribute object, .value per attr) is legal top-level input; adapter maps
//   buyer.* FIRST with sources{} fallback.
//   USER RULING 2026-08-19: the live workflow is buyer-intelligence (SYNC — ONE final
//   response, no callbacks). Its response IS the 08-parser output, so the adapter MUST
//   read the four 08-parser sections when present; sources{}-derivation is the fallback
//   for async/legacy shapes only.
//
// REAL WIRE BYTES: src/fixtures/persona360-live-sample.json (glid 268590579, tier fast,
// captured 2026-08-18 by @doraemon) is the full-payload case. The synthetic builders
// below stay as reduced/edge cases (bare arrays, fraud-present float, seller rating).
// src/fixtures/persona360-live-partials.json is the per-node PARTIAL stream — data in
// it that final-assemble dropped must NOT leak into the render (case pinned below).
//
// OUTPUT = Persona360Data (see persona360Types.ts). Verified two ways below:
//   (1) runtime structural assertions in this file (node --test strips types, so a
//       pure type annotation would silently verify nothing at runtime);
//   (2) a compile-time annotation inside asPersona360() — stripped here, but
//       `npm run typecheck` (tsc -b) enforces it for real.
//
// RED first: src/lib/persona360Live.ts does not exist until @steve builds it, so this
// file MUST fail the suite until then. The import is direct (no loader shim): the
// adapter is required to be a PURE function module — no import.meta.env, no network,
// no gemini — so node --test can import it with types stripped. That purity is part
// of the contract being pinned.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapFinalToPersona360 } from '../persona360Live.ts';
import type { Persona360Data } from '../persona360Types.ts';

// ── compile-time output gate (enforced by tsc -b, stripped at runtime) ─────────────────
function asPersona360(out: unknown): Persona360Data {
  return out as Persona360Data; // tsc proves assignability at the mapFinalToPersona360 call sites below
}

// ── REAL wire captures (@doraemon, glid 268590579, tier fast, 2026-08-18) ─────────────
// Loaded from disk, not inlined: the bytes under test are the bytes that came off the wire.
const REAL_FINAL = JSON.parse(
  readFileSync(new URL('../../fixtures/persona360-live-sample.json', import.meta.url), 'utf8'),
);
const REAL_PARTIALS = JSON.parse(
  readFileSync(new URL('../../fixtures/persona360-live-partials.json', import.meta.url), 'utf8'),
);

// ── synthetic minimal final-assemble fixture ───────────────────────────────────────────
// Documented shape ONLY — no 08-parser sections anywhere. Kept as the REDUCED case set:
// the real capture (REAL_FINAL above) is the full-payload gate; these synthetic builders
// cover the edges the real wire did not produce (fraud float present, seller rating
// present, bare pan_union/mobiles arrays, empty sources, cache-hit minus timing keys).
const GLID = '268590579';

function fullFinalPayload() {
  return {
    glid: GLID,
    fetched_at: '2026-08-24T09:00:00.000Z',
    derived_anchors: { mobile: '6386941152', pan: 'KDPVS7147Q' },
    source_registry: {
      identity: { source_name: 'identity', trust_level: 'high' },
      external: { source_name: 'external', trust_level: 'high' },
    },
    source_priority: { persona: ['pns', 'identity', 'external', 'csl'] },
    sources: {
      identity: {
        summary: {
          name: 'Jayveer Singh',
          company: 'JS Enterprises',
          city: 'Kanpur',
          state: 'Uttar Pradesh',
          email: 'jayveeranayak75@gmail.com',
          mobile: '6386941152',
          member_since: '2026-05-20',
        },
        __health: { node: 'identity', ok: true, status: 'ok' },
      },
      external: {
        summary: {
          name: 'Jayveer Singh',
          age: 29,
          gender: 'Male',
          sign3_scores: { fraud_seller_detection_score: 0.37 },
        },
        __health: { node: 'external', ok: true, status: 'ok' },
      },
      pan_union: {
        summary: { rows: [{ pan: 'KDPVS7147Q', entity_type_hint: 'Individual' }], primary: 'KDPVS7147Q', count: 1 },
        rows: [{ pan: 'KDPVS7147Q', entity_type_hint: 'Individual' }],
        __health: { node: 'pan_union', ok: true, status: 'ok' },
      },
      mobiles: {
        summary: { rows: [{ mobile: '6386941152', is_primary: true }], primary: '6386941152', count: 1 },
        rows: [{ mobile: '6386941152', is_primary: true }],
        __health: { node: 'mobiles', ok: true, status: 'ok' },
      },
      gst_detail_union: { summary: {}, __health: { node: 'gst_detail_union', ok: true, status: 'no_data', count: 0 } },
      udyam: { summary: {}, __health: { node: 'udyam', ok: true, status: 'no_data', count: 0 } },
      pns: {
        summary: { call_count: 2, intent_level: 'high', persona: 'machinery buyer', products: ['notebook making machine'] },
        __health: { node: 'pns', ok: true, status: 'ok' },
      },
      requirement: {
        summary: { requirements: [{ title: '300 PCS/Hr notebook making machine', category: 'Machinery' }], search_cities: ['Delhi'] },
        __health: { node: 'requirement', ok: true, status: 'ok' },
      },
      web_osint: { summary: {}, __health: { node: 'web_osint', ok: true, status: 'no_data', count: 0 } },
      csl: { summary: { browse_cities: ['Kanpur'] }, __health: { node: 'csl', ok: true, status: 'ok' } },
      buyerprofile: {
        summary: {
          business_type: 'Proprietor',
          avg_rating: 3.8,
          rating_count: 6,
          is_also_seller: true,
          city: 'Kanpur',
          member_since: '2026-05-20',
        },
        __health: { node: 'buyerprofile', ok: true, status: 'ok' },
      },
      conflict_tickets: {
        summary: { as_respondent: { count: 0, window: '365d', type: 'BS_Conflict (181)' } },
        __health: { node: 'conflict_tickets', ok: true, status: 'ok' },
      },
    },
    sources_present: ['identity', 'external', 'pan_union', 'mobiles', 'pns', 'requirement', 'csl', 'buyerprofile', 'conflict_tickets'],
    sources_absent: ['gst_detail_union', 'udyam', 'web_osint'],
    requirement_brain: null,
    pipeline_timing: [],
    total_pull_s: 4.2,
    pipeline_health: { ok_count: 12, no_data_count: 3, error_count: 0, errors: [] },
    __health: [
      { node: 'identity', ok: true, status: 'ok' },
      { node: 'external', ok: true, status: 'ok' },
    ],
  };
}

// Cache-hit variant: no job_id / no async envelope — the payload IS the final-assemble
// body and must pass through the same mapping. (Async wraps in {job_id, status, result};
// a cache hit returns the assembled body directly. Adapter must not require the envelope.)
function cacheHitPayload() {
  const p = fullFinalPayload();
  delete (p as Record<string, unknown>).total_pull_s;
  delete (p as Record<string, unknown>).pipeline_timing;
  return p;
}

// Missing-sources variant: sources key entirely absent / empty → pending & empty states,
// never fabricated values, never a throw.
function missingSourcesPayload() {
  return {
    glid: GLID,
    fetched_at: '2026-08-24T09:05:00.000Z',
    sources: {},
    sources_present: [],
    sources_absent: ['identity', 'external', 'pns'],
    __health: [{ node: 'identity', ok: false, status: 'error', error_msg: 'timeout' }],
  };
}

// ── runtime structural gate for Persona360Data ────────────────────────────────────────
// node --test strips types — a plain annotation would "verify" nothing at runtime.
// This walks the required contract shape and fails loudly on the first violation.
function assertPersona360Shape(d: Persona360Data, ctx: string) {
  const prefix = `[${ctx}]`;
  assert.equal(typeof d.glid, 'string', `${prefix} glid must be a string`);
  assert.ok(d.identity && typeof d.identity === 'object', `${prefix} identity object required`);
  assert.equal(typeof d.identity.name, 'string', `${prefix} identity.name string required`);
  assert.ok(Array.isArray(d.identity.badges), `${prefix} identity.badges array required`);
  assert.equal(typeof d.identity.description, 'string', `${prefix} identity.description string required`);
  assert.ok(d.trust && typeof d.trust === 'object', `${prefix} trust object required`);
  assert.ok(Array.isArray(d.trust.signals), `${prefix} trust.signals array required`);
  for (const s of d.trust.signals) {
    assert.ok(['good', 'caution', 'bad'].includes(s.state), `${prefix} trust signal state must be good|caution|bad, got ${s.state}`);
  }
  assert.ok(d.persona && typeof d.persona === 'object', `${prefix} persona object required`);
  assert.equal(typeof d.persona.primary, 'string', `${prefix} persona.primary string required`);
  assert.ok(['startup', 'sme', 'mid', 'enterprise'].includes(d.persona.stage), `${prefix} persona.stage enum, got ${d.persona.stage}`);
  assert.ok(d.sourcing && typeof d.sourcing === 'object', `${prefix} sourcing object required`);
  assert.ok(Array.isArray(d.sourcing.cities), `${prefix} sourcing.cities array required`);
  assert.ok(Array.isArray(d.sourcing.products), `${prefix} sourcing.products array required`);
  assert.ok(d.risk && typeof d.risk === 'object', `${prefix} risk object required`);
  assert.ok(Array.isArray(d.risk.financial), `${prefix} risk.financial array required`);
  assert.ok(d.internet && typeof d.internet === 'object', `${prefix} internet object required`);
  assert.ok(Array.isArray(d.internet.rows), `${prefix} internet.rows array required`);
  assert.ok(Array.isArray(d.internet.verifiedTags), `${prefix} internet.verifiedTags array required`);
  assert.ok(d.internet.completeness && typeof d.internet.completeness === 'object', `${prefix} internet.completeness object required`);
  assert.ok(Array.isArray(d.internet.completeness.missing), `${prefix} internet.completeness.missing array required`);
  assert.ok(d.engagement && typeof d.engagement === 'object', `${prefix} engagement object required`);
  assert.ok(Array.isArray(d.engagement.metrics), `${prefix} engagement.metrics array required`);
  assert.ok(Array.isArray(d.engagement.monthly), `${prefix} engagement.monthly array required`);
}

describe('mapFinalToPersona360 — data contract', () => {
  test('full final-assemble payload maps to a valid Persona360Data', () => {
    const out = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    assertPersona360Shape(out, 'full');
    assert.equal(out.glid, GLID, 'glid must pass through untouched');
  });

  test('contract: adapter DOES read 08-parser sections — they are the sync webhook response', () => {
    // USER RULING 2026-08-19: the live workflow is buyer-intelligence, a SYNCHRONOUS
    // webhook whose ONE response IS the 08 — Intelligence Parser output. Feed sentinel
    // 08 sections; every field the parser emits must flow into the render.
    const payload: Record<string, unknown> = fullFinalPayload();
    payload.persona = {
      industry: 'SENTINEL-08-INDUSTRY',
      business_persona: 'SENTINEL-08-PERSONA',
      business_stage: 'SENTINEL-08-STAGE',
      annual_turnover: 'SENTINEL-08-TURNOVER',
      business_type: 'SENTINEL-08-TYPE',
    };
    payload.sourcing = {
      price_vs_quality: 'SENTINEL-08-PQ',
      annual_procurements: 'SENTINEL-08-PROC',
      purchase_frequency: 'SENTINEL-08-FREQ',
      procurement_cities: { value: ['Delhi'] },
    };
    payload.risk = {
      fraud_seller_detection_score: { value: 0.42, sources: ['SIGN3'] },
      indiamart_seller_rating: { value: { avg: 4.1, count: 9 }, note: 'seller-side' },
    };
    payload.internet_profile = {
      gst: { value: { legal_name: 'SENTINEL-08-GST' } },
      company_previous: { value: { company: 'SENTINEL-08-CO' } },
    };
    const out = asPersona360(mapFinalToPersona360(payload));
    const json = JSON.stringify(out);
    assert.ok(json.includes('SENTINEL-08-INDUSTRY'), '08 persona.industry must render');
    assert.ok(json.includes('SENTINEL-08-PERSONA'), '08 persona.business_persona must render');
    assert.ok(json.includes('SENTINEL-08-PROC'), '08 sourcing.annual_procurements must render');
    assert.ok(json.includes('SENTINEL-08-GST'), '08 internet_profile.gst must render');
    assert.ok(json.includes('SENTINEL-08-CO'), '08 company_previous must render');
    assert.equal(out.risk.rawSign3, 0.42, '08 fraud_seller_detection_score must pass raw');
    assert.equal(out.risk.rating!.value, 4.1, '08 seller rating avg must pass');
    assert.ok(json.includes('Delhi'), '08 procurement_cities must render');
    // Trust score is DERIVED from Sign3 fsd (0=safe → 1=fraud): trust = round((1 - fsd) * 100).
    // fsd 0.42 → 58. Risk score stays 0 (no formula yet).
    assert.equal(out.trust.score, 58, 'trust derived from Sign3 fsd: round((1 - 0.42) * 100)');
    assert.equal(out.risk.score, 0, 'no risk score may be invented from 08 sections');
  });

  test('cache-hit payload (no job_id, sources present) maps identically — passthrough', () => {
    const out = asPersona360(mapFinalToPersona360(cacheHitPayload()));
    assertPersona360Shape(out, 'cache-hit');
    assert.equal(out.glid, GLID);
    // Same mapping as the full payload for the fields both carry.
    const full = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    assert.deepEqual(out.identity, full.identity, 'identity mapping must be identical for cache-hit vs full');
    assert.deepEqual(out.persona, full.persona, 'persona mapping must be identical for cache-hit vs full');
  });

  test('MISSING sources → pending/empty states, never fabricated values, never throws', () => {
    const out = asPersona360(mapFinalToPersona360(missingSourcesPayload()));
    assertPersona360Shape(out, 'missing-sources');
    assert.equal(out.glid, GLID, 'glid must still pass through');
    // Live mapping must never claim fixture mode; 'live' or unset are both acceptable
    // (mode is ultimately the page shell's prop — the adapter just must not lie).
    assert.notEqual(out.trust.mode, 'fixture', 'adapter output over a real final payload must not claim fixture mode');
    // Completeness in live mode uses real counts, not a fabricated pct (design §7).
    assert.ok(out.internet.counts, 'live mode must emit real present/absent/error counts');
    assert.equal(out.internet.counts!.present, 0, 'present count must be 0 when sources{} is empty');
    assert.ok(out.internet.counts!.errors >= 1, 'the errored identity node must surface as an error count');
    // Anti-fabrication: with no data, the mockup's 46/58 values must not leak back in.
    assert.notEqual(out.trust.score, 46, 'empty payload must not reuse the mockup trust score');
    assert.notEqual(out.risk.score, 58, 'empty payload must not reuse the mockup risk score');
    assert.equal(out.risk.rawSign3, 'unknown', 'no external source ⇒ rawSign3 must be "unknown"');
  });

  test('fraud score ABSENT → rawSign3 is exactly "unknown" (NOT 0, NOT invented)', () => {
    const payload = fullFinalPayload();
    delete (payload.sources.external.summary as Record<string, unknown>).sign3_scores;
    const out = asPersona360(mapFinalToPersona360(payload));
    assert.equal(out.risk.rawSign3, 'unknown', 'absent fraud score must be the literal string "unknown"');
    assert.notEqual(out.risk.rawSign3, 0, 'absent must never render as 0 (audit: missing ≠ low risk)');
    assert.equal(typeof out.risk.rawSign3, 'string');
  });

  test('fraud score PRESENT → raw float passthrough, no band labels', () => {
    const out = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    assert.equal(out.risk.rawSign3, 0.37, 'Sign3 0–1 float must pass through raw and unmodified');
    assert.equal(typeof out.risk.rawSign3, 'number');
    // No banding: the fraud read must not be derived from the raw float (audit §1:
    // no verdict labels until Sign3 provides banding).
    const json = JSON.stringify(out.risk);
    assert.ok(!/0\.37.*(low|medium|high|safe|risky)/i.test(json), 'raw float must not acquire an invented band label');
  });

  test('pan_union / mobiles as BARE per-row arrays are tolerated', () => {
    const payload = fullFinalPayload() as Record<string, unknown>;
    const sources = payload.sources as Record<string, unknown>;
    // Strip the {summary,rows,__health} wrapper — feed the raw row arrays directly.
    sources.pan_union = [{ pan: 'KDPVS7147Q', entity_type_hint: 'Individual' }];
    sources.mobiles = [{ mobile: '6386941152', is_primary: true }];
    const out = asPersona360(mapFinalToPersona360(payload));
    assertPersona360Shape(out, 'bare-arrays');
    assert.equal(out.glid, GLID);
    // PAN must still be surfaced (masked or raw) from the bare rows.
    const panJson = JSON.stringify(out.persona.entity) + JSON.stringify(out.identity);
    assert.ok(panJson.includes('KDPVS7147Q'), 'PAN from bare pan_union rows must still surface');
  });

  test('pan_union / mobiles NULL or missing entirely are tolerated', () => {
    const payload = fullFinalPayload() as Record<string, unknown>;
    const sources = payload.sources as Record<string, unknown>;
    delete sources.pan_union;
    delete sources.mobiles;
    const out = asPersona360(mapFinalToPersona360(payload));
    assertPersona360Shape(out, 'null-unions');
  });

  test('indiamart_seller_rating carried with SELLER-side semantics, not buyer trust', () => {
    const out = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    assert.ok(out.risk.rating, 'seller rating present in fixture must surface as risk.rating');
    assert.equal(out.risk.rating!.value, 3.8, 'avg passes through');
    assert.equal(out.risk.rating!.count, 6, 'count passes through');
    // Semantics guard: the seller rating must NOT be relabeled as the buyer trust score.
    assert.notEqual(out.trust.score, 3.8, 'seller rating must never become the trust score');
  });

  test('deterministic: same input → same output (no randomness, no clock skew in mapping)', () => {
    const a = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    const b = asPersona360(mapFinalToPersona360(fullFinalPayload()));
    assert.deepEqual(a, b, 'adapter must be a pure deterministic function of its input');
  });

  // ── REAL WIRE cases (Doraemon's captures) ───────────────────────────────────────────

  test('REAL final-assemble capture maps to a valid Persona360Data (the full-payload gate)', () => {
    const out = asPersona360(mapFinalToPersona360(REAL_FINAL));
    assertPersona360Shape(out, 'real-capture');
    assert.equal(out.glid, '268590579', 'real glid passes through');
    // Real capture facts (verified against the wire bytes 2026-08-19):
    //  · identity.summary.name = 'Jaiveer' — the adapter must use the real name.
    assert.equal(out.identity.name, 'Jaiveer', 'identity name must come from the real wire bytes');
    //  · sign3 fraud score ABSENT on the real wire → 'unknown', never 0.
    assert.equal(out.risk.rawSign3, 'unknown', 'real capture has no Sign3 score ⇒ unknown');
    //  · is_also_seller=false, no avg_rating on the real wire → no rating object fabricated.
    assert.equal(out.risk.rating, undefined, 'no seller rating on the wire ⇒ none invented');
    //  · no 08-parser sections on the wire — output must still be complete (shape gate above).
  });

  test('buyer-PRESENT: flat LLM attributes map (value unwrapped), no invented numerics', () => {
    const out = asPersona360(mapFinalToPersona360(REAL_FINAL));
    // buyer.business_persona.value / business_type.value / business_stage.value are
    // {value, confidence, ...} objects — adapter must unwrap .value, not stringify the object.
    const json = JSON.stringify(out);
    assert.ok(!json.includes('[object Object]'), 'buyer attribute objects must be unwrapped to .value');
    assert.ok(
      out.persona.primary.length > 0 || out.persona.industry.length > 0,
      'buyer-present payload must populate persona text from buyer.* or sources{}',
    );
    // No invented numerics: buyer attrs carry no trust/risk score → trust.score / risk.score
    // must not be derived from confidence values (e.g. 70/75 in buyer.* are CONFIDENCE, not scores).
    assert.notEqual(out.trust.score, 70, 'buyer confidence must not become trust score');
    assert.notEqual(out.trust.score, 75, 'buyer confidence must not become trust score');
    assert.notEqual(out.risk.score, 70, 'buyer confidence must not become risk score');
    assert.notEqual(out.risk.score, 75, 'buyer confidence must not become risk score');
  });

  test('buyer-ABSENT/empty: pending paths, no throw, no fabricated persona', () => {
    const payload = JSON.parse(JSON.stringify(REAL_FINAL)) as Record<string, unknown>;
    delete payload.buyer;
    const out = asPersona360(mapFinalToPersona360(payload));
    assertPersona360Shape(out, 'buyer-absent');
    assert.equal(out.glid, '268590579');

    const payload2 = JSON.parse(JSON.stringify(REAL_FINAL)) as Record<string, unknown>;
    payload2.buyer = {};
    const out2 = asPersona360(mapFinalToPersona360(payload2));
    assertPersona360Shape(out2, 'buyer-empty');
  });

  test('partials-present-but-final-ABSENT: partial stream data must NOT leak into the render', () => {
    // Empirical finding (@doraemon): a source can emit a partial during the run and still
    // land in sources_absent in the final body. The adapter renders the FINAL body only.
    // Real example in the captures: partials.identity.summary carries member_since /
    // tenure_years / verified_business_buyer_flag, which final-assemble's identity.summary
    // dropped. The mapped output must not contain partial-only values.
    const out = asPersona360(mapFinalToPersona360(REAL_FINAL));
    const json = JSON.stringify(out);
    const partialOnly = (REAL_PARTIALS.identity && REAL_PARTIALS.identity.summary) || {};
    for (const key of ['tenure_years', 'verified_business_buyer_flag', 'glusr_usr_custtype_name']) {
      const pv = partialOnly[key];
      // Skip empty/short values — json.includes('') is trivially true and proves nothing.
      if (pv !== undefined && String(pv).length >= 2 && !(REAL_FINAL.sources.identity.summary as Record<string, unknown>)[key]) {
        assert.ok(
          !json.includes(String(pv)),
          `partial-only identity.${key} (${String(pv)}) must not leak into the final render`,
        );
      }
    }
    // Strong form of the rule, keyed off the final body's OWN honesty list:
    // for every source the final declares sources_absent, no meaningful string from that
    // node's PARTIAL emission may appear in the render. (Verified capture anatomy: the
    // final sources{} carries these keys with no_data summaries while sources_absent marks
    // them absent; the partials show e.g. gst-consensus DID run and produce a basis string.)
    const NODE_TO_FINAL_KEY: Record<string, string> = {
      'websearch-parse': 'web_osint',
      'gst-consensus': 'gst_detail_union',
      'udyam-parse': 'udyam',
      'pan-compile': 'pan_union',
      'mobile-compile': 'mobiles',
      'pns-parser': 'pns',
      'csl-merge': 'csl',
      'external': 'external',
      'identity': 'identity',
      'requirement': 'requirement',
    };
    const absent = new Set(REAL_FINAL.sources_absent as string[]);
    const walkStrings = (o: unknown, acc: string[], depth: number) => {
      if (depth > 4 || acc.length > 40) return;
      if (typeof o === 'string' && o.length >= 8) { acc.push(o); return; }
      if (Array.isArray(o)) { o.slice(0, 8).forEach((x) => walkStrings(x, acc, depth + 1)); return; }
      if (o && typeof o === 'object') { Object.values(o).slice(0, 20).forEach((x) => walkStrings(x, acc, depth + 1)); }
    };
    let checked = 0;
    for (const [nodeName, finalKey] of Object.entries(NODE_TO_FINAL_KEY)) {
      if (!absent.has(finalKey)) continue; // final says present — nothing to prove here
      const strings: string[] = [];
      walkStrings((REAL_PARTIALS[nodeName] || {}).summary, strings, 0);
      for (const v of strings) {
        // Skip meta strings (node names, timestamps, vendor labels) — a legit render may
        // name a source or show a fetched_at; the ban is on partial DATA leaking.
        if (/^\d{4}-\d{2}-\d{2}T/.test(v)) continue;
        if (v === finalKey || v === nodeName) continue;
        if (/^(consensus|sign3|idfy|befisc)/i.test(v)) continue;
        assert.ok(
          !json.includes(v),
          `partial ${nodeName} string "${v.slice(0, 60)}" must not leak — final declared ${finalKey} absent`,
        );
        checked++;
      }
    }
    assert.ok(checked > 0, 'guard against a vacuous pass — at least one partial string must actually be checked');
  });
});

// ── SYNC webhook shape (USER RULING 2026-08-19: buyer-intelligence responds with ONE
//    final JSON — the 08 — Intelligence Parser output; no sources{}, no buyer) ─────────
function sync08Payload() {
  return {
    glid: GLID,
    fetched_at: '2026-08-19T10:00:00.000Z',
    persona: {
      industry: 'Textile Machinery',
      business_stage: 'SME',
      scale: 'small scale',
      annual_turnover: '₹1–5 Cr',
      business_persona: 'Established machinery buyer',
      business_type: 'Proprietor',
      buyer_maturity: 'Repeat buyer',
    },
    sourcing: {
      price_vs_quality: 'Price sensitive',
      annual_procurements: '₹25L per year',
      sourcing_channel: 'Online marketplaces',
      preferred_suppliers: ['Supplier A'],
      procurement_model: 'Annual contracts',
      purchase_frequency: 'Quarterly',
      location_sourcing_preference: 'Local',
      procurement_cities: { value: ['Delhi', 'Kanpur'], sources: ['REQUIREMENT'] },
    },
    risk: {
      is_fraud: { value: false, sources: ['BUYER PROFILE'] },
      verification_status: { value: 'verified', sources: ['BUYER PROFILE'] },
      indiamart_seller_rating: {
        value: { avg: 3.8, count: 6 },
        note: "This is the GLID's SELLER-side IndiaMART rating (arrives with is_also_seller). It is NOT the buyer's trust grade.",
        sources: ['BUYER PROFILE'],
      },
      is_also_seller: { value: true, sources: ['BUYER PROFILE'] },
      gst_verified: { value: true, sources: ['GST'] },
      udyam_registered: { value: false, sources: ['UDYAM'] },
      pan_present: { value: true, sources: ['PAN'] },
      fraud_seller_detection_score: { value: 0.37, sources: ['SIGN3'], note: 'Sign3 fraud-seller-detection score (0-1 raw).' },
      conflict_tickets: {
        as_respondent: { count: 0, window: '365d', type: 'BS_Conflict (181)' },
        note: 'Genuine dispute-history count. NOT a risk score or grade.',
        sources: ['REDASH iil_customer_tickets QID 12023'],
      },
    },
    internet_profile: {
      gst: { value: { legal_name: 'JS Enterprises', trade_name: 'JS Enterprises', gstin: '09AABC…' }, sources: ['GST'] },
      pns_profiling: { value: { call_count: 2, intent_level: 'high' }, sources: ['PNS'] },
      company_previous: {
        value: { member_since: '2026-05-20', company: 'JS Enterprises', historical_activity: { total_requirement: 12, total_calls: 34 } },
        sources: ['BUYER PROFILE', 'COMPANY / KYB'],
      },
    },
    needs_input: [],
    __source_priority: {},
    __sources_present: ['identity', 'external', 'pan_union', 'mobiles', 'pns', 'requirement', 'csl', 'buyerprofile', 'gst_detail_union', 'conflict_tickets'],
    __sources_absent: ['udyam', 'web_osint'],
  };
}

describe('mapFinalToPersona360 — sync buyer-intelligence (08-parser) shape', () => {
  test('08-parser payload maps to a valid Persona360Data — the live webhook gate', () => {
    const out = asPersona360(mapFinalToPersona360(sync08Payload()));
    assertPersona360Shape(out, 'sync-08');
    assert.equal(out.glid, GLID);
    assert.equal(out.persona.primary, 'Established machinery buyer', 'business_persona is the persona primary');
    assert.equal(out.persona.industry, 'Textile Machinery');
    assert.equal(out.persona.stage, 'sme');
    assert.equal(out.persona.stageEstimate, 'SME', 'raw business_stage kept as the estimate');
    assert.equal(out.persona.turnover.display, '₹1–5 Cr');
    assert.equal(out.sourcing.annualProcurement.display, '₹25L per year');
    assert.equal(out.sourcing.priceQuality.label, 'Price sensitive');
    assert.equal(out.sourcing.orderPattern.display, 'Quarterly');
    assert.ok(out.sourcing.cities.some((c) => c.name === 'Delhi'), 'procurement_cities flow into sourcing.cities');
    assert.equal(out.risk.rawSign3, 0.37, 'Sign3 0–1 float raw passthrough');
    assert.equal(out.risk.rating!.value, 3.8);
    assert.equal(out.risk.rating!.count, 6);
    assert.ok(out.risk.smNote && out.risk.smNote.includes('SELLER-side'), 'seller-side semantics note present');
    // Trust derived from Sign3 fsd: 0.37 → round((1 - 0.37) * 100) = 63
    assert.equal(out.trust.score, 63, 'trust derived from Sign3 fsd 0.37');
    assert.equal(out.risk.score, 0, 'no risk score invented');
    assert.deepEqual(out.risk.fraudRead, { verdict: 'CLEAR', detail: 'No fraud flag on buyer profile' });
    assert.ok(out.internet.verifiedTags.find((t) => t.name === 'GST')!.verified, 'gst_verified flag surfaces');
    assert.ok(!out.internet.verifiedTags.find((t) => t.name === 'Udyam')!.verified, 'udyam not registered surfaces');
    assert.ok(out.internet.verifiedTags.find((t) => t.name === 'PAN')!.verified, 'pan_present flag surfaces');
    assert.equal(out.internet.counts!.present, 10, 'real __sources_present count');
    assert.equal(out.internet.counts!.absent, 2, 'real __sources_absent count');
    // identity name absent on the 08 shape (no sources{}) — honest placeholder, no fabrication
    assert.equal(out.identity.name, '—');
  });

  test('08-parser shape: ABSENT fraud score → rawSign3 exactly "unknown" (NOT 0)', () => {
    const payload = sync08Payload() as Record<string, unknown>;
    delete (payload.risk as Record<string, unknown>).fraud_seller_detection_score;
    const out = asPersona360(mapFinalToPersona360(payload));
    assert.equal(out.risk.rawSign3, 'unknown', 'absent Sign3 score must be the literal string "unknown"');
    assert.notEqual(out.risk.rawSign3, 0);
  });

  test('08-parser shape: FLAGGED fraud + reason surfaces in fraudRead', () => {
    const payload = sync08Payload() as Record<string, unknown>;
    (payload.risk as Record<string, unknown>).is_fraud = { value: true, sources: ['BUYER PROFILE'] };
    (payload.risk as Record<string, unknown>).fraud_reason = { value: 'Payment dispute history', sources: ['BUYER PROFILE'] };
    const out = asPersona360(mapFinalToPersona360(payload));
    assert.deepEqual(out.risk.fraudRead, { verdict: 'FLAGGED', detail: 'Payment dispute history' });
  });
});
