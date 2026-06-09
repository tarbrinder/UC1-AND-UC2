import { useState } from 'react';
import { ChevronDown, ChevronUp, MapPin } from 'lucide-react';
import OptionChips from './OptionChips';
import LocationSearch from './LocationSearch';

interface Props {
  deliveryLocation: string;
  onLocationChange: (v: string) => void;
  deliveryTimeline: string;
  onTimelineChange: (v: string) => void;
  paymentTerms: string;
  onPaymentTermsChange: (v: string) => void;
  paymentMode: string;
  onPaymentModeChange: (v: string) => void;
  buyerType: string;
  onBuyerTypeChange: (v: string) => void;
  industry: string;
  onIndustryChange: (v: string) => void;
  companySize: string;
  onCompanySizeChange: (v: string) => void;
  gstRegistered: boolean;
  onGstRegisteredChange: (v: boolean) => void;
  gstNumber: string;
  onGstNumberChange: (v: string) => void;
  requirementFrequency: string;
  onFrequencyChange: (v: string) => void;
  contactName: string;
  onContactNameChange: (v: string) => void;
  contactMobile: string;
  onContactMobileChange: (v: string) => void;
  contactEmail: string;
  onContactEmailChange: (v: string) => void;
  additionalDetails: string;
  onAdditionalDetailsChange: (v: string) => void;
  detectedLocation?: string;
}

const TIMELINE_OPTIONS = [
  'Immediate', 'Within 1 Week', 'Within 2 Weeks',
  'Within 1 Month', 'Within 3 Months', 'Flexible',
];

const PAYMENT_TERMS_OPTIONS = [
  'Cash on Delivery', 'Advance Payment', 'Letter of Credit',
  '30 Days Credit', '60 Days Credit', 'Against Delivery',
];

const PAYMENT_MODE_OPTIONS = ['NEFT/RTGS', 'UPI', 'Cheque', 'Cash', 'Other'];

const BUYER_TYPE_OPTIONS = [
  'Manufacturer', 'Trader/Stockist', 'Retailer', 'Service Provider', 'End User',
];

const COMPANY_SIZE_OPTIONS = ['1-10', '11-50', '51-200', '200+'];

const FREQUENCY_OPTIONS = ['One-time', 'Monthly', 'Quarterly', 'Annual'];

const INDUSTRIES = [
  'Manufacturing', 'Construction', 'Automotive', 'Textile', 'Chemical',
  'Pharmaceutical', 'Food & Beverage', 'Energy', 'Agriculture', 'Mining',
  'IT & Electronics', 'Healthcare', 'Logistics', 'Retail', 'Hospitality',
  'Education', 'Real Estate', 'Packaging', 'Defence', 'Other',
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
      {children}
    </p>
  );
}

export default function DeliverySection({
  deliveryLocation, onLocationChange,
  deliveryTimeline, onTimelineChange,
  paymentTerms, onPaymentTermsChange,
  paymentMode, onPaymentModeChange,
  buyerType, onBuyerTypeChange,
  industry, onIndustryChange,
  companySize, onCompanySizeChange,
  gstRegistered, onGstRegisteredChange,
  gstNumber, onGstNumberChange,
  requirementFrequency, onFrequencyChange,
  contactName, onContactNameChange,
  contactMobile, onContactMobileChange,
  contactEmail, onContactEmailChange,
  additionalDetails, onAdditionalDetailsChange,
  detectedLocation,
}: Props) {
  const [buyerOpen, setBuyerOpen] = useState(false);

  const showLocationBanner =
    detectedLocation &&
    detectedLocation.toLowerCase() !== deliveryLocation.toLowerCase();

  return (
    <div className="space-y-4">
      {/* Delivery Location */}
      <div className="bg-gray-50 rounded-xl p-4">
        <SectionLabel>Delivery Location</SectionLabel>
        <LocationSearch value={deliveryLocation} onChange={onLocationChange} />
        {showLocationBanner && (
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            <MapPin className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span>📍 Detected: <span className="font-medium">{detectedLocation}</span></span>
            <button
              type="button"
              onClick={() => onLocationChange(detectedLocation!)}
              className="ml-auto text-teal-600 font-semibold hover:text-teal-700 transition"
            >
              Use this
            </button>
          </div>
        )}
      </div>

      {/* Delivery Timeline */}
      <div className="bg-gray-50 rounded-xl p-4">
        <SectionLabel>Delivery Timeline</SectionLabel>
        <OptionChips options={TIMELINE_OPTIONS} value={deliveryTimeline} onChange={onTimelineChange} />
      </div>

      {/* Payment Terms */}
      <div className="bg-gray-50 rounded-xl p-4">
        <SectionLabel>Payment Terms</SectionLabel>
        <OptionChips options={PAYMENT_TERMS_OPTIONS} value={paymentTerms} onChange={onPaymentTermsChange} />
      </div>

      {/* Payment Mode */}
      <div className="bg-gray-50 rounded-xl p-4">
        <SectionLabel>Payment Mode</SectionLabel>
        <OptionChips options={PAYMENT_MODE_OPTIONS} value={paymentMode} onChange={onPaymentModeChange} />
      </div>

      {/* Buyer Profile (collapsible) */}
      <div className="bg-gray-50 rounded-xl p-4">
        <button
          type="button"
          onClick={() => setBuyerOpen(o => !o)}
          className="w-full flex items-center justify-between"
        >
          <SectionLabel>Buyer Profile</SectionLabel>
          {buyerOpen
            ? <ChevronUp className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {buyerOpen && (
          <div className="space-y-5 mt-2">
            {/* Buyer Type */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Buyer Type</p>
              <OptionChips options={BUYER_TYPE_OPTIONS} value={buyerType} onChange={onBuyerTypeChange} />
            </div>

            {/* Industry */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Industry</p>
              <select
                value={industry}
                onChange={e => onIndustryChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
              >
                <option value="">Select Industry…</option>
                {INDUSTRIES.map(ind => (
                  <option key={ind} value={ind}>{ind}</option>
                ))}
              </select>
            </div>

            {/* Company Size */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Company Size</p>
              <OptionChips options={COMPANY_SIZE_OPTIONS} value={companySize} onChange={onCompanySizeChange} />
            </div>

            {/* Requirement Frequency */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Requirement Frequency</p>
              <OptionChips options={FREQUENCY_OPTIONS} value={requirementFrequency} onChange={onFrequencyChange} />
            </div>

            {/* GST */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gstRegistered}
                  onChange={e => onGstRegisteredChange(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm text-gray-700">GST Registered?</span>
              </label>
              {gstRegistered && (
                <input
                  type="text"
                  value={gstNumber}
                  onChange={e => onGstNumberChange(e.target.value)}
                  placeholder="Enter GST number"
                  className="mt-2 w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Contact Details */}
      <div className="bg-gray-50 rounded-xl p-4">
        <SectionLabel>Contact Details</SectionLabel>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-0.5">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={contactName}
              onChange={e => onContactNameChange(e.target.value)}
              placeholder="Your full name"
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-0.5">
              Mobile <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              value={contactMobile}
              onChange={e => onContactMobileChange(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">
              Email <span className="text-gray-400 text-[10px]">(optional)</span>
            </label>
            <input
              type="email"
              value={contactEmail}
              onChange={e => onContactEmailChange(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">
              Additional Details
            </label>
            <textarea
              value={additionalDetails}
              onChange={e => onAdditionalDetailsChange(e.target.value)}
              placeholder="Any specific requirements, grade, certifications, packaging preferences…"
              rows={3}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition resize-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
