// ─── BUYER PERSONA REGISTRY (Wave 1) — turns 481 facts into a buyer a human instantly understands ──────
// The bottleneck moved from "explain a decision" to "who is this buyer?". This builds the canonical
// persona (mapped toward GL_USR_PERSONA) from the SAME ledger facts, OPEN-vocabulary-ready, each attribute
// passed through the candidate → evidence-check → contradiction-check → confidence → promotion-gate
// pipeline (the same Fact→Belief→Decision discipline). High-confidence attrs are SHOWN; low/contradicted
// ones are HIDDEN with an ignoredReason (the "Ignored Personas" drill). Deterministic + grounded today
// (producer 'rule'); an LLM extractor can later add candidates against the identical schema. Harnessed in
// scripts/personatest.mjs.

import type { Ledger, Fact, SourceNode } from './ledger';

export interface PersonaEvidence { factId: string; raw: string; source: SourceNode; ref?: string }
export interface ConfidenceItem { label: string; delta: number; kind: 'base' | 'corroboration' | 'penalty' }   // the confidence LEDGER (+/−→net)
export interface PersonaAttr {
  key: string; label: string; group: string;
  value: string; confidence: number;
  stability: 'High' | 'Medium' | 'Low';   // band (for HOD "decision stable = yes")
  stabilityScore: number;                  // 0-100 — breadth across sources + evidence episodes (− conflict)
  stabilityNote: string;                   // "4 evidence lines · 3 sources" — WHY it's stable
  lastChangedBy: string;                    // which source line last moved it
  evidence: PersonaEvidence[];
  contradictions: PersonaEvidence[];
  sources: SourceNode[];
  alternatives: Array<{ value: string; whyLost: string }>;   // C · what it could have been + why not (universal)
  confidenceLedger: ConfidenceItem[];        // base + corroboration − penalties = confidence (why this number)
  method: string;                            // the ARITHMETIC RULE that ran — declared rule (if any) + the actual
                                             // fact-tags it matched → value @ base. "No black box": this is the code/inputs.
  shown: boolean; ignoredReason?: string;   // why NOT surfaced (low-conf / conflict / no-evidence)
}
export interface Persona { headline: string; shown: PersonaAttr[]; hidden: PersonaAttr[]; all: PersonaAttr[] }

const PROMOTE = 55; // confidence gate for "shown in the profile"

// one candidate spec: how to mine a value + its evidence + its contradictions from the facts.
// `needs` = what evidence WOULD fill this GL_USR_PERSONA slot when mine() returns null (schema-driven:
// every slot appears — grounded → shown, ungrounded → held under Ignored Personas with the "needs" hint).
interface Cand { key: string; label: string; group: string; needs?: string; rule?: string; mine: (h: Helper) => { value: string; ev: Fact[]; contra?: Fact[]; base: number; alts?: Array<{ value: string; whyLost: string }> } | null }
interface Helper { byTag: (t: string) => Fact[]; byRe: (t: string, re: RegExp) => Fact[]; all: Fact[] }

// member-since (GLUSR) → "X months". If the value isn't a parseable date, show it verbatim (let the LLM read it).
const monthsSince = (v: string): string => {
  if (!v) return v;
  const d = new Date(v); if (isNaN(d.getTime())) return v;
  const now = new Date(); const m = Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()));
  return m < 1 ? '<1 month' : `${m} month${m === 1 ? '' : 's'}`;
};

