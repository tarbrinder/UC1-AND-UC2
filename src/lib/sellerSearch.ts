// ── Real seller retrieval (windmill "curated_seller_search_v6_7") ──────────────────────────────────────────
// Query #1 of the seller pipeline. POSTs the buyer's requirement to the windmill workflow and gets back a
// RANKED list of verified sellers (company · city · image · rating · GST · TrustSEAL · tenure · distance).
//
// PROXY: called via `/api/sellersearch` (vite.config rewrites it to the windmill run URL) so there's no CORS.
// LATENCY: the endpoint takes ~30s steady-state, so callers fire it EARLY (owner: the moment the buyer moves
//   from the first spec page to the second) and show a progress experience while it runs; 60s client timeout.
// AUTH (`ak`): a STATIC TEST JWT (owner: "hardcode for now"). The windmill endpoint accepts the request with it
//   in the body. ⚑ DEV-TODO (prod): replace TEST_AK with the LOGGED-IN BUYER'S OWN session token — never ship a
//   shared constant to real buyers.
//
// BUYER LOCATION (fixed 2026-07-28): the buyer's city used to be hardcoded to the Ghaziabad fixture, so every
//   `dist_km` we rendered was "distance from Ghaziabad" no matter where the buyer actually was. The caller now
//   threads the REAL city (`buyerCity`, from the form's delivery/own-location or the IP-detected city) and the
//   fixture is used only when we have nothing real. VERIFIED LIVE against the endpoint (mcat 8361 "Safety Helmet",
//   same seller glusrid 96710703, New Delhi):
//       cityname "Ghaziabad" → dist_km 34.5   ·   "Mumbai" → 1153.2   ·   "Chennai" → 1767.7
//   and "Ghaziabad" with city_id "" returned the SAME 34.5 as "Ghaziabad" with city_id "70740" ⇒ the endpoint
//   geocodes `cityname`; `city_id` is NOT required for distance. So we never invent an id — we send the name
//   alone (city_id '') for any city we don't have a real id for. `dist_km` also comes back sparse (15/20 rows for
//   Ghaziabad, 8/20 for Mumbai) and is null for sellers in the buyer's OWN city — see nearnessKm() below.
import { postJSON } from './api';
import { upsizeImimg } from './enrichment';

const ENDPOINT = '/api/sellersearch';

// STATIC TEST fixture — owner-approved for the demo. See DEV-TODO above for the prod source.
const TEST_AK =
  'eyJhbGciOiJzaGEyNTYiLCJ0eXAiOiJKV1QifQ.eyJhdWQiOiI3KjcqOCo2KjEqIiwiY2R0IjoiMTgtMDYtMjAyNiIsImV4cCI6MTc4MTg2Mjk0MywiaWF0IjoxNzgxNzc2NTQzLCJpc3MiOiJVU0VSIiwic3ViIjoiMjM2NjIzNTg4In0.EfK4KnJ8gqWOThjoGloTWUvc8OU9KRJYs3qoHBTLWZM';
const STATIC_BUYER_CONTEXT = {
  ip: '106.51.171.102',
  source: 'gladmin.buylead.approval',
  city_id: '70740',
  city_data: 'Ghaziabad',
  city_match: 'exact',
  lang_explicit: 'hi',
  geo_country_ip: '106.51.171.102',
  for_country_data: 'IN',
  for_country_type: 'India',
  geo_country_code: 'IN',
  geo_country_name: 'India',
} as const;
// Location FALLBACK only — used when the caller has no real buyer city at all. 70740 is the one city id we
// actually know (Ghaziabad); we never map any other city name to an id.
const STATIC_CITY_ID = '70740';
const STATIC_CITY_NAME = 'Ghaziabad';
const STATIC_BUYER_ID = '215595413';   // auth/test fixture — NOT location. Left as-is.

