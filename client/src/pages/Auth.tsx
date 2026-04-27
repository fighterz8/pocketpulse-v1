import { FormEvent, useEffect, useState } from "react";
import { Hint, HintIcon } from "../components/ui/tooltip";
import { useAuth } from "../hooks/use-auth";
import { apiFetch, readJsonError } from "../lib/api";
import { DEV_MODE_ENABLED } from "@shared/devConfig";
import { PASSWORD_RESET_SUCCESS_FLAG } from "./ResetPassword";

type Mode = "login" | "register" | "forgot";

export function Auth({ inactivityLogout = false }: { inactivityLogout?: boolean }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [isBetaTester, setIsBetaTester] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Forgot-password sub-state. Kept inline rather than in its own component
  // so the screen still feels like one continuous auth surface.
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSubmitted, setForgotSubmitted] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  // Pick up the success flag set by ResetPassword after a successful reset
  // and surface it once. Cleared immediately so a refresh doesn't replay it.
  const [resetSuccess, setResetSuccess] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PASSWORD_RESET_SUCCESS_FLAG) === "1") {
        window.localStorage.removeItem(PASSWORD_RESET_SUCCESS_FLAG);
        setResetSuccess(true);
      }
    } catch {
      /* localStorage unavailable — silent */
    }
  }, []);

  const activeMutation = mode === "login" ? login : register;
  const mutationError =
    mode !== "forgot" && activeMutation.error instanceof Error
      ? activeMutation.error.message
      : null;
  const shownError = formError ?? mutationError;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (mode === "forgot") {
      setForgotError(null);
      if (!email.trim()) {
        setForgotError("Please enter your email address.");
        return;
      }
      setForgotBusy(true);
      try {
        const res = await apiFetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (!res.ok) {
          setForgotError(await readJsonError(res));
          return;
        }
        setForgotSubmitted(true);
      } catch (err) {
        setForgotError(
          err instanceof Error ? err.message : "Something went wrong.",
        );
      } finally {
        setForgotBusy(false);
      }
      return;
    }

    activeMutation.reset();

    try {
      if (mode === "login") {
        await login.mutateAsync({ email, password });
      } else {
        if (!displayName.trim()) {
          setFormError("Display name is required");
          return;
        }
        await register.mutateAsync({
          email,
          password,
          displayName: displayName.trim(),
          companyName: companyName.trim() || undefined,
          isDev: DEV_MODE_ENABLED && isBetaTester,
        });
      }
    } catch {
      /* surfaced via mutation.error */
    }
  }

  const busy =
    mode === "forgot" ? forgotBusy : activeMutation.isPending;

  function switchTo(next: Mode) {
    setMode(next);
    setFormError(null);
    setForgotError(null);
    setForgotSubmitted(false);
    login.reset();
    register.reset();
  }

  return (
    <main className="app-main auth-main auth-main--centered auth-main--editorial">
      <div className="auth-card auth-card--capture">
        <div className="auth-brand-row">
          <span className="auth-brand">PocketPulse</span>
          <span className="auth-brand-dot" aria-hidden="true" />
        </div>
        <h1 className="auth-title">
          {mode === "login"
            ? "Sign in"
            : mode === "register"
              ? "Create account"
              : "Reset your password"}
        </h1>

        {inactivityLogout && (
          <p className="auth-inactivity-notice" role="status" data-testid="inactivity-notice">
            You were logged out due to inactivity.
          </p>
        )}

        {resetSuccess && mode === "login" ? (
          <p
            className="auth-inactivity-notice"
            role="status"
            data-testid="text-reset-success-notice"
          >
            Your password has been updated. Please sign in with your new
            password.
          </p>
        ) : null}

        {mode === "forgot" && forgotSubmitted ? (
          <p
            className="auth-inactivity-notice"
            role="status"
            data-testid="text-forgot-submitted"
          >
            If an account exists for that email, we've sent reset
            instructions. Check your inbox (and your spam folder) — the link
            expires in 30 minutes.
          </p>
        ) : (
          <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
            <label className="auth-field">
              <span className="auth-label">Email</span>
              <input
                className="auth-input"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={busy}
                data-testid="input-email"
              />
            </label>

            {mode !== "forgot" ? (
              <label className="auth-field">
                <span className="auth-label">
                  Password
                  <HintIcon
                    label="About passwords"
                    content="At least 8 characters. We hash it with bcrypt — we never store or see your plaintext password."
                    data-testid="hint-password"
                  />
                </span>
                <input
                  className="auth-input"
                  type="password"
                  name="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={busy}
                  data-testid="input-password"
                />
              </label>
            ) : null}

            {mode === "register" ? (
              <>
                <label className="auth-field">
                  <span className="auth-label">Display name</span>
                  <input
                    className="auth-input"
                    type="text"
                    name="displayName"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="auth-field">
                  <span className="auth-label">Company (optional)</span>
                  <input
                    className="auth-input"
                    type="text"
                    name="companyName"
                    autoComplete="organization"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    disabled={busy}
                  />
                </label>
                {DEV_MODE_ENABLED ? (
                  <label className="auth-field auth-field--check" data-testid="label-beta-tester">
                    <input
                      className="auth-checkbox"
                      type="checkbox"
                      name="isBetaTester"
                      checked={isBetaTester}
                      onChange={(e) => setIsBetaTester(e.target.checked)}
                      disabled={busy}
                      data-testid="checkbox-beta-tester"
                    />
                    <span className="auth-label auth-label--check">
                      Register as a beta tester
                      <HintIcon
                        label="About beta testing"
                        content="Beta testers get early access to new features and may receive occasional feedback requests."
                        data-testid="hint-beta-tester"
                      />
                      <span className="auth-label-hint">Enables the Accuracy Report feature for research purposes</span>
                    </span>
                  </label>
                ) : null}
              </>
            ) : null}

            {mode === "forgot" && forgotError ? (
              <p className="auth-error" role="alert" data-testid="text-forgot-error">
                {forgotError}
              </p>
            ) : null}

            {mode !== "forgot" && shownError ? (
              <p className="auth-error" role="alert">
                {shownError}
              </p>
            ) : null}

            <button
              className="auth-submit"
              type="submit"
              disabled={busy}
              data-testid={
                mode === "forgot" ? "button-send-reset" : undefined
              }
            >
              {busy
                ? "Please wait…"
                : mode === "login"
                  ? "Sign in"
                  : mode === "register"
                    ? "Create account"
                    : "Send reset link"}
            </button>
          </form>
        )}

        {mode === "login" ? (
          <div className="auth-switch auth-switch--forgot">
            <Hint
              content="We'll email you a one-time link valid for 30 minutes."
              data-testid="hint-forgot-password"
            >
              <button
                type="button"
                className="auth-linkish"
                onClick={() => switchTo("forgot")}
                data-testid="link-forgot-password"
              >
                Forgot password?
              </button>
            </Hint>
          </div>
        ) : null}

        <div className="auth-switch">
          {mode === "login" ? (
            <button
              type="button"
              className="auth-linkish"
              onClick={() => switchTo("register")}
            >
              Create an account
            </button>
          ) : mode === "register" ? (
            <button
              type="button"
              className="auth-linkish"
              onClick={() => switchTo("login")}
            >
              Already have an account? Sign in
            </button>
          ) : (
            <button
              type="button"
              className="auth-linkish"
              onClick={() => switchTo("login")}
              data-testid="link-back-to-signin-from-forgot"
            >
              ← Back to sign in
            </button>
          )}
        </div>

        <button
          type="button"
          className="auth-beta-reset"
          data-testid="button-beta-reset"
          onClick={() => {
            localStorage.removeItem("pp_beta_access");
            window.location.reload();
          }}
        >
          ← Back to coming soon
        </button>
      </div>
    </main>
  );
}
