# Dynamic RFQ — Gap Register

Generated **2026-08-01** by an 11-agent code-grounded audit of the live `?rfq=brain` flow (1.68M tokens, 463 tool calls). Every gap was read from source, not from docs. Companion to `DYNAMIC-RFQ-HANDOFF.md`.

**101 gaps** — 29 high · 49 medium · 23 low. 
By owner: 68 frontend · 29 server/n8n · 4 gateway.

> Severity is the auditor's, not the owner's. Nothing here is fixed unless the handoff says so.


---


## A · GATEWAY / MODEL (4)


### HIGH — The buyer-profile card is now on an unprobed model over a DIFFERENT gateway key, with max_tokens 48000 against an unknown output ceiling

`RFQ_FORM_LLM_MODEL = MODEL_FAST` (gemini.ts:41), so extractBuyerProfileLLM silently moved from 2.5-flash-lite to 3.5-flash-lite at gemini.ts:377 — and that call uses `route: 'card'`, i.e. ENDPOINT_CARD → `/api/cardllm`, which the proxy authorises with a DIFFERENT key (`RFQ_BUYERCARD_KEY`, vite.config.ts:39) from the form key (`RFQ_LLM_KEY`, vite.config.ts:53). The probe quoted in the new comment (gemini.ts:30) was on the form path. The code's own comment at gemini.ts:370-372 records that this key 401s on flash — i.e. it is entitlement-limited — so there is no evidence it can reach a 3.5-generation model. The failure is not graceful: the same call requests maxTokens 48000, justified at gemini.ts:376 as 'inside flash-lite's ~64k output ceiling' — a 2.5-flash-lite fact asserted about a different model. If the new model's cap is lower, the gateway 400s; the retry path at gemini.ts:296-301 strips reasoning_effort and allowed_openai_params but NEVER max_tokens, so the retry 400s again, callLLM throws, and extractBuyerProfileLLM's catch (gemini.ts:389) returns `{out:null}` → the whole card silently falls back with only a mislabelled health row.


`src/lib/gemini.ts:41,377,296-301; vite.config.ts:33-57`


### HIGH — The seller-search auth token expired 2026-06-19 — the results page is likely broken for every buyer

sellerSearch.ts:29 hardcodes TEST_AK, a static JWT whose `exp` claim is 1781862943 = Fri 19 Jun 2026 09:55:43 UTC. Today is 2026-08-01, i.e. the token is 43 days expired. Every ?rfq=brain run that reaches the last page POSTs it to /api/sellersearch (rewritten to the windmill curated_seller_search_v6_7-golive run URL, vite.config.ts:60-63); if windmill validates exp the call 401/403s, searchSellers rejects, and CuratedSellerBoard renders its error state with no diagnostic beyond emitApiError (which goes nowhere — see the telemetry gap). Also still fixture-bound in the same file: STATIC_BUYER_CONTEXT with a hardcoded IP/city_id (30-42), STATIC_BUYER_ID '215595413' (46), and the Ghaziabad city fallback (44-45). The file's own DEV-TODO (9-10) says the prod fix is the logged-in buyer's session token, never a shared constant.


`src/lib/sellerSearch.ts:29 · vite.config.ts:60-63`


### HIGH — allowed_openai_params makes reasoning_effort actually take effect for the first time — which REMOVES thinking from 9 call sites and adds it to 10

The new comment (gemini.ts:269-277) states that before this change the successes came back with `reasoning_tokens = 0` and 'low/medium/high were all identical — the whole knob was inert'. That means every tuned effort value in the file was dead and every call ran on the gateway's default thinking. Sending allowed_openai_params (gemini.ts:278) turns all of them live at once, in BOTH directions. Thinking is now actively suppressed (probe: 'low 0') on twinPrune (gemini.ts:397), voiceToSpecs 'none' (:516), analyzeImage 'none' (:595), deriveIntent (:864), refineQuestions (:1276), deriveBuyerStory (:1397), deriveBuyerProfile (:1470), explainSpec (:1988), getSpecHints (:2113) — nine calls that previously got the gateway default and may quietly degrade. Simultaneously thinking starts BILLING and consuming max_tokens on extractBuyerProfile (:377), offerEnrich (:417), uc2Enrich (:437), deduceLogistics (:1357, cap only 2200), deriveBuyerTwin (:1639), inferSpecsFromApplication (:1887), curated-planner (:2574), planRequirement (:1106), getMissingSpecs (:2852) and all three RFQ LLMs. None of these had their max_tokens re-checked in this change set. The probe's 300-457 reasoning tokens were measured on a small probe prompt; on the brain's real multi-source prompt 'high' thinking scales far higher, so the quoted numbers do not transfer to any of these caps.


`src/lib/gemini.ts:268-278 (all effort call sites listed inline)`


### HIGH — reasoningEffort 'none' was never probed and is now forwarded verbatim — it lands on exactly the two buyer-visible multimodal calls whose parse failure returns an EMPTY result

ReasoningEffort permits 'none' (gemini.ts:120) and only two call sites use it: voiceToSpecs (gemini.ts:516, maxTokens 4000, timeoutMs 15000) and analyzeImage (gemini.ts:595, maxTokens 2500, timeoutMs 20000). The live probe recorded in the comment covers low/medium/high only. `allowed_openai_params` is LiteLLM's instruction to STOP validating/mapping the param and pass it through to OpenRouter, so an unrecognised enum value is no longer normalised — it either 400s or is silently ignored. If it 400s, the strip at gemini.ts:296-301 burns one full extra round trip inside a 15s (mic) / 20s (photo) budget; if it aborts, both functions swallow the throw... actually worse, if the model instead applies default (non-zero) thinking, those reasoning tokens count against 4000/2500, the JSON truncates, and the catch blocks at gemini.ts:518-519 and :597-598 return a fully EMPTY extraction — the mic and camera silently produce nothing rather than erroring. Cheapest verification: one live call at each of 'none' and 'low' checking status + completion_tokens_details.reasoning_tokens.


`src/lib/gemini.ts:120,516,595,518-519,597-598`


## B · FRONTEND (68)


### HIGH — BES measures only Page 1 and the last page — the entire LLM 2/3 surface is uninstrumented

bes.ts is the second KPI ('did we make the buyer WORK for what we already knew', bes.ts:1-18) and BrainRFQForm instruments it densely on page-1 specs (2412-2416), the dead engine blocks (2512-2583, 2642-2676), the ai-spec rows (2747-2752), the skip link (2790) and the file input (3640). renderCxPs — the ONE renderer for both planner pages (2894-2910) — contains no bes() call at all: no 'question_shown' for a shown planner question, no 'chip' on selection, no 'correction' when the buyer overrides a prefill. So besReport().shown/answered/answerRate (bes.ts:88-92), which the inspector prints as the Buyer Effort Score (BrainDebugPanel.tsx:507), systematically undercount the pages the whole 3-LLM re-architecture exists to produce, making BES useless as the counter-force to 'ask more questions' precisely where the planners add questions.


`src/components/BrainRFQForm.tsx:2894-2910 · src/lib/bes.ts:88 · src/components/BrainDebugPanel.tsx:507`


### HIGH — BuyLead dispatch is a stub AND the host wires no onSubmit — every submitted RFQ is discarded

dispatchBuyLead carries an explicit `⚑ DEV-TODO (BuyLead generation API — owner provides it later)` and only does two things: emit(EV.REQUIREMENT_SUBMITTED) and `onSubmit?.(req)`. BrainFormGate renders <BrainRFQForm> with surface/standalone/loggedIn/categoryMode/brainSeed/landing/glid/execMode/effortMode/pnsMode/leafTruth/onClose and NO onSubmit prop, so the optional call is always a no-op. The fully-assembled RFQSubmission (lossless text, page-1 specs, LLM-2 cxAnswers, LLM-3 psAnswers, contact, imageBase64, the Requirement Brain trace) is built and thrown away; the buyer still sees the 'results' success page. Nothing on the live route persists a requirement.


`src/components/BrainRFQForm.tsx:2074-2097 (stub + onSubmit?.(req) at :2096); src/components/BrainFormGate.tsx:288-297 (no onSubmit passed); src/components/BrainRFQForm.tsx:91-92 (interface DEV-TODO)`


### HIGH — Contact is always empty and the OTP gate is always bypassed on ?rfq=brain

BrainFormGate passes `loggedIn` (bare = true), so isLoggedIn starts true and applyLoggedInDefaults runs, whose last statement is `otpVerified.current = true`. submit() therefore takes the `if (otpVerified.current) { dispatchBuyLead(); setStage('results'); }` branch and OTPGate never mounts. But every value applyLoggedInDefaults fills comes from seedIdentity ← _seed.buyerIdentity / buyerFacts / buyerProfile / bulkGate, and on the leaf flow the payload is built by normalize({glid, node_raw}) which populates NONE of those metadata slots — so name/mobile/email/buyerType/gstin are all ''. The Contact card is collapsed by default (contactOpen=false) and is rendered unconditionally despite its own comment claiming 'logged-in … this whole card is hidden'. Net: submission ships contact {name:'',mobile:'',email:''} with no verification and no validation (blEligible checks qty/specs/notes only).


`src/components/BrainFormGate.tsx:290; src/components/BrainRFQForm.tsx:564, 582-628, 2108-2114, 2982-2999, 3213`


### HIGH — JSON-parse failure of all three RFQ LLMs is invisible in LLM_HEALTH (recordParse never called)

llm.ts parseJson swallows the error and runRequirementBrain / runPlanner just `return null`. gemini.ts exports recordParse specifically so 'a green ring with parseOk:false is now readable as exactly what it is' (gemini.ts:191-197), and it IS called for extractBuyerProfile, planRequirement, curated-planner and getMissingSpecs — but never for 'requirement-brain', 'commercial-planner' or 'persona-planner'. So a truncated/unparseable brain or planner response records ok:true, HTTP 200, tokens and cost in the debug panel while the feature silently degraded. Same blind spot for a maxTokens clip at BRAIN_MAXTOK=18000.


`src/lib/rfq/llm.ts:42-47, 139-140, 188-189; src/lib/gemini.ts:191-197 (recordParse), callers at :380,:1108,:2576,:2857`


### HIGH — LLM 2 / LLM 3 failure is entirely silent — no telemetry, no error event, no buyer message, page auto-skipped

usePlannerController's commercial branch does `.then(env => … else setStage('persona')).catch(() => setStage('persona'))` and the persona branch the same to 'more'. There is no emitApiError, no EV.* emit, no showFeedback and no error state anywhere in the hook (it imports nothing from the telemetry layer). A 429/5xx/timeout from the gateway is indistinguishable from 'the planner had nothing to ask': the buyer is silently advanced past a page that should have carried 3-5 questions, and no operator signal is produced. Contrast the LLM-1 path, which does call emitApiError + EV.AISPECS_FAILED and shows a Retry (BrainRFQForm.tsx:1331-1335).


`src/lib/rfq/usePlannerController.ts:45-48 and :58-62`


### HIGH — Legacy routes share the rewritten gemini.ts / score.ts / OptionChips and can regress silently with no test or eval to catch it

App.tsx routes are ?profile= (BuyerProfileStandalone), ?rfq=brain (BrainFormGate), ?rfq=brain2 (DynamicRFQ), ?rfq=simple|category (SimpleRFQForm), ?rfq=standard (StandardRFQForm), else MainApp — and MainApp mounts RFQModalV3 (MainApp.tsx:266), RFQModalV4 (:278) and SimpleRFQForm (:292). All of those import src/lib/gemini.ts, whose 3-LLM-era edits are global: MODEL_FAST and MODEL_RICH both repointed to google/gemini-3.5-flash-lite (gemini.ts:33-34), reasoning_effort + allowed_openai_params added to every body (gemini.ts:268-278), default maxTokens 16000 and default timeoutMs 240000 (gemini.ts:249). V3/V4's ~14 legacy call sites (analyzeImage, voiceToSpecs, planRequirement, deriveIntent, inferSpecsFromApplication, runCuratedPlanner …) all changed model and transport with no route-level test. utils/score.ts is shared by 5 components (SimpleRFQForm, RFQModalV3, RFQModalV4, BrainRFQForm, ScoreBadge) and OptionChips.tsx by 4 (both are in the modified-files list), and src/lib/rfq/llm.ts is imported by BOTH ?rfq=brain and ?rfq=brain2 — so every prompt edit is a two-route change. The handoff should name this blast radius explicitly.


`src/App.tsx:31-45 · src/MainApp.tsx:266 · src/lib/gemini.ts:33-34`


### HIGH — Mic and camera are two more LLM calls nobody mapped — and one uses a 4th, unrated model that breaks the model lock