// ── FIELD INVENTORY, captured live 2026-07-28 (mcat 8361 "Safety Helmet", buyer city Ghaziabad, 40 rows) ───────
// The response is a flat object with EIGHT top-level keys — weights · p1_weights · p2_threshold · is_local_mcat ·
// total_sellers · ranked_sellers · distance_percentiles · total_excluded_threshold — and each `ranked_sellers` row
// carries EXACTLY these 26 keys and no others:
//   glusrid · companyname · city · city_match · dist_km · image · supplier_rating · rating_count ·
//   gstVerifiedFlag · custtype_name · memberSince · member_since_str · CustTypeWt · sources[] ·
//   rank · final_rank · final_score · base_score · product_match · location_boost · is_local_mcat ·
//   p1_breakdown{catalog_match_score, category_match_score, location_match_score, order_value_match_score,
//                + the four matching *_reasoning strings — ALL EMPTY in the capture} ·
//   p2_category_affinity_score · p3_capability_score · llm_reasoning (empty 0/40) · mcat_rank (empty 0/40)
//
// RE-VERIFIED 2026-07-28 against a SECOND, independent live capture (same mcat, 28 rows): the row key set is
// byte-identical — the same 26 keys, nothing added, nothing dropped. Both captures agree on everything below.
//
// ⚑ WHAT IS *NOT* THERE — four deliberate omissions in the UI follow from this, so re-check here before adding a
//   claim to a seller card. A keyword sweep of the whole 41 KB body found ZERO occurrences of isq · spec · attribute
//   · url · link · pdp · pc_item · display_id · price · phone · mobile · contact · tel · msisdn · number · dial ·
//   pns · email:
//   (a) NO per-seller SPEC / ISQ ECHO → a "N of M specs matched" count is NOT SOURCEABLE from this response. It is
//       therefore NOT rendered. `specMatch` below exists, typed and matcher-ready, but stays undefined until the
//       workflow returns the sellers' own spec values. Never populate it by inference.
//   (b) NO product / PDP url and NO item display id → nothing to join a spec sheet on and nothing to link an image
//       to. `image` is a CDN photo, not a page. The numeric segment inside some image paths is NOT a documented
//       item id, and 5/40 rows use image path shapes that have no such segment at all — parsing it would be a
//       guess, so we don't.
//   (c) NO company url or slug → the seller name cannot be linked either. Only `glusrid`, which this repo has no
//       documented url template for.
//   (d) NO PHONE NUMBER OF ANY KIND → a per-seller CALL button has nothing to dial. This is the blocker behind
//       CuratedSellerBoard's Call CTA and it is worth being precise about, because "the seller has a phone, surely
//       it's in there somewhere" is the obvious assumption: BOTH captures returned zero matches for phone ·
//       mobile · contact · tel · msisdn · number · dial · pns · email, AND zero 10-digit Indian-mobile-shaped
//       tokens (`[6-9][0-9]{9}`) anywhere in either body — the only near-misses were seller image filenames of the
//       form `whatsapp-image-2024-03-01-….jpg`, which are photos a supplier uploaded, not contact details.
//       TWO ways to make Call real, and the UI supports both without a rework:
//         · server-side PNS lookup keyed on the `glusrid` these rows already carry (IndiaMART's normal masked-
//           number path) — the board gates Call on the HOST HANDLER, not on a phone field, exactly so this works;
//         · or the workflow echoes a number, which lands on the optional `SellerPick.phone` below.
//       Until one of those exists the button renders disabled with the reason. It is never enabled-and-dead.
//   The cheap server-side fix (for whoever owns the workflow): IndiaMART's own IMSearchAPI — already called by this
//   app in enrichment.fetchProductImages — returns, per listing, `isq: ["Material==PVC", "Color==Yellow", …]`,
//   `desktop_title_url` (a real /proddetail/ page), `catalog_url` (a real company page) and `displayid`, keyed by
//   the SAME `glusrid` these rows carry. Echoing those four fields into `ranked_sellers` makes the spec count and
//   both links real with no frontend guesswork. Joining the two endpoints CLIENT-side does not work and was tested,
//   not assumed: IMSearchAPI returned 4 rows for the same query and 0 of the 40 curated glusrids (0/3 on the top 3)
//   — the two draw from different pools, so the join is empty in practice.

