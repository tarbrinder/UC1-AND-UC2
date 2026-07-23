/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Dark theme is toggled by adding `dark` to <html> — driven by IST time-of-day (see main.tsx / index.css).
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand teal (design guideline #1d8480). Overriding the `teal` ramp makes every existing `teal-*` class
        // render the brand colour (fixes P2-231) and #1d8480-on-white computes to ~4.5:1 = WCAG AA (fixes P1-129
        // on filled CTAs / selected chips). 700 is darker for hover/active + AA headroom on small semibold text.
        teal: {
          50: '#eef7f6', 100: '#d2eae8', 200: '#a7d6d2', 300: '#71bcb6', 400: '#3f9f99',
          500: '#248b86', 600: '#1d8480', 700: '#15726e', 800: '#115e59', 900: '#134e4a',
        },
      },
    },
  },
  plugins: [],
};
