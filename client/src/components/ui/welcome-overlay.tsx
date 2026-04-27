import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

export const WELCOME_SEEN_FLAG = "pp_welcome_seen";

export type WelcomeOverlayProps = {
  /**
   * If false the overlay never mounts, even if the flag is missing.
   * Used by AppGate so existing users (those with accounts) never see it.
   */
  enabled: boolean;
  /** Called after the user dismisses the overlay (and the flag is written). */
  onDismiss?: () => void;
  /**
   * CSS selector for the element to focus after the overlay is dismissed.
   * Used to return keyboard focus to the underlying form (Step 1's first
   * input) so the user can immediately start typing.
   */
  restoreFocusSelector?: string;
};

/**
 * First-run welcome overlay shown the first time a freshly authenticated
 * user lands on Step 1 of onboarding. Persists `pp_welcome_seen` in
 * localStorage on dismiss so it never replays for that browser.
 *
 * Behaviour:
 *  - Backdrop click, Esc, and the primary CTA all dismiss.
 *  - Focus is moved to the primary CTA on mount and trapped within the
 *    overlay until dismissed (Tab cycles through focusable elements).
 *  - Honours `prefers-reduced-motion` (no scale animation, just a fade).
 */
export function WelcomeOverlay({
  enabled,
  onDismiss,
  restoreFocusSelector,
}: WelcomeOverlayProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (!enabled) return false;
    try {
      return localStorage.getItem(WELCOME_SEEN_FLAG) !== "1";
    } catch {
      return true;
    }
  });
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(WELCOME_SEEN_FLAG, "1");
    } catch {
      /* storage may be unavailable in private mode — overlay still closes */
    }
    setOpen(false);
    onDismiss?.();
    // Return focus to the underlying form so the user can immediately
    // start typing. Wait one tick for the overlay (and its inert siblings)
    // to actually unmount before re-focusing.
    if (restoreFocusSelector) {
      const sel = restoreFocusSelector;
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(sel);
        target?.focus();
      });
    }
  }, [onDismiss, restoreFocusSelector]);

  // Esc-to-close + focus trap (Tab / Shift+Tab cycles within card; Tab from
  // outside the card is redirected back inside).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = card.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // If focus is somehow outside the card, pull it back in.
      if (!active || !card.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, dismiss]);

  // Belt-and-braces focus retention: if anything (programmatic focus, screen
  // reader, click) moves focus outside the card while open, snap it back to
  // the CTA on the next tick.
  useEffect(() => {
    if (!open) return;
    function onFocusIn(e: FocusEvent) {
      const card = cardRef.current;
      const target = e.target as Node | null;
      if (!card || !target) return;
      if (!card.contains(target)) {
        ctaRef.current?.focus();
      }
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open]);

  // Focus the primary CTA on mount.
  useEffect(() => {
    if (open) ctaRef.current?.focus();
  }, [open]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Make every sibling element of the backdrop inert + aria-hidden so
  // screen readers and keyboard users cannot reach Step 1 controls behind
  // the dialog. Restored on dismiss.
  useEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const parent = backdrop?.parentElement;
    if (!backdrop || !parent) return;
    const targets: HTMLElement[] = [];
    for (const child of Array.from(parent.children)) {
      if (child !== backdrop && child instanceof HTMLElement) {
        targets.push(child);
      }
    }
    const previous = targets.map((el) => ({
      el,
      inert: el.hasAttribute("inert"),
      ariaHidden: el.getAttribute("aria-hidden"),
    }));
    targets.forEach((el) => {
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    });
    return () => {
      previous.forEach(({ el, inert, ariaHidden }) => {
        if (!inert) el.removeAttribute("inert");
        if (ariaHidden === null) {
          el.removeAttribute("aria-hidden");
        } else {
          el.setAttribute("aria-hidden", ariaHidden);
        }
      });
    };
  }, [open]);

  if (!enabled || !open) return null;

  function handleBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) dismiss();
  }

  return (
    <div
      ref={backdropRef}
      className="welcome-overlay-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
      data-testid="welcome-overlay-backdrop"
    >
      <div
        ref={cardRef}
        className="welcome-overlay-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-overlay-title"
        aria-describedby="welcome-overlay-body"
        data-testid="welcome-overlay"
      >
        <div className="welcome-overlay-eyebrow" aria-hidden="true">
          <span className="welcome-overlay-dot" />
          PocketPulse
        </div>
        <h2
          id="welcome-overlay-title"
          className="welcome-overlay-title"
          data-testid="welcome-overlay-title"
        >
          Welcome.
        </h2>
        <div
          id="welcome-overlay-body"
          className="welcome-overlay-body"
          data-testid="welcome-overlay-body"
        >
          <p>
            PocketPulse turns your bank statements into a clear picture of
            where your money actually goes — quietly, and on your terms.
          </p>
          <p>
            <strong>Every category, recurring tag, and leak is rule-based
            and inspectable</strong> — not an opaque AI guess. You can see
            exactly why a transaction was labelled the way it was.
          </p>
          <p>
            When something looks wrong, fix it once. Your corrections are
            how PocketPulse gets sharper for you over time.
          </p>
        </div>
        <button
          ref={ctaRef}
          type="button"
          className="welcome-overlay-cta"
          onClick={dismiss}
          data-testid="welcome-overlay-dismiss"
        >
          Let's get started
        </button>
      </div>
    </div>
  );
}
