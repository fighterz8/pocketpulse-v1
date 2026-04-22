import { useId } from "react";
import { useAiEnhancementStatus } from "../../hooks/use-ai-enhancement-status";

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * Small pulse-style header badge that reflects the async AI worker's
 * progress. Only renders when there is something active, or briefly when
 * a run just finished / failed.
 */
export function AiEnhancementBadge({ compact = false }: { compact?: boolean }) {
  const {
    anyActive,
    activeCount,
    remaining,
    overallProgress,
    uploads,
    lastJustCompleted,
    lastJustFailed,
  } = useAiEnhancementStatus();

  if (!anyActive && !lastJustCompleted && !lastJustFailed) return null;

  if (lastJustFailed && !anyActive) {
    // Truncate to keep the header chip readable; the full error is on
    // the title attribute for users who want the detail.
    const MAX = 80;
    const detail =
      lastJustFailed.length > MAX
        ? `${lastJustFailed.slice(0, MAX - 1)}…`
        : lastJustFailed;
    return (
      <div
        className="ai-pulse-badge ai-pulse-badge--failed"
        data-testid="ai-pulse-badge"
        role="status"
        aria-live="polite"
        title={lastJustFailed}
      >
        <span className="ai-pulse-dot ai-pulse-dot--failed" aria-hidden="true" />
        <span className="ai-pulse-text" data-testid="text-ai-pulse-status">
          AI enhancement failed: {detail}
        </span>
      </div>
    );
  }

  if (lastJustCompleted && !anyActive) {
    return (
      <div
        className="ai-pulse-badge ai-pulse-badge--complete"
        data-testid="ai-pulse-badge"
        role="status"
        aria-live="polite"
      >
        <span className="ai-pulse-dot ai-pulse-dot--complete" aria-hidden="true" />
        <span className="ai-pulse-text" data-testid="text-ai-pulse-status">
          AI enhancement complete
        </span>
      </div>
    );
  }

  const label = compact
    ? `${remaining} left · ${pct(overallProgress)}`
    : `Enhancing ${remaining} transaction${remaining === 1 ? "" : "s"}… (${pct(overallProgress)})`;

  // useId() so multiple badge instances (sidebar + mobile header) never
  // emit duplicate DOM ids — important for aria-describedby correctness
  // and for any QA tooling that walks the accessibility tree.
  const tooltipId = `ai-pulse-tooltip-${useId()}`;

  return (
    <div
      className="ai-pulse-badge ai-pulse-badge--active"
      data-testid="ai-pulse-badge"
      role="status"
      aria-live="polite"
      aria-label={`AI enhancement in progress: ${remaining} transactions remaining, ${pct(overallProgress)} complete`}
      // Make the badge keyboard-focusable so screen-reader and
      // keyboard-only users can reach the per-upload tooltip via Tab.
      // The CSS opens the tooltip on :focus-within in addition to :hover.
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <span className="ai-pulse-dot" aria-hidden="true">
        <span className="ai-pulse-ring" />
        <span className="ai-pulse-core" />
      </span>
      <span className="ai-pulse-text" data-testid="text-ai-pulse-count">
        {label}
      </span>
      {/* Hover/focus tooltip — listed per upload so the user can see which
          file contributed which rows. Linked via aria-describedby above. */}
      <div className="ai-pulse-tooltip" role="tooltip" id={tooltipId}>
        <p className="ai-pulse-tooltip-title">
          {activeCount} upload{activeCount === 1 ? "" : "s"} being enhanced
        </p>
        <ul className="ai-pulse-tooltip-list">
          {uploads.map((u) => {
            const left = Math.max(0, (u.aiRowsPending ?? 0) - (u.aiRowsDone ?? 0));
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
                  {left} left · {pct(u.progress ?? 0)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
