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
        ...(lastFour !== "" ? { lastFour } : {}),
        ...(accountType.trim() !== ""
          ? { accountType: accountType.trim() }
          : {}),
      });
      onCreated(result.account);
    } catch {
      /* shown via mutationError */
    }
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
          lastFour={lastFour}
          accountType={accountType}
        />

        <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="auth-field">
            <span className="auth-label">
              Nickname for this account (e.g. Chase Checking, Amex Gold)
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
              Last 4 digits — optional, helps you tell similar cards apart
              <HintIcon
                label="About last 4 digits"
                content="Optional. Helps you tell apart multiple cards from the same bank — handy if you have, say, two Chase cards."
                data-testid="hint-last-four"
              />
            </span>
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
              data-testid="input-account-last-four"
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
      </div>
    </main>
  );
}

function AccountPreview({
  label,
  lastFour,
  accountType,
}: {
  label: string;
  lastFour: string;
  accountType: string;
}) {
  const shownLabel = label.trim() === "" ? "Your account" : label.trim();
  const last4Display =
    lastFour.length === 4 ? `•••• ${lastFour}` : "•••• ••••";
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
      <span
        className="account-preview-digits"
        data-testid="text-preview-digits"
      >
        {last4Display}
      </span>
    </div>
  );
}
