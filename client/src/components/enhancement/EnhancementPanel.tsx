import { Link } from "wouter";

import {
  type EnhancementAccess,
  type EnhancementJob,
  useEnhancementWorkflow,
} from "../../hooks/use-enhancement-workflow";

type EnhancementPanelProps = {
  uploadId: number;
  surface: "upload" | "ledger";
};

function merchantLabel(count: number): string {
  return `${count} merchant${count === 1 ? "" : "s"}`;
}

function ManualReviewLink({ surface }: { surface: "upload" | "ledger" }) {
  if (surface === "ledger") {
    return (
      <a className="enhancement-manual-link" href="#ledger-transactions">
        Review manually below
      </a>
    );
  }
  return (
    <Link className="enhancement-manual-link" href="/transactions">
      Review manually in Ledger
    </Link>
  );
}

function AccessExplanation({
  access,
  surface,
}: {
  access: EnhancementAccess;
  surface: "upload" | "ledger";
}) {
  const needsRecovery = access.state === "past_due" || access.state === "expired";
  return (
    <>
      <p className="enhancement-copy">
        {needsRecovery
          ? "Plus access needs attention. Enhancement stays paused, while your imported data and corrections remain available."
          : "PocketPulse Plus is planned to review unresolved merchants and apply the result to matching transactions. Free imports and manual corrections stay available."}
      </p>
      {access.trialAvailable ? (
        <p className="enhancement-trial-note">A 7-day trial is planned; checkout is not enabled yet.</p>
      ) : null}
      <ManualReviewLink surface={surface} />
    </>
  );
}

function AccessRecoveryState({
  surface,
  titleId,
}: {
  surface: "upload" | "ledger";
  titleId: string;
}) {
  return (
    <>
      <h2 className="enhancement-title" id={titleId}>Monthly enhancement allowance reached</h2>
      <p className="enhancement-copy">
        Plus access needs attention. Manual review remains available, and any completed changes are preserved.
      </p>
      <ManualReviewLink surface={surface} />
    </>
  );
}

function Progress({ job }: { job: EnhancementJob }) {
  const resolved = job.completedMerchants + job.skippedMerchants + job.failedMerchants;
  return (
    <div className="enhancement-progress">
      <div
        className="enhancement-progress-track"
        role="progressbar"
        aria-label="Merchant enhancement progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
      >
        <span className="enhancement-progress-fill" style={{ width: `${job.progress}%` }} />
      </div>
      <span className="enhancement-progress-label">
        {resolved} of {job.totalMerchants} merchants reviewed · {job.progress}%
      </span>
    </div>
  );
}

function JobState({
  job,
  access,
  surface,
  busy,
  cancelling,
  hasError,
  onResume,
  onCancel,
  titleId,
}: {
  job: EnhancementJob;
  access: EnhancementAccess;
  surface: "upload" | "ledger";
  busy: boolean;
  cancelling: boolean;
  hasError: boolean;
  onResume: () => void;
  onCancel: () => void;
  titleId: string;
}) {
  const running = job.status === "queued" || job.status === "processing";
  const needsAccessRecovery = access.state === "past_due" || access.state === "expired";
  const title =
    job.status === "complete"
      ? "Enhancement complete"
      : job.status === "partial"
        ? "Enhancement partially complete"
        : job.status === "cancelled"
          ? "Enhancement cancelled"
          : job.status === "budget_blocked"
            ? "Monthly enhancement allowance reached"
            : job.status === "failed"
              ? "Enhancement paused"
              : `Enhancing ${merchantLabel(job.totalMerchants)}`;

  return (
    <>
      <div aria-live="polite" role="status">
        <h2 className="enhancement-title" id={titleId}>{title}</h2>
        <Progress job={job} />
        <p className="enhancement-copy">
          {needsAccessRecovery
            ? "Plus access needs attention. Manual review remains available, and completed changes are preserved."
            : running
              ? "PocketPulse runs one bounded batch at a time. Leaving this page pauses before another batch starts; returning resumes the durable job."
              : job.status === "complete"
                ? "Reviewed merchant labels have been applied to matching transactions."
                : "Imported transactions remain ready to review, and completed changes are preserved."}
        </p>
      </div>
      {job.failedMerchants > 0 ? (
        <p className="enhancement-detail">{job.failedMerchants} merchant{job.failedMerchants === 1 ? "" : "s"} could not be resolved.</p>
      ) : null}
      {hasError ? (
        <p className="enhancement-error" role="alert">
          Enhancement paused. Your imported transactions remain ready to review.
        </p>
      ) : null}
      {running ? (
        <div className="enhancement-actions">
          {hasError ? (
            <button type="button" className="enhancement-button enhancement-button--primary" onClick={onResume} disabled={busy || cancelling}>
              {busy ? "Resuming…" : "Resume enhancement"}
            </button>
          ) : null}
          <button type="button" className="enhancement-button enhancement-button--secondary" onClick={onCancel} disabled={busy || cancelling}>
            {cancelling ? "Cancelling…" : "Cancel enhancement"}
          </button>
        </div>
      ) : (
        <ManualReviewLink surface={surface} />
      )}
    </>
  );
}

