import { useCallback, useRef, useState } from "react";
import { useAuth, type AuthAccount } from "../hooks/use-auth";
import { useUploads, type UploadFileResult } from "../hooks/use-uploads";

type QueuedFile = {
  file: File;
  accountId: number | null;
  key: string;
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Upload() {
  const { accounts } = useAuth();
  const { upload } = useUploads();

  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [results, setResults] = useState<UploadFileResult[] | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const newFiles: QueuedFile[] = [];
      const errors: Record<string, string> = {};

      for (const file of Array.from(fileList)) {
        if (!file.name.toLowerCase().endsWith(".csv")) {
          errors[file.name] = `"${file.name}" is not a CSV file`;
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          errors[file.name] =
            `"${file.name}" exceeds the 5 MB size limit (${formatFileSize(file.size)})`;
          continue;
        }
        if (file.size === 0) {
          errors[file.name] = `"${file.name}" is empty`;
          continue;
        }

        const defaultAccount =
          accounts && accounts.length === 1 ? accounts[0]!.id : null;
        keyCounter.current += 1;
        newFiles.push({
          file,
          accountId: defaultAccount,
          key: `file-${keyCounter.current}`,
        });
      }

      if (Object.keys(errors).length > 0) {
        setValidationErrors((prev) => ({ ...prev, ...errors }));
      }
      if (newFiles.length > 0) {
        setQueue((prev) => [...prev, ...newFiles]);
        setResults(null);
      }
    },
    [accounts],
  );

  const removeFile = useCallback((key: string) => {
    setQueue((prev) => prev.filter((q) => q.key !== key));
    setValidationErrors({});
  }, []);

  const setAccountForFile = useCallback(
    (key: string, accountId: number) => {
      setQueue((prev) =>
        prev.map((q) => (q.key === key ? { ...q, accountId } : q)),
      );
    },
    [],
  );

  const canImport =
    queue.length > 0 &&
    queue.every((q) => q.accountId !== null) &&
    !upload.isPending;

  async function handleImport() {
    if (!canImport) return;

    setValidationErrors({});
    setResults(null);

    const metadata: Record<string, { accountId: number }> = {};
    for (const q of queue) {
      metadata[q.file.name] = { accountId: q.accountId! };
    }

    try {
      const response = await upload.mutateAsync({
        files: queue.map((q) => q.file),
        metadata,
      });
      setResults(response.results);
      setQueue([]);
    } catch {
      // Error state is handled via upload.error
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  const hasResults = results !== null && results.length > 0;
  const allSuccess = hasResults && results!.every((r) => r.status === "complete");
  const totalRows = hasResults
    ? results!.reduce((sum, r) => sum + r.rowCount, 0)
    : 0;

  return (
    <>
      <h1 className="app-page-title">Upload Statements</h1>

      {/* Results banner */}
      {hasResults && (
        <div className="upload-results" data-testid="upload-results">
          {allSuccess ? (
            <div className="upload-results-success">
              <p className="upload-results-headline">
                Import complete &mdash; {totalRows} transaction
                {totalRows !== 1 ? "s" : ""} added
              </p>
              <a href="/transactions" className="upload-results-link">
                Review in Ledger &rarr;
              </a>
            </div>
          ) : (
            <div className="upload-results-mixed">
              <p className="upload-results-headline">Import finished</p>
            </div>
          )}

          <ul className="upload-results-list">
            {results!.map((r, i) => (
              <li
                key={i}
                className={`upload-result-item upload-result-item--${r.status}`}
              >
                <span className="upload-result-filename">{r.filename}</span>
                {r.status === "complete" ? (
                  <span className="upload-result-count">
                    {r.rowCount} row{r.rowCount !== 1 ? "s" : ""}
                  </span>
                ) : (
                  <span className="upload-result-error">{r.error}</span>
                )}
                {r.warnings && r.warnings.length > 0 && (
                  <details className="upload-result-warnings">
                    <summary>
                      {r.warnings.length} warning{r.warnings.length !== 1 ? "s" : ""}
                    </summary>
                    <ul>
                      {r.warnings.map((w, wi) => (
                        <li key={wi}>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="upload-btn upload-btn--secondary"
            onClick={() => setResults(null)}
          >
            Upload more files
          </button>
        </div>
      )}

      {/* Queue UI */}
      {!hasResults && (
        <>
          {/* Drop zone */}
          <div
            className="upload-dropzone"
            data-testid="upload-dropzone"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                fileInputRef.current?.click();
              }
            }}
          >
            <p className="upload-dropzone-text">
              Drop CSV files here or click to browse
            </p>
            <p className="upload-dropzone-hint">
              Up to 5 MB per file &middot; .csv format
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              multiple
              className="upload-file-input"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  addFiles(e.target.files);
                  e.target.value = "";
                }
              }}
            />
          </div>

          {/* Validation errors */}
          {Object.keys(validationErrors).length > 0 && (
            <div className="upload-validation-errors" role="alert">
              {Object.entries(validationErrors).map(([name, msg]) => (
                <p key={name} className="upload-validation-error">
                  {msg}
                </p>
              ))}
            </div>
          )}

          {/* Queued file list */}
          {queue.length > 0 && (
            <div className="upload-queue" data-testid="upload-queue">
              <h2 className="upload-queue-title">
                {queue.length} file{queue.length !== 1 ? "s" : ""} ready
              </h2>

              <ul className="upload-queue-list">
                {queue.map((q) => (
                  <li key={q.key} className="upload-queue-item">
                    <div className="upload-queue-item-header">
                      <span className="upload-queue-filename">
                        {q.file.name}
                      </span>
                      <span className="upload-queue-filesize">
                        {formatFileSize(q.file.size)}
                      </span>
                      <button
                        type="button"
                        className="upload-queue-remove"
                        onClick={() => removeFile(q.key)}
                        aria-label={`Remove ${q.file.name}`}
                        disabled={upload.isPending}
                      >
                        &times;
                      </button>
                    </div>

                    <div className="upload-queue-item-fields">
                      <label className="upload-field">
                        <span className="upload-field-label">Account</span>
                        <AccountSelector
                          accounts={accounts}
                          value={q.accountId}
                          onChange={(id) => setAccountForFile(q.key, id)}
                          disabled={upload.isPending}
                        />
                      </label>
                    </div>
                  </li>
                ))}
              </ul>

              {/* General error */}
              {upload.error && (
                <p className="upload-error" role="alert">
                  {upload.error.message}
                </p>
              )}

              <button
                type="button"
                className="upload-btn upload-btn--primary"
                disabled={!canImport}
                onClick={() => void handleImport()}
              >
                {upload.isPending
                  ? "Importing..."
                  : `Import ${queue.length} file${queue.length !== 1 ? "s" : ""}`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function AccountSelector({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: AuthAccount[] | null;
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
}) {
  if (!accounts || accounts.length === 0) {
    return <span className="upload-field-empty">No accounts available</span>;
  }

  return (
    <select
      className="upload-select"
      value={value ?? ""}
      onChange={(e) => onChange(Number(e.target.value))}
      disabled={disabled}
    >
      {value === null && <option value="">Select account...</option>}
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
          {a.lastFour ? ` (****${a.lastFour})` : ""}
        </option>
      ))}
    </select>
  );
}
