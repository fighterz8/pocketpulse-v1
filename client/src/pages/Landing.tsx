import { CheckMark } from "../components/landing/CheckMark";
import { FinalCta, PrivacySection, ProcessSection } from "../components/landing/LandingClose";
import { ProductPreview } from "../components/landing/ProductPreview";
import { ProductStories } from "../components/landing/ProductStories";

const proofPoints = [
  ["01", "Keep your bank login private", "Upload statement exports when you choose. No always-on bank connection."],
  ["02", "Trace every insight", "Dashboard totals and Leak Hunter findings lead back to the transactions behind them."],
  ["03", "Correct the record", "Edit categories and recurrence labels when your real life does not match the first pass."],
] as const;

function PocketPulseLogo() {
  return (
    <span className="landing-official-logo" aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="#2563eb" />
        <path d="M4 16h5l2.5-6 3 12 2.5-6h11" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Brand() {
  return <><PocketPulseLogo /><span>Pocket Pulse</span></>;
}

export function Landing() {
  return (
    <main className="landing-main" id="top">
      <a className="landing-skip-link" href="#main-content">Skip to main content</a>
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <a className="landing-brand" href="#top" aria-label="Pocket Pulse home"><Brand /></a>
          <nav aria-label="Main navigation">
            <a href="#product">Product</a><a href="#how">How it works</a><a href="#privacy">Privacy</a>
          </nav>
          <div className="landing-nav-actions">
            <a className="landing-sign-in" href="/auth">Sign in</a>
            <a className="landing-nav-cta" href="/auth">Start free</a>
          </div>
        </div>
      </header>

      <div id="main-content">
        <section className="landing-hero">
          <div className="landing-container">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">Private beta · CSV-powered spending clarity</p>
              <h1>Your bank statements should tell you more.</h1>
              <p className="landing-lede">
                Pocket Pulse turns exported transactions into a clean ledger, a monthly cash-flow view,
                recurring-expense review, and evidence-backed spending patterns—without connecting your bank account.
              </p>
              <div className="landing-cta-row">
                <a className="landing-primary" href="/auth">Create a free account</a>
                <a className="landing-secondary" href="#product">Explore the product</a>
              </div>
              <ul className="landing-hero-trust" aria-label="Pocket Pulse product assurances">
                <li><CheckMark /> No bank password required</li>
                <li><CheckMark /> Every finding stays reviewable</li>
                <li><CheckMark /> Your labels remain editable</li>
              </ul>
            </div>
            <ProductPreview />
          </div>
        </section>

        <section className="landing-proof-strip" aria-label="How Pocket Pulse earns trust">
          <div className="landing-container">
            {proofPoints.map(([number, title, body]) => (
              <article key={number}><span>{number}</span><div><h2>{title}</h2><p>{body}</p></div></article>
            ))}
          </div>
        </section>

        <ProductStories />
        <ProcessSection />
        <PrivacySection />
        <FinalCta />
      </div>

      <footer className="landing-footer">
        <div className="landing-container">
          <a className="landing-brand" href="#top"><Brand /></a>
          <p>CSV-powered spending clarity. Built independently by Nick Solomon.</p>
          <nav aria-label="Footer navigation"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/auth">Sign in</a></nav>
        </div>
      </footer>
    </main>
  );
}
