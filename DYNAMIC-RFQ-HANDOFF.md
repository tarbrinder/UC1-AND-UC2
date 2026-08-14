# Dynamic RFQ — Handoff (resume here)

**How to resume in a new chat:** open `~/Desktop/rfq-form`, then `Read DYNAMIC-RFQ-HANDOFF.md`. This file is the full current context. Last updated **2026-08-01** (supersedes the 2026-07-30 version, which described a since-completed re-architecture).

**Live dev route:** `http://localhost:5173/?rfq=brain` · Repo `~/Desktop/rfq-form` (Vite + React + TS + Tailwind)
**State:** all code below is `tsc`-clean + **79/79 tests** green + live-verified on GLID `254950925`. **NOTHING IS COMMITTED** (21 modified/untracked files — see §10).

> ✅ **UPDATE 2026-08-01 (later):** the 101-gap register has been worked through — see §16 "Fix pass" at the end. Test
> coverage is now **79 tests** including a real suite for `src/lib/rfq/`, the three regressions below are FIXED, and
> a live probe found (and fixed) a model switch that was hard-401ing the buyer-profile card. The paragraphs below are
> kept as the record of what was wrong.

> ⚠️ **"39/39 tests green" does NOT cover this work.** No test file imports anything from `src/lib/rfq/`. The four suites (`plannerBlocks`, `sourceConsumption`, `specHygiene`, `substringGuard`) certify the **retired** architecture. Treat the green tests as a regression guard on the old code, not as evidence the 3-LLM path works. The only real verification to date is manual + the live traces in §2.3.

### ⚠️ Known regressions introduced by this session (NOT fixed)
A post-build 11-agent audit found three defects in the uncommitted work. They are real, they are mine, and they are unfixed:
1. **`captureRaw` gating blanked raw I/O on OTHER surfaces.** Making `captureRaw` default to `false` (the prod/debug leak fix) means every pre-existing consumer outside `rfq/llm.ts` now renders an empty prompt/output panel — `BuyerLedgerView.tsx:438,1156,1619`, `RFQModalV4.tsx:7230,7264`, `downloadProfile.ts:123,165`. Those call sites need `captureRaw: true` passed explicitly.
2. **`catCorpus` is not cleared on the seed short-circuit**, so LLM 2 can be fed the *previous* category's full corpus. `BrainRFQForm.tsx:487-500` returns early when the seed already has a category for this mcat, without resetting `catCorpus`.
3. **The extra category fetch is a genuine double-execution, not a cache-warm.** My code comment claims it is cache-warm; the n8n node sends Redash `max_age: 0`, so `bi-category-brain` runs the full query **twice per commit**. `BrainRFQForm.tsx:498-508`.

Also correct two claims made earlier in this project: the **category corpus being "empty"** for a given mcat is *indistinguishable from a Redash failure or poll timeout* by design (the node reports success either way), so `0 calls analysed` is not proof the category has no data; and `reasoning_effort` **actually taking effect for the first time** silently changes behaviour at ~19 other call sites across the estate (see §15 / the gap register).

---

## 1. What this is

IndiaMART **Dynamic RFQ** — a buyer-facing "Post a Requirement → Get Quotes" form driven by a **3-LLM architecture** over a mostly-dumb renderer, with a **deterministic merge layer** as the last page.

```
Page -1  BrainFormGate       GLID + PNS mode + Execution mode + Reasoning effort + Surface
   ↓
Page 0   Landing             search / mic / camera · repost cards · viewed products
   ↓     commitProduct       mcat resolve → CSL-collision mcat swap → qty/unit gate
Page 1   Specifications      LLM 1 · Requirement Brain (fires on commit)
   ↓
Page 2   Commercial          LLM 2 · Commercial Planner
   ↓
Page 3   About You           LLM 3 · Persona Planner
   ↓
Page 4   Your Profile        deterministic Merge Layer (dedup) + GST/contact/delivery
   ↓
         Results             curated seller search
```

Stage machine values: `landing → specs → commercial → persona → more → results`. (`specs2` was removed 2026-08-01 — see §16.21.)

**`?rfq=brain2`** (`src/components/rfq/DynamicRFQ.tsx`) is a *minimal reference blueprint* of the pure architecture — **do not ship it**; the owner wants enhancements inside `?rfq=brain`, reusing the polished shell. ⚠️ It had fallen behind; the effort selector is now threaded (§16.19), but it still passes the distilled category feed rather than the full corpus.

---

## 2. Model + gateway (READ THIS FIRST — changed 2026-08-01)

### 2.1 One model everywhere
`src/lib/gemini.ts`:
```ts
const MODEL_FAST = 'google/gemini-3.5-flash-lite';
const MODEL_RICH = 'google/gemini-3.5-flash-lite';   // owner: "across all use 3.5 flash lite only"
const MODEL_CARD = 'google/gemini-2.5-flash-lite';   // buyer-CARD path ONLY — its key 401s on anything else (§16.1)
```
Both FORM tiers point at 3.5-flash-lite. It is a newer generation than 2.5-flash and the owner's own transcription benchmark put it **ahead of 2.5-flash on quality at ~2.8× the speed**. `MODEL_RICH` is kept as a separate *name* so pointing it back at a heavier model for multimodal is a one-line change.

⚠️ **The card path is deliberately NOT on the lock** — `RFQ_FORM_LLM_MODEL = MODEL_CARD`. Probed live: `/api/cardllm` returns a hard **401 `team_model_access_denied`** for anything other than 2.5-flash-lite, so pointing it at MODEL_FAST broke every card call into a silent empty-card fallback. Fixed in §16.1.
⚠️ **The lock is still incomplete in one place:** two form LLM calls in `BrainRFQForm.tsx:205-222` pass their own model override (a 3.6-generation string) with **no `LLM_RATES` entry**, so they escape the lock and report $0. Left as-is — they are the mic/photo multimodal calls and changing their tier is a quality decision, not a bug fix.

