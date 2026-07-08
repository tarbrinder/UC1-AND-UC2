// ─── REQUIREMENT STITCHING (Wave 2C) — BuyLead + ISQ → one requirement, not two datasets ──────────────
// Humans think "Requirement: Notebook Making Machine (specs · buyer notes)", not "a BL row + an ISQ row".
// This stitches prev_bl_data ⨝ prev_isq_data by title (the offer link) into one card per requirement.
// Per the product owner: Probable Order Value + Probable Requirement Type are SYSTEM-deduced, not buyer-
// stated → excluded from specs. "Buyer Filled Details" = the buyer's own free-text note. "I am interested in"
// is the category MAPPING — it stays a SPEC (so Offer Enrichment can correct a mis-map, e.g. the buyer who
// typed "Paper Plate Raw Material" on a Notebook-Raw-Material lead). PURE · deterministic · no LLM. scripts/reqtest.mjs.

import type { Ledger, Fact } from './ledger';

const nrm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const IGNORE = /probable order value|probable requirement type/i;
const NOTE_KEY = /buyer filled details/i;            // free-text buyer note → notes ("I am interested in" stays a spec)

export interface ReqSpec { k: string; v: string; filledBy?: string } // filledBy: 'buyer'|'auto'|'agent'|'predicted' — drives the legend colours
export interface Requirement {
  title: string; specs: ReqSpec[]; buyerNotes: string[]; hasBL: boolean; hasISQ: boolean; facts: Fact[];
  // V10.1 merged-shape fields (populated by requirementsFromMerged; undefined on the legacy ledger path)
  offerId?: string; posted?: string; expiry?: string; status?: string; isExpired?: boolean; recencyDays?: number; category?: string; categoryId?: string; description?: string;
  specsStatus?: string; // 'present' | 'none' (no ISQ answered) | 'beyond_fetch_cap' (ISQ not fetched this pull) — WHY specs may be empty
  // broken-out ISQ fields (the node separates these from the product specs)
  buyerInfo?: string; commercials?: string; purchaseFrequency?: string; orderValue?: string; requirementType?: string; productOrService?: string; verified?: string; queryId?: string; retailLead?: boolean;
}

function makeReq(title: string, facts: Fact[]): Requirement {
  const specs: ReqSpec[] = []; const buyerNotes: string[] = [];
  for (const f of facts.filter((x) => x.tag === 'isq.answer')) {
    const eq = f.rawValue.indexOf('='); if (eq < 0) continue;
    const k = f.rawValue.slice(0, eq).trim(); const v = f.rawValue.slice(eq + 1).trim();
    if (!k || !v) continue;
    if (IGNORE.test(k)) continue;                                  // business-deduced → drop (owner's call)
    if (NOTE_KEY.test(k)) { buyerNotes.push(v); continue; }        // buyer's own words → notes
    specs.push({ k, v });
  }
  return { title, specs, buyerNotes, hasBL: facts.some((f) => f.tag === 'bl.title'), hasISQ: facts.some((f) => f.sourceNode === 'prev-isq'), facts };
}

export function buildRequirements(L: Ledger): Requirement[] {
  const blTitles = L.facts.filter((f) => f.tag === 'bl.title');
  const isqFacts = L.facts.filter((f) => f.sourceNode === 'prev-isq');
  // group ISQ facts by their ISQ index (lineRef), then key each group by its title
  const groups = new Map<string, Fact[]>();
  for (const f of isqFacts) { const r = f.lineRef || 'ISQ ?'; if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(f); }
  const isqByTitle = new Map<string, Fact[]>();
  for (const fs of groups.values()) { const t = fs.find((f) => f.tag === 'isq.title')?.rawValue; if (t) isqByTitle.set(nrm(t), fs); }
  const reqs: Requirement[] = []; const usedIsq = new Set<string>();
  // every BL title is a requirement; attach its ISQ specs if the title matches
  for (const bl of blTitles) { const key = nrm(bl.rawValue); const isq = isqByTitle.get(key); if (isq) usedIsq.add(key); reqs.push(makeReq(bl.rawValue, [bl, ...(isq || [])])); }
  // ISQ groups with no BL → still a requirement (reusable buyer memory)
  for (const [key, fs] of isqByTitle) { if (usedIsq.has(key)) continue; const t = fs.find((f) => f.tag === 'isq.title')?.rawValue || 'requirement'; reqs.push(makeReq(t, fs)); }
  return reqs;
}

