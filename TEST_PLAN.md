# BTE Staging Test Plan — 134 GLIDs × 2 scenarios (for review/approval)

> **Process (your rule, honored):** instrument → **you approve this plan** → run the WHOLE test (no fixes mid-run) → per-case analysis → whole-test summary → ranked fix actions → **you review with ChatGPT/Gemini** → final fix plan → implement → **re-run**. No fix is built until after the report + your review.

---

## 0. Status

- ✅ **Done now — event tracking + `bl_id`** (see §1). Build green.
- ⏳ **Awaiting:** (a) your approval of this plan, (b) the **actual 134 GLID list** — it did **not** come through in the message (no numbers received). Paste them or drop a file (e.g. `/tmp/glids.txt`, one per line) and I'll wire it in.

---

## 1. Instrumentation shipped (pre-test) — the funnel + KPIs

Every `track()` event now auto-carries **`glid` + `bl_id`** (the BuyLead key, minted the moment a quantity is captured; reset per requirement so two requirements in one session never blur). The funnel:

| Event | Fires when | Key KPI it answers |
|---|---|---|
| `rfq_modal_open` | form opens | top-of-funnel impressions |
| `rfq_product_committed` | product + specs load | product-entry rate |
| `rfq_buylead_minted` | quantity captured → `bl_id` | the requirement key |
| `rfq_buyer_twin` | Heavy Twin compiles | twin confidence dist. |
| `rfq_req_plan` | planner returns | mode, archetype |
| `concierge_impression` | concierge card renders (fast-track) | how often we recognise a buyer |
| `rfq_concierge_confirm` | Yes / Something-changed | **Concierge Acceptance Rate** |
| `rfq_gate_blocked` | a brand/preference auto-fill blocked | **VEKA leaks (must be 0)** |
| `rfq_cascade` / panel events | spec cascade / wizard | spec assist usage |
| `rfq_completed` | Get Quotes submit | **completion + a full KPI snapshot**: `twin_mode, questions_asked, twin_skipped, concierge, twin_confidence, specs_total/filled/autofilled/cascade, brand_blocked, score` |

All land in `window.dataLayer` (GA-ready). In prod, swap the synthetic `bl_id` for the real BuyLead/Offer ID returned by the BL API on quantity capture — the injection point is one line.

**Recommended-but-optional (your call before run):** `rfq_step_advance` (step 0→1→2 drop-off granularity). Not added yet to keep the freeze tight; trivial to add if you want per-step funnel drop-off.

---

## 2. Harness architecture (faithfulness vs speed)

**Primary — in-app batch runner (recommended, zero divergence).** A debug-only `window.__bteBatch(glids)` that runs the **real production code paths** in the page — real enrichment webhook + real `deriveBuyerTwin` + `buildTwinPlanInput` + `planRequirement` + `classifyFieldTypes` + a simulated cascade (`inferSpecsFromApplication`) — via the Vite proxy. Driven by `preview_eval` in chunks, accumulating to `window.__bteResults`. Concurrency-capped (~6) to avoid gateway overload. **Why:** the existing `.mjs` harnesses *replicate* prompts (drift risk); for a 268-run correctness proof we want the literal app code.
**Secondary — full-UI E2E spot-check (~10 GLIDs).** Drive the actual UI through the whole flow (concierge render position, chips-only, no PII leak, funnel events firing with `bl_id`, the cascade grounding) on a representative spread (rich / sparse / stale / multi-role / off-profile-short-name). Catches UI bugs the logic runner can't (e.g. the auto-open ambush we already caught).
**Parallelism.** The browser is single-page, so the 268 runs are Promise-pooled *inside* the page (not multiple browsers). **Parallel sub-agents** are used to **analyze** the raw results — sharded batches of cases written up concurrently — which is where the wall-clock savings are. (Alt if you prioritize raw speed over fidelity: shard a Node harness across agents, accepting prompt-replication drift — not recommended.)

---

## 3. The two scenarios per GLID

For each GLID, after compiling its Twin:

- **A — Relevant / on-profile** ("a little older product"): pick a product from the GLID's **own** `historical_categories` / `recent_intent_clusters` (the most representative). Shares tokens with history → should **not** trip the breaker.
- **B — Non-relevant / off-profile** ("totally new"): pick a product **unrelated** to this GLID — chosen from a small rotating pool of distinct goods (e.g. Men's T-Shirt, Wall Paint, Office Chair, Yoga Mat, Ceiling Fan…) such that it shares **no ≥4-char token** with the GLID's history. (Pool is generic consumer/industrial items, not category-hardcoded logic.)

---

## 4. Assertions

**Scenario A (on-profile) — expect FAST-TRACK:**
- `twinMode === 'fast_track'` (when conf ≥60 & ≥1 high-conf known fact) — else documented why (`cold`/`none`).
- `concierge_impression` fires; bundled traits ≥1; PII-free & brand-free.
- `questions_asked ≤ 3` (the code cap held).
- `twinResolved` non-empty (it skipped known facts).

**Scenario B (off-profile) — expect DISCOVERY (circuit-breaker):**
- `twinMode === 'off_profile'`; concierge does **NOT** render.
- leads with `intent`/`scale` tier; `twinResolved` empty (no fast-track skip).

**Universal invariants (BOTH scenarios, every GLID):**
- **0 brand/preference auto-fills** (the VEKA guarantee) — `rfq_gate_blocked` for any brand field, never filled.
- **Cascade grounding** (the open 4d question): count auto-filled specs and flag any **ungrounded commercial-choice** fill (warranty / compliance / certification) not entailed by the signal.
- Chips-only (no free-text questions); no re-asking covered fields (qty/delivery/timeline/payment/GST).
- No PII in the seller-facing requirement summary.
- Valid JSON from every LLM pass; `bl_id` present on all events.

---

## 5. Coverage matrix ("left, right, centre")

Routing (fast/off/cold/none) · Twin quality (conf/freshness/grounding/contradictions) · **Bias gate (brand)** · **Cascade grounding (4d)** · Question budget (asked/skipped/tiers/cap) · Concierge (impression/traits/accept/changed) · UI/UX subset (render order, chips, hint, score, PII, events) · Edge cases (sparse=cold, stale, off-profile short-name tokenization, multi-role).

---

## 6. Output format (what I'll bring back — in this order)

1. **Per-case analysis** (134 × 2): GLID · Twin (conf/freshness/biz/top-traits) · **A**: product, mode, concierge, asked, per-assertion ✓/✗ · **B**: product, mode, per-assertion ✓/✗ · anomalies.
2. **Whole-test summary**: pass-rate per assertion · mode distribution · **brand-leak count (target 0)** · cascade-grounding stats · concierge-eligible rate · accept-rate (n/a in sim) · edge-case failures.
3. **Ranked action-to-fix list**: each finding → proposed fix + blast radius. (Known candidates already on the radar: 4d cascade grounding gate; off-profile short-name; discovery intent-lead compliance; `current_active_intent` quality. The run will confirm/expand these.)
4. → **You review #1–3 with ChatGPT/Gemini** → we lock the fix plan → I implement → **re-run** the same 268 cases to confirm green.

---

## 7. Open decisions for you to confirm before I run

1. **Harness:** in-app faithful runner (recommended) vs sharded Node harness (faster, drift risk)?
2. **`rfq_step_advance`** event — add it for per-step drop-off, or hold the freeze?
3. **The 134 GLIDs** — paste / file path.
4. Anything to ADD to the assertion set (§4) or coverage (§5)?
