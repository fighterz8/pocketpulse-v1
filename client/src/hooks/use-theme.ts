import { useEffect, useState, useCallback } from "react";

export type Theme = "light" | "dark" | "system";

function resolveTheme(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyClass(isDark: boolean) {
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("pp-theme") as Theme) ?? "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    applyClass(resolveTheme(theme));

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => applyClass(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem("pp-theme", t);
    } catch {}
    setThemeState(t);
  }, []);

  const toggleDark = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const isDark = theme === "dark" || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return { theme, setTheme, toggleDark, isDark };
}
