import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LeakItem {
  merchant: string;
  merchantFilter: string;
  category: string;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  label: string;
  monthlyAmount: number;
  occurrences: number;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  recentSpend: number;
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

function monthLabel(isoDate: string): string {
  const [year, mo] = isoDate.split("-").map(Number);
  return new Date(year, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
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

const CONFIDENCE_COLORS: Record<string, string> = {
  High:   "bg-emerald-100 text-emerald-700",
  Medium: "bg-amber-100 text-amber-700",
  Low:    "bg-slate-100 text-slate-500",
};

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  visible: (i: number = 0) => ({
    opacity: 1, y: 0,
    transition: { duration: 0.35, delay: i * 0.04, ease: [0.25, 0, 0, 1] as [number, number, number, number] },
  }),
};

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
  const ledgerParams = new URLSearchParams({
    merchant: l.merchantFilter,
    transactionClass: "expense",
    dateFrom: startDate,
    dateTo: endDate,
  });
  if (l.recurrenceType === "recurring") ledgerParams.set("recurrenceType", "recurring");
  const ledgerHref = `/transactions?${ledgerParams.toString()}`;

  const bucketBorderColor =
    l.bucket === "micro_spend"                ? "border-l-amber-400" :
    l.bucket === "high_frequency_convenience" ? "border-l-orange-400" :
                                                "border-l-pink-400";

  const slug = l.merchant.toLowerCase().replace(/\W+/g, "-");

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
        {/* Left: merchant + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap mb-1.5">
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm leading-snug">
              {l.merchant}
            </span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(l.category)}`}>
              {capitalize(l.category)}
            </span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${CONFIDENCE_COLORS[l.confidence] ?? "bg-slate-100 text-slate-500"}`}>
              {l.confidence} confidence
            </span>
            {l.isSubscriptionLike && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 text-violet-700">
                Subscription-like
              </span>
            )}
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5">{l.label}</p>

          <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500 dark:text-slate-400">
            <span data-testid={`leak-occurrences-${slug}`}>{l.occurrences} charges</span>
            <span>·</span>
            <span>avg {fmt(l.averageAmount)}</span>
            <span>·</span>
            <span>last {shortDate(l.lastDate)}</span>
          </div>
        </div>

        {/* Right: amounts + drill-down */}
        <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 sm:min-w-[120px] sm:text-right">
          <div>
            <p className="text-lg font-bold leading-none text-red-500" data-testid={`leak-monthly-${slug}`}>
              {fmt(l.monthlyAmount)}<span className="text-xs font-normal text-slate-400 dark:text-slate-500">/mo</span>
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
              {fmt(l.recentSpend)} total
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
  const params = new URLSearchParams(window.location.search);

  const today = new Date();
  const year  = today.getFullYear();
  const month = today.getMonth() + 1;
  const pad   = (n: number) => String(n).padStart(2, "0");
  const defaultStart = `${year}-${pad(month)}-01`;
  const defaultEnd   = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;

  const startDate = params.get("startDate") || defaultStart;
  const endDate   = params.get("endDate")   || defaultEnd;

  const { data: leaks = [], isLoading, error } = useQuery<LeakItem[]>({
    queryKey: ["/api/leaks", startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/leaks?startDate=${startDate}&endDate=${endDate}`);
      if (!res.ok) throw new Error("Failed to load leak data");
      return res.json();
    },
    staleTime: 60_000,
  });

  const monthLabelStr = monthLabel(startDate);
  const totalFlagged  = leaks.reduce((s, l) => s + l.recentSpend, 0);
  const totalMonthly  = leaks.reduce((s, l) => s + l.monthlyAmount, 0);

  const pageHeader = (
    <motion.div className="mb-5" variants={fadeUp} initial="hidden" animate="visible" custom={0}>
      <h1 className="app-page-title mb-0.5">Expense Patterns</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Automatically detected discretionary spending patterns for{" "}
        <span className="font-medium text-slate-700 dark:text-slate-200">{monthLabelStr}</span>
        {" "}· no review required.
      </p>
      {!isLoading && !error && leaks.length > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5 font-medium" data-testid="leaks-summary-inline">
          {leaks.length} pattern{leaks.length !== 1 ? "s" : ""} detected ·{" "}
          <span className="text-red-500">{fmt(totalFlagged)} flagged</span>
          {totalMonthly > 0 && (
            <span className="text-slate-500 font-normal"> (~{fmtShort(totalMonthly)}/mo)</span>
          )}
        </p>
      )}
    </motion.div>
  );

  if (error) return (
    <div>
      {pageHeader}
      <p className="leaks-error" data-testid="leaks-error">Failed to load expense patterns.</p>
    </div>
  );

  if (isLoading) return (
    <div>
      {pageHeader}
      <p className="leaks-loading" data-testid="leaks-loading">Analyzing spending patterns…</p>
    </div>
  );

  if (leaks.length === 0) return (
    <div>
      {pageHeader}
      <motion.div
        className="glass-card text-center py-10"
        variants={fadeUp} initial="hidden" animate="visible" custom={2}
        data-testid="leaks-empty"
      >
        <p className="text-2xl mb-2">✓</p>
        <p className="font-semibold text-slate-700 dark:text-slate-100 mb-1">No patterns flagged</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No discretionary spending patterns detected for {monthLabelStr}.<br />
          Upload more statements to improve detection accuracy.
        </p>
      </motion.div>
    </div>
  );

  return (
    <div>
      {pageHeader}
      <div className="flex flex-col gap-3">
        {leaks.map((l, i) => (
          <LeakCard
            key={`${l.merchant}::${l.category}`}
            leak={l}
            index={i + 2}
            startDate={startDate}
            endDate={endDate}
          />
        ))}
      </div>
    </div>
  );
}
