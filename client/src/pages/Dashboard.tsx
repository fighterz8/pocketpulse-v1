import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, ArrowDownRight, TrendingUp, AlertTriangle, RefreshCcw, Download } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

interface CashflowSummary {
  totalInflows: number;
  totalOutflows: number;
  recurringIncome: number;
  recurringExpenses: number;
  oneTimeIncome: number;
  oneTimeExpenses: number;
  safeToSpend: number;
  netCashflow: number;
}

interface LeakItem {
  merchant: string;
  monthlyAmount: number;
  annualAmount: number;
  occurrences: number;
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Dashboard() {
  const { data: cashflow, isLoading: cfLoading } = useQuery<CashflowSummary>({
    queryKey: ["/api/cashflow"],
  });

  const { data: leaks } = useQuery<LeakItem[]>({
    queryKey: ["/api/leaks"],
  });

  const totalLeakMonthly = leaks?.reduce((s, l) => s + l.monthlyAmount, 0) ?? 0;

  const handleExport = () => {
    window.open("/api/export/summary", "_blank");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Financial overview and cashflow estimates.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExport} data-testid="button-export">
            <Download className="mr-2 h-4 w-4" />
            Export Report
          </Button>
        </div>
      </div>

      {/* Primary KPI */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 border-primary/20 shadow-sm">
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
              <span className="flex items-center font-medium bg-primary/10 text-primary px-2 py-0.5 rounded mr-2">
                <TrendingUp className="mr-1 h-3 w-3" />
                Net: {fmt(cashflow?.netCashflow ?? 0)}
              </span>
              Based on recurring income minus recurring expenses.
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
        <SummaryCard label="Total Inflows" value={cashflow?.totalInflows} icon={<ArrowUpRight className="h-4 w-4 text-emerald-500" />} loading={cfLoading} testId="text-total-inflows" />
        <SummaryCard label="Total Outflows" value={cashflow?.totalOutflows} icon={<ArrowDownRight className="h-4 w-4 text-destructive" />} loading={cfLoading} testId="text-total-outflows" />
        <SummaryCard label="Recurring Income" value={cashflow?.recurringIncome} icon={<RefreshCcw className="h-4 w-4 text-emerald-500 opacity-70" />} loading={cfLoading} sub="Baseline" testId="text-recurring-income" />
        <SummaryCard label="Recurring Expenses" value={cashflow?.recurringExpenses} icon={<RefreshCcw className="h-4 w-4 text-destructive opacity-70" />} loading={cfLoading} sub="Baseline" testId="text-recurring-expenses" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SummaryCard label="One-time Income" value={cashflow?.oneTimeIncome} icon={<ArrowUpRight className="h-4 w-4 text-emerald-500" />} loading={cfLoading} testId="text-onetime-income" />
        <SummaryCard label="One-time Expenses" value={cashflow?.oneTimeExpenses} icon={<ArrowDownRight className="h-4 w-4 text-destructive" />} loading={cfLoading} testId="text-onetime-expenses" />
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

function SummaryCard({ label, value, icon, loading, sub, testId }: { label: string; value?: number; icon: React.ReactNode; loading: boolean; sub?: string; testId: string }) {
  return (
    <Card className="shadow-sm">
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
