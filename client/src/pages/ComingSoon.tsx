import { FormEvent, useState } from "react";
import { apiFetch } from "../lib/api";

function IconDoc() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.5 12h7M8.5 15.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconTag() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h7.172a2 2 0 0 1 1.414.586l5.828 5.828a2 2 0 0 1 0 2.828l-4.172 4.172a2 2 0 0 1-2.828 0L6.586 13.414A2 2 0 0 1 6 12V7H3z"
        fill="currentColor"
        opacity="0.15"
      />
      <path
        d="M3 7a2 2 0 0 1 2-2h7.172a2 2 0 0 1 1.414.586l5.828 5.828a2 2 0 0 1 0 2.828l-4.172 4.172a2 2 0 0 1-2.828 0L6.586 13.414A2 2 0 0 1 6 12V7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9" r="1.25" fill="currentColor" />
    </svg>
  );
}

function IconBars() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="13" width="4" height="8" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="10" y="8" width="4" height="13" rx="1" fill="currentColor" opacity="0.75" />
      <rect x="17" y="4" width="4" height="17" rx="1" fill="currentColor" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 7l8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const FEATURES: { title: string; description: string; icon: () => JSX.Element }[] = [
  { title: "CSV Import", description: "Bring in your data in seconds", icon: IconDoc },
  { title: "Auto-Categorization", description: "Accurate categories from the moment you import", icon: IconTag },
  { title: "Spending Insights", description: "Understand patterns and save more", icon: IconBars },
];

