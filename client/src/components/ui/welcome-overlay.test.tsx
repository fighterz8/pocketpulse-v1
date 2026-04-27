import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WELCOME_SEEN_FLAG, WelcomeOverlay } from "./welcome-overlay";

describe("WelcomeOverlay", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.style.overflow = "";
  });

  it("does not render when enabled is false", () => {
    render(<WelcomeOverlay enabled={false} />);
    expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
  });

  it("does not render when the seen flag is already set", () => {
    window.localStorage.setItem(WELCOME_SEEN_FLAG, "1");
    render(<WelcomeOverlay enabled />);
    expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
  });

  it("renders the welcome card with rule-based-not-AI copy when enabled and unseen", () => {
    render(<WelcomeOverlay enabled />);
    const card = screen.getByTestId("welcome-overlay");
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute("role", "dialog");
    expect(card).toHaveAttribute("aria-modal", "true");
    const body = screen.getByTestId("welcome-overlay-body");
    // Must explicitly contrast rule-based vs AI guess.
    expect(body).toHaveTextContent(/rule-based/i);
    expect(body).toHaveTextContent(/not an opaque AI guess/i);
    expect(body).toHaveTextContent(/your corrections/i);
  });

  it("focuses the dismiss CTA on mount", () => {
    render(<WelcomeOverlay enabled />);
    const cta = screen.getByTestId("welcome-overlay-dismiss");
    expect(document.activeElement).toBe(cta);
  });

  it("locks body scroll while open and restores on dismiss", () => {
    render(<WelcomeOverlay enabled />);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByTestId("welcome-overlay-dismiss"));
    expect(document.body.style.overflow).toBe("");
  });

  it("dismisses on CTA click and persists the flag", () => {
    const onDismiss = vi.fn();
    render(<WelcomeOverlay enabled onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("welcome-overlay-dismiss"));
    expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WELCOME_SEEN_FLAG)).toBe("1");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on backdrop click but NOT when clicking inside the card", () => {
    render(<WelcomeOverlay enabled />);
    // Click inside the card — overlay stays open.
    fireEvent.click(screen.getByTestId("welcome-overlay-title"));
    expect(screen.getByTestId("welcome-overlay")).toBeInTheDocument();
    // Click on the backdrop — overlay closes.
    fireEvent.click(screen.getByTestId("welcome-overlay-backdrop"));
    expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WELCOME_SEEN_FLAG)).toBe("1");
  });

  it("dismisses on Escape", () => {
    render(<WelcomeOverlay enabled />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WELCOME_SEEN_FLAG)).toBe("1");
  });

  it("restores focus to the underlying form input after CTA dismiss", async () => {
    render(
      <>
        <input data-testid="input-account-label" />
        <WelcomeOverlay
          enabled
          restoreFocusSelector="[data-testid='input-account-label']"
        />
      </>,
    );
    fireEvent.click(screen.getByTestId("welcome-overlay-dismiss"));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("input-account-label"),
      );
    });
  });

  it("restores focus to the underlying form input after backdrop dismiss", async () => {
    render(
      <>
        <input data-testid="input-account-label" />
        <WelcomeOverlay
          enabled
          restoreFocusSelector="[data-testid='input-account-label']"
        />
      </>,
    );
    fireEvent.click(screen.getByTestId("welcome-overlay-backdrop"));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("input-account-label"),
      );
    });
  });

  it("restores focus to the underlying form input after Escape dismiss", async () => {
    render(
      <>
        <input data-testid="input-account-label" />
        <WelcomeOverlay
          enabled
          restoreFocusSelector="[data-testid='input-account-label']"
        />
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("input-account-label"),
      );
    });
  });

  it("traps Tab when focus has escaped the dialog", () => {
    // Render an element OUTSIDE the dialog that we can move focus to.
    const outside = document.createElement("button");
    outside.setAttribute("data-testid", "outside-button");
    outside.textContent = "outside";
    document.body.prepend(outside);
    try {
      render(<WelcomeOverlay enabled />);
      const cta = screen.getByTestId("welcome-overlay-dismiss");
      // Force focus to escape the modal — focusin retention should pull it back.
      outside.focus();
      // Document-level focusin listener fires synchronously on focus().
      expect(document.activeElement).toBe(cta);

      // Even if a Tab event somehow fires while focus was elsewhere,
      // the keydown handler also redirects focus back inside the card.
      // Move focus out, then dispatch a Tab keydown directly.
      outside.focus();
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement?.getAttribute("data-testid")).toBe(
        "welcome-overlay-dismiss",
      );
    } finally {
      outside.remove();
    }
  });

  it("marks sibling elements of the backdrop inert and aria-hidden while open", () => {
    // Mirror the production AppGate structure: a Step-1 sibling next to the
    // overlay inside the same parent fragment.
    const { unmount } = render(
      <>
        <div data-testid="behind">Behind</div>
        <WelcomeOverlay enabled />
      </>,
    );
    const sibling = screen.getByTestId("behind");
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(sibling.getAttribute("aria-hidden")).toBe("true");
    unmount();
    // After unmount the attributes we added are cleaned up. Re-create the
    // node by rendering again with the overlay disabled to assert defaults.
    const { getByTestId } = render(
      <>
        <div data-testid="behind-2">Behind 2</div>
        <WelcomeOverlay enabled={false} />
      </>,
    );
    const sibling2 = getByTestId("behind-2");
    expect(sibling2.hasAttribute("inert")).toBe(false);
    expect(sibling2.getAttribute("aria-hidden")).toBeNull();
  });
});