The form makes two more LLM calls the '3-LLM' framing hides. Camera: onPhoto (1711-1745) resizes/rejects >5 MB, then analyzeImage(base64, mime, productName, fieldNames, fieldOpts, '', 'form', RFQ_MODEL_IMAGE) at 1728, plus a seeded-image variant at 1500. Mic: VoiceRecorder → voiceToSpecs(..., 'form', RFQ_MODEL_MIC) at 1760, with bes('voice') at 1754 and bes('upload') on the file input at 3640. Both merge through applyExtractedSpecs (1604-1609) and bump aiEpoch. Three consequences: (1) RFQ_MODEL_IMAGE = 'google/gemini-3.6-flash' (line 209) is a FOURTH model string, absent from LLM_RATES (gemini.ts:171-178), so estCostUsd falls back to {in:0.15,out:0.60} (gemini.ts:180) and the inspector over-reports every photo call — and it contradicts the owner's 'all 3.5 flash lite only' lock the handoff records; (2) aiEpoch is part of LLM 1's fireKey (1200) so photo/voice re-fires the brain, but LLM 2/3 key on mcatId alone (usePlannerController.ts:42/56), so new photo/voice evidence NEVER reaches the planners; (3) photoSpecsRef is journey-level and deliberately survives a product change (1040-1043) while being dropped on an mcat change at commit (1026) — two rules in tension that a resumer will trip over.


`src/components/BrainRFQForm.tsx:209 · :1728 · :1760 · src/lib/gemini.ts:180`


### HIGH — Retired engine-Decision-Layer surfaces are still live state + render blocks — the '#4d cleanup pass' is explicitly deferred

The LLM-1 effect resets nine engine-era states on every plan with the admission: 'Their state + render blocks remain until the #4d cleanup pass; nothing feeds them any more.' Verified: setBaq / setIdentityAsk / setPersonaAsk / setPersonaRoute / setPreAnswered / setPlacementRoutes / setEnginePhrasing / setCoveredGapReasons are ONLY ever called with null/[]/{} (lines 1046 and 1218-1219), and setPlanCorrections only with [] (line 1046). Their consumers are therefore permanently dead: the identityAsk GST ask (2723-2738), personaSection/personaAsk (2530-2541, 2741), the baq opening question + loader (2603-2610), preAnsweredSection (2608), the planCorrections/observedFields provenance routes (1390-1401), and coveredGapReasons/enginePhrasing in the routing ledger. `engineDecisions` is likewise always empty because both seeds the gate uses set it to [] (formAdapter recommendationToSeed:696) or omit it (buyerSeed→blankSeed:725-728), so renderableConflicts/renderableSuggests can never populate either. Several hundred lines of unreachable UI in the largest file on the route.


`src/components/BrainRFQForm.tsx:1216-1220 (the admission), 1046, 1122-1176, 1384-1458, 2530-2541, 2603-2610, 2626-2680, 2717-2758; src/lib/brains/formAdapter.ts:696, 725-728`


### HIGH — The score rail can never reach 100 once LLM 2 owns delivery/payment — 17 unfillable points plus a nudge to a hidden field

calcScore adds 'Delivery timeline' (7 pts) and 'Payment terms' (10 pts) unconditionally applicable, reading form.deliveryTimeline / form.paymentTerms (src/utils/score.ts:78-80). scoreDetails passes exactly those two state values (BrainRFQForm.tsx:1876) and passes NO cxAnswers/psAnswers at all, so nothing LLM 2/3 collects is ever scored. Meanwhile logisticsBody HIDES both last-page controls when the commercial plan covered them: `placement.delivery_timeline==='last_page' && !cxCoversTimeline` (2953) and the payment twin (2959), with cxCovers matching the planner's field/label/answer keys (2933-2935). Verified that nothing bridges the two: grep for setDeliveryTimeline/setPaymentTerms shows writers only at seed (1778-1779), the dead promoted blocks (2552/2560) and the now-hidden last-page chips (2956/2962) — never from cxAnswers. So a buyer who answers LLM 2's delivery+payment questions loses 17 of ~100 points permanently, and `nextCheck` (1892) will keep pointing 'Fill next' at a check whose control no longer renders, with jumpToCheck (2133) flashing a data-flash target that is not in the DOM.


`src/utils/score.ts:78-80 · src/components/BrainRFQForm.tsx:1876 · :2953 · :2933`


### HIGH — The seller-search / results stage (the 5th page) is completely unmapped

resultsBody renders CuratedSellerBoard (BrainRFQForm.tsx:3104-3116) fed by `curateBoard(sellerResults, deliveryLocation||userLocation||detectedCity)` (3103). The fetch effect (887-918) fires searchSellers once per mcatId when `stage==='more' || stage==='results'`, guarded by sellerFiredFor + a monotonic sellerRunRef, 60000 ms timeout, error→sellerStatus 'error'. Three things a resumer needs and no doc/agent states: (a) its own comment (889-893) says it fires on the 'specs2 → more' tap, but specs2 is dead — today it fires on the PERSONA→more tap, so the ~30 s windmill call now overlaps only the last page, not pages 2-3 as designed; (b) it sends ONLY `specValues` (904) — no aiSpecValues, no extraSpecs, no cxAnswers/psAnswers — so nothing LLM 1/2/3 produced influences seller retrieval; (c) buyerCity is read at FIRE time while the city inputs live on the very page that triggers it (911-913), so editing the city afterwards does not re-fire. src/components/CuratedSellerBoard.tsx is a new untracked file and is the entire closing UX.


`src/components/BrainRFQForm.tsx:887-918 · :3103-3116 · src/lib/sellerSearch.ts:1`


### HIGH — Untouched prefill/confirm answers on Pages 2/3 are lost from the submission AND invisible to the merge layer

cxAnswers/psAnswers initialise to `{}` (BrainRFQForm.tsx:458-459) and are written ONLY by renderCxPs' onChange (2911-2912). renderCxPs displays a prefilled value as `answers[q.field] ?? q.value` (2904-2905) but never commits q.value to state. The planner prompt explicitly tells LLM 2/3 to emit prefill/confirm rows carrying a value from truth (llm.ts:167), and runPlanner deliberately keeps those rows chip-less. Consequence chain, all verified: (1) buildSession sets page2 = cxAnswers / page3 = psAnswers (plannerController.ts:20), so answeredKeys never sees the prefill and dropAnswered cannot dedup against it — LLM 3 may legitimately re-ask a concept LLM 2 already prefilled; (2) dispatchBuyLead ships `commercial: nonEmpty(cxAnswers)` / `persona: nonEmpty(psAnswers)` (2083), so the prefill is absent from RFQSubmission; (3) buildRequirementText iterates `{...cxAnswers, ...psAnswers}` (1983), so it is absent from the lossless text too. A buyer who agrees with every prefilled commercial answer by not touching it submits an RFQ with an empty commercial block. No agent reported this.


`src/components/BrainRFQForm.tsx:2904 · :2083 · :1983 · src/lib/rfq/plannerController.ts:20`


### HIGH — Zero test coverage for src/lib/rfq/ — and the 39 green tests certify the RETIRED architecture

No test file imports any module from src/lib/rfq/. The only 4 suites are plannerBlocks.test.ts, sourceConsumption.test.ts, specHygiene.test.ts, substringGuard.test.ts (src/lib/__tests__/), and grepping them for 'lib/rfq|llm|contracts|dataLayer|plannerController' returns only two incidental ledger STRINGS (substringGuard.test.ts:154 quoting a BrainRFQForm suggester regex, :164 quoting rfqEvals). Worse, two suites pin the pre-3-LLM design: plannerBlocks.test.ts:12 asserts PLANNER_BLOCKS against `runCuratedPlanner` in gemini.ts:2309 — the planner BrainRFQForm.tsx:1214 states is retired — and sourceConsumption.test.ts:23 loads src/lib/brains/requirementBrainFixtures.json and validates it against sourceContract.ts, the monolith's facet contract. So `npm test` reporting 39/39 (which the handoff cites as evidence of health) guards code no live buyer reaches, while NOTHING guards normQuestions' ui whitelist, the >=2-chip drop (llm.ts:193), applyBudget, dropAnswered/answeredKeys, haveRealBrain, fence/fenceNumbered/FENCE_CAP truncation, or any of the fire-once/upgrade-refire guards. plannerController.ts:5 explicitly says these helpers were extracted to be 'pure and unit-testable first' — the tests were never written.


`src/lib/__tests__/plannerBlocks.test.ts:12 · src/lib/__tests__/sourceConsumption.test.ts:23 · src/lib/rfq/plannerController.ts:5`


### HIGH — captureRaw defaults to false, so EVERY pre-existing raw prompt/output consumer outside rfq/llm.ts now renders blank

`captureRaw = false` is the default in the destructure (gemini.ts:249) and the whole LLM_RAW/LLM_RAW_BY_ID capture is now wrapped in `if (captureRaw)` (gemini.ts:319). Only src/lib/rfq/llm.ts:138 and :187 ever pass it, and only when exec==='debug'. Every other caller in the estate never passes it, so LLM_RAW is now permanently empty for extractBuyerProfile, uc2Enrich, curated-planner, voiceToSpecs, analyzeImage, getMissingSpecs, getSpecHints, planRequirement and the rest. Concrete regressions: BuyerLedgerView.tsx:438 `getLLMRaw()['uc2Enrich']?.output` → undefined (UC2 debug band loses rawOutput); BuyerLedgerView.tsx:1156-1157 `io = rawIO['extractBuyerProfile']` → undefined, so the L4 'EXACT INPUT' request body falls back to synthCtx and BuyerLedgerView.tsx:1619 `getLLMRaw()['extractBuyerProfile']?.output` renders nothing; RFQModalV4.tsx:7230 and :7264 ship an empty `llmRaw` into the downloaded snapshot; downloadProfile.ts:123 and :165 do the same, which means offlineSnapshot.ts:40 `seedLLMRaw` has nothing to hydrate and the entire offline L4/L5 prompt render is dead; BrainDebugPanel.tsx:311 and :689 `raw['curated-planner']` → undefined. Also note the AI-Debug rail itself is gated on exec==='debug' (BrainFormGate.tsx:279), so in Production Preview no call anywhere captures raw I/O at all — the debug story is now all-or-nothing per mode.


`src/lib/gemini.ts:249,319 + consumers BuyerLedgerView.tsx:438,1156,1619; RFQModalV4.tsx:7230,7264; downloadProfile.ts:123,165`


### HIGH — catCorpus is NOT cleared on the seed short-circuit, so LLM 2 can be fed the PREVIOUS category's full corpus

In the mcat effect, the seed branch returns early: `if (_seed?.mcatId && mcatId === _seed.mcatId && _seed.categoryTopSpecs?.length) { setCatTopSpecs(_seed.categoryTopSpecs); return; }` (BrainRFQForm.tsx:494). It sets catTopSpecs but does NOT `setCatCorpus(null)` — only the fall-through path at :495 does. It also returns BEFORE `++catBrainTok.current` (:496), so a fetchCategoryBrainFull still in flight for the OLD mcat passes its own staleness check (`catBrainTok.current === tok`) and commits. Since usePlannerController.ts:45 PREFERS the corpus (`categoryEngine: p.catCorpus ?? p.catTopSpecs`), LLM 2 then reasons about category A's top_specs/personas/b2b_b2c while the buyer is on category B. This is precisely the wrong-category-advice bug the comment at BrainRFQForm.tsx:475-479 documents as already fixed for catTopSpecs; the new state re-opens it on a higher-authority input.


`src/components/BrainRFQForm.tsx:487-500; src/lib/rfq/usePlannerController.ts:45`


### HIGH — fetchCategoryBrainFull double-fires the SAME n8n webhook, and Redash caching is explicitly disabled (max_age:0) — it is two full query executions, not a cache-warm

BrainRFQForm.tsx:500 calls fetchCategoryBrainFull(mcatId) and :501 calls fetchCategoryTopSpecs(mcatId) in the same tick. Both hit the identical URL `/api/imworkflow/webhook/bi-category-brain?mcat_id=` (dataLayer.ts:147 and enrichment.ts:955); getJSON (api.ts:41) has no in-flight dedup. The comment at BrainRFQForm.tsx:498-499 claims 'same endpoint, so it is a cache-warm second GET rather than added latency' — that is wrong twice: (a) they are fired in PARALLEL so there is no first response to warm anything, and (b) the workflow's Redash node sends `max_age: 0` (jsonBody of node `redash-13521`), which forces a fresh execution of query 13521 every time. So each product commit now runs the call-analysis query TWICE. Worse, the node polls Redash for up to 120s (`const end=now()+120000` in `pii-strip`/`category-brain`) while both clients abort at 30s (dataLayer.ts:147, enrichment.ts:955) — and an aborted browser fetch does not cancel the n8n execution, so both queries run to completion regardless. Doubling the load makes the 30s abort MORE likely on both, and the failure mode is exactly the thing this change set out to fix: catTopSpecs undefined AND catCorpus null → LLM 2 plans commercial questions with no category at all.


`src/components/BrainRFQForm.tsx:498-508; src/lib/rfq/dataLayer.ts:144-151; src/lib/enrichment.ts:955`


### HIGH — ~700 lines of engine-era question UI are structurally unreachable, including the widget its own comment calls the most important in the form

