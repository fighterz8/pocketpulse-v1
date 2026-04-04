import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";

import {
  formatMonthLabel,
  useAvailableMonths,
  useDashboardSummary,
} from "../hooks/use-dashboard";

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
  if (abs >= 1_000_000) return (n < 0 ? "-$" : "$") + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n < 0 ? "-$" : "$") + (abs / 1_000).toFixed(1) + "K";
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

/** Build a /ledger URL with the given query params. */
function ledgerUrl(
  params: Record<string, string | undefined>,
  dateRange?: { dateFrom?: string; dateTo?: string },
): string {
  const qp = new URLSearchParams();
  const all = { ...dateRange, ...params };
  Object.entries(all).forEach(([k, v]) => { if (v) qp.set(k, v); });
  const qs = qp.toString();
  return `/ledger${qs ? `?${qs}` : ""}`;
}

// ─── Animation variants ──────────────────────────────────────────────────────

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, delay: i * 0.07, ease: [0.25, 0, 0, 1] as [number, number, number, number] },
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
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") navigate(href!); } : undefined}
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
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "red" | "blue" | "neutral";
  href?: string;
  "data-testid"?: string;
  index?: number;
}) {
  const colorMap = {
    green: "text-emerald-600",
    red: "text-red-500",
    blue: "text-blue-600",
    neutral: "text-slate-800",
  };
  return (
    <GlassCard index={index} href={href}>
      <p className="kpi-label">{label}</p>
      <p data-testid={testId} className={`kpi-value ${colorMap[accent]}`}>{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
      {href && <p className="kpi-drill">View transactions →</p>}
    </GlassCard>
  );
}

function safeToSpendStatus(safeToSpend: number, income: number): {
  label: string;
  badge: string;
} {
  if (income === 0) return { label: "No income data", badge: "badge-neutral" };
  if (safeToSpend > income * 0.2) return { label: "Healthy buffer", badge: "badge-green" };
  if (safeToSpend > 0) return { label: "Tight but positive", badge: "badge-yellow" };
  if (safeToSpend > -income * 0.2) return { label: "Slightly over", badge: "badge-orange" };
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
    const el = scrollRef.current?.querySelector<HTMLElement>("[data-active='true']");
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
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

      {months.map(({ month, transactionCount }) => (
        <button
          key={month}
          data-testid={`month-btn-${month}`}
          data-active={selected === month ? "true" : "false"}
          onClick={() => onSelect(month)}
          className={`period-btn ${selected === month ? "period-btn--active" : ""}`}
        >
          {formatMonthLabel(month)}
          <span className="ml-1.5 text-[10px] opacity-50 font-normal">{transactionCount}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

// Categories excluded from the spending breakdown display
const HIDDEN_CATEGORIES = new Set(["income", "transfers"]);

export function Dashboard() {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const { data: availableMonths, isLoading: monthsLoading } = useAvailableMonths();

  useEffect(() => {
    if (!availableMonths || availableMonths.length === 0) return;
    const best =
      availableMonths.find((m) => m.transactionCount >= 20) ?? availableMonths[0];
    setSelectedMonth(best.month);
  }, [availableMonths]);

  const { data, isLoading, error } = useDashboardSummary({ month: selectedMonth });

  // Date range for ledger deep-links
  const dateRange = selectedMonth ? monthToDateRange(selectedMonth) : undefined;

  const periodLabel = selectedMonth
    ? formatMonthLabel(selectedMonth)
    : "All Time";

  const periodLabelFull = selectedMonth
    ? (() => {
        const [year, mo] = selectedMonth.split("-").map(Number);
        return new Date(year, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
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
    <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={0} className="mb-6">
      <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
        <div>
          <h1 className="dash-title">Dashboard</h1>
          <p className="dash-subtitle">
            Cashflow overview · <span className="font-medium text-slate-600">{periodLabelFull}</span>
          </p>
        </div>
      </div>
      {monthSelector}
    </motion.div>
  );

  if (isLoading && !data) {
    return (
      <div>
        {headerRow}
        <p className="app-placeholder">Loading dashboard…</p>
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
          <p className="dash-empty-msg">No transactions in {periodLabelFull}.</p>
          {selectedMonth ? (
            <button className="dash-leaks-link mt-2" onClick={() => setSelectedMonth(null)}>
              View All Time →
            </button>
          ) : (
            <Link href="/upload" className="dash-empty-link" data-testid="link-upload-first">
              Upload your first CSV →
            </Link>
          )}
        </GlassCard>
      </div>
    );
  }

  const { totals, expenseLeaks, categoryBreakdown } = data;

  // Filter out non-spending categories from the breakdown
  const spendingCategories = categoryBreakdown.filter(
    (c) => !HIDDEN_CATEGORIES.has(c.category),
  );
  const totalSpending = spendingCategories.reduce((s, c) => s + c.total, 0);

  const safeToSpend = totals.safeToSpend;
  const spendStatus = safeToSpendStatus(safeToSpend, totals.recurringIncome);
  const safeColor = safeToSpend > 0
    ? "text-emerald-600"
    : safeToSpend > -totals.recurringIncome * 0.2
    ? "text-orange-500"
    : "text-red-500";

  const recurringRatio = totals.recurringIncome > 0
    ? Math.min(100, (totals.recurringExpenses / Math.max(totals.recurringIncome, totals.recurringExpenses)) * 100)
    : 0;

  return (
    <div>
      {headerRow}

      {/* ── Row 1: Safe-to-Spend Hero + Expense Leaks ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Safe-to-Spend Hero — links to all recurring transactions */}
        <GlassCard
          className="lg:col-span-2"
          index={1}
          href={ledgerUrl({ recurrenceType: "recurring" }, dateRange)}
        >
          <p className="kpi-label">Safe-to-Spend Estimate</p>
          <p data-testid="safe-to-spend-value" className={`dash-hero-value ${safeColor}`}>
            {currency(safeToSpend)}
          </p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className={`dash-badge ${spendStatus.badge}`}>{spendStatus.label}</span>
            <span className="text-xs text-slate-400">
              Recurring income minus recurring expenses · {periodLabelFull}
            </span>
          </div>

          <div className="mt-5">
            <div className="flex justify-between text-xs text-slate-400 mb-1.5">
              <span>Recurring expenses</span>
              <span>Recurring income</span>
            </div>
            <div className="h-2 bg-blue-50 rounded-full overflow-hidden border border-blue-100">
              {totals.recurringIncome > 0 && (
                <div
                  className={`h-full rounded-full transition-all ${safeToSpend >= 0 ? "bg-emerald-500" : "bg-red-400"}`}
                  style={{ width: `${recurringRatio}%` }}
                />
              )}
            </div>
            <div className="flex justify-between text-xs mt-1.5">
              <span className="text-red-500 font-semibold">{currency(totals.recurringExpenses)}</span>
              <span className="text-emerald-600 font-semibold">{currency(totals.recurringIncome)}</span>
            </div>
          </div>
          <p className="kpi-drill mt-4">View recurring transactions →</p>
        </GlassCard>

        {/* Expense Leaks — links to /leaks page */}
        <GlassCard className="flex flex-col justify-between" index={2} href="/leaks">
          <div>
            <p className="kpi-label">Expense Leaks</p>
            <p data-testid="leak-count" className="dash-hero-value text-slate-900">
              {expenseLeaks.count > 0 ? expenseLeaks.count : "—"}
            </p>
            <p className="text-sm text-slate-500 mt-1">
              {expenseLeaks.count > 0
                ? `${expenseLeaks.count} recurring charge${expenseLeaks.count !== 1 ? "s" : ""} marked as leaks`
                : "No leaks flagged yet"}
            </p>
            {expenseLeaks.monthlyAmount > 0 && (
              <p className="text-sm text-red-500 font-semibold mt-1">
                ~{currency(expenseLeaks.monthlyAmount / Math.max(1, totals.periodDays / 30))}/mo in recurring charges
              </p>
            )}
          </div>
          <p className="kpi-drill">Review recurring →</p>
        </GlassCard>
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
          sub="Baseline revenue"
          accent="green"
          data-testid="kpi-recurring-income"
          index={5}
          href={ledgerUrl({ transactionClass: "income", recurrenceType: "recurring" }, dateRange)}
        />
        <KpiCard
          label="Recurring Expenses"
          value={currencyShort(totals.recurringExpenses)}
          sub="Baseline costs"
          accent="red"
          data-testid="kpi-recurring-expenses"
          index={6}
          href={ledgerUrl({ transactionClass: "expense", recurrenceType: "recurring" }, dateRange)}
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
          href={ledgerUrl({ transactionClass: "income", recurrenceType: "one-time" }, dateRange)}
        />
        <KpiCard
          label="One-Time Expenses"
          value={currencyShort(totals.oneTimeExpenses)}
          sub="Non-recurring costs"
          accent="neutral"
          data-testid="kpi-one-time-expenses"
          index={8}
          href={ledgerUrl({ transactionClass: "expense", recurrenceType: "one-time" }, dateRange)}
        />
        <KpiCard
          label="Discretionary Spend"
          value={currencyShort(totals.discretionarySpend)}
          sub={`${periodLabel} · dining, coffee, delivery…`}
          accent="neutral"
          data-testid="kpi-discretionary-spend"
          index={9}
          href={ledgerUrl({ transactionClass: "expense" }, dateRange)}
        />
      </div>

      {/* ── Row 4: Monthly baselines ───────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <KpiCard
          label="Utilities / Month"
          value={currency(totals.utilitiesMonthly)}
          sub={`${periodLabel} avg`}
          accent="neutral"
          data-testid="kpi-utilities-monthly"
          index={10}
          href={ledgerUrl({ category: "utilities" }, dateRange)}
        />
        <KpiCard
          label="Software & Subscriptions / Month"
          value={currency(totals.softwareMonthly)}
          sub={`${periodLabel} avg`}
          accent="neutral"
          data-testid="kpi-software-monthly"
          index={11}
          href={ledgerUrl({ category: "software" }, dateRange)}
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
                  className="flex items-center gap-3 group py-1 rounded-lg hover:bg-blue-50/40 transition-colors px-1 -mx-1"
                >
                  <span className="w-24 shrink-0 text-xs text-slate-600 capitalize truncate group-hover:text-blue-700 transition-colors">
                    {capitalize(cat.category)}
                  </span>
                  <div className="flex-1 h-1.5 bg-blue-50 rounded-full overflow-hidden border border-blue-100">
                    <div
                      className="h-full bg-blue-400 rounded-full group-hover:bg-blue-500 transition-colors"
                      style={{ width: pct(cat.total, totalSpending) }}
                    />
                  </div>
                  <span className="text-xs font-medium text-slate-700 w-20 text-right shrink-0">
                    {currency(cat.total)}
                  </span>
                  <span className="text-xs text-slate-400 w-10 text-right shrink-0">
                    {pct(cat.total, totalSpending)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

      {/* ── Tech-stack footer ──────────────────────────────────────────── */}
      <motion.p
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        custom={13}
        className="dash-tech-footer"
      >
        React · TailwindCSS · Framer Motion · Glass UI
      </motion.p>
    </div>
  );
}
