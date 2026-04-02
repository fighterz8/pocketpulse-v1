import { useState } from "react";

import {
  useRecurringCandidates,
  useReviewMutation,
  type RecurringCandidate,
  type ReviewStatus,
} from "../hooks/use-recurring";

type FilterTab = "all" | ReviewStatus;

const TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unreviewed", label: "Unreviewed" },
  { key: "essential", label: "Essential" },
  { key: "leak", label: "Leaks" },
  { key: "dismissed", label: "Dismissed" },
];

function confidenceLabel(c: number): string {
  if (c >= 0.75) return "High";
  if (c >= 0.5) return "Medium";
  return "Low";
}

function confidenceClass(c: number): string {
  if (c >= 0.75) return "leaks-confidence--high";
  if (c >= 0.5) return "leaks-confidence--medium";
  return "leaks-confidence--low";
}

function formatCurrency(n: number): string {
  return "$" + n.toFixed(2);
}

function CandidateCard({
  candidate,
  onReview,
  isPending,
}: {
  candidate: RecurringCandidate;
  onReview: (key: string, status: ReviewStatus) => void;
  isPending: boolean;
}) {
  const statusClass =
    candidate.reviewStatus !== "unreviewed"
      ? `leaks-card--${candidate.reviewStatus}`
      : "";

  return (
    <div className={`leaks-card ${statusClass}`}>
      <div className="leaks-card-header">
        <div className="leaks-card-merchant">{candidate.merchantDisplay}</div>
        <div className="leaks-card-amount">
          {formatCurrency(candidate.averageAmount)}
          <span className="leaks-card-freq">/{candidate.frequency}</span>
        </div>
      </div>

      <div className="leaks-card-details">
        <span className={`leaks-confidence ${confidenceClass(candidate.confidence)}`}>
          {confidenceLabel(candidate.confidence)} confidence
        </span>
        <span className="leaks-card-category">{candidate.category}</span>
        <span className="leaks-card-date">
          Last: {candidate.lastSeen}
        </span>
        <span className="leaks-card-date">
          Next: {candidate.expectedNextDate}
        </span>
      </div>

      <div className="leaks-card-reason">{candidate.reasonFlagged}</div>

      <div className="leaks-card-actions">
        <button
          className={`leaks-action-btn leaks-action-btn--essential ${candidate.reviewStatus === "essential" ? "leaks-action-btn--active" : ""}`}
          onClick={() => onReview(candidate.candidateKey, "essential")}
          disabled={isPending}
        >
          Essential
        </button>
        <button
          className={`leaks-action-btn leaks-action-btn--leak ${candidate.reviewStatus === "leak" ? "leaks-action-btn--active" : ""}`}
          onClick={() => onReview(candidate.candidateKey, "leak")}
          disabled={isPending}
        >
          Leak
        </button>
        <button
          className={`leaks-action-btn leaks-action-btn--dismiss ${candidate.reviewStatus === "dismissed" ? "leaks-action-btn--active" : ""}`}
          onClick={() => onReview(candidate.candidateKey, "dismissed")}
          disabled={isPending}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Leaks() {
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const { data, isLoading, error } = useRecurringCandidates();
  const reviewMutation = useReviewMutation();

  const handleReview = (candidateKey: string, status: ReviewStatus) => {
    reviewMutation.mutate({ candidateKey, status });
  };

  if (error) {
    return (
      <>
        <h1 className="app-page-title">Recurring Leak Review</h1>
        <p className="leaks-error">Failed to load recurring patterns.</p>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <h1 className="app-page-title">Recurring Leak Review</h1>
        <p className="leaks-loading">Analyzing transaction patterns...</p>
      </>
    );
  }

  const { candidates, summary } = data;

  const filtered =
    activeTab === "all"
      ? candidates
      : candidates.filter((c) => c.reviewStatus === activeTab);

  return (
    <>
      <h1 className="app-page-title">Recurring Leak Review</h1>

      <div className="leaks-summary">
        <div className="leaks-summary-item">
          <span className="leaks-summary-count">{summary.total}</span>
          <span className="leaks-summary-label">Total</span>
        </div>
        <div className="leaks-summary-item leaks-summary-item--unreviewed">
          <span className="leaks-summary-count">{summary.unreviewed}</span>
          <span className="leaks-summary-label">Unreviewed</span>
        </div>
        <div className="leaks-summary-item leaks-summary-item--essential">
          <span className="leaks-summary-count">{summary.essential}</span>
          <span className="leaks-summary-label">Essential</span>
        </div>
        <div className="leaks-summary-item leaks-summary-item--leak">
          <span className="leaks-summary-count">{summary.leak}</span>
          <span className="leaks-summary-label">Leaks</span>
        </div>
        <div className="leaks-summary-item leaks-summary-item--dismissed">
          <span className="leaks-summary-count">{summary.dismissed}</span>
          <span className="leaks-summary-label">Dismissed</span>
        </div>
      </div>

      <div className="leaks-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`leaks-tab ${activeTab === tab.key ? "leaks-tab--active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="leaks-empty">
          {activeTab === "all"
            ? "No recurring patterns detected. Upload more transactions for better detection."
            : `No ${activeTab} candidates.`}
        </p>
      ) : (
        <div className="leaks-grid">
          {filtered.map((c) => (
            <CandidateCard
              key={c.candidateKey}
              candidate={c}
              onReview={handleReview}
              isPending={reviewMutation.isPending}
            />
          ))}
        </div>
      )}
    </>
  );
}
