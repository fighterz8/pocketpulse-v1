import type {
  FlowType,
  RecurrenceType,
  TransactionCategory,
  TransactionClass,
} from "@shared/schema";
import { flowTypeFromAmount, getDirectionHint } from "./transactionUtils";

interface ClassificationResult {
  merchant: string;
  transactionClass: TransactionClass;
  flowType: FlowType;
  recurrenceType: RecurrenceType;
  category: TransactionCategory;
  aiAssisted: boolean;
}

interface MerchantRule {
  merchant: string;
  category: TransactionCategory;
  recurrenceType?: RecurrenceType;
}

const MERCHANT_RULES: Array<{ keyword: string; rule: MerchantRule }> = [
  { keyword: "aws", rule: { merchant: "Amazon Web Services", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "amazon web services", rule: { merchant: "Amazon Web Services", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "gusto", rule: { merchant: "Gusto Payroll", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "adobe", rule: { merchant: "Adobe", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "google cloud", rule: { merchant: "Google Cloud", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "microsoft", rule: { merchant: "Microsoft", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "slack", rule: { merchant: "Slack", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "zoom", rule: { merchant: "Zoom", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "dropbox", rule: { merchant: "Dropbox", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "github", rule: { merchant: "GitHub", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "heroku", rule: { merchant: "Heroku", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "netlify", rule: { merchant: "Netlify", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "vercel", rule: { merchant: "Vercel", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "openai", rule: { merchant: "OpenAI", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "shopify", rule: { merchant: "Shopify", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "mailchimp", rule: { merchant: "Mailchimp", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "hubspot", rule: { merchant: "HubSpot", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "salesforce", rule: { merchant: "Salesforce", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "quickbooks", rule: { merchant: "QuickBooks", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "xero", rule: { merchant: "Xero", category: "business_software", recurrenceType: "recurring" } },
  { keyword: "insurance", rule: { merchant: "Insurance", category: "insurance", recurrenceType: "recurring" } },
  { keyword: "geico", rule: { merchant: "GEICO", category: "insurance", recurrenceType: "recurring" } },
  { keyword: "tesla insurance", rule: { merchant: "Tesla Insurance", category: "insurance", recurrenceType: "recurring" } },
  { keyword: "rent", rule: { merchant: "Rent/Lease", category: "housing", recurrenceType: "recurring" } },
  { keyword: "lease", rule: { merchant: "Rent/Lease", category: "housing", recurrenceType: "recurring" } },
  { keyword: "mortgage", rule: { merchant: "Mortgage", category: "housing", recurrenceType: "recurring" } },
  { keyword: "electric", rule: { merchant: "Electric Utility", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "water", rule: { merchant: "Water Utility", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "internet", rule: { merchant: "Internet Service", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "phone", rule: { merchant: "Phone Service", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "at&t", rule: { merchant: "AT&T", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "verizon", rule: { merchant: "Verizon", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "comcast", rule: { merchant: "Comcast", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "spectrum", rule: { merchant: "Spectrum", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "sdg&e", rule: { merchant: "San Diego Gas & Electric", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "gas & electric", rule: { merchant: "Gas & Electric", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "godaddy", rule: { merchant: "GoDaddy", category: "subscriptions", recurrenceType: "recurring" } },
  { keyword: "solar", rule: { merchant: "Solar Servicing", category: "utilities", recurrenceType: "recurring" } },
  { keyword: "starbucks", rule: { merchant: "Starbucks", category: "dining" } },
  { keyword: "doordash", rule: { merchant: "DoorDash", category: "dining" } },
  { keyword: "grubhub", rule: { merchant: "Grubhub", category: "dining" } },
  { keyword: "ubereats", rule: { merchant: "Uber Eats", category: "dining" } },
  { keyword: "mcdonald", rule: { merchant: "McDonald's", category: "dining" } },
  { keyword: "7-eleven", rule: { merchant: "7-Eleven", category: "dining" } },
  { keyword: "vons", rule: { merchant: "Vons", category: "groceries" } },
  { keyword: "costco", rule: { merchant: "Costco", category: "groceries" } },
  { keyword: "99 ranch", rule: { merchant: "99 Ranch Market", category: "groceries" } },
  { keyword: "food 4 less", rule: { merchant: "Food 4 Less", category: "groceries" } },
  { keyword: "amazon", rule: { merchant: "Amazon", category: "shopping" } },
  { keyword: "target", rule: { merchant: "Target", category: "shopping" } },
  { keyword: "walmart", rule: { merchant: "Walmart", category: "shopping" } },
  { keyword: "home depot", rule: { merchant: "The Home Depot", category: "shopping" } },
  { keyword: "pandora", rule: { merchant: "Pandora Jewelry", category: "shopping" } },
  { keyword: "chevron", rule: { merchant: "Chevron", category: "transportation" } },
  { keyword: "shell", rule: { merchant: "Shell", category: "transportation" } },
  { keyword: "lakeview", rule: { merchant: "Lakeview Loan Servicing", category: "debt", recurrenceType: "recurring" } },
  { keyword: "payment to chase", rule: { merchant: "Payment To Chase", category: "debt" } },
  { keyword: "credit card", rule: { merchant: "Credit Card Payment", category: "debt" } },
];

const TRANSFER_KEYWORDS = ["transfer", "xfer", "ach transfer", "wire transfer", "zelle", "venmo transfer"];
const REFUND_KEYWORDS = ["refund", "return", "reversal", "chargeback", "adjustment - credit", "credit adjustment"];
const INCOME_KEYWORDS = ["deposit", "payment received", "direct dep", "ach credit", "wire from", "invoice"];
const RECURRING_INCOME_KEYWORDS = [
  "salary",
  "payroll",
  "direct deposit",
  "regular income",
  "benefit",
  "benefits",
  "pension",
  "social security",
  "veteran affairs",
  "dept. of veterans",
  "department of veteran",
  "thrift savings",
];

const CATEGORY_KEYWORDS: Array<{ keyword: string; category: TransactionCategory }> = [
  { keyword: "salary", category: "income" },
  { keyword: "payroll", category: "income" },
  { keyword: "deposit", category: "income" },
  { keyword: "invoice", category: "income" },
  { keyword: "utility", category: "utilities" },
  { keyword: "gas & electric", category: "utilities" },
  { keyword: "internet", category: "utilities" },
  { keyword: "phone", category: "utilities" },
  { keyword: "insurance", category: "insurance" },
  { keyword: "at&t", category: "utilities" },
  { keyword: "mortgage", category: "housing" },
  { keyword: "rent", category: "housing" },
  { keyword: "lease", category: "housing" },
  { keyword: "grocery", category: "groceries" },
  { keyword: "vons", category: "groceries" },
  { keyword: "costco", category: "groceries" },
  { keyword: "starbucks", category: "dining" },
  { keyword: "doordash", category: "dining" },
  { keyword: "ubereats", category: "dining" },
  { keyword: "grubhub", category: "dining" },
  { keyword: "mcdonald", category: "dining" },
  { keyword: "amazon", category: "shopping" },
  { keyword: "home depot", category: "shopping" },
  { keyword: "target", category: "shopping" },
  { keyword: "walmart", category: "shopping" },
  { keyword: "godaddy", category: "subscriptions" },
  { keyword: "netflix", category: "subscriptions" },
  { keyword: "spotify", category: "subscriptions" },
  { keyword: "hulu", category: "subscriptions" },
  { keyword: "subscription", category: "subscriptions" },
  { keyword: "membership", category: "subscriptions" },
  { keyword: "openai", category: "subscriptions" },
  { keyword: "shopify", category: "subscriptions" },
  { keyword: "adobe", category: "subscriptions" },
  { keyword: "slack", category: "business_software" },
  { keyword: "github", category: "business_software" },
  { keyword: "quickbooks", category: "business_software" },
  { keyword: "xero", category: "business_software" },
  { keyword: "cvs", category: "health" },
  { keyword: "pharmacy", category: "health" },
  { keyword: "doctor", category: "health" },
  { keyword: "atm fee", category: "fees" },
  { keyword: "intl transaction fee", category: "fees" },
  { keyword: "fee", category: "fees" },
];

function cleanMerchant(raw: string): string {
  let cleaned = raw.toUpperCase();
  cleaned = cleaned.replace(/^(SQ \*|TST\*|STRIPE - |PAYPAL \*|PP\*|CHECKCARD |POS |ACH |DEBIT |PURCHASE |SP )/, "");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  
  const parts = cleaned.split(/[#*\/]/);
  cleaned = parts[0].trim();
  
  if (cleaned.length > 40) cleaned = cleaned.substring(0, 40);
  
  return cleaned.split(" ").map(w =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(" ");
}

export function classifyTransaction(rawDescription: string, amount: number): ClassificationResult {
  const lower = rawDescription.toLowerCase();
  
  let merchant = cleanMerchant(rawDescription);
  let transactionClass: ClassificationResult["transactionClass"] = amount >= 0 ? "income" : "expense";
  let flowType: ClassificationResult["flowType"] = flowTypeFromAmount(amount);
  let recurrenceType: ClassificationResult["recurrenceType"] = "one-time";
  let category: ClassificationResult["category"] =
    amount >= 0 ? "income" : "other";
  let aiAssisted = false;

  for (const keyword of TRANSFER_KEYWORDS) {
    if (lower.includes(keyword)) {
      transactionClass = "transfer";
      category = "transfers";
      break;
    }
  }

  if (transactionClass !== "transfer") {
    for (const keyword of REFUND_KEYWORDS) {
      if (lower.includes(keyword)) {
        transactionClass = "refund";
        break;
      }
    }
  }

  if (transactionClass !== "transfer" && /(^|\s)credit($|\s)/.test(lower) && amount > 0) {
      transactionClass = "refund";
  }

  if (transactionClass !== "transfer" && transactionClass !== "refund") {
    for (const keyword of INCOME_KEYWORDS) {
      if (lower.includes(keyword) && amount >= 0) {
        transactionClass = "income";
        category = "income";
        break;
      }
    }
  }

  const directionHint = getDirectionHint(rawDescription);
  if (transactionClass === "transfer" && directionHint) {
    flowType = directionHint;
  }

  for (const { keyword, rule } of MERCHANT_RULES) {
    if (lower.includes(keyword)) {
      merchant = rule.merchant;
      category = rule.category;
      if (rule.recurrenceType) {
        recurrenceType = rule.recurrenceType;
      }
      break;
    }
  }

  if (category === "other") {
    for (const { keyword, category: matchedCategory } of CATEGORY_KEYWORDS) {
      if (lower.includes(keyword)) {
        category = matchedCategory;
        break;
      }
    }
  }

  if (recurrenceType === "one-time" && transactionClass !== "transfer" && transactionClass !== "refund") {
    if (lower.includes("subscription") || lower.includes("monthly") || lower.includes("recurring") || lower.includes("membership")) {
      recurrenceType = "recurring";
    }
  }

  if (recurrenceType === "one-time" && transactionClass === "income") {
    for (const keyword of RECURRING_INCOME_KEYWORDS) {
      if (lower.includes(keyword)) {
        recurrenceType = "recurring";
        break;
      }
    }
  }

  if (transactionClass === "transfer") {
    category = "transfers";
  } else if (transactionClass === "income") {
    category = "income";
  }

  if (
    merchant === cleanMerchant(rawDescription) &&
    recurrenceType === "one-time" &&
    transactionClass !== "transfer" &&
    !directionHint
  ) {
    aiAssisted = true;
  }

  return { merchant, transactionClass, flowType, recurrenceType, category, aiAssisted };
}