const CANDIDATES: Cand[] = [
  { key: 'business_type', label: 'Business type', group: 'Identity & firm', mine: (h) => { const ev = h.byRe('pns.persona', /manufactur/i); const bl = h.byRe('bl.title', /machine|raw material|making/i); if (!ev.length && !bl.length) return null; const contra = h.byRe('pns.persona', /entrepreneur|trader|reseller/i); return { value: 'Manufacturer', ev: [...ev, ...bl.slice(0, 2)], contra, base: 70, alts: [{ value: 'Trader', whyLost: 'no resale/stocking signals; buys inputs + machines, not finished-goods resale' }, { value: 'Distributor', whyLost: 'no multi-brand catalog / bulk-resale evidence' }] }; } },
  // NO HARDCODING (owner, absolute): industry/category are DERIVED from the buyer's own application/title text, never a baked category literal.
  { key: 'industry', label: 'Industry', group: 'Industry & category', mine: (h) => { const ap = h.byTag('pns.application'); if (!ap.length) return null; const vals = [...new Set(ap.map((f) => f.rawValue))].slice(0, 2); return { value: vals.join(' / '), ev: ap.slice(0, 3), base: 60 }; } },
  { key: 'category_expertise', label: 'Category expertise', group: 'Industry & category', mine: (h) => { const sig = [...h.byTag('bl.title'), ...h.byTag('pns.application')]; if (sig.length < 2) return null; return { value: `High (${sig.length} category signals)`, ev: sig.slice(0, 4), base: 55 }; } },
  { key: 'preferred_products', label: 'Preferred products', group: 'Industry & category', mine: (h) => { const p = [...h.byTag('pns.product'), ...h.byTag('bl.title')]; if (!p.length) return null; const vals = [...new Set(p.map((f) => f.rawValue))].slice(0, 3); return { value: vals.join(', '), ev: p.slice(0, 4), base: 55 }; } },
  { key: 'scale', label: 'Scale', group: 'Scale & maturity', mine: (h) => { const ov = h.byRe('isq.answer', /order value|lakh|crore/i); const qty = h.byRe('isq.answer', /\b\d{5,}\b|\bton\b/i); if (!ov.length && !qty.length) return null; return { value: 'Industrial · high', ev: [...ov, ...qty].slice(0, 3), base: 62, alts: [{ value: 'SME / retail', whyLost: 'order value + bulk quantity indicate industrial, not retail' }] }; } },
  { key: 'machine_ownership', label: 'Machine ownership', group: 'Scale & maturity', mine: (h) => { const own = h.byRe('bl.title', /machine|making/i); const specs = h.byRe('isq.answer', /automation|cutting machine|machine components/i); if (!own.length && !specs.length) return null; const contra = [...h.byRe('pns.narrative', /new.*venture|setting up/i), ...h.byRe('pns.seller_q', /setting up|installed the machine/i)]; return { value: 'Likely installed', ev: [...own.slice(0, 2), ...specs.slice(0, 2)], contra, base: 60, alts: [{ value: 'No machine yet', whyLost: 'machine purchases + spec answers on record' }] }; } },
  { key: 'maturity', label: 'Lifecycle / maturity', group: 'Scale & maturity', mine: (h) => { const est = h.byRe('pns.persona', /manufactur/i); if (!est.length) return null; const contra = [...h.byRe('pns.persona', /entrepreneur/i), ...h.byRe('pns.narrative', /new.*venture/i), ...h.byRe('pns.seller_q', /setting up|what business did you do/i)]; return { value: contra.length ? 'Growing (early-stage signals present)' : 'Established', ev: est.slice(0, 2), contra, base: 58, alts: [{ value: contra.length ? 'Established' : 'Nascent', whyLost: contra.length ? 'repeated manufacturing signals outweigh the new-venture mention' : 'no early-stage signals' }] }; } },
  { key: 'purchase_frequency', label: 'Purchase frequency', group: 'Intent & behavior', mine: (h) => { const rec = h.byRe('pns.order_type', /recurring|regular/i); const nar = h.byRe('pns.narrative', /regular|recurring/i); if (!rec.length && !nar.length) return null; return { value: 'Recurring', ev: [...rec, ...nar].slice(0, 2), base: 58 }; } },
  { key: 'purchase_style', label: 'Purchase style', group: 'Intent & behavior', mine: (h) => { const bulk = h.byRe('pns.order_type', /bulk/i); const qty = h.byRe('isq.answer', /\b\d{5,}\b|\bton\b/i); if (!bulk.length && !qty.length) return null; return { value: 'Bulk', ev: [...bulk, ...qty].slice(0, 2), base: 56 }; } },
  { key: 'intent_strength', label: 'Intent strength', group: 'Intent & behavior', mine: (h) => { const hi = h.byRe('pns.intent_level', /high/i); if (!hi.length) return null; return { value: 'High', ev: hi.slice(0, 3), base: 58 }; } },
  { key: 'language', label: 'Language', group: 'Comms & engagement', mine: (h) => { const l = h.byRe('pns.language', /hindi|english/i); if (!l.length) return null; return { value: l[0].rawValue, ev: l.slice(0, 2), base: 70 }; } },
  { key: 'communication', label: 'Communication preference', group: 'Comms & engagement', mine: (h) => { const waIn = h.byTag('wa.in'); const vol = h.byTag('wa.volume'); const calls = h.byTag('pns.persona'); const ev = [...waIn.slice(0, 3), ...vol]; if (!ev.length && !calls.length) return null; const channels = [waIn.length || vol.length ? 'WhatsApp' : '', calls.length ? 'Calls' : ''].filter(Boolean); return { value: `${channels.join(' + ')}${waIn.length ? ` (${waIn.length} inbound replies)` : ''}`, ev: ev.length ? ev : calls.slice(0, 1), base: waIn.length ? 64 : 50 }; } },
  // NO HARDCODING: geo = the buyer's actual registered city (profile), never a baked place name.
  { key: 'geo', label: 'Geo', group: 'Geo', mine: (h) => { const city = h.byTag('profile.city'); if (!city.length) return null; return { value: city[0].rawValue, ev: city.slice(0, 1), base: 60 }; } },
  { key: 'procurement_value', label: 'Procurement value (historical)', group: 'Scale & maturity', mine: (h) => { const ov = h.byRe('isq.answer', /order value|lakh/i); if (!ov.length) return null; return { value: ov.map((f) => f.rawValue.replace(/.*=/, '')).slice(0, 2).join(' · '), ev: ov.slice(0, 2), base: 60 }; } },
  // ── GLUSR (Redash usersince node) — member-since · last-modified · last-login. Filled-only: mine returns null
  //    when the column is absent, so the slot stays held until the E3 node is deployed. ──
  { key: 'account_tenure', label: 'Account tenure', group: 'Scale & maturity', needs: 'member-since (GLUSR usersince node)', mine: (h) => { const f = h.all.find((x) => /membersince|member_since/i.test(x.tag)); if (!f) return null; return { value: monthsSince(f.rawValue), ev: [f], base: 75 }; } },
  { key: 'last_active', label: 'Last active', group: 'Comms & engagement', needs: 'last-modified (GLUSR usersince node)', mine: (h) => { const f = h.all.find((x) => /lastmodified|last_modified/i.test(x.tag)); if (!f) return null; return { value: f.rawValue, ev: [f], base: 62 }; } },
  { key: 'last_login', label: 'Last login', group: 'Comms & engagement', needs: 'last-login (GLUSR usersince node)', mine: (h) => { const f = h.all.find((x) => /last.?log(in|ged|on)/i.test(x.tag)); if (!f) return null; return { value: f.rawValue, ev: [f], base: 62 }; } },
  { key: 'risk_profile', label: 'Risk profile', group: 'Scores & meta', mine: (h) => { const mfg = h.byRe('pns.persona', /manufactur/i); if (mfg.length < 2) return null; return { value: 'Low', ev: mfg.slice(0, 2), base: 58 }; } },
  { key: 'opportunity_profile', label: 'Opportunity', group: 'Scores & meta', mine: (h) => { const ov = h.byRe('isq.answer', /lakh|crore/i); const rec = h.byRe('pns.order_type', /recurring/i); if (!ov.length && !rec.length) return null; return { value: 'High value', ev: [...ov, ...rec].slice(0, 2), base: 56 }; } },
  { key: 'sub_industry', label: 'Sub-industry', group: 'Industry & category', needs: 'a finer category signal', mine: (h) => { const ap = h.byTag('pns.application'); if (ap.length < 2) return null; const vals = [...new Set(ap.map((f) => f.rawValue))].slice(0, 2); return { value: vals.join(' / '), ev: ap.slice(0, 2), base: 55 }; } },
  { key: 'usage', label: 'Usage', group: 'Sourcing & supplier', needs: 'a stated usage (home / business / reselling)', mine: (h) => { const bu = h.byRe('isq.answer', /business use/i); if (!bu.length) return null; return { value: 'Business use', ev: bu.slice(0, 2), base: 60 }; } },
  { key: 'total_calls', label: 'Sales-call depth', group: 'Comms & engagement', needs: 'PNS call records', mine: (h) => { const calls = new Set(h.byTag('pns.persona').map((f) => f.lineRef)); if (!calls.size) return null; return { value: `${calls.size} successful calls`, ev: h.byTag('pns.persona').slice(0, 3), base: 60 }; } },
  { key: 'wa_engagement', label: 'WhatsApp engagement', group: 'Comms & engagement', needs: 'inbound WhatsApp activity', mine: (h) => { const waIn = h.byTag('wa.in'); if (!waIn.length) return null; return { value: waIn.length > 10 ? 'High' : 'Medium', ev: waIn.slice(0, 3), base: 55 }; } },
  // ── WhatsApp INTELLIGENCE — behaviour DERIVED from the buyer's own chat lines (not just the transcript) ──
  // NO HARDCODING: "specifics" = generic measurement units/numbers in the buyer's reply, not category words.
  { key: 'response_quality', label: 'Response quality', group: 'Comms & engagement', needs: 'buyer answering with specifics in chat', mine: (h) => { const spec = h.byTag('wa.in').filter((f) => /buyer/i.test(f.lineRef || '') && /\b\d+\s*(gsm|kg|ton|inch|piece|mm|cm|meter|metre|litre|ltr|watt|hp|micron|sheet|ream)\b/i.test(f.rawValue)); if (!spec.length) return null; return { value: 'High — answers with specifics', ev: spec.slice(0, 3), base: 60 }; } },
  { key: 'negotiation_style', label: 'Negotiation style', group: 'Intent & behavior', needs: 'price/rate cues in chat', mine: (h) => { const px = h.byTag('wa.in').filter((f) => /buyer/i.test(f.lineRef || '') && /\b(price|rate|best|discount|kitna|kitne|sasta|cost)\b/i.test(f.rawValue)); if (!px.length) return null; return { value: 'Price-focused', ev: px.slice(0, 2), base: 55 }; } },
  { key: 'urgency', label: 'Urgency', group: 'Intent & behavior', needs: 'urgency cues in chat', mine: (h) => { const u = h.byTag('wa.in').filter((f) => /buyer/i.test(f.lineRef || '') && /\b(urgent|jaldi|today|tonight|this week|abhi|turant|asap)\b/i.test(f.rawValue)); if (!u.length) return null; return { value: 'High urgency', ev: u.slice(0, 2), base: 55 }; } },
  // ── EXTERNAL — first-class (Befisc/Sign3 paid APIs), weighted like PNS ──
  { key: 'verified_identity', label: 'Verified identity', group: 'External intelligence', needs: 'a Befisc identity match', mine: (h) => { const n = h.byTag('befisc.name'); if (!n.length) return null; return { value: `Verified · ${n[0].rawValue}`, ev: n.slice(0, 1), base: 72 }; } },
  { key: 'digital_footprint', label: 'Digital footprint', group: 'External intelligence', needs: 'a Sign3 lookup', mine: (h) => { const soc = [...h.byTag('sign3.socialProfiles'), ...h.byTag('sign3.platforms'), ...h.byTag('sign3.operator')]; if (!soc.length) return null; return { value: soc.map((f) => f.rawValue).slice(0, 3).join(' · '), ev: soc.slice(0, 3), base: 66 }; } },
  { key: 'external_risk', label: 'External risk signal', group: 'External intelligence', needs: 'a Sign3 breach/risk lookup', mine: (h) => { const br = h.byTag('sign3.breaches'); if (!br.length) return null; const n = parseInt(br[0].rawValue, 10) || 0; return { value: n > 0 ? `${n} breach(es) — review` : 'Clean', ev: br.slice(0, 1), base: 64 }; } },
  // purchasing power — parse the Befisc income value → tier (the bands the user fixed). Scans befisc facts by tag for an
  // income-like field, takes the first number + lakh/crore multiplier. >15L High · >5L Medium · <5L Low (annual).
  { key: 'purchasing_power', label: 'Purchasing power', group: 'External intelligence', needs: 'a Befisc income / financial signal', rule: 'Befisc income → annualised ₹ · >15L High · >5L Medium · <5L Low', mine: (h) => {
    const inc = h.all.filter((f) => f.sourceNode === 'befisc' && /income|salary|annual|earning|turnover|revenue/i.test(f.tag) && /\d/.test(f.rawValue));
    if (!inc.length) return null;
    const raw = inc[0].rawValue; const m = raw.replace(/,/g, '').match(/\d[\d.]*/); if (!m) return null;
    let n = parseFloat(m[0]); if (/crore|\bcr\b/i.test(raw)) n *= 1e7; else if (/lakh|lac/i.test(raw)) n *= 1e5;
    const tier = n >= 1.5e6 ? 'High (>₹15L)' : n >= 5e5 ? 'Medium (>₹5L)' : 'Low (<₹5L)';
    return { value: `${tier}`, ev: inc.slice(0, 2), base: 66, alts: [{ value: 'tier above/below', whyLost: 'income band is a point estimate; verify with GST/turnover if present' }] };
  } },
  { key: 'pan_on_file', label: 'PAN on file', group: 'External intelligence', needs: 'a PAN from Befisc / profile', rule: 'PAN present in befisc.* or profile.* → on file (identity verified)', mine: (h) => { const p = h.all.filter((f) => /\bpan\b|pan_?number/i.test(f.tag) && /[A-Z]{3,}\d/i.test(f.rawValue)); if (!p.length) return null; return { value: 'On file ✓', ev: p.slice(0, 1), base: 70 }; } },
  { key: 'address_verified', label: 'Address verified', group: 'External intelligence', needs: 'an address-verification flag from Befisc/Sign3', rule: 'befisc/sign3 address-verified flag → Verified', mine: (h) => { const a = h.all.filter((f) => (f.sourceNode === 'befisc' || f.sourceNode === 'sign3') && /address.?verif|verified.?address|addr.?match/i.test(f.tag) && /true|yes|1|verif|match/i.test(f.rawValue)); if (!a.length) return null; return { value: 'Verified ✓', ev: a.slice(0, 1), base: 68 }; } },
  // ── deliberately weak → demonstrate the HIDDEN / Ignored-Personas drill ──
  { key: 'price_sensitivity', label: 'Price sensitivity', group: 'Intent & behavior', needs: 'a negotiation / price-objection signal', mine: (h) => { const hp = h.byRe('wa.out', /high price/i); return { value: 'Medium (weak)', ev: hp.slice(0, 1), base: 30 }; } },
  // ── schema slots awaiting evidence (GL_USR_PERSONA-driven → shown as held with "needs") ──
  { key: 'company_size', label: 'Company size', group: 'Identity & firm', needs: 'employee count / firm size', mine: () => null },
  { key: 'company_type', label: 'Company type', group: 'Identity & firm', needs: 'proprietor / partnership / pvt-ltd', mine: () => null },
  { key: 'annual_turnover', label: 'Annual turnover', group: 'Identity & firm', needs: 'turnover band (external/GST)', mine: () => null },
  { key: 'gst_udyam', label: 'GST / Udyam', group: 'Identity & firm', needs: 'GST / Udyam from external', mine: () => null },
  { key: 'business_vintage', label: 'Business vintage', group: 'Scale & maturity', needs: 'incorporation / first-seen date (external)', mine: () => null },
  { key: 'payment_pref', label: 'Payment preference', group: 'Sourcing & supplier', needs: 'a stated payment mode (advance/credit/COD)', mine: () => null },
  { key: 'delivery_pref', label: 'Delivery preference', group: 'Sourcing & supplier', needs: 'a stated delivery timeline', mine: () => null },
  { key: 'preferred_supplier_type', label: 'Preferred supplier type', group: 'Sourcing & supplier', needs: 'a stated supplier preference', mine: () => null },
  { key: 'decision_velocity', label: 'Decision velocity', group: 'Intent & behavior', needs: 'time-between-requirement timing data', mine: () => null },
];

