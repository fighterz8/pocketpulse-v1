import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Every client-side projection derived from imported transaction data.
 * Mutations that add or change financial data use this list so Dashboard,
 * Ledger, and Leak Hunter cannot drift into different cache generations.
 */
export const financialDataQueryRoots = [
  ["uploads"],
  ["transactions"],
  ["/api/dashboard/months"],
  ["/api/dashboard-summary"],
  ["/api/recurring-candidates"],
  ["/api/leak-hunter/report"],
  ["recurring-expense-panel"],
] as const satisfies readonly QueryKey[];

const uploadScopedQueryRoots = [
  ["enhancement-availability"],
  ["enhancement-job"],
  ["active-enhancement-job"],
] as const satisfies readonly QueryKey[];

/**
 * Refresh inactive cached views as well as the current page. Awaiting this
 * function keeps a successful import mutation pending until any previously
 * visited Dashboard, Ledger, or Leak Hunter view has current data.
 */
export async function refreshFinancialDataQueries(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all(
    financialDataQueryRoots.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, refetchType: "all" }),
    ),
  );
}

/**
 * A wipe removes the source records entirely, so discard cached projections
 * rather than briefly rendering their stale pre-delete values on navigation.
 */
export function clearImportedDataQueries(queryClient: QueryClient): void {
  for (const queryKey of [
    ...financialDataQueryRoots,
    ...uploadScopedQueryRoots,
  ]) {
    queryClient.removeQueries({ queryKey });
  }
}
