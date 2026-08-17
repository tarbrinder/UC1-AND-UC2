# Smart RFQ — Architecture V2 + Master Audit Prompt

**2026-08-02.** Written after an 11-agent gap audit (101 findings) and a 6-agent architecture grounding pass over the real code. Everything below is either cited to `file:line` or explicitly marked as a proposal.

---

## 0. The one number that changes everything

> **Owner constraint (2026-08-02): the buyer may wait 1–2 seconds on page 1. Beyond 3s, something must be on screen for them to consume.**

The current architecture **cannot** meet that, and not by a small margin. LLM 1 is gated behind a serial chain:

```
commit → mcat resolve → ┬ GetIsq        (15s timeout)  → specsLoading:false ─┐
                        ├ getISQs       (30s timeout)  → sellerSpecsReady ───┤
                        └ McatDtl                                            ├→ ALL must clear
   gate mount → ┬ CSL ─┬                                                     │
                ├ RFQ  ├→ leafTruth (ONE object, all four) ──────────────────┤
                ├ Profile                                                    │
                └ WhatsApp ─┘                                                │
                                          PNS (120s timeout) ────────────────┘
                                                    ↓
                                       runRequirementBrain  ← 14–17s at effort=high
```

Four things make this fatal:

1. **PNS hard-blocks the brain.** `pnsP.then((pns) => runRequirementBrain(...))` — `BrainRFQForm.tsx:1249`. The brain cannot start until PNS resolves or its **120s** timeout fires.
2. **All four leaves block the brain, including WhatsApp**, because they share one `leafTruth` object and LLM 1 returns early until it is non-null (`BrainRFQForm.tsx:1182`). The comment calling profile+whatsapp "non-blocking" is true for the *landing* and false for the *brain*.
3. **Seller specs block the brain even when the category has none** — `sellerSpecsReady` flips in a `.finally`, so a zero-seller-spec category still waits out the call (`BrainRFQForm.tsx:1066`, gate at `:1183`).
4. **The brain itself is 14–17s** at `effort=high` on a ~15k-token prompt of raw source dumps.

Measured live: brain 13,959ms / 14,967ms / 17,501ms across three runs. **The floor today is ~15s. The target is 2s.**

### The owner's own insight is the key to fixing it

> *"those buyer specs are there which buys us time for requirement brain to build"*

Exactly right — page 1 is a **latency-hiding device**. But it only works if (a) specs render immediately without waiting for any LLM, and (b) the brain finishes inside the time the buyer spends filling them. Today (b) is false, and (a) is only accidentally true.

V2 makes both true by construction.

---

## 1. Design principles

**Ik Onkar — one reality, many forms.** There is **one buyer**, not one-buyer-per-session. Today the RFQ form treats itself as a separate universe: it rebuilds understanding from zero on every visit, from raw dumps, and throws it away at submit. The correction is a single persistent understanding — the **Buyer Twin** — of which the RFQ form, the calls, WhatsApp and the search history are all facets. *All is one; the RFQ is part of that one.*

**Sarbat da bhala — the system serves the buyer.** The metric is *fewest questions that still let a seller quote*, not *most fields captured*. Asking more always "reduces uncertainty"; that is the failure mode, not the goal.

**Kirat karo — honest labour.** Every claim carries its evidence. No fabricated prefill, no invented citation, no confident guess dressed as a fact. This is the concrete anti-AI-slop rule: **if it cannot cite a source line, it is not evidence — it is a question.**

Translated to engineering norms: **one source of truth · deterministic where correctness matters, probabilistic where judgement matters · progressive enhancement · evidence with provenance · idempotent writes.**

---

## 2. Architecture V2

### 2.1 The Buyer Twin (persisted, reuses `bi-buyer-brain`)

Split by **volatility and writer**, not by page:

| Layer | Content | Changes | Written by | Storage |
|---|---|---|---|---|
| **DNA** | GST, legal name, city, business type, scale band | ~never | **Deterministic only — never an LLM** | Persisted, long TTL |
| **Social wiring** | Channel preference, language, responsiveness, decision-maker vs gatekeeper | months | Behavioural counters + LLM | Persisted |
| **Long-term memory** | Category history, price bands, cadence, seasonality, suppliers | accretive | Deterministic aggregation + LLM summary | Persisted, enriched each visit |
| **Drive** | Urgency, seriousness, price sensitivity — *this deal only* | per requirement | LLM | Session |
| **Judgement** | Contradiction resolution, category trust, qty conflicts | per requirement | LLM, evidence-bound | Session |
| **Reflex** | Buyer specs stay on p1 · dedup · unit derivation · GST gating · chip contract | fixed | **Code. Never a prompt.** | Code |

