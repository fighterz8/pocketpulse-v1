import { useId, type ReactNode } from "react";
import { useAiEnhancementStatus } from "../../hooks/use-ai-enhancement-status";

/**
 * Brand-integrated AI pulse status.
 *
 * The PocketPulse logo + wordmark are the badge. While the async AI
 * worker is enhancing transactions the brand mark literally pulses with
 * a soft cyan halo and a subtext line below reads "Enhancing
 * transactions… N%". On terminal states the pulse stops and the
 * subtext briefly flips to a completion / failure message before
 * fading out.
 *
 * Replaces the prior standalone AiEnhancementBadge so the visual lives
 * in the brand region itself rather than as a separate header chip.
 *
 * The wrapper carries `data-testid="ai-pulse-badge"` whenever it is in
 * a non-idle state, and the active / terminal subtext nodes carry the
 * same `text-ai-pulse-count` / `text-ai-pulse-status` testids the
 * previous component used. This keeps the e2e badge test contract
 * intact (Task #68) without the test needing to know that the visual
 * was redesigned.
 */
export function BrandPulse({
  gradId,
  compact = false,
}: {
  gradId: string;
  /**
   * Marks the mobile-header instance. The active label copy is
   * identical between modes per spec; this flag only adjusts layout
   * (centred alignment, slightly smaller subtext via CSS).
   */
  compact?: boolean;
}) {
  const {
    anyActive,
    activeCount,
    remaining,
    overallProgress,
    uploads,
    lastJustCompleted,
    lastJustFailed,
  } = useAiEnhancementStatus();

  // useId() must run on every render — never gate it behind an early
  // return. The previous standalone badge regressed exactly this and
  // crashed with "Rendered more hooks than during the previous render"
  // the moment its early-return branch was taken; we keep both hooks
  // unconditionally up here to make repeats of that bug impossible.
  const reactId = useId();
  const tooltipId = `brand-pulse-tooltip-${reactId}`;

  const visualState: "active" | "complete" | "failed" | "idle" = anyActive
    ? "active"
    : lastJustFailed
      ? "failed"
      : lastJustCompleted
        ? "complete"
        : "idle";

  const blockClass = [
    "brand-pulse-block",
    `brand-pulse-block--${visualState}`,
    compact ? "brand-pulse-block--compact" : null,
  ]
    .filter(Boolean)
    .join(" ");

  // Subtext is ALWAYS rendered to reserve a stable vertical slot —
  // mounting/unmounting it would change the brand block's height and
  // shift the surrounding sidebar/header layout every time the worker
  // started or finished. When idle we keep a non-breaking space so the
  // line-box height is preserved, and hide the placeholder from
  // assistive tech.
  let subtextContent: ReactNode = "\u00A0";
  let subtextTestid: string | undefined;
  let badgeTestid: string | undefined;
  let role: "status" | undefined;
  let ariaLive: "polite" | undefined;
  let ariaLabel: string | undefined;
  let titleAttr: string | undefined;
  let interactive = false;

  if (visualState === "active") {
    const percentLabel = `${Math.round(overallProgress * 100)}%`;
    subtextContent = `Enhancing transactions… ${percentLabel}`;
    subtextTestid = "text-ai-pulse-count";
    badgeTestid = "ai-pulse-badge";
    role = "status";
    ariaLive = "polite";
    ariaLabel = `AI enhancement in progress: ${remaining} transactions remaining, ${percentLabel} complete`;
    interactive = true;
  } else if (visualState === "complete") {
    const n = lastJustCompleted as number;
    subtextContent =
      n > 0
        ? `${n} transaction${n === 1 ? "" : "s"} enhanced`
        : "AI enhancement complete";
    subtextTestid = "text-ai-pulse-status";
    badgeTestid = "ai-pulse-badge";
    role = "status";
    ariaLive = "polite";
  } else if (visualState === "failed") {
    // Truncate to keep the subtext line readable; the full reason
    // remains accessible via the title attribute on the wrapper.
    const MAX = 80;
    const reason = lastJustFailed ?? "AI enhancement failed";
    const detail = reason.length > MAX ? `${reason.slice(0, MAX - 1)}…` : reason;
    subtextContent = `AI enhancement failed: ${detail}`;
    subtextTestid = "text-ai-pulse-status";
    badgeTestid = "ai-pulse-badge";
    role = "status";
    ariaLive = "polite";
    titleAttr = reason;
  }

  return (
    <div
      className={blockClass}
      data-testid={badgeTestid}
      role={role}
      aria-live={ariaLive}
      aria-label={ariaLabel}
      title={titleAttr}
      // Keyboard-focusable only when there's an interactive tooltip to
      // reach; otherwise it's just decoration and shouldn't grab focus.
      tabIndex={interactive ? 0 : undefined}
      aria-describedby={interactive ? tooltipId : undefined}
    >
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

      {/* `key` forces re-mount on state transitions so the CSS
          fade/flash keyframes retrigger; without it the span would
          stay mounted across active→complete and the animation would
          never replay. */}
      <span
        key={visualState}
        className={
          visualState === "idle"
            ? "brand-pulse-subtext brand-pulse-subtext--placeholder"
            : "brand-pulse-subtext"
        }
        data-testid={subtextTestid}
        aria-hidden={visualState === "idle" ? true : undefined}
      >
        {subtextContent}
      </span>

      {visualState === "active" && (
        <div className="ai-pulse-tooltip" role="tooltip" id={tooltipId}>
          <p className="ai-pulse-tooltip-title">
            {activeCount} upload{activeCount === 1 ? "" : "s"} being enhanced
          </p>
          <ul className="ai-pulse-tooltip-list">
            {uploads.map((u) => {
              const left = Math.max(
                0,
                (u.aiRowsPending ?? 0) - (u.aiRowsDone ?? 0),
              );
              return (
                <li
                  key={u.uploadId}
                  className="ai-pulse-tooltip-row"
                  data-testid={`ai-pulse-tooltip-row-${u.uploadId}`}
                >
                  <span className="ai-pulse-tooltip-name" title={u.filename}>
                    {u.filename}
                  </span>
                  <span className="ai-pulse-tooltip-progress">
                    {left} left · {Math.round((u.progress ?? 0) * 100)}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
