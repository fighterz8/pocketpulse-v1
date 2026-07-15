import type { V1Category } from "../shared/schema.js";

export type BankCategoryHint = {
  category: V1Category;
  transactionClass?: "income" | "expense" | "transfer" | "refund";
  confidence: number;
};

const CATEGORY_HINTS: ReadonlyMap<string, BankCategoryHint> = new Map([
  ["mortgages", { category: "housing", transactionClass: "expense", confidence: 0.96 }],
  ["utilities", { category: "utilities", transactionClass: "expense", confidence: 0.85 }],
  ["telephone services", { category: "utilities", transactionClass: "expense", confidence: 0.85 }],
  ["groceries", { category: "groceries", transactionClass: "expense", confidence: 0.82 }],
  ["restaurants dining", { category: "dining", transactionClass: "expense", confidence: 0.82 }],
  ["gasoline fuel", { category: "gas", transactionClass: "expense", confidence: 0.82 }],
  ["travel", { category: "travel", transactionClass: "expense", confidence: 0.82 }],
  ["automotive expenses", { category: "auto", transactionClass: "expense", confidence: 0.82 }],
  ["healthcare medical", { category: "medical", transactionClass: "expense", confidence: 0.82 }],
  ["insurance", { category: "insurance", transactionClass: "expense", confidence: 0.88 }],
  ["general merchandise", { category: "shopping", transactionClass: "expense", confidence: 0.78 }],
  ["clothing shoes", { category: "shopping", transactionClass: "expense", confidence: 0.78 }],
  ["gifts", { category: "shopping", transactionClass: "expense", confidence: 0.74 }],
  ["electronics", { category: "shopping", transactionClass: "expense", confidence: 0.76 }],
  ["home improvement", { category: "shopping", transactionClass: "expense", confidence: 0.75 }],
  ["education", { category: "shopping", transactionClass: "expense", confidence: 0.7 }],
  ["entertainment", { category: "entertainment", transactionClass: "expense", confidence: 0.82 }],
  ["online services", { category: "software", transactionClass: "expense", confidence: 0.82 }],
  ["service charges fees", { category: "fees", transactionClass: "expense", confidence: 0.9 }],
  ["other expenses", { category: "other", transactionClass: "expense", confidence: 0.55 }],

  ["paychecks salary", { category: "income", transactionClass: "income", confidence: 0.95 }],
  ["investment income", { category: "income", transactionClass: "income", confidence: 0.92 }],
  ["refunds adjustments", { category: "other", transactionClass: "refund", confidence: 0.9 }],
  ["rewards", { category: "other", transactionClass: "refund", confidence: 0.88 }],

  // These are balance movements, not consumption. Keeping their category as
  // `other` prevents double-counting them as spending while the transfer class
  // excludes them from expense and Leak Hunter totals.
  ["transfers", { category: "other", transactionClass: "transfer", confidence: 0.95 }],
  ["savings", { category: "other", transactionClass: "transfer", confidence: 0.95 }],
  ["securities trades", { category: "other", transactionClass: "transfer", confidence: 0.9 }],
  ["credit card payments", { category: "other", transactionClass: "transfer", confidence: 0.92 }],
  ["atm cash withdrawals", { category: "other", transactionClass: "transfer", confidence: 0.9 }],
]);

function normalizeBankCategory(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[&/]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Map a bank's category vocabulary into PocketPulse's smaller V1 taxonomy.
 * Unknown categories intentionally return null rather than being guessed.
 */
export function getBankCategoryHint(
  rawCategory: string | undefined,
): BankCategoryHint | null {
  if (!rawCategory?.trim()) return null;
  return CATEGORY_HINTS.get(normalizeBankCategory(rawCategory)) ?? null;
}
