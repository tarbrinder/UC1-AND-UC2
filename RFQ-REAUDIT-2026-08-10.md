# Dynamic RFQ — Re-audit + fixes (2026-08-10)

Full re-check of the live `?rfq=brain` form + the entire frontend + the n8n workflow, "for any misses." Method: a live
browser walk end-to-end, plus three parallel code-grounded audit agents (n8n code-nodes · frontend submission/seller/seed ·
frontend LLM-engine/prompts). This supersedes the V5 ledger for the items below.

## A. Live walk — the flow works end-to-end
Walked page −1 → landing → qty-gate → Specs (LLM 1) → Commercial (LLM 2) → Persona (LLM 3) → merge layer, on a real GLID
(106815489) and a fixture (140092812). All stages render with real, product-contextual questions. Network: every leaf +
both `/api/llm` calls **200**; the merge layer correctly **drops** delivery-timeline + payment + industry from the last page
(Commercial/Persona covered them) — dedup confirmed live. The only live error is `bi-pns-insights` **500**, which the form
swallows gracefully. Qty-gate correctly disables Continue until quantity is given. Provenance mislabel (below) seen live.

## B. FIXED this pass (verified: tsc clean · 79/79)

### Frontend (`src/lib/rfq/llm.ts`, `dataLayer.ts`, `components/BrainRFQForm.tsx`)
| Fix | What |
|---|---|
| `category_trustworthy` coercion | `x !== false` coerced stringy `"false"`/`0` → **true**, inverting the collision override. Now stringy/numeric falses = false; absent still defaults trustworthy. `llm.ts` |
| Parse-shape guards (all 3 LLMs) | A valid-but-shapeless 200 (`{}`/wrong top key) was stamped a clean run → empty plan read as "nothing to ask". Brain now requires `brain`\|`page1`; planners require `questions:[]` array → else recordParse(false)+null (→ retry card). `llm.ts` |
| Brain chip-less ask filter | Page-1 `ui:ask` with <2 chips now dropped (same code contract the planners already had) — no raw text box. `llm.ts` |
| CSL/RFQ empty-array crash | `(...d[0]).summary` threw a `TypeError` OUTSIDE `safe()` on a `[]` response → could hang the loader. Now guarded. `dataLayer.ts` |
| CSL/RFQ green-on-empty | Both recorded `ok:true` regardless of payload; now gated on real evidence (viewed/searches / requirements length) — matches the 2026-08-01 `hasPayload` pass that missed them. `dataLayer.ts` |
| Provenance mislabel | "Also detected — **from your photo / voice**" was false: `extraSpecs` come from LLM-1 `known_truths` (WhatsApp/calls/CSL/past-RFQs). Now "auto-detected · confirm, edit or remove". `BrainRFQForm.tsx:2497` |
| (last pass) planner gen-tokens · cat-brain staleness token · haveCategory+corpus · Profile/WhatsApp hasPayload | see V5 §5 |

### n8n → `~/Downloads/bi-pns-insights-FIXED7.json` (import to apply; FIXED5/6 preserved)
| Fix | What |
|---|---|
| `csl-data-raw` P0 | The ONLY http node with no `onError` → a non-2xx 500'd the `bi-csl-raw` endpoint. Now `continueRegularOutput` + `alwaysOutputData`. **All 24 http nodes now have onError.** |
| `guard-pns` hardening | Bare `$json.query.glid` (throws if no `query`) → null-hardened to match every sibling guard. |
| (FIXED6) `pns-parse` `rowsOut` scope bug | carried over — the universal-500 fix. |

## C. NEEDS OWNER DECISION (not mine to change unilaterally)

1. **Import `bi-pns-insights-FIXED7.json`** into n8n → clears the live `bi-pns-insights` 500 (pns-parse) AND the `bi-csl-raw`
   500-on-error. Re-probe after.
2. **PII on the internal-card paths** (`bi-bpod`/`bi-buyer-brain`/`bi-requirement-brain` emit raw mobile/email/GST; `bi-transcribe`'s
   `assemble-rfq1` emits raw buyer mobile+name). The category + pns paths strip; these do not. Per project history (C1 was
   **declined** — "PII stays in the prompt, don't disturb the working flow") this is likely intentional for the GLADMIN card,
   but it is inconsistent and `bi-transcribe`/`requirement-brain` ship it in the *response* despite "debug-only" comments.
   **Confirm which paths are buyer-facing vs internal-card, and whether the transcribe path should strip.**
3. **Firewall prompt-contract items** (change LLM behavior — want your sign-off):
   - Brain `persona_read`/`understanding` are **required** with no grounding rule / no "leave empty" escape → cold-buyer
     fabrication propagates into LLM 2/3 prefills. Fix = make them nullable + add a "leave empty if no evidence" rule.
   - `ui:"suggest"` value is pre-filled onto a possibly-**empty** spec and shipped as STATED — needs a "was it buyer-filled?"
     gate (`BrainRFQForm.tsx:1325`) so an INFERRED value can't ride to the seller as stated.
4. **Seller-search expired `TEST_AK`** + **no BuyLead POST endpoint** (submissions dropped) — credentials/endpoint only you can supply.
5. **`stale buyer-brain1`** (`bi-buyer-brain`) never got the v9/v11 clustering fixes `buyer-brain` has (naive overlap, no
   NAME_RANK, no `_src` tag) → the old "Sweet Tray → Sweet Potatoes" merge. Sync it to `buyer-brain` (bigger port — flag).
6. **More inline secrets** in the n8n file beyond the JWTs (Redash key, an `sk-` LLM key, audio bearer, wahelp api_key) — rotate.

## D. DEFERRED (known, lower value)
`applyBudget` slice caps ALL questions incl prefills at 11 by array order (`llm.ts:234`); `canonConcept` `includes`-matching
over-collapses (timeline/sample/turnover, `plannerController.ts:31`); error-detail telemetry wired for only 2/6 sources;
seller ranking stale after a results-pencil spec edit (`BrainRFQForm.tsx:880`); collision-swap defeats the `seedSpecsApplied`
latch (`:1551`); structured submission omits logistics/profile/GST as discrete keys (text-only, matters when the BL API lands);
`category-brain1` dead `orders` accumulator; unclamped `asked_pct` from verbatim corpus; fence-tag injection surface (low).

## E. n8n endpoint verdict (post-FIXED7)
| Endpoint | Verdict |
|---|---|
| `bi-pns-insights` | SAFE (was 500 → fixed; hardened deep-mask, fail-closed) |
| `bi-csl-parser`, `bi-whatsapp`, `bi-category-brain` | SAFE |
| `bi-csl-raw` | fixed P0 (onError) — SAFE after FIXED7 |
| `bi-bpod`, `bi-buyer-brain`, `bi-requirement-brain`, `bi-transcribe` | AT-RISK — raw PII (owner policy call, C2 above) |
| `bi-rfq-details` | minor — `raw` unmasked (unverified; `summary` is clean) |

**Cleared (no defect):** `CuratedSellerBoard` renders only real response fields — no invented distance/price/rating/links;
post-CSL-swap mcat is consistent across seller-search + submission.
