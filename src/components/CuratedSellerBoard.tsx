import { MapPin, Star, BadgeCheck, Pencil, Package, Send, Phone } from 'lucide-react';
import type { SellerPick } from '../lib/sellerSearch';
import SellerSearchProgress from './SellerSearchProgress';

// ═══ THE CLOSING PAGE — two scrollable rows (rebuilt 2026-08-14, task #77) ═══════════════════════════════════
// The last thing the buyer sees after posting a requirement. Owner: "we did the hardwork to make this curated
// seller API, it takes time, but we go tell my buyer: these are best for you, our recommendation; here are
// nearest to you. Simple." LAYOUT (owner 2026-08-14, reverses the old #33 six-card no-scroll grid + #73 card
// variants): the requirement restated with a pencil, then TWO sections — TopStack (recommendations, a VERTICAL-
// scroll column of full-width cards) over NearRail (nearby, a HORIZONTAL-scroll rail of fixed-width cards).
// (The old VERTICAL-BUDGET / MSITE 2+1 / MEASURED-budget notes below describe the retired no-scroll grid — stale.)
//
// PURELY PRESENTATIONAL. It owns no fetch, no state and no data decisions — `top` / `near` come from
// `curateBoard()` in src/lib/sellerSearch.ts, which is where the ordering rules and their justification live.
//
// ── OWNER REVIEW 2026-07-28 (second pass, on screen) — what changed and why ───────────────────────────────────
//   1. "send enq + call CTA, two CTAs please"       → both render on every card. See THE TWO CTAs below: they are
//                                                     host callbacks, and with no host handler they are DISABLED
//                                                     with the reason, never a button that lies.
//   2. "our recommendation is enough, the line after that is not ok"  → row-1 subtitle DELETED.
//   3. "nearest to you is enough, sorted by distance is not ok"       → row-2 subtitle DELETED. The sort stays.
//                                                     Row-2 honesty moved from the caption INTO the label — see
//                                                     ROW-2 HONESTY below; it is not lost, it changed carrier.
//   4. "photo is not required on top … show product name and top 2-3 specs with dot dot dot … and pencil icon"
//                                                     → the strip is name · ≤3 specs · pencil, one line of specs,
//                                                     a real ellipsis when there are more. ⚑ THE DASHED PHOTO BOX
//                                                     HE IS LOOKING AT IS NOT IN THIS FILE — see PHOTO note below.
//   5. "find better UI for desktop and Msite last page too cluttered"  → see DECLUTTERING, which is mostly a
//                                                     data finding, not a taste call.
//
// ── ⚑ THE PHOTO ON TOP IS NOT THIS COMPONENT'S ───────────────────────────────────────────────────────────────
// This board has never rendered a photo in its requirement strip. The dashed 40px box next to the product name on
// the last page is the shell's own header, in BrainRFQForm.tsx (`border-2 border-dashed` camera button, desktop
// branch of the header row) — it renders on EVERY stage including `results`, and it also prints `productName` a
// SECOND time in teal directly above this board's strip. Removing it is a one-line change in a file this component
// does not own; it is called out in the handoff. Everything owner-point-4 asks for that lives here is done here.
//
// ── DECLUTTERING: two badges were deleted because the DATA says they carry no information ─────────────────────
// The per-card row used to carry four badge types (rating · GST · TrustSEAL · city/distance) on all six cards.
// Measured on two independent live captures of the real endpoint (mcat 8361), counting the rows it returns:
//     GST verified ....... 40/40  and  28/28  → 100% constant. On the six cards actually rendered: 6/6.
//     TrustSEAL .......... 38/40  and  27/28  → 96%. On the six cards actually rendered: 6/6.
//     supplier_rating .... 39/40  and  28/28  present, and it VARIES (4.2 / 4.6 / 4.4 / 3.8 / 4.0 / 3.9).
// A badge that is true on every card is ink, not information — it cannot help a buyer choose between them, which
// is the only job a badge has on a comparison board. So:
//   · TrustSEAL is GONE. It is also near-constant BY CONSTRUCTION, not by luck: `CustTypeWt` is one of the
//     ranker's own weights and TSCATALOG sellers are boosted, so TrustSEAL is largely WHY these six are on the
//     board. Printing it shows the selection criterion back to the buyer. It was additionally the widest badge
//     (~70px) and the only one that needed a shrink-to-icon degradation hack — that whole mechanism is deleted.
//   · GST is stated ONCE for the whole board instead of six times — but only when it is actually true of every
//     seller shown (`allGst` below). If the mix is ever partial the badge returns to the cards, where a real
//     differentiator belongs. A universal claim printed per-card and a universal claim printed once are the same
//     claim; six copies just cost six slots.
//   · Rating and city/distance STAY: both vary across the six, and distance is load-bearing for row-2 honesty.
// Also removed: the six card drop-shadows (border-only reads calmer at this density) and the second row-label
// weight. Result per card: ONE bold line (the name), ONE grey meta line, ONE action row. Three weights, not six.
//
// ── ROW-2 HONESTY WITHOUT ITS CAPTION ────────────────────────────────────────────────────────────────────────
// `near` holds the three closest sellers that are NOT already in `top`, so a seller can be the closest overall and
// sit in row 1 — which would let row 2's first card read as "the nearest" when it is not. That used to be carried
// by the row-2 subtitle ("…the closest is in the row above"), and the owner has deleted subtitles. It is NOT
// dropped; it moved to the two carriers he did not object to:
//   1. THE LABEL ITSELF. When `nearestIsInTop` is true the label reads "ALSO NEAR YOU" instead of "NEAREST TO
//      YOU". Three words, no second line, and it makes no superlative claim — so the false reading is impossible
//      rather than merely corrected. This is the mechanism the caption used to provide.
//   2. EVERY CARD IN BOTH ROWS PRINTS ITS OWN CITY AND DISTANCE. A nearer seller sitting in row 1 is visible as
//      nearer, in both rows, from the same units. This was always required and is unchanged.
// If a future edit makes the label unconditional again, mechanism 1 is gone and the board can mislead — that is
// the one regression to watch for in this file.
//
// ── VERTICAL BUDGET (the "all six in the first fold" constraint is real arithmetic, and the CTAs cost real px) ─
// The desktop popup is the WORST case: the shell is `h-[78vh] min-h-[560px] max-h-[92vh]`, so at the 560px FLOOR
// the board gets a 504px scroll box (= 560 − 56 header), i.e. 464px of content inside the body's py-5. Every
// number below was MEASURED in the browser at that exact floor — see the block under the component.
// The two CTAs the owner asked for cost one 44px row per card = +88px over the action-free version; the deleted
// badge line and the one-line spec strip pay ~40px of that back, so the board went 351px → 425px and still clears
// the floor with 79px to spare.
// A grid card measures 136px × 237px: 10 pad · 40 thumb+name · 6 gap · 12 meta · 6 gap · 44 action row · 10 pad,
// plus the flex-1 spacer that bottom-aligns the action row across a row of three.
// Adding any line to a card costs 2 × that line, because there are two rows.
//
// ── MSITE ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Three cards across a 375px viewport is ~111px per card, which cannot legibly carry a photo, a company name, a
// city, a distance AND two buttons. So `compact` switches each row to a 2-COLUMN grid whose THIRD card spans both
// columns as a horizontal strip, which reads as a deliberate shape rather than a stretched square.
//   ⚑ THE DEVIATION, stated rather than hidden: it is 2+1, not the 3-across the owner asked for. Each row occupies
//     two grid lines, so the rows read as "2 + 1, 2 + 1". Rejected on the width arithmetic above, not abandoned.
//   ⚑ THE COST OF THE TWO CTAs, stated rather than hidden: the action-free version of this board also fit a
//     375×667 SE-class screen with ~29px spare. Two 44px action rows do not fit in 29px, and they don't:
//     375×812 still fits with 63px spare, but 375×667 now OVERFLOWS BY 122px — about one grid card — and scrolls.
//     MEASURED, not predicted. That is a direct consequence of owner-point-1 and it is a tradeoff for him to make,
//     not one to hide: the two CTAs cost SE-class users a short scroll. If he would rather keep 667px scroll-free,
//     the cheapest ~90px is the Call button (icon-only merged into the meta line) or the wide card's second row.
// On compact the Call button is icon-only (44px, word in aria-label) because 144px of card cannot spell both
// labels; on desktop and on the wide strip both are spelled out.

