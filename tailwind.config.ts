import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        muted: {
          DEFAULT: "#f4f4f5",
          foreground: "#3f3f46"
        },
        border: "#e4e4e7",
        background: "#ffffff",
        foreground: "#18181b",
        primary: {
          DEFAULT: "#0f172a",
          foreground: "#f8fafc"
        },
        secondary: {
          DEFAULT: "#1d4ed8",
          foreground: "#e0f2fe"
        }
      },
      boxShadow: {
        card: "0 10px 40px rgba(15, 23, 42, 0.15)"
      }
    }
  },
  plugins: []
};

export default config;
