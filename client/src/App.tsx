import { useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import { AppLayout } from "./components/layout/AppLayout";
import { useAuth } from "./hooks/use-auth";
import { useInactivityLogout } from "./hooks/use-inactivity-logout";
import { useTheme } from "./hooks/use-theme";
import { AccountSetup } from "./pages/AccountSetup";
import { Auth } from "./pages/Auth";
import { AccuracyReport } from "./pages/AccuracyReport";
import { Dashboard } from "./pages/Dashboard";
import { Ledger } from "./pages/Ledger";
import { Leaks } from "./pages/Leaks";
import { NotFoundPage } from "./pages/not-found";
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
        <Route path="/accuracy">
          {canAccessDev ? <AccuracyReport /> : <NotFoundPage />}
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

function AppGate() {
  const auth = useAuth();
  const [inactivityLogout, setInactivityLogout] = useState(false);

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

  if (auth.accounts !== null && auth.accounts.length === 0) {
    return <AccountSetup />;
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
      <ThemeInit />
      <div className={cn("app-shell")} data-testid="app-root">
        <AppGate />
      </div>
    </QueryClientProvider>
  );
}
