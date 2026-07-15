import { CheckMark } from "./CheckMark";

const steps = [
  ["01", "Export", "Download a CSV from your bank or card account."],
  ["02", "Import", "Pocket Pulse organizes the file into a reviewable ledger."],
  ["03", "Review", "Explore cash flow, recurring expenses, and spending patterns."],
] as const;

export function ProcessSection() {
  return (
    <section className="landing-process" id="how">
      <div className="landing-container">
        <header className="landing-section-heading">
          <p className="landing-eyebrow">Simple by design</p>
          <h2>From statement export to useful review.</h2>
          <p>No account-linking ceremony. Bring the file you already control.</p>
        </header>
        <ol>
          {steps.map(([number, title, body]) => (
            <li key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function PrivacySection() {
  return (
    <section className="landing-privacy" id="privacy">
      <div className="landing-container">
        <div className="landing-privacy-copy">
          <p className="landing-eyebrow">Privacy without theater</p>
          <h2>Your CSV is enough.</h2>
          <p>
            Pocket Pulse is built for people who want useful spending insight without
            handing another app an always-on view into their bank accounts.
          </p>
          <a href="/privacy">Read the privacy policy →</a>
        </div>
        <ul>
          <li><CheckMark /><span><strong>No bank credentials</strong>Upload exports instead of sharing your bank username or password.</span></li>
          <li><CheckMark /><span><strong>No unrelated account access</strong>Pocket Pulse does not ask for your inbox, Drive, or Calendar.</span></li>
          <li><CheckMark /><span><strong>Review stays in your hands</strong>Inspect transactions and correct classifications when needed.</span></li>
        </ul>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="landing-final-cta">
      <div className="landing-container">
        <div>
          <p className="landing-eyebrow">Start with one statement</p>
          <h2>See the month differently.</h2>
        </div>
        <div>
          <p>Join the free beta and turn a bank export into a clearer financial review.</p>
          <a className="landing-primary" href="/auth">Try Pocket Pulse</a>
        </div>
      </div>
    </section>
  );
}
