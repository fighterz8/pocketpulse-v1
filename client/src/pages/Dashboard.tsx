import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../lib/api";

import {
  formatMonthLabel,
  useAvailableMonths,
  useDashboardSummary,
} from "../hooks/use-dashboard";
import { useAuth } from "../hooks/use-auth";
import { Hint, HintIcon } from "../components/ui/tooltip";
import { WelcomeOverlay } from "../components/ui/welcome-overlay";
import { ONBOARDING_UPLOAD_SUCCESS_FLAG } from "./OnboardingUpload";

interface DashboardLeakFinding {
  kind: "subscription" | "bill" | "habit" | "price_creep" | "unknown";
  monthlyEquivalent: number;
}

interface DashboardLeakReport {
  sections: {
    activeLeaks: DashboardLeakFinding[];
    recentHabits: DashboardLeakFinding[];
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number, opts?: Intl.NumberFormatOptions): string {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...opts,
  });
}

function currency(n: number): string {
  return (n < 0 ? "-$" : "$") + fmt(n);
}

function currencyShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000)
    return (n < 0 ? "-$" : "$") + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000)
    return (n < 0 ? "-$" : "$") + (abs / 1_000).toFixed(1) + "K";
  return currency(n);
}

function pct(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build first and last day of a YYYY-MM month string. */
function monthToDateRange(month: string): { dateFrom: string; dateTo: string } {
  const [year, mo] = month.split("-").map(Number);
  const from = new Date(year, mo - 1, 1);
  const to = new Date(year, mo, 0);
  const d = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  return { dateFrom: d(from), dateTo: d(to) };
}

/** Build a /transactions URL with the given query params.
 *  Always includes excluded=false so the visible ledger total matches KPI figures,
 *  which also exclude rows marked excludedFromAnalysis=true. */
function ledgerUrl(
  params: Record<string, string | undefined>,
  dateRange?: { dateFrom?: string; dateTo?: string },
): string {
  const qp = new URLSearchParams();
  const all = { excluded: "false", ...dateRange, ...params };
  Object.entries(all).forEach(([k, v]) => {
    if (v !== undefined) qp.set(k, v);
  });
  const qs = qp.toString();
  return `/transactions${qs ? `?${qs}` : ""}`;
}

// ─── Animation variants ──────────────────────────────────────────────────────

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      delay: i * 0.07,
      ease: [0.25, 0, 0, 1] as [number, number, number, number],
    },
  }),
};

// ─── Clickable Glass Card ─────────────────────────────────────────────────────

function GlassCard({
  children,
  className = "",
  index = 0,
  href,
}: {
  children: React.ReactNode;
  className?: string;
  index?: number;
  href?: string;
}) {
  const [, navigate] = useLocation();
  const clickable = !!href;

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      onClick={clickable ? () => navigate(href!) : undefined}
      className={`glass-card ${clickable ? "glass-card--clickable" : ""} ${className}`}
      role={clickable ? "link" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") navigate(href!);
            }
          : undefined
      }
    >
      {children}
    </motion.div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent = "neutral",
  href,
  "data-testid": testId,
  index = 0,
  hint,
  hintTestId,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "red" | "blue" | "neutral";
  href?: string;
  "data-testid"?: string;
  index?: number;
  hint?: React.ReactNode;
  hintTestId?: string;
}) {
  const colorMap = {
    green: "text-emerald-600 dark:text-emerald-400",
    red: "text-red-500 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
    neutral: "text-slate-800 dark:text-slate-100",
  };
  return (
    <GlassCard index={index} href={href}>
      <p className="kpi-label">
        {label}
        {hint ? (
          <HintIcon
            label={`About ${label}`}
            content={hint}
            data-testid={hintTestId}
          />
        ) : null}
      </p>
      <p data-testid={testId} className={`kpi-value ${colorMap[accent]}`}>
        {value}
      </p>
      {sub && <p className="kpi-sub">{sub}</p>}
      {href && <p className="kpi-drill">View transactions →</p>}
    </GlassCard>
  );
}

// ─── Recurring expenses breakdown panel ─────────────────────────────────

type RecurringPanelTxn = {
  id: number;
  merchant: string;
  amount: string;
  date: string;
};

type RecurringMerchantGroup = {
  merchant: string;
  count: number;
  total: number;
  transactionIds: number[];
};

