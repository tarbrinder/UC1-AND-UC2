# Smart RFQ — Architecture V3 (evidence-grounded)

**2026-08-03.** Supersedes V2. Every number below comes from a **12-buyer raw-source study** (60 pulls, dumps on disk), not from reading code or reasoning. Where V3 contradicts V2, V2 was wrong and the correction is marked ⚠️.

Cohort: `254950925 · 268590579 · 244092512 · 154357970 · 106815489 · 140092812 · 114449705 · 12268156 · 271739981 · 131410806 · 42049584 · 16473577`

---

## 1. The finding that reorders every priority: PII is already in the prompt

**Three of five sources carry live PII, and two of them reach the LLM verbatim today.**

| Source | PII present across 12 buyers | Reaches LLM? |
|---|---|---|
| **Profile (bpod)** | `mobile1` **12/12** · `contacts_mobile1` **12/12** · `contacts_name` **12/12** · `first_name` **12/12** · `contact_address` **12/12** · `email1` **11/12** · `zip` 7/12 · `ceo_fname` 3 | **YES — verbatim.** `fetchProfile` does no parsing (`raw === cleaned`) |
| **WhatsApp** | buyer first name **11/12** · **seller mobile numbers: 37 occurrences across 5 buyers** · seller websites 5 · **internal employee names** (16473577) | **YES — verbatim.** `fetchWhatsapp` does no parsing |
| **Previous RFQs** | `UserDetail.DATA` = full contact record: mobile **12/12**, email **11/12**, postal address 5/12 | **No — by accident.** `fetchRfq` sets `raw = summary`, discarding the branch |
| CSL | **none found** — no mobile, no email, no personal name in any of the 12 files | yes, and safely |
| PNS | (n/a — 6/12 returned nothing) | yes |

Two consequences:

1. **A PII firewall is now a first-class architectural layer**, not a rule in a prompt. It sits between *fetch* and *prompt*, and it is deterministic code.
2. ⚠️ **V2 was about to make this worse.** I recommended preserving the RFQ `raw` branch to recover order-value bands. That branch is where the full contact record lives — it is only safe today *because* it is thrown away. The fix must extract `order_value` **surgically**, never by widening the passthrough.

> **Rule:** a source may enter an LLM prompt only through a **declared projection**. No source is ever passed verbatim. The projection is a whitelist, not a blacklist.

---

## 2. Source truth — what each one actually is, at 12 buyers

### CSL — the journey source. PII-clean, richest, and the rightful category authority.
- Real journey data **11/12**. Intent-bearing **10/12**.
- **For 6 of 12 buyers the latest RFQ requirement's mcat appears nowhere in CSL.** The two sources disagree about what the buyer wants **half the time**.
- `12268156`: all 19 posted requirements are **expired** (9–176 days) while CSL shows `fly ash powder ×38` in the last two days. Without CSL the landing offers stale junk.
- **Untapped and valuable:** `viewed_products[].desc` (**35/35**, read by nothing — the single strongest free category disambiguator) · `last_seen` per-product recency · `categories[{id,name}]` with human names (10/12; for `114449705` it is the *only* product signal) · `evidence[].count` = intent intensity (`×90`, `×63`, `×38`) · `requirement{}` funnel telemetry · `suppliers{profile_visits, comparisons}` (12268156 made **43** supplier visits) · `contacted_seller.whatsapped`.
- **Health is useless as a data test: 12/12 report `csl_data_ok: true`, including the one genuinely empty buyer.**

### WhatsApp — ⚠️ my V2 recommendation was WRONG
V2 said "wire WhatsApp to the landing — confirmed." At 12 buyers that collapses:

> **11–13 of 13 buyer-typed CTA products are already carried by that buyer's own RFQ or CSL payload. No buyer gains a first tile from WhatsApp. A third product namespace buys ~0.08 new products per buyer.**

The 5-buyer sample made it look unique because I was reading *uniqueness within WhatsApp*, not *novelty against the other sources*. **Landing: no.**

