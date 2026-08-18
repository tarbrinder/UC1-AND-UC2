// Persona360 — local color tokens (K-5). Used ONLY inside src/components/persona360/.
// Sourced from docs/persona360-design.md §2. The navy/orange accent pair is local to this
// surface by design — do NOT promote these into the repo-wide Tailwind theme.

export const navy = '#0B2D4D';        // header band, assigned-persona card, Calls series
export const navySoft = '#123A5F';    // header hover/inner borders
export const activity = '#2563EB';    // Enquiries series, "active" info states
export const caution = '#F59E0B';     // orange badges/bars (BuyLeads, WATCH band, VBB badge)
export const positive = '#16A34A';    // verified/positive badges & dots
export const concern = '#DC2626';     // missing/concern badges, dots, warnings
export const unknown = '#9CA3AF';     // unrated/unknown/pending badges, absent dots
export const canvas = '#E9EAEC';      // page background
export const card = '#FFFFFF';        // column surfaces
export const hairline = '#E5E7EB';    // row dividers, track fills
export const fraudBg = '#FCEBEA';     // fraud-read callout fill
export const fraudRule = '#B91C1C';   // fraud callout left rule

// Dark-mode canvas/card surfaces (design §0: dark variants ONLY for page canvas + cards;
// navy header and assigned-persona card are constant in both modes).
export const canvasDark = '#0F172A';
export const cardDark = '#1E293B';

// ► Deliberate divergence from ScoreBadge.tsx's red→green ramp (design §2):
// trust ring fill = caution on #33475C track, risk band chip uses its own colors.
// Do NOT "fix" this back to a red-green score ramp — score banding is a pending product formula.
export const trustTrack = '#33475C';