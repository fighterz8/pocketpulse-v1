const features = [
  ["CSV-first privacy", "Upload bank exports without handing over your bank login."],
  ["Inspectable categories", "See why transactions are grouped, then fix labels once."],
  ["Leak detection", "Find subscriptions and quiet recurring charges that stack up."],
] as const;

const steps = [
  ["1", "Upload a CSV", "Start with a bank or card statement export."],
  ["2", "Review the rules", "Pocket Pulse categorizes spending with editable, inspectable logic."],
  ["3", "Catch the leaks", "Spot recurring charges, unusual patterns, and budget drift."],
] as const;

function PocketPulseLogo() {
  return (
    <span className="landing-official-logo" aria-hidden="true">
      <svg viewBox="0 0 32 32" role="img">
        <defs>
          <linearGradient id="landing-pp-logo-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="7" fill="url(#landing-pp-logo-bg)" />
        <polyline points="4,16 9,16 11.5,10 14,22 16.5,16 28,16" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function DashboardPreview() {
  const rows = [
    ["05/12/2026", "AMZN MKTPLACE PMTS", "-$42.16", "shopping", "one-time"],
    ["05/10/2026", "SPOTIFY USA", "-$11.99", "subscription", "recurring"],
    ["05/08/2026", "PAYROLL DEPOSIT", "$2,100.00", "income", "recurring"],
  ] as const;

  return (
    <div className="landing-app-preview" aria-label="Pocket Pulse dashboard preview">
      <div className="landing-preview-shell-top">
        <div>
          <p className="landing-dash-title-mini">Dashboard</p>
          <p className="landing-dash-subtitle-mini">Your money, cleaned up from CSV imports.</p>
        </div>
        <span className="landing-dash-badge-mini">May 2026</span>
      </div>

      <div className="landing-actual-kpis">
        <div className="landing-glass-mini landing-hero-mini">
          <span className="landing-kpi-label-mini">Net cashflow</span>
          <strong className="landing-dash-hero-mini">+$1,917</strong>
          <em>Income minus expenses</em>
        </div>
        <div className="landing-glass-mini"><span className="landing-kpi-label-mini">Income</span><strong>$2,100</strong><em>1 transaction</em></div>
        <div className="landing-glass-mini"><span className="landing-kpi-label-mini">Expenses</span><strong>$182.54</strong><em>4 transactions</em></div>
      </div>

      <div className="landing-actual-grid">
        <div className="landing-glass-mini landing-spend-card">
          <h3>Spending by Category</h3>
          {["shopping", "dining", "subscriptions", "transport"].map((name, i) => (
            <div className="landing-spend-row" key={name}>
              <span>{name}</span>
              <div><i style={{ width: `${[76, 54, 34, 22][i]}%` }} /></div>
              <strong>{["$72", "$48", "$39", "$23"][i]}</strong>
            </div>
          ))}
        </div>

        <div className="landing-glass-mini landing-leak-mini">
          <span className="landing-dash-badge-mini landing-warning">Leak watch</span>
          <strong>No major leaks yet</strong>
          <p>Recurring charges are separated from one-time purchases for quick review.</p>
          <a href="/leaks">Review Leak Hunter</a>
        </div>
      </div>

      <div className="landing-glass-mini landing-ledger-mini">
        <div className="landing-ledger-title-row"><h3>Ledger</h3><span>3 of 5 transactions</span></div>
        <table>
          <tbody>
            {rows.map(([date, merchant, amount, category, recur]) => (
              <tr key={merchant}>
                <td>{date}</td>
                <td>{merchant}</td>
                <td className={amount.startsWith("$") ? "landing-money-in" : "landing-money-out"}>{amount}</td>
                <td><span className="landing-ledger-chip">{category}</span></td>
                <td>{recur}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <main className="landing-main">
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="Pocket Pulse home"><PocketPulseLogo />Pocket Pulse</a>
        <nav>
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#privacy">Privacy</a>
          <a className="landing-nav-cta" href="/auth">Get started</a>
        </nav>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">CSV-powered spending clarity</p>
          <h1>See where your money actually goes.</h1>
          <p className="landing-lede">Pocket Pulse turns bank statement CSVs into clean categories, recurring-charge detection, and money-leak insights — without connecting your bank account.</p>
          <div className="landing-cta-row">
            <a className="landing-primary" href="/auth">Get started</a>
            <a className="landing-secondary" href="#how">See how it works</a>
          </div>
          <p className="landing-trust">CSV upload only · No bank login required · You stay in control</p>
        </div>
        <DashboardPreview />
      </section>

      <section className="landing-logo-strip" aria-label="Product highlights">
        <span>No Plaid required</span><span>Rule-based labels</span><span>Editable imports</span><span>Recurring charge review</span>
      </section>

      <section className="landing-section" id="features">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">Why Pocket Pulse</p>
          <h2>Built for clarity, not another finance chore.</h2>
        </div>
        <div className="landing-feature-grid">
          {features.map(([title, body]) => <article key={title}><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section className="landing-section landing-split" id="how">
        <div>
          <p className="landing-eyebrow">Simple workflow</p>
          <h2>From messy CSV to useful insight in minutes.</h2>
          <p className="landing-muted">Pocket Pulse is designed for people who want a clean budget reset without opening another permanent financial data connection.</p>
        </div>
        <div className="landing-steps">
          {steps.map(([num, title, body]) => <article key={num}><span>{num}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}
        </div>
      </section>

      <section className="landing-section landing-privacy" id="privacy">
        <div>
          <p className="landing-eyebrow">A calmer privacy model</p>
          <h2>Not another black-box budget app.</h2>
          <p>Pocket Pulse uses inspectable rules instead of mysterious guesses. If something is categorized wrong, fix it once and make future imports smarter.</p>
        </div>
        <ul>
          <li>No bank credentials</li><li>No Gmail, Drive, or Calendar access</li><li>Editable categories and recurrence tags</li><li>Financial insights you can inspect</li>
        </ul>
      </section>

      <section className="landing-final-cta" id="demo">
        <p className="landing-eyebrow">Ready when you are</p>
        <h2>Start with a CSV. Leave with a clearer month.</h2>
        <div className="landing-cta-row landing-center"><a className="landing-primary" href="/auth">Try Pocket Pulse</a><a className="landing-secondary" href="/privacy">Read privacy policy</a></div>
      </section>
    </main>
  );
}
