# Final Plan v2 — "HOD-proof" Explainability (Decision Trace + Truth Table)

> ## ✅ SHIPPED & LIVE-VERIFIED (2026-06-05)
> - **Truth Table** (last page) + **Trust column** (VERIFIED/HIGH/MEDIUM/LOW/BLOCKED) + **AI Contribution** summary card — verified GLID 68151813 + cold drives.
> - **P3 — per-spec provenance bar** (`🤖 Ranked #N · ✨ filled by <src> · TRUST (conf) — <evidence/rationale>`).
> - **P0 — Pipeline Health** (`🩺 GLID · webhook path+latency+records · 7 sources 🟢⚠🔴 · twin conf+ms · planner · single verdict`).
> - **P4 — Decision Timeline** (`🕓` chronological replay of `window.dataLayer`, every row carries glid+bl_id).
> - **P6 — intent-driven spec RE-RANKING** (the one behaviour change): first intent answer → re-run planner → reorder UNTOUCHED specs only, lead+manual pinned, anti-jitter, `🔄 moved #X→#Y` badges + persistent `🔄 Re-planned after: X` banner + `rfq_replanned` event. Verified: Centrifugal Pump + "Submersible" → Power #6→#2, 5 specs moved.
> ## ✅ FINAL 5 (reviewer punch-list — ALL SHIPPED & VERIFIED 2026-06-05)
> Both reviewers converged (ChatGPT 9.3/10 + Gemini) on exactly these, then "stop → pilot":
> - **SpecReason** — planner emits a per-spec ≤12-word WHY-HERE sentence; renders `💡 Why here: …` on every spec bar + in Why-Asked. Verified (10/10 specs on Centrifugal Pump + Cotton Tote Bag).
> - **Why Asked / Why Skipped** — `🧭` panel: ASKED (with needed-for reason) vs SKIPPED (Twin knew, conf / history / deduced). Verified.
> - **AI Impact card (executive)** — headline `Buyer effort reduced ~X%` + Questions avoided / Twin filled / Cascade / Deduced / External signals used / Gate blocks / Manual. Verified on last page.
> - **Unified Buyer Intelligence Ledger (P1+P1A)** — ONE panel: INTERNAL (7 n8n sources, all used-by-Twin=YES) + EXTERNAL (Befisc/Sign3/OSINT as *observed evidence, NOT a planning input*, each `used by Twin: YES/NO`). Verified live (external rows + Used-By-Twin).
> - **Contradictions block** — programmatic, **category-agnostic token-overlap** (NO hardcoded category literals; generic business stoplist only). Node-verified: bags↔pharma & pump↔food fire; steel↔steel & generic-only stay silent.
> Both reviewers' verdict: **freeze layout, wire analytics, start pilot.** "Do not build more APIs / Twin traits / confidence formulas / planners."
> (Optional/parked per "stop": P5 source-themes — the ledger already shows per-source detail + the Twin panel shows recent_intent_clusters.)
>
> ## ✅ POST-REVIEW SPEC-ORDERING REFINEMENTS (2026-06-05) — the "answerability" insight
> Triggered by the Cotton Tote Bag case (GSM led #1 for a retail buyer). Reviewers' converged frame: rank by **importance × buyer-answerability**, not importance alone. Both shipped, live-verified, NO category/spec hardcoding:
> - **Buyer-answerability ranking vector** (planner `specOrder` rule 3): score each spec by inference-power **AND** how confidently THIS buyer can answer it now (conceptual attributes from intent — use/size/look/branding — over fabrication metrics they'd ask a supplier to recommend), with INFERABILITY + DEPENDENCY, and an explicit **exception for technical/repeat buyers**. Per-buyer judgement, never a per-category rule. Verified: "Retail packaging" → GSM #1→#3; "Grocery shopping" → GSM stays #1 (correct — heavy goods → strength leads). Contextual, generic.
> - **Sequencing — intent before specs** (Refinement 2): when the plan has a conceptual wizard question, the spec list is **held** behind a placeholder + always-present **Skip** rail; the wizard auto-opens at the use-case question; on answer → "Tailoring your specs…" → the intent re-plan lands → specs **reveal already re-ranked**. Buyer never sees the cold order. `replanPending` covers the async gap; only the intent-gate trigger holds (never mid-interaction for lead-spec products).
> - **Robustness (caught in live test):** the LLM tags question `tier` non-deterministically (mis-tagged "primary use" as constraint). Hardened intent detection at all 3 sites to **`tier:intent` OR first requirement-bucket wizard question**, + strengthened the planner prompt to tag use/application/purpose as `intent`. Also carried `tier` through `planToDynQuestions` (was dropped). Without these the re-rank + hold would have silently no-op'd on mis-tagged runs.
> **Behaviour-change note for pilot:** the hold changes the funnel for every category with a conceptual wizard question (intent asked before specs) — intended, reviewer-approved, Skip-guarded.
> **Parked (optional):** Truth-Table per-spec "Buyer Likely Knows: High/Low" column (needs a new planner field); harder answerability weighting (trade-off: would demote genuinely-critical specs).



> **Goal:** an HOD opens `?debug=1`, runs one buyer, and narrates the whole flow —
> `Raw Signals → Twin → Planner → Gate → Field Decisions → Final RFQ` — **without the console**,
> and for **every fact** can see **value · source · confidence · evidence**.
>
> **Discipline (both reviewers):** observability, not more AI. ~90% is surfacing data we *already capture*
> (`gate_decisions`, `promptTraces`, `dataLayer`, `enrichmentRaw`, the spec-source sets, Twin evidence).
> Only new LLM touch = P6 re-plan (reuses `planRequirement`) + a `specReason` *field* on that same call.
> **Directives applied:** wire Befisc/Sign3/World into the debug **ledger** + let the **Twin** consume external
> *evidence*; **DPDP set aside for now** (revisit before prod); the last-page summary becomes the **Truth Table**.

---

## ⭐ THE centerpiece (build first — "if you do one thing"): Final RFQ Truth Table
On the **last page**, replace the chip recap with a table — **every captured field**, with provenance:

| FIELD | VALUE | SOURCE | CONF | EVIDENCE |
|---|---|---|---|---|
| Buyer Type | Trader | 🧬 Twin | 85 | 20 prev BLs, 67 WA |
| Use Case | Processing | 👤 User | 100 | typed step 1 |
| Quantity | 100 KG | 👤 User | 100 | typed step 1 |
| Quality Grade | FAQ | ✨ Cascade | 82 | from Use Case=Processing |
| Packaging Size | 25 KG | ✨ Cascade | 78 | from Use Case=Processing |
| Delivery Timeline | 7 Days | 🧠 Deduced | 74 | logistics belief |
| Variety | — (open) | 🔒 Gate | — | preference → more quotes |

Buyer sees a clean value list; **debug adds Source/Conf/Evidence columns**. Backed by a single
`fieldProvenance(key)` helper (reused by P3 inline). **This is where Twin + Planner + Cascade + Gate +
Signals all become auditable.** Directly satisfies your directive: *truth / filled / deduced shown on the last page*.

---

## Sequence
`Truth Table (+fieldProvenance) → P3 spec provenance → P0 health → P1 unified ledger → P4 timeline → P6 re-ranking → P5 themes → P-why`
*(Truth Table + P3 share one helper, so build together. Re-ranking (P6) is the only behavior change → explicit go.)*

### Truth Table + `fieldProvenance(key)` — centerpiece, reuse
`fieldProvenance` → `{source: User|Twin|Cascade|Deduced|AI|Gate, icon, confidence, evidence}` derived from
`manualSpecs / cascadeSpecs / enrichedSpecs / autoFilledSpecs / preferenceSpecs / deducedLogistics / buyerTwin / buyerTypeDeducedFrom`. No new calls.

### P3 — Per-spec Provenance bar (inline, on the form) — your core ask, reuse
Under every spec in `?debug=1`: **WHY HERE** (`🤖 Ranked #N — "<reason>"`, + `moved #8→#2` when re-ranked) ·
**WHO FILLED** (reuses `fieldProvenance`). Adds one `specReason` field to the existing `planRequirement` call.

### P0 — Pipeline Health panel — reuse, quick
Webhook (path `…-glid123` / HTTP / bytes / #records) · 7 sources ✅⚠❌ (buyer_profile can auth-fail alone) ·
Twin built? + conf + gen-time · planner ran? · one **failure reason** ∈ {ok·webhook-empty·parse-failed·profile-auth-failed·twin-failed·cold-start}.

### P1 + P1A — Unified Buyer Intelligence Ledger (INTERNAL + EXTERNAL in one panel) — reuse + wiring
One `🌍 Buyer Intelligence Sources` panel:
- **INTERNAL:** PNS · CSL · WhatsApp(in/out) · BL · prev-ISQ — status · records · **themes** (P5) · conf 95.
- **EXTERNAL:** GST · HSN · Udyam · World/OSINT · Sign3 · Befisc-ProfileAdvance — status · records · confidence · last-fetch · **Used? YES/NO**.
- **Twin mixed-attribution:** each Twin trait shows its source set, e.g. `Business Type: Trader · [BL, WhatsApp, GST nature] · conf 91`. Built by feeding external **evidence** into the existing `deriveBuyerTwin` pass (evidence-tagged), not a new call.

### P4 — Decision Timeline — reuse
Chronological: `GLID loaded → Twin built (conf) → Planner ran → Gate blocked Brand → User: Use Case=Processing → Planner re-ran → Quality Grade #5→#2 → Cascade filled → Logistics deduced → Submit`. Thin `logDecision()` over existing `track()`/`gate_decisions` + timestamps.

### P6 — Intent-driven spec RE-RANKING (the one behavior change) — 1 reused call
On first lead/application/persona answer → re-run `planRequirement` with the answer → new `specOrder`; apply **once**, anti-jitter (only re-rank untouched specs, never move a touched/above-cursor spec, re-lock); record `orig#→new#`; flash `🔄 Re-planned after: Use Case=Processing`. The tomato case proves the need (today: nothing moves).

### P5 — Source insights = themes (reuse Twin clusters, NO new LLM)
PNS/CSL/WA/BL show themes via Twin `recent_intent_clusters / intentHistory / historical_categories` + code-side top-terms. If richer later → add `source_themes` to the existing `deriveBuyerTwin` pass.

### P-why — Why Asked / Why Skipped — reuse
Per field: asked (twin-conf 0 · needed-for from `specReason`) vs skipped (twin-conf 91 · from Past BL) — from `explicit_unknowns` + `twinResolved`.

---

## External (EBI) — per your directive (DPDP set aside)
- **Wired into the debug ledger immediately** (all sources visible) and the **Twin may consume external evidence** (tagged `Observed`, never overriding internal behaviour).
- **Reality check (still blocked):** GST endpoint codes unknown + Udyam 402 → those rows show **"awaiting creds"** until provided. Befisc Profile Advance + Sign3 persona + World/OSINT **work now**.
- **Sign3 caveat (value, not compliance):** persona = social/breach/identity → ~no procurement signal, so it's shown as **Observed evidence, not a planning input**. (DPDP/consent to be revisited before prod, per your "ignore for now".)
- In-app wiring needs the EBI pipeline to run on GLID-resolve (server-side in prod); until then the ledger reads `window.__ebi` (sandbox can publish).

## Do NOT build (until the above ship → pilot)
More Twin traits · more confidence formulas · more external APIs · more planner layers · more LLM calls (beyond P6's reused re-plan).

## Acceptance test
HOD opens `?debug=1`, runs one buyer, and reads the **Truth Table** + **per-spec provenance** + **timeline** to explain every field's value/source/confidence and how specs re-ranked — console closed.