`LLM_RATES` has an entry for the new model — the rate is **ASSUMED equal to 2.5-flash-lite** pending a published price. Debug cost display only, never billing.

### 2.2 ⭐ The gateway fix — `reasoning_effort` was silently inert for the entire project's life
The gateway (`imllm.intermesh.net/v1`, reached via the vite proxy `/api/llm`, key injected server-side) is **LiteLLM in front of OpenRouter**. It rejected our thinking level with:

```
litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'],
for model=google/gemini-2.5-flash-lite … If you want to use these params dynamically
send allowed_openai_params=['reasoning_effort'] in your request.
```

The error names its own cure. `callLLM` now sends it whenever an effort is stated:
```ts
...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
...(reasoningEffort ? { allowed_openai_params: ['reasoning_effort'] } : {}),
```

**Measured on the live gateway (12 probes):**

| | hard 400s | `reasoning_tokens` |
|---|---|---|
| **without** `allowed_openai_params` | ~1 in 4 (nondeterministic — routing lottery across deployments) | **0** — effort silently dropped |
| **with** it | 0 / 12 | low `0` · medium `~300-400` · high `~404-457` |

The critical implication: **even the HTTP-200 calls had 0 reasoning tokens**, so `low`/`medium`/`high` were *identical*. Every earlier claim in this project about "prod runs at low effort / debug at medium" was describing a parameter the gateway was throwing away. Nothing reasoned differently until 2026-08-01.

The old 400/422 strip in `callLLM` is retained as a **backstop only** and now also deletes `allowed_openai_params` on the retry. If `LLM_HEALTH` ever shows `effort — (stripped)` again, the gateway changed.

### 2.3 Effort is now selectable and mode-independent
`EffortMode = 'low' | 'medium' | 'high'` (`src/lib/rfq/contracts.ts`), chosen once on **page −1**, default **high**, threaded to **all three LLMs identically in prod and debug**.

> **Owner rule (locked):** intelligence is mode-INDEPENDENT. Prod and Debug reason at exactly the same depth; only *verbosity* differs. Do **not** re-tie effort or token budgets to `exec` for latency reasons.

**Live-verified (GLID 254950925, effort=high, all on 3.5-flash-lite, one 200 per call, no retry):**

| call | effort | reasoning tokens | latency |
|---|---|---|---|
| `requirement-brain` | high | **3,723** | 13,959 ms |
| `commercial-planner` | high | **2,540** | 8,896 ms |
| `persona-planner` | high | **3,081** | 11,249 ms |

**≈34 s of LLM time across the three pages at `high`.** This is the known latency cost; dial to medium/low on page −1, which now genuinely changes behaviour.

---

## 3. The three LLMs — exact contracts

