import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  useAvailableMonths,
  formatMonthLabel,
} from "../hooks/use-dashboard";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CategoryBreakdownItem {
  category: string;
  total: number;
  count: number;
}

interface LeakItem {
  merchant: string;
  merchantKey: string;
  merchantFilter: string;
  dominantCategory: string;
  categoryBreakdown: CategoryBreakdownItem[];
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  label: string;
  monthlyAmount: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  recentSpend: number;
  dailyAverage?: number;
  transactionClass: "expense";
  recurrenceType?: "recurring" | "one-time";
  isSubscriptionLike: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShort(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function monthToDateRange(month: string): { startDate: string; endDate: string } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(y, m - 1, 1);
  const to   = new Date(y, m, 0);
  const pad  = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { startDate: pad(from), endDate: pad(to) };
}

function currentMonthStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function shortDate(iso: string): string {
  const [year, mo, day] = iso.split("-").map(Number);
  return new Date(year, mo - 1, day).toLocaleString("en-US", { month: "short", day: "numeric" });
}

const CATEGORY_COLORS: Record<string, string> = {
  dining:        "bg-orange-100 text-orange-700",
  coffee:        "bg-amber-100 text-amber-700",
  delivery:      "bg-yellow-100 text-yellow-700",
  convenience:   "bg-lime-100 text-lime-700",
  shopping:      "bg-pink-100 text-pink-700",
  entertainment: "bg-purple-100 text-purple-700",
  fitness:       "bg-green-100 text-green-700",
  software:      "bg-violet-100 text-violet-700",
  other:         "bg-slate-100 text-slate-600",
};

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? "bg-slate-100 text-slate-600";
}


const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  visible: (i: number = 0) => ({
    opacity: 1, y: 0,
    transition: { duration: 0.35, delay: i * 0.04, ease: [0.25, 0, 0, 1] as [number, number, number, number] },
  }),
};

// ─── Month selector ───────────────────────────────────────────────────────────

