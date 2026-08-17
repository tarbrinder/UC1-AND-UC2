import { api } from '../lib/api';

// Large list spanning: Power & Energy, Pumps & Valves, Industrial Machinery, Steel & Metal,
// Electrical, Construction, Chemicals, Textiles, Packaging, Agriculture, Automotive, Medical, Safety
export const PRODUCT_NAMES: string[] = [
  // Power & Energy
  'Diesel Generator', 'Silent Diesel Generator', 'Petrol Generator', 'Gas Generator',
  'Solar Panel', 'Monocrystalline Solar Panel', 'Polycrystalline Solar Panel', 'Solar Inverter',
  'Solar Battery', 'Solar Charge Controller', 'UPS System', 'Online UPS', 'Offline UPS',
  'Inverter Battery', 'Li-ion Battery', 'Lead Acid Battery', 'Battery Charger',
  'Wind Turbine', 'Power Bank', 'Electric Vehicle Charger',
  // Pumps & Valves
  'Centrifugal Pump', 'Submersible Pump', 'Monoblock Pump', 'Water Pump', 'Sewage Pump',
  'Borewell Pump', 'Chemical Pump', 'Diaphragm Pump', 'Dosing Pump', 'Gear Pump',
  'Hydraulic Pump', 'Peristaltic Pump', 'Piston Pump', 'Slurry Pump', 'Vacuum Pump',
  'Gate Valve', 'Ball Valve', 'Butterfly Valve', 'Check Valve', 'Globe Valve',
  'Pressure Relief Valve', 'Solenoid Valve', 'Control Valve',
  // Industrial Machinery
  'CNC Machine', 'CNC Lathe', 'CNC Milling Machine', 'Lathe Machine', 'Milling Machine',
  'Drilling Machine', 'Grinding Machine', 'Welding Machine', 'Cutting Machine',
  'Hydraulic Press', 'Power Press', 'Injection Moulding Machine', 'Blow Moulding Machine',
  'Conveyor Belt', 'Screw Conveyor', 'Belt Conveyor', 'Chain Conveyor',
  'Forklift', 'Electric Forklift', 'Diesel Forklift', 'Pallet Jack',
  'Air Compressor', 'Screw Compressor', 'Reciprocating Compressor', 'Portable Compressor',
  'Packaging Machine', 'Filling Machine', 'Sealing Machine', 'Labelling Machine',
  'Industrial Robot', 'Crane', 'Overhead Crane', 'Hoist',
  // Steel & Metal
  'Steel Pipe', 'MS Pipe', 'GI Pipe', 'SS Pipe', 'ERW Pipe',
  'Steel Plate', 'Mild Steel Plate', 'Stainless Steel Sheet', 'Aluminium Sheet',
  'Steel Bar', 'TMT Bar', 'Round Bar', 'Flat Bar', 'Angle Iron',
  'Steel Channel', 'H-Beam', 'I-Beam', 'Steel Coil', 'HR Coil', 'CR Coil',
  'Copper Wire', 'Aluminium Wire', 'Copper Rod', 'Aluminium Rod',
  'Cast Iron', 'Brass Rod', 'Stainless Steel Rod', 'Galvanized Wire',
  // Electrical
  'Electric Motor', 'Induction Motor', 'Servo Motor', 'AC Motor', 'DC Motor',
  'Transformer', 'Distribution Transformer', 'Step Up Transformer', 'Step Down Transformer',
  'Circuit Breaker', 'MCB', 'MCCB', 'RCCB', 'Switchgear',
  'Control Panel', 'MCC Panel', 'PCC Panel', 'VFD Panel', 'Capacitor Bank',
  'LED Light', 'LED Bulb', 'LED Tube Light', 'LED Flood Light', 'Street Light',
  'Cable', 'Power Cable', 'Control Cable', 'Instrumentation Cable', 'Armoured Cable',
  'Conduit Pipe', 'Cable Tray', 'Junction Box', 'Distribution Box',
  // Construction
  'Cement', 'OPC Cement', 'PPC Cement', 'White Cement', 'Ready Mix Concrete',
  'Bricks', 'Red Bricks', 'Fly Ash Bricks', 'AAC Block', 'Concrete Block',
  'TMT Steel', 'Binding Wire', 'Welded Mesh', 'Chain Link Fence',
  'PVC Pipe', 'HDPE Pipe', 'UPVC Pipe', 'Plumbing Pipe', 'Drainage Pipe',
  'Tiles', 'Ceramic Tiles', 'Vitrified Tiles', 'Floor Tiles', 'Wall Tiles',
  'Sanitary Ware', 'Toilet', 'Wash Basin', 'Bathtub', 'Shower',
  // Chemicals
  'Caustic Soda', 'Soda Ash', 'Sodium Hydroxide', 'Hydrochloric Acid', 'Sulphuric Acid',
  'Hydrogen Peroxide', 'Sodium Hypochlorite', 'Ferric Chloride', 'Citric Acid',
  'Lubricating Oil', 'Hydraulic Oil', 'Gear Oil', 'Transformer Oil', 'Cutting Oil',
  // Textiles
  'Cotton Yarn', 'Polyester Yarn', 'Nylon Yarn', 'Viscose Yarn', 'Blended Yarn',
  'Cotton Fabric', 'Polyester Fabric', 'Denim Fabric', 'Knitted Fabric', 'Woven Fabric',
  // Agriculture
  'Tractor', 'Rotavator', 'Seed Drill', 'Harvester', 'Sprayer',
  'Fertiliser', 'Pesticide', 'Seeds', 'Drip Irrigation System', 'Sprinkler System',
  // Automotive
  'Car Battery', 'Truck Battery', 'Brake Pad', 'Clutch Plate', 'Engine Oil',
  'Tyre', 'Truck Tyre', 'Two Wheeler Tyre', 'Alloy Wheel', 'Radiator',
  // Medical
  'Surgical Gloves', 'Disposable Mask', 'Syringe', 'IV Cannula', 'Surgical Suture',
  // Safety
  'Safety Helmet', 'Safety Shoes', 'Safety Gloves', 'Safety Harness', 'Fire Extinguisher',
  // Packaging
  'HDPE Bag', 'PP Bag', 'Corrugated Box', 'Bubble Wrap', 'Stretch Film',
  'BOPP Bag', 'Woven Sack', 'Jute Bag', 'Paper Bag', 'Aluminium Foil',
  // Miscellaneous
  'Ball Bearing', 'Roller Bearing', 'Gear Box', 'Shaft Coupling', 'Pulley',
  'V-Belt', 'Chain Sprocket', 'Filter', 'Gasket', 'Seal',
  'Bolt', 'Nut', 'Washer', 'Fastener', 'Screw',
  'Heat Exchanger', 'Cooling Tower', 'Chiller', 'Boiler', 'Steam Trap',
  'Weighing Machine', 'Electronic Weighbridge', 'Packing Scale',
  'CCTV Camera', 'Access Control', 'Fire Alarm', 'Security System',
];

