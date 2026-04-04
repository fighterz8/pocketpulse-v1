import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "../../lib/utils";
import { useRecurringCandidates } from "../../hooks/use-recurring";

// Must stay in sync with AUTO_HIDDEN_CATEGORIES in Leaks.tsx
const SIDEBAR_HIDDEN_CATEGORIES = new Set(["housing"]);

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
      !SIDEBAR_HIDDEN_CATEGORIES.has(c.category) &&
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
          <span className="app-sidebar-brand-dot" />
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
                label="Recurring & Leaks"
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
