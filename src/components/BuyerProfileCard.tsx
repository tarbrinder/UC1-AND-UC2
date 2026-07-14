// ─── TrustSEAL Buyer Profile — CARD (owner 2026-07-14 pixel-parity rebuild to the reference mockup) ──────────────
// Reads ONLY the normalized BuyerProfileModel. Renders the SAME card on the GLADMIN dashboard (viewMode='card',
// frontend extract) and the standalone (?profile=, bi-buyer-unified server buyer{}). Owner rules:
//  · exactly the mockup attributes, exactly this order/spacing;
//  · empty attribute → the literal "Not Specified"; empty social → "-";
//  · NO provenance / ticks / validation chrome (that lives on the BuyLead debug card);
//  · identity PII (mobile/email) + DOB/Age/Gender/Income sit under the company-name block;
//  · Udyam / PAN go in Company Details when present (else omitted); GST/Udyam/PAN tagged "· External" when vendor-sourced;
//  · TrustSEAL box = the verification tier (flag 5-8 TrustSEAL · 4/GST Verified Business Buyer · mobile+email Verified);
//  · Overall Activity = Total Calls · Enquiries Posted · BuyLeads Posted.
import { useMemo } from 'react';
import { User, Building2, Calendar, MapPin, Factory, Globe, IndianRupee, CreditCard, ShieldCheck, Mail, Phone, Users, Target, ShoppingCart, TrendingUp, Store, BadgeCheck, type LucideIcon } from 'lucide-react';
import { parseBuyerProfile, type BuyerProfileModel, type Field, type LabeledField } from '../lib/buyerProfileModel';

// ── brand glyphs (lucide has no brand marks) ──────────────────────────────────────────────────────────────────
type BrandIcon = (p: { className?: string }) => React.ReactElement;
const FacebookI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="currentColor" className={className}><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.51 1.49-3.9 3.78-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.78l-.44 2.9h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94Z"/></svg>;
const InstagramI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>;
const LinkedinI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="currentColor" className={className}><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.66H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.8 0 0 .78 0 1.75v20.5C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.75V1.75C24 .78 23.2 0 22.22 0Z"/></svg>;

// ── a field is "externally sourced" (vendor / web) — GST/Udyam/PAN carry a "· External" tag then (owner) ──────────
const isExternal = (f?: Field) => !!f && /idfy|befisc|sign3|consensus|union|external|smartauth|parallel|web[_ ]?osint|gweb/i.test(String(f.source || ''));

// value or the literal "Not Specified" (owner). `dash` → the social empty-state "-".
function V({ f, dash, ext }: { f: Field; dash?: boolean; ext?: boolean }) {
  if (!f?.present || f.value == null || f.value === '') return <span className="text-gray-400">{dash ? '-' : 'Not Specified'}</span>;
  return <span className="text-gray-800 break-words">{f.value}{ext && isExternal(f) && <span className="ml-1 text-[10px] text-gray-400 align-middle">· External</span>}</span>;
}

// one attribute row — leading icon · fixed-width label · value
function Row({ Ic, label, f, mono, ext }: { Ic: LucideIcon; label: string; f: Field; mono?: boolean; ext?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px]">
      <Ic className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" strokeWidth={2} />
      <span className="w-[128px] shrink-0 text-[12.5px] text-gray-700 leading-snug">{label}</span>
      <span className={`flex-1 min-w-0 text-[12.5px] leading-snug ${mono ? 'font-mono text-[11.5px]' : ''}`}><V f={f} ext={ext} /></span>
    </div>
  );
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11.5px] font-bold text-blue-700 uppercase tracking-wide mt-4 mb-1.5 first:mt-0">{children}</div>
);

function Tile({ Ic, value, label, tone }: { Ic: LucideIcon; value: number | null; label: string; tone: string }) {
  return (
    <div className="flex-1 rounded-xl border border-gray-200 bg-white px-2 py-3 text-center min-w-0">
      <div className={`mx-auto mb-1.5 w-9 h-9 rounded-full flex items-center justify-center ${tone}`}><Ic className="w-4 h-4" strokeWidth={2} /></div>
      <div className="text-2xl font-bold text-gray-900 leading-none tabular-nums">{value == null ? '—' : value}</div>
      <div className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</div>
    </div>
  );
}

