import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import { Auth } from "./Auth";

function renderAuth(props: Parameters<typeof Auth>[0] = {}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <Auth {...props} />
    </TooltipProvider>,
  );
}

const { mockAuthState, mockApiFetch } = vi.hoisted(() => ({
  mockAuthState: {
    login: {
      mutateAsync: vi.fn(),
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
    },
    register: {
      mutateAsync: vi.fn(),
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
    },
  },
  mockApiFetch: vi.fn(),
}));

vi.mock("../hooks/use-auth", () => ({
  useAuth: () => mockAuthState,
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

describe("Auth page inactivity notice", () => {
  beforeEach(() => {
    mockAuthState.login.mutateAsync.mockReset();
    mockAuthState.login.isPending = false;
    mockAuthState.login.error = null;
    mockAuthState.login.reset.mockReset();
    mockAuthState.register.mutateAsync.mockReset();
    mockAuthState.register.isPending = false;
    mockAuthState.register.error = null;
    mockAuthState.register.reset.mockReset();
    mockApiFetch.mockReset();
  });

  it("shows the inactivity notice when inactivityLogout is true", () => {
    renderAuth({ inactivityLogout: true });
    const notice = screen.getByTestId("inactivity-notice");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/logged out due to inactivity/i);
    expect(notice).toHaveAttribute("role", "status");
  });

  it("does not show the inactivity notice when inactivityLogout is false", () => {
    renderAuth({ inactivityLogout: false });
    expect(screen.queryByTestId("inactivity-notice")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/logged out due to inactivity/i),
    ).not.toBeInTheDocument();
  });

  it("does not show the inactivity notice when inactivityLogout is omitted (default false)", () => {
    renderAuth();
    expect(screen.queryByTestId("inactivity-notice")).not.toBeInTheDocument();
  });
});

describe("Auth forgot password mode", () => {
  beforeEach(() => {
    mockAuthState.login.mutateAsync.mockReset();
    mockAuthState.login.isPending = false;
    mockAuthState.login.error = null;
    mockAuthState.login.reset.mockReset();
    mockAuthState.register.mutateAsync.mockReset();
    mockAuthState.register.isPending = false;
    mockAuthState.register.error = null;
    mockAuthState.register.reset.mockReset();
    mockApiFetch.mockReset();
    window.localStorage.clear();
  });

  it("shows the Forgot password link in login mode", () => {
    renderAuth();
    expect(screen.getByTestId("link-forgot-password")).toBeInTheDocument();
  });

  it("switches to forgot mode and posts to /api/auth/forgot-password", async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    renderAuth();

    fireEvent.click(screen.getByTestId("link-forgot-password"));

    expect(
      screen.getByRole("heading", { name: /reset your password/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("input-password")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("input-email"), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByTestId("button-send-reset"));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/auth/forgot-password",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const submitted = await screen.findByTestId("text-forgot-submitted");
    expect(submitted).toHaveTextContent(/if an account exists/i);
  });

  it("validates that an email is required before submitting", async () => {
    renderAuth();
    fireEvent.click(screen.getByTestId("link-forgot-password"));
    // Submit with empty email — required attribute should block native submit
    // but we also guard explicitly for browsers / a11y agents that bypass it.
    const form = screen.getByTestId("input-email").closest("form")!;
    fireEvent.submit(form);
    // The mocked apiFetch should not have been called
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("shows the post-reset success notice when the localStorage flag is set", () => {
    window.localStorage.setItem("pp_password_reset_success", "1");
    renderAuth();
    expect(
      screen.getByTestId("text-reset-success-notice"),
    ).toBeInTheDocument();
    // Flag is consumed (cleared) so a refresh doesn't replay it.
    expect(window.localStorage.getItem("pp_password_reset_success")).toBeNull();
  });
});

describe("Auth tooltips", () => {
  beforeEach(() => {
    mockAuthState.login.mutateAsync.mockReset();
    mockAuthState.register.mutateAsync.mockReset();
    mockApiFetch.mockReset();
  });

  it("reveals the password hint tooltip when the icon is focused", async () => {
    renderAuth();
    const trigger = screen.getByTestId("hint-password");
    expect(trigger).toHaveAttribute("aria-label", "About passwords");
    fireEvent.focus(trigger);
    const content = await screen.findByTestId("hint-password-content");
    expect(content).toHaveTextContent(/8 characters/i);
  });
});
