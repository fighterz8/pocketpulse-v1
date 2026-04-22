import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { apiFetch } from "../../lib/api";
import {
  CLASSIFICATION_CLASS_VALUES,
  CLASSIFICATION_RECURRENCE_VALUES,
  V1_CATEGORIES,
  type ClassificationVerdict,
} from "@shared/schema";

// ─── Types matching server JSON shapes ──────────────────────────────────────

type SampleTransaction = {
  id: number;
  date: string;
  rawDescription: string;
  amount: number;
  category: string;
  transactionClass: string;
  recurrenceType: string;
  labelSource: string;
  labelConfidence: number;
};

type CreateResponse = {
  sampleId: number;
  createdAt: string;
  sampleSize: number;
  transactions: SampleTransaction[];
};

type SampleRecord = {
  id: number;
  createdAt: string;
  completedAt: string | null;
  sampleSize: number;
  categoryAccuracy: number | null;
  classAccuracy: number | null;
  recurrenceAccuracy: number | null;
  confirmedCount: number;
  correctedCount: number;
  skippedCount: number;
  verdicts: ClassificationVerdict[];
};

// ─── Local working state for the review screen ──────────────────────────────

type RowState = {
  txn: SampleTransaction;
  verdict: "confirmed" | "corrected" | "skipped" | null;
  category: string;
  transactionClass: string;
  recurrenceType: string;
};

const MIN_REQUIRED_RATIO = 40 / 50; // ≥ 40 of 50 must have a verdict before submit (spec §4)

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtAmount(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number, decimals = 0): string {
  return `${(n * 100).toFixed(decimals)}%`;
}

function fractionLine(num: number, denom: number): string {
  return `(${num}/${denom})`;
}

function buildVerdict(rs: RowState): ClassificationVerdict | null {
  if (!rs.verdict) return null;
  if (rs.verdict !== "corrected") {
    return {
      transactionId: rs.txn.id,
      classifierCategory: rs.txn.category,
      classifierClass: rs.txn.transactionClass,
      classifierRecurrence: rs.txn.recurrenceType,
      classifierLabelSource: rs.txn.labelSource,
      classifierLabelConfidence: rs.txn.labelConfidence,
      verdict: rs.verdict,
      correctedCategory: null,
      correctedClass: null,
      correctedRecurrence: null,
    };
  }
  return {
    transactionId: rs.txn.id,
    classifierCategory: rs.txn.category,
    classifierClass: rs.txn.transactionClass,
    classifierRecurrence: rs.txn.recurrenceType,
    classifierLabelSource: rs.txn.labelSource,
    classifierLabelConfidence: rs.txn.labelConfidence,
    verdict: "corrected",
    correctedCategory:   rs.category         !== rs.txn.category         ? rs.category         : null,
    correctedClass:      rs.transactionClass !== rs.txn.transactionClass ? rs.transactionClass : null,
    correctedRecurrence: rs.recurrenceType   !== rs.txn.recurrenceType   ? rs.recurrenceType   : null,
  };
}

// ─── Review screen ──────────────────────────────────────────────────────────

