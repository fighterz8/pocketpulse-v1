import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { useAuth } from "../hooks/use-auth";
import { Hint } from "../components/ui/tooltip";
import {
  useTransactions,
  type Transaction,
  type TransactionFilters,
  type UpdateTransactionInput,
} from "../hooks/use-transactions";
import { useAiEnhancementStatus } from "../hooks/use-ai-enhancement-status";
import { V1_CATEGORIES } from "../../../shared/schema";

const CLASS_OPTIONS = ["income", "expense", "transfer", "refund"] as const;
const RECURRENCE_OPTIONS = ["recurring", "one-time"] as const;

function formatAmount(amount: string, txnClass: string): string {
  const n = parseFloat(amount);
  const abs = Math.abs(n).toFixed(2);
  if (txnClass === "expense") return `-$${abs}`;
  if (txnClass === "income" || txnClass === "refund") return `$${abs}`;
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function amountColorClass(txnClass: string): string {
  if (txnClass === "income" || txnClass === "refund") return "ledger-amount--inflow";
  if (txnClass === "expense") return "ledger-amount--outflow";
  return "";
}

function currency(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function Ledger() {
  const { accounts } = useAuth();
  const [location] = useLocation();

  // Initialise filters from URL search params so dashboard cards can deep-link here.
  // The useState initialiser handles fresh mounts; the useEffect handles the case
  // where the component is already mounted and location changes (e.g. browser back/fwd).
  const filtersFromUrl = (): TransactionFilters => {
    const p = new URLSearchParams(window.location.search);
    const excludedParam = p.get("excluded");
    return {
      page: 1,
      limit: 50,
      search: p.get("search") ?? undefined,
      category: p.get("category") ?? undefined,
      transactionClass: p.get("transactionClass") ?? undefined,
      recurrenceType: p.get("recurrenceType") ?? undefined,
      dateFrom: p.get("dateFrom") ?? undefined,
      dateTo: p.get("dateTo") ?? undefined,
      excluded: (excludedParam === "true" || excludedParam === "false" || excludedParam === "all")
        ? (excludedParam as "true" | "false" | "all")
        : undefined,
    };
  };

  const searchFromUrl = (): string =>
    new URLSearchParams(window.location.search).get("search") ?? "";

  const [filters, setFilters] = useState<TransactionFilters>(filtersFromUrl);

  // Re-sync when the route changes (e.g. clicking a dashboard card while already on /transactions)
  useEffect(() => {
    setFilters(filtersFromUrl());
    setSearchInput(searchFromUrl());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const [searchInput, setSearchInput] = useState(searchFromUrl);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value || undefined, page: 1 }));
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const setFilter = (key: keyof TransactionFilters, value: string | number | undefined) => {
    setFilters((f) => ({ ...f, [key]: value || undefined, page: 1 }));
  };

  const [editingId, setEditingId] = useState<number | null>(null);

  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  // Propagation notice: shown briefly after a correction is auto-applied to
  // same-merchant transactions.
  const [propagationNotice, setPropagationNotice] = useState<{ merchant: string; count: number } | null>(null);
  const propagationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showPropagationNotice = (merchant: string, count: number) => {
    if (count <= 0) return;
    if (propagationTimerRef.current) clearTimeout(propagationTimerRef.current);
    setPropagationNotice({ merchant, count });
    propagationTimerRef.current = setTimeout(() => setPropagationNotice(null), 5000);
  };

  // While the async AI worker is enhancing rows for any of this user's
  // recent uploads, refetch the ledger every 5s so newly-AI'd categories
  // appear without a manual reload. The hook short-circuits to no
  // polling the moment nothing is active, so idle users are unaffected.
  const { anyActive: hasActiveAiEnhancement } = useAiEnhancementStatus();

  const {
    transactions,
    pagination,
    totals,
    isLoading,
    error,
    updateTransaction,
    wipeData,
    resetWorkspace,
  } = useTransactions(filters, {
    refetchInterval: hasActiveAiEnhancement ? 5000 : false,
  });

  const setPage = (p: number) => setFilters((f) => ({ ...f, page: p }));

  const handleRowClick = (id: number) => {
    setEditingId((prev) => (prev === id ? null : id));
  };

  const hasAnyFilter = !!(
    filters.search || filters.category || filters.transactionClass ||
    filters.recurrenceType || filters.dateFrom || filters.dateTo ||
    filters.accountId
  );

  const clearFilters = () => {
    setSearchInput("");
    setFilters({ page: 1, limit: 50 });
  };

  // Clean up propagation notice timer on unmount.
  useEffect(() => {
    return () => {
      if (propagationTimerRef.current) clearTimeout(propagationTimerRef.current);
    };
  }, []);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (filters.search)          params.set("search", filters.search);
    if (filters.category)        params.set("category", filters.category);
    if (filters.transactionClass) params.set("transactionClass", filters.transactionClass);
    if (filters.recurrenceType)  params.set("recurrenceType", filters.recurrenceType);
    if (filters.dateFrom)        params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo)          params.set("dateTo", filters.dateTo);
    if (filters.accountId)       params.set("accountId", String(filters.accountId));
    const url = `/api/transactions/export?${params.toString()}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <>
      <motion.h1
        className="app-page-title"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <svg className="page-title-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="14" height="14" rx="1.5" />
          <line x1="3" y1="7.5" x2="17" y2="7.5" />
          <line x1="3" y1="12" x2="17" y2="12" />
          <line x1="8" y1="7.5" x2="8" y2="17" />
        </svg>
        Ledger
      </motion.h1>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.07 }}
        className="glass-card mb-4"
      >
      <div className="ledger-filters">
        <div className="ledger-search-row">
          <input
            type="text"
            className="ledger-search-input"
            placeholder="Search merchant or description..."
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {hasAnyFilter && (
            <button className="ledger-clear-btn" onClick={clearFilters}>
              Clear filters
            </button>
          )}
          <Hint
            content="Download the rows currently shown (with your filters applied) as a CSV."
            data-testid="hint-export-csv"
          >
            <button
              className="ledger-export-btn"
              onClick={handleExport}
              data-testid="btn-export-csv"
            >
              Export CSV
            </button>
          </Hint>
        </div>

        <div className="ledger-filter-bar">
          {accounts && accounts.length > 0 && (
            <select
              className="ledger-filter-select"
              value={filters.accountId ?? ""}
              onChange={(e) => setFilter("accountId", e.target.value ? parseInt(e.target.value) : undefined)}
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label}{a.lastFour ? ` (...${a.lastFour})` : ""}</option>
              ))}
            </select>
          )}

          <select
            className="ledger-filter-select"
            value={filters.category ?? ""}
            onChange={(e) => setFilter("category", e.target.value)}
          >
            <option value="">All categories</option>
            {V1_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
            ))}
          </select>

          <select
            className="ledger-filter-select"
            value={filters.transactionClass ?? ""}
            onChange={(e) => setFilter("transactionClass", e.target.value)}
          >
            <option value="">All classes</option>
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            className="ledger-filter-select"
            value={filters.recurrenceType ?? ""}
            onChange={(e) => setFilter("recurrenceType", e.target.value)}
          >
            <option value="">All recurrence</option>
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>

          <div className="ledger-date-range">
            <input
              type="date"
              className="ledger-date-input"
              value={filters.dateFrom ?? ""}
              onChange={(e) => setFilter("dateFrom", e.target.value)}
              aria-label="From date"
            />
            <span className="ledger-date-sep">to</span>
            <input
              type="date"
              className="ledger-date-input"
              value={filters.dateTo ?? ""}
              onChange={(e) => setFilter("dateTo", e.target.value)}
              aria-label="To date"
            />
          </div>
        </div>
      </div>
      </motion.div>

      {error && <p className="ledger-error">{error.message}</p>}

      {isLoading && transactions.length === 0 && (
        <p className="ledger-loading">Loading transactions...</p>
      )}

      {!isLoading && transactions.length === 0 && !error && (
        <div className="ledger-empty glass-card">
          <p className="ledger-empty-text">
            {hasAnyFilter ? "No transactions match your filters." : "No transactions yet."}
          </p>
          <p className="ledger-empty-hint">
            {hasAnyFilter ? "Try adjusting or clearing your filters." : "Upload CSV statements to get started."}
          </p>
        </div>
      )}

      {transactions.length > 0 && (
        <>
          <motion.div
            className="ledger-table-wrap glass-card"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.21 }}
          >
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Merchant</th>
                  <th className="ledger-th-right">Amount</th>
                  <th>Category</th>
                  <th>Class</th>
                  <th>Recurrence</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((txn) => (
                  <TransactionRow
                    key={txn.id}
                    txn={txn}
                    isEditing={editingId === txn.id}
                    onRowClick={() => handleRowClick(txn.id)}
                    onQuickUpdate={(fields) => {
                      updateTransaction.mutate(
                        { id: txn.id, fields },
                        {
                          onSuccess: (data) => {
                            if (data.propagated > 0) {
                              showPropagationNotice(txn.merchant, data.propagated);
                            }
                          },
                        },
                      );
                    }}
                    onSave={(fields) => {
                      updateTransaction.mutate(
                        { id: txn.id, fields },
                        {
                          onSuccess: (data) => {
                            setEditingId(null);
                            if (data.propagated > 0) {
                              showPropagationNotice(txn.merchant, data.propagated);
                            }
                          },
                        },
                      );
                    }}
                    onCancel={() => setEditingId(null)}
                    isSaving={updateTransaction.isPending}
                  />
                ))}
              </tbody>
            </table>
          </motion.div>

          {pagination && pagination.totalPages > 1 && (
            <div className="ledger-pagination">
              <button
                className="ledger-pagination-btn"
                disabled={pagination.page <= 1}
                onClick={() => setPage(pagination.page - 1)}
              >
                Previous
              </button>
              <span className="ledger-pagination-info">
                Page {pagination.page} of {pagination.totalPages}
                {" "}({pagination.total} total)
              </span>
              <button
                className="ledger-pagination-btn"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => setPage(pagination.page + 1)}
              >
                Next
              </button>
            </div>
          )}

          {pagination && totals && (
            <div className="ledger-totals-bar" data-testid="ledger-totals-bar">
              <span className="ledger-totals-count">
                {pagination.total} transaction{pagination.total !== 1 ? "s" : ""}
              </span>
              <span className="ledger-totals-divider" aria-hidden="true">·</span>
              {totals.totalInflow > 0 && (
                <span className="ledger-totals-item ledger-totals-item--inflow" data-testid="ledger-total-inflow">
                  <span className="ledger-totals-label">Income</span>
                  <span className="ledger-totals-value">{currency(totals.totalInflow)}</span>
                </span>
              )}
              {totals.totalInflow > 0 && totals.totalOutflow > 0 && (
                <span className="ledger-totals-divider" aria-hidden="true">·</span>
              )}
              {totals.totalOutflow > 0 && (
                <span className="ledger-totals-item ledger-totals-item--outflow" data-testid="ledger-total-outflow">
                  <span className="ledger-totals-label">Expenses</span>
                  <span className="ledger-totals-value">{currency(totals.totalOutflow)}</span>
                </span>
              )}
              {totals.totalRefund > 0 && (
                <>
                  <span className="ledger-totals-divider" aria-hidden="true">·</span>
                  <span className="ledger-totals-item ledger-totals-item--inflow" data-testid="ledger-total-refund">
                    <span className="ledger-totals-label">Refunds</span>
                    <span className="ledger-totals-value">{currency(totals.totalRefund)}</span>
                  </span>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Danger zone */}
      <div className="ledger-danger-zone glass-card">
        <h3 className="ledger-danger-title">Data Management</h3>
        <div className="ledger-danger-actions">
          {!wipeConfirm ? (
            <Hint
              content="Permanent. Deletes all imported transactions but keeps your accounts. Export a CSV first if you want a backup."
              data-testid="hint-wipe-data"
            >
              <button
                className="ledger-danger-btn ledger-danger-btn--warn"
                onClick={() => setWipeConfirm(true)}
                disabled={wipeData.isPending || resetWorkspace.isPending}
                data-testid="btn-wipe-data"
              >
                Wipe Imported Data
              </button>
            </Hint>
          ) : (
            <div className="ledger-danger-confirm">
              <p className="ledger-danger-msg">
                This will permanently delete all transactions and uploads. Your accounts will be kept.
              </p>
              <p className="ledger-danger-msg ledger-danger-msg--note">
                Tip: when you re-upload, overlapping bank statement exports (e.g. month-end and month-start statements from the same bank) may contain duplicate rows — these are automatically skipped and reported separately in the import summary.
              </p>
              <div className="ledger-danger-confirm-actions">
                <button
                  className="ledger-danger-btn ledger-danger-btn--destructive"
                  onClick={() => {
                    wipeData.mutate(undefined, {
                      onSuccess: () => setWipeConfirm(false),
                    });
                  }}
                  disabled={wipeData.isPending}
                >
                  {wipeData.isPending ? "Wiping..." : "Confirm Wipe"}
                </button>
                <button
                  className="ledger-danger-btn ledger-danger-btn--cancel"
                  onClick={() => setWipeConfirm(false)}
                  disabled={wipeData.isPending}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!resetConfirm ? (
            <Hint
              content="Permanent. Deletes everything including your accounts — you'll need to set up your accounts again. Export a CSV first if you want a backup."
              data-testid="hint-reset-workspace"
            >
              <button
                className="ledger-danger-btn ledger-danger-btn--warn"
                onClick={() => setResetConfirm(true)}
                disabled={wipeData.isPending || resetWorkspace.isPending}
                data-testid="btn-reset-workspace"
              >
                Reset Workspace
              </button>
            </Hint>
          ) : (
            <div className="ledger-danger-confirm">
              <p className="ledger-danger-msg">
                This will permanently delete all transactions, uploads, and accounts. You will need to set up accounts again.
              </p>
              <div className="ledger-danger-confirm-actions">
                <button
                  className="ledger-danger-btn ledger-danger-btn--destructive"
                  onClick={() => {
                    resetWorkspace.mutate(undefined, {
                      onSuccess: () => {
                        setResetConfirm(false);
                        window.location.href = "/";
                      },
                    });
                  }}
                  disabled={resetWorkspace.isPending}
                >
                  {resetWorkspace.isPending ? "Resetting..." : "Confirm Reset"}
                </button>
                <button
                  className="ledger-danger-btn ledger-danger-btn--cancel"
                  onClick={() => setResetConfirm(false)}
                  disabled={resetWorkspace.isPending}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {propagationNotice && (
        <motion.div
          className="propagation-toast"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          data-testid="propagation-notice"
          role="status"
          aria-live="polite"
        >
          <span className="propagation-toast-icon">✓</span>
          Also applied to{" "}
          <span className="propagation-toast-count">{propagationNotice.count}</span>{" "}
          other <span className="propagation-toast-merchant">{propagationNotice.merchant}</span>{" "}
          transaction{propagationNotice.count !== 1 ? "s" : ""}.
        </motion.div>
      )}
    </>
  );
}

type TransactionRowProps = {
  txn: Transaction;
  isEditing: boolean;
  onRowClick: () => void;
  onQuickUpdate: (fields: UpdateTransactionInput) => void;
  onSave: (fields: UpdateTransactionInput) => void;
  onCancel: () => void;
  isSaving: boolean;
};

function TransactionRow({ txn, isEditing, onRowClick, onQuickUpdate, onSave, onCancel, isSaving }: TransactionRowProps) {
  return (
    <>
      <tr
        className={`ledger-row--clickable ${isEditing ? "ledger-row--selected" : ""}`}
        onClick={onRowClick}
      >
        <td className="ledger-td-date">{txn.date}</td>
        <td className="ledger-td-merchant" title={txn.rawDescription}>
          {txn.merchant}
        </td>
        <td className={`ledger-td-amount ${amountColorClass(txn.transactionClass)}`}>
          {formatAmount(txn.amount, txn.transactionClass)}
        </td>
        <td className="ledger-td-category">
          <select
            className="ledger-inline-select"
            value={txn.category}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); onQuickUpdate({ category: e.target.value }); }}
            disabled={isSaving}
            data-testid={`select-category-${txn.id}`}
          >
            {V1_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
            ))}
          </select>
        </td>
        <td className="ledger-td-class">
          <Hint
            content="Set 'Transfer' for movement between your own accounts so it isn't double-counted as spending or income."
            data-testid={`hint-class-${txn.id}`}
          >
            <select
              className="ledger-inline-select ledger-inline-select--class"
              value={txn.transactionClass}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { e.stopPropagation(); onQuickUpdate({ transactionClass: e.target.value }); }}
              disabled={isSaving}
              data-testid={`select-class-${txn.id}`}
            >
              {CLASS_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Hint>
        </td>
        <td className="ledger-td-recurrence">
          <Hint
            content="Mark this 'Recurring' to help PocketPulse detect subscriptions and recurring bills."
            data-testid={`hint-recurrence-${txn.id}`}
          >
            <select
              className="ledger-inline-select ledger-inline-select--recurrence"
              value={txn.recurrenceType}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { e.stopPropagation(); onQuickUpdate({ recurrenceType: e.target.value }); }}
              disabled={isSaving}
              data-testid={`select-recurrence-${txn.id}`}
            >
              {RECURRENCE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Hint>
        </td>
        <td className="ledger-td-status">
          {txn.userCorrected && (
            <Hint
              content="Manually corrected — this kind of edit is used to improve future automatic categorization."
              data-testid={`hint-edited-${txn.id}`}
            >
              <span
                className="ledger-badge ledger-badge--edited"
                tabIndex={0}
                data-testid={`badge-edited-${txn.id}`}
              >
                edited
              </span>
            </Hint>
          )}
        </td>
      </tr>
      {isEditing && (
        <tr className="ledger-edit-row">
          <td colSpan={7}>
            <EditPanel txn={txn} onSave={onSave} onCancel={onCancel} isSaving={isSaving} />
          </td>
        </tr>
      )}
    </>
  );
}

type EditPanelProps = {
  txn: Transaction;
  onSave: (fields: UpdateTransactionInput) => void;
  onCancel: () => void;
  isSaving: boolean;
};

function EditPanel({ txn, onSave, onCancel, isSaving }: EditPanelProps) {
  const [date, setDate] = useState(txn.date);
  const [merchant, setMerchant] = useState(txn.merchant);
  const [amount, setAmount] = useState(txn.amount);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fields: UpdateTransactionInput = {};
    if (date !== txn.date) fields.date = date;
    if (merchant !== txn.merchant) fields.merchant = merchant;
    if (amount !== txn.amount) fields.amount = amount;
    if (Object.keys(fields).length === 0) {
      onCancel();
      return;
    }
    onSave(fields);
  };

  return (
    <form className="ledger-edit-panel" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>
      <div className="ledger-edit-grid">
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Date</span>
          <input type="date" className="ledger-edit-input" value={date} onChange={(e) => setDate(e.target.value)} disabled={isSaving} />
        </label>
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Merchant</span>
          <input type="text" className="ledger-edit-input" value={merchant} onChange={(e) => setMerchant(e.target.value)} disabled={isSaving} />
        </label>
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Amount</span>
          <input type="text" className="ledger-edit-input" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isSaving} />
        </label>
      </div>
      <div className="ledger-edit-actions">
        <button type="submit" className="ledger-edit-save" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ledger-edit-cancel" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
      </div>
      {txn.rawDescription !== txn.merchant && (
        <p className="ledger-edit-raw">Original: {txn.rawDescription}</p>
      )}
    </form>
  );
}
