import type { Segment } from './types';

const SERVICE_HINTS =
  /\b(service|services|repair|installation|consult\w*|rental|hire|amc|maintenance|transport|logistics|fabrication|job\s*work|labour|contractor|printing|designing)\b/i;
const CAPITAL_HINTS =
  /\b(machine|machinery|plant|generator|genset|compressor|lathe|cnc|press|furnace|boiler|forklift|crane|equipment|moulding|molding|turbine|chiller|conveyor)\b/i;

/**
 * Derive the buyer/category segment from whatever signals exist so far.
 * Recomputed at every commit point, so it starts coarse ("unknown") and
 * sharpens as quantity / role / specs arrive. Enrichment can override later.
 */
export function classifySegment(input: {
  productName: string;
  mcatType?: string; // 'P' product, 'S' service
  buyerType?: string; // End User / Manufacturer / Stockist / Reseller / Trader
  quantity?: number; // parsed numeric qty (0 when not asked/empty)
  hasUnits: boolean; // API returned quantity-unit options for this category
}): Segment {
  const name = input.productName || '';
  const role = (input.buyerType || '').toLowerCase();

  // 1) Explicit role is the strongest signal.
  if (/reseller|trader|stockist|wholesal/.test(role)) return 'reseller';

  // 2) Service category (by API type or product wording).
  if (input.mcatType === 'S' || SERVICE_HINTS.test(name)) return 'service';

  // 3) Capital / machinery: no quantity units from the API, or a machinery word.
  if (!input.hasUnits || CAPITAL_HINTS.test(name)) return 'capital';

  const qty = input.quantity ?? 0;

  // 4) End user → retail when the quantity is tiny, else a small business buy.
  if (role.includes('end user')) {
    return qty > 0 && qty <= 5 ? 'retail' : 'b2b_small';
  }

  // 5) Quantity-driven for the rest.
  if (qty >= 50) return 'b2b_bulk';
  if (qty > 0 && qty < 50) return 'b2b_small';

  // 6) Not enough signal yet → moderate default.
  return 'unknown';
}
