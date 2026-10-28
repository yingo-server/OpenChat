/**
 * 设计令牌 —— 与用户端 apps/client 共用同一份（docs/web-ui-spec.md §10）。
 * 颜色一律引用 CSS 变量（rgb(var(--oc-*) / <alpha-value>)），禁止硬编码 hex。
 * 变量值在 src/styles/tokens.css 的 :root / [data-theme="dark"] 中定义。
 *
 * 命名即令牌名：bg-bg-surface / text-text-primary / border-border-default，
 * 与 §10 表格逐项对应，保证两端 class 可互换。
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: 'rgb(var(--oc-primary-50) / <alpha-value>)',
          100: 'rgb(var(--oc-primary-100) / <alpha-value>)',
          300: 'rgb(var(--oc-primary-300) / <alpha-value>)',
          500: 'rgb(var(--oc-primary-500) / <alpha-value>)',
          600: 'rgb(var(--oc-primary-600) / <alpha-value>)',
          700: 'rgb(var(--oc-primary-700) / <alpha-value>)',
          DEFAULT: 'rgb(var(--oc-primary-500) / <alpha-value>)',
        },
        success: {
          50: 'rgb(var(--oc-success-50) / <alpha-value>)',
          100: 'rgb(var(--oc-success-100) / <alpha-value>)',
          300: 'rgb(var(--oc-success-300) / <alpha-value>)',
          500: 'rgb(var(--oc-success-500) / <alpha-value>)',
          600: 'rgb(var(--oc-success-600) / <alpha-value>)',
          700: 'rgb(var(--oc-success-700) / <alpha-value>)',
          DEFAULT: 'rgb(var(--oc-success-500) / <alpha-value>)',
        },
        warning: {
          50: 'rgb(var(--oc-warning-50) / <alpha-value>)',
          100: 'rgb(var(--oc-warning-100) / <alpha-value>)',
          300: 'rgb(var(--oc-warning-300) / <alpha-value>)',
          500: 'rgb(var(--oc-warning-500) / <alpha-value>)',
          600: 'rgb(var(--oc-warning-600) / <alpha-value>)',
          700: 'rgb(var(--oc-warning-700) / <alpha-value>)',
          DEFAULT: 'rgb(var(--oc-warning-500) / <alpha-value>)',
        },
        danger: {
          50: 'rgb(var(--oc-danger-50) / <alpha-value>)',
          100: 'rgb(var(--oc-danger-100) / <alpha-value>)',
          300: 'rgb(var(--oc-danger-300) / <alpha-value>)',
          500: 'rgb(var(--oc-danger-500) / <alpha-value>)',
          600: 'rgb(var(--oc-danger-600) / <alpha-value>)',
          700: 'rgb(var(--oc-danger-700) / <alpha-value>)',
          DEFAULT: 'rgb(var(--oc-danger-500) / <alpha-value>)',
        },
        info: {
          50: 'rgb(var(--oc-info-50) / <alpha-value>)',
          100: 'rgb(var(--oc-info-100) / <alpha-value>)',
          300: 'rgb(var(--oc-info-300) / <alpha-value>)',
          500: 'rgb(var(--oc-info-500) / <alpha-value>)',
          600: 'rgb(var(--oc-info-600) / <alpha-value>)',
          DEFAULT: 'rgb(var(--oc-info-500) / <alpha-value>)',
        },
        'bg-page': 'rgb(var(--oc-bg-page) / <alpha-value>)',
        'bg-surface': 'rgb(var(--oc-bg-surface) / <alpha-value>)',
        'bg-surface-2': 'rgb(var(--oc-bg-surface-2) / <alpha-value>)',
        'bg-elevated': 'rgb(var(--oc-bg-elevated) / <alpha-value>)',
        'text-primary': 'rgb(var(--oc-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--oc-text-secondary) / <alpha-value>)',
        'text-tertiary': 'rgb(var(--oc-text-tertiary) / <alpha-value>)',
        'text-inverse': 'rgb(var(--oc-text-inverse) / <alpha-value>)',
        'border-default': 'rgb(var(--oc-border-default) / <alpha-value>)',
        scrim: 'rgb(var(--oc-scrim) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          '"PingFang SC"',
          '"HarmonyOS Sans SC"',
          '"MiSans"',
          '"Noto Sans SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          '"Cascadia Mono"',
          'Consolas',
          '"Noto Sans SC"',
          'monospace',
        ],
      },
      fontSize: {
        display: ['24px', { lineHeight: '32px', fontWeight: '700' }],
        title: ['17px', { lineHeight: '24px', fontWeight: '600' }],
        body: ['15px', { lineHeight: '22px', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '20px', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '400' }],
        table: ['14px', { lineHeight: '20px', fontWeight: '400' }],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
        tail: '4px',
        full: '999px',
      },
      spacing: {
        'control-sm': '28px',
        'control-md': '36px',
        'control-lg': '44px',
        'row-table': '48px',
        'side-nav': '240px',
        'side-rail': '64px',
        'top-bar': '56px',
        detail: '320px',
      },
      boxShadow: {
        sm: '0 1px 2px rgb(0 0 0 / 0.05)',
        md: '0 4px 12px rgb(0 0 0 / 0.10)',
        lg: '0 12px 32px rgb(0 0 0 / 0.14)',
      },
      zIndex: {
        base: '0',
        sticky: '10',
        'network-bar': '20',
        drawer: '30',
        modal: '40',
        menu: '50',
        toast: '60',
        tooltip: '70',
      },
      transitionDuration: {
        micro: '100ms',
        normal: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};
