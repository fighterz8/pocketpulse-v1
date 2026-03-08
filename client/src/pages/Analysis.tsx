import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Download, TrendingUp } from "lucide-react";

type PresetValue =
  | "last30"
  | "last60"
  | "last90"
  | "thisMonth"
  | "lastMonth"
  | "quarterToDate"
  | "yearToDate"
  | "year"
  | "custom";

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

interface MetricDelta {
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
}

interface TrendPoint {
  period: string;
  inflows: number;
  outflows: number;
  netCashflow: number;
  discretionarySpend: number;
}

interface CategoryBreakdownItem {
  category: string;
  amount: number;
  monthlyBaseline: number;
  share: number;
  occurrences: number;
}

interface LeakItem {
  merchant: string;
  category: string;
  label: string;
  monthlyAmount: number;
  recentSpend: number;
}

interface AnalysisResponse {
  range: {
    preset: string;
    startDate: string;
    endDate: string;
    label: string;
    rangeDays: number;
    previousStartDate: string;
    previousEndDate: string;
  };
  analysis: {
    summary: CashflowSummary;
    previousSummary: CashflowSummary;
    comparisons: {
      inflows: MetricDelta;
      outflows: MetricDelta;
      netCashflow: MetricDelta;
      safeToSpend: MetricDelta;
      discretionarySpend: MetricDelta;
    };
    trend: TrendPoint[];
    categoryBreakdown: CategoryBreakdownItem[];
    leakPreview: LeakItem[];
    recurringConfidence: number;
  };
  currentTransactionCount: number;
  previousTransactionCount: number;
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Analysis() {
  const currentYear = new Date().getFullYear();
  const [preset, setPreset] = useState<PresetValue>("last90");
  const [year, setYear] = useState(String(currentYear));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (preset === "custom") {
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      params.set("preset", "custom");
    } else if (preset === "year") {
      params.set("preset", "year");
      params.set("year", year);
    } else {
      params.set("preset", preset);
    }
    return params.toString();
  }, [endDate, preset, startDate, year]);

  const analysisUrl = useMemo(() => `/api/analysis?${queryString}`, [queryString]);
  const { data, isLoading, isError, error } = useQuery<AnalysisResponse>({
    queryKey: [analysisUrl],
  });

  const exportUrl = useMemo(() => `/api/export/summary?${queryString}`, [queryString]);
  const ledgerUrl = useMemo(() => {
    if (!data?.range) {
      return "/transactions";
    }
    const params = new URLSearchParams({
      startDate: data.range.startDate,
      endDate: data.range.endDate,
    });
    return `/transactions?${params.toString()}`;
  }, [data?.range]);

  const leakUrl = useMemo(() => {
    if (!data?.range) {
      return "/leaks";
    }
    const params = new URLSearchParams({
      startDate: data.range.startDate,
      endDate: data.range.endDate,
    });
    return `/transactions?${params.toString()}&transactionClass=expense`;
  }, [data?.range]);

  const summary = data?.analysis.summary;
  const comparisons = data?.analysis.comparisons;
  const trend = data?.analysis.trend ?? [];
  const categories = data?.analysis.categoryBreakdown.slice(0, 6) ?? [];
  const leaks = data?.analysis.leakPreview ?? [];
  const hasCurrentRows = (data?.currentTransactionCount ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Advanced Analysis</h1>
          <p className="mt-1 text-muted-foreground">
            Explore longer history with explicit ranges, prior-period comparisons, and category trends.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.open(exportUrl, "_blank")}>
            <Download className="mr-2 h-4 w-4" />
            Export Summary
          </Button>
          <Link href={ledgerUrl}>
            <Button variant="outline">Open Filtered Ledger</Button>
          </Link>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle>Analysis Range</CardTitle>
          <CardDescription>Choose a preset, a specific year, or a custom date window.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Preset</p>
            <Select value={preset} onValueChange={(value) => setPreset(value as PresetValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="last30">Last 30 days</SelectItem>
                <SelectItem value="last60">Last 60 days</SelectItem>
                <SelectItem value="last90">Last 90 days</SelectItem>
                <SelectItem value="thisMonth">This month</SelectItem>
                <SelectItem value="lastMonth">Last month</SelectItem>
                <SelectItem value="quarterToDate">Quarter to date</SelectItem>
                <SelectItem value="yearToDate">Year to date</SelectItem>
                <SelectItem value="year">Specific year</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Year</p>
            <Input
              type="number"
              min="2020"
              max={String(currentYear)}
              value={year}
              disabled={preset !== "year"}
              onChange={(event) => setYear(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Start date</p>
            <Input
              type="date"
              value={startDate}
              disabled={preset !== "custom"}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">End date</p>
            <Input
              type="date"
              value={endDate}
              disabled={preset !== "custom"}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Range" value={data?.range.label ?? ""} isText loading={isLoading} />
        <SummaryCard label="Net Cashflow" value={summary?.netCashflow} loading={isLoading} />
        <SummaryCard label="Safe to Spend" value={summary?.safeToSpend} loading={isLoading} />
        <SummaryCard label="Recurring Confidence" value={`${data?.analysis.recurringConfidence ?? 0}%`} isText loading={isLoading} />
      </div>

      {isError && (
        <Card className="border-destructive/30 shadow-sm">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Analysis could not load for this range. {error instanceof Error ? error.message : "Unknown error."}
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && !hasCurrentRows && (
        <Card className="shadow-sm border-dashed">
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground">
              No transactions were found in the selected range. Try a broader preset, a different year, or a custom range.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <DeltaCard label="Inflows" metric={comparisons?.inflows} loading={isLoading} />
        <DeltaCard label="Outflows" metric={comparisons?.outflows} loading={isLoading} />
        <DeltaCard label="Net Cashflow" metric={comparisons?.netCashflow} loading={isLoading} />
        <DeltaCard label="Safe to Spend" metric={comparisons?.safeToSpend} loading={isLoading} />
        <DeltaCard label="Discretionary" metric={comparisons?.discretionarySpend} loading={isLoading} />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3 shadow-sm">
          <CardHeader>
            <CardTitle>Trend Over Time</CardTitle>
            <CardDescription>Monthly inflow, outflow, and net movement within the selected range.</CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="period" />
                  <YAxis />
                  <Tooltip formatter={(value: number) => fmt(value)} />
                  <Line type="monotone" dataKey="inflows" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="outflows" stroke="#ef4444" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="netCashflow" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Category Mix</CardTitle>
            <CardDescription>Top expense categories in the selected period.</CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categories} layout="vertical" margin={{ left: 16, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" hide />
                  <YAxis dataKey="category" type="category" width={110} tickFormatter={(value) => value.replace(/_/g, " ")} />
                  <Tooltip formatter={(value: number) => fmt(value)} />
                  <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Category Breakdown</CardTitle>
            <CardDescription>Monthly baselines and share of total expenses.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              [...Array(4)].map((_, index) => <Skeleton key={index} className="h-12 w-full" />)
            ) : !hasCurrentRows || categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expense categories in this range yet.</p>
            ) : (
              categories.map((category) => (
                <div key={category.category} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="font-medium capitalize">{category.category.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {category.occurrences} transactions · {category.share}% of expenses
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{fmt(category.amount)}</p>
                    <p className="text-xs text-muted-foreground">{fmt(category.monthlyBaseline)}/mo baseline</p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Leak Preview</CardTitle>
            <CardDescription>Top discretionary patterns inside the selected range.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              [...Array(3)].map((_, index) => <Skeleton key={index} className="h-16 w-full" />)
            ) : !hasCurrentRows || leaks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No leak-like patterns were flagged for this period.</p>
            ) : (
              leaks.map((leak) => (
                <div key={`${leak.merchant}-${leak.category}`} className="rounded-lg border p-3">
                  <p className="font-medium">{leak.merchant}</p>
                  <p className="text-xs text-muted-foreground">
                    {leak.label} · {leak.category.replace(/_/g, " ")}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span>{fmt(leak.monthlyAmount)}/mo</span>
                    <span className="font-semibold text-destructive">{fmt(leak.recentSpend)} in range</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Next Review Actions</CardTitle>
          <CardDescription>Jump directly into the same range in other surfaces.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href={ledgerUrl}>
            <Button variant="outline">
              Review Filtered Ledger
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <Link href={leakUrl}>
            <Button variant="outline">
              Review Expense Rows
              <TrendingUp className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  loading,
  isText = false,
}: {
  label: string;
  value?: number | string;
  loading: boolean;
  isText?: boolean;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className={isText ? "text-lg font-semibold" : "text-2xl font-bold"}>
            {typeof value === "number" ? fmt(value) : value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeltaCard({ label, metric, loading }: { label: string; metric?: MetricDelta; loading: boolean }) {
  const deltaValue = metric?.delta ?? 0;
  const deltaPct = metric?.deltaPct;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {loading ? (
          <>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-28" />
          </>
        ) : (
          <>
            <div className="text-xl font-bold">{fmt(metric?.current ?? 0)}</div>
            <p className="text-xs text-muted-foreground">
              Prior: {fmt(metric?.previous ?? 0)}
            </p>
            <p className={`text-xs font-medium ${deltaValue >= 0 ? "text-emerald-600" : "text-destructive"}`}>
              {deltaValue >= 0 ? "+" : ""}
              {fmt(deltaValue)}
              {deltaPct === null || deltaPct === undefined ? "" : ` (${deltaPct >= 0 ? "+" : ""}${deltaPct}%)`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
