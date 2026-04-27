import { FormEvent, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { apiFetch, readJsonError } from "../lib/api";

/**
 * Standalone "set new password" screen reached from the password reset
 * email. Runs outside the normal AppGate flow because the user is, by
 * definition, not signed in (and may even be on a fresh device).
 *
 * The token comes in via the `?token=…` query string. After a successful
 * reset we hard-redirect to `/` with a localStorage flag the Auth screen
 * picks up to render the success notice — that way the new password is
 * confirmed via a real login attempt before we hand out a session cookie.
 */
export const PASSWORD_RESET_SUCCESS_FLAG = "pp_password_reset_success";

function readTokenFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  if (typeof t !== "string" || t.length === 0) return null;
  return t;
}

export function ResetPassword() {
  const [, setLocation] = useLocation();
  const token = useMemo(() => readTokenFromLocation(), []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // If we landed here without a token there's nothing to do — surface a
  // clear error rather than a confusingly-empty form.
  const noToken = token == null;

  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PASSWORD_RESET_SUCCESS_FLAG, "1");
      } catch {
        /* localStorage may be disabled — the success state still shows */
      }
      setLocation("/");
    }, 1800);
    return () => window.clearTimeout(t);
  }, [success, setLocation]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError("Reset link is missing or invalid.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const res = await apiFetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!res.ok) {
        setError(await readJsonError(res));
        return;
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-main auth-main auth-main--centered auth-main--editorial">
      <div className="auth-card auth-card--capture">
        <div className="auth-brand-row">
          <span className="auth-brand">PocketPulse</span>
          <span className="auth-brand-dot" aria-hidden="true" />
        </div>
        <h1 className="auth-title" data-testid="text-reset-password-title">
          Set a new password
        </h1>

        {noToken ? (
          <p className="auth-error" role="alert" data-testid="text-reset-no-token">
            This reset link is missing or invalid. Please request a new one
            from the sign-in screen.
          </p>
        ) : success ? (
          <p
            className="auth-inactivity-notice"
            role="status"
            data-testid="text-reset-success"
          >
            Your password has been updated. Redirecting you to sign in…
          </p>
        ) : (
          <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
            <label className="auth-field">
              <span className="auth-label">New password</span>
              <input
                className="auth-input"
                type="password"
                name="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                disabled={busy}
                data-testid="input-new-password"
              />
              <span className="auth-label-hint">At least 8 characters.</span>
            </label>

            <label className="auth-field">
              <span className="auth-label">Confirm password</span>
              <input
                className="auth-input"
                type="password"
                name="confirm"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                disabled={busy}
                data-testid="input-confirm-password"
              />
            </label>

            {error ? (
              <p className="auth-error" role="alert" data-testid="text-reset-error">
                {error}
              </p>
            ) : null}

            <button
              className="auth-submit"
              type="submit"
              disabled={busy}
              data-testid="button-reset-password"
            >
              {busy ? "Updating…" : "Update password"}
            </button>
          </form>
        )}

        <div className="auth-switch">
          <button
            type="button"
            className="auth-linkish"
            onClick={() => setLocation("/")}
            data-testid="link-back-to-signin"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    </main>
  );
}
