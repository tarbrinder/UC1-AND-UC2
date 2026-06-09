# FINAL PLAN — Intent-First Engine + Knowledge Coverage Registry + Fact Dossier

> ## ✅ STATUS (2026-06-05) — went as per plan, in sequence
> - **A5 Knowledge Coverage Registry** — DONE (lifecycle active/confirmed/overridden/rejected · evidence[] · created_at/updated_at · writers · debug · `window.__coverage`). coveragetest 30/30.
> - **A5b Reader + Registry→Truth-Table sync** — DONE (Level-1/2 only, no semantic; hides a spec only when a QUESTION covered its concept; verified it never hides a user-filled/unrelated spec).
> - **A6 Intent-First Engine** — DONE & live-verified end-to-end: `deriveIntent` single journey-adapted call → gate asked FIRST (specs held) → answer locks `requirement_intent` + records to registry → seeded re-plan (via P6) reorders specs → A5b hides the now-redundant intent spec (e.g. "Usage"). Diesel generator: "What will you use this diesel generator for?" → "Construction site power" → 3 specs moved, "Usage" hidden, no double-ask.
> - **C Dossier** — pieces exist (Ledger · Raw Fetch Dump · Used-By · Contradictions · AI Impact), NOT yet assembled into the fact-oriented C1–C6 panel.
> - **B External — Registry bridge DONE** (live-verified): any Tier-1 verified fact in `window.__ebi` (GST/HSN/Udyam/NIC/World-OSINT) → Registry as **`Verified`** (authority above Twin, below User → user truth overrides; 35/35 incl. that lifecycle). **Sign3/identity EXCLUDED** (observed-only). Dossier ② + Used-By + Truth Table reflect it. Verified: injected GST "Advertising & Events" + OSINT "Corporate gifting" → both Registry `Verified` facts; Sign3 dropped.
>   - **⛔ BLOCKER (creds, not code):** real GST/HSN DATA needs the **Befisc GST/HSN endpoint code(s)** (currently unknown — only C9S1 *identity* works, which is Tier-2) + **Udyam privilege** (402). Provide the GST endpoint code → I add the live proxied call and it flows through the bridge automatically. Until then the bridge runs off the sandbox (`ebi_sandbox.mjs` → `window.__ebi`).
>
> ## 🔭 EXTERNAL SPLIT (adopted — Befisc≠Sign3≠World are NOT one bucket)
> - **Tier-1 — Verified Business Truths → feed Registry + Twin** (not pilot-gated; they're verified facts): GST · GST-nature · HSN · Udyam · NIC · company website/description. Enter as Registry facts (`source:'GST'|'Verified'`, conf 90-95) **subject to the same lifecycle — user truth still overrides** (e.g. GST "Packaging Mfr" → user "we're a trader" → GST fact `overridden`). New Twin layer "Verified Business Truths".
>   - *Reality:* Befisc Profile-Advance + World/OSINT work today; **HSN + Udyam blocked on endpoint codes + privilege (creds, not code).** Live wiring needs key-proxy + async + mobile-gate.
> - **Tier-2 — Observed-only (Dossier, never planning):** Sign3 persona · social · email/breach footprint.
> - **Next order:** Tier-1 external → Registry/Twin (wire Profile-Advance + website now; flag HSN/Udyam creds-blocked) → assemble Dossier → pilot.



> Converged across Claude + ChatGPT + Gemini (2026-06-05). This is the LOCKED roadmap.
> Standing directives still in force: **NO HARDCODING any category** anywhere · brands/preferences
> never auto-filled (VEKA gate) · external (Befisc/Sign3/World) = **observed-only, never into
> Twin/Planner** until pilot proves value · debug shows honest receipts (no fabricated numbers) ·
> the Twin is the BUYER's persistent memory — **never destroyed on product change** (Ignore-Twin
> toggle is the cold-run opt-out) · OTP static for now · DPDP set aside.

