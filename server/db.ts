import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { classifyTransaction } from "./classifier";
import { normalizeAmountForClass, flowTypeFromAmount } from "./transactionUtils";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision the database?");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

export async function ensureSchemaExtensions(): Promise<void> {
  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other',
      ADD COLUMN IF NOT EXISTS label_source text NOT NULL DEFAULT 'rule',
      ADD COLUMN IF NOT EXISTS label_confidence numeric(5, 2),
      ADD COLUMN IF NOT EXISTS label_reason text
  `);
}

export async function reclassifyMislabeledTransactions(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, raw_description, amount::numeric as amount
     FROM transactions
     WHERE user_corrected = false
       AND transaction_class = 'refund'
       AND label_reason != 'Matched refund keyword: refund'`
  );

  if (rows.length === 0) return 0;

  let updated = 0;
  for (const row of rows) {
    const amount = parseFloat(row.amount);
    const result = classifyTransaction(row.raw_description, amount);

    if (result.transactionClass === "refund") continue;

    const normalizedAmount = normalizeAmountForClass(amount, result.transactionClass);
    const flowType = flowTypeFromAmount(normalizedAmount);

    await pool.query(
      `UPDATE transactions
       SET transaction_class = $1,
           flow_type = $2,
           category = $3,
           recurrence_type = $4,
           merchant = $5,
           amount = $6,
           label_source = $7,
           label_confidence = $8,
           label_reason = $9,
           ai_assisted = $10
       WHERE id = $11`,
      [
        result.transactionClass,
        flowType,
        result.category,
        result.recurrenceType,
        result.merchant,
        normalizedAmount.toFixed(2),
        result.labelSource,
        result.labelConfidence,
        result.labelReason + " (reclassified)",
        result.aiAssisted,
        row.id,
      ]
    );
    updated++;
  }

  console.log(`Reclassified ${updated} transactions from refund to correct class`);
  return updated;
}
