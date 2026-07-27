// IST-based auto dark theme for the RFQ forms (owner: "dark theme yes based on time IST").
// SELF-SCOPED: the forms add `rfq-root` + (when dark) `rfq-dark` to their own outer shell, and index.css
// only styles `.rfq-root.rfq-dark …`. Nothing outside the forms is touched — V3/V4/BuyerLedgerView never
// carry `rfq-root`, so the dashboard/other flows are unaffected regardless of the hour.
export type RfqTheme = 'light' | 'dark';

/** Resolve the theme once at mount.
 *  ⚑ DARK THEME DISABLED FOR NOW (owner, 2026-07-23): always resolves to 'light'. The IST-based logic + the
 *  `?theme=` override are preserved below (commented) — delete the early `return 'light'` to re-enable. All the
 *  wiring (rfqThemeClass on the shells, the `.rfq-root.rfq-dark` CSS in index.css) stays intact for that flip. */
export function resolveRfqTheme(): RfqTheme {
  return 'light';
  // --- re-enable dark by removing the line above ---
  // try {
  //   const q = new URLSearchParams(window.location.search).get('theme');
  //   if (q === 'dark' || q === 'light') return q;
  // } catch { /* no window/search — fall through to time-based */ }
  // // IST = UTC + 5:30. Night (19:00–06:59 IST) → dark.
  // const now = new Date();
  // const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  // const istHour = istMinutes / 60;
  // return istHour >= 19 || istHour < 7 ? 'dark' : 'light';
}

/** Class string for a form's outer shell: always `rfq-root`, plus `rfq-dark` when the resolved theme is dark. */
export function rfqThemeClass(theme: RfqTheme): string {
  return theme === 'dark' ? 'rfq-root rfq-dark' : 'rfq-root';
}
