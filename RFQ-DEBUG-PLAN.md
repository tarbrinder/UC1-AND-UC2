# Dynamic RFQ — Debug / Observability Plan (persona-driven)

**2026-08-10.** The debug should not be one data dump — it should answer *the question the reader came with*. Five readers, five questions:

| Persona | The one question they open debug to answer |
|---|---|
| **Prototype PM** | *Is the product idea working — did we ask the RIGHT questions, use the buyer's own truth, and personalise?* |
| **HOD** (product+eng lead) | *Is the pipeline healthy and on-strategy — how much truth do we activate, where's the leverage, where does it fail?* |
| **Implementing Engineer** | *How EXACTLY did this happen, and can I reproduce/fix it?* |
| **CEO** | *Why is this 10× better than a static form — in one glance, no jargon?* |
| **COO** | *Will it run reliably at scale, at what latency and cost?* |

The **flow** (every page emits the same debug atoms, below): `Page −1 setup → Page 0 Landing → Page 1 Specs (LLM 1) → Page 2 Commercial (LLM 2) → Page 3 Persona (LLM 3) → Last page (merge layer) → Results (seller search)`.

## The shared vocabulary — 5 "debug atoms" every page must emit
Everything each persona wants is a *view* over these five. Define them once:
1. **CANDIDATES** — every question/field that COMPETED for this page (LLM-proposed + code-considered), not just the winners.
2. **DECISION** — per candidate: *won/lost*, *rank*, **who decided** (LLM prompt vs a deterministic code rule), and *why* / *dropped_because*.
3. **FILL** — per rendered field: value · `ui` (prefill/confirm/ask/suggest) · **source** (which signal) · **confidence** · the exact evidence line (`source:Lnn — fact`).
4. **COST/LATENCY** — per LLM call + per source fetch: model · in/out tokens · $ · ms · retries.
5. **HEALTH** — per source/node: ok/empty/error · raw payload · parsed payload · what it contributed (or why it didn't).

---

## 1. Prototype PM — "is the product working, per page?"
Cares about *decision quality + truth utilisation + personalisation*. Per page wants:

| Page | PM must see |
|---|---|
| −1 Setup | the buyer picked (GLID), the mode (effort/exec/PNS), so a run is reproducible in a demo |
| 0 Landing | which past requirements/searches/viewed-products surfaced and **why THIS product is the anchor**; the repost/enrich/new decision + its trigger |
| 1 Specs | the **brain's understanding** (who/what/why); which specs **prefilled from truth vs asked**; the CANDIDATE ledger (Cavity won, Layers dropped-because…); each fill's **source** (RFQ / CSL / call) |
| 2 Commercial | the intent question + its customised options; **every category candidate incl. the non-spec gems** (white-labeling, approval) with *won/dropped + why*; what dropAnswered removed and why |
| 3 Persona | the persona gate verdict; which persona facts **prefilled from profile** vs asked; scenario-drops ("white-labeling — not applicable to this buyer") |
| Last | what the merge layer **removed as already-answered** (finance-spec ⇒ no payment); location-conflict prompt if fired |
| Results | which specs actually went to seller search; the ranked sellers' basis |
| **Every page** | **Truth Utilization (this page)** = fills-from-truth ÷ fills; **Buyer Effort (this page)** = # asks · # chips · # typed; the **"two-buyers" proof** — would a different buyer get a different page here? |
**PM headline widget:** a per-page strip — `asked N · prefilled M · from-truth K · ignored J` — and a **"what we knew but didn't use"** list (the TUS leak).

## 2. HOD — "healthy + on-strategy, in a rollup"
Not per-question; the *rollup + the exceptions*. Wants:
- **Two KPIs, whole-run:** Truth Utilization Score ↑ and Buyer Effort Score ↓ (the §3 KPIs), with the per-page contribution.
- **Per-source contribution matrix:** each of the 9 sources → did it Prefill / Confirm / Ask / Rank / *nothing*? (the "every source must contribute" invariant; a source contributing nothing is a red row).
- **The funnel:** Truth AVAILABLE → UNDERSTOOD → USED → CONFIRMED → SENT-TO-SELLER, with the drop at each stage.
- **Quality gates:** fabrication count (values shown that no evidence supports) · dedup violations (same concept asked twice) · green-on-empty sources · parse failures — all should be 0.
- **Cost + latency rollup:** $/RFQ, ms to first question, ms to submit — as a trend, not per-call.
- **Exceptions only:** the 3 things that went wrong this run (a 500, a thin brain, a dropped gem), not the 30 that went right.
**HOD headline widget:** one line — `TUS 41% · BES 6 · 8/9 sources contributed · 0 fabrications · $0.012 · 14s` — expandable to the funnel + the red rows.

## 3. Implementing Engineer — "exactly how, and reproducible"
Wants the *raw mechanics + a replay bundle*. Per LLM call + code layer:
- **The exact request:** full system prompt + the **line-numbered** user fences + the model/temp/effort/tokens.
- **The exact response:** raw JSON before parsing; `parseOk`; what the parser kept/dropped.
- **The code path fired:** seed short-circuit vs live fetch (which mcat, which builder) · `catCorpus` present? · which planner · gen-token · `dropAnswered` before→after (per-concept, the canonConcept mapping used) · `applyBudget` before→after · `matchSpec` routing (which LLM-1 question → which chip, by concept).
- **State transitions:** rbBrain landed at t=? · commercial fired at stage=? with brain=real|fallback · re-fire y/n.
- **Per-node raw-vs-parsed** side by side, + the fetch URL + status + ms + retries.
- **Errors:** every non-2xx, every parse fail, every timeout, with the stack/point.
- **A REPLAY BUNDLE:** the exact inputs (leaves + brain + corpus) as a downloadable JSON so a bug reproduces offline (this is what `scripts/*-probe.mjs` do manually — make it a button).
**Engineer headline widget:** per stage — `stage · fired-with · ms · tokens · parseOk · code-path` + a "copy replay bundle" button.

## 4. CEO — "why is this 10× better, in one glance, no jargon"
No line numbers, no tokens. Wants the *story + the differentiator + the trust guarantee*:
- **Questions avoided:** "A static form asks 12. We already knew 7 from his history, so we asked 4." (the headline metric).
- **Personalisation proof:** side-by-side — "Generic buyer sees X · THIS buyer sees Y" for one page (the "every buyer a different form" claim, made concrete).
- **Trust guarantee:** "Nothing on this form was invented — every prefilled value traces to something he actually said/did" (fabrication = 0, shown as a seal, not a number).
- **What we understood about him** in one plain sentence (the brain understanding, de-jargoned).
- **Outcome:** better/faster seller responses (once the learning loop exists) — flagged as "coming" honestly if not instrumented.
**CEO headline widget:** a single card — *"For Girish, we already knew 7 of 11 things. He answered 4. Nothing was invented. He got a form no other buyer gets."*

## 5. COO — "reliable + scalable + cost, operationally"
Wants *SLOs + failure modes + unit economics*:
- **Reliability:** success rate, error rate, timeout rate — per source and per LLM, over time.
- **Latency:** p50/p95 per page · time-to-first-question · time-to-submit · the slowest source (the bottleneck).
- **Cost per RFQ:** LLM tokens × rate + # upstream calls; projected at scale (× daily RFQs).
- **Failure modes + fallbacks:** what happens when a source 500s / times out / returns empty — did the fallback fire? (e.g. pns 500 → swallowed; monolith slow → thin brain).
- **Source uptime / dependency map:** which external systems (n8n, Redash, gateway, windmill) the RFQ depends on + their live status.
- **Capacity / throughput:** concurrent-run headroom, rate limits hit.
**COO headline widget:** `success 98% · p95 22s · $0.012/RFQ · bottleneck: category-brain (11s) · 1 fallback fired`.

---

## Combined plan — one debug, three layers, a persona toggle
Don't build five debuggers. Build **one per-page Decision Trace** (the spine — it already answers the PM) and wrap it in two rollup layers, gated by a **persona switch** (CEO / COO / HOD / PM / Engineer) on Page −1 next to the AI-Debug toggle:

```
LAYER 1 — STORY (CEO)         one card/page: knew-N, asked-M, 0-invented, personalised
LAYER 2 — SCORECARD (HOD/COO) KPIs (TUS↑ BES↓ · $ · p95 · success%) + per-source contribution + exceptions
LAYER 3 — DECISION TRACE (PM) per page: CANDIDATES → DECISION(who+why) → FILL(source+conf) — the spine
   └─ drill-down — MECHANICS (Engineer)  raw request/response · code-path · before/after · replay bundle
```
- The **spine (Layer 3)** is per-page and already exists in part (`metadata.considered` + reasoning + options in `BrainDebugPanel`). Everything above is an *aggregation* of the 5 atoms — build the atoms once, roll them up per layer.
- The persona switch just changes *default depth*: CEO opens on L1, Engineer on L3-drill; everyone can expand down.

---

## Quick audit — HAVE vs NEED (what to build)

**HAVE today** (`BrainDebugPanel.tsx` + telemetry):
- ✅ Every LLM call: model · in/out tokens · $cost · ms · full system+user prompt · raw output (Engineer L3).
- ✅ Question-competition ledger (`considered`: won/dropped/rank/why/basis) — PM/Engineer.
- ✅ Per-field reasoning + **per-option reasoning** (PICKED/DROPPED) + evidence `source:Lnn` chips.
- ✅ `needs_input` (couldn't ground).
- ✅ Source chips per call (which fences fed it, `∅` when empty).
- ✅ Per-source health (raw · cleaned · latency) + node health + evidence→decisions count + total $cost.

**GAPS to build** (ranked by leverage):
| # | Gap | Serves | Effort |
|---|---|---|---|
| 1 | **Per-page atoms unified** — CANDIDATES/DECISION/FILL/COST/HEALTH as one typed record PER PAGE (today it's per-LLM-call; landing + last-page + results have no trace) | all | M |
| 2 | **FILL provenance on every RENDERED field** — a source+confidence chip on each prefilled chip in the actual form (not just in debug), so "what filled this & why" is one hover | PM/CEO/trust | M |
| 3 | **TUS + BES instrumentation** — compute per-page + whole-run; BES needs tap/type/time telemetry (not captured today) | HOD/PM | L→M |
| 4 | **Per-source contribution matrix** — did each of 9 sources Prefill/Confirm/Ask/Rank/nothing | HOD | S |
| 5 | **The CEO story card** — knew-N/asked-M/0-invented/personalised, plain language, per run | CEO | S |
| 6 | **Cost-per-RFQ + p50/p95 latency rollup + bottleneck source** (data exists per-call; needs aggregation) | COO/HOD | S |
| 7 | **Fabrication + dedup-violation counters** — assert 0 (values with no evidence; concept asked twice) | HOD/trust | M |
| 8 | **Replay bundle download** — the exact inputs to reproduce a run offline (formalise `scripts/*-probe.mjs`) | Engineer | S |
| 9 | **Personalisation proof** — run the same page with a "generic buyer" brain and diff (the `cat-probe` generic-vs-scenario diff, in-panel) | PM/CEO | M |
| 10 | **Persona switch** — one control that sets default debug depth (L1/L2/L3) | all | S |
| 11 | **Landing + Last-page + Results traces** — today only the 3 LLM pages emit `considered`; the deterministic pages have no ledger | PM/HOD | M |
| 12 | **Failure-mode / fallback log** — which fallback fired and why (pns 500 → swallowed, thin-brain, corpus-race) | COO/Engineer | S |

**Recommended build order:** atoms-per-page (#1) → FILL provenance chip (#2) → contribution matrix (#4) + cost/latency rollup (#6) + CEO card (#5) → TUS/BES (#3) → the rest. #1 is the keystone: once every page emits the 5 atoms, layers 1–2 are pure aggregation.

---

## BUILT — 2026-08-11 (phase 1, live-verified on GLID 106815489 / "Girish", AI-Debug mode)

**Keystone shipped:** `src/lib/rfq/debugTrace.ts` — a PURE aggregation (`buildRunTrace(llm, raw, sources, canon)`, `import type` only so it is unit-testable) that rolls the three telemetry streams the panel already holds (LLM call records · captured raw I/O · source health) into a typed `RunTrace`: `story` (knew/asked/total/invented) · `kpi` (TUS%, BES-proxy) · `gates` (fabrications, dedupViolations) · `ops` (cost, LLM-ms, slowest source, parse-fails, source empty/error) · `contribution` (per-source) · `exceptions`. 7 unit tests in `rfqCore.test.ts` (**97/97 pass, tsc clean**).

**Panel (`BrainDebugPanel.tsx`):** a **persona lens** (CEO/COO/HOD/PM/Engineer, persisted in `localStorage.rfqDebugPersona`, sets default depth L1/L2/L3) + **L1 Story card** (knew-N-of-T · asked-M · "✓ Nothing invented" seal or "⚠ N unverified prefill" · plain understanding sentence · "a form no other buyer gets") + **L2 Scorecard** (one KPI line `TUS% · BES · sources · fabr/dup/parse-fail · $ · LLM-s · slowest source`, expanding at depth≥2 to the per-source contribution chips + exceptions-only list) + a **⬇ replay-bundle export** (serialises inputs+telemetry to JSON, user-click download). Live proof: TUS 67% (4/6) · 0 fabr · 0 dup · dead PNS surfaced as a red ∅ chip AND an exception.

| # | Gap | Status |
|---|---|---|
| 4 | Per-source contribution matrix | ✅ DONE (chips, red ∅ on no-contribution) |
| 5 | CEO story card | ✅ DONE |
| 6 | Cost + latency rollup + bottleneck source | ✅ DONE ($ + LLM-ms + slowest source). p50/p95 needs a multi-run window — not done (single-run panel). |
| 7 | Fabrication + dedup-violation counters | ✅ DONE (both, assert-0 gates; dedup uses the real `canonConcept`) |
| 10 | Persona switch | ✅ DONE |
| 3 | TUS + BES | 🟡 TUS DONE (real proxy). **BES is a proxy** (asks + chip-weight) — true BES needs tap/type/time telemetry not captured today. |
| 1 | Per-page atoms unified | 🟡 PARTIAL — run-LEVEL rollup done; per-PAGE atom record + landing/last-page/results traces not (only the 3 LLM pages emit `considered`). |
| 12 | Failure-mode / fallback log | 🟡 PARTIAL — dead-source + parse-fail surface as exceptions; explicit "which fallback fired" not logged. |
| 8 | Replay bundle download | ✅ DONE (button; formalises `scripts/*-probe.mjs`) |
| 2 | On-form FILL provenance chip (on the real form, not debug) | ❌ DEFERRED — touches the live form UI (higher risk); flagged from the start. |
| 9 | Personalisation proof (generic-vs-scenario in-panel diff) | ❌ DEFERRED — needs a second "generic buyer" run to diff. |
| 11 | Landing + Last-page + Results traces | ❌ DEFERRED — deterministic pages still emit no ledger. |

**Net:** the whole aggregation spine (keystone + L1 + L2 + persona switch + replay) is done and live. The 3 deferred items (#2 on-form chip, #9 diff, #11 non-LLM-page traces) and the BES-realness half of #3 all need NEW instrumentation beyond the existing telemetry — the honest next phase.
