import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AppGate } from "./App";
import type { AuthAccount, AuthUser } from "./hooks/use-auth";

const { authState } = vi.hoisted(() => ({
  authState: {
    isLoading: false,
    isAuthenticated: false as boolean,
    accounts: null as AuthAccount[] | null,
    user: null as AuthUser | null,
  },
}));

vi.mock("./hooks/use-auth", () => ({
  useAuth: () => ({
    isLoading: authState.isLoading,
    isAuthenticated: authState.isAuthenticated,
    user: authState.user,
    accounts: authState.accounts,
    accountsLoading: false,
    accountsError: null,
    meError: null,
    refetch: vi.fn(),
    refetchAccounts: vi.fn(),
    login: stubMutation(),
    register: stubMutation(),
    createAccount: stubMutation(),
    logout: stubMutation(),
  }),
}));

function stubMutation() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  };
}

// Stub heavy page components — we only care which one renders.
vi.mock("./pages/Auth", () => ({
  Auth: () => <div data-testid="stub-auth">AUTH</div>,
}));
vi.mock("./pages/AccountSetup", () => ({
  AccountSetup: ({
    onCreated,
    onSkip,
  }: {
    onCreated: (account: AuthAccount) => void;
    onSkip: () => void;
  }) => (
    <div data-testid="stub-account-setup">
      ACCOUNT_SETUP
      <button data-testid="stub-create" onClick={() => onCreated(account)}>
        create
      </button>
      <button data-testid="stub-skip-1" onClick={onSkip}>
        skip
      </button>
    </div>
  ),
}));
vi.mock("./pages/OnboardingUpload", () => ({
  OnboardingUpload: ({
    account,
    onDone,
    onSkip,
  }: {
    account: AuthAccount;
    onDone: () => void;
    onSkip: () => void;
  }) => (
    <div data-testid="stub-onboarding-upload">
      ONBOARDING_UPLOAD:{account.label}
      <button data-testid="stub-done" onClick={onDone}>
        done
      </button>
      <button data-testid="stub-skip-2" onClick={onSkip}>
        skip
      </button>
    </div>
  ),
  ONBOARDING_UPLOAD_SUCCESS_FLAG: "pp_onboarding_upload_count",
}));
vi.mock("./components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stub-app-layout">{children}</div>
  ),
}));
vi.mock("./pages/Dashboard", () => ({
  Dashboard: () => <div data-testid="stub-dashboard">DASHBOARD</div>,
}));
vi.mock("./pages/Ledger", () => ({
  Ledger: () => <div data-testid="stub-ledger">LEDGER</div>,
}));
vi.mock("./pages/Leaks", () => ({
  Leaks: () => <div data-testid="stub-leaks">LEAKS</div>,
}));
vi.mock("./pages/Upload", () => ({
  Upload: () => <div data-testid="stub-upload">UPLOAD</div>,
}));
vi.mock("./pages/ResetPassword", () => ({
  ResetPassword: () => <div data-testid="stub-reset">RESET</div>,
  PASSWORD_RESET_SUCCESS_FLAG: "pp_password_reset_success",
}));
vi.mock("./pages/ComingSoon", () => ({
  ComingSoon: () => <div data-testid="stub-coming-soon">COMING_SOON</div>,
}));
vi.mock("./pages/not-found", () => ({
  NotFoundPage: () => <div data-testid="stub-not-found">NOT_FOUND</div>,
}));
vi.mock("./pages/dev/ClassificationSampler", () => ({
  ClassificationSampler: () => <div>cs</div>,
}));
vi.mock("./pages/dev/TeamSummary", () => ({
  TeamSummary: () => <div>ts</div>,
}));
vi.mock("./pages/dev/TestSuiteIndex", () => ({
  TestSuiteIndex: () => <div>tsi</div>,
}));
vi.mock("./hooks/use-inactivity-logout", () => ({
  useInactivityLogout: () => {},
}));

