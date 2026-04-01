import { FormEvent, useState } from "react";
import { useAuth } from "../hooks/use-auth";

export function AccountSetup() {
  const { createAccount } = useAuth();
  const [label, setLabel] = useState("");
  const [lastFour, setLastFour] = useState("");
  const [accountType, setAccountType] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const mutationError =
    createAccount.error instanceof Error
      ? createAccount.error.message
      : null;
  const shownError = formError ?? mutationError;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    createAccount.reset();

    const trimmed = label.trim();
    if (!trimmed) {
      setFormError("Account name is required");
      return;
    }

    try {
      await createAccount.mutateAsync({
        label: trimmed,
        ...(lastFour !== "" ? { lastFour } : {}),
        ...(accountType.trim() !== ""
          ? { accountType: accountType.trim() }
          : {}),
      });
    } catch {
      // Error is shown via createAccount.error (mutation state), not thrown to the UI here.
    }
  }

  const busy = createAccount.isPending;

  return (
    <main className="app-main auth-main auth-main--centered auth-main--editorial">
      <div className="auth-card auth-card--capture">
        <div className="auth-brand-row">
          <span className="auth-brand">PocketPulse</span>
          <span className="auth-brand-dot auth-brand-dot--success" aria-hidden="true" />
        </div>
        <h1 className="auth-title">Set up your first account</h1>

        <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="auth-field">
            <span className="auth-label">Account name</span>
            <input
              className="auth-input"
              type="text"
              name="label"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              disabled={busy}
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">Last four digits (optional)</span>
            <input
              className="auth-input"
              type="text"
              name="lastFour"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={lastFour}
              onChange={(e) =>
                setLastFour(e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              disabled={busy}
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">Account type (optional)</span>
            <input
              className="auth-input"
              type="text"
              name="accountType"
              placeholder="e.g. checking, cash"
              autoComplete="off"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              disabled={busy}
            />
          </label>

          {shownError ? (
            <p className="auth-error" role="alert">
              {shownError}
            </p>
          ) : null}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}
