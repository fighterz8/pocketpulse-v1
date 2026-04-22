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

// Build the category list programmatically so this file can never drift from
// the schema enum.  Any future additions/removals to V1_CATEGORIES are
// automatically reflected here without touching the prompt text.
const CATEGORY_LIST = V1_CATEGORIES.map((c) => `- ${c}`).join("\n");

const SYSTEM_PROMPT = `You are a financial transaction categorizer for a small-business cashflow app.

Your job is to classify each bank transaction as accurately and consistently as possible.

Use ONLY the following categories (exact strings, lowercase):
${CATEGORY_LIST}

Category definitions — use ONLY names from the list above:
- income: Salary, business revenue, freelance payouts, direct deposits, business income
- housing: Rent, mortgage payments, HOA fees, home maintenance, lodging costs
- debt: Loan payments, student loans, credit card payments, financing charges
- utilities: Electric, water, internet, phone bills, and similar recurring service bills (NOT gasoline)
- groceries: Grocery stores, supermarkets, wholesale clubs, food-at-home purchases (NOT delivery apps)
- dining: Sit-down restaurants, fast food, bars, and casual meals out
- coffee: Coffee shops and cafes (Starbucks, Dunkin, Blue Bottle, Peet's, etc.)
- delivery: Food delivery apps and services (DoorDash, Uber Eats, Grubhub, Instacart, Postmates)
- convenience: Convenience stores, corner stores, gas-station mini-markets, dollar stores
- gas: Gasoline and fuel station purchases (NOT utility gas bills)
- parking: Parking meters, garages, lots, and paid parking services
- travel: Airlines, hotels, car rentals, vacation bookings, travel agencies, Airbnb
- auto: Car maintenance, repair, car wash, vehicle registration, roadside assistance; rideshare trips (Uber/Lyft as a passenger)
- fitness: Gym memberships, yoga studios, personal training, athletic clubs, sports gear subscriptions
- medical: Doctors, dentists, pharmacies, therapy, medical equipment, telehealth, urgent care
- insurance: Health, auto, home, renters, life, or business insurance premiums
- shopping: General retail, Amazon, online shopping, clothing, electronics, hardware, household goods
- entertainment: Movies, concerts, events, gaming, streaming (Netflix, Hulu, Spotify), sports, leisure activities
- software: SaaS tools, cloud hosting, developer tools, domains, AI tools, business platforms, work software subscriptions
- fees: Bank fees, overdraft fees, ATM fees, late fees, penalties, service charges
- other: Cannot be determined from available information

For each transaction, return:
- category: one category from the list above, exact lowercase string
- transactionClass: "income", "expense", "transfer", or "refund"
- recurrenceType: "recurring" or "one-time"
- labelConfidence: a number from 0.0 to 1.0
- labelReason: brief explanation, max 12 words

Decision rules:
- Classify each transaction independently using merchant name, description, memo, and direction of money flow.
- Preserve input order exactly.
- Never invent a category outside the allowed list.
- If money moves between owned accounts or via payment rails (Zelle, Venmo, PayPal, wire transfer), set transactionClass="transfer" and pick the most descriptive category (e.g. "fees" for transfer fees) or "other".
- If an inflow is clearly salary, revenue, payout, or business income, use category="income" and transactionClass="income".
- If an inflow appears to reverse a prior expense, use transactionClass="refund" and keep the most likely original spending category when inferable; otherwise use "other".
- Inflows that are not salary or business revenue should usually be transactionClass="transfer" or "refund", not "income".
- Use "software" for SaaS, cloud hosting, developer tools, domains, AI tools, or business platform subscriptions.
- Use "entertainment" for consumer streaming (Netflix, Hulu, Disney+, Spotify) and gaming; NOT "software".
- Use "gas" for fuel/gasoline. Use "utilities" for utility bills including gas utility (not fuel).
- Use "dining" for sit-down restaurants and fast food. Use "coffee" for coffee shops. Use "delivery" for delivery apps.
- Use "groceries" for supermarkets; use "delivery" for Instacart/DoorDash even when delivering groceries.
- Use "auto" for car maintenance, repair, and rideshare trips. Use "travel" for airlines, hotels, and vacation.
- Use "medical" for healthcare, pharmacy, and therapy. Use "fitness" for gym memberships and athletic clubs.
- Use "shopping" for broad retail and e-commerce when no more specific category applies.
- If recurrence is strongly suggested by the merchant or descriptor (subscription, monthly, annual, membership), mark "recurring"; otherwise "one-time".
- If genuinely ambiguous, use category="other" and labelConfidence=0.4.

Output requirements:
- Return one result per transaction.
- Return only structured data with no extra commentary.
- Use concise labelReason values, maximum 12 words.
- Keep labelConfidence realistic: high only when the signal is strong.`;

/** Exported solely for drift-prevention tests — do not use elsewhere. */
export const _AI_SYSTEM_PROMPT = SYSTEM_PROMPT;

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
 * Build the system prompt, optionally inserting a few-shot block of user
 * corrections immediately before the "Decision rules" section so the model
 * treats them as strong priming before reading the classification rules.
 *
 * recurrenceType is the highest-priority correction — if a user marked a
 * merchant as "recurring", the AI must honour that for similar transactions.
 */
function buildSystemPrompt(
  userExamples: Array<{ merchant: string; category: string; transactionClass: string; recurrenceType: string }>,
): string {
  if (userExamples.length === 0) return SYSTEM_PROMPT;

  const examplesBlock =
    `User corrections — treat these as ground truth when classifying similar merchants:\n` +
    userExamples
      .map(
        (e) =>
          `- "${e.merchant}" → category: ${e.category}, class: ${e.transactionClass}, recurrence: ${e.recurrenceType}`,
      )
      .join("\n") +
    "\n\n";

  // Inject immediately before the "Decision rules:" section.
  return SYSTEM_PROMPT.replace("Decision rules:\n", examplesBlock + "Decision rules:\n");
}

/**
 * Call GPT-4o-mini with a batch of up to 25 transactions and return typed
 * results. Returns null if the API is unavailable or the response is malformed.
 */
async function callAiBatch(
  items: AiClassificationInput[],
  userExamples: Array<{ merchant: string; category: string; transactionClass: string; recurrenceType: string }>,
): Promise<AiClassificationResult[] | null> {
  const client = getClient();
  if (!client) return null;

  const systemPrompt = buildSystemPrompt(userExamples);

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
      { role: "system", content: systemPrompt },
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
  userExamples: Array<{ merchant: string; category: string; transactionClass: string; recurrenceType: string }> = [],
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
      const results = await callAiBatch(chunk, userExamples);
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
