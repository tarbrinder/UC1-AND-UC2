# Persona360 New UI — Architecture & Design Tokens (K-2)

> Owner: @doraemon · Card K-2 on `docs/KANBAN-NEW-UI.md`.
> Source mockup: `docs/buyer-persona-ui.webp` (visually inspected by the author).
> Data contract: `docs/persona360-data-audit.md` (@scout, K-1) + type sketch in `.hermes/plans/2026-08-19_buyer-persona-360-ui.md`.
> **Scope:** documentation only. Zero `src/` writes. A builder implements every section from this doc without re-viewing the webp.
> **Stack frozen by the plan:** React + Vite + TS, existing Tailwind 3.4 (class-dark-mode), `lucide-react` (already a dep), hand-rolled SVG (no recharts).

---

## 0. Design principles

1. **Additive & isolated.** Everything lives under `src/components/persona360/` (+ `src/lib/persona360Types.ts`, `src/fixtures/persona360Fixture.ts`). The page never imports from existing components except where §9 explicitly reuses a repo pattern as reference. No existing file changes except the planned 2-line `App.tsx` gate (K-5 task 2).
2. **Fixture-first, live-later.** Every component is a pure function of a typed `Persona360Data` prop (or a slice of it). `Persona360Page` owns data acquisition; columns never fetch. This keeps K-5 task 9 (live wiring) a swap inside the page shell only.
3. **Never invent data.** Fields the audit marks gap (trust/risk numeric score formula, completeness %, monthly buckets, credit/cheque/balance-sheet) render in one of two ways: fixture values in fixture mode; a **Pending** state in live mode when the workflow omits them (§6). No computed-looking numbers without a documented formula.
4. **Status taxonomy is a TS union.** `VerifyStatus` (§4) is the single source of truth for badge color/shape. No free-string status styling anywhere.
5. **Dark mode:** the repo flips `dark` on `<html>` by IST time-of-day. Persona360 is an operator surface; design light-first and add `dark:` variants only for the page canvas + card surfaces (navy header and assigned-persona card are already dark constants and stay identical in both modes).

---

## 1. Page anatomy & layout grid

Page = vertical stack of four bands: `TrustStrip` → `PersonaHeader` → `ColumnsBand` (4 cols) → `EngagementBand`. Canvas background `#E9EAEC` (light gray) with 1px white gutters between bands, matching the mockup's hairline separators.

| Band | Max width | Notes |
|---|---|---|
| TrustStrip | full-bleed white, 32px height | operator/debug affordance |
| PersonaHeader | full-bleed navy `#0B2D4D` | two-zone flex |
| ColumnsBand | full-bleed, `grid grid-cols-4 gap-px bg-white` on ≥xl | each col is a white card; equal widths (1fr each) |
| EngagementBand | full-bleed white | inner `grid grid-cols-[280px_1fr]` (metric stack + chart) |

ColumnsBand responsive fallback: `grid-cols-1` < md, `grid-cols-2` md–xl, `grid-cols-4` ≥ xl (1280px). Each column component renders standalone — it receives only its own slice and its own loading/error/empty state (§6), so a 2-col or 1-col layout is just the same components stacked.

Spacing rhythm (Tailwind): band padding `p-4` (16px); column inner `p-4`; section header row `mb-3`; field row `py-2` with `border-b border-gray-100` hairlines; label→value gap `mt-0.5`. Section number titles: `text-[11px] font-bold tracking-[0.08em] text-gray-700 uppercase` e.g. `1 · PERSONA`.

---

## 2. Color & semantic token table

Existing repo tokens: brand teal `#1d8480` (tailwind `teal-600`), gray ramp = Tailwind default. Persona360 introduces a **local navy/orange accent pair** used ONLY inside `persona360/` components (defined as consts in `persona360/tokens.ts`, exported for the fixture chart):

