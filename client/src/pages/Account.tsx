import { Link } from "wouter";

import {
  type BillingAccountResponse,
  type PlusPlan,
  useBillingAccount,
  useHostedBillingPages,
} from "../hooks/use-billing";

type AccountProps = {
  redirectToHostedPage?: (url: string) => void;
};

function defaultRedirect(url: string) {
  window.location.assign(url);
}

function formatPrice(plan: PlusPlan): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(plan.monthlyPriceCents / 100);
}

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function planStatus(account: BillingAccountResponse): {
  label: string;
  title: string;
  body: string;
} {
  const price = formatPrice(account.plan);
  const accessEnd = formatDate(account.access.expiresAt);
  const periodEnd = formatDate(account.subscription.currentPeriodEndsAt);
  const trialEnd = formatDate(account.subscription.trialEndsAt);

  switch (account.access.state) {
    case "trialing":
      return {
        label: "Trial",
        title: "Your Plus trial is active",
        body: trialEnd
          ? `Your trial ends ${trialEnd}. After that, Plus renews at ${price} per month unless you cancel before the trial ends.`
          : `Plus renews at ${price} per month after the trial unless you cancel first.`,
      };
    case "active":
      if (account.subscription.cancelAtPeriodEnd) {
        return {
          label: "Cancelling",
          title: "Plus will not renew",
          body: accessEnd
            ? `Transaction Enhancement stays available through ${accessEnd}. Your free PocketPulse features and existing data remain afterward.`
            : "Your free PocketPulse features and existing data remain when Plus ends.",
        };
      }
      return {
        label: "Active",
        title: "PocketPulse Plus is active",
        body: periodEnd
          ? `Your subscription renews ${periodEnd} at ${price} per month.`
          : `Your subscription renews monthly at ${price}.`,
      };
    case "past_due":
      return {
        label: "Payment issue",
        title: "Your Plus payment needs attention",
        body: "Transaction Enhancement is paused. Imports, dashboards, Ledger, existing data, and manual corrections remain available.",
      };
    case "expired":
      return {
        label: "Ended",
        title: "Your Plus access has ended",
        body: "Your free PocketPulse features and existing data remain available. You can continue reviewing merchants manually.",
      };
    default:
      return {
        label: "Free",
        title: "You are using PocketPulse Free",
        body: "CSV imports, local analysis, dashboards, Ledger, existing data, and manual corrections are included.",
      };
  }
}

export function Account({ redirectToHostedPage = defaultRedirect }: AccountProps) {
  const accountQuery = useBillingAccount();
  const billingPages = useHostedBillingPages();

  if (accountQuery.isLoading) {
    return (
      <section className="account-page" aria-busy="true" aria-label="Loading account plan">
        <div className="account-skeleton" />
      </section>
    );
  }

  if (!accountQuery.data || accountQuery.isError) {
    return (
      <section className="account-page">
        <h1 className="app-page-title">Account</h1>
        <div className="glass-card account-error" role="alert">
          <p>We could not load your plan details.</p>
          <button type="button" onClick={() => void accountQuery.refetch()}>Try again</button>
        </div>
      </section>
    );
  }

  const account = accountQuery.data;
  const status = planStatus(account);
  const price = formatPrice(account.plan);
  const actionError = billingPages.checkout.error ?? billingPages.portal.error;

  async function openCheckout() {
    try {
      const url = await billingPages.checkout.mutateAsync();
      redirectToHostedPage(url);
    } catch {
      // The mutation owns the user-facing error state below.
    }
  }

  async function openPortal() {
    try {
      const url = await billingPages.portal.mutateAsync();
      redirectToHostedPage(url);
    } catch {
      // The mutation owns the user-facing error state below.
    }
  }

  return (
    <section className="account-page" aria-labelledby="account-title">
      <header className="account-header">
        <div>
          <p className="account-eyebrow">Plan and billing</p>
          <h1 className="app-page-title" id="account-title">Account</h1>
          <p className="account-subtitle">See what is included and manage Plus from the provider-hosted billing page.</p>
        </div>
        <Link className="account-pricing-link" href="/pricing">Compare plans</Link>
      </header>

      <article className="glass-card account-plan-card" aria-labelledby="account-plan-title">
        <div className="account-plan-heading">
          <div>
            <span className={`account-status account-status--${account.access.state}`}>{status.label}</span>
            <h2 id="account-plan-title">{status.title}</h2>
          </div>
          <p className="account-price"><strong>{price}</strong><span>/ month</span></p>
        </div>
        <p className="account-plan-copy">{status.body}</p>

        <div className="account-actions">
          {account.actions.canStartCheckout ? (
            <button
              type="button"
              className="account-primary-action"
              disabled={billingPages.checkout.isPending}
              onClick={() => void openCheckout()}
            >
              {billingPages.checkout.isPending
                ? "Opening secure checkout…"
                : account.access.trialAvailable
                  ? `Start ${account.plan.trialDays}-day trial`
                  : "Restart Plus"}
            </button>
          ) : null}
          {account.actions.canManageBilling ? (
            <button
              type="button"
              className="account-secondary-action"
              disabled={billingPages.portal.isPending}
              onClick={() => void openPortal()}
            >
              {billingPages.portal.isPending ? "Opening billing…" : "Manage billing"}
            </button>
          ) : null}
        </div>

        {account.access.state === "free" && !account.actions.canStartCheckout ? (
          <p className="account-availability-note">Plus checkout is not open yet. PocketPulse Free remains fully available.</p>
        ) : null}
        {account.actions.canStartCheckout && account.access.trialAvailable ? (
          <p className="account-recurring-note">
            The trial lasts {account.plan.trialDays} days. Unless cancelled first, Plus then renews automatically at {price} per month until cancelled.
          </p>
        ) : null}
        {actionError ? <p className="account-action-error" role="alert">{actionError.message}</p> : null}
      </article>

      <div className="account-benefit-grid">
        <article className="glass-card">
          <p className="account-card-kicker">Always included</p>
          <h2>PocketPulse Free</h2>
          <ul>
            <li>CSV imports without a bank login</li>
            <li>Local transaction classification and monthly views</li>
            <li>Dashboard, Ledger, and manual corrections</li>
            <li>Access to your existing imported data</li>
          </ul>
        </article>
        <article className="glass-card">
          <p className="account-card-kicker">Optional</p>
          <h2>PocketPulse Plus</h2>
          <ul>
            <li>Reviews unresolved merchants when you ask</li>
            <li>Applies reviewed labels to matching transactions</li>
            <li>Runs in bounded batches with clear progress</li>
            <li>Leaves every result editable in Ledger</li>
          </ul>
        </article>
      </div>
    </section>
  );
}
