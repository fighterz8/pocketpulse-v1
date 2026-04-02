import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./App";

const { mockAuthState } = vi.hoisted(() => ({
  mockAuthState: {
    isLoading: false,
    isAuthenticated: false as boolean,
    user: null as null | { id: number; email: string; displayName: string },
    meError: null as Error | null,
    refetch: vi.fn(),
    accounts: null as null | { id: number; label: string }[],
    accountsLoading: false,
    accountsError: null as Error | null,
    refetchAccounts: vi.fn(),
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
    createAccount: {
      mutateAsync: vi.fn(),
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
    },
    logout: {
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
    mockAuthState.accounts = null;
    mockAuthState.accountsLoading = false;
    mockAuthState.accountsError = null;
    mockAuthState.refetchAccounts.mockReset();
    mockAuthState.createAccount.mutateAsync.mockReset();
    mockAuthState.createAccount.isPending = false;
    mockAuthState.createAccount.error = null;
    mockAuthState.createAccount.reset.mockReset();
    mockAuthState.logout.mutateAsync.mockReset();
    mockAuthState.logout.isPending = false;
    mockAuthState.logout.error = null;
    mockAuthState.logout.reset.mockReset();
  });

  it("renders the app root", () => {
    render(<App />);
    expect(screen.getByTestId("app-root")).toBeInTheDocument();
  });

  it("routes signed-out users to the auth screen", () => {
    mockAuthState.isAuthenticated = false;
    mockAuthState.isLoading = false;
    render(<App />);
    const title = screen.getByRole("heading", { name: /sign in/i });
    expect(title).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create an account/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("auth-main--centered");
    expect(screen.getByRole("main")).toHaveClass("auth-main--editorial");
    expect(title.closest(".auth-card")).toHaveClass("auth-card--capture");
    expect(screen.getByText(/^pocketpulse$/i)).toHaveClass("auth-brand");
  });

  it("routes authenticated users with no accounts to account setup onboarding", () => {
    mockAuthState.isLoading = false;
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 1,
      email: "user@example.com",
      displayName: "Test User",
    };
    mockAuthState.accountsLoading = false;
    mockAuthState.accounts = [];
    mockAuthState.accountsError = null;
    render(<App />);
    const title = screen.getByRole("heading", {
      name: /set up your first account/i,
    });
    expect(title).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /account name/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("auth-main--centered");
    expect(screen.getByRole("main")).toHaveClass("auth-main--editorial");
    expect(title.closest(".auth-card")).toHaveClass("auth-card--capture");
    expect(screen.getByText(/^pocketpulse$/i)).toHaveClass("auth-brand");
  });

  it("renders protected app shell with sidebar navigation when the user has accounts", () => {
    mockAuthState.isLoading = false;
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 1,
      email: "user@example.com",
      displayName: "Test User",
    };
    mockAuthState.accountsLoading = false;
    mockAuthState.accounts = [{ id: 10, label: "Cash" }];
    mockAuthState.accountsError = null;
    render(<App />);
    expect(
      screen.getByRole("navigation", { name: /main navigation/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^dashboard$/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: /^upload$/i })).toHaveAttribute(
      "href",
      "/upload",
    );
    expect(screen.getByRole("link", { name: /^ledger$/i })).toHaveAttribute(
      "href",
      "/transactions",
    );
    expect(
      screen.getByRole("link", { name: /recurring leak review/i }),
    ).toHaveAttribute("href", "/leaks");
    expect(
      screen.getByRole("button", { name: /^logout$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^dashboard$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/dashboard overview will live here/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /set up your first account/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes logout when the sidebar Logout control is used", () => {
    mockAuthState.logout.mutateAsync.mockResolvedValue(undefined);
    mockAuthState.isLoading = false;
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 1,
      email: "user@example.com",
      displayName: "Test User",
    };
    mockAuthState.accountsLoading = false;
    mockAuthState.accounts = [{ id: 10, label: "Cash" }];
    mockAuthState.accountsError = null;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^logout$/i }));
    expect(mockAuthState.logout.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("renders not-found inside the protected shell for unknown routes", () => {
    const { hook } = memoryLocation({ path: "/not-a-real-page", static: true });
    mockAuthState.isLoading = false;
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 1,
      email: "user@example.com",
      displayName: "Test User",
    };
    mockAuthState.accountsLoading = false;
    mockAuthState.accounts = [{ id: 10, label: "Cash" }];
    mockAuthState.accountsError = null;
    render(
      <Router hook={hook}>
        <App />
      </Router>,
    );
    expect(
      screen.getByRole("navigation", { name: /main navigation/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });
});