| Token | Hex | Tailwind approx | Semantic use |
|---|---|---|---|
| `navy` | `#0B2D4D` | — (arbitrary) | header band, assigned-persona card, section 0 ring, Calls series, primary text accent |
| `navySoft` | `#123A5F` | — | header hover/inner borders |
| `activity` | `#2563EB` | `blue-600` | Enquiries series, "active" info states |
| `caution` | `#F59E0B` | `amber-500` | orange badges/bars (BuyLeads, WATCH band, VBB badge, caution dots) |
| `positive` | `#16A34A` | `green-600` | verified/positive badges & dots |
| `concern` | `#DC2626` | `red-600` | missing/concern badges, dots, warnings, fraud-callout rule |
| `unknown` | `#9CA3AF` | `gray-400` | unrated/unknown/pending badges, absent dots |
| `canvas` | `#E9EAEC` | `gray-200`-ish | page background |
| `card` | `#FFFFFF` | white | column surfaces |
| `hairline` | `#E5E7EB` | `gray-200` | row dividers, track fills |
| `fraudBg` | `#FCEBEA` | — | fraud-read callout fill |
| `fraudRule` | `#B91C1C` | `red-700` | fraud callout left rule |

State→color mapping for dots/signals (`'good' | 'caution' | 'bad'`): good=`positive`, caution=`caution`, bad=`concern`. `unknown` is not a signal state — absent/pending rows use `unknown`.

**Deliberate divergence from `ScoreBadge.tsx`:** the existing RFQ ring interpolates red→green by score. Persona360 does **NOT** reuse that ramp. Mockup semantics are different (trust 46 renders navy/orange, not red), and risk/trust banding is explicitly *pending product formula* per the audit. Ring color rules here: trust ring = `caution` fill on `#33475C` track inside navy header; risk score uses band chip (§5 Risk). Document in code comment so nobody "fixes" it back to the red-green ramp.

---

## 3. Component tree

```
Persona360Page                     // owns ?glid=, data acquisition (fixture now, webhook later), error/empty page states
├─ TrustStrip                      // "trustScore ——●—— 46" operator strip (fixture/debug only; hidden in live mode until formula exists)
├─ PersonaHeader
│  ├─ HeaderIdentity               // name, GLID chip, VBB badge, description, meta row
│  └─ TrustRing                    // SVG donut 46/100 + "TRUST SCORE" + recommendation + 3 signal bullets
├─ ColumnsBand (grid)
│  ├─ PersonaColumn                // §1
│  │  ├─ AssignedPersonaCard       // navy card, match%, primary + alternate
│  │  ├─ StageScale                // 4-segment bar + estimate note
│  │  └─ FieldRow (shared)
│  ├─ SourcingColumn               // §2
│  │  ├─ PriceQualitySlider        // gradient track + positioned marker
│  │  ├─ CityShareBars             // 3 horizontal share bars + delivery note
│  │  └─ RankedProductList
│  ├─ RiskColumn                   // §3
│  │  ├─ RiskScoreBlock            // big number + band chip + bar
│  │  ├─ StatusBadge (shared)      // keyed on VerifyStatus
│  │  └─ FraudReadCallout
│  └─ InternetColumn               // §4
│     ├─ StatusDotRow (shared)
│     ├─ VerifiedTagRow            // pill tags verified/absent
│     └─ CompletenessBar
└─ EngagementBand
   ├─ MetricCardStack              // 2×2 cards
   └─ MonthlyBars                  // grouped SVG bar chart + legend + annotation
```

Shared atoms live in `persona360/ui.tsx`: `SectionTitle`, `FieldRow`, `StatusBadge`, `StatusDotRow`, `Hairline`. Chart/ring SVGs in `persona360/svg.tsx`: `TrustRing`, `MonthlyBars`.

---

## 4. Status taxonomy → badge/dot style map

Extend the plan's union with the audit's needs (pending states). Final union in `persona360Types.ts`:

```ts
export type VerifyStatus =
  | 'verified'        // green solid pill, white text        (Mobile/Email/PAN/Name; "No bounce")
  | 'active'          // green dot + dark text               (PNS profiling active)
  | 'not_registered'  // red dot + bold dark label, gray sub (GST not registered)
  | 'no_match'        // orange dot                          (IINRCA: no entity match)
  | 'no_presence'     // red dot                             (No web or social presence)
  | 'notified'        // red solid pill, white text          (Balance sheet: Notified)
  | 'no_bounce'       // green solid pill                    (Cheque history)
  | 'unrated'         // gray-200 pill, gray-600 text        (Credit exposure; GST/Udyam/TrustSeal tags)
  | 'missing'         // gray text list item                 (completeness missing list)
  | 'pending'         // amber-outline pill "formula pending" (trust/risk numeric, completeness % in LIVE mode)
  | 'not_checked';    // gray dot, neutral                   (future-proof)
```

