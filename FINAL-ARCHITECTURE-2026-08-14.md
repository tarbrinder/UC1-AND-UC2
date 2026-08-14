# RFQ Brain Form — Final Architecture & Go-Live Plan (2026-08-14)

Owner-confirmed. Supersedes the timing model in `GO-LIVE-PLAN-2026-08-14.md`. Everything below is clubbed into one build.

---

## 0. One paragraph

The whole input pipeline moves to **one fire point**. A tiny **LLM0** pulls product-name + quantity from mic/photo; the product commit **only loads the spec schema**; and when the buyer **lands on page 1 (specs)**, **LLM1** fires once with *everything gathered* (buyer truth + mic + photo + chat + manual), does **all** the prefilling (quantity included, as a spec), and decides the next questions. **LLM2 (commercial)** and **LLM3 (persona)** cascade from LLM1, each taking **LLM1's brain + the form filled so far** (product, qty, filled specs). This single change fixes both the unit-less quantity bug and the "chat/mic/photo never reach the brain" bug. The other go-live items (location, seller board, last-page redesign, buyer entry) are folded in below.

---

## 1. The LLM pipeline (the core change)

### 1.1 Roles

| | Name | When | Input | Output |
|---|---|---|---|---|
| **LLM0** | Extractor (tiny/fast) | on mic / photo input | raw audio / image | **product name + quantity** (+ unit if stated) — nothing else |
| **LLM1** | Requirement Brain (`runRequirementBrain`) | **on land page 1** | buyer truth (CSL/RFQ/profile/WhatsApp/PNS) **+ mic transcript + photo findings + chat transcript + manual entries** + schema | the brain: understanding, known-truths, **prefilled specs (incl. quantity)**, generated questions |
| **LLM2** | Commercial | **on land page 2** | **LLM1 brain + form-so-far** (`page1_state`: specs incl. buyer edits) | commercial questions (delivery, payment, terms) |
| **LLM3** | Persona | **on land page 3** | **LLM1 brain + form-so-far** (`page1_state` + `page2_state`) | persona questions (segment, use, industry) |
| **LLM4** | Profile synth | at commit or page-1 (independent) | buyer truth only | last-page profile chips (display only) |

Chat already has its LLM0 equivalent (`extractFromChat` → product+qty+unit). Mic (`voiceToSpecs`) and photo (`analyzeImage`) get **trimmed to the product+qty slice** for the commit; their *full* findings still flow into LLM1 via the bundle.

### 1.2 The trigger timeline

```
LANDING (page 0) ───────────────────────────────► LAND ON PAGE 1 (specs)
  buyer gives product (type / mic / photo / chat)      │
     │                                                 │
     ├─ LLM0: mic/photo → product + qty                │
     ├─ commitProduct(productName)                     │
     │     └─ loads ISQ schema ONLY (no planner)       │
     ├─ accumulate ALL raw input into inputBundle ref: │
     │     mic transcript · photo findings ·           │
     │     chat transcript · manual specs · qty        │
     │                                                 ▼
     │                              ┌──────────────────────────────────┐
     └─ buyer taps Next / "Fill my form" ────────────► LLM1 fires ONCE  │
                                    │  in: truth + inputBundle + schema │
                                    │  out: brain + prefilled specs+qty │
                                    └──────┬─────────────────┬──────────┘
                                           │ cascade         │ cascade
                                           ▼                 ▼
                                     LLM2 commercial    LLM3 persona
                                   in: brain+form-so-far  in: brain+form-so-far
```

**Key inversion:** today LLM1 fires at *product commit* (before mic/photo/chat exist). Now commit only **loads the schema**; LLM1 fires at **land-page-1** with the settled bundle. That is why the brain finally sees every input source.

### 1.3 The cascade (LLM2 / LLM3) — each on its OWN page

- **Symmetric:** LLM1 fires on land-page-1, **LLM2 on land-page-2**, **LLM3 on land-page-3**. Each fires **once** (fireKey guard) — never on every Next (that was the persona "jumping"); a single snapshot at page-arrival avoids it.
- Each consumes **LLM1's brain + the form filled so far at arrival**: LLM2 sees `page1_state` (the specs the buyer actually filled/edited on page 1); LLM3 sees `page1_state` **+** `page2_state` (so page 3 sees the most). These fences are already wired in the planner prompts.
- Firing on the page itself (not pre-warmed a page early) is deliberate — it's what gives each planner the buyer's *real* answers so far, at the cost of a brief loader on arrival (accepted).

### 1.4 Race handling (the part that must be right)

