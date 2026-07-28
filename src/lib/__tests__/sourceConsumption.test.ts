/// <reference types="node" />
// ─── GUARDRAIL 2 — parsed-then-dropped ───────────────────────────────────────
// Run: npm test
//
// Loads the captured engine payloads, runs every declared source facet through
// validateSourceContract(), and fails when a facet has ZERO live consumers.
//
// The 78 facets that are dead TODAY are listed below with a reason and a decision (WIRE / DELETE /
// KEEP). That list is the whole point: it can only shrink. Fix or delete a facet and its line must
// come out, or "the allow-list is current" fails. Add a new parser field with no reader and
// "no undeclared dead facets" fails on the very first run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSourceContract, facetKey, SOURCE_CONTRACTS, SOURCE_IDS, CONSUMERS,
  type ContractReport,
} from '../sourceContract.ts';
import { REPO_ROOT } from './repoScan.ts';

const fixtures = JSON.parse(
  readFileSync(join(REPO_ROOT, 'src/lib/brains/requirementBrainFixtures.json'), 'utf8'),
) as Record<string, unknown>;

const reports: [string, ContractReport][] = Object.entries(fixtures).map(([glid, p]) => [glid, validateSourceContract(p)]);
const base = reports[0][1];   // the dead/alive verdict is declaration-driven, so any payload gives it

