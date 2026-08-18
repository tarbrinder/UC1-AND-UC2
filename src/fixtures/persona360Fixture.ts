// Persona360 — fixture (K-5 task 1). Exact mockup values (docs/buyer-persona-ui.webp)
// per docs/persona360-design.md §7 so @batman can pixel-compare.
import type { Persona360Data } from '../lib/persona360Types';

export const MOCKUP_GLID = '268590579';

export const PERSONA360_FIXTURE: Persona360Data = {
  glid: MOCKUP_GLID,
  identity: {
    name: 'Jayveer Singh',
    badges: ['VBB REPEAT BUYER'],
    description: 'Notebook machinery buyer - Kanpur, Uttar Pradesh',
    age: 29,
    gender: 'Male',
    memberSince: '3 months',
    phoneMasked: '6386941152',
    emailMasked: 'jayveeranayak75@gmail.com',
  },
  trust: {
    score: 46,
    max: 100,
    recommendation: 'Verify before push',
    mode: 'fixture',
    signals: [
      { label: 'Identity clear', state: 'good' },
      { label: 'Financial thin', state: 'caution' },
      { label: 'Behaviour genuine', state: 'good' },
    ],
  },
  persona: {
    primary: 'Raw Material Processing Machinery',
    matchPct: 82,
    alternate: 'Component & Machinery Manufacturer',
    industry: 'Notebook making machinery',
    industrySecondary: 'Paper & stationery converting',
    stage: 'startup',
    stageEstimate: 'Micro scale · first plant · <10 people (est.)',
    turnover: {
      display: '₹8–10 L',
      declared: false,
      warning: 'Company turnover not declared',
    },
    entity: { type: 'Proprietor, unregistered', detail: 'Buys in own name · PAN KDPVS7147Q', panMasked: 'KDPVS7147Q' },
  },
  sourcing: {
    priceQuality: {
      label: 'Price-led',
      position: 18,
      evidence: 'Ask rate first in 8 of 10 enquiries, no brand preference',
    },
    annualProcurement: { display: '₹18–25L', basis: 'est. from basket' },
    orderPattern: { display: '1–2 / yr', note: 'capex / low frequency' },
    cities: [
      { name: 'Delhi', sharePct: 42 },
      { name: 'Rajkot', sharePct: 33 },
      { name: 'Ahmedabad', sharePct: 25 },
    ],
    deliveryNote: 'All delivered to Kanpur, Uttar Pradesh',
    products: [
      '300 PCS/Hr notebook making machine',
      'Exercise notebook raw material',
      'Tata Chhota Hathi tipper body',
    ],
  },
  risk: {
    score: 58,
    band: 'WATCH',
    smRisk: 'Low',
    smNote: 'no adverse mentions',
    rating: { value: 3.8, grade: 'B', count: 6 },
    financial: [
      { label: 'Balance sheet', status: 'notified', statusText: 'Not filed' },
      { label: 'Cheque history', status: 'no_bounce', statusText: 'No bounce' },
      { label: 'Credit exposure', status: 'unrated', statusText: 'Unrated' },
    ],
    fraudRead: {
      verdict: 'No fraud signal',
      detail: 'No fraud signal – verified identity, consistent enquiries, single intent. Risk is ability to pay.',
    },
    rawSign3: 'unknown',
  },
  internet: {
    rows: [
      { label: 'GST not registered', sub: 'No GSTIN against this PAN', state: 'bad' },
      { label: 'PNS profiling active', sub: '2 calls · avg 2m 10s; answers 84%', state: 'good' },
      { label: 'INRCA: no entity match', sub: 'No registered company by name', state: 'caution' },
      { label: 'No company history', sub: 'First IndiaMART account, 3 months old', state: 'caution' },
      { label: 'No web or social presence', sub: 'Nothing on Facebook, Instagram, LinkedIn', state: 'bad' },
    ],
    verifiedTags: [
      { name: 'Mobile', verified: true },
      { name: 'Email', verified: true },
      { name: 'PAN', verified: true },
      { name: 'Name', verified: true },
      { name: 'GST', verified: false },
      { name: 'Udyam', verified: false },
      { name: 'TrustSeal', verified: false },
    ],
    completeness: { pct: 44, missing: ['GST', 'turnover', 'business type', 'TrustSeal'] },
  },
  engagement: {
    windowMonths: 6,
    metrics: [
      { label: 'Sellers connected', value: 34 },
      { label: 'Calls made', value: 27 },
      { label: 'Enquiries posted', value: 20 },
      { label: 'BuyLeads posted', value: 27 },
    ],
    monthly: [
      { month: 'Mar', calls: 2, enquiries: 0, buyleads: 0 },
      { month: 'Apr', calls: 3, enquiries: 1, buyleads: 1 },
      { month: 'May', calls: 9, enquiries: 8, buyleads: 10 },
      { month: 'Jun', calls: 5, enquiries: 4, buyleads: 6 },
      { month: 'Jul', calls: 4, enquiries: 4, buyleads: 5 },
      { month: 'Aug', calls: 4, enquiries: 3, buyleads: 5 },
    ],
    annotation: 'one buying burst in May, steady follow-up since',
  },
};