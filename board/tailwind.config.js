// The whiteboard's Tailwind: the desktop app's config (tailwind.config.js at
// the root: the same tokens — bg-card, text-foreground, border … — and
// Tailwind 3.4) as a preset, with the board's own content and the iPadOS
// pieces on top: system colours, materials, the popover/sheet springs.
// The tokens' values are set in board/src/style.css (light, and dark with
// prefers-color-scheme), the same HSL variables the desktop defines.
import root from "../tailwind.config.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  presets: [root],
  content: [join(here, "index.html"), join(here, "src/**/*.ts")],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // iPadOS system colours (light/dark values in style.css).
        sys: {
          blue: "rgb(var(--sys-blue) / <alpha-value>)",
          red: "rgb(var(--sys-red) / <alpha-value>)",
          green: "rgb(var(--sys-green) / <alpha-value>)",
          fill: "rgb(var(--sys-fill) / <alpha-value>)",
          label: "rgb(var(--sys-label) / <alpha-value>)",
          secondary: "rgb(var(--sys-secondary) / <alpha-value>)",
          tertiary: "rgb(var(--sys-tertiary) / <alpha-value>)",
          separator: "rgb(var(--sys-separator) / <alpha-value>)",
          grouped: "rgb(var(--sys-grouped) / <alpha-value>)",
          material: "rgb(var(--sys-material) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "system-ui", "Inter", "sans-serif"],
        display: ["-apple-system", "BlinkMacSystemFont", "SF Pro Display", "system-ui", "Inter", "sans-serif"],
      },
      fontSize: {
        // iOS text styles.
        caption: ["12px", { lineHeight: "16px" }],
        footnote: ["13px", { lineHeight: "18px" }],
        subhead: ["15px", { lineHeight: "20px" }],
        body: ["17px", { lineHeight: "22px" }],
        title3: ["20px", { lineHeight: "25px" }],
        large: ["34px", { lineHeight: "41px", letterSpacing: "0.01em" }],
      },
      boxShadow: {
        float: "0 0 0 0.5px rgb(0 0 0 / 0.06), 0 1px 2px rgb(0 0 0 / 0.06), 0 6px 20px rgb(0 0 0 / 0.10)",
        pop: "0 0 0 0.5px rgb(0 0 0 / 0.08), 0 2px 6px rgb(0 0 0 / 0.08), 0 16px 40px rgb(0 0 0 / 0.18)",
        tile: "0 0 0 0.5px rgb(0 0 0 / 0.07), 0 1px 3px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.07)",
        sheet: "-1px 0 0 rgb(0 0 0 / 0.06), -12px 0 40px rgb(0 0 0 / 0.14)",
      },
      backdropBlur: { material: "20px", thick: "30px" },
      backdropSaturate: { 180: "1.8" },
      transitionTimingFunction: { spring: "cubic-bezier(0.34, 1.36, 0.64, 1)", ios: "cubic-bezier(0.32, 0.72, 0, 1)" },
      keyframes: {
        "pop-in": { from: { opacity: "0", transform: "scale(0.92) translateY(-4px)" }, to: { opacity: "1", transform: "none" } },
        "sheet-in": { from: { transform: "translateX(104%)" }, to: { transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": { from: { opacity: "0", transform: "translateY(10px) scale(0.98)" }, to: { opacity: "1", transform: "none" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
      },
      animation: {
        "pop-in": "pop-in 180ms cubic-bezier(0.34, 1.36, 0.64, 1) both",
        "sheet-in": "sheet-in 320ms cubic-bezier(0.32, 0.72, 0, 1) both",
        "fade-in": "fade-in 160ms ease-out both",
        "rise-in": "rise-in 220ms cubic-bezier(0.32, 0.72, 0, 1) both",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
};
