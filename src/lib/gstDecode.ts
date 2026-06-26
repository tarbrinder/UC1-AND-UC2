// ─── GST (GSTIN) DECODE (deterministic, no LLM) ──────────────────────────────────────────────────────────
// A GSTIN is 15 chars: [2 state code][10 PAN][1 entity/registration digit]['Z' default][1 checksum].
// We decode the state (numeric state code), the embedded PAN (an identity cross-check), and the entity type
// (from the embedded PAN's 4th char). Presence of a valid GSTIN itself = a registered-business trust signal.
// Single-source/deterministic → `deterministic` provenance badge. Harnessed in scripts/decodetest.mjs.

import { PAN_ENTITY } from './panDecode';

// Indian GST state codes (first two digits of a GSTIN).
export const GST_STATE: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh (pre-2014)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export interface GstInfo {
  gstin: string;
  valid: boolean;       // matches the canonical GSTIN format
  stateCode: string;    // first 2 chars
  state: string;        // resolved label, or 'Unknown'
  pan: string;          // embedded PAN (chars 3-12)
  entityType: string;   // from the embedded PAN's 4th char
  registered: boolean;  // a present GSTIN ⇒ a registered business
}

export function decodeGST(gstin?: string | null): GstInfo | null {
  const g = String(gstin || '').trim().toUpperCase();
  if (!g || g.length !== 15) return null;
  const stateCode = g.substring(0, 2);
  const pan = g.substring(2, 12);
  const entityChar = pan.charAt(3);
  return {
    gstin: g,
    valid: GSTIN_RE.test(g),
    stateCode,
    state: GST_STATE[stateCode] || 'Unknown',
    pan,
    entityType: PAN_ENTITY[entityChar] || 'Unknown',
    registered: true,
  };
}
