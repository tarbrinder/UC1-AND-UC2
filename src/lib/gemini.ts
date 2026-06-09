// IndiaMART LLM gateway — OpenAI-compatible API
// Proxied through Vite dev server to avoid CORS (/api/llm → imllm.intermesh.net/v1)

import { api } from './api';
import type { DynQuestion, Segment, RequirementPlan, PlanQuestion } from './questions/types';
import type { SeedQuestion } from './questions/seed';
import type { BuyerProfile, BuyerTwin, InferredTrait, TwinSignal, TwinSource } from './enrichment';

const LLM_KEY = import.meta.env.VITE_LLM_KEY as string;
const ENDPOINT = api('/api/llm/chat/completions');

// Two-tier model strategy. Most calls are short, structured, low-reasoning text
// tasks (hints, "Not sure?", requirement summary, question generation) → the
// faster/cheaper "lite" model keeps the UI snappy for impatient mobile buyers.
// Multimodal extraction (image, audio) keeps the richer model, where lite
// measurably degrades quality.
const MODEL_FAST = 'google/gemini-2.5-flash-lite';
const MODEL_RICH = 'google/gemini-2.5-flash';

// ── India B2B context (injected into EVERY prompt) ────────────────────
// IndiaMART is an India-only B2B marketplace. Every model output — options,
// examples, money, personas, guidance — must be in Indian context. We prepend
// this verbatim to each prompt so no call can drift to $/USD or foreign norms.
// (The visible offender was budget chips coming back as "$5,000".)
const INDIA_CTX =
  'CONTEXT — INDIA B2B ONLY. This is IndiaMART, an India business-to-business marketplace. EVERYTHING you output must be in Indian context. MONEY/BUDGET/PRICE: ALWAYS Indian Rupees with the ₹ symbol and Indian numbering — use bands like "Under ₹50,000", "₹50,000–₹2 lakh", "₹2–10 lakh", "₹10 lakh+", "₹1 crore+". Use lakh/crore, NEVER million/billion, NEVER $/USD/"dollar". Places = Indian cities/states; standards = BIS/ISI/IS; norms = GST, Indian trade terms. Never use foreign currencies, units, places, or examples.';

export const hasGeminiKey = () => Boolean(LLM_KEY?.trim());

// Belt-and-suspenders: if a model still emits a "$"/USD token in any buyer-facing
// string, swap the symbol to ₹ (amounts are nominal bands, not FX conversions).
export const indiaize = (s: string): string =>
  s
    .replace(/\bUSD\b/gi, '₹')
    .replace(/\bdollars?\b/gi, 'rupees')
    .replace(/\$\s?/g, '₹');

interface LLMOpts {
  jsonMode?: boolean;
  model?: string;
  maxTokens?: number;
  temperature?: number; // F1/F2: low temp on CLASSIFICATION calls (archetype, twin) → consistent labels across runs
  label?: string; // A4: which logical call this is (e.g. 'deriveIntent') — for the LLM Call Health ring
}

// ── A4 (G12): per-call LLM health ring — answers "did each LLM call fire, succeed, how long". ──
// Network-level outcome (ok/status/ms/bytes) captured at the single chokepoint. Parse-level
// success (returned null/{}) shows downstream as the caller's fallback; this ring proves the
// CALL itself. Mirrored to window.__llmHealth for the debug panel + console introspection.
export interface LLMCallRecord { label: string; ok: boolean; ms: number; status: number; bytes: number; model: string; at: number; }
const LLM_HEALTH: LLMCallRecord[] = [];
function recordLLM(rec: LLMCallRecord): void {
  LLM_HEALTH.push(rec);
  if (LLM_HEALTH.length > 80) LLM_HEALTH.shift();
  try { (globalThis as unknown as { __llmHealth?: LLMCallRecord[] }).__llmHealth = LLM_HEALTH; } catch { /* noop */ }
}
export const getLLMHealth = (): LLMCallRecord[] => LLM_HEALTH.slice();

async function callLLM(messages: object[], opts: LLMOpts = {}): Promise<string> {
  const { jsonMode = true, model = MODEL_FAST, maxTokens = 1024, temperature, label = 'llm' } = opts;
  const t0 = Date.now();
  let status = 0;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        max_tokens: maxTokens,
      }),
    });
    status = res.status;
    if (!res.ok) {
      const body = await res.text();
      recordLLM({ label, ok: false, ms: Date.now() - t0, status, bytes: 0, model, at: Date.now() });
      throw new Error(`LLM error: ${res.status} ${body}`);
    }
    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content ?? '{}') as string;
    recordLLM({ label, ok: true, ms: Date.now() - t0, status, bytes: content.length, model, at: Date.now() });
    return content;
  } catch (e) {
    if (!status) recordLLM({ label, ok: false, ms: Date.now() - t0, status: 0, bytes: 0, model, at: Date.now() });
    throw e;
  }
}

// ── Voice transcription + spec extraction ────────────────────────────
export async function voiceToSpecs(
  audioBase64: string,
  mimeType: string,
  productName: string,
  isqSpecNames: string[]
): Promise<{
  rawTranscript: string;
  productName: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  deliveryLocation: string | null;
  deliveryTimeline: string | null;
  paymentTerms: string | null;
  creditPeriod: string | null;
  mappedSpecs: Record<string, string>;
  customSpecs: Array<{ fieldName: string; value: string }>;
}> {
  const specList = isqSpecNames.length
    ? `Known spec fields for ${productName || 'this product'}: ${isqSpecNames.join(', ')}`
    : '';

  // Derive the true container format from the recorder's mime type
  // (e.g. "audio/webm;codecs=opus" -> "webm"). Sending the wrong format
  // (we used to hardcode "wav") makes Gemini return an empty transcript.
  const format = (mimeType.split(';')[0].split('/')[1] || 'webm').toLowerCase();

  const text = await callLLM([
    {
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: audioBase64, format } },
        {
          type: 'text',
          text: `${INDIA_CTX}
Transcribe this audio and extract B2B procurement details.
${specList}

Return ONLY valid JSON:
{
  "rawTranscript": "exact transcription",
  "productName": "product name or null",
  "quantity": "number as string or null",
  "quantityUnit": "unit like Pieces/KG/MT/Litre or null",
  "deliveryLocation": "delivery city (handle Hindi/Hinglish: 'मुंबई' / 'Mumbai mein kar do' → Mumbai) or null",
  "deliveryTimeline": "map to EXACTLY one of: Immediate, Within 15 Days, 1 Month, Flexible ('10 days' / '10 दिन के अंदर' / '2 weeks' → Within 15 Days; 'turant' / 'urgent' → Immediate; 'mahine bhar' → 1 Month) — or null",
  "paymentTerms": "map to EXACTLY one of: Full Advance, Credit (Post-Delivery), COD, Loan/Finance ('credit' / 'udhaar' / 'क्रेडिट पे' → Credit (Post-Delivery); 'advance' → Full Advance; 'COD' / 'delivery pe payment' → COD) — or null",
  "creditPeriod": "ONLY when payment is credit, map to EXACTLY one of: 15 Days, 30 Days, 45 Days, 60 Days, 90 Days ('45 days' / '45 din' → 45 Days) — else null",
  "mappedSpecs": { "SpecFieldName": "value" },
  "customSpecs": [{ "fieldName": "name", "value": "value" }]
}
The audio may be in Hindi, English or Hinglish — transcribe faithfully, then extract. mappedSpecs keys must exactly match known spec fields. customSpecs is for anything else. Map deliveryTimeline/paymentTerms/creditPeriod to the EXACT option strings above (so the form can pre-select them).`,
        },
      ],
    },
  ], { model: MODEL_RICH, maxTokens: 2048, label: 'voiceToSpecs' });
  return JSON.parse(text);
}

// ── Image analysis ────────────────────────────────────────────────────
export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  currentProduct: string,
  isqFieldNames: string[],
  isqFieldOptions: Record<string, string[]>,
  application = ''
): Promise<{
  productName: string;
  specifications: Record<string, string>;
  additionalSpecifications: Record<string, string>;
  quantity: string | null;
  additionalDetails: string;
}> {
  const hasFields = isqFieldNames.length > 0;
  const useCase = application.trim()
    ? `\nBuyer's use-case (use this together with the image): "${application.trim()}"`
    : '';
  const prompt = hasFields
    ? `${INDIA_CTX}
Analyze this product image for B2B procurement.
Product context: ${currentProduct || 'unknown'}${useCase}
Spec fields to fill: ${JSON.stringify(isqFieldNames)}
Available options: ${JSON.stringify(isqFieldOptions)}

Use BOTH the image and the use-case (if given). Only fill fields you have signal for.
Prefer an EXACT option string. If the image/use-case clearly shows a specific value
for a listed field that isn't among its options, return that exact value (saved as a
custom "Other" entry). Put attributes that don't match any listed field in
"additionalSpecifications", not in "specifications".

Return JSON:
{
  "productName": "identified product",
  "specifications": { "FieldName": "an exact option, or a clearly-shown custom value" },
  "additionalSpecifications": { "AttributeNotInFields": "value" },
  "quantity": null,
  "additionalDetails": "other visible details"
}`
    : `${INDIA_CTX}
Identify this B2B product and its key specs.${useCase} Return JSON:
{
  "productName": "product name",
  "specifications": { "spec": "value" },
  "additionalSpecifications": {},
  "quantity": null,
  "additionalDetails": ""
}`;

  const text = await callLLM([
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    },
  ], { model: MODEL_RICH, maxTokens: 1024, label: 'analyzeImage' });
  return JSON.parse(text);
}

// ── Cold-mode: generate the non-spec questions to ask, by segment ─────
// Given the product + segment + what's already chosen, decide which seed
// questions are relevant, drop the rest, tailor options to THIS product, add
// category-specific ones, and assign each a slot. No enrichment needed.
const RENDER_SLOTS = ['specs', 'requirement', 'persona'];
const ALLOWED_BUCKETS = ['requirement', 'persona', 'business'];

// Cross-category de-dup backstop. Every generated question must be buyer CONTEXT
// or PERSONA — never a product-configuration attribute (that's a spec). Two layers:
//   (A) DYNAMIC — block any ≥4-char token taken from THIS category's live ISQ
//       field names + option labels (category-agnostic; the real workhorse).
//   (B) UNIVERSAL SYNONYMS — a tiny map of cross-category PROCUREMENT concepts
//       (usage, brand, colour, size, warranty, material…) so a synonym the model
//       reaches for ("purpose" when a "Usage/Application" spec exists) still dedups.
// Phase 4c (DE-HARDCODE): the old domain-specific families — kVA, diesel, petrol,
// radiator, ATS/AMF, phase, voltage, noise/silent, cooling — were GENSET
// ASSUMPTIONS: great for one category, dead weight (uneven quality) for every
// other. They are GONE. Only category-AGNOSTIC procurement concepts remain — the
// same durable abstraction as the Objective-vs-Preference gate. DO NOT re-add
// category-specific words here; that recreates the "works for genset, blind for
// saree" bias. Domain-specific synonymy is the LLM's job, not a hardcoded table.
const UNIVERSAL_SPEC_SYNONYMS: string[][] = [
  ['usage', 'use', 'uses', 'used', 'application', 'applications', 'purpose', 'purposes', 'enduse'],
  ['warranty', 'guarantee', 'warrantee'],
  ['material', 'grade', 'composition'],
  ['brand', 'make', 'manufacturer', 'oem'],
  ['capacity', 'output'],
  ['color', 'colour', 'finish', 'shade'],
  ['size', 'dimension', 'dimensions', 'diameter'],
];
const GENERIC_SPEC_WORDS = new Set([
  'type', 'rated', 'preferred', 'required', 'your', 'please', 'specify', 'what',
  'which', 'have', 'with', 'this', 'that', 'from', 'into', 'about', 'start', 'other',
]);
const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function blockedSpecTopicTokens(specsWithOptions: Record<string, string[]>): Set<string> {
  const blocked = new Set<string>();
  const ingest = (text: string) => {
    const ws = tokenize(text);
    for (const w of ws) if (w.length >= 4 && !GENERIC_SPEC_WORDS.has(w)) blocked.add(w);
    for (const group of UNIVERSAL_SPEC_SYNONYMS) {
      if (group.some((g) => ws.includes(g))) group.forEach((g) => blocked.add(g));
    }
  };
  for (const [name, opts] of Object.entries(specsWithOptions)) {
    ingest(name);
    (opts || []).forEach(ingest);
  }
  return blocked;
}

