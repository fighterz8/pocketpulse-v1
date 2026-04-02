import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import { AppLayout } from "./components/layout/AppLayout";
import { useAuth } from "./hooks/use-auth";
import { AccountSetup } from "./pages/AccountSetup";
import { Auth } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { Ledger } from "./pages/Ledger";
import { Leaks } from "./pages/Leaks";
import { NotFoundPage } from "./pages/not-found";
import { Upload } from "./pages/Upload";
import { createQueryClient } from "./lib/queryClient";
import { cn } from "./lib/utils";

function AppAuthenticated() {
  const { logout } = useAuth();

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
        <Route>
          <NotFoundPage />
        </Route>
      </Switch>
    </AppLayout>
  );
}

function AppGate() {
  const auth = useAuth();

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
    return <Auth />;
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

export function App() {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <div className={cn("app-shell")} data-testid="app-root">
        <AppGate />
      </div>
    </QueryClientProvider>
  );
}