// One mapped seller for the results cards.
export interface SellerResult {
  id: string;                 // glusrid — for the (future) real enquiry/call/WhatsApp dispatch
  name: string;               // companyname
  city: string;
  distanceKm: number | null;  // dist_km from the BUYER's city. Sparse: null for same-city sellers AND for some
                              // rows the endpoint can't geocode — null means UNKNOWN, never 0. See nearnessKm().
  cityMatch: boolean;         // city_match — the ENDPOINT's own same-city verdict. Verified against the capture:
                              // exactly the 4 Ghaziabad rows had city_match true, and all 4 had dist_km null.
  image: string;              // upsized listing photo ('' when none)
  rating: number | null;      // supplier_rating
  reviews: number;            // rating_count
  gst: boolean;               // gstVerifiedFlag === '1'
  trustSeal: boolean;         // TrustSEAL customer type (custtype_name starts with 'TS')
  tenureYears: number | null; // parsed from member_since_str
  rank: number;               // final_rank (already sorted)
  score: number;              // final_score (0..1)
  productMatch: number | null; // product_match (0..1; observed 0.18–0.94). Ranker-internal — parsed, NOT rendered:
                               // a raw relevance score shown as a percentage reads as a precision we don't own.
}

export interface SellerSearchInput {
  productName: string;
  mcatId: string;
  mcatName: string;                    // McatDtl glcat_mcat_name (categoryNameRef)
  specValues: Record<string, string>;  // page-1 buyer ISQ answers (ONLY these — no extras, no smart-questions)
  quantity: string;
  quantityUnit: string;
  qtyMeaningful: boolean;               // qtyIsMeaningful(quantity) — gates Quantity + Quantity Unit
  buyerCity?: string;                   // REAL buyer city — drives every dist_km. Empty ⇒ the Ghaziabad fallback.
  buyerCityId?: string;                 // IndiaMART city id, ONLY if the caller genuinely has one (never guessed).
}

// The city we will actually send + whether it came from the buyer (used for the payload and for honest UI copy).
export function resolveBuyerCity(input: Pick<SellerSearchInput, 'buyerCity' | 'buyerCityId'>) {
  const name = (input.buyerCity ?? '').trim();
  if (!name) return { cityName: STATIC_CITY_NAME, cityId: STATIC_CITY_ID, real: false };
  // Real city → send the NAME. Only pass an id the caller actually owns; '' is accepted (verified) and the
  // endpoint geocodes the name. Never synthesise an id for a name.
  return { cityName: name, cityId: (input.buyerCityId ?? '').trim(), real: true };
}

// isq = filled page-1 buyer specs + Quantity (if a real number) + Quantity Unit (only when Quantity is sent).
function buildIsq(input: SellerSearchInput): Record<string, string> {
  const isq: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.specValues)) {
    if (k && v && String(v).trim()) isq[k] = String(v).trim();
  }
  if (input.qtyMeaningful && input.quantity.trim()) {
    isq['Quantity'] = input.quantity.trim();
    if (input.quantityUnit && input.quantityUnit.trim()) isq['Quantity Unit'] = input.quantityUnit.trim();
  }
  return isq;
}

// The exact windmill payload (all owner-fixed fields hardcoded; only query/mcat/isq are buyer-driven).
export function buildSellerSearchPayload(input: SellerSearchInput) {
  const { cityName, cityId } = resolveBuyerCity(input);
  return {
    offer_id: '',
    query: input.productName,
    nodeflag: '',
    buyer_context: { ...STATIC_BUYER_CONTEXT, city_id: cityId, city_data: cityName },
    debugger: false,
    city_id: cityId,
    mcat_name: input.mcatName,
    buyer_id: STATIC_BUYER_ID,
    isq: buildIsq(input),
    cityname: cityName,
    spec_question: null,
    ak: TEST_AK,
    spec_answer: null,
    search_params: {
      query: input.productName,
      max_price: '',
      min_price: '',
      categoryid: '',
      price_unit: '',
      mcategoryid: input.mcatId,
    },
    mcat_id: input.mcatId,
  };
}

// Raw seller row shape (only the fields we consume; the endpoint returns more — see the FIELD INVENTORY above for
// the complete 26-key list and for the three things it does NOT return).
interface RawSeller {
  glusrid?: string | number;
  companyname?: string;
  city?: string;
  dist_km?: number | null;
  city_match?: boolean;
  image?: string;
  supplier_rating?: number | null;
  rating_count?: number | null;
  gstVerifiedFlag?: string | number;
  custtype_name?: string;
  member_since_str?: string;
  memberSince?: string;
  final_rank?: number;
  final_score?: number;
  product_match?: number | null;
}

