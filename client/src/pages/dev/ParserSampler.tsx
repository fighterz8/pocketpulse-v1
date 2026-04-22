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
  createdAt: string;
  sampleSize: number;
  uploadRowCount: number;
  uploadWarningCount: number;
  verdicts: ParserVerdict[];
};

const MIN_REQUIRED_RATIO = 40 / 50; // ≥ 80% of rows must have a verdict (spec §4)

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(n: number | null, decimals = 0): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function pctFrac(acc: number | null, denom: number): string {
  if (acc == null || denom <= 0) return "—";
  const num = Math.round(acc * denom);
  return `${(acc * 100).toFixed(0)}% (${num}/${denom})`;
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
  dateV: ParserVerdict["dateVerdict"];
  descV: ParserVerdict["descriptionVerdict"];
  amtV: ParserVerdict["amountVerdict"];
  dirV: ParserVerdict["directionVerdict"];
  notes: string;
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
    dateV: v.dateVerdict,
    descV: v.descriptionVerdict,
    amtV: v.amountVerdict,
    dirV: v.directionVerdict,
    notes: v.notes ?? "",
    decided: wasTouched,
  };
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(i: number, partial: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...partial, decided: true } : r)));
  }

  function confirmRow(i: number) {
    update(i, {
      skipped: false,
      dateV: "ok", descV: "ok", amtV: "ok", dirV: "ok",
    });
  }

  function skipRow(i: number) {
    update(i, {
      skipped: true,
      dateV: "ok", descV: "ok", amtV: "ok", dirV: "ok",
    });
  }

  const decided = rows.filter((r) => r.decided).length;
  const canSubmit = decided / rows.length >= MIN_REQUIRED_RATIO;

  async function submit() {
    setError(null); setSubmitting(true);
    try {
      const verdicts = rows
        .filter((r) => r.decided)
        .map((r) => ({
          transactionId: r.v.transactionId,
          skipped: r.skipped,
          dateVerdict: r.dateV,
          descriptionVerdict: r.descV,
          amountVerdict: r.amtV,
          directionVerdict: r.dirV,
          notes: r.notes.trim() ? r.notes.trim() : null,
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
          Click <strong>Looks right</strong> if all four fields match, <strong>Skip</strong> if the
          raw row can't be evaluated, or flag specific fields below. The reconstructed raw values
          are display-only and never written back.
        </p>

        <div className="acc-merchants-table-wrap">
          <table className="acc-merchants-table">
            <thead>
              <tr>
                <th>Raw (reconstructed)</th>
                <th>Parsed</th>
                <th>Date</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Direction</th>
                <th>Notes</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const disabled = r.skipped;
                return (
                  <tr key={r.v.transactionId} data-testid={`row-parser-${r.v.transactionId}`}>
                    <td>
                      <div className="acc-metric-raw">{r.v.rawDate}</div>
                      <div>{r.v.rawDescription}</div>
                      <div className="acc-metric-raw">{r.v.rawAmount}</div>
                    </td>
                    <td>
                      <div className="acc-metric-raw">{r.v.parsedDate}</div>
                      <div>{r.v.parsedDescription}</div>
                      <div className="acc-metric-raw">
                        {r.v.parsedAmount.toFixed(2)} ({r.v.parsedFlowType})
                      </div>
                    </td>
                    <td>
                      <select
                        value={r.dateV}
                        disabled={disabled}
                        onChange={(e) => update(i, { dateV: e.target.value as ParserVerdict["dateVerdict"] })}
                        data-testid={`select-date-${r.v.transactionId}`}
                      >
                        {PARSER_DATE_VERDICTS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        value={r.descV}
                        disabled={disabled}
                        onChange={(e) => update(i, { descV: e.target.value as ParserVerdict["descriptionVerdict"] })}
                        data-testid={`select-description-${r.v.transactionId}`}
                      >
                        {PARSER_DESC_VERDICTS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        value={r.amtV}
                        disabled={disabled}
                        onChange={(e) => update(i, { amtV: e.target.value as ParserVerdict["amountVerdict"] })}
                        data-testid={`select-amount-${r.v.transactionId}`}
                      >
                        {PARSER_AMOUNT_VERDICTS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        value={r.dirV}
                        disabled={disabled}
                        onChange={(e) => update(i, { dirV: e.target.value as ParserVerdict["directionVerdict"] })}
                        data-testid={`select-direction-${r.v.transactionId}`}
                      >
                        {PARSER_DIRECTION_VERDICTS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.notes}
                        maxLength={500}
                        onChange={(e) => update(i, { notes: e.target.value })}
                        placeholder="optional"
                        data-testid={`input-notes-${r.v.transactionId}`}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button
                          type="button"
                          onClick={() => confirmRow(i)}
                          data-testid={`btn-confirm-${r.v.transactionId}`}
                        >
                          Looks right
                        </button>
                        <button
                          type="button"
                          onClick={() => skipRow(i)}
                          data-testid={`btn-skip-${r.v.transactionId}`}
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

      <div className="acc-corrections glass-card" data-testid="parser-submit-bar">
        <div>
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
          Sample of <strong>{sample.sampleSize}</strong> transactions
          {sample.uploadRowCount != null && (
            <> from upload #{sample.uploadId} ({sample.uploadRowCount} rows, {sample.uploadWarningCount ?? 0} parser warnings)</>
          )}
          .{" "}
          <strong>{sample.confirmedCount}</strong> confirmed,{" "}
          <strong>{sample.flaggedCount}</strong> flagged,{" "}
          <strong>{sample.sampleSize - sample.confirmedCount - sample.flaggedCount}</strong> skipped.
        </p>

        <div className="acc-merchants-table-wrap">
          <table className="acc-merchants-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Accuracy</th>
                <th>Top error tags</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="row-report-date">
                <td>Date</td>
                <td>{pctFrac(sample.dateAccuracy, denom)}</td>
                <td>{dateMisses.length === 0 ? "—" : dateMisses.map(([k, n]) => `${k} (${n})`).join(", ")}</td>
              </tr>
              <tr data-testid="row-report-description">
                <td>Description</td>
                <td>{pctFrac(sample.descriptionAccuracy, denom)}</td>
                <td>{descMisses.length === 0 ? "—" : descMisses.map(([k, n]) => `${k} (${n})`).join(", ")}</td>
              </tr>
              <tr data-testid="row-report-amount">
                <td>Amount</td>
                <td>{pctFrac(sample.amountAccuracy, denom)}</td>
                <td>{amtMisses.length === 0 ? "—" : amtMisses.map(([k, n]) => `${k} (${n})`).join(", ")}</td>
              </tr>
              <tr data-testid="row-report-direction">
                <td>Direction</td>
                <td>{pctFrac(sample.directionAccuracy, denom)}</td>
                <td>{dirMisses.length === 0 ? "—" : dirMisses.map(([k, n]) => `${k} (${n})`).join(", ")}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={exportJson} data-testid="btn-export-parser-json">
            Export JSON
          </button>
        </div>
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
