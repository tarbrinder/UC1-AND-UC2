export interface ISQSpec {
  IM_SPEC_MASTER_DESC: string;
  IM_SPEC_MASTER_TYPE: string; // "1"=number, "2"=text, "3"=select
  IM_SPEC_OPTIONS_DESC: string; // "##" separated options
  IM_CAT_SPECIFICATION_SORTORDER: string;
}

export interface AIMissingSpec {
  fieldName: string;
  inputType: 'radio' | 'dropdown' | 'text' | 'chips' | 'chips-with-text';
  options?: string[];
  helperText?: string;
  showWhen?: { spec: string; values: string[] } | null;
  hideWhen?: { spec: string; values: string[] } | null;
}

export interface ComputedSpecState {
  hint: string | null;
  isNotApplicable: boolean;
  notApplicableReason: string | null;
}

export type SpecSource = 'photo' | 'product-name' | 'voice' | 'variant' | 'user';

export interface VoiceExtractedFields {
  rawTranscript: string;
  productName: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  deliveryLocation: string | null;
  deliveryTimeline: string | null;
  mappedSpecs: Record<string, string>;
  customSpecs: Array<{ fieldName: string; value: string }>;
}

export interface RFQFormData {
  // Step 0 – Product
  productName: string;
  mcatId: string;
  mcatType: string;
  quantity: string;
  unit: string;
  imageBase64: string;
  imageMimeType: string;
  // Step 1 – Specs
  dynamicSpecs: Record<string, string>;
  // Step 2 – Delivery
  clientLocation: string;
  deliveryLocation: string;
  deliveryTimeline: string;
  paymentTerms: string;
  creditPeriod: string;
  paymentMode: string;
  buyerType: string;
  industry: string;
  companySize: string;
  gstRegistered: boolean;
  gstNumber: string;
  requirementFrequency: string;
  contactName: string;
  contactMobile: string;
  contactEmail: string;
  additionalDetails: string; // Firm / company name
  requirementNotes: string; // buyer's free-text requirement (use-case, extras) — PII-scrubbed
  voiceTranscript: string;
  voiceDurationSeconds: number;
}

export type FormStep = 0 | 1 | 2;
