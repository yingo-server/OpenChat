/**
 * Tailwind 设计令牌 —— 逐项抄自 docs/web-ui-spec.md §10。
 * 颜色一律引用 CSS variables（rgb 三元组），亮/暗主题在 styles/index.css 中切换；
 * 组件里禁止硬编码 hex，间距只允许 4px 网格。
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    screens: {
      tablet: '768px',
      desktop: '1200px',
    },
    extend: {
      colors: {
        // 品牌与语义色（§1.3，50/100/300/500/600/700/900 六阶）
        primary: {
          50: 'rgb(var(--primary-50) / <alpha-value>)',
          100: 'rgb(var(--primary-100) / <alpha-value>)',
          300: 'rgb(var(--primary-300) / <alpha-value>)',
          500: 'rgb(var(--primary-500) / <alpha-value>)',
          600: 'rgb(var(--primary-600) / <alpha-value>)',
          700: 'rgb(var(--primary-700) / <alpha-value>)',
          900: 'rgb(var(--primary-900) / <alpha-value>)',
        },
        success: {
          50: 'rgb(var(--success-50) / <alpha-value>)',
          100: 'rgb(var(--success-100) / <alpha-value>)',
          300: 'rgb(var(--success-300) / <alpha-value>)',
          500: 'rgb(var(--success-500) / <alpha-value>)',
          600: 'rgb(var(--success-600) / <alpha-value>)',
          700: 'rgb(var(--success-700) / <alpha-value>)',
          900: 'rgb(var(--success-900) / <alpha-value>)',
        },
        warning: {
          50: 'rgb(var(--warning-50) / <alpha-value>)',
          100: 'rgb(var(--warning-100) / <alpha-value>)',
          300: 'rgb(var(--warning-300) / <alpha-value>)',
          500: 'rgb(var(--warning-500) / <alpha-value>)',
          600: 'rgb(var(--warning-600) / <alpha-value>)',
          700: 'rgb(var(--warning-700) / <alpha-value>)',
          900: 'rgb(var(--warning-900) / <alpha-value>)',
        },
        danger: {
          50: 'rgb(var(--danger-50) / <alpha-value>)',
          100: 'rgb(var(--danger-100) / <alpha-value>)',
          300: 'rgb(var(--danger-300) / <alpha-value>)',
          500: 'rgb(var(--danger-500) / <alpha-value>)',
          600: 'rgb(var(--danger-600) / <alpha-value>)',
          700: 'rgb(var(--danger-700) / <alpha-value>)',
          900: 'rgb(var(--danger-900) / <alpha-value>)',
        },
        info: {
          50: 'rgb(var(--info-50) / <alpha-value>)',
          100: 'rgb(var(--info-100) / <alpha-value>)',
          300: 'rgb(var(--info-300) / <alpha-value>)',
          500: 'rgb(var(--info-500) / <alpha-value>)',
          600: 'rgb(var(--info-600) / <alpha-value>)',
          700: 'rgb(var(--info-700) / <alpha-value>)',
          900: 'rgb(var(--info-900) / <alpha-value>)',
        },

        // 表面 / 文本 / 边框（§10.1）
        // 用法：bg-page / bg-surface / bg-surface-2 / bg-elevated
        page: 'rgb(var(--bg-page) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--bg-surface) / <alpha-value>)',
          2: 'rgb(var(--bg-surface-2) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
          inverse: 'rgb(var(--text-inverse) / <alpha-value>)',
        },
        line: 'rgb(var(--border-default) / <alpha-value>)',
        scrim: 'rgb(var(--scrim) / <alpha-value>)',
      },

      // §10.2 字号 / 行高 / 字重
      fontSize: {
        display: ['24px', { lineHeight: '32px', fontWeight: '700' }],
        title: ['17px', { lineHeight: '24px', fontWeight: '600' }],
        body: ['15px', { lineHeight: '22px', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '20px', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '400' }],
        table: ['14px', { lineHeight: '20px', fontWeight: '400' }],
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'PingFang SC',
          'HarmonyOS Sans SC',
          'MiSans',
          'Noto Sans SC',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
        nums: [
          'SF Mono',
          'ui-monospace',
          'Cascadia Mono',
          'Consolas',
          'Noto Sans SC',
          'monospace',
        ],
      },

      // §10.3 4px 网格（其余沿用 Tailwind 默认，已是 4px 基准）
      spacing: {
        0.5: '2px',
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        6: '24px',
        8: '32px',
        12: '48px',
        16: '64px',
        'control-sm': '28px',
        'control-md': '36px',
        'control-lg': '44px',
        'avatar-xs': '24px',
        'avatar-sm': '32px',
        'avatar-md': '48px',
        'avatar-lg': '64px',
        'avatar-xl': '96px',
        'row-conv': '64px',
        'row-conv-mobile': '72px',
        'row-table': '48px',
        sidebar: '280px',
        detail: '320px',
      },

      // §10.4 圆角
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        tail: '4px',
        xl: '20px',
        full: '999px',
      },

      // §10.5 阴影
      boxShadow: {
        sm: '0 1px 2px rgb(0 0 0 / 0.05)',
        md: '0 4px 12px rgb(0 0 0 / 0.10)',
        lg: '0 12px 32px rgb(0 0 0 / 0.14)',
      },

      // §10.6 动效
      transitionDuration: {
        micro: '100ms',
        normal: '200ms',
        slow: '300ms',
        skeleton: '1200ms',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.2, 0, 0, 1)',
        in: 'ease-in',
      },

      // §10.7 层级
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

      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'wave-breath': {
          '0%, 100%': { transform: 'scaleY(1)' },
          '50%': { transform: 'scaleY(1.5)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.2s linear infinite',
        'fade-in': 'fade-in 200ms cubic-bezier(0.2, 0, 0, 1)',
        'slide-up': 'slide-up 200ms cubic-bezier(0.2, 0, 0, 1)',
        'scale-in': 'scale-in 200ms cubic-bezier(0.2, 0, 0, 1)',
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'wave-breath': 'wave-breath 100ms ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
