import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";

type LeakHunterMode =
  | "full"
  | "active"
  | "stopped"
  | "price_creep"
  | "recent_habits"
  | "needs_review";

type LeakHunterCoverage = {
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  totalTransactions: number;
  accountCount: number;
  coverageDays: number;
  coverageQuality: "empty" | "limited" | "partial" | "useful" | "strong";
  freshness: "current" | "slightly_stale" | "stale";
  limitations: string[];
};

type LeakHunterFinding = {
  id: string;
  merchantKey: string;
  merchant: string;
  status:
    | "active"
    | "possibly_active"
    | "overdue"
    | "inactive"
    | "historical"
    | "insufficient_history";
  kind: "subscription" | "bill" | "habit" | "price_creep" | "unknown";
  firstSeen: string;
  lastSeen: string;
  expectedNextDate?: string;
  cadence?: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  occurrences: number;
  averageAmount: number;
  latestAmount: number;
  monthlyEquivalent: number;
  historicalTotal: number;
  priceChangePct?: number;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  transactions: Array<{
    id: number;
    date: string;
    merchant: string;
    amount: number;
    category: string;
  }>;
  ledgerQuery: Record<string, string>;
};

type LeakHunterReport = {
  coverage: LeakHunterCoverage;
  analysisWindow: {
    startDate: string | null;
    endDate: string | null;
    days: number;
    totalTransactions: number;
  };
  summary: {
    activeCount: number;
    inactiveCount: number;
    priceCreepCount: number;
    recentHabitCount: number;
    estimatedActiveMonthly: number;
    estimatedHistoricalTotal: number;
  };
  sections: {
    activeLeaks: LeakHunterFinding[];
    stoppedLeaks: LeakHunterFinding[];
    priceCreep: LeakHunterFinding[];
    recentHabits: LeakHunterFinding[];
    needsReview: LeakHunterFinding[];
  };
};

const MODE_OPTIONS: Array<{ value: LeakHunterMode; label: string }> = [
  { value: "full", label: "Hunt summary" },
  { value: "recent_habits", label: "Spending patterns" },
  { value: "active", label: "Subscriptions" },
  { value: "stopped", label: "Ended charges" },
  { value: "price_creep", label: "Cost increases" },
  { value: "needs_review", label: "Check these" },
];

const FINDINGS_PER_PAGE = 3;

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      delay: i * 0.04,
      ease: [0.25, 0, 0, 1] as [number, number, number, number],
    },
  }),
};