/**
 * Fetches every recurring expense transaction for the period (paged, capped
 * at 500 rows) so the breakdown reconciles exactly with the Recurring
 * Expenses KPI — both are driven by the same filters the Ledger drill-down
 * uses: transactionClass=expense, recurrenceType=recurring, excluded=false.
 */
async function fetchRecurringExpenseRows(dateRange?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<{ rows: RecurringPanelTxn[]; truncated: boolean }> {
  const rows: RecurringPanelTxn[] = [];
  const MAX_PAGES = 5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      transactionClass: "expense",
      recurrenceType: "recurring",
      excluded: "false",
      limit: "100",
      page: String(page),
    });
    if (dateRange?.dateFrom) params.set("dateFrom", dateRange.dateFrom);
    if (dateRange?.dateTo) params.set("dateTo", dateRange.dateTo);
    const res = await apiFetch(`/api/transactions?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to load recurring transactions");
    const body = (await res.json()) as {
      transactions: RecurringPanelTxn[];
      pagination?: { total?: number; totalPages?: number };
    };
    rows.push(...body.transactions);
    const totalPages = body.pagination?.totalPages ?? 1;
    if (page >= totalPages) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function groupRecurringByMerchant(
  rows: RecurringPanelTxn[],
): RecurringMerchantGroup[] {
  const groups = new Map<string, RecurringMerchantGroup>();
  for (const row of rows) {
    const name = row.merchant || "Unlabeled merchant";
    const existing = groups.get(name.toLowerCase());
    const amount = Math.abs(parseFloat(row.amount)) || 0;
    if (existing) {
      existing.count += 1;
      existing.total += amount;
      existing.transactionIds.push(row.id);
    } else {
      groups.set(name.toLowerCase(), {
        merchant: name,
        count: 1,
        total: amount,
        transactionIds: [row.id],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

function RecurringExpensesPanel({
  dateRange,
  periodLabelFull,
  kpiTotal,
  index,
}: {
  dateRange?: { dateFrom: string; dateTo: string };
  periodLabelFull: string;
  kpiTotal: number;
  index: number;
}) {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["recurring-expense-panel", dateRange ?? "all"],
    queryFn: () => fetchRecurringExpenseRows(dateRange),
  });

  const refreshDetection = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/recurring-candidates/sync", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Refresh failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  const groups = data ? groupRecurringByMerchant(data.rows) : [];
  const visibleGroups = showAll ? groups : groups.slice(0, 8);
  const panelTotal = groups.reduce((sum, group) => sum + group.total, 0);
  const reconciles =
    !data?.truncated && Math.abs(panelTotal - kpiTotal) < 0.01;

  const refreshButton = (
    <Hint
      content="Re-scan your imported history for recurring payment patterns without changing transaction categories."
      data-testid="hint-refresh-detection"
    >
      <button
        type="button"
        className="sync-btn"
        onClick={() => refreshDetection.mutate()}
        disabled={refreshDetection.isPending}
        data-testid="btn-refresh-detection"
      >
        {refreshDetection.isPending ? "Refreshing…" : "↻ Refresh detection"}
      </button>
    </Hint>
  );

  return (
    <GlassCard index={index} className="recurring-panel">
      <div className="recurring-panel-head">
        <div>
          <p className="kpi-label">Recurring expenses · breakdown</p>
          <p className="kpi-sub">
            Every charge counted in the Recurring Expenses figure for{" "}
            {periodLabelFull}.
          </p>
        </div>
        {refreshButton}
      </div>

      {refreshDetection.isError && (
        <p className="recurring-panel-note" data-testid="recurring-refresh-error">
          Refresh didn’t finish — try again in a moment.
        </p>
      )}
      {refreshDetection.isSuccess && (
        <p className="recurring-panel-note" data-testid="recurring-refresh-done">
          Recurring payment detection refreshed.
        </p>
      )}

      {isLoading ? (
        <p className="recurring-panel-note">Loading recurring charges…</p>
      ) : error ? (
        <p className="recurring-panel-note">
          Couldn’t load the recurring breakdown.
        </p>
      ) : groups.length === 0 ? (
        <div className="recurring-panel-empty" data-testid="recurring-panel-empty">
          <p>No recurring charges detected in {periodLabelFull}.</p>
          <p className="kpi-sub">
            If you expect subscriptions or bills here, refresh detection to
            re-scan your imported history.
          </p>
        </div>
      ) : (
        <>
          <ul className="recurring-panel-list" data-testid="recurring-panel-list">
            {visibleGroups.map((group) => (
              <li key={group.merchant}>
                <Link
                  href={ledgerUrl(
                    {
                      ids: group.transactionIds.slice(0, 200).join(","),
                    },
                    dateRange,
                  )}
                  className="recurring-panel-row"
                  data-testid={`recurring-panel-row-${group.merchant
                    .toLowerCase()
                    .replace(/\W+/g, "-")}`}
                >
                  <span className="recurring-panel-merchant">
                    {group.merchant}
                  </span>
                  <span className="recurring-panel-count">
                    {group.count} charge{group.count === 1 ? "" : "s"}
                  </span>
                  <span className="recurring-panel-amount">
                    {currency(group.total)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {groups.length > 8 && (
            <button
              type="button"
              className="recurring-panel-more"
              onClick={() => setShowAll((v) => !v)}
              data-testid="btn-recurring-show-all"
            >
              {showAll
                ? "Show fewer"
                : `Show all ${groups.length} merchants`}
            </button>
          )}
          <div className="recurring-panel-footer">
            <span data-testid="recurring-panel-total">
              Total: {currency(panelTotal)}
            </span>
            {!reconciles && (
              <span
                className="recurring-panel-warn"
                data-testid="recurring-panel-mismatch"
              >
                {data?.truncated
                  ? "Showing the first 500 charges — open the ledger for the rest."
                  : "This list and the KPI figure disagree — refresh detection."}
              </span>
            )}
            <Link
              href={ledgerUrl(
                { transactionClass: "expense", recurrenceType: "recurring" },
                dateRange,
              )}
              className="kpi-drill"
            >
              View in ledger →
            </Link>
          </div>
        </>
      )}
    </GlassCard>
  );
}

function safeToSpendStatus(
  netCashflow: number,
  totalInflow: number,
): {
  label: string;
  badge: string;
} {
  if (totalInflow === 0)
    return { label: "No income data", badge: "badge-neutral" };
  const ratio = netCashflow / totalInflow;
  if (ratio > 0.2) return { label: "Healthy surplus", badge: "badge-green" };
  if (ratio > 0.05) return { label: "Positive cashflow", badge: "badge-green" };
  if (ratio >= 0) return { label: "Thin surplus", badge: "badge-yellow" };
  if (ratio > -0.15)
    return { label: "Spending over income", badge: "badge-orange" };
  return { label: "Over budget", badge: "badge-red" };
}

// ─── Month Pill Selector ─────────────────────────────────────────────────────

function MonthSelector({
  months,
  selected,
  onSelect,
}: {
  months: Array<{ month: string; transactionCount: number }>;
  selected: string | null;
  onSelect: (month: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      "[data-active='true']",
    );
    el?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [selected]);

  return (
    <div
      ref={scrollRef}
      className="period-selector"
      data-testid="month-selector"
    >
      <button
        data-testid="month-btn-all"
        data-active={selected === null ? "true" : "false"}
        onClick={() => onSelect(null)}
        className={`period-btn ${selected === null ? "period-btn--active" : ""}`}
      >
        All Time
      </button>

      {months.map(({ month }) => (
        <button
          key={month}
          data-testid={`month-btn-${month}`}
          data-active={selected === month ? "true" : "false"}
          onClick={() => onSelect(month)}
          className={`period-btn ${selected === month ? "period-btn--active" : ""}`}
        >
          {formatMonthLabel(month)}
        </button>
      ))}
    </div>
  );
}

// Reads + clears the onboarding-upload success flag set by OnboardingUpload
// after a successful first import. Auto-dismisses after 6 seconds.
function OnboardingSuccessNotice() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const raw = localStorage.getItem(ONBOARDING_UPLOAD_SUCCESS_FLAG);
    if (!raw) return;
    const n = parseInt(raw, 10);
    localStorage.removeItem(ONBOARDING_UPLOAD_SUCCESS_FLAG);
    if (Number.isFinite(n) && n > 0) {
      setCount(n);
      const t = setTimeout(() => setCount(null), 6000);
      return () => clearTimeout(t);
    }
  }, []);
  if (count === null) return null;
  return (
    <div
      className="onboarding-success-notice"
      role="status"
      data-testid="onboarding-success-notice"
    >
      <span className="onboarding-success-notice-icon" aria-hidden="true">
        ✓
      </span>
      Welcome to PocketPulse — we imported <strong>{count}</strong> transaction
      {count !== 1 ? "s" : ""}.
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

// Categories excluded from the spending breakdown display
const HIDDEN_CATEGORIES = new Set(["income", "transfers"]);

export function Dashboard() {
  return (
    <>
      {/*
        First-visit welcome overlay. Renders alongside DashboardImpl so that
        when the modal opens the entire dashboard body becomes inert (the
        overlay's backdrop marks every sibling of itself inert + aria-hidden
        while open). Uses the same `pp_welcome_seen` localStorage flag as
        before, so users who already dismissed it elsewhere never see it again.
        Focus is returned to the Export button (a stable element present in
        every dashboard state — loading, error, empty, populated).
      */}
      <WelcomeOverlay
        enabled
        restoreFocusSelector="[data-testid='btn-dashboard-export']"
      />
      <DashboardImpl />
    </>
  );
}

function DashboardImpl() {
  const { user } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (selectedMonth) {
      const { dateFrom, dateTo } = monthToDateRange(selectedMonth);
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
    }
    const url = `/api/transactions/export?${params.toString()}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const { data: availableMonths, isLoading: monthsLoading } =
    useAvailableMonths();

  // Track the most-recent month seen so far so we only auto-advance the selector
  // when new data arrives (e.g. user uploads June 2026 CSV) — not on every
  // background refetch (which would override the user's manual month selection).
  const prevMostRecentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!availableMonths || availableMonths.length === 0) return;
    // Months are returned DESC (newest first).
    const mostRecent = availableMonths[0]?.month ?? null;
    const isFirstLoad = prevMostRecentRef.current === null;
    const hasNewMonths =
      mostRecent !== null && mostRecent !== prevMostRecentRef.current;

    if (isFirstLoad || hasNewMonths) {
      // Auto-select the most recent month that has meaningful transaction volume.
      const best =
        availableMonths.find((m) => m.transactionCount >= 20) ??
        availableMonths[0];
      setSelectedMonth(best?.month ?? null);
    }
    prevMostRecentRef.current = mostRecent;
  }, [availableMonths]);

  const { data, isLoading, error } = useDashboardSummary({
    month: selectedMonth,
  });

  // Date range for ledger deep-links
  const dateRange = selectedMonth ? monthToDateRange(selectedMonth) : undefined;

  // Use the same recent-window report as the Leak Hunter page. When a dashboard
  // month is selected, its end date becomes the report snapshot date so both
  // surfaces describe the same findings.
  const leaksAsOf = dateRange?.dateTo;
  const { data: leakReport } = useQuery<DashboardLeakReport>({
    queryKey: ["/api/leak-hunter/report", leaksAsOf ?? "latest"],
    queryFn: async () => {
      const url = leaksAsOf
        ? `/api/leak-hunter/report?asOf=${leaksAsOf}`
        : "/api/leak-hunter/report";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch Leak Hunter report");
      return res.json();
    },
    staleTime: 60_000,
  });

  const recentFindings = leakReport?.sections.recentHabits ?? [];
  const priorityLeaks = recentFindings.filter((finding) => finding.kind === "habit");
  const subscriptionReviewCount =
    (leakReport?.sections.activeLeaks.length ?? 0) +
    recentFindings.filter((finding) => finding.kind === "subscription").length;
  const leakCount = priorityLeaks.length;
  const leakMonthly =
    Math.round(
      priorityLeaks.reduce((sum, finding) => sum + finding.monthlyEquivalent, 0) * 100,
    ) /
    100;

  const periodLabel = selectedMonth
    ? formatMonthLabel(selectedMonth)
    : "All Time";

  const periodLabelFull = selectedMonth
    ? (() => {
        const [year, mo] = selectedMonth.split("-").map(Number);
        return new Date(year, mo - 1, 1).toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });
      })()
    : "All Time";

  const monthSelector = monthsLoading ? null : (
    <MonthSelector
      months={availableMonths ?? []}
      selected={selectedMonth}
      onSelect={setSelectedMonth}
    />
  );

  const headerRow = (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      custom={0}
      className="mb-6"
    >
      <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
        <div>
          <h1 className="dash-title">
            <svg
              className="page-title-icon"
              style={{
                flexShrink: 0,
                width: "1.35rem",
                height: "1.35rem",
                color: "#2563eb",
                opacity: 0.85,
              }}
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="2" width="7" height="7" rx="1.2" />
              <rect x="11" y="2" width="7" height="7" rx="1.2" />
              <rect x="2" y="11" width="7" height="7" rx="1.2" />
              <rect x="11" y="11" width="7" height="7" rx="1.2" />
            </svg>
            Dashboard
          </h1>
          <p className="dash-subtitle">
            Cashflow overview ·{" "}
            <span className="font-medium text-slate-600 dark:text-slate-300">
              {periodLabelFull}
            </span>
          </p>
        </div>
        <Hint
          content={`Download a CSV of all transactions for ${periodLabelFull}.`}
          data-testid="hint-dashboard-export"
        >
          <button
            onClick={handleExport}
            data-testid="btn-dashboard-export"
            className="sync-btn"
          >
            ↓ Export CSV
          </button>
        </Hint>
      </div>
      {monthSelector}
    </motion.div>
  );

  if (isLoading && !data) {
    return (
      <div>
        {headerRow}
        <div
          className="dash-loading"
          role="status"
          aria-live="polite"
          data-testid="dashboard-loading"
        >
          <span className="dash-loading-spinner" aria-hidden="true" />
          <span className="dash-loading-text">Loading dashboard…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {headerRow}
        <p className="app-placeholder">Error loading dashboard.</p>
      </div>
    );
  }

  if (!data || data.totals.transactionCount === 0) {
    return (
      <div>
        {headerRow}
        <GlassCard index={1} className="dash-empty-card">
          <p className="dash-empty-msg">
            No transactions in {periodLabelFull}.
          </p>
          {selectedMonth ? (
            <button
              className="dash-leaks-link mt-2"
              onClick={() => setSelectedMonth(null)}
            >
              View All Time →
            </button>
          ) : (
            <Link
              href="/upload"
              className="dash-empty-link"
              data-testid="link-upload-first"
            >
              Upload your first CSV →
            </Link>
          )}
        </GlassCard>
      </div>
    );
  }

  const { totals, categoryBreakdown, isAllTime } = data;

  // Filter out non-spending categories from the breakdown
  const spendingCategories = categoryBreakdown.filter(
    (c) => !HIDDEN_CATEGORIES.has(c.category),
  );
  const totalSpending = spendingCategories.reduce((s, c) => s + c.total, 0);

  const safeToSpend = totals.safeToSpend;
  const spendStatus = safeToSpendStatus(safeToSpend, totals.totalInflow);
  const safeColor =
    safeToSpend > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : safeToSpend > -totals.totalInflow * 0.15
        ? "text-orange-500 dark:text-orange-400"
        : "text-red-500 dark:text-red-400";

  const spendRatio =
    totals.totalInflow > 0
      ? Math.min(
          100,
          (totals.totalOutflow /
            Math.max(totals.totalInflow, totals.totalOutflow)) *
            100,
        )
      : 0;

  return (
    <div>
      <OnboardingSuccessNotice />
      {headerRow}

      {/* ── Row 1: Safe-to-Spend Hero + Expense Leaks ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Safe-to-Spend Hero — net cashflow = total income − total spending */}
        <GlassCard
          className="lg:col-span-2"
          index={1}
          href={ledgerUrl({}, dateRange)}
        >
          <p className="kpi-label">
            Net Cashflow (Safe to Spend)
            <HintIcon
              label="About Net Cashflow"
              content="Income − Spending for this period. Excludes transfers between your accounts and any rows you've marked as excluded."
              data-testid="hint-net-cashflow"
            />
          </p>
          <p
            data-testid="safe-to-spend-value"
            className={`dash-hero-value ${safeColor}`}
          >
            {currency(safeToSpend)}
          </p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <HintIcon
              label="About Safe-to-Spend status"
              content="Status compares net cashflow to income for this period: Healthy surplus is above 20%, Positive cashflow is 5–20%, Thin surplus is 0–5%, and Over means spending is higher than income."
              data-testid="hint-safe-to-spend-badge"
            />
            <span className={`dash-badge ${spendStatus.badge}`}>
              {spendStatus.label}
            </span>
            <span className="text-xs text-slate-400">
              Total income minus total spending · {periodLabelFull}
            </span>
          </div>

          <div className="mt-5">
            <div className="flex justify-between text-xs text-slate-400 dark:text-slate-400 mb-1.5">
              <span>Total spending</span>
              <span>Total income</span>
            </div>
            <div className="h-2 bg-blue-50 dark:bg-slate-700 rounded-full overflow-hidden border border-blue-100 dark:border-slate-600">
              {totals.totalInflow > 0 && (
                <div
                  className={`h-full rounded-full transition-all ${safeToSpend >= 0 ? "bg-emerald-500" : "bg-red-400"}`}
                  style={{ width: `${spendRatio}%` }}
                />
              )}
            </div>
            <div className="flex justify-between text-xs mt-1.5">
              <span className="text-red-500 dark:text-red-400 font-semibold">
                {currency(totals.totalOutflow)}
              </span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                {currency(totals.totalInflow)}
              </span>
            </div>
          </div>
          <p className="kpi-drill mt-4">View all transactions →</p>
        </GlassCard>

        {/* Leak Hunter — uses the same as-of snapshot as the full report */}
        {(() => {
          const leaksHref = leaksAsOf
            ? `/leaks?asOf=${leaksAsOf}`
            : "/leaks";
          return (
            <GlassCard
              className="flex flex-col justify-between"
              index={2}
              href={leaksHref}
            >
              <div>
                <p className="kpi-label">
                  Leak Hunter
                  <HintIcon
                    label="About Leak Hunter"
                    content="Leak Hunter prioritizes repeated discretionary spending from the recent window. Subscriptions are shown separately so ordinary recurring charges are not presented as the same kind of leak."
                    data-testid="hint-leak-detection"
                  />
                </p>
                {leakCount > 0 ? (
                  <>
                    <p
                      data-testid="leak-count"
                      className="dash-hero-value text-red-500 dark:text-red-400"
                    >
                      {leakCount}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-300 mt-1">
                      spending leak{leakCount !== 1 ? "s" : ""} detected — repeated
                      discretionary purchases to review
                    </p>
                    {leakMonthly > 0 && (
                      <p className="text-sm text-red-500 dark:text-red-400 font-semibold mt-1">
                        ~{currency(leakMonthly)}/mo recent repeat spend
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p
                      data-testid="leak-count"
                      className="dash-hero-value text-slate-500 dark:text-slate-300 text-3xl leading-tight mt-1"
                    >
                      No spending leaks
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                      No repeated discretionary leaks found in the recent analysis window.
                    </p>
                  </>
                )}
                {subscriptionReviewCount > 0 && (
                  <p className="text-sm text-sky-700 dark:text-sky-300 font-semibold mt-2">
                    {subscriptionReviewCount} subscription
                    {subscriptionReviewCount === 1 ? "" : "s"} to review separately
                  </p>
                )}
              </div>
              <p className="kpi-drill">
                {leakCount > 0
                  ? "See leak detections →"
                  : "View leak detection →"}
              </p>
            </GlassCard>
          );
        })()}
      </div>

      {/* ── Row 2: 4 KPI cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <KpiCard
          label="Total Income"
          value={currencyShort(totals.totalInflow)}
          sub={periodLabel}
          accent="green"
          data-testid="kpi-total-income"
          index={3}
          href={ledgerUrl({ transactionClass: "income" }, dateRange)}
        />
        <KpiCard
          label="Total Spending"
          value={currencyShort(totals.totalOutflow)}
          sub={periodLabel}
          accent="red"
          data-testid="kpi-total-spending"
          index={4}
          href={ledgerUrl({ transactionClass: "expense" }, dateRange)}
        />
        <KpiCard
          label="Recurring Income"
          value={currencyShort(totals.recurringIncome)}
          sub="Recurring inflows · this period"
          accent="green"
          data-testid="kpi-recurring-income"
          index={5}
          href={ledgerUrl(
            { transactionClass: "income", recurrenceType: "recurring" },
            dateRange,
          )}
        />
        <KpiCard
          label="Recurring Expenses"
          value={currencyShort(totals.recurringExpenses)}
          sub={`Actual recurring charges · ${periodLabel}`}
          accent="red"
          data-testid="kpi-recurring-expenses"
          index={6}
          href={ledgerUrl(
            { transactionClass: "expense", recurrenceType: "recurring" },
            dateRange,
          )}
        />
      </div>

      {/* ── Row 3: 3 KPI cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <KpiCard
          label="One-Time Income"
          value={currencyShort(totals.oneTimeIncome)}
          sub="Non-recurring revenue"
          accent="blue"
          data-testid="kpi-one-time-income"
          index={7}
          href={ledgerUrl(
            { transactionClass: "income", recurrenceType: "one-time" },
            dateRange,
          )}
        />
        <KpiCard
          label="One-Time Expenses"
          value={currencyShort(totals.oneTimeExpenses)}
          sub="Non-recurring costs"
          accent="neutral"
          data-testid="kpi-one-time-expenses"
          index={8}
          href={ledgerUrl(
            { transactionClass: "expense", recurrenceType: "one-time" },
            dateRange,
          )}
        />
        <KpiCard
          label="Discretionary Spend"
          value={currencyShort(totals.discretionarySpend)}
          sub={`${periodLabel} · dining, coffee, delivery…`}
          accent="neutral"
          data-testid="kpi-discretionary-spend"
          index={9}
          hint="Sum of Dining, Coffee, Delivery, and Shopping categories. Use it to gauge how much of your spending is optional this period."
          hintTestId="hint-discretionary-spend"
        />
      </div>

      {/* ── Recurring expenses breakdown ────────────────────────────── */}
      <div className="mb-4">
        <RecurringExpensesPanel
          dateRange={dateRange}
          periodLabelFull={periodLabelFull}
          kpiTotal={totals.recurringExpenses}
          index={10}
        />
      </div>

      {/* ── Row 4: Monthly baselines (or all-time totals) ──────────────── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <KpiCard
          label={isAllTime ? "Utilities" : "Utilities / Month"}
          value={
            isAllTime
              ? currency(totals.utilitiesTotal)
              : currency(totals.utilitiesMonthly)
          }
          sub={isAllTime ? "All-time total" : `${periodLabel} avg`}
          accent="neutral"
          data-testid="kpi-utilities-monthly"
          index={10}
          href={ledgerUrl(
            { category: "utilities", transactionClass: "expense" },
            dateRange,
          )}
        />
        <KpiCard
          label={
            isAllTime
              ? "Software & Subscriptions"
              : "Software & Subscriptions / Month"
          }
          value={
            isAllTime
              ? currency(totals.softwareTotal)
              : currency(totals.softwareMonthly)
          }
          sub={isAllTime ? "All-time total" : `${periodLabel} avg`}
          accent="neutral"
          data-testid="kpi-software-monthly"
          index={11}
          href={ledgerUrl(
            { category: "software", transactionClass: "expense" },
            dateRange,
          )}
        />
      </div>

      {/* ── Row 5: Spending by category ────────────────────────────────── */}
      <GlassCard index={12} className="mb-4">
        <h2 className="glass-section-title mb-4">Spending by Category</h2>
        {spendingCategories.length === 0 ? (
          <p className="app-placeholder">No outflow transactions.</p>
        ) : (
          <ul className="space-y-2">
            {spendingCategories.map((cat) => (
              <li key={cat.category}>
                <Link
                  href={ledgerUrl({ category: cat.category }, dateRange)}
                  className="flex items-center gap-3 group py-1 rounded-lg hover:bg-blue-50/40 dark:hover:bg-white/5 transition-colors px-1 -mx-1"
                >
                  <span className="w-24 shrink-0 text-xs text-slate-600 dark:text-slate-300 capitalize truncate group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">
                    {capitalize(cat.category)}
                  </span>
                  <div className="flex-1 h-1.5 bg-blue-50 dark:bg-slate-700 rounded-full overflow-hidden border border-blue-100 dark:border-slate-600">
                    <div
                      className="h-full bg-blue-400 dark:bg-blue-500 rounded-full group-hover:bg-blue-500 dark:group-hover:bg-blue-400 transition-colors"
                      style={{ width: pct(cat.total, totalSpending) }}
                    />
                  </div>
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200 w-20 text-right shrink-0">
                    {currency(cat.total)}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-400 w-10 text-right shrink-0">
                    {pct(cat.total, totalSpending)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

    </div>
  );
}