const account: AuthAccount = {
  id: 1,
  userId: 1,
  label: "Chase",
  lastFour: null,
  accountType: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderGate(initialPath: string = "/") {
  const memory = memoryLocation({ path: initialPath, record: true });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Mark beta unlocked so the gate doesn't trip the beta wall.
  localStorage.setItem("pp_beta_access", "1");
  const utils = render(
    <QueryClientProvider client={qc}>
      <Router hook={memory.hook}>
        <AppGate />
      </Router>
    </QueryClientProvider>,
  );
  return { ...utils, history: memory.history };
}

describe("AppGate routing state machine", () => {
  beforeEach(() => {
    sessionStorage.clear();
    authState.isLoading = false;
    authState.isAuthenticated = true;
    authState.user = {
      id: 1,
      email: "x@y.z",
      displayName: "X",
      companyName: null,
      isDev: false,
    };
    authState.accounts = null;
  });
  afterEach(() => {
    localStorage.removeItem("pp_beta_access");
  });

  it("renders Step 1 (AccountSetup) when authenticated and accounts is empty", () => {
    authState.accounts = [];
    renderGate();
    expect(screen.getByTestId("stub-account-setup")).toBeInTheDocument();
  });

  it("renders Step 2 (OnboardingUpload) when accounts has 1 entry and step2_pending is set", () => {
    sessionStorage.setItem("pp_onboarding_step2_pending", "1");
    authState.accounts = [account];
    renderGate();
    expect(screen.getByTestId("stub-onboarding-upload")).toHaveTextContent(
      "ONBOARDING_UPLOAD:Chase",
    );
  });

  it("renders the authenticated app when accounts has entries and no step2_pending", () => {
    authState.accounts = [account];
    renderGate();
    expect(screen.getByTestId("stub-dashboard")).toBeInTheDocument();
  });

  it("renders the authenticated app when accounts is empty but skipped flag is set", () => {
    sessionStorage.setItem("pp_onboarding_skipped", "1");
    authState.accounts = [];
    renderGate();
    // No dashboard data, so we'll see the layout — what matters is that
    // Step 1 is NOT shown (skipped takes effect).
    expect(screen.queryByTestId("stub-account-setup")).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-app-layout")).toBeInTheDocument();
  });

  it("Step 1 onCreated transitions to Step 2 and sets the pending flag", async () => {
    authState.accounts = [];
    const { rerender } = renderGate();
    fireEvent.click(screen.getByTestId("stub-create"));
    expect(sessionStorage.getItem("pp_onboarding_step2_pending")).toBe("1");
    // Simulate the createAccount cache update bumping accounts.length to 1
    authState.accounts = [account];
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <Router>
          <AppGate />
        </Router>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("stub-onboarding-upload"),
      ).toBeInTheDocument();
    });
  });

  it("Step 1 skip persists in-session AND navigates to /", async () => {
    authState.accounts = [];
    const { history } = renderGate("/transactions");
    fireEvent.click(screen.getByTestId("stub-skip-1"));
    expect(sessionStorage.getItem("pp_onboarding_skipped")).toBe("1");
    await waitFor(() => {
      expect(history.at(-1)).toBe("/");
    });
  });

  it("Step 2 done clears the pending flag AND navigates to /", async () => {
    sessionStorage.setItem("pp_onboarding_step2_pending", "1");
    authState.accounts = [account];
    const { history } = renderGate("/transactions");
    fireEvent.click(screen.getByTestId("stub-done"));
    expect(sessionStorage.getItem("pp_onboarding_step2_pending")).toBeNull();
    await waitFor(() => {
      expect(history.at(-1)).toBe("/");
    });
  });

  it("Step 2 skip clears the pending flag AND navigates to /", async () => {
    sessionStorage.setItem("pp_onboarding_step2_pending", "1");
    authState.accounts = [account];
    const { history } = renderGate("/transactions");
    fireEvent.click(screen.getByTestId("stub-skip-2"));
    expect(sessionStorage.getItem("pp_onboarding_step2_pending")).toBeNull();
    await waitFor(() => {
      expect(history.at(-1)).toBe("/");
    });
  });

  it("logout clears both per-session onboarding flags", async () => {
    sessionStorage.setItem("pp_onboarding_skipped", "1");
    sessionStorage.setItem("pp_onboarding_step2_pending", "1");
    authState.isAuthenticated = false;
    authState.accounts = null;
    renderGate();
    await waitFor(() => {
      expect(sessionStorage.getItem("pp_onboarding_skipped")).toBeNull();
      expect(sessionStorage.getItem("pp_onboarding_step2_pending")).toBeNull();
    });
  });
});
