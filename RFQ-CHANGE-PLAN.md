# Smart RFQ — Proposed Change Plan (for owner review)

**2026-08-03.** Every proposal is tagged with the evidence that justifies it. Nothing here is implemented unless it appears in **Part 0**. Review format: tick, strike, or annotate each ID.

Evidence sources: 101-gap code audit · 6-agent architecture grounding · **12-buyer / 60-pull raw source study** · live gateway probes.
Current state: **16 modified + 10 untracked files, nothing committed.** `tsc` clean, 79/79 tests.

---

## Part 0 — ALREADY LANDED this session (baseline, uncommitted)

Listed so you don't re-review them.

> ⚠️ **What "landed" means here.** D1–D13 are **frontend, in the working tree, UNCOMMITTED** — `tsc`-clean, 79/79 tests, verified against the local dev server on GLID 254950925. They are **not committed to git and not deployed to production.**
>
> ⚠️ **D14 was wrong when first written — corrected 2026-08-03.** Probing the live webhook shows `mcat_id_forwarded: true` but **no `mcats_seen`**, i.e. the imported build is the **original `FIXED`, not `FIXED3`.** `FIXED2` and `FIXED3` were produced but never imported.

| # | Change |
|---|---|
| D1 | **Gateway fix** — `allowed_openai_params` makes `reasoning_effort` actually take effect. It was inert project-wide: without it, 1-in-4 hard 400s *and* the successes returned `reasoning_tokens: 0` |
| D2 | **Model lock** → `gemini-3.5-flash-lite` on the form; `MODEL_CARD` pinned to 2.5-flash-lite after a probe showed the card key hard-401s on anything else |
| D3 | `reasoningEffort: 'none'` no longer sent (gateway: *"Reasoning is mandatory for this endpoint"*) |
| D4 | **Effort selector** on page −1 (High/Medium/Low), mode-independent, all 3 LLMs |
| D5 | **`applyBudget` bug** — keep-set held field names, so duplicate canonical keys re-admitted (8 asks survived a max of 5); now keeps identities |
| D6 | Line-numbered debug fences + `<source>:Lnn` evidence citations; truncation parity (cap applied to compact form so debug can't truncate before prod) |
| D7 | `catCorpus` cleared on the seed short-circuit (was feeding LLM 2 the *previous* category) |
| D8 | Category **double-execution removed** — one fetch + `distillCategory()`; verified 1 request where there were 2 |
| D9 | `PROMPT_VER` entries (`rb-v1` verified live), `recordParse` on all 3 LLMs, planner-failure `emitApiError` |
| D10 | `hasPayload` green-on-empty fix (**category only**), `getSourceError`, 2 new health rows incl. `getISQs` (the call that gates LLM 1) |
| D11 | BES on pages 2/3; chip-less prefill no longer a text box; untouched prefills reach the submission |
| D12 | **`specs2` stage deleted** — was dead-but-reachable; anything outside `{specs,commercial,persona,more}` fell through to the *results* body |
| D13 | 79 tests (was 39) — first coverage of `src/lib/rfq/` |
| D14 | n8n **`FIXED`** (imported, live): 20 fixes incl. fail-closed PII strip on the PNS path, honest `full_supported`, `asked_pct` fix, cap 15→40 + totals, `wa-merge` barrier, 6 input guards. **NOT live: `FIXED2`** (MODID→PNS, FIELDS→metadata, Redash `max_age` 900, poll 8s→16s) **and `FIXED3`** (glid-only PNS, `mcats_seen`) |

---

## Part 1 — P0: correctness and safety

### C1 · PII firewall between fetch and prompt
**Why.** Profile and WhatsApp reach the LLM **verbatim** today (`fetchProfile`/`fetchWhatsapp` do no parsing, `raw === cleaned`). Across 12 buyers: `mobile1` **12/12**, `contacts_name` **12/12**, `first_name` **12/12**, `contact_address` **12/12**, `email` 11/12, plus **37 seller mobile numbers** across 5 buyers and **internal employee names** for one.
**What.** A `projectFor(source)` whitelist layer in `src/lib/rfq/` — no source enters a prompt except through a declared projection. Whitelist, not blacklist.
**Where.** `dataLayer.ts:107-118`, consumed at `BrainRFQForm.tsx:1251`.
**Risk.** Medium — narrowing what LLM 1 sees could change its output. Mitigate by projecting *fields*, not by summarising.
**Effort.** ~half a day. **Blocks:** nothing. **Do first.**

### C2 · Reset page-2/3 plans and answers on product change
**Why.** The commit block resets every page-1 surface but **never** `commercialPlan`/`personaPlan`/`cxAnswers`/`psAnswers`. Switch product and stale answers silently suppress the new product's questions.
**What.** Add the four setters + reset `cxFiredFor`/`psFiredFor`/`cxUsedFallback`/`psUsedFallback`.
**Where.** `BrainRFQForm.tsx:~1034`.
**Risk.** Low. **Effort.** 15 min.

### C3 · Feed shown-but-blank page-1 questions to the merge layer
**Why.** `buildSession` builds `page1` from **values only**, so a spec that rendered and was left blank is invisible to dedup — a **guaranteed double-ask on page 2**.
**What.** Thread `page1Shown: string[]` (every `isqSpecs[].IM_SPEC_MASTER_DESC` + `aiSpecs[].fieldName` + `extraSpecs` keys) and pass as `extraShown` to the commercial `dropAnswered`.
**Where.** `plannerController.ts:12-22`, `usePlannerController.ts:49`.
**Risk.** Low. **Effort.** 1 h.

### C4 · Consume WhatsApp `isq_answer` as deterministic prefill
**Why.** **21 `isq_answer` messages** across the cohort are the buyer answering *named ISQs* — including **`purchase_frequency` ("Monthly")** and **`sample_order` ("Sample Only")**, two of the eleven canonical LLM-2 keys. The planner asks them again because it never sees them. Also present: order quantity (`"Dried Sweet Potatoes · 5 Kg · YES"`), delivery geography, use-case (`Animal Feed Binder`, `Snacks`).
**What.** Parse `raw.timeline[]` by `kind`: `isq_answer` → page-1/2 prefill (highest confidence) · `button_tap` → lower-confidence candidate · `free_text` → intent to LLM 1 · `caption` from `ours` → **context only, never intent**.
**Where.** new parser in `dataLayer.ts`; consumers `BrainRFQForm` prefill + LLM-2 inputs.
**Risk.** Medium — a wrong prefill is worse than no prefill; gate on `kind === 'isq_answer'` only for auto-fill, everything else as *suggestion*.
**Effort.** ~1 day. **Highest value-per-hour in the plan.**

### C5 · PNS green-on-empty + cross-source contradiction alarm
**Why.** `fetchPnsInsights` still uses `ok: d != null`, so an empty-but-structured response counts as healthy. **6 of 12 buyers return zero rows while their own profile records calls.**
**What.** Apply `hasPayload`; and raise a **red** source when `profile.pns_call_cnt > 0 && pns.rows === 0`.
**Where.** `dataLayer.ts:128-133`.
**Risk.** Very low. **Effort.** 1 h. Also produces C13's metric.

---

## Part 2 — P1: the 1–2s latency budget

Current floor is **~15s** (measured 13,959 / 14,967 / 17,501 ms). Target is 2s.

### C6 · Move PNS to gate mount
**Why.** PNS **hard-blocks** LLM 1 (`pnsP.then(() => runRequirementBrain(...))`) behind a **120s** timeout. It is now glid-only — it never needed the mcat.
**Where.** `BrainRFQForm.tsx:1248-1254` → `BrainFormGate.load()`.
**Risk.** Low. **Effort.** 2 h. **Biggest single latency win.**

### C7 · Un-block LLM 1 from WhatsApp, Profile and empty seller-specs
**Why.** All four leaves share one `leafTruth` object, so WhatsApp — which nothing else consumes — delays the brain. Seller specs block even when the category has none (flag flips in a `.finally`).
**What.** Split the gate: LLM 1 waits only on its **minimum viable set** (product + buyer specs + CSL/RFQ), and enriches when the rest land.
**Where.** `BrainFormGate.tsx:104-110`, `BrainRFQForm.tsx:1182-1183`.
**Risk.** Medium — changes what LLM 1 sees on first fire; the existing upgrade-refire guards already handle late arrivals.
**Effort.** ~half a day.

### C8 · Build the Buyer Twin pre-commit; shrink LLM 1 to a projection
**Why.** LLM 1's prompt is ~15k tokens of five raw dumps. The buyer-understanding half is **product-independent** and can be computed while the buyer is still choosing.
**What.** Twin build after the gate-mount burst, persisted in **`bi-buyer-brain`** keyed by GLID. LLM 1 then receives a compact twin + buyer specs + seller specs + product. **Returning buyer = cache hit, skipped entirely.**
**Risk.** **High — this is the big one.** See C9 for the guard.
**Effort.** Multi-day. Serves latency *and* token cost *and* scalability.

### C9 · Twin stores evidence with provenance, never bare conclusions
**Why.** A persisted brain persists **mistakes**. The cake-as-transformer error would have been written into that buyer's twin and poisoned every future session, indistinguishable from history.
**What.** Every derived claim carries `derived_at` + `from_evidence[]`; anything inferred is flagged `inferred` and is overridable. **Contradiction policy: keep both and flag** — page 3 is where the buyer resolves it.
**Risk.** Low (it *is* the risk control). **Non-negotiable if C8 ships.**

### C10 · Progressive enhancement instead of a spinner
**Why.** Your rule: over 3s, something must be on screen.
**What.** Page 1 renders from buyer specs immediately; autofill lands as a visible **"✦ filled 3 from your history"**, never a blocking spinner.
**Effort.** ~2 h once C6/C7 land.

---

## Part 3 — P2: understanding quality

### C11 · CSL becomes the category authority; RFQ title the fallback
**Why.** **For 6 of 12 buyers the latest RFQ mcat appears nowhere in CSL** — they disagree half the time. `12268156` has 19 expired requirements while CSL shows `fly ash powder ×38` in the last two days. Trusting the RFQ title over browsing is the **root cause of the collision**. CSL is also the only PII-clean source.
**What.** Rank category candidates: CSL recency+intensity > RFQ title. Use `viewed_products[].desc` (**35/35, read by nothing** — the strongest free disambiguator) and `evidence[].count` as intent intensity.
**Risk.** Medium — inverts today's precedence. Ship behind the existing collision-swap path, which already does this for the exact-name case.
**Effort.** ~1 day.

### C12 · Hard-code the page contract (stop trusting prompts)
**Why.** "Page 1 = only technical", "buyer specs never leave page 1", "never repeat" are **sentences in three prompt strings and nowhere else.** The only rule enforced in code is the ≥2-chips gate.
**What.** One shared field taxonomy (the 11 canonical keys are the seed) enforced at each consumption point: drop commercial/persona-canonical fields from `page1`, drop technical fields from pages 2/3, and canonicalise **label as well as field** before dedup (today it matches the field key only — the repo's own concept matcher is dead code).
**Risk.** Low-medium. **Effort.** ~1 day.

### C13 · Extract `order_value` surgically → unit-price expectation
**Why.** `order_value` is present in **27/60 rows across 9/12 buyers** as Rupee bands, and `order_value ÷ quantity` yields a **unit-price expectation on all 27** (they co-occur 1:1). `268590579`: 100,000 kg for ₹70–74 L ⇒ ₹70–74/kg. Also: `requirement_type` is `"Business Use"` in **20/20** — useless as a B2C/B2B discriminator, while **qty + order_value separate the cohort cleanly.**
⚠️ **Surgical only.** The `raw` branch that holds `order_value` also holds the full contact record for 12/12 buyers. Do **not** widen the passthrough (this corrects an earlier V2 recommendation of mine).
**Effort.** ~half a day.

### C14 · Profile: use the reliable half, stop relying on the empty half
**Why.** `business_type` **2/12** and `glusr_usr_designation` **2/12** — the two fields a persona planner most wants barely exist. Reliably 12/12: `contact_city/state/district`, `location_preference`, `is_paid`, `membersince`, `enq_count`, `total_requirement`, `pns_call_cnt`, `products_of_interest[]` (34 rows with mcat + name + **image**). `buyer_product_sold` 5/12 = **the buyer is also a seller**.
**What.** Route geography + engagement counters → **page 2**. Route `buyer_product_sold` + maturity → **page 3**, and treat business_type/designation as **UNKNOWN** so page 3 asks rather than guesses.
**Effort.** ~half a day.

### C15 · PNS coverage gap as a standing metric
> ⚠️ **Re-measure after importing FIXED3.** The 6/12 figure was gathered against the live `FIXED` build, which still sends `MODID: "MY"`, omits `FIELDS: "metadata"`, and **forwards `MCAT_ID` (as an empty string when the caller omits it)**. If the API treats an empty MCAT_ID as a filter, part of the gap is self-inflicted and will shrink once the glid-only build is live. Treat 6/12 as an **upper bound** until re-run.
**What.** Ship the C5 alarm as a dashboard number: *"API returned 66 rows against 318 profile-recorded calls ≈ 21%; 6/12 buyers zero."* This is the artefact for the API-expansion argument.
**Effort.** ~2 h.

---

## Part 4 — P3: hygiene (cheap, prevents repeat confusion)

| # | Change | Why |
|---|---|---|
| C16 | **Rename the three PNSes and two WhatsApps** — `category_call_insights` · `buyer_call_insights_api` · `buyer_call_transcripts_full` · `vani_bot_calls`; `channel` (thread) vs `sender` (speaker) | I conflated them myself this session; it will cost the next person the same hour |
| C17 | Fix `seller_cities` — it contains **review counts** (`27`, `5`, `177`), not cities; seller names/cities/domains dropped | n8n parser bug |
| C18 | `explicit_business_intent: ['distribution']` is a false positive lifted from *"Distribution"* in a category name | the collision contaminated a derived signal |
| C19 | Delete `promotedLastPage` + the no-op `setPlacement`, or gate behind an allow-list | live render path that puts commercial/persona fields on page 1, unreachable only by accident |
| C20 | Add `dropAnswered` to `?rfq=brain2` | the blueprint has no cross-page dedup at all |

---

## Part 5 — Server-side / n8n (yours)

| # | Change | Why |
|---|---|---|
| N1 | **Import `FIXED3`** (glid-only PNS, `MODID: PNS`, `FIELDS: metadata`) | still on `FIXED` |
| N2 | **Reconcile `EMP_ID` with the AK** — node sends `94913`, your working curl uses `105253` | the API answers a malformed request with an empty 200, which is why this looked like "no data" |
| N3 | **Parallelise the full suite** — `t2 → redash-pns- → redash-vani- → pns-insights-api1 → …` is a strictly linear 10-node chain with **zero fan-out**, serialising two independent Redash pollers | slow-mode latency is the sum, not the max |
| N4 | Route **VANI to persona only**, never requirement extraction | 9696 calls may be off-topic; feeding them to LLM 1 is the hallucination path that produced the transformer |
| N5 | Rotate + vault the inline credentials; create an error workflow | plaintext in the export |
| N6 | Expand the PNS API to return all calls | C15 is the evidence |

---

## Part 6 — NOT proposing (and why)

| Item | Why not |
|---|---|
| **WhatsApp tiles on the landing** | ⚠️ **My V2 recommendation, now withdrawn.** 11–13 of 13 buyer-typed CTA products are already in that buyer's RFQ or CSL payload — **~0.08 new products per buyer** |
| Deleting the ~700 lines of engine-era UI | Needs its own pass with its own verification; too risky inside a batch |
| Score-rail rebalance | Owner-visible weights — your call, not mine |
| BuyLead POST | Needs a real endpoint + auth. **The submission is currently discarded** (`onSubmit?.(req)` on `undefined`) |
| Seller-search token | Expired 2026-06-19. It's a credential — not mine to handle |
| Splitting the brain into three objects | Three writers, no arbiter ⇒ they drift and contradict. Recommend one object + per-page projections instead |

---

## Part 7 — Decisions that block me

1. **C8/C9 twin write policy** — planners propose deltas, one arbiter commits (my recommendation)?
2. **Twin staleness** — how long before DNA is re-verified?
3. **CF-6 vs "buyer specs always stay on page 1"** — these contradict each other in code **today**. `visibleSpecs` drops every unfilled buyer spec when `category_trustworthy === false`. Which rule wins?
4. **Category corpus for LLM 2** — it carries *technical* seller questions, structurally pushing page-1 content onto page 2. Filter before LLM 2, or retag?
5. ⚠️ **Twin key** — requesting GLID `154357970` returned `254950925` as canonical. Verify before keying persistence on the requested value.

---

## Suggested sequence

**Week 1 (safety + cheap wins):** C1 · C2 · C3 · C5 · C17 · C18 — plus N1/N2 on your side.
**Week 2 (latency):** C6 · C7 · C10, measure against the 2s budget.
**Week 3 (value):** C4 · C13 · C14.
**Then, with decisions settled:** C8 · C9 · C11 · C12.

C1–C5 are independent of the twin, so **nothing in Week 1 is wasted** if you decide against C8.