// ─────────────────────────────────────────────────────────────────────────────
// The ledger. `WIRE` = there is a consumer that should exist. `DELETE` = stop parsing it.
// `KEEP` = legitimately unread (PII that must not travel, or pure health telemetry) — still listed,
// because "deliberately unread" is a decision someone has to own, not a silence.
// ─────────────────────────────────────────────────────────────────────────────
const DEAD_FACET_ALLOWLIST: Record<string, string> = {
  // ── CSL ────────────────────────────────────────────────────────────────────
  'csl:search_freq': 'WIRE — the "x15" repeat count, destroyed by a label regex and re-captured in v8 so it could be used. Nothing ranks by it. Repeating a search 15 times is the strongest un-used intent signal in the bundle.',
  'csl:viewed_last': 'DELETE — duplicate of viewed[].last_seen, which is what buyer-brain actually ages from.',
  'csl:isq_filters': 'WIRE — spec values the buyer TICKED with his own hands. Observed-tier truth that should become CONFIRM chips; today only filters.city is read.',
  'csl:buyer_is_also_seller': 'WIRE (after fixing its parser) — computed in n8n csl-to-llm1 by title.includes("seller"), which also fires on reseller/bestseller/the buyer\'s own seller panel. Fix the matcher first, then feed it into kybUnlock.',
  'csl:seller_intent.suppliers_viewed': 'WIRE — which suppliers he already looked at should shape who we route the RFQ to.',
  'csl:seller_intent.profile_visits': 'WIRE — inflated by the same includes("seller") bug; fix the matcher, then feed score().',
  'csl:seller_intent.contacted': 'WIRE — CSL-side proof he already called/whatsapped a seller. score() uses profile.activity.total_calls instead and ignores this.',
  'csl:browse_channel': 'KEEP or DELETE — web/msite/app changes nothing in the decision layer today. Decide and remove it from the payload if the answer is no.',
  'csl:filters.mcategory': 'DELETE — never emitted, never read.',
  'csl:filters.category': 'DELETE — never emitted, never read.',

  // ── RFQ ────────────────────────────────────────────────────────────────────
  'rfq:[].specs[].mandatory': 'WIRE — the planner ranks gaps by a category corpus average while ignoring which specs this category actually forces a buyer to answer.',
  'rfq:[].specs[].priority': 'WIRE — the buyer\'s own form order is the natural order for the seeded chips.',
  'rfq:[].order_value': 'WIRE — becomes a stated evidence atom and a PREFILL decision, then formAdapter drops it on the context skip-list and no surface renders it. Either show it or stop emitting the decision.',
  'rfq:[].category_name': 'WIRE — the planner gets categoryName from the McatDtl API instead, so the label the buyer actually posted under is discarded.',
  'rfq:[]._name_from': 'KEEP — merge-ledger provenance, debug-only by design.',
  'rfq:[]._renamed_from': 'KEEP — merge-ledger provenance, debug-only by design.',
  'rfq:[]._merged': 'WIRE — this is the audit trail for the Sweet Packaging Tray <- Sweet Potatoes merge. Nothing reads it, so a bad merge is still only findable by a human opening the raw dump. It should raise a visible warning.',
  'rfq:[].purchase_frequency': 'WIRE — a stated cadence that formAdapter skip-lists, while the planner still spends a gap slot on "One-time order, or a recurring monthly need?".',
  'rfq:[].description': 'WIRE — the buyer\'s own prose about his own requirement, parsed and read by nothing. It belongs in the planner prompt.',
  'rfq:[].product_or_service': 'WIRE — a service requirement should not be asked product questions.',
  'rfq:[].posted': 'DELETE — recency_days is derived from it and is what everything uses.',
  'rfq:[].expiry': 'DELETE — is_expired is derived from it and is what everything uses.',
  'rfq:[].verified': 'WIRE or DELETE — a verified lead is stronger evidence than an unverified one; nothing weighs it.',
  'rfq:[].offer_id': 'WIRE — without it no decision can be traced back to the buylead it came from.',

  // ── PROFILE ────────────────────────────────────────────────────────────────
  'profile:identity.name': 'KEEP — PII, must not reach a seller-facing payload. TODO: then stop emitting it into node_raw as well.',
  'profile:identity.mobile': 'KEEP — PII. TODO: strip from node_raw.',
  'profile:identity.email': 'KEEP — PII. TODO: strip from node_raw.',
  'profile:identity.company': 'WIRE — not PII in the same sense. The company name is the best single clue to what the buyer does, and the planner is asked to infer buyer_situation without it.',
  'profile:identity.designation': 'WIRE — "Purchase Manager" vs "Proprietor" changes the register of every question.',
  'profile:identity.whatsapp_active': 'WIRE — the WhatsApp source is empty for most buyers; this is the cheap availability check nobody makes.',
  'profile:identity.email_verified': 'KEEP or DELETE — no decision depends on it.',
  'profile:identity.website': 'WIRE — a buyer with a website is a business buyer; the identity/GST gate currently guesses.',
  'profile:location.district': 'DELETE — city + state cover every consumer.',
  'profile:location.pincode': 'WIRE — the form asks the buyer for a delivery pincode we already hold.',
  'profile:location.address': 'KEEP — PII-adjacent, not needed pre-quote.',
  'profile:location.country_iso': 'DELETE — single-country product.',
  'profile:business.turnover': 'WIRE — order-size sanity, budget banding and the B2B/B2C call all guess without it.',
  'profile:kyb.pan': 'KEEP — identity document, not a requirement signal.',
  'profile:kyb.legal_status': 'WIRE — proprietorship vs pvt ltd is a direct read on B2B-ness; the planner infers it from the category instead.',
  'profile:kyb.registration_year': 'WIRE — business age, same argument as member_since which IS used.',
  'profile:kyb.nature_secondary': 'WIRE — a second line of business explains an otherwise unrelated basket.',
  'profile:activity.past_requirements': 'WIRE — repeat-buyer detection currently uses total_requirements alone.',
  'profile:activity.enquiry_replies': 'WIRE — responsiveness is never scored, yet it predicts whether quotes will be answered.',
  'profile:activity.pns_calls': 'DELETE — subsumed by total_calls in score().',
  'profile:activity.buy_replies': 'WIRE — same responsiveness argument.',
  'profile:rating': 'KEEP or DELETE — ratings the buyer gave bear on nothing in this flow.',
  'profile:seller_status': 'WIRE — listing_status / is_paid / trustseal say this buyer is a paying seller; today only the opaque custtype_weight survives and nothing reads it.',
  'profile:seller_context': 'WIRE — THE named incident. Parsed by buyer-brain, dropped by the node_raw whitelist, re-emitted in v8, still zero consumers. custtype_name = "qgFCPplus with PNS" means the buyer is a paid seller, and he is treated exactly like a cold buyer.',
  'profile:interests.browse_interest': 'DELETE or WIRE — parsed by parseBuyer and dropped before node_raw, so it is both invisible and unread.',
  'profile:verified_business_buyer': 'WIRE — a verified business buyer should never be shown the "Are you GST registered?" identity gap.',

  // ── CALLS ──────────────────────────────────────────────────────────────────
  'calls:coverage': 'KEEP as health, but ALARM on it — the nine counters are the only place a silent transcription failure shows up and nothing checks them.',
  'calls:buyer.name': 'KEEP — PII.',
  'calls:buyer.mobile': 'KEEP — PII.',
  'calls:buyer.city': 'WIRE — a city the buyer STATED on a call outranks both the browsing city and the registered city in the delivery_city A/B, and it is not even a candidate.',
  'calls:buyer.state': 'WIRE — same argument as buyer.city.',
  'calls:buyer.b2b_b2c': 'WIRE — the per-buyer B2B/B2C read from his own call is dropped while category.b2b_b2c (a corpus average over other buyers) IS passed to the planner. The average beats the individual.',
  'calls:buyer.persona': 'WIRE — same inversion: category.personas is passed to the LLM, the buyer\'s own persona is not.',
  'calls:requirement.products[].name': 'WIRE — buyer-brain pools csl/rfq/profile/whatsapp into clusters; calls arrive a level later at requirement-brain, so a product the buyer SPOKE about can never become or rename a requirement.',
  'calls:requirement.products[].source': 'KEEP — provenance of the extraction.',
  'calls:requirement.products[].quantity': 'WIRE — a quantity the buyer said out loud, dropped, while the form still asks him for it.',
  'calls:requirement.products[].price': 'WIRE — a stated target price is the single most useful thing a seller could be told.',
  'calls:requirement.intent_level': 'WIRE — score() rebuilds intent from click/call counters and ignores the read taken from the buyer\'s own voice.',
  'calls:seller_engagement.outcomes': 'WIRE — a "Follow-up" outcome is live intent.',
  'calls:seller_engagement.deal_readiness': 'WIRE — a direct read on how close the deal is, unused by score().',
  'calls:seller_engagement.next_steps': 'WIRE — what the buyer agreed to do next is the best possible opening line.',
  'calls:seller_engagement.callbacks': 'WIRE — an explicit dated commitment from the buyer, unread.',

  // ── WHATSAPP ───────────────────────────────────────────────────────────────
  'whatsapp:buyer_turns': 'WIRE — conversation depth is engagement; score() cannot see it.',
  'whatsapp:responsive': 'WIRE — predicts whether the quotes will be answered.',
  'whatsapp:button_taps': 'WIRE — a quick-reply tap is a STATED answer and it is thrown away.',
  'whatsapp:campaigns_received': 'KEEP — our outbound volume, not buyer intent.',
  'whatsapp:campaigns_responded': 'WIRE — responding to a campaign is buyer intent, unlike receiving one.',
  'whatsapp:response_rate': 'WIRE — same responsiveness argument.',
  'whatsapp:images_requested': 'WIRE — a buyer who asks for photos wants the photo-first flow.',
  'whatsapp:supplier_feedback_given': 'KEEP or DELETE — bears on nothing in this flow.',

  // ── CATEGORY ───────────────────────────────────────────────────────────────
  'category:calls': 'WIRE — a brain built from 3 analysed calls and one built from 3000 are indistinguishable to both the planner gate and the LLM prompt. Only the debug dot reads it.',
  'category:top_specs_source': 'WIRE — added in v11 for exactly one reason: so downstream could tell a real call-derived brain from the getISQ substitution. Nothing reads it, so the planner still tells the LLM "asked in X% of this category\'s seller calls" for rows that were never on a call.',
  'category:calls_analyzed': 'DELETE — duplicate of `calls` in the node_raw projection.',
  'category:top_products': 'DELETE or WIRE — parsed in the requirement-brain entry block, never emitted, never read.',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('source contracts — shape', () => {
  test('all six sources publish the seven facets the architecture review asked for', () => {
    for (const id of SOURCE_IDS) {
      const c = SOURCE_CONTRACTS[id];
      assert.ok(c.version, `${id}: missing Version`);
      assert.ok(c.fields.length > 0, `${id}: missing Fields`);
      assert.ok(c.freshness?.kind && c.freshness.window, `${id}: missing Freshness`);
      assert.ok(c.confidence?.tier && c.confidence.basis, `${id}: missing Confidence`);
      assert.ok(c.coverage && 'pct' in c.coverage && c.coverage.basis, `${id}: missing Coverage`);
      assert.ok(c.latency?.tier && typeof c.latency.typicalMs === 'number', `${id}: missing Latency`);
      assert.ok(c.owner && c.producedBy.length, `${id}: missing Owner`);
    }
  });

  test('every declared consumer is referenced by at least one facet', () => {
    const used = new Set(SOURCE_IDS.flatMap((id) => SOURCE_CONTRACTS[id].fields.flatMap((f) => f.consumedBy as string[])));
    const orphans = Object.keys(CONSUMERS).filter((c) => !used.has(c) && c !== 'BrainDebugPanel:raw-dump');
    assert.deepEqual(orphans, [], 'a consumer is declared but reads nothing — delete it or wire it');
  });

  test('facet paths are unique per source', () => {
    for (const id of SOURCE_IDS) {
      const paths = SOURCE_CONTRACTS[id].fields.map((f) => f.path);
      assert.equal(new Set(paths).size, paths.length, `${id}: duplicate facet path`);
    }
  });
});

describe('parsed-then-dropped — a facet with zero consumers is a build failure', () => {
  test('no undeclared dead facet', () => {
    const undeclared = base.dead
      .filter((f) => !(facetKey(f) in DEAD_FACET_ALLOWLIST))
      .map((f) => `${facetKey(f)} — ${f.note ?? 'no note'}`);
    assert.deepEqual(
      undeclared, [],
      'these facets are parsed and read by nothing. Wire a consumer, delete the field, or add a line to DEAD_FACET_ALLOWLIST saying which and why.',
    );
  });

  test('the allow-list is current — a facet that found a consumer must be deleted from it', () => {
    const deadKeys = new Set(base.dead.map(facetKey));
    const stale = Object.keys(DEAD_FACET_ALLOWLIST).filter((k) => !deadKeys.has(k));
    assert.deepEqual(stale, [], 'these allow-list entries now have live consumers — delete the lines. The list may only shrink.');
  });

  test('the allow-list only shrinks', () => {
    // Locked at the count measured when this guardrail was built (2026-07-28, engine req-brain-v2
    // fixtures + v11 workflow). Raising it means a new facet was parsed and dropped.
    const LOCKED_AT = 78;
    assert.ok(
      Object.keys(DEAD_FACET_ALLOWLIST).length <= LOCKED_AT,
      `dead-facet allow-list grew to ${Object.keys(DEAD_FACET_ALLOWLIST).length} (locked at ${LOCKED_AT}). Lower LOCKED_AT when you fix one; never raise it.`,
    );
  });

  test('every facet the payload actually carries is declared in a contract', () => {
    const leafPaths = (v: unknown, prefix = ''): string[] => {
      if (Array.isArray(v)) return [...new Set(v.slice(0, 5).flatMap((e) => leafPaths(e, `${prefix}[]`)))];
      if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, val]) => leafPaths(val, prefix ? `${prefix}.${k}` : k));
      return [prefix];
    };
    // array hops are structure, not name: `keywords[]` and `keywords` are the same facet.
    const flat = (s: string) => s.replace(/\[\]/g, '');
    const missing: string[] = [];
    for (const [glid, payload] of Object.entries(fixtures)) {
      const nodeRaw = ((payload as { observability?: { node_raw?: Record<string, unknown> } }).observability?.node_raw ?? {});
      for (const id of SOURCE_IDS) {
        const raw = nodeRaw[id];
        if (raw == null) continue;
        const declared = SOURCE_CONTRACTS[id].fields.map((f) => flat(f.path));
        for (const leaf of leafPaths(raw).map(flat)) {
          const covered = declared.some((d) => leaf === d || leaf.startsWith(`${d}.`) || d.startsWith(`${leaf}.`));
          if (!covered) missing.push(`${glid} ${id}:${leaf}`);
        }
      }
    }
    assert.deepEqual(
      [...new Set(missing.map((m) => m.split(' ').slice(1).join(' ')))], [],
      'the engine emits a field no contract declares — declare it (with its consumer) in src/lib/sourceContract.ts',
    );
  });
});

