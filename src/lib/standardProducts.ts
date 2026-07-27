// "Standard Product" = a known brand-catalog SKU (brands.indiamart.com/?sid=…). Clicking "Get Best Price"
// on such a page raises an RFQ for THIS exact product — no search, no AI category planner, NO LLM at all.
// A properly-configured brand product has ONE value per spec (not a choice), so specs are FIXED facts we
// simply confirm-and-carry. For the demo we seed the config straight from the brand-page content; production
// would fetch the same shape from a brand API by sid.

export interface StandardSpec {
  name: string;
  value: string; // the catalog's single configured value — a fact, not a choice
}

export interface StandardProduct {
  sid: string;
  title: string;
  url: string; // the exact brand product URL — carried into the requirement as a spec
  priceOnwards?: string; // e.g. "₹ 215"
  image: string; // the catalog's first photo — pre-set as the buyer's product image (no upload, no LLM)
  description: string; // the catalog description — pre-filled, buyer-editable
  specs: StandardSpec[]; // exactly 6 fixed specs: 3 below-price highlights + top-3 full-specification
}

// The requirement the form hands back to the host via onSubmit (or logs in the demo).
export interface StandardRequirement {
  sid: string;
  productTitle: string;
  productUrl: string;
  imageUrl: string;
  specs: Record<string, string>; // only the specs the buyer kept ticked (default: all 6)
  customSpecs: { name: string; value: string }[]; // product-page URL (always) + any buyer additions
  description: string;
  quantity: string;
  unit: string;
  logistics: { deliveryTimeline: string; paymentTerms: string; creditPeriod: string; paymentMode: string; deliveryLocation: string; buyerLocation: string };
  profile: { businessType: string; industry: string; gstRegistered: boolean | null; gstNumber: string };
  contact: { name: string; mobile: string; email: string };
  text: string; // the assembled, lossless requirement text (for enquiry / WhatsApp)
}

export const STANDARD_PRODUCTS: Record<string, StandardProduct> = {
  // 4 Core 6 sqmm Aluminium Armoured Power Cable — from brands.indiamart.com/?sid=456523 (well-configured SKU).
  '456523': {
    sid: '456523',
    title: '4 Core 6 sqmm Aluminium Armoured Power Cable',
    url: 'https://brands.indiamart.com/?sid=456523',
    priceOnwards: '₹ 215',
    image:
      'https://5.imimg.com/data5/MODPRD/Default/2026/7/625264637/MA/TY/WK/146820410/kei-4-core-aluminium-xlpe-armoured-and-unarmoured-low-voltage-cable-500x500.jpg',
    description:
      'The 4 Core 6 sqmm Aluminium Armoured Power Cable is a robust electrical solution designed for reliable power distribution in demanding industrial and commercial environments. Featuring a high-grade aluminium conductor and durable PVC insulation, this cable is protected by 1.40 mm wire armouring to withstand mechanical stress and harsh installation conditions. It maintains a maximum DC resistance of 4.61 Ohms/Km and supports a current rating of up to 35 Amps when buried directly in the ground. With an approximate overall diameter of 19.0 mm and a 0.3 mm inner sheath, this cable is ideal for underground power transmission, factory electrification, and heavy-duty infrastructure projects.',
    specs: [
      // 3 below-price highlight specs
      { name: 'Conductor Size', value: '6 sqmm' },
      { name: 'Conductor Material', value: 'Aluminium' },
      { name: 'Insulation Material', value: 'PVC' },
      // top-3 from the full specification sheet
      { name: 'Armouring Type', value: 'Wire' },
      { name: 'Number Of Cores', value: '4 Core' },
      { name: 'Outer Sheath', value: 'PVC' },
    ],
  },
};

export const getStandardProduct = (sid: string): StandardProduct | null => STANDARD_PRODUCTS[sid] || null;