// ─── V10.1 MERGED-SOURCE adapter — bi-user-insights v10.1 emits sources.requirement.summary.requirements[] =
// { offer_id, title, posted, expiry, status, is_expired, recency_days, category, specs:{k:v}, description }
// (BL spine ⨝ answered ISQ, category-named, status/recency carried). Map it to the rich Requirement[] the L2
// signals band + the L6 Buylead-Details card render. Falls back to the v9.5 items/answered_specs shape, then
// returns [] (caller falls back to buildRequirements(ledger) on the legacy rfq/isq ledger facts).
export function requirementsFromMerged(rich: unknown): Requirement[] {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
  const sum = obj(obj(obj(obj(rich).sources).requirement).summary);
  // robust spec reader — the v10.1 node emits specs as a { desc: value } MAP (or null); tolerate array / list shapes too
  const readSpecs = (v: unknown): ReqSpec[] => {
    if (Array.isArray(v)) return v.map((x) => { if (x && typeof x === 'object') { const o = obj(x); return { k: str(o.k ?? o.key ?? o.desc ?? o.name), v: str(o.v ?? o.value ?? o.val) }; } const s = str(x); const i = s.indexOf(':'); return i > 0 ? { k: s.slice(0, i).trim(), v: s.slice(i + 1).trim() } : { k: s, v: '' }; }).filter((s) => s.k && s.v);
    if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, val]) => ({ k, v: str(val) })).filter((s) => s.k && s.v);
    return [];
  };
  // PRIMARY · v10.1 requirements[] — the rich per-lead shape
  const reqs = arr(sum.requirements);
  if (reqs.length) {
    const out: Requirement[] = [];
    for (const it of reqs) {
      const o = obj(it);
      const title = str(o.title) || str(o.category); if (!title) continue;
      const allSpecs: ReqSpec[] = readSpecs(o.specs).length ? readSpecs(o.specs) : (readSpecs(o.isq_specs).length ? readSpecs(o.isq_specs) : readSpecs(o.answered_specs));
      const meta = obj(o.specs_meta); for (const s of allSpecs) s.filledBy = str(meta[s.k]) || 'buyer'; // answered ISQ w/o a source flag = buyer-filled
      const isExpired = o.is_expired === true || /expired/i.test(str(o.status));
      const catId = str(o.category_id) || str(o.mcat_id) || str(o.mcatid);
      // broken-out ISQ fields the node separates from product specs
      const buyerInfo = str(o.buyer_profile) || str(o.buyer_info) || undefined;
      const purchaseFrequency = str(o.purchase_frequency) || undefined;
      const orderValue = str(o.order_value) || undefined;
      const requirementType = str(o.requirement_type) || undefined;
      // assemble the "Commercials" line (payment/delivery/mode specs + purchase frequency); pull those out of the green product specs
      const COMM = /payment term|payment mode|delivery timeline|delivery time|freight|shipping|incoterm|commercial|credit period|terms of payment/i;
      const commParts = allSpecs.filter((s) => COMM.test(s.k)).map((s) => `${s.k}: ${s.v}`);
      if (purchaseFrequency) commParts.push(`Purchase Frequency: ${purchaseFrequency}`);
      const commercials = commParts.length ? commParts.join(' | ') : undefined;
      const specs = allSpecs.filter((s) => !COMM.test(s.k)); // product specs only (Commercials shown as its own line)
      const retailLead = /end[\s-]?user|individual|personal|\bretail\b|b2c|home use|household/i.test(`${buyerInfo || ''} ${requirementType || ''} ${str(o.product_or_service)}`);
      out.push({
        title, specs, buyerNotes: str(o.description) ? [str(o.description)] : [], hasBL: true, hasISQ: allSpecs.length > 0, facts: [],
        offerId: str(o.offer_id) || undefined, posted: str(o.posted) || undefined, expiry: str(o.expiry) || undefined,
        status: str(o.status) || (isExpired ? 'expired' : 'active'), isExpired, recencyDays: o.recency_days != null && !isNaN(Number(o.recency_days)) ? Number(o.recency_days) : undefined,
        category: str(o.category) || (catId ? `MCAT ${catId}` : undefined), categoryId: catId || undefined, description: str(o.description) || undefined,
        specsStatus: str(o._specs_status) || str(o.specs_status) || (allSpecs.length ? 'present' : undefined),
        buyerInfo, commercials, purchaseFrequency, orderValue, requirementType,
        productOrService: str(o.product_or_service) || undefined, verified: str(o.verified) || undefined, queryId: str(o.query_id) || undefined, retailLead,
      });
    }
    // freshest first (active before expired, then by recency) so hot leads lead the picker
    out.sort((a, b) => (Number(a.isExpired) - Number(b.isExpired)) || ((a.recencyDays ?? 1e9) - (b.recencyDays ?? 1e9)));
    // Amit (demo): "two leads at the same time = the same lead" — collapse exact duplicates so the BuyLeads count + list
    // aren't inflated. Dedupe by offer_id (a true unique BuyLead id); else by same posted-timestamp + same title.
    const seenReq = new Set<string>();
    const deduped = out.filter((r) => {
      const key = r.offerId ? `oid:${r.offerId}` : `pt:${str(r.posted)}|${str(r.title).toLowerCase().replace(/\s+/g, ' ').trim()}`;
      if (seenReq.has(key)) return false; seenReq.add(key); return true;
    });
    return deduped;
  }
  // FALLBACK · v9.5 items + answered_specs
  const items = arr(sum.items); const pool = arr(sum.answered_specs);
  if (!items.length && !pool.length) return [];
  const out: Requirement[] = [];
  for (const it of items) { const o = obj(it); const title = str(o.title); if (!title) continue; out.push({ title, specs: [], buyerNotes: [], hasBL: true, hasISQ: false, facts: [] }); }
  for (const a of pool) { const o = obj(a); const specs: ReqSpec[] = Object.entries(obj(o.specs)).map(([k, v]) => ({ k, v: str(v) })); if (!specs.length && !o.category) continue; out.push({ title: str(o.category) || 'Requirement specs', specs, buyerNotes: [], hasBL: false, hasISQ: true, facts: [] }); }
  return out;
}
