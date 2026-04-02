/**
 * Rules-based transaction classifier.
 *
 * Assigns category, transaction class, recurrence hints, and a human-readable
 * label reason using keyword matching against the merchant name. Rules are
 * intentionally deterministic and explainable (V1 spec section 10.2).
 *
 * The keyword tables below drive classification. Each entry maps a set of
 * merchant substrings to a category. Order matters: the first matching rule
 * wins, so more specific patterns should appear before broader ones.
 */
import type { V1Category } from "../shared/schema.js";

export type ClassificationResult = {
  transactionClass: "income" | "expense" | "transfer" | "refund";
  category: V1Category;
  recurrenceType: "recurring" | "one-time";
  labelSource: "rule";
  labelConfidence: number;
  labelReason: string;
};

type CategoryRule = {
  category: V1Category;
  keywords: string[];
  confidence: number;
};

/**
 * Keyword rules ordered from specific to general. Each keyword is matched
 * as a case-insensitive substring of the merchant name.
 */
const CATEGORY_RULES: CategoryRule[] = [
  // Transfers (check before income — "transfer" can appear in inflows too)
  {
    category: "transfers",
    keywords: [
      "transfer",
      "xfer",
      "zelle",
      "venmo",
      "cash app",
      "wire",
    ],
    confidence: 0.85,
  },
  // Subscriptions & streaming
  {
    category: "subscriptions",
    keywords: [
      "netflix",
      "spotify",
      "hulu",
      "disney+",
      "disney plus",
      "apple music",
      "youtube premium",
      "hbo max",
      "paramount+",
      "peacock",
      "audible",
      "kindle unlimited",
      "adobe",
      "dropbox",
      "icloud",
      "google storage",
      "microsoft 365",
      "subscription",
    ],
    confidence: 0.9,
  },
  // Business software / SaaS
  {
    category: "business_software",
    keywords: [
      "github",
      "gitlab",
      "heroku",
      "aws",
      "google cloud",
      "digitalocean",
      "vercel",
      "netlify",
      "slack",
      "zoom",
      "notion",
      "figma",
      "jira",
      "atlassian",
      "quickbooks",
      "freshbooks",
      "mailchimp",
      "hubspot",
      "squarespace",
      "shopify",
      "godaddy",
      "namecheap",
      "cloudflare",
    ],
    confidence: 0.85,
  },
  // Insurance
  {
    category: "insurance",
    keywords: [
      "insurance",
      "geico",
      "state farm",
      "allstate",
      "progressive",
      "liberty mutual",
      "usaa",
      "nationwide",
      "farmers",
      "metlife",
      "aetna",
      "cigna",
      "blue cross",
      "anthem",
      "united health",
    ],
    confidence: 0.9,
  },
  // Housing
  {
    category: "housing",
    keywords: [
      "rent",
      "mortgage",
      "hoa",
      "property tax",
      "landlord",
      "apartment",
      "realty",
      "real estate",
    ],
    confidence: 0.85,
  },
  // Utilities
  {
    category: "utilities",
    keywords: [
      "electric",
      "water",
      "gas co",
      "sewer",
      "utility",
      "utilities",
      "power",
      "energy",
      "comcast",
      "xfinity",
      "spectrum",
      "at&t",
      "verizon",
      "t-mobile",
      "internet",
      "phone bill",
      "broadband",
    ],
    confidence: 0.85,
  },
  // Groceries
  {
    category: "groceries",
    keywords: [
      "whole foods",
      "trader joe",
      "kroger",
      "safeway",
      "publix",
      "aldi",
      "costco",
      "sam's club",
      "walmart supercenter",
      "target",
      "grocery",
      "market basket",
      "food lion",
      "wegmans",
      "sprouts",
      "fresh market",
      "h-e-b",
    ],
    confidence: 0.8,
  },
  // Dining
  {
    category: "dining",
    keywords: [
      "restaurant",
      "chipotle",
      "mcdonald",
      "starbucks",
      "dunkin",
      "subway",
      "domino",
      "pizza",
      "burger",
      "taco bell",
      "wendy",
      "chick-fil-a",
      "panera",
      "grubhub",
      "doordash",
      "uber eats",
      "postmates",
      "cafe",
      "coffee",
      "diner",
      "grill",
      "kitchen",
      "bakery",
      "sushi",
      "thai",
      "chinese",
      "indian",
      "pho",
      "ramen",
    ],
    confidence: 0.8,
  },
  // Transportation
  {
    category: "transportation",
    keywords: [
      "gas station",
      "shell",
      "exxon",
      "chevron",
      "bp ",
      "mobil",
      "citgo",
      "sunoco",
      "wawa",
      "uber",
      "lyft",
      "parking",
      "toll",
      "metro",
      "transit",
      "fuel",
      "car wash",
      "auto parts",
      "jiffy lube",
      "tire",
    ],
    confidence: 0.8,
  },
  // Health
  {
    category: "health",
    keywords: [
      "pharmacy",
      "cvs",
      "walgreens",
      "rite aid",
      "doctor",
      "medical",
      "hospital",
      "dental",
      "optometry",
      "vision",
      "urgent care",
      "clinic",
      "lab corp",
      "quest diagnostics",
      "gym",
      "fitness",
      "planet fitness",
    ],
    confidence: 0.8,
  },
  // Debt
  {
    category: "debt",
    keywords: [
      "loan payment",
      "student loan",
      "auto loan",
      "car payment",
      "credit card payment",
      "debt",
      "sallie mae",
      "navient",
      "great lakes",
      "fedloan",
    ],
    confidence: 0.85,
  },
  // Fees
  {
    category: "fees",
    keywords: [
      "fee",
      "overdraft",
      "nsf",
      "late charge",
      "service charge",
      "annual fee",
      "maintenance fee",
      "atm fee",
    ],
    confidence: 0.85,
  },
  // Entertainment
  {
    category: "entertainment",
    keywords: [
      "theatre",
      "theater",
      "amc",
      "regal",
      "cinemark",
      "concert",
      "ticket",
      "ticketmaster",
      "stubhub",
      "bowling",
      "arcade",
      "museum",
      "zoo",
      "amusement",
      "steam",
      "playstation",
      "xbox",
      "nintendo",
    ],
    confidence: 0.75,
  },
  // Shopping (broad — keep near end so specific merchants match first)
  {
    category: "shopping",
    keywords: [
      "amazon",
      "walmart",
      "best buy",
      "home depot",
      "lowe",
      "ikea",
      "etsy",
      "ebay",
      "apple store",
      "nike",
      "nordstrom",
      "macy",
      "tj maxx",
      "marshalls",
      "ross",
      "old navy",
      "gap",
      "zara",
      "h&m",
    ],
    confidence: 0.7,
  },
];

