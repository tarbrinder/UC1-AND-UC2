// Candidate non-spec questions (from the enrichment taxonomy sheet). The LLM is
// given these as a SEED to consider — it keeps the relevant ones, drops the rest
// for the segment/product, tailors options, and may add category-specific ones.
import type { Bucket } from './types';

export interface SeedQuestion {
  label: string;
  options: string[]; // [] → free text
  bucket: Bucket;
}

export const SEED_QUESTIONS: SeedQuestion[] = [
  // ── Requirement ──
  { label: 'Purchase Frequency', options: ['Daily', 'Weekly', 'Monthly', 'Yearly'], bucket: 'requirement' },
  { label: 'Purchase Timeline', options: ['Immediate', 'Within 15 days', 'Same month', 'Flexible'], bucket: 'requirement' },
  { label: 'Usage', options: ['Home Use', 'Business Use', 'Reselling'], bucket: 'requirement' },
  { label: 'Quality preference', options: ['Cheaper Variants', 'Medium Quality', 'Top Brands'], bucket: 'requirement' },
  { label: 'Preferred Supplier Type', options: ['Manufacturer', 'Wholesaler', 'Reseller', 'Trader'], bucket: 'requirement' },
  { label: 'Current Buying Stage', options: ['Sample / Trial', 'Price Discovery', 'Supplier Finalisation'], bucket: 'requirement' },
  { label: 'Payment Mode', options: ['Advance', 'Credit', 'Finance', 'COD'], bucket: 'requirement' },
  // ── Persona ──
  { label: 'Estimated Annual Procurement Volume', options: ['< ₹1L', '₹1–10L', '₹10L–1Cr', '₹1Cr+'], bucket: 'persona' },
  { label: 'Decision Style', options: ['Advisory Driven', 'Price Driven', 'Spec Driven'], bucket: 'persona' },
  { label: 'Preferred Language', options: ['English', 'Hindi', 'Other'], bucket: 'persona' },
  // ── Business ──
  { label: 'Annual Turnover', options: ['< ₹40L', '₹40L–1.5Cr', '₹1.5–5Cr', '₹5Cr+'], bucket: 'business' },
  { label: 'GST / PAN / Udyam', options: [], bucket: 'business' },
  { label: 'Company Size', options: ['1–10', '11–50', '51–200', '200+'], bucket: 'business' },
  { label: 'Company Type', options: ['Proprietorship', 'Partnership', 'Pvt Ltd', 'LLP'], bucket: 'business' },
  { label: 'Company Tenure', options: ['< 1 yr', '1–3 yrs', '3–10 yrs', '10+ yrs'], bucket: 'business' },
];