function ReviewScreen({
  sampleId,
  transactions,
  onSubmitted,
}: {
  sampleId: number;
  transactions: SampleTransaction[];
  onSubmitted: (sample: SampleRecord) => void;
}) {
  const [rows, setRows] = useState<RowState[]>(() =>
    transactions.map((t) => ({
      txn: t,
      verdict: null,
      category: t.category,
      transactionClass: t.transactionClass,
      recurrenceType: t.recurrenceType,
    })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(i: number, partial: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...partial } : r)));
  }

  function confirmRow(i: number) {
    update(i, { verdict: "confirmed" });
  }

  function skipRow(i: number) {
    update(i, { verdict: "skipped" });
  }

  function startEdit(i: number) {
    update(i, { verdict: "corrected" });
  }

  function revertField(i: number, field: "category" | "transactionClass" | "recurrenceType") {
    const t = rows[i]!.txn;
    update(i, { [field]: t[field] } as Partial<RowState>);
  }

  const decided = rows.filter((r) => r.verdict !== null).length;
  const canSubmit = decided / rows.length >= MIN_REQUIRED_RATIO;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const verdicts: ClassificationVerdict[] = [];
      for (const r of rows) {
        const v = buildVerdict(r);
        if (v) {
          // If user clicked Edit but didn't actually change anything, treat as confirmed.
          if (
            v.verdict === "corrected" &&
            v.correctedCategory == null &&
            v.correctedClass == null &&
            v.correctedRecurrence == null
          ) {
            verdicts.push({ ...v, verdict: "confirmed" });
          } else {
            verdicts.push(v);
          }
        }
      }
      const res = await apiFetch(`/api/dev/classification-samples/${sampleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdicts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Submit failed (${res.status})`);
      }
      const body = (await res.json()) as { sample: SampleRecord };
      onSubmitted(body.sample);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="acc-merchants glass-card" data-testid="classification-review">
        <h2 className="acc-merchants-title">
          Review {rows.length} transactions ({decided}/{rows.length} done)
        </h2>
        <p className="acc-merchants-intro">
          For each row, click <strong>Looks right</strong>, <strong>Edit</strong> a field, or{" "}
          <strong>Skip</strong>. Submit becomes available once at least{" "}
          {Math.ceil(MIN_REQUIRED_RATIO * rows.length)} rows have a verdict.
        </p>

        <div className="acc-merchants-table-wrap">
          <table className="acc-merchants-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description / amount</th>
                <th>Category</th>
                <th>Class</th>
                <th>Recurrence</th>
                <th>Source / conf.</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isEdit = r.verdict === "corrected";
                const isConfirmed = r.verdict === "confirmed";
                const isSkipped = r.verdict === "skipped";
                return (
                  <tr key={r.txn.id} data-testid={`row-classification-${r.txn.id}`}>
                    <td className="acc-merchant-count">{r.txn.date}</td>
                    <td>
                      <div>{r.txn.rawDescription}</div>
                      <div className="acc-metric-raw">{fmtAmount(r.txn.amount)}</div>
                    </td>
                    <td>
                      {isEdit ? (
                        <span style={{ display: "inline-flex", gap: 4 }}>
                          <select
                            value={r.category}
                            onChange={(e) => update(i, { category: e.target.value })}
                            data-testid={`select-category-${r.txn.id}`}
                          >
                            {V1_CATEGORIES.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                          {r.category !== r.txn.category && (
                            <button
                              type="button"
                              onClick={() => revertField(i, "category")}
                              aria-label="Revert category"
                              data-testid={`btn-revert-category-${r.txn.id}`}
                            >↶</button>
                          )}
                        </span>
                      ) : (
                        <span className="acc-category-chip">{r.txn.category}</span>
                      )}
                    </td>
                    <td>
                      {isEdit ? (
                        <select
                          value={r.transactionClass}
                          onChange={(e) => update(i, { transactionClass: e.target.value })}
                          data-testid={`select-class-${r.txn.id}`}
                        >
                          {CLASSIFICATION_CLASS_VALUES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="acc-category-chip">{r.txn.transactionClass}</span>
                      )}
                    </td>
                    <td>
                      {isEdit ? (
                        <select
                          value={r.recurrenceType}
                          onChange={(e) => update(i, { recurrenceType: e.target.value })}
                          data-testid={`select-recurrence-${r.txn.id}`}
                        >
                          {CLASSIFICATION_RECURRENCE_VALUES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="acc-category-chip">{r.txn.recurrenceType}</span>
                      )}
                    </td>
                    <td className="acc-metric-raw">
                      {r.txn.labelSource}
                      <br />
                      {pct(r.txn.labelConfidence, 0)}
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button
                          type="button"
                          onClick={() => confirmRow(i)}
                          disabled={isConfirmed}
                          data-testid={`btn-confirm-${r.txn.id}`}
                        >
                          {isConfirmed ? "✓ Looks right" : "Looks right"}
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(i)}
                          disabled={isEdit}
                          data-testid={`btn-edit-${r.txn.id}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => skipRow(i)}
                          disabled={isSkipped}
                          data-testid={`btn-skip-${r.txn.id}`}
                        >
                          Skip
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

      <div className="acc-corrections glass-card" data-testid="classification-submit-bar">
        <div>
          <strong>{decided}</strong> of <strong>{rows.length}</strong> rows have a verdict
          {fractionLine(decided, rows.length)}
        </div>
        {error && <div className="acc-error" role="alert">{error}</div>}
        <button
          type="button"
          className="acc-run-btn"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
          data-testid="btn-submit-classification"
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
  const nonSkipped = verdicts.filter((v) => v.verdict !== "skipped");
  const nonSkippedCount = nonSkipped.length;

  const dim = (field: "correctedCategory" | "correctedClass" | "correctedRecurrence") => {
    const correct = nonSkipped.filter((v) => v[field] == null).length;
    return { correct, total: nonSkippedCount };
  };

  const cat = dim("correctedCategory");
  const cls = dim("correctedClass");
  const rec = dim("correctedRecurrence");

  // Per-labelSource breakdown
  const sources = Array.from(new Set(nonSkipped.map((v) => v.classifierLabelSource))).sort();

  // Failure-mode tables
  function topMisses(field: "correctedCategory" | "correctedClass" | "correctedRecurrence",
                      classifierField: "classifierCategory" | "classifierClass" | "classifierRecurrence") {
    const counts = new Map<string, number>();
    for (const v of nonSkipped) {
      const corrected = v[field];
      if (corrected == null) continue;
      const key = `${v[classifierField]} → ${corrected}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  const catMisses = topMisses("correctedCategory", "classifierCategory");
  const clsMisses = topMisses("correctedClass", "classifierClass");
  const recMisses = topMisses("correctedRecurrence", "classifierRecurrence");

  function exportJson() {
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `classification-sample-${sample.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div data-testid="classification-report">
      <div className="acc-metrics-grid">
        <div className="acc-metric-card glass-card" data-testid="metric-category">
          <div className="acc-metric-header"><span className="acc-metric-title">Category</span></div>
          <div className="acc-metric-value">{nonSkippedCount > 0 ? pct(cat.correct / cat.total) : "—"}</div>
          <div className="acc-metric-raw">{fractionLine(cat.correct, cat.total)}</div>
        </div>
        <div className="acc-metric-card glass-card" data-testid="metric-class">
          <div className="acc-metric-header"><span className="acc-metric-title">Class</span></div>
          <div className="acc-metric-value">{nonSkippedCount > 0 ? pct(cls.correct / cls.total) : "—"}</div>
          <div className="acc-metric-raw">{fractionLine(cls.correct, cls.total)}</div>
        </div>
        <div className="acc-metric-card glass-card" data-testid="metric-recurrence">
          <div className="acc-metric-header"><span className="acc-metric-title">Recurrence</span></div>
          <div className="acc-metric-value">{nonSkippedCount > 0 ? pct(rec.correct / rec.total) : "—"}</div>
          <div className="acc-metric-raw">{fractionLine(rec.correct, rec.total)}</div>
        </div>
      </div>

      <div className="acc-merchants glass-card">
        <h2 className="acc-merchants-title">Accuracy by labelSource</h2>
        {sources.length === 0 ? (
          <p className="acc-empty-text">No verdicts to break down.</p>
        ) : (
          <div className="acc-merchants-table-wrap">
            <table className="acc-merchants-table">
              <thead>
                <tr><th>Source</th><th>Count</th><th>Category</th><th>Class</th><th>Recurrence</th></tr>
              </thead>
              <tbody>
                {sources.map((src) => {
                  const sub = nonSkipped.filter((v) => v.classifierLabelSource === src);
                  const subCat = sub.filter((v) => v.correctedCategory   == null).length;
                  const subCls = sub.filter((v) => v.correctedClass      == null).length;
                  const subRec = sub.filter((v) => v.correctedRecurrence == null).length;
                  return (
                    <tr key={src} data-testid={`row-source-${src}`}>
                      <td>{src}</td>
                      <td>{sub.length}</td>
                      <td>{subCat}/{sub.length} {pct(subCat / sub.length)}</td>
                      <td>{subCls}/{sub.length} {pct(subCls / sub.length)}</td>
                      <td>{subRec}/{sub.length} {pct(subRec / sub.length)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {[
        { title: "Top category misclassifications", rows: catMisses, testid: "misses-category" },
        { title: "Top class misclassifications",    rows: clsMisses, testid: "misses-class" },
        { title: "Top recurrence misclassifications", rows: recMisses, testid: "misses-recurrence" },
      ].map(({ title, rows, testid }) => (
        <div key={testid} className="acc-merchants glass-card" data-testid={testid}>
          <h2 className="acc-merchants-title">{title}</h2>
          {rows.length === 0 ? (
            <p className="acc-empty-text">No misclassifications recorded.</p>
          ) : (
            <table className="acc-merchants-table">
              <tbody>
                {rows.map(([k, n]) => (
                  <tr key={k}><td>{k}</td><td className="acc-merchant-count">{n}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <div className="acc-corrections glass-card">
        <h2 className="acc-corrections-title">Sample metadata</h2>
        <p className="acc-corrections-body">
          Sample #{sample.id} · {sample.completedAt ? new Date(sample.completedAt).toLocaleString() : "—"} ·
          confirmed {sample.confirmedCount} / corrected {sample.correctedCount} / skipped {sample.skippedCount}
        </p>
        <button type="button" className="acc-run-btn" onClick={exportJson} data-testid="btn-export-json">
          Export as JSON
        </button>
      </div>
    </div>
  );
}

// ─── Page entry ─────────────────────────────────────────────────────────────

export function ClassificationSampler() {
  const [, params] = useRoute<{ sampleId?: string }>("/dev/test-suite/classification/:sampleId?");
  const [, setLocation] = useLocation();
  const sampleIdParam = params?.sampleId ? Number.parseInt(params.sampleId, 10) : null;

  const [createState, setCreateState] = useState<CreateResponse | null>(null);
  const [sample, setSample] = useState<SampleRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Load existing sample when an ID is in the URL.
  useEffect(() => {
    if (sampleIdParam == null || !Number.isFinite(sampleIdParam)) {
      setSample(null);
      setCreateState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/dev/classification-samples/${sampleIdParam}`);
        if (!res.ok) throw new Error(`Could not load sample (${res.status})`);
        const body = (await res.json()) as { sample: SampleRecord };
        if (!cancelled) setSample(body.sample);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sampleIdParam]);

  async function startNew() {
    setError(null);
    setStarting(true);
    try {
      const res = await apiFetch("/api/dev/classification-samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleSize: 50 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Could not start sample (${res.status})`);
      }
      const body = (await res.json()) as CreateResponse;
      setCreateState(body);
      setLocation(`/dev/test-suite/classification/${body.sampleId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setStarting(false);
    }
  }

  // Header is consistent across all states.
  const header = useMemo(
    () => (
      <div className="acc-page-header">
        <div>
          <h1 className="acc-page-title">Classification Sampler</h1>
          <p className="acc-page-subtitle">
            Verify the classifier's category, class, and recurrence on 50 random transactions.
          </p>
        </div>
        <Link href="/dev/test-suite" className="acc-run-btn" data-testid="link-back-index">
          ← Test Suite
        </Link>
      </div>
    ),
    [],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  // Three states:
  //   1. No URL id + no createState → start screen
  //   2. URL id present, sample completed → report screen
  //   3. URL id present, sample in progress (or just created) → review screen

  if (sampleIdParam == null) {
    return (
      <div className="acc-page">
        {header}
        {error && <div className="acc-error glass-card" role="alert">{error}</div>}
        <div className="acc-explainer glass-card">
          <h2 className="acc-explainer-title">Start a new sample</h2>
          <p>
            We will pull 50 random transactions you have not already manually corrected and ask you
            to verify each one. The whole flow takes about 5–10 minutes.
          </p>
          <button
            type="button"
            className="acc-run-btn"
            onClick={() => void startNew()}
            disabled={starting}
            data-testid="btn-start-sample"
          >
            {starting ? "Starting…" : "Start sample"}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="acc-page">
        {header}
        <div className="acc-loading glass-card"><p className="acc-loading-text">Loading sample…</p></div>
      </div>
    );
  }

  if (error && !sample && !createState) {
    return (
      <div className="acc-page">
        {header}
        <div className="acc-error glass-card" role="alert" data-testid="text-load-error">{error}</div>
      </div>
    );
  }

  // Completed sample → report
  if (sample?.completedAt) {
    return (
      <div className="acc-page">
        {header}
        <ReportScreen sample={sample} />
      </div>
    );
  }

  // In-progress sample
  // If we have createState (just created in this session), use those transactions.
  // Otherwise we loaded an in-progress sample from URL — the verdicts snapshot
  // contains everything we need to reconstruct the review screen.
  const txns: SampleTransaction[] | null = createState
    ? createState.transactions
    : sample
    ? sample.verdicts.map((v) => ({
        id: v.transactionId,
        date: "",
        rawDescription: `Transaction #${v.transactionId}`,
        amount: 0,
        category: v.classifierCategory,
        transactionClass: v.classifierClass,
        recurrenceType: v.classifierRecurrence,
        labelSource: v.classifierLabelSource,
        labelConfidence: v.classifierLabelConfidence,
      }))
    : null;

  if (!txns) {
    return (
      <div className="acc-page">
        {header}
        <div className="acc-empty glass-card">
          <p className="acc-empty-text">Sample not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="acc-page">
      {header}
      <ReviewScreen
        sampleId={sampleIdParam}
        transactions={txns}
        onSubmitted={(s) => setSample(s)}
      />
    </div>
  );
}