engineDecisions = `_seed?.engineDecisions ?? []` (BrainRFQForm.tsx:1168) and BOTH seed builders hardcode it empty: recommendationToSeed returns `engineDecisions: []` (formAdapter.ts:696) and buyerSeed spreads blankSeed() with no decisions (formAdapter.ts:743-756, doc-comment 737-739 says Decision Objects are deliberately dropped). brainToSeed is no longer called (BrainFormGate.tsx:155-158). On top of that the LLM 1 fire clears the rest on every plan — `setBaq(null); setIdentityAsk(null); setPersonaAsk(null); setPersonaRoute(null); setPreAnswered([]); setPlacementRoutes([]); …` (1218-1220) — with `setPlacement((p)=>p)` a literal no-op, so `placement` stays at its default and no field is ever 'spec_page'. Therefore ALL of these render blocks are dead, for live buyers AND for the 3 fixture GLIDs: conflictsSection (2626-2658, whose own comment at 2618 calls it 'the single most important interaction in the whole form'), the SUGGEST section (2660+), preAnsweredSection (2505-2526), personaSection (2528-2541), promotedLastPage (2545-2588), the baq opening question (2601-2612) and the decisionRoutingReport inspector section. The handoff must either schedule the '#4d cleanup pass' the comment at 1216-1217 promises or state that these are inert — a resumer reading 3.6k lines cannot tell.


`src/components/BrainRFQForm.tsx:1168 · :1218-1220 · :2626 · src/lib/brains/formAdapter.ts:696`


### MEDIUM — ?rfq=brain2 (DynamicRFQ) is an unfinished parallel implementation of the same 3-LLM flow

App.tsx routes it, and it is the only consumer of dataLayer's fetchBuyerSpecs / fetchSellerSpecs and contracts' emptySession / defaultSim / SimConfig. Unfinished in concrete ways: (a) no submission at all — the terminal 'done' stage just pretty-prints the session JSON with 'next: curated seller search'; (b) result.known_truths from runRequirementBrain is never read, so every non-schema spec truth is dropped; (c) App passes no `sim`, so defaultSim() pins exec:'prod' and pns:'api' with no simulator UI, and no effort argument is ever passed to any of the three LLMs (all silently default to 'high'); (d) on LLM-1 failure `if (!brain)` skips BOTH planner stages entirely instead of using plannerController.fallbackContext the way the live route does; (e) the delivery page writes into session.page3 — the same bag as persona answers — with the comment 'reuse a bag'; (f) back-navigation does no replan ('v1 tradeoff').


`src/App.tsx:33; src/components/rfq/DynamicRFQ.tsx:34, 95-103, 109-119, 147, 181, 240-249`


### MEDIUM — A chip-less prefill/confirm on Pages 2/3 renders as a raw text box pre-filled with our guess

runPlanner drops only ui:'ask' rows with <2 chips (llm.ts:193); prefill/confirm/suggest rows legitimately arrive with a value and no options. renderCxPs then falls to `<input … placeholder="Type your answer">` whenever `q.options?.length` is falsy (BrainRFQForm.tsx:2903-2905), so a prefilled commercial/persona answer appears as free text the buyer must edit by typing — the exact interaction the option-based contract and Page 1's 'droppedFewOptions' gate (1293) exist to prevent, and the most expensive event in the BES weighting (text = 4, bes.ts:37). Combined with the untouched-prefill loss above, the same row is simultaneously the costliest to answer and the one silently dropped if left alone. Page 1 and Pages 2/3 therefore enforce two different rendering contracts for the same LLM output shape.


`src/components/BrainRFQForm.tsx:2903-2905 · src/lib/rfq/llm.ts:193 · src/lib/bes.ts:37`


### MEDIUM — A late-arriving full category corpus never re-fires LLM 2 — the upgrade guard watches only catTopSpecs

usePlannerController computes `haveCategory = (p.catTopSpecs?.length ?? 0) > 0` and allows one re-fire on `cxUsedNoCategory && haveCategory`. But the value actually fed to the planner is `p.catCorpus ?? p.catTopSpecs`. catCorpus and catTopSpecs come from two independent fetches issued in the same effect with no ordering guarantee; if catTopSpecs lands first the commercial planner fires with the distilled top_specs only, and when the full corpus (personas / keywords / b2b_b2c / top_products / coverage counters) arrives there is no guard that re-plans. p.catCorpus is in the effect deps, so the effect re-runs and then returns at the guard.


`src/lib/rfq/usePlannerController.ts:41-45, 50; src/components/BrainRFQForm.tsx:498-508`


### MEDIUM — BuyerLedgerView now displays a stale hardcoded 'google/gemini-2.5-flash' as the model, because its only real source of truth just went empty

BuyerLedgerView.tsx:1163 builds the L4 'EXACT INPUT' wire payload with `model: io?.model || 'google/gemini-2.5-flash'`. Since captureRaw is now false for extractBuyerProfile, `io` is always undefined (see the captureRaw finding), so the fallback ALWAYS wins and the ledger asserts a model that no longer runs anywhere in the app. Same stale literal is hardcoded at BuyerLedgerView.tsx:1618 (`<L3Band model={io?.model || 'google/gemini-2.5-flash'}`) and unconditionally at :1626 (`<UC2DebugBand … model="google/gemini-2.5-flash">`), which is now doubly wrong since uc2Enrich moved to lite (gemini.ts:437). Anyone debugging a card regression from this panel will reproduce against the wrong model. These should read RFQ_FORM_LLM_MODEL / the health record's `model`, not literals.


`src/components/BuyerLedgerView.tsx:1163,1618,1626`


### MEDIUM — Commercial and Persona planners only start when the buyer lands on their page — no prefetch

Both effects are gated `if (p.stage !== 'commercial' …)` / `!== 'persona'`, so the ~20-60s flash-lite call at reasoningEffort 'high' begins the moment the page mounts and the buyer stares at 'Preparing questions…'. Nothing warms LLM 2 while the buyer is still filling Page 1 (the data it needs — brain + page1_state + category corpus + pns — is available then, and page1_state is only refined, not created, by the last keystroke). The same is true for LLM 3 relative to Page 2.


`src/lib/rfq/usePlannerController.ts:37, 54; loader at src/components/BrainRFQForm.tsx:2895`


### MEDIUM — Cost figures in the debug panel are now wrong for both the new default and the still-hardcoded 3.6 model

The new LLM_RATES entry for 'google/gemini-3.5-flash-lite' (gemini.ts:174) is an admitted assumption copied from 2.5-flash-lite. Separately there is still NO entry for 'google/gemini-3.6-flash', which BrainRFQForm.tsx:209/222 and SimpleRFQForm.tsx:104-106 hardcode for the photo, use-case and page-2 spec calls — so estCostUsd (gemini.ts:176-179) falls through to the mid default {in:0.15, out:0.60} for them. BrainDebugPanel.tsx renders `$${r.costUsd.toFixed(4)}` per call to four decimal places, which reads as measured fact. Either add the 3.6 entry and label both as estimates, or drop the $ column until real rates are pinned.


`src/lib/gemini.ts:171-179; src/components/BrainDebugPanel.tsx (per-call cost row)`


### MEDIUM — Debug mode now shows the model LESS data than production, which is the opposite of the stated invariant

FENCE_CAP is described as 'SAME value in prod and debug, so the DATA the LLM sees is byte-identical in both modes' (llm.ts:13-14). It is not. fence() serialises with `JSON.stringify(v)` (llm.ts:18) while fenceNumbered() uses `JSON.stringify(v, null, 1)` and then prefixes every line with `Lnn ` (llm.ts:29-31). I measured a representative category-brain-shaped object: 3805 chars single-line vs 9350 chars pretty+numbered — 2.46x inflation. Because BOTH apply the same 60000-char cap, debug truncates at roughly 24k chars of prod-equivalent data while prod truncates at 60k. So for any source above ~24k chars (PNS-full, a fat CSL summary) the AI-Debug inspector is showing a run made on LESS evidence than production made its decision on, and the inspector's whole purpose — explaining the production decision — is invalidated for exactly the biggest sources. Fix is to scale the cap by mode or to cap the source value before formatting, not after.


`src/lib/rfq/llm.ts:13-35`


### MEDIUM — FENCE_CAP 10000→60000 raises the brain's worst-case prompt 6x, and truncation still slices raw JSON mid-structure

runRequirementBrain fences 10 sources (llm.ts:122-130), so the worst case moves from ~100k chars (~25k tokens) to ~600k chars (~150k tokens) per call, and the request body from ~120KB to ~0.7-1MB — untested against whatever body limit the production gateway replicates for /api/llm. It is multiplied by MAX_PLANNER_RUNS = 6 automatic runs per product (BrainRFQForm.tsx:214), and each run also carries BRAIN_MAXTOK 18000 output with 'high' effort now live. Second issue, unchanged but 6x amplified: truncation is a raw `s.slice(0, FENCE_CAP)` (llm.ts:19, llm.ts:30), so a source that hits the cap is handed to the model as syntactically INVALID JSON with a trailing prose note. The comment says only 'a pathological unbounded PNS-full transcript could ever reach it' — that is precisely the pns=full source the live form fetches (BrainRFQForm.tsx:1252), so the broken-JSON path is on the main flow, just 6x longer now.


`src/lib/rfq/llm.ts:15-20,30,39; src/components/BrainRFQForm.tsx:214,1252`


### MEDIUM — Fixture vs live divergence in the seed layer: the demo GLIDs exercise buyer facts a live pull never has

BrainFormGate seeds `payload` from `fixture(glid)` (BrainFormGate.tsx:44/81), which resolves only for GLIDs present in the fixtures map (requirementBrain.ts:259-262); useCaseGlids.ts lists 10 scenarios of which exactly 3 carry `instant: true` (140092812, 106815489, 244092512). For the other 7 (and any typed GLID) fixture() returns null, so `payload` is null and BOTH the 🔬 button (BrainFormGate.tsx:259) and the debug rail (:279) cannot mount until the leaves land. On a LIVE pull the payload is built by normalize() over a hand-made node_raw of only rfq+csl (BrainFormGate.tsx:96), so metadata.buyer_facts / decisions / kyb_unlock are absent → buyerSeed carries no buyerFacts (formAdapter.ts:750) → seedIdentity is empty (BrainRFQForm.tsx:582-605) → buyerType '' and gstOnFile false. isBusinessRole then depends ENTIRELY on LLM 1's persona_read or psAnswers (BrainRFQForm.tsx:1824-1826), so whether the P3 GST question appears is LLM-dependent for real buyers but seed-determined for fixtures. Also note the comment at 1819 still says 'GST itself is asked ONLY on the last page', contradicting showGstOnPersona at 1838.


`src/components/BrainFormGate.tsx:44 · :96 · src/lib/brains/useCaseGlids.ts:8-19 · src/components/BrainRFQForm.tsx:1824`


### MEDIUM — Funnel + API-error telemetry never leaves the browser, so nothing observes the 3-LLM flow in production

Every EV.* event the form emits (EV.PAGE_TRANSITION, EV.PRODUCT_COMMITTED, EV.AISPECS_FAILED, EV.REQUIREMENT_SUBMITTED at BrainRFQForm.tsx:2095) and every emitApiError (runRequirementBrain:1332, getISQs:1070, McatDtl:1077, GetIsq:1101, resolveMcat:1005, fetchProductImages:2041, sellerSearch:916, analyzeImage:1744, voiceToSpecs:1791) goes through src/lib/emit.ts, whose sendBeacon transport is COMMENTED OUT (emit.ts:47) and whose header states the collector is a to-do requiring VITE_EVENTS_URL (emit.ts:10). Combined with LLM telemetry living in an in-memory 80-record ring (gemini.ts:184-188) that resetSourceHealth/resetLLMTelemetry wipe per pull (BrainFormGate.tsx:79), there is currently NO way to observe a failure of any of the three LLMs outside a live debug session — which matters because the same code path is what a resumer would use to prove the PNS/category flakes are server-side.


`src/lib/emit.ts:10 · :47 · src/components/BrainRFQForm.tsx:2095`


### MEDIUM — LLM 1 never re-runs after a photo / voice / use-case addition once it has fired

applyExtractedSpecs bumps aiEpoch only `if (eager.changed && refire && !plannerFiredFor.current)`, and handleAssistSubmit likewise only `if (!plannerFiredFor.current)`. Both were deliberately gated to stop a page reset, but the effect is that new evidence the buyer supplies AFTER Page 1 renders never reaches the Requirement Brain — no re-prefill, no new questions, and the brain that rides into LLM 2/LLM 3 and the submission is stale. The only re-arm is the buyer-visible 'Retry' (retryAiSpecs), which is only shown on failure.


`src/components/BrainRFQForm.tsx:1623-1638 (esp. 1637), 1698-1701, 2048-2054`


### MEDIUM — LLM 2 / LLM 3 planner debug renders only inside the `plan?.brain` branch — lost whenever LLM 1's raw output is missing or unparseable

The whole block is gated on `const out = raw['requirement-brain']?.output ?? raw['curated-planner']?.output; if (!out) return null;`, then `if (!plan?.brain && !u && !considered) return null;`, and the two <PlannerDebugBlock> calls for the commercial and persona planners sit INSIDE `if (plan?.brain) { … }`. So if the brain call failed, was clipped, or emitted no `brain` key, the panel silently drops the LLM-2/LLM-3 reasoning, competition ledger (metadata.considered) and needs_input tables — the very output PLANNER_DEBUG_CONSIDERED was added to produce. A brain output that fails JSON.parse returns a one-line amber message and nothing else.


