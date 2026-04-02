import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/use-auth";
import {
  useTransactions,
  type Transaction,
  type TransactionFilters,
} from "../hooks/use-transactions";

const V1_CATEGORIES = [
  "income", "transfers", "utilities", "subscriptions", "insurance",
  "housing", "groceries", "transportation", "dining", "shopping",
  "health", "debt", "business_software", "entertainment", "fees", "other",
] as const;

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

  const {
    transactions,
    pagination,
    isLoading,
    error,
  } = useTransactions(filters);

  const setPage = (p: number) => setFilters((f) => ({ ...f, page: p }));

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
                  <TransactionRow key={txn.id} txn={txn} />
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
    </>
  );
}

function TransactionRow({ txn }: { txn: Transaction }) {
  return (
    <tr className={txn.excludedFromAnalysis ? "ledger-row--excluded" : ""}>
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
  );
}