function CardDecorations() {
  return (
    <div className="coming-soon-decor" aria-hidden="true">
      <svg className="cs-decor cs-decor--donut" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="84" fill="#cbd5e1" />
        <path d="M 100 100 L 100 16 A 84 84 0 0 1 181.07 121.65 Z" fill="#0ea5e9" />
        <path d="M 100 100 L 181.07 121.65 A 84 84 0 0 1 132.61 174.46 Z" fill="#38bdf8" />
      </svg>

      <div className="cs-decor cs-decor--mini">
        <div className="cs-mini-label">Monthly Overview</div>
        <div className="cs-mini-amount">$4,287.63</div>
        <div className="cs-mini-delta">+12.4% vs last month</div>
        <svg className="cs-mini-spark" viewBox="0 0 120 36" preserveAspectRatio="none">
          <defs>
            <linearGradient id="cs-spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0,28 L18,24 L36,26 L54,16 L72,20 L90,10 L120,4 L120,36 L0,36 Z"
            fill="url(#cs-spark-fill)"
          />
          <path
            d="M0,28 L18,24 L36,26 L54,16 L72,20 L90,10 L120,4"
            stroke="#0ea5e9"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <span className="cs-decor cs-ontrack-pill">
        <span className="cs-ontrack-dot" />
        On track
      </span>

      <div className="cs-decor cs-decor--bars">
        <svg viewBox="0 0 220 120" preserveAspectRatio="none">
          <g>
            <rect x="6" y="78" width="16" height="36" rx="2" fill="#bae6fd" />
            <rect x="32" y="68" width="16" height="46" rx="2" fill="#bae6fd" />
            <rect x="58" y="60" width="16" height="54" rx="2" fill="#7dd3fc" />
            <rect x="84" y="52" width="16" height="62" rx="2" fill="#7dd3fc" />
            <rect x="110" y="44" width="16" height="70" rx="2" fill="#38bdf8" />
            <rect x="136" y="34" width="16" height="80" rx="2" fill="#38bdf8" />
            <rect x="162" y="22" width="16" height="92" rx="2" fill="#0ea5e9" />
            <rect x="188" y="12" width="16" height="102" rx="2" fill="#0ea5e9" />
          </g>
          <path
            d="M14,82 L40,72 L66,64 L92,56 L118,48 L144,38 L170,26 L196,16"
            stroke="#0284c7"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

export function ComingSoon({ onUnlock }: { onUnlock: () => void }) {
  const [showInput, setShowInput] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState("");
  const [waitlistState, setWaitlistState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [waitlistError, setWaitlistError] = useState("");

  function rejectCode() {
    setError(true);
    setShaking(true);
    setTimeout(() => setShaking(false), 500);
    setTimeout(() => setError(false), 2500);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/beta/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (res.ok && data?.ok) {
        onUnlock();
      } else {
        rejectCode();
      }
    } catch {
      rejectCode();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWaitlistSubmit(e: FormEvent) {
    e.preventDefault();
    setWaitlistError("");
    setWaitlistState("loading");
    try {
      const res = await apiFetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setWaitlistState("success");
      } else {
        setWaitlistError(data.error ?? "Something went wrong. Please try again.");
        setWaitlistState("error");
      }
    } catch {
      setWaitlistError("Something went wrong. Please try again.");
      setWaitlistState("error");
    }
  }

  return (
    <main className="coming-soon-main">
      <div className="coming-soon-card">
        <CardDecorations />
        <div className="coming-soon-content">
        <svg
          className="coming-soon-logo"
          aria-hidden="true"
          viewBox="0 0 32 14"
          fill="none"
        >
          <defs>
            <linearGradient id="cs-logo-grad" x1="0" y1="0" x2="32" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#0ea5e9" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>
            <filter
              id="cs-logo-glow"
              x="-8"
              y="-8"
              width="48"
              height="30"
              filterUnits="userSpaceOnUse"
            >
              <feGaussianBlur in="SourceAlpha" stdDeviation="0.7" result="blur" />
              <feFlood floodColor="#0ea5e9" floodOpacity="0.85">
                <animate
                  attributeName="flood-opacity"
                  values="0.55;0.95;0.55"
                  dur="2.8s"
                  repeatCount="indefinite"
                />
              </feFlood>
              <feComposite in2="blur" operator="in" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <polyline
            points="0,7 6,7 9,1 12,13 15,7 32,7"
            stroke="url(#cs-logo-grad)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#cs-logo-glow)"
          />
        </svg>

        <div className="coming-soon-wordmark" data-testid="cs-brand">
          <span className="cs-wordmark-pocket">POCKET</span>
          <span className="cs-wordmark-pulse">PULSE</span>
        </div>

        <h1 className="coming-soon-title" data-testid="cs-heading">
          Coming Soon
        </h1>

        <p className="coming-soon-tagline" data-testid="cs-tagline">
          Smart financial clarity for everyday decisions.
          <br />
          We're putting the finishing touches on PocketPulse.
          <br />
          Launching soon.
        </p>

        <div className="coming-soon-features">
          {FEATURES.map(({ title, description, icon: Icon }) => (
            <div key={title} className="cs-feature">
              <div className="cs-feature-icon">
                <Icon />
              </div>
              <div className="cs-feature-text">
                <div className="cs-feature-title">{title}</div>
                <div className="cs-feature-desc">{description}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="coming-soon-form-section">
          {waitlistState === "success" ? (
            <div data-testid="cs-waitlist-success" className="coming-soon-success">
              You're on the list! We'll notify you at launch.
            </div>
          ) : (
            <form onSubmit={handleWaitlistSubmit} data-testid="cs-waitlist-form" className="coming-soon-form">
              <label htmlFor="cs-waitlist-email-input" className="coming-soon-label cs-label-with-icon">
                <span className="cs-label-icon"><IconMail /></span>
                Get notified at launch
              </label>
              <div className="cs-input-wrap">
                <span className="cs-input-icon"><IconMail /></span>
                <input
                  id="cs-waitlist-email-input"
                  className="coming-soon-input cs-input--with-icon"
                  type="email"
                  value={email}
                  data-testid="cs-waitlist-email"
                  onChange={(e) => { setEmail(e.target.value); setWaitlistError(""); if (waitlistState === "error") setWaitlistState("idle"); }}
                  placeholder="your@email.com"
                  autoComplete="email"
                  required
                />
              </div>
              {waitlistState === "error" && waitlistError && (
                <p role="alert" data-testid="cs-waitlist-error" className="coming-soon-error">
                  {waitlistError}
                </p>
              )}
              <button
                className="coming-soon-submit"
                type="submit"
                data-testid="cs-waitlist-submit"
                disabled={waitlistState === "loading"}
              >
                <span>{waitlistState === "loading" ? "Saving…" : "Notify me"}</span>
                {waitlistState !== "loading" && (
                  <span className="cs-submit-arrow"><IconArrowRight /></span>
                )}
              </button>
            </form>
          )}
        </div>

        <div className="coming-soon-divider">
          {!showInput ? (
            <button
              type="button"
              data-testid="cs-beta-toggle"
              onClick={() => setShowInput(true)}
              className="coming-soon-link-button"
            >
              Have a beta access code?
            </button>
          ) : (
            <form
              onSubmit={handleSubmit}
              data-testid="cs-beta-form"
              className={shaking ? "coming-soon-form coming-soon-form--shake" : "coming-soon-form"}
            >
              <label>
                <span className="coming-soon-label">
                  Beta Access Code
                </span>
                <input
                  className="coming-soon-input coming-soon-input--code"
                  type="text"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  data-testid="cs-code-input"
                  onChange={(e) => { setCode(e.target.value); setError(false); }}
                  placeholder="Enter code"
                />
              </label>
              {error && (
                <p role="alert" data-testid="cs-error" className="coming-soon-error">
                  Invalid code — try again.
                </p>
              )}
              <button
                className="coming-soon-submit"
                type="submit"
                data-testid="cs-submit"
                disabled={submitting}
              >
                {submitting ? "Checking…" : "Unlock"}
              </button>
              <button
                type="button"
                onClick={() => { setShowInput(false); setCode(""); setError(false); }}
                className="coming-soon-link-button cs-link-plain"
              >
                Cancel
              </button>
            </form>
          )}
        </div>

        </div>{/* coming-soon-content */}
      </div>
    </main>
  );
}