describe('coverage report (informational)', () => {
  test('report', () => {
    const wastedKeys = new Set<string>();
    for (const [, r] of reports) for (const f of r.wasted) wastedKeys.add(facetKey(f));
    const lines: string[] = [];
    lines.push(`  contracts: ${SOURCE_IDS.length} sources · ${base.facets.length} facets · ${base.dead.length} dead (${Math.round((base.dead.length / base.facets.length) * 100)}%)`);
    lines.push(`  parsed-then-dropped observed in the fixtures: ${wastedKeys.size} facets carried real data that nothing read`);
    for (const id of SOURCE_IDS) {
      const dead = base.facets.filter((f) => f.source === id && f.dead).length;
      const total = base.facets.filter((f) => f.source === id).length;
      const cov = reports.map(([, r]) => r.sources.find((s) => s.source === id)?.observedCoverage ?? 0);
      const avg = cov.reduce((a, b) => a + b, 0) / (cov.length || 1);
      lines.push(`  ${id.padEnd(9)} ${String(total - dead).padStart(2)}/${String(total).padEnd(3)} facets consumed · fixture fill ${(avg * 100).toFixed(0).padStart(3)}%`);
    }
    const neverPresent = base.facets.filter((f) => f.emitted).filter((f) => reports.every(([, r]) => !r.facets.find((x) => facetKey(x) === facetKey(f))?.present));
    lines.push(`  declared but absent from all 3 fixtures: ${neverPresent.length} (fixtures were captured from the older req-brain-v2 emitter; the contract tracks v11)`);
    console.log(`\n${lines.join('\n')}\n`);
    assert.ok(base.facets.length > 0);
  });
});