function fmt(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtShort(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function sentenceCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function findingStatusLabel(finding: LeakHunterFinding): string {
  if (finding.status === "active") return "Likely active";
  if (finding.status === "possibly_active") return "Check timing";
  if (finding.status === "overdue") return "May still be active";
  if (finding.status === "inactive") return "Appears ended";
  if (finding.status === "historical") return "Ended";
  return "More history needed";
}

function repeatPatternLabel(finding: LeakHunterFinding): string {
  if (finding.kind === "habit" || !finding.cadence) return "Repeated recently";
  const labels: Record<NonNullable<LeakHunterFinding["cadence"]>, string> = {
    weekly: "Repeats about weekly",
    biweekly: "Repeats about every two weeks",
    monthly: "Repeats about monthly",
    quarterly: "Repeats about every three months",
    annual: "Repeats about yearly",
  };
  return labels[finding.cadence];
}

function plainEvidence(line: string): string {
  return line
    .replace(/^Cadence looks /i, "Pattern repeats about ")
    .replace(/\bcadence\b/gi, "pattern");
}

function formatDate(iso: string | null): string {
  if (!iso) return "No dates yet";
  const [year, mo, day] = iso.split("-").map(Number);
  return new Date(year, mo - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isBackdatedAnalysis(coverage: LeakHunterCoverage): boolean {
  if (!coverage.asOfDate || !coverage.endDate) return false;
  return coverage.asOfDate < coverage.endDate;
}

function ledgerHref(finding: LeakHunterFinding, accountId?: string | null): string {
  const transactionIds = (finding.transactions ?? []).map((transaction) => transaction.id);
  const params = new URLSearchParams({ excluded: "false", source: "leak-hunter" });
  if (transactionIds.length > 0) {
    params.set("ids", transactionIds.join(","));
  } else {
    Object.entries(finding.ledgerQuery).forEach(([key, value]) => params.set(key, value));
  }
  if (accountId) params.set("accountId", accountId);
  return `/transactions?${params.toString()}`;
}

function findingCostLabel(finding: LeakHunterFinding): string {
  if (finding.kind === "unknown") {
    return `${fmt(finding.historicalTotal)} seen · not counted as a leak`;
  }
  if (finding.status === "inactive" || finding.status === "historical") {
    return `${fmt(finding.historicalTotal)} tracked historically`;
  }
  if (finding.status === "insufficient_history" || finding.kind === "habit") {
    return `${fmt(finding.historicalTotal)} seen in this window`;
  }
  return `${fmt(finding.monthlyEquivalent * 12)} per year if active`;
}

function findingKindLabel(finding: LeakHunterFinding): string {
  if (finding.kind === "habit") return "Priority leak";
  if (finding.kind === "subscription") return "Subscription";
  if (finding.kind === "bill") return "Bill or obligation";
  if (finding.kind === "price_creep") return "Subscription price increase";
  return "Needs review";
}

function initialMode(): LeakHunterMode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return MODE_OPTIONS.some((option) => option.value === mode)
    ? (mode as LeakHunterMode)
    : "full";
}

function reportParams(mode: LeakHunterMode): URLSearchParams {
  const currentParams = new URLSearchParams(window.location.search);
  const params = new URLSearchParams({ mode });
  const accountId = currentParams.get("accountId");
  const asOf = currentParams.get("asOf");

  if (accountId) params.set("accountId", accountId);
  if (asOf) params.set("asOf", asOf);

  return params;
}

function updateModeUrl(mode: LeakHunterMode) {
  const params = reportParams(mode);
  const nextUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", nextUrl);
}

function coverageTone(quality: LeakHunterCoverage["coverageQuality"]): string {
  if (quality === "strong") return "Strong coverage";
  if (quality === "useful") return "Useful coverage";
  if (quality === "partial") return "Partial coverage";
  if (quality === "limited") return "Limited coverage";
  return "No history";
}

function coverageGuidance(quality: LeakHunterCoverage["coverageQuality"]): string {
  if (quality === "strong") {
    return "Enough history for active charges, stopped patterns, annual renewals, and cost-increase checks.";
  }
  if (quality === "useful") {
    return "Enough history for active charges and recent habits; more months can strengthen ended-charge and cost-increase checks.";
  }
  if (quality === "partial") {
    return "Good for a first pass on active charges, but annual renewals and cost increases need more history.";
  }
  if (quality === "limited") {
    return "Short history can catch obvious repeats; 90 days is better for active leaks and 12 months is better for stopped patterns.";
  }
  return "Upload transaction history so PocketPulse can infer dates before checking for leaks.";
}

function emptyGuidance(
  coverage: LeakHunterCoverage,
  mode: LeakHunterMode,
): { title: string; body: string; action: string } {
  if (coverage.coverageQuality === "empty") {
    return {
      title: "Upload history to start a leak hunt",
      body: "A bank or card CSV lets PocketPulse infer the covered dates before looking for recurring charges, ended subscriptions, cost increases, and repeat spending.",
      action: "Upload transactions",
    };
  }

  if (coverage.coverageQuality === "limited" || coverage.coverageQuality === "partial") {
    return {
      title: "This upload is too short for a confident hit",
      body: "Short windows can catch obvious repeats, but 90 days is better for active charges and 12 months is better for ended charges, annual renewals, and cost increases.",
      action: "Add more history",
    };
  }

  if (mode === "price_creep") {
    return {
      title: "No meaningful cost increase found",
      body: "No subscription's latest charge was at least 20% higher than its first observed charge and $2 above its usual pattern.",
      action: "Upload more history",
    };
  }

  if (mode === "recent_habits") {
    return {
      title: "No repeat recent habits found",
      body: "This import does not show a clear discretionary repeat pattern in the current window. More recent checking or card history may reveal one.",
      action: "Upload more history",
    };
  }

  if (mode === "needs_review") {
    return {
      title: "No uncertain recurring patterns",
      body: "PocketPulse did not find a current recurring pattern that still needs classification in this analysis window.",
      action: "Upload more history",
    };
  }

  return {
    title: "No findings in this mode",
    body: "Your current history did not surface a clear pattern here. More account coverage can improve confidence, especially for card subscriptions and annual renewals.",
    action: "Upload more history",
  };
}

function CoverageStrip({
  coverage,
  analysisWindow,
}: {
  coverage: LeakHunterCoverage;
  analysisWindow: LeakHunterReport["analysisWindow"];
}) {
  const range =
    coverage.startDate && coverage.endDate
      ? `${formatDate(coverage.startDate)} to ${formatDate(coverage.endDate)}`
      : "Upload transaction history to begin";
  const freshness =
    coverage.freshness === "current"
      ? "Current"
      : coverage.freshness === "slightly_stale"
        ? "Slightly stale"
        : "Stale";
  const freshnessWarning =
    coverage.freshness === "current"
      ? null
      : coverage.freshness === "slightly_stale"
        ? "Your latest uploaded transaction is a little old, so active-charge timing may need a quick ledger check."
        : "Your latest uploaded transaction is stale, so active leaks may already have changed since this history ended.";
  const backdatedAnalysis = isBackdatedAnalysis(coverage);

  return (
    <motion.div
      className="leak-hunter-coverage"
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={1}
      data-testid="leak-hunter-coverage"
    >
      <div className="leak-hunter-coverage-line">
        <div>
          <p className="leak-hunter-eyebrow">{coverageTone(coverage.coverageQuality)}</p>
          <p className="leak-hunter-coverage-main">
            Imported {coverage.accountCount} account
            {coverage.accountCount === 1 ? "" : "s"} from {range}.
          </p>
        </div>
        <span className={`leak-hunter-freshness leak-hunter-freshness--${coverage.freshness}`}>
          {freshness}
        </span>
      </div>
      <details className="leak-hunter-coverage-details">
        <summary>Coverage &amp; analysis window</summary>
        <p className="leak-hunter-coverage-sub">
          Imported coverage: {coverage.totalTransactions.toLocaleString()} transactions ·{" "}
          {coverage.coverageDays} days
        </p>
        <p className="leak-hunter-analysis-window" data-testid="leak-hunter-analysis-window">
          <strong>Recent analysis:</strong> {formatDate(analysisWindow.startDate)} to{" "}
          {formatDate(analysisWindow.endDate)} ·{" "}
          {analysisWindow.totalTransactions.toLocaleString()} transactions. Older imported
          transactions are not compared with this period.
        </p>
        <p className="leak-hunter-coverage-guidance">
          {coverageGuidance(coverage.coverageQuality)}
        </p>
        {backdatedAnalysis && (
          <p className="leak-hunter-coverage-guidance" data-testid="leak-hunter-as-of-note">
            Later imported transactions through {formatDate(coverage.endDate)} stay visible in
            coverage, but this report's findings stop at {formatDate(coverage.asOfDate)}.
          </p>
        )}
        {freshnessWarning && (
          <p className="leak-hunter-freshness-warning" data-testid="leak-hunter-freshness-warning">
            {freshnessWarning}
          </p>
        )}
      </details>
    </motion.div>
  );
}

function ModeControl({
  mode,
  report,
  onChange,
}: {
  mode: LeakHunterMode;
  report: LeakHunterReport;
  onChange: (mode: LeakHunterMode) => void;
}) {
  const counts: Record<LeakHunterMode, number> = {
    full: 0,
    active: report.sections.activeLeaks.length,
    stopped: report.sections.stoppedLeaks.length,
    price_creep: report.sections.priceCreep.length,
    recent_habits: report.sections.recentHabits.length,
    needs_review: report.sections.needsReview.length,
  };
  const visibleOptions = MODE_OPTIONS.filter(
    (option) =>
      option.value === "full" ||
      option.value === mode ||
      counts[option.value] > 0,
  );

  return (
    <motion.div
      className="leak-hunter-modes"
      role="group"
      aria-label="Leak Hunter report modes"
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={2}
      data-testid="leak-hunter-modes"
    >
      {visibleOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`leak-hunter-mode ${mode === option.value ? "leak-hunter-mode--active" : ""}`}
          onClick={() => onChange(option.value)}
          aria-pressed={mode === option.value}
          aria-label={
            option.value === "full"
              ? option.label
              : `${option.label}, ${counts[option.value]} ${
                  counts[option.value] === 1 ? "finding" : "findings"
                }`
          }
          data-testid={`leak-mode-${option.value}`}
        >
          <span>{option.label}</span>
          {option.value !== "full" && (
            <strong aria-hidden="true">{counts[option.value]}</strong>
          )}
        </button>
      ))}
    </motion.div>
  );
}