## Locked sequence
```
A5  Knowledge Coverage Registry      (the requirement's memory / system-of-record)
A6  Intent-First Engine              (purpose asked FIRST, journey-adapted, seeds ONE planner call)
C   Buyer Intelligence Dossier       (fact-oriented; Used-By · Contradictions · Missing · Counterfactual)
— PILOT —
B   Befisc / Sign3 / World           (wired, OBSERVED-ONLY)
— PILOT 2 —
D   External → Twin                  (only if pilot measures real RFQ lift)
```
Build order rationale: A5 is the connective tissue every later phase consults; A6 produces the
single highest RFQ-quality gain; C makes the whole chain auditable for the HOD before pilot.

---

## A5 — Knowledge Coverage Registry  *(formerly "Universal De-Dupe" — ChatGPT rename; it's bigger)*
**Goal:** ONE in-memory system-of-record for every fact the requirement has learned, so no stage
ever asks something already known — on the intent step, planner, spec page, OR last page.

- **Shape:** `registry[conceptKey] = { concept, value, source, confidence, at }`
  - `source ∈ User | Intent | Planner | Twin | Cascade | Deduced | Spec | LastPage`
- **Concept normalization (category-agnostic):** a generic concept map folds synonyms to one key —
  `use_case|application|purpose|end_use → intent` · `frequency|cadence|repeat_order → cadence` ·
  `budget|price_range → budget` · etc. Reuse the existing `UNIVERSAL_SPEC_SYNONYMS`; **no category literals.**
- **Writers:** intent answer, each planner question answer, high-conf Twin facts, spec picks, cascade
  fills, deduced logistics, last-page answers — all `record(concept, value, source, conf)`.
- **Readers (every stage, before rendering):** `isCovered(concept)` → if covered, **hide/skip** the
  question/spec and log provenance ("hidden: Application — covered by Intent = Retail").
- **Edge cases:** only hide when a *different* stage answered the *same* concept (conservative synonym
  match, never fuzzy over-reach); never hide a spec the buyer hasn't actually had answered; PII / delivery
  location / qty / timeline / payment are dedicated fields (already excluded); **log every hide** so debug
  shows exactly what was suppressed and why.
- **Last-page relevance pass:** of the remaining last-page questions, an LLM relevance check drops any
  that are now pointless given the registry (except PII/location); genuinely-decisive leftovers get
  promoted up (into planner scope or top-3 specs) instead of asked late.
- **Acceptance:** answer intent = "Retail" → Application/Usage/Purpose specs vanish + logged; nothing the
  buyer answered anywhere is ever re-asked; debug "Coverage" view lists concept · value · source.

## A6 — Intent-First Engine
**Goal:** ask WHY/purpose FIRST (before the planner), adapt the question to the buyer's journey, and seed
the planner's single call with it — so the first plan is already right, not re-ranked after.

- **`requirement_intent` — first-class object** (NOT the ISQ "Use Case", which exists per-category):
  `{ value, journey, confidence, source: 'buyer'|'derived', locked }`.
- **`deriveIntent(productName, qty, buyerKind, profileTruths)` — ONE flash-lite call** (classifier folded
  in, per Claude+ChatGPT — no separate call): returns `{ journey, intent_question, chips[], derived_intent?, confidence }`.
  Journey-adapted question, e.g. retail → "Why do you need these?" · industrial → "What's driving this?" ·
  project → "Where will these be installed?". Inputs = product + qty + business/personal + 100%-confidence
  profile truths only (no low-conf guesses).
- **Flow:** product committed → `deriveIntent` fires (pre-fetched at commit, async, so no double wait) →
  spec page asks the intent question FIRST (reuse the existing hold) → answer → **seed the single
  `planRequirement` call** with `requirement_intent` → plan → specs reveal already-shaped.
- **Intent Confidence:** buyer-selected = 100; derived/skipped = lower (e.g. 72). Shown in debug + Truth Table.
- **Intent Lock (ChatGPT — prevents oscillation):** once answered, `requirement_intent.locked = true`; the
  planner / cascade / re-rank must NOT re-interpret it. A later spec pick (e.g. Printing = Screen Print)
  can never flip Intent from "Corporate Gifting" to "Retail Resale".