`src/components/BrainDebugPanel.tsx:542-549, 561, 645-648`


### MEDIUM — LLM-2/LLM-3 answers and the Requirement Brain never reach seller matching

searchSellers is called with productName / mcatId / mcatName / specValues / quantity / unit / buyerCity only — commented 'ONLY page-1 buyer specs (owner) — no extras/smart-Qs'. So cxAnswers (warranty, delivery, payment, supplier type…), psAnswers (designation, industry, size…), aiSpecValues, extraSpecs and rbBrain are all excluded from the retrieval that produces the six seller cards. The brain rides only in RFQSubmission.brain, which goes nowhere (see gap 1).


`src/components/BrainRFQForm.tsx:900-913, 2080-2086`


### MEDIUM — No per-seller enquiry dispatch — results-page CTAs are demo/absent by admission

Two explicit notes: '⚑ DEV-TODO: "Send Enquiry" / Call / WhatsApp are still DEMO CTAs — wire the real per-seller dispatch using s.id (glusrid)' and '`onEnquire` IS DELIBERATELY OMITTED … There is no per-seller dispatch endpoint anywhere: `dispatchBuyLead` is a stub'. CuratedSellerBoard is therefore rendered with no action handler at all, so the closing page has zero conversion path.


`src/components/BrainRFQForm.tsx:3074-3098, 3104-3116`


### MEDIUM — None of the three RFQ LLMs has a PROMPT_VER entry, so every prompt change in this set is unattributable in telemetry

PROMPT_VER (gemini.ts:153-166) has no key for 'requirement-brain', 'commercial-planner' or 'persona-planner', so promptVer() (gemini.ts:167) returns the build stamp PROMPTS_VERSION = '2026.06.14' (gemini.ts:147) for all three. That value is stamped into LLM_HEALTH (gemini.ts:324) and rendered by BrainDebugPanel.tsx as `{r.promptVersion}` on the per-call row, so the panel reports a June build stamp for prompts materially changed on 2026-07-31 (fenceNumbered, FENCE_CAP, DEBUG_SUFFIX line-citation rule, PLANNER_DEBUG_CONSIDERED, PROD_SUFFIX). Meanwhile RFQ_LLM_VERSION (llm.ts:9) still reads `{brain:'rb-v1', commercial:'cx-v1', persona:'ps-v1'}` — unchanged despite those edits — and is only ever written into the returned envelope, never into PROMPT_VER. This is the exact regression-attribution gap the file's own comment at gemini.ts:157-158 says was fixed for the other prompts.


`src/lib/gemini.ts:147,153-167,324; src/lib/rfq/llm.ts:9`


### MEDIUM — Per-field spec hints (isqHints) are read but never populated

`isqHints` is declared for 'the unified Curated-RFQ planner's field_hints' — a retired producer. setIsqHints is called exactly once, with {} (commit reset). renderSpecField still reads `const hint = isqHints[...]` and uses it for the caption and the text-input placeholder, so the hint feature is permanently blank. LLM 1's page-1 questions carry no helperText either (asks are pushed with `helperText: ''`).


`src/components/BrainRFQForm.tsx:444-447, 1044, 2418; asks built with helperText:'' at 1290 and 1298`


### MEDIUM — Seller search reads the buyer city at fire time and never re-fires — flagged as a known limit in code

Explicit note: '⚑ Known limit: this is read at FIRE time (entering the last page) while the city inputs live ON that page — a city edited afterwards does not re-fire the ~30s search.' The `sellerFiredFor.current === mcatId` guard also means a spec correction made after entering 'more' never reaches retrieval, so every dist_km and the ranking can be computed from a city/spec set the buyer has since changed.


`src/components/BrainRFQForm.tsx:887-916 (limit at 911-913)`


### MEDIUM — Sources panel is green-on-empty: `ok: d != null` counts [] / {} / "" as a healthy source

fetchProfile, fetchWhatsapp and fetchPnsInsights record `ok: d != null`. getJSON only throws on non-2xx, so an n8n webhook returning `[]` or `{}` is recorded ok:true and renders green in the debug rail's 'N/N sources' headline with an empty RAW block. fetchCsl/fetchRfq likewise record ok:true when viewed_products and searches are both empty. This is exactly the 'green-on-empty' disease the panel's own consumption-ladder comment names as one of the four recurring consumption bugs.


`src/lib/rfq/dataLayer.ts:83-102 (and 39-56, 59-80); src/lib/api.ts:41-51; rendered at src/components/BrainDebugPanel.tsx:261, 273-280, 304-309`


### MEDIUM — The brain2 route silently ignores the page -1 effort selector and always runs 'high'

The EffortMode thread is `BrainFormGate.tsx:43 → :294 effortMode → BrainRFQForm.tsx:335 default 'high' → :1258 runRequirementBrain(..., execMode, effortMode)` and `:2889 effort: effortMode → usePlannerController.ts:45,58`. The second surface added to App.tsx in this change set (`?rfq=brain2` → DynamicRFQ) calls `runRequirementBrain(..., sim.exec)` at DynamicRFQ.tsx:98 and `runner({...}, sim.exec)` at :113 with NO third argument, so both fall to the `effort: EffortMode = 'high'` defaults (llm.ts:120,176,197,198). With reasoning_effort now actually live, brain2 unconditionally spends maximum thinking on every call with no way to dial it down, and any latency/cost measured on brain2 is not comparable to brain. Also BrainFormGate.tsx:43 declares the state as an inline `'low'|'medium'|'high'` literal union instead of importing EffortMode (contracts.ts:77) — two definitions of the same contract that can drift.


`src/components/rfq/DynamicRFQ.tsx:98,113; src/lib/rfq/llm.ts:120,176; src/components/BrainFormGate.tsx:43; src/lib/rfq/contracts.ts:77`


### MEDIUM — The commercial prompt describes ONLY the full-corpus shape, but the fallback (and the whole brain2 route) sends a different shape

PLANNER_SYSTEM tells the model that <category_engine> is 'the COMPLETE category corpus for this mcat: `top_specs` each with `asked_pct` … and `top_values` … plus `personas`, `keywords`, `b2b_b2c` and `top_products`' (llm.ts:162), and PLANNER_DEBUG_CONSIDERED repeats it (llm.ts:78). But usePlannerController.ts:45 falls back to catTopSpecs, which is a bare `{q, pct, vals}[]` array (enrichment.ts:961-970) with none of those key names and none of those sections. So whenever the full fetch fails the model is told to read keys that are not in the payload — and per the finding above that fallback is the common case, not the rare one. Worse, the second surface DynamicRFQ.tsx:113 passes `categoryEngine: sellerSpecs.current` (the distilled shape from fetchSellerSpecs, dataLayer.ts:132-133) 100% of the time, so on `?rfq=brain2` the glossary is never accurate. The prompt needs to describe both shapes, or the fallback needs to be normalised into the documented shape.


`src/lib/rfq/llm.ts:78,162; src/lib/rfq/usePlannerController.ts:45; src/components/rfq/DynamicRFQ.tsx:113`


### MEDIUM — The debug 'candidate pool' section parses fence tags the current prompts never emit — permanently dead

That block reads `raw['curated-planner']?.user` and looks for <seller_top_questions>, <seller_flagged_specs>, <page1_buyer_specs>. The live prompts emit <buyer_specs_schema>, <seller_specs>, <browsed_specs>, <category_engine>, <requirement_brain>, <page1_state>, <page2_state>. curated-planner is retired (BrainRFQForm.tsx:210, 1214), so `pin` is always undefined and the whole 55-line verdict/from_ref machinery — plus the `understand` / `questions that competed` blocks above it — can never render on ?rfq=brain.


`src/components/BrainDebugPanel.tsx:649-742 (esp. 688-690, 713-720); prompts at src/lib/rfq/llm.ts:122-130, 178-183`


### MEDIUM — The eval harness exists but is wired to the legacy modals only — the 3-LLM route has no eval surface

src/lib/rfqEvals.ts (191 lines) exports questionQualityEval, intentQualityEval, categoryQualityEval, fusionQualityEval, plannerQualityEval, rfqQualityEval, leadQualityEval, outcomeEval and evaluateRFQ. Its only importers are RFQModalV3.tsx:47 and RFQModalV4.tsx:53 — neither BrainRFQForm, BrainFormGate, BrainDebugPanel nor anything in src/lib/rfq imports it. So the 'Observability & eval rail' the inspector is titled after has telemetry (LLM_HEALTH, SOURCE_HEALTH, BES, the consumption ledger) but no scored eval of LLM 1/2/3 output quality, and the plannerQualityEval that would grade a planner's questions grades the retired one. A resumer asked to 'improve the planners' has no measurement to move.


`src/lib/rfqEvals.ts:1 · src/components/RFQModalV3.tsx:47`


### MEDIUM — The first demo scenario advertises a feature that is dead code

USE_CASES[0] is `{ label: 'Conflict (500L vs 1000L)', glid: '140092812', instant: true, note: 'call says 500L, viewed 1000L — A/B resolver' }` (useCaseGlids.ts:9) and it is the top button under 'Or try a scenario' (BrainFormGate.tsx:239-245) — the first thing anyone resuming this project will click. The A/B resolver it names is the conflictsSection, which cannot render because engineDecisions is always empty (see the engine-era gap). Several other notes are equally stale against the 3-LLM flow ('Noise-suppressed — junk profile fields hidden, logged', 'No category brain — non-spec questions only'). Either the scenario list or its labels needs re-basing, or the handoff must warn that these notes describe the retired monolith.


`src/lib/brains/useCaseGlids.ts:9 · src/components/BrainFormGate.tsx:239`


### MEDIUM — The inline catalog transport in BrainRFQForm is the real page-1 data path and is largely invisible to the inspector

The live form does NOT use dataLayer's resolveMcat/fetchBuyerSpecs (those serve ?rfq=brain2 only). It calls, inline: mcatid-suggestion.php twice (raw name then stripQuantityPrefix'd, BrainRFQForm.tsx:996-1004, getJSON default 15 s); POST /api/mimart/api/bmcajax/addressbook/getISQs with an explicit 30000 ms timeout (1052) — which alone derives units, splits buyer vs seller rows on IM_SPEC_MASTER_BUYER_SELLER==='2' (1062) and is the ONLY writer of sellerSpecsRef + setSellerSpecsReady, in its .finally (1070); /api/imimg/index.php?r=postblenq/McatDtl (1071, no timeout → 15 s default) for categoryNameRef + the hero image; and Newreqform/GetIsq (1084, 15 s default). Of these only GetIsq is recordSource'd ('Specs · GetIsq', 1098/1101). So getISQs — the call that GATES LLM 1 via gate 4 `if (!sellerSpecsReady) return` (1187) — has no row in the Sources pane, and neither does mcat-resolve or McatDtl. A resumer debugging 'the brain never fired' has no instrument pointing at the actual cause.


`src/components/BrainRFQForm.tsx:996 · :1052 · :1070 · :1098`


### MEDIUM — The landing→specs auto-advance and the unitsResolved gate are undocumented stage transitions

Two behaviours own the landing→specs move and no agent described either. (1) THE QUANTITY RULE (1995-2012): `hasUnits = unitOptions.length > 0`; when a committed+resolved mcat defines NO units and no quantity was captured, an effect calls setStage('specs') once per mcatId via autoAdvancedFor (2007-2011) — so for unit-less categories the buyer never sees the qty block and Back does not re-bounce forward. The reverse redirect (specs→landing on a blank qty) was removed 2026-07-30 (2014-2017), so quantity now gates nothing. (2) `canContinueProduct = !!productName.trim() && committed && unitsResolved` (2004) — unitsResolved is set only by the GetIsq success path (1093) or the getISQs .finally (1070), so a category whose BOTH ISQ calls hang leaves the landing's Continue disabled for the full 30 s with no visible reason. These are the transitions most likely to be mistaken for bugs during a resume.


`src/components/BrainRFQForm.tsx:2002-2012 · :2004 · :1093`


### MEDIUM — The late-arriving full corpus can never re-fire LLM 2, and a corpus-only success does not count as 'have category'

usePlannerController.ts:41 computes `haveCategory` from catTopSpecs ONLY, while :45 prefers catCorpus. Two consequences. (1) If the distilled fetch fails but the full fetch succeeds, haveCategory stays false, cxUsedNoCategory stays true, and the guard at :42 short-circuits — so LLM 2 never re-fires even though catCorpus is in the effect deps at :50, i.e. the dependency implies a re-plan that the gate then refuses. (2) On the happy path both fetches race (both started at BrainRFQForm.tsx:500-501). If catTopSpecs resolves first and the buyer is already on the commercial stage, LLM 2 fires with the distilled shape and sets cxUsedNoCategory = false; when catCorpus lands a moment later there is no upgrade re-fire left, so the complete corpus — the entire point of the change — never reaches the prompt. There is also no telemetry to notice: recordSource('Category · bi-category-brain', …) is only called for the distilled fetch (BrainRFQForm.tsx:503,508), so the inspector shows one category source and one latency while two requests ran.


