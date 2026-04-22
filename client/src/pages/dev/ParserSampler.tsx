/**
 * Dev Test Suite — Parser fidelity sampler (PR2).
 *
 * Mirrors ClassificationSampler structurally: start → review → report. All
 * verdicts are sandboxed (server enforces the same gate). The "raw CSV" cells
 * shown to the reviewer are reconstructed from stored fields and never
 * persisted back — see spec §6 (Option 2).
 *
 * UI copy intentionally says "Parser output validation", NOT "Raw CSV audit"
 * (per spec §1).
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { apiFetch } from "../../lib/api";
import {
  PARSER_AMOUNT_VERDICTS,
  PARSER_DATE_VERDICTS,
  PARSER_DESC_VERDICTS,
  PARSER_DIRECTION_VERDICTS,
  type ParserVerdict,
} from "@shared/schema";

// ─── Server-shape types ─────────────────────────────────────────────────────

type SampleRecord = {
  id: number;
  uploadId: number | null;
  uploadDate: string | null;
  createdAt: string;
  completedAt: string | null;
  sampleSize: number;
  dateAccuracy: number | null;
  descriptionAccuracy: number | null;
  amountAccuracy: number | null;
  directionAccuracy: number | null;
  uploadRowCount: number | null;
  uploadWarningCount: number | null;
  confirmedCount: number;
  flaggedCount: number;
  verdicts: ParserVerdict[];
};

type CreateResponse = {
  sampleId: number;
  uploadId: number;
  uploadDate: string | null;
  createdAt: string;
  sampleSize: number;
  uploadRowCount: number;
  uploadWarningCount: number;
  verdicts: ParserVerdict[];
};

const MIN_REQUIRED_RATIO = 40 / 50; // ≥ 80% of rows must have a verdict (spec §4)

// Spec §5 disclaimer — surfaced on the submit screen and again on the report.
const PARSER_DISCLAIMER =
  "This tool validates the classifier's view of your data; for deeper " +
  "CSV-layer debugging, re-upload the file and inspect warnings.";

// Per-field "Wrong" dropdown options (the "ok" entry is the OK toggle itself,
// so we filter it out of the dropdowns the user sees after picking Wrong).
const DATE_WRONG_OPTIONS = PARSER_DATE_VERDICTS.filter((v) => v !== "ok");
const DESC_WRONG_OPTIONS = PARSER_DESC_VERDICTS.filter((v) => v !== "ok");
const AMOUNT_WRONG_OPTIONS = PARSER_AMOUNT_VERDICTS.filter((v) => v !== "ok");
const DIRECTION_WRONG_OPTIONS = PARSER_DIRECTION_VERDICTS.filter((v) => v !== "ok");

// ─── Helpers ────────────────────────────────────────────────────────────────

function pctFrac(acc: number | null, denom: number): string {
  if (acc == null || denom <= 0) return "—";
  const num = Math.round(acc * denom);
  return `${(acc * 100).toFixed(0)}% (${num}/${denom})`;
}

function fmtUploadDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ─── Start screen ───────────────────────────────────────────────────────────

function StartScreen({
  onStarted,
}: {
  onStarted: (sampleId: number) => void;
}) {
  const [uploadId, setUploadId] = useState("");
  const [sampleSize, setSampleSize] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { sampleSize: Number.parseInt(sampleSize, 10) || 50 };
      if (uploadId.trim()) {
        const n = Number.parseInt(uploadId.trim(), 10);
        if (!Number.isFinite(n)) throw new Error("Upload ID must be an integer.");
        body.uploadId = n;
      }
      const res = await apiFetch("/api/dev/parser-samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Failed to start sample (${res.status})`);
      }
      const j = (await res.json()) as CreateResponse;
      onStarted(j.sampleId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start sample");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acc-merchants glass-card" data-testid="parser-start">
      <h2 className="acc-merchants-title">Start a parser sample</h2>
      <p className="acc-merchants-intro">
        We'll draw 50 random transactions from your most recent successful upload and ask you to
        spot-check what the parser produced for each one. Verdicts never modify any real
        transactions.
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label>
          <div>Upload ID (optional)</div>
          <input
            type="text"
            inputMode="numeric"
            value={uploadId}
            onChange={(e) => setUploadId(e.target.value)}
            placeholder="latest upload"
            data-testid="input-parser-upload-id"
          />
        </label>
        <label>
          <div>Sample size</div>
          <input
            type="number"
            min={1}
            max={200}
            value={sampleSize}
            onChange={(e) => setSampleSize(e.target.value)}
            data-testid="input-parser-sample-size"
          />
        </label>
        <button
          type="button"
          className="acc-run-btn"
          disabled={busy}
          onClick={() => void start()}
          data-testid="btn-start-parser"
        >
          {busy ? "Starting…" : "Start sample"}
        </button>
      </div>
      {error && <div className="acc-error" role="alert" data-testid="text-parser-start-error">{error}</div>}
    </div>
  );
}

// ─── Review row state ───────────────────────────────────────────────────────

type RowState = {
  v: ParserVerdict;
  // Transient form state
  skipped: boolean;
  // null = OK toggle is selected; non-null = Wrong toggle + chosen error tag
  dateWrong: ParserVerdict["dateVerdict"] | null;
  descWrong: ParserVerdict["descriptionVerdict"] | null;
  amtWrong:  ParserVerdict["amountVerdict"]   | null;
  dirWrong:  ParserVerdict["directionVerdict"] | null;
  decided: boolean;
};

function rowFromVerdict(v: ParserVerdict): RowState {
  // Treat any verdict that's already been touched (skipped or any non-"ok"
  // value) as decided so reopening a partially-reviewed sample preserves work.
  const wasTouched =
    v.skipped ||
    v.dateVerdict !== "ok" ||
    v.descriptionVerdict !== "ok" ||
    v.amountVerdict !== "ok" ||
    v.directionVerdict !== "ok" ||
    (v.notes != null && v.notes.length > 0);
  return {
    v,
    skipped: v.skipped,
    dateWrong: v.dateVerdict === "ok" ? null : v.dateVerdict,
    descWrong: v.descriptionVerdict === "ok" ? null : v.descriptionVerdict,
    amtWrong:  v.amountVerdict   === "ok" ? null : v.amountVerdict,
    dirWrong:  v.directionVerdict === "ok" ? null : v.directionVerdict,
    decided: wasTouched,
  };
}

// ─── Per-field OK/Wrong toggle ──────────────────────────────────────────────

function FieldVerdict<T extends string>({
  label, value, options, disabled, onChange, testIdPrefix, txnId,
}: {
  label: string;
  value: T | null;        // null → OK selected
  options: readonly T[];  // wrong-only options
  disabled: boolean;
  onChange: (next: T | null) => void;
  testIdPrefix: string;
  txnId: number;
}) {
  const isWrong = value !== null;
  return (
    <div className="parser-field-verdict">
      <div className="parser-field-label">{label}</div>
      <div className="parser-field-toggle">
        <button
          type="button"
          aria-pressed={!isWrong}
          disabled={disabled}
          className={!isWrong ? "parser-toggle parser-toggle-ok-on" : "parser-toggle"}
          onClick={() => onChange(null)}
          data-testid={`btn-${testIdPrefix}-ok-${txnId}`}
        >
          OK
        </button>
        <button
          type="button"
          aria-pressed={isWrong}
          disabled={disabled}
          className={isWrong ? "parser-toggle parser-toggle-wrong-on" : "parser-toggle"}
          onClick={() => onChange(options[0] ?? null)}
          data-testid={`btn-${testIdPrefix}-wrong-${txnId}`}
        >
          Wrong
        </button>
      </div>
      {isWrong && (
        <select
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
          data-testid={`select-${testIdPrefix}-${txnId}`}
        >
          {options.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
    </div>
  );
}

// ─── Review screen ──────────────────────────────────────────────────────────

function ReviewScreen({
  sampleId,
  initialVerdicts,
  onSubmitted,
}: {
  sampleId: number;
  initialVerdicts: ParserVerdict[];
  onSubmitted: (s: SampleRecord) => void;
}) {
  const [rows, setRows] = useState<RowState[]>(() => initialVerdicts.map(rowFromVerdict));
  const [globalNotes, setGlobalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(i: number, partial: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...partial, decided: true } : r)));
  }

  function confirmRow(i: number) {
    update(i, { skipped: false, dateWrong: null, descWrong: null, amtWrong: null, dirWrong: null });
  }

  function skipRow(i: number) {
    update(i, { skipped: true,  dateWrong: null, descWrong: null, amtWrong: null, dirWrong: null });
  }

  const decided = rows.filter((r) => r.decided).length;
  const canSubmit = decided / rows.length >= MIN_REQUIRED_RATIO;

  async function submit() {
    setError(null); setSubmitting(true);
    try {
      const trimmedNotes = globalNotes.trim();
      const verdicts = rows
        .filter((r) => r.decided)
        .map((r) => ({
          transactionId: r.v.transactionId,
          skipped: r.skipped,
          dateVerdict:        r.dateWrong ?? "ok",
          descriptionVerdict: r.descWrong ?? "ok",
          amountVerdict:      r.amtWrong  ?? "ok",
          directionVerdict:   r.dirWrong  ?? "ok",
          // spec §5: footer Notes field "carried onto every verdict".
          notes: trimmedNotes ? trimmedNotes : null,
        }));
      const res = await apiFetch(`/api/dev/parser-samples/${sampleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdicts }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Submit failed (${res.status})`);
      }
      const j = (await res.json()) as { sample: SampleRecord };
      onSubmitted(j.sample);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="acc-merchants glass-card" data-testid="parser-review">
        <h2 className="acc-merchants-title">
          Review {rows.length} parser outputs ({decided}/{rows.length} done)
        </h2>
        <p className="acc-merchants-intro">
          For each row, compare the reconstructed raw values against what the parser produced.
          Toggle each field to <strong>OK</strong> or <strong>Wrong</strong> — picking Wrong
          reveals the common error types. Skip a row if the raw values can't be evaluated.
          Reconstructed raw values are display-only and never written back.
        </p>

        <div className="acc-merchants-table-wrap">
          <table className="acc-merchants-table parser-review-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Raw (reconstructed)</th>
                <th style={{ minWidth: 220 }}>Parsed</th>
                <th>Date</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Direction</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const disabled = r.skipped;
                const txnId = r.v.transactionId;
                return (
                  <tr key={txnId} data-testid={`row-parser-${txnId}`}>
                    <td>
                      <div className="acc-metric-raw">{r.v.rawDate}</div>
                      <div>{r.v.rawDescription}</div>
                      <div className="acc-metric-raw">{r.v.rawAmount}</div>
                    </td>
                    <td>
                      <div className="acc-metric-raw">{r.v.parsedDate}</div>
                      <div>{r.v.parsedDescription}</div>
                      <div className="acc-metric-raw">
                        {r.v.parsedAmount.toFixed(2)}{" "}
                        <span className={`parser-pill parser-pill-${r.v.parsedFlowType}`}>
                          {r.v.parsedFlowType}
                        </span>
                        {r.v.parsedAmbiguous && (
                          <span
                            className="parser-pill parser-pill-ambiguous"
                            data-testid={`pill-ambiguous-${txnId}`}
                          >
                            ambiguous
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <FieldVerdict
                        label="Date" value={r.dateWrong} options={DATE_WRONG_OPTIONS}
                        disabled={disabled} testIdPrefix="date" txnId={txnId}
                        onChange={(next) => update(i, { dateWrong: next })}
                      />
                    </td>
                    <td>
                      <FieldVerdict
                        label="Description" value={r.descWrong} options={DESC_WRONG_OPTIONS}
                        disabled={disabled} testIdPrefix="description" txnId={txnId}
                        onChange={(next) => update(i, { descWrong: next })}
                      />
                    </td>
                    <td>
                      <FieldVerdict
                        label="Amount" value={r.amtWrong} options={AMOUNT_WRONG_OPTIONS}
                        disabled={disabled} testIdPrefix="amount" txnId={txnId}
                        onChange={(next) => update(i, { amtWrong: next })}
                      />
                    </td>
                    <td>
                      <FieldVerdict
                        label="Direction" value={r.dirWrong} options={DIRECTION_WRONG_OPTIONS}
                        disabled={disabled} testIdPrefix="direction" txnId={txnId}
                        onChange={(next) => update(i, { dirWrong: next })}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button
                          type="button"
                          onClick={() => confirmRow(i)}
                          data-testid={`btn-confirm-${txnId}`}
                        >
                          Looks right
                        </button>
                        <button
                          type="button"
                          onClick={() => skipRow(i)}
                          data-testid={`btn-skip-${txnId}`}
                        >
                          {r.skipped ? "✓ Skipped" : "Skip"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="acc-corrections glass-card parser-submit-bar" data-testid="parser-submit-bar">
        <p className="parser-disclaimer" data-testid="text-parser-disclaimer">
          {PARSER_DISCLAIMER}
        </p>

        <label className="parser-global-notes">
          <div>Notes (applied to every verdict)</div>
          <input
            type="text"
            value={globalNotes}
            maxLength={500}
            onChange={(e) => setGlobalNotes(e.target.value)}
            placeholder="optional — context for the whole sample"
            data-testid="input-parser-global-notes"
          />
        </label>

        <div className="parser-submit-status">
          <strong>{decided}</strong> of <strong>{rows.length}</strong> rows have a verdict
          ({decided}/{rows.length})
        </div>
        {error && <div className="acc-error" role="alert" data-testid="text-parser-submit-error">{error}</div>}
        <button
          type="button"
          className="acc-run-btn"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
          data-testid="btn-submit-parser"
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </>
  );
}

// ─── Report screen helpers ──────────────────────────────────────────────────

function AccuracyCard({
  label, acc, denom, testId,
}: {
  label: string; acc: number | null; denom: number; testId: string;
}) {
  const pctText = acc == null || denom <= 0 ? "—" : `${(acc * 100).toFixed(0)}%`;
  const fracText = acc == null || denom <= 0
    ? ""
    : `${Math.round(acc * denom)} / ${denom}`;
  return (
    <div className="parser-accuracy-card" data-testid={testId}>
      <div className="parser-accuracy-card-label">{label}</div>
      <div className="parser-accuracy-card-pct">{pctText}</div>
      {fracText && <div className="parser-accuracy-card-frac">{fracText}</div>}
    </div>
  );
}

function renderBreakdownRows(
  label: string,
  misses: Array<[string, number]>,
  testIdPrefix: string,
) {
  if (misses.length === 0) {
    return (
      <tr key={`${label}-none`} data-testid={`${testIdPrefix}-none`}>
        <td>{label}</td>
        <td colSpan={2} style={{ color: "#94a3b8" }}>No errors flagged</td>
      </tr>
    );
  }
  return misses.map(([tag, count], i) => (
    <tr key={`${label}-${tag}`} data-testid={`${testIdPrefix}-${tag}`}>
      {i === 0 ? <td rowSpan={misses.length}>{label}</td> : null}
      <td>{tag}</td>
      <td>{count}</td>
    </tr>
  ));
}

// ─── Report screen ──────────────────────────────────────────────────────────

function ReportScreen({ sample }: { sample: SampleRecord }) {
  const verdicts = sample.verdicts;
  const nonSkipped = verdicts.filter((v) => !v.skipped);
  const denom = nonSkipped.length;

  // Build per-error-tag counts so reviewers can see WHICH parser bug shows up
  // most (e.g. amount: wrong-sign vs wrong-amount). Excludes "ok" by definition.
  const tag = (field: keyof Pick<ParserVerdict, "dateVerdict" | "descriptionVerdict" | "amountVerdict" | "directionVerdict">) => {
    const counts = new Map<string, number>();
    for (const v of nonSkipped) {
      const t = v[field];
      if (t === "ok") continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  const dateMisses = tag("dateVerdict");
  const descMisses = tag("descriptionVerdict");
  const amtMisses  = tag("amountVerdict");
  const dirMisses  = tag("directionVerdict");

  const flaggedRows = verdicts.filter((v) =>
    !v.skipped && (
      v.dateVerdict !== "ok" || v.descriptionVerdict !== "ok" ||
      v.amountVerdict !== "ok" || v.directionVerdict !== "ok"
    ),
  );

  function exportJson() {
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `parser-sample-${sample.id}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="acc-merchants glass-card" data-testid="parser-report">
        <h2 className="acc-merchants-title">Parser output validation report</h2>
        <p className="acc-merchants-intro">
          Sample of <strong>{sample.sampleSize}</strong> transactions.{" "}
          <strong>{sample.confirmedCount}</strong> confirmed,{" "}
          <strong>{sample.flaggedCount}</strong> flagged,{" "}
          <strong>{sample.sampleSize - sample.confirmedCount - sample.flaggedCount}</strong> skipped.
        </p>
        <p className="parser-disclaimer" data-testid="text-parser-disclaimer-report">
          {PARSER_DISCLAIMER}
        </p>

        {/* Spec §5: four headline accuracy cards (XX% paired with raw fraction). */}
        <div className="parser-accuracy-cards" data-testid="parser-accuracy-cards">
          <AccuracyCard label="Date"        acc={sample.dateAccuracy}        denom={denom} testId="card-accuracy-date" />
          <AccuracyCard label="Description" acc={sample.descriptionAccuracy} denom={denom} testId="card-accuracy-description" />
          <AccuracyCard label="Amount"      acc={sample.amountAccuracy}      denom={denom} testId="card-accuracy-amount" />
          <AccuracyCard label="Direction"   acc={sample.directionAccuracy}   denom={denom} testId="card-accuracy-direction" />
        </div>

        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={exportJson} data-testid="btn-export-parser-json">
            Export JSON
          </button>
        </div>
      </div>

      {/* Spec §5 middle block: per-field error breakdown across the sample. */}
      <div className="acc-merchants glass-card" data-testid="parser-error-breakdown">
        <h2 className="acc-merchants-title">Per-field error breakdown</h2>
        <div className="acc-merchants-table-wrap">
          <table className="acc-merchants-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Error type</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {renderBreakdownRows("Date",        dateMisses, "row-breakdown-date")}
              {renderBreakdownRows("Description", descMisses, "row-breakdown-description")}
              {renderBreakdownRows("Amount",      amtMisses,  "row-breakdown-amount")}
              {renderBreakdownRows("Direction",   dirMisses,  "row-breakdown-direction")}
            </tbody>
          </table>
        </div>
      </div>

      <div className="acc-merchants glass-card" data-testid="parser-upload-context">
        <h2 className="acc-merchants-title">Upload context</h2>
        <table className="acc-merchants-table">
          <tbody>
            <tr data-testid="row-upload-id">
              <th style={{ width: 200 }}>Upload ID</th>
              <td>{sample.uploadId ?? "—"}</td>
            </tr>
            <tr data-testid="row-upload-date">
              <th>Upload date</th>
              <td>{fmtUploadDate(sample.uploadDate)}</td>
            </tr>
            <tr data-testid="row-upload-row-count">
              <th>Upload row count</th>
              <td>{sample.uploadRowCount ?? "—"}</td>
            </tr>
            <tr data-testid="row-upload-warning-count">
              <th>Parser warnings</th>
              <td>
                {sample.uploadWarningCount ?? 0}
                {" — "}
                <Link href="/upload" data-testid="link-upload-warnings">
                  view in uploads
                </Link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {flaggedRows.length > 0 && (
        <div className="acc-merchants glass-card" data-testid="parser-flagged">
          <h2 className="acc-merchants-title">Flagged rows ({flaggedRows.length})</h2>
          <div className="acc-merchants-table-wrap">
            <table className="acc-merchants-table">
              <thead>
                <tr>
                  <th>Raw</th>
                  <th>Parsed</th>
                  <th>Verdicts</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {flaggedRows.map((v) => (
                  <tr key={v.transactionId} data-testid={`row-flagged-${v.transactionId}`}>
                    <td className="acc-metric-raw">
                      {v.rawDate} / {v.rawDescription} / {v.rawAmount}
                    </td>
                    <td className="acc-metric-raw">
                      {v.parsedDate} / {v.parsedDescription} / {v.parsedAmount.toFixed(2)} ({v.parsedFlowType})
                      {v.parsedAmbiguous && (
                        <span className="parser-pill parser-pill-ambiguous">ambiguous</span>
                      )}
                    </td>
                    <td>
                      {[
                        ["date", v.dateVerdict],
                        ["desc", v.descriptionVerdict],
                        ["amt",  v.amountVerdict],
                        ["dir",  v.directionVerdict],
                      ].filter(([, val]) => val !== "ok").map(([k, val]) => `${k}=${val}`).join(", ")}
                    </td>
                    <td>{v.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Page wrapper ───────────────────────────────────────────────────────────

export function ParserSampler() {
  const [, params] = useRoute<{ sampleId?: string }>("/dev/test-suite/parser/:sampleId?");
  const [, setLocation] = useLocation();
  const sampleIdParam = params?.sampleId;
  const sampleId = useMemo(() => {
    if (!sampleIdParam) return null;
    const n = Number.parseInt(sampleIdParam, 10);
    return Number.isFinite(n) ? n : null;
  }, [sampleIdParam]);

  const [sample, setSample] = useState<SampleRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sampleId == null) { setSample(null); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true); setError(null);
      try {
        const res = await apiFetch(`/api/dev/parser-samples/${sampleId}`);
        if (!res.ok) {
          if (res.status === 404) throw new Error("Sample not found.");
          throw new Error(`Failed to load sample (${res.status})`);
        }
        const body = (await res.json()) as { sample: SampleRecord };
        if (!cancelled) setSample(body.sample);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load sample");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sampleId]);

  return (
    <div className="acc-page" data-testid="page-parser-sampler">
      <div className="acc-page-header">
        <div>
          <h1 className="acc-page-title">Parser output validation</h1>
          <p className="acc-page-subtitle">
            Spot-check what the CSV parser produced against the reconstructed raw values. Verdicts
            are sandboxed.
          </p>
        </div>
        <div>
          <Link href="/dev/test-suite" data-testid="link-back-to-suite">← Back to test suite</Link>
        </div>
      </div>

      {sampleId == null ? (
        <StartScreen onStarted={(id) => setLocation(`/dev/test-suite/parser/${id}`)} />
      ) : loading ? (
        <p className="acc-empty-text" data-testid="text-parser-loading">Loading…</p>
      ) : error ? (
        <div className="acc-error" role="alert" data-testid="text-parser-error">{error}</div>
      ) : sample == null ? null : sample.completedAt ? (
        <ReportScreen sample={sample} />
      ) : (
        <ReviewScreen
          sampleId={sample.id}
          initialVerdicts={sample.verdicts}
          onSubmitted={(s) => setSample(s)}
        />
      )}
    </div>
  );
}
