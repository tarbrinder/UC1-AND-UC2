// ── Real seller retrieval (windmill "curated_seller_search_v6_7") ──────────────────────────────────────────
// Query #1 of the seller pipeline. POSTs the buyer's requirement to the windmill workflow and gets back a
// RANKED list of verified sellers (company · city · image · rating · GST · TrustSEAL · tenure · distance).
//
// PROXY: called via `/api/sellersearch` (vite.config rewrites it to the windmill run URL) so there's no CORS.
// LATENCY: the endpoint takes ~30s steady-state, so callers fire it EARLY (owner: the moment the buyer moves
//   from the first spec page to the second) and show a progress experience while it runs; 60s client timeout.
// AUTH (`ak`): a STATIC TEST JWT (owner: "hardcode for now"). The windmill endpoint accepts the request with it
//   in the body. ⚑ DEV-TODO (prod): replace TEST_AK with the LOGGED-IN BUYER'S OWN session token — never ship a
//   shared constant to real buyers. buyer_context is a fixed Ghaziabad fixture (owner: sellers always return
//   from Ghaziabad for testing) — in prod this comes from the real buyer's geo/session too.
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
const STATIC_CITY_ID = '70740';
const STATIC_CITY_NAME = 'Ghaziabad';
const STATIC_BUYER_ID = '215595413';

// One mapped seller for the results cards.
export interface SellerResult {
  id: string;                 // glusrid — for the (future) real enquiry/call/WhatsApp dispatch
  name: string;               // companyname
  city: string;
  distanceKm: number | null;  // dist_km (null when same city)
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
  return {
    offer_id: '',
    query: input.productName,
    nodeflag: '',
    buyer_context: STATIC_BUYER_CONTEXT,
    debugger: false,
    city_id: STATIC_CITY_ID,
    mcat_name: input.mcatName,
    buyer_id: STATIC_BUYER_ID,
    isq: buildIsq(input),
    cityname: STATIC_CITY_NAME,
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