`src/lib/rfq/usePlannerController.ts:41-50; src/components/BrainRFQForm.tsx:500-508`


### MEDIUM — The model lock is incomplete AND the comment explaining MODEL_RICH is factually wrong for the live route

gemini.ts:31-32 claims 'MODEL_RICH is kept as a separate NAME — it is referenced by the multimodal (image/audio) call sites, so pointing it back at a heavier model is a one-line change.' On the live `?rfq=brain` route that is false in both halves. BrainRFQForm.tsx:209 hardcodes RFQ_MODEL_IMAGE = 'google/gemini-3.6-flash' and passes it explicitly at :1500 and :1728, and :222 hardcodes RFQ_MODEL_USECASE = 'google/gemini-3.6-flash' passed at :1695 — so the photo and use-case calls bypass MODEL_RICH entirely and still run a 3.6 model despite the owner's 'across all use 3.5 flash lite only'. Flipping MODEL_RICH back would change nothing on the live route. SimpleRFQForm.tsx:104-106 does the same for image/specs/use-case. The call sites that DID change to lite and are worth an explicit quality check are: offerEnrichLLM (gemini.ts:417, whose own comment at :415-416 says 'the lite model demonstrably missed these'), enrichRequirementLLM (gemini.ts:437), voiceToSpecs default (gemini.ts:516 — hit by RFQModalV3.tsx:2653 and RFQModalV4.tsx:2690, which pass no model), analyzeImage default (gemini.ts:595 — RFQModalV3.tsx:2738,2807 and RFQModalV4.tsx:2775,2844), and explainSpec's image branch (gemini.ts:1985, from RFQModalV3.tsx:2918 / RFQModalV4.tsx:2955).


`src/lib/gemini.ts:31-34,417,437,516,595,1985; src/components/BrainRFQForm.tsx:209,222; src/components/SimpleRFQForm.tsx:104-106`


### MEDIUM — The name↔category collision override inside LLM 1 is now unreachable except in a leafTruth-late race

commitProduct already re-anchors the mcat when the CSL-browsed twin's mcat differs AND csl.category_isq is non-empty (`id = twin.mcat`). The LLM-1 effect then computes `collision = browsedTwin.mcat !== mcatId && catIsq.length > 0` — but after the swap mcatId IS twin.mcat, so collision is false; and if the swap did not fire it is because catIsq was empty, so collision is false again. The only path that still reaches browsedSpecs/collision is when leafTruthRef is still null at commit time but populated by the time LLM 1 fires (the effect gates on `if (glid && !leafTruth) return`). So the 'COLLISION OVERRIDE (highest priority)' rule in BRAIN_SYSTEM, the browsedSpecs input, the forced category_trustworthy:false, and browsedPool in the consumption ledger are dead on the normal path — while the comment at 1261-1266 presents them as the CRITICAL live mechanism.


`src/components/BrainRFQForm.tsx:1015-1021 (commit-time swap) vs 1233-1248 and 1261-1267; src/lib/rfq/llm.ts:109, 112, 127`


### MEDIUM — The submission has no consumer and the logged-out half of the form is unreachable on this route

BrainFormGate mounts BrainRFQForm with `loggedIn` and NO onSubmit prop (BrainFormGate.tsx:288-297). Two consequences. (a) dispatchBuyLead (2077-2097) builds the full RFQSubmission — text + specs + commercial + persona + the hidden `brain` — signs it for dedup, emits EV.REQUIREMENT_SUBMITTED, then calls `onSubmit?.(req)` on undefined: the requirement is discarded. Its own DEV-TODO (2074-2076) names the missing BL POST. (b) Because loggedIn is true, applyLoggedInDefaults runs at mount (628) and sets `otpVerified.current = true` (625), so submit() (2108-2114) skips straight to dispatch — OTPGate (3650), handleLogin (627) and the logged-out autofetch banner are dead on ?rfq=brain and have never been exercised against the 3-LLM flow. Anyone wiring the real BL endpoint has to build BOTH the host callback and the logged-out path.


`src/components/BrainFormGate.tsx:288 · src/components/BrainRFQForm.tsx:2077 · :625`


### MEDIUM — `placement` never changes — setPlacement is a literal no-op, so purchase-frequency never renders and the relocation allow-list is inert

placement is initialised to {…all 'last_page', purchase_frequency:'none'} and the only writer is `setPlacement((p) => p)` — an identity updater React bails out of. Therefore: the PURCHASE_FREQUENCIES field (guarded by placement.purchase_frequency, default 'none') can never render; `hasSpecPageExtras`'s `placement[f] === 'spec_page'` test is always false; showBuyerTypeField/showIndustryField reduce to `!personaStageActive`. The purchaseFrequency state is settable only from a control that never mounts, yet buildRequirementText still emits it.


`src/components/BrainRFQForm.tsx:1155-1158, 1220, 522, 1850-1851, 2717, 2963-2970, 1971`


### MEDIUM — mcat re-anchoring after a collision is admitted incomplete

Inline: 'NOTE: re-anchoring mcatId to the browsed category (so seller-search + submission also use it) is the completing follow-up.' The commit-time swap partially does this, but the two mechanisms were never reconciled — when the swap does NOT fire (no browsed ISQ) the brain can still be forced to category_trustworthy:false and drive Page 1 off generated questions while mcatId, seller-search and the submission all keep the mis-mapped category.


`src/components/BrainRFQForm.tsx:1261-1267`


### MEDIUM — safe() discards the error object, so a failed leaf has no status code or message anywhere

`async function safe<T>(p) { try { return await p } catch { return null } }` is the sole error handling for all six leaf fetches. The recorded SourceHealthRec gets ok:false, ms, raw:null, cleaned:null — nothing distinguishes a 500, a CORS block, a 60s timeout and an empty body, and no emitApiError is raised (contrast the GetIsq/category paths in BrainRFQForm which do call emitApiError). Debugging a flaky webhook from the inspector is not possible.


`src/lib/rfq/dataLayer.ts:12-14, 39-102`


### MEDIUM — specSplit is hardcoded false — the 'specs2' stage, its stepper node, and the empty-planner auto-skip effect are all dead

specGroups returns `split: false` unconditionally ('so `split` is always false and the specs2 stage/stepper node no longer exists'). Consequences: the 5-node stepper branch (417) is unreachable, prefillStage is always 'specs' (414), the specs2→specs rescue effect (434) can never fire, the specs2 wording branches in the ledger (1383, 1473-1475) are dead — and critically the 'EMPTY PLANNER PAGE → SKIP' effect begins `if (… || !specSplit) return;` so it ALWAYS returns early. The owner-requested behaviour 'skip when planner says nothing to fill' does not run at all; a category where LLM 1 emits zero extra questions leaves the buyer on a page with only the ISQ chips. Note also that stage 'specs2', if ever reached, falls through the render ternary to resultsBody.


`src/components/BrainRFQForm.tsx:400-418, 434, 2775-2782, 3210-3214`


### MEDIUM — specs2 is dead by a single guard effect, and three live code paths still branch on it

Beyond 'specGroups hardcodes split:false': the render switch has no 'specs2' case, so ANY stage that is not specs/commercial/persona/more falls through to resultsBody (3210-3214) — the ONLY thing preventing the seller board from painting for stage 'specs2' is the corrective effect at 434 that forces it back to 'specs'. Three paths still reference it and would re-animate on a flip of `split`: prefillStage (411) which checkStageIdx uses to place every Specs score check (1890-1891), the empty-planner auto-skip that calls setStage('specs2') and is guarded dead by `!specSplit` (2775), and STEPPER_LABELS' 'Confirm your details' entry (132). specGroups' prefilled/unfilled arrays are still computed each render with no consumer (409). Either delete the stage and its label or the handoff must record that it is a one-guard-away landmine.


`src/components/BrainRFQForm.tsx:434 · :3210 · :2775 · :409`


### MEDIUM — usePlannerController has no generation token — the fallback→real-brain upgrade re-fire races itself

Both effects fire, then commit whatever resolves, with no monotonic token (unlike commitGen / sellerRunRef / fetchGen / catBrainTok used everywhere else in this codebase). When LLM 2 fires on the thin fallbackContext and the real brain lands mid-flight, a SECOND call is issued and last-resolver-wins: the fallback's (worse) plan can overwrite the real-brain plan, or — if the fallback returns empty first — its `else setStage('persona')` pushes the buyer off a Commercial page whose real-brain questions are still in flight. setCxLoading(false) in the shared `finally` compounds it.


`src/lib/rfq/usePlannerController.ts:36-64`


### LOW — 'suggest' is in the shared Question contract and the normaliser but not in either planner's output schema

contracts.ts QuestionUi and normQuestions both accept 'suggest', and BrainRFQForm implements the ghost-chip path for it (llmSuggests) — but PLANNER_SYSTEM's OUTPUT block only declares "ask|prefill|confirm", so LLM 2/3 can never legitimately emit a suggestion. Conversely renderCxPs falls back to a free-text `<input>` when q.options is empty, which the runPlanner gate only prevents for ui:'ask' — a prefill/confirm row with no chips still renders as an uncontrolled text box on Pages 2/3.


`src/lib/rfq/contracts.ts:10, 18; src/lib/rfq/llm.ts:53, 171, 193; src/components/BrainRFQForm.tsx:2903-2905`


### LOW — A GLID with no fixture whose CSL and RFQ leaves both fail leaves the AI-Debug inspector unreachable and the status chip lying

load() seeds `setPayload(fixture(g))`, and fixture() returns null for any GLID not in the fixtures map. The csl+rfq handler bails with `if (!csl && !rfq) return; // both leaves down → keep the instant fixture` — but there is no fixture, so payload stays null. Both the 🔬 Debug button and the debugRail are gated on `payload &&`, so AI-Debug mode is silently unavailable for exactly the buyer whose data failed; and the glidChip renders the 'fixture' badge (its not-loading/not-live state) when no fixture exists. landingSeed also falls back to blankSeed().


`src/components/BrainFormGate.tsx:44, 81, 94, 166, 259-261, 268, 279-281; src/lib/brains/requirementBrain.ts:259-261`


### LOW — An inert baq.gaps merge loop is knowingly retained in the submitted-specs builder

'INERT since 2026-07-28 and deliberately kept: `baq.gaps` is emptied when the plan lands … Left in place so that if anyone ever re-populates baq.gaps the answers still reach the lead.' Since baq is now always null (see the retired-surfaces gap) both this loop and the baq.opening line above it are unreachable, as are baqAnswers, personaAnswer, conflictPicks and suggestPicks in the same useMemo.


`src/components/BrainRFQForm.tsx:1908-1942 (admission at 1914-1918)`


### LOW — Debug raw-capture stores the prompt twice per call and the panel renders it untrimmed, now 6x larger

The capture at gemini.ts:319 stores `input` (all messages joined) AND `user` (the user message) in the same record, so the biggest string is held twice, and the record is registered in both LLM_RAW and LLM_RAW_BY_ID. LLM_RAW_BY_ID grows for the whole session and is only cleared by resetLLMTelemetry (gemini.ts:82-87, called once per pull at BrainFormGate.tsx:79). BrainDebugPanel then renders `<Pre v={io.user}/>` with the explicit comment 'untrimmed — the Pre block scrolls, and the input cap is a 60k backstop'. With 10 fences at up to 60000 chars each, pretty-printed and line-numbered in debug, a single brain call can push well over a megabyte of text into one DOM node, and downloadInteractiveHtml (BuyerLedgerView.tsx:849) / downloadProfile.ts:123 embed the same blobs into a downloadable file. Worth a render-side slice with an explicit 'truncated for display' marker.


`src/lib/gemini.ts:82-87,319; src/components/BrainDebugPanel.tsx:451-471; src/components/BrainFormGate.tsx:79`


### LOW — Overstated claim to correct: normQuestions' 'skip'→'ask' coercion is not a live rendering bug

The mapped claim that normQuestions coerces the prompt's 'skip' to 'ask' (llm.ts:49) is textually right but its stated consequence is not reachable on either surface. A coerced 'skip' row carries no options, and (a) for LLM 2/3 runPlanner's own filter drops any ui:'ask' with <2 chips before the envelope leaves llm.ts (:193), (b) for LLM 1's page1 BrainRFQForm's loop records it as 'droppedFewOptions' and renders nothing (BrainRFQForm.tsx:1292-1293). The only way a coerced skip survives is if the model also emits >=2 options on a row it wanted omitted. Worth correcting in the handoff so a resumer does not spend time hunting a phantom free-text render; the real residual risk is the opposite one (chip-less prefill/confirm rendering as text, above).


`src/lib/rfq/llm.ts:49 · :193 · src/components/BrainRFQForm.tsx:1292`


### LOW — Prompt-input truncation at FENCE_CAP is invisible to telemetry

fence()/fenceNumbered() append '…[truncated N chars — runaway backstop]' inside the prompt string itself and nothing else. There is no counter, no health flag and no debug-panel warning, so a source that actually hit the 60000-char backstop (a full PNS transcript suite is the stated candidate) is only discoverable by reading the captured USER prompt — and only in AI-Debug, where captureRaw is on.


