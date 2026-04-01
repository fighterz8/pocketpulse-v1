import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const { mockAuthState } = vi.hoisted(() => ({
  mockAuthState: {
    isLoading: false,
    isAuthenticated: false as boolean,
    user: null as null | { id: number; email: string; displayName: string },
    meError: null as Error | null,
    refetch: vi.fn(),
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
}));

vi.mock("./hooks/use-auth", () => ({
  useAuth: () => mockAuthState,
}));

describe("app shell", () => {
  beforeEach(() => {
    mockAuthState.isLoading = false;
    mockAuthState.isAuthenticated = false;
    mockAuthState.user = null;
    mockAuthState.meError = null;
    mockAuthState.refetch.mockReset();
    mockAuthState.login.mutateAsync.mockReset();
    mockAuthState.login.isPending = false;
    mockAuthState.login.error = null;
    mockAuthState.login.reset.mockReset();
    mockAuthState.register.mutateAsync.mockReset();
    mockAuthState.register.isPending = false;
    mockAuthState.register.error = null;
    mockAuthState.register.reset.mockReset();
  });

  it("renders the app root", () => {
    render(<App />);
    expect(screen.getByTestId("app-root")).toBeInTheDocument();
  });

  it("routes signed-out users to the auth screen", () => {
    mockAuthState.isAuthenticated = false;
    mockAuthState.isLoading = false;
    render(<App />);
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create an account/i }),
    ).toBeInTheDocument();
  });
});
