import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/">PocketPulse</Route>
        <Route>404</Route>
      </Switch>
    </QueryClientProvider>
  );
}