const pick = (rows: LabeledField[], ...labels: string[]): Field => {
  for (const l of labels) { const r = rows.find((x) => x.label.toLowerCase() === l.toLowerCase()); if (r) return r.field; }
  return { value: null, present: false, provenance: 'absent', source: '' } as Field;
};

export default function BuyerProfileCard({ rich, glid }: { rich: unknown; glid: string; pending?: boolean; persona?: string }) {
  const m: BuyerProfileModel = useMemo(() => parseBuyerProfile(rich), [rich]);
  if (!m.available) {
    return <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-[12px] text-gray-400">TrustSEAL Buyer Profile — pull a GLID to populate.</div>;
  }
  const tenure = m.header.tenureYears;
  const tileTone = ['bg-blue-50 text-blue-600', 'bg-emerald-50 text-emerald-600', 'bg-violet-50 text-violet-600'];
  const tileIcon = [Phone, Mail, Target];
  const mobiles = m.company.mobiles.map((x) => x.value).filter(Boolean);
  const phoneF: Field = mobiles.length ? { value: mobiles.slice(0, 2).join(', '), present: true, provenance: 'registry', source: 'IndiaMART / external identity' } : { value: null, present: false, provenance: 'absent', source: '' };
  const gstOk = (() => { const v = String(m.company.gstStatus.value || '').toLowerCase(); return /verified|active|tactical|otp|matchmaking/.test(v); })();

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm max-w-6xl mx-auto text-gray-800">
      {/* ── HEADER (navy) ── */}
      <div className="bg-[#0b1f4d] px-5 py-3 flex items-center gap-3">
        <span className="w-9 h-9 rounded-lg bg-amber-400 text-[#0b1f4d] flex items-center justify-center shrink-0"><BadgeCheck className="w-5 h-5" strokeWidth={2.2} /></span>
        <span className="text-[17px] font-bold tracking-wide text-white">TrustSEAL <span className="text-amber-400">Buyer Profile</span></span>
      </div>

      {/* ── TOP: identity block + overall activity ── */}
      <div className="px-5 pt-4 pb-3 border-b border-gray-100 flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-[26px] font-bold text-gray-900 leading-tight">{m.header.company.present ? m.header.company.value : <span className="text-gray-300 italic text-xl">Not Specified</span>}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12.5px] text-gray-600">
            <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} />{m.header.contactName.present ? m.header.contactName.value : 'Not Specified'}</span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1"><Calendar className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} />Member Since: <b className="font-semibold text-gray-700">{tenure != null ? `${tenure} Year${tenure === 1 ? '' : 's'}` : (m.header.memberSince.present ? m.header.memberSince.value : 'Not Specified')}</b></span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1">GLID: <span className="text-blue-600 font-semibold">{glid || m.glid}</span></span>
          </div>
          {/* identity PII — directly under the name block (owner) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px] text-gray-600">
            <span className="inline-flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} /><V f={phoneF} /></span>
            <span className="text-gray-300">|</span>
            <span className="inline-flex items-center gap-1"><Mail className="w-3.5 h-3.5 text-gray-400" strokeWidth={2} /><V f={m.contact.email} /></span>
          </div>
          {/* DOB / Age / Gender / Income — under the name block (owner) */}
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
            {m.header.tiles.slice(0, 3).map((t, i) => <Tile key={t.label} Ic={tileIcon[i] || Target} value={t.value} label={t.label} tone={tileTone[i] || tileTone[0]} />)}
          </div>
        </div>
      </div>

      {/* ── 3-COLUMN BODY ── */}
      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-2">

        {/* COLUMN 1 */}
        <div>
          <SectionTitle>Buyer Details</SectionTitle>
          <div className="rounded-lg bg-blue-50/60 border border-blue-100 px-3 py-2.5">
            <div className="text-[10.5px] font-bold text-blue-700 uppercase tracking-wide mb-1">Business Story</div>
            <p className="text-[12px] text-gray-600 leading-relaxed">{m.businessStory?.text || m.headline || <span className="text-gray-400">Not Specified</span>}</p>
          </div>

          <SectionTitle>Business Overview</SectionTitle>
          <Row Ic={Building2} label="Business Type" f={pick(m.overview, 'Business Type')} />
          <Row Ic={TrendingUp} label="Business Stage" f={pick(m.buyerDetails, 'Business Stage')} />
          <Row Ic={Factory} label="Business Scale" f={pick(m.overview, 'Business Scale')} />
          <Row Ic={IndianRupee} label="Turnover" f={pick(m.overview, 'Annual Turnover')} />
          <Row Ic={ShoppingCart} label="Annual Procurement" f={pick(m.overview, 'Annual Procurements', 'Annual Procurement')} />

          <SectionTitle>Procurement Profile</SectionTitle>
          <Row Ic={Store} label="Sourcing Channel" f={pick(m.procurement, 'Sourcing Channel')} />
          <Row Ic={Factory} label="Preferred Suppliers" f={pick(m.procurement, 'Preferred Suppliers')} />
          <Row Ic={Target} label="Procurement Approach" f={pick(m.procurement, 'Procurement Approach')} />
          <Row Ic={MapPin} label="Sourcing Location" f={pick(m.procurement, 'Preferred Sourcing Cities')} />

          <SectionTitle>Market Focus</SectionTitle>
          <Row Ic={Users} label="Target Customers" f={pick(m.market, 'Target Customers')} />
          <Row Ic={Store} label="Selling Channel" f={pick(m.market, 'Selling Channel')} />
          <Row Ic={Globe} label="Sales Geography" f={pick(m.market, 'Sales Geography')} />
        </div>

        {/* COLUMN 2 */}
        <div>
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
          {m.company.udyam.present && (
            <Row Ic={Factory} label="Udyam / MSME" f={m.company.udyam.regNo} mono ext />
          )}
          {m.company.pans?.primary && (
            <Row Ic={CreditCard} label="PAN" f={m.company.pans.primary} mono ext />
          )}

          <SectionTitle>Requirements Activity <span className="normal-case font-normal text-gray-400 text-[10px]">(Last 6 Months)</span>{m.requirementActivity.total != null && <span className="float-right normal-case font-normal text-gray-500 text-[10.5px]">Last 6 Months Total: {m.requirementActivity.total}</span>}</SectionTitle>
          {(() => {
            const bars = m.requirementActivity.months || [];
            const maxC = Math.max(1, ...bars.map((b) => b.count));
            if (!bars.length) return <div className="text-[11px] text-gray-300 italic py-2">No dated requirements to chart.</div>;
            return (
              <div className="mt-1">
                <div className="flex items-end gap-2 h-28 border-b border-gray-200 pb-0 px-1">
                  {bars.map((b) => (
                    <div key={b.month} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
                      <span className="text-[10px] text-gray-500 tabular-nums">{b.count || 0}</span>
                      <div className="w-4 rounded-t bg-blue-500" style={{ height: `${b.count ? Math.max(6, (b.count / maxC) * 88) : 0}px` }} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 px-1 mt-1">{bars.map((b) => <span key={b.month} className="flex-1 text-center text-[10px] text-gray-400">{String(b.month).replace(/['’]\d{2}$/, '')}</span>)}</div>
                <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-500"><span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" />BuyLead</span></div>
              </div>
            );
          })()}
        </div>

        {/* COLUMN 3 */}
        <div>
          <SectionTitle>Social Media Presence</SectionTitle>
          <div className="flex items-baseline gap-2 py-[3px]"><Globe className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" strokeWidth={2} /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Website</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.website} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><FacebookI className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Facebook</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.facebook} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><InstagramI className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">Instagram</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.instagram} dash /></span></div>
          <div className="flex items-baseline gap-2 py-[3px]"><LinkedinI className="w-3.5 h-3.5 shrink-0 text-gray-400 translate-y-0.5" /><span className="w-[84px] shrink-0 text-[12.5px] text-gray-700">LinkedIn</span><span className="flex-1 min-w-0 text-[12.5px]"><V f={m.social.linkedin} dash /></span></div>

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
          ) : <div className="text-[12px] text-gray-400">Not Specified</div>}
        </div>
      </div>
    </div>
  );
}
