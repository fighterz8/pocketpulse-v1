import { useEffect, useState } from "react";
import { Link } from "wouter";
import { apiFetch } from "../../lib/api";

type SampleListItem = {
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
};

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

/** Spec §6: every percent must be paired with a raw fraction. */
function pctWithFraction(
  acc: number | null,
  s: { sampleSize: number; skippedCount: number },
): string {
  if (acc == null) return "—";
  const denom = s.sampleSize - s.skippedCount;
  if (denom <= 0) return "—";
  const num = Math.round(acc * denom);
  return `${(acc * 100).toFixed(0)}% (${num}/${denom})`;
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export function TestSuiteIndex() {
  const [samples, setSamples] = useState<SampleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch("/api/dev/classification-samples");
        if (!res.ok) throw new Error(`Failed to load samples (${res.status})`);
        const body = (await res.json()) as { samples: SampleListItem[] };
        if (!cancelled) setSamples(body.samples);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="acc-page" data-testid="page-test-suite-index">
      <div className="acc-page-header">
        <div>
          <h1 className="acc-page-title">Dev Test Suite</h1>
          <p className="acc-page-subtitle">
            Measure PocketPulse on your own data. Verdicts are sandboxed — they do not modify any
            real transactions.
          </p>
        </div>
      </div>

      <div className="acc-explainer glass-card">
        <h2 className="acc-explainer-title">Tools</h2>
        <div className="acc-explainer-grid">
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">A</span>
            <div>
              <strong>Classification sampler</strong>
              <p>
                Pulls 50 random transactions and asks you to verify the classifier's category, class,
                and recurrence. The report breaks accuracy down per dimension and per labelSource so
                you can tell which subsystem is failing.
              </p>
              <p>
                <Link
                  href="/dev/test-suite/classification"
                  className="acc-run-btn"
                  data-testid="link-start-classification"
                >
                  Start classification sample
                </Link>
              </p>
            </div>
          </div>
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">T</span>
            <div>
              <strong>Team side-by-side</strong>
              <p>
                Compares the latest completed classification sample for each whitelisted teammate.
                Useful for milestone documentation.
              </p>
              <p>
                <Link
                  href="/dev/test-suite/team"
                  className="acc-run-btn"
                  data-testid="link-team-summary"
                >
                  Open team view
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="acc-merchants glass-card">
        <h2 className="acc-merchants-title">Past classification samples</h2>
        {error ? (
          <div className="acc-error" role="alert" data-testid="text-samples-error">{error}</div>
        ) : loading ? (
          <p className="acc-empty-text" data-testid="text-samples-loading">Loading…</p>
        ) : samples.length === 0 ? (
          <p className="acc-empty-text" data-testid="text-samples-empty">
            No samples yet. Start one above to see it listed here.
          </p>
        ) : (
          <div className="acc-merchants-table-wrap">
            <table className="acc-merchants-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Category</th>
                  <th>Class</th>
                  <th>Recurrence</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s) => (
                  <tr key={s.id} data-testid={`row-sample-${s.id}`}>
                    <td>{fmtDate(s.createdAt)}</td>
                    <td>{s.completedAt ? "Completed" : "In progress"}</td>
                    <td>{s.sampleSize}</td>
                    <td>{pctWithFraction(s.categoryAccuracy, s)}</td>
                    <td>{pctWithFraction(s.classAccuracy, s)}</td>
                    <td>{pctWithFraction(s.recurrenceAccuracy, s)}</td>
                    <td>
                      <Link
                        href={`/dev/test-suite/classification/${s.id}`}
                        data-testid={`link-open-sample-${s.id}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
