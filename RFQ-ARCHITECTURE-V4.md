# Smart RFQ — Architecture V4 (as-built)

**2026-08-03.** This is the architecture **as it now stands in code**, after the owner-reviewed change round. `tsc` clean · **79/79 tests** · live-verified end-to-end on GLID `254950925`. Nothing committed.

Supersedes V3 (which was the evidence) and the change plan (which was the proposal). Where the owner **declined** a proposal, that is recorded here as a deliberate decision, not an omission.

---

## 1. What the owner decided

| Decision | Outcome |
|---|---|
| **PII stays in the prompt** (C1 declined) | Profile + WhatsApp still reach LLM 1 verbatim. Working flow preserved. **Risk noted once, not re-litigated** — 12/12 buyers carry mobile + name, 37 seller phone numbers. |
| **LLM 1 keeps consuming everything** (C6/C7/C8 declined) | PNS still blocks the brain; all four leaves still gate it; no pre-commit twin; no prompt projection. The brain gets the whole picture, and the cost is latency. |
| **CF-6 resolved** | Buyer specs **always** stay on page 1. Prefilled values are dropped **only on an mcat change**, deterministically at commit. |
| **Category corpus stays intact** | Not filtered before LLM 2. The prompt now carries the discipline instead: use it as a helper, skip its technical specs. |
| **WhatsApp `isq_answer`** (C4 deferred) | Waiting on the enquiries / deleted-requirements import, which will surface the same facts. |
| **PNS metric** (C15 declined) | Modes will demonstrate the case to management instead of a standing dashboard. |

---

## 2. Flow, as built

```
PAGE −1  BrainFormGate
         GLID · call-insights mode (api | full) · execution mode (prod | AI-Debug) · reasoning effort (High/Med/Low) · surface
            ↓ load(): resetSourceHealth + resetLLMTelemetry, then 4 leaves in parallel
PAGE 0   Landing — paints on CSL + previous RFQs; profile + WhatsApp land behind them
            ↓ commitProduct
         mcat resolve  →  ★ CSL IS THE CATEGORY AUTHORITY (C11)
                          exact-name → name-containment → catalogue-desc, each requiring a browsed ISQ
                          a swap sets collisionSwapRef ⇒ the wrong category's seed specs are DISCARDED
            ↓ parallel: GetIsq (buyer specs) · getISQs (seller split) · McatDtl · bi-category-brain
         qty / unit gate (units derived from the CORRECTED mcat)
PAGE 1   Specifications — buyer ISQ renders immediately; LLM 1 enriches
            ↓ LLM 1 · Requirement Brain  (blocks on all leaves + PNS — owner's choice)
PAGE 2   Commercial — LLM 2 ← brain + page-1 state + FULL category corpus + PNS + ★ buyer profile (C14)
PAGE 3   About You  — LLM 3 ← brain + page-1 + page-2 state + ★ buyer profile (C14)  [+ GST for business personas]
PAGE 4   Your Profile & Delivery — deterministic merge layer
            ↓
         Results — curated seller search
```

---

## 3. The change that mattered most: pages 2 and 3 were asking a fixed list

**Diagnosis.** Three things in the planner prompt colluded:

1. The **canonical-key rule** (added for merge-layer dedup) listed 11 keys and said "use these EXACT field keys". An LLM reads an 11-item list as a **menu**.
2. The **themes line** read as a second menu, despite saying "not limits".
3. **Nothing instructed prefilling.** The only mention was the prohibition *"never fabricate a prefill"* — so the model defaulted to `ask` for everything.

**Fix.** `PLANNER_SYSTEM` rewritten around two lead rules:

- **ANSWER BEFORE YOU ASK.** Establish the fact from the inputs first; emit `prefill`/`confirm` and don't ask. *"A page on which EVERY row is ask is a failure: it means you did not read the Requirement Brain."* Prefills are free — they don't consume the budget.
- **THINK, DON'T PICK FROM A LIST.** Keys are a **naming convention**, not a permitted-question list; coin your own `snake_case` for anything else. *"At least ONE question must be specific to THIS buyer or THIS product and appear in no generic list. If two different buyers in this category would get the same page from you, you have not done the job."*

Plus a hard page-purity clause per planner: LLM 2 must **skip** any technical spec the corpus hands it, however high its `asked_pct`; LLM 3 may ask only about the buyer.

### Live result (GLID 254950925, food/bakery buyer)

**Page 2 — before:** Delivery Timeline · Payment Terms · Supplier Type · Purchase Frequency (the generic list, every time).
**Page 2 — now:**
- **`Delivery Location` → prefilled "Ahmedabad, Gujarat"** ← read from the profile, not asked
- Required Delivery Timeline → *Within 3 days* · *Scheduled recurring delivery* (perishable-aware)
- Preferred Payment Terms → *50% Advance, 50% on Delivery* · *Against Delivery (COD)* · *Credit Terms (15-30 Days)*
- **`Batch Dispatch Preference` → *"As per stock freshness"*** ← a question that exists in **no** generic list and is meaningful only for a perishable

**Page 3 — now:**
- **`Confirm Buyer Industry` → "Bakery & Confectionery"** ← a **confirm**, not a blank ask
- Business type → *Retail Bakery Shop* · *Wholesale Food Distributor* · *Cake And Pastry Parlour* · *Hotel Or Restaurant Outlet*
- Designation → *Store Owner Or Proprietor* · **_Head Chef Or Baker_** · *Senior Procurement Manager*
- No page-2 concept reappears.

---

## 4. Frontend changes, as built

| ID | Change | Where |
|---|---|---|
| **C2** | **Pages 2/3 reset on product change** — plans, answers and all fire-once refs. Previously a product switch left the old answers in the session, and because the merge layer drops anything already answered, they **silently suppressed the new product's questions**. | `BrainRFQForm` commit block |
| **C3** | **Shown-but-blank page-1 questions reach the merge layer.** `buildSession` sees values only, so a rendered-and-skipped spec was invisible to dedup — a guaranteed double-ask. New `page1Shown` (buyer ISQ + `aiSpecs` + extras) threaded to both planners. | `plannerController` · `usePlannerController` · `BrainRFQForm` |
| **C12** | **Concept-level dedup.** `dropAnswered` now resolves both sides through `canonConcept()` — a 12-concept alias map — and checks the **label** as well as the field. `"when do you need it"` now collides with `delivery_timeline`. | `plannerController.ts` |
| **C5** | **PNS green-on-empty + contradiction alarm.** Health is now `hasPayload && rows > 0`, and a red source when the buyer's own profile records calls but the API returns none. Live: *"CONTRADICTED — profile records 2 call(s), API returned 0 rows."* | `dataLayer.ts` |
| **C10** | **Pages 2/3 have loading and failure states.** Skeleton rows while the planner thinks; on a genuine failure a plain message + **Try again**. Critically, **failure no longer auto-skips** — an empty plan still skips (nothing to ask), but a transport/parse failure is shown. | `BrainRFQForm` · `usePlannerController` |
| **C11** | **CSL as category authority**, three-tier match (exact name → containment → catalogue `desc`), each still requiring a browsed ISQ so a working schema is never traded for none. `cslAuthorityRef` reports which tier won. | `BrainRFQForm.commitProduct` |
| **C14** | **Profile reaches both planners.** LLM 3 previously received **no profile at all** — asked to understand the buyer while shown nothing about him. Prompt states the measured reliability: city/state/district and the engagement counters are 12/12; **`business_type` and `designation` are 2/12 and must be treated as UNKNOWN**; `buyer_product_sold` means he is himself a seller. | `llm.ts` · hook · component |
| **CF-6** | **Resolved.** `visibleSpecs = isqSpecs` — buyer specs always render. The LLM boolean no longer removes half the form. | `BrainRFQForm` |
| **C16** | **Canonical naming documented** — three PNSes and two WhatsApps disambiguated in `dataLayer.ts`, including the `sender` × `channel` orthogonality and the `kind` fidelity tier. | `dataLayer.ts` |
| **C19** | **`promotedLastPage` deleted** — it rendered five commercial/persona fields **on page 1** whenever `placement[f] === 'spec_page'`, unreachable only because `setPlacement` was a no-op. A landmine, not a feature. | `BrainRFQForm` |
| **C20** | **`?rfq=brain2` gets the merge layer** — the blueprint ran the same prompts with no cross-page dedup at all. | `DynamicRFQ.tsx` |