`src/lib/rfq/llm.ts:15-33`


### LOW — The automatic completeness fill was removed and its re-instatement is explicitly deferred

'COMPLETENESS FILL — AUTOMATIC FIRE REMOVED … Re-instate the automatic effect only if seller-search completeness measurably suffers without it (flagged to the owner).' Today empty ISQ specs are filled only if the buyer taps 'Fill my specs', so seller retrieval (which runs on specValues alone) can go out with a sparse spec set and nobody measures it.


`src/components/BrainRFQForm.tsx:1671-1680`


### LOW — The failure path of recordLLM omits reasoningEffort and id, so the panel's 'stripped' indicator cannot mean what it claims

BrainDebugPanel.tsx renders effort with the comment 'reasoning_effort as ACTUALLY sent — `—` means the gateway stripped it (400/422 compat path)'. But the !res.ok recordLLM at gemini.ts:308 (and the catch at :328) writes neither `reasoningEffort` nor `id`, so EVERY failed call shows '— (stripped)' regardless of what was sent, and a genuinely-stripped-then-succeeded call is indistinguishable from a call that simply failed. That directly undercuts the verification story the gemini.ts:292-295 comment relies on to prove allowed_openai_params is working. Pass `reasoningEffort: sentEffort` and `id` on the failure records too.


`src/lib/gemini.ts:308,328; src/components/BrainDebugPanel.tsx (effort row)`


### LOW — The seller-specs source (getISQs) has no health row — an LLM-1 input is unobservable

recordSource is called in BrainRFQForm for 'Category · bi-category-brain' and 'Specs · GetIsq' only. The getISQs POST that produces sellerSpecsRef (the <seller_specs> fence LLM 1 reasons over, and the buyer-spec enrichment that carries OPTIONS_DATA) records nothing — its failure only reaches emitApiError. The debug rail's source list therefore cannot answer whether seller_specs was empty because the category has none or because the call failed.


`src/components/BrainRFQForm.tsx:1052-1070 (no recordSource) vs 503, 508, 1098, 1101`


### LOW — Two form LLM calls override the global flash-lite model lock and have no cost-rate entry

gemini.ts pins both MODEL_FAST and MODEL_RICH to google/gemini-3.5-flash-lite under 'MODEL LOCK (owner 2026-07-31: "across all use 3.5 flash lite only")', and the three RFQ LLMs correctly inherit that default. But BrainRFQForm still hardcodes RFQ_MODEL_IMAGE and RFQ_MODEL_USECASE to 'google/gemini-3.6-flash' for the photo and use-case calls on the same route. That model has no LLM_RATES entry, so estCostUsd falls through to the mid rate and the debug panel's per-call $ figure is wrong for exactly those calls.


`src/components/BrainRFQForm.tsx:205-222; src/lib/gemini.ts:28-34, 171-182`


### LOW — Two identical HTTP calls to bi-category-brain per product commit

The same effect fires fetchCategoryBrainFull(mcatId) and fetchCategoryTopSpecs(mcatId), both GET /api/imworkflow/webhook/bi-category-brain?mcat_id=… with a 30s timeout. The full payload already contains top_specs, which is all the distiller keeps. The comment rationalises it as 'a cache-warm second GET rather than added latency', but it is a duplicated round-trip per commit and the two results can land out of order (see the missing corpus re-fire gap). Only the distilled call records a Source health row; the corpus call's failure is swallowed by `.catch(() => {})`.


`src/components/BrainRFQForm.tsx:496-508; src/lib/rfq/dataLayer.ts:144-151; src/lib/enrichment.ts:951-972`


### LOW — Two stale in-code comments will mislead a resumer about when things fire

(1) The seller-search effect's comment says it 'FIRES ON THE PAGE-2 NEXT TAP (specs2 → more), NOT on specs2 entry' and reasons about page 2's 'COMPLETENESS FILL' (BrainRFQForm.tsx:889-893) — specs2 and the completeness fill are both gone, so the described trigger does not exist; the real trigger is persona→more. (2) The commitProduct comment at 1078-1080 states the landing gallery 'is NOT fetched here any more' because it is 'owner-gated on the category actually defining a quantity', while the effect it points at is keyed on mcatId ALONE and explicitly reverses that gate (2019-2030). Both comments are the kind a resumer trusts over the code, and the brief for this handoff warns exactly against that.


`src/components/BrainRFQForm.tsx:889 · :1078 · :2019`


### LOW — Unused exports in src/lib/rfq/

`fetchCategoryEngine` (dataLayer.ts:135, an alias of fetchSellerSpecs) has no importer anywhere in src. `postSellerSearch` (dataLayer.ts:154) has no importer — the live seller call goes through src/lib/sellerSearch.ts's own ENDPOINT constant for the same /api/sellersearch path. `KnownFacts` (contracts.ts:46) is declared as 'the merge layer reads this to prefill/skip' but nothing references the type. `RFQ_LLM_VERSION` is exported but only consumed inside llm.ts itself.


`src/lib/rfq/dataLayer.ts:135, 154; src/lib/rfq/contracts.ts:46; src/lib/rfq/llm.ts:9`


### LOW — fence() can throw where fenceNumbered() cannot — prod fails on an input debug survives

fenceNumbered wraps serialisation in try/catch with a String(v) fallback (llm.ts:29). fence does not: `let s = JSON.stringify(v);` then `s.length` (llm.ts:18-19). A value JSON.stringify cannot handle (a cycle, a BigInt) throws, and a top-level function/symbol makes it return undefined so `.length` throws a TypeError — either way runRequirementBrain rejects before the call and BrainRFQForm.tsx:1260 sets aiSpecsError. Since fenceFor() picks fence for prod and fenceNumbered for debug (llm.ts:35), the identical input would work in AI-Debug and fail in Production, which is the hardest possible shape of bug to diagnose. Low likelihood (inputs are parsed network JSON) but a one-line fix to make the two symmetric.


`src/lib/rfq/llm.ts:16-33`


### LOW — fetchCategoryBrainFull breaks its own file's URL convention, and its doc comment overstates what the node returns

Every other fetch in dataLayer.ts builds its URL through `HOOK()`, which already applies api() (dataLayer.ts:9-10), and then hands it to getJSON, which applies api() again (api.ts:45). fetchCategoryBrainFull instead passes a RAW '/api/...' path (dataLayer.ts:147) so api() is applied exactly once. Today both work only because api() short-circuits on an absolute URL (api.ts:14) and API_BASE is '' in dev — a relative VITE_API_BASE would break the HOOK-based fetches and not this one, and the next editor copying either pattern gets a coin flip. Separately, the comment at dataLayer.ts:141 claims the node returns coverage counters 'calls_analyzed / rows_received / rows_unparsed'; the live `category-brain` node returns only `source`, `mcat_id`, `calls_analyzed`, `top_specs`, `personas`, `keywords`, `b2b_b2c`, `top_products` — the other two counters do not exist, so any debug panel or prompt reasoning that expects them reads undefined. On the upside I confirmed the payload is small and hard-capped server-side (top_specs 15, top_values 5, personas 6, keywords 10, top_products 8), so catCorpus itself is no context risk.


`src/lib/rfq/dataLayer.ts:9-10,137-151; src/lib/api.ts:14,45`


### LOW — llm.ts's local fence() does not map an empty object to '(none)', so the new debug source chips mark empty inputs as present

llm.ts:17 returns '(none)' only for null/undefined and for an empty ARRAY. An empty object serialises to `{}` (llm.ts:18) and, in debug, to `L1 {}` (llm.ts:29-31). BrainDebugPanel.tsx:214-216 detects an empty source by testing the fence body for exactly '(none)', so `already_filled` (llm.ts:124, seeded from a possibly-empty map at BrainRFQForm.tsx:1229-1231), `page1_state` (llm.ts:181) and `page2_state` (llm.ts:182) render as teal 'present' chips when the form holds nothing. That contradicts the exported gemini.ts fence(), which explicitly maps `'{}'` and `'[]'` to '(none)' (gemini.ts:67) precisely so 'we hold nothing' is distinguishable from 'we forgot to send it' (gemini.ts:57-59). Two divergent implementations of the same named primitive; the rfq one is the weaker of the two and is the one feeding the new inspector.


`src/lib/rfq/llm.ts:16-33; src/lib/gemini.ts:63-70; src/components/BrainDebugPanel.tsx:214-216`


### LOW — src/lib/rfq/dataLayer is only half-adopted — the live route re-implements the spec fetches inline

fetchBuyerSpecs (GetIsq) and fetchSellerSpecs exist in the extracted data layer but the live BrainRFQForm calls the identical GetIsq URL inline via getJSON and the getISQs enrichment via postJSON, with its own parsing (mapDisplaySpecs / deriveUnits / IM_SPEC_MASTER_BUYER_SELLER split). resolveMcat is also re-implemented as a local function inside commitProduct despite dataLayer exporting one. Two parsers for the same payload that can drift independently.


`src/lib/rfq/dataLayer.ts:107-134 vs src/components/BrainRFQForm.tsx:995-999, 1052-1070, 1084-1101`


## C · SERVER / n8n (29)


### HIGH — CSL summary emits `searched`, the frontend reads `searches` — buyer search phrases are always empty

`csl-to-llm1` builds the summary with `searched: freqList(searchCount)` (a name-only frequency-ordered array), plus `searched_last` and `requirement_searches`; `summary.activity.searches` is a COUNT, not a list. dataLayer.fetchCsl does `searches: (Array.isArray(s.searches) ? s.searches : []).map(String)` — `s.searches` never exists, so CslResult.searches is unconditionally []. The buyer's own typed search phrases — the strongest stated-intent signal in CSL and the thing the whole landing-truth fetch exists for — never reach LLM 1, and the recorded `cleaned` telemetry shows an empty array as if CSL had none. Note `omitEmpty` also removes `searched` entirely when there are no searches, so a consumer must treat absent and empty as the same thing. Fix by emitting `searches` as an alias in `csl-final1` (cheap, non-breaking) rather than only patching the client.


`node `csl-to-llm1` line ~225 (`searched: freqList(searchCount)`) → src/lib/rfq/dataLayer.ts:51`


### HIGH — `pns=full` is not implemented — it is a label-only alias of `pns=api`

The whole bi-pns-insights path is 3 nodes: webhook → pns-insights-api → pns-parse (terminal, responseMode lastNode). There is no branching node anywhere in the workflow — the only node types present are webhook, httpRequest, code, merge, respondToWebhook (no IF/Switch/Set). `pns-parse` merely ECHOES the mode: `mode: q.pns === 'full' ? 'full' : 'api'`. The actual full suite exists in the same file but hangs off the `bi-transcribe` webhook (t2 → redash-pns-[query 12475] → redash-vani-[query 12322] → pns-insights-api1 → pns-rows1 → vani-rows1 → pns-api-parse1 → pns-transcribe1 → vani-transcribe1 → assemble-rfq1), and no frontend code calls bi-transcribe. So the simulator's "PNS API-only (fast) vs full transcripts" toggle (BrainRFQForm Props.pnsMode:118) is a no-op, and dataLayer records a second, distinct source label `PNS · bi-pns-insights (full)` for identical bytes — false telemetry in the AI-Debug Sources panel. Either route pns=full into the transcribe chain, or delete the mode from the contract.


`node `webhook` (path bi-pns-insights) → `pns-insights-api` → `pns-parse`; unreachable suite behind node `t2` (path bi-transcribe)`


### HIGH — bi-category-brain reports GREEN on a Redash failure or poll timeout — "empty category" and "broken pipe" are indistinguishable

`redash-` has neverError:true and NO retryOnFail. On a 4xx/5xx, or when the 120s job poll in `pii-strip` expires, `rowsFromTrigger` returns [] with every error swallowed by bare `catch(e){}`. pii-strip then computes rows_in:0, dropped:0 → `ok:(dropped===0)` = true and `status:(dropped===0?'green':…)` = 'green'. `category-brain1` emits calls_analyzed:0, rows_received:0, rows_unparsed:0, top_specs:[] and NO error field. The frontend's only health signal is `recordSource('Category · bi-category-brain', { ok: !!s?.length })`, so a transport failure is logged identically to a genuinely call-less mcat, and the `cxUsedNoCategory` upgrade re-fire in usePlannerController never gets a second chance because nothing ever arrives. The node needs a distinct terminal state (e.g. redash_status: 'ok' | 'http_error' | 'poll_timeout' | 'no_rows') that survives into the response.


`nodes `redash-` (neverError, no retry) → `pii-strip` (ok:(dropped===0)) → `category-brain1``


### HIGH — bi-category-brain's server budget is up to ~185s against a 30s browser abort

