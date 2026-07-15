const recurringRows = [
  ["Rent", "$1,450.00"],
  ["Home internet", "$79.99"],
  ["Mobile plan", "$62.00"],
  ["Spotify", "$11.99"],
] as const;

const ledgerRows = [
  ["May 12", "Corner Market", "Groceries", "-$42.16", "One-time"],
  ["May 10", "Spotify", "Software", "-$11.99", "Recurring"],
  ["May 08", "Payroll deposit", "Income", "+$4,800.00", "Recurring"],
] as const;

function PulseMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#2563eb" />
      <path
        d="M4 16h5l2.5-6 3 12 2.5-6h11"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProductPreview() {
  return (
    <figure
      className="landing-product-preview"
      aria-label="Pocket Pulse dashboard showing monthly cash flow, recurring expenses, a Leak Hunter finding, and its matching transactions"
    >
      <div className="landing-product-window" aria-hidden="true">
        <div className="landing-product-topbar">
          <div className="landing-product-brand">
            <span><PulseMark /></span>
            <strong>Pocket Pulse</strong>
          </div>
          <div className="landing-product-tabs">
            <span className="is-active">Dashboard</span>
            <span>Ledger</span>
            <span>Leak Hunter</span>
          </div>
          <span className="landing-product-period">May 2026</span>
        </div>

        <div className="landing-product-canvas">
          <div className="landing-product-heading">
            <div>
              <span className="landing-product-kicker">Monthly review</span>
              <h2>Your May snapshot</h2>
            </div>
            <span className="landing-product-reviewed">
              <i /> 46 transactions reviewed
            </span>
          </div>

          <div className="landing-product-kpis">
            <div className="landing-preview-kpi is-primary">
              <span>Net cash flow</span>
              <strong>+$1,917</strong>
              <small>Income minus spending</small>
            </div>
            <div className="landing-preview-kpi">
              <span>Total spending</span>
              <strong>$2,883</strong>
              <small>Across 38 expenses</small>
            </div>
            <div className="landing-preview-kpi">
              <span>Recurring expenses</span>
              <strong>$1,604</strong>
              <small>4 charges this month</small>
            </div>
          </div>

          <div className="landing-product-grid">
            <section className="landing-preview-leak">
              <div className="landing-preview-card-head">
                <div>
                  <span className="landing-product-kicker">Leak Hunter</span>
                  <h3>Repeated coffee runs</h3>
                </div>
                <span className="landing-preview-priority">Priority review</span>
              </div>
              <p>Six similar purchases appeared in the recent window.</p>
              <div className="landing-preview-pattern" aria-hidden="true">
                {[48, 66, 55, 78, 60, 92].map((height, index) => (
                  <span key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <div className="landing-preview-leak-foot">
                <div>
                  <strong>$46.80</strong>
                  <span>across 6 purchases</span>
                </div>
                <span className="landing-preview-link">Review 6 transactions →</span>
              </div>
            </section>

            <section className="landing-preview-recurring">
              <div className="landing-preview-card-head">
                <div>
                  <span className="landing-product-kicker">Recurring expenses</span>
                  <h3>What repeated this month</h3>
                </div>
                <strong>$1,603.98</strong>
              </div>
              <ul>
                {recurringRows.map(([merchant, amount]) => (
                  <li key={merchant}>
                    <span>{merchant}</span>
                    <strong>{amount}</strong>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="landing-preview-ledger">
            <div className="landing-preview-card-head">
              <div>
                <span className="landing-product-kicker">Ledger</span>
                <h3>Transactions behind the numbers</h3>
              </div>
              <span className="landing-preview-link">View all transactions →</span>
            </div>
            <div className="landing-preview-table">
              {ledgerRows.map(([date, merchant, category, amount, recurrence]) => (
                <div className="landing-preview-row" key={`${date}-${merchant}`}>
                  <span>{date}</span>
                  <strong>{merchant}</strong>
                  <span className="landing-preview-category">{category}</span>
                  <span className={amount.startsWith("+") ? "is-income" : "is-expense"}>
                    {amount}
                  </span>
                  <span>{recurrence}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      <figcaption className="sr-only">
        A sample Pocket Pulse workspace where dashboard totals, recurring expenses,
        Leak Hunter findings, and ledger transactions remain connected.
      </figcaption>
    </figure>
  );
}
