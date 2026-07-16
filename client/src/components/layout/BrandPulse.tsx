/**
 * Stable PocketPulse brand mark.
 *
 * Enhancement progress now lives beside the user-controlled workflow on
 * Upload and Ledger. Keeping the navigation mark static prevents an idle
 * client from polling or implying that background work continues after the
 * user leaves the workflow.
 */
export function BrandPulse({
  gradId,
  compact = false,
}: {
  gradId: string;
  /** Centers the mark in the mobile header. */
  compact?: boolean;
}) {
  const blockClass = [
    "brand-pulse-block",
    compact ? "brand-pulse-block--compact" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={blockClass}>
      <div className="brand-pulse-row">
        <svg
          className="brand-pulse-logo"
          viewBox="0 0 32 14"
          fill="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id={gradId}
              x1="0"
              y1="0"
              x2="32"
              y2="0"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor="#0ea5e9" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>
          </defs>
          <polyline
            points="0,7 6,7 9,1 12,13 15,7 32,7"
            stroke={`url(#${gradId})`}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="app-nav-brand">PocketPulse</span>
      </div>
    </div>
  );
}
