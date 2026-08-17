// ─── bpod → seed mappers (STEP 0, 2026-08-11) ───────────────────────────────────
// PURE + dependency-free (no imports), so the node:test suite can load it directly — requirementBrain.ts pulls
// in `../api` and a JSON fixture, which the strip-types test loader cannot resolve, so the mappers live here and
// requirementBrain re-exports them.
//
// bi-bpod returns a wide {bp, od, detail} record. The seed builders (formAdapter.extractBuyerIdentity /
// extractBuyerProfile) read a NORMALISED node_raw.profile.{identity,kyb,business,seller_context}; the bulk-B2B
// gate + the location/contact prefill effects read metadata.buyer_facts. The gate never mapped bpod into EITHER,
// so a real buyer's identity, company, city, business truth and persona gate were all dormant. These fold it.
type Bpod = { bp?: Record<string, unknown>; od?: Record<string, unknown>; detail?: Record<string, unknown> };
type BpodParts = { bp: Record<string, unknown>; od: Record<string, unknown>; detail: Record<string, unknown> };
function bpodParts(raw: unknown): BpodParts {
  const o = (Array.isArray(raw) ? raw[0] : raw) as Bpod | null;
  return { bp: (o?.bp ?? {}) as Record<string, unknown>, od: (o?.od ?? {}) as Record<string, unknown>, detail: (o?.detail ?? {}) as Record<string, unknown> };
}
const bstr = (x: unknown): string | undefined => { const v = String(x ?? '').trim(); return v && v.toLowerCase() !== 'null' ? v : undefined; };

/** bi-bpod → the node_raw.profile shape formAdapter's extractors expect. Returns null when nothing maps. */
export function bpodToProfileNode(raw: unknown): Record<string, unknown> | null {
  const { bp, od, detail } = bpodParts(raw);
  const name = bstr(bp.contacts_name) ?? ([bstr(detail.ceo_fname), bstr(detail.ceo_lname)].filter(Boolean).join(' ').trim() || undefined);
  const node = {
    identity: {
      name,
      mobile: bstr(bp.contacts_mobile1) ?? bstr(detail.glusr_usr_ph_mobile),
      email: bstr(bp.contacts_email1) ?? bstr(detail.email1),
      company: bstr(bp.contacts_company) ?? bstr(detail.company_name),
    },
    kyb: { gst: bstr(bp.gst) ?? bstr(od.GST), legal_status: bstr(od.GLUSR_GST_LEGAL_STATUS), registration_year: bstr(od.GLUSR_GST_REGISTRATION_YEAR) },
    business: { turnover: bstr(od.GLUSR_GST_ANNUAL_TURNOVER), nature_of_business: bstr(od.GLUSR_GST_NATURE_OF_BUSINESS) },
    seller_context: { custtype_name: bstr(detail.glusr_usr_custtype_name) },
  };
  const any = [node.identity.name, node.identity.mobile, node.identity.email, node.identity.company,
    node.kyb.gst, node.business.turnover, node.business.nature_of_business, node.seller_context.custtype_name].some(Boolean);
  return any ? node : null;
}

/** bi-bpod → metadata.buyer_facts (city/state + the bulk-gate signals). Returns null when empty. */
export function bpodToBuyerFacts(raw: unknown): Record<string, unknown> | null {
  const { bp, od, detail } = bpodParts(raw);
  const num = (x: unknown): number | undefined => { const t = String(x ?? '').replace(/[^0-9.]/g, ''); const n = Number(t); return t !== '' && Number.isFinite(n) ? n : undefined; };
  const gstStr = bstr(bp.gst) ?? bstr(od.GST);
  const gstV = bstr(bp.is_gst_verified) === '1' || bstr(bp.verification_status) === '1';
  const facts: Record<string, unknown> = {
    city: bstr(bp.contact_city) ?? bstr(detail.city),
    state: bstr(bp.contact_state) ?? bstr(detail.state),
    // The one-off veto (formAdapter.assessBulkB2B) keys off this count, so it must be REAL requirement history —
    // buyer_past_requirement_count — NOT total_requirement, which conflates buyleads + cross-category Type-E
    // enquiries and inflated a 1-requirement FREE buyer to 5, silently neutralising the veto and letting the persona
    // layer fabricate a "wholesaler" (deep-audit 2026-08-12). Fall back to total_requirement only when real history
    // is absent. NOTE: the positive ">=10 requirements" bulk signal now also reads the truer (lower) count — correct,
    // since buyleads are not requirements he posted.
    total_requirements: num(bp.buyer_past_requirement_count) ?? num(bp.total_requirement),
    total_calls: num(bp.total_calls),
    member_since: bstr(bp.glusr_usr_membersince),
    business_type: bstr(od.GLUSR_GST_NATURE_OF_BUSINESS),
  };
  // has_gst/gst_verified are booleans, so only ATTACH them on a real GST signal — otherwise an empty bpod would
  // carry {has_gst:false} and never read as "no data".
  if (gstStr || gstV) { facts.has_gst = gstV || !!gstStr; facts.gst_verified = gstV; }
  for (const k of Object.keys(facts)) if (facts[k] === undefined) delete facts[k];
  return Object.keys(facts).length ? facts : null;
}