// "11 yrs" → 11; an ISO date → whole years since. (App runtime, so Date is fine here.)
function tenureYearsFrom(s?: string): number | null {
  if (!s || !s.trim()) return null;
  const m = /^(\d+)\s*yr/i.exec(s.trim());
  if (m) return parseInt(m[1], 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const yrs = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
    return yrs >= 0 ? yrs : null;
  }
  return null;
}

function mapSeller(r: RawSeller): SellerResult {
  const img = typeof r.image === 'string' && r.image.startsWith('http') ? r.image.replace(/^http:\/\//i, 'https://') : '';
  return {
    id: String(r.glusrid ?? ''),
    name: (r.companyname ?? '').trim(),
    city: (r.city ?? '').trim(),
    distanceKm: typeof r.dist_km === 'number' ? r.dist_km : null,
    cityMatch: r.city_match === true,
    image: img ? upsizeImimg(img) : '',
    rating: typeof r.supplier_rating === 'number' ? r.supplier_rating : null,
    reviews: typeof r.rating_count === 'number' ? r.rating_count : 0,
    gst: String(r.gstVerifiedFlag ?? '') === '1',
    trustSeal: /^TS/i.test(String(r.custtype_name ?? '')),
    tenureYears: tenureYearsFrom(r.member_since_str ?? r.memberSince),
    rank: typeof r.final_rank === 'number' ? r.final_rank : 0,
    score: typeof r.final_score === 'number' ? r.final_score : 0,
    productMatch: typeof r.product_match === 'number' ? r.product_match : null,
  };
}

export interface SellerSearchResponse {
  sellers: SellerResult[];
  total: number;
}

// POST + map. Throws on non-2xx / timeout / abort (caller shows the graceful fallback).
export async function searchSellers(input: SellerSearchInput, timeoutMs = 60000): Promise<SellerSearchResponse> {
  const data = await postJSON<{ ranked_sellers?: RawSeller[]; total_sellers?: number }>(
    ENDPOINT,
    buildSellerSearchPayload(input),
    timeoutMs,
  );
  const ranked = Array.isArray(data?.ranked_sellers) ? data.ranked_sellers : [];
  const sellers = ranked
    .map(mapSeller)
    .filter((s) => s.name)
    .sort((a, b) => a.rank - b.rank);
  return { sellers, total: typeof data?.total_sellers === 'number' ? data.total_sellers : sellers.length };
}

// ── Curation for the results page (owner: "top 3 as is order, and top 3 by location") ────────────────────────
// Two picks of three, then DE-DUPLICATED: a seller that earns both places is shown ONCE (in `best`) carrying both
// ribbons, and `nearest` simply omits it rather than repeating the card. Every ribbon below is derived from a real
// field of the response — there is no price in this payload, so there is deliberately no "lowest price" ribbon.
export const CURATED_PICK_SIZE = 3;
// The nearby row is now a horizontal-scroll RAIL (task #77), not a 3-cell grid — so it carries more than 3 so there is
// something to scroll (3 cards don't overflow a desktop rail). Top stays CURATED_PICK_SIZE; only the near rail grows.
export const NEAR_RAIL_SIZE = 10;

export type RibbonTone = 'match' | 'near' | 'rated' | 'tenure';
export interface SellerRibbon { label: string; tone: RibbonTone }

export interface SellerPick extends SellerResult {
  ribbons: SellerRibbon[];   // earned superlatives (≤2, priority-ordered) — may be empty
  sameCity: boolean;         // seller's city === buyer's city (distance comes back null in that case)
  nearestPick: boolean;      // one of the top-3 by distance
  bestPick: boolean;         // one of the top-3 by final_rank
  // ── THE THREE FIELDS THE RESPONSE DOES NOT CARRY (see FIELD INVENTORY at the top of this file) ──
  // All three are OPTIONAL and are `undefined` with today's payload. The board renders each one ONLY when it is
  // present, so the day the workflow starts echoing the sellers' own isq / desktop_title_url / catalog_url they
  // light up with no UI rework. Populating any of them by inference is a fabrication — don't.
  specMatch?: SpecMatch;     // how many of the buyer's filled specs this seller's OWN specs match. NEVER inferred.
  productUrl?: string;       // real PDP url for the pictured product. Never built from a name or an image path.
  sellerUrl?: string;        // real company-page url.
  phone?: string;            // a REAL dialable number, if one is ever returned — see omission (d) above. Today it
                             // is always undefined. Never synthesise or reformat one from any other field.
}

// ── Buyer-spec ↔ seller-spec matching ─────────────────────────────────────────────────────────────────────────
// Currently UNREACHABLE from the live payload (no seller spec echo) but written, exact and tested so that the
// count can never be produced by a looser method later. TWO rules, both non-negotiable:
//   1. NORMALISED EXACT EQUALITY on both the spec NAME and the spec VALUE — never containment. The same
//      normaliser shape as BrainRFQForm's snapToOption (lowercase, strip everything non-alphanumeric) so
//      "Usage/Application" == "usage application" and "IS 2925" == "IS2925".
//   2. A bare substring match is FORBIDDEN on either side. This repo has shipped three containment bugs
//      ("Capa-CITY"→delivery city, "re-SELLER", "Sweet Potatoes"/"Sweet Packaging Tray") and `npm test` sweeps
//      for the shape. "HDPE" must not match "HDPE-lined ABS", and "5 kVA" must not match "7.5 kVA".
export interface SpecMatch {
  matched: number;           // buyer specs this seller's own specs equal
  total: number;             // buyer specs compared (the filled ones)
  fields: string[];          // WHICH ones matched — so the UI can name them instead of asserting a bare number
}

const specKey = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** IMSearchAPI-style seller specs — `["Material==PVC", "Color==Yellow"]` — into a name→value map. Splits on the
 *  documented `==` delimiter only; a row without it is dropped rather than guessed at. */
export function parseSellerSpecs(rows: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const parts = String(row ?? '').split('==');
    if (parts.length !== 2) continue;
    const name = parts[0].trim(), value = parts[1].trim();
    if (name && value) out[name] = value;
  }
  return out;
}