Pill geometry: `px-2 py-0.5 rounded text-[11px] font-bold`; solid pills use token fill + white text; `unrated` = `bg-gray-200 text-gray-600`; `pending` = `border border-amber-400 text-amber-600 bg-amber-50`.
Dot geometry: `w-2 h-2 rounded-full` + label `text-[13px] font-semibold text-gray-900` + sub `text-[11px] text-gray-500`.
WATCH band chip (risk): `bg-amber-500 text-white rounded px-2.5 py-1 text-[11px] font-bold tracking-wide`.

---

## 5. Section-by-section build spec

### TrustStrip (band 0)
White 32px row, left-aligned: label `trustScore` `text-[10px] text-gray-400`, a 90px `h-0.5 bg-gray-200` track with a 6px gray-500 knob at `score%`, value `text-[10px] text-gray-500`. **Fixture/debug only** — in live mode render `<Pending>` ("trustScore formula pending") unless product defines a formula. Non-interactive (`aria-hidden`, not an input).

### PersonaHeader (band H)
Navy `#0B2D4D`, `px-5 py-4`, flex `justify-between`.
- Left: H1 name `text-2xl font-extrabold text-white` + inline `GLID 268590579` chip (`border border-slate-400/60 text-slate-200 text-[10px] px-1.5 rounded`); second line orange badge `VBB REPEAT BUYER` (`bg-caution text-[#0B2D4D]` bold 10px, `px-2 py-0.5 rounded-sm`); third line description `text-[12px] text-slate-300`; meta row `flex gap-6` of 4 labeled pairs — label `text-[9px] uppercase tracking-wider text-slate-400`, value `text-[11px] text-white` (AGE/GENDER `29 · Male`, MEMBER SINCE `3 months`, MOBILE `6386941152`, EMAIL `jayveer…@gmail.com` — masking done in fixture, component renders strings as-is).
- Right: `TrustRing` (donut 64px: track `#33475C` stroke 6, arc `caution` stroke 6, `strokeDasharray = pct·C`, `-rotate-90`, center number `text-xl font-extrabold text-white` + `of 100` `text-[8px] text-slate-400`); beside it a column: `TRUST SCORE` micro-label (amber, 9px), recommendation `text-[13px] font-bold text-caution` ("Verify before push"), then 3 signal bullets — dot (good=green / caution=amber / bad=red) + `text-[11px] text-slate-200`. Signals fixture: Identity clear=good, Financials thin=caution, Behaviour genuine=good.

### Column 1 · PERSONA
- `AssignedPersonaCard`: navy card `rounded-md p-3`, header row `ASSIGNED PERSONA` (9px slate-400) + `82% match` (11px bold caution, right). Title `text-[15px] font-extrabold text-white` two lines; `Alternate read: …` `text-[10px] text-slate-300`.
- INDUSTRY `FieldRow`: label 10px gray-500 bold; value `text-[13px] font-semibold text-gray-900`; sub `text-[11px] text-gray-500`.
- STAGE OF BUSINESS: `StageScale` = flex row of 4 equal `h-1.5 rounded-sm` segments, active = `navy`, inactive = `gray-200`; under-segment labels 9px (Startup/SME/Mid/Enterprise, active bold dark); note line 10px gray-500.
- TURNOVER / INCOME: value `₹8–10 L` bold + inline `declared p.a.` 10px gray-500; warning line `text-[11px] font-semibold text-concern` ("Company turnover not declared").
- BUYING ENTITY: value bold + sub `text-[11px] text-gray-500` (masked PAN rendered as given).