Serial worst case: `redash-` HTTP timeout 40000ms, then `pii-strip` polls the Redash job with `const end=now()+120000` at 2500ms intervals, then a final GET /api/query_results/<id>.json with timeout 25000ms. Total ≈185s before `category-brain1` can emit. The frontend gives it 30s on BOTH callers: fetchCategoryBrainFull uses getJSON(..., 30000) (dataLayer.ts:147) and fetchCategoryTopSpecs uses AbortSignal.timeout(30000) (src/lib/enrichment.ts:955). For any mcat whose Redash query 13521 takes more than ~28s the browser aborts, catCorpus stays null and catTopSpecs stays undefined, so LLM 2 plans the Commercial page with zero category evidence (usePlannerController.ts: `categoryEngine: p.catCorpus ?? p.catTopSpecs`) while n8n keeps burning the Redash execution to completion. Either the server must respond inside the client budget (bounded poll + partial result) or the client budget must be raised to match the declared server budget.


`nodes `redash-` (timeout 40000) + `pii-strip` (poll end=now()+120000) → 30s clients at src/lib/rfq/dataLayer.ts:147 and src/lib/enrichment.ts:955`


### HIGH — bi-csl-parser aborts the whole run on a single upstream blip — the browser gets a 500, not an empty skeleton

