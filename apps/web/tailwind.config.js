/** @type {import('tailwindcss').Config} */
//
// Palette: Deep Navy + Champagne Gold (option 1, 2026-08-11).
//
// `brand` is the PRIMARY ramp and is navy — buttons, active nav, logo plate.
// `gold` is the ACCENT and is deliberately restricted: champagne gold measures
// only 1.98:1 on the light background, so it fails even the 3:1 non-text
// threshold. Use gold-400 on navy surfaces (7.94:1) and gold-700 (#7A6414,
// 5.40:1) for the rare case of gold text on light.
//
// Contrast verified 2026-08-11 against #F7F8FA:
//   text-brand-500 11.03:1 · cream-on-brand-500 11.03:1 · ink 15.48:1
//   gold-400 on brand-800 plate 7.94:1
//
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Text — near black with a cool cast.
        ink: '#17202A',
        // Muted text base. Applied at opacity (text-charcoal/55 etc.), so the
        // darkest navy is used: it keeps low-alpha text as legible as possible.
        charcoal: '#0B1F33',
        // App background (off white).
        cream: '#F7F8FA',
        // Standalone muted token for full-opacity secondary text (5.43:1).
        muted: '#5C6773',
        success: '#2F7D5A',
        danger: '#C94C4C',
        // Primary — deep navy.
        // 500+ sit in genuine deep-navy territory because bg-brand-500 is the
        // primary button fill; 50–400 remain light enough for tints and borders.
        brand: {
          50: '#F2F5F8',
          100: '#E3E9F0',
          200: '#C3D0DF',
          300: '#94AAC4',
          400: '#4E6E90',
          500: '#1E3A55',
          600: '#16293C',
          700: '#12243A',
          800: '#0B1F33',
          900: '#081827',
          950: '#050F19',
        },
        // Accent — champagne gold. Safe on navy; gold-700+ only for text on light.
        gold: {
          50: '#FCF8EA',
          100: '#F8EFCB',
          200: '#F0DE95',
          300: '#E5CA60',
          400: '#D4AF37',
          500: '#C29A28',
          600: '#A17E1F',
          700: '#7A6414',
          800: '#5E4D11',
          900: '#453909',
          DEFAULT: '#D4AF37',
        },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(11, 31, 51, 0.05), 0 4px 16px rgba(11, 31, 51, 0.05)',
      },
      keyframes: {
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // Desktop dialogs settle in place rather than sliding.
        'modal-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // Mobile dialogs are bottom sheets — they rise from the edge they touch.
        'sheet-in': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
      },
      animation: {
        'overlay-in': 'overlay-in 150ms ease-out',
        'modal-in': 'modal-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'sheet-in': 'sheet-in 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