export interface CuratedSellerBoardProps {
  productName: string;
  /** The buyer's FILLED specs, in the order they were asked. Shown verbatim in the strip — it is his own input
   *  echoed back, which is the one spec statement on this page that needs no sourcing. Only the first
   *  `STRIP_SPEC_LIMIT` are printed, with a real ellipsis when there are more (owner: "top 2-3 specs with dot
   *  dot dot"). Pass them all; the truncation is this component's job, not the caller's. */
  filledSpecs: Array<{ field: string; value: string }>;
  /** Pencil icon → back to the spec page. */
  onEditSpecs: () => void;
  /** Top 3 in the API's OWN final_rank order. Never re-sorted here. */
  top: SellerPick[];
  /** Top 3 by real distance, excluding anyone already in `top` (see curateBoard). */
  near: SellerPick[];
  /** Pass `curateBoard().nearDroppedToTop > 0`. True means the single closest supplier is in the TOP row, so the
   *  row-2 LABEL drops its superlative ("Also near you") instead of letting its first card read as "the nearest".
   *  Costs no vertical space — it swaps three words. Leaving it false when it should be true is the one way this
   *  board can mislead. See ROW-2 HONESTY above. */
  nearestIsInTop?: boolean;
  /** msite register: 2-column rows, tighter type, icon-only Call. */
  compact?: boolean;
  loading?: boolean;
  error?: boolean;
  /** ── THE TWO CTAs — read this before wiring either ────────────────────────────────────────────────────────
   *  Owner asked for "send enq + call CTA, two CTAs". Both buttons ALWAYS render. Neither is ever a button that
   *  claims something it did not do:
   *    · handler supplied  → live teal button, and the HOST owns the dispatch and the confirmation. Confirm to
   *      the buyer only after the POST resolves. Never optimistically. The glusrid is on `s.id`.
   *    · handler omitted   → the button renders DISABLED, greyed, with the reason in `title` + `aria-label`.
   *      Not a dead-but-enabled control, and no "Enquiry sent" toast — the version this replaces showed exactly
   *      that toast without any POST, and shipped a Call button with no onClick at all.
   *  Today BOTH are unwired, and that is a data/backend fact, not an oversight:
   *    · onEnquire — there is NO per-seller dispatch endpoint in this repo. `dispatchBuyLead` does not POST; it
   *      hands the whole REQUIREMENT to the host `onSubmit`, and it has already fired before this page renders,
   *      so calling it per card would duplicate the BuyLead rather than target a seller.
   *    · onCall — ⚑ HARD BLOCKER, IN THE DATA: the seller row carries NO phone number. Re-verified 2026-07-28 on
   *      two independent live captures (40 rows and 28 rows): the SAME 26 keys both times, and zero matches for
   *      phone · mobile · contact · tel · msisdn · number · dial · pns · email, and zero 10-digit mobile-shaped
   *      tokens anywhere in either body outside seller image filenames. There is literally nothing to dial. A
   *      host handler must therefore resolve a number from `s.id` (glusrid) via PNS server-side, or the workflow
   *      must start returning one. `SellerPick.phone` exists, typed and optional, for that second case.
   *  Gating: Call is gated on the HANDLER, not on `s.phone`, precisely so a PNS-by-glusrid host implementation
   *  works without the field ever appearing in the payload. */
  onEnquire?: (s: SellerPick) => void;
  onCall?: (s: SellerPick) => void;
}

