import { db } from './server/db.js';
import { transactions } from './shared/schema.js';
import { eq } from 'drizzle-orm';
import { classifyPipeline } from './server/classifyPipeline.js';
import { bulkUpdateTransactions, listAllTransactionsForExport, type BulkTransactionUpdate } from './server/storage.js';

const TEST_USER_ID = 524;
const ACCOUNT_ID = 207;
const UPLOAD_ID = 188;

// Insert a synthetic AI-labeled row (category=other, same as structural fallback)
const [inserted] = await db.insert(transactions).values({
  userId: TEST_USER_ID,
  uploadId: UPLOAD_ID,
  accountId: ACCOUNT_ID,
  date: new Date('2025-01-15'),
  amount: '-42.00',
  merchant: 'Mystery Vendor Zq99',
  rawDescription: 'MYSTERY VENDOR ZQ99 TEST',
  flowType: 'outflow',
  transactionClass: 'expense',
  recurrenceType: 'one-time',
  recurrenceSource: 'none',
  category: 'other',
  labelSource: 'ai',
  labelConfidence: '0.42',
  labelReason: 'AI fallback, low confidence',
  aiAssisted: true,
  userCorrected: false,
  excludedFromAnalysis: false,
}).returning({ id: transactions.id });

const rowId = inserted!.id;
console.log('Inserted synthetic AI row, id:', rowId);

// Inline reclassify with 1ms AI timeout so AI definitely can't re-run
const allTxns = await listAllTransactionsForExport({ userId: TEST_USER_ID });
const eligible = allTxns.filter(
  t => !t.userCorrected && t.labelSource !== 'propagated' && t.labelSource !== 'recurring-transfer'
);

const outputs = await classifyPipeline(
  eligible.map(t => ({ rawDescription: t.rawDescription, amount: parseFloat(String(t.amount)) })),
  { userId: TEST_USER_ID, aiTimeoutMs: 1, aiConfidenceThreshold: 0.5, cacheWriteMinConfidence: 0.7, includeUserExamplesInAi: false },
);

const updates: BulkTransactionUpdate[] = [];
for (let i = 0; i < eligible.length; i++) {
  const txn = eligible[i]!;
  const out = outputs[i]!;
  const newAmount = out.amount.toFixed(2);
  const dataChanged =
    newAmount !== String(txn.amount) ||
    out.flowType !== txn.flowType ||
    out.transactionClass !== txn.transactionClass ||
    out.category !== txn.category ||
    out.recurrenceType !== txn.recurrenceType ||
    out.recurrenceSource !== txn.recurrenceSource;
  const isAiDemotion =
    txn.labelSource === 'ai' &&
    (out.labelSource === 'cache' || out.labelSource === 'rule') &&
    !dataChanged;
  const labelSourceChanged = out.labelSource !== txn.labelSource && !isAiDemotion;
  const finalChanged = dataChanged || (out.aiAssisted && !txn.aiAssisted) || labelSourceChanged;
  if (!finalChanged) continue;
  updates.push({ id: txn.id, amount: newAmount, flowType: out.flowType, transactionClass: out.transactionClass,
    category: out.category, recurrenceType: out.recurrenceType, recurrenceSource: out.recurrenceSource,
    labelSource: out.labelSource, labelConfidence: out.labelConfidence.toFixed(2), labelReason: out.labelReason, aiAssisted: out.aiAssisted });
}

if (updates.length > 0) await bulkUpdateTransactions(TEST_USER_ID, updates);
console.log('Reclassify pass: updated', updates.length, '/ unchanged', eligible.length - updates.length);

const [after] = await db.select({ labelSource: transactions.labelSource })
  .from(transactions).where(eq(transactions.id, rowId));
console.log('After reclassify — labelSource:', after!.labelSource);

if (after!.labelSource === 'ai') {
  console.log('✓ FIX VERIFIED: "ai" label survived reclassify.');
} else {
  console.log('✗ BROKEN: label overwritten with:', after!.labelSource);
}

await db.delete(transactions).where(eq(transactions.id, rowId));
console.log('Cleaned up.');
