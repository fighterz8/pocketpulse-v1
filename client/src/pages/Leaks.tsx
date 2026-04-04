import { useState } from "react";
import { motion } from "framer-motion";

import {
  useRecurringCandidates,
  useReviewMutation,
  useSyncRecurringMutation,
  type RecurringCandidate,
  type ReviewStatus,
} from "../hooks/use-recurring";

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

function freqLabel(f: string): string {
  const map: Record<string, string> = {
    weekly: "Weekly", biweekly: "Every 2 wks",
    monthly: "Monthly", quarterly: "Quarterly", annual: "Annual",
  };
  return map[f] ?? f;
}

function dayLabel(days: number): string {
  const abs = Math.abs(days);
  if (days < 0)  return `due in ${abs}d`;
  if (days === 0) return "due today";
  if (days <= 5)  return `${days}d overdue`;
  return `${days}d since due`;
}

const CATEGORY_COLORS: Record<string, string> = {
  software: "bg-violet-100 text-violet-700",
  utilities: "bg-sky-100 text-sky-700",
  fitness: "bg-green-100 text-green-700",
  insurance: "bg-blue-100 text-blue-700",
  entertainment: "bg-pink-100 text-pink-700",
  dining: "bg-orange-100 text-orange-700",
  medical: "bg-red-100 text-red-700",
  housing: "bg-amber-100 text-amber-700",
  shopping: "bg-lime-100 text-lime-700",
  other: "bg-slate-100 text-slate-600",
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

// ─── Filter tabs ──────────────────────────────────────────────────────────────

type FilterTab = "all" | "active" | ReviewStatus;

const TABS: { key: FilterTab; label: string }[] = [
  { key: "all",         label: "All" },
  { key: "active",      label: "Active" },
  { key: "unreviewed",  label: "Unreviewed" },
  { key: "essential",   label: "Essential" },
  { key: "leak",        label: "Leaks" },
  { key: "dismissed",   label: "Not Recurring" },
];

function applyFilter(candidates: RecurringCandidate[], tab: FilterTab): RecurringCandidate[] {
  if (tab === "all")    return candidates;
  if (tab === "active") return candidates.filter((c) => c.isActive);
  return candidates.filter((c) => c.reviewStatus === tab);
}

// ─── Summary KPI bar ─────────────────────────────────────────────────────────

function SummaryBar({
  summary,
}: {
  summary: {
    total: number;
    unreviewed: number;
    essential: number;
    leak: number;
    dismissed: number;
    totalMonthlyActive: number;
    totalMonthlyLeak: number;
    totalMonthlyEssential: number;
    totalMonthlyUnreviewed: number;
  };
}) {
  return (
    <motion.div
      className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4"
      variants={fadeUp} initial="hidden" animate="visible" custom={1}
    >
      <div className="glass-card text-center py-3">
        <p className="text-xl font-bold text-slate-800">{fmtShort(summary.totalMonthlyActive)}</p>
        <p className="text-xs text-slate-500 mt-0.5">Active/month</p>
      </div>
      <div className="glass-card text-center py-3">
        <p className="text-xl font-bold text-red-500">{fmtShort(summary.totalMonthlyLeak)}</p>
        <p className="text-xs text-slate-500 mt-0.5">Leaks/month</p>
      </div>
      <div className="glass-card text-center py-3">
        <p className="text-xl font-bold text-red-400">{fmtShort(summary.totalMonthlyLeak * 12)}</p>
        <p className="text-xs text-slate-500 mt-0.5">Leak cost/year</p>
      </div>
      <div className="glass-card text-center py-3">
        <p className="text-xl font-bold text-amber-500">{summary.unreviewed}</p>
        <p className="text-xs text-slate-500 mt-0.5">Need review</p>
      </div>
    </motion.div>
  );
}

// ─── Candidate card ───────────────────────────────────────────────────────────

function CandidateCard({
  candidate: c,
  onReview,
  isPending,
  index = 0,
}: {
  candidate: RecurringCandidate;
  onReview: (key: string, status: ReviewStatus) => void;
  isPending: boolean;
  index?: number;
}) {
  const statusBorder =
    c.reviewStatus === "essential" ? "border-l-emerald-400" :
    c.reviewStatus === "leak"      ? "border-l-red-400" :
    c.reviewStatus === "dismissed" ? "border-l-slate-300 opacity-60" :
    "border-l-transparent";

  const txCount = c.transactionIds.length;
  const monthSpan = Math.max(1, Math.round(
    (new Date(c.lastSeen).getTime() - new Date(c.firstSeen).getTime()) / (1000 * 60 * 60 * 24 * 30)
  ));

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className={`glass-card border-l-4 ${statusBorder} flex flex-col sm:flex-row gap-4`}
      data-testid={`leak-card-${c.candidateKey}`}
    >
      {/* Left: name + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap mb-1.5">
          <span className="font-semibold text-slate-800 text-sm leading-snug">
            {c.merchantDisplay}
          </span>
          {!c.isActive && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
              Possibly cancelled
            </span>
          )}
          {c.autoEssential && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-200">
              Auto-labeled
            </span>
          )}
          {c.isActive && c.reviewStatus === "unreviewed" && !c.autoEssential && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200">
              Needs review
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(c.category)}`}>
            {capitalize(c.category)}
          </span>
          <span>{freqLabel(c.frequency)}</span>
          <span>·</span>
          <span>{txCount} charges over {monthSpan} month{monthSpan !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>Last: {c.lastSeen}</span>
          {c.isActive && (
            <>
              <span>·</span>
              <span className={c.daysSinceExpected > 0 ? "text-orange-500" : "text-slate-400"}>
                {dayLabel(c.daysSinceExpected)}
              </span>
            </>
          )}
        </div>

        <p className="text-xs text-slate-400 mt-1.5 leading-snug">{c.reasonFlagged}</p>

        {/* Confidence bar */}
        <div className="flex items-center gap-2 mt-2">
          <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden max-w-[80px]">
            <div
              className={`h-full rounded-full ${c.confidence >= 0.7 ? "bg-emerald-400" : c.confidence >= 0.5 ? "bg-amber-400" : "bg-slate-300"}`}
              style={{ width: `${Math.round(c.confidence * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-slate-400">{Math.round(c.confidence * 100)}% confidence</span>
        </div>
      </div>

      {/* Center: amounts */}
      <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-1 sm:min-w-[110px] sm:text-right">
        <div>
          <p className={`text-lg font-bold leading-none ${c.reviewStatus === "leak" ? "text-red-500" : "text-slate-800"}`}>
            {fmt(c.monthlyEquivalent)}<span className="text-xs font-normal text-slate-400">/mo</span>
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{fmt(c.annualEquivalent)}/yr</p>
        </div>
        <p className="text-xs text-slate-400">avg {fmt(c.averageAmount)}</p>
      </div>

      {/* Right: action buttons */}
      <div className="flex flex-row sm:flex-col gap-1.5 sm:min-w-[110px]">
        <button
          data-testid={`btn-essential-${c.candidateKey}`}
          className={`leak-action ${c.reviewStatus === "essential" ? "leak-action--essential-active" : "leak-action--essential"}`}
          onClick={() => onReview(c.candidateKey, "essential")}
          disabled={isPending}
        >
          ✓ Essential
        </button>
        <button
          data-testid={`btn-leak-${c.candidateKey}`}
          className={`leak-action ${c.reviewStatus === "leak" ? "leak-action--leak-active" : "leak-action--leak"}`}
          onClick={() => onReview(c.candidateKey, "leak")}
          disabled={isPending}
        >
          ⚠ Leak
        </button>
        <button
          data-testid={`btn-dismiss-${c.candidateKey}`}
          className={`leak-action ${c.reviewStatus === "dismissed" ? "leak-action--dismiss-active" : "leak-action--dismiss"}`}
          onClick={() => onReview(c.candidateKey, "dismissed")}
          disabled={isPending}
        >
          ✕ Not recurring
        </button>
      </div>
    </motion.div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Leaks() {
  const [activeTab, setActiveTab] = useState<FilterTab>("unreviewed");
  const [sortBy, setSortBy] = useState<"cost" | "confidence" | "lastSeen">("cost");

  const { data, isLoading, error } = useRecurringCandidates();
  const reviewMutation  = useReviewMutation();
  const syncMutation    = useSyncRecurringMutation();

  const handleReview = (candidateKey: string, status: ReviewStatus) => {
    reviewMutation.mutate({ candidateKey, status });
  };

  const handleSync = () => { syncMutation.mutate(); };

  // ── Sort
  function sortCandidates(list: RecurringCandidate[]): RecurringCandidate[] {
    return [...list].sort((a, b) => {
      if (sortBy === "cost")       return b.monthlyEquivalent - a.monthlyEquivalent;
      if (sortBy === "confidence") return b.confidence - a.confidence;
      return b.lastSeen.localeCompare(a.lastSeen);
    });
  }

  const pageHeader = (
    <motion.div className="mb-4 flex items-center justify-between flex-wrap gap-3"
      variants={fadeUp} initial="hidden" animate="visible" custom={0}>
      <div>
        <h1 className="app-page-title mb-0.5">Recurring &amp; Leaks</h1>
        <p className="text-sm text-slate-500">
          Review recurring charges — mark leaks you want to cut, essentials to keep.
        </p>
      </div>
      <button
        data-testid="btn-sync-recurring"
        onClick={handleSync}
        disabled={syncMutation.isPending}
        className="sync-btn"
      >
        {syncMutation.isPending ? "Syncing…" : syncMutation.isSuccess ? "✓ Synced" : "⟳ Sync to Dashboard"}
      </button>
    </motion.div>
  );

  if (error) return (
    <div>{pageHeader}<p className="leaks-error">Failed to load recurring patterns.</p></div>
  );

  if (isLoading || !data) return (
    <div>{pageHeader}<p className="leaks-loading">Analyzing transaction patterns…</p></div>
  );

  const { candidates, summary } = data;
  const filtered = sortCandidates(applyFilter(candidates, activeTab));

  return (
    <div>
      {pageHeader}

      <SummaryBar summary={summary} />

      {/* Tabs + sort */}
      <motion.div className="flex items-center justify-between gap-3 mb-3 flex-wrap"
        variants={fadeUp} initial="hidden" animate="visible" custom={2}>
        <div className="leaks-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              data-testid={`tab-${tab.key}`}
              className={`leaks-tab ${activeTab === tab.key ? "leaks-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.key === "leak" && summary.leak > 0 && (
                <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">
                  {summary.leak}
                </span>
              )}
              {tab.key === "unreviewed" && summary.unreviewed > 0 && (
                <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-white text-[9px] font-bold">
                  {summary.unreviewed}
                </span>
              )}
            </button>
          ))}
        </div>

        <select
          data-testid="sort-select"
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-300"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
        >
          <option value="cost">Sort: Monthly cost</option>
          <option value="confidence">Sort: Confidence</option>
          <option value="lastSeen">Sort: Last seen</option>
        </select>
      </motion.div>

      {/* Sync result toast */}
      {syncMutation.isSuccess && (
        <motion.div
          className="mb-3 px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700"
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        >
          ✓ Dashboard synced — {syncMutation.data?.recurringCount} transactions marked recurring,{" "}
          {syncMutation.data?.oneTimeCount} marked one-time.
        </motion.div>
      )}

      {/* Cards */}
      {filtered.length === 0 ? (
        <motion.p className="leaks-empty" variants={fadeUp} initial="hidden" animate="visible" custom={3}>
          {activeTab === "all"
            ? "No recurring patterns detected. Upload more transactions for better results."
            : `No ${activeTab === "active" ? "active" : activeTab} candidates.`}
        </motion.p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((c, i) => (
            <CandidateCard
              key={c.candidateKey}
              candidate={c}
              onReview={handleReview}
              isPending={reviewMutation.isPending}
              index={i + 3}
            />
          ))}
        </div>
      )}
    </div>
  );
}
