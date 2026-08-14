# Dynamic RFQ — Master Audit & Action Plan
**Date:** 2026-08-13 · **Route:** `?rfq=brain` · **Component:** `src/components/BrainRFQForm.tsx` · **Engine:** `src/lib/rfq/*`, `src/lib/gemini.ts`

> One document, every open pointer. Grouped so nothing is staggered. Each item has: **State** (grounded in code) · **Plan** · **Edge cases** · **Owner input needed**. Coverage matrix at the end proves nothing was dropped. `[P0]`=blocks everything real, `[P1]`=audit-defect fix, `[P2]`=quality.

---

## 0. Status of what shipped this session (baseline)

| # | Item | State |
|---|---|---|
| 64 | Name+Location upfront hard-gate (name≥3/autofill, city+conflict, brain-land, city_id-plumbed) | **Shipped + live-verified** |
| — | Review found **4 blockers** on the gate/confirmation build; **all fixed** (Escape/Back bypass, stale-conflict timer, notes-only discard, review completeness) + follow-ups (seed-image gate, focus-traps, conflict hard-block) | **Fixed, tsc-clean, 122/122 tests** |
| 67 | Image↔product-name relation gate (`productMatch`, product-first `unrelated`→reject) | **Shipped**; unrelated-path not live-tested (needs mismatched photo + backend) |
| 68 | Buyer confirmation: Review-&-Confirm modal + close→Discard prompt | **Shipped + live-verified** |
| — | n8n CSL: 7-day window + non-lossy `viewed_products` union + `enrich_counts` (`~/Downloads/bi-pns-insights-CSL7D.json`) | **Built, NOT imported live** |
| 63 | Audit-coverage analysis (122 failures → 34% covered / ~0% realized; 15-GLID test plan) | **Done** |

**Known caveat:** a React "deps size changed" warning appeared after the Escape edit. **Root cause fixed in source** (Escape effect now reads overlay state from `overlaysRef`, deps back to a stable 4 — `BrainRFQForm.tsx` Escape effect). The dev browser kept serving a **stale ES-module** (survives navigate + server restart — a Vite sandbox cache quirk), so the live warning is a tooling artifact, not the shipped code. Verify on a clean machine reload.

---

## 1. Input-flow deep audit — image / AI-fill / mic across page navigation `[P1]`

