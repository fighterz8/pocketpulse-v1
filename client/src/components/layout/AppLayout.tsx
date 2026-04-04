import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { AUTO_ESSENTIAL_CATEGORIES } from "@shared/schema";
import { cn } from "../../lib/utils";
import { useRecurringCandidates } from "../../hooks/use-recurring";

function RecurringNavItem({ href, label, isActive }: { href: string; label: string; isActive: boolean }) {
  // Eagerly read from cache — the Leaks page populates this; if not yet loaded it's undefined.
  const { data } = useRecurringCandidates();

  // Mirror the same filter logic as the Leaks page so the dot disappears exactly
  // when the page shows "All caught up!": exclude auto-hidden categories and cap
  // at 6 months so old cancelled subscriptions don't keep the light on.
  const sixMonthCutoff = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const unreviewedCount = data?.candidates.filter(
    (c) =>
      !AUTO_ESSENTIAL_CATEGORIES.has(c.category) &&
      c.reviewStatus === "unreviewed" &&
      c.lastSeen >= sixMonthCutoff,
  ).length ?? 0;
  const needsReview = unreviewedCount > 0;

  return (
    <Link
      href={href}
      data-testid="nav-link-recurring-leak-review"
      className={cn("app-nav-link", isActive && "app-nav-link--active")}
    >
      <span className="flex items-center gap-2">
        {label}
        {needsReview && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
        )}
      </span>
    </Link>
  );
}

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

  return (
    <div className="app-protected">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand">
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
          <p className="app-nav-brand">PocketPulse</p>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <ul className="app-nav-list">
            {NAV_ITEMS.map(({ href, label }) => {
              const isActive = location === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    data-testid={`nav-link-${label.toLowerCase().replace(/\s+/g, "-")}`}
                    className={cn("app-nav-link", isActive && "app-nav-link--active")}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
            {/* Recurring Leak Review — gets a live indicator dot when items need review */}
            <li>
              <RecurringNavItem
                href="/leaks"
                label="Subscription Leaks"
                isActive={location === "/leaks"}
              />
            </li>
          </ul>
        </nav>

        <div className="app-sidebar-footer">
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