function HuntBriefing({
  report,
  onSelect,
}: {
  report: LeakHunterReport;
  onSelect: (mode: LeakHunterMode) => void;
}) {
  const startMode: LeakHunterMode = report.summary.recentHabitCount > 0
    ? "recent_habits"
    : report.summary.activeCount > 0
      ? "active"
      : report.summary.inactiveCount > 0
        ? "stopped"
        : report.summary.priceCreepCount > 0
          ? "price_creep"
          : "needs_review";
  const startCount =
    startMode === "recent_habits"
      ? report.summary.recentHabitCount
      : startMode === "active"
        ? report.summary.activeCount
        : startMode === "stopped"
          ? report.summary.inactiveCount
          : startMode === "price_creep"
            ? report.summary.priceCreepCount
            : report.sections.needsReview.length;
  const startTitle =
    startMode === "recent_habits"
      ? "Start with repeated discretionary spending"
      : startMode === "active"
        ? "Start with subscriptions that still appear active"
        : startMode === "stopped"
          ? "Review charges that appear to have ended"
          : startMode === "price_creep"
            ? "Review subscriptions that now cost more"
            : "Confirm the patterns PocketPulse is unsure about";

  return (
    <motion.section
      className="leak-hunter-briefing"
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={3}
      data-testid="leak-hunter-summary"
    >
      <div className="leak-hunter-briefing-lead">
        <p className="leak-hunter-eyebrow">Start here</p>
        <h2>{startTitle}</h2>
        <p>
          {startCount > 0
            ? `${startCount} ${startCount === 1 ? "finding deserves" : "findings deserve"} a closer look.`
            : "No clear leak is demanding attention in this analysis window."}
        </p>
        {startCount > 0 && (
          <button type="button" onClick={() => onSelect(startMode)}>
            Review {startCount} {startCount === 1 ? "finding" : "findings"}
          </button>
        )}
      </div>
      <dl className="leak-hunter-briefing-facts">
        <div>
          <dt>Repeated spending</dt>
          <dd>{report.summary.recentHabitCount}</dd>
        </div>
        <div>
          <dt>Active subscriptions</dt>
          <dd>
            {report.summary.activeCount}
            <span>{fmtShort(report.summary.estimatedActiveMonthly)}/mo</span>
          </dd>
        </div>
        <div>
          <dt>Ended charges</dt>
          <dd>
            {report.summary.inactiveCount}
            <span>{fmtShort(report.summary.estimatedHistoricalTotal)} seen</span>
          </dd>
        </div>
        <div>
          <dt>Cost increases</dt>
          <dd>{report.summary.priceCreepCount}</dd>
        </div>
      </dl>
      <details className="leak-hunter-briefing-note">
        <summary>What counts as a cost increase?</summary>
        <p>
          A cost increase means the latest subscription charge is at least 20% above
          the first observed charge and at least $2 above its average pattern.
        </p>
      </details>
    </motion.section>
  );
}

