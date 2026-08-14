# Dynamic RFQ — Complete Architecture (V5, audit-verified)

**Date:** 2026-08-10 · supersedes V4 as the *current-state* doc. Deep design rationale still lives in
`DYNAMIC-RFQ-HANDOFF.md` (§1–§16) and `RFQ-ARCHITECTURE-V4.md`; this file is the **verified snapshot + defect ledger**
after a live probe + code-grounded audit on 2026-08-10.

**Verified this session (not asserted):**
- Frontend: `tsc -p tsconfig.app.json` clean · **79/79 tests** · 3-LLM flow coherent (audit below).
- n8n live probe (`imworkflow.intermesh.net/webhook/…`): `bi-rfq-details` **200**, `bi-csl-parser` **200**,
  `bi-pns-insights` **500 on every buyer** — root-caused to a one-line scope bug, fixed in `bi-pns-insights-FIXED6.json`
  (see §3). **Not yet live** — needs the owner to import FIXED6 into n8n.

---

## 1. The whole picture

```
        buyer opens ?rfq=brain
              │
Page -1  BrainFormGate ......... GLID · PNS mode · Exec mode · Reasoning effort · Surface
              │  load() → leaf fetches (CSL/RFQ) + monolith brain (bi-requirement-brain)
              ▼
Page 0   Landing ............... search / mic / camera · repost + viewed-product cards
              │  commitProduct → mcat resolve → CSL-collision mcat swap → qty/unit gate
              ▼
Page 1   Specifications ........ LLM 1 · Requirement Brain (fires on commit)         ── model: gemini-3.5-flash-lite
              ▼
Page 2   Commercial ............ LLM 2 · Commercial Planner (warranty/delivery/pay)   ── effort threaded to all 3
              ▼
Page 3   About You ............. LLM 3 · Persona Planner (designation/industry/size)  ── prod prompt = stripped
              ▼
Page 4   Your Profile ......... deterministic MERGE LAYER (dedup) + GST/contact/delivery
              ▼
         Results ............... curated seller search (windmill)
```

Stage machine: `landing → specs → commercial → persona → more → results`. `specs2` is deleted (no dead fall-through).
Reference blueprint `?rfq=brain2` (`src/components/rfq/DynamicRFQ.tsx`) — **do not ship**; the shipping form is `?rfq=brain`.

---

## 2. Frontend — audit verdict: the 3-LLM machinery is SOUND

Confirmed in code (file:line in the audit log): stage machine clean; LLM 2/3 fire on their stages and render;
prod vs debug prompts genuinely separate (`PROD_SUFFIX` strips evidence/reasoning); `applyBudget` keys on question
identities; commercial+persona answers ride the submission payload; all three LLMs on `gemini-3.5-flash-lite` with
`reasoning_effort` threaded. On an LLM-2/3 **failure** the code shows a retry card (does not blank the page, does not
skip a real plan) — safer than the old auto-skip.

**The breakage is at the two ENDS, not the middle:**
- **The submission is dropped.** `BrainFormGate` mounts `<BrainRFQForm>` with **no `onSubmit`**, so the fully assembled
  RFQ (text + specs + commercial + persona + brain) is emitted to telemetry then discarded. The "results" page is
  cosmetic. → owner decision needed (real BuyLead POST endpoint). `BrainRFQForm.tsx:~2130`, `BrainFormGate.tsx:~290`.
- **Seller search is expired + fixture-bound.** `sellerSearch.ts:~28` rides a hardcoded `TEST_AK` whose `exp` is in the
  past, and sends **only page-1 specs** (no commercial/persona/brain), keyed per-mcat so a last-page city/spec edit
  never re-fires. → owner must supply the real per-session token; the payload-widening is a frontend follow-up.

---

## 3. n8n — one workflow, 10 endpoints (`bi-pns-insights.json`, 85 nodes)

All ten webhook paths route correctly (guard → work → terminal/respond); 8 use `responseMode:lastNode`, 2 use a
respond node. Endpoints: `bi-csl-raw`, `bi-rfq-details`, `bi-bpod`, `bi-category-brain`, `bi-buyer-brain`,
`bi-csl-parser`, `bi-transcribe`, `bi-whatsapp`, `bi-requirement-brain`, `bi-pns-insights`.

