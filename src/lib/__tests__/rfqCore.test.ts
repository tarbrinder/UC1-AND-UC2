/// <reference types="node" />
// ─── DYNAMIC RFQ · 3-LLM CORE — the deterministic layers, pinned ──────────────
// Run: npm test
//
// Until this file, NOT ONE test imported anything from src/lib/rfq/: the four existing suites certify
// the retired architecture, while every regression the 24-bug and the 101-gap audits found lives in
// these four files. Covered here — all of it pure, no network, no LLM:
//   · dropAnswered      the Deterministic Merge Layer. Drops a question already answered on an earlier
//                       page, AND one merely SHOWN there (the P2↔P3 "shown but skipped" rule).
//   · haveRealBrain     the upgrade-refire predicate. Wrong either way costs a re-fire or a stale brain.
//   · buildSession /    what the planners are allowed to see, and the thin brain LLM 2/3 run on when
//     fallbackContext   they fire before LLM 1 has landed.
//   · applyBudget       asks are CAPPED at BUDGET.max; prefills/confirms are EXTRA and never dropped.
//   · runPlanner        the option-chip contract: an `ask` with <2 chips renders as a raw text box in
//                       renderCxPs, so it must never reach an envelope.
//   · the two fences    AI-Debug must show the model EXACTLY production's data — line numbers are the
//                       only difference. The inverse (debug truncating first) shipped and was fixed.
//
// ── HOW THESE MODULES ARE LOADED, AND WHY IT IS NOT A PLAIN IMPORT ───────────────────────────────
// `node --test` runs .ts directly by stripping types, and stripping does NOT rewrite import specifiers.
// src/lib/rfq/*.ts import each other extensionlessly (`from './contracts'`) — which node's ESM resolver
// cannot resolve — and llm.ts pulls in ../gemini.ts, which reads `import.meta.env` at module scope
// (undefined outside vite) and owns the real HTTP transport. So loadRfqModule() reads the REAL shipped
// file, strips its types, rewrites its relative specifiers to absolute file: URLs, and swaps ../gemini
// for a recording stub. Nothing is copied or re-implemented: the code under test is the code on disk.
// The loader fails LOUDLY if a specifier stops resolving, so it can never silently test nothing.
// (repoScan.ts's extractRegexLiteral pins a guard to shipped source for exactly the same reason.)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { BUDGET, answeredKeys, emptySession } from '../rfq/contracts.ts';
import type { PlannerEnvelope, Question, RequirementBrain, SessionState } from '../rfq/contracts.ts';
import { detectLocationConflict } from '../rfq/locationConflict.ts';
import { buildRunTrace } from '../rfq/debugTrace.ts';
import { bpodToProfileNode, bpodToBuyerFacts } from '../brains/bpodMap.ts';
import { assessBulkB2B } from '../brains/formAdapter.ts';
import { reconcilePostedRequirement } from '../rfq/categoryReconcile.ts';
import { parseEnquiries, parseUserDetail } from '../rfq/enquiryParse.ts';

const RFQ_DIR = new URL('../rfq/', import.meta.url);
const LLM_SRC = readFileSync(new URL('llm.ts', RFQ_DIR), 'utf8');

const asDataUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;

/** stripTypeScriptTypes emits a once-per-process ExperimentalWarning; muted so `npm test` stays readable. */
function quiet<T>(fn: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try { return fn(); } finally { process.emitWarning = emit; }
}

const RELATIVE_SPEC = /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/;
const IS_IMPORT_LINE = /^\s*(?:import|export)\b/;

/** The names a module really imports from `spec` — so a stub exports exactly that, and a new import
 *  (recordParse landed mid-audit) surfaces as a loud module-resolution error, never a silent skip. */
function namedImports(src: string, spec: string): string[] {
  const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = src.match(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]${esc}['"]`));
  if (!m) throw new Error(`[rfqCore] no named import of '${spec}' found — the stub cannot know what to export`);
  return m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean);
}

function loadRfqModule(file: string, stubs: Record<string, (named: string[]) => string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(file, RFQ_DIR);
  const src = readFileSync(url, 'utf8');
  const code = quiet(() => stripTypeScriptTypes(src, { mode: 'strip' }))
    .split('\n')
    .map((line) => (IS_IMPORT_LINE.test(line)
      ? line.replace(RELATIVE_SPEC, (_m: string, kw: string, quote: string, spec: string) => {
        const stub = stubs[spec];
        const target = stub ? asDataUrl(stub(namedImports(src, spec))) : new URL(spec.endsWith('.ts') ? spec : `${spec}.ts`, url).href;
        return `${kw}${quote}${target}${quote}`;
      })
      : line))
    .join('\n');
  const unresolved = code.split('\n').filter((l) => IS_IMPORT_LINE.test(l) && RELATIVE_SPEC.test(l));
  if (unresolved.length) throw new Error(`[rfqCore] loader left a relative specifier unresolved in ${file}: ${unresolved.join(' | ')} — fix the loader, do not delete the tests`);
  return import(asDataUrl(code));
}

// ── the recording transport ───────────────────────────────────────────────────
interface LlmCall { messages: { role: string; content: string }[]; opts: Record<string, unknown> }
const bridge = { calls: [] as LlmCall[], reply: '', side: [] as Array<[string, unknown[]]> };
(globalThis as unknown as { __rfqBridge: typeof bridge }).__rfqBridge = bridge;

/** ../gemini, replaced: callLLM records the prompt it was handed and returns a canned string; every
 *  other imported name becomes a recorded no-op. No key, no fetch, no model. */
const geminiStub = (named: string[]) => named.map((n) => (n === 'callLLM'
  ? 'export const callLLM = async (messages, opts) => { globalThis.__rfqBridge.calls.push({ messages, opts }); return globalThis.__rfqBridge.reply; };'
  : `export const ${n} = (...args) => { globalThis.__rfqBridge.side.push([${JSON.stringify(n)}, args]); };`)).join('\n');

/** Arm the transport with what "the LLM" will answer, and clear the recorder. */
function say(reply: unknown): void {
  bridge.calls.length = 0; bridge.side.length = 0;
  bridge.reply = typeof reply === 'string' ? reply : JSON.stringify(reply);
}
const lastUserPrompt = (): string => {
  assert.equal(bridge.calls.length, 1, 'expected exactly one LLM call to have been made');
  return bridge.calls[0].messages[1].content;
};

const pcMod = await loadRfqModule('plannerController.ts');
const llmMod = await loadRfqModule('llm.ts', { '../gemini': geminiStub });

const { buildSession, dropAnswered, fallbackContext, haveRealBrain } = pcMod as {
  buildSession: (a: {
    product: string; quantity?: string; mcatId?: string;
    extraSpecs: Record<string, string>; specValues: Record<string, string>; aiSpecValues: Record<string, string>;
    cxAnswers: Record<string, string>; psAnswers: Record<string, string>;
  }) => SessionState;
  dropAnswered: (env: PlannerEnvelope, session: SessionState, extraShown?: string[]) => PlannerEnvelope;
  fallbackContext: (product: string, quantity: string | undefined, unit: string, specLine: string) => RequirementBrain;
  haveRealBrain: (b: RequirementBrain | null | undefined) => boolean;
};
const { applyBudget, runCommercialPlanner, runRequirementBrain } = llmMod as {
  applyBudget: (env: PlannerEnvelope) => PlannerEnvelope;
  runCommercialPlanner: (inp: { brain: RequirementBrain; session: SessionState; categoryEngine?: unknown; pns?: unknown },
    exec?: 'prod' | 'debug', effort?: 'low' | 'medium' | 'high') => Promise<PlannerEnvelope | null>;
  runRequirementBrain: (inp: Record<string, unknown>, exec?: 'prod' | 'debug', effort?: 'low' | 'medium' | 'high') => Promise<unknown>;
};

// ── builders ──────────────────────────────────────────────────────────────────
const mkQ = (field: string, ui: Question['ui'], order: number, extra: Partial<Question> = {}): Question =>
  ({ field, label: field, ui, order, ...extra });
const mkEnv = (questions: Question[]): PlannerEnvelope =>
  ({ planner: 'commercial', version: 'cx-v1', questions, metadata: { reasoning: { warranty: { why: 'x' } } } });
const mkSession = (over: Partial<SessionState> = {}): SessionState => ({ ...emptySession(), ...over });
const REAL_BRAIN: RequirementBrain = { understanding: 'Bakery buying kraft rolls', persona_read: 'SME owner', category_trustworthy: true, evidence: [] };
const fields = (env: PlannerEnvelope | null) => (env?.questions ?? []).map((q) => q.field);