function FindingCard({
  finding,
  index,
  accountId,
}: {
  finding: LeakHunterFinding;
  index: number;
  accountId?: string | null;
}) {
  const priceChange =
    finding.priceChangePct === undefined
      ? null
      : `${finding.priceChangePct > 0 ? "+" : ""}${Math.round(finding.priceChangePct)}%`;
  const transactions = finding.transactions ?? [];
  const trail = [...transactions]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-6);
  const maxTrailAmount = Math.max(
    1,
    ...trail.map((transaction) => Math.abs(transaction.amount)),
  );
  const impact =
    finding.kind === "habit"
      ? `${fmt(finding.historicalTotal)} across ${finding.occurrences} recent purchases`
      : finding.kind === "price_creep" && priceChange
        ? `${fmt(finding.latestAmount)} now · ${priceChange}`
        : finding.status === "inactive" || finding.status === "historical"
          ? `${fmt(finding.latestAmount)} last observed charge`
          : `${fmt(finding.latestAmount)} latest · about ${fmt(finding.monthlyEquivalent)}/mo`;

  return (
    <motion.article
      className={`leak-hunter-card leak-hunter-card--${finding.status} leak-hunter-card--kind-${finding.kind}`}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={index}
      data-testid={`leak-hunter-card-${finding.merchantKey.replace(/\W+/g, "-")}`}
    >
      <div className="leak-hunter-card-head">
        <div className="leak-hunter-card-identity">
          <span className={`leak-hunter-kind leak-hunter-kind--${finding.kind}`}>
            {findingKindLabel(finding)}
          </span>
          <h3>{finding.merchant}</h3>
          <p>
            {repeatPatternLabel(finding)} · {finding.occurrences} charges from{" "}
            {formatDate(finding.firstSeen)} to {formatDate(finding.lastSeen)}
          </p>
        </div>
        <div className="leak-hunter-card-impact">
          <strong>{impact}</strong>
          <span className={`leak-hunter-status leak-hunter-status--${finding.status}`}>
            {findingStatusLabel(finding)}
          </span>
        </div>
      </div>

      {trail.length > 0 && (
        <div
          className="leak-hunter-trail"
          aria-label={`Recent transaction pattern for ${finding.merchant}`}
        >
          <div className="leak-hunter-trail-bars" aria-hidden="true">
            {trail.map((transaction) => (
              <span
                key={transaction.id}
                style={{
                  height: `${Math.max(18, Math.round((Math.abs(transaction.amount) / maxTrailAmount) * 100))}%`,
                }}
              />
            ))}
          </div>
          <div className="leak-hunter-trail-labels">
            <span>{formatDate(trail[0]!.date)}</span>
            <strong>{trail.length} matching charges</strong>
            <span>{formatDate(trail[trail.length - 1]!.date)}</span>
          </div>
        </div>
      )}

      <details className="leak-hunter-why">
        <summary>Why PocketPulse flagged this</summary>
        <ul className="leak-hunter-evidence">
          {finding.evidence.slice(0, 3).map((line) => (
            <li key={line}>{plainEvidence(line)}</li>
          ))}
          {finding.expectedNextDate && (
            <li>Expected again around {formatDate(finding.expectedNextDate)}.</li>
          )}
        </ul>
      </details>

      <details className="leak-hunter-transactions">
        <summary>
          {transactions.length} associated transaction
          {transactions.length === 1 ? "" : "s"}
        </summary>
        {transactions.length > 0 ? (
          <ul>
            {transactions.map((transaction) => (
              <li key={transaction.id}>
                <div>
                  <strong>{transaction.merchant}</strong>
                  <span>
                    <time dateTime={transaction.date}>{formatDate(transaction.date)}</time> ·{" "}
                    {sentenceCase(transaction.category)}
                  </span>
                </div>
                <strong>{fmt(transaction.amount)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p>Open the ledger to review the matching transaction history.</p>
        )}
      </details>

      <div className="leak-hunter-actions">
        <span>{findingCostLabel(finding)}</span>
        <a href={ledgerHref(finding, accountId)} data-testid={`link-ledger-${finding.merchantKey}`}>
          Review transactions
        </a>
      </div>
    </motion.article>
  );
}

function Section({
  title,
  subtitle,
  findings,
  startIndex,
  accountId,
}: {
  title: string;
  subtitle: string;
  findings: LeakHunterFinding[];
  startIndex: number;
  accountId?: string | null;
}) {
  const [page, setPage] = useState(1);
  if (findings.length === 0) return null;

  const totalPages = Math.ceil(findings.length / FINDINGS_PER_PAGE);
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * FINDINGS_PER_PAGE;
  const pageFindings = findings.slice(pageStart, pageStart + FINDINGS_PER_PAGE);

  return (
    <section className="leak-hunter-section" data-testid={`section-${title.toLowerCase().replace(/\W+/g, "-")}`}>
      <div className="leak-hunter-section-head">
        <div>
          <h2>{title}</h2>
          <span>{findings.length} finding{findings.length === 1 ? "" : "s"}</span>
        </div>
        <p>{subtitle}</p>
      </div>
      <div className="leak-hunter-list">
        {pageFindings.map((finding, i) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            index={startIndex + pageStart + i}
            accountId={accountId}
          />
        ))}
      </div>
      {totalPages > 1 && (
        <nav className="leak-hunter-pagination" aria-label={`${title} pages`}>
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span>Page {currentPage} of {totalPages}</span>
          <button
            type="button"
            disabled={currentPage === totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

export function Leaks() {
  const [mode, setMode] = useState<LeakHunterMode>(initialMode);
  const queryString = reportParams(mode).toString();
  const selectedAccountId = new URLSearchParams(window.location.search).get("accountId");

  const { data, isLoading, error } = useQuery<LeakHunterReport>({
    queryKey: ["/api/leak-hunter/report", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/leak-hunter/report?${queryString}`);
      if (!res.ok) throw new Error("Failed to load leak hunter report");
      return res.json() as Promise<LeakHunterReport>;
    },
    staleTime: 60_000,
  });

  const handleModeChange = (nextMode: LeakHunterMode) => {
    updateModeUrl(nextMode);
    setMode(nextMode);
  };

  const visibleSections = useMemo(() => {
    if (!data) return [];
    const sections = [
      {
        key: "recent_habits" as const,
        title: "Spending patterns to review",
        subtitle:
          "Repeated discretionary purchases in the recent window. Amounts can vary; similar merchant activity is grouped together.",
        findings: data.sections.recentHabits,
      },
      {
        key: "active" as const,
        title: "Subscriptions to review",
        subtitle:
          "Likely subscriptions are labeled separately from discretionary leaks so you can judge whether they still earn their cost.",
        findings: data.sections.activeLeaks,
      },
      {
        key: "stopped" as const,
        title: "Charges that appear ended",
        subtitle: "Recurring charges that stopped appearing before the latest uploaded activity.",
        findings: data.sections.stoppedLeaks,
      },
      {
        key: "price_creep" as const,
        title: "Subscriptions costing more",
        subtitle:
          "The latest charge is at least 20% above the first observed charge and $2 above its average pattern.",
        findings: data.sections.priceCreep,
      },
      {
        key: "needs_review" as const,
        title: "Patterns to confirm",
        subtitle:
          "Current recurring patterns PocketPulse cannot classify confidently. These are not counted as leaks or savings.",
        findings: data.sections.needsReview,
      },
    ];

    if (mode === "full") {
      // The briefing provides the map; the overview previews only the first
      // non-empty queue so the page stays compact.
      return sections.filter((section) => section.findings.length > 0).slice(0, 1);
    }
    if (mode === "active") return sections.filter((section) => section.key === "active");
    if (mode === "stopped") return sections.filter((section) => section.key === "stopped");
    if (mode === "price_creep") return sections.filter((section) => section.key === "price_creep");
    if (mode === "recent_habits") {
      return sections.filter((section) => section.key === "recent_habits");
    }
    return sections.filter((section) => section.key === "needs_review");
  }, [data, mode]);

  const hasFindings = visibleSections.some((section) => section.findings.length > 0);
  const emptyState = data ? emptyGuidance(data.coverage, mode) : null;

  const header = (
    <motion.div
      className="mb-4"
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={0}
    >
      <h1 className="app-page-title mb-0.5">
        <svg
          className="page-title-icon"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 3C10 3 4 9.5 4 13a6 6 0 0012 0c0-3.5-6-10-6-10z" />
          <path d="M7.5 14.5a2.5 2.5 0 004.5-1.5" strokeWidth="1.4" />
        </svg>
        Leak Hunter
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Recent-first review of repeated discretionary spending, subscriptions,
        and cost increases—with the matching transactions attached.
      </p>
    </motion.div>
  );

  if (error)
    return (
      <div>
        {header}
        <p className="leaks-error" data-testid="leaks-error">
          Failed to load Leak Hunter.
        </p>
      </div>
    );

  if (isLoading || !data)
    return (
      <div>
        {header}
        <p className="leaks-loading" data-testid="leaks-loading">
          Building leak hunt report...
        </p>
      </div>
    );

  return (
    <div>
      {header}
      <CoverageStrip coverage={data.coverage} analysisWindow={data.analysisWindow} />
      {data.coverage.limitations.length > 0 && (
        <motion.div
          className="leak-hunter-limitations"
          role="list"
          aria-label="Leak Hunter coverage limitations"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
          data-testid="leak-hunter-limitations"
        >
          {data.coverage.limitations.map((limitation) => (
            <span key={limitation} role="listitem">
              {limitation}
            </span>
          ))}
        </motion.div>
      )}
      {mode === "full" && (
        <HuntBriefing report={data} onSelect={handleModeChange} />
      )}
      <ModeControl mode={mode} report={data} onChange={handleModeChange} />

      {!hasFindings ? (
        <motion.div
          className="glass-card text-center py-10"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={4}
          data-testid="leaks-empty"
        >
          <p className="font-semibold text-slate-700 dark:text-slate-100 mb-1">
            {emptyState?.title}
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-xl mx-auto">
            {emptyState?.body}
          </p>
          <a className="leak-hunter-empty-action" href="/upload">
            {emptyState?.action}
          </a>
        </motion.div>
      ) : (
        visibleSections.map((section, sectionIndex) => (
          <Section
            key={section.key}
            title={section.title}
            subtitle={section.subtitle}
            findings={section.findings}
            startIndex={5 + sectionIndex * 5}
            accountId={selectedAccountId}
          />
        ))
      )}
    </div>
  );
}
