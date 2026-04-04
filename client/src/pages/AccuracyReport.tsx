import { motion } from "framer-motion";
import { useAccuracyReport } from "../hooks/use-accuracy";

const fade = { hidden: { opacity: 0, y: 10 }, visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08 } }) };

function pct(n: number, dec = 1) {
  return (n * 100).toFixed(dec) + "%";
}

function ScoreRing({ score }: { score: number }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  const color = score >= 80 ? "#22c55e" : score >= 60 ? "#f59e0b" : "#ef4444";
  return (
    <div className="acc-score-ring-wrap" aria-label={`Overall score: ${score}%`}>
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="70" cy="70" r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform="rotate(-90 70 70)"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="acc-score-ring-label">
        <span className="acc-score-number" style={{ color }}>{score}</span>
        <span className="acc-score-pct">/100</span>
      </div>
    </div>
  );
}

function ConfBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pctVal = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="acc-bar-row">
      <span className="acc-bar-label">{label}</span>
      <div className="acc-bar-track">
        <div className="acc-bar-fill" style={{ width: `${pctVal}%`, background: color }} />
      </div>
      <span className="acc-bar-pct">{pctVal.toFixed(0)}%</span>
      <span className="acc-bar-count">({count.toLocaleString()})</span>
    </div>
  );
}

function MetricCard({ title, value, sub, color, delay }: {
  title: string; value: string; sub: string; color: string; delay: number;
}) {
  return (
    <motion.div className="acc-metric-card" variants={fade} custom={delay} style={{ borderLeftColor: color }}>
      <p className="acc-metric-title">{title}</p>
      <p className="acc-metric-value" style={{ color }}>{value}</p>
      <p className="acc-metric-sub">{sub}</p>
    </motion.div>
  );
}

