import colors from 'tailwindcss/colors'
import plugin from 'tailwindcss/plugin'

// Light and dark themes share the same class names: every colour is a CSS variable ("R G B" so that opacity such as bg-surface/80
// works) that is defined once for the light theme on :root and once for the dark theme on :root[data-theme="dark"].
// src/lib/theme.ts sets data-theme from Telegram's colour scheme (or the browser's outside Telegram).

const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}
const ref = (name) => `rgb(var(--${name}) / <alpha-value>)`

const light = {}
const dark = {}
const palette = {}

/** One colour of the app: its light value and its dark value. */
function token(name, lightHex, darkHex) {
  light[`--${name}`] = channels(lightHex)
  dark[`--${name}`] = channels(darkHex)
  return ref(name)
}

/**
 * Tailwind's own palette, themed. In the dark theme a pale tint (50..200) becomes the matching deep shade and dark text (700..900)
 * the matching pale one, so "bg-rose-50 text-rose-700" is a deep red panel with light red text. 400..600 are solid fills and stay.
 */
const MIRROR = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 400, 500: 500, 600: 600, 700: 300, 800: 200, 900: 100 }
const USED = {
  rose: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900],
  amber: [50, 100, 200, 300, 500, 600, 700, 800, 900],
  emerald: [50, 200, 300, 500, 600, 700, 800],
}
for (const [name, shades] of Object.entries(USED)) {
  palette[name] = {}
  for (const s of shades) palette[name][s] = token(`${name}-${s}`, colors[name][s], colors[name][MIRROR[s]])
}

// Slate is the app's neutral grey (chips, switches, skeletons, secondary text); blue-100 is the hairline border of every card.
const SLATE_DARK = { 100: '#1E2B3A', 200: '#2A3A4D', 300: '#3A4C61', 400: '#6F8296', 500: '#8FA1B5', 600: '#A9B8C9', 700: '#C4CFDB', 900: '#E8EEF5' }
palette.slate = {}
for (const [s, hex] of Object.entries(SLATE_DARK)) palette.slate[s] = token(`slate-${s}`, colors.slate[s], hex)
palette.blue = {
  50: token('blue-50', colors.blue[50], '#15212E'),
  100: token('blue-100', colors.blue[100], '#2A3A4C'),
  700: token('blue-700', colors.blue[700], '#7CC4F5'),
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ...palette,
        brand: {
          DEFAULT: '#0098EA',
          hover: '#0082C8',
          light: token('brand-light', '#E1F1FD', '#16384F'),
          dark: '#0070B8',
          text: token('brand-text', '#0277BD', '#5CBFF5'),
        },
        // cards and sheets / the panel inside a card
        surface: { DEFAULT: token('surface', '#FFFFFF', '#17212B'), sub: token('surface-sub', '#F5F9FD', '#1E2A37') },
        // the screen behind the cards (top and bottom of its gradient), and what is behind the phone frame on a desktop
        screen: { DEFAULT: token('screen', '#EBF3FE', '#0E1621'), end: token('screen-end', '#F8FAFC', '#0E1621') },
        backdrop: token('backdrop', '#F1F5F9', '#070B11'),
        // the balance card's gradient
        'card-mid': token('card-mid', '#F2F8FF', '#1A2838'),
        'card-end': token('card-end', '#D6EBFD', '#1D3A55'),
        content: {
          primary: token('content-primary', '#0F172A', '#E8EEF5'),
          secondary: token('content-secondary', '#64748B', '#9AA9BA'),
          muted: token('content-muted', '#94A3B8', '#6F8296'),
        },
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
        sky: 'linear-gradient(to bottom, rgb(var(--screen)), rgb(var(--screen-end)))',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': { ...light, colorScheme: 'light' },
        ':root[data-theme="dark"]': { ...dark, colorScheme: 'dark' },
      })
    }),
  ],
}