`csl-data` (POST http://10.142.0.9/GladminActivity/GetCSLData/, timeout 20000) is the only HTTP node on a frontend-called path with NO onError, NO retryOnFail and NO alwaysOutputData. Because `Webhook1` uses responseMode:'responseNode', an exception means `Respond1` never executes and n8n returns 500 — `fetchCsl` catches it and returns null, so Page 0 loses ALL landing truth at once: viewed_products, searched, category_isq, buyer_is_also_seller, categories, cities_resolved. Every other leaf's HTTP nodes carry continueRegularOutput + alwaysOutputData for exactly this reason (bp-fetch, od-fetch, BL profile, rfq-details-api, getisq5). One 20s timeout on an internal IP degrades the entire form to no-history mode with no partial result and no retry.


`node `csl-data` (no onError/retry/alwaysOutputData) + node `Webhook1` responseMode:responseNode`


### HIGH — bi-pns-insights has NO PII strip — the raw PNS payload is returned to the browser and fenced into the LLM prompt

`pns-parse` sets `insights: rows` where rows = `body.data` verbatim, with no field selection and no redaction. The verified row shape is visible in the sibling node `pns-api-parse1` on the transcribe path, which deliberately projects only `{source, file_id, to, extraction}` from each `data[]` element — so the raw rows carry at minimum `to` (a phone number) plus whatever else the endpoint returns. Contrast the category path, which has a dedicated fail-closed `pii-strip` node that deletes buyer_name/buyer_mobile_number/seller_name/seller_mobile_number and DROPS rows it cannot open. The PNS path has no equivalent, and llm.ts:182 fences the whole object as `<pns>` to the imllm gateway — so call-participant phone numbers leave the estate twice (once to the buyer's browser, once to the model). At minimum `pns-parse` should project the same allowlist `pns-api-parse1` already uses.


`node `pns-parse` (`insights: rows`) vs node `pii-strip` on the category path; consumed at src/lib/rfq/llm.ts:182`


### HIGH — bi-pns-insights ships an EXPIRED hardcoded AK token — expiry matches the owner's 2026-07-31 "PNS is a server-side issue" note to the hour

Node `pns-insights-api` POSTs to http://audio.imutils.com/pns-call-insights with bodyParameters USR_ID, AK, MODID, EMP_ID, PAGE_INDEX. AK is the ONLY credential on the call and it is a hardcoded JWT literal (value redacted). Its unsigned claims decode to iss=EMPLOYEE, iat=2026-07-30T08:52:09Z, exp=2026-07-31T08:52:09Z — i.e. a 24-hour token that expired the day before today (2026-08-01). Because the node sets options.response.neverError=true, onError=continueRegularOutput and alwaysOutputData=true, a 401/403 is not an error: `pns-parse` then emits count:0, insights:[] and __health:{ok:true, note:'ok'} (it only sets ok:false when `body.error` happens to exist). The frontend records `ok: d != null` so it logs PNS as a healthy source with zero rows. Two consequences: (a) LLM 1 is awaited behind this call — BrainRFQForm.tsx:1252 does `pnsP.then(... runRequirementBrain)` — so every commit pays up to the node's 30s timeout for nothing; (b) even after rotation the 24h lifetime means it re-breaks daily. Needs an n8n credential/env (`PNS_AK`) plus a real health flag derived from HTTP status, not from a `body.error` key.


`node `pns-insights-api` (bodyParameters.AK) → node `pns-parse`; consumed at src/lib/rfq/dataLayer.ts:97-102`


### HIGH — category-brain `asked_pct` can exceed 100 and reaches LLM 2 unclamped as ranking truth

In `category-brain1` the denominator and numerator count different things: `parsed++` increments once per Redash ROW (one analysed call), but `inc(specs, s.name)` runs inside `for(const p of A(e.products)) for(const s of A(p.specifications))` — once per product per call. One call quoting 3 products that each carry "Grade" yields cnt=3 with parsed=1, so `asked_pct: Math.round(100*cnt/parsed)` = 300. `fetchCategoryTopSpecs` hides this with `Math.min(100, Math.round(pct))` (enrichment.ts:967), but `fetchCategoryBrainFull` returns the object verbatim and usePlannerController PREFERS it (`categoryEngine: p.catCorpus ?? p.catTopSpecs`), so the clamp is bypassed on the live path. llm.ts:162 then instructs LLM 2 that asked_pct is "how often real sellers ask it" and to "Prefer a high asked_pct theme over your own guess" — the planner is ranking commercial questions on a percentage that is not a percentage. `top_values` counts have the same shape problem (raw counts with no per-spec total, so a value seen 2/50 times is indistinguishable from 45/50).


`node `category-brain1`: `parsed++` per row vs `inc(specs,s.name)` per product·spec; asked_pct formula`


### HIGH — mcat_id is accepted, documented as REQUIRED, echoed back — and never forwarded upstream

Both sides of the contract assert it is mandatory: dataLayer.ts:96 says "mcatId is REQUIRED by the endpoint (MCAT_ID)" and pns-parse's own header says "INPUTS (query): glid (→USR_ID), mcat_id (REQUIRED by the endpoint)". But `pns-insights-api`'s body is exactly USR_ID/AK/MODID/EMP_ID/PAGE_INDEX — there is no MCAT_ID parameter and no query parameter carrying it. `pns-parse` only re-emits `mcat_id: q.mcat_id || null`, which makes the response LOOK category-scoped. Result: PNS insights are never filtered to the committed category, so a multi-category buyer's unrelated calls are fenced to LLM 1 and LLM 2 as `<pns>` evidence about the product just committed. This also masks the bug — the echoed mcat_id makes it impossible to tell from the payload that no scoping happened. (Note the other caller is worse: DynamicRFQ.tsx:55 calls fetchPnsInsights(glid, sim.pns) with no mcatId at all.)


`node `pns-insights-api` bodyParameters (no MCAT_ID) vs node `pns-parse` line ~10`


### MEDIUM — CSL is hardcoded to a rolling 30-day window with manual IST arithmetic and no override or reporting

`csl-data` (and `csl-data-raw`) compute starttime = `Date.now() - 30*24*60*60*1000 + 5.5h` and endtime = `Date.now() + 5.5h`, both sliced to YYYYMMDD. The window is not exposed as a query parameter and the emitted `summary.window {from,to,sessions}` reports the observed data range, not the requested range — so "this buyer has no browse history" and "this buyer last browsed 31 days ago" are indistinguishable to the frontend, and there is no way to widen the lookback for a low-activity buyer. The workflow `settings` sets no `timezone`, so the +5.5h literal is the only IST handling in the file and will be wrong if the n8n instance is ever moved or DST-adjacent logic is added.


`nodes `csl-data` and `csl-data-raw` queryParameters starttime/endtime; workflow settings has no timezone`


### MEDIUM — Every secret in the workflow is a hardcoded literal — several in URL query strings — and one node's comment falsely claims otherwise

No node uses n8n credentials or env vars. Distinct secrets present (all values redacted): 5 distinct AK JWTs; static shared-secret `token` literals on getisq5, rfq-details-api, BL profile, bp-fetch, od-fetch, whatsapp-conversations; ONE Redash API key repeated 12 times — in the Authorization header of `redash-`, `redash-pns-`, `redash-vani-` and inline as a `RKEY` constant in the jsCode of `requirement`, `pii-strip`, `category-brain1`, `csl-enrich-mcat1`, `csl-enrich-city1`, `csl-enrich-prod1`, `pns-rows1`, `vani-rows1`; a WhatsApp wrapper `api_key` AND a hardcoded operator MSISDN in `whatsapp-inbound1`'s QUERY STRING; an LLM-gateway `sk-…` bearer in `pns-transcribe1` and `vani-transcribe1`; an audio signed-URL BearerToken in `pns-transcribe1`; a hardcoded EMP_ID in `pns-insights-api`, `pns-insights-api1`, `pns-api-parse1`; and an RC4 key literal in `bp-compute-K`. Credentials in query strings (AK on csl-data/csl-data-raw/rfq-details-api/BL profile/bp-fetch/od-fetch, api_key on whatsapp-inbound1, api_key on every Redash job-poll GET) land in access logs and proxy logs. Worst of all, `pns-parse`'s header comment asserts "SECURITY: AK + EMP_ID come from n8n env (PNS_AK / PNS_EMP_ID), never hard-coded" — which is false for the very node feeding it, so the file documents a control that does not exist. Rotating the Redash key today means editing 12 places.


`workflow-wide; `pns-parse` header comment vs `pns-insights-api` bodyParameters`


### MEDIUM — No caching anywhere, and the frontend fires bi-category-brain twice per commit on a false cache assumption

`redash-` posts `max_age: 0`, which forces a fresh execution of the heavy corpus query 13521 on every single call; no node in the workflow uses workflowStaticData or any other result store. Meanwhile BrainRFQForm.tsx:500-501 fires `fetchCategoryBrainFull(mcatId)` and `fetchCategoryTopSpecs(mcatId)` in parallel against the SAME webhook with the SAME mcat_id, with an inline comment asserting it is "a cache-warm second GET rather than added latency on the critical path". There is no cache to warm — that is two independent full Redash executions (each up to the ~185s budget) per product commit, doubled again on the cxUsedNoCategory re-fire path, plus one more per bi-requirement-brain call via `cat-call`. The only caching in the file is MAXAGE=2592000 (30d) on the small id→name decoder queries inside the CSL branch (csl-enrich-mcat1/city1/prod1) — the pattern exists, it just was not applied to the expensive query. Either give 13521 a non-zero max_age or add a per-mcat in-flight dedup so the two GETs collapse into one execution.


`node `redash-` jsonBody `max_age: 0`; callers src/components/BrainRFQForm.tsx:500-501`


### MEDIUM — PNS is awaited inline before LLM 1 fires, with a 120s timeout and the safeguard explicitly reverted

`pnsP.then(pns => runRequirementBrain(...))` — the brain cannot start until bi-pns-insights resolves. fetchPnsInsights defaults to t=120000 and the caller passes no override. The comment states the 3s race-cap safeguard 'was reverted at the owner's request' and that 'the PNS empty/err is a server-side n8n issue'. So a slow or hanging PNS holds Page 1's enhancement for up to two minutes with only a spinner; in pns='full' mode this is the design.


`src/components/BrainRFQForm.tsx:1249-1258; src/lib/rfq/dataLayer.ts:95-102`


### MEDIUM — Two more frontend-called webhooks carry AK tokens whose claims are months past expiry

Same pattern as the PNS token, different nodes (values redacted; claims read from the unsigned payload): `rfq-details-api` (webhook bi-rfq-details) carries an iss=EMPLOYEE JWT with exp=2026-05-20T11:08:06Z — 73 days stale; `whatsapp-conversations` (webhook bi-whatsapp) carries an iss=USER JWT with exp=2026-05-22T10:51:11Z. Both endpoints ALSO receive a static shared-secret `token` value, so they may currently be ignoring AK entirely — which is itself the problem: the workflow is shipping dead credentials that nothing validates, and both nodes set continueRegularOutput/neverError so an auth rejection would surface as an empty requirements[] rather than an error. A third stale copy (exp=2026-07-27) sits in `pns-api-parse1`'s pagination loop. The one long-lived token (iss=CRON, aud = an internal /22 CIDR, exp 2031-05-20) is shared by csl-data, csl-data-raw, BL profile, bp-fetch and od-fetch — a 5-year secret in plaintext across 5 nodes.


`nodes `rfq-details-api`, `whatsapp-conversations`, `pns-api-parse1`; long-lived token in `csl-data`, `csl-data-raw`, `BL profile`, `bp-fetch`, `od-fetch``


### MEDIUM — bi-category-brain truncates five sections and emits none of the pre-truncation totals

`category-brain1` caps with `topN`: top_specs = top 15 specs, top_values = top 5 per spec, personas = top 6, keywords = top 10, top_products = top 8. None of the underlying cardinalities (Object.keys(specs).length, per-spec value counts, persona/keyword/product totals) are emitted, so no consumer can say "15 of 62 specs shown" or decide whether to ask for more. The frontend has papered over this by hard-coding the number into the LLM 2 prompt — llm.ts:162 tells the model "Note top_specs is a truncated top-15 and may omit a theme" — which will silently become a lie the moment the server cap changes. Emitting `specs_total`, `values_total_per_spec`, `personas_total`, `keywords_total`, `products_total` alongside the truncated arrays would let the prompt state the real number and let the debug panel show coverage.


`node `category-brain1`: topN(specs,15) / topN(specVals,5) / topN(personas,6) / topN(keywords,10) / topN(products,8)`


### MEDIUM — bi-category-brain's PII-strip bookkeeping is consumed by nothing — except the LLM 2 prompt, which pays tokens for it

The node emits `source`, `mcat_id`, `calls_analyzed`, `rows_received`, `rows_unparsed` and a `pii_strip{rows_in, rows_emitted, pii_values_stripped, pii_strip_failed, fail_mode, status}` block. Nothing in the frontend reads any of them: grep across src/lib/rfq/*.ts and BrainRFQForm.tsx finds `personas|keywords|b2b_b2c|top_products|calls_analyzed|rows_received|rows_unparsed|pii_strip` only inside comments. Yet `fetchCategoryBrainFull` returns the object verbatim (by design) and llm.ts:182 fences the whole thing as `<category_engine>`, so internal PII accounting and node provenance are serialized into every Commercial-planner prompt as meaningless numbers the model is told to cite line numbers against. The coverage counters are genuinely valuable — they say how much real call evidence the top_specs rest on — but they belong in the AI-Debug health panel (which currently gets nothing) rather than in the prompt. Either split the response into `corpus{}` + `__health{}` so the client can fence only the corpus, or surface the counters in the inspector.


`node `category-brain1` return object; src/lib/rfq/dataLayer.ts:144-151 → src/lib/rfq/llm.ts:182`


### MEDIUM — bi-pns-insights fetches page 1 only, while the sibling node on the unused path paginates

`pns-insights-api` hardcodes PAGE_INDEX:"1" and there is no pagination loop on the path. The transcribe path's `pns-api-parse1` shows the intended behaviour: `for(let pg=2; pg<=3 && n>=10; pg++)` re-POSTs for pages 2 and 3 while a full page came back. So the page size is ~10 and the path the RFQ actually uses silently truncates any buyer with more than ~10 call insights — and emits no has_more / total flag, so `count: 10` is indistinguishable from "exactly 10 calls exist". The pagination logic already exists 30 lines away and just needs porting.


`node `pns-insights-api` (PAGE_INDEX "1") vs node `pns-api-parse1` pagination loop`


### MEDIUM — bi-requirement-brain fetches category evidence for the PRIMARY mcat only, then looks it up per-requirement

`cat-call`'s URL is `…/webhook/bi-category-brain?mcat_id={{ $json._primary_mcat }}` — a single mcat, taken from `resolve`. `requirement-brain` then builds `category_brains: cat ? [cat] : []` (line 534) but queries it per requirement with `(bundle.category_brains||[]).find(c => String(c.mcat_id)===String(r&&r.mcat))` (line 444) and `…find(c => String(c.mcat_id)===pm)` (line 206). For every requirement whose mcat is not the primary, `find` returns undefined and the recommendation is emitted with `category: null` — so the multi-mcat structure the code is written against can never be populated. Either fan `cat-call` out over the distinct requirement mcats, or drop the per-requirement lookup and state plainly that only the primary carries category context.


`node `cat-call` URL (single _primary_mcat) vs node `requirement-brain` L444/L534`


### MEDIUM — bi-rfq-details silently caps at the latest 20 BuyLeads with no signal to the caller

`rfq-details-api` sends queryParameter `latest_lead: 20`. The `requirement` node then reports `requirement_count: requirements.length` and a __health block covering buyleads/isq_results/mcat_resolved — but nothing states that a cap was applied or how many leads exist beyond it. `fetchRfq` therefore treats a truncated history as a complete one, and a heavy repeat buyer looks identical to one with exactly 20 requirements. (The per-offer ISQ cap was already removed — the `getisq_loop_call` comment says "v10.2: removed the slice(0,15) cap" and _specs_status still carries a now-unreachable 'beyond_fetch_cap' branch — so this is the last remaining silent cap on the path.)


`node `rfq-details-api` queryParameters `latest_lead: 20`; node `requirement` health block`


### MEDIUM — bi-whatsapp has no merge barrier, so under executionOrder v1 one of its two sources can be silently dropped

`t0` fans out to `whatsapp-inbound1` AND `whatsapp-conversations`, and BOTH connect to `whatsapp1` input 0 with no Merge node between them — unlike every other fan-out in this workflow, which barriers correctly (merge3 3-input for bpod, merge/merge4 4-input for the brains, csl-enrich-barrier1 3-input for CSL). `whatsapp1` reads its siblings by name at lines 252-253 (`$('whatsapp-conversations')`, `$('whatsapp-inbound1')`) inside try/catch blocks that swallow every failure. With settings.executionOrder='v1' (depth-first), the first invocation of whatsapp1 runs before the second branch has executed, so its cross-branch read returns nothing; whatsapp1 then executes a second time. With responseMode:'lastNode' the served payload depends on which run n8n reports last, so bi-whatsapp can legitimately return a timeline built from only the inbound leg (conversations:{} → no USER turns → counts.buyer_turns 0 → responsive:false). The established fix for this exact family is a Merge node with one input PORT per feeder.


`connections t0 → `whatsapp-inbound1` / `whatsapp-conversations` → both into `whatsapp1` [in0]; whatsapp1 jsCode L252-253`


### MEDIUM — bi-whatsapp's HTTP nodes set no timeout at all

`whatsapp-inbound1` (GET https://wahelp.indiamart.com/whatsapp/wrapper_api_prod.php) has options `{redirect:{}}` — no response block, no timeout. `whatsapp-conversations` (POST http://10.130.0.54/wservce/users/whatsappConversation/) likewise has no timeout. Both fall back to the n8n default, so a slow wahelp keeps the execution alive long after `fetchWhatsapp` has aborted at 60s (dataLayer.ts:89). Every other leaf pins an explicit timeout (csl-data 20s, rfq-details-api 20s, bp-fetch/od-fetch 30s, redash- 40s, pns-insights-api 30s), so this is an omission rather than a policy. `whatsapp-conversations` also lacks neverError, so a non-2xx there aborts the branch entirely.


`nodes `whatsapp-inbound1` and `whatsapp-conversations` (options has no timeout)`


### MEDIUM — requirement-brain reads a node that does not exist, so call evidence is structurally unreachable there

Line 511: `let calls={}; try{ calls=(g('calls-call').summary)||{}; }catch(e){}` with the comment "absent by default (fast) → {}". There is no node named calls-call, calls-call1, calls-call2 or calls-call3 anywhere in the 76-node workflow (grep for 'calls' in node names returns nothing), so the helper's four-suffix probe always falls through and `bundle.calls` is permanently {}. bi-requirement-brain therefore never has call data even though the full transcription suite (redash 12475/12322 + gemini-3.5-flash-lite) lives in the same file behind bi-transcribe. The dangling read is disguised as a feature flag — nothing can turn it on.


`node `requirement-brain` L511 (`g('calls-call')`); no such node in the export`


### MEDIUM — retryOnFail is set on the low-value leaves and absent on every critical one

Retries exist only where they matter least: getisq5 (3 tries/2s), rfq-details-api (3/2s), BL profile (3/2s), bp-fetch (2/2s), od-fetch (2/2s). NOT set on `csl-data` (bi-csl-parser's only source), `pns-insights-api` (bi-pns-insights' only source), `redash-` (bi-category-brain's only source), `whatsapp-inbound1` / `whatsapp-conversations` (both of bi-whatsapp's sources), `getisq-from-mcat1`, `redash-pns-`, `redash-vani-`, `pns-insights-api1`, or any of the internal fan-out calls (csl-call, csl-call1, rfq-call, rfq-call1, bp-call, bp-call1, wa-call, wa-call1, cat-call). So the three single-source webhooks the Dynamic RFQ depends on most have exactly zero fault tolerance, while the multi-source bpod path has retries on all three legs.


`nodes `csl-data`, `pns-insights-api`, `redash-`, `whatsapp-inbound1`, `whatsapp-conversations` (all retryOnFail unset)`


### LOW — Category top_specs is truncated server-side to 15 with the fix declared out of scope

The debug panel warns: '⚠ N specs = the n8n topN(specs,15) cap. Themes ranked 16+ never left the workflow … Raising the cap is a server-side change.' dataLayer repeats it: 'NOTE the n8n node still caps top_specs at the top 15 and top_values at 5 per spec'. The commercial planner's own prompt has to compensate in prose ('its ABSENCE is not evidence against a theme'), i.e. LLM 2 is knowingly planning on a truncated corpus.


`src/components/BrainDebugPanel.tsx:436-437; src/lib/rfq/dataLayer.ts:137-143; src/lib/rfq/llm.ts:162`


### LOW — No error workflow, no execution timeout, no alerting — nothing pages when the daily-expiring token dies

Workflow settings are exactly `{"executionOrder":"v1","binaryMode":"separate"}`: no `errorWorkflow`, no `executionTimeout`, no saveDataErrorExecution tuning. Combined with the neverError/continueRegularOutput/alwaysOutputData pattern applied almost everywhere, failures never become n8n execution errors in the first place — they become 200 responses with empty arrays. So the PNS token expiring on a 24-hour cycle, a Redash key rotation, or wahelp going down all present as "the buyer had no history" with no server-side signal at all. This is why the PNS breakage had to be diagnosed from the frontend.


`workflow `settings`; combined with neverError/continueRegularOutput across all HTTP nodes`


### LOW — No input validation on any webhook — missing params become the literal string "undefined" upstream

There is not one IF, Switch or Set node in the workflow (node types present: webhook, httpRequest, code, merge, respondToWebhook). Consequences: `redash-` interpolates `String($('t4').first().json.query.mcat_id)`, which sends the six-character string "undefined" as the mcat_id parameter when the caller omits it — Redash runs that as a legitimate parameter, returns 0 rows, and the result is indistinguishable from a genuinely empty category (compounding the silent-zero above). `pns-insights-api` posts an empty USR_ID when glid is absent. `redash-vani-` does `Number($('t2')...glid)` → NaN. Every webhook should reject a missing/non-numeric glid or mcat_id with an explicit `{error:'missing_param'}` body rather than performing a real upstream call with garbage.


`node `redash-` jsonBody (`String(...mcat_id)`), node `pns-insights-api` (USR_ID), node `redash-vani-` (`Number(...)`)`


### LOW — category-brain1 carries a dead second copy of the Redash key and an unused job-polling helper

Lines 1-9 of `category-brain1` re-declare `REDASH` and `RKEY` and define a complete `rowsFromTrigger` job-poll function — verbatim duplicated from `pii-strip` — but the node never calls it: its rows come from `const rows=__pii.rows||[]` where `__pii = $('pii-strip').first().json`. So it is a live credential literal with no purpose, and the dead poller sitting next to real code invites a future edit that double-polls Redash (doubling the ~185s budget). Deleting lines 1-9 is behaviour-neutral and removes one of the 12 copies of the Redash key.


`node `category-brain1` L1-L9 (unused REDASH/RKEY + rowsFromTrigger)`


### LOW — pinData is committed on the bi-csl-parser webhook, so manual n8n testing does not exercise the real GLID

The export carries `pinData` keyed on `Webhook1` (path bi-csl-parser). Production/active executions ignore pinned data, so this is not a runtime bug — but any manual execution used to debug the CSL parser replays the pinned query instead of the GLID under investigation, which makes "it works when I run it in n8n" a non-result for this specific leaf. Worth clearing before the next CSL debugging pass, since bi-csl-parser is also the one leaf with no fault tolerance (see the csl-data finding).


`workflow `pinData` → node `Webhook1` (path bi-csl-parser)`


### LOW — pns-parse's row extraction has a wrong fallback key, can emit a non-array, and never unwraps extracted_data

`const rows = Array.isArray(body) ? body : (body.data || body.metadata || body.rows || body.result || [])`. The verified shape of this endpoint — from the sibling `pns-api-parse1`, which does `const data=(r&&(r.data||r.Data))||[]` — is `{data:[{file_id,to,extracted_data}]}`; `metadata` is not a rows container on this API and `Data` (capital D) is a real variant that pns-parse does NOT handle. If `body.metadata` is ever a non-empty object, `insights` becomes an object while `count` (guarded by Array.isArray) reports 0 — a self-contradicting payload. It also never projects `extracted_data`, so LLM 1 receives the transport envelope (file ids, routing fields) instead of the extraction, and the extraction sits one level deeper than the prompt describes.


`node `pns-parse` line ~6 vs node `pns-api-parse1` `eat()``


---

## How this was produced

Four adversarial lenses over the code: (1) deferred/TODO/dead-or-inert code, (2) server-side n8n gaps read from the workflow export with every credential redacted, (3) an adversarial risk review of the three uncommitted change-sets, (4) a completeness critic asked what no other agent had covered. Full per-agent transcripts: `~/.claude/projects/-Users-tarbrinder/20438ea4-571a-40af-9bc8-fb0980856333/subagents/workflows/wf_9ca05f8e-3c6/`.
