# RFQ Forms — FINAL Build & Test Plan (re-scoped to owner decisions)

> **Status:** FINAL DRAFT for owner sign-off · 2026-07-22
> **Companion:** the full 109-issue register + 234 test cases live in [RFQ-STRESS-TEST-PLAN.md](RFQ-STRESS-TEST-PLAN.md). This file is the *actionable, re-scoped* plan reflecting your decisions.
> **Fix bar (owner):** FIX ALL in-scope issues (every severity) — not just P0/P1.
> **In scope:** SimpleRFQForm **Simple**-popup + **Simple**-standalone, and **StandardRFQForm** (all 3 shells). **Category mode is parked** (owner: "focus on simple forms").

---

## ⚑ v2 — OWNER RULINGS APPLIED (2026-07-22, review round 2)

**Directive:** *"keep all other issues to be fixed in one go; those I commented need the changes I said; the rest fix as-is — I agree with those observations, don't drop them."* So: every in-scope issue is fixed; commented ones use the owner's specified approach below.

### v2.1 — Per-issue rulings (owner comments)
| Issue | Ruling | Build approach |
|---|---|---|
| P1-114 Standard hardcoded identity / no OTP · P1-115 logged-in demo PII | **Keep dummy; build for TWO scenarios.** Logged-in → fetch from **Buyer Profile**; not-logged-in → prompt **login**. Real fetch/login = dev. | Structure the contact/identity UI for both states + prominent `DEV-TODO` comments where the real profile-fetch / login hooks in. Don't hardcode-submit silently. |
| P1-117 OTP dead-locks if localStorage throws | **Keep OTP simulated;** just don't let it hang. | `try/finally` around localStorage so `verifying` always clears; `DEV-TODO`: "real login flow replaces this." |
| P1-118 mobile no Indian-format rule | **DEFER** (dev team handles validation). | — |
| P1-120 image upload no size/type cap | **≤5 MB is OK.** | Reject >5 MB with a friendly toast; keep it simple. (HEIC/downscale still open — §v2.4 Q5.) |
| P1-121 results dispatches nothing but says "sent" | **Keep UI as-is.** | Leave Send/Call/WhatsApp + "Enquiry sent" exactly as shown; `DEV-TODO` comments on each for real dispatch wiring. |
| P1-122 fabricated sellers/badges | **Ignore (demo).** | Keep; `DEV-TODO`: "demo sellers — replace with real match API." |
| P1-123 consent/DND | **Ignore.** | Deferred. |
| P1-130 OTP paste drops digits / a11y | **UI fixes welcome** (logic stays simulated). | Paste-distributes across boxes, `autoComplete="one-time-code"`, `aria-label`s, `role="alert"` on error. |
| P2-210 redundant specs can blank the spec page | **Owner: if all redundant, just SKIP the page** ("why ask what's already asked"). | When `visibleSpecs` is empty because everything is redundant → **auto-advance past `specs`** (don't render a blank page). |

### v2.2 — Global rulings (apply everywhere in scope)
- **LLM timeout = 10s for ALL calls** (getSpecHints, getMissingSpecs, analyzeImage, voiceToSpecs) — no call waits >10s.
- **Failed/empty mic/photo extraction UX:** show a **Retry with a 3-second loader**; if the buyer doesn't respond → **auto-skip** (proceed without it).
- **photoSpecsRef = MCAT-SCOPED + ADDITIVE (resolves P0-01):** same mcat on re-commit → keep/merge facts (additive); **entirely different mcat → DROP the image + its facts.** (Owner's reasoning: the buyer changed the *name* because they're unhappy with the product identity; specs from the old image are then wrong → drop when identity truly changes, keep when it's the same category.)
- **BL dummy block:** keep the stub, and **add comments listing the real payload** it must send (image, specs, qty, contact, mcat, etc.) so the dev wires it.
- **DEV-TODO comment pass — everywhere there's a placeholder:** login, OTP (`1234`), send-enquiry, dummy CTAs, demo sellers, `fetchProductImages` sample IDs (`s_glusrid=32454240`/`pageCityId=70422` → "use real buyer data"), the **`VITE_API_BASE` corrupts absolute 3rd-party geo URLs** gotcha (comment so a dev/codex auto-handles), analytics **sink** choice, **session/user id** scheme, **PII policy**. Goal: a dev plugs real data/APIs guided by the comments.
- **Exit affordance everywhere:** **disable click-outside-to-close consistently** across the main popup + all sub-popovers, AND guarantee **every stage of every Simple-form surface has an exit** (back / Exit / cross). Full exit-coverage sweep.
- **Auto-focus** the product input on open (owner: go ahead).
- **StandardRFQForm popup shell:** apply the **body-scroll-lock** fix too (it inherits the P0 background-scroll bug even though only the standalone shell ships today).
- **Dark theme:** add it, **auto-switching by IST time-of-day** (night IST → dark).
- **Re-plan question handling:** on a corpus/evidence re-plan, **keep the buyer's answered questions** and **remove duplicates from the new question set** (dedupe new vs answered).
- **Mobile "no popups":** owner rule — **no popup/drawer designs on mobile.** → convert the mobile location-picker + score sheets from bottom-sheets to **inline page sections** (see §v2.4 Q1 for confirmation).

### v2.3 — Appendix answers folded in (resolved)
- **Specs never empty** except a full API failure (then AI-specs still run; qty+buyer-specs absent = the fail case) → **NAV-08 downgraded** (unit-less auto-advance is a ~10% real case, non-blocking).
- **Live ISQ data check (20 B2B keywords, done):** 0/87 spec names contain `unit/qty/quantity`; 0 options contain a comma → **SPEC-13 & SPEC-14 downgraded to P3 / won't-fix-unless-observed.** 18/20 categories carry a unit row.
- **Category corpus latency** (~3 min Redash) → owner warming + API ticket → **deferred** (category out of demo).
- **OTP close** returns to editing ('more') → **keep as-is.**
- **flash-lite** for image/voice → **OK for now.**
- **OTP** stays **fully simulated** (`1234`, no real SMS provider) → no send/verify failure matrix now.
- **n8n v51** (category corpus) is **LIVE** — but category still parked for the demo.
- **getSpecHints timing:** run hints **after the authoritative getISQs** returns (so late-arriving buyer specs get hinted/deduped) — owner-preferred.
- **StandardRFQForm duplicate spec names:** **consume as-is** (don't dedupe client-side — upstream catalog owns uniqueness; fixing here risks errors). → drop that fix.
- **click-outside disabled intentionally** → keep, and align sub-popovers to match.

### v2.4 — STILL OPEN (need owner answer on lunch return)
1. **Mobile "no popup" → confirm approach.** You asked whether a top-drawer is acceptable. **My recommendation: neither top nor bottom drawer — render the location-picker + score inline as normal page sections on mobile** (fits "no popup on mobile," and removes the keyboard-occlusion entirely). OK?
2. **Orphaned AI answers (explain, as asked).** When a re-plan *removes* an AI question the buyer already answered, that answer today still travels into the seller enquiry even though it's no longer on screen. Beyond "dedupe duplicates" (already ruled), do you want me to **prune answers whose question is no longer shown** on submit? *(Recommended: yes — never ship an answer the buyer can't see.)*
3. **Analytics — may events log the raw search query + product name (explain, as asked)?** e.g. `product_committed { productName, query }`. This is high-value demand data and normally **not** PII. OK to log them? *(Recommended: yes.)*
4. **"Self-build+poll vs read-only" (explain, as asked).** V3/V4 actively **build** the category corpus and **poll** until it's ready; SimpleRFQForm currently assumes the server **pre-warmed** it and just **reads once**. For category (parked), should Simple also self-build+poll, or keep read-only + rely on pre-warm? *(Category-scoped — parkable with the rest of category.)*
5. **HEIC / live iPhone camera.** The 5 MB cap is set. Beyond size: will you **demo live camera upload from an iPhone** (HEIC format may not decode)? If **no** → cap is enough; if **yes** → I add a format guard/downscale.

---

## ⚑ v4 — APPENDIX (§12) FULL RECONCILIATION (2026-07-22)

All 60 auditor open-questions reconciled against owner rulings. **56 ANSWERED, 4 OPEN (+1 confirm).** Verdicts below; OPEN items restated in §v3.3.

**ANSWERED (with ruling):**
- GetIsq zero-unit-rows (NAV-08) → specs never empty unless full API fail (then AI-specs continue); live check: 18/20 categories carry units.
- Corpus-after-planner (NAV-10) → category parked; owner warming + API ticket.
- Downstream WA/enquiry product-name validation (NAV-05) → backend, ignore now.
- OTP onClose → keep form on 'more' (don't abandon).
- photoSpecsRef scope → **mcat-scoped + additive; different mcat → drop image + facts.**
- Evidence facts tagged by mcatId → yes.
- Typed-name + different-product photo → additive if same mcat, drop image if entirely different.
- Multimodal json_object / parse-guard → no parsing work now.
- Failed/empty extraction UX → **retry + 3s loader → auto-skip if no response.**
- OTP real-SMS failure matrix → keep simulated (1234).
- VITE_API_BASE geo-corruption → DEV-TODO comment.
- getSpecHints timing → **run after authoritative getISQs.**
- fetchProductImages sample IDs / CORS → DEV-TODO (real buyer data).
- flash-lite for image/voice → OK now.
- click-outside disabled → disable consistently + ensure an exit on every stage/surface.
- mobile auto-focus product input → yes.
- Dark theme → **in scope, auto by IST, per design PDF.**
- Category corpus chip → remove buyer-facing; loader shows warm/cold (category parked).
- v10x/v51 category corpus → v51 LIVE.
- Corpus re-plan answers → keep answered, dedupe new, **preserve by concept.**
- ISQ unit/qty substring + comma options → **live check: 0/87 names, 0 comma → SPEC-13/14 down to P3.**
- getISQs↔AI collision frequency → structurally fixed (score over visible arrays + prune orphans); frequency moot.
- Orphaned aiSpecValues → **prune orphans on submit (enquiry IS sent), preserve by concept.**
- Standard duplicate spec names → consume as-is, don't fix (upstream owns uniqueness).
- Analytics sink → DEV-TODO; emit layer built, sink is dev-config.
- PII in events → ignore/omit raw PII (my call), DEV-TODO for allowed-fields.
- Log raw query/productName → yes (my call — demand data, not PII).
- Session/user id → anon per-session id + DEV-TODO for GLID.
- Standalone vs popup events → one taxonomy, `surface` as a label/property.
- Delete V3/V4 tracking → Simple+Standard are the only funnels; leave V3/V4 untouched.
- Standard same taxonomy → yes.
- SimpleRFQForm embeddable/onSubmit → live; add onSubmit-style hook + DEV comment.
- LLM keys behind proxy → env vars + DEV-TODO comment.
- aispecs Next mobile vs desktop → **sync (hold + "Skip for now").**
- OTP name/mobile in enquiry → not required (server-side identity).
- Light-only theming → dark IS in scope (see Dark theme).
- Standalone routes auth → demo OTP; greet by name only after auth.
- JSON.parse non-object → **harden `parsed && typeof==='object'`.**
- Standard submit guard/OTP double-tap → add OTP + idempotency guard + DEV comment.
- OTPGate.handleResend timer race → I'll just fix (clear prior interval; trivial, no decision needed).
- BuyerProfileStandalone garbage GLID → out of scope; ErrorBoundary covers white-screen risk.
- Server-side validation downstream → ignore now (live APIs later).
- Transmit contactEmail / OTP identity → not required.
- SimpleRFQForm live vs demo → live (BL API, owner provides).
- Consent string TRAI/DPDP → not needed.
- LLM gateway first-party → internal only; no external-consent.
- Seller-match API / DEMO_SELLERS → **use IMSearchAPI product-search top-3 as the last-page cards;** real match API later (DEV comment).
- Standalone standard OTP gate → yes, add OTP.
- Bad sid behavior → not-found/redirect; real brand-product API later.
- SPA native-shell Back interception → DEV-TODO comment.
- RACE-01/02 sent to real sellers → yes → prune orphans (fix stays in).
- aiEpoch re-plan preserve by concept → yes, keep specs.
- Category mode in demo → no, parked.

**OPEN (4 + 1 confirm):** see §v3.3 — (1) iPhone/HEIC live camera, (2) 200%/large-text clip, (3) Standard popup shell delete-vs-keep, (4) category self-build+poll; (+confirm) mobile inline (no drawer).

---

## ⚑ v3 — OWNER RULINGS ROUND 3 + INLINE REAUDIT (2026-07-22)

*(The multi-agent plan-audit hit the session limit — resets 3:20pm IST. The reaudit below is my inline self-review; re-run the workflow after reset for the independent pass.)*

### v3.1 — New rulings resolved (fold into build)
- **Re-plan preserves prior answers BY CONCEPT** (match new question by fieldName/option) instead of discarding → fixes RACE-01/06/07 together. **The enquiry IS really sent**, so **prune truly-orphaned answers** (no matching new question) at submit. *(Resolves the old "orphaned aiSpecValues" open Q.)*
- **StandardRFQForm gets an OTP gate** before submit (same simulated demo OTP) + in-flight/idempotency guard; `DEV-TODO` for the real host handler.
- **Bad `?rfq=standard&sid=<invalid>` → not-found/redirect** (not a silent MainApp fall-through). The standard product will use a **real brand-product API** (the sid URL was illustrative) → `DEV-TODO`.
- **Results seller cards** (Simple results + Standard sent screen) → populate from the **IMSearchAPI product-search results** (real company / city / price / image, top-3) instead of hardcoded `DEMO_SELLERS`; `DEV-TODO`: real seller-match API later; verification badges = demo/`DEV-TODO`.
- **aispecs "Next" mobile in SYNC with desktop** — hold while loading + "Skip for now" (no silent skip).
- **gemini.ts JSON.parse hardening** — guard `parsed && typeof parsed === 'object'` at :1600 / :1681 (null/true/123 bodies).
- **LLM = internal/first-party** (no external-consent). **Contact email + OTP name/mobile NOT required** in the enquiry now (identity attached server-side) → EMAIL-02 = not a bug.
- **Standalone routes** use the same **simulated demo OTP** for auth; the header greets by name **only once authenticated** (kills "Hi Tarbrinder" for a logged-out visitor).
- **Dark theme IS in scope** (per the design-guideline PDF), **auto-switching by IST time-of-day**. *(Will pull the exact dark tokens from the PDF at build.)*
- **Analytics — my call (you said "decide yourself"):** ONE event taxonomy with **`surface` as a label/property** (not separate streams); **Simple + Standard are the only funnels** (leave V3/V4 tracking untouched); **log productName + query** (demand data, not PII); **do NOT put raw mobile/email/GST in events** (hash/omit) — `DEV-TODO` for the allowed-fields list; generate a proper **per-session anon id** + `DEV-TODO` for GLID attach; **sink left as dev-config** (emit layer + comment: GA4/GTM vs n8n vs /events).
- **DEV-TODO comment sweep — everywhere a real API/data plugs in:** login flow, contact/identity fetch (Buyer Profile), OTP send/verify, BL generation payload, brand-product API, seller-match API, `fetchProductImages` sample IDs, `VITE_API_BASE`-vs-3rd-party-geo gotcha, LLM key → server-proxy/env, analytics sink + session id, native-shell Back interception.

### v3.2 — Inline reaudit: fix-interaction bundles that MUST land together
1. **Skip-specs-if-redundant + score source** — skipping the specs page requires the score to treat redundant specs as satisfied (count over `visibleSpecs`, not raw `isqSpecs`); otherwise the score sticks <100 with no field to fill. **Bundle P2-210-skip with the score-desync fix.**
2. **10s-timeout / retry-3s / auto-skip are DIFFERENT surfaces** — retry-with-3s-loader = mic/photo **extraction** failure; auto-skip-to-`more` = aispecs **page** failure. Same 10s trigger, distinct handlers — don't double-fire.
3. **mcat-scoped drop vs same-mcat preserve** — product-IDENTITY change (different mcat) → DROP image + photo facts + stale `aiSpecValues`; same-mcat re-plan (aiEpoch) → PRESERVE answers by concept. Different triggers, consistent; the drop path must fully clear `photoSpecsRef` + `pendingAiSpecs`.
4. **Disable-click-outside + exit-everywhere** — must land together (removing scrim-dismiss without an explicit exit on every stage = a trap; includes the 640–767px standalone gap P1-102).
5. **getSpecHints-after-getISQs + skip-if-redundant sequencing** — show specs first; decide redundancy only after hints resolve post-getISQs; never yank a buyer who already advanced.
6. **Dark theme = highest regression surface** (every screen + score rail + OTP + toasts + chips) → build **LAST**, verify both themes.

### v3.3 — STILL OPEN (only these remain — please answer on return)
1. **HEIC / iPhone camera (simple version):** iPhones save photos in the **HEIC** format, which browsers/our image-AI often can't read. If you'll **hold up a phone and take/upload a photo live on stage**, that photo may fail. → **Will the live demo use an iPhone camera photo?** If no, the 5 MB cap is all we need; if yes, I add an iPhone-format converter. *(One word: yes/no.)*
2. **Very-large text-scaling clip (detail):** if a viewer cranks their **browser/OS font size way up** (accessibility zoom to ~200%), a full-height locked screen (`100dvh`) can push the bottom bar (footer/score rail) off-screen because content grows taller than the fixed height. → **Do we need to support 200% zoom** (a real WCAG item, but unlikely to bite on a normal demo display)? *(My rec: quick check, low priority.)*
3. **StandardRFQForm popup shell (detail):** the Standard form can render 3 ways — mobile, full-page (standalone), and a **popup-modal**. Today it's **always** opened full-page; nothing ever opens the popup version. → **Will you ever embed the Standard form as a popup inside another page?** If **no** → I delete the unused popup code (less surface, fewer bugs). If **yes** → I keep it and fix its scroll/a11y. *(yes/no.)*
4. **Category "self-build+poll vs read-only" (detail, category is parked):** category intelligence takes ~3 min to build. V3/V4 forms actively trigger that build and poll until ready; the Simple form currently just **reads once** (assuming it was pre-warmed). Only matters when you switch category on. → **When category returns: should Simple build+poll itself, or rely on pre-warming?** *(Parkable with category.)*

*(Mobile "no popup" — I'm treating this as resolved: location-picker + score render **inline on mobile**, no drawer. Say the word if you disagree.)*

---

## A. Decisions locked (my reading — correct me if wrong)

| # | Decision | Locked answer | Effect on plan |
|---|---|---|---|
| 1 | SimpleRFQForm live or shell? | **LIVE lead-capture.** A BuyLead (BL) API exists; you'll provide it. | Wire real submit; add BL-eligibility gate + toaster (§C). |
| 2 | Server re-validates mobile/email/GST/qty? | **Ignore validations for now** (revisit later). | All input-validation issues → **DEFERRED**. |
| 3 | Popup StandardRFQForm shipping? | **LIVE** — same toaster + BL API later. | Standard fully in scope. |
| 4 | Category mode in demo? | **No, not yet.** | Category-corpus issues → **DEFERRED**. |
| 5 | iPhone/HEIC camera live? | **You asked what I meant** — see §B, need your call. | Image guardrails → **DEFERRED pending your answer**. |
| 6 | Consent/DND/privacy? | **Ignore.** | Consent/legal issues → **DEFERRED**. |
| 7 | Fix bar? | **Fix all** (in scope). | Every in-scope severity is on the build list. |

---

## B. Two clarifications back to you

- **Item 4 — "Requesting exactly this" chip:** you're right, it's redundant once the exact URL rides along as a visible custom spec. **My recommendation: remove the chip.** The URL-as-custom-spec is the unambiguous "this exact product" signal. (Included as a change in §D unless you say keep it.)
- **Item 5 — HEIC (what I meant):** iPhones save photos as **HEIC**, not JPEG. If a buyer uses the **live camera/upload on an iPhone** during the demo, the file may be large or not decode in the LLM image call → the "Reading your photo…" step could fail silently. My question was only: *will you demo photo-upload from a real iPhone on stage?* If **no** → I defer HEIC/size handling. If **yes** → I add a client downscale + format guard (small task). **Default: defer** until you confirm.

---

## C. BL (BuyLead) generation contract — the core "live" behavior

**Eligibility rule (exactly your spec):**
```
blEligible = quantity.trim() !== ''            // qty defined → 1 condition met
          || allSpecEntries.length > 0         // else ≥1 page-1/page-2 spec filled
```
- `allSpecEntries` (SimpleRFQForm.tsx:515) already merges only `specValues` (page 1) + `aiSpecValues` (page 2) → **last-page fields are correctly excluded** ("last page specs are not specs"). No new plumbing needed.
- **Standard products:** the 6 catalog specs are default-ticked → `allSpecEntries.length ≥ 6` → **always eligible** (qty optional). ✔ matches "those will anyway get generated."

**Behavior to build:**
1. **Toaster on first eligibility** — the moment `blEligible` flips `false→true` (qty entered OR first spec filled), show a one-time success toast ("Great — your requirement is ready, you'll get verified quotes"). Guarded so it fires once per session.
2. **Submit → BL API** — on "Get Quotes" (after OTP when logged-out; direct when logged-in), call `generateBuyLead(requirement)`. **Stub now** (a clearly-marked async placeholder returning ok), **you wire the real API in backend later**. Expose it via a clean `onSubmit`/service hook so integration is a one-liner.
3. **Honest "sent" copy** — the results screen shows "Enquiry sent" **only after** the BL call resolves (today it lies — flips to results with no dispatch). Fixes P0-03-adjacent + RI-01/02.
4. **Submit gate** — disable "Get Quotes" until `blEligible` (with a soft hint "Add a quantity or pick at least one spec"). This ALSO closes P1-101 (score-jump lets you submit an empty RFQ with no product).
5. **Results sellers** — `DEMO_SELLERS` stay as visual placeholder until the BL API returns real matches; swap to the API response when you provide it (flagged, not removed).

---

## D. Standard/MSite UI changes you asked for (Phase 1 — quick, high-visibility)

1. **Qty + Unit BEFORE specifications** (Standard) — reorder `productStep`: header → **Qty+Unit** → Product specifications (6 toggles) → custom specs → description. `StandardRFQForm.tsx` productStep.
2. **URL shown as-is in a custom spec** (Standard) — replace the "Product page (custom spec) · Always included" locked chip with a real custom-spec row showing the **actual URL text** (e.g. `Product page: https://brands.indiamart.com/?sid=456523`), still always-carried. Description stays editable (unchanged).
3. **Remove "Requesting exactly this ↗" chip** (Standard) — redundant with #2 (per §B, pending your OK).
4. **Keyboard-safe CTA** (Standard mobile, item 3) — NOT moving CTAs to top; fix the real issue: the "Get Best Price" button is occluded by the on-screen keyboard on the contact step. Make it a keyboard-safe sticky CTA (P3-314). Same pattern already used in SimpleRFQForm.
5. **Scroll-position reset between pages** (ALL MSite forms, item 5 — *was* caught: **P2-216** / **P3-314**) — on every stage/step change, reset the stage-body scroller to top. Add a ref to the scroll container (SimpleRFQForm.tsx:1022/1058/1191; StandardRFQForm body) + `useEffect(scrollTo(0,0), [stage])`. Fixes "next page starts from the previous page's scroll position."

---

## E. Re-scoped issue buckets

### E1 · IN SCOPE — FIX ALL (Simple-popup, Simple-standalone, Standard)

**P0 (4)**
- P0-01 Stale mic/photo evidence persists across name-clear/product-switch (your bug) → scope evidence by `mcatId`; clear on name-empty / different mcat.
- P0-02 Background scroll behind fixed popup (your bug) → body scroll-lock + `overscroll-behavior:contain`.
- P0-03/04 Zero analytics + dead gtag stub → build the emit() layer + event taxonomy (§F), gated on `VITE_GA_ID` / POST-to-collector.

**P1 themes (in-scope subset)**
- Input races: photo analyzed against previous product's schema (P1-103); no generation/in-flight guard on onPhoto/onVoice (P1-104); no mic↔photo concurrency guard (P1-105); clear-name doesn't reset product-scoped state.
- Navigation/guards: score-jump bypasses skip-guard & empty submit (P1-101 — closed by §C.4 submit gate); standalone no exit at 640–767px (P1-102).
- Results integrity: no dispatch though says "sent" (RI-01/02 — closed by §C); fabricated sellers/badges (placeholder until BL API).
- Resilience: no ErrorBoundary/global handler → white-screen risk; OTP dead-locks if localStorage throws (Safari Private).
- UX/state: hidden page-2 answers still submitted; browser-Back exits whole standalone form (no history wiring); no draft persistence (refresh loses RFQ).
- A11y (P1s): no aria-live for score/stage/error/AI banners; contrast below WCAG AA; OTP paste/autofill drops digits.

**P2 / P3 (in-scope):** stepper active-node on results; exit-intent salvage fires post-conversion; specsLoading never clears on zero-display-specs; getSpecHints can blank the spec page; SimpleRFQForm swallows mic/photo failures (no toast); Toast has no role/aria-live; scroll not reset (§D.5); OptionChips no-deselect on page-1; "Other…" abandon clears selection; comma-split options; substring `/quantity|qty|unit/` hides real specs; buyer-spec silent cap at 10; Standard: exit control, unknown-sid not-found, half-filled custom spec discarded, popup scroll-lock/dialog, hero onError, duplicate spec-name collapse; reduced-motion; focus trap + role=dialog + Escape; input labels; 44×44 targets; routing not-found for bad `?rfq`/`?sid`. *(Full text + file:line in the register.)*

### E2 · DEFERRED (explicit — parked by your decisions)

- **Category-corpus** surfaces & races (Category-popup/standalone) — decision 4.
- **Input validation** — mobile prefix, email format, GST checksum, quantity dots — decision 2.
- **Image-upload guardrails / HEIC** — pending §B item 5.
- **Consent / DND / privacy / third-party disclosure** (incl. WA-deeplink GSTIN-in-URL) — decision 6. *(WA GSTIN-in-URL is a real privacy leak; flagged for when consent work resumes.)*
- **Prompt-injection** hardening (product name/voice/photo steering buyer questions) — hardening, low demo risk.
- **Secrets** — LLM/gateway key in browser bundle → needs backend proxy (ties to your BL-API backend work).
- **RFQModalV3 / V4 / BuyerLedgerView** — standing rule, never touch.

---

## F. GA event taxonomy (build the emit layer; wire IDs when you have them)

`rfq_form_open` · `rfq_product_committed` · `rfq_input_source_used` (mic/photo/typed) · `rfq_spec_filled`/`_deselected` · `rfq_aispecs_shown`/`_answered`/`_skipped`/`_failed` · `rfq_bl_eligible` (the toaster trigger) · `rfq_page_transition` (from/to/direction/method) · `rfq_otp_requested`/`_verified`/`_failed` · `rfq_requirement_submitted` (→ BL API) · `rfq_form_abandoned` (last_stage) · `rfq_api_error` (call/status/stage) · `rfq_timing` (per-stage dwell). One `emit()` fired from a centralized stage-transition helper + the key handlers. Result: full funnel drop-off, AI-assist adoption, failure attribution, time-per-page.

---

## G. Execution phases (order of work once you sign off)

- **Phase 1 — UI changes (§D):** the 5 Standard/MSite items. Fast, visible, low-risk.
- **Phase 2 — BL contract (§C):** eligibility + toaster + submit gate + onSubmit/BL stub + honest "sent".
- **Phase 3 — P0s:** stale-mic scoping, scroll-lock, analytics emit layer + events.
- **Phase 4 — Input races:** generation guards + stale-schema fix + concurrency + clear-name reset.
- **Phase 5 — Navigation/state:** standalone exit, stepper-on-results, exit-intent, hidden-answers, browser-back history, draft persistence.
- **Phase 6 — Resilience:** ErrorBoundary + global handlers + telemetry; OTP dead-lock; routing not-found.
- **Phase 7 — A11y:** dialog semantics/focus-trap/Escape, aria-live, labels, contrast (brand teal `#1d8480`), 44px, reduced-motion, OTP paste.
- **Phase 8 — Standard-specific:** exit, unknown-sid, half-filled custom spec, popup scroll/dialog, hero onError, dup spec-name.
- **Phase 9 — Test harness + suite:** Vitest (pure fns) + RTL (stages/guards/races w/ fake timers) + Playwright (journeys × surfaces + failure injection) + axe; CI gate w/ per-file coverage. Seed with `scripts/aispecs-invariants.mjs`.

Each phase: build → `tsc` clean → live-verify in preview → mark issue IDs closed in the register. No commit/push unless you ask.

---

## H. Test plan (yardsticks → the ~150 in-scope cases)

- **Journeys:** every forward/back/stepper-jump path across Simple-popup, Simple-standalone, Standard (× mobile/desktop). Empty/partial/complete.
- **Inputs:** every {type, mic, photo} permutation — first/after/clear-then-re-enter/concurrent/cancel/empty/garbled — asserting no stale-evidence bleed (P0-01 gate).
- **Failure matrix:** each call (McatDtl, buyer-ISQ, seller-ISQ, hints, AI-specs, images, OTP, BL) × {4xx, 401, 429, 5xx, timeout, empty, malformed, slow, offline}. Incl. **buyer-spec fails → seller-spec fallback shows first-3** and **AI-specs fail → auto-skip**.
- **Races:** commitGen/aiEpoch guards; second-commit-mid-call; jump-into-loading-page; scroll-lock during load.
- **BL contract:** eligibility truth table (qty only / spec only / both / neither / Standard-default); toaster fires once; submit gated; "sent" only after resolve.
- **A11y:** keyboard-only, focus trap, Escape, aria-live announcements, contrast, 44px, 200% reflow, reduced-motion, OTP paste.
- **Exit criteria:** all in-scope issue IDs closed + green suite + a live cross-device pass (the ~5–8% that needs a browser/device run: 200% reflow, cross-browser matrix, load perf).

---

## I. What I need from you to start building
1. Confirm §A reading is correct.
2. §B item 4 (remove "Requesting exactly this"?) and item 5 (demo iPhone camera → HEIC in or out?).
3. Any issue you want moved IN↔DEFERRED, or any severity you'd downgrade to "accept".
Then I re-run the completeness critic on THIS re-scoped plan (catch new gaps), and on your OK, start Phase 1.