**The lethal risk, and the rule that neutralises it.** A persisted brain persists *mistakes*. The cake-mapped-as-transformer error would have been written into that buyer's twin and poisoned every future session, looking exactly like history.

> **The twin stores EVIDENCE with provenance and confidence — never bare conclusions.** Every derived claim carries `derived_at` + `from_evidence[]`. Anything an LLM inferred is flagged `inferred` and is always overridable by a later observation. Conclusions must be re-derivable from evidence, so invalidating evidence invalidates the conclusion.

**Contradiction policy: keep both and flag.** Never silently overwrite. The flag is exactly the signal that caught the cake case, and page 3 is where the buyer resolves it (owner: *"yes they can [correct it] — that's what the persona page is for"*).

**Segmentation verdict — one object, internal sections, per-page projections.** Not three brains (they drift and contradict with no arbiter), not one blob sent everywhere (expensive and unfocused). Planners **propose deltas; one arbiter commits.** This is what serves the token goal: each planner receives only its projection.

### 2.2 The staged flow

```
t=0     GATE MOUNT ── fire in parallel, all GLID-only:
        CSL · RFQ · Profile · WhatsApp · PNS          ← PNS MOVES HERE (it no longer needs the mcat)
           │
        landing paints on the FIRST TWO to land (CSL + RFQ)          ~1–2s
           │
t≈2s    TWIN BUILD (background, product-independent) ────────────────────────┐
        Runs while the buyer is still choosing a product.                    │
        Cache hit for a returning buyer ⇒ skipped entirely.                  │
           │                                                                 │
t=commit PRODUCT COMMIT → mcat resolve → collision swap                      │
        fire in parallel: GetIsq · getISQs · category-brain                  │
           │                                                                 │
t+0.5s  PAGE 1 RENDERS from buyer specs alone. No LLM in the path.  ✅ 1–2s   │
           │                                                                 │
t+~2s   LLM 1 = REQUIREMENT pass ←── twin (compact) + buyer specs + seller specs + product
        Small prompt (a summary, not five raw dumps) ⇒ fast.
        Autofills specs as a visible "✦ filled 3 from your history" moment.
           │
page 2  LLM 2 ← twin projection (commercial) + form-so-far + category insights
page 3  LLM 3 ← twin projection (persona) + buyer profile + form-so-far
           │
submit  TWIN WRITE-BACK (idempotent, evidence-stamped)
```

**Why this hits 1–2s:**
- Page 1 never waits for an LLM — buyer specs are already there.
- PNS is no longer on the critical path; it rides the gate-mount burst and is warm by commit.
- LLM 1's prompt shrinks from ~15k tokens of raw dumps to a compact twin + the two spec sets.
- A **returning buyer skips the twin build entirely** — this is where scalability and cost both come from.

**Progressive enhancement, not blocking.** If the brain is not back in 2s, page 1 is already usable; autofill lands as an enhancement. Nothing is ever held hostage to an LLM.

### 2.3 Source × Page × Planner matrix

`B` = blocks · `—` = not used · `✓` = consumed

| Source | Fetched | Landing | Twin | LLM 1 | LLM 2 | LLM 3 | Cached | V1 problem |
|---|---|---|---|---|---|---|---|---|
| CSL | gate mount | **B** ✓ | ✓ | ✓ (+collision) | — | — | twin | ok |
| Previous RFQs | gate mount | **B** ✓ | ✓ | ✓ | — | — | twin | ok |
| Buyer Profile | gate mount | ✓ (fallback tiles) | ✓ | ✓ | — | **✓** | twin | **blocks LLM 1 today**; identity half never reaches form state |
| WhatsApp | gate mount | ✓ *(see §3)* | ✓ | ✓ | — | — | twin | **blocks LLM 1**, and is single-consumer — nothing else reads it |
| PNS (glid-only) | **gate mount (moved)** | — | ✓ | ✓ | ✓ | ✓ | twin | **hard-blocks LLM 1 behind a 120s timeout** |
| Buyer Specs (GetIsq) | commit | — | — | **B** ✓ | via page1_state | via page1_state | per mcat | ok — this is the latency shield |
| Seller Specs (getISQs) | commit | — | — | **B** ✓ | — | — | per mcat | blocks even when empty |
| Category insights | commit | — | — | **never** | ✓ | — | per mcat | correct to withhold from LLM 1 |
| mcat resolve | commit | — | — | gates all | — | — | per name | ok |

