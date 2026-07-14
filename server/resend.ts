/**
 * Resend email client.
 *
 * Vercel/portable deployments read static RESEND_* env vars. Replit can still
 * fall back to its connector service so the live app keeps working before DNS
 * cutover.
 */
import { Resend } from "resend";

let connectionSettings: any;

export function formatFromEmail(fromEmail: string): string {
  const trimmed = fromEmail.trim();
  return trimmed.includes("<") ? trimmed : `PocketPulse <${trimmed}>`;
}

async function getCredentials(): Promise<{ apiKey: string; fromEmail: string }> {
  const envApiKey = process.env.RESEND_API_KEY;
  const envFromEmail = process.env.RESEND_FROM_EMAIL;
  if (envApiKey && envFromEmail) {
    return { apiKey: envApiKey, fromEmail: envFromEmail };
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.",
    );
  }

  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=resend",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    },
  )
    .then((res) => res.json())
    .then((data: any) => data.items?.[0]);

  if (!connectionSettings || !connectionSettings.settings.api_key) {
    throw new Error("Resend not connected");
  }

  return {
    apiKey: connectionSettings.settings.api_key,
    fromEmail: connectionSettings.settings.from_email,
  };
}

export async function getUncachableResendClient(): Promise<{
  client: Resend;
  fromEmail: string;
}> {
  const { apiKey, fromEmail } = await getCredentials();
  return { client: new Resend(apiKey), fromEmail };
}
