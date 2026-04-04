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

Given a list of bank transactions, classify each one using ONLY the following categories:
${V1_CATEGORIES.map((c) => `- ${c}`).join("\n")}

Category definitions:
- income: Money received — salary, revenue, freelance pay, business deposits
- transfers: Moving money between own accounts — Zelle, Venmo, PayPal, wire transfers
- housing: Rent, mortgage payments, HOA fees, home maintenance
- utilities: Electric, water, gas bill, internet, phone bills
- groceries: Grocery stores, supermarkets, wholesale clubs (Costco)
- dining: Restaurants, fast food, bars, sit-down meals
- coffee: Coffee shops — Starbucks, Dunkin, Dutch Bros, cafes
- delivery: Food delivery apps — DoorDash, UberEats, Grubhub, Postmates
- convenience: Convenience stores — 7-Eleven, Circle K, Wawa, Sheetz
- gas: Gas stations — Shell, Exxon, Chevron, BP, fuel purchases
- parking: Parking garages, lots, meters, ParkWhiz, SpotHero
- travel: Airlines, hotels, rental cars, Airbnb, booking platforms
- auto: Uber/Lyft/rideshare, car maintenance, tolls, transit passes, DMV
- fitness: Gyms, fitness studios, Peloton, yoga, personal training
- medical: Doctors, dentists, pharmacies, hospitals, therapy, copays, prescriptions
- insurance: Health, auto, home, life, renters insurance premiums
- shopping: Retail stores, Amazon, online shopping, clothing, electronics, hardware
- entertainment: Movies, concerts, events, tickets, video games, streaming (Netflix/Hulu)
- software: SaaS tools, cloud storage, dev tools, productivity apps, Spotify, Adobe
- fees: Bank fees, overdraft, ATM fees, late fees, loan payments, service charges
- other: Cannot be determined from available information

For each transaction return:
- category: one of the 21 values above (use lowercase, no underscores except none needed)
- transactionClass: "income", "expense", "transfer", or "refund"
- recurrenceType: "recurring" or "one-time"
- labelConfidence: 0.0–1.0 (your confidence in this classification)
- labelReason: brief explanation (max 12 words)

Rules:
- Inflows that are NOT salary/business revenue should be "transfers" or "refund"
- Use "refund" for returns, credits, chargebacks (flowType=inflow + merchant suggests expense)
- If genuinely ambiguous, use "other" with confidence 0.4
- Never invent a category not in the list above`;

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
