import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Search, Sparkles, Check, ArrowDownRight, ArrowUpRight, Clock, CalendarDays, Download, Layers, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  category: string;
  aiAssisted: boolean;
  userCorrected: boolean;
  accountId: number;
}

interface Account {
  id: number;
  name: string;
  lastFour: string | null;
}

interface TransactionPage {
  rows: Transaction[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const CATEGORY_OPTIONS = [
  "income",
  "transfers",
  "utilities",
  "subscriptions",
  "insurance",
  "housing",
  "groceries",
  "transportation",
  "dining",
  "shopping",
  "health",
  "debt",
  "business_software",
  "entertainment",
  "fees",
  "other",
];

function getVisiblePages(currentPage: number, totalPages: number): Array<number | "ellipsis-left" | "ellipsis-right"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis-right", totalPages];
  }

  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis-left", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "ellipsis-left", currentPage - 1, currentPage, currentPage + 1, "ellipsis-right", totalPages];
}

function TransactionTable({ transactions, updateMutation }: { transactions: Transaction[]; updateMutation: any }) {
  if (transactions.length === 0) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        No transactions in this account yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow>
            <TableHead className="w-[100px]">Date</TableHead>
            <TableHead className="w-[200px]">Merchant / Desc</TableHead>
            <TableHead className="w-[120px] text-right">Amount</TableHead>
            <TableHead className="w-[140px]">Classification</TableHead>
            <TableHead className="w-[150px]">Category</TableHead>
            <TableHead className="w-[140px]">Recurrence</TableHead>
            <TableHead className="w-[80px] text-right">Confirm</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((tx) => (
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
                  defaultValue={tx.category}
                  onValueChange={(val) => updateMutation.mutate({ id: tx.id, data: { category: val } })}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid={`select-category-${tx.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
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
                    onClick={() => updateMutation.mutate({ id: tx.id, data: { transactionClass: tx.transactionClass, recurrenceType: tx.recurrenceType, category: tx.category } })}
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
  );
}

export default function Ledger() {
  const { toast } = useToast();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [searchTerm, setSearchTerm] = useState(initialParams.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(initialParams.get("search") ?? "");
  const [activeTab, setActiveTab] = useState(initialParams.get("accountId") ?? "all");
  const [page, setPage] = useState(parseInt(initialParams.get("page") || "1", 10) || 1);
  const [categoryFilter, setCategoryFilter] = useState(initialParams.get("category") ?? "all");
  const pageSize = 50;
  const merchantFilter = initialParams.get("merchant") ?? "";
  const transactionClassFilter = initialParams.get("transactionClass") ?? "";
  const recurrenceTypeFilter = initialParams.get("recurrenceType") ?? "";
  const daysFilter = initialParams.get("days") ?? "";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, activeTab, categoryFilter]);

  const transactionUrl = useMemo(() => {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });

    if (debouncedSearch) {
      params.set("search", debouncedSearch);
    }

    if (activeTab !== "all") {
      params.set("accountId", activeTab);
    }

    if (categoryFilter !== "all") {
      params.set("category", categoryFilter);
    }

    if (merchantFilter) {
      params.set("merchant", merchantFilter);
    }

    if (transactionClassFilter) {
      params.set("transactionClass", transactionClassFilter);
    }

    if (recurrenceTypeFilter) {
      params.set("recurrenceType", recurrenceTypeFilter);
    }

    if (daysFilter) {
      params.set("days", daysFilter);
    }

    return `/api/transactions?${params.toString()}`;
  }, [activeTab, categoryFilter, debouncedSearch, daysFilter, merchantFilter, page, recurrenceTypeFilter, transactionClassFilter]);

  const { data: transactionPage, isLoading } = useQuery<TransactionPage>({
    queryKey: [transactionUrl],
  });

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ["/api/accounts"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await apiRequest("PATCH", `/api/transactions/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/transactions"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/cashflow"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/leaks"),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const wipeDataMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/transactions");
      return res.json() as Promise<{ deletedTransactions: number; deletedUploads: number }>;
    },
    onSuccess: (data) => {
      setPage(1);
      setSearchTerm("");
      setDebouncedSearch("");
      setActiveTab("all");
      setCategoryFilter("all");
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/transactions"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/cashflow"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/leaks"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      toast({
        title: "Imported data wiped",
        description: `Deleted ${data.deletedTransactions} transactions and ${data.deletedUploads} uploads.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Wipe failed", description: err.message, variant: "destructive" });
    },
  });

  const wipeWorkspaceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/workspace-data");
      return res.json() as Promise<{ deletedTransactions: number; deletedUploads: number; deletedAccounts: number }>;
    },
    onSuccess: (data) => {
      setPage(1);
      setSearchTerm("");
      setDebouncedSearch("");
      setActiveTab("all");
      setCategoryFilter("all");
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/transactions"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/cashflow"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/leaks"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      toast({
        title: "Workspace reset",
        description: `Deleted ${data.deletedTransactions} transactions, ${data.deletedUploads} uploads, and ${data.deletedAccounts} accounts.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  const transactions = transactionPage?.rows ?? [];
  const totalCount = transactionPage?.totalCount ?? 0;
  const totalPages = transactionPage?.totalPages ?? 1;
  const visiblePages = getVisiblePages(page, totalPages);
  const firstRowNumber = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRowNumber = totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount);

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
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-wipe-imported-data">
                <Trash2 className="mr-2 h-4 w-4" />
                Wipe Data
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Wipe imported data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all imported transactions and upload records for your account.
                  Your login and saved accounts will stay in place so you can immediately re-test imports.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => wipeDataMutation.mutate()}
                  data-testid="button-confirm-wipe-imported-data"
                >
                  {wipeDataMutation.isPending ? "Wiping..." : "Wipe imported data"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-reset-workspace">
                <Trash2 className="mr-2 h-4 w-4" />
                Reset Workspace
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset the entire workspace?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all imported transactions, upload history, and saved accounts for your account.
                  Your login will remain so you can start fresh and test the new importer end to end.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => wipeWorkspaceMutation.mutate()}
                  data-testid="button-confirm-reset-workspace"
                >
                  {wipeWorkspaceMutation.isPending ? "Resetting..." : "Reset workspace"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full sm:w-[220px]" data-testid="select-ledger-category-filter">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORY_OPTIONS.map((category) => (
                <SelectItem key={category} value={category}>
                  {category.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(merchantFilter || transactionClassFilter || recurrenceTypeFilter || daysFilter || categoryFilter !== "all") && (
          <div className="px-4 py-3 border-b bg-muted/5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium">Active filters:</span>
            {merchantFilter && <Badge variant="secondary">Merchant: {merchantFilter}</Badge>}
            {transactionClassFilter && <Badge variant="secondary">Class: {transactionClassFilter}</Badge>}
            {recurrenceTypeFilter && <Badge variant="secondary">Recurrence: {recurrenceTypeFilter}</Badge>}
            {daysFilter && <Badge variant="secondary">Window: {daysFilter}D</Badge>}
            {categoryFilter !== "all" && <Badge variant="secondary">Category: {categoryFilter.replace(/_/g, " ")}</Badge>}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                window.location.href = "/transactions";
              }}
              data-testid="button-clear-ledger-filters"
            >
              Clear filters
            </Button>
          </div>
        )}

        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="px-4 pt-3 border-b bg-muted/5">
              <TabsList className="bg-transparent h-auto p-0 gap-0">
                <TabsTrigger
                  value="all"
                  className="rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 pb-3 pt-2"
                  data-testid="tab-all-accounts"
                >
                  <Layers className="w-4 h-4 mr-2" />
                  All Accounts
                </TabsTrigger>
                {accounts.map((acc) => (
                  <TabsTrigger
                    key={acc.id}
                    value={acc.id.toString()}
                    className="rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 pb-3 pt-2"
                    data-testid={`tab-account-${acc.id}`}
                  >
                    {acc.name}
                    {acc.lastFour && <span className="text-muted-foreground ml-1">...{acc.lastFour}</span>}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value={activeTab} className="mt-0">
              {transactions.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground">
                  {totalCount === 0 ? "No matching transactions found." : "No transactions on this page."}
                </div>
              ) : (
                <TransactionTable transactions={transactions} updateMutation={updateMutation} />
              )}
            </TabsContent>
          </Tabs>
        )}

        <div className="p-4 border-t flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between text-sm text-muted-foreground bg-muted/10">
          <div data-testid="text-transaction-count">
            Showing {firstRowNumber}-{lastRowNumber} of {totalCount} transactions. Page {page} of {totalPages}.
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page <= 1}
              data-testid="button-page-prev"
            >
              Previous
            </Button>
            {visiblePages.map((visiblePage) => (
              typeof visiblePage === "number" ? (
                <Button
                  key={visiblePage}
                  variant={visiblePage === page ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPage(visiblePage)}
                  data-testid={`button-page-${visiblePage}`}
                >
                  {visiblePage}
                </Button>
              ) : (
                <span key={visiblePage} className="px-2 text-muted-foreground">
                  ...
                </span>
              )
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page >= totalPages}
              data-testid="button-page-next"
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