/** Count the buyer's filled specs that the seller's OWN specs equal. Returns null when the seller has no spec
 *  data at all — an ABSENT count, never a zero, because "0 of 4 matched" is a claim and silence is not. */
export function matchSpecs(
  buyerSpecs: Record<string, string>,
  sellerSpecs: Record<string, string> | null | undefined,
): SpecMatch | null {
  if (!sellerSpecs || !Object.keys(sellerSpecs).length) return null;
  // Normalised lookup table, built once — equality both ways, no scanning for containment.
  const sellerByKey = new Map<string, string>();
  for (const [n, v] of Object.entries(sellerSpecs)) {
    const k = specKey(n);
    if (k && !sellerByKey.has(k)) sellerByKey.set(k, specKey(v));
  }
  const fields: string[] = [];
  let total = 0;
  for (const [name, value] of Object.entries(buyerSpecs)) {
    const bk = specKey(name), bv = specKey(value);
    if (!bk || !bv) continue;         // an unfilled spec is not "unmatched", it was never asked of the seller
    total += 1;
    const sv = sellerByKey.get(bk);
    if (sv !== undefined && sv === bv) fields.push(name);   // exact, normalised. No includes(). No partials.
  }
  if (!total) return null;
  return { matched: fields.length, total, fields };
}

export interface CuratedSellers {
  best: SellerPick[];        // ≤3, final_rank order
  nearest: SellerPick[];     // ≤3 by distance, EXCLUDING anyone already in `best`
  shown: number;             // best.length + nearest.length
  ranked: number;            // how many sellers the search returned
  withDistance: number;      // how many of those we can actually place on a map (honest "sorted by distance" gate)
}

const norm = (s: string) => s.trim().toLowerCase();

// Is this seller in the buyer's own city? PREFER the endpoint's own `city_match` flag over our string compare —
// it is the ranker's own verdict and survives spelling/casing variants our `norm()` would miss. The name compare
// stays as the fallback for rows/older captures without the flag.
function isSameCity(s: SellerResult, buyerCity: string): boolean {
  if (s.cityMatch) return true;
  return !!buyerCity && !!s.city && norm(s.city) === norm(buyerCity);
}

