# Buyer Twin Engine (BTE) — Build Context & Continuity Doc

> Single source of truth for the IndiaMART RFQ → **Demand Understanding Engine** rebuild.
> Written to preserve full context across the conversation boundary. Read this first.

---

## 0. What we are building (the vision)

We are **NOT** building a static RFQ form, a decision tree, a category questionnaire, or a spec-collection engine.

We are building a **Buyer Twin Engine (BTE)** — a persistent, evidence-grounded buyer-intelligence layer. The RFQ is just its **first consumer** (later: matchmaking, BMC, search ranking, seller recos — all consume the same Twin). Also called the **Demand Understanding Engine (DUE)**.

**Core philosophy:** Most RFQ systems ask *"what specs should I collect?"*. This asks *"what is the most valuable unknown right now?"* — optimize for **maximum understanding with minimum questions / reduce uncertainty**, not form completion. Every question must justify its existence.

**The reasoning spine:** `INTENT → PERSON → PII` (each stitches confidence into the requirement).
**The funnel inversion (target):** `Intent → Scale → Constraints → Specs` (specs become last & optional, surfaced only when they're the highest-information-gain unknown). *We have NOT done this inversion yet — it's Phase 5.*

**Must work across ALL categories, ALL buyer types, new + existing buyers — WITHOUT hardcoding category logic.**

**Convergence:** 3 independent reviewers (the user + ChatGPT + Gemini) converged ~96% on this architecture. Phases 1–4b are reviewer-approved. Remaining risk is **production calibration** (50 → 500 → 5000 real GLIDs), not architecture.

### The 4 guardrails (non-negotiable, enforced everywhere)
1. **Confidence-&-Bias Gate** — never auto-fill brand/preference; confidence tiers (>90 silent / 60–89 suggest / <60 ask).
2. **Anti-hallucination** — every inferred value must cite real evidence or be dropped (grounded; no fabrication).
3. **No hardcoding** — behaviour comes from data (ISQ) or LLM classification, **never** `if (name.includes('diesel'))`-style literals. (Universal English procurement keywords like "brand/make" as a *safety net* are OK; category names are NOT.)
4. **Structured JSON only** — every LLM call returns strict JSON, validated in code.

---

## 1. Repo / stack / how to run

- **Path:** `/Users/tarbrinder/Desktop/rfq-form` (always `cd` here first — bash cwd drifts).
- **Stack:** React 18 + TypeScript + Vite + Tailwind.
- **Build/verify:** `npm run build` (runs `tsc -b && vite build`). Keep it green after every change.
- **Preview:** `preview_start` name `rfq-dev`, port 5173 (restarts between sessions). Debug mode: append `?debug=1` to the URL → 🐞 toggle + all debug panels.
- **LLM gateway:** `imllm.intermesh.net/v1/chat/completions` via Vite proxy `/api/llm`. Key `VITE_LLM_KEY` in `.env`. `response_format: json_object`.
- **Models:** `MODEL_FAST='google/gemini-2.5-flash-lite'` for ALL structured/text. `MODEL_RICH='google/gemini-2.5-flash'` ONLY for `analyzeImage`/`voiceToSpecs`.
  - **CRITICAL learning:** `flash` is a reasoning model — runaway reasoning_tokens (1.9k–3.9k) eat `max_tokens` and **truncate JSON** (`finish_reason:"length"`). Use flash-lite for anything structured.
- **Enrichment webhook:** `imworkflow.intermesh.net/webhook/user-insights-glid123?glid=` via proxy `/api/imworkflow`. (⚠ the path is `…-glid123`, NOT `…-glid` — the latter is a dead/old endpoint that returns empty; using it was the cause of every "no data found" + "flaky webhook" earlier.) Returns 7 sources: `csl_data, pns_data, prev_isq_data, whatsapp_data, prev_bl_data, whatsapp_inbound, buyer_profile` (the `buyer_profile` node can independently auth-fail per-GLID → other 6 still resolve).
- **Test GLIDs:** `6732501` (Rajeev Nanda / Nanda Traders, Gurugram — bag MANUFACTURER + multi-SKU trader; PVD coating, PET jars, silicone moulds, karaoke mic, dehydrator; WhatsApp-heavy 109 msgs, local pref, low delay tolerance). Raw dump cached at `/tmp/glid6732501.json`. Earlier: `267885237` (Oil Expellers).
- **OTP:** static `1234` (demo). **Login:** demo autofill (Rajesh Kumar).

---

## 2. File map

| File | What |
|---|---|
| `src/components/RFQModalV3.tsx` | **Main component** (huge). Form flow, all UI, all effects, debug panels. |
| `src/lib/gemini.ts` | All LLM prompts + functions (planner, twin compiler, gate, hints, cascade, look-ahead, deduce, summary). |
| `src/lib/enrichment.ts` | `deriveEnrichment` (pure transform → EnrichmentProfile + signals/digest), all Twin types (BTE-v1.2), `matchCategory`. |
| `src/lib/questions/types.ts` | DynQuestion, RequirementPlan, Segment, PlanQuestion types. |
| `src/lib/questions/segment.ts` | `classifySegment` (regex — **to be killed in Phase 4c**). |
| `src/lib/questions/seed.ts` | Seed questions (generator fallback). |
| `src/lib/api.ts` | `api()`/`getJSON`/`postJSON` (Vite proxy paths). |
| `src/lib/supabase.ts` | `localDB.saveSubmission(Record<string,unknown>)` (loose). |
| `vite.config.ts` | Proxies: `/api/llm`, `/api/imimg`, `/api/suggest`, `/api/mimart`, `/api/imworkflow`. |
| `scripts/*.mjs` | Node test harnesses (read `.env`, hit gateway directly). See §6. |

---

## 3. The BTE-v1.2 Twin schema (in `enrichment.ts`)

```ts
TwinSource = 'pns'|'whatsapp'|'csl'|'bl_history'|'isq'|'profile'
TwinEvidence = { source: TwinSource; date: string; signal: string }
TemporalInferredTrait = {           // (InferredTrait = alias)
  value: string|boolean|number;
  confidence: number;               // 0-100, certainty NOW
  trait_stability: number;          // 0-100, consistency over time — CODE-derived
  contradictions_count: number;     // conflicting signals — LLM-flagged
  last_seen: string;                // most-recent evidence date — CODE-derived
  evidence: TwinEvidence[];         // receipts; trait DROPPED if none grounded
}
IntentCluster = { intent: string; signal_count: number; last_seen: string }

BuyerTwin = {
  glid; compiled_at;
  buyer_version; major_profile_shift_detected;        // shift = company_desc role vs current intent
  twin_generation_time_ms?; total_signal_count?;
  twin_confidence: { overall_score; evidence_base{pns_calls,whatsapp_events,bls_created,csl_events};
                     freshness:'Fresh'|'Moderate'|'Stale'|'Unknown'; last_signal_at };
  explicit_unknowns: string[];        // the Question Planner's queue (traits w/ no evidence) — CODE-derived
  explicit_negative_signals: string[];// the "Not" profile (hard constraints) — never inferred
  layer_a_identity: { city; state; business_type; secondary_roles?[]; language; verified; company_desc };
  layer_b_behavioral: { whatsapp_affinity?, catalog_driven?, image_affinity?, local_preference?,
                        response_sensitivity?, decision_style? }   // each optional TemporalInferredTrait
  layer_c_commercial_intelligence: { inventory_builder?, multi_category_buyer?, bulk_orientation?, trial_first?,
                        historical_categories[]; recent_intent_clusters[]; buyer_intent_history{};
                        current_active_intent?; attribution_confidence{inferred_product_mapping,confidence} }
  summary: string;
}
```

**CODE-derived (never LLM-guessed → can't hallucinate):** `twin_confidence.overall_score` (saturating formula `0.35·sat(pns,3)+0.25·sat(wa,30)+0.25·sat(bl,4)+0.15·sat(csl,20)`), `freshness`/`last_signal_at`, every trait's `last_seen` + `trait_stability`, `explicit_unknowns`, `business_type` fallback (from company_desc keywords), `major_profile_shift_detected`.
**LLM-derived (grounded + validated):** trait `value`/`confidence`/`evidence`/`contradictions_count`, `secondary_roles`, `recent_intent_clusters`, `explicit_negative_signals`, `attribution`, `summary`.

**Heavy ⇄ Lite contract:** Heavy pass (`deriveBuyerTwin`) compiles the Twin ONCE on GLID-resolve → cached on `window.__buyerTwin`. Lite passes only READ the compiled Twin (sub-second). In prod the heavy compile is a backend job; in this form it's one call on GLID pull.

---

## 4. Key functions in `gemini.ts`

- `planRequirement(args)` — Intent Planner. Reads category + qty + persona/prior + **buyerProfile** → `RequirementPlan{archetype, orderMode, specOrder[], lead{source,ref}, leadingQuestion, mustHaveSpecs[], personaOptions[], questions[], serveSignals[]}`. Chips-only, ₹, no covered-field dupes, no brand questions. flash-lite, maxTokens 2048.
- `deriveBuyerTwin(args)` — **THE heavy pass** → BuyerTwin (BTE-v1.2). Grounded evidence (drops ungrounded via `grounded()`), vocab-snap (drops off-vocab values), per-trait `norm()`, code-computed temporal/confidence/unknowns/shift. flash-lite, maxTokens 3000.
- `deriveBuyerProfile(digest)` — OLD flat profile (BuyerProfile). **Still runs alongside deriveBuyerTwin** (2 LLM calls on GLID pull) because the planner/look-ahead/deduce threading still consumes the flat `buyerProfile`. **Phase 5 should unify onto the Twin and delete this.**
- `classifyFieldTypes(productName, isqSpecNames)` — **the VEKA killer.** LLM + keyword net → `{preference[], objective[]}`. Brand/make/manufacturer/OEM/model = preference = NEVER auto-filled.
- `classifyFieldTypes` keyword net const: `PREFERENCE_KEYWORDS` (gemini.ts) / `PREFERENCE_RE` (RFQModalV3.tsx) — universal, not category-specific.
- `getSpecHints(productName, isqSpecNames, isqSpecsWithOptions, twinContext?)` — name-detect specs + hints + redundant. **Filters brand out of `knownFromProductName` at source** + prompt bans brand inference. **(5a)** takes a PII-free/brand-free `twinContext` used ONLY to sharpen `isqHints` — never to fill `knownFromProductName`, never a brand.
- `inferSpecsFromApplication` — used by the cascade + Assist. Maps application → spec values.
- `refineQuestions(args)` — the **look-ahead**: re-tailors not-yet-shown panel questions from what's known (e.g. Usage=Salon → "salon size").
- `deduceLogistics(args)` — last-page belief: predict timeline/payment with confidence; ≥0.8 pre-fill, else ask.
- `generateEnrichmentQuestions` — flat generator (fallback when planner fails).
- `explainSpec`, `summarizeRequirement`, `analyzeImage`, `voiceToSpecs` — supporting.
- `indiaize(s)` — ₹/India sanitizer applied to LLM outputs.
- De-dup backstops: `blockedSpecTopicTokens`+`reAsksSpec` (uses the dynamic live-ISQ token block + **`UNIVERSAL_SPEC_SYNONYMS`** — universal procurement concepts only, post-4c; the genset families are gone), `FORM_COVERED_RE` (quantity/delivery/timeline/payment/location — never re-ask), `hasChips` (chips-only).

---

## 5. Phase status

| Phase | Status | What |
|---|---|---|
| **1 — Heavy Twin Compiler** (BTE-v1.1) | ✅ | `deriveEnrichment` evidence pool (`signals[]`, `companyDesc`, `cslBrowse`, `intentHistory`, `evidenceBase`) + `deriveBuyerTwin` + `window.__buyerTwin`. Additive (existing threading untouched). |
| **1B — v1.2 hardening** | ✅ | Evidence ledger; temporal (`last_seen`/`trait_stability`/`contradictions_count`); intent split (`buyer_intent_history` vs `current_active_intent`); `explicit_unknowns`; `explicit_negative_signals`; `attribution`; `recent_intent_clusters`; anti-fabrication pool-grounding; vocab-snap. |
| **2 — Debug View + surfacing** | ✅ | `renderTwinDebug` (click-trait → evidence ledger); **Buyer Context line in "Your Requirement"** (no PII, seller-facing); **PII only in debug**. |
| **3 — Calibration Gate** | ✅ | Freshness badge (🟢🟡🔴⚪) + confidence-source mix %; `twincalib.mjs` scenarios; business_type-from-company_desc + company_desc-based shift fixes. |
| **4a — Tweaks** | ✅ | `twin_generation_time_ms`, `total_signal_count`, `secondary_roles[]` (multi-intent), contradictory-locality calib test. |
| **4b — Confidence-&-Bias Gate (VEKA Killer)** | ✅ | `classifyFieldTypes` + brand BLOCKED across all auto-fill paths (getSpecHints source-filter, `applyAiSpec`, cascade targets, knownFromProductName merge) + "open to all" hint + `🔒 preference·no-autofill` debug tag. Verified: classifytest 10/10, live upvc Profile Brand gated. |
| **4c — De-hardcode (MEASURED)** | ✅ | Killed `SPEC_TOPIC_GROUPS` genset families (kVA/diesel/radiator/ATS/phase/voltage/noise/cooling) → `UNIVERSAL_SPEC_SYNONYMS` (universal procurement concepts only) + kept the dynamic live-ISQ token block. **KEPT `classifySegment`** per ChatGPT's rule "remove category *assumptions*, keep deterministic *detection*": it routes API facts (`mcatType`,`hasUnits`; regex is only a backstop) → a depth budget, never dictates questions. Planner regression green across categories. |
| **4-polish — gate_decisions + brand-trap** | ✅ | ChatGPT review items. `gate_decisions` paper trail — every auto-fill verdict (`filled`/`blocked_autofill`/`blocked_manual`) + classification/reason/path; debug panel + `window.__gateDecisions`. `applyAiSpec` hardened with `PREFERENCE_RE` belt (blocks brand even before `classifyFieldTypes` resolves). `scripts/brandtrap.mjs` **12/12**. |
| **5a — Twin everywhere** | ✅ | `twinPromptContext(t)` (PII-free, brand-free, grounded-only) + `liveTwin()` window accessor, threaded into `getSpecHints` (hints only — never fills/brands) + `explainSpec` (sharpens "likely"). Skipped `summarizeRequirement` (Twin already surfaced via `twinContextLine`). Debug trace shows `twin=` passed. |
| **5b — Soft funnel inversion** | ✅ | Twin-aware planner (the "ruthless editor"): **FAST-TRACK** (conf≥60 + known facts → don't re-ask; **code-capped to 3 cards**, no backfill) · **COLD-DISCOVER** (conf<50 → lead intent+scale before specs) · **OFF-PROFILE circuit-breaker** (current product shares no token with history → no fast-track, force intent). `tier` tagging (intent→scale→constraint→spec) reorders the panel via `order`. **Question-budget metric** in debug (`asked / twin-skipped / mode / tiers`) + `inversiontest.mjs` proves the North Star: Rajeev 3 cards vs cold 5. |
| **5c — Concierge confirmation** | ✅ | `conciergeTraits(twin)` bundles high-conf (≥70) commercial traits into ONE card ("👋 Welcome back — we found these likely details… [Yes, continue] [Something changed]"), code-composed (not LLM-hoped). Gates specs when fast-tracked; auto-open wizard suppressed while pending (no ambush). **Yes** → accepted, specs revealed. **Something changed** → `twinMuted` → re-plan via off-profile path (discovery, cap lifted, relearn). `confirmation_accept_rate` telemetry (`window.__conciergeStat` + debug). **Verified live on Rajeev 6732501**: fast-track card with 4 bundled traits; Yes→specs (yes:1); Changed→discovery (off_profile, yes:0). |
| **5d — Unify onto Twin** | ⏳ | Replace flat `buyerProfile` consumers (planner/refine/deduce) with a Twin adapter; retire `deriveBuyerProfile` (kills the 2nd GLID-pull LLM call). |
| **6 — Scoring + discovery + "why"** | ⏳ | 3 live confidences (Product/Requirement/Buyer) drive focus (planner attacks lowest); score-ring = requirement_confidence; unknown-product discovery ("need something for waterproofing" → propose categories, don't force MCAT); **"why this requirement exists"** field (intent-root, highest signal). |
| **7 — Lock fidelity + prod** | ⏳ | Invariant harness as **build-gate** (no-brand · evidence-required · intent-order · no-hardcode · valid-JSON → red fails build); chaos/E2E; prod blockers (below). |

**Realistic in-form ceiling vs DUE = ~95%.** The last ~5% is backend/platform (see §8) — don't smuggle it into the form.

---

## 6. Test harnesses (`node scripts/X.mjs`, read `.env`)

- `plantest.mjs` — planner across 8 categories + asserts chips-only · ₹-only · no form-field dupes.
- `bptest.mjs` — `deriveBuyerProfile` on a dump.
- `hintstest.mjs` — getSpecHints brand-leak repro (the original VEKA reproduction).
- `twintest.mjs <dump>` — `deriveBuyerTwin` (BTE-v1.2) on a real dump + grounding/evidence assertions. **Last run on 6732501: 9–11/11 traits grounded, 0 fabricated, twin_confidence 87.**
- `twincalib.mjs` — **6 calibration scenarios**: BlankSlate(cold→degrade), Conflicting(Trader→Mfr→shift), Stale(18mo→Stale), Sparse(1 msg→low/no-overclaim), WrongSignal(Mfr→Karaoke→**off-profile signal must be represented in active intent OR clusters, not dropped** — robust, no longer slot-specific), ContradictoryLocality(contradictions>0). **12/12 checks pass.**
- `classifytest.mjs` — field-type classification (VEKA killer) across 5 categories. **10/10: brand gated, objective kept.**
- `brandtrap.mjs` — VEKA killer under pressure: "Kommerling UPVC"(explicit→observed, not filled) · "UPVC Window"(generic→blank) · "VEKA equivalent"(equivalent-guard→VEKA not selected) · objective control. **INVARIANT: brandAutoFilled===false under all inputs. 12/12.**
- `inversiontest.mjs` — **Phase 5b acceptance / the North Star metric**: same category, COLD vs WARM(high-conf twin) vs OFF-PROFILE. Asserts known⇒fewer cards (WARM≤COLD, capped ≤3), fast-track engaged (twinResolved>0), cold leads intent/scale, off-profile circuit-breaker holds. **6/6.**

These are the **never-miss safety net** (Phase 7 turns them into a CI build-gate). Run them after any prompt change.

---

## 7. Existing form features still live (the "RFQ" the Twin powers)

Built before the BTE work, all functioning:
- **Intent Planner** drives spec triage (top-3 by `specOrder`, lead floated to #1, `lockedSpecOrder` so late planner never reshuffles), persona options, panel questions.
- **One-by-one panel wizard** ("A few details → sharper quotes"): `panelItems` (dyn questions + role card), `panelFrozen` snapshot-on-open (anti-jitter), auto-open-once, chips-only.
- **Progressive cascade** (lead/manual spec → infer remaining empty specs, marked "✦ Suggested", never overrides manual, debounced) — now **gated** (no brand).
- **Adaptive look-ahead** (`refineQuestions`) — re-tailors upcoming panel questions from answers; only mutates cards ahead of cursor (anti-jitter).
- **Last-page belief** (`deduceLogistics`) — pre-fills timeline/payment ≥0.8 confidence as "✦ noted", asks the rest.
- **buyerType deduction** from a spec value matching a personaOption (token overlap) → skips the role card.
- **Debug provenance** everywhere: `promptTraces` (📡 which prompt + inputs), per-question "surfaced by X · why · passed", per-spec source tags, `planTrace`.
- **India context** (₹/lakh/crore) in all prompts + `indiaize` guard. **Chips-only** questions. **FORM_COVERED_RE** guard (never re-ask quantity/delivery/timeline/payment/location, incl. hidden delivery-location field).
- Submission payload carries full PII + derived profile (`buyer_pii`, `buyer_profile_derived`, etc.) — debug stance.

---

## 8. Production blockers (Phase 7 / backend roadmap — NOT in-form)

- **Server proxy for enrichment** — strip buyer contact (the paid lead) + resolve GLID from the **authenticated session** (never trust a client-supplied GLID — spoofing). Currently the form fetches raw client-side with PII (intentional DEBUG stance; PII-safe contract preserved in git history).
- **Real OTP / SSO** (currently static `1234`).
- **Backend buyer-master** — cross-session Twin persistence + writeback (Twin currently compiled per-fetch, not persisted) + the OTHER consumers (matchmaking, BMC, search ranking, seller recos) reading the same Twin. The schema is built to plug in.
- **Vernacular / Hindi i18n** — buyers' `primary_language` is often Hindi (huge India-B2B lever).
- **CI invariant-harness gate** (Phase 7).

### ChatGPT's 4 future-roadmap items (post-Phase-5 / need production learning — NOT blockers, logged so they're not lost)
1. **Twin Drift Detection** — beyond `major_profile_shift_detected` (binary): a continuous `drift_score` (e.g. 0.72) tracking gradual behaviour change over years (Manufacturer→trader-like). Needs snapshot history (#3).
2. **Source Trust Weighting** — not all signals are equal: **buyer *said* > buyer *clicked* > buyer *viewed***. A PNS transcript should outrank a CSL browse when they conflict. Today all sources contribute via the saturating formula; add per-source trust weights. (Phase 6/7.)
3. **Twin Snapshot History** — `buyer_version` is stubbed. Persist Twin v1/v2/v3 so "why did the Twin change?" has an auditable answer. Needs backend buyer-master.
4. **Marketplace Outcome Feedback Loop** — the biggest missing loop. Today: Signals→Twin→RFQ. Target: Signals→Twin→RFQ→**Outcome**→Twin. "Buyer *always selects* a local supplier after quotes" is far stronger than "buyer *once said* local." Closes the learning loop; needs post-RFQ outcome capture.

---

## 9. Key learnings / gotchas (don't relearn the hard way)

- **flash-lite for structured, flash only image/voice** (truncation, §1).
- **Enum drift fix:** placeholder format `"value": "<one of: Low, Medium, High>"` + a worked example + code-side `norm()`/vocab-snap (drop off-vocab). Models echo the option list otherwise.
- **Anti-fabrication:** validate LLM evidence against the real signal pool (`grounded()` — 25-char substring overlap); drop ungrounded. The model paraphrases ~1/5 runs.
- **No hardcoding:** any `if (name.includes('<category>'))` is a bug. Use ISQ data + LLM classification. Universal procurement keywords (brand/make/quantity/delivery) as safety nets are fine; category names are not.
- **Anti-jitter:** snapshot lists on open (`panelFrozen`), lock orders (`lockedSpecOrder`), only mutate cards ahead of the cursor, debounce by signature. The user is very sensitive to mid-interaction UI changes.
- **Two memory objects:** `buyerProfile` (old flat, still threaded) + `buyerTwin` (new, BTE-v1.2). Phase 5 unifies → Twin only.
- **`twincalib` fixtures must use the REAL webhook keys** (e.g. `glusr_usr_company_desc`, `ETO_OFR_TITLE`, `ETO_OFR_POSTDATE_ORIG`), not invented ones — a fixture-key mismatch silently breaks tests.
- **cwd drift** — prefix bash with `cd /Users/tarbrinder/Desktop/rfq-form &&`.
- **Preview** restarts between sessions (`preview_start` `rfq-dev`). Vite proxy changes need a server restart.
- **Date.now()/Math.random()** are fine in app code (the throw-restriction is only inside Workflow scripts).

---

## 10. The convergence (what ChatGPT/Gemini said)

- Phase 1 (Twin), 2 (Visibility), 3 (Calibration), 4a/4b (Gate) — **all approved.**
- Architecture risk is gone; remaining risk is production calibration at scale (50/500/5000 real GLIDs) — which only real traffic resolves.
- ChatGPT's 3 standing guardrails for Phase 4+: **never infer brand from the Twin**, **track gen-time + signal-count**, **test contradictory-locality** — all ✅ done.
- Open future ideas (noted, not built): `secondary_roles` for multi-role buyers (✅ added), behaviour-outweighs-stale-profile, "wrong company description" handling, twin source-distribution (✅ added as confidence-mix).

---

## 11. Immediate next step — PILOT (frozen), not more code

Both ChatGPT and Gemini reviewed the full Phase 1→5c implementation: **no major architectural misses; the engineering phase is complete.** Their unanimous next step is **Option B — pilot before 5d** ("real buyer data > more AI design"). 5d is clean engineering but teaches nothing new and would break the freeze right before a pilot. So:

1. **FREEZE the frontend** (done — `why_fast_track`/`why_discovery` was the last pre-pilot add).
2. **Route ~100 real GLIDs** through the form (operational — team runs this).
3. **Watch the ONE metric both AIs care about most — Concierge Acceptance Rate** (`window.__conciergeStat` = `{yes,total}`; the `rfq_concierge_confirm` track event has `{accepted}`). Plus question-reduction (`questionBudget.asked` vs cold baseline) and completion rate.
   - **>85%** → Heavy compiler is solid, scale up.
   - **<60%** → read `window.__twinWhy` / `why_fast_track` to see WHICH trait is noisy (e.g. `current_active_intent`="Product evaluation") and tune the compiler.

**Deferred until AFTER the pilot (Phase 6+, need production learning — logged in §8):**
- **5d** — unify planner/refine/deduce onto the Twin; retire `deriveBuyerProfile` (the 2nd GLID-pull LLM call). Low-risk cleanup, do during/after pilot.
- **Phase 6** — 3-confidence scoring (Product/Requirement/Buyer) · unknown-product discovery · "why this requirement exists".
- **Phase 7** — lock fidelity (`nohardcode.mjs` grep gate + invariant harness as CI build-gate) + prod blockers (§8).
- **The 4 outcome layers** (§8): Outcome Feedback Loop · Source Trust Weighting · Twin Drift · Snapshot History.

### Polish backlog (non-blocking; found in 5b/5c LIVE runs on 6732501)
- **Off-profile short-name edge:** a product whose tokens are all <4 chars ("TMT Bar") yields no tokens → off-profile can't be assessed → defaults to fast-track. Mitigated by the "Something changed" escape hatch. Consider lowering the token threshold.
- **Discovery intent-lead compliance:** in `off_profile`/cold mode the planner is told to lead with INTENT but sometimes leads with SCALE (LLM variance). Mode/cap/telemetry are correct; the lead-tier is soft. Tighten the prompt or code-force an intent-first card if data shows it matters.
- **`current_active_intent` quality:** Rajeev compiled to a vague "Product evaluation" (shows verbatim in the concierge card) — a Heavy-compiler tuning item, ties to ChatGPT's `confirmation_accept_rate` feedback loop (low accept-rate ⇒ tune the compiler).
