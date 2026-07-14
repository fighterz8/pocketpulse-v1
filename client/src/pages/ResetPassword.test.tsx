/**
 * Component tests for ResetPassword.
 *
 * The most important behaviour to lock in: after a successful reset
 * the page MUST set the password-reset success flag and trigger a
 * full-page navigation to `/`, so the normal signed-out auth route can
 * show the post-reset notice.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch, mockSetLocation } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockSetLocation: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  apiFetch: mockApiFetch,
  readJsonError: async (res: Response) => {
    try {
      const body = await res.json();
      return body?.error ?? "error";
    } catch {
      return "error";
    }
  },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/reset-password", mockSetLocation],
}));

import {
  PASSWORD_RESET_SUCCESS_FLAG,
  ResetPassword,
} from "./ResetPassword";

const ORIGINAL_LOCATION = window.location;
let assignSpy: ReturnType<typeof vi.fn>;

function setLocationSearch(search: string) {
  // jsdom's window.location is read-only; replace with a stub for the
  // duration of one test. We restore the original in afterEach.
  assignSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...ORIGINAL_LOCATION,
      search,
      assign: assignSpy,
    },
  });
}

describe("ResetPassword", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockSetLocation.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: ORIGINAL_LOCATION,
    });
  });

  it("renders the no-token error when the URL has no ?token query", () => {
    setLocationSearch("");
    render(<ResetPassword />);
    expect(screen.getByTestId("text-reset-no-token")).toBeInTheDocument();
    expect(screen.queryByTestId("input-new-password")).not.toBeInTheDocument();
  });

  it("on a successful reset, sets the success flag and full-page-navigates to /", async () => {
    setLocationSearch("?token=42.deadbeefverifier");
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<ResetPassword />);

    fireEvent.change(screen.getByTestId("input-new-password"), {
      target: { value: "newlongpassword" },
    });
    fireEvent.change(screen.getByTestId("input-confirm-password"), {
      target: { value: "newlongpassword" },
    });
    fireEvent.click(screen.getByTestId("button-reset-password"));

    // Wait for the success notice to appear (proves the success state
    // and the post-success effect have run / been scheduled).
    await waitFor(() => {
      expect(screen.getByTestId("text-reset-success")).toBeInTheDocument();
    });

    // The redirect runs after a 1.8s real-timer pause so the user can
    // read the success notice. Wait for the side effects with a
    // generous timeout rather than fake timers (waitFor itself relies
    // on real timers).
    await waitFor(
      () => {
        expect(assignSpy).toHaveBeenCalled();
      },
      { timeout: 4_000 },
    );

    // 1. PASSWORD_RESET_SUCCESS_FLAG so Auth shows the "updated" notice.
    expect(window.localStorage.getItem(PASSWORD_RESET_SUCCESS_FLAG)).toBe("1");
    // Full-page nav (window.location.assign) — NOT a wouter setLocation,
    // because AppGate should remount into the normal signed-out route.
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/");
    expect(mockSetLocation).not.toHaveBeenCalled();
  });

  it("on a failed reset, shows the server error and does NOT redirect or set flags", async () => {
    setLocationSearch("?token=42.deadbeefverifier");
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "This reset link has expired or already been used",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    render(<ResetPassword />);

    fireEvent.change(screen.getByTestId("input-new-password"), {
      target: { value: "newlongpassword" },
    });
    fireEvent.change(screen.getByTestId("input-confirm-password"), {
      target: { value: "newlongpassword" },
    });
    fireEvent.click(screen.getByTestId("button-reset-password"));

    await waitFor(() => {
      expect(screen.getByTestId("text-reset-error")).toHaveTextContent(
        /expired or already been used/i,
      );
    });

    // Give the (non-existent) success-redirect timer plenty of time to
    // fire so we'd notice if a regression scheduled one on the error
    // path.
    await new Promise((r) => setTimeout(r, 2_100));

    expect(window.localStorage.getItem(PASSWORD_RESET_SUCCESS_FLAG)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords client-side without calling the API", async () => {
    setLocationSearch("?token=42.deadbeefverifier");
    render(<ResetPassword />);

    fireEvent.change(screen.getByTestId("input-new-password"), {
      target: { value: "newlongpassword" },
    });
    fireEvent.change(screen.getByTestId("input-confirm-password"), {
      target: { value: "differentpw" },
    });
    fireEvent.click(screen.getByTestId("button-reset-password"));

    await waitFor(() => {
      expect(screen.getByTestId("text-reset-error")).toHaveTextContent(
        /do not match/i,
      );
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
