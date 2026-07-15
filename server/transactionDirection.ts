export type TransactionFlow = "inflow" | "outflow";
export type TransactionClass = "income" | "expense" | "transfer" | "refund";

type DirectionalClassification = {
  transactionClass: TransactionClass;
  category: string;
};

const VALID_CLASSES = new Set<TransactionClass>([
  "income",
  "expense",
  "transfer",
  "refund",
]);

export function isClassCompatibleWithFlow(
  flowType: TransactionFlow,
  transactionClass: string,
): transactionClass is TransactionClass {
  if (!VALID_CLASSES.has(transactionClass as TransactionClass)) return false;
  if (transactionClass === "transfer") return true;
  if (flowType === "outflow") return transactionClass === "expense";
  return transactionClass === "income" || transactionClass === "refund";
}

/**
 * Keep semantic labels subordinate to the observed direction of money flow.
 * Merchant caches and AI may refine category/class, but they may never turn a
 * confirmed inflow into an expense or a confirmed outflow into income/refund.
 */
export function reconcileTransactionDirection(input: {
  flowType: TransactionFlow;
  proposedClass: string;
  proposedCategory: string;
  fallbackClass?: string;
  fallbackCategory?: string;
}): DirectionalClassification {
  const proposedIsCompatible = isClassCompatibleWithFlow(
    input.flowType,
    input.proposedClass,
  );
  const fallbackIsCompatible =
    input.fallbackClass !== undefined &&
    isClassCompatibleWithFlow(input.flowType, input.fallbackClass);

  let transactionClass: TransactionClass;
  if (proposedIsCompatible) {
    transactionClass = input.proposedClass as TransactionClass;
  } else if (input.proposedClass === "expense" && input.flowType === "inflow") {
    // A true inflow from an expense merchant is normally a refund/reversal.
    // Preserve the spending category instead of flattening it into income.
    transactionClass = "refund";
  } else if (
    (input.proposedClass === "income" || input.proposedClass === "refund") &&
    input.flowType === "outflow"
  ) {
    transactionClass = "expense";
  } else if (fallbackIsCompatible) {
    transactionClass = input.fallbackClass as TransactionClass;
  } else {
    transactionClass = input.flowType === "inflow" ? "income" : "expense";
  }

  let category = proposedIsCompatible || VALID_CLASSES.has(input.proposedClass as TransactionClass)
    ? input.proposedCategory
    : input.fallbackCategory ?? "other";

  if (transactionClass === "income") category = "income";
  if (transactionClass !== "income" && category === "income") category = "other";

  return { transactionClass, category };
}

/**
 * Apply an AI suggestion without allowing it to erase a structurally detected
 * refund. The model may enrich the original spending category, but an explicit
 * refund/reversal signal remains stronger evidence for class than the model.
 */
export function reconcileAiTransactionClassification(input: {
  flowType: TransactionFlow;
  currentClass: string;
  currentCategory: string;
  proposedClass: string;
  proposedCategory: string;
}): DirectionalClassification {
  if (input.flowType === "inflow" && input.currentClass === "refund") {
    const category =
      input.proposedCategory === "income"
        ? input.currentCategory
        : input.proposedCategory;
    return {
      transactionClass: "refund",
      category: category === "income" ? "other" : category,
    };
  }

  return reconcileTransactionDirection({
    flowType: input.flowType,
    proposedClass: input.proposedClass,
    proposedCategory: input.proposedCategory,
    fallbackClass: input.currentClass,
    fallbackCategory: input.currentCategory,
  });
}
