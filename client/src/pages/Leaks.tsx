import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";

type LeakHunterMode =
  | "full"
  | "active"
  | "stopped"
  | "price_creep"
  | "recent_habits";

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
  ledgerQuery: Record<string, string>;
};

type LeakHunterReport = {
  coverage: LeakHunterCoverage;
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
  { value: "full", label: "Full hunt" },
  { value: "active", label: "Active" },
  { value: "stopped", label: "Stopped" },
  { value: "price_creep", label: "Price creep" },
  { value: "recent_habits", label: "Recent habits" },
];

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

function ledgerHref(query: Record<string, string>, accountId?: string | null): string {
  const params = new URLSearchParams({ excluded: "false", ...query });
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
    return "Enough history for active charges, stopped patterns, annual renewals, and price-creep checks.";
  }
  if (quality === "useful") {
    return "Enough history for active charges and recent habits; more months can strengthen stopped-leak and price-creep checks.";
  }
  if (quality === "partial") {
    return "Good for a first pass on active charges, but annual renewals and price creep need more history.";
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
      body: "A bank or card CSV lets PocketPulse infer the covered dates before looking for recurring charges, stopped subscriptions, price creep, and repeat spending.",
      action: "Upload transactions",
    };
  }

  if (coverage.coverageQuality === "limited" || coverage.coverageQuality === "partial") {
    return {
      title: "This upload is too short for a confident hit",
      body: "Short windows can catch obvious repeats, but 90 days is better for active charges and 12 months is better for stopped leaks, annual renewals, and price creep.",
      action: "Add more history",
    };
  }

  if (mode === "price_creep") {
    return {
      title: "No meaningful price creep found",
      body: "The recurring charges in this history did not show a clear latest-amount jump. Check Full hunt for active or stopped patterns worth reviewing.",
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

  return {
    title: "No findings in this mode",
    body: "Your current history did not surface a clear pattern here. More account coverage can improve confidence, especially for card subscriptions and annual renewals.",
    action: "Upload more history",
  };
}

function CoverageStrip({ coverage }: { coverage: LeakHunterCoverage }) {
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
      <div>
        <p className="leak-hunter-eyebrow">{coverageTone(coverage.coverageQuality)}</p>
        <p className="leak-hunter-coverage-main">
          Analyzing {coverage.accountCount} account
          {coverage.accountCount === 1 ? "" : "s"} from {range}.
        </p>
        <p className="leak-hunter-coverage-sub">
          Current as of {formatDate(coverage.asOfDate)} ·{" "}
          {coverage.totalTransactions.toLocaleString()} transactions ·{" "}
          {coverage.coverageDays} days
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
      </div>
      <span className={`leak-hunter-freshness leak-hunter-freshness--${coverage.freshness}`}>
        {freshness}
      </span>
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
    full:
      report.sections.activeLeaks.length +
      report.sections.stoppedLeaks.length +
      report.sections.priceCreep.length +
      report.sections.recentHabits.length +
      report.sections.needsReview.length,
    active: report.sections.activeLeaks.length,
    stopped: report.sections.stoppedLeaks.length,
    price_creep: report.sections.priceCreep.length,
    recent_habits: report.sections.recentHabits.length,
  };

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
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`leak-hunter-mode ${mode === option.value ? "leak-hunter-mode--active" : ""}`}
          onClick={() => onChange(option.value)}
          aria-pressed={mode === option.value}
          aria-label={`${option.label}, ${counts[option.value]} ${
            counts[option.value] === 1 ? "finding" : "findings"
          }`}
          data-testid={`leak-mode-${option.value}`}
        >
          <span>{option.label}</span>
          <strong aria-hidden="true">{counts[option.value]}</strong>
        </button>
      ))}
    </motion.div>
  );
}