But its real value is larger than the tiles I wanted it for. `kind` is a **fidelity tier**:

| `kind` | n | What it is | Where it belongs |
|---|---|---|---|
| `isq_answer` | **21** | The buyer answered a *named ISQ* | **Deterministic page-1 prefill — highest confidence** |
| `button_tap` | 53 | Chip selection (may be browsing) | Prefill candidate, lower confidence |
| `free_text` | 33 | Buyer's own words | Intent → LLM 1 |
| `caption` | 305 | Mostly **ours** | Context only. **Never intent.** |

Speaker split: **buyer 107 / ours 305 — only 26% of WhatsApp is the buyer.**

`sender` and `channel` are **orthogonal**: `channel` marks *which thread* (user-initiated vs paid campaign), `sender` marks *who spoke*. Filtering on `channel=inbound` would discard **31 buyer messages — 29% of all buyer voice.** Classify by `sender`; use `channel` as context.

**Already-answered facts sitting unread:** order quantity (`"Dried Sweet Potatoes · 5 Kg · YES"`), **`purchase_frequency` ("Monthly")**, **`sample_order` ("Sample Only")**, delivery geography (taps `Nalanda`, `Salem`, pincode `801302`), and use-case answers (`Animal Feed Binder`, `Snacks`, `Décor Use`).

> **`purchase_frequency` and `sample_order` are two of the eleven canonical keys the LLM-2 prompt enumerates. The buyer has already answered them on WhatsApp, and LLM 2 is never shown them — so it asks again.** This is the most direct violation of "never ask what we already know" in the system.

### Profile (bpod) — ⚠️ the two fields page 3 most wants are the two that are empty

| Reliability | Fields |
|---|---|
| **12/12 always** | `contact_city` · `contact_state` · `contact_district` · `location_preference` · `is_paid` · `membersince` · `enq_count` · `total_requirement` · `pns_call_cnt` · `total_calls` · `verification_status` · `products_of_interest[]` (34 rows, each with mcat id + name + **image**) |
| 4–9/12 | `company_name` 7 · `contact_pincode` 7 · **`buyer_product_sold` 5** (the buyer-is-also-a-seller flag) · `custtype_weight` 5 |
| **≤2/12 — effectively absent** | **`business_type` 2/12** · **`glusr_usr_designation` 2/12** · `buyer_product_of_interest` 0/12 · `avg_rating` 1/12 · lat/long 1/12 |

**So page 3 cannot read persona off the profile — it must ask or infer.** `business_type` and `designation` are exactly what a persona planner would want, and they are populated for 2 of 12 buyers. Conversely `city/state/district/location_preference` are 12/12 → those are **page-2 delivery facts**, not page-3 persona.

This answers the owner's "build more on profile for page 2 and 3" precisely: **page 2 gets the geography and the engagement counters; page 3 gets `buyer_product_sold` and the maturity signals, and must treat business_type/designation as unknown.**

### Previous RFQs — three sources in one envelope
- Requirements in **11/12** (60 total); identity/geography in **12/12** (present even for the buyer with zero requirements).
- **`order_value` in 27/60 rows across 9/12 buyers**, as Rupee bands (`"Rs. 70 - 74 Lakh"`, `"Rs. Upto 1,000"`).
- **`order_value ÷ quantity` = a unit-price expectation, computable on all 27** (they co-occur 1:1). `268590579`: 100,000 kg for ₹70–74 L ⇒ **₹70–74/kg**.
- `requirement_type` is `"Business Use"` in **20/20** non-null cases — useless as a B2C/B2B discriminator. **Quantity + order_value separate the buyers cleanly.**
- `MODID` = posting channel (FENQ×26, IMOB×15, FLPNS×8, WHAT…), `DATE_R` = hour-of-day (several buyers post at 22:00–23:00, one thrice at 06:00).
- `ETO_CUST_CREDITS`: `16473577` holds 11,400 of 202,200 with designation **CEO** — a **paying BuyLead customer, i.e. also a supplier.**