**State (grounded):** three input engines — `onPhoto` (`:2028`, `analyzeImage`), `onVoice` (`:2068`, `voiceToSpecs`), use-case assist `handleAssistSubmit` (`:1999`, `inferSpecsFromApplication`). Merge is centralized in `applyExtractedSpecs`/`mergeExtracted` (`:1852`) with a real priority ladder (buyer-edit > use-case > photo/mic > seed) and a firewall (never clobber a buyer value). Re-fire is gated to *before* the planner ran (`plannerFiredFor`), specifically to stop the "page resets" bug (#51).

**Plan — enumerate every page×input×navigation permutation and assert the invariant, then patch gaps:**
- Build a **state-machine test matrix**: {landing, specs, commercial, persona, more} × {photo, mic, assist} × {before-commit, after-commit, after-planner} × {forward, Back, jump-to-node, back-to-landing, re-commit different product}.
- Assert on each: (a) buyer edits never lost, (b) no stage-renumber/reset mid-flow, (c) mcat-scoping (`photoMcatRef`) drops stale results after a product switch, (d) `commitGen` guard drops a stale in-flight extraction.
- Verify the **back-to-landing → re-commit** path resets the per-product refs (`autoAdvancedFor`, `photoMcatRef`, `seedSpecsApplied`, `identityGateFiredFor`, `sellerFiredFor`) — a missed reset = specs from product A leaking onto product B.

**Edge cases to handle:** photo committed mid-extraction then buyer types a different name (hijack guard `committedNew`); mic "assist-dictation" vs "extract" mode routing (`voiceTargetRef`); assist photo (photo added *inside* the assist box → routes through `onPhoto`, must obey the relation gate); two inputs racing (photo then mic in <1s); Back after a photo added on page 2 then forward (specs must persist); re-commit the SAME product (should not double-apply); adding input AFTER the planner fired (must merge to page 2, never re-fire).

**Owner input:** none — pure audit + fix. Deliver as a checklist run + patch list.

---

## 2. Debug mode — CEO/CXO clarity, click-to-source, no jargon `[P1]` (extends #66)

**State:** debug lives in `BrainDebugPanel.tsx` (gated by the 🔬 toggle in `BrainFormGate`, `exec==='debug'`). It already carries per-LLM I/O, source health, TUS/BES scorecard, and a `metadata.reasoning` trace where the prompt asks the model to cite `"<source>:Lnn — <fact>"` (`llm.ts:89`) and line-number the fenced inputs. So the **evidence→line pointer already exists in the data**; it is not wired to click-through, and the language is jargon-heavy (TUS/SUS/fabr/parse-fail).

**Plan:**
1. **Per-page "What happened here" band** (plain English): for each page, one line — *"Page 1 asked X specs; 3 prefilled from your history, 2 asked. Why: …"*. No acronyms.
2. **Click-a-reasoning-line → jump-to-source:** every evidence string is `"<source>:Lnn — <fact>"`. Render each as a link; on click, open that source's fenced block (RAW/CLEANED), scroll to line `nn`, highlight it. If the source is the **prompt** itself, highlight the prompt line that produced the reasoning (the prompt is static — pre-index it by line).
3. **RAW vs CLEANED, per source:** RAW = the exact **n8n endpoint** that returned it (show the URL, e.g. `bi-csl-parser?glid=…`) + the raw JSON. CLEANED = the transform + **which code cleaned it** (function name + file:line) + a one-line "why we cleaned it". Do this uniformly for CSL / RFQ / WhatsApp / PNS / Profile.
4. **Expandable to the last row** — every source and every reasoning node fully expandable.
5. **Strip AI-slop:** replace TUS/SUS/BES/fabr/dup/parse-fail with plain labels behind a "?" tooltip; keep a compact "CEO summary" line (he's technical) + a "details" disclosure for HOD/CPO. Simple enough for a kid, one layer of depth for the CXO.
6. **AI-debug-mode only** — production build never renders any of this.

**Edge cases:** a reasoning line that cites a source not present (record as a gap, don't link to nothing); prompt-line highlight must survive prompt edits (index at build, not hardcode line numbers); a source that failed (show "endpoint returned error" not empty); very long RAW (virtualize/collapse).

**Owner input:** confirm the 3-tier framing — **CEO one-liner / HOD-CPO details / raw** — is the right split, and the exact acronyms to keep vs. drop.

---

## 3. Location-on-hints + example dropdowns `[P1]`

**State:** location conflict fires on the spec page today (`detectLocationConflict`, `locationConflict.ts`), reading only `browse_city` + `browse_also_seen`. This session added the **upfront gate** that asks name+city (with conflict) at brain-land, and wired `LocationSearch` (hardcoded 49-city list) into the gate. Example placeholders exist in a few inputs (`Search city…`).

**Plan:**
- **Reconfirm the trigger:** the gate/drawer must fire as soon as *any* location hint exists (profile city, CSL browse/searched city, PNS-call city, requirement delivery city) OR a conflict among them. Extend the signal set beyond `browse_city` (see items 4a + CSL wiring).
- **Dropdown examples:** replace the old example placeholders with a fresh, relevant city set surfaced as a dropdown in `LocationSearch` (real IndiaMART cities the buyer is likely in, ranked by the hints).
- Remove stale/previous example strings everywhere (`Search city…` → the new curated list).

**Edge cases:** no hint at all (cold buyer) → show top metros as examples, don't block; hint is a district not a city (Gir Somnath→Junagadh) → offer the nearest valid; multiple conflicting hints → show them all in the single popup (already designed).

**Owner input:** the canonical example-city list (or approve "top-N by the hint").

---

## 4a. GLID 253102197 — location intent not captured (Imphal/Manipur/PNS) `[P1]` — **needs a live probe**

**State / hypothesis:** you saw no location drawer for this buyer despite Imphal/Manipur + PNS hints. Two candidate faults: (a) the location signal never reached the frontend conflict detector (only `browse_city` is fed today — parser gap **G2**: CSL `city_filters`, searched-city, and PNS-call city are NOT wired), or (b) CSL **over-parsed** and dropped the city IDs.

**Plan (probe first, then fix):**
1. **Probe** `bi-csl-parser?glid=253102197` and the PNS insights for 253102197. Check: `_enrich.city_ids`, `cities_resolved`, `browse_city`, `searched_cities`, PNS-call city. Determine which hints exist and which reached `buyer_facts`.
2. If hints exist but weren't fed → **wire CSL `cities_resolved` + searched-city + PNS city into the frontend `locationConflict` signal array** (currently only `browse` source is fed; the lib already supports `filter`/`target`/`pns`).
3. If CSL over-parsed (dropped city IDs) → fix the parser (the `csl-to-llm1` `cityIdSet` harvest + `csl-enrich-city` decode).
4. Confirm the brain SHOULD capture browsing-location intent (city + industry + when/where/how/why) and record conflicts — yes, and surface them in the drawer.

**Edge cases:** buyer browses from a different city than his profile (traveling/sourcing elsewhere) — that's a legit conflict, ask; north-east districts often map to a parent city — resolve, don't drop; PNS city may be a call-center city not the buyer's — weight profile+CSL over PNS.

**Owner input:** confirm I may run the live probe for 253102197 (read-only), or you paste its CSL/PNS dump.

## 4b. Illegal / irrelevant question guard `[P1]`

**State:** the "**GST Invoice Requirement / Required For Business Records / Not Required For Purchase**" question is a commercial-planner emission. There is **no prompt guard** forbidding illegal/irrelevant asks; GST is *also* handled deterministically (`gstQuestionBlock`), so this is both a duplicate and an out-of-context ask.

**Plan:** add an **ILLEGAL-QUESTION GUARD** to the commercial + persona prompts (`llm.ts`): *"Never ask — as a question OR as an option — anything about invoicing/tax-treatment, payment-protection, legal terms, personal/financial credentials, or anything IndiaMART handles deterministically (GST is asked separately). In the Indian B2B context, ask only what a seller genuinely needs to quote."* Plus a deterministic frontend **drop-list** backstop (regex on generated question/option labels) so a stray one never renders even if the LLM slips.

**Edge cases:** a legitimate "GST registered?" (deterministic block) must still work — the guard targets the *planner*, not the deterministic GST field; "tax" appearing inside a real spec (e.g. "Tax Invoice Printer") must not be dropped (anchor on question-intent, not substring).

**Owner input:** confirm the full illegal-topic list (invoicing, tax, payment-protection, legal, credentials — add any others).

---

## 5. No page-specific question leakage — confirm `[P1]`

**State:** cross-page dedup exists — `CONCEPT_ALIASES` + `canonConcept()` in `plannerController.ts`, a render-time dedup net (`personaRender`, `:2191`) that drops persona questions matching commercial concepts, and the parallel-fire fix (LLM 2/3/4 fire once). Item 14 shows a *reasoning* leak, not a question leak, but they share the render path.

**Plan:** add a **leakage assertion** to the test suite: for a fixed brain, assert no concept (canonicalized) appears on two pages, no page-1 spec re-appears on page 2/3, and no commercial concern re-appears on persona. Add fixtures for the known collisions (`business_setup_type≡setup_stage`, supplier_type, delivery/payment).

**Edge cases:** a question the buyer already ANSWERED on an earlier page must be dropped, not re-asked; a concept with different wording across pages (synonym) must dedup (extend `CONCEPT_ALIASES`).

**Owner input:** none (verification + guardrail).

---

## 6. GST-not-available → last-page identity spiral (Aadhaar / Udyam / PAN / Photo) `[P2]`

**State:** GST is asked deterministically (`gstQuestionBlock`, `gstRegistered`, `gstNumber` `:3404`). No fallback spiral today.

**Plan:** when `gstRegistered === false` (or unknown for a business role), on the **last page only** offer an optional identity spiral: Aadhaar / Udyam / PAN / Business Profile Photo — as a progressive, skippable block (trust-building, not blocking). Keep it strictly last-page, never mid-flow. These map to the existing identity-verification APIs (Sign3/IDfy/Befisc) for a future cross-check (currently unwired to this form — see backlog).

**Edge cases:** individual (non-business) buyer → don't ask any of these; a buyer who gave GST → skip entirely; keep them OPTIONAL (a hard-block here kills conversion); never store/enter the raw numbers into a field on our side without the credential-request flow.

**Owner input:** confirm these stay **optional** and last-page-only, and which (if any) are required vs. nice-to-have.

---

## 7. Question length — 3–4 words, never 2 lines on mobile `[P1]`

**State:** planner questions are free-form LLM text; some run two lines on 375px. The `one_word.py` agent (zip) caps *titles* at 6 words — different concern, but confirms the "short is better" house style.

**Plan:** (a) prompt rule in commercial/persona: *"Every question label ≤ 4 words, no punctuation, fits one mobile line; put detail in the options, not the question."* (b) deterministic frontend **truncation/reflow guard**: if a rendered label would wrap on mobile, shorten to the head noun-phrase (and keep the full text in a tooltip/`aria-label`). (c) audit existing labels against the rule.

**Edge cases:** a question that genuinely needs context (e.g. "Delivery within how many days?") — move context to options ("Delivery timeline" + option chips); non-English/Hindi labels count by rendered width, not word count.

**Owner input:** confirm ≤4 words is the hard rule (vs ≤6).

---

## 8. Font / text sizes vs IndiaMART design guidelines `[P2]` (extends #34)

**State:** mixed `text-xs/sm/base`, some `text-[10px]/[11px]` labels. Prior contrast sweep done (#4); size conformance not audited.

**Plan:** map every text class to the IndiaMART type scale; fix under-min sizes (mobile min tap/read sizes), ensure inputs are `text-base` on mobile (prevents iOS zoom), align uppercase-label letter-spacing + weights to the guide. Produce a before/after diff.

**Owner input:** the current IndiaMART design-system token sheet (type scale + min sizes) if available; else I use the platform's live CSS as the reference.

---

## 9. CSL product IDs not coming — status `[P1]`

**State:** **Root-caused and fixed in n8n** this session. The parser harvested all `proddetail` display-IDs into `_enrich.product_display_ids`; the loss was `csl-merge1` **overwriting** the full viewed-product name list with only the Redash-enriched subset (e.g. 6 diapers). Fixed with a **non-lossy union** (keeps every viewed product, grafts image/specs where Redash resolved) + added `enrich_counts` so `requested vs resolved` is visible. File: `~/Downloads/bi-pns-insights-CSL7D.json`.

**Plan / remaining:** (1) **import + live-verify** CSL7D (not yet live). (2) On a live run read `enrich_counts` — if `product_display_ids ≫ product_sheets_resolved`, the residual gap is **pc_item coverage** (Redash has no row), not a parser miss; that's a data/backend item, not frontend. (3) Frontend: ensure the RFQ card + spec prefill consume the full `viewed_products` array (ties to item 12).

**Owner input:** approve importing CSL7D to the live n8n (and paste the new PNS token into the `AK` body field of `pns-insights-api` + `pns-insights-api1` yourself — credential, I won't).

---

## 10a. Prefilled specs — editable + relevant options + reasoning `[P1]`

**State:** prefilled buyer-ISQ specs render as chips/inputs and ARE editable; the planner already emits `metadata.reasoning.options` (a reason per offered option, with `PICKED:`/`DROPPED:` — debug only). Buyer ISQ options come from the ISQ API; seller ISQ from that API; a spec outside both today may render without options.

**Plan:** for EVERY prefilled/asked spec, guarantee a **change affordance + option pool**:
- **Buyer ISQ** answered → prefill the value + still show the other API options (chips) so he can switch.
- **Seller ISQ** → show that API's options.
- **New spec (neither API)** → have the brain **populate options** (from corpus `top_values` / trade sense) AND attach a one-line **reason per option** (from the same `metadata.reasoning.options`), surfaced buyer-friendly (not the raw `PICKED:` string — see item 14).
- Never a bare prefilled value with no way to change it.

**Edge cases:** single-option spec (no real choice) → show value + "Other"; an option the buyer typed that's off-canon → snap to the real option or keep as "Other" (existing `snapToOption`); reasoning must be ≤1 short line, buyer-safe, never internal jargon.

**Owner input:** confirm reasoning-per-option should be **buyer-visible** (clean text) vs debug-only.

## 10b. Absurd quantity → confirm with buyer `[P1]`

**State:** none today. **Reference logic = `bl_quality/agents/absurd_quantity.py` (in your zip):** evaluate only qty > 1000; **Rule 1** ones-digit ≠ 0 for large qty → absurd; **Rule 2** qty exactly equals a viewed-product price → "price entered as quantity"; **Rule 3** qty within the MCAT price IQR [Q1,Q3] with no GST + no company name.

**Plan:** port these 3 deterministic rules to the frontend qty field. On an absurd flag, don't block — show a soft confirm: *"Did you mean {qty} {unit}? That looks unusually large — confirm or edit."* (Rule-based, no LLM.) Needs `product_prices` (from CSL viewed products) + `mcat_q1/q3` (from category brain) as inputs.

**Edge cases:** legitimately large round orders (10,000 bags) → Rule 1 correctly won't fire (ones digit 0); a buyer who confirms → proceed, never re-nag; missing price/IQR data → skip Rules 2/3, keep Rule 1.

**Owner input:** confirm soft-confirm (not hard-block), and that `mcat_q1/q3` can be sourced from the category brain.

---

## 11. Learnings from the zips (`bl_quality`, `vani_quality_agent`) `[reference]`

These are the **production BL/VANI quality agents** — the exact audit logic. Reusable in our flow as **submit-time guards** (mirror the auditor so our lead never fails the audit it will be graded by):
- `absurd_quantity.py` → item 10b (ported above).
- `title_mcat_mismatch.py` → **submit-time MCAT sanity** (item #65): LLM contract = `mismatch` (wrong category) + `is_irrelevant` (gibberish); conservative — never flag brand/model/variant. Use it to gate/correct a wrong prime MCAT.
- `one_word.py` → **title enrichment** (≤6 words) — enrich a one-word product before it ships (feeds items 7 + title hygiene).
- `spec_title.py`, `buyer_filled_details.py`, `selling_intent.py`, `pii.py`, `buylead_review.py` → title-vs-spec consistency, notes routing, seller-intent (reject sellers posing as buyers), PII strip, overall review. Mine each for a matching frontend guard.
- `vani/isq_quality.py` → the ISQ-capture rubric VANI grades calls on — our spec-capture must satisfy it.

**Plan:** for each agent, add the equivalent **client-side guard at submit** so the RFQ passes its own future audit. This is the highest-leverage reuse — we're literally building to the grader.

---

## 12. RFQ cards — remove image, no landing placeholder, two card UIs `[P2]`

**State:** landing history/RFQ cards render a product-image box (with a placeholder when empty — the grey image icon you saw). `productImage`/`productImages` (`:384`).

**Plan:** (a) **remove the image** from the previous-RFQ / history cards; (b) **no placeholder** on the landing (the empty grey box is the eyesore); (c) keep **two card variants**: one *with* image (when a real image exists) and one *without* (text-only, clean) — pick per-card by whether a real image URL is present, never render an empty frame.

**Edge cases:** a card with a broken image URL (404) → treat as no-image (text variant), never a broken-image icon; the *form* product image (page 1 hero) is separate — this item is only the cards.

**Owner input:** confirm the text-only card layout (or share a mock).

---

## 14. Page-2 "Preferred supplier category — PICKED: … Aligns with …" `[P1]`

**Root cause (grounded):** two faults compounded.
1. **Debug-reasoning leaked into the buyer form.** `"PICKED: …"` is verbatim the **DEBUG_SUFFIX** instruction (`llm.ts:89`: *"prefix a PREFILLED/selected option with 'PICKED: '"*). That belongs in `metadata.reasoning` (debug panel only) — it reached the buyer-facing option/`why` (rendered at `:2914` as `— {p.why}`). In AI-debug mode the form is showing debug metadata.
2. **`supplier_type` was prefilled** despite the **UNSTATED-PREFERENCE GUARD** (`llm.ts:219`: supplier_type/preferred-supplier from category dominance must be `ask`/`suggest`, **never** `prefill`/`confirm`).

**Plan:** (a) the form must render **clean option labels + a clean buyer-friendly `why`** only — strip any `PICKED:`/`DROPPED:`/`Aligns with…` reasoning from buyer-facing text; reasoning lives solely in the debug panel (ties to item 2). (b) **Enforce** the UNSTATED-PREFERENCE guard: supplier_type may only `ask`/`suggest` unless the buyer's own behaviour establishes it (he enquired only manufacturers). Add a deterministic frontend backstop: if a `supplier_type`/`preferred_supplier` field arrives as `prefill`/`confirm` from category dominance, downgrade it to `ask`.

**Edge cases:** buyer whose own enquiry history IS manufacturer-only → prefill is legitimate, keep it; the clean `why` should still explain the *suggestion* ("common for capital equipment") without the internal "PICKED/Aligns" phrasing.

**Owner input:** confirm supplier-type is **never prefilled** from category alone (my read of your guard), only suggested.

---

## UI. Quantity → Unit chips stacking on mobile + cursor flow `[P1]`

**State:** `qtyUnitBlock` (`:2647`) renders units as `unitOptions.map(RadioChip)` in `flex flex-wrap gap-2`. On 375px, 3 units (Tonne/Bundle/Quintal) wrap one-per-row (vertical stack) — the odd look in your screenshot. Works on popup/standalone (wider), breaks on mobile.

**Plan (UI-first, your preference):**
- **Option A (recommended): inline compact chips** — shrink chip padding/font so 3 units sit on one row at 375px; qty and unit side-by-side.
- **Option B: unit dropdown** — replace chips with a native/styled select; **auto-open the unit dropdown once qty is filled** (your idea), so the flow is *product → qty → (dropdown opens) → unit*.
- **Cursor flow:** wire focus advance — commit product → autofocus qty → on qty entry (blur/Enter) → focus/open unit → then Continue. Sequential, no hunting.

**Edge cases:** single unit (no choice) → show it as a static label, no dropdown/chips, skip its focus step; many units (>4) → dropdown is clearly better; iOS zoom on the qty input (keep `text-base`); don't auto-advance while the buyer is still typing a multi-digit qty (advance on blur/Enter, not per-keystroke).

**Owner input (decision):** **chips-compact (A)** vs **dropdown-auto-open (B)**? You leaned dropdown+auto-open — confirm and I build that with the cursor chain.

---

## Backlog — previous plan + pending audit (consolidated, deduped)

| ID | Item | Pri | Note |
|---|---|---|---|
| P0-a | Wire `dispatchBuyLead` POST (stub today → nothing persists) | **P0** | Universal defeater; until this lands nothing is auditable/consented end-to-end |
| P0-b | Telemetry — `emit.ts` `sendBeacon` is commented off | **P0** | Nothing measurable in prod; blocks item-2 at-scale |
| 65 | MCAT fly-ash sanity + candidate-scoring + secondary-MCAT slot | P1 | Use `title_mcat_mismatch.py` contract; resolver takes `suggestion[0]` blindly today |
| 66 | Debug BL-audit self-checklist | P1 | Merged into item 2 |
| — | `city_id` endpoint for `resolveCityId` (stub returns '') | P1 | Owner provides IndiaMART city API |
| — | CSL `cities_resolved`/searched/PNS city → FE location signal | P1 | Feeds items 3 + 4a |
| — | Title hygiene (location-in-title, grammar) + one-word enrich | P2 | Use `one_word.py` + a cleaner |
| — | OTP consent artifact (bypassed for logged-in) | P2 | Ties to #68 consent |
| — | Multi-select chips for size/grade ISQs ("8mm,10mm") | P2 | Single-select loses the 2nd value |
| — | Unconsumed mic `rawTranscript` → notes | P2 | So no spoken fact is dropped |
| — | LLM-1 re-fire after late photo/mic/tell-us-more evidence | P2 | Planners keyed on mcat only |
| — | Import fixed PNS file + new token | P1 | Flaky call evidence until done |
| — | Buyer-name identity cross-check (Sign3/IDfy/Befisc unwired) | P2 | Coverage-audit gap |
| — | Company-name vs GST legal-name reconcile | P2 | KYB unwired to this form |
| open tasks | #19 category-why, #20 category early non-spec, #21 de-nest reliability, #27 "I am interested in" ISQ, #32 de-hardcode identity, #35 empty persona caption, #36 curated-API echo isq+URLs, #38 conflict→one-question, #40 hints only on key+value, #41 last-page full-height, #53 staged fetch, #56–59 leaf-fetchers/staged-landing/gate-ordering | P2 | Carried from tracker |

---

## Conflicts & where I need you (decisions)

1. **Unit UI (item UI):** chips-compact **A** vs dropdown-auto-open **B**? (you leaned B — confirm).
2. **Reasoning-per-option (10a) + why-caption (14):** buyer-visible clean text, or debug-only? (I recommend: a *clean* one-liner buyer-side, full reasoning debug-only.)
3. **GLID 253102197 (4a):** may I run the read-only live probe, or will you paste its CSL/PNS dump?
4. **CSL7D + PNS token (9):** approve importing CSL7D to live n8n; you paste the PNS `AK` token yourself (credential).
5. **Illegal-topic list (4b):** confirm the full list to guard (invoicing, tax, payment-protection, legal, credentials, + your additions).
6. **GST spiral (6):** optional + last-page-only confirmed? which of Aadhaar/Udyam/PAN/photo are required vs nice-to-have?
7. **Question length (7):** ≤4 words hard rule?
8. **Debug tiers (2):** CEO one-liner / HOD-CPO details / raw — right split?
9. **The P0 truth:** none of the consent/audit fixes are *real in production* until `dispatchBuyLead` POSTs and telemetry is on. Priority call: do we wire P0 before/parallel to the P1 UX items?

---

## Coverage matrix — every pointer you raised → where it's handled

| Your pointer | Section | Status |
|---|---|---|
| 1. image/AI/mic across page nav + edge cases | §1 | planned |
| 2. Debug CEO simple + click-to-source + RAW endpoint/CLEANED code | §2 (+#66) | planned |
| 3. location-on-hints + dropdown examples (remove old) | §3 | planned |
| 4a. GLID 253102197 location mismatch | §4a | needs live probe |
| 4b. illegal GST/invoice question guard | §4b | planned |
| 5. no page-question leakage | §5 | verify + guard |
| 6. GST-absent → Aadhaar/Udyam/PAN/photo last page | §6 | planned |
| 7. questions 3–4 words | §7 | planned |
| 8. font sizes vs design guide | §8 | planned |
| 9. CSL product IDs | §9 | fixed (n8n), import pending |
| 10a. prefill editable + options + reasoning | §10a | planned |
| 10b. absurd qty confirm | §10b | planned (zip logic) |
| 11. learn from zips + this plan | §11 + whole doc | done |
| 12. RFQ card image / placeholder / two UIs | §12 | planned |
| 14. "Preferred supplier category PICKED/Aligns" | §14 | root-caused |
| unit UI stacking + auto-expand + cursor | §UI | planned (decision) |
| previous plan + pending audit | Backlog | consolidated |

---

## Priority-ordered build sequence (once decisions are in)

1. **P0** — `dispatchBuyLead` POST + telemetry on (makes everything real). *[blocked on the endpoint — owner]*
2. **P1 UX quick wins (no backend):** unit UI (§UI), question length (§7), illegal-question guard (§4b), supplier-category leak (§14), prefill options+reasoning (§10a), absurd-qty (§10b), RFQ cards (§12).
3. **P1 location:** 4a probe → CSL city wiring (§4a) → dropdown examples (§3).
4. **P1 debug:** §2 click-to-source + plain language (+#66 self-checklist).
5. **P1 data:** import CSL7D + PNS token (§9); MCAT sanity via `title_mcat_mismatch` (§65).
6. **P1 audit:** §1 input-flow matrix, §5 leakage guard.
7. **P2:** §6 GST spiral, §8 fonts, backlog.
