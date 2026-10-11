// Personal theme: warm neutrals with a clay accent. Overriding the stock
// palettes below re-tints every existing `blue-*` / `gray-*` utility in the
// components, so the look changes without touching component class names.
const clay = {
  50: '#fbf4f0',
  100: '#f6e5dc',
  200: '#edcab9',
  300: '#e2a88c',
  400: '#d98a69',
  500: '#c96442',
  600: '#ae4f2e',
  700: '#8f3f24',
  800: '#733420',
  900: '#5d2d1d',
  950: '#33160c',
};

// Warm gray: off-white (50) to warm charcoal (900/950). Step 500 keeps 4.5:1 on
// white and on gray-100; step 400 keeps 4.5:1 on gray-800 and gray-900.
const warmNeutral = {
  50: '#faf9f5',
  100: '#f4f2ec',
  200: '#e8e5dc',
  300: '#d4d0c5',
  400: '#a29d91',
  500: '#716d66',
  600: '#5b5852',
  700: '#403e3a',
  800: '#30302e',
  900: '#262624',
  950: '#1c1b19',
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      colors: {
        blue: clay,
        gray: warmNeutral,
        slate: warmNeutral,
        zinc: warmNeutral,
        neutral: warmNeutral,
        sidebar: "hsl(var(--sidebar))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // Soft, warm-tinted shadows; --shadow-color is set per theme in index.css.
      boxShadow: {
        sm: '0 1px 2px 0 hsl(var(--shadow-color) / 0.05)',
        DEFAULT: '0 1px 3px 0 hsl(var(--shadow-color) / 0.07), 0 1px 2px -1px hsl(var(--shadow-color) / 0.05)',
        md: '0 4px 12px -2px hsl(var(--shadow-color) / 0.08), 0 2px 4px -2px hsl(var(--shadow-color) / 0.05)',
        lg: '0 12px 28px -6px hsl(var(--shadow-color) / 0.12), 0 4px 8px -4px hsl(var(--shadow-color) / 0.06)',
        xl: '0 20px 40px -8px hsl(var(--shadow-color) / 0.16), 0 8px 16px -8px hsl(var(--shadow-color) / 0.08)',
        '2xl': '0 28px 56px -12px hsl(var(--shadow-color) / 0.22)',
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
        'mobile-nav': 'var(--mobile-nav-total)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-content-show': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'bottom-sheet-content-show': {
          from: { opacity: '0', transform: 'translateY(100%)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 150ms ease-out',
        'dialog-content-show': 'dialog-content-show 150ms ease-out',
        'bottom-sheet-content-show': 'bottom-sheet-content-show 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