### Column 2 · SOURCING
- `PriceQualitySlider`: header row label left (10px bold gray-600) + current position right (`Price-led`, 12px bold navy). Track `h-1.5 rounded-full` CSS gradient `linear-gradient(90deg,#F59E0B,#E5E7EB 45%,#2563EB)`; marker = 2px×12px `bg-gray-900` at `position%` (fixture ≈ 18%). Footer captions 9px gray-400 left "Lowest price" / right "Premium quality". Evidence note 10px gray-500 italic below.
- ANNUAL PROCUREMENT / ORDER PATTERN: two `FieldRow`s side by side (`grid grid-cols-2 gap-3`); value `text-[15px] font-extrabold`; sub 10px gray-500.
- PROCUREMENT CITIES · SHARE OF ENQUIRIES: `CityShareBars` rows = name 11px semibold + pct right-aligned 11px gray-600; bar `h-1 bg-gray-100 rounded` with `activity` fill at share%; note 10px gray-400 italic ("All delivered to Kanpur, Uttar Pradesh").
- PRODUCTS OF INTEREST: ordered list, rank number `text-gray-400` + text 11px gray-800; header value line first item bold (`1 1300 Pcs/Hr Notebook making machine`).

### Column 3 · RISK & FRAUD
- `RiskScoreBlock`: row: `RISK SCORE` micro-label; right `WATCH` chip. Number `text-3xl font-extrabold text-gray-900` + `/100` 11px gray-400. Bar `h-1.5` track gray-200, fill `caution` width=score%. **Live mode:** if no numeric score from workflow → number area renders `StatusBadge 'pending'` + raw Sign3 `fraud_seller_detection_score` (0–1 or `unknown`, never band-labelled, never 0 when absent — audit rule).
- SM RISK / RATING & GRADE two-col grid: SM value `text-[15px] font-extrabold text-positive` ("Low") + 10px gray-500 note; rating value bold ("3.8 · B") + 10px note ("6 supplier ratings"). **Live-mode label rule (audit §3):** caption must read "seller-side rating (also-seller signal)" when sourced from `risk.indiamart_seller_rating` — never "buyer trust".
- FINANCIAL VERIFICATION: 3 `FieldRow`s label left (11px gray-700) + `StatusBadge` right: Balance sheet→`notified`, Cheque history→`no_bounce`, Credit exposure→`unrated`. **Live mode:** these three are audit gaps → render `pending` unless workflow adds named fields.
- `FraudReadCallout`: `bg-fraudBg border-l-2 border-fraudRule rounded-r-md p-3`; title `FRAUD READ` 10px bold `text-red-700 tracking-wider`; body 11px gray-700 with bolded key phrase ("ability to pay") via `<strong>`.

### Column 4 · INTERNET PROFILE
- `StatusDotRow` list (5 rows): dot color by state (bad=concern, good=positive, caution=caution), label 12px bold gray-900, sub 10px gray-500. Fixture rows: GST not registered (bad) / PNS profiling active (good, sub "27 calls · avg 2m 10s · answers 84%") / IINRCA: no entity match (caution) / No company history (caution) / No web or social presence (bad).
- VERIFIED tag row: label 10px bold; pills `px-2 py-0.5 rounded text-[10px] font-bold` — verified: `bg-positive text-white`; absent: `bg-gray-200 text-gray-500`. Fixture: Mobile/Email/PAN/Name verified; GST, Udyam, TrustSeal absent.
- PROFILE COMPLETENESS: header row label + `44%` bold right; bar `h-1.5` fill `activity`; missing line 10px gray-500 ("Missing: GST, turnover, business type, TrustSeal"). **Live mode:** pct = `pending` chip; show "N present · M absent · E errors" from `pipeline_health` instead (audit §6) — counts are real, percent is not.

