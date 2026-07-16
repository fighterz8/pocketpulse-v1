# ADR 0001: Billing Provider and Plus Entitlement Boundary

- **Status:** Accepted
- **Date:** 2026-07-16
- **Decision owner:** PocketPulse
- **Applies to:** Slice 6 sandbox billing foundation

## Context

PocketPulse is testing a single paid tier, PocketPulse Plus, at a working hypothesis of $5 per month with one seven-day trial per eligible user. Plus unlocks Transaction Enhancement. The free product keeps local CSV import, deterministic classification, dashboard, ledger, and manual corrections.

The immediate goal is not a public billing launch. Slice 6 needs a safe sandbox foundation that can prove trial and subscription lifecycle behavior, enforce access on the server, and avoid coupling product authorization to a checkout vendor. No live provider account, price, webhook endpoint, public pricing page, or production deployment is authorized by this decision.

At the working $5 price, fixed fees matter:

| Option | Commercial model | Approximate fee on a domestic $5 card payment | Tax and operational responsibility |
| --- | --- | ---: | --- |
| Stripe Payments + Billing | Payment processor plus subscription platform | $0.48 (2.9% + $0.30 Payments, plus 0.7% Billing) | PocketPulse remains merchant of record and owns registrations, filings, refunds, disputes, and customer billing support unless separate products/services are added. |
| Stripe Managed Payments | Stripe merchant-of-record service | Higher than direct Stripe; Stripe lists 3.5% in addition to payment processing, with Billing charges also subject to its published terms | Stripe assumes supported indirect-tax, fraud, dispute, invoicing, and billing-support responsibilities, subject to eligibility and product coverage. |
| Paddle | Merchant of record | $0.75 (5% + $0.50) | Paddle handles payments, billing, tax compliance, and customer billing support under its merchant-of-record model. |
| Lemon Squeezy | Merchant of record | Published transaction pricing should be rechecked immediately before launch | Lemon Squeezy handles digital sales tax collection and remittance under its merchant-of-record model. |

Stripe's direct path has the lowest known unit cost and the strongest fit for the existing TypeScript/Express stack, hosted Checkout, hosted customer portal, test clocks, and webhook tooling. A merchant-of-record option can reduce international tax and billing operations, but costs more at this price point and may impose eligibility or product constraints.

## Decision

Use **Stripe Payments + Stripe Billing in sandbox mode** as the first provider adapter for Slice 6, while keeping PocketPulse's entitlement model provider-agnostic.

The decision has these boundaries:

1. **The PocketPulse database is the application authorization source of truth.** Browser state, checkout redirects, query parameters, and client claims never grant Plus access.
2. **Signed, idempotently processed provider webhooks update billing projections.** Checkout completion only returns the user to PocketPulse; access changes after the corresponding verified provider event is accepted.
3. **Entitlements are evaluated server-side at every protected boundary.** Transaction Enhancement job creation and each subsequent batch execution must both recheck access so cancellation, expiration, refund, or administrative revocation takes effect during long-running work.
4. **Billing records use neutral identifiers.** Core tables store `provider`, external customer/subscription/event IDs, normalized status, trial timestamps, and access timestamps. Stripe-specific payload interpretation remains inside the Stripe adapter.
5. **One trial is enforced atomically by durable data.** A user's prior trial consumption cannot be reset by deleting a subscription, replaying a request, changing a browser, or racing two requests.
6. **Hosted surfaces handle payment details.** PocketPulse does not collect or store card numbers. Checkout and subscription management use provider-hosted pages.
7. **Billing is disabled by default.** Missing or disabled configuration must fail closed for checkout, portal, webhook mutation, and Plus-only work. Tests use injected fake transports; they do not contact Stripe.
8. **The price and trial duration remain hypotheses.** `$5/month` and seven days are configuration values, not promises embedded throughout the domain model.

Normalized access states are:

- `free`: no current Plus access
- `trialing`: Plus access until the stored trial end
- `active`: Plus access for a paid/current subscription
- `past_due`: no Plus access by default; a future policy may add a narrowly bounded grace period
- `expired`: no Plus access after cancellation, refund/revocation, incomplete expiry, or trial end

The raw provider status is retained for auditability, while authorization uses the normalized state and authoritative timestamps.

## Webhook processing rules

- Verify the signature against the unparsed request body.
- Persist the external event ID under a unique constraint before applying its effect.
- Treat duplicate delivery as success without reapplying state.
- Compare provider event creation time and object version/update time before replacing a newer projection with an older one.
- Apply the database mutation and event-processing marker in one transaction.
- Return a fast success response after durable processing; do not perform AI work in the webhook request.
- Retain only the minimum payload metadata needed for diagnosis. Do not store payment credentials or unnecessary personal data.

## Consequences

### Positive

- Slice 6 can prove the complete authorization lifecycle without exposing real billing.
- Stripe's hosted pages reduce PCI scope and avoid custom payment UI.
- Server-side rechecks close common client-side and stale-job authorization gaps.
- The provider-neutral projection preserves a practical migration path to Stripe Managed Payments, Paddle, or Lemon Squeezy.

### Costs and risks

- Direct Stripe leaves PocketPulse responsible for merchant, tax, refund, dispute, and billing-support obligations.
- Webhooks are asynchronous and can be duplicated or delivered out of order, so the local projection requires careful idempotency and ordering tests.
- At $5, Stripe's fixed card fee is material, and international cards, currency conversion, Tax, and other services can increase effective cost.
- A provider-neutral core adds a small adapter boundary now, but avoids a much larger billing rewrite later.

## Reconsideration gates

Re-evaluate the provider before any public paid launch, and specifically when any of these becomes true:

- PocketPulse intends to sell in more than one tax jurisdiction.
- Stripe Managed Payments eligibility and total effective pricing are known.
- Expected paid volume makes the operational cost of merchant-of-record work comparable to its fee premium.
- The $5 price or seven-day trial hypothesis changes.
- Beta evidence does not show repeat use and a clear Transaction Enhancement upgrade trigger.

The public launch decision must include a current fee comparison, tax/accounting review appropriate to the selling entity, refund policy, support workflow, and an explicit production-readiness approval.

## Alternatives considered

### Use a merchant of record immediately

Paddle, Lemon Squeezy, or Stripe Managed Payments could reduce tax and billing operations. This remains a strong public-launch option, especially for international sales. It was not selected for the first adapter because direct Stripe has clearer fit with the current stack and sandbox testing needs, while the product's paid demand is still unproven.

### Build checkout and card collection in PocketPulse

Rejected. It increases security and compliance scope without creating product differentiation.

### Trust the client or checkout success URL

Rejected. Client state is forgeable and redirects can occur before, after, or without the authoritative subscription event.

### Delay all billing architecture until public launch

Rejected. Transaction Enhancement needs a real server authorization boundary before a public pricing interface can safely expose it.

## Sources

Official sources reviewed 2026-07-16:

- [Stripe Billing pricing](https://stripe.com/billing/pricing)
- [Stripe Payments pricing](https://stripe.com/pricing)
- [Stripe Tax pricing](https://stripe.com/tax/pricing)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe customer portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Stripe webhook signature guidance](https://docs.stripe.com/webhooks)
- [Paddle pricing and merchant-of-record scope](https://www.paddle.com/pricing)
- [Lemon Squeezy pricing](https://www.lemonsqueezy.com/pricing)
- [Lemon Squeezy merchant-of-record scope](https://www.lemonsqueezy.com/reporting/merchant-of-record)
