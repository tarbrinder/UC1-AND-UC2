// ─── TrustSEAL Buyer Profile — CARD (owner 2026-07-14 pixel-parity rebuild to the reference mockup) ──────────────
// ONE component for GLADMIN dashboard (viewMode='card', frontend extract) + standalone (?profile=, bi-buyer-unified).
// Owner rules: exactly the mockup attributes/order; empty attr → "Not Specified"; empty social/link → "-"; NO
// provenance/ticks/validation chrome (a compact traffic-light strip only). PII + demographics under the name.
import { useMemo } from 'react';
import { User, Building2, Calendar, MapPin, Factory, Globe, IndianRupee, CreditCard, ShieldCheck, Mail, Phone, Users, Target, ShoppingCart, TrendingUp, Store, BadgeCheck, type LucideIcon } from 'lucide-react';
import { parseBuyerProfile, type BuyerProfileModel, type Field, type LabeledField } from '../lib/buyerProfileModel';

// ── exact mockup brand glyphs (brand-coloured, matching the reference) ────────────────────────────────────────
type BrandIcon = (p: { className?: string }) => React.ReactElement;
const FacebookI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" className={className}><path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z"/></svg>;
const InstagramI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" className={className}><defs><radialGradient id="ig" cx="30%" cy="107%" r="150%"><stop offset="0%" stopColor="#fdf497"/><stop offset="45%" stopColor="#fd5949"/><stop offset="60%" stopColor="#d6249f"/><stop offset="90%" stopColor="#285AEB"/></radialGradient></defs><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig)"/><rect x="6.5" y="6.5" width="11" height="11" rx="5.5" fill="none" stroke="#fff" strokeWidth="1.6"/><circle cx="17.3" cy="6.7" r="1.1" fill="#fff"/></svg>;
const LinkedinI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" className={className}><path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.66H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.8 0 0 .78 0 1.75v20.5C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.75V1.75C24 .78 23.2 0 22.22 0Z"/></svg>;
const GlobeI: BrandIcon = ({ className }) => <Globe className={className} strokeWidth={2} color="#2563eb" />;

const isExternal = (f?: Field) => !!f && /idfy|befisc|sign3|consensus|union|external|smartauth|parallel|web[_ ]?osint|gweb/i.test(String(f.source || ''));

function V({ f, dash, ext }: { f: Field; dash?: boolean; ext?: boolean }) {
  if (!f?.present || f.value == null || f.value === '') return <span className="text-gray-400">{dash ? '-' : 'Not Specified'}</span>;
  return <span className="text-gray-800 break-words">{f.value}{ext && isExternal(f) && <span className="ml-1 text-[10px] text-gray-400 align-middle">· External</span>}</span>;
}

function Row({ Ic, label, f, mono, ext, children }: { Ic: LucideIcon; label: string; f?: Field; mono?: boolean; ext?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px]">
      <Ic className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" strokeWidth={2} />
      <span className="w-[128px] shrink-0 text-[12.5px] text-gray-700 leading-snug">{label}</span>
      <span className={`flex-1 min-w-0 text-[12.5px] leading-snug ${mono ? 'font-mono text-[11.5px]' : ''}`}>{children != null ? children : (f ? <V f={f} ext={ext} /> : null)}</span>
    </div>
  );
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11.5px] font-bold text-blue-700 uppercase tracking-wide mt-4 mb-1.5 first:mt-0">{children}</div>
);

function Tile({ Ic, value, label, tone, ring }: { Ic: LucideIcon; value: number | null; label: string; tone: string; ring: string }) {
  return (
    <div className="flex-1 rounded-xl border border-gray-200 bg-white px-2 py-3 text-center min-w-0">
      <div className={`mx-auto mb-1.5 w-9 h-9 rounded-full flex items-center justify-center ${tone}`}><Ic className="w-4 h-4" strokeWidth={2} /></div>
      <div className="text-2xl font-bold text-gray-900 leading-none tabular-nums">{value == null ? '—' : value}</div>
      <div className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</div>
      <div className={`mx-auto mt-1 h-0.5 w-8 rounded ${ring}`} />
    </div>
  );
}