### EngagementBand (5)
Left `MetricCardStack`: `grid grid-cols-2 gap-3`; card `bg-white border border-gray-200 rounded-md p-3` — number `text-2xl font-extrabold text-gray-900`, label 10px gray-500. Fixture: 34 Sellers connected / 27 Calls made / 20 Enquiries posted / 27 BuyLeads posted.
Right `MonthlyBars` (hand-rolled SVG, no deps):
- Header: `Monthly demand pattern` 12px bold + annotation inline 11px gray-500 ("— one buying burst in May, steady follow-up since"); legend right: 8px squares navy/activity/caution + labels Calls/Enquiries/BuyLeads 10px gray-600.
- Chart: viewBox `0 0 720 200`, preserveAspectRatio none for width; y-axis 0/4/8/12 with dashed `#D1D5DB` gridlines; 6 month groups (Mar–Aug), 3 bars each `width 12 gap 4`, group gap auto; bar colors = series tokens; May group month label bold; y max = `ceil(max/4)*4`. Bars are `<rect>` from data array only; `<title>` per rect for hover value. Fixture monthly: Mar 2/0/0 · Apr 3/1/1 · May 9/8/10 · Jun 5/4/6 · Jul 4/4/5 · Aug 4/3/5.
- **Live mode:** month buckets are an audit gap → render `EmptyState` ("monthly engagement aggregation pending") unless frontend aggregation from dated rows is later approved; metric cards render only sums that exist.

---

## 6. Empty / loading / error states (per column & page)

Every column component accepts `state: 'loading' | 'error' | 'empty' | 'ready'` + optional slice:
- `loading`: 3 skeleton rows (`animate-pulse bg-gray-100 rounded h-3`) sized like real rows; header stays visible.
- `error`: `text-[11px] text-concern` one-liner ("Risk sources failed — see source health") + retry hint; column keeps its frame so the grid never collapses.
- `empty`: gray-400 11px "No data" + which sources were absent (pass `sources_absent` names when available).
- Page level: fixture mode = always `ready`; live mode (task 9): page shows a navy-top progress strip while webhook in flight, page-level error card with `job_id`/cache-hit note mirroring `AsyncBuyerProfilePage` conventions, and per-column `pending` chips for formula gaps. Each column renders independently — sibling failure never blanks a ready column (board rule from K-1).

---

## 7. Type additions vs plan sketch

Keep the plan's `Persona360Data` shape; add: `VerifyStatus` gains `'pending' | 'not_checked'`; `risk.financial` rows stay `{label, status}`; add optional `risk.rawSign3?: number | 'unknown'`; add optional `internet.counts?: { present: number; absent: number; errors: number }`; `trust` gains `mode?: 'fixture' | 'live'`. Fixture file exports `PERSONA360_FIXTURE: Persona360Data` with the exact mockup values (GLID 268590579, Jayveer Singh, trust 46, risk 58/WATCH, completeness 44, cities 42/33/25, monthly rows above) so @batman can pixel-compare.

---

## 8. Accessibility & misc

- All SVGs `role="img"` + `aria-label` ("Trust score 46 of 100", "Monthly engagement March to August").
- Numeric strings use en-dashes as in mockup (₹8–10 L); fixture stores display strings, components never format currency.
- No new npm deps. Only existing imports allowed: react, lucide-react (icons optional — mockup needs none beyond dots/pills, prefer plain divs).
- File list for K-5: `tokens.ts`, `persona360Types.ts` (lib), `persona360Fixture.ts` (fixtures), `ui.tsx`, `svg.tsx`, `TrustStrip.tsx`, `PersonaHeader.tsx`, `PersonaColumn.tsx`, `SourcingColumn.tsx`, `RiskColumn.tsx`, `InternetColumn.tsx`, `EngagementBand.tsx`, `Persona360Page.tsx`.

---

## 9. Repo-pattern references (read-only)

- Gate placement: `src/App.tsx` gates — new `?persona360=1` gate goes with the others, before `MainApp` fallthrough (K-5 task 2, +2 lines).
- Ring SVG math reference: `src/components/ScoreBadge.tsx` (dasharray pattern) — but NOT its red→green ramp (§2 divergence note).
- Live fetch reference (task 9 only): `src/components/AsyncBuyerProfilePage.tsx` webhook/callback pattern; persona360 live mode targets webhook `buyer-intelligence` per audit.

**Acceptance self-check:** every mockup section 0–5 has a build spec with geometry, tokens, and fixture values; every audit gap has a designated pending/empty rendering; no src/ writes made by this card.