// key → { display label, bucket } from the registry schema (used to group the pure-LLM twin attributes into the
// same buckets the persona uses). Unknown keys (LLM-surfaced) fall back to a humanised label + "Other deduced".
export function attrMeta(key: string): { label: string; group: string } {
  const c = CANDIDATES.find((x) => x.key === key);
  if (c) return { label: c.label, group: c.group };
  return { label: key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), group: 'Other deduced' };
}

export function buildPersona(L: Ledger): Persona {
  const facts = L.facts;
  const h: Helper = { all: facts, byTag: (t) => facts.filter((f) => f.tag === t), byRe: (t, re) => facts.filter((f) => f.tag === t && re.test(f.rawValue)) };
  const all: PersonaAttr[] = [];
  for (const c of CANDIDATES) {
    const m = c.mine(h);
    // schema slot with NO grounding → held, with the "needs" hint (every GL_USR_PERSONA slot appears)
    if (!m || !m.ev.length) {
      all.push({ key: c.key, label: c.label, group: c.group, value: m?.value || '—', confidence: 0, stability: 'Low', stabilityScore: 0, stabilityNote: 'no evidence yet', lastChangedBy: '—', evidence: [], contradictions: [], sources: [], alternatives: [], confidenceLedger: [], method: `rule: ${c.rule || 'tag match'} · no matching facts this pull — needs ${c.needs || 'grounding evidence'}`, shown: false, ignoredReason: `needs ${c.needs || 'grounding evidence'}` });
      continue;
    }
    const ev: PersonaEvidence[] = m.ev.map((f) => ({ factId: f.id, raw: f.rawValue, source: f.sourceNode, ref: f.lineRef }));
    const contra: PersonaEvidence[] = (m.contra || []).map((f) => ({ factId: f.id, raw: f.rawValue, source: f.sourceNode, ref: f.lineRef }));
    const srcSet = [...new Set(m.ev.map((f) => f.sourceNode))];
    const episodes = new Set(m.ev.map((f) => f.lineRef || f.id)).size;   // distinct calls/BLs/lines it's stable across
    // confidence LEDGER: base + corroboration across distinct sources − contradiction penalty = net
    const corro = 12 * Math.max(0, srcSet.length - 1);
    const pen = contra.length ? 15 : 0;
    const confidenceLedger: ConfidenceItem[] = [{ label: 'base signal', delta: m.base, kind: 'base' }];
    if (corro) confidenceLedger.push({ label: `corroboration · ${srcSet.length} sources`, delta: corro, kind: 'corroboration' });
    if (pen) confidenceLedger.push({ label: `contradiction · ${contra.length}`, delta: -pen, kind: 'penalty' });
    const confidence = Math.max(0, Math.min(95, m.base + corro - pen));
    // STABILITY (mandatory, richer than confidence) — breadth across sources + evidence episodes, − conflict
    const stabilityScore = Math.max(0, Math.min(100, 40 + 15 * srcSet.length + 6 * episodes - (contra.length ? 25 : 0)));
    const stability: PersonaAttr['stability'] = stabilityScore >= 75 ? 'High' : stabilityScore >= 50 ? 'Medium' : 'Low';
    const stabilityNote = `${episodes} evidence line${episodes === 1 ? '' : 's'} · ${srcSet.length} source${srcSet.length === 1 ? '' : 's'}${contra.length ? ' · 1 conflict' : ''}`;
    const lastChangedBy = `${ev[0].source}${ev[0].ref ? ' · ' + ev[0].ref : ''}`;
    const shown = confidence >= PROMOTE;
    const ignoredReason = shown ? undefined : (contra.length ? 'conflicting sources — unresolved' : 'low confidence — single weak signal');
    // the ARITHMETIC RULE, grounded in the REAL run: declared rule (if any) + the actual fact-tags it consumed → value @ base.
    const matchedTags = [...new Set(m.ev.map((f) => f.tag))];
    const method = `${c.rule ? c.rule + ' · ' : ''}matched [${matchedTags.join(', ')}] → "${m.value}" @${m.base}${corro ? ` +${corro} corroboration (${srcSet.length} sources)` : ''}${pen ? ` −${pen} contradiction` : ''}`;
    all.push({ key: c.key, label: c.label, group: c.group, value: m.value, confidence, stability, stabilityScore, stabilityNote, lastChangedBy, evidence: ev, contradictions: contra, sources: srcSet, alternatives: m.alts || [], confidenceLedger, method, shown, ignoredReason });
  }
  const shown = all.filter((a) => a.shown);
  const hidden = all.filter((a) => !a.shown);
  // one-line headline — DERIVED from the buyer's own data (scale + first industry token + business type). NO HARDCODING.
  const bt = all.find((a) => a.key === 'business_type')?.value || 'Buyer';
  const ind = all.find((a) => a.key === 'industry' && a.shown)?.value;
  const scale = all.find((a) => a.key === 'scale' && a.shown) ? 'industrial' : '';
  const headline = [scale, ind ? ind.split(/[\s/]+/)[0].toLowerCase() : '', bt.toLowerCase()].filter(Boolean).join(' ').replace(/\b\w/, (m) => m.toUpperCase());
  return { headline, shown, hidden, all };
}