const pick = (rows: LabeledField[], ...labels: string[]): Field => {
  for (const l of labels) { const r = rows.find((x) => x.label.toLowerCase() === l.toLowerCase()); if (r) return r.field; }
  return { value: null, present: false, provenance: 'absent', source: '' } as Field;
};
const F = (value: string | null): Field => (value ? { value, present: true, provenance: 'derived', source: 'composed' } : { value: null, present: false, provenance: 'absent', source: '' });

// parse the model's "MON'YY" month bucket back to a (year,month) key for the rolling 6-month axis
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monKey(label: string): number | null {
  const m = String(label).toLowerCase().match(/([a-z]{3})[^0-9]*'?(\d{2})/);
  if (!m) return null; const mi = MON.indexOf(m[1]); if (mi < 0) return null;
  return (2000 + Number(m[2])) * 12 + mi;
}

export default function BuyerProfileCard({ rich, glid }: { rich: unknown; glid: string; pending?: boolean; persona?: string }) {
  const m: BuyerProfileModel = useMemo(() => parseBuyerProfile(rich), [rich]);
  if (!m.available) {
    return <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-[12px] text-gray-400">TrustSEAL Buyer Profile — pull a GLID to populate.</div>;
  }
  const tenure = m.header.tenureYears;

  // header title reflects the verification tier (owner)
  const tierTitle = m.verifiedBuyer?.tier === 'trustseal' ? 'TrustSEAL Buyer Profile'
    : m.verifiedBuyer?.tier === 'gst_verified' ? 'Verified Business Buyer Profile'
    : m.verifiedBuyer?.tier === 'verified' ? 'Verified Buyer Profile'
    : m.verifiedBuyer?.tier === 'fraud' ? 'Buyer Profile — Fraud-flagged' : 'Buyer Profile';

  // ALL mobiles + all distinct names (owner: show as many as we got)
  const allMobiles = [...new Set(m.company.mobiles.map((x) => x.value).filter(Boolean))];
  const idn = m.company.identity as { registered?: { name?: string }; bankLinked?: { name?: string } } | null;
  const names = [...new Set([m.header.contactName.present ? String(m.header.contactName.value) : '', idn?.registered?.name || '', idn?.bankLinked?.name || ''].filter(Boolean))];
  const phoneF = F(allMobiles.join(', '));
  const nameF = F(names.join(' / '));

  // Sourcing / Selling channels — kept HONEST (audit 2026-07-14): Sign3 phone-linked "platform present" flags are
  // ordinary CONSUMER accounts on the phone owner (Flipkart present on ~86% of buyers; Amazon isn't even probed) — they
  // are NOT sourcing/selling evidence and would be slop. So: Sourcing = IndiaMART (the confirmed platform). Selling =
  // the IndiaMART storefront (catalogue link) ONLY when the buyer is actually a listed seller; else nothing. A real
  // external channel needs a seller-storefront URL from web OSINT / is_also_seller — never a phone-presence flag.
  const sourcingF = F('IndiaMART');
  const catUrl = m.catalogueLink.present ? String(m.catalogueLink.value) : '';
  const businessTypeF = pick(m.overview, 'Business Type');

  // Turnover moves to Company Details (owner: it's GST-derived) — prefer the GST-declared band, else the extract value.
  const turnoverF = m.company.turnoverBand.present ? m.company.turnoverBand : pick(m.overview, 'Annual Turnover');

  // rolling last-6-months axis (from today) — BuyLead bars from dated requirements; Enquiry/Call series kept at 0
  // (no per-month feed) so the 3-series mockup UI is preserved.
  const now = new Date();
  const blByKey = new Map<number, number>();
  for (const b of m.requirementActivity.months) { const k = monKey(b.month); if (k != null) blByKey.set(k, b.count); }
  const axis = Array.from({ length: 6 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1); const k = d.getFullYear() * 12 + d.getMonth(); return { label: d.toLocaleString('en-US', { month: 'short' }), bl: blByKey.get(k) || 0 }; });
  const blTotal = axis.reduce((s, a) => s + a.bl, 0);
  const chartMax = Math.max(1, ...axis.map((a) => a.bl));

  // traffic-light verification strip — keys only, no values (owner: reduce clutter, values live in the sections)
  const gstOk = (() => { const v = String(m.company.gstStatus.value || '').toLowerCase(); return /verified|active|tactical|otp|matchmaking/.test(v); })();
  const tri: { k: string; state: 'g' | 'y' | 'r' }[] = [
    { k: 'GST', state: m.company.gst.present ? (gstOk ? 'g' : 'y') : 'r' },
    { k: 'Udyam', state: m.company.udyam.present ? 'g' : 'r' },
    { k: 'PAN', state: m.company.pans?.primary ? 'g' : 'r' },
    { k: 'Mobile', state: allMobiles.length ? (m.company.mobiles.some((x) => x.agreementCount >= 2) ? 'g' : 'y') : 'r' },
    { k: 'Email', state: m.contact.email.present ? 'g' : 'r' },
    { k: 'Name', state: names.length ? (names.length === 1 ? 'g' : 'y') : 'r' },
  ];
  const triTone = { g: 'bg-emerald-50 text-emerald-700 border-emerald-200', y: 'bg-amber-50 text-amber-700 border-amber-200', r: 'bg-gray-50 text-gray-400 border-gray-200' };

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm max-w-6xl mx-auto text-gray-800">
      {/* HEADER */}
      <div className="bg-[#0b1f4d] px-5 py-3 flex items-center gap-3">
        <span className="w-9 h-9 rounded-lg bg-amber-400 text-[#0b1f4d] flex items-center justify-center shrink-0"><BadgeCheck className="w-5 h-5" strokeWidth={2.2} /></span>
        <span className="text-[17px] font-bold tracking-wide text-white">{tierTitle.split(' ').slice(0, -1).join(' ')} <span className="text-amber-400">{tierTitle.split(' ').slice(-1)}</span></span>
      </div>

      {/* TOP: identity + activity */}
      <div className="px-5 pt-4 pb-3 border-b border-gray-100 flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-[26px] font-bold text-gray-900 leading-tight">{m.header.company.present ? m.header.company.value : <span className="text-gray-300 italic text-xl">Not Specified</span>}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12.5px] text-gray-600">
            <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} />{nameF.present ? nameF.value : 'Not Specified'}</span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1"><Calendar className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} />Member Since: <b className="font-semibold text-gray-700">{tenure != null ? `${tenure} Year${tenure === 1 ? '' : 's'}` : (m.header.memberSince.present ? m.header.memberSince.value : 'Not Specified')}</b></span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1">GLID: <span className="text-blue-600 font-semibold">{glid || m.glid}</span></span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px] text-gray-600">
            <span className="inline-flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} /><V f={phoneF} /></span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1"><Mail className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} /><V f={m.contact.email} /></span>
          </div>
          {(m.contact.dob.present || m.contact.age.present || m.contact.gender.present || m.contact.incomeBand.present) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11.5px] text-gray-500">
              {m.contact.dob.present && <span>DOB: <b className="font-medium text-gray-700">{m.contact.dob.value}</b></span>}
              {m.contact.age.present && <span>Age: <b className="font-medium text-gray-700">{m.contact.age.value}</b></span>}
              {m.contact.gender.present && <span>Gender: <b className="font-medium text-gray-700">{m.contact.gender.value}</b></span>}
              {m.contact.incomeBand.present && <span>Income: <b className="font-medium text-gray-700">{m.contact.incomeBand.value}</b></span>}
            </div>
          )}
        </div>
        <div className="lg:w-[42%] shrink-0">
          <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">Overall Activity</div>
          <div className="flex gap-2">
            <Tile Ic={Phone} value={m.header.tiles[0]?.value ?? null} label={m.header.tiles[0]?.label || 'Total Calls'} tone="bg-blue-50 text-blue-600" ring="bg-blue-500" />
            <Tile Ic={Mail} value={m.header.tiles[1]?.value ?? null} label={m.header.tiles[1]?.label || 'Enquiries Posted'} tone="bg-emerald-50 text-emerald-600" ring="bg-emerald-500" />
            <Tile Ic={Target} value={m.header.tiles[2]?.value ?? null} label={m.header.tiles[2]?.label || 'BuyLeads Posted'} tone="bg-violet-50 text-violet-600" ring="bg-violet-500" />
          </div>
        </div>
      </div>

      {/* 3-COLUMN BODY */}
      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-2 items-stretch">

        {/* COLUMN 1 */}
        <div>
          <SectionTitle>Buyer Details</SectionTitle>
          <div className="rounded-lg bg-blue-50/60 border border-blue-100 px-3 py-2.5">
            <div className="text-[10.5px] font-bold text-blue-700 uppercase tracking-wide mb-1">Business Story</div>
            <p className="text-[12px] text-gray-600 leading-relaxed">{m.businessStory?.text || m.headline || <span className="text-gray-400">Not Specified</span>}</p>
          </div>

          <SectionTitle>Business Overview</SectionTitle>
          <Row Ic={Building2} label="Business Type" f={businessTypeF} />
          <Row Ic={TrendingUp} label="Business Stage" f={pick(m.buyerDetails, 'Business Stage')} />
          <Row Ic={Factory} label="Business Scale" f={pick(m.overview, 'Business Scale')} />
          <Row Ic={ShoppingCart} label="Annual Procurement" f={pick(m.overview, 'Annual Procurements', 'Annual Procurement')} />

          <SectionTitle>Procurement Profile</SectionTitle>
          <Row Ic={Store} label="Sourcing Channel" f={sourcingF} />
          <Row Ic={Factory} label="Preferred Suppliers" f={pick(m.procurement, 'Preferred Suppliers')} />
          <Row Ic={Target} label="Procurement Approach" f={pick(m.procurement, 'Procurement Approach')} />
          <Row Ic={MapPin} label="Sourcing Location" f={pick(m.procurement, 'Preferred Sourcing Cities')} />

          <SectionTitle>Market Focus</SectionTitle>
          <Row Ic={Users} label="Target Customers" f={pick(m.market, 'Target Customers')} />
          <Row Ic={Store} label="Selling Channel">
            {catUrl ? (
              <a href={/^https?:/.test(catUrl) ? catUrl : `https://${catUrl}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">IndiaMART</a>
            ) : <span className="text-gray-400">Not Specified</span>}
          </Row>
          <Row Ic={Globe} label="Sales Geography" f={pick(m.market, 'Sales Geography')} />
        </div>

        {/* COLUMN 2 — company details + verification strip + chart pinned bottom */}
        <div className="flex flex-col">
          <SectionTitle>Company Details</SectionTitle>
          <Row Ic={IndianRupee} label="GST" f={m.company.gst} mono ext />
          <div className="flex items-baseline gap-2 py-[3px]">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" strokeWidth={2} />
            <span className="w-[128px] shrink-0 text-[12.5px] text-gray-700 leading-snug">GST Verification Status</span>
            <span className="flex-1 min-w-0 text-[12.5px] leading-snug">{m.company.gstStatus.present ? <span className={gstOk ? 'text-emerald-600 font-medium' : 'text-amber-600 font-medium'}>{m.company.gstStatus.value}</span> : <span className="text-gray-400">Not Specified</span>}</span>
          </div>
          <Row Ic={User} label="Trade Name / Company Name" f={m.company.tradeName} />
          <Row Ic={Building2} label="Constitution of Business" f={m.company.constitution} />
          <Row Ic={Calendar} label="Date of Registration" f={m.company.regDate} />
          <Row Ic={MapPin} label="Principal Place of Business" f={m.company.principalAddress} />
          <Row Ic={IndianRupee} label="Annual Turnover" f={turnoverF} ext />
          {m.company.udyam.present && <Row Ic={Factory} label="Udyam / MSME" f={m.company.udyam.regNo} mono ext />}
          {m.company.pans?.primary && <Row Ic={CreditCard} label="PAN" f={m.company.pans.primary} mono ext />}

          {/* traffic-light verification strip — keys only (owner) */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-gray-400 uppercase tracking-wide mr-0.5">Verified</span>
            {tri.map((t) => <span key={t.k} className={`text-[10px] px-1.5 py-px rounded border ${triTone[t.state]}`}>{t.k}</span>)}
          </div>

          {/* Requirements chart — pinned to the bottom of the column */}
          <div className="mt-auto pt-4">
            <SectionTitle>Requirements Activity <span className="normal-case font-normal text-gray-400 text-[10px]">(Last 6 Months)</span><span className="float-right normal-case font-normal text-gray-500 text-[10.5px]">Last 6 Months Total: {blTotal}</span></SectionTitle>
            <div className="flex items-end gap-2 h-28 border-b border-gray-200 pb-0 px-1 mt-1">
              {axis.map((a) => (
                <div key={a.label} className="flex-1 flex flex-col items-center justify-end h-full">
                  <span className="text-[10px] text-gray-500 tabular-nums leading-none mb-1">{a.bl || 0}</span>
                  <div className="w-4 rounded-t bg-blue-500" style={{ height: `${a.bl ? Math.max(6, (a.bl / chartMax) * 86) : 0}px` }} />
                </div>
              ))}
            </div>
            <div className="flex gap-2 px-1 mt-1">{axis.map((a) => <span key={a.label} className="flex-1 text-center text-[10px] text-gray-400">{a.label}</span>)}</div>
            <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" />BuyLead ({blTotal})</span>
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Enquiry (0)</span>
              <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-400" />Call (0)</span>
            </div>
          </div>
        </div>

        {/* COLUMN 3 */}
        <div>
          <SectionTitle>Social Media Presence</SectionTitle>
          <div className="flex items-baseline gap-2 py-[3px]"><GlobeI className="w-4 h-4 shrink-0 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Website</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.website} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><FacebookI className="w-4 h-4 shrink-0 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Facebook</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.facebook} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><InstagramI className="w-4 h-4 shrink-0 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Instagram</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.instagram} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><LinkedinI className="w-4 h-4 shrink-0 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">LinkedIn</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.linkedin} dash /></span></div>

          {m.verifiedBuyer && (
            <div className="mt-4 rounded-lg border border-gray-200 px-3 py-2.5">
              <div className="text-[11px] font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5 mb-1.5"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" strokeWidth={2} />TrustSEAL Buyer</div>
              <div className="flex items-baseline gap-2 py-[2px]"><span className="w-[110px] shrink-0 text-[12px] text-gray-500">Verification</span><span className="flex-1 text-[12px] font-semibold text-gray-800">{m.verifiedBuyer.label}</span></div>
            </div>
          )}

          <SectionTitle>Products of Interest</SectionTitle>
          {m.products.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {m.products.map((p, i) => <div key={`${p}-${i}`} className="text-[12px] text-blue-700 flex items-start gap-1.5"><span className="text-blue-300 mt-0.5">•</span><span className="break-words leading-snug">{p}</span></div>)}
            </div>
          ) : <span className="text-gray-400 text-[12px]">-</span>}
        </div>
      </div>
    </div>
  );
}