- **qty default:** when the API omits quantity, assume **1** *if applicable to the category* (not forced
  on bulk-only categories).
- **Registry:** `requirement_intent` is recorded in A5 → planner/specs/last-page never re-ask it.
- **Fallback:** if the buyer skips intent, fall back to today's planner-first + P6 re-rank (already shipped).
- **Edge cases:** off-profile → journey may be "unknown", still ask; latency → flash-lite + pre-fetch;
  B2B vs B2C genuinely diverge the chips (driven by `buyerKind` + journey, not category literals).
- **Acceptance:** Cotton Tote Bag · qty 500 · business → intent question shows retail-style chips; answer
  "Retail" → the planner's FIRST plan is already retail-shaped (no jarring re-rank); intent locked + never re-asked.

## C — Buyer Intelligence Dossier  *(fact-oriented — conclusions, not counts)*
**Goal:** the HOD reads ONE panel and trusts the system — what we knew, inferred, ignored, and the value created.

- **C1 — 4 lenses:** 🪪 PII (name/mobile/GST) · 🏭 Procurement (HSN/categories/ISQs) · 🧠 Behaviour
  (WA-friendly/cadence/local) · 🎯 Intent (product/journey/qty/business-personal).
- **C6 — Fact → Source → Used-By → Result** (the headline reframe): each row reads
  `WhatsApp → "buyer asks every 7 days" → Twin → "Weekly cadence inferred"`. **Not** "WA events: 67."
- **C2 — Used-By matrix:** per source → `Twin: Y/N · Planner: Y/N · Specs: Y/N · Matchmaking: Y/N`.
  Internal = mostly YES; External (Befisc/Sign3/World) = **NO** (observed-only) — kills the "did the Twin use
  external?" confusion.
- **C3 — Contradictions:** internal-history × external token-overlap (shipped) **+** Twin-business ×
  CURRENT product → OFF-PROFILE / discovery verdict.
- **C4 — Missing-Data:** every empty/failed/unwired source + impact (already in the Raw Fetch Dump gaps — fold in).
- **C5 — Counterfactual (the leadership-seller):** `Without Twin: 9 Qs · With Twin: 4 · Saved: 5` + the
  skipped list (Business Type, Buying Frequency, Supplier Preference). Mostly already computable from
  `twinResolved` + the AI Impact card.
- **Honesty rule:** NO fabricated influence percentages. Show used/not-used + which fields each source
  actually contributed (counts) + the Counterfactual. Honest beats fake-precise.
- **Reuse:** fact extraction reuses the Twin evidence ledger — **no new LLM**.

## PILOT  → measure question-count, skip-rate, spec-page abandonment, completion.

## B — Befisc / Sign3 / World  *(wired, OBSERVED-ONLY)*
Proxy the keys (Vite/dev) · mobile-gated (needs buyer_profile mobile) · async, never blocks · graceful
per-source fallback · GST→HSN/Udyam stays "awaiting endpoint code". Lands in the Dossier with `Used-By: NO`.

## D — External → Twin  *(only after Pilot 2 proves measurable RFQ lift)*

---

## Do NOT build
Separate journey classifier (folded into `deriveIntent`) · fabricated influence % · more Twin traits /
confidence formulas / planner layers · external into Twin/Planner before pilot · category/spec hardcoded rules.

## Acceptance test (end state)
A buyer enters a product + qty → answers ONE journey-adapted purpose question → sees a short, plain-English,
intent-shaped set of questions and specs with **zero repeats across any stage** → reaches a last page that
asks only genuinely-relevant unknowns. An HOD opens `?debug=1` and reads, in the Dossier:
`Source → Fact → Used-By → Result`, the Used-By matrix, Contradictions, Missing-Data, and the Counterfactual —
and can explain every question asked, skipped, and re-ordered, console closed.
