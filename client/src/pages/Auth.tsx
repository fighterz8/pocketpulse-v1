import { FormEvent, useState } from "react";
import { useAuth } from "../hooks/use-auth";

type Mode = "login" | "register";

export function Auth() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const activeMutation = mode === "login" ? login : register;
  const mutationError =
    activeMutation.error instanceof Error
      ? activeMutation.error.message
      : null;
  const shownError = formError ?? mutationError;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
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
        });
      }
    } catch {
      /* surfaced via mutation.error */
    }
  }

  const busy = activeMutation.isPending;

  return (
    <main className="app-main auth-main">
      <div className="auth-card">
        <h1 className="auth-title">
          {mode === "login" ? "Sign in" : "Create account"}
        </h1>

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
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">Password</span>
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
            />
          </label>

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
            </>
          ) : null}

          {shownError ? (
            <p className="auth-error" role="alert">
              {shownError}
            </p>
          ) : null}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "login" ? (
            <button
              type="button"
              className="auth-linkish"
              onClick={() => {
                setMode("register");
                setFormError(null);
                login.reset();
              }}
            >
              Create an account
            </button>
          ) : (
            <button
              type="button"
              className="auth-linkish"
              onClick={() => {
                setMode("login");
                setFormError(null);
                register.reset();
              }}
            >
              Already have an account? Sign in
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