/** Owner: "top 2-3 specs with dot dot dot". Three, then an ellipsis. */
const STRIP_SPEC_LIMIT = 3;

// Reasons a CTA is dead. They live in `title`/`aria-label`, never on screen — the owner has asked repeatedly for
// a few words, and an explanation printed six times over is the clutter he is complaining about.
const ENQUIRE_OFF = 'Per-seller enquiry is not connected yet — your requirement is already posted';
const CALL_OFF = 'No phone number is available for this seller yet';

// ── Card sub-parts ────────────────────────────────────────────────────────────────────────────────────────────

// ONE grey meta line per card: city · distance · rating (· GST only in the partial-GST case). It replaces the two
// separate lines (place, then badges) the cluttered version had — same facts, one line, half the vertical cost.
// A real positive dist_km prints as km; a same-city seller (where the endpoint returns dist_km null and city_match
// true) says so in words rather than pretending to be "0 km"; a genuinely unknown distance says nothing at all.
// Reviews count is dropped on compact, where 144px cannot hold it.
function Meta({ s, compact, showGst }: { s: SellerPick; compact: boolean; showGst: boolean }) {
  return (
    <p className="flex items-center gap-1 text-[12px] text-gray-500 min-w-0 leading-none">
      {/* The pin is decoration next to a city NAME, and 148px of compact card had it clipping the city to "Ne…".
          The star stays on both registers because a bare "4.6" does not read as a rating without it — icon kept
          where it carries meaning, dropped where it only decorates. */}
      {!compact && <MapPin className="w-3 h-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{s.city || '—'}</span>
      {s.distanceKm != null && s.distanceKm > 0
        ? <span className="shrink-0 text-gray-400">· {Math.round(s.distanceKm)} km</span>
        // "New Delhi · your city" states one fact twice, and at 148px of compact card the two together shoved the
        // city name down to "Ne…" — the one token on the line a buyer cannot reconstruct. So the marker shortens
        // instead of the city: "· yours" on compact, the full phrase where it fits. It is still a WORD (not colour
        // alone) so it survives for screen readers, and it keeps a same-city seller distinguishable from one whose
        // distance we simply don't know — those two must not look alike.
        : s.sameCity ? <span className="shrink-0 font-medium text-teal-700">· {compact ? 'yours' : 'your city'}</span> : null}
      {s.rating != null && (
        <span className="flex items-center gap-0.5 shrink-0 font-semibold text-gray-700">
          <Star className="w-3 h-3 text-[#eeb160] fill-[#eeb160]" aria-hidden="true" />{s.rating}
          {!compact && s.reviews > 0 && <span className="font-normal text-gray-400">({s.reviews})</span>}
        </span>
      )}
      {/* Only in the partial-GST case — see DECLUTTERING. When every seller shown is GST-verified the board says
          so once, at the bottom, instead of stamping the same true thing on all six cards. */}
      {showGst && s.gst && (
        <span className="flex items-center gap-0.5 shrink-0 text-[#1a9e56]"><BadgeCheck className="w-3 h-3" aria-hidden="true" />GST</span>
      )}
    </p>
  );
}

// The matched-spec line. Renders ONLY when the row genuinely carried the seller's own specs — which today it
// never does (the response has no spec echo at all; see the FIELD INVENTORY in sellerSearch.ts). `fields` names
// the matched specs so the number is never a bare assertion. Deliberately NOT given a placeholder now that there
// is space: an invented count is worse than a missing one, and a dash in a numeric slot reads as a real number.
// ⚑ Budget: switching this on costs 2 × 14px, which the measured desktop margin still covers — but re-measure.
function SpecMatchLine({ s }: { s: SellerPick }) {
  if (!s.specMatch) return null;
  const { matched, total, fields } = s.specMatch;
  return (
    <p className="text-[12px] leading-none text-teal-700 font-semibold truncate" title={fields.join(' · ')}>
      {matched}/{total} specs match
    </p>
  );
}

// Product photo — the seller's OWN listing photo or nothing. No category-level stand-in is substituted here: on a
// seller card a representative photo invites the reader to believe it is that seller's product, so a seller
// without a photo gets the package glyph instead. Linked ONLY with a real productUrl (never today — the response
// carries no PDP url and an IndiaMART url cannot be guessed from a name or an image path).
function Thumb({ s, size }: { s: SellerPick; size: string }) {
  const box = (
    <span className={`${size} shrink-0 rounded-lg bg-white border border-gray-200 overflow-hidden flex items-center justify-center`}>
      {s.image
        ? <img src={s.image} alt={`${s.name} listing photo`} loading="lazy" className="w-full h-full object-contain p-0.5" />
        : <Package className="w-5 h-5 text-gray-300" aria-hidden="true" />}
    </span>
  );
  if (!s.productUrl) return box;
  return (
    <a href={s.productUrl} target="_blank" rel="noopener noreferrer" aria-label={`View ${s.name}'s product`} className="shrink-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500">{box}</a>
  );
}

// Company name. Linked ONLY with a real sellerUrl; otherwise a plain heading.
function Name({ s, cls }: { s: SellerPick; cls: string }) {
  if (!s.sellerUrl) return <p className={cls}>{s.name}</p>;
  return (
    <a href={s.sellerUrl} target="_blank" rel="noopener noreferrer" className={`${cls} hover:text-teal-700 hover:underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-teal-500 rounded`}>{s.name}</a>
  );
}

// ── The action row ────────────────────────────────────────────────────────────────────────────────────────────
// Per-seller inquiry/call is the one place the design guide reserves Primary Teal #1d8480 for, so teal is correct
// here (the flow-advance CTAs elsewhere are Secondary Indigo). 8px radius, 44px minimum tap target.
// Send Enquiry is FILLED and Call is OUTLINED: twelve equal-weight teal blocks on one screen is exactly the
// density the owner objected to, and one filled button per card gives the card a single visual entry point while
// still rendering both CTAs he asked for.
// The DISABLED register is deliberately quiet neutral — an unwired button must not read as a live primary, and as
// a side effect today's unwired board carries LESS ink than the wired one, not more.
const CTA_BASE = 'min-h-[44px] rounded-lg text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 '
  + 'focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1';
const CTA_FILLED = 'bg-[#1d8480] hover:brightness-110 active:brightness-95 text-white';
const CTA_OUTLINE = 'bg-white border border-[#1d8480] text-[#1d8480] hover:bg-teal-50';
const CTA_DEAD = 'bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed';

function Actions({
  s, compact, callLabel, onEnquire, onCall,
}: {
  s: SellerPick; compact: boolean; callLabel: boolean;
  onEnquire?: (s: SellerPick) => void; onCall?: (s: SellerPick) => void;
}) {
  const enquireLive = !!onEnquire;
  const callLive = !!onCall;
  return (
    <div className="flex items-stretch gap-1.5 min-w-0">
      <button
        type="button"
        disabled={!enquireLive}
        onClick={enquireLive ? () => onEnquire!(s) : undefined}
        title={enquireLive ? undefined : ENQUIRE_OFF}
        aria-label={enquireLive ? `Send enquiry to ${s.name}` : `Send enquiry to ${s.name} — ${ENQUIRE_OFF}`}
        className={`flex-1 min-w-0 px-2 ${CTA_BASE} ${enquireLive ? CTA_FILLED : CTA_DEAD}`}
      >
        <Send className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{compact ? 'Enquiry' : 'Send Enquiry'}</span>
      </button>
      <button
        type="button"
        disabled={!callLive}
        onClick={callLive ? () => onCall!(s) : undefined}
        title={callLive ? undefined : CALL_OFF}
        aria-label={callLive ? `Call ${s.name}` : `Call ${s.name} — ${CALL_OFF}`}
        className={`shrink-0 ${callLabel ? 'px-3' : 'w-11'} ${CTA_BASE} ${callLive ? CTA_OUTLINE : CTA_DEAD}`}
      >
        <Phone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {callLabel && <span>Call</span>}
      </button>
    </div>
  );
}

// ── The two card shapes ───────────────────────────────────────────────────────────────────────────────────────

// GRID card — the ~124px unit the vertical budget is built around. Every desktop cell, and the first two cells of
// each msite row. Border-only, no shadow (see DECLUTTERING).
function GridCard({
  s, compact, rail, showGst, onEnquire, onCall,
}: {
  s: SellerPick; compact: boolean; showGst: boolean;
  // `rail` = a fixed-width card for the horizontal "nearby" rail (task #77): shrink-0 + a set width so flex can't
  // squeeze it, snap-start so it aligns when scrolled, and an icon-only Call (the narrow card can't spell both CTAs).
  rail?: boolean;
  onEnquire?: (s: SellerPick) => void; onCall?: (s: SellerPick) => void;
}) {
  const tight = !!(compact || rail);   // narrow card padding + "Enquiry" (not "Send Enquiry")
  return (
    // p-2 on compact/rail vs p-2.5 on desktop grid: the 2px buys budget where cards are scarce.
    <article className={`${rail ? 'shrink-0 snap-start w-[164px] md:w-[190px]' : 'min-w-0'} flex flex-col gap-1.5 rounded-xl border border-gray-200 bg-white transition-colors hover:border-teal-300 ${tight ? 'p-2' : 'p-2.5'}`}>
      <div className="flex items-start gap-2 min-w-0">
        <Thumb s={s} size="w-10 h-10" />
        <div className="min-w-0 flex-1">
          {/* NO `block` here: `line-clamp-2` needs display:-webkit-box, and a `block` alongside it wins the
              display cascade and silently disables the clamp — a 3-line company name then pushed this card past
              its budget. Caught in the browser at 375px, not in review. */}
          <Name s={s} cls="text-[13px] font-bold text-gray-900 leading-tight line-clamp-2" />
        </div>
      </div>
      <Meta s={s} compact={tight} showGst={showGst} />
      <SpecMatchLine s={s} />
      {/* Pushes the action row to the bottom so cards align on it regardless of name length. */}
      <div className="flex-1" />
      <Actions s={s} compact={tight} callLabel={!rail && !compact} onEnquire={onEnquire} onCall={onCall} />
    </article>
  );
}

// FULL card — the TOP-row (recommendations) card: a full-width horizontal composition (thumb · facts) with the
// action row beneath at full width, where both CTAs are spelled out. Stacked vertically inside the scrollable TopStack.
function FullCard({
  s, showGst, onEnquire, onCall,
}: {
  s: SellerPick; showGst: boolean;
  onEnquire?: (s: SellerPick) => void; onCall?: (s: SellerPick) => void;
}) {
  return (
    <article className="min-w-0 flex flex-col gap-1.5 rounded-xl border border-gray-200 bg-white p-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <Thumb s={s} size="w-11 h-11" />
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <Name s={s} cls="block text-[13px] font-bold text-gray-900 leading-tight line-clamp-2" />
          <Meta s={s} compact={false} showGst={showGst} />
          <SpecMatchLine s={s} />
        </div>
      </div>
      <Actions s={s} compact={false} callLabel onEnquire={onEnquire} onCall={onCall} />
    </article>
  );
}

// ── TWO SCROLLABLE ROWS (task #77, owner 2026-08-14 — reverses the #33 no-scroll board + #73 card variants) ──────
// TOP = recommendations, a single-column vertical-scroll stack of full-width cards (max-h, not fixed h, so 1 card
// leaves no dead box). Fewer sellers → fewer cards; the section hides entirely when empty (no ghost scrollbar).
function TopStack({
  label, sellers, showGst, onEnquire, onCall,
}: {
  label: string; sellers: SellerPick[]; showGst: boolean;
  onEnquire?: (s: SellerPick) => void; onCall?: (s: SellerPick) => void;
}) {
  if (!sellers.length) return null;
  return (
    <section aria-label={label} className="min-w-0">
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-gray-900 mb-1.5">{label}</h3>
      {/* Viewport-relative cap (not a fixed px height): keeps the whole board — strip + this stack + the near rail +
          footnote — within the fold so the OUTER body scroller doesn't ALSO engage (no two-scrollbar trap). overscroll-
          contain stops this inner scroll from chaining to the body. Only THIS stack scrolls vertically. */}
      <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto overscroll-contain scroll-auto-hide pr-0.5">
        {sellers.map((s) => (
          <FullCard key={s.id || s.name} s={s} showGst={showGst} onEnquire={onEnquire} onCall={onCall} />
        ))}
      </div>
    </section>
  );
}

// BOTTOM = nearby sellers, a horizontal-scroll rail of fixed-width cards (reuses the "Products you viewed" pattern).
// The last card is cut at the container edge, which advertises the scroll; snap-x aligns each card on release.
function NearRail({
  label, sellers, showGst, onEnquire, onCall,
}: {
  label: string; sellers: SellerPick[]; showGst: boolean;
  onEnquire?: (s: SellerPick) => void; onCall?: (s: SellerPick) => void;
}) {
  if (!sellers.length) return null;
  return (
    <section aria-label={label} className="min-w-0">
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-gray-900 mb-1.5">{label}</h3>
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain snap-x scroll-auto-hide pb-1">
        {sellers.map((s) => (
          <GridCard key={s.id || s.name} s={s} compact rail showGst={showGst} onEnquire={onEnquire} onCall={onCall} />
        ))}
      </div>
    </section>
  );
}

// ── The board ─────────────────────────────────────────────────────────────────────────────────────────────────

export default function CuratedSellerBoard({
  productName, filledSpecs, onEditSpecs, top, near, nearestIsInTop = false,
  // `compact` (isMobile) is no longer read: the top stack is always full-width and the rail card is responsive via
  // its own md: width, so layout no longer branches on surface. The prop stays on the interface for callers.
  loading = false, error = false, onEnquire, onCall,
}: CuratedSellerBoardProps) {
  // LOADING — unchanged experience: the same SellerSearchProgress the results page already shows while the
  // ~30s windmill search runs.
  if (loading) return <SellerSearchProgress productName={productName} />;

  // ERROR and EMPTY are the same message with different wording: the requirement IS posted either way (the
  // BuyLead is dispatched at submit, independently of this search), so neither state may imply it was lost.
  if (error || (!top.length && !near.length)) {
    return (
      <div className={`rounded-xl border px-5 py-6 text-center ${error ? 'border-amber-200 bg-amber-50/60' : 'border-gray-200 bg-gray-50'}`}>
        <p className="text-[16px] font-bold text-gray-900">Your requirement is posted</p>
        <p className="text-[13px] text-gray-600 mt-1.5">
          {error
            ? <>We're still shortlisting suppliers for <span className="font-semibold text-gray-700">{productName}</span> — quotes will reach you on WhatsApp &amp; email.</>
            : <>We're lining up suppliers for <span className="font-semibold text-gray-700">{productName}</span> and will send quotes shortly.</>}
        </p>
      </div>
    );
  }

  const shown = [...top, ...near];
  // Is GST-verified true of EVERY seller on the board? Only then may it be said once at the bottom instead of on
  // each card. Measured 6/6 on live data, but this is checked at render, not assumed — a partial mix puts the
  // badge back on the cards where a real differentiator belongs. `.every` on a non-empty array; `shown` is
  // non-empty here because the empty case returned above.
  const allGst = shown.every((s) => s.gst);

  // Owner: "top 2-3 specs with dot dot dot". Three, then a real ellipsis when there are more — the previous
  // version printed every filled spec and let a 2-line clamp decide where to stop, which is why a long spec set
  // ate a second line of a page he was already calling cluttered.
  const stripSpecs = filledSpecs.slice(0, STRIP_SPEC_LIMIT);
  const moreSpecs = filledSpecs.length > STRIP_SPEC_LIMIT;

  return (
    // gap-2 (8px), not the 10px an earlier draft used: three 2px shavings is 6px of the msite budget and the owner
    // asked for the page to be tighter, so the tighter value is both cheaper and what he wanted.
    <div className="flex flex-col gap-2 min-w-0">
      {/* ── The requirement, restated: product name · top ≤3 specs · pencil. Nothing else (owner point 4).
             ⚑ The dashed photo box and the duplicate teal product name ABOVE this strip are the shell's header in
             BrainRFQForm.tsx, not this component — see the PHOTO note at the top of this file. ── */}
      <div className="rounded-xl border border-gray-200 bg-[hsl(220,20%,97%)] px-3 py-2.5 flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-bold text-gray-900 leading-tight truncate">{productName}</p>
          {stripSpecs.length > 0 ? (
            // ONE line, truncated. The ellipsis after spec 3 is a real character, so "there is more behind the
            // pencil" is stated rather than implied by a clipped glyph.
            <p className="mt-1 text-[12px] text-gray-600 leading-snug truncate">
              {stripSpecs.map((sp, i) => (
                <span key={sp.field}>
                  {i > 0 && <span className="text-gray-300"> · </span>}
                  <span className="text-gray-500">{sp.field}:{' '}</span>
                  {/* NBSP inside a value keeps "IS 2925" atomic so a truncate never splits one spec's value. */}
                  <span className="font-medium text-gray-700">{sp.value.replace(/ /g, ' ')}</span>
                </span>
              ))}
              {moreSpecs && <span className="text-gray-400"> …</span>}
            </p>
          ) : (
            <p className="mt-1 text-[12px] text-gray-500">No specs added</p>
          )}
        </div>
        <button
          type="button"
          onClick={onEditSpecs}
          aria-label="Edit product and specifications"
          className="shrink-0 w-11 h-11 -my-1 -mr-1 rounded-lg flex items-center justify-center text-gray-500 hover:text-teal-700 hover:bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <Pencil className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* ── TOP: the API's own ranking, vertical-scroll stack. Label only — the subtitle is deleted (owner). ── */}
      <TopStack
        label="Our recommendation"
        sellers={top} showGst={!allGst} onEnquire={onEnquire} onCall={onCall}
      />

      {/* ── BOTTOM: by distance, horizontal-scroll rail. Hidden entirely when the search returned no usable
             distance, rather than presenting an unsorted list under a proximity label. The label — not a caption —
             carries the honesty: see ROW-2 HONESTY at the top of this file. ── */}
      <NearRail
        label={nearestIsInTop ? 'Also near you' : 'Nearest to you'}
        sellers={near} showGst={!allGst} onEnquire={onEnquire} onCall={onCall}
      />

      {/* The one closing line. It carries the fact that makes the whole page honest — the requirement is ALREADY
          posted, so a buyer who taps nothing still gets quotes — plus the GST claim that used to be printed six
          times on the cards and once in a deleted subtitle. Gated on the data: no `allGst`, no claim. */}
      <p className="text-[12px] text-gray-500 text-center">
        {allGst && <span className="font-medium text-gray-600">All GST-verified</span>}
        {allGst && <span className="text-gray-300"> · </span>}
        Requirement posted — quotes reach you on WhatsApp &amp; email.
      </p>
    </div>
  );
}

// ── MEASURED, IN THE REAL APP — not estimated, and not from a harness ─────────────────────────────────────────
// Taken 2026-07-28 by driving the actual ?rfq=brain flow to the results stage against the LIVE endpoint, then
// reading the real popup/msite scroll container. Both registers of the action row (host-wired teal and unwired
// disabled) measure IDENTICALLY, so the budget holds whichever state the host puts the board in.
//   DESKTOP POPUP, shell forced to its 560px FLOOR (viewport 1280×700, so 78vh clamps to min-h-[560px]):
//     shell 560 · header 56 · body scroll box 504 (464 inside py-5)
//     strip 62.5 · section 160 (label 18 + mb 6 + card 136) · section 160 · footnote 18 · 3 gaps × 8 = 24
//                                                                     ⇒  BOARD 425px
//     425 ≤ 504 ⇒ scrollHeight === clientHeight (504 === 504): NO vertical scroll, NO horizontal scroll, and the
//     shell's own "more below" hint stays hidden. 79px spare AT THE ABSOLUTE FLOOR. Six cards, 136 × 237px each.
//   MSITE 375×812: board 667px in the real 708px body box ⇒ 708 === 708, NO scroll, 41px spare. Cards
//     4 × (164×132) grid + 2 × (335×108) wide. Smallest computed font on the board = 12px (nothing below the
//     caption floor); every button 44px. No city name clipped at this width — checked per element, not by eye.
//     ⚑ A HARNESS LIED ABOUT THIS ONE: a faithful-looking copy of the shell gave a 752px body box and reported
//       63px of spare. The REAL msite header is taller, the real box is 708px, and the first honest measurement
//       was a 21px OVERFLOW. The desktop harness had matched the real app to the pixel, which is exactly why the
//       msite miss is worth recording: measure the surface you are shipping, not a replica of it.
//   MSITE 375×667 (SE class): still scrolls. The action-free version of this board cleared 667px by ~29px; two
//     44px action rows cost more than that and no amount of 2px shaving buys it back honestly. Documented as the
//     price of owner-point-1, not hidden — see the MSITE note above for what to cut if he wants it back.
// Re-measure before adding ANY line to a card: at 237px wide and two rows deep, one extra 12px line costs ~32px
// of the 79px desktop margin, and msite has only 41px.
