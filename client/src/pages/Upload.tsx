import { FormEvent, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "../hooks/use-auth";
import { useUploads } from "../hooks/use-uploads";
import { Hint } from "../components/ui/tooltip";
import { UploadCore } from "./UploadCore";

function formatUploadDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Upload page wrapper.
 *
 * The actual dropzone / queue / import logic lives in `UploadCore` so
 * the onboarding flow can embed it without duplicating logic. This page
 * adds:
 *   - The "create your first bank account" gate (rendered in place of
 *     the dropzone when the user has zero accounts). This stays at the
 *     page level so onboarding — which already has its own dedicated
 *     bank-account step — doesn't double-render it.
 *   - The page title.
 *   - The past-imports history list at the bottom.
 */
export function Upload() {
  const { accounts, accountsLoading } = useAuth();
  const { uploads } = useUploads();

  const hasAccounts = accounts !== null && accounts.length > 0;

  return (
    <>
      <motion.h1
        className="app-page-title"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <svg
          className="page-title-icon"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13V4M6.5 7.5 10 4l3.5 3.5" />
          <path d="M3 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" />
        </svg>
        Upload Statements
      </motion.h1>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.07 }}
      >
        {accountsLoading && !accounts ? (
          <p className="app-placeholder" data-testid="upload-loading-accounts">
            Loading your accounts…
          </p>
        ) : hasAccounts ? (
          <UploadCore
            accounts={accounts!}
            dropzoneHintContent="Drop one or more bank-statement CSVs here. We'll detect the columns automatically and let you preview each file before importing."
          />
        ) : (
          <BankAccountGate />
        )}
      </motion.div>

      {/* Past imports — only rendered when we actually have any. */}
      {uploads && uploads.length > 0 && (
        <motion.div
          className="upload-history glass-card"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.14 }}
          data-testid="upload-history"
        >
          <h2 className="upload-history-title">Past Imports</h2>
          <ul className="upload-history-list">
            {uploads.map((u) => {
              const acct = accounts?.find((a) => a.id === u.accountId);
              return (
                <li
                  key={u.id}
                  className="upload-history-item"
                  data-testid={`row-upload-${u.id}`}
                >
                  <span
                    className="upload-history-filename"
                    data-testid={`text-upload-filename-${u.id}`}
                  >
                    {u.filename}
                  </span>
                  <span className="upload-history-meta">
                    <span data-testid={`text-upload-account-${u.id}`}>
                      {acct ? acct.label : "Unknown account"}
                    </span>
                    <span className="upload-history-sep">&middot;</span>
                    <span data-testid={`text-upload-rows-${u.id}`}>
                      {u.rowCount} row{u.rowCount !== 1 ? "s" : ""}
                    </span>
                    <span className="upload-history-sep">&middot;</span>
                    <span data-testid={`text-upload-date-${u.id}`}>
                      {formatUploadDate(u.uploadedAt)}
                    </span>
                  </span>
                  <Hint
                    content={
                      u.status === "complete"
                        ? "All rows in this file were imported successfully."
                        : u.status === "processing"
                        ? "We're still importing rows from this file."
                        : "Something went wrong importing this file. Try re-uploading it."
                    }
                    data-testid={`hint-upload-status-${u.id}`}
                  >
                    <span
                      className={`upload-history-badge upload-history-badge--${u.status}`}
                      data-testid={`status-upload-${u.id}`}
                      tabIndex={0}
                    >
                      {u.status === "complete" ? "Imported" : u.status}
                    </span>
                  </Hint>
                </li>
              );
            })}
          </ul>
        </motion.div>
      )}
    </>
  );
}

/**
 * Inline "Create your first bank account" gate. Replaces the dropzone
 * when the user has zero accounts, so they're never staring at a
 * disabled dropzone with a confusing "select an account" error.
 *
 * Successful creation invalidates the accounts query (handled in
 * `useAuth.createAccount.onSuccess`) — this gate then auto-disappears
 * because `hasAccounts` flips to true on the next render.
 */
function BankAccountGate() {
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
      await createAccount.mutateAsync({
        label: trimmed,
        ...(lastFour !== "" ? { lastFour } : {}),
        ...(accountType.trim() !== ""
          ? { accountType: accountType.trim() }
          : {}),
      });
      // Success: the accounts cache refreshes and the parent re-renders
      // with the dropzone in place. Nothing else to do here.
    } catch {
      /* shown via mutationError */
    }
  }

  return (
    <div
      className="upload-account-gate glass-card"
      data-testid="upload-account-gate"
    >
      <h2 className="upload-account-gate-title">
        Add a bank account first
      </h2>
      <p className="upload-account-gate-subtitle">
        PocketPulse needs at least one bank account so it knows where your
        transactions came from. Create one below — you can add more later.
      </p>

      <form
        className="upload-account-gate-form"
        onSubmit={(e) => void onSubmit(e)}
      >
        <label className="upload-account-gate-field">
          <span className="upload-account-gate-label">Account name</span>
          <input
            className="upload-account-gate-input"
            type="text"
            name="label"
            placeholder="e.g. Chase Checking, Business Visa"
            autoComplete="off"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            disabled={busy}
            data-testid="input-gate-account-label"
          />
        </label>

        <div className="upload-account-gate-row">
          <label className="upload-account-gate-field">
            <span className="upload-account-gate-label">
              Last four digits (optional)
            </span>
            <input
              className="upload-account-gate-input"
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
              data-testid="input-gate-account-last-four"
            />
          </label>

          <label className="upload-account-gate-field">
            <span className="upload-account-gate-label">
              Account type (optional)
            </span>
            <input
              className="upload-account-gate-input"
              type="text"
              name="accountType"
              placeholder="e.g. checking, savings, cash"
              autoComplete="off"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              disabled={busy}
              data-testid="input-gate-account-type"
            />
          </label>
        </div>

        {shownError ? (
          <p
            className="upload-account-gate-error"
            role="alert"
            data-testid="error-gate-account"
          >
            {shownError}
          </p>
        ) : null}

        <button
          type="submit"
          className="upload-btn upload-btn--primary"
          disabled={busy}
          data-testid="button-gate-create-account"
        >
          {busy ? "Creating…" : "Create account & continue"}
        </button>
      </form>

      {/* Disabled-dropzone visual underneath so the user can see what's
          coming next once they finish the form. */}
      <div
        className="upload-dropzone upload-dropzone--disabled"
        aria-disabled="true"
        data-testid="upload-dropzone-disabled"
      >
        <p className="upload-dropzone-text">Drop CSV files here</p>
        <p className="upload-dropzone-hint">
          Available after you create your first account.
        </p>
      </div>
    </div>
  );
}