export function EnhancementPanel({ uploadId, surface }: EnhancementPanelProps) {
  const workflow = useEnhancementWorkflow(uploadId);
  const titleId = `enhancement-title-${surface}-${uploadId}`;

  if (workflow.isLoading) {
    return (
      <section className="enhancement-panel" aria-busy="true" aria-label="Loading enhancement availability">
        <div className="enhancement-skeleton" />
      </section>
    );
  }

  if (!workflow.availability) {
    return (
      <section className="enhancement-panel" data-testid="enhancement-panel">
        <h2 className="enhancement-title">Enhancement status unavailable</h2>
        <p className="enhancement-copy">Imported transactions remain ready to review.</p>
        <button type="button" className="enhancement-button enhancement-button--secondary" onClick={workflow.retryAvailability}>
          Try again
        </button>
      </section>
    );
  }

  const { availability, access, job } = workflow;
  const entitled = access.state === "active" || access.state === "trialing";
  const needsAccessRecovery = access.state === "past_due" || access.state === "expired";
  const count = availability.unresolvedMerchantCount;

  return (
    <section className="enhancement-panel" data-testid="enhancement-panel" aria-labelledby={titleId}>
      <div className="enhancement-eyebrow">Transaction review</div>
      {job ? (
        <JobState
          job={job}
          access={access}
          surface={surface}
          busy={workflow.isAdvancing}
          cancelling={workflow.isCancelling}
          hasError={Boolean(workflow.error)}
          onResume={workflow.resume}
          onCancel={workflow.cancel}
          titleId={titleId}
        />
      ) : needsAccessRecovery && availability.activeJobId ? (
        <AccessRecoveryState surface={surface} titleId={titleId} />
      ) : availability.state === "complete" || availability.state === "not_needed" ? (
        <>
          <h2 className="enhancement-title" id={titleId}>No merchant review needed</h2>
          <p className="enhancement-copy">This import is already resolved. You can still adjust any label manually in Ledger.</p>
          <ManualReviewLink surface={surface} />
        </>
      ) : !entitled ? (
        <>
          <h2 className="enhancement-title" id={titleId}>{merchantLabel(count)} need review · PocketPulse Plus</h2>
          <AccessExplanation access={access} surface={surface} />
        </>
      ) : availability.state === "available" ? (
        <>
          <h2 className="enhancement-title" id={titleId}>{merchantLabel(count)} need review</h2>
          <p className="enhancement-copy">Review each unique merchant once, then apply the result to matching transactions. Work starts only when you choose it.</p>
          <div className="enhancement-actions">
            <button type="button" className="enhancement-button enhancement-button--primary" onClick={workflow.start} disabled={workflow.isStarting}>
              {workflow.isStarting ? "Starting…" : `Enhance ${merchantLabel(count)}`}
            </button>
            <ManualReviewLink surface={surface} />
          </div>
        </>
      ) : (
        <>
          <h2 className="enhancement-title" id={titleId}>Enhancement preview</h2>
          <p className="enhancement-copy">Enhancement is not available yet. Your import is complete and ready for manual review.</p>
          <ManualReviewLink surface={surface} />
        </>
      )}
    </section>
  );
}
