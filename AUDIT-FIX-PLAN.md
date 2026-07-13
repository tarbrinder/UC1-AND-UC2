# RFQ Buyer-Intelligence — Exhaustive Single-Phase Change Plan

_Synced from: the multi-agent code audit (31 confirmed + 67 P2, adversarially verified) · your 6 responses · your HOD's observations document (`changes.docx`, 384 paras) · this chat's open decisions. **No code changed yet — this is the plan the HOD asked to see before implementation.** 2026-07-13._

> **Framing (per your HOD):** the product must stop being a *data-aggregation dashboard* and become a *Buyer-Intelligence platform* — **infer, don't populate; merge signals, don't repeat them; show what WE added, not what the DB holds.** Every audit fix below is kept, but re-cast under that lens: many audit "data-honesty" bugs and HOD "no duplication / no conflict" asks are the *same defect* and are merged into one workstream so we don't fix twice.

---

## PART 0 — Your 6 responses, locked in

1. **Remove the crawler.** Firecrawl OSINT + `CrawlerBand` are removed entirely; web intelligence comes only from **gweb (Gemini web-search)** and **Parallel.ai**. This moots two audit findings (`ledgerBands.tsx:782`, `gemini.ts:251`) and deletes `osintEnrich.ts` / `osintSignalsLLM` wiring.
2. **Parallel.ai may take 10–12 min — do NOT force it under 8 min.** New architecture (aligned with HOD obs-2): the frontend fires **all three tiers concurrently**; Superfast shows instantly; **Normal (which carries Parallel.ai) loads in the background tab** and enables when ready. n8n side: raise `executionTimeout` to 15 min, keep the Parallel poll generous, and — because strict proxies still cut long connections — add a **job-id + poll fallback** for the Normal tier (webhook returns `{job_id, status:'running'}` immediately, writes the finished payload into static-data cache keyed `glid:normal`, FE polls `?job=<id>` until ready). Nobody ever 504s; Parallel gets its full 12 min. _(One decision for you — see Part F.)_
3. **extract-v42 — agreed, hardened to your rule:** flag `annual_turnover` when it mirrors the income band; stop `procurement_approach` restating `purchase_frequency`; trim Procurement Challenge to top-1 + drill. **And the governing rule you added: "don't surface a requirement-specific field unless there is an explicit signal tied to that requirement."** This becomes a global omit-if-unevidenced gate on all requirement-side rows.
4. **Namesake suppression + the Dinesh/PAN failure.** Two things: (a) when *every* web field is namesake-flagged, **suppress the whole summary block** (not just tag it) so `indomaret.co.id` never renders. (b) **The real bug you spotted:** searching Dinesh Agarwal's PAN should have surfaced "IndiaMART" (he's associated) — instead we populated an Indonesian retail chain. Root cause = the web query is built from **name+city text**, not anchored to the **hard PAN/GST identity**, and Parallel's fuzzy text match wins. Fix: **PAN/GST-anchored query first**, and reject any web entity whose hard IDs don't match — a namesake with zero shared hard-ID is dropped, not shown. This is a correctness fix, not cosmetic.
5. **Emergent / Langfuse — de-coupled (you're right).** These are two *separate* things; I wrongly linked them:
   - *Emergent LLM key* — you supplied it to Emergent separately, so the deployed build reaching the model is **your infra, already handled — nothing to do in code.** I'm dropping the Emergent item.
   - *Langfuse secret leak* — this is a **genuine, independent** code bug: `traceExport.ts` reads the whole `import.meta.env`, so the Langfuse **secret** key is compiled into the browser bundle (and every offline HTML). That's a real secret-in-client leak regardless of Emergent. Fix = read only the specific non-secret vars client-side, move ingestion behind a proxy, rotate the Langfuse keys. **Kept as P0-security.**
6. **PII in downloads — kept as intended.** Full Aadhaar/PAN/income stays baked into the offline HTML. Logged informational only; no change.

---

## PART A — HOD observations → concrete engineering

### A-UI · the six interface notes
| # | HOD note | Change |
|---|---|---|
| UI-1 | Humanized node-health view missing for IndiaMART Buyer Profile · GLUSR, External · Befisc ⊕ Sign3, CSL | Add humanized renderers for those three node-health entries (they currently show raw). Extend the L-node health map so every source has a plain-English summary line. |
| UI-2 | Auto-load all 3 modes in parallel; default Superfast; disable others till ready; cache; instant switch, no reload | **New tri-tier loading engine** — see Part D-4. This is the biggest UX change and also absorbs your Parallel-timeout concern (Part 0.2). |
| UI-3 | "What is the need of *this section* on the BuyLead details page?" | **Blocked — the screenshot didn't extract from the docx.** My best guess is the L6 "enrichment run details" or the "How this buyer buys" block. Need you to confirm which (Part F). |
| UI-4a | Toggle buttons inconsistent size (BuyLead toggle too small); animation only on buyer card, not BuyLead | Unify the two toggle groups to one shared component (same size, padding, and the ring-pulse animation on both — or neither, your call; plan assumes **both animated**). |
| UI-4b | Replace emojis with SVGs — download icon (top-left near GLADMIN/BuyLead toggles) + the Available-section icons | Swap all emoji glyphs for a clean inline-SVG icon set (`lucide-react` is already a dependency). Covers the Available anchor row (📱✉️🏢🪪🏛️💬👤🏭), the Download button, footprint chips. |
| UI-5 | Remove L6's collapsibility on the BuyLead page — it must be always-open, not closable | Make the L6 band non-collapsible on the dashboard (always expanded); drop the open/close control. |
| UI-6 | "Campaign" not needed — top section = only Total Requirements, Messages, Calls (from the 3 internal APIs) | Remove the Campaign tile from the header/activity tiles on both cards; keep exactly Requirements · Calls · Messages. (Matches HOD product-obs-1.) |

### A-PRODUCT · the intelligence philosophy (obs 1–13)
| # | HOD principle | Engineering |
|---|---|---|
| P-1 | Remove Campaign; keep only Total Requirements/Calls/Messages | = UI-6. `buyerProfileModel.ts` header tiles + BuyLead header. |
| P-2 | **Summary must not repeat** — nothing shown in the summary/headline may reappear as a separate row | New **de-dup-against-summary pass**: after the persona/business-story headline is built, suppress any curated row whose value is already stated in the headline (token-overlap gate). Applies to both cards. |
| P-3 | **No conflicting data** — summary "Mostly Wholesale" vs row "Retail+Wholesale" | **Single source of truth per attribute.** The merge work already started (one Business Model value) is completed and made authoritative; the headline is generated *from* the resolved attributes, so it can't disagree with them. Add a build-time consistency assert (dev warn) when a headline token contradicts a row. |
| P-4 | **Business Type only once** — Type/Nature/Model/Retail-Wholesale all say the same | Collapse to **one Business Type/Model line**; Business Nature and Retail/Wholesale only render if they add *new* information (different from the Type line), else absorbed into the drill. (Extends the true-merge work already done.) |
| P-5 | **Sourcing cities** — where sourced from? avoid duplication | Wire sourcing cities from **Seller City IDs → CSL browser** (the real provenance) and drop the LLM's guessed sourcing-city text when the CSL-derived set exists; never show both. |
| P-6 | **Identity Signals (NEW)** — GST/UDYAM/PAN/TrustSEAL/Email-domain/Phone/Business-name verified + "how genuine is this buyer" | **New Identity Signals panel** — a checkmark grid of verification states + an overall genuineness read. Reuses existing verified flags; adds email-domain + business-name-match. Fixes the audit GST-verified false-positive (must show a real active/verified check, not substring). See Part D-1. |
| P-7 | **"What We Enriched"** section after the cards — show what WE added, not what exists | **New "What We Enriched" section** — the single biggest new feature. Lists every enrichment WE generated (GST/UDYAM/PAN/footprint/orders/WA/calls/Sign3/Befisc/Parallel/website/social/multi-source). See Part D-2. |
| P-8 | **Multi-source validation is itself new value** — "Business Name verified from 5 sources" | Add a **cross-source agreement engine**: for each key fact (business name, address, city, GST), count independent sources that agree and render "verified from N sources". Fixes the audit's over-loose 24-char triangulation (`buyerProfileModel.ts:81`) at the same time. See Part D-2. |
| P-9 | **Don't just populate — infer** ("buyer shifted from electrical to industrial hardware") | **Inference Engine** (Part D-3): trajectory/shift detection over requirement + call history. |
| P-10 | **Cook 4 signals together** → Procurement Maturity, Buying Readiness, Expansion Indicator, Trust Score, Business Stability, Growth Potential | Inference Engine produces these **composite scores** from Behaviour+Communication+Growth+Verification — not four raw signals shown side by side. See Part D-3. |
| P-11 | **Product of Interest = inference** (Chota Hathi → Tata Ace → logistics → expansion) | Inference Engine resolves colloquial/brand product terms to category+intent narrative (uses MCAT + a small LLM reasoning step). Never shows the raw search token alone. |
| P-12 | Every card answers "what NEW insight did AI provide?" | Governing acceptance test applied to every section during build. |
| P-13 | **Three documented deliverables:** Use Cases · Flow Diagram · Crisp Example | Delivered in Part E of this plan. |

**Overlap note:** HOD P-2/P-3/P-4 == the audit's "true-merge / no-concatenation" + data-honesty findings; P-6 == audit GST-verified false-positives; P-8 == audit triangulation-too-loose. These are executed **once**, not twice.

---

## PART B — Every audit finding → its fix (grouped by file)

All 31 confirmed + 67 P2, nothing dropped. `P0`=launch-blocker, `P1`=high, `P2`=cleanup. Items tagged _RESOLVED by…_ are handled by a Part-0/D change and need no separate work.

#### n8n v40 (standalone) — 5 (3 P0 · 1 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P0` | `RFQ Buyer Unified — v40 (syntax repair · namesake field-guard · no-audio skip) [bi-buyer-unified].json:3045` | The standalone LLM chain (profile-bundle → profile-llm → profile-parse) is ORPHANED; the webhook response never contains a buyer{} block, so every inferred card attribute is blank on every standalone pull. | Re-wire so the LLM subgraph is IN the response path: final-assemble → profile-bundle → profile-llm → profile-parse → cache-store → Respond to Webhook (move cache-store to after profile-parse so the cached payload also carries buyer{}). profile-bundle already reads final-assemble's output via $input; it just needs the incoming main connection that is currently missing. |
| `P0` | `RFQ Buyer Unified — v40 (syntax repair · namesake field-guard · no-audio skip) [bi-buyer-unified].json:3100` | profile-parse double-nests the LLM output: it sets buyer:llm where llm is the full {buyer:{...},needs_input:[...]} object, so response.buyer.<attr> is always undefined even once the chain is wired. | Unwrap in profile-parse: `const out = llm && llm.buyer ? llm.buyer : llm; return [{ json: Object.assign({}, pass, { buyer: out, needs_input: (llm && llm.needs_input) \|\| [], __llm_health: {...} }) }];` so response.buyer is the flat attribute map parseBuyerProfile reads. |
| `P0` | `RFQ Buyer Unified — v40 (syntax repair · namesake field-guard · no-audio skip) [bi-buyer-unified].json:3045` | Standalone's ONE LLM node (profile-bundle) is an orphaned root with zero inbound wires, so the endpoint never emits buyer{} — the whole reason the standalone card exists — yet the FE renders it as success. | In the bi-buyer-unified workflow, insert the LLM branch into the live path: wire final-assemble (or cache-store) → profile-bundle so profile-bundle→profile-llm→profile-parse becomes reachable from Webhook1, and make profile-parse (which merges _pass + buyer:llm) the node feeding "Respond to Webhook" on the fresh path (cache-store then only persists, not responds). Verify the cache-hit path (respond-cached) also returns a payload that carries buyer{}. |
| `P1` | `RFQ Buyer Unified — v40 (syntax repair · namesake field-guard · no-audio skip) [bi-buyer-unified].json:3592` | Standalone result-cache is permanently dead: cache-store always writes key tier 'full' while t0 always reads a normalized tier (superfast/fast/normal), so the write key can never match the read key — every standalone pull re-runs all paid externals. | Make the standalone write key equal the read key: either have standalone final-assemble emit `tier` (or `pipeline_mode.tier`) equal to t0's resolved tier, OR in cache-store read the tier directly from t0's query (`$('t0').first().json.tier`) instead of the dead `t0j.__t0.tier`/`j0.pipeline_mode.tier`/`'full'` fallback chain. Also fix the shared root cause: t0 stores __t0 as a bare timestamp, so `t0j.__t0.tier` is always undefined in BOTH workflows (masked in the dashboard, fatal here). |
| `P2` | `RFQ Buyer Unified — v40 (syntax repair · namesake field-guard · no-audio skip) [bi-buyer-unified].json:3584` | Standalone cache-store writes the result-cache under tier 'full' while t0 reads it under the real tier (superfast/fast/normal), so the 24h result-cache never hits and every ?profile pull re-runs all paid external APIs. | Fix the tier source in cache-store to `$('t0').first().json.tier` (t0 already resolves and stamps `tier` at top level of its output json), matching t0's read key. Same latent `t0j.__t0.tier` bug exists in the dashboard cache-store (harmless only because dashboard final-assemble emits pipeline_mode.tier) — correct both to read `t0j.tier`. |

#### n8n v44 (dashboard) — 6 (1 P0 · 2 P1 · 3 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P0` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:17` | pan-gate skip branch (no-PAN buyer) never executes pan-gst-parse, leaving DUMB-MERGE input 10 AND gst-discovery-merge input 1 unfed — the same unrun-input condition the calls-empty stub was added to prevent from hanging the barrier. | Add a connection pan-gate[out1] -> pan-gst-parse (mirror the sibling s3-pan-gst-parse wiring) so the IDfy PAN->GST terminal runs and emits its honest 'skipped' summary on the no-PAN path; or add a pan-gst-empty stub feeding both DUMB-MERGE in10 and gst-discovery-merge in1. Then every barrier-terminal is covered on both IF branches, matching the workflow's established no-unrun-input contract. |
| `P1` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:104` | requirement node's parseLoose control-char stripper uses the wrong regex /[ -]+/g (space + literal hyphen) instead of /[ -]+/g, so it (a) fails to strip the control chars it was meant to and (b) corrupts hyphens in MCAT category names. | Replace the regex in requirement node's parseLoose (jsCode line 104) with the same control-char stripper the sibling decoders use: `String(s).replace(/[ -]+/g,' ')` (or the more precise `/[ --]/g` that parse_rows uses). This restores control-char stripping (the intended behavior) and stops destroying hyphens inside category-name values. |
| `P1` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:1302` | On the slowest tiers the synchronous webhook (responseMode='responseNode') holds the client connection until the entire pipeline finishes; the Parallel deep-web poll branch alone is bounded at ~13min (up to ~27min with poll retries) and there is no workflow executionTimeout — this exceeds the stated ~8min budget and typical proxy limits, so the caller 504s while n8n keeps running. | Bound the synchronous run to under the proxy limit: add an overall executionTimeout in settings and/or an early 'facts-ready' Respond that returns before the slow web/transcription branches (async-continue for the rest), and lower the Parallel exposure (fewer guard iterations and/or single 90s poll with no retry so an iteration can't double to 180s). At minimum align the guard/poll math so worst-case Parallel duration is under the stated 8min budget and the gateway timeout. |
| `P2` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:172` | final-assemble __health rollup reports the transcription sources (calls, pns_calls) as ok:true/status:'ok'/count:null even when tier-skipped, empty, or unrun — contradicting sources_absent — because their assemble/empty nodes emit no __health and the rollup never reads summary.call_count. | Emit a real __health {node, ok, status:('extracted'\|'no_data'\|'skipped'), count: call_count} from calls-assemble and pns-assemble (and calls-empty/pns-empty with status:'skipped'); have final-assemble fall back to reading calls-empty/pns-empty when the assemble node is absent, and in the rollup derive count from summary.call_count and default status to 'no_data'/'skipped' (not 'ok') for null/empty sources. |
| `P2` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:3060` | Non-idempotent create-POSTs (websearch-post → Parallel run, gst-cert-post → IDfy async task) have retryOnFail with maxTries 3; on a slow/timed-out response where the server already created the resource, the retry creates a duplicate run/task, wasting vendor credits (only the first run_id/request_id is used downstream). | For the paid create endpoints (websearch-post, gst-cert-post) either disable retryOnFail or make retry safe (idempotency key / dedupe on run_id-request_id), so a transient timeout after server-side creation cannot spawn a second billable job. |
| `P2` | `RFQ Buyer Insights — v44 (syntax repair · namesake field-guard · no-audio skip) [bi-user-insights-v10x].json:3970` | cache-store writes the final payload to the 24h cache unconditionally, with no check on pipeline_health/__health — so a fresh partial/flaked run (PNS/websearch/IDfy/calls timeout or error) is cached and served to the next ≤20 pulls of that GLID+tier; the tracked 'stale flaked run' mitigation is an age-based banner that does NOT fire on a run cached seconds ago. | Gate the write in cache-store: skip caching (or cache with a much shorter TTL) when `j0.pipeline_health.error_count > 0` or any `j0.__health[].status` is 'error'/'timeout' for a source that matters, so a partial/flaked run is re-pulled next time instead of pinned for 24h. |

#### BuyerLedgerView.tsx — 19 (1 P0 · 6 P1 · 12 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P0` | `BuyerLedgerView.tsx:137` | Previous buyer's Befisc/Sign3 external identity (window.__buyerTwin.observed_external, not keyed by GLID) is merged into the next buyer's ledger and also suppresses the next buyer's own external fetch. | Store observed_external keyed by GLID (e.g. __buyerTwin.observed_external_glid) and have withObservedExternal + the extState effect ignore it when the stored GLID differs from the current prop; clear it on unmount. |
| `P1` | `BuyerLedgerView.tsx:279` | The extract effect fires a real Gemini call on the PREVIOUS buyer's module-cached rich at mount (no glid match check), and while the correct re-extract runs, the retained previous-buyer output renders under the new GLID. | In extractSynth, bail unless the rich belongs to this view: `if (!rich \|\| String((rich as {glid?:unknown}).glid\|\|'') !== glid.trim() ) return null;` (and also `if (presetLedger) return null;`), so the extract only ever runs on this GLID's pull. |
| `P1` | `BuyerLedgerView.tsx:204` | The 'alive' race guard only drops component setState; a stale pull that resolves later still overwrites the module globals (lastRich/lastRaw/lastHealth), so every render-body getEnrichmentRich() consumer — including the BuyerProfileCard rich prop — silently flips to the stale buyer's/pull's data. | Have fetchEnrichment only commit the module globals when the resolving run is still the latest for that key (compare against a monotonically increasing runId stored per glid:tier, or pass an 'isCurrent' callback), or store rich keyed by glid and make getEnrichmentRich(glid) explicit. |
| `P1` | `BuyerLedgerView.tsx:1206` | A raw NUL byte (U+0000) is embedded in the source of the most bug-dense file, silently making the whole 199 KB file register as binary to grep/git/rg and blinding text-search-based review. | Replace the NUL byte on line 1206 with a real space (`idn?.city \|\| ' '`), or better `idn?.city \|\| ' -never'`-style sentinel that norm() won't collapse to ''; then guard the whole predicate with `&& !!idn?.city` as buyerDetails.resolveAvailable already does, so an empty city can't make includes('') true. |
| `P1` | `BuyerLedgerView.tsx:1312` | The L6 'GST Verified' ribbon is presence-only: gstVerified is built from decodeGST() without ever checking format validity or registration status, so an invalid or CANCELLED GSTIN gets a green 'GST Verified' badge. | Gate gstVerified on `docs.gst.valid` AND on an active status (e.g. only build it when gstAdv?.status is absent or matches an explicit `/^active$/i` after normalization); when the GSTIN is present but not verified-active, render a neutral 'GSTIN on file' chip instead of the emerald 'GST Verified'. |
| `P1` | `BuyerLedgerView.tsx:411` | A failed requirement-enrichment (UC2) LLM call is collapsed into status 'done' with null output, so the UC2 debug band affirmatively reports the requirement was checked and is clean when the check never completed. | Add a distinct 'error' status on the .catch for both UC2 (line 411) and offer enrichment (line 341), thread it into UC2DebugBand / the enrich banner, and render an explicit 'enrichment failed — retry' state (never 'confirmed clean' / '✓ Enriched') when the LLM call did not succeed. |
| `P1` | `BuyerLedgerView.tsx:341` | A failed offer-enrichment LLM call is collapsed into status 'done', and the enrich banner then renders '✓ Enriched · nothing to correct … (N fields verified)', presenting an errored (or never-run) enrichment as a successful clean pass. | Give offerLLM an 'error' status on the catch and render a failed/retry state in enrichControl instead of the success banner; only show '✓ Enriched · nothing to correct' when offerLLM.status==='done' AND offerLLM.out is non-null. |
| `P2` | `BuyerLedgerView.tsx:1499` | The zero-vs-flake banner keys off n8n counter fields defaulted to 0 instead of the in-scope parsed requirements list, so it can proclaim '0 BuyLeads returned this pull' directly above a screen that is rendering requirements. | Gate the banner on the source of truth already in scope: `if (requirements.length === 0 && lifetime > 0)`, keeping the counters only as corroborating text. |
| `P2` | `BuyerLedgerView.tsx:1437` | Each UC2 debug block's 'input' prompt is recomputed at render time from the CURRENT context instead of the prompt actually sent, so after a web upgrade or re-extract the band shows a prompt that never hit the LLM next to the real rawOutput. | Store `{system, user}` in the Uc2Entry at fire time (alongside rawOutput/usage in the setUc2Map at line 408) and render that, falling back to recompute only for legacy entries. |
| `P2` | `BuyerLedgerView.tsx:944` | The PNS-calls 'extracted' count fallback still filters status==='transcribed', which the v18 Go-schema migration replaced with 'extracted', so the label shows '0 extracted' when call_count is absent despite extractions rendering below. | Use the existing helper in the fallback: `pnsArr.filter((c) => isDone((c as Record<string, unknown>).status)).length`. |
| `P2` | `BuyerLedgerView.tsx:1206` | The location-correction guard uses norm(idn?.city \|\| ' ') which normalizes to '' and String.includes('') is always true, so the strike-through correction is silently disabled for every buyer whose identity has no city (state-only recordedLoc). | Only apply the containment sub-check when a city exists: `&& !(idn?.city && norm(operatingCity).includes(norm(idn.city)))`. |
| `P2` | `BuyerLedgerView.tsx:1575` | The in-flight LLM toaster reads only the SELECTED requirement's uc2 entry, so switching the offer picker mid-enrichment hides the toaster while a UC2 call is still running (and the queued one shows no indicator either). | Use `anyUc2Loading` in busy (`... \|\| anyUc2Loading \|\| offerLLM.status === 'loading'`). |
| `P2` | `BuyerLedgerView.tsx:838` | During a re-pull (Fresh pull or tier switch) the StagedLoader and the full stale ledger view render simultaneously — the screen splits between 'Pulling buyer X…' and the old pull's complete card with no stale marker. | Gate the ledger block on `!loading` too (matching the loader), or keep it visible but overlay a dim/stale banner while loading is true. |
| `P2` | `BuyerLedgerView.tsx:229` | fullPending can never become true — it is only ever set to false — so the BuyerProfileCard 'still enriching' pending badge is dead and the comment's claim that it gates the Download button is stale. | Delete fullPending, its two setters, the pending prop pass-through (and the pending branch in BuyerProfileCard), or wire it to a real signal if a deferred-web upgrade returns. |
| `P2` | `BuyerLedgerView.tsx:1403` | The dummy-UC2 call still passes addSpecs and derivedCount, but buildUC2Enrichment (O27 pure-LLM contract) ignores every input except specs, so both arguments (and the UC2Input.altLocation field) are dead. | Drop addSpecs/derivedCount from the call site and remove the unused altLocation/addSpecs/derivedCount fields from UC2Input. |
| `P2` | `BuyerLedgerView.tsx:1537` | L0Band falls back to a hardcoded promptVersion 'extract-v9' (32 versions stale) when the extract IO is missing, feeding a wrong version into the drift-by-version eval log. | Replace the literal with the imported EXTRACT_PROMPT_VERSION (`io?.promptVersion \|\| EXTRACT_PROMPT_VERSION`), matching the real current version. |
| `P2` | `BuyerLedgerView.tsx:1122` | The 'enrich (LLM)' button is a one-way switch with no retry: it disappears the moment enrichMode flips to 'offer', enrichMode is never reset on GLID/requirement change, so after an error there is no re-click affordance and later buyers auto-enrich silently. | Reset enrichMode to 'profile' in the `[glid]` reset effect, and keep/re-show a retry button when offerLLM ends in error rather than collapsing to the outcome banner. |
| `P2` | `BuyerLedgerView.tsx:817` | The Download button can stay permanently disabled with a misleading '⏳ AI extract running…' label: msynth resets to 'idle' on GLID and the extract effect early-returns while synthCtx is null, so if the extract context never builds the button never re-enables. | Distinguish 'idle because synthCtx is null / cannot build' from 'idle→loading in progress': when ledger exists but synthCtx stays null, flip msynth to a terminal 'no-extract' state (Download enabled, honest label) rather than leaving it pending; or gate the button's pending state on synthCtx being non-null. |
| `P2` | `BuyerLedgerView.tsx:784` | CTA coverage inventory — every CTA in the cluster was traced to its effect; the ones below verified OK (handlers are null-safe, toggles round-trip both directions, links carry rel, Fresh-pull busts all three caches). | No action — inventory line for coverage; the four defects above are the actionable items. |

#### ledgerBands.tsx — 9 (0 P0 · 4 P1 · 5 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `ledgerBands.tsx:740` | UC2DebugBand renders a FAILED enrichment LLM call as "No corrections/additions — requirement confirmed clean." because its status union has no 'failed' state and the producer maps a rejected promise to status 'done' with out=null. | Add a 'failed' status to UC2DebugBand's status union and render an explicit failure line (rose, 'enrichment call failed — no verdict'); in BuyerLedgerView's catch, set status:'failed' instead of 'done'. |
| `P1` | `ledgerBands.tsx:636` | UC1 offer-enrich 'corrected' and 'added' fields are counted in the always-visible enrich banner but their values/drills are rendered nowhere — L6Band consumes `fields` only to list dropped/suggested rows, and the receipt's claim that reasoning is 'on the card' is false for this path. | Render applied corrected/added OfferFieldRows (before→after + drill) inside the enrichment run details receipt (or overlay them on the left-column specs), or make the banner link to a section that actually shows them. |
| `P1` | `ledgerBands.tsx:545` | Every 'Available' anchor popover hardcodes a 100% deterministic confidence chip, which directly contradicts the sub-100 confidence printed in the same popover's note for resolved anchors like Name. | Pass the anchor's real confidence into the popover (add an optional confidence field to L6Availability, defaulting to 100 only for literally on-file values like mobile/email/GST), or drop the chip for anchors that carry their own confidence in the note. |
| `P1` | `ledgerBands.tsx:782` | CrawlerBand renders LLM-extracted OSINT signals with `confidenceChip(s.confidence, false)`, so expanding the chip mislabels a web-scrape LLM guess as 'deterministic — a single verified source, taken at face value' and suppresses the LLM scoring criteria. | Call confidenceChip(s.confidence, true) (optionally threading the model's per-signal reason), or add a third 'llm-observed' mode whose explainer says the score is model-reported over uncorroborated web text. — _RESOLVED by removing CrawlerBand (obs-1)_ |
| `P2` | `ledgerBands.tsx:490` | The specsStatus explanations — including the '⚠ getisq5 returned NOTHING this pull' flake warning — are suppressed whenever the lead has buyerInfo or commercials, turning a specs-fetch flake into a silent blank. | Drop `!selectedReq.buyerInfo && !selectedReq.commercials` from the condition (or at minimum keep the getisq5_empty_run branch unconditional) so flake states always render. |
| `P2` | `ledgerBands.tsx:549` | In Original mode the static Available icons expose the full unmasked anchor value (mobile, email, PAN, GST) in a hover `title` tooltip, bypassing the click-to-reveal gate that the PII block enforces. | In Original mode set the tooltip to the label only (`title={a.label}`), keeping value exposure behind the Profile-mode click popover and the PII reveal button. |
| `P2` | `ledgerBands.tsx:461` | The Requirement-mode location-correction line (`on && uc2?.location`) is unreachable: the O28 location lock guarantees mergeUC2LLM never emits an applied corrected location, and the dummy builder never sets one. | Delete line 461 (sourcing cities already arrive as the 'Preferred sourcing city' added spec per the location lock); alternatively repoint it at that added spec if a dedicated location row is wanted. |
| `P2` | `ledgerBands.tsx:394` | The GST Verified ribbon popover is a plain <details> outside the name="avail" exclusive-accordion group, so it stays open while Available/Footprint/device popovers open and its w-80 max-h-[28rem] panel (z-20) physically overlaps them in the same right-column area. | Add name="avail" to the GST ribbon <details> so it participates in the same exclusive group. |
| `P2` | `ledgerBands.tsx:344` | L6Requirement's expiry/status/isExpired/recencyDays are populated by the producer but never rendered by L6Band, so an expired lead is indistinguishable from an active one on the card in Original and Profile modes. | Either render an EXPIRED badge / '{recencyDays}d old' chip next to the posted line in all modes, or strip the four unused fields from L6Requirement and the selectedReqCard mapping. |

#### BuyerProfileCard.tsx — 6 (0 P0 · 2 P1 · 4 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `BuyerProfileCard.tsx:325` | The GST Verification Status green-check test `/active\|verified/i` substring-matches 'Inactive' and 'Not Verified', rendering a bad GST status as an emerald '✓' success. | Anchor the positive test (`/^(active\|verified)\b/i`) and check negatives first (`/inactive\|cancel\|suspend/i` → amber/rose). |
| `P1` | `BuyerProfileCard.tsx:444` | The card renders a fabricated 'TrustSEAL Buyer Plan → Plan Type: TrustSEAL Verified' row for EVERY buyer, contradicting the model's explicit plan:null contract and the card's own 'NO fabricated data reaches the screen' guarantee. | Delete the placeholder section (matching the model contract) or render the standard muted 'Not available' empty state instead of a sample value. |
| `P2` | `BuyerProfileCard.tsx:257` | The persona prop renders as the hero headline with no junk-value or confidence gate, bypassing both filters that the same LLM key gets on every other path. | Apply the same guard in the card: treat persona as absent when it matches `/^(null\|n\/?a\|none\|unknown\|not available)$/i`, and have the call site pass it only at >=50 confidence (same gate as the buyer block). |
| `P2` | `BuyerProfileCard.tsx:143` | IdentityPanel's same-person verdict (one-directional token containment) disagrees with the model's conflict flag (symmetric substring containment), so the panel can show a green 'likely the same person ✓' chip inside an amber conflict-styled box, or a family-member warning in a no-conflict gray box. | Compute ONE verdict in the model (symmetric token-subset match, either direction) and drive both the chip and the container styling from it. |
| `P2` | `BuyerProfileCard.tsx:426` | Sign3 platforms outside the 4-item CONSUMER list and the 4 social rows render NOWHERE, yet `!m.socialPlatforms.length` in the empty-state guard suppresses the 'No web / social / registry footprint detected' message — a buyer with only e.g. a PAYTM/WHATSAPP presence gets a Digital Footprint section that is a title over nothing. | Either render unbucketed platforms as a generic 'Other phone-linked' chip row in FootprintChips, or base the empty-state guard on what actually rendered (gov/consumer/b2b buckets + the 5 social fields) instead of raw socialPlatforms.length. |
| `P2` | `BuyerProfileCard.tsx:84` | The two surfaces' Digital-Footprint chips key off different platform allow-lists, so identical Sign3 social_platforms data yields different chips on the BuyLead card vs GLADMIN. | Extract one shared platform→bucket map used by both FootprintChips and the BL footprint builder so the surfaced set is identical. |

#### buyerProfileModel.ts — 13 (0 P0 · 0 P1 · 13 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `buyerProfileModel.ts:369` | Integration question (dashboard surface): the dashboard feeds the v10x pull into BuyerProfileCard/parseBuyerProfile, whose registry reads target the STANDALONE bi-buyer-unified source keys — so the same buyer's GST/KYB can render on the L6 buylead card but be 'Not available' in the card view. | Verify on a live 268590579 v10x pull which source keys are present, and either make parseBuyerProfile fall back to the buyerDetails source keys (sources.gst.advance / identity / external) when the bi-buyer-unified keys are absent, or feed the dashboard card from the same buyerDetails-derived model the L6 band uses so both views agree per buyer. |
| `P2` | `buyerProfileModel.ts:81` | triangulateAddress grants the ✓✓ 'Confirmed by 2 independent sources' marker on a 24-char prefix containment, so a city-only web_osint address 'agrees' with any full GST address in that city. | Require a minimum overlap length (e.g. both normalized strings >= 24 chars before prefix-matching) or match on pincode/street tokens; otherwise return provenance 'registry' with the web value as an alternate. |
| `P2` | `buyerProfileModel.ts:400` | Both '(Last 6 Months)' surfaces (activity tiles and requirement chart/total) count and chart ALL requirements in the payload — no 6-month window is enforced anywhere. | Filter reqs by recencyDays <= ~183 (or posted within 6 months) when building tiles/months/total, or drop the '(Last 6 Months)' wording from both headers. |
| `P2` | `buyerProfileModel.ts:398` | The requirement-activity chart's month axis follows the requirement sort order (active-first, then recency), not chronology, so mixed active/expired histories render a jumbled month sequence. | Sort the buckets chronologically (parse MON'YY back to a timestamp) before building `months`. |
| `P2` | `buyerProfileModel.ts:214` | `reqs.length \|\| null` conflates a known ZERO (requirement node succeeded, no BuyLeads) with unknown, rendering '—' where an honest 0 belongs. | Use `value: nodeOk(rich, 'requirement') ? reqs.length : null` (same for `total`), so a real zero renders as 0 and only a failed/skipped node renders '—'. |
| `P2` | `buyerProfileModel.ts:469` | latestRequirement, hasActiveRequirement, and proofs are computed on every parse (including the proof namesake-suppression pipeline) but have ZERO consumers anywhere in the repo. | Delete the three fields (and ReqDetail/ProofRow types) from the model, or move the computation behind the surface that will actually render them (the BuyLead card already has its own requirement view). |
| `P2` | `buyerProfileModel.ts:279` | The setL overlay wires 'deal_readiness' but the standalone's bi-buyer-unified prompt (newest v40) never emits that key, so Deal Readiness (and the readiness half of the merged Buyer Intent row) is permanently absent on the standalone surface — the 'mirrored' prompts have drifted. | Add deal_readiness to the bi-buyer-unified prompt/schema (mirroring extract-v36+), or document it as dashboard-only and stop wiring it for the unified shape. |
| `P2` | `buyerProfileModel.ts:565` | header.company sourced from the GST certificate is stamped provenance:'inferred' (inferred:true), mislabelling registry-grade data as LLM synthesis for any provenance consumer. | Use provenance 'registry' for the GST-certificate branch too (the source string already distinguishes 'IndiaMART profile' vs 'GST certificate'). |
| `P2` | `buyerProfileModel.ts:279` | decision_maker is extracted and rendered on the BuyLead card but is never wired into the GLADMIN model, despite the code comment stating it must appear on BOTH surfaces. | Add a 'Decision Maker' row to buyerDetails in buyerProfileModel.ts and a corresponding setL(buyerDetails, N, 'decision_maker'), or intentionally document why it is BL-only; the same gap exists for communication/use_case if they are meant to be buyer-card facts. |
| `P2` | `buyerProfileModel.ts:276` | The >=50 confidence gate for curated LLM rows is enforced by only one of the two BuyerProfileCard callers, so the standalone card shows sub-50 attributes the dashboard hides. | Move the >=50 gate into parseBuyerProfile's lf() (or into finalsToBuyerBlock's server-side twin) so both callers apply it, instead of relying on each caller to pre-filter. |
| `P2` | `buyerProfileModel.ts:289` | Selling Channel is surfaced with a deterministic 'Sells on IndiaMART' fallback on GLADMIN but is deliberately excluded on the BuyLead card, so the same field renders on one surface and is hidden on the other. | Align the two Selling-Channel rules (either both show the IndiaMART-seller fallback or both suppress it) via a shared helper. |
| `P2` | `buyerProfileModel.ts:56` | The deterministic data layer behind the CURRENT GLADMIN Buyer Profile Card and standalone card (reconcileField conflict panels, triangulateAddress same-source agreement, monthBucket footprint buckets, parseBuyerProfile) has no harness at all. | Add a deterministic harness (repo mirror-or-import pattern) exercising reconcileField (agreement vs single-source, Conflict A/B), triangulateAddress (agree → triangulated, disagree, one-sided), and monthBucket over DD-MON-YY inputs and recencyDays fallback. |
| `P2` | `buyerProfileModel.ts:281` | The standalone prompt emits 5 attributes the standalone card never consumes (decision_maker, urgency, communication, identity_confidence, digital_footprint) — wasted tokens, and urgency being dropped leaves Delivery Timeline blank for the common no-explicit-timeframe buyer. | Either (a) consume urgency as the delivery_timeline fallback in the procurement overlay (setL delivery_timeline, and if absent fall back to buyer.urgency), or (b) drop decision_maker/urgency/communication/identity_confidence/digital_footprint from the standalone prompt to save tokens since the standalone card cannot render them. |

#### BuyerProfileStandalone.tsx — 2 (0 P0 · 0 P1 · 2 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `BuyerProfileStandalone.tsx:3` | The file's contract comment says 'FAST-ONLY … there is no run full' and 'Web OSINT + Udyam are gated OFF at the fast tier', directly contradicted by the component's own 3-tier toggle whose LOWEST tier is documented 10 lines later as including 'Udyam + gweb'. | Rewrite the header comment to describe the current 3-tier behavior (superfast/fast/normal, what each adds) and delete the FAST-ONLY paragraph. |
| `P2` | `BuyerProfileStandalone.tsx:4` | Stale tier documentation: the header comment claims FAST-ONLY (no 'run full') and that Web-OSINT + Udyam are gated off at fast, but the component ships a 3-tier toggle and t0 keeps Udyam + gweb on at every tier. | Update the BuyerProfileStandalone header comment to match t0: three tiers (superfast/fast/normal); transcripts added at fast, Parallel deep-web added at normal; Udyam + Gemini-web always on. Remove the 'FAST-ONLY / no run full' line. |

#### gemini.ts — 10 (0 P0 · 2 P1 · 8 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `gemini.ts:209` | extractBuyerProfileLLM discards the top-level needs_input array the extract prompt demands, so the LLM's honest 'could not ground, ask the buyer' channel never reaches the UI. | In both tolerant parses, carry needs_input through: `return { out: { attributes: attrs, needs_input: Array.isArray(parsed.needs_input) ? parsed.needs_input : undefined }, usage }` (guarding element shape is already done downstream in extractNeedsInput). |
| `P1` | `gemini.ts:123` | callLLM has no timeout/AbortController, so a hung gateway request never resolves — llmInFlight stays incremented forever and the global 'working…' loader spins permanently with no health-ring record. | Wrap the fetch in an AbortController with a per-call deadline (e.g. 90s default, overridable in LLMOpts); on abort, recordLLM({ok:false, status:0, ...}) and throw so existing catch/fallback paths engage. |
| `P2` | `gemini.ts:348` | voiceToSpecs (maxTokens 2048) and analyzeImage (maxTokens 1024) keep tight output caps that can clip the JSON mid-transcript, losing the entire extraction — contradicting the file's own raise-to-16000 rationale. | Raise both caps (e.g. 8000/4000) or drop the overrides to inherit the 16000 default; cost impact is bounded because max_tokens is a ceiling, not a spend. |
| `P2` | `gemini.ts:251` | osintSignalsLLM does not enforce the URL-grounding its prompt promises — signals with an empty or fabricated source_url pass the filter and flow unfiltered into the OSINT band. | Extend the filter to `.filter((s) => s.value && s.source_url && resultUrls.has(s.source_url))` where resultUrls is built from the input results, mirroring the twin's evidence-must-trace-to-pool rule. — _RESOLVED by removing Firecrawl/osintSignalsLLM (obs-1)_ |
| `P2` | `gemini.ts:63` | PROMPT_VER stamps uc2Enrich as 'uc2Enrich.v9' while uc2Enrichment.ts is at UC2_PROMPT_VERSION 'uc2Enrich.v10', despite the inline 'MUST mirror' contract — every uc2Enrich health/raw-IO record carries the wrong prompt version. | Import UC2_PROMPT_VERSION (a plain const, safe alongside the existing type-only import from uc2Enrichment) into PROMPT_VER instead of hand-copying the string — or have uc2Enrichment register its version at module load like registerPromptTemplate does for templates. |
| `P2` | `gemini.ts:1067` | Enum-constrained classification calls (deriveBuyerProfile, classifyFieldTypes, deriveIntent) run at the gateway's default temperature, contradicting the file's own F1/F2 rule of low temp on classification for consistent labels. | Pass temperature: 0 (or 0.2) on deriveBuyerProfile, classifyFieldTypes and deriveIntent, matching the discipline already applied to planRequirement/deriveBuyerTwin. |
| `P2` | `gemini.ts:146` | The LLM_RAW debug capture stringifies multimodal message content to '[object Object],[object Object]', so the L4 'nothing hidden' raw-IO ledger shows garbage for voiceToSpecs/analyzeImage/explainSpec-with-image calls. | When content is an array, join the text parts' `.text` and replace media parts with a placeholder (e.g. '[image image/png, 240KB]' / '[audio webm]') before capturing. |
| `P2` | `gemini.ts:126` | callLLM never gates on hasGeminiKey, so the ~15 exported functions that (unlike the 6 guarded ones) skip the key check fire a doomed HTTP request with 'Authorization: Bearer undefined' when the key is unset, polluting the health ring. | Add `if (!hasGeminiKey()) throw new Error('no LLM key')` (or an early recorded skip) at the top of callLLM so all 21 entry points inherit the guard, and delete the now-redundant per-function checks. |
| `P2` | `gemini.ts:63` | UC2 prompt-version tag in gemini.ts is stale (uc2Enrich.v9) while the lib's UC2_PROMPT_VERSION is v10, so every v10 run is logged/traced as v9. | Bump gemini.ts PROMPT_VER.uc2Enrich to 'uc2Enrich.v10' to match UC2_PROMPT_VERSION. |
| `P2` | `gemini.ts:63` | gemini.ts self-reports the UC2 prompt version as uc2Enrich.v9 while the actual constant is uc2Enrich.v10, so all UC2 telemetry/eval-over-time records the wrong version. | Change gemini.ts:63 to `uc2Enrich: 'uc2Enrich.v10'` (or better, import UC2_PROMPT_VERSION and reference it in PROMPT_VER so the map can never drift again). |

#### buyerProfileExtract.ts — 3 (0 P0 · 1 P1 · 2 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `buyerProfileExtract.ts:744` | buyer_maturity has an explicit default-to-value rule — 'otherwise "established business"' — so a buyer with zero maturity evidence is fabricated as an established business, and business_stage is forced to agree with it. | Change the rule to three-way: early-stage on setup signals; 'established business' ONLY on positive establishment evidence (verified-business flag, GST/Udyam vintage, multi-year tenure); otherwise OMIT and add to needs_input. — _folds into HOD-4 (Business Type once) + extract-v42 no-fabricate_ |
| `P2` | `buyerProfileExtract.ts:517` | The v41 per-field namesake ⚠ marker (nsk) is applied only to business_type/industry/official_address/website — web_scale (employee_count/turnover_estimate/year_established), web_udyam, web_digital, web_people and web_news lines omit it even when those fields are namesake-flagged. | Append nsk(<field>) to every field-derived line: web_scale (per contributing field), web_udyam, web_digital, web_people, web_news, mirroring what web_address/web_website already do. |
| `P2` | `buyerProfileExtract.ts:731` | The pre-v33 generic conflict-priority line ranks Requirement(BuyLeads/ISQ) BELOW CSL, contradicting every injected frozen policy that includes both (IDENTITY/PROCUREMENT/BEHAVIOUR/INTENT all put Requirements above CSL) and the requirements-dynamic rule that makes a repeated RFQ pattern Primary. | Delete the generic order from line 731 (keep only 'weigh per the # SOURCE POLICIES block') or regenerate it from POLICIES so it cannot contradict the frozen layer. |

#### attributeRulebook.ts — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `attributeRulebook.ts:59` | The frozen-architecture doc comment says ATTR_POLICY covers 'The 32 emitted attributes' but the map (and the prompt's key enum, which it does match 1:1) contains 35 — a stale count in the exact place an auditor checks for enum/rulebook drift. | Update the comment to 35 (or drop the hardcoded number in favor of 'every key in the prompt enum'). |

#### sourceConsumption.ts — 2 (0 P0 · 0 P1 · 2 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `sourceConsumption.ts:71` | present() effectively returns true whenever the source key exists: the `nonEmpty(node)` fallback fires on the standard {summary, raw} wrapper and scaffolding keys count as content, so the matrix reports 'present' for registries that returned nothing. | Make presence semantic: strip plumbing keys (_meta/__health/count/status) before the emptiness check and drop the bare `nonEmpty(node)` fallback for wrapper-shaped nodes (only use it when the node has keys other than summary/raw). |
| `P2` | `sourceConsumption.ts:116` | deriveConsumption's isUsed substring/regex matching double-counts a single cited source: citing 'Befisc GST' (a legal closed-catalog name) marks BOTH the GST rung (Primary) and the External (Sign3/Befisc) rung (Corroborative) as used. | Match each cited source string to at most ONE spec (first policy-order match wins, or use exact-name mapping from the closed catalog to spec), instead of testing every spec's regex independently against every cited string. |

#### offerEnrich.ts — 1 (0 P0 · 1 P1 · 0 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `offerEnrich.ts:247` | mergeOfferLLM applies a 'corrected'/'added' value to an existing field on confidence ALONE — the computed `grounded` flag never gates the action — so an ungrounded/fabricated-citation correction is applied and shown on the L6 card. | In apply(), require grounded to keep a change: when action is 'corrected'/'added' and !grounded, demote to 'suggested' (or 'kept'), mirroring the new-field guard at line 267 and mergeUC2LLM at uc2Enrichment.ts:185. |

#### uc2Enrichment.ts — 2 (0 P0 · 0 P1 · 2 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `uc2Enrichment.ts:185` | UC2's confidence gate is NOT actually 'ported from offerEnrich' as the header claims — it applies corrections at conf≥50 whereas offerEnrich only applies at ≥70 (50-69 there is 'suggested', not applied), so UC2 overwrites buyer-recorded fields on medium confidence. | Pick one policy: either give UC2 the same tiered gate (≥70 apply, 50-69 suggest) as offerEnrich, or correct the 'ported from offerEnrich' comment to document the intentionally-lower single threshold. |
| `P2` | `uc2Enrichment.ts:205` | A spec edit marked kind:'corrected' whose field key doesn't norm-match any base spec key is counted in `corrected`/the summary but is never rendered in specOut — the 'N corrected' banner overstates visible corrections. | When an applied kind:'corrected' spec has no matching base key, render it as an added spec row (or exclude it from the corrected count) so the count and the rendered before/after agree. |

#### worldEnrichment.ts — 2 (0 P0 · 1 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `worldEnrichment.ts:184` | GST verified flag uses substring `.includes('active')`, so a status of "Inactive" (or "Not Active") is decoded as verified=true. | Match the status exactly, e.g. `business.status?.trim().toLowerCase() === 'active'`, or whitelist the active states — do not use substring includes(). |
| `P2` | `worldEnrichment.ts:182` | When GST-Advance returns hsn_codes but no sac_codes, HSN (goods) codes are stored into business.sacCodes (services) and never reach business.hsnCodes, mislabeling goods codes as service codes. | Assign hsn_codes into business.hsnCodes and sac_codes into business.sacCodes separately; do not fall back from one to the other. |

#### enrichment.ts — 4 (0 P0 · 0 P1 · 4 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `enrichment.ts:809` | The in-flight dedup entry is deleted unconditionally on settle, so a fresh pull that overwrote the map entry (line 752 skips the in-flight check when _fresh) gets deregistered by the OLDER run's finally — later callers miss both cache and in-flight and fire a duplicate multi-minute n8n execution. | Guard the delete: `finally { if (enrichInFlight.get(_key) === _run) enrichInFlight.delete(_key); }` (same pattern for profileInFlight/unifiedInFlight is harmless but only fetchEnrichment has the fresh-overwrite path). |
| `P2` | `enrichment.ts:631` | isNewUserInsightsShape accepts `sources: null` (typeof null === 'object'), making normalizeNewUserInsights throw on `s[k]` — the whole pull is then swallowed to {profile:null, raw:null} even though the HTTP response arrived with usable top-level data. | Tighten the guard: `… && !!(raw as {sources?:unknown}).sources && typeof (raw as {sources?:unknown}).sources === 'object' && !Array.isArray((raw as {sources?:unknown}).sources)`. |
| `P2` | `enrichment.ts:629` | lastAnchors / getEnrichmentAnchors is write-only dead code — the getter has zero consumers in the repo, and the value is also excluded from the per-tier cache restore so it would serve the wrong pull's anchors if ever wired. | Delete lastAnchors/getEnrichmentAnchors (and the stale richToLegacy comment), or if the identity-prefill hint is still planned, store anchors inside enrichResultCache entries and restore them on the cache-hit path. |
| `P2` | `enrichment.ts:698` | The FE discards n8n's authoritative honesty fields (sources_present, sources_absent, pipeline_mode.skipped_for_tier, pipeline_health) and re-derives per-node health from the raw __health array, so tier-skipped transcript sources (calls / pns_calls in superfast & fast) render in the health matrix as ok/'no data' instead of 'skipped for tier'. | Have extractHealth (or the L1 matrix builder) read the response's `sources_absent` + `pipeline_mode.skipped_for_tier` and label those nodes 'skipped (tier)' instead of deriving 'ok' from a null source; alternatively make final-assemble ref the honest empty node (calls-empty/pns-empty give it a status:'skipped'+__health) so the null-source never masquerades as ok. |

#### twinAdapter.ts — 2 (0 P0 · 2 P1 · 0 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `twinAdapter.ts:122` | finalsToBuyerProfile reads pre-rename attribute keys (maturity/buyer_stage/supplier_preference/preferred_channel/responsiveness/buyer_persona) that extract-v41 no longer emits, so those BuyerProfile fields are silently always undefined. | Rename the reads to the extract-v41 schema: persona→v('business_persona')\|\|v('business_type'), maturity→v('buyer_maturity')\|\|v('business_stage'), supplierPreference→v('preferred_suppliers'), engagement→v('communication'); responsiveness has no extract equivalent, so source responseSensitivity from communication/behavioral evidence or leave it explicitly absent rather than reading a dead key. |
| `P1` | `twinAdapter.ts:94` | finalsToBuyerTwin reads renamed extract keys (preferred_channel/responsiveness/buyer_persona/current_active_intent/industry), so layer_b traits never populate and current_active_intent shows the product list instead of the deduced buyer_intent. | Rename to the extract-v41 schema: preferred_channel→communication, buyer_persona→business_persona, industry→sub_industry, and put buyer_intent first in the activeIntentVal chain (val('buyer_intent') \|\| val('products_of_interest') \|\| val('business_persona')); response_sensitivity has no extract key, so derive it from communication or omit rather than reading a nonexistent 'responsiveness'. |

#### threeBrainRegistry.ts — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `threeBrainRegistry.ts:174` | The three-brain alignment engine (alignBrains + buyerBrainFromFinals + categoryBrainFromIntel + rfqBrainFromState) is never imported by any app surface — only the test script references it; only stateFromFrequency is actually consumed. | Either wire alignBrains into the live provenance/consumption view it was built for, or drop the unused exports (keep only stateFromFrequency) to remove the dead surface from the bundle; if kept as intentional scaffolding, gate/annotate it like the other flag-gated code so it isn't mistaken for a live path. |

#### MainApp.tsx — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `MainApp.tsx:164` | Without ?debug the landing page has zero interactive CTAs — the GLID input + entry button are gated behind isDebug() and every quote button behind SHOW_QUOTE_CTAS=false — so the 'Drop a buyer's GLID' page is a dead-end for a non-debug visitor. | Either always render the GLID input + '📊 Profile & Enrichment' entry (keeping the extra debug pulls gated), or show a short 'append ?debug=1 to open the console' hint so the landing is not an unactionable dead-end. |

#### RFQModalV3.tsx — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `RFQModalV3.tsx:2641` | The no-key toast tells the user to set VITE_GEMINI_API_KEY, but the client actually reads VITE_LLM_KEY — following the instruction leaves voice extraction dead. | Change both toasts to 'Set VITE_LLM_KEY in .env' (identical fix in RFQModalV4.tsx:2678). |

#### traceExport.ts — 1 (1 P0 · 0 P1 · 0 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P0` | `traceExport.ts:19` | The Langfuse SECRET key (and public key) is inlined into the bundle and every offline HTML, and the bare `import.meta.env` read here pulls ALL VITE_ vars into the client bundle. | Move Langfuse ingestion behind a server-side endpoint/proxy that injects the Basic auth header from NON-VITE_ env vars; never reference the secret key in browser code. Destructure only the specific non-secret VITE_ vars you need instead of the bare `import.meta.env` object, and rotate the Langfuse secret+public keys since they have shipped. |

#### downloadProfile.ts — 2 (0 P0 · 0 P1 · 2 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `downloadProfile.ts:113` | Full buyer PII (Aadhaar/PAN/income and the entire enrichment pull) is embedded verbatim into the downloadable HTML that gets emailed around — accepted per the owner's 'not PII-safe' stance, flagged informational. | No code change required per owner stance; if a compliance posture is ever needed, gate the raw-JSON embed behind a debug flag or redact the identity fields (Aadhaar/PAN/income) from the embedded snapshot before download. |
| `P2` | `downloadProfile.ts:118` | The offline-download gating/assembly path (downloadProfileHtml + offline-shell integrity guard) has no harness, despite a history of the offline bundle silently breaking. | Add a harness that calls buildProfileHtml with a fixture rich payload containing newlines/quotes and asserts the embedded bundle round-trips (extract + JSON.parse) and that the shell-integrity guard rejects a non-bundle shell. |

#### offlineSnapshot.ts — 1 (0 P0 · 1 P1 · 0 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P1` | `offlineSnapshot.ts:33` | The downloaded offline snapshot silently drops the client-fetched Befisc/Sign3 external identity — maybeHydrateOffline never restores window.__buyerTwin, and the capture writes the pre-merge raw — so the offline copy shows fewer verified anchors than the live view it claims to reproduce. | Capture the external layer into the snapshot (add `observedExternal: window.__buyerTwin?.observed_external` to the OfflineSnapshot built at BuyerLedgerView:820) and re-seed it in maybeHydrateOffline (`w.__buyerTwin = { observed_external: snap.observedExternal }`); or capture `legacy: withObservedExternal(raw)` so the merge is baked into snapshot.legacy. |

#### OfflineDashboard.tsx — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `OfflineDashboard.tsx:12` | Inside the downloaded offline shell several header CTAs render as live but do nothing useful: ✕ close is a no-op, Fresh-pull and the tier chips are inert (the pull effect early-returns on __ledgerDemoRaw), and 'standalone ↗' re-opens the offline dashboard rather than the standalone card. | In offline mode (getOfflineSnapshot()) hide the ✕ close, Fresh-pull, tier chips and standalone-↗ controls (or render them disabled with an 'offline snapshot' note) so no offline CTA looks interactive while being inert/misleading. |

#### requirements.ts — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `requirements.ts:92` | The retailLead classifier substring-matches 'personal'/'individual'/'home use' against the product name, so a bulk B2B product flips the 'This might be a retail lead' (B2C/end-user) flag. | Tighten to whole-word, buyer-context tokens (`\b(end[\s-]?user\|individual buyer\|personal use\|home use\|household\|b2c)\b`) and evaluate it over buyerInfo/requirementType only, not over the product/category name where 'personal'/'individual' are legitimate product descriptors. |

#### synthtest.mjs — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `synthtest.mjs:82` | synthtest's 16 assertions exhaustively test the arithmetic “Merged Synthesis Engine”, but that path is explicitly UNHOOKED in source — the suite is green coverage of dead code, not the live extract flow. | Either point synthtest at the ACTIVE `buildLLMSynth`/`llmFinals` path (the current flow) or clearly rename/scope it as a legacy/frozen-path test so its green result is not read as coverage of the shipping extractor. |

#### reqtest.mjs — 1 (0 P0 · 0 P1 · 1 P2)

| Sev | Location | Issue | Fix |
|---|---|---|---|
| `P2` | `reqtest.mjs:8` | reqtest's NOTE_KEY mirror still routes “I am interested in” to buyer notes, but source requirements.ts dropped it so that phrase now stays a spec — stale mirror + an unprotected behavior branch. | Sync the mirror to `/buyer filled details/i` and add a fixture row with an “I am interested in ...” ISQ answer asserting it lands in `specs` (not `buyerNotes`). |

---

## PART C — The two n8n rebuilds (new files, webhook paths unchanged)

### C-1 · `bi-buyer-unified` → **v41** (standalone) — was completely non-functional
1. **Wire the orphaned LLM chain (P0):** `final-assemble → profile-bundle → profile-llm → profile-parse → cache-store → Respond`. profile-bundle currently has zero inbound wires, so the endpoint never emitted `buyer{}`.
2. **Un-nest profile-parse (P0):** `const out = llm?.buyer ? llm.buyer : llm; buyer: out` — today it sets `buyer: llm` where `llm` is the whole `{buyer,needs_input}`, so `response.buyer.<attr>` was always undefined.
3. **Fix the dead result-cache (P1):** align the write key to the read key (read tier from `t0` query, not the `'full'` fallback); also fix the shared `__t0` bare-timestamp bug so `t0j.__t0.tier` isn't always undefined.
4. **Prompt parity:** add `deal_readiness`, `use_case`, and the requirement-side keys the standalone card renders but the prompt never emitted; drop the 5 attrs the card never consumes (decision_maker/urgency/communication/identity_confidence/digital_footprint) unless Part-D re-introduces them.
5. **cache-hit path** must also return a payload carrying `buyer{}`.

### C-2 · `bi-user-insights-v10x` → **v45** (dashboard)
1. **No-PAN barrier hang (P0):** wire `pan-gate[out1] → pan-gst-parse` (mirror the sibling) so DUMB-MERGE in10 + gst-discovery-merge in1 are fed on the no-PAN branch; the terminal emits its honest `status:'skipped'` summary.
2. **`requirement` parseLoose regex (P1):** replace `/[ -]+/g` with the control-char stripper the sibling decoders use (`/[\x00-\x1f]+/g`) — stops nulling categories and stops mangling `e-Rickshaw`/`T-Shirt`.
3. **Parallel/Normal timeout (P1) — the async redesign (Part 0.2):** raise `executionTimeout` to 15 min; for the Normal tier add the **job-id + poll** response mode so the caller never holds a 12-min connection; keep facts/fast sources in the immediate payload.
4. **PAN/GST-anchored web query (obs-4b, Dinesh fix):** build `websearch-build`/`gweb-build` queries from the **hard IDs first**; drop web entities that share no hard ID with the buyer.
5. **Namesake full-suppression (obs-4a):** when all web fields are namesake-flagged, emit an empty/`suppressed` web summary, not the tagged foreign entity.
6. **Remove Firecrawl nodes (obs-1):** delete the crawler HTTP + parse nodes; keep gweb + Parallel.
7. **P2 hardening:** don't cache a flaked run (`cache-store` gate on `pipeline_health`); make `final-assemble` `__health` honest for tier-skipped transcription sources; guard non-idempotent create-POST retries (websearch-post/gst-cert-post) so a retry can't double-submit a paid run.

---

## PART D — New builds (the intelligence layer)

### D-1 · Identity Signals panel (HOD P-6)
A verification grid: **GST · UDYAM · PAN · TrustSEAL · Email-domain · Phone · Business-name-match**, each ✓/⚠/— with its source, plus an overall **genuineness read** (not a fabricated number — derived from how many hard anchors verified + agree). Fixes at the same time: GST "verified" substring false-positives (`BuyerProfileCard.tsx:325`, `worldEnrichment.ts:184`, `BuyerLedgerView.tsx:1312`) — a check only shows green on a real active/verified status.

### D-2 · "What We Enriched" + multi-source verification (HOD P-7, P-8)
A section below the cards that answers **"what NEW value did we add?"**: the list of enrichments WE generated, and for each key fact a **"verified from N independent sources"** line built by a cross-source agreement engine (internal + GST + Udyam + website + Parallel). Replaces the too-loose 24-char triangulation with token/normalized-value agreement across the real source set.

### D-3 · Inference Engine (HOD P-9, P-10, P-11) — the heart of the HOD ask
A new module (`inferenceEngine.ts`) that takes the resolved attributes + requirement/call/WhatsApp history and produces **derived intelligence**, not restated data:
- **Trajectory / shift** — "moved from electrical accessories to industrial hardware" (diff over requirement history).
- **Composite scores** — Procurement Maturity · Buying Readiness · Expansion Indicator · Trust Score · Business Stability · Growth Potential, each cooked from ≥2 signal families with an evidence drill.
- **Product-of-Interest inference** — colloquial/brand term → category → intent narrative (Chota Hathi → Tata Ace → logistics/last-mile), via MCAT resolve + one small grounded LLM step; never the raw token alone.
- Everything grounded (evidence lines) and gated — no signal, no claim (your Part-0.3 rule).

### D-4 · Tri-tier concurrent auto-loading (HOD P-UI-2 + your Part-0.2)
Rework the pull orchestration so that on GLID submit **all three tiers fire in parallel**; UI opens on Superfast with a loader; Fast/Normal tabs are **disabled + spinner** until each resolves, then enabled (no auto-switch); every completed tier is cached in memory; switching between completed tiers is **instant, zero loading, zero re-call**. This is also where the audit's race-condition P0/P1s get fixed structurally (see below).

### D-5 · Fold-in of the audit's dashboard race bugs (they're prerequisites for D-4)
The tri-tier cache **requires** per-GLID, per-tier isolation — which is exactly what these P0/P1s are about, so they're fixed as part of D-4, not separately:
- Key `getEnrichmentRich()` / module globals **by `glid:tier`** with a runId "latest-wins" guard (fixes `BuyerLedgerView.tsx:204`, `:279`).
- Key `window.__buyerTwin.observed_external` **by GLID** + clear on unmount (fixes the **P0 cross-buyer PII bleed** `:137`).
- AbortController on `callLLM` + fetch (fixes `gemini.ts:123` hung-loader).

---

## PART E — HOD's three documented deliverables (P-13)

### E-1 · Use Cases
Buyer Qualification · Sales Prioritization (hot/warm/cold from Buying Readiness) · Fraud / Genuineness Detection (Identity Signals) · Business Verification (multi-source) · Cross-sell / Up-sell (Product-of-Interest inference) · Expansion Targeting (Growth Potential) · RFQ Completeness assist (form).

### E-2 · Flow Diagram
`Internal APIs (Buyer Profile · Details · Other · Previous Orders · CSL · Calls · WhatsApp)` **+** `External (Sign3 · Befisc · GST · Udyam · gweb · Parallel.ai)` → **Validation layer** (format + status + cross-source agreement) → **Inference Engine** (trajectory · composite scores · product inference) → **Identity Signals · Buyer Intelligence · Enrichment Summary · Smart Insights** → **GLADMIN card · BuyLead card · Standalone card**. _(Rendered as a proper diagram in the shipped doc.)_

### E-3 · Crisp Example
**Input:** buyer searched "Chota Hathi", "warehouse", "transport"; GST verified; multiple RFQs; 20 calls; frequent WhatsApp. **Output — AI added:** ✓ Logistics-expansion intent · ✓ Verified GST + UDYAM (2 sources) · ✓ High procurement intent (Buying Readiness: Hot) · ✓ Transport-infrastructure interest · ✓ Identity Confidence 94% · ✓ Multi-source verified (name across 5 sources). None of these are raw DB fields — all derived.

---

## PART F — Decisions I need before I start (only 3)
1. **UI-3 section:** the screenshot didn't survive the docx extraction — which section on the BuyLead details page did you circle as "no need"? (My guess: the L6 enrichment-run-details receipt, or "How this buyer buys".)
2. **Parallel/Normal architecture:** go with **job-id + poll** for the Normal tier (robust against any proxy, slightly bigger n8n change), or just **raise timeouts + background-tab** (simpler, but a strict proxy could still cut a 12-min connection)?
3. **Scope of this single pass:** ship **everything** here in one build (audit fixes + 2 n8n rebuilds + Identity Signals + What-We-Enriched + Inference Engine + tri-tier loading), or land **audit-fixes + n8n first** (stable base, ~1 build) then the intelligence layer (D-1..D-4) as the immediately-following build? Both are "single phase" in spirit; the split just de-risks.

---

### Execution order (once you confirm F)
`1` D-5 race/PII/abort fixes (unblocks caching) → `2` n8n v41 + v45 rebuilds → `3` true-merge/no-conflict/no-duplication + campaign removal + extract-v42 (P-1..P-5, Part-0.3) → `4` Identity Signals (D-1) → `5` What-We-Enriched + multi-source (D-2) → `6` Inference Engine (D-3) → `7` tri-tier loading + SVG icons + toggle/L6 UI (D-4, UI-4/5) → `8` remaining P2 sweep → `9` `tsc -p tsconfig.app.json` clean + harnesses + live preview + rebuild offline shell.
