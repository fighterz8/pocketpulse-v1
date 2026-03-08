import type {
  FlowType,
  LabelSource,
  Transaction,
  TransactionCategory,
  TransactionClass,
  UpdateTransaction,
} from "@shared/schema";

export interface AmountDerivationInput {
  rawAmount: number;
  creditAmount?: number;
  debitAmount?: number;
  indicator?: string;
  typeHint?: string;
  rawDescription?: string;
}

export interface AmountDerivationResult {
  amount: number;
  flowType: FlowType;
  source: "split-columns" | "indicator" | "signed-amount" | "heuristic" | "fallback";
  ambiguous: boolean;
}

const INFLOW_HINT_PATTERNS = [
  /\btransfer from\b/,
  /\bach credit\b/,
  /\bdirect deposit\b/,
  /\bdeposit\b/,
  /\bsalary\b/,
  /\bpayroll\b/,
  /\bpayment received\b/,
  /\bwire from\b/,
  /\bincoming\b/,
  /\brefund\b/,
  /\breversal\b/,
  /\breturn\b/,
  /\badjustment - credit\b/,
];

const STRONG_OUTFLOW_HINT_PATTERNS = [
  /\btransfer to\b/,
  /\bpayment to\b/,
  /\bach debit\b/,
  /\bpos\b/,
  /\bpurchase\b/,
  /\bwithdrawal\b/,
  /\bwithdraw\b/,
  /\batm fee\b/,
  /\batm\b/,
  /\bbill pay\b/,
  /\bautopay\b/,
  /\bdebit\b/,
];

const MERCHANT_OUTFLOW_HINT_PATTERNS = [
  /\bloan\b/,
  /\bmortgage\b/,
  /\butility\b/,
  /\bgas & electric\b/,
  /\bdoordash\b/,
  /\bamazon\b/,
  /\bstarbucks\b/,
  /\bvons\b/,
  /\bmcdonald'?s\b/,
  /\bpandora\b/,
  /\bcostco\b/,
  /\bchevron\b/,
  /\bopenai\b/,
  /\bapple\b/,
  /\badobe\b/,
  /\bmicrosoft\b/,
  /\bverizon\b/,
  /\batt\b/,
  /\bat&t\b/,
  /\bcomcast\b/,
  /\bspectrum\b/,
];

const CREDIT_INDICATORS = [
  "credit",
  "cr",
  "deposit",
  "inflow",
  "incoming",
  "received",
];

const DEBIT_INDICATORS = [
  "debit",
  "dr",
  "withdrawal",
  "withdraw",
  "charge",
  "payment",
  "outflow",
  "outgoing",
  "spent",
];

function normalizeHint(value?: string): string {
  return (value || "").trim().toLowerCase();
}

function includesAny(value: string, options: string[]): boolean {
  return options.some((option) => value.includes(option));
}

export function flowTypeFromAmount(amount: number): FlowType {
  return amount < 0 ? "outflow" : "inflow";
}

export function getDirectionHint(
  rawDescription?: string,
  ...extraHints: Array<string | undefined>
): FlowType | undefined {
  const combined = [rawDescription, ...extraHints]
    .filter(Boolean)
    .map((value) => normalizeHint(value))
    .join(" ");

  if (!combined) {
    return undefined;
  }

  if (STRONG_OUTFLOW_HINT_PATTERNS.some((pattern) => pattern.test(combined))) {
    return "outflow";
  }

  if (INFLOW_HINT_PATTERNS.some((pattern) => pattern.test(combined))) {
    return "inflow";
  }

  if (MERCHANT_OUTFLOW_HINT_PATTERNS.some((pattern) => pattern.test(combined))) {
    return "outflow";
  }

  return undefined;
}

export function deriveSignedAmount({
  rawAmount,
  creditAmount,
  debitAmount,
  indicator,
  typeHint,
  rawDescription,
}: AmountDerivationInput): AmountDerivationResult {
  const absoluteAmount = Math.abs(rawAmount);

  if ((creditAmount ?? 0) > 0 || (debitAmount ?? 0) > 0) {
    if ((creditAmount ?? 0) > 0) {
      return {
        amount: Math.abs(creditAmount!),
        flowType: "inflow",
        source: "split-columns",
        ambiguous: false,
      };
    }

    return {
      amount: -Math.abs(debitAmount!),
      flowType: "outflow",
      source: "split-columns",
      ambiguous: false,
    };
  }

  const normalizedIndicator = normalizeHint(indicator);
  if (normalizedIndicator) {
    if (includesAny(normalizedIndicator, CREDIT_INDICATORS)) {
      return {
        amount: absoluteAmount,
        flowType: "inflow",
        source: "indicator",
        ambiguous: false,
      };
    }

    if (includesAny(normalizedIndicator, DEBIT_INDICATORS)) {
      return {
        amount: -absoluteAmount,
        flowType: "outflow",
        source: "indicator",
        ambiguous: false,
      };
    }
  }

  if (rawAmount !== 0) {
    const signedFlowType = flowTypeFromAmount(rawAmount);
    if (rawAmount < 0) {
      return {
        amount: rawAmount,
        flowType: signedFlowType,
        source: "signed-amount",
        ambiguous: false,
      };
    }
  }

  const hintedDirection = getDirectionHint(rawDescription, typeHint);
  if (hintedDirection) {
    return {
      amount: hintedDirection === "inflow" ? absoluteAmount : -absoluteAmount,
      flowType: hintedDirection,
      source: "heuristic",
      ambiguous: true,
    };
  }

  return {
    amount: rawAmount,
    flowType: flowTypeFromAmount(rawAmount),
    source: "fallback",
    ambiguous: rawAmount >= 0,
  };
}

export function normalizeAmountForClass(
  amount: number,
  transactionClass: TransactionClass,
  explicitFlowType?: FlowType,
): number {
  const absoluteAmount = Math.abs(amount);

  if (explicitFlowType) {
    return explicitFlowType === "inflow" ? absoluteAmount : -absoluteAmount;
  }

  switch (transactionClass) {
    case "income":
    case "refund":
      return absoluteAmount;
    case "expense":
      return -absoluteAmount;
    case "transfer":
      return amount;
  }
}

export function buildTransactionUpdate(
  transaction: Transaction,
  data: UpdateTransaction,
): Pick<
  Transaction,
  "amount" | "flowType" | "transactionClass" | "recurrenceType" | "category" | "merchant" | "userCorrected" | "labelSource" | "labelConfidence" | "labelReason"
> {
  const nextClass = data.transactionClass ?? (transaction.transactionClass as TransactionClass);
  const shouldUpdateDirection = Boolean(data.transactionClass || data.flowType);
  const nextAmount = shouldUpdateDirection
    ? normalizeAmountForClass(
        parseFloat(transaction.amount),
        nextClass,
        data.flowType,
      )
    : parseFloat(transaction.amount);

  return {
    amount: nextAmount.toFixed(2),
    flowType: shouldUpdateDirection
      ? flowTypeFromAmount(nextAmount)
      : (transaction.flowType as FlowType),
    transactionClass: nextClass,
    recurrenceType: data.recurrenceType ?? transaction.recurrenceType,
    category: data.category ?? (transaction.category as TransactionCategory),
    merchant: data.merchant ?? transaction.merchant,
    labelSource: "manual" as LabelSource,
    labelConfidence: "1.00",
    labelReason: "Confirmed manually in the ledger",
    userCorrected: true,
  };
}
