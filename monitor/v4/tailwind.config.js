/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Syne"', 'system-ui', 'sans-serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      colors: {
        surface: {
          50: '#FAFAF8',
          100: '#FFFFFF',
          200: '#F3F2EF',
          300: '#E8E6E1',
          400: '#D5D3CD',
        },
        ink: {
          900: '#1A1A17',
          700: '#3D3D37',
          500: '#6B6B63',
          400: '#8E8E86',
          300: '#ABABAA',
        },
        brand: {
          DEFAULT: '#FF4D00',
          light: '#FFF0E8',
          medium: '#FFDCC8',
          dark: '#CC3D00',
          text: '#A63300',
        },
        status: {
          running: '#0077CC',
          'running-light': '#E8F4FD',
          'running-border': '#B3D9F2',
          success: '#1A8754',
          'success-light': '#E8F8F0',
          'success-border': '#A8E0C4',
          error: '#CC2936',
          'error-light': '#FFF0F0',
          'error-border': '#F0B3B8',
          warning: '#C47F17',
          'warning-light': '#FFF8E8',
          'warning-border': '#F0D88A',
          planning: '#7C3AED',
          'planning-light': '#F3EFFE',
          'planning-border': '#C4B5FD',
        },
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)',
        'card-hover': '0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
        panel: '0 8px 32px rgba(0,0,0,0.06)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
