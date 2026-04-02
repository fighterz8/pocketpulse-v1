import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "../../lib/utils";

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

  const linkClass = (path: string) =>
    cn("app-nav-link", location === path && "app-nav-link--active");

  return (
    <div className="app-protected">
      <aside className="app-sidebar">
        <p className="app-nav-brand">PocketPulse</p>
        <nav className="app-nav" aria-label="Main navigation">
          <ul className="app-nav-list">
            <li>
              <Link href="/" className={linkClass("/")}>
                Dashboard
              </Link>
            </li>
            <li>
              <Link href="/upload" className={linkClass("/upload")}>
                Upload
              </Link>
            </li>
            <li>
              <Link
                href="/transactions"
                className={linkClass("/transactions")}
              >
                Ledger
              </Link>
            </li>
            <li>
              <Link href="/leaks" className={linkClass("/leaks")}>
                Recurring Leak Review
              </Link>
            </li>
          </ul>
        </nav>
        <div className="app-sidebar-footer">
          <button
            type="button"
            className="app-nav-logout"
            disabled={logoutPending}
            onClick={() => onLogout()}
          >
            {logoutPending ? "Signing out…" : "Logout"}
          </button>
        </div>
      </aside>
      <main className="app-layout-main">{children}</main>
    </div>
  );
}
