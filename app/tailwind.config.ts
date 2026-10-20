import animate from "tailwindcss-animate";
import type { Config } from "tailwindcss";

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "Segoe UI", "Nirmala UI", "system-ui", "sans-serif"],
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["14px", "20px"],
        base: ["16px", "24px"],
        lg: ["20px", "28px"],
        xl: ["28px", "36px"],
        "2xl": ["40px", "48px"],
      },
      colors: {
        border: token("border"),
        input: token("border"),
        ring: token("ring"),
        background: token("surface"),
        foreground: token("text"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        text: token("text"),
        "text-muted": token("text-muted"),
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        success: token("success"),
        warning: token("warning"),
        danger: { DEFAULT: token("danger"), foreground: token("primary-foreground") },
        muted: { DEFAULT: token("surface-2"), foreground: token("text-muted") },
        accent: { DEFAULT: token("surface-2"), foreground: token("text") },
        popover: { DEFAULT: token("surface"), foreground: token("text") },
        cat: {
          organize: token("cat-organize"),
          optimize: token("cat-optimize"),
          convert: token("cat-convert"),
          edit: token("cat-edit"),
          security: token("cat-security"),
          intelligence: token("cat-intelligence"),
        },
      },
      borderRadius: {
        card: "12px",
        lg: "12px",
        md: "8px",
        sm: "6px",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
