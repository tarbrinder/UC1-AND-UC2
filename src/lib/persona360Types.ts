// Persona360 — data contract (K-5).
// Fixture-first: every column is a pure function of these types. Live wiring later
// swaps the data source inside Persona360Page only. Sourced from:
//   - .hermes/plans/2026-08-19_buyer-persona-360-ui.md (type sketch)
//   - docs/persona360-design.md §7 (type additions)
//   - docs/persona360-data-audit.md (contract gaps -> pending/empty states)

export type VerifyStatus =
  | 'verified'        // green solid pill          (Mobile/Email/PAN/Name; "No bounce")
  | 'active'          // green dot + dark text     (PNS profiling active)
  | 'not_registered'  // red dot + bold dark label (GST not registered)
  | 'no_match'        // orange dot                (INRCA: no entity match)
  | 'no_presence'     // red dot                   (No web or social presence)
  | 'notified'        // red solid pill            (Balance sheet: Not filed -> notified)
  | 'no_bounce'       // green solid pill          (Cheque history)
  | 'unrated'         // gray-200 pill             (Credit exposure; GST/Udyam/TrustSeal tags)
  | 'missing'         // gray text list item       (completeness missing list)
  | 'pending'         // amber-outline pill "formula pending" (trust/risk numeric, completeness % in LIVE mode)
  | 'not_checked';    // gray dot, neutral         (future-proof)

export type SignalState = 'good' | 'caution' | 'bad';

/** Per-column render state. Every column renders standalone; a sibling failure never blanks a ready column. */
export type ColumnState = 'loading' | 'error' | 'empty' | 'ready';

export interface Persona360Data {
  glid: string;
  identity: {
    name: string;
    badges: string[];          // e.g. ['VBB REPEAT BUYER']
    description: string;
    age?: number;
    gender?: string;
    memberSince?: string;
    phoneMasked?: string;      // component renders strings as-is (masking done upstream)
    emailMasked?: string;
  };
  trust: {
    score: number;
    max: number;
    recommendation: string;
    mode?: 'fixture' | 'live';                 // design §7 — live mode may render pending
    signals: { label: string; state: SignalState }[];
  };
  persona: {
    primary: string;
    matchPct: number;
    alternate?: string;
    industry: string;
    industrySecondary?: string;
    stage: 'startup' | 'sme' | 'mid' | 'enterprise';
    stageEstimate?: string;
    turnover: { display: string; declared: boolean; warning?: string };
    entity: { type: string; detail?: string; panMasked?: string };
  };
  sourcing: {
    priceQuality: { label: string; position: number; evidence?: string };  // position = % along the track
    annualProcurement: { display: string; basis: string };
    orderPattern: { display: string; note: string };
    cities: { name: string; sharePct: number }[];
    deliveryNote?: string;
    products: string[];
  };
  risk: {
    score: number;
    band: string;
    smRisk: string;
    smNote?: string;
    rating?: { value: number; grade: string; count: number };
    financial: { label: string; status: VerifyStatus; statusText?: string }[]; // statusText overrides badge text (mockup: "Not filed")
    fraudRead?: { verdict: string; detail: string };
    rawSign3?: number | 'unknown';             // audit: raw 0–1 / unknown, never band-labelled
  };
  internet: {
    rows: { label: string; sub?: string; state: SignalState }[];
    verifiedTags: { name: string; verified: boolean }[];
    completeness: { pct: number; missing: string[] };
    counts?: { present: number; absent: number; errors: number };  // design §7 — live mode uses real counts, not pct
  };
  engagement: {
    windowMonths: number;
    metrics: { label: string; value: number }[];
    monthly: { month: string; calls: number; enquiries: number; buyleads: number }[];
    annotation?: string;
  };
}

export interface Persona360PageProps {
  /** Data source. Defaults to the mockup fixture; live mode swaps this in page shell only. */
  data?: Persona360Data;
  mode?: 'fixture' | 'live';
  onRetry?: () => void;
}