---

## 3. Where the owner is right, and where to evolve

**Right — do not change:**
1. **Category insights withheld from LLM 1.** LLM 1's job is the buyer's own truth; category is market truth. Mixing them is precisely how the transformer hallucination happened.
2. **PNS glid-only across all categories.** A buyer researching a *new* product has no calls in that mcat; cross-category calls are where persona lives.
3. **Buyer specs as the latency shield.** Correct instinct — V2 makes it structural.
4. Deterministic merge layer as the last page. One spec page. Effort mode-independent.

**Evolve:**
1. **The brain is write-once.** LLM 2/3 only *read* it; neither updates it. The accumulating brain in your head does not exist in code yet.
2. **Hard rules are prompt-only.** Page purity, "buyer specs never leave page 1", "never repeat" — all sentences, no enforcement. Promote to reflexes.
3. **No persistence.** Rebuild-from-zero every session.
4. **LLM 1 waits for everything.** Fire on the minimum viable set, enrich after.
5. **WhatsApp on landing** — *conditional*. It currently reaches only LLM 1's prompt and nothing else. Whether it carries products worth surfacing is being tested against a live cohort; do not wire it to the landing on a hunch.

---

## 3b. Cohort evidence — 5 buyers, raw sources (2026-08-02)

Five archetypes pulled raw and profiled independently: `254950925` food/collision · `268590579` heavy repost · `244092512` B2C · `154357970` wrong-category · `106815489` project/factory.

### WhatsApp on the landing — CONFIRMED. Wire it.

Your hunch was right, and the evidence is stronger than you argued. WhatsApp carries **buyer-typed product names and spec values that exist in NO other source**, in 4 of 5 buyers:

| Buyer | What WhatsApp uniquely carried |
|---|---|
| 106815489 | The buyer's own typed wording, richer than any RFQ title: *"Custom Printed Zipper Stand-Up Pouch for Dry Fruits & Snacks With 50g to 1kg"* |
| 268590579 | The only spec value he typed himself — **"54 GSM"** — in reply to our own bot question |
| 154357970 | **Three named products appearing in no other source**, all dated, all from buyer turns |
| 254950925 | The timestamped causal mechanism of the whole collision failure — his own free-text product enquiry |
| 244092512 | A true negative: never sent a message (`buyer_turns: 0`) — itself a channel signal |

And today **100% of it is wasted**: `fetchWhatsapp` returns the payload verbatim, `BrainFormGate` puts it only into `leafTruth`, and the sole consumer is LLM 1's prompt as prose. There is no typed reader for `products_enquired` or `buyer_typed` anywhere in the app.

**Action:** parse WhatsApp buyer-turn products into the landing "Continue where you left off" rail, ranked by recency. This is the highest-value, lowest-risk change in the entire audit — the data is already being fetched and paid for.

### PNS — simultaneously the most valuable and the least reliable source

| Buyer | Result |
|---|---|
| 268590579 | **Works.** "By a wide margin the highest-value source in the file" — real quoted prices |
| 106813489 → 106815489 | **Works.** The only source explaining *why*: "dry-fruit laddoos packed in 200-250g pouches" |
| 244092512 | 0 rows — but BPOD reports `pns_call_cnt: 7`, `total_calls: 12` |
| 254950925 | 0 rows — but BPOD reports `pns_call_cnt: 2` |
| 154357970 | 0 rows — but BPOD reports calls exist |

**3 of 5 return zero rows while the buyer's own profile says calls exist.** That is a contradiction the platform never notices, because `fetchPnsInsights` still records `ok: d != null` — an empty-but-structured response counts as healthy.

**Actions:** (a) apply the `hasPayload` fix to PNS as it was applied to category; (b) add a **cross-source contradiction alarm** — if `bpod.pns_call_cnt > 0` and PNS returns 0 rows, that is a red source, not an empty one. This alarm would have surfaced the PNS breakage months ago.

