// ─── Dynamic RFQ — location-conflict detector (#1/#2, 2026-08-10) ────────────────────────────────────────────────
// The buyer's PROFILE city is the registered / delivery default. CSL tells us where he is actually BROWSING from
// (geo-IP `browse_location`), what city he FILTERED sellers by (`city_filters`), and where a search TARGETED
// (`browse_location.searched`, once the parser surfaces it — CSL gap G2); PNS tells us where a call happened. When
// ANY of those names a DIFFERENT district from the profile city, the registered address is likely stale or he is
// sourcing for another location — so the SPEC PAGE opens a small "confirm your location" prompt (buyer + delivery
// city) at the top, BEFORE specs (owner 2026-08-10).
//
// District-level, per the owner: compare at city/district granularity, and treat well-known METRO CLUSTERS as ONE
// district, so Ghaziabad↔Delhi does NOT false-fire while Ghaziabad↔Imphal DOES. The cluster list is deliberately
// small and owner-tunable — add rows as needed; it never suppresses a genuine cross-region mismatch.

export type LocationSource = 'browse' | 'target' | 'filter' | 'pns';
export interface LocationSignal { source: LocationSource; city: string; }
export interface LocationConflict { conflict: boolean; profileCity: string; conflicting: LocationSignal[]; }

const norm = (c: string | undefined | null): string =>
  (c || '').trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');

// Cities within one row are treated as the same district for conflict purposes (owner-tunable).
const METRO_CLUSTERS: string[][] = [
  ['delhi', 'new delhi', 'ghaziabad', 'noida', 'greater noida', 'gurgaon', 'gurugram', 'faridabad'],
  ['mumbai', 'navi mumbai', 'thane', 'kalyan', 'mira bhayandar'],
  ['bengaluru', 'bangalore'],
  ['hyderabad', 'secunderabad'],
  ['kolkata', 'howrah'],
  ['pune', 'pimpri chinchwad', 'pimpri'],
  ['ahmedabad', 'gandhinagar'],
];

/** The cluster key a city belongs to (its own normalised name if it is in no cluster). */
export function clusterOf(city: string | undefined | null): string {
  const n = norm(city);
  for (const cl of METRO_CLUSTERS) if (cl.includes(n)) return cl[0];
  return n;
}

/** Fire when any signal city is in a DIFFERENT district-cluster from the profile city. A blank profile city or blank
 *  signal city never triggers (we only claim a conflict when we actually have two cities to compare). */
export function detectLocationConflict(profileCity: string | undefined | null, signals: LocationSignal[]): LocationConflict {
  const p = clusterOf(profileCity);
  const seen = new Set<string>();
  const conflicting = (signals || []).filter((s) => {
    const cn = norm(s.city);
    const c = clusterOf(s.city);
    if (!cn || !p || c === p) return false;      // same district / missing side → not a conflict
    if (seen.has(cn)) return false;              // de-dupe by city
    seen.add(cn);
    return true;
  });
  return { conflict: !!p && conflicting.length > 0, profileCity: (profileCity || '').trim(), conflicting };
}
