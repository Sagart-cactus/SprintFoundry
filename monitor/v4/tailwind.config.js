/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"DM Sans"', 'system-ui', 'sans-serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      colors: {
        surface: {
          50: '#F8F9FA',
          100: '#FFFFFF',
          200: '#F1F3F5',
          300: '#E1E4E8',
          400: '#D0D4DA',
        },
        ink: {
          900: '#141821',
          700: '#343A46',
          500: '#5C6370',
          400: '#7E8694',
          300: '#A0A8B4',
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
          rework: '#D97706',
          'rework-light': '#FFFBEB',
          'rework-border': '#FCD34D',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.03)',
        'card-hover': '0 2px 8px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        panel: '0 4px 24px rgba(0,0,0,0.06)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
