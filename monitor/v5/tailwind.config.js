/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],   // 11px
        'xs': ['0.75rem', { lineHeight: '1rem' }],       // 12px
        'sm': ['0.8125rem', { lineHeight: '1.25rem' }],  // 13px
      },
      letterSpacing: {
        'technical': '0.05em',
        'headline': '-0.02em',
      },
      colors: {
        /* Surface hierarchy — CSS variable driven */
        surface: {
          DEFAULT: 'var(--sf-surface)',
          dim: 'var(--sf-surface-dim)',
          'container-lowest': 'var(--sf-surface-container-lowest)',
          'container-low': 'var(--sf-surface-container-low)',
          container: 'var(--sf-surface-container)',
          'container-high': 'var(--sf-surface-container-high)',
          'container-highest': 'var(--sf-surface-container-highest)',
        },

        /* Content */
        'on-surface': {
          DEFAULT: 'var(--sf-on-surface)',
          variant: 'var(--sf-on-surface-variant)',
        },

        /* Primary */
        primary: {
          DEFAULT: 'var(--sf-primary)',
          container: 'var(--sf-primary-container)',
          fixed: 'var(--sf-primary-fixed)',
        },
        'on-primary': 'var(--sf-on-primary)',

        /* Outline */
        outline: {
          variant: 'var(--sf-outline-variant)',
        },

        /* Semantic status */
        status: {
          executing: 'var(--sf-status-executing)',
          planning: 'var(--sf-status-planning)',
          completed: 'var(--sf-status-completed)',
          failed: 'var(--sf-status-failed)',
          warning: 'var(--sf-status-warning)',
          rework: 'var(--sf-status-rework)',
          pending: 'var(--sf-status-pending)',
        },

        /* Agent identity */
        agent: {
          developer: '#06b6d4',
          qa: '#10b981',
          product: '#8b5cf6',
          architect: '#3b82f6',
          security: '#ef4444',
          'code-review': '#f59e0b',
          devops: '#64748b',
          'ui-ux': '#ec4899',
          orchestrator: 'var(--sf-primary)',
        },
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        sm: '0.125rem',
        md: '0.375rem',
        lg: '0.5rem',
      },
      boxShadow: {
        'ambient': '0 4px 24px var(--sf-shadow-color)',
        'ambient-sm': '0 2px 8px var(--sf-shadow-color)',
        'glow-primary': '0 0 12px var(--sf-primary-glow)',
        'glow-executing': '0 0 8px rgba(77, 142, 255, 0.2)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 8px rgba(77, 142, 255, 0.15)' },
          '50%': { boxShadow: '0 0 16px rgba(77, 142, 255, 0.3)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
