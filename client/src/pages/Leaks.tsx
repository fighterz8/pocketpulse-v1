import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemo, useState } from "react";

interface LeakItem {
  merchant: string;
  merchantFilter: string;
  category: string;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  label: string;
  monthlyAmount: number;
  annualAmount: number;
  occurrences: number;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  recentSpend: number;
  transactionClass: "expense";
  recurrenceType?: "recurring" | "one-time";
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Leaks() {
  const [days, setDays] = useState(90);
  const leaksUrl = useMemo(() => `/api/leaks?days=${days}`, [days]);
  const { data: leaks = [], isLoading } = useQuery<LeakItem[]>({
    queryKey: [leaksUrl],
  });

  const totalAnnual = leaks.reduce((s, l) => s + l.annualAmount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Leak Detection</h1>
        <p className="text-muted-foreground mt-1">Identify discretionary and high-frequency spending patterns that may be avoidable.</p>
      </div>

      <div className="flex items-center gap-2 rounded-md border bg-background p-1 w-fit">
        {[30, 60, 90].map((windowDays) => (
          <Button
            key={windowDays}
            variant={days === windowDays ? "default" : "ghost"}
            size="sm"
            onClick={() => setDays(windowDays)}
            data-testid={`button-leak-window-${windowDays}`}
          >
            {windowDays}D
          </Button>
        ))}
      </div>

      <Card className="bg-orange-50/50 dark:bg-orange-950/10 border-warning/20">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <CardTitle>Potential Savings Identified</CardTitle>
          </div>
          <CardDescription>
            {leaks.length} discretionary spending pattern{leaks.length !== 1 ? "s" : ""} detected in the last {days} days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-10 w-48" />
          ) : (
            <>
              <div className="text-4xl font-bold text-foreground mt-2" data-testid="text-total-annual-savings">
                {fmt(totalAnnual)}
              </div>
              <p className="text-sm text-muted-foreground mt-1">Estimated annualized savings opportunity from flagged leak patterns</p>
            </>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : leaks.length === 0 ? (
        <Card className="shadow-sm border-dashed">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">No leak patterns detected in the selected time window.</p>
            <Link href="/upload">
              <Button>Upload CSV to analyze</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <h3 className="text-lg font-semibold mt-8 mb-4">Ranked by Annual Cost</h3>
          <div className="space-y-4">
            {leaks.map((leak, i) => (
              <Card key={i} className="overflow-hidden transition-all hover:shadow-md" data-testid={`card-leak-${i}`}>
                <div className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h4 className="font-bold text-lg">{leak.merchant}</h4>
                      <p className="text-sm text-muted-foreground">{leak.label} · {leak.occurrences} occurrence{leak.occurrences !== 1 ? "s" : ""}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="capitalize">{leak.category.replace(/_/g, " ")}</Badge>
                      <Badge variant="outline" className={
                        leak.confidence === "High" ? "bg-primary/10 text-primary border-primary/20" :
                        leak.confidence === "Medium" ? "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400" :
                        "bg-muted text-muted-foreground"
                      }>
                        {leak.confidence} Confidence
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground mb-1">Monthly</p>
                      <p className="font-semibold">{fmt(leak.monthlyAmount)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Annual Cost</p>
                      <p className="font-bold text-destructive">{fmt(leak.annualAmount)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Last Seen</p>
                      <p className="font-medium">{leak.lastDate}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Avg Ticket</p>
                      <p className="font-medium">{fmt(leak.averageAmount)}</p>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t">
                    <Link href={`/transactions?merchant=${encodeURIComponent(leak.merchantFilter)}&category=${encodeURIComponent(leak.category)}&transactionClass=${leak.transactionClass}&days=${days}${leak.recurrenceType ? `&recurrenceType=${leak.recurrenceType}` : ""}`}>
                      <Button variant="link" size="sm" className="px-0 text-xs text-muted-foreground hover:text-primary">
                        View related transactions <ArrowRight className="w-3 h-3 ml-1" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
