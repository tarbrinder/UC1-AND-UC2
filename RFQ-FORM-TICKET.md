# RFQ "Post a Requirement" Forms — Feature & Behaviour Spec

**Scope of this ticket:** the buyer-facing RFQ capture forms across **3 surfaces** — *mobile MSite*, *desktop popup*, *standalone full-page* — plus the **Standard Product ("Get Best Price")** form. One component drives all mobile/popup/standalone surfaces; changing it changes every surface at once (surface is a *test* dimension, not a code boundary).

| Component | File | Surfaces / routes |
|---|---|---|
| **Simple RFQ** | `src/components/SimpleRFQForm.tsx` | mobile MSite · desktop popup (in-app) · standalone `?rfq=simple` · category `?rfq=category` |
| **Standard RFQ** | `src/components/StandardRFQForm.tsx` | mobile · standalone `?rfq=standard&sid=<sid>` · desktop popup |

Both share: `IndiaMartHeader`, `OTPGate`, `Toast`, unified telemetry (`lib/emit.ts`), IST self-scoped theme hook (`lib/theme.ts`, currently forced light), `useFocusTrap`.

---

## A. Simple RFQ Form

**Flow:** `product → specs → aispecs (smart questions) → more (profile & delivery) → [OTP] → results`. A clickable stepper + orange progress bar reflect position; browser/hardware **Back steps through stages** (leaves the page only from the first stage).

### 1. Product page
- **Typeahead search** → resolves to an IndiaMART category (`mcatid-suggestion`), then pulls the spec schema (`GetIsq`) + seller specs (`getISQs`) + category image (`McatDtl`) + seller photos (IMSearchAPI) — **all fired in parallel**.
- **Recent searches** shown when the box is focused. The suggestions dropdown opens **only on a real tap/focus or typing** — never auto-popped on load.
- **Voice (mic)** and **Photo (camera)** → Gemini (`analyzeImage`/`voiceToSpecs`) extract product name + specs + qty. Evidence is **mcat-scoped** (dropped if the product changes to a different category). HEIC/large images are normalised (canvas → JPEG, ≤5 MB).
- **Quantity + Unit** — units come only from the API; a category with no qty/unit hides the block and auto-advances.

### 2. Specs page (buyer specs)
- Shows **all** buyer specs (ISQ) for the category, each as option chips + an optional grey **hint**.
- **Autofill only on an explicit signal** — a spec is pre-filled *only* when its value literally appears in the typed product name / photo / mic. The AI never *guesses* a value, and never *hides/removes* a spec once shown.

### 3. Smart questions page (AI specs)
- One LLM planning call (`getMissingSpecs`) proposes the best options-only questions a seller needs, product-intent-first.
- **Hard guards (deterministic parser):** never re-asks a page-1 buyer spec (name + option-overlap dedup), never asks quantity, and never asks a **last-page field** (delivery/timeline/payment/GST/location/business/industry). Fires as soon as the product resolves; fails safe (skip + fallback copy, never a dead page).

### 4. More page (Profile & Delivery)
- **Delivery location** — a compact row opening a **bottom-sheet drawer** (mobile) / anchored popover (desktop): *use my current location* (GPS→reverse-geocode, IP fallback) · your location · delivery location · "same as" toggle.
- **Delivery timeline**, **Payment terms** (+ conditional **Credit period** / **Payment mode**).
- **About You** — business type · industry · **GST** (asked only for a business role).
- **Contact** — collapsible; **Login** button autofills the buyer profile (guest → empty, never a real identity).

### 5. OTP + Results
- **OTP gate** (currently simulated `1234`) captures name/mobile before results.
- **Results** = curated sellers (Send Enquiry · WhatsApp deeplink). The **RFQ-strength score rail + checklist are hidden here** (no post-requirement distraction).
- **Score rail** elsewhere: live score, tap-any-item-to-jump, and a **"Fill next" nudge** that **moves forward** with the buyer (never nags about a skipped item behind them).

---

## B. Standard Product Form ("Get Best Price")

A **known** brand-catalog SKU (from `brands.indiamart.com/?sid=…`). **No search, no LLM** — the product is fixed.

**Flow:** `Product → Your Profile & Delivery → sent`. **CTA (Next/Back) on top, Exit on bottom** on every surface (MSite pattern); the product page and both steps scroll.

### 1. Product step
- Fixed catalog identity (image, title, ₹ onwards, "Requesting exactly this ↗"), **Quantity + Unit on top**.
- **6 catalog specs** as pre-ticked toggles (buyer unticks any); the **product URL rides along as a locked custom spec**; add-custom-spec; editable description.

### 2. Your Profile & Delivery — **in full sync with the Simple form**
- **Delivery** — the same location **drawer** (current-location · your/delivery · same-as), timeline, payment + **credit period** + **payment mode**.
- **About You** — business type · industry · **GST** (business role only).
- **Contact** — **collapsible**, with **Login** autofill.

---

## Cross-cutting behaviours (both forms)
- **Responsive / zoom-safe** — no horizontal overflow at narrow/zoomed desktop widths; the stepper condenses (active label only) until there's room.
- **Scroll cue** — a subtle amber "more below" chevron appears when a page overflows.
- **A11y** — `role=dialog`+`aria-modal`+focus-trap+Escape on overlays, aria-live for stage/score, labelled inputs, 44px targets, reduced-motion.
- **Telemetry** — one `emit()` funnel (form_open → product_committed → page_transition → bl_eligible → requirement_submitted) + `emitApiError` on every API catch.
- **BuyLead eligibility** — a BL is generated when quantity is set **or** ≥1 page-1/page-2 spec is filled (last-page profile fields are *not* specs). A one-time toaster confirms; submit calls the BL stub.

---

## ⚑ Integration points for the dev team (DEV-TODOs in code)
1. **Login / OTP** — currently simulated (`OTPGate`, code `1234`); wire the real IndiaMART login + SMS send/verify.
2. **Buyer-Profile fetch** — replace the demo identity (`applyLoggedInDefaults`) with the authenticated buyer's name/mobile/email.
3. **BuyLead API** — `dispatchBuyLead` (Simple) / `onSubmit` (Standard) are stubs; POST the assembled requirement (specs + qty + contact + lossless text + image).
4. **Standard product API** — resolve the SKU by `sid` (demo seeds one product in `lib/standardProducts.ts`).
5. **Analytics sink** — pick GA4/GTM or an `/api/events` collector (`lib/emit.ts`).
6. **Geo** — `ipapi.co` / `bigdatacloud` are demo providers; swap for production geo.
7. **Category corpus (category mode)** — needs the n8n `v51` import to serve a warm corpus (falls back gracefully today).
8. **Seller results** — `DEMO_SELLERS` + IMSearchAPI sample IDs are illustrative; wire the real product→seller match.

---

## QA checklist (per change)
Verify on: **mobile MSite · desktop popup · standalone (simple + category) · Standard**. Not one of these is a separate build — they are the same component; each is a test lane.
