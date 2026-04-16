import { type ReactNode, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { DEV_MODE_ENABLED } from "@shared/devConfig";
import { cn } from "../../lib/utils";
import { useAuth } from "../../hooks/use-auth";
import { useTheme } from "../../hooks/use-theme";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Ledger" },
  { href: "/upload", label: "Upload" },
] as const;

export function AppLayout({
  children,
  onLogout,
  logoutPending = false,
}: {
  children: ReactNode;
  onLogout: () => void;
  logoutPending?: boolean;
}) {
  const [location] = useLocation();
  const { user } = useAuth();
  const { isDark, toggleDark } = useTheme();
  const showAccuracy = DEV_MODE_ENABLED && user?.isDev === true;
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeSidebar = () => setMobileOpen(false);

  useEffect(() => {
    closeSidebar();
  }, [location]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const navLinks = (
    <>
      {NAV_ITEMS.map(({ href, label }) => {
        const isActive = location === href;
        return (
          <li key={href}>
            <Link
              href={href}
              data-testid={`nav-link-${label.toLowerCase().replace(/\s+/g, "-")}`}
              className={cn("app-nav-link", isActive && "app-nav-link--active")}
              onClick={closeSidebar}
            >
              {label}
            </Link>
          </li>
        );
      })}
      <li>
        <Link
          href="/leaks"
          data-testid="nav-link-leaks"
          className={cn("app-nav-link", location === "/leaks" && "app-nav-link--active")}
          onClick={closeSidebar}
        >
          Leak Detection
        </Link>
      </li>
      {showAccuracy && (
        <li>
          <Link
            href="/accuracy"
            data-testid="nav-link-accuracy"
            className={cn("app-nav-link app-nav-link--dev", location === "/accuracy" && "app-nav-link--active")}
            onClick={closeSidebar}
          >
            Accuracy Report
            <span className="acc-nav-badge">BETA</span>
          </Link>
        </li>
      )}
    </>
  );

  const pulseSvg = (
    <svg
      className="app-sidebar-brand-pulse"
      viewBox="0 0 32 14"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="pulseGrad" x1="0" y1="0" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <polyline
        points="0,7 6,7 9,1 12,13 15,7 32,7"
        stroke="url(#pulseGrad)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <div className="app-protected">
      {/* Mobile top bar */}
      <header className="mobile-header" aria-label="Mobile navigation bar">
        <button
          type="button"
          className="mobile-hamburger"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((o) => !o)}
          data-testid="btn-mobile-menu"
        >
          {mobileOpen ? (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="4" x2="16" y2="16" />
              <line x1="16" y1="4" x2="4" y2="16" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="17" y2="6" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="14" x2="17" y2="14" />
            </svg>
          )}
        </button>

        <div className="mobile-header-brand">
          {pulseSvg}
          <span className="app-nav-brand">PocketPulse</span>
        </div>

        <button
          type="button"
          className="app-theme-toggle mobile-theme-toggle"
          onClick={toggleDark}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {isDark ? (
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="16" height="16">
              <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.78a1 1 0 011.42 1.42l-.7.7a1 1 0 11-1.42-1.42l.7-.7zM18 9a1 1 0 110 2h-1a1 1 0 110-2h1zM4.22 15.78a1 1 0 001.42-1.42l-.7-.7a1 1 0 00-1.42 1.42l.7.7zM11 17a1 1 0 11-2 0v-1a1 1 0 112 0v1zM4.22 4.22a1 1 0 00-1.42 1.42l.7.7a1 1 0 001.42-1.42l-.7-.7zM3 10a1 1 0 110 2H2a1 1 0 110-2h1zm11.78 5.78a1 1 0 001.42-1.42l-.7-.7a1 1 0 00-1.42 1.42l.7.7zM10 6a4 4 0 100 8 4 4 0 000-8z" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="16" height="16">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
            </svg>
          )}
        </button>
      </header>

      {/* Sidebar overlay (mobile only) */}
      {mobileOpen && (
        <div
          className="mobile-overlay"
          aria-hidden="true"
          onClick={closeSidebar}
        />
      )}

      <aside className={cn("app-sidebar", mobileOpen && "app-sidebar--open")}>
        <div className="app-sidebar-brand">
          {pulseSvg}
          <p className="app-nav-brand">PocketPulse</p>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <ul className="app-nav-list">
            {navLinks}
          </ul>
        </nav>

        <div className="app-sidebar-footer">
          <button
            type="button"
            className="app-theme-toggle"
            onClick={toggleDark}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            data-testid="btn-theme-toggle"
          >
            {isDark ? (
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="15" height="15">
                <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.78a1 1 0 011.42 1.42l-.7.7a1 1 0 11-1.42-1.42l.7-.7zM18 9a1 1 0 110 2h-1a1 1 0 110-2h1zM4.22 15.78a1 1 0 001.42-1.42l-.7-.7a1 1 0 00-1.42 1.42l.7.7zM11 17a1 1 0 11-2 0v-1a1 1 0 112 0v1zM4.22 4.22a1 1 0 00-1.42 1.42l.7.7a1 1 0 001.42-1.42l-.7-.7zM3 10a1 1 0 110 2H2a1 1 0 110-2h1zm11.78 5.78a1 1 0 001.42-1.42l-.7-.7a1 1 0 00-1.42 1.42l.7.7zM10 6a4 4 0 100 8 4 4 0 000-8z" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="15" height="15">
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
              </svg>
            )}
            {isDark ? "Light mode" : "Dark mode"}
          </button>
          <button
            type="button"
            className="app-nav-logout"
            disabled={logoutPending}
            onClick={() => onLogout()}
            data-testid="btn-logout"
          >
            {logoutPending ? "Signing out…" : "Logout"}
          </button>
        </div>
      </aside>

      <main className="app-layout-main">{children}</main>
    </div>
  );
}