function SummaryGrid({ report }: { report: LeakHunterReport }) {
  const cards = [
    ["Active leaks", String(report.summary.activeCount)],
    ["Stopped leaks", String(report.summary.inactiveCount)],
    ["Price creep", String(report.summary.priceCreepCount)],
    ["Recent habits", String(report.summary.recentHabitCount)],
    ["Active monthly", fmtShort(report.summary.estimatedActiveMonthly)],
  ];

  return (
    <motion.div
      className="leak-hunter-summary"
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={3}
      data-testid="leak-hunter-summary"
    >
      {cards.map(([label, value]) => (
        <div className="leak-hunter-summary-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </motion.div>
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

  return (
    <motion.article
      className={`leak-hunter-card leak-hunter-card--${finding.status}`}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={index}
      data-testid={`leak-hunter-card-${finding.merchantKey.replace(/\W+/g, "-")}`}
    >
      <div className="leak-hunter-card-head">
        <div>
          <h3>{finding.merchant}</h3>
          <p>
            Seen {finding.occurrences} times from {formatDate(finding.firstSeen)} to{" "}
            {formatDate(finding.lastSeen)}
          </p>
        </div>
        <span className={`leak-hunter-status leak-hunter-status--${finding.status}`}>
          {sentenceCase(finding.status)}
        </span>
      </div>

      <div className="leak-hunter-metrics">
        <span>
          Latest <strong>{fmt(finding.latestAmount)}</strong>
        </span>
        <span>
          Est. <strong>{fmt(finding.monthlyEquivalent)}/mo</strong>
        </span>
        <span>
          Cadence <strong>{finding.cadence ? sentenceCase(finding.cadence) : "Review"}</strong>
        </span>
        {priceChange && (
          <span>
            Change <strong>{priceChange}</strong>
          </span>
        )}
      </div>

      <ul className="leak-hunter-evidence">
        {finding.evidence.slice(0, 3).map((line) => (
          <li key={line}>{line}</li>
        ))}
        {finding.expectedNextDate && (
          <li>Expected again around {formatDate(finding.expectedNextDate)}.</li>
        )}
      </ul>

      <div className="leak-hunter-actions">
        <span>{findingCostLabel(finding)}</span>
        <a href={ledgerHref(finding.ledgerQuery, accountId)} data-testid={`link-ledger-${finding.merchantKey}`}>
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
  if (findings.length === 0) return null;

  return (
    <section className="leak-hunter-section" data-testid={`section-${title.toLowerCase().replace(/\W+/g, "-")}`}>
      <div className="leak-hunter-section-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="leak-hunter-list">
        {findings.map((finding, i) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            index={startIndex + i}
            accountId={accountId}
          />
        ))}
      </div>
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
        key: "active" as const,
        title: "Active leaks",
        subtitle: "Recurring charges that look active or close enough to check.",
        findings: data.sections.activeLeaks,
      },
      {
        key: "stopped" as const,
        title: "Stopped leaks",
        subtitle: "Historical patterns that appear to have ended before the latest upload.",
        findings: data.sections.stoppedLeaks,
      },
      {
        key: "price_creep" as const,
        title: "Price creep",
        subtitle: "Recurring charges where the latest amount rose meaningfully.",
        findings: data.sections.priceCreep,
      },
      {
        key: "recent_habits" as const,
        title: "Recent habits",
        subtitle: "Repeat discretionary spending from the current import window.",
        findings: data.sections.recentHabits,
      },
      {
        key: "needs_review" as const,
        title: "Needs review",
        subtitle:
          "Current recurring patterns PocketPulse cannot classify confidently. These are not counted as leaks or savings.",
        findings: data.sections.needsReview,
      },
    ];

    if (mode === "full") return sections;
    if (mode === "active") return sections.filter((section) => section.key === "active");
    if (mode === "stopped") return sections.filter((section) => section.key === "stopped");
    if (mode === "price_creep") return sections.filter((section) => section.key === "price_creep");
    return sections.filter((section) => section.key === "recent_habits");
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
        Private CSV-based review for recurring charges, stopped subscriptions,
        price creep, and repeat spending.
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
      <CoverageStrip coverage={data.coverage} />
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
      <ModeControl mode={mode} report={data} onChange={handleModeChange} />
      <SummaryGrid report={data} />

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
