/**
 * AI-powered transaction classifier using GPT-4o-mini.
 *
 * Used as a fallback when the rules-based classifier produces low confidence
 * or falls through to "other". Batches requests, deduplicates by merchant
 * name, and gracefully falls back on error so uploads never fail.
 */
import OpenAI from "openai";
import type { V1Category } from "../shared/schema.js";
import { V1_CATEGORIES } from "../shared/schema.js";

export type AiClassificationInput = {
  /** Index carried through to correlate output rows back to input rows. */
  index: number;
  merchant: string;
  rawDescription: string;
  amount: number;
  flowType: "inflow" | "outflow";
};

export type AiClassificationResult = {
  index: number;
  category: V1Category;
  transactionClass: "income" | "expense" | "transfer" | "refund";
  recurrenceType: "recurring" | "one-time";
  labelConfidence: number;
  labelReason: string;
};

const SYSTEM_PROMPT = `You are a financial transaction categorizer for a small-business cashflow app.

Your job is to classify each bank transaction as accurately and consistently as possible.

Use ONLY the following categories:
${V1_CATEGORIES.map((c) => `- ${c}`).join("\n")}

Category definitions:
- income: Money received from salary, business revenue, freelance work, payouts, deposits
- transfers: Money moved between accounts or payment rails, including Zelle, Venmo, PayPal, wires, cash movement
- utilities: Electric, water, gas, internet, phone, and similar household/service bills
- subscriptions: Consumer subscriptions and memberships such as streaming, personal memberships, and recurring consumer services
- insurance: Health, auto, home, renters, or life insurance premiums
- housing: Rent, mortgage, HOA, lodging-related housing costs, home maintenance
- groceries: Grocery stores, supermarkets, wholesale clubs, and similar food-at-home merchants
- transportation: Gas, rideshare, parking, tolls, car maintenance, airlines, hotels, and travel transit
- dining: Restaurants, fast food, coffee shops, bars, and food delivery
- shopping: General retail, Amazon, online shopping, clothing, electronics, hardware, household goods
- health: Doctors, dentists, pharmacies, therapy, medical equipment, gyms, and wellness services
- debt: Loan payments, student loans, financing payments, credit card payments
- business_software: SaaS, cloud hosting, dev tools, AI tools, domains, business platforms, and work software
- entertainment: Movies, concerts, events, tickets, gaming, sports, and leisure activities
- fees: Bank fees, overdraft fees, ATM fees, late fees, penalties, service charges
- other: Cannot be determined from available information

For each transaction, return:
- category: one allowed category above, lowercase with underscores
- transactionClass: "income", "expense", "transfer", or "refund"
- recurrenceType: "recurring" or "one-time"
- labelConfidence: a number from 0.0 to 1.0
- labelReason: brief explanation, max 12 words

Decision rules:
- Classify each transaction independently using merchant name, description, memo, and direction of money flow.
- Preserve input order exactly.
- Never invent a category outside the allowed list.
- If a transaction is clearly money movement between owned accounts or payment rails, use category="transfers" and transactionClass="transfer".
- If an inflow is clearly salary, revenue, payout, or business income, use category="income" and transactionClass="income".
- If an inflow appears to reverse a prior expense, use transactionClass="refund".
- For refunds, keep the most likely original spending category when inferable; otherwise use "other".
- Inflows that are not salary or business revenue should usually be "transfers" or "refund", not "income".
- Prefer "business_software" over "subscriptions" for SaaS, hosting, domains, developer tools, cloud services, AI tools, or business platforms.
- Use "subscriptions" for personal recurring services like streaming or consumer memberships.
- Use "debt" for loans, financing, and credit card payments.
- Use "transportation" for gas, parking, tolls, rideshare, flights, hotels, and vehicle maintenance.
- Use "dining" for restaurants, coffee, bars, and food delivery.
- Use "shopping" for broad retail and e-commerce purchases unless another category is clearly more specific.
- Use "health" for medical, pharmacy, therapy, gym, and wellness-related transactions.
- If recurrence is strongly suggested by the merchant or descriptor, mark "recurring"; otherwise mark "one-time".
- If genuinely ambiguous, use category="other" and labelConfidence=0.4.

Output requirements:
- Return one result per transaction.
- Return only structured data with no extra commentary.
- Use concise labelReason values, maximum 12 words.
- Keep labelConfidence realistic: high only when the signal is strong.`;

type RawAiRow = {
  index: number;
  category: string;
  transactionClass: string;
  recurrenceType: string;
  labelConfidence: number;
  labelReason: string;
};

type AiBatchResponse = {
  results: RawAiRow[];
};

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

