import { FormEvent, useState } from "react";
import { apiFetch } from "../lib/api";

const BETA_CODE =
  (import.meta.env.VITE_BETA_CODE as string | undefined)?.trim().toLowerCase() ||
  "pennysavers2025";

export function ComingSoon({ onUnlock }: { onUnlock: () => void }) {
  const [showInput, setShowInput] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [shaking, setShaking] = useState(false);

  const [email, setEmail] = useState("");
  const [waitlistState, setWaitlistState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [waitlistError, setWaitlistError] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (code.trim().toLowerCase() === BETA_CODE) {
      onUnlock();
    } else {
      setError(true);
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
      setTimeout(() => setError(false), 2500);
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

        <div className="coming-soon-eyebrow">
          <span data-testid="cs-brand">PocketPulse</span>
          <span className="coming-soon-eyebrow-dot" aria-hidden="true" />
        </div>

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
            {/* Stroke-hugging cyan glow.
                filterUnits="userSpaceOnUse" + an explicit oversized region
                lets the glow extend well beyond the stroke without being
                clipped to the SVG bounding box (combined with the parent
                CSS `overflow: visible`). The blur is composited with a
                cyan flood and merged behind the original stroke so the
                halo follows the alpha shape of the polyline — never the
                rectangular element bounds. */}
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

        <h1 className="coming-soon-title" data-testid="cs-heading">
          Coming Soon
        </h1>
        <p className="coming-soon-tagline" data-testid="cs-tagline">
          Smart financial clarity for everyone.
          <br />
          We're putting the finishing touches on PocketPulse.
        </p>

        <div className="coming-soon-pills">
          {["CSV Import", "AI Classification", "Spending Insights"].map((label) => (
            <span key={label} className="coming-soon-pill">{label}</span>
          ))}
        </div>

        <div className="coming-soon-form-section">
          {waitlistState === "success" ? (
            <div data-testid="cs-waitlist-success" className="coming-soon-success">
              You're on the list! We'll notify you at launch.
            </div>
          ) : (
            <form onSubmit={handleWaitlistSubmit} data-testid="cs-waitlist-form" style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
              <label>
                <span className="coming-soon-label">
                  Get notified at launch
                </span>
                <input
                  className="coming-soon-input"
                  type="email"
                  value={email}
                  data-testid="cs-waitlist-email"
                  onChange={(e) => { setEmail(e.target.value); setWaitlistError(""); if (waitlistState === "error") setWaitlistState("idle"); }}
                  placeholder="your@email.com"
                  autoComplete="email"
                  required
                />
              </label>
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
                {waitlistState === "loading" ? "Saving…" : "Notify me"}
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
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                animation: shaking ? "cs-shake 0.45s ease" : undefined,
              }}
            >
              <label>
                <span className="coming-soon-label">
                  Beta Access Code
                </span>
                <input
                  className="coming-soon-input"
                  type="text"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  data-testid="cs-code-input"
                  onChange={(e) => { setCode(e.target.value); setError(false); }}
                  placeholder="Enter code"
                  style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}
                />
              </label>
              {error && (
                <p role="alert" data-testid="cs-error" className="coming-soon-error">
                  Invalid code — try again.
                </p>
              )}
              <button className="coming-soon-submit" type="submit" data-testid="cs-submit">
                Unlock
              </button>
              <button
                type="button"
                onClick={() => { setShowInput(false); setCode(""); setError(false); }}
                className="coming-soon-link-button"
                style={{ textDecoration: "none" }}
              >
                Cancel
              </button>
            </form>
          )}
        </div>

      </div>
    </main>
  );
}