### PNS (buyer call insights, fast API) — the coverage gap, quantified
**6 of 12 buyers return zero rows while their own profile records calls.** In aggregate **66 API rows against 318 profile-recorded PNS calls ≈ 21%**; excluding one anomalous high-volume account, **16 of 297 ≈ 5%**. `12268156` has **116 recorded calls and the API returns 1.**

That is the number for the API-expansion argument. It should be a **standing metric**, not a one-off.

---

## 3. Naming — fix this first, it costs an hour per person

Three things are called *PNS* and two are called *WhatsApp*. I conflated the first set myself this session.

| Use | Name |
|---|---|
| Category-level call aggregation (Redash 13521 → `bi-category-brain`) | `category_call_insights` |
| Buyer's calls, fast API | `buyer_call_insights_api` |
| Buyer's calls, full audio→transcript over *all* calls | `buyer_call_transcripts_full` |
| 9696 inbound bot, often off-topic | `vani_bot_calls` |
| WhatsApp conversation thread | `channel` (inbound = user-initiated · outbound = paid) |
| Who spoke in it | `sender` (buyer · ours) |

---

## 4. The architecture

### 4.1 Layers

```
     ┌─────────────── FETCH ───────────────┐
     │  raw payloads, never used directly  │
     └──────────────────┬──────────────────┘
                        │
     ┌──────────────────▼──────────────────┐
     │        PII FIREWALL (code)          │  ← NEW, first-class
     │  whitelist projections per source   │
     └──────────────────┬──────────────────┘
                        │
     ┌──────────────────▼──────────────────┐
     │   BUYER TWIN  (persisted, bi-buyer-brain, keyed by GLID)
     │   DNA · social wiring · long-term memory     ← evidence + provenance, never bare conclusions
     └──────────────────┬──────────────────┘
                        │  per-page projections
     ┌──────────────────▼──────────────────┐
     │  REFLEX LAYER (deterministic code)  │  buyer specs on p1 · dedup · units · GST · chip contract
     └──────────────────┬──────────────────┘
                        │
                LLM 1 → LLM 2 → LLM 3      each sees only its projection
```

**Reflex is code, never a prompt.** Today "buyer specs never leave page 1", "no leakage", "never repeat" are sentences in prompts — that is a knee-jerk routed through the prefrontal cortex.

**The twin stores evidence with provenance, never conclusions.** Every derived claim carries `derived_at` + `from_evidence[]`; anything inferred is flagged `inferred` and is overridable. Otherwise the cake-as-transformer error would have been written into the twin and poisoned every future session, indistinguishable from history. **Contradiction policy: keep both and flag** — page 3 is where the buyer resolves it.

### 4.2 Source placement (evidence-based)

| Source | Fetch | Landing | Twin | LLM 1 | LLM 2 | LLM 3 | Evidence |
|---|---|---|---|---|---|---|---|
| **CSL** | gate mount | **BLOCK** ✓ | ✓ | ✓ **category authority** | — | — | 11/12 real; disagrees with RFQ 6/12; PII-clean |
| **Prev RFQs** | gate mount | **BLOCK** ✓ | ✓ (identity 12/12) | ✓ | ✓ order_value → unit price | — | 60 reqs; 27 order_value |
| **Profile** | gate mount | tiles fallback | ✓ DNA | ✓ | ✓ **geography 12/12** | ✓ `buyer_product_sold` | business_type/designation 2/12 → **must not be relied on** |
| **WhatsApp** | gate mount | ⚠️ **NO tiles** | ✓ | ✓ `free_text` | ✓ **`isq_answer` freq/sample** | ✓ channel behaviour | 0.08 new products/buyer; 21 isq_answers unread |
| **PNS api** | **gate mount (moved)** | — | ✓ | ✓ | ✓ | ✓ | glid-only; 21% coverage |
| **Buyer specs** | commit | — | — | **BLOCK** ✓ | via page1 | via page1 | the latency shield |
| **Seller specs** | commit | — | — | ✓ (must not block when empty) | — | — | — |
| **Category insights** | commit | — | — | **never** | ✓ | — | owner-locked; and the misroute is better-evidenced than the truth |