All in `src/lib/rfq/llm.ts`. Versions: `RFQ_LLM_VERSION = { brain: 'rb-v1', commercial: 'cx-v1', persona: 'ps-v1' }`.
Shared budget: `BUDGET = { min: 2, pref: 3, max: 5 }` (prefills/confirms are EXTRA, don't count).
Token ceilings: `BRAIN_MAXTOK = 18000`, `PLANNER_MAXTOK = 10000`. `temperature: 0` everywhere.

### 3.1 Fencing (how inputs are presented)
| helper | used when | shape |
|---|---|---|
| `fence(tag, v)` | **prod** | `<tag>` + one-line `JSON.stringify` |
| `fenceNumbered(tag, v)` | **debug** | `<tag>` + pretty-printed JSON with an `Lnn ` prefix on every line |
| `fenceFor(exec)` | picks one | debug → numbered, prod → compact |
| `FENCE_CAP = 60000` | both | **runaway backstop only** (was a 10 000-char routine trim). Same in both modes so the DATA is byte-identical; only presentation differs. |

### 3.2 LLM 1 · Requirement Brain — `runRequirementBrain(inp, exec, effort)`
Fires **inline in `BrainRFQForm`** on product commit (deliberately *not* extracted — too entangled with the spec-merge/consumption pipeline).

**Inputs (fenced):** `product`, `already_filled`, `buyer_specs_schema`, `seller_specs`, `browsed_specs`, `truth_csl`, `truth_rfq`, `truth_profile`, `truth_whatsapp`, `truth_pns`.
**Category insights are deliberately NOT given to LLM 1** (owner-locked, both branches).

**Output:**
```json
{ "brain": { "understanding": str, "persona_read": str, "category_trustworthy": bool, "evidence"?: [str] },
  "page1": { "questions": [{ "field","label","ui":"ask|prefill|suggest|confirm","value"?,"suggestion"?,"options"?,"order" }], "metadata": {} },
  "known_truths": [{ "key","value","source" }] }
```

**Key rules:** never fabricate (prefill only from truth); every `ui:"ask"` MUST carry 2–5 option chips (a chip-less ask would render as a raw text box and is dropped in code); labels 3–4 words; `known_truths` is **specification facts only** — identity/contact/location/company/GST is firewalled out; **COLLISION OVERRIDE** (highest priority) — if `browsed_specs` is present a category collision was already detected upstream, so `category_trustworthy=FALSE` and Page 1 is driven from `browsed_specs`, and the mis-category's self-consistent filled values may NOT be used to validate it.

### 3.3 LLM 2 · Commercial + LLM 3 · Persona — `runCommercialPlanner` / `runPersonaPlanner`
Both via `runPlanner(kind, inp, exec, effort)`; orchestrated by `usePlannerController`.

| | LLM 2 Commercial | LLM 3 Persona |
|---|---|---|
| fenced inputs | `requirement_brain`, `product`, `page1_state`, **`category_engine`**, `pns` | `requirement_brain`, `product`, `page1_state`, **`page2_state`** |
| authority order (in prompt) | brain → page-1 specs → full category corpus → PNS | brain → page-1 specs → page-2 commercial answers |
| themes | warranty, delivery timeline, payment terms, installation, supplier preference, purchase frequency, sample order, certifications | designation, industry, business size, annual procurement, decision-maker — **never GST** (last page owns it deterministically) |

**Output:** `{ questions: [{field,label,ui,value?,options,order}], metadata: {} }`

**Canonical field keys** (so the merge layer can dedup across pages — exact keys, never synonyms): `delivery_timeline, payment_terms, supplier_type, purchase_frequency, warranty, sample_order, annual_procurement, designation, industry, business_size, decision_maker`.

**Code-enforced contract:** `normQuestions` + a filter drop any `ui:'ask'` with `<2` option chips, so a chip-less ask can never reach the renderer as free text.

---

## 4. Prod vs Debug — exactly what differs

**Intent: data identical, reasoning identical, only verbosity + instrumentation differ.**

⚠️ **The "data identical" invariant is violated at the margin, in the wrong direction.** `fenceNumbered` pretty-prints (`JSON.stringify(v, null, 1)` + an `Lnn ` prefix per line), which makes the same payload several times longer in characters — but `FENCE_CAP` is the same 60 000 in both modes. So a large source truncates **earlier in debug than in prod**, i.e. debug can show the model *less* data than production. For the sources seen live this is nowhere near the cap, but it means a debug trace of a very large PNS/CSL payload is not a faithful reproduction of the prod call. Fix = scale the cap by mode, or cap on the pre-render object.

| | Prod | Debug |
|---|---|---|
| model | 3.5-flash-lite | same |
| `reasoningEffort` | page −1 selection | **same** |
| `maxTokens` | 18000 / 10000 | **same** |
| input fence | compact | **line-numbered** (`Lnn `) |
| `evidence[]`, `metadata.reasoning`, `considered[]`, `needs_input` | omitted | emitted |
| `captureRaw` (raw prompt/PII trace) | **off** | on |
| 🔬 inspector UI | hidden | shown |

`PROD_SUFFIX` says *"return only the JSON … think and reason as fully as you would in debug … do NOT trade accuracy for speed."* (An earlier "be concise and fast" nudge was removed — it was capping reasoning on the buyer path.)

**Debug-only prompt addenda:**
- `DEBUG_SUFFIX` — `metadata.reasoning` keyed by field `{why, confidence, evidence, source}`, where **every evidence atom must cite `<source>:Lnn — <fact>`**; if it can't point at a line it is not evidence and must go to `needs_input` instead. Plus `metadata.needs_input[{attribute, missing_reason, best_next_question}]`.
- `BRAIN_DEBUG_CONSIDERED` — `page1.metadata.considered[{candidate, surfaced, rank, dropped_because}]` (the seller/generated candidate pool).
- `PLANNER_DEBUG_CONSIDERED(kind)` — the **question-competition ledger**: `considered[{candidate, surfaced, rank, basis, why_ranked, dropped_because}]`. `basis` must cite `<source>:Lnn` **or** the literal `own_knowledge` — never a fabricated line number.

**Live-verified basis output:**
- Commercial `#1 delivery_timeline` ← `product:L3 quantity 200 + requirement_brain:L2 bakery cake product`; dropped `warranty` ← `own_knowledge` "not applicable for food/bakery items".
- Persona dropped `purchase_frequency` ← **`page2_state:L3`** "already captured in commercial page 2" — proof LLM 3 reads and dedups against the commercial answers with a citable line.

⚠️ Debug prompts are materially bigger (brain 10,750 → 15,640 prompt tokens) because the numbered fence pretty-prints. **Prod is unaffected.**

---

## 5. Data sources

All webhooks via the dev proxy `/api/imworkflow/webhook/…`. `src/lib/rfq/dataLayer.ts` owns them; each calls `recordSource(...)` so the inspector shows **7 sources**.

| source | endpoint | consumed by |
|---|---|---|
| CSL | `bi-csl-parser` | LLM 1 (`truth_csl`) + landing tiles + **collision mcat swap** |
| RFQ details | `bi-rfq-details` | LLM 1 (`truth_rfq`) + landing repost cards |
| Profile | `bi-bpod` | LLM 1 (`truth_profile`) |
| WhatsApp | `bi-whatsapp` | LLM 1 (`truth_whatsapp`) |
| PNS call insights | `bi-pns-insights?pns=api\|full&mcat_id=` | LLM 1 (`truth_pns`) + LLM 2 (`pns`) |
| Buyer specs | `Newreqform/GetIsq` | Page 1 schema + LLM 1 (`buyer_specs_schema`) |
| Category brain | `bi-category-brain?mcat_id=` | **LLM 2 only** (`category_engine`) |
| mcat resolve | `mcatid-suggestion.php` | commit |
| Seller search | `POST /api/sellersearch` → windmill | results page |

**Category corpus (fixed 2026-08-01).** `fetchCategoryTopSpecs` kept only `top_specs` and silently discarded four whole sections the n8n node computes — `personas`, `keywords`, `b2b_b2c`, `top_products` — plus the coverage counters (`calls_analyzed`/`rows_received`/`rows_unparsed`). New **`fetchCategoryBrainFull`** returns the payload verbatim → new `catCorpus` state → LLM 2 receives `categoryEngine: catCorpus ?? catTopSpecs`. `catTopSpecs` is untouched so the have-category gating contract still works.

> Category insights feed **LLM 2 only** — owner-locked. Not the Brain, not Persona.

---

## 6. Page-by-page behaviour

**Page −1 `BrainFormGate`** — GLID (or scenario buttons) · Call insights `API only` / `API+VANI+PNS` · Execution mode `Production ⚡` / `AI Debug 🔬` · **Reasoning effort `High`/`Medium`/`Low`** · Surface `Mobile`/`Desktop popup`/`Standalone`. Chosen ONCE (only Surface changes live). `load()` calls `resetSourceHealth()` + `resetLLMTelemetry()` and fetches all four truth leaves into `leafTruth`.

**Page 0 Landing** — product search + suggest, mic, camera; "Continue where you left off" repost cards; "Products you viewed" tiles (from CSL `viewed_products`, incl. images).

**`commitProduct`** — resolves the mcat, then the **CSL-collision mcat swap**: if the CSL viewed-twin with the same product name has a *different* mcat AND a browsed `category_isq`, then `id = twin.mcat` and `collisionSwapRef = true`; the seed-spec apply effect is gated on that ref so the **wrong-category prefilled specs are discarded**. This is the fix for the toffee/cake case (a bakery cake mis-filed as "Three Phase Distribution Transformers", 500 kVA/11 kV, which had matched 5 transformer sellers to a cake buyer). Then the qty/unit gate renders with units derived from the *corrected* category.

**Page 1 Specs** — buyer ISQ schema renders first; LLM 1's `page1.questions` either prefill a matching ISQ row or route to `aiSpecs`; photo/mic specs merge via `applyExtractedSpecs` (whose `replace` is gated on `source !== 'ai'` so an LLM omission can never delete a photo/mic spec); `known_truths` render as "also detected"; every LLM-1 `ask` with `<2` chips is dropped (`droppedFewOptions`).

**Pages 2 & 3** — rendered by the shared `renderCxPs`; questions come from the planners, deduped by the merge layer.

**Page 4 Your Profile & Delivery** — the deterministic merge layer + contact/delivery. **GST moved to the persona page** for non-individual personas (`showGstOnPersona = isBusinessRole && !gstOnFile`), so it is asked once, in context.

**Submission** — `buildRequirementText` appends label-resolved, deduped `cxAnswers`/`psAnswers` (they used to be dropped entirely), and `RFQSubmission` carries structured `commercial`/`persona` plus a `brain` trace.

**Published debug globals:** `window.__sourceHealth`, `__rfqConsumption`, `__rfqLive`, `__rfqCategory` (new), `__llmHealth`, `LLM_RAW_BY_ID`.

---

## 7. Orchestration + race guards

`src/lib/rfq/plannerController.ts` — pure helpers `buildSession` / `dropAnswered` / `fallbackContext` / `haveRealBrain`.
`src/lib/rfq/usePlannerController.ts` — the two firing effects for LLM 2 + LLM 3.

| guard | prevents |
|---|---|
| `fireKey = mcat:name:aiEpoch` | LLM 1 firing ~5× per product (was including a spec signature) |
| `cxFiredFor` / `psFiredFor` | re-firing a planner on every render |
| `cxUsedFallback` / `psUsedFallback` | being pinned to the fallback brain if the buyer outruns LLM 1 → **one** upgrade re-fire |
| `cxUsedNoCategory` | planning without the category → **one** re-fire when it lands late |
| `dropAnswered(env, shownKeys)` | the same concept appearing on both P2 and P3 (dedups against every *shown* commercial question, not just answered) |
| `stageRef` on auto-skip | advancing a stage the buyer already left |
| `commitGen` / `aiEpoch` / `catBrainTok` / `fetchGen` | stale async writes after the product or mcat changed |

---

## 8. The 🔬 AI-Debug inspector (`BrainDebugPanel.tsx`)

Sections, in order: **sources** (7, green/red with raw · cleaned · latency) → **live form state** → **category corpus (LLM 2 input) — every question, 1 → last** (numbered rows with `asked_pct` + real `top_values`, all four sections, coverage counters, raw-payload expander, and an amber warning when rows == 15 = the n8n cap) → **LLM calls grouped by LLM 1 / 2 / 3 / Other** (each with `model · effort · maxTok · temp`, a **sources-used chip row** parsed from the fence tags in the captured prompt with `∅` for empty sources, and the complete SYSTEM + USER + OUTPUT) → **LLM 1 → form consumption ledger** → **buyer effort score** → **requirement brain read** (understanding / persona / trustworthy / evidence-with-line-chips) → **page 1 pre-baked** → **known truths + form verdict** → **per-field reasoning + evidence** → **candidate pool** → **needs input** → **LLM 2 · Commercial planner debug** → **LLM 3 · Persona planner debug** (each: questions + chips, per-field reasoning+evidence, question-competition ledger with `basis`/`why_ranked`, needs_input).

Reusable components: `EvidenceList` (renders `source:Lnn` as a chip), `MetaDebug`, `PlannerDebugBlock`, `SourceChips`. A surfaced question with no `basis` renders amber **"no basis cited — unexplained."**

The inspector is gated to `exec === 'debug'` — Production Preview shows no debug affordance at all.

---

## 9. Locked owner decisions

- **CF-1** low-confidence category = keep filled buyer specs, drop empty, add LLM questions.
- **CF-2** precedence = deterministic client merge, no second AI call.
- **CF-3** qty from PNS/repost; conflict → suggestion.
- **CF-4** failure ladder: LLM 1 fail → keep buyer specs · LLM 2 fail → skip to P3 · LLM 3 fail → skip to last page.
- **CF-5·A** default render + hot-enhance; nothing blocks on LLM 1 (page-1 Next is never disabled on LLM-1 loading).
- **CF-6** hide unfilled buyer specs ONLY when `category_trustworthy === false`.
- **Budget** per page min 2 / prefer 3 / max 5 asks.
- **Category insights NOT in LLM 1** (both branches); LLM 2 only.
- **Collision policy** = prefer the CSL mcat at commit; discard the wrong-category specs; the product/RFQ *title* was right, the specs were not.
- **Intelligence is mode-independent** — same effort/tokens in prod and debug; only verbosity differs.
- **One model:** 3.5-flash-lite across the board.
- **`category_trustworthy` is a boolean, never a score.** Envelope is `{planner, version, questions, metadata}`.
- Naming: "Requirement Brain" (not Briefing); "Deterministic Merge Layer" (the last page).
- LLM-over-determinism: use flash-lite liberally for buyer/requirement understanding, 1–3 s latency acceptable; determinism only for the two firewall guarantees.

---

## 10. Files

**NEW (untracked) — the 3-LLM core**
- `src/lib/rfq/contracts.ts` — types, `BUDGET`, `ExecMode`, **`EffortMode`**, `SessionState`, `PlannerEnvelope`, `RequirementBrain`
- `src/lib/rfq/llm.ts` — the three prompts + runners, fences, suffixes, `applyBudget`
- `src/lib/rfq/dataLayer.ts` — every fetcher + `recordSource` health, **`fetchCategoryBrainFull`**
- `src/lib/rfq/plannerController.ts` — pure orchestration helpers
- `src/lib/rfq/usePlannerController.ts` — the LLM 2 / LLM 3 firing hook
- `src/components/rfq/DynamicRFQ.tsx` + `QuestionRenderer.tsx` — the `?rfq=brain2` blueprint
- `src/lib/specHygiene.ts` + `src/lib/__tests__/specHygiene.test.ts`, `src/components/CuratedSellerBoard.tsx`

**EDITED (modified)** — `src/components/BrainRFQForm.tsx` (main integration, ~3600 lines), `BrainFormGate.tsx` (page −1 + effort selector), `BrainDebugPanel.tsx` (inspector), `src/lib/gemini.ts` (transport, gateway fix, model), `src/App.tsx` (routes), plus `OptionChips.tsx`, `RFQModalV3/V4.tsx`, `SimpleRFQForm.tsx`, `src/lib/brains/formAdapter.ts`, `requirementBrain.ts`, `observatoryView.ts`, `rfqEvals.ts`, `sellerSearch.ts`, `src/lib/__tests__/substringGuard.test.ts`.

**Nothing is committed.** Last commit on the branch is `cadef6f "Stop the drift-detector from drifting"`. Commit before switching accounts if you want this preserved.

---

## 11. Session changelog (what was actually done)

**2026-07-30 → 07-31 · fidelity bug-hunt (24 verified bugs: 4 high / 10 med / 10 low)**
fireKey dedup · collision image graft · photo-spec delete gate (`source!=='ai'`) · LLM 2/3 fallback→real upgrade re-fire · merge layer wired (`dropAnswered`) · telemetry reset per pull · dead category-corpus fetch deleted · BES alarm gated · category source recorded. *(One fix, a 3 s PNS race-cap, was **reverted by the owner** — the PNS empty/err is server-side. Do not re-apply.)*

**2026-07-31 · modes + gaps audit (10 findings, 8 fixed)**
`browsed_specs` was **dead code** (`leafTruth.csl` IS the summary, so `cslObj.raw` was one level too deep → collision always false) · submission was lossless-broken (cx/ps answers dropped) · brain trace added to submission · Page-1 options gate · **prod/debug leak fixed** (`captureRaw` was unconditional on the prod path) · candidate-pool provenance published · LLM-2 category re-fire · P2/P3 duplicate fix + canonical field keys · GST moved to persona page · card thumbnail slot for consistent height.

**2026-07-31 · forensic case audit of GLID 254950925 (34 findings, 7 critical)**
Root cause of the cake-buyer failure, confirmed 4×: the deterministic `collision` boolean was **computed then thrown away** — it only fed `browsed_specs` and never overrode `category_trustworthy`, so the brain rubber-stamped "transformer" for a bakery cake. Fixed three ways: force `category_trustworthy:false` on collision · a COLLISION OVERRIDE prompt rule · and the owner-chosen **prefer-CSL-mcat swap at commit**. Live-verified: Page 1 became a cake spec page with zero transformer specs.

**2026-07-31 · PlannerController extraction**
LLM 2 + LLM 3 orchestration lifted out of the 3 600-line component into `plannerController.ts` + `usePlannerController.ts`, all guards preserved; LLM 1 deliberately left inline. Live-verified end-to-end.

**2026-07-31 → 08-01 · intelligence parity, then the real fix**
Discovered prod ran `low`/8000 while debug ran `medium`/12000 — prod was genuinely *dumber*, not just leaner. Unified both, stripped a "be concise and fast" nudge from `PROD_SUFFIX` … **then discovered via live probing that `reasoning_effort` had been rejected/ignored by the gateway all along** (§2.2). Fixed with `allowed_openai_params`, switched everything to 3.5-flash-lite, added the page −1 effort selector, and verified real reasoning tokens on all three LLMs.

**2026-08-01 · debug/observability + corpus completeness**
Line-numbered debug fences + `<source>:Lnn` evidence citations · `FENCE_CAP` 10k→60k (no-trim) · planner debug blocks with the question-competition ledger · `basis`/`why_ranked` per candidate · per-LLM call grouping + sources chips · complete category corpus to LLM 2 + rendered 1→last · n8n dangling-ref audit (**0 found** — the `t2` error was already resolved).

---

## 12. Reference docs

**In-repo (root):**
| file | covers | status for 3-LLM work |
|---|---|---|
| `DYNAMIC-RFQ-HANDOFF.md` | **this file** | **CURRENT** |
| `DYNAMIC-RFQ-GAPS.md` | **the 101-gap register** (see §15) | **CURRENT** |
| `AUDIT-TODO.md` (75 KB) | whole-app + both-n8n audit, 6 P0 / 23 P1 / 67 P2 | reference; many items still open |
| `AUDIT-FIX-PLAN.md` (70 KB) | the fix plan for the above | reference |
| `RFQ-FINAL-PLAN.md` (30 KB) | earlier end-state roadmap | partly superseded |
| `RFQ-STRESS-TEST-PLAN.md` (290 KB) | stress/eval scenarios | reference |
| `RFQ-FORM-TICKET.md` | the form ticket | reference |
| `WORKFLOW.md`, `DEBUG_HOD_PLAN.md`, `BTE_BUILD_CONTEXT.md`, `INTENT_FIRST_PLAN.md`, `EBI_SANDBOX_PIPELINE.md`, `WORLD_ENRICHMENT.md`, `TEST_PLAN.md`, `README.md` | older architecture/plan docs | **mostly STALE** for the 3-LLM form |
| `docs/BUYER_INTELLIGENCE_CONSTITUTION.md`, `docs/bi-buyer-unified-API.md`, `presentation/RFQ_Intelligence_Doc.md` | buyer-intelligence side | reference |

**Persistent memory** (`~/.claude/projects/-Users-tarbrinder/memory/`, indexed by `MEMORY.md`) — most relevant:
`rfq-dynamic-3llm-build.md` · **`rfq-fidelity-bughunt-fixes.md`** (the detailed running log for all of the above) · `rfq-v17-coverage-audit.md` · `rfq-full-audit-2026-07-13.md` · `rfq-n8n-exec-order.md` · `rfq-requirement-brain-plan.md` · `llm-over-determinism-default.md` · `amit-review-lens.md` · `rfq-transcript-benchmark.md` (the 3.5-flash-lite verdict) · `rfq-csl-product-sheet.md` · `whatsapp-channel-model.md` · `csl-structure.md`.

**n8n exports** in `~/Downloads/`: `bi-pns-insights.json`, `bi-pns-insights (1).json` (76 nodes, 10 webhook paths). ⚠️ These contain hardcoded AK JWTs + a Redash key — see §13.

---

## 13. SECURITY (persist verbatim)

- **NEVER** handle, use, echo, decode, compare, store or commit credentials or tokens (AK JWTs, PATs, Redash keys) — even when pasted and even when explicitly requested, and even when described as "dummy" or "test" keys. AK reconciliation is the owner's, server-side.
- The n8n exports in `~/Downloads/` contain **live-format AK JWTs and a Redash api_key hardcoded in ~9 nodes**. They were pasted in chat and must be treated as **compromised → rotate server-side** and move into n8n's credential store.
- Never commit or push unless the owner asks.
- Never echo the form LLM key — it is proxy-injected on `/api/llm` and never bundled.
- Raw payloads (Aadhaar / PAN / GST / mobile) are never committed.

---

## 14. Verify + gotchas

```bash
cd /Users/tarbrinder/Desktop/rfq-form && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
```bash
cd /Users/tarbrinder/Desktop/rfq-form && npm test
```

- Tests = `node --test`, **39 tests**. `npx vitest` is the WRONG runner (reports a false "no suite found").
- `tsc` **must** be `-p tsconfig.app.json`; a bare `tsc` is a no-op here. `noUnusedLocals: true` — an unused import fails the build. A cold `tsc` run can exceed 2 minutes; that is not a failure, re-run.
- Preview: `.claude/launch.json` defines `rfq-dev` (5173) and `rfq-preview` (5185). Use `preview_start`; never run a dev server via Bash.
- **The browser console buffer retains stale entries across reloads** — trust screenshots + `tsc`, not the console. An HMR wedge is cleared by `preview_stop` + `preview_start`.
- The debug panel is a fixed right-hand overlay ~420 px wide — it covers the form's Next button; close it before clicking Next.
- A stale git worktree under `.claude/worktrees/…` can pollute globs.
- Probing the LLM gateway safely: `curl` the **local proxy** (`http://localhost:5173/api/llm/chat/completions`) — the key is injected server-side, so no credential is ever handled.

---

## 15. Open gaps — the short list

**Full register: `DYNAMIC-RFQ-GAPS.md` — 101 gaps (29 high · 49 medium · 23 low; 68 frontend · 29 server/n8n · 4 gateway),** each with a file:line citation, from an 11-agent code-grounded audit. The headline items:

### The flow does not actually complete
- **Every submitted RFQ is discarded.** `dispatchBuyLead` builds the full `RFQSubmission` (text + specs + commercial + persona + the `brain` trace), signs it for dedup, emits the event — then calls `onSubmit?.(req)` on `undefined`, because `BrainFormGate` passes no `onSubmit`. The real BuyLead POST is a DEV-TODO. `BrainRFQForm.tsx:2074-2097`
- **The seller-search token expired 2026-06-19** (43 days ago) — the results page is likely broken for every buyer. Still fixture-bound (static buyer id / IP / city fallback). `sellerSearch.ts:29`
- **LLM 2/3 answers and the Requirement Brain never reach seller matching.** The three LLMs' whole output is absent from the search payload. `BrainRFQForm.tsx:900-913`
- **Contact is always empty and the OTP gate is always bypassed** on this route (`loggedIn` is hardcoded true).

### Nothing observes the 3-LLM path
- **Zero tests for `src/lib/rfq/`.**
- **LLM 2/3 failure is entirely silent** — no telemetry, no event, no buyer message; the page just auto-skips. `usePlannerController.ts:45-62`
- **JSON-parse failure of all three LLMs is invisible** in `LLM_HEALTH` (`recordParse` is never called from `rfq/llm.ts`).
- **Funnel + API-error telemetry never leaves the browser** — `emit.ts`'s `sendBeacon` is commented out.
- **BES instruments only Page 1 and the last page** — the entire LLM 2/3 surface is uncounted, so the one metric that counterbalances "ask more questions" is blind exactly where the planners add them.
- **The sources panel is green-on-empty** (`ok: d != null` counts `[]`/`{}`/`""` as healthy) and `safe()` throws the error object away, so a failed leaf has no status code anywhere.
- **`getISQs` — the call that GATES LLM 1 — has no health row**, along with mcat-resolve and `McatDtl`. Debugging "the brain never fired" has no instrument pointing at the real cause.
- **The 3 RFQ labels have no `PROMPT_VER` entry**, so telemetry stamps `2026.06.14` instead of `rb-v1`/`cx-v1`/`ps-v1` — every prompt change in this session is unattributable.

### Dead / inert code that looks live
- **~700 lines of engine-era question UI are structurally unreachable** (`engineDecisions` is always empty) — including the A/B conflict resolver that the **first demo scenario button advertises**.
- **`specs2` is dead by a single guard effect**, yet three live paths still branch on it; remove the guard and the seller board paints on the specs page.
- **`placement` never changes** (`setPlacement` is a no-op) → purchase-frequency never renders from that path; **`isqHints` is read but never populated**; the **eval harness** (`rfqEvals.ts`) is wired to the legacy modals only.
- **The score rail can never reach 100** once LLM 2 owns delivery/payment — 17 unfillable points plus a nudge toward a hidden field.

### Server / n8n (owner's)
- **`bi-pns-insights` ships an EXPIRED hardcoded AK** — the expiry matches the owner's "PNS is a server-side issue" note to the hour.
- **`bi-pns-insights` has NO PII strip** — the raw PNS payload is returned to the browser *and fenced into the LLM prompt*. The category path has a strip; this one does not.
- **`pns=full` is a label-only alias of `pns=api`**; **`mcat_id` is accepted, documented REQUIRED, echoed back, and never forwarded upstream**; only page 1 is fetched while the unused sibling path paginates.
- **`bi-category-brain` budgets up to ~185 s against a 30 s browser abort**, and **reports GREEN on a Redash failure** — so "empty category" and "broken pipe" are indistinguishable.
- **`asked_pct` can exceed 100** (per-product·spec counting vs per-row parsing) and reaches LLM 2 unclamped as ranking truth.
- **CSL emits `searched`, the frontend's typed reader looks for `searches`.**
- **`bi-csl-parser` aborts the whole run on one upstream blip** → the browser gets a 500, not an empty skeleton.
- **Every secret is a hardcoded literal**, several in URL query strings; no error workflow, no execution timeout, no alerting when the daily-expiring token dies.
- Category output truncated to top 15 specs / 5 values / 6 personas / 10 keywords / 8 products, with **no pre-truncation totals emitted**.

### Gateway / model
- **`allowed_openai_params` making `reasoning_effort` real for the first time REMOVES thinking from ~9 call sites and ADDS it to ~10** — every `reasoningEffort` value in the estate was previously decorative. In particular `'none'` was never probed and now lands on the two buyer-visible multimodal calls whose parse failure returns an empty result.
- The **buyer-profile card** risk described in §2.1.

### Architecture drift
- **`?rfq=brain2` has fallen behind**: it ignores the page −1 effort selector (always `high`), still sends only `sellerSpecs` as `category_engine` (so it gets the shape the prompt no longer describes), and re-implements the same flow with fewer guards.
- **`dataLayer` is only half-adopted** — the live route re-implements the spec fetches inline; `resolveMcat`/`fetchBuyerSpecs` serve `brain2` only.
- **The LLM-1 collision override is now nearly unreachable** — the commit-time mcat swap resolves the collision *before* the brain runs, so `browsed_specs` is normally absent and the prompt rule only fires in a `leafTruth`-late race. Intentional, but the two fixes now overlap.
- **LLM 2/3 planner debug renders only inside the `plan?.brain` branch**, so it disappears whenever LLM 1's raw output is missing or unparseable.
- **A chip-less `prefill`/`confirm` on Pages 2/3 renders as a raw text box** (only `ui:'ask'` is chip-filtered), and an **untouched prefill is lost from the submission** — the same row is both the costliest to answer and silently dropped if left alone.


---

## 16. Fix pass — 2026-08-01 (post-audit)

Everything here is `tsc`-clean, **79/79 tests** (was 39), and live-verified on GLID `254950925`. Still **nothing committed**.

### Found by live probing (worse than the audit predicted)
1. **The buyer-profile card was hard-401ing.** `RFQ_FORM_LLM_MODEL = MODEL_FAST` pointed the card at 3.5-flash-lite, but `/api/cardllm` uses a different, entitlement-capped key: `team not allowed to access model. This team can only access models=['google/gemini-2.5-flash-lite']`. Every card call failed into a silent empty-card fallback. **Fixed:** new `MODEL_CARD = 'google/gemini-2.5-flash-lite'` pin, with the probe recorded in the comment. The form keeps 3.5-flash-lite (its team *is* entitled). Widening the card team's entitlement is a server-side decision.
2. **`reasoning_effort: 'none'` is rejected:** `Reasoning is mandatory for this endpoint and cannot be disabled.` Harmless before (the param was being dropped anyway), but now that effort is real it would 400 + burn a retry on every voice/photo/summarise/classify call. **Fixed:** `'none'` is no longer forwarded (nor is its `allowed_openai_params` companion); telemetry still records `none`.

### The three regressions — all fixed
3. **captureRaw** restored on the five dashboard-side calls whose consumers (`downloadProfile`'s "nothing hidden" HTML, `BuyerLedgerView`'s UC2 band) are themselves inspection tools. The **form's prod mode stays clean** — that leak fix stands.
4. **`catCorpus` staleness** — now cleared on the seed short-circuit too, so LLM 2 can no longer be fed the previous category's corpus.
5. **Category double-execution eliminated.** One `fetchCategoryBrainFull` per commit; the distilled `{q,pct,vals}` feed is derived locally via new `distillCategory()`. Verified live: **one** `bi-category-brain` request, where there were two.

### Prod/debug fidelity
6. **Truncation parity** — `FENCE_CAP` now applies to the *compact* serialization in both modes, so debug can no longer truncate earlier than prod (it did, because the numbered fence pretty-prints). New shared `safeStringify` also means a circular payload degrades to `(unserialisable input)` instead of throwing.
7. **Empty means empty** — `{}` now renders `(none)` like `null`/`[]`, so source chips stop reporting empty inputs as present.
8. **`PROMPT_VER`** entries added → verified live: the brain call now stamps **`rb-v1`** (was the build date `2026.06.14`).

### Observability
9. **`recordParse`** on all three RFQ LLMs → verified live: `parseOk: true` on the brain. A 200-with-bad-JSON is no longer indistinguishable from a clean run.
10. **Planner failure is attributable** — LLM 2/3 empty-or-thrown now emits `emitApiError` with the distinction between "returned no questions" and "returned null (parse or transport failure)". The auto-skip stays (CF-4).
11. **Green-on-empty fixed** — new `hasPayload()`; `safe()` now retains the last error per source (`getSourceError`). Verified live: `Category · bi-category-brain` correctly reports **`ok: false`** on an evidence-less corpus.
12. **New health rows** — verified live, **9 sources** now: `Category resolve · mcatid-suggestion` (and it records whether the **CSL collision swap** fired) and `Specs · getISQs (buyer+seller split)` — **the call that GATES LLM 1**, previously invisible. Its `cleaned` payload carries the full buyer/seller spec split.
    - *Your question answered:* the collision swap sets `id` **before** the ISQ fetches, so the **new (correct) mcat's buyer ISQ is what gets fetched and rendered**. Buyer specs are always visible (prefilled or as a question); only when `category_trustworthy === false` are *unfilled* ones dropped (CF-6).
13. **BES now instruments pages 2/3** (`renderCxPs`) — a prefilled row left untouched counts as `confirm`, not an ask.
14. **`recordLLM` failure path** carries `id` + the effort actually sent, so the `(stripped)` indicator survives a failure.
15. **Planner debug moved OUTSIDE the `plan?.brain` branch** — LLM 2/3 traces no longer vanish when LLM 1's output is missing or unparseable.

### Contract / render
16. **Chip-less `prefill`/`confirm` on P2/P3** no longer renders a bare "Type your answer" box pre-filled with our guess; it renders as a known value with an explicit change affordance.
17. **Untouched prefills now reach the submission** — answers are seeded from `prefill`/`confirm` values (never clobbering a buyer edit), so "left it alone" means "accepted", as the UI implies.
18. **The commercial prompt is shape-tolerant** — it now describes BOTH the full corpus and the distilled `{q,pct,vals}` array, and says explicitly that `calls_analyzed: 0` means no evidence → use `own_knowledge` rather than inventing a citation.
19. **`?rfq=brain2` threads effort** (`SimConfig.effort`, default `high`) instead of silently hardcoding it.
20. **`asked_pct` clamped 0..100** client-side (the node can emit >100) and **CSL `searched`/`searches`** both accepted.

### Dead-code landmines removed
21. **The `specs2` stage is GONE** — union member, stepper label, corrective effect, the auto-skip that targeted it, `specSplit`, `prefillStage`, `specGroups`, `plannerRowCount`, `emptyPlannerSkippedFor`, `specsTouchedRef` and `prefilledSpecNames`. It was dead-but-reachable: no render case existed for it, so anything outside `{specs, commercial, persona, more}` fell through to the **results body** — one guard away from painting the seller board mid-form.
22. **Demo-scenario notes re-based** — the first button no longer advertises the retired A/B resolver.
23. **Two misleading comments corrected** (the seller-search trigger, the landing-gallery gate) and the unused `fetchCategoryEngine` alias removed.

### Tests — 39 → 79
`src/lib/__tests__/rfqCore.test.ts` covers `dropAnswered` (incl. the shown-but-skipped rule and blank≠answered), `haveRealBrain`, `buildSession`/`fallbackContext`, `applyBudget`, the option-chip contract, and **fence/fenceNumbered parity + cap + `(none)`** — so fix 6 is now regression-protected. It loads the real shipped source with a stubbed transport (no network).

**It also found a real bug, now fixed:** `applyBudget`'s keep-set held **field names**, so duplicate canonical keys all got re-admitted — 8 asks over fields `a,b,c,d,e,a,a,b` all survived a max of 5. It now keeps question *identities*. The planner prompt hands the model a fixed list of 11 canonical keys, so a repeat was the expected failure mode, not a freak case.

### n8n — `bi-pns-insights-FIXED.json`
All 20 workflow fixes applied to `~/Downloads/bi-pns-insights (2).json` → **`~/Downloads/bi-pns-insights-FIXED.json`**. Nodes 76 → 85; all 10 webhook paths and every credential literal **byte-for-byte unchanged**; no HTTP calls were made (your token budget untouched). Highlights: a **fail-closed PII strip on the PNS path** (it had none); `pns=full` now honestly reports `full_supported:false` + `mode_effective` (rewiring to the transcription chain was rejected — those 6 nodes read `$('t2')` by name and would return empty off this path); `MCAT_ID` forwarded upstream; real pagination (cap 10) that re-reads the upstream body rather than duplicating the credential; the category budget cut to ≈26s against the 30s client abort with an explicit `status: ok|redash_error|poll_timeout|empty`; `asked_pct` fixed at source (was 300% on one call × 3 products) and clamped; spec cap 15→40 **plus pre-truncation totals**; a real `wa-merge` barrier; 6 input guards; retries and timeouts on the critical fetches; `pinData` removed.

**Owner steps that JSON cannot do:** create + attach an error workflow; **rotate and vault the inline credentials** (they are plaintext in the export); open each of the 6 new If guards once to confirm the filter reads "is not empty"; decide whether `redash-`'s `max_age: 0` should allow a cache age; and import into a **test** workflow first — nothing is live-verified.

### Still open (deliberately)
- **BuyLead POST** — the submission still has no consumer. Needs a real endpoint + auth; I won't invent one.
- **Seller-search token** — expired 2026-06-19. It is a credential; not mine to handle.
- **~700 lines of engine-era UI** — still inert but present. Its own pass, not a batch item.
- **Score rail can't reach 100** — needs your call on the weights.
- **`emit.ts` `sendBeacon` is commented out**, so funnel/API-error telemetry (including the new planner-failure events) still never leaves the browser. One line + a collector URL.
