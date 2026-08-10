/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#171717',
        charcoal: '#242424',
        cream: '#FAF9F6',
        gold: '#C9A227',
        success: '#2F7D5A',
        danger: '#C94C4C',
        brand: {
          50: '#fbf8ef',
          100: '#f5eed6',
          200: '#ebe0ad',
          300: '#dfcd7a',
          400: '#d4b84a',
          500: '#C9A227',
          600: '#a8861f',
          700: '#866819',
          800: '#6b5318',
          900: '#594516',
          950: '#33260c',
        },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(23, 23, 23, 0.04), 0 4px 16px rgba(23, 23, 23, 0.04)',
      },
    },
  },
  plugins: [],
};
