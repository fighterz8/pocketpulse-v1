import { useState } from "react";
import {
  useTransactions,
  type Transaction,
  type TransactionFilters,
} from "../hooks/use-transactions";

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
  const [filters, setFilters] = useState<TransactionFilters>({
    page: 1,
    limit: 50,
  });

  const {
    transactions,
    pagination,
    isLoading,
    error,
  } = useTransactions(filters);

  const setPage = (p: number) => setFilters((f) => ({ ...f, page: p }));

  return (
    <>
      <h1 className="app-page-title">Ledger</h1>

      {error && <p className="ledger-error">{error.message}</p>}

      {isLoading && transactions.length === 0 && (
        <p className="ledger-loading">Loading transactions...</p>
      )}

      {!isLoading && transactions.length === 0 && !error && (
        <div className="ledger-empty">
          <p className="ledger-empty-text">No transactions yet.</p>
          <p className="ledger-empty-hint">Upload CSV statements to get started.</p>
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
