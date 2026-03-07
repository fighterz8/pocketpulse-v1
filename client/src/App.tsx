import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import UploadPage from "@/pages/Upload";
import Ledger from "@/pages/Ledger";
import Leaks from "@/pages/Leaks";
import AuthPage from "@/pages/Auth";
import { useAuth } from "@/hooks/use-auth";

function ProtectedApp() {
  const { user, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/upload" component={UploadPage} />
        <Route path="/transactions" component={Ledger} />
        <Route path="/leaks" component={Leaks} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <ProtectedApp />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
