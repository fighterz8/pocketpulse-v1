import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/use-auth";
import {
  useTransactions,
  type Transaction,
  type TransactionFilters,
  type UpdateTransactionInput,
} from "../hooks/use-transactions";
import { V1_CATEGORIES } from "../../../shared/schema";

const CLASS_OPTIONS = ["income", "expense", "transfer", "refund"] as const;
const RECURRENCE_OPTIONS = ["recurring", "one-time"] as const;
const EXCLUDED_OPTIONS = [
  { value: "", label: "All" },
  { value: "false", label: "Active" },
  { value: "true", label: "Excluded" },
] as const;

function formatAmount(amount: string): string {
  const n = parseFloat(amount);
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function amountClass(amount: string): string {
  const n = parseFloat(amount);
  if (n > 0) return "ledger-amount--inflow";
  if (n < 0) return "ledger-amount--outflow";
  return "";
}

export function Ledger() {
  const { accounts } = useAuth();
  const [filters, setFilters] = useState<TransactionFilters>({
    page: 1,
    limit: 50,
  });

  const [searchInput, setSearchInput] = useState("");
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

  const {
    transactions,
    pagination,
    isLoading,
    error,
    updateTransaction,
    wipeData,
    resetWorkspace,
  } = useTransactions(filters);

  const setPage = (p: number) => setFilters((f) => ({ ...f, page: p }));

  const handleRowClick = (id: number) => {
    setEditingId((prev) => (prev === id ? null : id));
  };

  const handleToggleExclude = (txn: Transaction) => {
    updateTransaction.mutate({
      id: txn.id,
      fields: { excludedFromAnalysis: !txn.excludedFromAnalysis },
    });
  };

  const hasAnyFilter = !!(
    filters.search || filters.category || filters.transactionClass ||
    filters.recurrenceType || filters.dateFrom || filters.dateTo ||
    filters.excluded || filters.accountId
  );

  const clearFilters = () => {
    setSearchInput("");
    setFilters({ page: 1, limit: 50 });
  };

  return (
    <>
      <h1 className="app-page-title">Ledger</h1>

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

          <select
            className="ledger-filter-select"
            value={filters.excluded ?? ""}
            onChange={(e) => setFilter("excluded", e.target.value as TransactionFilters["excluded"])}
          >
            {EXCLUDED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <div className="ledger-date-range">
            <input
              type="date"
              className="ledger-date-input"
              value={filters.dateFrom ?? ""}
              onChange={(e) => setFilter("dateFrom", e.target.value)}
              title="From date"
            />
            <span className="ledger-date-sep">to</span>
            <input
              type="date"
              className="ledger-date-input"
              value={filters.dateTo ?? ""}
              onChange={(e) => setFilter("dateTo", e.target.value)}
              title="To date"
            />
          </div>
        </div>
      </div>

      {error && <p className="ledger-error">{error.message}</p>}

      {isLoading && transactions.length === 0 && (
        <p className="ledger-loading">Loading transactions...</p>
      )}

      {!isLoading && transactions.length === 0 && !error && (
        <div className="ledger-empty">
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
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="ledger-th-toggle"></th>
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
                    onToggleExclude={() => handleToggleExclude(txn)}
                    onSave={(fields) => {
                      updateTransaction.mutate(
                        { id: txn.id, fields },
                        { onSuccess: () => setEditingId(null) },
                      );
                    }}
                    onCancel={() => setEditingId(null)}
                    isSaving={updateTransaction.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>

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

          {pagination && (
            <p className="ledger-total-info">
              {pagination.total} transaction{pagination.total !== 1 ? "s" : ""}
            </p>
          )}
        </>
      )}

      {/* Danger zone */}
      <div className="ledger-danger-zone">
        <h3 className="ledger-danger-title">Data Management</h3>
        <div className="ledger-danger-actions">
          {!wipeConfirm ? (
            <button
              className="ledger-danger-btn ledger-danger-btn--warn"
              onClick={() => setWipeConfirm(true)}
              disabled={wipeData.isPending || resetWorkspace.isPending}
            >
              Wipe Imported Data
            </button>
          ) : (
            <div className="ledger-danger-confirm">
              <p className="ledger-danger-msg">
                This will permanently delete all transactions and uploads. Your accounts will be kept.
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
            <button
              className="ledger-danger-btn ledger-danger-btn--warn"
              onClick={() => setResetConfirm(true)}
              disabled={wipeData.isPending || resetWorkspace.isPending}
            >
              Reset Workspace
            </button>
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
    </>
  );
}

type TransactionRowProps = {
  txn: Transaction;
  isEditing: boolean;
  onRowClick: () => void;
  onToggleExclude: () => void;
  onSave: (fields: UpdateTransactionInput) => void;
  onCancel: () => void;
  isSaving: boolean;
};

function TransactionRow({ txn, isEditing, onRowClick, onToggleExclude, onSave, onCancel, isSaving }: TransactionRowProps) {
  return (
    <>
      <tr
        className={`ledger-row--clickable ${txn.excludedFromAnalysis ? "ledger-row--excluded" : ""} ${isEditing ? "ledger-row--selected" : ""}`}
        onClick={onRowClick}
      >
        <td className="ledger-td-toggle">
          <button
            className={`ledger-exclude-toggle ${txn.excludedFromAnalysis ? "ledger-exclude-toggle--active" : ""}`}
            title={txn.excludedFromAnalysis ? "Include in analysis" : "Exclude from analysis"}
            onClick={(e) => { e.stopPropagation(); onToggleExclude(); }}
          >
            {txn.excludedFromAnalysis ? "X" : ""}
          </button>
        </td>
        <td className="ledger-td-date">{txn.date}</td>
        <td className="ledger-td-merchant" title={txn.rawDescription}>
          {txn.merchant}
        </td>
        <td className={`ledger-td-amount ${amountClass(txn.amount)}`}>
          {formatAmount(txn.amount)}
        </td>
        <td className="ledger-td-category">
          <span className="ledger-badge">{txn.category}</span>
        </td>
        <td className="ledger-td-class">{txn.transactionClass}</td>
        <td className="ledger-td-recurrence">{txn.recurrenceType}</td>
        <td className="ledger-td-status">
          {txn.excludedFromAnalysis && <span className="ledger-badge ledger-badge--excluded">excluded</span>}
          {txn.userCorrected && <span className="ledger-badge ledger-badge--edited">edited</span>}
        </td>
      </tr>
      {isEditing && (
        <tr className="ledger-edit-row">
          <td colSpan={8}>
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
  const [category, setCategory] = useState(txn.category);
  const [txnClass, setTxnClass] = useState(txn.transactionClass);
  const [recurrence, setRecurrence] = useState(txn.recurrenceType);
  const [excluded, setExcluded] = useState(txn.excludedFromAnalysis);
  const [excludedReason, setExcludedReason] = useState(txn.excludedReason ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fields: UpdateTransactionInput = {};
    if (date !== txn.date) fields.date = date;
    if (merchant !== txn.merchant) fields.merchant = merchant;
    if (amount !== txn.amount) fields.amount = amount;
    if (category !== txn.category) fields.category = category;
    if (txnClass !== txn.transactionClass) fields.transactionClass = txnClass;
    if (recurrence !== txn.recurrenceType) fields.recurrenceType = recurrence;
    if (excluded !== txn.excludedFromAnalysis) fields.excludedFromAnalysis = excluded;
    if (excludedReason !== (txn.excludedReason ?? "")) {
      fields.excludedReason = excludedReason || null;
    }
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
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Category</span>
          <select className="ledger-edit-input" value={category} onChange={(e) => setCategory(e.target.value)} disabled={isSaving}>
            {V1_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Class</span>
          <select className="ledger-edit-input" value={txnClass} onChange={(e) => setTxnClass(e.target.value)} disabled={isSaving}>
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="ledger-edit-field">
          <span className="ledger-edit-label">Recurrence</span>
          <select className="ledger-edit-input" value={recurrence} onChange={(e) => setRecurrence(e.target.value)} disabled={isSaving}>
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="ledger-edit-exclude-row">
        <label className="ledger-edit-checkbox">
          <input
            type="checkbox"
            checked={excluded}
            onChange={(e) => setExcluded(e.target.checked)}
            disabled={isSaving}
          />
          <span>Exclude from analysis</span>
        </label>
        {excluded && (
          <input
            type="text"
            className="ledger-edit-input ledger-edit-reason"
            placeholder="Reason (optional)"
            value={excludedReason}
            onChange={(e) => setExcludedReason(e.target.value)}
            disabled={isSaving}
          />
        )}
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
