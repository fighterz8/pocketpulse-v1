interface ClassificationResult {
  merchant: string;
  transactionClass: "income" | "expense" | "transfer" | "refund";
  flowType: "inflow" | "outflow";
  recurrenceType: "recurring" | "one-time";
  aiAssisted: boolean;
}

const KNOWN_RECURRING: Record<string, string> = {
  "aws": "Amazon Web Services",
  "amazon web services": "Amazon Web Services",
  "gusto": "Gusto Payroll",
  "adobe": "Adobe",
  "google cloud": "Google Cloud",
  "microsoft": "Microsoft",
  "slack": "Slack",
  "zoom": "Zoom",
  "dropbox": "Dropbox",
  "github": "GitHub",
  "heroku": "Heroku",
  "netlify": "Netlify",
  "vercel": "Vercel",
  "shopify": "Shopify",
  "mailchimp": "Mailchimp",
  "hubspot": "HubSpot",
  "salesforce": "Salesforce",
  "quickbooks": "QuickBooks",
  "xero": "Xero",
  "stripe": "Stripe",
  "square": "Square",
  "paypal": "PayPal",
  "insurance": "Insurance",
  "rent": "Rent/Lease",
  "lease": "Rent/Lease",
  "electric": "Electric Utility",
  "water": "Water Utility",
  "internet": "Internet Service",
  "phone": "Phone Service",
  "att": "AT&T",
  "verizon": "Verizon",
  "comcast": "Comcast",
  "spectrum": "Spectrum",
};

const TRANSFER_KEYWORDS = ["transfer", "xfer", "ach transfer", "wire transfer", "zelle", "venmo transfer"];
const REFUND_KEYWORDS = ["refund", "credit", "return", "reversal", "chargeback"];
const INCOME_KEYWORDS = ["deposit", "payment received", "direct dep", "ach credit", "wire from", "invoice"];

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
  const absAmount = Math.abs(amount);
  
  let merchant = cleanMerchant(rawDescription);
  let transactionClass: ClassificationResult["transactionClass"] = amount >= 0 ? "income" : "expense";
  let flowType: ClassificationResult["flowType"] = amount >= 0 ? "inflow" : "outflow";
  let recurrenceType: ClassificationResult["recurrenceType"] = "one-time";
  let aiAssisted = false;

  for (const keyword of TRANSFER_KEYWORDS) {
    if (lower.includes(keyword)) {
      transactionClass = "transfer";
      break;
    }
  }

  for (const keyword of REFUND_KEYWORDS) {
    if (lower.includes(keyword)) {
      transactionClass = "refund";
      if (amount > 0) flowType = "inflow";
      break;
    }
  }

  if (transactionClass !== "transfer" && transactionClass !== "refund") {
    for (const keyword of INCOME_KEYWORDS) {
      if (lower.includes(keyword) && amount >= 0) {
        transactionClass = "income";
        flowType = "inflow";
        break;
      }
    }
  }

  for (const [keyword, name] of Object.entries(KNOWN_RECURRING)) {
    if (lower.includes(keyword)) {
      merchant = name;
      recurrenceType = "recurring";
      break;
    }
  }

  if (recurrenceType === "one-time" && transactionClass !== "transfer" && transactionClass !== "refund") {
    if (lower.includes("subscription") || lower.includes("monthly") || lower.includes("recurring") || lower.includes("membership")) {
      recurrenceType = "recurring";
    }
  }

  if (merchant === cleanMerchant(rawDescription) && recurrenceType === "one-time" && transactionClass === "expense") {
    aiAssisted = true;
  }

  return { merchant, transactionClass, flowType, recurrenceType, aiAssisted };
}
