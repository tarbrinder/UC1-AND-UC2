// Shared, production-grade input validators for BOTH RFQ forms (Simple + Standard). Kept in one place so the
// two forms can never drift on what a "clean" quantity / mobile / GSTIN is (audit: junk values were shipping
// to sellers as verified leads).

/** Normalise a raw quantity string to a single well-formed decimal: digits + at most one dot, no leading
 *  zeros (a lone "0"/"0." is preserved so the buyer can type "0.5"), capped length. Non-numeric chars dropped. */
export function sanitizeQty(raw: string): string {
  let s = (raw || '').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, ''); // keep only the FIRST dot
  s = s.replace(/^0+(?=\d)/, ''); // strip leading zeros ("007" → "7"), but keep "0" and "0."
  if (s === '.') s = '0.';
  return s.slice(0, 12);
}

/** A quantity is MEANINGFUL (counts toward the score / ships to sellers) only if it parses to a finite > 0. */
export function qtyIsMeaningful(raw: string | undefined | null): boolean {
  const n = parseFloat((raw || '').trim());
  return Number.isFinite(n) && n > 0;
}

/** Valid Indian mobile: exactly 10 digits, starts 6-9, and NOT all-identical (blocks 0000000000 / 9999999999
 *  and the digit-count-only check that let 1234567890 through as a "verified" lead). */
export function isValidIndianMobile(raw: string | undefined | null): boolean {
  const d = (raw || '').replace(/\D/g, '');
  return /^[6-9]\d{9}$/.test(d) && !/^(\d)\1{9}$/.test(d);
}

/** GSTIN format: 2-digit state + 5 letters + 4 digits + 1 letter + 1 alnum + 'Z' + 1 alnum (15 chars). */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export function isValidGSTIN(raw: string | undefined | null): boolean {
  return GSTIN_RE.test((raw || '').toUpperCase());
}
