# Persona360 New UI — Data-source & Gap Audit

Scope corrected by user: source of truth is `n8n/Buyer-intelligence.json`, webhook `buyer-intelligence`, not `buyer-persona-async`.

This audit is read-only against the current workflow export. The new UI must be additive and must not change existing routes/workflows.

## Workflow contract found

`Buyer-intelligence.json` flow shape:

- Final collector: `final-assemble`
  - Collects source nodes into `sources{}`.
  - Emits `source_registry`, `source_priority`, `sources_present`, `sources_absent`, `pipeline_health`, `pipeline_timing`, `total_pull_s`, and per-source `__health`.
- Product-facing parser: `08 — Intelligence Parser`
  - Consumes final payload and emits four top-level business sections:
    - `persona`
    - `sourcing`
    - `risk`
    - `internet_profile`
  - Also emits `needs_input`, `__health`, `__source_priority`, `__sources_present`, `__sources_absent`.

## UI section mapping

| UI need | Current workflow source | Status | Notes |
|---|---|---:|---|
| Persona section | `08 — Intelligence Parser.persona` | Available | Picked from LLM buyer attributes: `industry`, `business_stage`, `scale`, `annual_turnover`, `business_persona`, `business_type`, `buyer_maturity`. |
| Sourcing section | `08 — Intelligence Parser.sourcing` | Available | Picked from `price_vs_quality`, `annual_procurements`, `sourcing_channel`, `preferred_suppliers`, `procurement_approach`, `procurement_model`, `purchase_frequency`, `location_sourcing_preference`. |
| Procurement cities | `sourcing.procurement_cities` | Available | Deterministic from `sources.requirement.summary.search_cities` + `sources.csl.summary.browse_cities`, excluding buyer operating city. |
| Risk section | `08 — Intelligence Parser.risk` | Available | Deterministic flags copied from source-node output. Not LLM-scored. |
| Internet profile | `08 — Intelligence Parser.internet_profile` | Available | Includes GST, PNS profiling, and company/previous profile/KYB fields when present. |
| Source health / completeness primitives | `final-assemble.__health`, `pipeline_health`, `sources_present`, `sources_absent` | Available | Supports source-completeness UI, but no single percentage is emitted. |
| Pipeline timing | `pipeline_timing`, `total_pull_s` | Available | Can power loading/performance diagnostics. |

## Open questions closed

### 1. Numeric trust/risk scores like `46 / 58`

**Current status: gap / do not invent.**

The workflow does not emit a single numeric trust score or a single numeric risk score matching mockup-style values such as `46` or `58`.

What exists:

- `risk.fraud_seller_detection_score.value`
  - Deterministic passthrough from `sources.external.summary.sign3_scores.fraud_seller_detection_score`.
  - Raw Sign3 0–1 float when present.
  - Emits `'unknown'` when absent.
  - Workflow comments explicitly say: no banding/verdict labels until Sign3 provides banding; missing must never render as 0 / low risk.
- `risk.identity_confidence`
  - Comes from the LLM buyer output if emitted.
- `risk.digital_footprint`
  - Comes from the LLM buyer output if emitted.
- Source registry has `should_influence_trust_score`, but no formula turns those booleans into a numeric score.

Recommendation for K-2/K-5: render available deterministic risk facts and raw Sign3 score. If mockup requires `46/58`, mark as “score formula pending” unless product defines a formula.

### 2. Monthly engagement aggregation

**Current status: gap / derivable only with extra aggregation.**

No monthly engagement rollup is emitted by `08 — Intelligence Parser`.

Raw/material sources exist:

- `sources.csl` — clickstream/search/browse signals.
- `sources.requirement` — BuyLeads / ISQ history.
- `sources.whatsapp` — chronological WhatsApp timeline.
- `sources.pns`, `sources.pns_calls`, `sources.calls` — call-related activity.
- `sources.buyerprofile.summary.activity` — historical activity when present.

Recommendation: new UI may show raw activity summaries if present, but month-bucket charts require either frontend aggregation from dated rows or an explicit workflow node that emits `monthly_engagement[]`.

### 3. Supplier ratings

**Current status: partially available, with strict label.**

The parser emits:

- `risk.indiamart_seller_rating.value.avg`
- `risk.indiamart_seller_rating.value.count`

only when `sources.buyerprofile.summary.avg_rating` exists.

Important contract note from workflow: this is the GLID’s **seller-side IndiaMART rating** when the buyer is also a seller. It is **not** the buyer’s trust grade.

Recommendation: UI label must say seller-side rating / also-seller signal, not buyer trust score.

### 4. Credit / cheque / balance-sheet statuses

**Current status: not present as explicit UI-ready statuses.**

No `credit_status`, `cheque_status`, or `balance_sheet_status` fields are emitted by `08 — Intelligence Parser`.

Possible adjacent sources:

- `external` includes Befisc-derived income/PAN/identity material.
- `company_reg`, `gst_detail_union`, `gst_cert_idfy`, `udyam`, `pan_union`, `gstin_union` can support KYB facts.
- `conflict_tickets` provides dispute-history count.

But there is no explicit credit/cheque/balance-sheet contract in the parser output.

Recommendation: render these as unavailable/pending unless the source workflow adds named fields or product accepts derived labels with a documented formula.

### 5. PNS call stats

**Current status: available.**

`pns-parser.summary` emits:

- `call_count`
- `intent_level`
- `intent_narrative`
- `deal_readiness`
- `deal_readiness_reason`
- `deal_blockers`
- `persona`
- `order_type`
- `quantity_scale`
- `repeat_buyer`
- `b2b_or_b2c`
- `call_purpose`
- `intended_application`
- `intended_applications`
- `primary_language`
- `languages`
- `moq`
- `callback_urgency`
- `buyer_locations`
- `seller_locations`
- `seller_questions`
- `order_types`
- `products`
- `buyer_queries`
- `conclusion`
- `calls[]` per-call compact rows with `file_id`, readiness/intent, intended application, and products.

The parser merges pages from `pns-insights1`, `pns-insights-p2`, and `pns-insights-p3`.

Recommendation: K-2 can safely design a PNS panel around these fields.

### 6. Completeness percentage

**Current status: primitives available; percent not emitted.**

Available:

- `__health[]` per source: `{ node, ok, status, count, error_msg, retryable, version }`.
- `pipeline_health`: `{ ok_count, no_data_count, error_count, errors }`.
- `__sources_present`, `__sources_absent` from parser output.

Not available:

- No single `completeness_pct` field.
- No weighted source-completeness formula.

Recommendation: UI can show source count/completeness (“N present, M absent, E errors”) immediately. A percent should be added only after Chief/product defines denominator and weights.

## Must-have UI contract for additive K-5 build

1. Route-gated new page only; do not alter existing routes/workflows.
2. Fetch/render `buyer-intelligence` output, not async callback output.
3. Render the four parser sections directly: Persona, Sourcing, Risk, Internet Profile.
4. Preserve deterministic-vs-derived labeling:
   - Risk flags are deterministic source facts.
   - Sign3 fraud-seller score is raw 0–1 / unknown.
   - Seller rating is seller-side GLID rating, not buyer trust.
5. Show source health from `__health`, `pipeline_health`, present/absent sources.
6. For unavailable mockup fields, show pending/unavailable states rather than fabricated values.
7. PNS call panel can be fully backed by `internet_profile.pns_profiling.value` / `sources.pns.summary`.

## Fields requiring product/formula decision before faithful numeric UI

- Trust score number.
- Risk score number / banding.
- Completeness percentage weighting.
- Monthly engagement buckets.
- Credit / cheque / balance-sheet status definitions and source mapping.