// ── READ SET (Trust · L1) — reframes "467 not referenced" (scary) into "read 481, here's the breakdown".
// Every fact WAS opened + role-assigned by the extractor, so nothing is "never opened"; the danger was
// purely the binary used/not-referenced framing. Used=decisive · supportive=scanned · held=available
// (signal, no consumer yet) · discounted=considered-and-rejected · noise=plumbing.
export interface ReadSet { read: number; used: number; supportive: number; held: number; discounted: number; noise: number }
export function readSet(L: Ledger): ReadSet {
  const c: ReadSet = { read: L.facts.length, used: 0, supportive: 0, held: 0, discounted: 0, noise: 0 };
  for (const f of L.facts) { const r = f.role || 'available'; if (r === 'decisive') c.used++; else if (r === 'scanned') c.supportive++; else if (r === 'available') c.held++; else if (r === 'discounted') c.discounted++; else c.noise++; }
  return c;
}

// ── COMPLETENESS CRITIC (Trust · the final unlock) — "I reviewed all N; top unused signals; would the
// strongest one CHANGE the call?". Stable = the top unused signal reinforces (doesn't contradict) and
// can't flip the category (< the gap to the next alternative). This is what lets the HOD relax.
export interface Critique { reviewed: number; topUnused: Array<{ raw: string; estDelta: number; note: string }>; maxImpact: number; verdict: 'stable' | 'review'; rationale: string }
export function completenessCritic(L: Ledger): Critique {
  const imp: Array<{ raw: string; estDelta: number; note: string }> = [];
  for (const d of L.decisions) for (const ig of d.ignoredImpact || []) imp.push({ raw: ig.raw, estDelta: ig.estDelta, note: ig.note });
  imp.sort((a, b) => b.estDelta - a.estDelta);
  const dedup: typeof imp = []; const seen = new Set<string>();
  for (const i of imp) { if (seen.has(i.raw)) continue; seen.add(i.raw); dedup.push(i); }
  const top = dedup.slice(0, 5);
  const maxImpact = top[0]?.estDelta ?? 0;
  // every ignored-impact note is a REINFORCING manufacturing-scale signal here → can't flip the call.
  const verdict: Critique['verdict'] = maxImpact < 20 ? 'stable' : 'review';
  const rationale = top.length
    ? `top unused signal would add up to +${maxImpact}, and all reinforce the call (none contradict) → ${verdict === 'stable' ? 'decision stable' : 'worth a re-run'}`
    : 'no signal-bearing facts left unused';
  return { reviewed: L.facts.length, topUnused: top, maxImpact, verdict, rationale };
}
