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

// One mapped seller for the results cards.
export interface SellerResult {
  id: string;                 // glusrid — for the (future) real enquiry/call/WhatsApp dispatch
  name: string;               // companyname
  city: string;
  distanceKm: number | null;  // dist_km from the BUYER's city. Sparse: null for same-city sellers AND for some
                              // rows the endpoint can't geocode — null means UNKNOWN, never 0. See nearnessKm().
  image: string;              // upsized listing photo ('' when none)
  rating: number | null;      // supplier_rating
  reviews: number;            // rating_count
  gst: boolean;               // gstVerifiedFlag === '1'
  trustSeal: boolean;         // TrustSEAL customer type (custtype_name starts with 'TS')
  tenureYears: number | null; // parsed from member_since_str
  rank: number;               // final_rank (already sorted)
  score: number;              // final_score (0..1)
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

// Raw seller row shape (only the fields we consume; the endpoint returns more, incl. score breakdowns).
interface RawSeller {
  glusrid?: string | number;
  companyname?: string;
  city?: string;
  dist_km?: number | null;
  image?: string;
  supplier_rating?: number | null;
  rating_count?: number | null;
  gstVerifiedFlag?: string | number;
  custtype_name?: string;
  member_since_str?: string;
  memberSince?: string;
  final_rank?: number;
  final_score?: number;
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
    image: img ? upsizeImimg(img) : '',
    rating: typeof r.supplier_rating === 'number' ? r.supplier_rating : null,
    reviews: typeof r.rating_count === 'number' ? r.rating_count : 0,
    gst: String(r.gstVerifiedFlag ?? '') === '1',
    trustSeal: /^TS/i.test(String(r.custtype_name ?? '')),
    tenureYears: tenureYearsFrom(r.member_since_str ?? r.memberSince),
    rank: typeof r.final_rank === 'number' ? r.final_rank : 0,
    score: typeof r.final_score === 'number' ? r.final_score : 0,
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

export type RibbonTone = 'match' | 'near' | 'rated' | 'tenure';
export interface SellerRibbon { label: string; tone: RibbonTone }

export interface SellerPick extends SellerResult {
  ribbons: SellerRibbon[];   // earned superlatives (≤2, priority-ordered) — may be empty
  sameCity: boolean;         // seller's city === buyer's city (distance comes back null in that case)
  nearestPick: boolean;      // one of the top-3 by distance
  bestPick: boolean;         // one of the top-3 by final_rank
}

export interface CuratedSellers {
  best: SellerPick[];        // ≤3, final_rank order
  nearest: SellerPick[];     // ≤3 by distance, EXCLUDING anyone already in `best`
  shown: number;             // best.length + nearest.length
  ranked: number;            // how many sellers the search returned
  withDistance: number;      // how many of those we can actually place on a map (honest "sorted by distance" gate)
}

const norm = (s: string) => s.trim().toLowerCase();

// Distance for SORTING. A positive dist_km is used as-is; a null distance for a seller sitting in the buyer's own
// city is treated as 0 (same-city is real data from `city`, not a guess); anything else is unknown ⇒ not sortable.
function nearnessKm(s: SellerResult, buyerCity: string): number | null {
  if (typeof s.distanceKm === 'number' && s.distanceKm > 0) return s.distanceKm;
  if (buyerCity && s.city && norm(s.city) === norm(buyerCity)) return 0;
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
      sameCity: !!buyerCity && !!s.city && norm(s.city) === norm(buyerCity),
      nearestPick: nearKeys.has(k),
      bestPick: bestKeys.has(k),
    };
  };

  const best = best3.map(decorate);
  const nearest = near3.filter((s) => !bestKeys.has(keyOf(s))).map(decorate);
  return { best, nearest, shown: best.length + nearest.length, ranked: ranked.length, withDistance: placeable.length };
}