export function AccuracyReport() {
  const { data, isLoading, error } = useAccuracyReport();

  if (isLoading) {
    return (
      <div className="acc-page">
        <h1 className="acc-heading">Classifier Accuracy</h1>
        <p className="acc-loading">Analyzing your transactions…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="acc-page">
        <h1 className="acc-heading">Classifier Accuracy</h1>
        <p className="acc-error">Failed to load accuracy report. Try again later.</p>
      </div>
    );
  }

  if (data.totalTransactions === 0) {
    return (
      <div className="acc-page">
        <h1 className="acc-heading">Classifier Accuracy</h1>
        <p className="acc-empty">No transactions yet — upload a CSV to see your accuracy report.</p>
      </div>
    );
  }

  const { labelSourceBreakdown: ls, confidenceDistribution: cd } = data;
  const confTotal = cd.high + cd.medium + cd.low + cd.unknown;
  const lsTotal = ls.rule + ls.ai + ls.manual + ls.propagated + ls.recurringTransfer + ls.other;

  const scoreColor = data.overallScore >= 80 ? "#22c55e" : data.overallScore >= 60 ? "#f59e0b" : "#ef4444";
  const scoreLabel = data.overallScore >= 80 ? "Good" : data.overallScore >= 60 ? "Fair" : "Needs work";

  return (
    <div className="acc-page">
      <motion.div variants={fade} initial="hidden" animate="visible" custom={0}>
        <h1 className="acc-heading">Classifier Accuracy</h1>
        <p className="acc-subheading">
          Estimated from {data.totalTransactions.toLocaleString()} transactions — no manual review required.
        </p>
      </motion.div>

      {/* Score hero */}
      <motion.div className="acc-hero" variants={fade} initial="hidden" animate="visible" custom={1}>
        <ScoreRing score={data.overallScore} />
        <div className="acc-hero-text">
          <p className="acc-hero-label" style={{ color: scoreColor }}>{scoreLabel}</p>
          <p className="acc-hero-desc">
            Weighted from four independent signals: label trust, confidence, merchant consistency,
            and user correction rate. Higher is better.
          </p>
        </div>
      </motion.div>

      {/* Metric cards */}
      <motion.div className="acc-metrics" initial="hidden" animate="visible">
        <MetricCard
          delay={2}
          title="Merchant consistency"
          value={pct(data.merchantConsistencyRate)}
          sub="Multi-occurrence merchants with a consistent category"
          color={data.merchantConsistencyRate >= 0.9 ? "#22c55e" : data.merchantConsistencyRate >= 0.75 ? "#f59e0b" : "#ef4444"}
        />
        <MetricCard
          delay={3}
          title="User correction rate"
          value={pct(data.correctionRate)}
          sub="AI-labeled transactions manually overridden"
          color={data.correctionRate <= 0.05 ? "#22c55e" : data.correctionRate <= 0.15 ? "#f59e0b" : "#ef4444"}
        />
        <MetricCard
          delay={4}
          title="Stale AI labels"
          value={data.staleAiCount.toLocaleString()}
          sub={`Transactions the AI labeled but keyword rules now override (${pct(data.staleAiRate, 0)} of AI-labeled)`}
          color={data.staleAiRate <= 0.05 ? "#22c55e" : data.staleAiRate <= 0.20 ? "#f59e0b" : "#ef4444"}
        />
        <MetricCard
          delay={5}
          title="Rule coverage"
          value={pct(ls.rule / lsTotal)}
          sub="Classified by keyword rules (highest accuracy)"
          color="#6366f1"
        />
      </motion.div>

      {/* Label source breakdown */}
      <motion.section className="acc-section glass-card" variants={fade} initial="hidden" animate="visible" custom={6}>
        <h2 className="acc-section-title">Label source breakdown</h2>
        <p className="acc-section-desc">
          Every transaction is classified by one of these methods. Keyword rules are the most
          accurate; AI fills in the gaps. Manual and propagated are user-verified.
        </p>
        <div className="acc-bars">
          <ConfBar label="Keyword rule"        count={ls.rule}             total={lsTotal} color="#6366f1" />
          <ConfBar label="AI classified"       count={ls.ai}              total={lsTotal} color="#f59e0b" />
          <ConfBar label="User-corrected"      count={ls.manual}          total={lsTotal} color="#22c55e" />
          <ConfBar label="Propagated"          count={ls.propagated}      total={lsTotal} color="#0ea5e9" />
          <ConfBar label="Recurring transfer"  count={ls.recurringTransfer} total={lsTotal} color="#8b5cf6" />
        </div>
      </motion.section>

      {/* Confidence distribution */}
      <motion.section className="acc-section glass-card" variants={fade} initial="hidden" animate="visible" custom={7}>
        <h2 className="acc-section-title">Confidence distribution</h2>
        <p className="acc-section-desc">
          Each classification comes with a confidence score. High confidence means a strong keyword
          match or very clear pattern. Low confidence = the system was guessing.
        </p>
        <div className="acc-bars">
          <ConfBar label="High (≥ 70%)"   count={cd.high}    total={confTotal} color="#22c55e" />
          <ConfBar label="Medium (50–69%)" count={cd.medium}  total={confTotal} color="#f59e0b" />
          <ConfBar label="Low (< 50%)"     count={cd.low}     total={confTotal} color="#ef4444" />
          <ConfBar label="No score"        count={cd.unknown} total={confTotal} color="#94a3b8" />
        </div>
      </motion.section>

      {/* Inconsistent merchants */}
      {data.inconsistentMerchants.length > 0 && (
        <motion.section className="acc-section glass-card" variants={fade} initial="hidden" animate="visible" custom={8}>
          <h2 className="acc-section-title">Inconsistently classified merchants</h2>
          <p className="acc-section-desc">
            Same merchant, different categories across transactions. These are the most likely
            classification errors. Open the Ledger and search for the merchant to review and fix.
          </p>
          <div className="acc-merchant-table">
            <div className="acc-merchant-head">
              <span>Merchant</span>
              <span>Categories found</span>
              <span>Transactions</span>
            </div>
            {data.inconsistentMerchants.map((m) => (
              <div key={m.merchant} className="acc-merchant-row" data-testid={`acc-merchant-${m.merchant}`}>
                <span className="acc-merchant-name">{m.merchant}</span>
                <span className="acc-merchant-cats">
                  {m.categories.map((c) => (
                    <span key={c} className="acc-cat-chip">{c}</span>
                  ))}
                </span>
                <span className="acc-merchant-count">{m.occurrences}</span>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Stale AI callout */}
      {data.staleAiCount > 0 && (
        <motion.section className="acc-callout" variants={fade} initial="hidden" animate="visible" custom={9}>
          <p className="acc-callout-icon">⚡</p>
          <div>
            <p className="acc-callout-title">
              {data.staleAiCount} transaction{data.staleAiCount !== 1 ? "s" : ""} could be improved
            </p>
            <p className="acc-callout-desc">
              These were classified by AI, but keyword rules added since then would now give a more
              confident answer. Go to the Ledger and run "Re-classify AI labels" to update them.
            </p>
          </div>
        </motion.section>
      )}
    </div>
  );
}
