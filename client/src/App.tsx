import { useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, useLocation } from "wouter";
import { AppLayout } from "./components/layout/AppLayout";
import { TooltipProvider } from "./components/ui/tooltip";
import { useAuth, type AuthAccount } from "./hooks/use-auth";
import { useInactivityLogout } from "./hooks/use-inactivity-logout";
import { useTheme } from "./hooks/use-theme";
import { AccountSetup } from "./pages/AccountSetup";
import { Auth } from "./pages/Auth";
import { ComingSoon } from "./pages/ComingSoon";
import { Dashboard } from "./pages/Dashboard";
import { Ledger } from "./pages/Ledger";
import { Leaks } from "./pages/Leaks";
import { NotFoundPage } from "./pages/not-found";
import { OnboardingUpload } from "./pages/OnboardingUpload";
import { ResetPassword } from "./pages/ResetPassword";
import { Upload } from "./pages/Upload";
import { ClassificationSampler } from "./pages/dev/ClassificationSampler";
import { TeamSummary } from "./pages/dev/TeamSummary";
import { TestSuiteIndex } from "./pages/dev/TestSuiteIndex";
import { createQueryClient } from "./lib/queryClient";
import { cn } from "./lib/utils";
import { DEV_MODE_ENABLED } from "@shared/devConfig";

function AppAuthenticated() {
  const { logout, user } = useAuth();
  const canAccessDev = DEV_MODE_ENABLED && user?.isDev === true;

  return (
    <AppLayout
      onLogout={() => void logout.mutateAsync()}
      logoutPending={logout.isPending}
    >
      <Switch>
        <Route path="/">
          <Dashboard />
        </Route>
        <Route path="/upload">
          <Upload />
        </Route>
        <Route path="/transactions">
          <Ledger />
        </Route>
        <Route path="/leaks">
          <Leaks />
        </Route>
        <Route path="/dev/test-suite">
          {canAccessDev ? <TestSuiteIndex /> : <NotFoundPage />}
        </Route>
        <Route path="/dev/test-suite/classification/:sampleId?">
          {canAccessDev ? <ClassificationSampler /> : <NotFoundPage />}
        </Route>
        <Route path="/dev/test-suite/team">
          {canAccessDev ? <TeamSummary /> : <NotFoundPage />}
        </Route>
        <Route>
          <NotFoundPage />
        </Route>
      </Switch>
    </AppLayout>
  );
}

const BETA_FLAG = "pp_beta_access";
// Per-session onboarding state. Lives in sessionStorage so it dies with
// the tab — users with no accounts always see Step 1 again on next login.
const ONBOARDING_SKIP_FLAG = "pp_onboarding_skipped";
const ONBOARDING_STEP2_FLAG = "pp_onboarding_step2_pending";

