import { CheckMark } from "../components/landing/CheckMark";
import { FinalCta, PrivacySection, ProcessSection } from "../components/landing/LandingClose";
import { ProductPreview } from "../components/landing/ProductPreview";
import { ProductStories } from "../components/landing/ProductStories";
import { PublicBrand } from "../components/landing/PublicBrand";

const proofPoints = [
  ["01", "Keep your bank login private", "Upload statement exports when you choose. No always-on bank connection."],
  ["02", "Trace every insight", "Dashboard totals and Leak Hunter findings lead back to the transactions behind them."],
  ["03", "Correct the record", "Edit categories and recurrence labels when your real life does not match the first pass."],
] as const;

export function Landing() {
  return (
    <main className="landing-main" id="top">
      <a className="landing-skip-link" href="#main-content">Skip to main content</a>
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <a className="landing-brand" href="#top" aria-label="Pocket Pulse home"><PublicBrand /></a>
          <nav aria-label="Main navigation">
            <a href="#product">Product</a><a href="#how">How it works</a><a href="#privacy">Privacy</a><a href="/pricing">Pricing</a>
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
              <p className="landing-eyebrow"><span /> Public beta · CSV-powered spending clarity</p>
              <h1>Your bank statements should <em>tell you more.</em></h1>
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
              <p className="landing-hero-note">
                <span>Designed for deliberate review</span>
                Your transactions remain the source of truth.
              </p>
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
        <section className="landing-plus-intro" aria-labelledby="landing-plus-title">
          <div className="landing-container">
            <div>
              <p className="landing-eyebrow">Free core · optional Plus</p>
              <h2 id="landing-plus-title">Keep the clarity free. Add merchant review when it helps.</h2>
            </div>
            <div>
              <p>
                CSV imports, local analysis, dashboards, Ledger, existing data, and manual corrections stay in PocketPulse Free. Plus is an optional way to review unresolved merchants and apply the result to matching transactions.
              </p>
              <a className="landing-secondary" href="/pricing">Compare Free and Plus</a>
            </div>
          </div>
        </section>
        <ProcessSection />
        <PrivacySection />
        <FinalCta />
      </div>

      <footer className="landing-footer">
        <div className="landing-container">
          <a className="landing-brand" href="#top"><PublicBrand /></a>
          <p>CSV-powered spending clarity. Built independently by Nick Solomon.</p>
          <nav aria-label="Footer navigation"><a href="/pricing">Pricing</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/auth">Sign in</a></nav>
        </div>
      </footer>
    </main>
  );
}