### 4.3 Timeline (owner budget: page 1 interactive in 1–2s)

```
t=0      gate mount → CSL · RFQ · Profile · WhatsApp · PNS   (all GLID-only, parallel)
t≈1-2s   landing paints on the first two to land (CSL + RFQ)
t≈2-3s   PII firewall → TWIN build/refresh  (background, product-independent)
           └─ returning buyer = cache hit ⇒ skipped
t=commit mcat resolve → collision check → GetIsq · getISQs · category-brain (parallel)
t+0.5s   PAGE 1 RENDERS from buyer specs alone. No LLM in the path.        ✅
t+~2s    LLM 1 ← twin projection + buyer specs + seller specs + product
           └─ autofill lands as a visible "✦ filled 3 from your history", never a spinner
page 2   LLM 2 ← twin(commercial) + form-so-far + category insights + WhatsApp isq_answers
page 3   LLM 3 ← twin(persona) + form-so-far   (business_type/designation treated as UNKNOWN)
submit   twin write-back, idempotent, evidence-stamped
```

Why this meets the budget: page 1 never waits on an LLM · PNS leaves the critical path · LLM 1's prompt becomes a compact twin instead of five raw dumps · **a returning buyer skips the twin build entirely.**

---

## 5. What changed from V2 — my three corrections

| V2 said | V3 says | Why |
|---|---|---|
| Wire WhatsApp to the landing — "confirmed" | ⚠️ **No.** Prefill + twin only | 11–13 of 13 CTA products already in RFQ/CSL; 0.08 new per buyer |
| Preserve the RFQ `raw` branch for order_value | ⚠️ **Surgical extraction only** | That branch holds the full contact record for 12/12 buyers |
| Profile → page 3 persona | ⚠️ **Geography → page 2; persona must be asked** | `business_type` and `designation` populated 2/12 |

---

## 6. Ranked actions

**P0 — correctness / safety**
1. **PII firewall.** Profile and WhatsApp currently enter the prompt verbatim, carrying 12/12 mobiles, 12/12 names and 37 seller phone numbers.
2. **Reset page-2/3 plans and answers on product change** (`BrainRFQForm.tsx:1034`) — stale answers suppress the new product's questions.
3. **Feed shown-but-blank page-1 questions to the merge layer** — `buildSession` uses values only, so a skipped spec is a guaranteed double-ask.
4. **Consume WhatsApp `isq_answer`** as deterministic prefill — 21 already-answered facts, including two canonical LLM-2 keys.

**P1 — the latency budget**
5. Move PNS to gate mount. 6. Un-block LLM 1 from WhatsApp/Profile/empty-seller-specs. 7. Build the twin pre-commit and shrink LLM 1's prompt to a projection.

**P2 — understanding**
8. CSL as category authority (`viewed_products[].desc` + `evidence[].count`). 9. `order_value ÷ quantity` → unit-price expectation. 10. Qty + order_value as the B2C/B2B discriminator (`requirement_type` is useless). 11. PNS coverage gap as a standing metric.

**P3 — hygiene**
12. Rename the three PNSes and two WhatsApps. 13. Fix `seller_cities` (it contains **review counts**). 14. `explicit_business_intent` false positive — `['distribution']` was lifted from the word "Distribution" in a category name.

---

## 7. Decisions still needed

1. **Twin write policy** — planners propose, one arbiter commits (recommended)?
2. **Twin staleness** — how long before DNA is re-verified?
3. **CF-6 vs "buyer specs always stay on page 1"** — these contradict each other in code today. Which wins?
4. **What fills the screen** when the brain exceeds 3s?
5. **Category corpus for LLM 2** — it carries *technical* seller questions; filter before LLM 2 sees them, or retag?
6. ⚠️ **Twin key** — requesting GLID `154357970` returned `254950925` as the canonical id. Verify before keying persistence on the requested value.