/** Merchants that strongly suggest a recurring charge. */
const RECURRING_KEYWORDS = [
  "netflix",
  "spotify",
  "hulu",
  "disney",
  "hbo",
  "paramount",
  "peacock",
  "audible",
  "apple music",
  "youtube premium",
  "adobe",
  "microsoft 365",
  "icloud",
  "google storage",
  "dropbox",
  "github",
  "slack",
  "zoom",
  "notion",
  "figma",
  "insurance",
  "geico",
  "state farm",
  "allstate",
  "progressive",
  "rent",
  "mortgage",
  "gym",
  "planet fitness",
  "subscription",
  "monthly",
];

const REFUND_KEYWORDS = ["refund", "return", "credit adj", "reversal", "chargeback"];

function matchesAny(merchant: string, keywords: string[]): boolean {
  const lower = merchant.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

export function classifyTransaction(
  merchant: string,
  amount: number,
  flowType: "inflow" | "outflow",
): ClassificationResult {
  const lower = merchant.toLowerCase();

  // Determine transaction class
  let transactionClass: ClassificationResult["transactionClass"];
  if (matchesAny(merchant, REFUND_KEYWORDS) && flowType === "inflow") {
    transactionClass = "refund";
  } else if (matchesAny(merchant, ["transfer", "xfer", "zelle", "venmo", "wire"])) {
    transactionClass = "transfer";
  } else if (flowType === "inflow") {
    transactionClass = "income";
  } else {
    transactionClass = "expense";
  }

  // Match category
  let category: V1Category = "other";
  let confidence = 0.3;
  let matchedKeyword = "";

  if (transactionClass === "income" && !matchesAny(merchant, ["transfer", "xfer", "zelle", "venmo", "wire"])) {
    category = "income";
    confidence = 0.8;
    matchedKeyword = "inflow";
  } else {
    for (const rule of CATEGORY_RULES) {
      for (const kw of rule.keywords) {
        if (lower.includes(kw)) {
          category = rule.category;
          confidence = rule.confidence;
          matchedKeyword = kw;
          break;
        }
      }
      if (matchedKeyword) break;
    }
  }

  // Recurrence hint
  const recurrenceType = matchesAny(merchant, RECURRING_KEYWORDS)
    ? "recurring" as const
    : "one-time" as const;

  const labelReason = matchedKeyword
    ? `Matched keyword "${matchedKeyword}" → ${category}`
    : `No keyword match — defaulted to ${category}`;

  return {
    transactionClass,
    category,
    recurrenceType,
    labelSource: "rule",
    labelConfidence: confidence,
    labelReason,
  };
}
