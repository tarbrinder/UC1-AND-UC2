# RFQ Brain Form — Go-Live Plan (2026-08-14)

Grounded audit of 6 items you raised. Each section: **what you asked → how it works today → the gap → edges → races → conflicts (owner-locks) → fix plan → how to test.** All routes are `http://localhost:5173/?rfq=brain`.

## Priority summary

| # | Item | Verdict | Go-live blocker? | Needs owner decision? |
|---|------|---------|:---:|:---:|
| 1 | Quantity fill (AI-fill) | Broken for **unit-less** categories (your Diesel Gen screenshot) | **YES** | No — clear fix |
| 2 | Whole chat → LLM1 (brain 1) | **NO, it doesn't** + non-schema specs dropped | **YES** (the drop) | Partial (feeding LLM1 = design change) |
| 3 | Location gate (253102197) | Signal is **severed before the form** → gate dead for everyone; no "choose city" UI exists | **YES** (wiring) | Yes (chooser vs confirm-one) |
| 4 | Seller board re-layout | Buildable, but **reverses 2 locked designs** | No (enhancement) | **YES** (sign-off) |
| 5 | Kill last page / header location / conditional persona+GST | Feasible but touches consent, seller-prewarm, planner-locks | Mixed | **YES** (several) |
| 6 | Variant parity | Not two variants — **one component**; parity already holds. Real gap = **no buyer entry** | **YES** (buyer entry) | No |

**The single biggest go-live truth:** `?rfq=brain` is the **operator harness**, not a buyer product. It hardcodes `loggedIn=true` (so OTP is dead code), and leaks operator chrome (GLID chip + surface switcher) even in "standalone + Production." A real buyer-facing entry does not exist yet (Item 6).

---

## Item 1 — Quantity is not getting filled by AI-fill

**What you asked:** check qty fills wherever possible, on the landing, across all flows + edges/races.

**How it works today.** There are 9 writers of `quantity`. For a **unit-bearing** category (has a Unit dropdown), qty fills and sticks correctly via manual typing and the AI-fill chat (`extractFromChat` is context-aware — "15 kVA"/"60 HP" are correctly *not* treated as quantities). The problem is concentrated on **unit-less** categories — exactly your Diesel Generator (mcat 13467), which returns no unit column, so `hasUnits = false`.

**The gap.**
- **F1 (headline, deterministic race):** on a unit-less category, mic/photo/chat set the quantity *after* `await commitProduct(...)`. But `commitProduct` flips `unitsResolved=true` while quantity is still `''`, which fires the "unit-less → skip to specs" **auto-advance** and bounces the buyer off the landing *before* the AI quantity lands. The number *is* captured (it ships, and shows on the Review row) but is **never visible or editable in the flow** — so to the buyer it "didn't fill."
- **F2:** on a unit-less category you **cannot even type a quantity** — the only qty input renders solely when quantity is *already* non-empty, and the auto-advance leaves immediately.
- **F3 (root cause):** the intended fallback — `DEFAULT_UNITS` (quantity.ts:27) that would give unit-less categories real unit chips — is **dead code**, never wired. Its own comment promises "unit chips… never a hidden field," which the code contradicts.
- **F4:** the qty-key match is too strict (`/^(order\s+)?(qty|quantity)$/i`). LLM/repost truths keyed "Quantity Required", "Approx Qty", "Order Quantity", "Order Size" **miss the qty box** and land as a spec chip / "Also detected."
- **F5:** voice/photo qty uses `String()` not `sanitizeQty` — a model output like "approx 100" / "5 pieces" ships verbatim, and `detectAbsurdQty(Number("5 pieces"))=0` silently disables the absurd-qty check.
- **F7:** a typed-but-uncommitted product + chat/voice sets qty, but the qty block is gated on `committed` → the qty is invisible with no schema behind it.

**Edge cases:** unit-less machines/services broadly (not just Diesel Gen); truths keyed with adjectives ("Approx Qty"); repost decision field "Order Quantity"; the absurd-qty banner is landing-only so it can never fire post-auto-advance; recovery via the Review row exists but buyers rarely open it → reads as "lost."

