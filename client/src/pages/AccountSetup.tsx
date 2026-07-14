import { FormEvent, useState } from "react";
import { Hint, HintIcon } from "../components/ui/tooltip";
import { useAuth, type AuthAccount } from "../hooks/use-auth";

export type AccountSetupProps = {
  /**
   * Called after the bank account is created. Receives the account
   * object so the parent can pass exactly that account into Step 2
   * (rather than guessing via `accounts[0]`).
   */
  onCreated: (account: AuthAccount) => void;
  /** Called when the user clicks "Skip for now". */
  onSkip: () => void;
};

export function AccountSetup({ onCreated, onSkip }: AccountSetupProps) {
  const { createAccount, logout } = useAuth();
  const [label, setLabel] = useState("");
  const [accountType, setAccountType] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const mutationError =
    createAccount.error instanceof Error
      ? createAccount.error.message
      : null;
  const shownError = formError ?? mutationError;
  const busy = createAccount.isPending;

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
      const result = await createAccount.mutateAsync({
        label: trimmed,
        ...(accountType.trim() !== ""
          ? { accountType: accountType.trim() }
          : {}),
      });
      onCreated(result.account);
    } catch {
      /* shown via mutationError */
    }
  }

  function handleBackToLogin() {
    // AppGate's auth.isAuthenticated effect clears the per-session
    // onboarding flags as soon as logout flips meQuery to unauthenticated,
    // so we just trigger the mutation and let the gate fall through to
    // the Auth screen on its own.
    void logout.mutateAsync().catch(() => {
      /* logout failure leaves the user where they were — no special UX */
    });
  }

  return (
    <main className="app-main auth-main auth-main--centered auth-main--editorial">
      <div className="auth-card auth-card--capture onboarding-card">
        <p
          className="onboarding-step-pill"
          data-testid="text-onboarding-step"
        >
          Step 1 of 2
        </p>

        <div className="auth-brand-row">
          <span className="auth-brand">PocketPulse</span>
          <span className="auth-brand-dot auth-brand-dot--success" aria-hidden="true" />
        </div>
        <h1 className="auth-title" data-testid="text-account-setup-title">
          Add your first bank account
        </h1>
        <p className="auth-subtitle">
          PocketPulse organizes transactions by the bank or card they came
          from. Add your first one to get started — you can add more later.
        </p>

        <AccountPreview
          label={label}
          accountType={accountType}
        />

        <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="auth-field">
            <span className="auth-label">
              Nickname
              <HintIcon
                label="About the nickname"
                content="A short name you'll recognize, e.g. Chase Checking or Amex Gold. You can change it later."
                data-testid="hint-nickname"
              />
            </span>
            <input
              className="auth-input"
              type="text"
              name="label"
              placeholder="e.g. Chase Checking"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              disabled={busy}
              data-testid="input-account-label"
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">
              Account type
              <HintIcon
                label="About account type"
                content="Picking the right type helps PocketPulse classify transfers and recurring charges correctly."
                data-testid="hint-account-type"
              />
            </span>
            <select
              className="auth-input"
              name="accountType"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              disabled={busy}
              data-testid="input-account-type"
            >
              <option value="">Choose one (optional)…</option>
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
              <option value="credit card">Credit card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </select>
          </label>

          {shownError ? (
            <p
              className="auth-error"
              role="alert"
              data-testid="error-account-setup"
            >
              {shownError}
            </p>
          ) : null}

          <button
            className="auth-submit"
            type="submit"
            disabled={busy}
            data-testid="button-create-account"
          >
            {busy ? "Adding…" : "Add bank account"}
          </button>

          <Hint
            content="You can add a bank account anytime from the Upload page."
            data-testid="hint-skip-step-1"
          >
            <button
              type="button"
              className="onboarding-skip-link"
              onClick={onSkip}
              disabled={busy}
              data-testid="link-skip-onboarding-step-1"
            >
              Skip for now
            </button>
          </Hint>
        </form>

        <button
          type="button"
          className="auth-secondary-link onboarding-back-to-login"
          onClick={handleBackToLogin}
          disabled={busy || logout.isPending}
          data-testid="link-back-to-login"
        >
          ← Back to login
        </button>
      </div>
    </main>
  );
}

function AccountPreview({
  label,
  accountType,
}: {
  label: string;
  accountType: string;
}) {
  const shownLabel = label.trim() === "" ? "Your account" : label.trim();
  return (
    <div
      className="account-preview"
      role="img"
      aria-label="Preview of the bank account you're adding"
      data-testid="account-preview"
    >
      <div className="account-preview-top">
        <span className="account-preview-label" data-testid="text-preview-label">
          {shownLabel}
        </span>
        {accountType !== "" && (
          <span
            className="account-preview-type"
            data-testid="text-preview-type"
          >
            {accountType}
          </span>
        )}
      </div>
    </div>
  );
}
