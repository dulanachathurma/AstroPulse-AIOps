/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: "#04060a",
          panel: "#0a1017",
          line: "#12202b",
        },
        neon: {
          green: "#00ff9c",
          cyan: "#22d3ee",
          pink: "#ff2e88",
          amber: "#ffb000",
          red: "#ff3b3b",
          purple: "#a855f7",
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "IBM Plex Mono",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        blink: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(255, 59, 59, 0.0)" },
          "50%": { boxShadow: "0 0 24px 2px rgba(255, 59, 59, 0.45)" },
        },
      },
      animation: {
        blink: "blink 1s steps(1) infinite",
        pulseGlow: "pulseGlow 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
