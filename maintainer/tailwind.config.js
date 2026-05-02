/** Theme tokens copied from vault-chat main so the maintainer feels
 *  like a sibling app. Don't import from main — this is meant to be
 *  a self-contained, low-coupling project. Keep the values in sync if
 *  the main app's palette ever changes. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="light"]'],
  theme: {
    extend: {
      colors: {
        border: "hsl(240 5% 22%)",
        input: "hsl(240 5% 18%)",
        ring: "hsl(240 5% 35%)",
        background: "hsl(240 5% 10%)",
        foreground: "hsl(240 6% 92%)",
        card: "hsl(240 6% 13%)",
        muted: { DEFAULT: "hsl(240 5% 17%)", foreground: "hsl(240 5% 65%)" },
        accent: { DEFAULT: "hsl(240 5% 22%)", foreground: "hsl(240 6% 92%)" },
        primary: { DEFAULT: "hsl(238 80% 66%)", foreground: "hsl(0 0% 100%)" },
        destructive: { DEFAULT: "hsl(0 70% 55%)", foreground: "hsl(0 0% 100%)" },
        indigo: { 300: "#a5b4fc", 400: "#818cf8", 500: "#6366f1" },
        emerald: { 500: "#10b981" },
        amber: { 500: "#f59e0b" },
        rose: { 400: "#fb7185", 500: "#f43f5e" },
      },
      borderRadius: { lg: "8px", md: "6px", sm: "4px" },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