export function AppGate() {
  const auth = useAuth();
  const [, setLocation] = useLocation();
  const [inactivityLogout, setInactivityLogout] = useState(false);
  const [betaUnlocked, setBetaUnlocked] = useState(
    () => localStorage.getItem(BETA_FLAG) === "1",
  );
  const [onboardingSkipped, setOnboardingSkipped] = useState(
    () => sessionStorage.getItem(ONBOARDING_SKIP_FLAG) === "1",
  );
  const [step2Pending, setStep2Pending] = useState(
    () => sessionStorage.getItem(ONBOARDING_STEP2_FLAG) === "1",
  );
  // The exact account just created in Step 1, so Step 2 doesn't have to
  // guess via `accounts[0]` — keeps the contract sturdy if a user with
  // multiple accounts ever ends up in Step 2 down the road.
  const [step2Account, setStep2Account] = useState<AuthAccount | null>(null);

  function handleUnlock() {
    localStorage.setItem(BETA_FLAG, "1");
    setBetaUnlocked(true);
  }

  function handleStep1Created(account: AuthAccount) {
    sessionStorage.setItem(ONBOARDING_STEP2_FLAG, "1");
    setStep2Account(account);
    setStep2Pending(true);
  }
  function exitOnboarding() {
    sessionStorage.removeItem(ONBOARDING_STEP2_FLAG);
    setStep2Pending(false);
    setStep2Account(null);
    // Send the user to the dashboard regardless of whatever URL the
    // onboarding screens were rendered at, so the success notice is
    // guaranteed to surface and there's no surprise deep-link landing.
    setLocation("/");
  }
  // Step 2 finished naturally (continue OR skip) — either way clear flags
  // and land on the dashboard. Aliased so handler names at the call site
  // read clearly (onDone vs onSkip) even though they share an exit path.
  const handleStep2Done = exitOnboarding;
  const handleStep2Skip = exitOnboarding;
  function handleSkipOnboarding() {
    sessionStorage.setItem(ONBOARDING_SKIP_FLAG, "1");
    setOnboardingSkipped(true);
    exitOnboarding();
  }

  // Reset all per-session onboarding state on logout so a fresh login
  // starts at Step 1.
  useEffect(() => {
    if (!auth.isAuthenticated) {
      if (sessionStorage.getItem(ONBOARDING_SKIP_FLAG) === "1") {
        sessionStorage.removeItem(ONBOARDING_SKIP_FLAG);
        setOnboardingSkipped(false);
      }
      if (sessionStorage.getItem(ONBOARDING_STEP2_FLAG) === "1") {
        sessionStorage.removeItem(ONBOARDING_STEP2_FLAG);
        setStep2Pending(false);
      }
      setStep2Account(null);
    }
  }, [auth.isAuthenticated]);

  // Clear the inactivity flag once the user re-authenticates.
  useEffect(() => {
    if (auth.isAuthenticated) setInactivityLogout(false);
  }, [auth.isAuthenticated]);

  // Run the 30-minute inactivity timer for all authenticated paths
  // (AppAuthenticated and AccountSetup). Disabled when not authenticated.
  useInactivityLogout({
    enabled: auth.isAuthenticated,
    onTimeout: () => {
      void auth.logout.mutateAsync().then(
        () => setInactivityLogout(true),
        () => { /* logout failed — leave session as-is, don't show notice */ },
      );
    },
  });

  if (auth.isLoading) {
    return (
      <main className="app-main">
        <p className="app-placeholder">Loading…</p>
      </main>
    );
  }

  if (auth.meError) {
    return (
      <main className="app-main">
        <p className="auth-error" role="alert">
          {auth.meError.message}
        </p>
        <button
          type="button"
          className="auth-submit"
          onClick={() => void auth.refetch()}
        >
          Retry
        </button>
      </main>
    );
  }

  if (!auth.isAuthenticated) {
    if (!betaUnlocked) {
      return <ComingSoon onUnlock={handleUnlock} />;
    }
    return <Auth inactivityLogout={inactivityLogout} />;
  }

  if (auth.accountsLoading) {
    return (
      <main className="app-main">
        <p className="app-placeholder">Loading…</p>
      </main>
    );
  }

  if (auth.accountsError) {
    return (
      <main className="app-main">
        <p className="auth-error" role="alert">
          {auth.accountsError.message}
        </p>
        <button
          type="button"
          className="auth-submit"
          onClick={() => void auth.refetchAccounts()}
        >
          Retry
        </button>
      </main>
    );
  }

  if (auth.accounts !== null) {
    if (auth.accounts.length === 0 && !onboardingSkipped) {
      return (
        <AccountSetup
          onCreated={handleStep1Created}
          onSkip={handleSkipOnboarding}
        />
      );
    }
    if (auth.accounts.length >= 1 && step2Pending) {
      // Prefer the explicit Step-1 account; fall back to the first
      // account in the cache for resumed sessions where the user
      // refreshed mid-onboarding (we lose in-memory state but the
      // sessionStorage flag still routes them back here).
      const account = step2Account ?? auth.accounts[0]!;
      return (
        <OnboardingUpload
          account={account}
          onDone={handleStep2Done}
          onSkip={handleStep2Skip}
        />
      );
    }
  }

  return <AppAuthenticated />;
}

function ThemeInit() {
  useTheme();
  return null;
}

export function App() {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <ThemeInit />
        <div className={cn("app-shell")} data-testid="app-root">
          {/*
           * /reset-password is reached from an emailed link by
           * definition-not-signed-in users (often on a fresh device), so
           * it must render OUTSIDE the auth/beta gates. Declared as a
           * top-level <Route> so that wouter's <Switch> short-circuits
           * before AppGate runs any of its auth/beta logic.
           */}
          <Switch>
            <Route path="/reset-password">
              <ResetPassword />
            </Route>
            <Route>
              <AppGate />
            </Route>
          </Switch>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
