import { motion } from "framer-motion";
import { Hint } from "../components/ui/tooltip";
import type { AuthAccount } from "../hooks/use-auth";
import type { UploadFileResult } from "../hooks/use-uploads";
import { UploadCore } from "./UploadCore";

export const ONBOARDING_UPLOAD_SUCCESS_FLAG = "pp_onboarding_upload_count";

export type OnboardingUploadProps = {
  /** Just-created account to preselect in the upload UI. */
  account: AuthAccount;
  /** Called after a successful import (or when user clicks "Continue"). */
  onDone: () => void;
  /** Called when the user clicks "Skip for now". */
  onSkip: () => void;
};

export function OnboardingUpload({
  account,
  onDone,
  onSkip,
}: OnboardingUploadProps) {
  function handleImportComplete(results: UploadFileResult[]) {
    const totalRows = results
      .filter((r) => r.status === "complete")
      .reduce((sum, r) => sum + r.rowCount, 0);
    if (totalRows > 0) {
      localStorage.setItem(
        ONBOARDING_UPLOAD_SUCCESS_FLAG,
        String(totalRows),
      );
    }
  }

  return (
    <main className="app-main auth-main auth-main--centered auth-main--editorial">
      <motion.div
        className="auth-card auth-card--capture onboarding-card onboarding-card--wide"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <p
          className="onboarding-step-pill"
          data-testid="text-onboarding-step"
        >
          Step 2 of 2
        </p>
        <div className="auth-brand-row">
          <span className="auth-brand">PocketPulse</span>
          <span
            className="auth-brand-dot auth-brand-dot--success"
            aria-hidden="true"
          />
        </div>
        <h1
          className="auth-title"
          data-testid="text-onboarding-upload-title"
        >
          Now bring in your transactions
        </h1>
        <p className="auth-subtitle">
          Drop a CSV from <strong>{account.label}</strong>
          {account.lastFour ? ` (••••${account.lastFour})` : ""} — we'll
          handle the rest.
        </p>

        <UploadCore
          accounts={[account]}
          onImportComplete={handleImportComplete}
          onAllImportsDismissed={onDone}
          dismissButtonLabel="Continue to dashboard"
          dropzoneHintContent="Most US banks (Chase, Amex, BofA, Citi, Discover, Capital One) export ready-to-use CSVs from their statement page."
        />

        <Hint
          content="You can upload anytime from the Upload page."
          data-testid="hint-skip-step-2"
        >
          <button
            type="button"
            className="onboarding-skip-link onboarding-skip-link--block"
            onClick={onSkip}
            data-testid="link-skip-onboarding-step-2"
          >
            Skip for now
          </button>
        </Hint>
      </motion.div>
    </main>
  );
}