function isValidCategory(value: string): value is V1Category {
  return (V1_CATEGORIES as readonly string[]).includes(value);
}

function isValidTransactionClass(
  value: string,
): value is AiClassificationResult["transactionClass"] {
  return ["income", "expense", "transfer", "refund"].includes(value);
}

function isValidRecurrenceType(
  value: string,
): value is AiClassificationResult["recurrenceType"] {
  return ["recurring", "one-time"].includes(value);
}

/**
 * Call GPT-4o-mini with a batch of up to 25 transactions and return typed
 * results. Returns null if the API is unavailable or the response is malformed.
 */
async function callAiBatch(
  items: AiClassificationInput[],
): Promise<AiClassificationResult[] | null> {
  const client = getClient();
  if (!client) return null;

  const userContent = JSON.stringify(
    items.map((item) => ({
      index: item.index,
      merchant: item.merchant,
      rawDescription: item.rawDescription,
      amount: item.amount,
      flowType: item.flowType,
    })),
  );

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 1500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Classify these transactions and respond with JSON matching this schema: { "results": [ { "index": number, "category": string, "transactionClass": string, "recurrenceType": string, "labelConfidence": number, "labelReason": string } ] }\n\n${userContent}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return null;

  let parsed: AiBatchResponse;
  try {
    parsed = JSON.parse(raw) as AiBatchResponse;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed.results)) return null;

  const out: AiClassificationResult[] = [];
  for (const row of parsed.results) {
    if (typeof row.index !== "number") continue;
    const category = isValidCategory(row.category) ? row.category : "other";
    const transactionClass = isValidTransactionClass(row.transactionClass)
      ? row.transactionClass
      : "expense";
    const recurrenceType = isValidRecurrenceType(row.recurrenceType)
      ? row.recurrenceType
      : "one-time";
    const labelConfidence =
      typeof row.labelConfidence === "number"
        ? Math.min(1, Math.max(0, row.labelConfidence))
        : 0.6;
    const labelReason =
      typeof row.labelReason === "string" ? row.labelReason : `AI classified as ${category}`;

    out.push({ index: row.index, category, transactionClass, recurrenceType, labelConfidence, labelReason });
  }

  return out;
}

/**
 * Classify a batch of transactions using GPT-4o-mini.
 *
 * - Deduplicates by normalized merchant name to reduce API calls.
 * - Splits into chunks of 25 per API call.
 * - Gracefully falls back: any item that fails to get an AI result keeps its
 *   original index so callers can detect the miss (result array may be
 *   shorter than input if some items fail).
 *
 * Returns a map from original index → AiClassificationResult.
 * Missing entries mean AI was unavailable or could not classify that item.
 */
export async function aiClassifyBatch(
  items: AiClassificationInput[],
): Promise<Map<number, AiClassificationResult>> {
  const resultMap = new Map<number, AiClassificationResult>();
  if (items.length === 0) return resultMap;

  const client = getClient();
  if (!client) return resultMap;

  // Deduplicate by merchant (lowercase) — share result across duplicates
  const merchantToItems = new Map<string, AiClassificationInput[]>();
  for (const item of items) {
    const key = item.merchant.toLowerCase().trim();
    if (!merchantToItems.has(key)) merchantToItems.set(key, []);
    merchantToItems.get(key)!.push(item);
  }

  // Build one canonical item per unique merchant, reusing the first occurrence's index
  const canonical: AiClassificationInput[] = [];
  const merchantToCanonicalIndex = new Map<string, number>();
  let idx = 0;
  for (const [key, group] of merchantToItems) {
    const representative = { ...group[0]!, index: idx };
    canonical.push(representative);
    merchantToCanonicalIndex.set(key, idx);
    idx++;
  }

  // Process in chunks of 25
  const CHUNK_SIZE = 25;
  const canonicalResults = new Map<number, AiClassificationResult>();

  for (let i = 0; i < canonical.length; i += CHUNK_SIZE) {
    const chunk = canonical.slice(i, i + CHUNK_SIZE);
    try {
      const results = await callAiBatch(chunk);
      if (results) {
        for (const r of results) {
          canonicalResults.set(r.index, r);
        }
      }
    } catch {
      // Silently skip this chunk — callers fall back to rules result
    }
  }

  // Fan canonical results back out to all original items by merchant
  for (const [key, group] of merchantToItems) {
    const canonicalIdx = merchantToCanonicalIndex.get(key);
    if (canonicalIdx === undefined) continue;
    const result = canonicalResults.get(canonicalIdx);
    if (!result) continue;
    for (const item of group) {
      resultMap.set(item.index, { ...result, index: item.index });
    }
  }

  return resultMap;
}
