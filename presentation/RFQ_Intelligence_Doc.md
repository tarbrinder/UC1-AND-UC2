# RFQ Intelligence — Walkthrough Doc (what is being done, how)

**Companion to:** `RFQ_Intelligence_Deck.html` (5 slides)
**One line:** The May “BL Enrichment” proposal, now **live at the source** — the RFQ form interprets PNS/CSL/WhatsApp/history *while the buyer types*, instead of degrading the requirement and reconstructing it later.

> **Core thesis (proven in pilot):** *We are not missing data — we are missing interpretation.* Every pilot bug (potatoes, notebook-paper, desktop-peripherals) showed the intelligence already existed in the Buyer Twin; the RFQ simply wasn’t consuming it. The work has been **consumption**, not more data or a bigger model.

---

## How to attach the LIVE images
Run the dev server, open `http://localhost:5173/?debug=1`, open **Smart RFQ**, and capture each figure below. Drop the PNGs into `presentation/images/` with the exact filenames — the deck auto-shows them (until then it shows a labelled placeholder).

| Fig | File | GLID · Product | What to capture |
|---|---|---|---|
| 1 | `images/fig1-final-bl.png` | 268590579 · *Notebook Making Machine* | Step 2 **“Your Requirement”** (spec chips + Buyer-context + Buyer-profile-deduced line) **and** the **🤖 AI Impact** panel (~91% effort reduced) |
| 2 | `images/fig2-walkthrough.png` | any · *TMT Bar* / *Notebook Paper* | Page 1: product + qty + **Pull** + the journey-adapted **Intent question** with chips |
| 3 | `images/fig3-twin.png` | 268590579 | Spec step (`?debug=1`): **🧬 Buyer Twin** + **🕵️ Dossier** + **🧠 Requirement Understanding** panel |
| 4 | `images/fig4-intent.png` | 42897602 · *potatoes* | Intent question chips (Processing/Retail/Restaurants/Feed) + “**Looks like a new area for you**” + **🧭 History influence: OFF** |
| 5 | `images/fig5-specs-truth.png` | 268590579 | Spec page (cascade-filled chips + per-spec **provenance**) + **🧾 Final RFQ Truth Table** |

---

## 1 · RFQ Walkthrough
**Flow:** `Product + Qty → GLID Pull (7 signals) → Buyer Twin → Intent-first (1 tap) → Planner (≤3) → Specs (auto-filled, editable) → Deduced delivery/payment → Enriched BL`

- **Pull** hits one webhook returning 7 sources (buyer_profile, PNS, CSL, WhatsApp-out/in, prev BL, prev ISQ). A **Pipeline-Health** panel shows exactly what arrived and what failed.
- **Intent-first:** the WHY question is asked *before* any spec (it replaced the old “who’s buying?” toggle). It is **journey-adapted** (chips fit the product) and shown as a one-tap **confirmation** when we can derive it.
- **Planner asks only the unknowns** — anything the Twin knows is skipped and listed in **“Why Asked / Why Skipped”**. Hard cap **≤3** questions.
- **Decision hierarchy (locked):** Current Requirement **>** Requirement Mode **>** Intent **>** Verified Truths **>** Persona/History. *Nothing inferred ever overrides what the buyer is doing now.*

## 2 · Buyer Profile Enrichment (the Buyer Twin)
- The 7 signals are compiled into a persistent **Buyer Twin** — persona, maturity, sourcing/communication style, intent clusters — **each trait with an evidence ledger** (the call/RFQ/chat that justifies it).
- Surfaced for the seller (PII-free) on the BL as **“Buyer context”**, and audited in **🧠 Requirement Understanding** (value · confidence · source · evidence · used-by) across **9 dimensions**.
- **Live (GLID 268590579):** *“Kanpur-based manufacturer, repeat raw-paper buyer for notebook production, WhatsApp-first, local-preferred”* — active-intent **Notebook Manufacturing Inputs (95)**, maturity **Execution Phase**.

**Safety:** only the buyer’s own answers / the question engine can *hide* a question; Twin/History/Cascade/Verified **prefill or shape options but never silently suppress** — the guard against over-personalisation. (`suppressiontest` locks this.)