const reAsksSpec = (q: { label: string; options?: string[] }, blocked: Set<string>) =>
  [q.label, ...(q.options || [])].some((f) => tokenize(f).some((w) => blocked.has(w)));

// Fields the form ALREADY collects as dedicated inputs (product page / last step).
// A generated question that re-asks any of these is a duplicate and is dropped —
// e.g. the "Approximate quantity required" card that leaked when quantity is its
// own field. Belt to the prompt rule (the model still occasionally re-asks qty).
// Each alternative carries its OWN anchoring: stems (\bquantit, \bdeliver) take a
// LEADING \b only — a trailing \b would fail "quantity" (t→y is no boundary, the
// bug that leaked qty cards); whole words (city/state/region) take \b…\b so we
// don't block "stateful". Covers EVERY dedicated form field, including the ones
// that are hidden (delivery location lives behind a pill) and the synonyms the
// model uses to dodge keywords ("which state installed", "how soon", "advance").
const FORM_COVERED_RE =
  /(\bquantit|\bqty\b|how many|order\s*size|order\s*quantit|pieces?\s*required|number of (pieces|units)|\bdeliver|\btimeline\b|lead\s*time|how soon|\burgen|by when|when do you (need|require|want)|\bpayment|advance payment|credit\s*(term|period)|\bgst\b|pin\s?code|postal|\bcity\b|\bstate\b|\bregion\b)/i;
const asksCoveredField = (label: string) => FORM_COVERED_RE.test(label || '');
// Chips-only rule: every surfaced question must offer ≥2 real option chips (the
// UI appends an "Other…" chip). Zero/one option ⇒ it would render a bare text box,
// which the buyer abandons — so we drop it rather than show free text.
const hasChips = (q: { options?: string[] }) => (q.options?.length ?? 0) >= 2;

