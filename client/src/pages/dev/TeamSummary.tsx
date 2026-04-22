import { useEffect, useState } from "react";
import { Link } from "wouter";
import { apiFetch } from "../../lib/api";

type TeamUser = {
  userId: number;
  email: string | null;
  displayName: string | null;
  classification: {
    sampleId: number;
    completedAt: string | null;
    sampleSize: number;
    categoryAccuracy: number | null;
    classAccuracy: number | null;
    recurrenceAccuracy: number | null;
    confirmedCount: number;
    correctedCount: number;
    skippedCount: number;
  } | null;
  parser: unknown | null;
};

/** Spec §6: every percent must be paired with a raw fraction. */
function pctWithFraction(
  acc: number | null,
  c: { sampleSize: number; skippedCount: number },
): { pct: string; raw: string } {
  if (acc == null) return { pct: "—", raw: "" };
  const denom = c.sampleSize - c.skippedCount;
  if (denom <= 0) return { pct: "—", raw: "" };
  const num = Math.round(acc * denom);
  return { pct: `${(acc * 100).toFixed(0)}%`, raw: `(${num}/${denom})` };
}

export function TeamSummary() {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch("/api/dev/team-summary");
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Could not load team summary (${res.status})`);
        }
        const body = (await res.json()) as { users: TeamUser[] };
        if (!cancelled) setUsers(body.users);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="acc-page" data-testid="page-team-summary">
      <div className="acc-page-header">
        <div>
          <h1 className="acc-page-title">Team side-by-side</h1>
          <p className="acc-page-subtitle">
            Latest completed classification sample for each whitelisted teammate.
          </p>
        </div>
        <Link href="/dev/test-suite" className="acc-run-btn" data-testid="link-back-index">
          ← Test Suite
        </Link>
      </div>

      {error ? (
        <div className="acc-error glass-card" role="alert" data-testid="text-team-error">{error}</div>
      ) : loading ? (
        <div className="acc-loading glass-card"><p className="acc-loading-text">Loading…</p></div>
      ) : users.length === 0 ? (
        <div className="acc-empty glass-card">
          <p className="acc-empty-text">No teammates configured. Set DEV_TEAM_USER_IDS to populate this view.</p>
        </div>
      ) : (
        <div className="acc-merchants glass-card">
          <div className="acc-merchants-table-wrap">
            <table className="acc-merchants-table">
              <thead>
                <tr>
                  <th>Teammate</th>
                  <th>Sample</th>
                  <th>Size</th>
                  <th>Category</th>
                  <th>Class</th>
                  <th>Recurrence</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const c = u.classification;
                  const denom = c ? c.sampleSize - c.skippedCount : 0;
                  const cat = c ? pctWithFraction(c.categoryAccuracy, c) : null;
                  const cls = c ? pctWithFraction(c.classAccuracy, c) : null;
                  const rec = c ? pctWithFraction(c.recurrenceAccuracy, c) : null;
                  return (
                    <tr key={u.userId} data-testid={`row-team-${u.userId}`}>
                      <td>
                        <div>{u.displayName ?? `User #${u.userId}`}</div>
                        <div className="acc-metric-raw">{u.email ?? "(unknown email)"}</div>
                      </td>
                      <td>{c ? `#${c.sampleId}` : "—"}</td>
                      <td>{c ? `${denom}/${c.sampleSize}` : "—"}</td>
                      <td>
                        {cat?.pct ?? "—"}
                        <div className="acc-metric-raw">{cat?.raw ?? ""}</div>
                      </td>
                      <td>
                        {cls?.pct ?? "—"}
                        <div className="acc-metric-raw">{cls?.raw ?? ""}</div>
                      </td>
                      <td>
                        {rec?.pct ?? "—"}
                        <div className="acc-metric-raw">{rec?.raw ?? ""}</div>
                      </td>
                      <td>{c?.completedAt ? new Date(c.completedAt).toLocaleDateString() : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
