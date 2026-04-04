/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./client/**/*.{ts,tsx,js,jsx}",
    "./client/index.html",
  ],
  darkMode: "class",
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          900: "#1e3a8a",
        },
      },
      spacing: {
        sidebar: "15rem",
      },
      backdropBlur: {
        glass: "20px",
      },
      boxShadow: {
        glass: "0 4px 24px rgb(15 23 42 / 0.07), inset 0 1px 0 rgb(255 255 255 / 0.8)",
        "glass-hover": "0 6px 28px rgb(15 23 42 / 0.1), inset 0 1px 0 rgb(255 255 255 / 0.9)",
      },
    },
  },
  plugins: [],
};
