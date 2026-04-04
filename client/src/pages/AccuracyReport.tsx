import { useState } from "react";
import { apiFetch } from "../lib/api";
import type { AccuracyReport, CorrectionImpact } from "@shared/accuracyTypes";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number, decimals = 1) {
  return (n * 100).toFixed(decimals) + "%";
}

function scoreGrade(score: number): { label: string; color: string } {
  if (score >= 85) return { label: "Excellent", color: "#16a34a" };
  if (score >= 70) return { label: "Good", color: "#2563eb" };
  if (score >= 55) return { label: "Fair", color: "#d97706" };
  return { label: "Needs Work", color: "#dc2626" };
}

function metricGrade(rate: number): { label: string; color: string } {
  if (rate >= 0.9) return { label: "Excellent", color: "#16a34a" };
  if (rate >= 0.75) return { label: "Good", color: "#2563eb" };
  if (rate >= 0.55) return { label: "Fair", color: "#d97706" };
  return { label: "Needs Work", color: "#dc2626" };
}

function scoreExplain(score: number): string {
  if (score >= 85)
    return "The classifier is doing an excellent job on your dataset. The vast majority of transactions were categorised correctly with high confidence.";
  if (score >= 70)
    return "The classifier is performing well overall. A small portion of transactions may be miscategorised, particularly from merchants the system has not seen before.";
  if (score >= 55)
    return "The classifier is working but shows some inconsistencies. This often happens with banks that use unusual description formats or with niche merchants.";
  return "The classifier is struggling with this dataset. Consider running Reclassify and manually reviewing a sample of transactions to identify patterns.";
}

