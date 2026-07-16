export const PLUS_PLAN_ENV = {
  monthlyPriceCents: "POCKETPULSE_PLUS_MONTHLY_PRICE_CENTS",
  trialDays: "POCKETPULSE_PLUS_TRIAL_DAYS",
} as const;

export type PlusPlan = {
  key: "plus";
  name: "PocketPulse Plus";
  monthlyPriceCents: number;
  currency: "USD";
  interval: "month";
  trialDays: number;
};

export class InvalidPlusPlanConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlusPlanConfigError";
  }
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value?.trim() || String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidPlusPlanConfigError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return parsed;
}

export function getPlusPlan(env: NodeJS.ProcessEnv = process.env): PlusPlan {
  return {
    key: "plus",
    name: "PocketPulse Plus",
    monthlyPriceCents: parseInteger(
      env[PLUS_PLAN_ENV.monthlyPriceCents],
      500,
      PLUS_PLAN_ENV.monthlyPriceCents,
      100,
      100_000,
    ),
    currency: "USD",
    interval: "month",
    trialDays: parseInteger(
      env[PLUS_PLAN_ENV.trialDays],
      7,
      PLUS_PLAN_ENV.trialDays,
      1,
      30,
    ),
  };
}
