import { PublicBrand } from "../components/landing/PublicBrand";
import { type PlusPlan, usePlusPlan } from "../hooks/use-billing";

function formatPrice(plan: PlusPlan): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(plan.monthlyPriceCents / 100);
}

function PricingBody() {
  const planQuery = usePlusPlan();

  if (planQuery.isLoading) {
    return <div className="pricing-loading" aria-busy="true" aria-label="Loading plan details" />;
  }

  if (!planQuery.data || planQuery.isError) {
    return (
      <div className="pricing-error" role="alert">
        <p>Plan details are temporarily unavailable.</p>
        <button type="button" onClick={() => void planQuery.refetch()}>Try again</button>
      </div>
    );
  }

  const { plan, checkoutAvailable } = planQuery.data;
  const price = formatPrice(plan);

  return (
    <>
      <div className="pricing-grid" aria-label="PocketPulse plan comparison">
        <article className="pricing-card" aria-labelledby="free-plan-title">
          <div className="pricing-card-head">
            <p className="pricing-kicker">Useful by itself</p>
            <h2 id="free-plan-title">PocketPulse Free</h2>
            <p className="pricing-price"><strong>$0</strong><span>no subscription</span></p>
          </div>
          <p className="pricing-card-copy">Private CSV-powered spending clarity without connecting a bank account.</p>
          <ul>
            <li>CSV imports and local transaction classification</li>
            <li>Monthly dashboard, Ledger, and spending patterns</li>
            <li>Recurring-expense and Leak Hunter review</li>
            <li>Manual category and recurrence corrections</li>
            <li>Continued access to existing imported data</li>
          </ul>
          <a className="pricing-action pricing-action--secondary" href="/auth">Create a free account</a>
        </article>

        <article className="pricing-card pricing-card--plus" aria-labelledby="plus-plan-title">
          <div className="pricing-card-head">
            <p className="pricing-kicker">Optional merchant review</p>
            <h2 id="plus-plan-title">{plan.name}</h2>
            <p className="pricing-price"><strong>{price}</strong><span>per month</span></p>
          </div>
          <p className="pricing-card-copy">Everything in Free, plus user-initiated review for merchants the local rules could not resolve.</p>
          <ul>
            <li>Reviews each unresolved merchant once per job</li>
            <li>Applies reviewed labels to matching transactions</li>
            <li>Shows bounded progress and preserves manual control</li>
            <li>Keeps every result editable in Ledger</li>
            <li>Remains subject to fair-use cost and safety limits</li>
          </ul>
          {checkoutAvailable ? (
            <>
              <a className="pricing-action pricing-action--primary" href="/account">Start in Account</a>
              <p className="pricing-disclosure">
                {plan.trialDays}-day trial. Unless cancelled first, Plus then renews automatically at {price} per month until cancelled.
              </p>
            </>
          ) : (
            <>
              <a className="pricing-action pricing-action--primary" href="/auth">Use PocketPulse Free</a>
              <p className="pricing-disclosure">Plus checkout is not open yet. The free product remains available during the private beta.</p>
            </>
          )}
        </article>
      </div>

      <section className="pricing-explainer" aria-labelledby="pricing-explainer-title">
        <p className="pricing-kicker">The upgrade trigger</p>
        <h2 id="pricing-explainer-title">Upgrade only when unresolved merchants are worth reviewing.</h2>
        <p>
          Importing never requires Plus. PocketPulse first uses local rules and saved corrections. If merchants remain unresolved, you can keep correcting them manually or choose Plus to review them in bounded batches.
        </p>
      </section>
    </>
  );
}

export function Pricing() {
  return (
    <main className="landing-main pricing-main" id="top">
      <a className="landing-skip-link" href="#pricing-content">Skip to plan comparison</a>
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <a className="landing-brand" href="/landing" aria-label="Pocket Pulse home"><PublicBrand /></a>
          <nav aria-label="Pricing navigation"><a href="/landing#product">Product</a><a href="/landing#privacy">Privacy</a></nav>
          <div className="landing-nav-actions">
            <a className="landing-sign-in" href="/auth">Sign in</a>
            <a className="landing-nav-cta" href="/auth">Start free</a>
          </div>
        </div>
      </header>

      <div className="pricing-content landing-container" id="pricing-content">
        <header className="pricing-hero">
          <p className="landing-eyebrow">Simple plans · no bank login</p>
          <h1>Start free. Add merchant review only when you need it.</h1>
          <p>PocketPulse Free handles your private CSV workflow. PocketPulse Plus adds optional Transaction Enhancement without locking your imports, data, or manual corrections behind a paywall.</p>
        </header>
        <PricingBody />
      </div>

      <footer className="landing-footer">
        <div className="landing-container">
          <a className="landing-brand" href="/landing"><PublicBrand /></a>
          <p>Free CSV-powered clarity, with optional merchant review.</p>
          <nav aria-label="Footer navigation"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/auth">Sign in</a></nav>
        </div>
      </footer>
    </main>
  );
}