### Buyer Profile is the most under-consumed source in the platform

`fetchProfile` does no parsing at all, and **exactly one field is read by application code** (`products_of_interest`, for the viewed-card fallback). Everything else reaches only LLM 1 as prose. Yet across the cohort it uniquely carried:

- **106815489 is himself a PAID COSMETICS SELLER** (`buyer_product_sold`) — a persona fact of enormous value to page 3, invisible to LLM 3
- **268590579**: 11 products with image URLs — the only image assets in any payload
- **254950925**: the buyer's wallet *beyond* the 5-day CSL window
- `pns_call_cnt` / `total_calls` / `is_whatsapp` — the very counters needed for the contradiction alarm above

### Previous RFQs — heaviest field-level waste

`fetchRfq` sets `raw = summary`, discarding the entire upstream `raw` branch. Lost: **order-value bands** (`"Rs. 100 - 200"`, `"Rs. 400 - 1,600"`), requirement detail text, Listing/UserDetail/isq payloads. Budget is a first-class commercial signal for page 2 and it never arrives.

### The category asymmetry — the misroute is more convincing than the truth

For 254950925: mcat **55260** (the bakery snack he actually wants) returns **0 calls, no specs, no personas**. mcat **2416** (the transformer misroute) is **data-rich and confident**.

> A wrong category can be *better evidenced* than the right one. Any design that lets corpus richness influence category trust will systematically prefer the misroute.

**Action:** category trust must never be a function of corpus size. And when the right category is empty, LLM 2 must be told "no evidence — use own knowledge" rather than being handed a rich corpus for a different mcat.

### ⚠️ Twin-key assumption needs verifying

Requesting GLID `154357970` returned **`254950925`** as the canonical id from every source that echoes one. If a requested GLID can resolve to a different canonical GLID, then "GLID is fully stable" is not safe as the twin key without an identity-resolution step. **Verify before building persistence on it.**

## 4. Contract violations found in code (fix before any rewrite)

| Sev | Finding | Where |
|---|---|---|
| **CRITICAL** | Page-2/3 plans and answers are **never reset on product change** — stale answers suppress the new product's questions | `BrainRFQForm.tsx:1034` |
| **CRITICAL** | Page-1 questions **shown but left blank** are invisible to the merge layer ⇒ guaranteed double-ask on page 2 | `plannerController.ts:12-22` |
| HIGH | Nothing in code classifies a question as technical/commercial/persona — page purity is 100% prompt | `llm.ts:123,180` |
| HIGH | Cross-page dedup matches the field key only — no synonym/concept matching; the repo's own concept matcher is dead code | `plannerController.ts:30-34` |
| HIGH | LLM 2 is fed **technical** seller-spec questions and told to prefer them — a structural driver of page-1 content onto page 2 | `enrichment.ts:946-950` |
| MEDIUM | "Buyer specs always stay on page 1" is contradicted by CF-6, which drops every unfilled spec on an LLM boolean | `BrainRFQForm.tsx:2444` |
| MEDIUM | Dedup is one-shot at plan time, never re-evaluated at render ⇒ back-navigation reopens the double-ask | `usePlannerController.ts:49,63` |
| MEDIUM | GST can be asked twice on page 3 — the ban on LLM 3 asking it is prompt-only | `BrainRFQForm.tsx:1832` |

---

## 5. The audit ground

A **case file** per buyer — one JSON capturing raw per source, every prompt, every output, timings, decisions and the final RFQ — so an audit is reproducible **without a live run**. Half of it already exists in `downloadProfile.ts`.

**Automated checks, asserted per case, no human needed:**
1. Contract violation — a commercial/persona-canonical field appearing on page 1, or a technical spec on page 2/3
2. Repeated question — same canonical concept asked twice across pages
3. Ungrounded prefill — a value with no `from_evidence`
4. Unconsumed source — fetched, parsed, never reaching any planner
5. Planner fired before its inputs landed
6. PII in any buyer-visible string
7. Latency budget — time-to-interactive on page 1 > 2s

**Scorecard:** source health · truth utilisation · question quality · contract compliance · latency. Run over a cohort; the baseline becomes a regression gate.

---

## 6. MASTER AUDIT PROMPT

> Copy from here down.

---