**THE LIVE BREAK (found + fixed 2026-08-10):** `bi-pns-insights` returned **HTTP 500 `Error in workflow` for every
buyer**. Cause was NOT the token (the `pns-insights-api` HTTP node is `onError:continueRegularOutput`, so a 401 would
not throw). Cause was `pns-parse`: `const rowsOut = []` is declared **inside** the `try` block, but the v17 tail line
`Object.assign(out, __mcatsSeen(rowsOut))` runs **outside** the try/catch — `rowsOut` is block-scoped and out of scope
there → `ReferenceError` on every execution → 500. Fixed in **`~/Downloads/bi-pns-insights-FIXED6.json`** by reading
the in-scope `out.insights` instead: `__mcatsSeen(out.insights || [])`. Only `pns-parse` had this (sibling
`pns-api-parse1` is clean, which is why the transcribe/requirement-brain paths never 500'd).

⚠️ **ACTION — OWNER:** import `bi-pns-insights-FIXED6.json` into n8n, then re-probe
`GET imworkflow.intermesh.net/webhook/bi-pns-insights?glid=268590579&pns=api` (expect 200 + `status:empty`/`ok`).
⚠️ **Security:** FIXED5/FIXED6 carry **10 inline JWT tokens** (the earlier `$env.PNS_AK` injection was reverted). The
file is secret-bearing — keep it out of git; ideally move the tokens back to `$env`. Assistant never read/echoed them.

---

## 4. Model + gateway (unchanged from V4)

`src/lib/gemini.ts`: `MODEL_FAST = MODEL_RICH = google/gemini-3.5-flash-lite` (form); `MODEL_CARD = google/gemini-2.5-flash-lite`
(buyer-card path only — 401s on anything else). Gateway = LiteLLM→OpenRouter at `imllm.intermesh.net/v1` via the vite
proxy `/api/llm`, key injected server-side. `reasoning_effort` requires `allowed_openai_params:['reasoning_effort']`
alongside it or it is silently dropped (the V4 gateway fix); effort is selectable on page -1, default `high`,
mode-independent. `reasoning_effort:'none'` is rejected by the gateway — omitted, never sent.

---

## 5. Defect ledger

### Fixed this session (frontend — tsc clean, 79/79)
| # | Fix | File |
|---|---|---|
| D6 | Category staleness token bumped on **every** effect path (seed short-circuit + `!mcatId` return no longer leave a prior mcat's fetch live) | `BrainRFQForm.tsx` cat-brain effect |
| D4 | Planner **generation tokens** (`cxGen`/`psGen`) — last-*issued* fire wins; a slow thin-context fire can no longer overwrite the rich plan or mis-advance the stage | `usePlannerController.ts` |
| D5 | `haveCategory` also honors the full corpus, not just distilled top_specs (stops a needless no-category re-fire) | `usePlannerController.ts` |
| D10 | Profile/WhatsApp source health uses `hasPayload` (was `d != null` → green-on-empty) | `dataLayer.ts` |

### Fixed this session (n8n — needs owner import)
| # | Fix | File |
|---|---|---|
| N1 | `pns-parse` `rowsOut` out-of-scope ReferenceError → universal 500 | `bi-pns-insights-FIXED6.json` |

### Owner action required (credential / endpoint / infra — not mine to do)
- **BuyLead POST endpoint** — wire `onSubmit` to a real endpoint so submitted RFQs persist (today: dropped). Sending
  buyer data on their behalf → needs the real endpoint + your go-ahead; I will not point it at a guessed URL.
- **Seller-search token** — replace the expired static `TEST_AK` with the buyer's real session token.
- **Import FIXED6** + move the 10 inline JWTs back to `$env`.

### Deferred (known, lower value — not done)
- Seller search should include commercial/persona/brain specs + re-fire on last-page edits (frontend, moderate).
- Unclamped `asked_pct` (>100) from the verbatim corpus reaches LLM 2 (distill clamps; corpus bypasses it). Low impact.
- LLM-1 collision-override branch is near-dead on the normal path (re-anchor happens pre-brain by design).
- OTP bypass + empty contact on the leaf/GLADMIN flow (simulator behavior).
- Dead engine-era surface (~engineDecisions/placement/baq/identityAsk permanently empty + their render blocks) — safe
  to delete, but it's a large removal; left for a dedicated pass.
- `RFQ_MODEL_IMAGE`/`RFQ_MODEL_USECASE` hardcode `gemini-3.6-flash` (escapes the flash-lite lock) — a deliberate
  multimodal-quality choice per V4, not a bug.

---

## 6. Is it in a "bad or worse" state? — the honest answer

**Better than V4 on the mechanical axes** (compiles, 79 tests, committed) and the 3-LLM core is coherent. **One thing
was genuinely, silently broken in production** — `bi-pns-insights` 500'd for every buyer — now root-caused and fixed in
FIXED6 (pending your import). The remaining real gaps are the **two ends** (submission persistence + seller-search
token), both of which need an owner/infra decision, not more form code. So: **sound engine, verified; two ends need
wiring that only you can authorize; one n8n import to close the live 500.**