export async function generateEnrichmentQuestions(args: {
  productName: string;
  segment: Segment;
  quantity?: string;
  unit?: string;
  specsChosen: Record<string, string>;
  isqSpecNames: string[]; // real spec fields the buyer is filling
  isqSpecsWithOptions: Record<string, string[]>; // spec field -> its options (for de-dup)
  coveredElsewhere: string[]; // fields asked elsewhere on the form (never duplicate)
  seed: SeedQuestion[];
  maxQuestions: number;
  askPersona: boolean;
  askBusiness: boolean;
}): Promise<DynQuestion[]> {
  const specsText = Object.entries(args.specsChosen)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  const prompt = `${INDIA_CTX}
You are designing the non-spec questions for a B2B procurement RFQ on IndiaMART.
Product: "${args.productName}"
Buyer segment: ${args.segment}
Quantity: ${args.quantity || '?'} ${args.unit || ''}
Specs already chosen: ${specsText || 'none'}
Spec fields ALREADY on the spec page, WITH their options — these are SPECS. Never ask a question whose answer is one of these fields, one of their options, or implied by them: ${JSON.stringify(args.isqSpecsWithOptions)}
Fields the form already collects on the last step (NEVER ask these or any synonym): ${JSON.stringify(args.coveredElsewhere)}

Candidate seed questions to consider: ${JSON.stringify(
    args.seed.map((s) => ({ label: s.label, options: s.options, bucket: s.bucket }))
  )}

Rules:
- Keep only questions relevant to THIS product & segment; DROP the rest.
- Skip anything already implied by the chosen specs or covered by the spec fields.
- TOPIC-OVERLAP GUARD: never put a question on the final step ("requirement"/"persona") whose topic is ALREADY one of the spec fields above. E.g. if a spec field like "Usage"/"Application" exists, do NOT add an "intended usage/application" question; if "Warranty" is a spec, don't ask warranty; if "Material" is a spec, don't ask material. When the topic is already a spec field, either anchor a genuinely COMPLEMENTARY "specs" question to it, or drop it entirely.
- The form ALREADY asks these elsewhere — do NOT ask them or any rephrasing/synonym of them: delivery timeline / when they need it / how soon / purchase timing, payment terms or mode, preferred supplier type, delivery city/location, company size, GST, purchase frequency, industry. Focus on OTHER intent/usage/quality/persona signals.
- TAILOR options to this product (e.g., "Usage" for a generator → Factory backup / Hospital / Site, not Home/Business). CHIPS ONLY: every question MUST have 3-5 specific option chips — NEVER free-text/empty options (the form adds an "Other…" chip). NEVER ask quantity/order-size, delivery, timeline, or payment — those are dedicated form fields.
- You MAY add category-specific questions beyond the seed if they reveal buyer intent/seriousness.
- ${args.askPersona ? 'Persona questions allowed.' : 'Do NOT ask persona questions.'}
- ${args.askBusiness ? 'Business-profile questions allowed.' : 'Do NOT ask business-profile/company questions.'}
- For "retail" segment, ask the bare minimum (timeline/quality at most).
- NEVER ask for phone, email, or personal contact.
- Return at most ${args.maxQuestions} questions, ranked by value to a supplier judging buyer seriousness.
- HARD RULE — each question MUST be exactly ONE of these, else DROP it:
  (a) BUYER CONTEXT — how/where/why they'll use it, scale & cadence, site conditions, buying stage, quality bar. NOT a product attribute.
  (b) PERSONA — who the buyer is: decision style, budget band, after-sales expectation.
- NEVER ask a PRODUCT-CONFIGURATION ATTRIBUTE — that IS a spec, not a question. Banned (not exhaustive): noise/silent level, ATS/auto-start/AMF, voltage or voltage-stability, cooling, phase, fuel, material/grade, dimensions/size, colour/finish, brand. If the spec list lacks one, the buyer adds it as "Other" on the spec — do NOT invent a question for it.
- Assign a "slot": "specs" = a BUYER-CONTEXT question (shown in a details panel beside the specs); "requirement"/"persona" = shown on the final step (use "persona" for who-the-buyer-is). GOOD context examples: "expected backup duration?", "indoor or outdoor install?", "new site or replacement?". Keep the final step short — put context in "specs", buyer-profile in "persona".

- Every question MUST include "reason": a ≤12-word note on why it helps the seller judge/serve this buyer (used for auditing).

Return ONLY JSON:
{ "questions": [ { "id": "kebab-case-id", "label": "...", "options": ["..."], "multi": false, "slot": "requirement", "afterSpec": "", "bucket": "requirement", "reason": "why this helps the seller", "optional": true } ] }`;

  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { maxTokens: 1500, label: 'generateEnrichmentQuestions' });
    const parsed = JSON.parse(text);
    const list: DynQuestion[] = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const blocked = blockedSpecTopicTokens(args.isqSpecsWithOptions);
    // Validate + normalise.
    return list
      .filter((q) => q && q.label && q.slot !== 'skip')
      .map((q, i) => ({
        id: q.id || `q-${i}-${q.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
        label: indiaize(q.label.trim()),
        options: Array.isArray(q.options) ? q.options.map((o) => indiaize(String(o).trim())).filter(Boolean) : [],
        multi: !!q.multi,
        // We render exactly three slots; anything else (product/postsubmit/etc.)
        // folds into the final-step "requirement" bucket so nothing is lost.
        slot: (RENDER_SLOTS.includes(q.slot as string) ? q.slot : 'requirement') as DynQuestion['slot'],
        afterSpec:
          q.slot === 'specs' && typeof q.afterSpec === 'string' && q.afterSpec.trim()
            ? q.afterSpec.trim()
            : undefined,
        bucket: ALLOWED_BUCKETS.includes(q.bucket as string) ? q.bucket : 'requirement',
        optional: q.optional !== false,
        reason: typeof q.reason === 'string' ? q.reason.trim() : '',
        source: 'llm' as const,
      }))
      // Hard backstops: drop free-text (chips-only), re-asked specs, and any
      // question that duplicates a dedicated form field (quantity/delivery/etc.).
      .filter((q) => hasChips(q) && !asksCoveredField(q.label) && !reAsksSpec(q, blocked))
      .slice(0, args.maxQuestions);
  } catch {
    return [];
  }
}

// ── Intent Planner: read the category's selling intent, decide the RFQ shape ──
// One pass at product-commit. Returns a RequirementPlan that (eventually) drives
// order, spec triage, and question placement. ISQs are REFERENCE, not the goal.
const PLAN_KINDS = ['spec', 'context', 'persona', 'identity', 'logistics'];
const PLAN_PLACEMENTS = ['page1', 'specpage', 'wizard', 'laststep'];
const PLAN_ARCHETYPES = [
  'commodity', 'branded_commodity', 'capital', 'made_to_spec', 'project_service', 'visual_odd_part', 'unknown',
];

// ─── A6: Intent-First — ONE call that asks WHY before any spec ────────────────
// Single flash-lite call (journey classification folded in — NOT a separate pass).
// Adapts the question + chips to the buyer's journey, inferred from product + qty +
// who's-buying + high-confidence Twin truths only. Output seeds the single planner call.
export async function deriveIntent(args: {
  productName: string;
  quantity?: string;
  unit?: string;
  buyerKind?: 'business' | 'personal';
  twinTruths?: string; // HIGH-confidence facts only, PII-free + brand-free
}): Promise<{ journey: string; question: string; chips: string[]; derivedIntent: string; confidence: number } | null> {
  const prompt = `${INDIA_CTX}
A buyer is starting an RFQ. BEFORE any product spec, ask ONE question that reveals WHY they need this — the single most decisive purpose/end-use driver. Adapt the question AND chips to the buyer's JOURNEY, inferred from the product, quantity and who's buying.
Product: "${args.productName}"
Quantity: ${args.quantity?.trim() ? `${args.quantity} ${args.unit || ''}`.trim() : 'not specified yet'}
Who's buying: ${args.buyerKind || 'unknown'}
${args.twinTruths ? `Known about this buyer (high-confidence — use to pre-judge journey + a derived guess): ${args.twinTruths}` : ''}
RULES:
- ONE question. PLAIN simple English, ≤12 words, no preamble, no jargon, warm and human.
- 3-5 SPECIFIC, mutually-exclusive chips tailored to THIS product + journey (the form adds "Other…").
- QUANTITY-AWARE: if the quantity is a SINGLE or very small number of discrete units (e.g. "1 Piece"), this is almost never bulk resale/wholesale — it's likely the buyer's OWN use, a sample, a trial, or a small need. Fit the chips to THAT reality; do NOT offer only wholesale/distribution options when the quantity is 1. (A single MACHINE/equipment unit is the exception — that's a real capital buy, not retail.)
- It MUST capture end-use / purpose — NOT a spec, NOT quantity / location / budget / timeline / payment.
- "journey": EXACTLY one of: retail | resale | industrial | project | maintenance | personal | unknown.
- DERIVE, don't ask, when the purpose is ALREADY clear: if the PRODUCT NAME itself states the end-use (e.g. "tyre polish for car wash", "school bags for resale") OR the buyer's known truths make it unambiguous (e.g. they only ever buy this for resale), set "derivedIntent" to that purpose with "confidence" 85-95 — the form will show it as a one-tap CONFIRMATION, not a question. If the truths merely hint, set "derivedIntent" with "confidence" 50-80. If genuinely unknown, "" and 0.
EXAMPLES (shape only — do NOT hardcode): Cotton Tote Bag → journey "retail" → "What will you use these bags for?" · ["Retail shopping","Corporate gifting","Event giveaway","Resale","Packaging"]. Industrial Filter → "industrial" → "What's driving this requirement?" · ["New plant","Replacement","Capacity expansion","Maintenance"]. Solar Panel → "project" → "Where will these be installed?" · ["Home rooftop","Commercial building","Industrial plant","Government tender"].
Return ONLY JSON: { "journey":"...", "question":"...", "chips":["..."], "derivedIntent":"", "confidence":0 }`;
  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 512, label: 'deriveIntent' });
    const p = JSON.parse(text);
    const chips = Array.isArray(p?.chips) ? p.chips.map((c: unknown) => indiaize(String(c).trim())).filter(Boolean).slice(0, 6) : [];
    const question = typeof p?.question === 'string' ? indiaize(p.question.trim()) : '';
    if (!question || chips.length < 2) return null; // graceful → caller falls back to planner-first
    const JOURNEYS = ['retail', 'resale', 'industrial', 'project', 'maintenance', 'personal', 'unknown'];
    return {
      journey: JOURNEYS.includes(String(p?.journey).toLowerCase()) ? String(p.journey).toLowerCase() : 'unknown',
      question,
      chips,
      derivedIntent: typeof p?.derivedIntent === 'string' ? p.derivedIntent.trim() : '',
      confidence: Number.isFinite(p?.confidence) ? Math.max(0, Math.min(100, p.confidence as number)) : 0,
    };
  } catch {
    return null;
  }
}

export async function planRequirement(args: {
  productName: string;
  mcatType?: string;
  quantity?: string;
  unit?: string;
  application?: string;
  isqSpecsWithOptions: Record<string, string[]>;
  prior?: {
    persona?: string;
    knownSpecs?: Record<string, string>;
    sellerQuestions?: string[];
    isqAnswers?: Record<string, string>;
  };
  buyerProfile?: BuyerProfile; // persistent behavioural profile (who the buyer is)
  // P5b — the compiled Buyer Twin, distilled for planning. `known` = HIGH-confidence
  // facts the planner must NOT re-ask (fast-track); `unknowns` = open questions to
  // prioritise; `confidence` = twin_confidence (cold vs warm); `offProfile` = current
  // product is unrelated to history → circuit-breaker (don't assume usual intent).
  twin?: { known: string; unknowns: string[]; confidence: number; offProfile: boolean; whyKnown?: string[] };
  buyerKind?: 'business' | 'personal'; // page-1 "who's buying" — shapes plan depth/tone
}): Promise<RequirementPlan | null> {
  const bpf = args.buyerProfile;
  // ── P5b: Twin track. Pick ONE mode, build a directive block. North Star: a
  // known buyer must get FEWER questions — never re-ask what the Twin already knows.
  const tw = args.twin;
  let twinMode: 'fast_track' | 'cold_discover' | 'off_profile' | 'none' = 'none';
  let twinBlock = '';
  if (tw && tw.offProfile) {
    twinMode = 'off_profile';
    twinBlock = `\nTWIN CIRCUIT-BREAKER: this buyer HAS a history, but the CURRENT product is OFF-PROFILE (unrelated to what they usually buy). DO NOT assume their usual intent / scale / persona — that history does not apply here. Treat INTENT and SCALE as UNKNOWN and LEAD WITH AN INTENT question to learn what THIS order is for. Leave "twinResolved" empty.\n`;
  } else if (tw && tw.confidence >= 60 && tw.known) {
    twinMode = 'fast_track';
    twinBlock = `\nTWIN FAST-TRACK (buyer confidence ${tw.confidence}/100). These facts are ALREADY KNOWN about this buyer from past behaviour — you MUST NOT ask about ANY of them again: ${tw.known}.\nEmit AT MOST ONE short CONFIRM question as the FIRST item (kind:"persona", tier:"intent", placement:"wizard", order:0) that lets them verify in ONE tap — options like ["Yes, same as usual","No — this order is different"]. After it, ask ONLY genuinely-decisive UNKNOWN constraints for THIS order — aim for 1-3 questions TOTAL. CRITICAL: do NOT backfill the freed space with extra spec/persona questions to "use up" the budget — specs are collected on the spec page, not here. A known buyer MUST end up with FEWER question cards than a new buyer. Put EVERY topic you skipped because it was already known into "twinResolved".\n`;
  } else if (tw && tw.confidence > 0 && tw.confidence < 50) {
    twinMode = 'cold_discover';
    twinBlock = `\nCOLD BUYER (confidence ${tw.confidence}/100) — we know very little about them. LEAD WITH INTENT (what is this for?) then SCALE (how big / how much per cycle) as chip questions, BEFORE product specs. Specs are secondary until intent + scale are known.\n`;
  }
  if (tw && tw.unknowns && tw.unknowns.length) {
    twinBlock += `Open unknowns to PRIORITISE (ask only the ones relevant to THIS product, as chips): ${tw.unknowns.slice(0, 8).join(', ')}.\n`;
  }
  const bpfLine = bpf && Object.keys(bpf).length
    ? [bpf.persona, bpf.maturity, bpf.sourcingStyle, bpf.buyingPattern, bpf.decisionStyle,
       bpf.infoSeeking && `info-seeking ${bpf.infoSeeking}`, bpf.supplierPreference, bpf.localityPreference,
       bpf.engagement, bpf.responseSensitivity, bpf.multiSku ? 'multi-SKU' : '', bpf.summary]
        .filter(Boolean).join(' · ')
    : '';
  const prompt = `${INDIA_CTX}
You are planning an IndiaMART RFQ so a SELLER can decide to serve and quote WITHOUT a discovery call.
NORTH STAR — ASK THE FEWEST QUESTIONS THAT STILL LET A SELLER QUOTE. Every question must earn its place; reducing buyer effort beats collecting more. A KNOWN buyer (Twin fast-track) MUST get fewer questions than a new one — never re-ask what we already know.
HARD CAP — return AT MOST 3 questions, EVER (the buyer already told us WHY via the intent step, so these are only the few decisive UNKNOWN constraints left). Never exceed 3, even for a brand-new buyer. If more than 3 seem useful, keep only the 3 highest-value and drop the rest.
LANGUAGE — write EVERY question label, option chip and leadingQuestion in PLAIN, SIMPLE ENGLISH a busy shop-owner reads in one glance: ≤12 words, ONE idea per question, NO preamble ("Since this is a one-time capital expenditure…"), NO jargon ("replenishment cadence", "capital expenditure"), NO run-on sentences. GOOD: "How often will you buy this?" BAD: "How frequently do you anticipate replenishing this inventory?". Keep it warm and human.
OPTIMISE FOR LEAD QUALIFICATION, NOT SEARCH: rank attributes by which, once known, infers the MOST about the rest of the requirement AND who the buyer is — the single most-inferent attribute leads. (e.g. hair wax "Usage: Salon vs Personal" implies hold / finish / pack-size / pricing → it leads, even though it is a spec.)
Product: "${args.productName}"
Category type: ${args.mcatType || 'unknown'} (P=product, S=service)
Quantity: ${args.quantity || '?'} ${args.unit || ''}
Buyer use-case (if any): "${args.application || ''}"
${args.buyerKind ? `Who's buying: ${args.buyerKind === 'personal' ? 'PERSONAL / individual end-user — keep it short and simple, NO firm/GST/credit/cadence questions, fewer cards, consumer language and pack sizes.' : 'BUSINESS buyer — scale (volume/cadence), credit/payment terms, and bulk/commercial signals are fair game.'}` : ''}
Category ISQ spec fields WITH options — REFERENCE ONLY (the spec dimension a seller expects; NOT the goal): ${JSON.stringify(args.isqSpecsWithOptions)}
${args.prior ? `\nBUYER HISTORY (from this buyer's PRIOR calls/RFQs in this or a related category — they ALREADY told us these). USE IT: pre-rank specs the buyer cared about to the top of specOrder; REUSE the seller's real questions; infer persona from it; and do NOT re-ask anything already known here.\n  persona: ${args.prior.persona || '?'}\n  specs the buyer already gave: ${JSON.stringify(args.prior.knownSpecs || {})}\n  questions the seller actually asked this buyer: ${JSON.stringify(args.prior.sellerQuestions || [])}\n  prior RFQ answers: ${JSON.stringify(args.prior.isqAnswers || {})}\n` : ''}${bpfLine ? `\nPERSISTENT BUYER PROFILE (WHO this buyer is, across all requirements — high signal): ${bpfLine}.\nUSE IT to shape the plan: a LOCAL-ONLY buyer → a supply-radius/visit question; CATALOG/IMAGE buyer → offer to share catalog, ask for a reference photo; MULTI-SKU TRADER/WHOLESALER → cadence + credit + bulk; LOW DELAY TOLERANCE → flag urgency; SETUP-PHASE → installation/turnkey. Bias personaOptions toward this persona, and rank specs this buyer-type cares about first. Do NOT ask anything this profile already answers.\n` : ''}
${twinBlock}Think about how THIS trade actually sells, then produce a PLAN:
1. "archetype" — classify by HOW THE TRADE SELLS, never by price or bulk:
   • commodity = standard catalog goods sold by spec/grade (resin, film, valves, fasteners — AND furniture, gifts, stationery, consumables, even in bulk).
   • branded_commodity = a commodity where a specific brand/make/OEM drives the buy.
   • capital = MACHINERY / EQUIPMENT that is installed, commissioned, or has a service life (generator, forklift, compressor, CNC, solar plant). NOT furniture / gifts / stationery / consumables — those are commodity however large the order.
   • made_to_spec = built to the buyer's drawing/spec (custom fabrication, custom packaging).
   • project_service = a service or turnkey scope (installation, AMC, consulting).
   • visual_odd_part = identified mainly from a photo/sample (odd spares).
2. "orderMode": "qualifier_first" if "lead" is a non-spec qualifier; "spec_first" otherwise.
3. "specOrder": ALL ISQ spec field names (exactly as listed above), ranked by a COMBINED score — NOT engineering importance alone. Score each by:
   (a) INFERENCE POWER — how much knowing it collapses uncertainty about the rest of the requirement AND who the buyer is;
   (b) BUYER ANSWERABILITY — how confidently THIS buyer can answer it RIGHT NOW, on their own, without asking a supplier. A buyer readily states what they know from their own INTENT — what it's for, rough size/dimensions, look/appearance, branding need, quantity — but only GUESSES at fine-grained fabrication/material metrics (weights, grades, densities, tolerances) that they'd normally ask a supplier to recommend. Rank decision-driving, highly-answerable attributes ABOVE metrics the buyer would merely guess at;
   (c) INFERABILITY — push DOWN anything that can be inferred later from earlier answers;
   (d) DEPENDENCY — ask drivers before the things they determine.
   The #1 spec must be BOTH high-impact AND high-answerability for this buyer. IMPORTANT EXCEPTION: if the buyer profile/history signals a TECHNICAL or repeat buyer who clearly knows the fabrication metrics (e.g. a manufacturer/OEM with prior specced orders), DO NOT demote those metrics — for them they ARE answerable. This is a per-buyer judgement, never a fixed per-category rule.
3b. "specReasons": an OBJECT mapping EACH specOrder field name → a SHORT (≤12 words), PLAIN-ENGLISH sentence saying WHY it sits at that rank — what knowing it tells a seller / what it determines downstream. Write for a business head, NOT an engineer. e.g. {"Application":"Determines material, shape and depth for the whole order","Pump Design Type":"The use-fork that sets power, head and material","Brand":"Buyer preference — left open so more sellers can quote"}. No jargon, no field-name echoing.
4. "lead": the ONE intent-driver to ask FIRST — it MAY be an existing ISQ spec OR a new non-spec qualifier; pick whichever is highest-intent. Shape: { "source": "spec" | "qualifier", "ref": "<exact ISQ field name if source=spec, else the qualifier question text>" }. (hair wax → {"source":"spec","ref":"Usage"}; VTD → {"source":"qualifier","ref":"Is this for cGMP / pharma use?"}; solar → {"source":"qualifier","ref":"Residential, commercial or a tender?"}.)
   LEAD RULE: for capital / project_service / made_to_spec, a USE / SCOPE / COMPLIANCE qualifier (cGMP, tender, supply-vs-install, new-vs-replacement) almost ALWAYS outranks a single spec — use source:"qualifier". A spec leads ONLY when that spec is itself the dominant use-fork (e.g. consumer goods "Usage: Salon vs Personal", which decides hold/finish/pack/pricing).
   APPLICATION/USAGE RULE (STRICT): if an ISQ spec already captures use/application (a field named like Usage / Application / End Use / Suitable For / Industry), the lead MUST be THAT spec (source:"spec", orderMode:"spec_first", ref=the exact field name) so the buyer picks from its option chips. NEVER create a free-text "primary application / which industry / what will you use it for" qualifier, NEVER set qualifier_first for this, and NEVER put such a question in "questions" — it duplicates the spec and forces a text box. (e.g. Diesel Generator HAS a "Usage" spec → lead = {"source":"spec","ref":"Usage"}, spec_first; hair wax HAS "Usage" → lead = Usage. Do this every time the spec exists.)
5. "leadingQuestion": if lead.source=="qualifier", repeat its text here; else "".
6. "mustHaveSpecs": the top 1-4 DECISIVE specs (a subset of specOrder).
7. "personaOptions": 4-6 CATEGORY-TAILORED buyer types — NOT the generic Manufacturer/Stockist/Reseller/Trader/End User. e.g. cosmetics → ["Salon","Retailer","Distributor","Private-label brand","Individual"]; fencing → ["Contractor","Farmer","Wholesaler","Builder"]; cable → ["Contractor","Electrician","Wholesaler","Distributor"].
8. "questions": 3-6 non-spec questions a seller in THIS trade asks to qualify the lead — kind "context" or "persona" ONLY. Each: {id, label, options (3-5 chips, REQUIRED), kind: context|persona, decisive (bool), placement: page1|specpage|wizard|laststep, order (int), reason (<=12 words)}.
   HARD RULES for "questions" (every one matters — a buyer abandons a typing box):
   a. CHIPS ONLY — NEVER free text. Every question MUST carry 3-5 SPECIFIC, mutually-exclusive, category-tailored option chips. NEVER return an empty options array. The form appends an "Other…" chip automatically, so you never need a text box. If you CANNOT enumerate 3-5 concrete options (open-ended things like "what material / size / application / install location?"), DROP the question entirely — do NOT emit it with empty options. Better to ask fewer, sharp chip questions than any text box.
   b. DO THE HARD WORK on options — real, decision-useful buckets, NOT lazy yes/no. Cadence GOOD = ["One-time","Monthly","Quarterly","Annual contract"]; cadence BAD = ["Yes, regular","No"]. Budget bands MUST be ₹, in Indian numbering, and SIZED TO THE ACTUAL ORDER = Quantity × this product's realistic unit price — NOT a generic lakh/crore ladder. A few pieces of a low-value commodity ≈ tens/hundreds of ₹ (e.g. cable lugs, fasteners) → bands like "Under ₹2,000","₹2,000–₹10,000","₹10,000+"; a truckload or machinery → lakh/crore. NEVER emit a lakh/crore budget band for a handful of low-value units. NEVER $.
   c. ALWAYS include a CATEGORY-RELEVANT SCALE question in the buyer's own terms — NOT generic "company size 1-10/11-50". e.g. salon → "Size of your setup?" ["Single chair","2–5 chairs","6–15 chairs","Chain / multi-outlet"]; restaurant → covers/day; factory → units/month; contractor → project size.
   d. Cover the scenario signals this category needs, each as 3-5 chips: repeat-vs-one-time cadence, supply-only-vs-install, new-setup-vs-expansion, sample/swatch wanted, project/tender, budget band, brand-or-best-rate (ONLY if brand is NOT already an ISQ field).
   e. The form ALREADY collects these as dedicated fields — NEVER ask any of them, in ANY phrasing: quantity / order size / "how many"; delivery LOCATION (city / state / region / pincode / "where will it be installed·delivered·used" — this field is HIDDEN behind a pill so you won't see it, but it exists); delivery TIMELINE ("how soon / urgency / lead time"); PAYMENT (terms / mode / advance / credit); GST; firm / company name; phone / email / contact. (e.g. "Which state will it be installed?" = delivery location → FORBIDDEN. "How soon do you need it?" = timeline → FORBIDDEN.)
   f. Do NOT add a buyer-type / "which best describes you" question — "personaOptions" covers identity and the form renders it as its own card.
   g. Do NOT emit kind:"spec" — specs are captured via specOrder/triage.
   h. TAG each question with "tier": "intent" (WHAT/WHY it's for — the use-case/application/purpose/end-use) | "scale" (HOW BIG — volume / cadence / project size / budget) | "constraint" (compliance, certification, install scope, site, sample) | "spec" (a product attribute — rare here; prefer specOrder). The form surfaces them in tier order intent → scale → constraint → spec, so the buyer establishes WHY and HOW-BIG before product details. STRICT: any question about what the product is FOR / its end-use / application / purpose (e.g. "primary use", "what will you use these for") MUST be tier:"intent" — never "constraint". Frequency/quantity/budget = "scale". Get this right: the form leads with the tier:"intent" answer to re-rank everything else.
   i. RELEVANCE BY ORDER SIZE — use the Quantity above to decide if a question even APPLIES. A SMALL order (a handful of units of a low-value commodity, e.g. "1 piece cable lug") → DO NOT ask a budget question and DO NOT ask a scale/volume question; they are noise and erode trust. Budget only earns a slot when the order value is genuinely decision-relevant for THIS qty×product. Cadence (one-time vs repeat) MAY still apply at small qty.
   j. GROUNDING (STRICT, MANDATORY) — every question MUST carry "groundedIn": the CONCRETE signal that makes it relevant for THIS buyer — one of: the quantity, the product/category, the buyer's history/profile, or a stated need. If you CANNOT ground a question in a real signal (it's just a generic thing you'd ask anyone), DROP it. Examples: budget → "groundedIn":"qty 500 × commodity = ₹2–10L order, value matters"; cadence → "groundedIn":"category is a consumable, repeat likely". A question with no real grounding is FORBIDDEN.
   k. INTENT ALREADY CAPTURED — if the "Buyer use-case" above already states the purpose / end-use (the buyer answered it on page 1, e.g. "stated purpose: … = Residential building"), you MUST NOT re-ask it in ANY phrasing — no "what type of project / construction / use / application is this for". That is already done. Emitting a tier:"intent" (purpose/use) question when the use-case is known is FORBIDDEN — ask ONLY scale / constraint / spec.
9. "serveSignals": what the seller needs to decide serve/no-serve (e.g. "city for freight", "qty vs MOQ", "repeat buyer", "install scope").

RULES:
- Category-DEFINING only. No generic chatter ("will you visit Delhi?"), no PII (don't ask phone/email/name as a question — name/company/city is the identity card), no seller tone/greeting.
- Do NOT duplicate the ISQ fields above as questions — specs are captured separately; non-spec questions must add NEW signal.
- BRAND: if ANY ISQ field above is about brand/make/manufacturer/OEM, NEVER add a brand or brand-preference question — that spec already captures it. Only ask "specific brand or best rate?" when brand is ENTIRELY ABSENT from the ISQ fields.
- QUANTITY is a dedicated form field — NEVER make it a question (no "approximate quantity / order size / how much / volume").
- EVERY question carries 3-5 real option chips. Zero free-text questions. Tight: 3-6 questions, decisive first.

Return ONLY JSON: { "archetype": "...", "orderMode": "...", "specOrder": ["..."], "specReasons": { "<spec name>": "why it ranks here (≤12 words)" }, "lead": { "source": "spec", "ref": "..." }, "leadingQuestion": "", "mustHaveSpecs": ["..."], "personaOptions": ["..."], "questions": [ { "id": "", "label": "How often will you need this?", "options": ["One-time","Monthly","Quarterly","Annual contract"], "kind": "context", "tier": "scale", "decisive": true, "placement": "wizard", "order": 1, "reason": "", "groundedIn": "category is a consumable, repeat purchase likely" } ], "serveSignals": ["..."], "twinResolved": [] }`;

  try {
    // Use flash-lite, NOT flash: flash's runaway reasoning (3-4k tokens) eats the
    // whole budget and truncates the JSON. Lite produces the structured plan
    // reliably — the intent classification is well within its ability.
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 2048, temperature: 0.2, label: 'planRequirement' });
    const p = JSON.parse(text);
    const TIER_RANK: Record<string, number> = { intent: 0, scale: 1, constraint: 2, spec: 3 };
    // Hard backstop (same as the generator): drop any planner question that
    // re-asks a spec field / option / config attribute — the planner is told not
    // to, but this guarantees it (e.g. "primary application" when "Usage" is a spec).
    const blocked = blockedSpecTopicTokens(args.isqSpecsWithOptions);
    const archetype = PLAN_ARCHETYPES.includes(p?.archetype) ? (p.archetype as string) : 'unknown';
    // A0: a TINY order of a low-value commodity (a few discrete units) makes a budget
    // question noise. Detect it deterministically so an absurd "Under ₹50,000 … ₹10 lakh+"
    // budget can NEVER appear for "1 piece cable lug" even if the LLM emits it.
    const qtyN = Number(args.quantity) || 0;
    const discreteUnit = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i.test(args.unit || '');
    const tinyCommodityOrder = qtyN > 0 && qtyN <= 10 && discreteUnit && (archetype === 'commodity' || archetype === 'branded_commodity');
    const isBudgetQ = (q: PlanQuestion) => /budget|₹|price\s*(band|range)|spend/i.test(`${q.label} ${(q.options || []).join(' ')}`);
    // T5: the page-1 intent already captured the purpose/use-case (it's in the application as
    // "stated purpose: …"). Drop any planner tier:intent question — it's a duplicate of page-1.
    const intentAlreadyAsked = /stated purpose/i.test(args.application || '');
    const questions: PlanQuestion[] = (Array.isArray(p?.questions) ? p.questions : [])
      .filter((q: { label?: string; placement?: string }) => q && q.label && PLAN_PLACEMENTS.includes(q.placement as string))
      .map((q: Record<string, unknown>, i: number) => ({
        id: (q.id as string) || `pq-${i}`,
        label: indiaize(String(q.label).trim()),
        options: Array.isArray(q.options) ? q.options.map((o) => indiaize(String(o).trim())).filter(Boolean) : [],
        kind: PLAN_KINDS.includes(q.kind as string) ? (q.kind as PlanQuestion['kind']) : 'context',
        tier: ['intent', 'scale', 'constraint', 'spec'].includes(String(q.tier)) ? (q.tier as PlanQuestion['tier']) : 'constraint',
        decisive: !!q.decisive,
        placement: q.placement as PlanQuestion['placement'],
        order: Number.isFinite(q.order) ? (q.order as number) : i,
        reason: typeof q.reason === 'string' ? q.reason.trim() : '',
        groundedIn: typeof q.groundedIn === 'string' ? q.groundedIn.trim().replace(/^<|>$/g, '') : '',
      }))
      // Backstops (belt to the prompt rules):
      //  • kind:'spec' → specs belong in specOrder/triage, not the panel
      //  • chips-only → no free-text questions leak (every card has ≥2 chips)
      //  • covered-field → never re-ask quantity/delivery/timeline/payment (own fields)
      //  • reAsksSpec → never restate a spec field / option / config attribute
      //  • A1 GROUNDING → drop any non-spec question with NO registry grounding (groundedIn
      //    or, as a soft fallback so an LLM hiccup can't wipe all questions, a reason).
      //  • A0 RELEVANCE → drop a budget question on a tiny commodity order (qty-irrelevant).
      .filter(
        (q: PlanQuestion) =>
          q.kind !== 'spec' &&
          hasChips(q) &&
          !asksCoveredField(q.label) &&
          !reAsksSpec({ label: q.label, options: q.options }, blocked) &&
          !!(q.groundedIn || q.reason) &&
          !(tinyCommodityOrder && isBudgetQ(q)) &&
          !(intentAlreadyAsked && q.tier === 'intent') // T5: page-1 intent already asked the purpose
      )
      // P5b: order by information-gain tier (intent → scale → constraint → spec),
      // then the planner's own order; reassign `order` so the panel (which sorts by
      // order) renders the inversion — the confirm/intent card surfaces first.
      .sort((a: PlanQuestion, b: PlanQuestion) => (TIER_RANK[a.tier ?? 'constraint'] - TIER_RANK[b.tier ?? 'constraint']) || ((a.order ?? 99) - (b.order ?? 99)))
      .map((q: PlanQuestion, i: number) => ({ ...q, order: i }))
      // A8 / Intent-First HARD CAP: at most 3 cards for EVERY buyer (the buyer already told
      // us WHY on page 1). We no longer generate 6-then-truncate; the cap is a flat 3.
      .slice(0, 3);
    return {
      archetype: PLAN_ARCHETYPES.includes(p?.archetype) ? p.archetype : 'unknown',
      orderMode: p?.orderMode === 'qualifier_first' ? 'qualifier_first' : 'spec_first',
      leadingQuestion: typeof p?.leadingQuestion === 'string' ? p.leadingQuestion.trim() : '',
      mustHaveSpecs: Array.isArray(p?.mustHaveSpecs) ? p.mustHaveSpecs.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      questions,
      serveSignals: Array.isArray(p?.serveSignals) ? p.serveSignals.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      specOrder: Array.isArray(p?.specOrder) ? p.specOrder.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      specReasons:
        p?.specReasons && typeof p.specReasons === 'object' && !Array.isArray(p.specReasons)
          ? Object.fromEntries(
              Object.entries(p.specReasons as Record<string, unknown>)
                .map(([k, v]) => [k.trim(), indiaize(String(v).trim())])
                .filter(([k, v]) => k && v)
            )
          : {},
      lead:
        p?.lead && (p.lead.source === 'spec' || p.lead.source === 'qualifier') && typeof p.lead.ref === 'string' && p.lead.ref.trim()
          ? { source: p.lead.source as 'spec' | 'qualifier', ref: p.lead.ref.trim() }
          : undefined,
      personaOptions: Array.isArray(p?.personaOptions) ? p.personaOptions.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      twinResolved: Array.isArray(p?.twinResolved) ? p.twinResolved.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      twinMode,
    };
  } catch {
    return null;
  }
}

// ── Adaptive look-ahead: refine the UPCOMING questions from what we know ──────
// Called as the buyer answers each panel card. Given everything we already know
// (the lead spec, other filled specs, buyer type, page-1 context, prior answers),
// it rewrites the not-yet-shown questions to be maximally relevant + specific in
// the buyer's OWN trade terms — e.g. once Usage=Salon is known, a generic
// "operating scale?" becomes "How big is your salon? Single chair / 2-5 / Chain".
// Chips-only, ids preserved, money in ₹. This is how the form stops asking dumb
// generic things (industry / company-size) and adapts step by step.
export async function refineQuestions(args: {
  productName: string;
  known: Record<string, string>; // what the buyer has already told us (specs, role, context)
  upcoming: { id: string; label: string; options: string[] }[];
}): Promise<Record<string, { label: string; options: string[]; drop?: boolean }>> {
  if (!args.upcoming.length) return {};
  const prompt = `${INDIA_CTX}
You are tightening the REMAINING questions of an IndiaMART RFQ for "${args.productName}" using what the buyer has ALREADY told us. Make each upcoming question maximally RELEVANT and SPECIFIC to THIS buyer, in their own trade terms.
Already known — never ask these again, but USE them to specialise: ${JSON.stringify(args.known)}
Upcoming questions to revise (keep each "id" EXACTLY): ${JSON.stringify(args.upcoming)}

For each upcoming id return:
- "label": a sharper question given what we know (e.g. buyer is a Salon → "Operating scale?" becomes "How big is your salon?").
- FOLLOW-UP: treat each upcoming slot as the NEXT question given the LATEST answers — you MAY fully RE-PURPOSE a slot into a more decisive follow-up that the previous answer just unlocked (e.g. after intent="Car wash service" + cadence="Weekly", re-purpose a generic slot into "How many vehicles do you service weekly?"). Keep the "id" exactly; change label + options to the best next question for THIS buyer right now.
- "options": 3-5 SPECIFIC, mutually-exclusive chips in the buyer's terms (salon → ["Single chair","2–5 chairs","6–15 chairs","Chain / multi-outlet"]). Money = ₹ lakh/crore, never $. NEVER free-text/empty.
- "drop": true if what we now know makes the question pointless or duplicate (the freed slot is NOT backfilled — fewer questions is better).
Do NOT add brand-new slots (keep the same ids); re-purposing an existing slot's content is encouraged. NEVER ask (in ANY phrasing) anything the form already collects: quantity/order-size, delivery LOCATION (city/state/region/pincode/"where installed"), timeline ("how soon"), payment (terms/advance/credit), GST, firm name, contact. Keep options crisp.
LANGUAGE: every label MUST be PLAIN SIMPLE ENGLISH — ≤12 words, one idea, no preamble, no jargon, no run-on sentences (e.g. "How big is your salon?" not "What is the operational scale of your salon setup?").
Return ONLY JSON: { "<id>": { "label": "...", "options": ["...","..."], "drop": false } }`;
  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 1024, label: 'refineQuestions' });
    const parsed = JSON.parse(text) as Record<string, { label?: string; options?: unknown; drop?: boolean }>;
    const out: Record<string, { label: string; options: string[]; drop?: boolean }> = {};
    for (const [id, v] of Object.entries(parsed || {})) {
      if (!v || typeof v !== 'object') continue;
      const options = Array.isArray(v.options)
        ? v.options.map((o) => indiaize(String(o).trim())).filter(Boolean)
        : [];
      out[id] = { label: indiaize(String(v.label || '').trim()), options, drop: !!v.drop };
    }
    return out;
  } catch {
    return {};
  }
}

// ── Last-page belief: deduce logistics/profile from everything known ──────────
// The Dumbledore payoff. By the last step we know a lot (enrichment history,
// persona, specs, panel answers). Rather than ask delivery timeline / payment
// terms blank, predict the MOST LIKELY value for each from its options, with a
// confidence 0-1 and a short reason. The client pre-fills only ≥0.8 ones (shown
// editable as "noted") and asks the rest. Returns {} on any failure → ask all.
export async function deduceLogistics(args: {
  productName: string;
  known: Record<string, string>; // specs + panel answers + persona + city + history
  fields: { id: string; label: string; options: string[] }[];
}): Promise<Record<string, { value: string; confidence: number; reason: string }>> {
  if (!args.fields.length) return {};
  const prompt = `${INDIA_CTX}
An India B2B buyer is finishing an RFQ for "${args.productName}". Using ONLY what we already know about them, predict the MOST LIKELY answer to each remaining logistics/profile field — so we can pre-fill it instead of asking.
What we know: ${JSON.stringify(args.known)}
Fields to predict (pick the value from the given options): ${JSON.stringify(args.fields)}

For each field id return { "value": <one of its options>, "confidence": 0-1, "reason": "<=10 words, why" }.
- confidence = how sure you are GIVEN the evidence. Be honest: 0.85+ only with real signal (e.g. repeat commercial buyer ordering in bulk → Credit terms; urgent salon restock → Immediate). If you're guessing, use <0.6 and we'll ask.
- WEIGH THE CURRENT ORDER ABOVE the buyer's persisted persona for these fields. If "known" carries a CURRENT ORDER MODE that says this is a one-off / single-unit / retail-style order, then Advance or COD payment + Immediate/short delivery are the norm for THIS order EVEN IF the buyer's usual persona is a repeat/credit/bulk buyer — a single low-value unit is not sold on credit. When the persona points to credit/long terms but THIS order is a single small unit, set confidence < 0.6 (we will ASK) instead of asserting credit. Your "reason" MUST reference THIS order's size/nature, not only the persona.
- value MUST be exactly one of that field's options.
Return ONLY JSON keyed by id: { "<id>": { "value": "...", "confidence": 0.0, "reason": "..." } }`;
  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 700, label: 'deduceLogistics' });
    const parsed = JSON.parse(text) as Record<string, { value?: string; confidence?: number; reason?: string }>;
    const out: Record<string, { value: string; confidence: number; reason: string }> = {};
    for (const f of args.fields) {
      const v = parsed?.[f.id];
      if (!v || typeof v.value !== 'string') continue;
      // Only keep values that match an allowed option (case-insensitive).
      const match = f.options.find((o) => o.toLowerCase() === String(v.value).trim().toLowerCase());
      if (!match) continue;
      out[f.id] = {
        value: match,
        confidence: typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : 0,
        reason: typeof v.reason === 'string' ? v.reason.trim() : '',
      };
    }
    return out;
  } catch {
    return {};
  }
}

// ── Persistent buyer profile from transcript digest (the compounding gold) ────
// One LLM pass over the buyer's history digest → the behavioural profile that
// PERSISTS across every future requirement (persona, maturity, sourcing/buying
// style, decision style, supplier & locality preference, engagement channel,
// info-seeking). Enum-constrained + confidence. Empty profile on failure.
export async function deriveBuyerProfile(digest: string): Promise<BuyerProfile> {
  if (!digest?.trim()) return {};
  const prompt = `${INDIA_CTX}
You are building a PERSISTENT buyer profile for an IndiaMART buyer from the signals below. These describe WHO THE BUYER IS (persists across requirements), NOT today's requirement. Deduce only what the evidence supports; be honest with confidence.
BUYER SIGNALS:
${digest}

Return ONLY JSON. For EACH field pick EXACTLY ONE value from its list — NEVER return the list itself or multiple values; omit a field entirely if there's no signal:
{
  "persona": "<one of: Industrial Buyer, Trader, Wholesaler, Retailer, Shopkeeper, Manufacturer, Business Buyer>",
  "maturity": "<one of: New Buyer, Existing Buyer, Repeat Buyer, Business Setup Phase, Execution Phase>",
  "sourcingStyle": "<one of: catalog_driven, spec_driven, brand_driven, application_driven>",
  "buyingPattern": "<one of: trial_first, bulk_first, inventory_builder, one_time_capex, repeat_procurement>",
  "decisionStyle": "<one of: Needs Guidance, Self Driven, Hybrid>",
  "infoSeeking": "<one of: Low, Medium, High>",
  "supplierPreference": "<one of: Manufacturer Preferred, Trader Preferred, No Preference>",
  "localityPreference": "<one of: Local Only, Regional, Pan India>",
  "engagement": "<one of: WhatsApp Friendly, Image Sharing Buyer, Call First Buyer, Low Response Buyer>",
  "responseSensitivity": "<one of: Low Tolerance For Delay, Patient, Unknown>",
  "multiSku": <true or false>,
  "summary": "<one concise line a seller would value, e.g. 'Gurugram trader, multi-SKU, WhatsApp-first, wants local suppliers, low delay tolerance'>",
  "tags": ["<short>","<behaviour>","<tags>"],
  "confidence": <a number from 0 to 1>
}
Evidence cues: many WhatsApp messages → WhatsApp Friendly; asks for images/catalog → Image Sharing Buyer; wants factory visit / local area → Local Only; "waited, bought elsewhere" → Low Tolerance For Delay; >1 distinct category → multiSku true; machine/setup → Business Setup Phase / one_time_capex.`;
  try {
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 700, label: 'deriveBuyerProfile' });
    const p = JSON.parse(text) as Record<string, unknown>;
    // Reject unfilled placeholders ("<one of: …>") and echoed option lists ("a | b")
    // — store a clean single value or nothing (never junk).
    const s = (v: unknown) => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      if (!t || t.startsWith('<') || t.includes('|')) return undefined;
      return t;
    };
    const lvl = (v: unknown) => (v === 'Low' || v === 'Medium' || v === 'High' ? v : undefined);
    return {
      persona: s(p.persona),
      maturity: s(p.maturity),
      sourcingStyle: s(p.sourcingStyle),
      buyingPattern: s(p.buyingPattern),
      decisionStyle: s(p.decisionStyle),
      infoSeeking: lvl(p.infoSeeking) as BuyerProfile['infoSeeking'],
      supplierPreference: s(p.supplierPreference),
      localityPreference: s(p.localityPreference),
      engagement: s(p.engagement),
      responseSensitivity: s(p.responseSensitivity),
      multiSku: typeof p.multiSku === 'boolean' ? p.multiSku : undefined,
      summary: s(p.summary),
      tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : undefined,
      confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : undefined,
    };
  } catch {
    return {};
  }
}

// ── BTE-v1.1 Heavy pass: compile the Buyer Twin (with evidence ledgers) ───────
// THE central object. Runs ONCE on GLID-resolve. Every inferred trait must cite
// real signals from the pool — no receipts ⇒ the trait is dropped (zero black-box
// deductions). Identity + twin_confidence are assembled in code (facts); only the
// behavioural/commercial traits + business_type + summary are LLM-inferred.
const TWIN_SRC = new Set(['pns', 'whatsapp', 'csl', 'bl_history', 'isq', 'profile']);
export async function deriveBuyerTwin(args: {
  glid: string;
  nowIso: string;
  identity: { city: string; state: string; language: string; verified: boolean; companyDesc: string | null };
  signals: TwinSignal[];
  counts: { pns_calls: number; whatsapp_events: number; bls_created: number; csl_events: number };
  historicalCategories: string[];
  intentHistory: Record<string, number>;
}): Promise<BuyerTwin> {
  const { counts: c } = args;
  // twin_confidence: saturating on evidence volume (more signals ⇒ more trust).
  const sat = (n: number, k: number) => 1 - Math.exp(-n / k);
  const overall = Math.round(
    100 * (0.35 * sat(c.pns_calls, 3) + 0.25 * sat(c.whatsapp_events, 30) + 0.25 * sat(c.bls_created, 4) + 0.15 * sat(c.csl_events, 20))
  );
  // Date parser (ISO + "25-MAY-26") — used for freshness AND per-trait last_seen.
  const parseDate = (d: string): number => {
    if (!d) return NaN;
    const iso = Date.parse(d);
    if (!Number.isNaN(iso)) return iso;
    const m = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) {
      const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[2].toUpperCase());
      if (mon >= 0) return Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon, +m[1]);
    }
    return NaN;
  };
  // Freshness — recency of the latest signal (stale Twins must lose trust later).
  let lastT = -1, lastStr = '';
  for (const sig of args.signals || []) { const t = parseDate(sig.date); if (!Number.isNaN(t) && t > lastT) { lastT = t; lastStr = sig.date; } }
  const nowT = Date.parse(args.nowIso);
  const days = lastT > 0 && !Number.isNaN(nowT) ? (nowT - lastT) / 86_400_000 : NaN;
  const freshness: BuyerTwin['twin_confidence']['freshness'] = Number.isNaN(days) ? 'Unknown' : days < 30 ? 'Fresh' : days < 90 ? 'Moderate' : 'Stale';
  const base: BuyerTwin = {
    glid: args.glid,
    compiled_at: args.nowIso,
    buyer_version: 1, // real cross-session versioning is a backend job (needs persisted history)
    major_profile_shift_detected: false,
    total_signal_count: args.signals?.length || 0,
    twin_confidence: { overall_score: overall, evidence_base: c, freshness, last_signal_at: lastStr },
    explicit_unknowns: [],
    explicit_negative_signals: [],
    layer_a_identity: {
      city: args.identity.city || '',
      state: args.identity.state || '',
      business_type: '',
      language: args.identity.language || '',
      verified: !!args.identity.verified,
      company_desc: args.identity.companyDesc || null,
    },
    layer_b_behavioral: {},
    layer_c_commercial_intelligence: {
      historical_categories: args.historicalCategories || [],
      recent_intent_clusters: [],
      buyer_intent_history: args.intentHistory || {},
      attribution_confidence: { inferred_product_mapping: null, confidence: 0 },
    },
    summary: '',
  };
  if (!args.signals?.length) return base;

  const pool = args.signals.map((s, i) => `[${i}] (${s.source}${s.date ? ', ' + s.date : ''}) ${s.signal}`).join('\n');
  const prompt = `${INDIA_CTX}
Compile a PERSISTENT BUYER TWIN — who this buyer IS across all requirements (not today's order). This Twin will power every future decision, so it must be EVIDENCE-GROUNDED and UNBIASED.
HARD RULES:
- Use ONLY the SIGNALS below as evidence. NEVER invent a fact or a signal. Copy the cited signal text from the pool.
- For EVERY trait you assert, attach 1-2 evidence items {source, date, signal}. If the signals don't support a trait, OMIT that trait entirely. No receipts → no trait.
- NEVER infer brands / manufacturers / trademarks. This is a marketplace; we must not narrow the seller pool.
- Pick EXACTLY ONE value per trait from its allowed list; never return the list.

IDENTITY (facts): city=${base.layer_a_identity.city}, state=${base.layer_a_identity.state}, language=${base.layer_a_identity.language}, verified=${base.layer_a_identity.verified}
COMPANY DESCRIPTION: ${args.identity.companyDesc || '(none)'}
HISTORICAL CATEGORIES: ${(args.historicalCategories || []).join('; ') || '(none)'}
INTENT HISTORY (counts): ${JSON.stringify(args.intentHistory || {})}
SIGNALS (your only evidence):
${pool}

Each trait is an object: { "value": <pick ONE from its list — never a place, number, or sentence>, "confidence": <0-100 number>, "contradictions_count": <how many signals CONTRADICT this value; 0 if none>, "evidence": [ { "source": "<pns|whatsapp|csl|bl_history|isq|profile>", "date": "<copy the date shown with the signal, or ''>", "signal": "<copy a line from SIGNALS>" } ] }.
Worked example of ONE trait:
  "whatsapp_affinity": { "value": "High", "confidence": 90, "contradictions_count": 0, "evidence": [ { "source": "whatsapp", "date": "", "signal": "109 WhatsApp messages exchanged; shares product images" } ] }

Also derive (all grounded in SIGNALS):
- "recent_intent_clusters": GROUP the categories into 2-4 BROAD themes — NEVER one cluster per product (e.g. combine "Silicone Molds + Candle Mold + Resin Mold" → "Craft & casting moulds"; "PET Jars + Pump Cap" → "Packaging"). Each { "intent": "<broad theme>", "signal_count": <supporting signals>, "last_seen": "<most recent date among them, or ''>" }. Max 4.
- "explicit_negative_signals": SHORT strings for HARD CONSTRAINTS the buyer EXPLICITLY stated (e.g. "No traders", "OEM only", "Don't call me"). A complaint, bad experience, or lost sale is NOT a negative constraint. Return [] if none — never infer.
- "attribution": { "inferred_product_mapping": "<what the buyer ultimately makes/sources for, from company description + pattern; null if unclear>", "confidence": <0-100> }.
- "unknowns": dimensions you have NO signal for (e.g. "supplier_preference", "budget_sensitivity").

Return ONLY JSON in EXACTLY this shape (omit any trait you cannot support with a signal):
{
  "business_type": "<PRIMARY role, short label e.g. Manufacturer / Trader / Wholesaler / Retailer / Service Provider>",
  "secondary_roles": ["<additional roles ONLY if the buyer is clearly multi-role, e.g. a manufacturer who also trades; [] otherwise — don't force a binary>"],
  "behavioral": {
    "whatsapp_affinity":    { "value": "<Low | Medium | High>", "confidence": 0, "evidence": [] },
    "catalog_driven":       { "value": "<true | false>", "confidence": 0, "evidence": [] },
    "image_affinity":       { "value": "<Low | Medium | High>", "confidence": 0, "evidence": [] },
    "local_preference":     { "value": "<Low | Medium | High>", "confidence": 0, "evidence": [] },
    "response_sensitivity": { "value": "<Low | Medium | High>", "confidence": 0, "evidence": [] },
    "decision_style":       { "value": "<Needs Guidance | Self Driven | Comparison>", "confidence": 0, "evidence": [] }
  },
  "commercial": {
    "inventory_builder":     { "value": "<true | false>", "confidence": 0, "evidence": [] },
    "multi_category_buyer":  { "value": "<true | false>", "confidence": 0, "evidence": [] },
    "bulk_orientation":      { "value": "<Low | Medium | High>", "confidence": 0, "evidence": [] },
    "trial_first":           { "value": "<true | false>", "confidence": 0, "evidence": [] },
    "current_active_intent": { "value": "<short intent label e.g. Manufacturing inputs / Packaging / Resale / Project / Personal>", "confidence": 0, "evidence": [] }
  },
  "recent_intent_clusters": [ { "intent": "...", "signal_count": 0, "last_seen": "" } ],
  "explicit_negative_signals": [],
  "attribution": { "inferred_product_mapping": null, "confidence": 0 },
  "unknowns": [],
  "summary": "<one concise seller-valuable line, no PII>"
}`;
  try {
    const t0 = Date.now();
    const text = await callLLM([{ role: 'user', content: prompt }], { model: MODEL_FAST, maxTokens: 3000, temperature: 0.2, label: 'deriveBuyerTwin' });
    base.twin_generation_time_ms = Date.now() - t0;
    const p = JSON.parse(text) as Record<string, Record<string, unknown>>;
    const s = (v: unknown) => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      return !t || t.startsWith('<') || t.includes('|') ? undefined : t;
    };
    // Normalise a trait value against its OWN allowed vocab (not a category list —
    // the trait defines its vocab). Off-vocab ⇒ undefined ⇒ the trait is dropped.
    const LMH = ['Low', 'Medium', 'High'];
    const norm = (val: unknown, vocab?: string[] | 'bool'): string | boolean | number | undefined => {
      if (!vocab) { const sv = s(val); return sv; } // free-form
      if (vocab === 'bool') {
        if (typeof val === 'boolean') return val;
        const t = String(val).trim().toLowerCase();
        if (/^(true|yes|y)$/.test(t)) return true;
        if (/^(false|no|n)$/.test(t)) return false;
        return undefined;
      }
      const t = String(val).trim().toLowerCase();
      return vocab.find((o) => o.toLowerCase() === t || t.includes(o.toLowerCase()));
    };
    // Temporal helpers — last_seen + stability are CODE-derived from grounded
    // evidence dates (never LLM-guessed), keeping the Twin honest. (parseDate hoisted above.)
    const lastSeenOf = (ev: { date: string }[]): string => {
      let best = '', bestT = -1;
      for (const e of ev) { const t = parseDate(e.date); if (!Number.isNaN(t) && t > bestT) { bestT = t; best = e.date; } }
      return best;
    };
    const stabilityOf = (ev: { source: string; date: string }[]): number => {
      const srcs = new Set(ev.map((e) => e.source)).size;
      const ds = ev.map((e) => parseDate(e.date)).filter((n) => !Number.isNaN(n));
      const spanMo = ds.length > 1 ? (Math.max(...ds) - Math.min(...ds)) / (1000 * 60 * 60 * 24 * 30) : 0;
      return Math.max(0, Math.min(100, Math.round(35 + ev.length * 13 + srcs * 10 + Math.min(spanMo, 12) * 2)));
    };
    // Anti-fabrication: an evidence item is only valid if it traces to a REAL pool
    // signal (the LLM must COPY, not paraphrase/invent). Lenient substring overlap.
    const poolText = args.signals.map((sig) => sig.signal);
    const grounded = (sig: string) => {
      const t = sig.trim();
      return t.length >= 8 && poolText.some((ps) => ps.includes(t.slice(0, 25)) || t.includes(ps.slice(0, 25)));
    };
    // Parse one TemporalInferredTrait — drops it if value off-vocab OR no grounded evidence.
    const trait = (v: unknown, vocab?: string[] | 'bool'): InferredTrait | undefined => {
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Record<string, unknown>;
      const value = norm(o.value, vocab);
      if (value === undefined || value === '') return undefined;
      const evidence = (Array.isArray(o.evidence) ? (o.evidence as Array<Record<string, unknown>>) : [])
        .filter((e) => e && TWIN_SRC.has(String(e.source)) && String(e.signal || '').trim() && grounded(String(e.signal)))
        .map((e) => ({ source: String(e.source) as TwinSource, date: String(e.date || '').trim(), signal: String(e.signal).trim().slice(0, 200) }))
        .slice(0, 5);
      if (!evidence.length) return undefined; // no grounded receipts → drop
      const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(100, o.confidence)) : 0;
      const contradictions_count = Math.max(0, Math.round(Number(o.contradictions_count) || 0));
      return { value, confidence, contradictions_count, last_seen: lastSeenOf(evidence), trait_stability: stabilityOf(evidence), evidence };
    };
    const b = (p.behavioral || {}) as Record<string, unknown>;
    const cm = (p.commercial || {}) as Record<string, unknown>;
    // business_type: prefer the LLM; else infer from the buyer's OWN company
    // description (their words, not a category list); else generic.
    const descRole = (() => {
      const d = (args.identity.companyDesc || '').toLowerCase();
      if (/manufactur|we make|we produce|production of/.test(d)) return 'Manufacturer';
      if (/wholesal|distribut/.test(d)) return 'Wholesaler';
      if (/\btrad|reseller/.test(d)) return 'Trader';
      if (/retail|boutique|store/.test(d)) return 'Retailer';
      if (/service|consult|solution provider/.test(d)) return 'Service Provider';
      return '';
    })();
    // F2 guard: a DESIGNATION (Owner/Proprietor/Director/CEO/Partner/Manager/MD…) is a job
    // title, NOT a business type — it leaked through on weak/partial pulls. Reject it and fall
    // back to the company-description role, else a neutral label. Keeps the Twin's identity honest.
    const llmBT = s(p.business_type as unknown).trim();
    const isDesignation = /^(owner|proprietor|partner|director|ceo|cfo|coo|md|managing director|founder|co[-\s]?founder|manager|self|individual|buyer|purchaser|head|president|vp|employee)$/i.test(llmBT);
    base.layer_a_identity.business_type = (llmBT && !isDesignation ? llmBT : '') || descRole || 'Business Buyer';
    base.layer_a_identity.secondary_roles = (Array.isArray((p as Record<string, unknown>).secondary_roles) ? ((p as Record<string, unknown>).secondary_roles as unknown[]) : [])
      .map((x) => s(x)).filter((x): x is string => !!x && x.toLowerCase() !== base.layer_a_identity.business_type.toLowerCase()).slice(0, 3);
    base.layer_b_behavioral = {
      whatsapp_affinity: trait(b.whatsapp_affinity, LMH),
      catalog_driven: trait(b.catalog_driven, 'bool'),
      image_affinity: trait(b.image_affinity, LMH),
      local_preference: trait(b.local_preference, LMH),
      response_sensitivity: trait(b.response_sensitivity, LMH),
      decision_style: trait(b.decision_style, ['Needs Guidance', 'Self Driven', 'Comparison']),
    };
    base.layer_c_commercial_intelligence.inventory_builder = trait(cm.inventory_builder, 'bool');
    base.layer_c_commercial_intelligence.multi_category_buyer = trait(cm.multi_category_buyer, 'bool');
    base.layer_c_commercial_intelligence.bulk_orientation = trait(cm.bulk_orientation, LMH);
    base.layer_c_commercial_intelligence.trial_first = trait(cm.trial_first, 'bool');
    base.layer_c_commercial_intelligence.current_active_intent = trait(cm.current_active_intent);

    // recent_intent_clusters (LLM, grounded) — recency beats history.
    base.layer_c_commercial_intelligence.recent_intent_clusters = (Array.isArray(p.recent_intent_clusters) ? (p.recent_intent_clusters as Array<Record<string, unknown>>) : [])
      .map((x) => ({ intent: s(x?.intent) || '', signal_count: Math.max(0, Math.round(Number(x?.signal_count) || 0)), last_seen: String(x?.last_seen || '').trim() }))
      .filter((x) => x.intent)
      .slice(0, 4);
    // explicit_negative_signals — hard constraints; grounded; never inferred.
    base.explicit_negative_signals = (Array.isArray(p.explicit_negative_signals) ? (p.explicit_negative_signals as unknown[]) : [])
      .map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' ? String((x as Record<string, unknown>).signal || (x as Record<string, unknown>).value || '').trim() : ''))
      .filter(Boolean)
      .slice(0, 6);
    // attribution stub for downstream Matchmaking/Recommendations.
    const attr = ((p as Record<string, unknown>).attribution || {}) as Record<string, unknown>;
    base.layer_c_commercial_intelligence.attribution_confidence = {
      inferred_product_mapping: s(attr.inferred_product_mapping) || null,
      confidence: typeof attr.confidence === 'number' ? Math.max(0, Math.min(100, attr.confidence)) : 0,
    };
    // explicit_unknowns = trait dimensions with NO evidence (dropped) + LLM-noted gaps.
    // The Question Planner asks from HERE — never a hardcoded list.
    const lc = base.layer_c_commercial_intelligence as unknown as Record<string, unknown>;
    const present = new Set<string>([
      ...Object.entries(base.layer_b_behavioral).filter(([, v]) => v).map(([k]) => k),
      ...['inventory_builder', 'multi_category_buyer', 'bulk_orientation', 'trial_first', 'current_active_intent'].filter((k) => lc[k]),
    ]);
    const expected = ['whatsapp_affinity', 'catalog_driven', 'image_affinity', 'local_preference', 'response_sensitivity', 'decision_style', 'inventory_builder', 'multi_category_buyer', 'bulk_orientation', 'trial_first', 'current_active_intent'];
    const llmUnknowns = (Array.isArray((p as Record<string, unknown>).unknowns) ? ((p as Record<string, unknown>).unknowns as unknown[]) : []).map((x) => String(x).trim()).filter(Boolean);
    base.explicit_unknowns = [...new Set([...expected.filter((k) => !present.has(k)), ...llmUnknowns])].slice(0, 12);
    // major_profile_shift: the buyer's HISTORICAL role (from company_desc) vs what
    // they're doing NOW (current intent + business_type). Compare on the
    // trader↔manufacturer axis. (True cross-session versioning → backend.)
    const desc = (args.identity.companyDesc || '').toLowerCase();
    // "Now" = current intent + business_type + the recent intent-history themes, so
    // a shift is detected even if the single intent trait was dropped for sparse evidence.
    const nowText = [
      String(base.layer_c_commercial_intelligence.current_active_intent?.value || ''),
      base.layer_a_identity.business_type,
      ...Object.keys(args.intentHistory || {}),
    ].join(' ').toLowerCase();
    const histTrader = /\btrad|wholesal|distribut|reseller/.test(desc);
    const histMfr = /manufactur|we make|we produce|production of/.test(desc);
    const nowMfr = /manufactur|setup|factory|machine|injection|moulding|production|tooling/.test(nowText);
    const nowTrade = /resale|\btrad|retail|distribut|stock/.test(nowText);
    base.major_profile_shift_detected = (histTrader && nowMfr) || (histMfr && nowTrade);
    base.summary = indiaize(String(p.summary || '').trim());
    return base;
  } catch {
    return base; // graceful: identity + confidence survive even if the LLM pass fails
  }
}

// ── Clean, PII-free requirement summary for suppliers ─────────────────
export async function summarizeRequirement(
  productName: string,
  notes: string,
  specsText: string
): Promise<string> {
  if (!notes.trim()) return '';
  try {
    const text = await callLLM([
      {
        role: 'user',
        content: `${INDIA_CTX}
Summarise this B2B buyer's requirement for "${productName}" into ONE short, professional line for suppliers.
Specs chosen: ${specsText || 'none'}.
Buyer's notes: "${notes}".

STRICT RULES:
- Describe the PRODUCT NEED only.
- Remove ALL personal/contact info — no phone, email, name, address, company name, links. (Buyer contact is sold separately as a lead.)
- No fluff. Plain language.

Return ONLY JSON: { "summary": "one concise line" }`,
      },
    ], { label: 'summarizeRequirement' });
    return indiaize(JSON.parse(text).summary || '');
  } catch {
    return '';
  }
}

// ── Infer specs from the buyer's use-case / application ───────────────
// One call that maps a free-text application ("rebar for a 3-storey house in
// a seismic zone") onto the category's spec fields, choosing existing options
// where possible. Powers the Tier-1 "Assist" flow.
export async function inferSpecsFromApplication(
  productName: string,
  application: string,
  isqSpecNames: string[],
  isqSpecsWithOptions: Record<string, string[]>
): Promise<{
  specs: Record<string, string>;
  rationale: string;
}> {
  const text = await callLLM([
    {
      role: 'user',
      content: `${INDIA_CTX}
You are a B2B procurement expert for IndiaMART.
Product: "${productName}"
Buyer's use-case / application: "${application}"
Spec fields to fill: ${JSON.stringify(isqSpecNames)}
Allowed options per field: ${JSON.stringify(isqSpecsWithOptions)}

Infer the most likely value for each spec field FROM THE USE-CASE.
Rules:
- Only fill a field if the use-case gives reasonable signal; skip the rest.
- Prefer an EXACT option string when one fits.
- If the buyer EXPLICITLY stated a specific value for a listed field that isn't among its options (e.g., a brand/material/size not in the list), return that exact stated value — it will be saved as a custom "Other" entry. Never invent off-list values the buyer didn't actually state.
- Do not invent fields that aren't listed. Details that don't match any field are ignored here (kept elsewhere).
- HONESTY: these values are DOMAIN INFERENCE (a typical configuration), NOT the buyer's stated requirement. The rationale must reflect that — frame it as what is TYPICAL/COMMON for this product. NEVER write "Buyer's requirement for X" / "Buyer needs X" for a value the buyer did not explicitly state in the use-case; that misrepresents an AI guess as a buyer-stated fact.

Return ONLY JSON:
{
  "specs": { "SpecName": "an exact option, or the buyer's explicit custom value" },
  "rationale": "ONE short sentence framed as typical/common domain inference (e.g. 'Typical for car-wash tyre polish: usually silicon-based, high-gloss, spray form'), NOT as the buyer's stated requirement"
}`,
    },
  ], { label: 'inferSpecsFromApplication' });
  return JSON.parse(text);
}

// ── On-demand: bucketized, context-aware spec guidance (Tier-2 help) ───
// Returns a "this-for-this" decision guide rather than a single answer.
export interface SpecBucket {
  label: string; // the option, or a range like "10–25 kVA"
  scenario: string; // who/what it's best for
  likely?: boolean; // best fit for THIS buyer's context (subtle highlight)
}
export interface SpecGuide {
  intro: string;
  buckets: SpecBucket[];
  note?: string;
}
export async function explainSpec(
  productName: string,
  specName: string,
  options: string[],
  ctx: {
    quantity?: string;
    unit?: string;
    filledSpecs?: Record<string, string>;
    application?: string;
    imageBase64?: string;
    imageMimeType?: string;
    twinContext?: string; // PII-free, brand-free buyer background (Twin) — sharpens "likely"
  } = {}
): Promise<SpecGuide> {
  const filled = Object.entries(ctx.filledSpecs || {})
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const prompt = `${INDIA_CTX}
You are helping a B2B buyer in India choose "${specName}" for "${productName}".
Context — quantity: ${ctx.quantity || '?'} ${ctx.unit || ''}; already chosen: ${filled || 'none'}; use-case: "${ctx.application || 'unknown'}".${ctx.twinContext ? ` Buyer background: ${ctx.twinContext}.` : ''}
${options.length ? `Options: ${JSON.stringify(options)}.` : 'This field is free-text (no fixed options).'}

Write a SHORT DECISION GUIDE — "this for this", not a single recommendation:
- Map options (or ranges, for numeric/size specs like kVA/diameter/length) to the scenario each suits best.
- 2–4 buckets. Keep each scenario to a few words, plain language, no jargon.
- If the spec is NOT scenario-driven (e.g., a brand list), put short guidance in "note" (e.g., which are premium vs value) and keep buckets minimal.
- Set "likely": true on the ONE bucket that best fits THIS buyer's context (product, quantity, chosen specs, use-case${ctx.imageBase64 ? ', and the attached photo' : ''}). Omit if genuinely unsure.

Return ONLY JSON:
{ "intro": "1-2 plain lines on what this controls", "buckets": [ { "label": "option or range", "scenario": "who/what it's for", "likely": false } ], "note": "" }`;

  const useImage = !!(ctx.imageBase64 && ctx.imageMimeType && !ctx.imageMimeType.includes('pdf'));
  const content = useImage
    ? [
        { type: 'image_url', image_url: { url: `data:${ctx.imageMimeType};base64,${ctx.imageBase64}` } },
        { type: 'text', text: prompt },
      ]
    : prompt;

  // Lite is plenty for a text decision-guide; only escalate when reading a photo.
  const text = await callLLM([{ role: 'user', content }], {
    model: useImage ? MODEL_RICH : MODEL_FAST,
    maxTokens: 800,
    label: 'explainSpec',
  });
  const guide = JSON.parse(text) as SpecGuide;
  // India guard: any price/range text in the guide must read in ₹.
  guide.intro = indiaize(guide.intro || '');
  if (guide.note) guide.note = indiaize(guide.note);
  guide.buckets = (guide.buckets || []).map((b) => ({
    ...b,
    label: indiaize(b.label || ''),
    scenario: indiaize(b.scenario || ''),
  }));
  return guide;
}

// ── Spec hints from product name ──────────────────────────────────────
// ── Confidence-&-Bias Gate: classify each ISQ field (the VEKA killer) ─────────
// objective = a buyer-owned physical/measurable attribute we MAY pre-fill.
// preference = a brand/make/manufacturer/proprietary choice that would NARROW the
// seller pool → NEVER auto-filled or even suggested. LLM-driven (no category
// hardcoding) + a universal procurement-keyword safety net.
const PREFERENCE_KEYWORDS = /\b(brand|make|manufacturer|oem|company\s*name|trademark|model\s*(name|no\.?|number)?|brand\s*name|made\s*by)\b/i;
export async function classifyFieldTypes(
  productName: string,
  isqSpecNames: string[]
): Promise<{ preference: string[]; objective: string[] }> {
  if (!isqSpecNames.length) return { preference: [], objective: [] };
  const kwPref = isqSpecNames.filter((n) => PREFERENCE_KEYWORDS.test(n));
  try {
    const text = await callLLM([{ role: 'user', content: `${INDIA_CTX}
For the product "${productName}", classify each ISQ field:
- "preference" = a SELLER/BRAND choice that would NARROW the supplier pool if we assumed it — Brand, Make, Manufacturer, OEM, Model name, proprietary/branded variant. The marketplace must NEVER guess these.
- "objective" = a physical/measurable buyer-owned attribute (size, material, capacity, grade, application, usage, colour, type, dimension).
Fields: ${JSON.stringify(isqSpecNames)}
Return ONLY JSON: { "preference": ["exact field names"], "objective": ["exact field names"] }` }], { maxTokens: 500, label: 'classifyFieldTypes' });
    const p = JSON.parse(text) as { preference?: unknown };
    const fromLLM = Array.isArray(p.preference) ? p.preference.map((x) => String(x)) : [];
    const prefSet = new Set(isqSpecNames.filter((n) => PREFERENCE_KEYWORDS.test(n) || fromLLM.some((f) => f.toLowerCase() === n.toLowerCase())));
    return { preference: [...prefSet], objective: isqSpecNames.filter((n) => !prefSet.has(n)) };
  } catch {
    return { preference: kwPref, objective: isqSpecNames.filter((n) => !kwPref.includes(n)) };
  }
}

export async function getSpecHints(
  productName: string,
  isqSpecNames: string[],
  isqSpecsWithOptions: Record<string, string[]>,
  twinContext = ''
): Promise<{
  knownFromProductName: Record<string, string>;
  redundantISQSpecs: string[];
  isqHints: Record<string, string>;
}> {
  const text = await callLLM([
    {
      role: 'user',
      content: `${INDIA_CTX}
You are a B2B product spec expert for IndiaMART.
Product: "${productName}"
${twinContext ? `Buyer background (use ONLY to make "isqHints" more relevant — do NOT use it to fill "knownFromProductName" with anything the product name does not itself entail, and NEVER infer a brand from it): ${twinContext}\n` : ''}ISQ fields: ${JSON.stringify(isqSpecNames)}
Fields with options: ${JSON.stringify(isqSpecsWithOptions)}

Only put a value in "knownFromProductName" if it is UNAMBIGUOUSLY entailed by the product name (e.g. "Stainless Steel Bottle" → Material: Steel). If you are not ~certain, leave it out.
NEVER infer a Brand / Make / Manufacturer / OEM / Model — that narrows the seller pool and is forbidden. NEVER guess.

Return ONLY JSON:
{
  "knownFromProductName": { "SpecName": "value UNAMBIGUOUSLY implied by the product name (never a brand)" },
  "redundantISQSpecs": ["spec names not applicable for this product"],
  "isqHints": { "SpecName": "short helpful hint, max 8 words" }
}`,
    },
  ], { label: 'getSpecHints' });
  const parsed = JSON.parse(text) as { knownFromProductName?: Record<string, string>; redundantISQSpecs?: string[]; isqHints?: Record<string, string> };
  // Bias guard at the source: a name-detect must NEVER be a brand/make field.
  const known: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.knownFromProductName || {})) {
    if (!PREFERENCE_KEYWORDS.test(k)) known[k] = v;
  }
  return { knownFromProductName: known, redundantISQSpecs: parsed.redundantISQSpecs || [], isqHints: parsed.isqHints || {} };
}
