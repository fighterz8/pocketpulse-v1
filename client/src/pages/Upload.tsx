import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Upload as UploadIcon, FileText, CheckCircle2, AlertCircle, Plus } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, readApiErrorMessage } from "@/lib/queryClient";

interface Account {
  id: number;
  name: string;
  lastFour: string | null;
}

export default function UploadPage() {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountLastFour, setNewAccountLastFour] = useState("");
  const [uploadResult, setUploadResult] = useState<{ transactionCount: number; filename: string } | null>(null);

  const { data: accounts = [], isLoading: accountsLoading } = useQuery<Account[]>({
    queryKey: ["/api/accounts"],
  });

  useEffect(() => {
    if (!selectedAccount) {
      return;
    }

    const stillExists = accounts.some((account) => account.id.toString() === selectedAccount);
    if (!stillExists) {
      setSelectedAccount("");
    }
  }, [accounts, selectedAccount]);

  const createAccountMutation = useMutation({
    mutationFn: async (data: { name: string; lastFour?: string }) => {
      const res = await apiRequest("POST", "/api/accounts", data);
      return res.json();
    },
    onSuccess: (newAccount: Account) => {
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      setSelectedAccount(newAccount.id.toString());
      setShowNewAccount(false);
      setNewAccountName("");
      setNewAccountLastFour("");
      toast({ title: "Account created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create account", description: err.message, variant: "destructive" });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res));
      }
      return res.json();
    },
    onSuccess: (data) => {
      setUploadResult(data);
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/transactions"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/cashflow"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/leaks"),
      });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/analysis"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      toast({ title: "Upload complete", description: `${data.transactionCount} transactions imported.` });
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      const f = e.dataTransfer.files[0];
      if (f.name.endsWith(".csv")) {
        setFile(f);
        setUploadResult(null);
      }
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      setFile(e.target.files[0]);
      setUploadResult(null);
    }
  };

  const handleUpload = () => {
    if (!file || !selectedAccount) return;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("accountId", selectedAccount);
    uploadMutation.mutate(formData);
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Upload Data</h1>
        <p className="text-muted-foreground mt-1">Import transactions via CSV from your bank or accounting software.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>File Import</CardTitle>
          <CardDescription>
            We support standard CSV exports. The system will automatically detect date, amount, and description fields.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="account-select">Target Account</Label>
            <div className="flex gap-2">
              <Select value={selectedAccount} onValueChange={(v) => {
                if (v === "__new__") {
                  setShowNewAccount(true);
                } else {
                  setSelectedAccount(v);
                }
              }}>
                <SelectTrigger id="account-select" className="flex-1" data-testid="select-account">
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id.toString()}>
                      {acc.name}{acc.lastFour ? ` (...${acc.lastFour})` : ""}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">
                    <span className="flex items-center gap-1"><Plus className="w-3 h-3" /> Add New Account</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div
            className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center text-center transition-colors
              ${uploadResult ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-muted-foreground/25 bg-muted/30 hover:bg-muted/50'}
            `}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            {uploadResult ? (
              <div className="space-y-3 flex flex-col items-center">
                <div className="h-16 w-16 bg-emerald-500/20 rounded-full flex items-center justify-center mb-2">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                </div>
                <h3 className="font-semibold text-lg">Upload Complete</h3>
                <p className="text-sm text-muted-foreground max-w-xs" data-testid="text-upload-result">
                  Successfully imported {uploadResult.transactionCount} transactions from {uploadResult.filename}.
                </p>
              </div>
            ) : file ? (
              <div className="space-y-4 w-full max-w-md mx-auto">
                <div className="flex items-center gap-3 p-4 bg-background rounded-lg border shadow-sm">
                  <div className="h-10 w-10 bg-primary/10 rounded flex items-center justify-center shrink-0">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1 text-left overflow-hidden">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                  {!uploadMutation.isPending && (
                    <Button variant="ghost" size="sm" onClick={() => setFile(null)} className="h-8 text-muted-foreground hover:text-destructive shrink-0">
                      Remove
                    </Button>
                  )}
                </div>
                {uploadMutation.isPending && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground font-medium">
                      <span>Parsing data...</span>
                    </div>
                    <Progress value={50} className="h-2 animate-pulse" />
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 flex flex-col items-center">
                <div className="h-16 w-16 bg-muted rounded-full flex items-center justify-center mb-2">
                  <UploadIcon className="h-8 w-8 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">Drag & drop your CSV</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
                    or click to browse files from your computer. Max file size 10MB.
                  </p>
                </div>
                <div className="mt-4">
                  <Input type="file" accept=".csv" className="hidden" id="file-upload" onChange={handleFileChange} />
                  <Label
                    htmlFor="file-upload"
                    className="inline-flex h-10 items-center justify-center rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 cursor-pointer transition-colors"
                    data-testid="button-select-file"
                  >
                    Select File
                  </Label>
                </div>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="bg-muted/30 border-t justify-between items-center py-4">
          <p className="text-xs text-muted-foreground flex items-center">
            <AlertCircle className="h-3 w-3 mr-1" />
            Classification runs automatically on import.
          </p>
          {uploadResult ? (
            <Button data-testid="button-view-ledger" onClick={() => window.location.href = "/transactions"}>
              Review Transactions
            </Button>
          ) : (
            <Button
              onClick={handleUpload}
              disabled={!file || !selectedAccount || uploadMutation.isPending}
              data-testid="button-process-upload"
            >
              {uploadMutation.isPending ? "Processing..." : "Process Upload"}
            </Button>
          )}
        </CardFooter>
      </Card>

      <Dialog open={showNewAccount} onOpenChange={setShowNewAccount}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Account Name</Label>
              <Input placeholder="Main Checking" value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} data-testid="input-account-name" />
            </div>
            <div className="space-y-2">
              <Label>Last 4 Digits (optional)</Label>
              <Input placeholder="4589" maxLength={4} value={newAccountLastFour} onChange={(e) => setNewAccountLastFour(e.target.value)} data-testid="input-account-last-four" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewAccount(false)}>Cancel</Button>
            <Button
              onClick={() => createAccountMutation.mutate({ name: newAccountName, lastFour: newAccountLastFour || undefined })}
              disabled={!newAccountName || createAccountMutation.isPending}
              data-testid="button-create-account"
            >
              {createAccountMutation.isPending ? "Creating..." : "Create Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
