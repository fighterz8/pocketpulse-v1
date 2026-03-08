import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, ArrowDownRight, TrendingUp, AlertTriangle, RefreshCcw, Download } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useMemo, useState } from "react";

interface CashflowSummary {
  totalInflows: number;
  totalOutflows: number;
  recurringIncome: number;
  recurringExpenses: number;
  oneTimeIncome: number;
  oneTimeExpenses: number;
  safeToSpend: number;
  netCashflow: number;
  utilitiesBaseline: number;
  subscriptionsBaseline: number;
  discretionarySpend: number;
}

interface LeakItem {
  merchant: string;
  monthlyAmount: number;
  occurrences: number;
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const LEDGER_DRILLDOWN_KEY = "ledger-drilldown";
const METRIC_FILTERS: Record<string, Record<string, string>> = {
  totalInflows: {
    transactionClass: "income",
  },
  totalOutflows: {
    transactionClass: "expense",
  },
  recurringIncome: {
    transactionClass: "income",
    recurrenceType: "recurring",
  },
  recurringExpenses: {
    transactionClass: "expense",
    recurrenceType: "recurring",
  },
  oneTimeIncome: {
    transactionClass: "income",
    recurrenceType: "one-time",
  },
  oneTimeExpenses: {
    transactionClass: "expense",
    recurrenceType: "one-time",
  },
  safeToSpend: {
    transactionClass: "income,expense",
    recurrenceType: "recurring",
  },
  netCashflow: {
    transactionClass: "income,expense",
  },
  utilitiesBaseline: {
    transactionClass: "expense",
    category: "utilities",
  },
  subscriptionsBaseline: {
    transactionClass: "expense",
    category: "subscriptions,business_software",
  },
  discretionarySpend: {
    transactionClass: "expense",
    category: "dining,shopping,entertainment",
  },
};

export default function Dashboard() {
  const [days, setDays] = useState(90);
  const cashflowUrl = useMemo(() => `/api/cashflow?days=${days}`, [days]);
  const leaksUrl = useMemo(() => `/api/leaks?days=${days}`, [days]);

  const { data: cashflow, isLoading: cfLoading } = useQuery<CashflowSummary>({
    queryKey: [cashflowUrl],
  });

  const { data: leaks } = useQuery<LeakItem[]>({
    queryKey: [leaksUrl],
  });

  const totalLeakMonthly = leaks?.reduce((s, l) => s + l.monthlyAmount, 0) ?? 0;

  const handleExport = () => {
    window.open(`/api/export/summary?days=${days}`, "_blank");
  };

  const metricHref = (metric: string) => {
    const params = new URLSearchParams({
      metric,
      days: String(days),
      ...METRIC_FILTERS[metric],
    });
    return `/transactions?${params.toString()}`;
  };

  const openMetricLedger = (metric: string) => {
    const href = metricHref(metric);
    const parsedHref = new URL(href, window.location.origin);
    window.sessionStorage.setItem(
      LEDGER_DRILLDOWN_KEY,
      JSON.stringify({
        metric,
        days: String(days),
        ...METRIC_FILTERS[metric],
      }),
    );
    window.location.href = parsedHref.pathname + parsedHref.search;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Financial overview and cashflow estimates for the selected window.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/analysis">
            <Button variant="outline">
              Advanced Analysis
            </Button>
          </Link>
          <div className="flex items-center gap-2 rounded-md border bg-background p-1">
            {[30, 60, 90].map((windowDays) => (
              <Button
                key={windowDays}
                variant={days === windowDays ? "default" : "ghost"}
                size="sm"
                onClick={() => setDays(windowDays)}
                data-testid={`button-window-${windowDays}`}
              >
                {windowDays}D
              </Button>
            ))}
          </div>
          <Button variant="outline" onClick={handleExport} data-testid="button-export">
            <Download className="mr-2 h-4 w-4" />
            Export Report
          </Button>
        </div>
      </div>

      {/* Primary KPI */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card
          className="md:col-span-2 border-primary/20 shadow-sm transition-colors hover:border-primary/40 cursor-pointer"
          onClick={() => {
            openMetricLedger("safeToSpend");
          }}
        >
          <CardHeader className="pb-2">
            <CardDescription className="font-medium text-sm">Safe-to-Spend Estimate</CardDescription>
            {cfLoading ? (
              <Skeleton className="h-12 w-48" />
            ) : (
              <CardTitle className="text-4xl md:text-5xl text-primary font-bold tracking-tight" data-testid="text-safe-to-spend">
                {fmt(cashflow?.safeToSpend ?? 0)}
              </CardTitle>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex items-center text-sm mt-2 text-muted-foreground">
              <Link href={metricHref("netCashflow")}>
                <span
                  className="flex items-center font-medium bg-primary/10 text-primary px-2 py-0.5 rounded mr-2 hover:bg-primary/15"
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    openMetricLedger("netCashflow");
                  }}
                >
                  <TrendingUp className="mr-1 h-3 w-3" />
                  Net: {fmt(cashflow?.netCashflow ?? 0)}
                </span>
              </Link>
              Based on the last {days} days of recurring income minus recurring expenses.
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-card to-card/50 shadow-sm border-warning/30">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium text-sm">Expense Leaks</CardDescription>
              <div className="h-8 w-8 rounded-full bg-warning/10 flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-warning" />
              </div>
            </div>
            <CardTitle className="text-3xl font-bold tracking-tight mt-1" data-testid="text-leak-count">
              {leaks?.length ?? 0} items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">~{fmt(totalLeakMonthly)}/mo in recurring charges.</p>
            <Link href="/leaks">
              <Button variant="outline" size="sm" className="w-full text-xs font-medium border-warning/50 hover:bg-warning/10" data-testid="button-review-leaks">
                Review Leaks
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Breakdown cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard label="Total Inflows" value={cashflow?.totalInflows} href={metricHref("totalInflows")} icon={<ArrowUpRight className="h-4 w-4 text-emerald-500" />} loading={cfLoading} testId="text-total-inflows" />
        <SummaryCard label="Total Outflows" value={cashflow?.totalOutflows} href={metricHref("totalOutflows")} icon={<ArrowDownRight className="h-4 w-4 text-destructive" />} loading={cfLoading} testId="text-total-outflows" />
        <SummaryCard label="Recurring Income" value={cashflow?.recurringIncome} href={metricHref("recurringIncome")} icon={<RefreshCcw className="h-4 w-4 text-emerald-500 opacity-70" />} loading={cfLoading} sub="Baseline" testId="text-recurring-income" />
        <SummaryCard label="Recurring Expenses" value={cashflow?.recurringExpenses} href={metricHref("recurringExpenses")} icon={<RefreshCcw className="h-4 w-4 text-destructive opacity-70" />} loading={cfLoading} sub="Baseline" testId="text-recurring-expenses" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <SummaryCard label="One-time Income" value={cashflow?.oneTimeIncome} href={metricHref("oneTimeIncome")} icon={<ArrowUpRight className="h-4 w-4 text-emerald-500" />} loading={cfLoading} testId="text-onetime-income" />
        <SummaryCard label="One-time Expenses" value={cashflow?.oneTimeExpenses} href={metricHref("oneTimeExpenses")} icon={<ArrowDownRight className="h-4 w-4 text-destructive" />} loading={cfLoading} testId="text-onetime-expenses" />
        <SummaryCard label="Discretionary Spend" value={cashflow?.discretionarySpend} href={metricHref("discretionarySpend")} icon={<AlertTriangle className="h-4 w-4 text-warning" />} loading={cfLoading} sub={`${days}-day total`} testId="text-discretionary-spend" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SummaryCard label="Utilities" value={cashflow?.utilitiesBaseline} href={metricHref("utilitiesBaseline")} icon={<RefreshCcw className="h-4 w-4 text-muted-foreground" />} loading={cfLoading} sub="Monthly baseline" testId="text-utilities-baseline" />
        <SummaryCard label="Subscriptions" value={cashflow?.subscriptionsBaseline} href={metricHref("subscriptionsBaseline")} icon={<RefreshCcw className="h-4 w-4 text-muted-foreground" />} loading={cfLoading} sub="Monthly baseline" testId="text-subscriptions-baseline" />
      </div>

      {!cfLoading && cashflow?.totalInflows === 0 && cashflow?.totalOutflows === 0 && (
        <Card className="shadow-sm border-dashed">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">No transaction data yet. Upload a CSV to get started.</p>
            <Link href="/upload">
              <Button data-testid="button-go-upload">Upload CSV</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, value, href, icon, loading, sub, testId }: { label: string; value?: number; href: string; icon: React.ReactNode; loading: boolean; sub?: string; testId: string }) {
  return (
    <Card
      className="shadow-sm transition-colors hover:border-primary/30 cursor-pointer"
      onClick={() => {
        const metric = new URL(href, window.location.origin).searchParams.get("metric");
        const days = new URL(href, window.location.origin).searchParams.get("days");
        if (metric) {
          window.sessionStorage.setItem(
            LEDGER_DRILLDOWN_KEY,
            JSON.stringify({
              metric,
              days,
            }),
          );
        }
        window.location.href = href;
      }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className="text-2xl font-bold" data-testid={testId}>{fmt(value ?? 0)}</div>
        )}
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}
