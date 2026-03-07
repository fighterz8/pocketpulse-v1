import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Sparkles, Check, ArrowDownRight, ArrowUpRight, Clock, CalendarDays, Download } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

interface Transaction {
  id: number;
  date: string;
  rawDescription: string;
  merchant: string;
  amount: string;
  flowType: string;
  transactionClass: string;
  recurrenceType: string;
  aiAssisted: boolean;
  userCorrected: boolean;
}

export default function Ledger() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [flowFilter, setFlowFilter] = useState("all");

  const { data: transactions = [], isLoading } = useQuery<Transaction[]>({
    queryKey: ["/api/transactions"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await apiRequest("PATCH", `/api/transactions/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaks"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const filtered = transactions.filter((tx) => {
    const matchesSearch = searchTerm === "" ||
      tx.merchant.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.rawDescription.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFlow = flowFilter === "all" || tx.flowType === flowFilter;
    return matchesSearch && matchesFlow;
  });

  const handleExportTransactions = () => {
    window.open("/api/export/transactions", "_blank");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Unified Ledger</h1>
          <p className="text-muted-foreground mt-1">Review and correct transaction classifications.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 px-3 py-1 text-xs">
            <Sparkles className="w-3 h-3 mr-1" />
            Auto-classified
          </Badge>
          <Button variant="outline" size="sm" onClick={handleExportTransactions} data-testid="button-export-transactions">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <div className="p-4 border-b flex flex-col sm:flex-row gap-4 items-center justify-between bg-muted/10">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search merchants or descriptions..."
              className="pl-9"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              data-testid="input-search"
            />
          </div>
          <Select value={flowFilter} onValueChange={setFlowFilter}>
            <SelectTrigger className="w-[130px]" data-testid="select-flow-filter">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="inflow">Inflows</SelectItem>
              <SelectItem value="outflow">Outflows</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            {transactions.length === 0 ? "No transactions yet. Upload a CSV to get started." : "No matching transactions found."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="w-[100px]">Date</TableHead>
                  <TableHead className="w-[200px]">Merchant / Desc</TableHead>
                  <TableHead className="w-[120px] text-right">Amount</TableHead>
                  <TableHead className="w-[140px]">Classification</TableHead>
                  <TableHead className="w-[140px]">Recurrence</TableHead>
                  <TableHead className="w-[80px] text-right">Confirm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((tx) => (
                  <TableRow key={tx.id} className="group hover:bg-muted/10">
                    <TableCell className="font-medium text-xs whitespace-nowrap">{tx.date}</TableCell>
                    <TableCell>
                      <div className="font-medium text-sm flex items-center">
                        {tx.merchant}
                        {tx.aiAssisted && !tx.userCorrected && (
                          <span title="AI Classified"><Sparkles className="w-3 h-3 ml-1.5 text-primary opacity-70" /></span>
                        )}
                        {tx.userCorrected && (
                          <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0 h-4">Manual</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px] mt-0.5" title={tx.rawDescription}>
                        {tx.rawDescription}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className={`font-semibold ${tx.flowType === "inflow" ? "text-emerald-600" : ""}`}>
                        {tx.flowType === "inflow" ? "+" : ""}
                        {parseFloat(tx.amount).toLocaleString("en-US", { style: "currency", currency: "USD" })}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        defaultValue={tx.transactionClass}
                        onValueChange={(val) => updateMutation.mutate({ id: tx.id, data: { transactionClass: val } })}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-class-${tx.id}`}>
                          <div className="flex items-center gap-1.5">
                            {tx.transactionClass === "income" ? <ArrowUpRight className="w-3 h-3 text-emerald-500" /> :
                             tx.transactionClass === "expense" ? <ArrowDownRight className="w-3 h-3 text-destructive" /> : null}
                            <SelectValue />
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="income">Income</SelectItem>
                          <SelectItem value="expense">Expense</SelectItem>
                          <SelectItem value="transfer">Transfer</SelectItem>
                          <SelectItem value="refund">Refund</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        defaultValue={tx.recurrenceType}
                        onValueChange={(val) => updateMutation.mutate({ id: tx.id, data: { recurrenceType: val } })}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-recurrence-${tx.id}`}>
                          <div className="flex items-center gap-1.5">
                            {tx.recurrenceType === "recurring" ? <Clock className="w-3 h-3 text-primary" /> :
                             <CalendarDays className="w-3 h-3 text-muted-foreground" />}
                            <SelectValue />
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="recurring">Recurring</SelectItem>
                          <SelectItem value="one-time">One-time</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10 rounded-full"
                          title="Confirm classification"
                          onClick={() => updateMutation.mutate({ id: tx.id, data: { transactionClass: tx.transactionClass, recurrenceType: tx.recurrenceType } })}
                          data-testid={`button-confirm-${tx.id}`}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="p-4 border-t flex items-center justify-between text-sm text-muted-foreground bg-muted/10">
          <div data-testid="text-transaction-count">Showing {filtered.length} of {transactions.length} transactions</div>
        </div>
      </Card>
    </div>
  );
}