// Distance for SORTING. A positive dist_km is used as-is; a null distance for a seller sitting in the buyer's own
// city is treated as 0 (same-city is real data — city_match / `city`, not a guess); anything else is unknown ⇒ not
// sortable. A null distance must NEVER sort to the front, and must never render as "0 km".
function nearnessKm(s: SellerResult, buyerCity: string): number | null {
  if (typeof s.distanceKm === 'number' && s.distanceKm > 0) return s.distanceKm;
  if (isSameCity(s, buyerCity)) return 0;
  return null;
}

// A rating only counts as a claim once enough people have actually rated. Checked against live data: at a bar of 3
// a 4.8 from FIVE reviewers beat a 4.6 from 92 — technically true, but not a claim worth printing on a card.
const MIN_MEANINGFUL_REVIEWS = 10;
// Tenure only becomes a boast at a level a buyer would care about.
const MIN_BOASTABLE_YEARS = 5;

export function curateSellers(sellers: SellerResult[], buyerCity = ''): CuratedSellers {
  const ranked = sellers.filter((s) => s.name);
  if (!ranked.length) return { best: [], nearest: [], shown: 0, ranked: 0, withDistance: 0 };

  const byRank = [...ranked].sort((a, b) => a.rank - b.rank);
  const best3 = byRank.slice(0, CURATED_PICK_SIZE);

  const placeable = ranked
    .map((s) => ({ s, km: nearnessKm(s, buyerCity) }))
    .filter((x): x is { s: SellerResult; km: number } => x.km !== null)
    .sort((a, b) => (a.km - b.km) || (a.s.rank - b.s.rank));
  const near3 = placeable.slice(0, CURATED_PICK_SIZE).map((x) => x.s);

  const keyOf = (s: SellerResult) => s.id || s.name;
  const bestKeys = new Set(best3.map(keyOf));
  const nearKeys = new Set(near3.map(keyOf));
  const union = [...best3, ...near3.filter((s) => !bestKeys.has(keyOf(s)))];

  // ── Superlatives, each awarded to AT MOST ONE seller, computed over the sellers we actually show ──
  const topRankKey = byRank.length ? keyOf(byRank[0]) : '';
  const nearestKey = placeable.length ? keyOf(placeable[0].s) : '';

  const rateable = union.filter((s) => s.rating != null && s.reviews >= MIN_MEANINGFUL_REVIEWS);
  const topRated = rateable.length
    ? [...rateable].sort((a, b) => (b.rating! - a.rating!) || (b.reviews - a.reviews))[0]
    : null;
  // Only a ribbon if it actually stands out — a tie on rating across every card says nothing.
  const topRatedKey = topRated && rateable.some((s) => s.rating! < topRated.rating!) ? keyOf(topRated) : '';

  const tenured = union.filter((s) => (s.tenureYears ?? 0) >= MIN_BOASTABLE_YEARS);
  const oldest = tenured.length ? [...tenured].sort((a, b) => (b.tenureYears! - a.tenureYears!))[0] : null;
  const oldestKey = oldest && tenured.some((s) => s.tenureYears! < oldest.tenureYears!) ? keyOf(oldest) : '';

  const decorate = (s: SellerResult): SellerPick => {
    const k = keyOf(s);
    const ribbons: SellerRibbon[] = [];
    if (k === topRankKey) ribbons.push({ label: 'Top match', tone: 'match' });
    if (k === nearestKey) ribbons.push({ label: 'Nearest to you', tone: 'near' });
    if (k === topRatedKey) ribbons.push({ label: 'Highest rated', tone: 'rated' });
    if (k === oldestKey) ribbons.push({ label: `${s.tenureYears} yrs in business`, tone: 'tenure' });
    return {
      ...s,
      ribbons: ribbons.slice(0, 2),   // two is the most a 390px card can carry without becoming a sticker sheet
      sameCity: isSameCity(s, buyerCity),
      nearestPick: nearKeys.has(k),
      bestPick: bestKeys.has(k),
    };
  };

  const best = best3.map(decorate);
  const nearest = near3.filter((s) => !bestKeys.has(keyOf(s))).map(decorate);
  return { best, nearest, shown: best.length + nearest.length, ranked: ranked.length, withDistance: placeable.length };
}

