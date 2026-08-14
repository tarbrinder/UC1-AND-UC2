# #79 — Final flow: location→header, delete last page, no consent step

Owner-decided 2026-08-14. The flow collapses to **Landing → Specs → Commercial → Persona → Curated Sellers.** No 'more' page, no consent step.

```
LANDING              PAGE 1        PAGE 2         PAGE 3                     RESULTS
product · qty ·  →   Specs    →    Commercial  →  Persona                →  Curated seller board
name+location gate   (LLM1)        (LLM2)         (LLM3)                     (curateBoard)
                     └──────── header shows the delivery city (editable) from here on ────────┘
                                                  + Contact details (collapsed, bottom)
```

## The moves

**A. Location → header (Move A).** A persistent, **visible** city control in the header (renders from Specs onward). Rules:
- Extract the gate's Continue logic (`resolveCityId` + `setLocationConfirmed` + `applyUserCity`) into one shared `commitCity(city)` helper the gate AND header both call, so they can't disagree and the gate can't re-pop over a city the header set.
- Header reads/writes the existing `userLocation` / `deliveryLocation` / `sameAsLoc` atoms — never a new atom (a single-field write must not clobber a distinct requirement-delivery the seed/spoken-delivery unlinked).
- Visible **text**, not a collapsed pill (honors the removed-pill lock). Edit affordance inline.
- `cityId` stays `''` until the city_id endpoint exists — same limitation everywhere; not a blocker.

**B. Delete the 'more' page (Move B).**
- Remove `'more'` from the `Stage` type + stepper. **Persona (page 3) becomes the last numbered page**; Get-Quotes advances persona → results.
- **Contact details → the bottom of the Persona page, collapsed by default** (owner). Same `contactBody`, just re-homed and collapsed.
- **Delivery location → the header** (Move A). Timeline / payment / terms are already the Commercial page's job (LLM2) — drop the deterministic 'more' duplicates (all optional; the lead contract doesn't require them).
- **Consent step is REMOVED** (owner): delete the Review-and-confirm modal + its page slot. Get-Quotes submits directly (with the OTP/name backstop that already exists).
- Repoint the hardcoded `'more'` targets: `checkStage`/`jumpToCheck`, and `goBack`-from-results now lands on `persona`.

## Race conditions — how each is handled (owner: "should be solved now")

- **Seller-search prewarm** — was fired on entering `'more'`. Re-point it to **entering the Persona page** (`stage==='persona' || 'results'`), so results stay warm when the buyer taps Get-Quotes on persona. (Known limit unchanged: it reads `buyerCity` at fire time and won't re-fire on a later header edit — acceptable, and a header edit is usually done well before persona.)
- **Persona late-resolve / skip** — already solved by the #76 fix: `nextBlocked` holds the persona Next while `psLoading`/`brainInFlight`, so the buyer can't skip persona and drop its answers, and the planner fires on the real brain. Contact-on-persona doesn't change this.
- **Gate ↔ header double-write** — the shared `commitCity` helper is the single writer of `cityId`/`locationConfirmed`; the header sets them the same way the gate does, so the 3.5s gate arm can't re-pop after a header confirm.
- **Stepper renumber** — persona stays derived from stable signals (never gated on async company data), so `includePersona` can't flip mid-flow.

## ⚠️ One legal flag before I delete consent

The `consentNote` on 'more' is **DPDP/TRAI microcopy** (a legal disclosure), separate from the Review *modal*. Removing the *modal* + the page is fine. But fully deleting the *microcopy* is a compliance decision. **Recommendation:** keep a **one-line consent notice** next to the final "Get Quotes" button (not a modal, not a step) — the legal disclosure survives with zero extra friction. I'll build it this way (microcopy kept as a one-liner near submit, modal + page removed) unless you tell me to drop the microcopy entirely.

## Build sequence
1. Move A — `commitCity` helper + visible header city control (shared atoms). Verify gate doesn't re-pop; header edits persist.
2. Move B — contact → persona (collapsed), delivery → header, remove Review modal + 'more' stage, re-point seller-search to persona-entry, repoint hardcoded 'more' nav.
3. Adversarially review (results still pre-warmed, no dangling 'more' refs, no stepper renumber, consent microcopy on the submit path).
