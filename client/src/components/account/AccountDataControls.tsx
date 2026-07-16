import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch, readJsonError } from "../../lib/api";
import { clearImportedDataQueries } from "../../lib/financialDataQueries";

type AccountDataControlsProps = {
  hasLiveBilling: boolean;
  onAccountDeleted: () => void;
};

export function AccountDataControls({
  hasLiveBilling,
  onAccountDeleted,
}: AccountDataControlsProps) {
  const queryClient = useQueryClient();
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [wipeComplete, setWipeComplete] = useState(false);
  const deleteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (deleteConfirm) deleteInputRef.current?.focus();
  }, [deleteConfirm]);

  const wipeData = useMutation({
    mutationFn: async () => {
      const response = await apiFetch("/api/transactions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(await readJsonError(response));
      return response.json();
    },
    onSuccess: () => {
      // Imported rows and uploads are gone, so discard every derived cache
      // before the user can navigate back to a financial page.
      clearImportedDataQueries(queryClient);
      setWipeConfirm(false);
      setWipeComplete(true);
    },
  });

  const deleteAccount = useMutation({
    mutationFn: async () => {
      const response = await apiFetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!response.ok) throw new Error(await readJsonError(response));
      return response.json();
    },
    onSuccess: () => {
      queryClient.clear();
      onAccountDeleted();
    },
  });

  const actionError = wipeData.error ?? deleteAccount.error;

  return (
    <section className="glass-card account-data-controls" aria-labelledby="data-controls-title">
      <div className="account-data-controls-header">
        <p className="account-card-kicker">Privacy and ownership</p>
        <h2 id="data-controls-title">Data controls</h2>
        <p>
          Export a transaction backup, remove imported activity, or permanently
          delete your PocketPulse account.
        </p>
      </div>

      <div className="account-data-controls-grid">
        <article className="account-data-control">
          <h3>Transaction data</h3>
          <p>Download your Ledger or remove every transaction and upload while keeping your account setup.</p>
          <div className="account-data-control-actions">
            <a className="account-data-link" href="/api/transactions/export">
              Export transaction CSV
            </a>
            {!wipeConfirm ? (
              <button
                type="button"
                className="account-danger-btn account-danger-btn--warn"
                onClick={() => {
                  setWipeComplete(false);
                  setWipeConfirm(true);
                }}
                disabled={wipeData.isPending || deleteAccount.isPending}
              >
                Wipe imported data
              </button>
            ) : (
              <div className="account-danger-confirm">
                <p id="wipe-data-warning">
                  This permanently deletes all imported transactions and uploads.
                  Your PocketPulse account and financial-account labels remain.
                </p>
                <div className="account-danger-confirm-actions">
                  <button
                    type="button"
                    className="account-danger-btn account-danger-btn--destructive"
                    aria-describedby="wipe-data-warning"
                    onClick={() => wipeData.mutate()}
                    disabled={wipeData.isPending}
                  >
                    {wipeData.isPending ? "Deleting imported data…" : "Confirm data wipe"}
                  </button>
                  <button
                    type="button"
                    className="account-danger-btn account-danger-btn--cancel"
                    onClick={() => setWipeConfirm(false)}
                    disabled={wipeData.isPending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {wipeComplete ? <p className="account-data-status" role="status">Imported data deleted.</p> : null}
          </div>
        </article>

        <article className="account-data-control account-data-control--delete">
          <h3>Delete PocketPulse account</h3>
          <p>
            Permanently removes your sign-in, preferences, accounts, uploads, and
            transactions. Privacy-minimized service records may remain without a
            link to your identity.
          </p>
          {hasLiveBilling ? (
            <p className="account-data-note">
              Cancel Plus and wait until access ends before deleting your account.
            </p>
          ) : null}
          {!deleteConfirm ? (
            <button
              type="button"
              className="account-danger-btn account-danger-btn--warn"
              onClick={() => setDeleteConfirm(true)}
              disabled={hasLiveBilling || wipeData.isPending || deleteAccount.isPending}
            >
              Delete account
            </button>
          ) : (
            <form
              className="account-danger-confirm"
              onSubmit={(event) => {
                event.preventDefault();
                if (deleteText === "DELETE") deleteAccount.mutate();
              }}
            >
              <p id="delete-account-warning">
                This cannot be undone. Type <strong>DELETE</strong> to confirm.
              </p>
              <label className="account-delete-label" htmlFor="delete-account-confirmation">
                Type DELETE to confirm
              </label>
              <input
                ref={deleteInputRef}
                id="delete-account-confirmation"
                className="account-delete-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={deleteText}
                onChange={(event) => setDeleteText(event.target.value)}
                disabled={deleteAccount.isPending}
              />
              <div className="account-danger-confirm-actions">
                <button
                  type="submit"
                  className="account-danger-btn account-danger-btn--destructive"
                  aria-describedby="delete-account-warning"
                  disabled={deleteText !== "DELETE" || deleteAccount.isPending}
                >
                  {deleteAccount.isPending ? "Deleting account…" : "Permanently delete account"}
                </button>
                <button
                  type="button"
                  className="account-danger-btn account-danger-btn--cancel"
                  onClick={() => {
                    setDeleteConfirm(false);
                    setDeleteText("");
                  }}
                  disabled={deleteAccount.isPending}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </article>
      </div>

      {actionError ? <p className="account-action-error" role="alert">{actionError.message}</p> : null}
    </section>
  );
}