function correctionImpactMessage(
  impact: CorrectionImpact,
  count: number,
  rate: number,
): { title: string; body: string; tone: "positive" | "neutral" | "warning" } {
  switch (impact) {
    case "none":
      return {
        title: "No corrections made yet",
        body: "You have not manually changed any transaction categories. The accuracy score reflects the automatic classifier working on its own. Try reviewing a handful of transactions in the Ledger to see whether the categories look right.",
        tone: "neutral",
      };
    case "keyword-fixes":
      return {
        title: `${count} correction${count === 1 ? "" : "s"} made — keyword rule fixes`,
        body: "Your corrections were on transactions that were classified by keyword rules, not AI. These fixes improve your real-world data quality but do not affect the AI correction metric, so your overall score is unchanged by them.",
        tone: "positive",
      };
    case "low":
      return {
        title: `${count} correction${count === 1 ? "" : "s"} made — minor AI misses (${pct(rate)})`,
        body: "A small fraction of AI-classified transactions were overridden. This is completely normal — it means the AI got a few edge cases wrong. At this level, corrections have a minimal effect on your score and reflect healthy user engagement with the data.",
        tone: "positive",
      };
    case "moderate":
      return {
        title: `${count} correction${count === 1 ? "" : "s"} made — noticeable AI misses (${pct(rate)})`,
        body: "A moderate share of AI-classified transactions were manually corrected. This lowers the AI correction metric in your score slightly. It likely means the AI struggled with some specific merchants or this bank's description format. The corrections themselves improve your data accuracy.",
        tone: "warning",
      };
    case "high":
      return {
        title: `${count} correction${count === 1 ? "" : "s"} made — frequent AI misses (${pct(rate)})`,
        body: "A high proportion of AI-classified transactions were corrected. This pulls the overall score down noticeably. It commonly happens when importing from a bank the system has not been trained on. Your corrections are valuable — they tell us exactly where the classifier needs improvement.",
        tone: "warning",
      };
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  title,
  value,
  rawLine,
  description,
  rate,
}: {
  title: string;
  value: string;
  rawLine: string;
  description: string;
  rate: number;
}) {
  const grade = metricGrade(rate);
  return (
    <div className="acc-metric-card glass-card">
      <div className="acc-metric-header">
        <span className="acc-metric-title">{title}</span>
        <span className="acc-metric-grade" style={{ color: grade.color }}>
          {grade.label}
        </span>
      </div>
      <div className="acc-metric-value">{value}</div>
      <div className="acc-metric-raw">{rawLine}</div>
      <p className="acc-metric-desc">{description}</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AccuracyReport() {
  const [report, setReport] = useState<AccuracyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runReport() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/accuracy-report");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to run report");
      }
      const data = (await res.json()) as AccuracyReport;
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const ls = report?.labelSourceBreakdown;
  const cd = report?.confidenceDistribution;
  const lsTotal = ls
    ? ls.rule + ls.ai + ls.manual + ls.propagated + ls.recurringTransfer + ls.other
    : 0;
  const cdTotal = cd ? cd.high + cd.medium + cd.low + cd.unknown : 0;

  const grade = report ? scoreGrade(report.overallScore) : null;
  const correction = report
    ? correctionImpactMessage(
        report.correctionImpact,
        report.manualCorrectionCount,
        report.correctionRate,
      )
    : null;

  return (
    <div className="acc-page">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="acc-page-header">
        <div>
          <h1 className="acc-page-title">Accuracy Report</h1>
          <p className="acc-page-subtitle">
            Tests the classifier on your uploaded transactions — no manual review required.
          </p>
        </div>
        <button
          className="acc-run-btn"
          onClick={() => void runReport()}
          disabled={loading}
          data-testid="button-run-accuracy"
        >
          {loading ? "Running…" : report ? "Re-run Report" : "Run Accuracy Report"}
        </button>
      </div>

      {error ? (
        <div className="acc-error glass-card" role="alert">
          {error}
        </div>
      ) : null}

      {/* ── What is being tested ──────────────────────────────────────── */}
      <div className="acc-explainer glass-card">
        <h2 className="acc-explainer-title">What is being tested</h2>
        <p className="acc-explainer-intro">
          Four signals are measured automatically on your transaction data.
          Together they produce a single score out of 100.
        </p>
        <div className="acc-explainer-grid">
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">1</span>
            <div>
              <strong>Keyword rule coverage</strong>
              <p>How many transactions were classified by the built-in keyword rules (the most reliable path). A high rule-coverage rate means the system found confident, pattern-based matches for your merchants.</p>
            </div>
          </div>
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">2</span>
            <div>
              <strong>Confidence distribution</strong>
              <p>Each classification carries a confidence score (0–100%). This measures what fraction of your transactions were classified at high confidence (&ge;70%). Low-confidence classifications are more likely to be wrong.</p>
            </div>
          </div>
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">3</span>
            <div>
              <strong>Merchant consistency</strong>
              <p>Groups every merchant with 3+ transactions and checks whether they always receive the same category. Inconsistency is a reliable sign of misclassification — the same coffee shop should not sometimes be "dining" and sometimes "other".</p>
            </div>
          </div>
          <div className="acc-explainer-item">
            <span className="acc-explainer-num">4</span>
            <div>
              <strong>AI correction rate</strong>
              <p>Of the transactions classified by AI (not keyword rules), what fraction did you manually override? A low rate means the AI was accurate. A high rate means it struggled, which slightly lowers the overall score.</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Results (only shown after a run) ───────────────────────────── */}
      {report ? (
        <>
          {/* Overall score */}
          <div className="acc-score-card glass-card" data-testid="acc-overall-score">
            <div className="acc-score-left">
              <div className="acc-score-value" style={{ color: grade!.color }}>
                {report.overallScore}
                <span className="acc-score-denom">/100</span>
              </div>
              <div className="acc-score-grade" style={{ color: grade!.color }}>
                {grade!.label}
              </div>
            </div>
            <div className="acc-score-right">
              <div className="acc-score-meta">
                {report.totalTransactions.toLocaleString()} transactions analysed
              </div>
              <p className="acc-score-explain">{scoreExplain(report.overallScore)}</p>
            </div>
          </div>

          {/* Metric cards (2×2) */}
          <div className="acc-metrics-grid">
            <MetricCard
              title="Keyword Rule Coverage"
              value={lsTotal > 0 ? pct(ls!.rule / lsTotal) : "—"}
              rawLine={`${ls!.rule.toLocaleString()} of ${lsTotal.toLocaleString()} transactions`}
              rate={lsTotal > 0 ? ls!.rule / lsTotal : 1}
              description={
                ls!.rule / lsTotal >= 0.95
                  ? "Nearly all transactions matched a keyword rule — the strongest classification path. This is excellent."
                  : ls!.rule / lsTotal >= 0.80
                  ? "Most transactions were classified by keyword rules. A small portion fell through to AI or other methods."
                  : "A notable share of transactions did not match any keyword rule and had to rely on AI or amount-range heuristics. Adding more merchant rules would improve this."
              }
            />
            <MetricCard
              title="High-Confidence Classifications"
              value={cdTotal > 0 ? pct((cd!.high) / cdTotal) : "—"}
              rawLine={`${cd!.high.toLocaleString()} high / ${cd!.medium.toLocaleString()} medium / ${cd!.low.toLocaleString()} low`}
              rate={cdTotal > 0 ? cd!.high / cdTotal : 1}
              description={
                cd!.high / cdTotal >= 0.85
                  ? "The vast majority of classifications scored above 70% confidence — the system was sure about most of these."
                  : cd!.high / cdTotal >= 0.65
                  ? "Most classifications were high-confidence but a meaningful minority were in the medium band. Medium-confidence rows are more likely to need review."
                  : "A significant portion of transactions were classified at low or medium confidence. These are the most likely to be miscategorised."
              }
            />
            <MetricCard
              title="Merchant Consistency"
              value={pct(report.merchantConsistencyRate)}
              rawLine={
                report.inconsistentMerchants.length === 0
                  ? "No inconsistent merchants found"
                  : `${report.inconsistentMerchants.length} inconsistent merchant${report.inconsistentMerchants.length === 1 ? "" : "s"} detected`
              }
              rate={report.merchantConsistencyRate}
              description={
                report.merchantConsistencyRate >= 0.9
                  ? "Merchants are being classified consistently — the same merchant always gets the same category."
                  : report.merchantConsistencyRate >= 0.7
                  ? "Most merchants are consistent, but some appear under more than one category. This often happens when a merchant uses slightly different description strings across transactions."
                  : "A notable share of merchants appear under multiple categories. This is a strong signal of misclassification and the most impactful area to improve."
              }
            />
            <MetricCard
              title="AI Correction Rate"
              value={report.correctionRate > 0 ? pct(report.correctionRate) : "0%"}
              rawLine={
                report.manualCorrectionCount === 0
                  ? "No corrections made"
                  : `${report.manualCorrectionCount} total correction${report.manualCorrectionCount === 1 ? "" : "s"}`
              }
              rate={1 - report.correctionRate}
              description={
                report.correctionRate === 0
                  ? "No AI-classified transactions have been manually corrected. Either the AI was accurate, or transactions have not been reviewed yet."
                  : report.correctionRate < 0.05
                  ? "Very few AI classifications were overridden — the AI was accurate on your dataset."
                  : report.correctionRate < 0.15
                  ? "A moderate share of AI classifications were corrected. This is expected when importing from a less common bank."
                  : "The AI struggled significantly with this dataset. Your corrections are valuable research data."
              }
            />
          </div>

          {/* Manual corrections section */}
          <div
            className={`acc-corrections glass-card acc-corrections--${correction!.tone}`}
            data-testid="acc-corrections"
          >
            <h2 className="acc-corrections-title">Manual Corrections</h2>
            <div className="acc-corrections-badge">{correction!.title}</div>
            <p className="acc-corrections-body">{correction!.body}</p>
            {report.correctionRate > 0 && (
              <p className="acc-corrections-note">
                <strong>Effect on score:</strong>{" "}
                {report.correctionRate < 0.05
                  ? "Minimal — the correction metric is nearly at its maximum."
                  : report.correctionRate < 0.15
                  ? "Moderate — the AI correction metric accounts for 15% of the overall score."
                  : "Noticeable — a high correction rate reduces the AI correction component (15% weight) of the overall score. This reflects real AI misses, not user error."}
              </p>
            )}
          </div>

          {/* Stale AI labels (if any) */}
          {report.staleAiCount > 0 && (
            <div className="acc-stale glass-card" data-testid="acc-stale">
              <h2 className="acc-stale-title">Stale AI Labels Detected</h2>
              <p className="acc-stale-body">
                <strong>{report.staleAiCount}</strong> transaction
                {report.staleAiCount === 1 ? " was" : "s were"} classified by AI but the
                keyword rule system would now assign a different, more confident category.
                These are called "stale" labels — the rules have improved since the AI ran.
                Running <strong>Reclassify</strong> from the Ledger will update them automatically.
              </p>
            </div>
          )}

          {/* Inconsistent merchants table */}
          {report.inconsistentMerchants.length > 0 && (
            <div className="acc-merchants glass-card" data-testid="acc-merchants">
              <h2 className="acc-merchants-title">Inconsistently Classified Merchants</h2>
              <p className="acc-merchants-intro">
                These merchants appeared under more than one category across their transactions.
                This is the most actionable signal — finding them in the Ledger and correcting
                one transaction will propagate the right category to all similar ones.
              </p>
              <div className="acc-merchants-table-wrap">
                <table className="acc-merchants-table">
                  <thead>
                    <tr>
                      <th>Merchant</th>
                      <th>Categories seen</th>
                      <th>Transactions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.inconsistentMerchants.map((m, i) => (
                      <tr key={i} data-testid={`row-merchant-${i}`}>
                        <td className="acc-merchant-name">{m.merchant}</td>
                        <td>
                          {m.categories.map((c) => (
                            <span key={c} className="acc-category-chip">{c}</span>
                          ))}
                        </td>
                        <td className="acc-merchant-count">{m.occurrences}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : !loading ? (
        <div className="acc-empty glass-card">
          <p className="acc-empty-text">
            Click <strong>Run Accuracy Report</strong> above to analyse your transaction data.
            The report runs in seconds and requires no manual review.
          </p>
        </div>
      ) : (
        <div className="acc-loading glass-card">
          <p className="acc-loading-text">Analysing your transactions…</p>
        </div>
      )}
    </div>
  );
}
