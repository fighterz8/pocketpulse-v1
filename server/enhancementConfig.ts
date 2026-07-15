export const ENHANCEMENT_FLAG_NAMES = {
  transactionEnhancement: "POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED",
  csvFormatAssistance: "POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED",
  fullReclassification: "POCKETPULSE_FULL_RECLASSIFY_ENABLED",
} as const;

export type EnhancementFeatureFlags = {
  transactionEnhancement: boolean;
  csvFormatAssistance: boolean;
  fullReclassification: boolean;
};

export class InvalidEnhancementFlagError extends Error {
  readonly code = "INVALID_ENHANCEMENT_FLAG" as const;

  constructor(name: string, value: string) {
    super(`${name} must be exactly "true" or "false"; received ${JSON.stringify(value)}`);
    this.name = "InvalidEnhancementFlagError";
  }
}

function readSafeBooleanFlag(
  name: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const value = env[name];
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidEnhancementFlagError(name, value);
}

/**
 * Paid capabilities are opt-in and fail closed. Merely configuring an API key
 * never enables provider traffic.
 */
export function getEnhancementFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): EnhancementFeatureFlags {
  return {
    transactionEnhancement: readSafeBooleanFlag(
      ENHANCEMENT_FLAG_NAMES.transactionEnhancement,
      env,
    ),
    csvFormatAssistance: readSafeBooleanFlag(
      ENHANCEMENT_FLAG_NAMES.csvFormatAssistance,
      env,
    ),
    fullReclassification: readSafeBooleanFlag(
      ENHANCEMENT_FLAG_NAMES.fullReclassification,
      env,
    ),
  };
}