## 3 · Persona Questions & Requirement Mode
- **Requirement Mode (8, ephemeral):** sample · one-off · recurring · bulk · capital · project · emergency — derived from qty + unit + intent + archetype + repeat-signal, and it **outranks the persona** for *this* order (a habitual bulk buyer ordering 1 unit → treated as a sample).
- **Current beats history (pilot-hardened):**
  - **On-profile** (notebook paper · notebook manufacturer) → intent = *Notebook Manufacturing Inputs* (the Twin corrects an ambiguous product).
  - **Off-profile** (potatoes · electronics buyer) → *“new area for you”*, history weight ≈ 0, fresh questions (**History influence: OFF** is shown).
  - **Diaper · 1 pc · B2B trader** → End User · **sample_trial** · advance — the business persona is correctly demoted.

## 4 · Specs
- IndiaMART **ISQ** specs + **cascade auto-fill** (one signal → dependent specs) + **intent-driven re-rank** (the specs that matter for *this* intent float to the top) + **per-spec provenance** (User / Cascade / Twin-History / Deduced, with confidence) + the buyer can **× remove** any spec they don’t want (it won’t be re-added).
- **Final BL** = corrected title/qty/specs/location + buyer persona, **every field sourced** (🧾 Truth Table) → a decision-grade BL for the seller.

---

## Maps to the May CEO proposal (BL Enrichment)
| Proposal output | RFQ today |
|---|---|
| Correct title / category / quantity / missing specs | ✅ at source |
| Application / use-case | ✅ (intent engine) |
| Buyer persona / type | ✅ (Twin + profile) |
| Requirement mode (sample/bulk/…)** | ✅ *(ahead of the proposal)* |
| Quick **Re-post** of past requirements | ✅ *(ahead of the proposal)* |
| Location / supplier preference | 🟡 captured, not yet driving matching |
| Procurement **stage / maturity** | 🟡 inferred, not yet a lifecycle |
| **Business model** (Notebook *Manufacturer*, not just Manufacturer) | 🟡 **biggest next gap** |
| Price sensitivity / **purchasing power** | 🟡 band only — GST/turnover await external creds |
| Deal blockers · live PNS-transcript spec-extraction | 🟡 shared with the **offline LEAP/n8n** track |

**9 persona dimensions:** 2 fully consumed (Who, Use-case) · 7 inferred + now visible, loosely driving (stage, urgency, power, local, awareness, comms, support).

## The 4 proposal examples → RFQ behaviour
- **Paper raw material (Kanpur):** RFQ → intent *Notebook Manufacturing Inputs*, recurring, Kanpur local-pref, manufacturer. *(GSM range still buyer-typed.)*
- **Polyester waste (Guwahati) & 9-bolt machine (Kannauj):** the *wadding→waste* correction and exact-product attribution came from **PNS-transcript extraction** — that’s the **offline LEAP track**; the RFQ uses the distilled Twin, not live transcript mining. This is the **WA/PNS-distillation** seam.
- **Dupatta reseller (Hyderabad):** RFQ → reseller persona, small-batch (sample/one-off), multi-SKU history surfaced.
- **HDPE bottle (Pune):** RFQ → manufacturer, local (Pune), grade-sensitive — captured via Twin + specs.

## What’s next — Requirement Understanding Engine v2
1. **Business-model inference** — basket (notebook machine + paper + ink) → *Notebook Manufacturer / Raw-material procurement / New-factory-setup*; offer business-model chips (*Wholesaler / Distributor / Processor / Exporter*), not just use-cases.
2. **Maturity-as-lifecycle** — Exploring → Setup → Commissioning → Production → Expansion → Replacement (changes qty/budget/urgency expectations).
3. **Deep WA/PNS distillation** — “107 messages” → *58 GSM · Kanpur supplier · MOQ-sensitive* (the proposal’s real power; bridges to the offline track).
4. **External purchasing power** — GST/HSN/Udyam (creds-gated; World/OSINT kept **observed-only** until confidence-scored — no bogus “verified” facts).

> Once these land, the 9 fields stop being independent and become a **coherent buyer story** — exactly what the May proposal aimed at.

---
*Engineering note: tsc clean; 11 deterministic harnesses green (coverage, requirement-mode, re-post, suppression, intent-skip, requirement-understanding, planner-guard, brand-trap, VEKA, distil, external). All buyer-facing flow changes are debug-gated where experimental.*
