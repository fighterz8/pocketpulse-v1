export const BILLING_ENV = {
  enabled: "POCKETPULSE_BILLING_ENABLED",
  stripeSecretKey: "STRIPE_SECRET_KEY",
  stripeWebhookSecret: "STRIPE_WEBHOOK_SECRET",
  stripePlusPriceId: "STRIPE_PLUS_PRICE_ID",
  appBaseUrl: "POCKETPULSE_APP_BASE_URL",
  trialDays: "POCKETPULSE_PLUS_TRIAL_DAYS",
} as const;

export type BillingConfig =
  | { enabled: false }
  | {
      enabled: true;
      provider: "stripe";
      stripeSecretKey: string;
      stripeWebhookSecret: string;
      stripePlusPriceId: string;
      appBaseUrl: string;
      trialDays: number;
    };

export class InvalidBillingConfigError extends Error {
  readonly code = "INVALID_BILLING_CONFIG" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidBillingConfigError";
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new InvalidBillingConfigError(`${name} is required when billing is enabled`);
  return value;
}

export function getBillingConfig(
  env: NodeJS.ProcessEnv = process.env,
): BillingConfig {
  const enabled = env[BILLING_ENV.enabled]?.trim();
  if (!enabled || enabled === "false") return { enabled: false };
  if (enabled !== "true") {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.enabled} must be exactly "true" or "false"`,
    );
  }

  const stripeSecretKey = required(env, BILLING_ENV.stripeSecretKey);
  if (!stripeSecretKey.startsWith("sk_test_")) {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.stripeSecretKey} must be a Stripe sandbox key for Slice 6`,
    );
  }
  const stripeWebhookSecret = required(env, BILLING_ENV.stripeWebhookSecret);
  if (!stripeWebhookSecret.startsWith("whsec_")) {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.stripeWebhookSecret} must be a Stripe webhook signing secret`,
    );
  }
  const stripePlusPriceId = required(env, BILLING_ENV.stripePlusPriceId);
  if (!stripePlusPriceId.startsWith("price_")) {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.stripePlusPriceId} must be a Stripe Price id`,
    );
  }

  const appBaseUrl = required(env, BILLING_ENV.appBaseUrl).replace(/\/$/, "");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(appBaseUrl);
  } catch {
    throw new InvalidBillingConfigError(`${BILLING_ENV.appBaseUrl} must be an absolute URL`);
  }
  const localHttp =
    parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
  if (parsedUrl.protocol !== "https:" && !localHttp) {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.appBaseUrl} must use HTTPS outside localhost`,
    );
  }

  const rawTrialDays = env[BILLING_ENV.trialDays]?.trim() || "7";
  const trialDays = Number(rawTrialDays);
  if (!Number.isSafeInteger(trialDays) || trialDays < 1 || trialDays > 30) {
    throw new InvalidBillingConfigError(
      `${BILLING_ENV.trialDays} must be an integer from 1 through 30`,
    );
  }

  return {
    enabled: true,
    provider: "stripe",
    stripeSecretKey,
    stripeWebhookSecret,
    stripePlusPriceId,
    appBaseUrl,
    trialDays,
  };
}