// ── The CLOSING BOARD: 3 recommended over 3 nearest, all six in one fold ──────────────────────────────────────
// Owner: "we did the hardwork to make this curated seller API … we go tell my buyer: these are best for you, our
// recommendation; here are nearest to you. Simple." Two rows of three, no carousel, nothing below the fold.
//
// WHY THIS IS A SECOND FUNCTION AND NOT A CHANGE TO curateSellers(): the carousel above tolerates a short list —
// it de-duplicates down to 5 cards and just scrolls less. A FIXED 3x2 grid cannot: dropping a duplicate would
// leave a hole in the layout. So the board fills six DISTINCT cells instead.
//
// THE ONE JUDGEMENT CALL, stated plainly: `near` takes the three nearest sellers that are NOT already in `top`.
// A seller can be both the best-ranked and the closest, and repeating its card twice on one screen is worse than
// useless. The cost is that row 2 is "the nearest others", not literally "the 3 nearest", which on its own would
// let a buyer read row 2's first card as the closest supplier we found. Two things close that gap, and BOTH are
// required — do not drop either when wiring this up:
//   1. every top-row card renders its OWN city and distance, so a nearer seller in row 1 is visible as such;
//   2. `nearDroppedToTop` counts the nearest-3 that were already in top-3. Pass `nearDroppedToTop > 0` to
//      CuratedSellerBoard's `nearestIsInTop` prop. The board then DROPS THE SUPERLATIVE from the row-2 label
//      ("Nearest to you" → "Also near you"), which makes the false reading impossible rather than merely
//      corrected. This used to be carried by a row-2 caption; the owner deleted captions on 2026-07-28, so the
//      label is now the only carrier — if this prop stops being passed, the board can mislead.
// It also lets a caller tell "no near row because nothing was placeable" apart from "no near row because the
// nearest sellers are all already in row 1" — two very different things to say to a buyer.
export interface CuratedBoard {
  top: SellerPick[];          // ≤3, the API's own final_rank order, UNCHANGED — no re-sorting of any kind
  near: SellerPick[];         // ≤3 by real distance, ascending, excluding anyone already in `top`
  ranked: number;             // how many sellers the search returned
  withDistance: number;       // how many are actually placeable — the honest gate on the "nearest" row
  nearDroppedToTop: number;   // nearest-3 members that were already in top-3 (so row 2 shifted down the list)
}

export function curateBoard(sellers: SellerResult[], buyerCity = ''): CuratedBoard {
  const all = curateSellers(sellers, buyerCity);   // reuse the ribbon/superlative logic verbatim — one source
  const ranked = sellers.filter((s) => s.name);
  const keyOf = (s: SellerResult) => s.id || s.name;

  const top = all.best;                             // already final_rank order, already decorated
  const topKeys = new Set(top.map(keyOf));

  // Re-derive the distance order over the FULL list so we can walk PAST the ones already in `top`.
  const placeable = ranked
    .map((s) => ({ s, km: nearnessKm(s, buyerCity) }))
    .filter((x): x is { s: SellerResult; km: number } => x.km !== null)
    .sort((a, b) => (a.km - b.km) || (a.s.rank - b.s.rank));

  const nearRaw = placeable.filter((x) => !topKeys.has(keyOf(x.s))).slice(0, NEAR_RAIL_SIZE);   // #77: the rail carries up to 10 so it actually scrolls (top stays CURATED_PICK_SIZE)
  // Decorate through curateSellers so a board-only card carries the same ribbons the carousel would give it.
  const decorated = new Map([...all.best, ...all.nearest].map((p) => [keyOf(p), p]));
  const near = nearRaw.map((x) => decorated.get(keyOf(x.s)) ?? { ...x.s, ribbons: [], sameCity: isSameCity(x.s, buyerCity), nearestPick: true, bestPick: false });

  const nearDroppedToTop = placeable.slice(0, CURATED_PICK_SIZE).filter((x) => topKeys.has(keyOf(x.s))).length;
  return { top, near, ranked: ranked.length, withDistance: placeable.length, nearDroppedToTop };
}