---

## 5. n8n — `bi-pns-insights-FIXED4.json`

85 nodes · 10 webhook paths unchanged · all 38 code nodes pass `node --check` · **18 credential literals byte-for-byte identical** (verified by hash-set) · no live HTTP request made.

| Change | Validation over the 12 recorded buyers |
|---|---|
| **CSL window 30 days → 48 hours** | Only the span literal changed; IST offset and format untouched. Verified `20260801 → 20260803`. Emits `window_hours`, `window_from/to`. |
| **`bi-bpod` empty-field prune** | **2772 → 1329 leaf fields (52.1% reduction), 0 non-empty fields lost.** The 6 meaningful zero-counters whitelisted — **72/72 instances kept**. Emits `pruned_fields_count`. |
| **`seller_cities` fixed** | Root cause: the old fallback grabbed the badge line. **Numeric "cities" 23 → 0**, **badge-as-seller-name 24 → 0**, **0 real cities lost, 13 gained.** New structured `sellers[]` with name/city/rating/reviews/domain. |
| **`explicit_business_intent` false positive** | Now derived only from `sender === 'buyer'` **and** `kind === 'free_text'`, with our own category/product names masked out first. `['distribution'] → []`; no true positive lost. |

**Still yours:** import FIXED4 · reconcile `EMP_ID` with the AK in `pns-insights-api` · rotate + vault the inline credentials · parallelise the `t2` full-suite chain (still a linear 10-node chain with zero fan-out) · route VANI to persona only.

---

## 6. The honest cost of the owner's latency decision

Measured on the verification run, effort `high`:

| call | reasoning tokens | latency |
|---|---|---|
| `requirement-brain` | 3,094 | **14.1 s** |
| `commercial-planner` | 4,062 | **14.8 s** |
| `persona-planner` | 3,106 | **17.2 s** |

**≈46 s of LLM time across the three pages.** The stated budget was 1–2 s to interactive on page 1.

This is a **deliberate trade**, not a defect: C6 (PNS off the critical path), C7 (un-block the brain) and C8 (pre-commit twin + projection) were the three fixes that would have closed it, and all three were declined in favour of the brain consuming everything. Page 1 still renders from buyer specs without waiting, so the *first* page is fast; pages 2 and 3 now have skeletons instead of a bare spinner (C10). Dialling effort to **Medium** on page −1 is the one lever available without revisiting C6/C7/C8.

---

## 7. Still open

1. **Twin write policy + staleness** — C9's principle is locked (*evidence with provenance, never bare conclusions*) but there is no twin yet, since C8 was declined.
2. ⚠️ **Twin key** — requesting GLID `154357970` returned `254950925` as canonical. Verify before any persistence is keyed on the requested value.
3. **The submission is still discarded** — `dispatchBuyLead` calls `onSubmit?.(req)` on `undefined`. Needs a real BuyLead endpoint.
4. **Seller search token expired 2026-06-19** — a credential, so yours.
5. **~700 lines of engine-era UI** still inert but present.
6. **`emit.ts` `sendBeacon` is commented out**, so the new planner-failure events never leave the browser. One line plus a collector URL.