| Race | Guard |
|---|---|
| Buyer taps Next **before the schema loaded** | `pendingBrainFire` ref — hold with the page-1 loader, fire LLM1 the instant the schema lands (mirror today's `pendingChatFill`) |
| Buyer taps Next **while a mic/photo LLM0 is still extracting** | gate the advance on `!aiBusy`; the fire waits for the in-flight extraction to merge into the bundle |
| **Product switched** mid-flow | `commitGen` generation token — a superseded product's late LLM0/LLM1 result is dropped |
| **Double-fire** of LLM1 | fire-once ref keyed on the commit generation; the FIRST page-1 land fires it, every later Next is pure navigation |
| **Late input after the fire** (edit on specs page) | applies as a normal spec edit via the existing `extraSpecs` path — never re-fires LLM1 (preserves #51, the page-reset lock) |

### 1.5 Debug panel changes (owner asked)

Update `BrainDebugPanel` to reflect the new model:
- Relabel the trigger from "fires at product commit" → **"fires on land page-1"** for LLM1/2/3.
- Add an **LLM0** row (mic/photo/chat → product+qty extraction) before the commit.
- Show LLM1's **inputs as the bundle**: truth + mic + photo + chat + manual (each as a distinct fenced source), not just product+truth.
- Show LLM2/LLM3 inputs as **brain + form-so-far snapshot** (product, qty, filled specs) so the cascade is visible.
- Keep RAW=endpoint / CLEANED=code and the click-to-source citations.

### 1.6 What this resolves (folds in Items 1 & 2)

- **Quantity (Item 1):** qty rides in the bundle → LLM1 prefills it as a field. For a **unit-less category (Diesel Gen)** quantity becomes a **prefilled spec on page 1** — no landing qty box, no `DEFAULT_UNITS` hack. LLM0 lifts qty out of mic/photo.
- **Chat/mic/photo → brain (Item 2):** the full transcript + photo findings + mic text reach LLM1, so **non-schema specs are no longer dropped** — the brain places them as known-truths / prefilled specs / generated questions. (The old `applyUseCaseSpecs` schema-only drop path is retired for the landing phase.)

### 1.7 Locks this revises (owner-sanctioned)

- **#62 "planners fire once in parallel at commit"** → **"fire once at land-page-1"** (LLM1, then LLM2/3 cascade). Still once each. LLM4 may stay at commit.
- **#51 "no re-fire on Next / no page reset"** → **preserved and strengthened**: single fire at first page-1 land; later input = incremental edit.
- **#45 "page-1 loader until loaded"** → still holds; the loader now covers the page-1 fire.

---

## 2. Location — reconnect the signal + city chooser  (task #78)

**Two parts, both required:**

1. **Wiring (the dead signal).** The city-conflict gate is ~0% today because the searched-city signal is cut before the form: `hydrateLocationSignals` reads `node_raw.csl.browse_location.searched_cities`, but `BrainFormGate.load` builds `node_raw.csl = { viewed, searches }` and `fetchCsl` never parses `browse_location`. **Fix:** thread `csl.browse_location` through `BrainFormGate.load` into `node_raw`, surface it on `fetchCsl`/`CslResult`. **Verify the live `bi-csl-parser` actually emits `browse_location.searched_cities`** (n8n side) — frontend alone yields nothing if the parser doesn't send it.
2. **City chooser (owner chose this over confirm-one).** Replace the single `LocationSearch` typeahead in the gate with a **selectable list of candidate cities** — the profile city + each browsed/searched city as **tappable options** — plus `LocationSearch` as the "other city" fallback. Wire `resolveCityId` (currently a stub returning `''`) so a picked city ships a real `city_id`.

**Test:** 253102197 isn't in the harness — add a fixture with `buyer_facts.city="Ghaziabad", searched_cities=["Imphal"]` (different metro clusters → conflict), run with n8n unreachable so the fixture facts survive, commit a product, wait ~3.5s → the chooser appears. Then validate live on a real buyer whose profile city ≠ a searched city.

---

## 3. Seller board — top vertical-scroll + bottom horizontal rail  (task #77)

Owner-approved reversal of #33 (6-card no-scroll) + #73 (card variants).

- **Top (recommendations):** single-column `max-h + overflow-y-auto overscroll-contain` stack; card = today's `WideCard` shape **without** `col-span-2`. Use `max-h` (not fixed `h`) so 1 card leaves no dead box. Keep the ≤3 `final_rank` picks.
- **Bottom (nearby):** `flex gap-2 overflow-x-auto overscroll-x-contain snap-x -mx-5 px-5` — **reuse the "Products you viewed" rail pattern** already in the file; card = `GridCard` with `min-w-0`→`shrink-0 w-[168px] md:w-[200px]` + icon-only Call. The edge-bleed makes the cut card advertise the scroll.
- **Raise the near count** from `CURATED_PICK_SIZE=3` to `NEAR_RAIL_SIZE ≈ 8–12` (keep top at 3), or the rail has nothing to scroll on desktop.
- Re-check `showScrollHint` (it may stop firing now the board fits the fold); delete the obsolete "6 sellers, no scroll" measured-budget comment so the next reader isn't misled.

**Edges:** top <3 (use max-h); near empty (rail absent, no ghost scrollbar); near 1–2 on desktop (no overflow — acceptable); keep the "nearest is in top" label honesty. **Race:** add `overscroll-x-contain` so iOS momentum doesn't chain to the backdrop.

---

## 4. Flow redesign — location-to-header + kill last page  (task #79, PLAN-NEXT)

Owner chose "plan in detail, then build." Detailed relocation plan to be delivered before code. Constraints already known:
- **Location → header** as a **visible city control** (not a hidden pill — honor the removal lock), sharing `userLocation/deliveryLocation/sameAsLoc`, with `cityId`+`locationConfirmed` moved into a shared helper the upfront gate also calls. Gate #64 stays the hard block.
- **Deleting 'more'** must first relocate its 3 sole-owned pieces: (1) the **consent Review modal + DPDP/TRAI microcopy** → new final step or OTP; (2) the **seller-search prewarm trigger** (fires on entering 'more' — move it or buyers hit a cold ~30s wait); (3) the **delivery editor** → header. Repoint the hardcoded 'more' navigation targets.
- **Persona is NOT gated on company name** (it reads segment/use, not firm; company only exists for logged-in buyers → inverts intent). Prune persona questions via the merge layer instead.

---

## 5. Variant parity + buyer entry  (from Item 6)

There are not two divergeable variants — one component, layout props; functional parity already holds. **The real gap:** `?rfq=brain` is the **operator harness** — hardcodes `loggedIn=true` (OTP is dead code), and leaks operator chrome (GLID chip + surface switcher) even in "standalone + Production."

**Go-live need:** a thin **production buyer entry** — mounts `BrainRFQForm` without harness chrome, injects the session GLID (no picker), passes the **real** `loggedIn` (so logged-out buyers exercise OTP), pins `execMode='prod'`, renders none of the operator overlays. *(Secondary: decide if AI-Debug must be a faithful prod mirror — today prod/debug send different prompt text, so a debug QA run isn't a guaranteed match for prod output.)*

---

## 6. Deferred / not doing (this pass)

- **DPDP verification strip** — not selected by owner; `req.verification` keeps shipping as-is until the KYC endpoint + DPDP review land.
- **Persona-gated-on-company** — explicitly rejected (inverts intent).
- **`DEFAULT_UNITS` unit-less qty hack** — obsolete; §1 handles unit-less qty as a prefilled spec instead.

---

## 7. Build sequence & status

| Task | Item | Status | Depends on |
|---|---|---|---|
| #76 | Input→LLM1 pipeline (LLM0 + fire-on-page1 + LLM2/3 cascade + debug) | **APPROVED — build** | — |
| #77 | Seller board rebuild | **APPROVED — build** | — |
| #78 | Location signal reconnect + city chooser | **APPROVED — build** (+ n8n parser check) | live parser emitting browse_location |
| #79 | Location-to-header + kill last page | **PLAN-NEXT** (deliver plan, then build) | #76 landed helps |
| — | Production buyer entry | Recommended go-live gate | — |

**Order:** #76 (core, adversarially review the trigger before ship) ‖ #77 ‖ #78 in parallel → #79 plan → buyer entry.

---

## 8. Test matrix (all on `http://localhost:5173/?rfq=brain`)

| What | Steps | Pass |
|---|---|---|
| Qty (unit-less) | chat "50 diesel generators, 15 kVA" → advance | 50 appears as a **prefilled spec** on page 1; 15 kVA is a spec, not the qty |
| Chat non-schema | chat "food-grade, anti-rust coating" (not in schema) → advance | shows in the brain's prefill/known-truths, not silently dropped |
| Mic/photo → brain | commit a product, add a photo, use mic, then Next | in AI-Debug, LLM1's fenced inputs contain the mic transcript + photo findings |
| Single-fire | after landing on page 1, tap Next/Back repeatedly | LLM1/2/3 do **not** re-fire; no page reset/jump |
| Race: fast Next | tap Next before schema loads | loader holds, then LLM1 fires once when schema lands |
| Location | fixture Ghaziabad vs Imphal, n8n off, commit, wait 3.5s | **city chooser** with tappable options appears |
| Seller board | reach results at 1280×700 and 375×812 | top scrolls vertically, bottom rail scrolls horizontally, no page h-scroll |
| Buyer entry | (after build) open the buyer route | no GLID chip / surface switcher; logged-out reaches OTP |