**Races:** R1 (auto-advance vs post-await setQuantity — deterministic, always loses); R2 (LLM-1 qtyTruth resolves after auto-advance on unit-less); R3 (seeded qty survives only because `committed` flips before `unitsResolved` — a fragile ordering invariant); R4 (finalizeAssist's hand-ordered qty-after / unit-before commit is brittle — already bit us once).

**Conflicts (owner-locks):** two locked decisions combine to hide the qty — "unit-less → skip to specs" + "qty rendered only on the landing." The "quantity gates NOTHING, captured in parallel" lock *assumes* qty is always visible where captured, which is false for unit-less + async fills.

**Fix plan (smallest-first):**
1. **Wire `DEFAULT_UNITS` as the unit fallback** in `commitProduct` when the category returns no units → `hasUnits=true` → the qty+unit block always renders, the auto-advance no longer fires, and every fill source becomes visible/editable. *This is exactly what the existing comment already promises.* (Fixes F1+F2+F3 in one move.)
2. **Broaden the qty-key regex** (KT_QTY at 195, formAdapter QTY at 613) to also catch `order (qty|quantity|size)`, `(qty|quantity) (required|approx|needed)`, `approx (qty|quantity)`. (F4)
3. **Route voice/photo qty through `sanitizeQty`** (or digit-clean in `voiceToSpecs` like `extractFromChat` does). (F5)
4. **F7:** in finalizeAssist, commit a typed-but-uncommitted name before applying qty, or render captured qty even when `committed=false`.

**How to test:** on `?rfq=brain`, chat "I need 50 diesel generators, 15 kVA" → today you get auto-bounced to specs and "50" appears nowhere (confirm it's actually captured via `window.__rfqLive.quantity`). Contrast: "100 tractor tyres 14.9-28" (unit-bearing) fills correctly. After fix #1, the unit-less case shows a qty box + a default unit and the number stays visible.

---

## Item 2 — Is the *whole* chat (text + mic + photo) passed to LLM1?

**Direct answer: NO.** LLM1 (`runRequirementBrain`) receives **only** structured, pre-digested fields — the committed **product name + quantity + seed buyer-truth** (past searches/requirements/profile/WhatsApp/calls). Its input contract has **no** transcript, no mic text, no image field.

**Per channel:**
- **Text chat → LLM1:** partial — only the extracted product name + quantity reach it. Chat specs that match the loaded schema reach LLM1 only *indirectly and conditionally* (via `alreadyFilled`, and only if the brain re-fires — which it deliberately doesn't). **Non-schema chat specs reach LLM1: never.**
- **Mic → LLM1:** same as text (mic-in-chat becomes a chat message). The audio/transcript never reaches LLM1.
- **Photo → LLM1:** the image reaches **no LLM at all** (it's only attached for sellers). Its schema-mapped values reach LLM2/3 via "Also detected," never LLM1.

**Your exact symptom explained.** Specs you type in chat that are **not** part of the buyer-spec schema are **dropped entirely**: `inferSpecsFromApplication` is instructed to ignore anything not in the field list, and `applyUseCaseSpecs` only writes values matching a *loaded* schema entry — it has **no leftover→"Also detected" routing** (unlike the photo/mic path, which does capture leftovers). So a non-schema chat spec (e.g. "food-grade", a brand not in the ISQ list) fills no chip, becomes no "Also detected" row, reaches no LLM, and survives *only* inside the free-text seller "Notes:" line. `requirementNotes` isn't even in the planner session — the raw chat is **LLM-invisible end-to-end**.

**Edges:** schema-matching chat spec at confidence <75 is discarded; a chat spec that matches schema but arrives after the brain fired fills the chip but LLM1's understanding was computed without it; a landing chat that fails to extract a product name runs spec-fill against an empty schema → nothing fills.

**Races:** brain-vs-chatfill — the brain fires on schema-ready while chat-fill *also* waits for schema-ready then adds a ~7s round-trip, so the brain wins and chat specs are excluded from LLM1's first (and only) pass. The re-fire suppression (task #51 fix) is intentional — re-enabling it would re-introduce the "page reset" bug.

**Conflicts (owner-locks):** LLM1 is *designed* to get buyer TRUTH only, not live-session input. Feeding the chat/photo into LLM1 is a **real design change**, owner-sanctioned, not a bug-fix. And it must arrive on the **first** fire (carried with the commit), never via a second fire.

**Fix plan:**
1. **Stop dropping non-schema chat specs (go-live blocker).** Relax `inferSpecsFromApplication` to also return a `customSpecs`/leftovers list (mirroring `voiceToSpecs`), and in `runChatSpecFill` route those into `extraSpecs` the same way the photo/mic path does → they fill a visible "Also detected" row, ship to sellers, **and** reach LLM2/3. This fixes your symptom without touching LLM1.
2. **(Optional, design change) Feed the transcript to LLM1.** Add an optional `<buyer_chat>` field to the brain inputs, carry the transcript *with the commit* (a ref set before `commitProduct`), and let the brain lift facts into known-truths/questions. Needs owner sign-off.

**How to test:** open the chat, say one in-schema spec + one non-schema spec ("food-grade with anti-rust coating"), tap "Fill my form." Today: the in-schema one fills a chip; the non-schema one appears nowhere except the notes textarea + final seller "Notes:" line. In AI-Debug, confirm the brain's fenced inputs contain **no** chat text.

---

## Item 3 — Location gate did not fire for 253102197 (and no "choose a city" UI)

**Direct answer: it correctly did not fire — because the signal that would trigger it is severed before it ever reaches the form.** And separately, **the "different city options to choose" UI does not exist** — the gate shows a single search box + a text banner naming the alternatives.

**Why it didn't fire (four compounding reasons):**
1. **Profile city seeds and suppresses the guess.** The live profile (bpod) supplies a city → `seedCity` present → fills `userLocation` → the browse-hint prefill bails (`if (seedCity || !browseCityHint) return`), so `cityIsGuessRef` is never set.
2. **The conflict predicate needs a profile-vs-browse mismatch that isn't present** — with no browse/searched signals, `detectLocationConflict` returns `conflict:false`.
3. **The searched-city signal is structurally dropped on this flow.** `hydrateLocationSignals` reads `node_raw.csl.browse_location.searched_cities`, but `BrainFormGate.load` builds `node_raw.csl = { viewed, searches }` only — it never threads `browse_location` through, and `fetchCsl` doesn't parse it. **So even when the live CSL webhook returns searched cities, they never reach the form.** The gap comment ("253102197: Dimapur") describes a signal the wiring doesn't deliver.
4. **253102197 isn't in the harness** — not a scenario, not a fixture — so it can only run fully live.

**Net:** the location-**conflict** branch of the gate is effectively **dead (~0% coverage) for every buyer**, not just 253102197 — because the searched-city signal is cut before `buyer_facts`.

**Does it ever offer options to choose?** No. Even on a genuine conflict, it renders **one** `LocationSearch` typeahead + a one-line amber banner ("Your saved city is X, but you seem to be browsing from Y. Confirm where suppliers should quote."). The alternative cities appear only as **bold text**, not tappable options. Your expectation (a chooser) isn't implemented.

**Edges:** profile city absent → gate fires but as a blank ask (no banner); same-metro-cluster cities (Ghaziabad vs Noida) are treated as one → no conflict by design; gate arms only after product commit, once per mcat; `gateCanContinue` accepts *any* pick, not the right one; `resolveCityId` is a **stub returning ''** so even a confirmed city ships with **no city_id**.

**Races:** two overlapping live pulls both re-run `normalize` and the second **overwrites** `buyer_facts` (would wipe any searched_cities); the 3.5s gate timer can fire before late CSL/profile leaves land.

**Conflicts (owner-locks / memory):** memory says "full city_id via LocationSearch now" but `resolveCityId` is still a stub → we ship a city **name**, no id. Memory's "CSL cities_resolved conflict" reads a *different* CSL field than the gate's `searched_cities` — the two aren't reconciled. And "confirm one city" (current) vs "choose among options" (your ask) is a **product decision**.

**Fix plan:**
1. **Reconnect the signal (load-bearing wiring bug).** In `BrainFormGate.load`, thread `csl.browse_location` into the reconstructed `node_raw`, and have `fetchCsl` surface `browse_location` (not bury it in `raw`). **Verify the live `bi-csl-parser` actually emits `browse_location.searched_cities`** — if it doesn't yet, the frontend fix alone yields nothing (that's the n8n side of "CSL gap G2").
2. **Decide the UX (owner):** keep "confirm one city via search" (current) or **build a selectable chooser** of profile-city vs each browsed/searched city.
3. Wire `resolveCityId` so a confirmed city ships a real `city_id`.

**How to test:** 253102197 isn't in the harness — to exercise the gate UI deterministically, add a fixture `"253102197"` with `buyer_facts: { city: "Ghaziabad", searched_cities: ["Imphal"] }` (different metro clusters → conflict=true), run it **with n8n unreachable** (so the fixture facts survive the re-normalize), commit a product, wait ~3.5s → the banner appears with a single search box (proving no chooser exists). Validate the real fix live on a buyer whose profile city ≠ a city they searched sellers in.

---

## Item 4 — Seller board: top vertical-scroll + bottom horizontal-scroll

**What you asked:** two stacked rows — top = recommendations (scroll), bottom = nearby sellers (scroll left-right).

**How it works today.** `CuratedSellerBoard` renders **two grid rows, no scroll on either axis** — "Our recommendation" (≤3) and "Also/Nearest near you" (≤3), deliberately sized to fit the first fold (there's a measured budget proving no scroll). The old horizontal carousel was **explicitly deleted 2026-07-28**. Two card variants exist: `GridCard` (`min-w-0`, squeezable) and `WideCard` (msite col-span-2).

**The gap / verdict.** Buildable and small in code, but it **reverses two completed owner-locked designs** (#33 "6-card no-scroll board", #73 "two card variants") and **re-adds the carousel that was deliberately removed**. Plus one data gap: the near row is **hard-capped at 3**, so a horizontal rail has **nothing to scroll on desktop** unless we raise the count.

**Precise build spec:**
- **Top (recommendations, vertical scroll):** single-column stack in a `max-h` + `overflow-y-auto overscroll-contain` scroller (use `max-h` not fixed `h` so 1 card doesn't leave a dead box). Card = the `WideCard` shape *without* `col-span-2`.
- **Bottom (nearby, horizontal scroll):** `flex gap-2 overflow-x-auto overscroll-x-contain snap-x -mx-5 px-5` — **reuse the exact "Products you viewed" rail pattern already in this file.** Card = `GridCard` with `min-w-0` replaced by `shrink-0 w-[168px] md:w-[200px]` + icon-only Call. The `-mx-5 px-5` edge-bleed makes the cut card advertise the scroll.
- **Raise the near count** from 3 to ~8–12 (keep top at 3) or the horizontal scroll is inert on desktop.

**Edges:** top <3 → use `max-h`; near empty → rail absent (no ghost scrollbar); near 1–2 on desktop → no overflow (acceptable); long names in a fixed rail card (`line-clamp-2`); keyboard focus onto an off-screen rail card; the "nearest is in top" label honesty still applies.

**Races:** streaming loading→done resets rail scroll to 0 (expected); a background result-grow preserves scroll via stable keys; iOS momentum can chain to the backdrop (`overscroll-x-contain` fixes it).

**Conflicts (owner-locks):** deletes #33's "one board, six sellers, no scroll" invariant + its measured budget proof; replaces #73's two variants with a *different* two; re-adds the removed carousel. **Needs explicit owner sign-off — it's a reversal, not a tweak.**

**How to test:** reach `stage==='results'`; desktop 1280×700 (worst-case 560px shell) → top scrolls vertically, bottom scrolls horizontally (only after raising near-count); mobile 375×812 & 375×667 → rail bleeds to edges; confirm `showScrollHint` no longer misfires now that the board fits the fold.

---

## Item 5 — Kill the last page / location-in-header / conditional persona + GST

**What you asked:** move location to the header; then maybe delete the last page ('more'); route to persona only if company name missing; fire GST/Udyam/Aadhaar only if required.

**All four are feasible (the flow is data-driven off one stepper array), but three collide with recent owner-locks, and deleting 'more' silently drops load-bearing pieces.**

**(a) Location → header.** Mostly a *relocation* — the upfront gate #64 already hard-captures city before specs. But it **directly reverses** the owner's removal of the header delivery-pill ("the city hid there"). Safe **only if** the header shows city **as visible text (not a collapsed pill)** and handles the `userLocation`-vs-`deliveryLocation` + `sameAsLoc` split. `cityId` resolution + `locationConfirmed` currently live **only** in the gate's Continue — a header control must call a shared helper for those. Feasible. Note the header renders from specs onward, not on the landing.

**(b) Delete 'more'.** The lead **contract survives** (no required submission field is 'more'-only), **but 'more' uniquely owns three things** you must relocate first, or they break:
1. **The consent Review modal + DPDP/TRAI microcopy** (owner task #2 + the "Approved without Buyer Consent" audit answer) — their *only* home. Move to the new final step or fold into OTP, or you lose the legal consent artifact.
2. **The seller-search prewarm trigger** — the ~30s windmill call fires *on entering 'more'* so results are warm on the results page. Delete 'more' without re-homing it → buyers hit a **cold 30s wait**.
3. **The delivery-location editor** (if not already moved to the header per (a)).
   Plus repoint the hardcoded 'more' targets in `checkStage`/`goBack-from-results`.

**(c) Persona only when company name missing — don't do this.** Persona (LLM3) reads **segment/use/designation/industry/size**, *not* company name. `companyName` is only populated for **logged-in** buyers → gating persona on it would **always** show persona for logged-out buyers and **never** for logged-in ones with a firm — the **inverse of intent**. It also strands the business-GST ask (which only renders on the persona page) and risks re-introducing conditional planner firing that fights the owner-locked "planners fire once in parallel." **Better:** let the merge layer prune persona questions we can already answer from profile (it already skips empty persona pages), and keep `includePersona` derived from stable signals to avoid mid-flow stepper renumbering.

**(d) GST/Udyam/Aadhaar "only when required" — already conditional.** The ask shows only for `isBusinessRole && !gstOnFile`; the spiral only for `isBusinessRole && gstRegistered===false` (collapsed, skippable); individuals see neither. **The real go-live blocker here is enforcing the DPDP strip:** `req.verification` is **still populated into the host payload today** despite the "do NOT ship until DPDP-reviewed" comment — the strip is a comment, not enforced code.

**Edges/races:** `resolveCityId` stub → no city_id anywhere; `companyName` empty for logged-out; `aboutYouHasContent` already collapses 'more' to logistics+contact+consent for cold buyers; retail-lite already hides persona/About-You; seller-search reads city at fire-time and won't re-fire on a later edit (an edit-anywhere header makes this pre-existing limit more visible); conditional persona keyed on async company data could flip `includePersona` **mid-flow and renumber the stepper** (the exact hazard the code warns against).

**Fix plan (sequenced to protect the locks):**
1. **Location-to-header first** — a *visible* city+edit control (never a hidden pill), sharing `userLocation/deliveryLocation/sameAsLoc`, with `cityId`+`locationConfirmed` moved into a shared helper both the gate and header call. Keep gate #64 as the hard block.
2. **Then delete 'more'** — but first relocate consent (Review + microcopy), the seller-search trigger, and the delivery editor; repoint the hardcoded 'more' navigation targets. Leave timeline/payment/company/industry/contact as optional accordions on the surviving last step.
3. **Do NOT gate persona on company name.** Prune persona questions via the merge layer instead; re-home the business-GST ask before touching persona visibility.
4. **Enforce the DPDP strip** — stop putting `req.verification` in the host payload until the KYC endpoint + DPDP review land.

Ship (a) and (d)-strip independently; (b) and (c) need the relocations + owner sign-off first.

---

## Item 6 — Variant parity (dashboard vs standalone, excluding debug)

**Direct answer: there are NOT two divergeable variants.** `BrainRFQForm` has **one** mount (`BrainFormGate`, `?rfq=brain`). "Dashboard popup" and "standalone" are the **same component** with different **layout props** (`surface` mobile/popup/desktop) + an orthogonal `execMode` (prod/debug). **Every functional gate — fetches, LLM1/2/3, retail gate, location gate, seller search, consent, scoring — is shared code that runs identically.** No variant skips logic.

**Only 2 non-inspector differences:**
1. **Prod vs Debug send different LLM *prompts*** (debug adds line-numbered fences + evidence schema). So at temperature 0, **a debug QA run is not a faithful mirror of prod output** — an extraction validated only in AI-Debug may not reproduce in Production. (Owner-intended "verbosity only," but the prompt text genuinely differs.)
2. **LLM4 profile-synth is skipped in prod for retail-lite** but fires in debug — **harmless** (output never shipped/shown), cost/telemetry only.

**THE REAL GAP — no production buyer entry exists.** `?rfq=brain` is the **operator harness**:
- It **hardcodes `loggedIn=true`** → `otpVerified` is force-true → **`OTPGate` is structurally unreachable**. OTP is built but exercised by nothing; a **logged-out buyer flow has no entry**.
- It **leaks operator chrome** — the floating **GLID chip** (bottom-left) and the **surface switcher** (top-left) render **even in "standalone + Production."** A buyer must never see these.
- `surfaceName` telemetry can't tell mobile from standalone (mobile logs as "standalone").

**Fix plan (this is the go-live gap, not "hunting for skipped logic"):**
1. **Ship a thin production buyer entry** — a route/wrapper that mounts `BrainRFQForm` **without** the harness chrome: inject the session GLID (no picker), pass the **real** `loggedIn` (so logged-out buyers exercise OTP), pin `execMode='prod'`, render **none** of the operator overlays.
2. **Decide whether AI-Debug must be a faithful prod mirror** — if yes, make prod/debug share the identical prompt body and gate only `captureRaw` + debug-only response fields. Otherwise every debug validation carries a caveat.

**How to test:** toggle Surface × Execution across the 6 combos and confirm the same flow fires everywhere (parity holds). Then pick **Standalone + Production** and observe the GLID chip + switcher still render (must be gone for a buyer). OTP can only be reached by temporarily setting `loggedIn={false}` in the gate.

---

## Go-live blocker checklist (my recommendation)

**Must-fix before buyers:**
- [ ] **Item 1.1** — wire `DEFAULT_UNITS` so unit-less categories show qty (your screenshot bug).
- [ ] **Item 2.1** — stop dropping non-schema chat specs (route to "Also detected").
- [ ] **Item 3.1** — reconnect the CSL `browse_location` signal (or the location-conflict gate stays 0%). *Also verify the n8n parser emits it.*
- [ ] **Item 5(d)-strip** — enforce the DPDP strip (`req.verification` must not ship).
- [ ] **Item 6.1** — a real buyer entry (no harness chrome, real `loggedIn`, OTP reachable).
- [ ] **Item 1.2/1.3** — qty-key regex + voice/photo `sanitizeQty`.

**Owner decisions needed (won't build until you say):**
- **Item 4** — seller-board re-layout reverses #33 + #73. Proceed?
- **Item 3.2** — location: build a **city chooser**, or keep confirm-one-via-search?
- **Item 5(a/b)** — location-to-header + delete 'more' (with the 3 relocations). Proceed?
- **Item 2.2** — feed the chat transcript into LLM1 (design change), or just fix the drop (2.1)?

**Explicitly recommend NOT doing:**
- **Item 5(c)** — gating persona on company name (inverts intent, fights planner-locks). Prune via the merge layer instead.

## Suggested build order
1. Item 1 (qty) + Item 2.1 (chat drop) — small, high-value, no owner decision.
2. Item 6.1 (buyer entry) + Item 5(d)-strip — the two hard go-live gates.
3. Item 3.1 (signal reconnect) — pair with the n8n parser check.
4. Owner-decision batch: Items 4, 3.2, 5(a/b), 2.2.
