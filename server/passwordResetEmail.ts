/**
 * PocketPulse password reset email — HTML + plain text templates sent
 * after a successful POST /api/auth/forgot-password. Mirrors the dark
 * navy launch-email styling so the brand stays consistent and the
 * hosted WebP logo (https://pocket-pulse.com/email-logo.webp) is reused.
 *
 * The CTA URL is injected per-message because each token is one-time.
 */
export function buildPasswordResetEmailHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your PocketPulse password</title>
</head>

<body style="margin:0;padding:0;background:#080d18;font-family:Inter,Arial,'Segoe UI',sans-serif;color:#e5e7eb;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;">
    Reset your PocketPulse password — link expires in 30 minutes.
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#080d18;padding:42px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:620px;border-radius:24px;background:#0d1424;border:1px solid rgba(148,163,184,0.22);box-shadow:0 28px 80px rgba(0,0,0,0.42);overflow:hidden;">
          <tr>
            <td style="padding:0;background:linear-gradient(145deg,#101827 0%,#0b1220 48%,#172d58 100%);">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="padding:54px 42px 42px;">

                    <table cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin:0 auto 36px;">
                      <tr>
                        <td valign="middle" style="padding-right:14px;">
                          <img src="https://pocket-pulse.com/email-logo.webp" width="56" height="56" alt="PocketPulse logo" style="display:block;border-radius:15px;" />
                        </td>
                        <td valign="middle" style="font-size:34px;line-height:1;font-weight:800;letter-spacing:-1.2px;color:#f8fafc;text-align:left;">
                          PocketPulse
                        </td>
                      </tr>
                    </table>

                    <p style="margin:0 0 20px;font-size:12px;line-height:1;letter-spacing:6px;text-transform:uppercase;color:#7dd3fc;font-weight:800;">
                      Account Security
                    </p>

                    <h1 style="margin:0 0 18px;font-size:42px;line-height:1.08;font-weight:800;letter-spacing:-2px;color:#ffffff;">
                      Reset your password<span style="color:#3b82f6;">.</span>
                    </h1>

                    <p style="margin:0 auto 8px;font-size:17px;line-height:1.6;color:#cbd5e1;max-width:510px;">
                      We received a request to reset the password for your PocketPulse account. Click the button below to choose a new one.
                    </p>

                    <table cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin:32px auto 0;">
                      <tr>
                        <td align="center" bgcolor="#3b82f6" style="border-radius:14px;background:linear-gradient(135deg,#60a5fa 0%,#2563eb 100%);box-shadow:0 14px 34px rgba(37,99,235,0.36);">
                          <a href="${resetUrl}" style="display:inline-block;padding:17px 48px;font-size:18px;line-height:1;font-weight:800;color:#ffffff;text-decoration:none;border-radius:14px;">
                            Reset Password
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin:18px 0 0;font-size:14px;line-height:1.5;color:#94a3b8;">
                      This link expires in 30 minutes and can be used once.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:34px auto 0;max-width:500px;">
                      <tr>
                        <td style="padding:18px 20px;background:rgba(15,23,42,0.58);border:1px solid rgba(148,163,184,0.18);border-radius:14px;font-size:13px;line-height:1.55;color:#94a3b8;text-align:left;">
                          If the button doesn't work, copy and paste this URL into your browser:
                          <br /><br />
                          <span style="word-break:break-all;color:#cbd5e1;">${resetUrl}</span>
                        </td>
                      </tr>
                    </table>

                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:32px auto 0;max-width:500px;">
                      <tr>
                        <td style="height:1px;background:rgba(148,163,184,0.16);line-height:1px;font-size:1px;">&nbsp;</td>
                      </tr>
                    </table>

                    <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#94a3b8;">
                      If you didn't request a password reset, you can safely ignore this email — your password will stay the same.
                    </p>

                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildPasswordResetEmailText(resetUrl: string): string {
  return `Reset your PocketPulse password.

We received a request to reset the password for your PocketPulse account. Use the link below to choose a new one:

${resetUrl}

This link expires in 30 minutes and can only be used once.

If you didn't request a password reset, you can safely ignore this email — your password will stay the same.

—
PocketPulse`;
}
