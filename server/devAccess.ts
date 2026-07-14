import { normalizeEmail } from "./auth.js";
import type { PublicUser } from "./public-user.js";

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function allowedDevEmails(): Set<string> {
  const raw = process.env.POCKETPULSE_DEV_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter((email) => email.includes("@")),
  );
}

export function isDevToolsEnabled(): boolean {
  return envFlag(process.env.POCKETPULSE_DEV_TOOLS);
}

export function isDevEmailAllowed(email: string): boolean {
  return allowedDevEmails().has(normalizeEmail(email));
}

export function hasDevToolsAccess(user: PublicUser): boolean {
  return isDevToolsEnabled() && (user.isDev === true || isDevEmailAllowed(user.email));
}

export type AuthUserPayload = PublicUser & {
  devToolsEnabled: boolean;
};

export function toAuthUserPayload(user: PublicUser): AuthUserPayload {
  return {
    ...user,
    isDev: hasDevToolsAccess(user),
    devToolsEnabled: isDevToolsEnabled(),
  };
}