### Mission

You are the **Principal AI Architect + Principal Product Manager + Principal Data Engineer** for IndiaMART's Smart RFQ.

You are **not** reviewing code, debugging n8n, or validating APIs. You are answering one question:

> **If this buyer walked into our shop today, would the platform understand them as well as an experienced salesperson — and if not, exactly where does understanding get lost?**

Assume the architecture is wrong. Your job is to find where. Do not optimise for confirming it.

### The governing principle

For every source, answer: **"If I knew this before asking the next question, would I ask a different question?"**
- Yes ⇒ it belongs *before* that planner.
- No ⇒ it must *never block* that planner.

This single test decides all sequencing.

### Hard constraints (non-negotiable)

1. **Page 1 must be interactive within 1–2 seconds.** Over 3s, something must be on screen to consume. Any design that holds the buyer on an LLM fails.
2. **Token cost is a first-class metric.** No source may be passed to a planner that does not change its output.
3. **Every claim must cite evidence.** A value that cannot name its source line is a question, not a prefill.
4. **No question may be asked twice**, in any phrasing, across any page.
5. **Buyer PII must never appear in a buyer-visible string**, and the buyer must never be told we read their calls.

### Phase 1 — Raw truth
Collect **raw**, unparsed payloads for every source: CSL, previous RFQs, Buyer Profile, WhatsApp, PNS, VANI/call suite, Buyer Specs, Seller Specs, Category Insights. Never trust a parsed output before reading the raw one. For each: availability, completeness, latency, freshness, what only it carried, what it duplicated, and **what it carried that the app never reads**.

### Phase 2 — Independent understanding
**Before** looking at the Requirement Brain or any planner output, read the raw evidence as a salesperson and answer: who is this buyer · what are they buying · why · how serious · what matters to them · what contradicts · what is unknown. Cite a source for every claim.

**Then compare with the platform's understanding. The delta is the single most important output of this audit.**

### Phase 3 — Information flow
For every source: when is it called, what does it block, which planner consumes it, is it cached, is it re-fetched, is any truth lost, is it consumed too early or too late? Produce the **Source × Page × Planner matrix** and mark every violation.

### Phase 4 — Page contracts
- **Page 1** — only technical specs. Buyer specs always present and autofilled. Seller specs only if essential and non-overlapping. No commercial, no persona, no category insights.
- **Page 2** — commercial intent + category-specific non-technical questions, from brain + form-so-far + category insights.
- **Page 3** — pure buyer understanding, from brain + profile + form-so-far.
- Nothing asked earlier reappears.

For each rule state whether enforcement is **(a) hard code, (b) prompt-only, or (c) absent.** *Prompt-only is a finding — an instruction is not an enforcement.*

### Phase 5 — Judgement
Per page: did the LLM understand the page's intent · ask the minimum useful questions · ignore useful truth · overfit to category · **would a senior salesperson ask the same questions?**

### Phase 6 — Propose
You are authorised to propose a **better architecture**, including deleting a planner, moving a source, or changing what persists between sessions. Justify against: latency, token cost, accuracy, consistency, scalability, exhaustiveness.

### Deliverables
Buyer Understanding Report · Source Health Report · Source × Page × Planner Matrix · Requirement Brain Audit · Planner Audit · n8n Audit · Performance Audit · Architecture Violations · Recommendations (Critical/High/Medium/Low) · Final Architecture · **Reusable Case-Audit Framework** · scores for Architecture, Product and AI Understanding.

### Cohort
Run against a cohort, not one buyer: no-history · new-product · wrong-MCAT · heavy-repost · B2C. A finding that appears once is an anecdote; one that appears across the cohort is a defect.

---

## 7. Open decisions for the owner

1. **Twin write policy** — planners propose deltas and one arbiter commits (recommended), or deterministic-only writes?
2. **Twin staleness** — how long before DNA is re-verified? Long-term memory is accretive, but a buyer who changed business needs invalidation.
3. **CF-6 vs "buyer specs always on page 1"** — these contradict each other in code today. Which wins?
4. **The 3s rule** — what goes on screen when the brain is slow? (Recommendation: render specs immediately and land autofill as a visible enhancement, never a spinner.)
5. **Category corpus for LLM 2** — it currently carries *technical* seller questions. Filter them out before LLM 2 sees them, or retag them?