// ═════════════════════════════════════════════════════════════════════════════
// 1 · BUDGET — the constant every layer and every prompt reads
// ═════════════════════════════════════════════════════════════════════════════
describe('BUDGET invariants', () => {
  // min/pref/max are three separate literals on one line. Inverting two of them (max < min) silently
  // turns the ask-cap into an ask-KILLER — applyBudget would slice to fewer than the prompt asked for
  // and Page 2 would render empty, which the fail/empty auto-skip then reads as "no questions" and
  // skips the page entirely. Nothing else in the codebase would complain.
  test('min ≤ pref ≤ max, and every bound is a positive integer', () => {
    assert.ok(BUDGET.min <= BUDGET.pref, `BUDGET.min (${BUDGET.min}) must not exceed pref (${BUDGET.pref})`);
    assert.ok(BUDGET.pref <= BUDGET.max, `BUDGET.pref (${BUDGET.pref}) must not exceed max (${BUDGET.max})`);
    for (const [k, v] of Object.entries(BUDGET)) {
      assert.ok(Number.isInteger(v) && v >= 1, `BUDGET.${k} = ${v}; a question count must be a positive integer`);
    }
  });

  // The planner PROMPT tells the model "ask between min and max (prefer pref)" and applyBudget enforces
  // the cap. If either side hardcodes a digit the two drift apart, and the visible symptom is the model
  // returning 6 asks that the code silently cuts to 5 — a question the buyer never sees and nobody can
  // explain. Both sides must read the one constant.
  test('the planner prompt interpolates BUDGET rather than hardcoding the numbers', () => {
    for (const ref of ['BUDGET.min', 'BUDGET.pref', 'BUDGET.max']) {
      assert.ok(LLM_SRC.includes(ref), `llm.ts no longer references ${ref} — the prompt and the enforcer must share one constant`);
    }
    const budgetLine = LLM_SRC.split('\n').find((l) => l.includes('- Budget: ask between'));
    assert.ok(budgetLine, 'the prompt\'s Budget sentence moved — re-anchor this test, do not delete it');
    assert.ok(/\$\{BUDGET\.min\}/.test(budgetLine) && /\$\{BUDGET\.max\}/.test(budgetLine),
      `the Budget sentence must interpolate BUDGET, not literal digits: ${budgetLine.trim()}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · dropAnswered — the Deterministic Merge Layer
// ═════════════════════════════════════════════════════════════════════════════
describe('dropAnswered — the deterministic merge layer', () => {
  // The core promise of the merge layer: the buyer is never asked twice. LLM 3 has no memory of what
  // LLM 2 produced, so nothing but this filter stops payment_terms appearing on both Page 2 and Page 3.
  test('a field already answered on an earlier page is dropped', () => {
    const out = dropAnswered(mkEnv([mkQ('payment_terms', 'ask', 0), mkQ('designation', 'ask', 1)]),
      mkSession({ page2: { payment_terms: 'Net 30' } }));
    assert.deepEqual(fields(out), ['designation'], 'payment_terms was answered on Page 2 — Page 3 must not re-ask it');
  });

  // The P2↔P3 "shown but SKIPPED" rule (extraShown). A commercial question the buyer looked at and left
  // blank is NOT in answeredKeys, so without extraShown the persona planner is free to re-surface it —
  // the buyer sees the question he just declined, one page later, and reads it as a broken form.
  test('a field merely SHOWN on an earlier page is dropped even though it was never answered', () => {
    const env = mkEnv([mkQ('sample_order', 'ask', 0), mkQ('industry', 'ask', 1)]);
    const answeredOnly = dropAnswered(env, mkSession());
    assert.deepEqual(fields(answeredOnly), ['sample_order', 'industry'], 'precondition: nothing is answered, so nothing drops on answers alone');
    const out = dropAnswered(env, mkSession(), ['sample_order']);
    assert.deepEqual(fields(out), ['industry'], 'sample_order was shown on Page 2 and skipped — it must not reappear on Page 3');
  });

  // The negative side. This layer DELETES, so a rule that over-fires costs the seller the one attribute
  // that decides the quote, and it fails invisibly — the question simply never renders.
  test('questions with unique fields survive untouched', () => {
    const asked = [mkQ('warranty', 'ask', 0), mkQ('delivery_timeline', 'ask', 1), mkQ('supplier_type', 'ask', 2)];
    const out = dropAnswered(mkEnv(asked), mkSession({ page1: { GSM: '120' }, page2: { payment_terms: 'Net 30' } }), ['annual_procurement']);
    assert.deepEqual(out.questions, asked, 'none of these fields was answered or shown — all three must survive');
  });

  // The whole point of the CANONICAL FIELD KEYS rule in the prompt is that both pages spell a shared
  // concept identically. They do not always: the merge layer therefore normalises case and separators,
  // so "Delivery Timeline" and delivery_timeline are one field. A comparison on the raw key lets the
  // synonym through and the buyer answers the same question twice.
  test('keys are normalised, so a case/separator variant still dedups', () => {
    const out = dropAnswered(mkEnv([mkQ('Delivery Timeline', 'ask', 0), mkQ('PAYMENT-TERMS', 'ask', 1)]),
      mkSession({ page2: { delivery_timeline: '7 days', payment_terms: 'Advance' } }));
    assert.deepEqual(fields(out), [], 'both are separator/case variants of an answered field');
  });

  // Shares one normaliser with answeredKeys in contracts.ts. Two copies of "normalise a field key" is
  // how a dedup layer starts agreeing with itself and disagreeing with the data.
  test('…the same normaliser answeredKeys uses', () => {
    assert.deepEqual([...answeredKeys(mkSession({ page2: { 'Delivery Timeline': '7 days' } }))], ['deliverytimeline']);
  });

  // A field PRESENT with a blank value is not answered. The specs pages seed keys ahead of the buyer
  // filling them, so treating key-presence as "answered" would delete the very question that collects
  // the value — the form would silently stop asking anything the schema pre-seeded.
  test('a field present but blank is NOT answered — the question survives', () => {
    const out = dropAnswered(mkEnv([mkQ('warranty', 'ask', 0), mkQ('industry', 'ask', 1)]),
      mkSession({ page2: { warranty: '' }, page3: { industry: '   ' } }));
    assert.deepEqual(fields(out), ['warranty', 'industry'], 'an empty / whitespace value is an UNanswered field');
  });

  // The envelope carries the planner identity and (in debug) the reasoning + considered ledger the
  // inspector renders. A merge layer that rebuilds the envelope instead of spreading it strips the
  // provenance, and the AI Inspector goes blank with no error anywhere.
  test('the envelope\'s other properties are preserved and the input is not mutated', () => {
    const env = mkEnv([mkQ('warranty', 'ask', 0), mkQ('payment_terms', 'ask', 1)]);
    const out = dropAnswered(env, mkSession({ page2: { warranty: '1 year' } }));
    assert.equal(out.planner, env.planner);
    assert.equal(out.version, env.version);
    assert.deepEqual(out.metadata, env.metadata, 'debug reasoning/considered must ride through the merge layer');
    assert.equal(env.questions.length, 2, 'dropAnswered must return a new envelope, never splice the caller\'s array');
  });

  // dropAnswered runs inside a .then() on every planner result. A throw there is swallowed by the
  // .catch() and read as "planner failed", which auto-skips the page — a data shape becomes a missing page.
  test('empty and missing inputs never throw', () => {
    assert.deepEqual(dropAnswered(mkEnv([]), emptySession()).questions, []);
    assert.deepEqual(fields(dropAnswered(mkEnv([mkQ('warranty', 'ask', 0)]), emptySession())), ['warranty'], 'an empty session drops nothing');
    assert.deepEqual(fields(dropAnswered(mkEnv([mkQ('warranty', 'ask', 0)]), emptySession(), [])), ['warranty'], 'an empty extraShown drops nothing');
    assert.doesNotThrow(() => dropAnswered(mkEnv([mkQ('', 'ask', 0)]), mkSession({ page1: { '': 'x' } })), 'a blank field key must not throw');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2b · concept-registry (2026-08-10) — the NEW canonical concepts the audit found missing
// ═════════════════════════════════════════════════════════════════════════════
describe('concept-registry — page-1-spec ⇄ planner-question dedup for the newly-mapped concepts', () => {
  // Helper: page-1 has a filled spec `spec`; a planner asks `q` + a guard 'warranty'. Returns the survivors.
  const dropsVia = (spec: string, q: string) =>
    fields(dropAnswered(mkEnv([mkQ(q, 'ask', 0), mkQ('warranty', 'ask', 1)]), mkSession({ page1: { [spec]: 'x' } })));
  test('finance/payment aliases — a Finance/Credit/Loan spec suppresses the payment question (owner #1)', () => {
    assert.deepEqual(dropsVia('Finance', 'payment_terms'), ['warranty'], 'finance in buyer specs must suppress the payment question');
    assert.deepEqual(dropsVia('Credit Period', 'payment_terms'), ['warranty']);
    assert.deepEqual(dropsVia('Loan Amount', 'How will you pay?'), ['warranty']);
  });
  test('delivery aliases — a Dispatch/Shipping spec suppresses the delivery question', () => {
    assert.deepEqual(dropsVia('Dispatch Time', 'delivery_timeline'), ['warranty']);
    assert.deepEqual(dropsVia('Shipping Time', 'When do you need delivery?'), ['warranty']);
  });
  test('application == intent — an Application/Usage/End Use spec suppresses the intent question (owner #5)', () => {
    assert.deepEqual(dropsVia('Application', 'Intended use'), ['warranty'], 'application answers intent — do not re-ask');
    assert.deepEqual(dropsVia('Usage', 'What is this for?'), ['warranty']);
    assert.deepEqual(dropsVia('End Use', 'Application'), ['warranty']);
  });
  test('new concepts — MOQ, installation, certification each dedup on a rephrase', () => {
    assert.deepEqual(dropsVia('Minimum Order Quantity', 'MOQ'), ['warranty']);
    assert.deepEqual(dropsVia('Installation Type', 'Installation'), ['warranty']);
    assert.deepEqual(dropsVia('Certification', 'Compliance'), ['warranty']);
  });
  test('setup_stage — commercial business_setup_type suppresses persona setup_stage, but NOT machine_setup_configuration (2026-08-12 dup)', () => {
    // Commercial page SHOWED business_setup_type. Persona then produces setup_stage (the SAME lifecycle concept) plus
    // machine_setup_configuration (a distinct product-scope question). Only setup_stage must drop.
    const env = mkEnv([mkQ('setup_stage', 'ask', 0), mkQ('machine_setup_configuration', 'ask', 1)]);
    assert.deepEqual(fields(dropAnswered(env, mkSession(), ['business_setup_type'])), ['machine_setup_configuration'], 'setup_stage duplicates business_setup_type; machine_setup_configuration is distinct and survives');
    // by LABEL too: "Machinery setup stage" ≡ "Select Business Setup Type"
    const byLabel = mkEnv([mkQ('sx', 'ask', 0, { label: 'Machinery setup stage' })]);
    assert.deepEqual(fields(dropAnswered(byLabel, mkSession(), ['Select Business Setup Type'])), [], 'the persona LABEL dedups against the commercial one');
  });
  test('no over-collapse — a genuinely different spec must NOT suppress payment/delivery', () => {
    assert.deepEqual(fields(dropAnswered(mkEnv([mkQ('payment_terms', 'ask', 0)]), mkSession({ page1: { Material: 'Steel' } }))), ['payment_terms']);
    assert.deepEqual(fields(dropAnswered(mkEnv([mkQ('delivery_timeline', 'ask', 0)]), mkSession({ page1: { Colour: 'Red' } }))), ['delivery_timeline']);
    // 'advance' is NOT a payment fragment (only 'advancepayment' is) — an "Advance Booking" spec must not suppress payment.
    assert.deepEqual(fields(dropAnswered(mkEnv([mkQ('payment_terms', 'ask', 0)]), mkSession({ page1: { 'Advance Booking': 'yes' } }))), ['payment_terms']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · haveRealBrain — the upgrade-refire predicate
// ═════════════════════════════════════════════════════════════════════════════
describe('haveRealBrain — fallback vs real', () => {
  // LLM 2/3 fire on stage entry, which can beat LLM 1 home. This predicate is the only thing that
  // authorises the ONE upgrade re-fire; returning true too early pins Page 2 to the thin fallback for
  // the rest of the session, and no error is raised anywhere.
  test('null / undefined is not a real brain', () => {
    assert.equal(haveRealBrain(null), false);
    assert.equal(haveRealBrain(undefined), false);
  });

  // The parse-succeeded-but-empty case: LLM 1 returned 200 with JSON that had no understanding and no
  // persona_read. runRequirementBrain coerces those to '' rather than failing, so a truthiness test on
  // the OBJECT would call this a real brain and cancel the re-fire.
  test('a brain whose text fields are empty strings is not a real brain', () => {
    assert.equal(haveRealBrain({ understanding: '', persona_read: '', category_trustworthy: true, evidence: [] }), false,
      'category_trustworthy/evidence alone is metadata, not an understanding');
  });

  test('either understanding or persona_read alone is enough', () => {
    assert.equal(haveRealBrain({ ...REAL_BRAIN, persona_read: '' }), true);
    assert.equal(haveRealBrain({ ...REAL_BRAIN, understanding: '' }), true);
    assert.equal(haveRealBrain(REAL_BRAIN), true);
  });

  // TRIPWIRE, not an endorsement. haveRealBrain tests CONTENT, not provenance — and fallbackContext
  // produces content whenever a product name exists. It is safe only because the call sites apply it to
  // rbBrain (LLM 1's own output, null until it lands) and never to the fallback they pass as rfqBrain.
  // If anyone ever routes the fallback through this predicate, cxUsedFallback goes false on the first
  // fire and the upgrade re-fire is dead — silently, forever.
  test('it is a CONTENT test, not a provenance test: a non-empty fallback would pass it', () => {
    assert.equal(haveRealBrain(fallbackContext('Kraft Paper Roll', '5', 'Tonne', 'GSM 120')), true,
      'so haveRealBrain must only ever be applied to LLM 1\'s own output, never to fallbackContext\'s');
    assert.equal(haveRealBrain(fallbackContext('', undefined, '', '')), false,
      'an empty fallback must read as "no brain yet" so the upgrade re-fire still happens');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · buildSession / fallbackContext
// ═════════════════════════════════════════════════════════════════════════════
describe('buildSession — what the planners are allowed to see', () => {
  // Page 1 is three overlapping bags. The documented precedence is extras < buyer selections < AI
  // values: "Also detected" specs must be VISIBLE but must never overwrite what the buyer chose.
  test('page1 layers extraSpecs < specValues < aiSpecValues on a key collision', () => {
    const s = buildSession({
      product: 'Kraft Paper Roll', quantity: '5', mcatId: '4979',
      extraSpecs: { GSM: 'from-extras', Colour: 'Brown' },
      specValues: { GSM: 'from-buyer', Grade: 'A' },
      aiSpecValues: { GSM: 'from-ai' },
      cxAnswers: { payment_terms: 'Net 30' }, psAnswers: { designation: 'Owner' },
    });
    assert.equal(s.page1.GSM, 'from-ai', 'a live AI/buyer selection outranks an "Also detected" extra');
    assert.deepEqual(s.page1, { GSM: 'from-ai', Colour: 'Brown', Grade: 'A' }, 'non-colliding keys from every bag must survive');
    assert.deepEqual(s.page2, { payment_terms: 'Net 30' }, 'page2 is the commercial slice, verbatim');
    assert.deepEqual(s.page3, { designation: 'Owner' }, 'page3 is the persona slice, verbatim');
    assert.equal(s.mcatId, '4979');
  });

  // buildSession is called on every render, including before the buyer has typed anything. Every slice
  // must exist and be empty — a missing page bag makes answeredKeys throw inside the merge layer, which
  // the planner .catch() then reports as "planner failed" and auto-skips the page.
  test('an empty input yields the empty-session shape and never throws', () => {
    const s = buildSession({ product: '', extraSpecs: {}, specValues: {}, aiSpecValues: {}, cxAnswers: {}, psAnswers: {} });
    const empty = emptySession();
    assert.equal(s.product, empty.product);
    assert.deepEqual([s.page1, s.page2, s.page3], [empty.page1, empty.page2, empty.page3], 'all three page bags must exist and be empty');
    // quantity/mcatId are present-but-undefined rather than absent. Equivalent for every consumer here
    // (JSON.stringify drops them, so the fences are unaffected), but pinned so it stays a NON-value.
    assert.equal(s.quantity ?? '', '', 'an unset quantity must never materialise as a string');
    assert.equal(s.mcatId ?? '', '', 'an unset mcatId must never materialise as a string');
    assert.deepEqual([...answeredKeys(s)], [], 'and nothing counts as answered');
  });
});

describe('fallbackContext — the thin brain LLM 2/3 run on before LLM 1 lands', () => {
  test('it carries product · quantity+unit · specs, and claims no evidence', () => {
    const b = fallbackContext('Kraft Paper Roll', '5', 'Tonne', 'GSM 120 · Grade A');
    assert.equal(b.understanding, 'Kraft Paper Roll · qty 5 Tonne · GSM 120 · Grade A');
    assert.equal(b.persona_read, '', 'the fallback knows nothing about the person — it must not pretend to');
    assert.equal(b.category_trustworthy, true);
    assert.deepEqual(b.evidence, [], 'a fabricated evidence line here would be cited by the planners as truth');
  });

  // Quantity is optional at commit time. An unconditional template ships " · qty undefined " into the
  // prompt, which the planner reads as a real (absurd) order size.
  test('a missing quantity omits the whole qty segment', () => {
    assert.equal(fallbackContext('Kraft Paper Roll', undefined, 'Tonne', '').understanding, 'Kraft Paper Roll');
    assert.equal(fallbackContext('Kraft Paper Roll', '', 'Tonne', 'GSM 120').understanding, 'Kraft Paper Roll · GSM 120');
  });

  test('empty input never throws and produces the no-brain-yet shape', () => {
    const b = fallbackContext('', undefined, '', '');
    assert.equal(b.understanding, '');
    assert.equal(haveRealBrain(b), false, 'an empty fallback must not be mistaken for a landed brain');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · applyBudget — asks are capped, prefills are EXTRA
// ═════════════════════════════════════════════════════════════════════════════
describe('applyBudget — the ask-only budget', () => {
  test('more asks than BUDGET.max are capped to exactly max', () => {
    const asks = Array.from({ length: BUDGET.max + 3 }, (_, i) => mkQ(`f${i}`, 'ask', i));
    const out = applyBudget(mkEnv(asks));
    assert.equal(out.questions.length, BUDGET.max, `${asks.length} asks in, BUDGET.max (${BUDGET.max}) out`);
  });

  // The LLM emits `order` and the array order need not match it. The budget must keep the questions the
  // planner RANKED highest, not whichever ones happen to be serialized first — otherwise the ranking the
  // debug "considered" ledger explains is not the ranking the buyer got.
  test('the survivors are the lowest `order`s, not the first array entries', () => {
    const shuffled = [mkQ('sixth', 'ask', 50), mkQ('first', 'ask', 0), mkQ('seventh', 'ask', 60), mkQ('second', 'ask', 1),
      mkQ('third', 'ask', 2), mkQ('fourth', 'ask', 3), mkQ('fifth', 'ask', 4)];
    const kept = fields(applyBudget(mkEnv(shuffled)));
    assert.equal(kept.length, BUDGET.max);
    assert.deepEqual(kept.includes('sixth') || kept.includes('seventh'), false, `order 50/60 ranked last — they must not survive a max of ${BUDGET.max}: kept ${kept.join(', ')}`);
  });

  // "Prefills / confirms are EXTRA and do NOT count toward the budget" — the prompt's own words. Counting
  // them spends the buyer's 5 slots on rows he does not have to answer, and the questions that actually
  // need answering get cut.
  test('prefill / confirm / suggest are EXTRA — never counted, never dropped', () => {
    const extras = [mkQ('payment_terms', 'prefill', 90, { value: 'Net 30' }), mkQ('supplier_type', 'confirm', 91, { value: 'Manufacturer' }),
      mkQ('GSM', 'suggest', 92, { value: '120', suggestion: '140' })];
    const asks = Array.from({ length: BUDGET.max }, (_, i) => mkQ(`f${i}`, 'ask', i));
    const out = applyBudget(mkEnv([...asks, ...extras]));
    assert.equal(out.questions.length, BUDGET.max + extras.length, 'every non-ask row must ride through on top of the full ask budget');
    assert.deepEqual(out.questions.filter((q) => q.ui !== 'ask').map((q) => q.field), ['payment_terms', 'supplier_type', 'GSM'],
      'and their high `order` values must not make them look like overflow asks');
  });

  test('…even when the asks alone already overflow', () => {
    const out = applyBudget(mkEnv([...Array.from({ length: BUDGET.max + 4 }, (_, i) => mkQ(`f${i}`, 'ask', i)),
      mkQ('payment_terms', 'prefill', 99, { value: 'Net 30' })]));
    assert.equal(out.questions.filter((q) => q.ui === 'ask').length, BUDGET.max);
    assert.deepEqual(out.questions.filter((q) => q.ui !== 'ask').map((q) => q.field), ['payment_terms']);
  });

  // A CEILING, not a floor. BUDGET.min lives in the prompt only — the code must never invent a question
  // to reach it, because the only thing it could invent is one the truth does not support.
  test('it is a ceiling, not a floor — it never pads toward min/pref', () => {
    const one = applyBudget(mkEnv([mkQ('warranty', 'ask', 0)]));
    assert.equal(one.questions.length, 1, `a single ask must stay a single ask even though BUDGET.min is ${BUDGET.min}`);
    assert.deepEqual(applyBudget(mkEnv([])).questions, [], 'an empty envelope stays empty — the fail/empty auto-skip depends on it');
  });

  test('envelope identity is preserved', () => {
    const env = mkEnv([mkQ('warranty', 'ask', 0)]);
    const out = applyBudget(env);
    assert.equal(out.planner, env.planner);
    assert.equal(out.version, env.version);
    assert.deepEqual(out.metadata, env.metadata);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · the option-chip contract, through the real runPlanner (stubbed transport)
// ═════════════════════════════════════════════════════════════════════════════
describe('runPlanner — strictly option-based', () => {
  const plannerArgs = { brain: REAL_BRAIN, session: mkSession({ product: 'Kraft Paper Roll' }), categoryEngine: null, pns: null };
  const plan = (questions: unknown[], metadata: unknown = {}) => {
    say({ questions, metadata });
    return runCommercialPlanner(plannerArgs);
  };

  // Page 2/3 are chip-only surfaces: renderCxPs falls back to a raw <input> when options are empty, so a
  // chip-less `ask` does not degrade gracefully — it renders a free-text box on a page that promised
  // taps, and the answer arrives unnormalised. The prompt asks for 2-5 chips; this is the code that
  // makes it true when the model ignores it.
  test('an ask with fewer than 2 chips never survives into the envelope', async () => {
    const env = await plan([
      { field: 'warranty', label: 'Warranty', ui: 'ask', options: ['1 year', '2 years'], order: 0 },
      { field: 'one_chip', label: 'One chip', ui: 'ask', options: ['Yes'], order: 1 },
      { field: 'no_chips', label: 'No chips', ui: 'ask', order: 2 },
      { field: 'empty_chips', label: 'Empty chips', ui: 'ask', options: [], order: 3 },
    ]);
    assert.deepEqual(fields(env), ['warranty'], 'only the 2-chip ask may render; the other three would become text boxes');
  });

  test('exactly 2 chips is enough — the rule is a floor, not a preference', async () => {
    assert.deepEqual(fields(await plan([{ field: 'supplier_type', label: 'Supplier', ui: 'ask', options: ['Manufacturer', 'Wholesaler'], order: 0 }])),
      ['supplier_type']);
  });

  // The other half of the contract: a prefill/confirm is a VALUE the buyer confirms, so it legitimately
  // has no chips. A blanket "every question needs options" filter deletes exactly the rows that prove
  // the brain did its job.
  test('prefill / confirm carry a value with no chips and survive', async () => {
    const env = await plan([
      { field: 'payment_terms', label: 'Payment terms', ui: 'prefill', value: 'Net 30', order: 0 },
      { field: 'delivery_timeline', label: 'Delivery', ui: 'confirm', value: '7 days', order: 1 },
    ]);
    assert.deepEqual(fields(env), ['payment_terms', 'delivery_timeline']);
    assert.deepEqual((env?.questions ?? []).map((q) => q.value), ['Net 30', '7 days'], 'the value is the whole point of a prefill row');
  });

  // Composition trap: an unrecognised ui is coerced to 'ask' by the normaliser, which means a row the
  // model labelled "text"/"input" inherits the chip requirement. If the coercion ran AFTER the chip
  // filter, every unknown ui would slip through as a text box.
  test('an unrecognised ui coerces to `ask` — and therefore still needs chips', async () => {
    assert.deepEqual(fields(await plan([{ field: 'freeform', label: 'Freeform', ui: 'text', order: 0 }])), [],
      'ui:"text" is not a renderer mode; it becomes an ask and an ask needs chips');
    const kept = await plan([{ field: 'freeform', label: 'Freeform', ui: 'text', options: ['A', 'B'], order: 0 }]);
    assert.deepEqual((kept?.questions ?? []).map((q) => q.ui), ['ask'], 'with chips it survives, normalised to a real renderer mode');
  });

  test('a row with no field or no label is dropped', async () => {
    const env = await plan([
      { field: '', label: 'Nameless', ui: 'ask', options: ['A', 'B'], order: 0 },
      { field: 'unlabelled', ui: 'ask', options: ['A', 'B'], order: 1 },
      { field: 'good', label: 'Good', ui: 'ask', options: ['A', 'B'], order: 2 },
    ]);
    assert.deepEqual(fields(env), ['unlabelled', 'good'], 'a field-less row cannot be deduped or submitted; a label defaults to the field');
  });

  // `order` drives both the budget's ranking and the render sequence, so a missing order must not
  // collapse every row onto NaN/0 — the ranking would become arbitrary.
  test('a missing `order` defaults to the row\'s position', async () => {
    const env = await plan([
      { field: 'a', label: 'A', ui: 'ask', options: ['x', 'y'] },
      { field: 'b', label: 'B', ui: 'ask', options: ['x', 'y'] },
      { field: 'c', label: 'C', ui: 'ask', options: ['x', 'y'], order: 'nine' },
    ]);
    assert.deepEqual((env?.questions ?? []).map((q) => q.order), [0, 1, 2], 'a non-numeric order is replaced by the index, never coerced to NaN');
  });

  // The runaway slice inside runPlanner must stay wider than the budget, or it becomes a SECOND,
  // undocumented cap that silently outranks applyBudget's `order`-aware one.
  test('the planner\'s own slice is a runaway backstop, wider than the budget', async () => {
    const many = Array.from({ length: BUDGET.max + 20 }, (_, i) => ({ field: `f${i}`, label: `F${i}`, ui: 'ask', options: ['x', 'y'], order: i }));
    const env = await plan(many);
    assert.ok((env?.questions.length ?? 0) > BUDGET.max, `the backstop cut to ${env?.questions.length} — it must leave the ask-cap to applyBudget`);
    assert.ok((env?.questions.length ?? 0) < many.length, 'but it must still bound a runaway response');
    assert.equal(applyBudget(env as PlannerEnvelope).questions.length, BUDGET.max, 'applyBudget is the real gate');
  });

  test('the envelope names its planner and version, and carries metadata through', async () => {
    const env = await plan([{ field: 'warranty', label: 'Warranty', ui: 'ask', options: ['1 year', '2 years'], order: 0 }], { considered: [{ candidate: 'warranty' }] });
    assert.equal(env?.planner, 'commercial');
    assert.ok(env?.version, 'an unversioned envelope cannot be attributed to a prompt revision');
    assert.deepEqual(env?.metadata, { considered: [{ candidate: 'warranty' }] });
  });

  // Parse failure must be null, not a half-envelope: usePlannerController reads null as "auto-skip this
  // page". An empty-but-truthy envelope would render a blank Page 2 instead.
  test('an unparseable response yields null so the caller can auto-skip', async () => {
    say('I could not produce JSON for that.');
    assert.equal(await runCommercialPlanner(plannerArgs), null);
  });

  test('…and a fenced JSON code block is unwrapped, not treated as prose', async () => {
    say('```json\n{ "questions": [ { "field": "warranty", "label": "Warranty", "ui": "ask", "options": ["1 year","2 years"], "order": 0 } ], "metadata": {} }\n```');
    assert.deepEqual(fields(await runCommercialPlanner(plannerArgs)), ['warranty'], 'flash-lite fences its JSON; a literal JSON.parse would return null and skip the page');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · the two fences — AI-Debug must show the model EXACTLY production's data
// ═════════════════════════════════════════════════════════════════════════════
describe('fences — debug is production, line-numbered', () => {
  const BRAIN_REPLY = { brain: { understanding: 'u', persona_read: 'p', category_trustworthy: true }, page1: { questions: [], metadata: {} }, known_truths: [] };
  const brainInputs = {
    product: 'Kraft Paper Roll', quantity: '5 Tonne',
    alreadyFilled: { GSM: '120' },
    buyerSpecs: [{ name: 'GSM', options: ['100', '120', '140'] }, { name: 'Grade', options: ['A', 'B'] }],
    sellerSpecs: [{ q: 'Grade', pct: 78, vals: ['A', 'B'] }],
    csl: { viewed_products: [{ name: 'Kraft Paper 120 GSM', mcat: '4979' }] },
    rfq: [{ product: 'Kraft Paper', qty: '2 Tonne' }],
    profile: { city: 'Kanpur', is_gst_verified: 2 },
    whatsapp: [{ sender: 'user', text: 'need 120 gsm rolls' }],
    pns: { calls_analyzed: 2 },
  };
  const promptFor = async (exec: 'prod' | 'debug', inp: Record<string, unknown> = brainInputs) => {
    say(BRAIN_REPLY);
    await runRequirementBrain(inp, exec);
    return lastUserPrompt();
  };
  const tagsOf = (prompt: string) => [...prompt.matchAll(/^<([a-z_0-9]+)>$/gm)].map((m) => m[1]);
  const block = (prompt: string, tag: string) => {
    const m = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
    assert.ok(m, `no <${tag}> block in the prompt`);
    return m[1];
  };
  const deNumber = (body: string) => body.split('\n').map((l) => l.replace(/^L\d+ /, '')).join('\n');

  // (a) THE INVARIANT THIS PROJECT LOCKED: the mode split is VERBOSITY, never data. A debug session that
  // shows the model different inputs from production cannot debug production — every conclusion drawn in
  // the inspector is about a prompt the buyer never got.
  test('every fenced block carries byte-identical DATA in prod and debug', async () => {
    const prod = await promptFor('prod');
    const dbg = await promptFor('debug');
    const tags = tagsOf(prod);
    assert.ok(tags.length >= 8, `only ${tags.length} fenced blocks found — the extractor is broken, not the fences`);
    assert.deepEqual(tagsOf(dbg), tags, 'both modes must fence the same sources, in the same order');
    for (const tag of tags) {
      const p = block(prod, tag);
      const d = deNumber(block(dbg, tag));
      if (p === '(none)') { assert.equal(d, '(none)', `<${tag}> is absent in prod but present in debug`); continue; }
      assert.deepEqual(JSON.parse(d), JSON.parse(p), `<${tag}> shows the model different data in debug than in production`);
    }
  });

  test('debug prefixes EVERY line with Lnn, numbered from 1 — the citation anchors', async () => {
    const dbg = await promptFor('debug');
    for (const tag of tagsOf(dbg)) {
      const body = block(dbg, tag);
      if (body === '(none)') continue;
      const lines = body.split('\n');
      assert.deepEqual(lines.map((l, i) => /^L\d+ /.test(l) ? null : `line ${i + 1}: ${l}`).filter(Boolean), [],
        `<${tag}> has unnumbered lines — "<source>:Lnn" evidence can never be resolved back to them`);
      assert.deepEqual(lines.map((l) => Number(l.match(/^L(\d+) /)?.[1])), lines.map((_, i) => i + 1),
        `<${tag}> line numbers must be sequential from L1, or a cited line resolves to the wrong fact`);
    }
    assert.equal(/^L\d+ /m.test(await promptFor('prod')), false, 'production must never carry line numbers — they are debug-only tokens the buyer path pays for');
  });

  // Absent means absent. `{}` rendering as literal "{}" told the model an input existed while carrying
  // nothing, and lit the inspector's source chip as present-with-data on every fresh product.
  test('null, undefined, [] and {} all render (none) — in both modes', async () => {
    const empties = { product: 'Kraft Paper Roll', alreadyFilled: {}, buyerSpecs: [], sellerSpecs: [], csl: null, rfq: undefined, profile: {}, whatsapp: [], pns: null };
    for (const exec of ['prod', 'debug'] as const) {
      const prompt = await promptFor(exec, empties);
      for (const tag of ['already_filled', 'buyer_specs_schema', 'seller_specs', 'truth_csl', 'truth_rfq', 'truth_profile', 'truth_whatsapp', 'truth_pns']) {
        assert.equal(block(prompt, tag), '(none)', `<${tag}> is empty in ${exec} mode and must say so, not render a hollow container`);
      }
    }
  });

  // TRUNCATION PARITY. The cap must be applied to the COMPACT serialization in both modes. It was not:
  // each fence capped its own rendering, and because the numbered fence pretty-prints (several times the
  // characters for identical data) DEBUG HIT THE CAP FIRST — AI-Debug showed the model LESS data than
  // production, the exact inverse of the invariant above.
  test('an over-cap payload truncates at the SAME data boundary in both modes', async () => {
    const huge = { blob: 'x'.repeat(200_000) };
    const full = JSON.stringify(huge);
    const prod = block(await promptFor('prod', { ...brainInputs, csl: huge }), 'truth_csl');
    const dbg = block(await promptFor('debug', { ...brainInputs, csl: huge }), 'truth_csl');
    assert.match(prod, /…\[truncated \d+ chars — runaway backstop\]$/, 'a runaway payload must be cut with the backstop marker, not emitted whole');
    assert.ok(prod.length < full.length / 2, `the payload was not really truncated (${prod.length} of ${full.length} chars)`);
    assert.equal(dbg, `L1 ${prod}`, 'debug must be prod\'s truncated body with a line number on it — nothing more, nothing less');
    // Self-consistent, so it needs no copy of FENCE_CAP: kept + reported-dropped must equal the whole input.
    const kept = prod.indexOf('…[truncated');
    const dropped = Number(prod.match(/truncated (\d+) chars/)?.[1]);
    assert.equal(kept + dropped, full.length, `the marker under-reports the loss: kept ${kept} + dropped ${dropped} ≠ ${full.length}. The cap must be measured on the COMPACT serialization in both modes.`);
  });

  // A fenced input is raw upstream data (CSL / PNS / n8n). One circular ref or BigInt in it must not take
  // the whole brain call down — the buyer would get no Page 1 at all, for a payload we only wanted to show.
  test('an unserialisable payload degrades to a marker instead of throwing', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    for (const exec of ['prod', 'debug'] as const) {
      const body = deNumber(block(await promptFor(exec, { ...brainInputs, csl: circular }), 'truth_csl'));
      assert.equal(body, '(unserialisable input)', `<truth_csl> must degrade in ${exec} mode, not raise`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · detectLocationConflict — the spec-page location-prompt trigger (#1/#2)
// ═════════════════════════════════════════════════════════════════════════════
describe('detectLocationConflict — profile city vs browse/target/filter/pns', () => {
  const sig = (source: 'browse' | 'target' | 'filter' | 'pns', city: string) => ({ source, city });
  test('same city → no conflict', () => {
    assert.equal(detectLocationConflict('Ghaziabad', [sig('browse', 'Ghaziabad')]).conflict, false);
  });
  test('different district → conflict (253102197: profile Ghaziabad vs browse Imphal)', () => {
    const r = detectLocationConflict('Ghaziabad', [sig('browse', 'Imphal')]);
    assert.equal(r.conflict, true);
    assert.deepEqual(r.conflicting.map((c) => c.city), ['Imphal']);
  });
  test('metro cluster does NOT false-fire — Ghaziabad↔Delhi/Noida are one district', () => {
    assert.equal(detectLocationConflict('Ghaziabad', [sig('browse', 'Delhi'), sig('filter', 'Noida')]).conflict, false);
  });
  test('any signal source triggers (filter · pns · target)', () => {
    assert.equal(detectLocationConflict('Mumbai', [sig('filter', 'Chennai')]).conflict, true);
    assert.equal(detectLocationConflict('Mumbai', [sig('pns', 'Chennai')]).conflict, true);
    assert.equal(detectLocationConflict('Mumbai', [sig('target', 'Chennai')]).conflict, true);
  });
  test('blank profile or blank signal never triggers', () => {
    assert.equal(detectLocationConflict('', [sig('browse', 'Imphal')]).conflict, false);
    assert.equal(detectLocationConflict('Ghaziabad', [sig('browse', '')]).conflict, false);
  });
  test('multiple off-cities are de-duped', () => {
    const r = detectLocationConflict('Ghaziabad', [sig('browse', 'Imphal'), sig('target', 'Imphal'), sig('filter', 'Guwahati')]);
    assert.deepEqual(r.conflicting.map((c) => c.city).sort(), ['Guwahati', 'Imphal']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · buildRunTrace — the persona-debug aggregation keystone (5 atoms → RunTrace)
// ═════════════════════════════════════════════════════════════════════════════
describe('buildRunTrace — whole-run rollup over LLM records + raw I/O + source health', () => {
  // Three planner outputs: brain (page1-nested), commercial (flat), persona (flat).
  const raw = {
    'requirement-brain': {
      at: 1,
      output: JSON.stringify({
        brain: { understanding: 'x' },
        page1: {
          questions: [
            { ui: 'prefill', label: 'Quantity', value: '500' },
            { ui: 'ask', label: 'Shape', options: ['Round', 'Square'] },
          ],
          metadata: { reasoning: { Quantity: { evidence: ['rfq:L4 — qty 500 units'] } } },
        },
      }),
    },
    'commercial-planner': {
      at: 2,
      output: JSON.stringify({
        questions: [
          { ui: 'ask', label: 'Delivery timeline', options: ['Urgent', 'Flexible'] },
          { ui: 'prefill', label: 'Delivery city', value: 'Gadag' }, // NO evidence → invented
        ],
        metadata: { reasoning: { 'Delivery city': { evidence: [] } } },
      }),
    },
    'persona-planner': {
      at: 3,
      output: JSON.stringify({
        questions: [{ ui: 'confirm', label: 'Your role', value: 'Owner' }],
        metadata: { reasoning: { 'Your role': { evidence: ['profile:L1 — proprietor'] } } },
      }),
    },
  };
  const llm = [
    { label: 'requirement-brain', ok: true, ms: 1000, status: 200, bytes: 1, model: 'm', at: 1, costUsd: 0.001, parseOk: true },
    { label: 'commercial-planner', ok: true, ms: 2000, status: 200, bytes: 1, model: 'm', at: 2, costUsd: 0.002, parseOk: true },
    { label: 'persona-planner', ok: true, ms: 500, status: 200, bytes: 1, model: 'm', at: 3, costUsd: 0.001, parseOk: false },
  ];
  const sources = [
    { source: 'CSL', ok: true, ms: 100, at: 1, raw: {}, cleaned: {} },
    { source: 'PNS', ok: false, ms: 5000, at: 2, raw: null, cleaned: null },
  ];
  const t = buildRunTrace(llm, raw, sources);

  test('story counts prefill/confirm as knew, ask as asked, evidence-less prefill as invented', () => {
    assert.equal(t.story.knew, 3);   // Quantity + Delivery city + Your role
    assert.equal(t.story.asked, 2);  // Shape + Delivery timeline
    assert.equal(t.story.total, 5);
    assert.equal(t.story.invented, 1); // Delivery city has [] evidence
    assert.deepEqual(t.story.askedFields.sort(), ['Delivery timeline', 'Shape']);
  });
  test('TUS proxy = knew ÷ total; BES proxy = asks + chip-weight', () => {
    assert.equal(t.kpi.tusPct, 60);   // 3/5
    assert.equal(t.kpi.besProxy, 2);  // 2 asks + (2+2+... chips)*0.1 rounded
  });
  test('ops rolls cost/latency, counts parse failures, finds the slowest source', () => {
    assert.equal(Number(t.ops.totalCostUsd.toFixed(3)), 0.004);
    assert.equal(t.ops.llmCalls, 3);
    assert.equal(t.ops.llmMs, 3500);
    assert.equal(t.ops.parseFailures, 1);           // persona parseOk:false
    assert.equal(t.ops.sourcesEmpty, 1);            // PNS raw:null
    assert.equal(t.ops.slowestSource?.source, 'PNS');
  });
  test('exceptions surface parse failure + dead source + fabrication (3), contribution has a row per source', () => {
    assert.equal(t.exceptions.length, 3);
    assert.ok(t.exceptions.some((e) => e.includes('parse failure')));
    assert.ok(t.exceptions.some((e) => e.startsWith('PNS')));
    assert.ok(t.exceptions.some((e) => e.includes('fabrication')));
    assert.equal(t.contribution.length, 2);
  });
  test('gates: fabrications counts evidence-less prefills; no dedup leak when every asked concept is unique', () => {
    assert.equal(t.gates.fabrications, 1);
    assert.equal(t.gates.dedupViolations, 0);
  });
  test('dedup gate fires when the same concept is asked on two pages (the "same question again" regression)', () => {
    const dupRaw = {
      'commercial-planner': { at: 1, output: JSON.stringify({ questions: [{ ui: 'ask', label: 'Payment terms' }] }) },
      'persona-planner': { at: 2, output: JSON.stringify({ questions: [{ ui: 'ask', label: 'payment_terms' }] }) },
    };
    // injected canon collapses 'Payment terms' and 'payment_terms' to the same concept → 1 violation
    const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const d = buildRunTrace([], dupRaw, [], canon);
    assert.equal(d.gates.dedupViolations, 1);
    assert.ok(d.exceptions.some((e) => e.includes('dedup leak')));
  });
  test('empty telemetry degrades to zeros, never throws', () => {
    const z = buildRunTrace([], {}, []);
    assert.equal(z.story.total, 0);
    assert.equal(z.kpi.tusPct, 0);
    assert.equal(z.gates.dedupViolations, 0);
    assert.equal(z.exceptions.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 · bpod → seed mappers (STEP 0) — the profile-threading that lights up contact/company/location prefills
// ═════════════════════════════════════════════════════════════════════════════
describe('bpodToProfileNode / bpodToBuyerFacts — the bi-bpod fold (real 106815489 shape)', () => {
  // A trimmed but structurally-real bi-bpod record (Girish / Mildcare Texture / Gadag).
  const bpod = {
    source: 'buyer_profile', glid: '106815489',
    bp: {
      contacts_name: 'Girish Panchakshari Lakkundi', contacts_mobile1: '8088487765', contacts_email1: 'girishlakkundi7@gmail.com',
      contacts_company: 'Mildcare Texture', contact_city: 'Gadag', contact_state: 'Karnataka',
      gst: '29BKMPL3596F2ZK', is_gst_verified: '1', total_requirement: 156, buyer_past_requirement_count: '19',
      total_calls: '63', glusr_usr_membersince: '6 Years',
    },
    od: { GLUSR_GST_ANNUAL_TURNOVER: '0 - 40 L', GLUSR_GST_LEGAL_STATUS: 'Proprietorship', GLUSR_GST_NATURE_OF_BUSINESS: 'Manufacturer', GLUSR_GST_REGISTRATION_YEAR: '2025-07-24', GST: '29BKMPL3596F2ZK' },
    detail: { company_name: 'Mildcare Texture', city: 'Gadag', state: 'Karnataka', glusr_usr_custtype_name: 'qgFCPplus with PNS', ceo_fname: 'Girish', ceo_lname: 'Panchakshari Lakkundi' },
  };

  test('profile node carries the exact shape the seed extractors read', () => {
    const n = bpodToProfileNode(bpod) as Record<string, Record<string, unknown>>;
    assert.equal(n.identity.name, 'Girish Panchakshari Lakkundi');
    assert.equal(n.identity.mobile, '8088487765');
    assert.equal(n.identity.email, 'girishlakkundi7@gmail.com');
    assert.equal(n.identity.company, 'Mildcare Texture');           // ← the field we were dropping
    assert.equal(n.kyb.gst, '29BKMPL3596F2ZK');
    assert.equal(n.business.nature_of_business, 'Manufacturer');
    assert.equal(n.seller_context.custtype_name, 'qgFCPplus with PNS');
  });
  test('buyer_facts carries city/state + the bulk-gate signals', () => {
    const f = bpodToBuyerFacts(bpod) as Record<string, unknown>;
    assert.equal(f.city, 'Gadag');
    assert.equal(f.state, 'Karnataka');
    assert.equal(f.has_gst, true);
    assert.equal(f.gst_verified, true);
    assert.equal(f.total_requirements, 19);   // prefers REAL history (buyer_past_requirement_count) over the inflated total_requirement — the one-off-veto fix (deep-audit 2026-08-12)
    assert.equal(f.total_calls, 63);
    assert.equal(f.business_type, 'Manufacturer');
  });
  test('accepts the array-wrapped webhook shape and name-fallback', () => {
    const alt = [{ bp: { contact_city: 'Pune' }, detail: { ceo_fname: 'Asha', ceo_lname: 'Rao' } }];
    assert.equal((bpodToProfileNode(alt) as Record<string, Record<string, unknown>>).identity.name, 'Asha Rao');
    assert.equal((bpodToBuyerFacts(alt) as Record<string, unknown>).city, 'Pune');
  });
  test('an empty / null profile degrades to null, never throws', () => {
    assert.equal(bpodToProfileNode(null), null);
    assert.equal(bpodToProfileNode({ bp: {}, od: {}, detail: {} }), null);
    assert.equal(bpodToBuyerFacts(null), null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8b · assessBulkB2B — the one-off VETO firewall (deep-audit 2026-08-12). A FREE, new, buyer-only, low-history
// account must be vetoed so the persona layer cannot inflate it into a "wholesaler". Locks A1 (real-count precedence
// via bpodMap feeds a truthful count here) + A2 (the brand-new-account backstop) without over-vetoing real B2B.
// ═════════════════════════════════════════════════════════════════════════════
describe('assessBulkB2B — one-off veto firewall', () => {
  test('a 1-requirement FREE buyer-only account (no GST, no seller) is vetoed as one-off', () => {
    const g = assessBulkB2B({ total_requirements: 1, member_since: 'This Month', has_gst: false });
    assert.equal(g.is_bulk_b2b, false);
    assert.ok(g.vetoed_by, 'expected a veto reason for a one-off buyer');
    assert.match(String(g.vetoed_by), /one-off/i);
  });
  test('BACKSTOP: a brand-new account with NO signal + no GST/seller is vetoed even when the count is absent', () => {
    const g = assessBulkB2B({ member_since: 'This Month', has_gst: false }); // no total_requirements at all
    assert.equal(g.is_bulk_b2b, false);
    assert.match(String(g.vetoed_by), /brand-new/i);
  });
  test('an established B2B buyer (GST + turnover + incorporated + 20 requirements) is NOT vetoed and reads bulk', () => {
    const g = assessBulkB2B({ has_gst: true, turnover: '5 Cr', legal_status: 'Private Limited', total_requirements: 20, member_since: '6 Years' });
    assert.equal(g.vetoed_by, undefined);
    assert.equal(g.is_bulk_b2b, true);
    assert.ok(g.score >= 3);
  });
  test('an ABSENT profile stays NEUTRAL (no veto, not bulk) — never silences page 3 for everyone', () => {
    const g = assessBulkB2B({});
    assert.equal(g.vetoed_by, undefined);   // the 2026-08-10 guard: absent counters must not veto
    assert.equal(g.is_bulk_b2b, false);
  });
  test('#13: a large order_value ALONE is not a bulk signal — a consumer basket reaches Rs 1-2 Lakh', () => {
    const g = assessBulkB2B({ order_value: 'Rs. 1 to 2 Lakh' });   // 200000, but no other business signal
    assert.equal(g.score, 0);
    assert.equal(g.met.some((m) => /order is worth/i.test(m)), false);
    assert.equal(g.is_bulk_b2b, false);
  });
  test('#13: order_value CORROBORATES once a genuine business signal is already present', () => {
    const g = assessBulkB2B({ has_gst: true, turnover: '5 Cr', legal_status: 'Private Limited', order_value: 'Rs. 3 Lakh', total_requirements: 20 });
    assert.equal(g.met.some((m) => /order is worth/i.test(m)), true);   // now it counts as a corroborator
    assert.equal(g.is_bulk_b2b, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8c · reconcilePostedRequirement — Theme-B #5 posted-requirement category reconciliation (deep-audit 2026-08-12).
// The buyer's own posted RFQ requirement carries a category_id; when the committed name matches it but resolved to a
// DIFFERENT mcat, his posted category is authoritative → swap (CSL stays primary). Divergence is recorded either way.
// ═════════════════════════════════════════════════════════════════════════════
describe('reconcilePostedRequirement — posted-requirement category reconciliation', () => {
  const reqs = [{ product: 'Cotton Pant Style Diaper', mcat: '55663', specs: [{ name: 'Material', value: 'Cotton' }] }];
  test('name-matched requirement with a different mcat + specs → SWAPS to the posted mcat', () => {
    const r = reconcilePostedRequirement('Cotton Pant Style Diaper', '205235', false, reqs);
    assert.equal(r.swapped, true);
    assert.equal(r.id, '55663');
    assert.equal(r.authority, 'posted-requirement');
    assert.deepEqual(r.divergence, { rfq_mcat: '55663', rfq_product: 'Cotton Pant Style Diaper' });
  });
  test('CSL already re-anchored → RECORD the divergence but do NOT swap (CSL is primary)', () => {
    const r = reconcilePostedRequirement('Cotton Pant Style Diaper', '205235', true, reqs);
    assert.equal(r.swapped, false);
    assert.equal(r.id, '205235');
    assert.ok(r.divergence);   // still surfaced to the inspector
  });
  test('a posted requirement with NO specs never swaps (never trade a resolved category for an empty one)', () => {
    const r = reconcilePostedRequirement('Cotton Pant Style Diaper', '205235', false, [{ product: 'Cotton Pant Style Diaper', mcat: '55663', specs: [] }]);
    assert.equal(r.swapped, false);
    assert.ok(r.divergence);   // divergence is still recorded
  });
  test('SEMANTIC mismatch (different product string, same need) is NOT name-matchable → left to LLM-1 (no swap, no divergence)', () => {
    const r = reconcilePostedRequirement('Mamy Poko Pants Diaper', '205235', false, reqs);
    assert.equal(r.swapped, false);
    assert.equal(r.id, '205235');
    assert.equal(r.divergence, null);
  });
  test('a name-match on the SAME mcat is a no-op (no swap, no divergence)', () => {
    const r = reconcilePostedRequirement('Cotton Pant Style Diaper', '55663', false, reqs);
    assert.equal(r.swapped, false);
    assert.equal(r.divergence, null);
  });
  test('strong containment matches; empty requirement list is safe', () => {
    const r = reconcilePostedRequirement('Cotton Pant Style Diaper S', '205235', false, reqs); // committed ⊃ posted
    assert.equal(r.swapped, true);
    assert.equal(r.id, '55663');
    assert.equal(reconcilePostedRequirement('anything', '999', false, []).swapped, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9 · buildSession — carry-forward: page-2/3 answers (incl. untouched prefills seeded into the maps) reach the
//     session that feeds the NEXT LLM and the submission. This is the guarantee the touchedFields fix protects.
// ═════════════════════════════════════════════════════════════════════════════
describe('buildSession — page-2/3 answers carry into the session (next-LLM input + submission)', () => {
  test('cxAnswers → page2, psAnswers → page3, all page-1 spec sources merge into page1', () => {
    const s = buildSession({
      product: 'HDPE Jar', quantity: '1000', mcatId: '186822',
      extraSpecs: { Color: 'White' }, specValues: { Capacity: '250 g' }, aiSpecValues: { Application: 'Food Packaging' },
      cxAnswers: { delivery_timeline: 'Within 1 week', payment_terms: 'Advance' },   // an untouched prefill lands here via the seed effect
      psAnswers: { designation: 'Owner' },
    });
    assert.equal(s.page2.delivery_timeline, 'Within 1 week');   // → LLM 3 sees it, and it ships
    assert.equal(s.page2.payment_terms, 'Advance');
    assert.equal(s.page3.designation, 'Owner');
    assert.deepEqual(s.page1, { Color: 'White', Capacity: '250 g', Application: 'Food Packaging' });
    assert.equal(s.product, 'HDPE Jar');
    assert.equal(s.quantity, '1000');
  });
  test('empty answer maps → empty page2/page3, never throws', () => {
    const s = buildSession({ product: 'X', extraSpecs: {}, specValues: {}, aiSpecValues: {}, cxAnswers: {}, psAnswers: {} });
    assert.deepEqual(s.page2, {});
    assert.deepEqual(s.page3, {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10 · parseEnquiries — TYPE-E extraction (real 268590579 shape): products+sellers, PII-masked, deduped
// ═════════════════════════════════════════════════════════════════════════════
describe('parseEnquiries — the buyer\'s outbound seller enquiries (highest-intent signal)', () => {
  const NOW = Date.UTC(2026, 4, 25);   // 2026-05-25, injected so recency is deterministic
  const listing = [
    // a B record (posted buylead) — must be EXCLUDED
    { TYPE: 'B', ETO_OFR_TITLE: 'Notebook Making Machines', STATUS: 'Expired' },
    { TYPE: 'E', DIR_QUERY_MODREF_NAME: 'Chota Hathi Loader', R_ORGANIZATION: 'India Cargo Movers', QUERY_RCV_GLUSR_USR_ID: '89920803', R_EMAIL: 'indiacargo1970@gmail.com', SENDEREMAIL: 'jayveernayak75@gmail.com', STATUS: 'Approved', OFR_DATE: '20260520124432', MESSAGE: 'I am interested in Chota Hathi Loader' },
    { TYPE: 'E', DIR_QUERY_MODREF_NAME: 'Edge Squaring Machine', R_ORGANIZATION: 'Glorious Machinery', QUERY_RCV_GLUSR_USR_ID: '244888506', R_EMAIL: 'x@y.com', STATUS: 'Approved', OFR_DATE: '20260519123841' },
    // two enquiries for the SAME product → dedup to one (most recent 05-18 09:00 wins over 05-18 08:00? both same day)
    { TYPE: 'E', DIR_QUERY_MODREF_NAME: 'Used Paper Cutting Machine', R_ORGANIZATION: 'Kashi Industries', QUERY_RCV_GLUSR_USR_ID: '182205228', STATUS: 'Rejected', OFR_DATE: '20260518105459' },
    { TYPE: 'E', DIR_QUERY_MODREF_NAME: 'Used Paper Cutting Machine', R_ORGANIZATION: 'Kashi Industries', QUERY_RCV_GLUSR_USR_ID: '182205228', STATUS: 'Approved', OFR_DATE: '20260518105433' },
  ];
  const out = parseEnquiries(listing, NOW);

  test('extracts only TYPE-E, deduped by product (B excluded, dup collapsed)', () => {
    assert.equal(out.length, 3);   // Chota Hathi, Edge Squaring, Used Paper Cutting (deduped) — NOT the B record
    assert.deepEqual(out.map((e) => e.product).sort(), ['Chota Hathi Loader', 'Edge Squaring Machine', 'Used Paper Cutting Machine']);
  });
  test('carries product + seller org + seller glid + status + recency', () => {
    const chota = out.find((e) => e.product === 'Chota Hathi Loader')!;
    assert.equal(chota.seller_org, 'India Cargo Movers');
    assert.equal(chota.seller_glid, '89920803');
    assert.equal(chota.status, 'Approved');
    assert.equal(chota.recency_days, 5);   // 05-20 → 05-25
  });
  test('NEVER emits seller/buyer email (PII masked)', () => {
    const json = JSON.stringify(out);
    assert.equal(/indiacargo1970|jayveernayak75|@gmail|@y\.com/.test(json), false);
    // the Enquiry shape has no email field at all
    assert.equal('seller_email' in out[0] || 'email' in out[0], false);
  });
  test('empty / non-array listing → [] (no throw); parseUserDetail lifts buyer city/state', () => {
    assert.deepEqual(parseEnquiries(null, NOW), []);
    assert.deepEqual(parseEnquiries({}, NOW), []);
    assert.deepEqual(parseUserDetail({ GLUSR_CITY: 'Auraiya', GLUSR_STATE: 'Uttar Pradesh' }), { city: 'Auraiya', state: 'Uttar Pradesh' });
  });
});

describe('#5 no cross-page question leakage', () => {
  const mod = pcMod as { canonConcept: (s: string) => string; conceptSet: (a: string[]) => Set<string> };
  test('cross-page synonyms canonicalize to ONE concept (so the merge layer drops the repeat)', () => {
    const pairs: [string, string][] = [
      ['business_setup_type', 'setup_stage'],   // commercial ↔ persona lifecycle question (the audited duplicate)
      ['Delivery Timeline', 'When do you need it'],
      ['Payment Terms', 'How will you pay'],
      ['Application', 'What is this for'],       // a page-1 Application spec == the page-2 intent question
      ['Preferred Supplier', 'Supplier Type'],
    ];
    for (const [a, b] of pairs) assert.equal(mod.canonConcept(a), mod.canonConcept(b), `${a} ≡ ${b}`);
  });
  test('distinct concepts do NOT collide (no over-dedup)', () => {
    assert.notEqual(mod.canonConcept('machine_setup_configuration'), mod.canonConcept('setup_stage'));
    assert.notEqual(mod.canonConcept('Delivery Timeline'), mod.canonConcept('Payment Terms'));
    assert.notEqual(mod.canonConcept('Your designation'), mod.canonConcept('Delivery Timeline'));
  });
  test('a persona question matching a commercial concept is seen as already-covered', () => {
    const commercial = mod.conceptSet(['Delivery Timeline', 'Payment Terms', 'Supplier Type']);
    assert.equal(commercial.has(mod.canonConcept('When do you need delivery')), true);  // dedup'd
    assert.equal(commercial.has(mod.canonConcept('Your designation')), false);          // genuinely new → kept
  });
});
