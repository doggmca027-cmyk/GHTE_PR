/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#0098EA',
          hover: '#0082C8',
          light: '#E1F1FD',
          dark: '#0070B8',
          text: '#0277BD',
        },
        surface: { DEFAULT: '#FFFFFF', sub: '#F5F9FD' },
        content: { primary: '#0F172A', secondary: '#64748B', muted: '#94A3B8' },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: { card: '24px', 'card-lg': '28px' },
      boxShadow: { card: '0 8px 30px rgb(0 136 204 / 0.06)' },
      keyframes: {
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'sheet-up': 'sheet-up 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-in': 'fade-in 200ms ease-out',
      },
      backgroundImage: {
        sky: 'linear-gradient(to bottom, #EBF3FE, #FFFFFF)',
      },
    },
  },
  plugins: [],
}