export function filterProducts(query: string): string[] {
  if (!query || query.length < 1) return [];
  const q = query.toLowerCase();
  const exact: string[] = [];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const p of PRODUCT_NAMES) {
    const lp = p.toLowerCase();
    if (lp === q) exact.push(p);
    else if (lp.startsWith(q)) prefix.push(p);
    else if (lp.includes(q)) contains.push(p);
  }
  return [...exact, ...prefix, ...contains].slice(0, 8);
}

// Buyers often type the quantity/unit inline, e.g. "100 m jute rope",
// "50 kg cement", "2 nos generator". Strip a leading number (+ optional unit)
// so search & validation work on the real product term ("jute rope").
const LEADING_QTY = /^\s*\d+(?:[.,]\d+)?\s*(?:m|mm|cm|ft|meter|metre|kg|g|gram|ton|tonne|mt|qt|quintal|ltr|litre|liter|l|pcs|pieces|piece|pc|nos|no|units?|sets?|rolls?|bags?|boxes?|box|pairs?|pair|dozen|dz)?\s+/i;

export function stripQuantityPrefix(query: string): string {
  const stripped = query.replace(LEADING_QTY, '').trim();
  // Only use the stripped form if something meaningful remains.
  return stripped.length >= 2 ? stripped : query.trim();
}

// Capture a leading quantity ONLY when it carries a TRUE ORDER unit (pieces / nos / kg / meter / …). The unit is
// now REQUIRED — a bare number, or a number with a spec/rating/dimension unit ("5 kVA", "6 mm", "230 V"), is NOT
// treated as an order quantity (that's a spec value, mapped by the LLM). Fixes "5 kVA diesel generator" → qty 5.
const LEADING_QTY_CAPTURE =
  /^\s*(\d+(?:[.,]\d+)?)\s*(pieces?|pcs|pc|nos\b|units?|sets?|rolls?|bags?|boxes?|box|pack(?:et)?s?|pkt|pairs?|pair|dozen|dz|kgs?|quintal|tonnes?|tons?|\bmt\b|litres?|liters?|ltr|meters?|metres?|feet|ft|km)\b/i;

export function parseQuantityFromName(name: string): { quantity: string; unit: string } | null {
  const m = name.match(LEADING_QTY_CAPTURE);
  if (!m) return null;
  // Require something after the qty+unit so a bare "100 pieces" with no product isn't treated as a requirement.
  if (!name.slice(m[0].length).trim()) return null;
  return { quantity: m[1].replace(/,/g, ''), unit: (m[2] || '').toLowerCase() };
}

export async function fetchProductSuggestions(query: string): Promise<string[]> {
  try {
    const res = await fetch(api(`/api/suggest/suggest/suggest.php?q=${encodeURIComponent(query)}&type=p`));
    const data = await res.json();
    const items: Array<{ label: string }> = Array.isArray(data) ? data : (data?.product ?? []);
    return items.map((i) => i.label).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}