function MonthSelector({
  months,
  selected,
  onSelect,
}: {
  months: Array<{ month: string; transactionCount: number }>;
  selected: string | null;
  onSelect: (month: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>("[data-active='true']");
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selected]);

  if (months.length === 0) return null;

  return (
    <div ref={scrollRef} className="period-selector" data-testid="leaks-month-selector">
      {months.map(({ month, transactionCount }) => (
        <button
          key={month}
          data-testid={`leaks-month-btn-${month}`}
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

// ─── LeakCard ─────────────────────────────────────────────────────────────────

function LeakCard({
  leak: l,
  index = 0,
  startDate,
  endDate,
}: {
  leak: LeakItem;
  index?: number;
  startDate: string;
  endDate: string;
}) {
  // Use ?search= so the Ledger's ILIKE filter picks up all of this merchant's
  // transactions across every category within the selected date range.
  const ledgerParams = new URLSearchParams({
    search: l.merchantFilter,
    transactionClass: "expense",
    dateFrom: startDate,
    dateTo: endDate,
  });
  const ledgerHref = `/transactions?${ledgerParams.toString()}`;

  const bucketBorderColor =
    l.bucket === "micro_spend"                ? "border-l-amber-400" :
    l.bucket === "high_frequency_convenience" ? "border-l-orange-400" :
                                                "border-l-pink-400";

  const slug = l.merchantKey.replace(/\W+/g, "-");

  // Date span: only show if first and last differ
  const dateSpan =
    l.firstDate !== l.lastDate
      ? `${shortDate(l.firstDate)} – ${shortDate(l.lastDate)}`
      : shortDate(l.lastDate);

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className={`glass-card border-l-4 ${bucketBorderColor}`}
      data-testid={`leak-card-${slug}`}
    >
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1 min-w-0">
          {/* Header: merchant name + badge row */}
          <div className="flex items-start gap-2 flex-wrap mb-1.5">
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm leading-snug">
              {l.merchant}
            </span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(l.dominantCategory)}`}>
              {capitalize(l.dominantCategory)}
            </span>
          </div>

          {/* Bucket label */}
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5">{l.label}</p>

          {/* Category breakdown */}
          <div
            className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 mb-1.5"
            data-testid={`leak-breakdown-${slug}`}
          >
            {l.categoryBreakdown.map((b) => (
              <span key={b.category}>
                <span className={`inline-block px-1 py-0 rounded text-[10px] font-medium mr-0.5 ${categoryColor(b.category)}`}>
                  {capitalize(b.category)}
                </span>
                {b.count}x {fmt(b.total)}
              </span>
            ))}
          </div>

          {/* Stats row: occurrences, avg, date span */}
          <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500 dark:text-slate-400">
            <span data-testid={`leak-occurrences-${slug}`}>{l.occurrences} charges</span>
            <span>·</span>
            <span>avg {fmt(l.averageAmount)}</span>
            <span>·</span>
            <span data-testid={`leak-datespan-${slug}`}>{dateSpan}</span>
          </div>
        </div>

        {/* Right column: amounts + link */}
        <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 sm:min-w-[120px] sm:text-right">
          <div>
            <p className="text-lg font-bold leading-none text-red-500" data-testid={`leak-spend-${slug}`}>
              {fmt(l.recentSpend)}{" "}
              <span className="text-xs font-normal text-slate-400 dark:text-slate-500">this month</span>
            </p>
          </div>
          <a
            href={ledgerHref}
            data-testid={`link-ledger-${slug}`}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
          >
            View in Ledger →
          </a>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Leaks() {
  // Read URL params once — used as the initial month hint from Dashboard card links.
  const urlParams  = new URLSearchParams(window.location.search);
  const urlStart   = urlParams.get("startDate");
  const urlInitial = urlStart ? monthFromIso(urlStart) : null;

  // Available months from the server (same source as Dashboard month selector).
  const { data: availableMonths = [], isLoading: monthsLoading } = useAvailableMonths();

  // Selected month state.
  // Priority: URL param → most recent available month (set via effect) → current month.
  const [selectedMonth, setSelectedMonth] = useState<string>(
    urlInitial ?? currentMonthStr(),
  );

  // Once available months load, default to the most recent one if the URL
  // didn't specify a month and the current calendar month has no data.
  useEffect(() => {
    if (urlInitial) return; // URL param takes precedence — don't override.
    if (availableMonths.length === 0) return;
    const mostRecent = availableMonths[0].month;
    // Only switch if the current selection isn't in the available months list.
    const isKnown = availableMonths.some((m) => m.month === selectedMonth);
    if (!isKnown) setSelectedMonth(mostRecent);
  }, [availableMonths, urlInitial]); // eslint-disable-line react-hooks/exhaustive-deps

  const { startDate, endDate } = monthToDateRange(selectedMonth);
  const monthLabelStr = new Date(
    parseInt(selectedMonth.split("-")[0]),
    parseInt(selectedMonth.split("-")[1]) - 1,
    1,
  ).toLocaleString("en-US", { month: "long", year: "numeric" });

  const { data: leaks = [], isLoading, error } = useQuery<LeakItem[]>({
    queryKey: ["/api/leaks", startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/leaks?startDate=${startDate}&endDate=${endDate}`);
      if (!res.ok) throw new Error("Failed to load leak data");
      return res.json();
    },
    staleTime: 60_000,
  });

  const totals = leaks.reduce(
    (acc, l) => {
      acc.flagged += l.recentSpend;
      acc.count   += 1;
      return acc;
    },
    { flagged: 0, count: 0 },
  );

  const sortedLeaks = [...leaks].sort((a, b) => {
    const aNew = typeof a.firstDate === "string" && a.firstDate >= startDate ? 1 : 0;
    const bNew = typeof b.firstDate === "string" && b.firstDate >= startDate ? 1 : 0;
    if (aNew !== bNew) return bNew - aNew;
    return b.recentSpend - a.recentSpend;
  });

  const pageHeader = (
    <motion.div className="mb-4" variants={fadeUp} initial="hidden" animate="visible" custom={0}>
      <h1 className="app-page-title mb-0.5">
        <svg className="page-title-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 3C10 3 4 9.5 4 13a6 6 0 0012 0c0-3.5-6-10-6-10z" />
          <path d="M7.5 14.5a2.5 2.5 0 004.5-1.5" strokeWidth="1.4" />
        </svg>
        Leak Detection
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Automatically detected discretionary spending patterns · no review required.
      </p>
    </motion.div>
  );

  const monthSelector = monthsLoading ? null : (
    <motion.div className="mb-5" variants={fadeUp} initial="hidden" animate="visible" custom={1}>
      <MonthSelector
        months={availableMonths}
        selected={selectedMonth}
        onSelect={setSelectedMonth}
      />
    </motion.div>
  );

  const summaryLine = !isLoading && !error && leaks.length > 0 && (
    <motion.p
      className="text-sm text-slate-600 dark:text-slate-300 mb-4 font-medium"
      data-testid="leaks-summary-inline"
      variants={fadeUp} initial="hidden" animate="visible" custom={2}
    >
      {totals.count} leak{totals.count !== 1 ? "s" : ""} detected in{" "}
      <span className="text-slate-700 dark:text-slate-200">{monthLabelStr}</span>
      {" "}·{" "}
      <span className="text-red-500">{fmt(totals.flagged)} flagged</span>
    </motion.p>
  );

  if (error) return (
    <div>
      {pageHeader}
      {monthSelector}
      <p className="leaks-error" data-testid="leaks-error">Failed to load leak data.</p>
    </div>
  );

  if (isLoading) return (
    <div>
      {pageHeader}
      {monthSelector}
      <p className="leaks-loading" data-testid="leaks-loading">Analyzing spending patterns…</p>
    </div>
  );

  if (leaks.length === 0) return (
    <div>
      {pageHeader}
      {monthSelector}
      <motion.div
        className="glass-card text-center py-10"
        variants={fadeUp} initial="hidden" animate="visible" custom={2}
        data-testid="leaks-empty"
      >
        <p className="text-2xl mb-2">✓</p>
        <p className="font-semibold text-slate-700 dark:text-slate-100 mb-1">No leaks detected</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No discretionary spending patterns detected for {monthLabelStr}.<br />
          Upload more statements or select a different month.
        </p>
      </motion.div>
    </div>
  );

  return (
    <div>
      {pageHeader}
      {monthSelector}
      {summaryLine}
      <div className="flex flex-col gap-3">
        {sortedLeaks.map((l, i) => (
          <LeakCard
            key={l.merchantKey}
            leak={l}
            index={i + 3}
            startDate={startDate}
            endDate={endDate}
          />
        ))}
      </div>
    </div>
  );
}
