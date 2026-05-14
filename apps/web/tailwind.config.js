/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#faf7f2',
          100: '#f2ead9',
          200: '#e4d4b2',
          300: '#d2b985',
          400: '#c29d60',
          500: '#b5874a',
          600: '#9a6f3b',
          700: '#7c5831',
          800: '#67482d',
          900: '#573d29',
          950: '#2f1f13',
        },
      },
    },
  },
  plugins: [],
};
