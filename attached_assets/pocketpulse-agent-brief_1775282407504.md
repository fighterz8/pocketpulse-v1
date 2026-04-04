# PocketPulse — Systems Overhaul Brief

**For:** Replit Agent  
**Project:** PocketPulse — CSV-based personal finance analyzer  
**Stack:** TypeScript, React, Express, PostgreSQL (Drizzle ORM)  
**Test data:** 3,300-line real Navy Federal transaction history already in the system

---

## Context

PocketPulse extracts bank-level financial insights from raw CSV exports — no integrations, no APIs. Three interconnected systems need overhaul. They form a pipeline where each stage caps the accuracy of the next:

```
CSV Upload → Classifier → Recurring Detector → Leak Identifier → Dashboard
```

The classifier labels each transaction. The recurring detector groups labeled transactions by merchant and frequency. The leak identifier surfaces discretionary recurring charges for user review. The dashboard reads from all three. Right now, each stage has bugs that compound downstream.

**Three things are actively wrong for the user:**

1. The "Recurring Expenses" card shows $474.57 because the detector's results only reach the DB via a manual sync button the user has to find and click. Even after sync, quarterly/annual charges spike the number because the dashboard sums raw amounts instead of normalized monthly equivalents.

2. The "Subscription Leak" monthly cost on the dashboard shows total recurring outflow ÷ months — not the cost of confirmed leaks. A $3,400 mortgage inflates the "leak cost" even though the user only marked a $15 Netflix as a leak.

3. Three separate constants (`AUTO_ESSENTIAL_CATEGORIES`, `AUTO_HIDDEN_CATEGORIES`, `SIDEBAR_HIDDEN_CATEGORIES`) in three separate files must stay in sync manually. If one drifts, essential expenses like mortgage or insurance appear as "leaks" or vice versa.

---

## Phase 1 — Stop the Bleeding (Do First)

These are surgical fixes. Low risk, high impact. Do them in order.

### Task 1.1 — Shared Essential Categories Constant

**Problem:** Three identical sets defined separately in `server/routes.ts`, `client/src/pages/Leaks.tsx`, and `client/src/components/layout/AppLayout.tsx`. They must match but can drift.

**Fix:**

1. Open `shared/schema.ts`
2. Add this export:
```typescript
export const AUTO_ESSENTIAL_CATEGORIES = new Set([
  "housing",
  "utilities",
  "insurance",
  "medical",
  "debt",
] as const);
```
3. In `server/routes.ts`: delete the local `AUTO_ESSENTIAL_CATEGORIES` definition. Add `import { AUTO_ESSENTIAL_CATEGORIES } from "@shared/schema";`
4. In `client/src/pages/Leaks.tsx`: delete the local `AUTO_HIDDEN_CATEGORIES` definition. Add `import { AUTO_ESSENTIAL_CATEGORIES } from "@shared/schema";`. Replace all references from `AUTO_HIDDEN_CATEGORIES` to `AUTO_ESSENTIAL_CATEGORIES`.
5. In `client/src/components/layout/AppLayout.tsx`: delete the local `SIDEBAR_HIDDEN_CATEGORIES` definition. Add `import { AUTO_ESSENTIAL_CATEGORIES } from "@shared/schema";`. Replace all references from `SIDEBAR_HIDDEN_CATEGORIES` to `AUTO_ESSENTIAL_CATEGORIES`.

**Verify:** Search the entire codebase for any remaining local definitions of these category sets. There should be exactly one definition in `shared/schema.ts` and three imports.

---

### Task 1.2 — Auto-Sync on Upload

**Problem:** The recurring expense detector computes results in memory but only writes them to the DB when the user manually clicks "Sync to Dashboard" on the Leaks page. The dashboard is always stale until they do.

**Fix:**

1. Open `server/routes.ts`
2. Find the CSV upload route handler (the route that processes uploaded transaction CSVs and inserts them into the `transactions` table)
3. Find the sync logic inside `POST /api/recurring-candidates/sync` — it calls `detectRecurringCandidates()`, collects transaction IDs, resets all outflows to `one-time`, then marks detected IDs as `recurring`
4. Extract the sync logic into a reusable function:
```typescript
async function syncRecurringCandidates(userId: number): Promise<{ recurringCount: number; oneTimeCount: number }> {
  // Move the existing sync logic here — same detection + DB update steps
  const transactions = await listAllTransactionsForExport(userId);
  const candidates = detectRecurringCandidates(transactions);
  
  const recurringIds = new Set<number>();
  for (const candidate of candidates) {
    for (const id of candidate.transactionIds) {
      recurringIds.add(id);
    }
  }
  
  // Reset all outflows to one-time
  await db.update(transactions)
    .set({ recurrenceType: "one-time" })
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.flowType, "outflow")
    ));
  
  // Mark detected as recurring
  if (recurringIds.size > 0) {
    await db.update(transactions)
      .set({ recurrenceType: "recurring" })
      .where(inArray(transactions.id, Array.from(recurringIds)));
  }
  
  return { recurringCount: recurringIds.size, oneTimeCount: /* remaining count */ };
}
```
5. Call `syncRecurringCandidates(userId)` at the end of the upload route handler, AFTER all transactions have been inserted
6. Keep the `POST /api/recurring-candidates/sync` endpoint working but have it call the same extracted function (so the manual button still works as a re-sync)

**Verify:** Upload a CSV. Check that the Recurring Expenses dashboard card updates immediately without clicking any sync button. The value should now include mortgage/rent if present.

---

## Phase 2 — Fix Dashboard Accuracy (Do Second)

### Task 2.1 — Fix Leak Monthly Amount Calculation

**Problem:** In `server/dashboardQueries.ts`, `leakMonthlyAmount` is calculated as `recurringExpenses / months`. This is the average of ALL recurring outflow, not the cost of confirmed leaks. A user with $3,400/mo mortgage (essential) and $15/mo Netflix (marked as leak) sees ~$3,415/mo as their "leak cost."

**Fix:**

1. Open `server/dashboardQueries.ts`
2. Find where `leakMonthlyAmount` is calculated
3. Replace it with a calculation that:
   - Runs `detectRecurringCandidates()` to get all candidates with their `monthlyEquivalent`
   - Reads all `recurringReviews` for the user where `status = "leak"`
   - Joins candidates to reviews by `candidateKey`
   - Sums `monthlyEquivalent` only for candidates whose review status is `"leak"`

```typescript
// Get candidates and reviews
const allTransactions = await listAllTransactionsForExport(userId);
const candidates = detectRecurringCandidates(allTransactions);
const leakReviews = await db
  .select()
  .from(recurringReviews)
  .where(and(
    eq(recurringReviews.userId, userId),
    eq(recurringReviews.status, "leak")
  ));

const leakKeys = new Set(leakReviews.map(r => r.candidateKey));
const leakMonthlyAmount = candidates
  .filter(c => leakKeys.has(c.candidateKey))
  .reduce((sum, c) => sum + c.monthlyEquivalent, 0);
```

**Verify:** Mark one subscription as a "leak" on the Leaks page. The dashboard should show only that subscription's monthly equivalent as the leak cost, not the total of all recurring expenses.

---

### Task 2.2 — Normalize Recurring Expenses to Monthly Equivalents

**Problem:** The "Recurring Expenses" dashboard card sums raw transaction amounts for the selected month. A quarterly insurance payment of $1,200 that lands in March shows as $1,200 that month and $0 in April. The monthly equivalent ($400/mo) is already computed by the detector but never used.

**Fix:**

1. Open `server/dashboardQueries.ts`
2. Find the `recurringExpenses` calculation (the one that sums `amount WHERE recurrenceType = 'recurring'`)
3. Replace it with a detector-based calculation:

```typescript
const allTransactions = await listAllTransactionsForExport(userId);
const candidates = detectRecurringCandidates(allTransactions);
const activeRecurring = candidates.filter(c => c.isActive);
const recurringExpensesNormalized = activeRecurring.reduce(
  (sum, c) => sum + c.monthlyEquivalent,
  0
);
```

This gives a stable "monthly baseline" number regardless of which charges happened to land in the selected calendar month.

**Verify:** If a quarterly charge exists in the data, the Recurring Expenses card should show 1/3 of its amount every month, not the full amount in the month it hits and $0 in other months.

---

## Phase 3 — Classifier Accuracy (Do Third)

A 3,300-line real Navy Federal transaction history is already loaded as the test dataset. Use it to measure and improve classification accuracy.

### Task 3.1 — Word-Boundary Matching

**Problem:** Keyword matching in `server/classifier.ts` uses substring matching. `"energy"` in the utilities keyword list matches "ENERGY DRINK CO" → misclassified as utilities. `"bar"` would match "BARNES AND NOBLE."

**Fix:**

1. Open `server/classifier.ts`
2. Find the keyword matching logic in CATEGORY_RULES (Pass 6)
3. For each keyword, change substring matching to word-boundary regex matching:

```typescript
// Before (substring)
description.includes(keyword)

// After (word boundary)
new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i').test(description)
```

4. Add an `escapeRegex` utility:
```typescript
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

5. Audit the keyword lists for terms that rely on substring behavior intentionally. Some multi-word keywords like `"bar & grill"` are fine with word-boundary. Single short words like `"gas"`, `"bar"`, `"energy"` benefit the most.

**Verify:** Search the transaction history for any "ENERGY DRINK" or similar false-positive cases. They should no longer classify as utilities.

---

### Task 3.2 — Amount-Range Signals

**Problem:** The classifier ignores transaction amounts entirely. A $2.99 Spotify charge and a $299 software license get identical treatment. Amount is a strong disambiguation signal.

**Fix:**

1. In `server/classifier.ts`, modify `classifyTransaction()` to accept and use the amount parameter (it's already in the signature but unused for category logic)
2. Add amount-based rules as a post-Pass-6 refinement:

```typescript
// After Pass 6 category assignment:

// Small amounts at convenience stores are convenience, not shopping
if (category === "shopping" && Math.abs(amount) < 25 && 
    /7-eleven|circle k|wawa|sheetz|quicktrip/i.test(description)) {
  category = "convenience";
}

// Large "shopping" charges at known general merchants may be groceries
if (category === "shopping" && Math.abs(amount) > 50 && Math.abs(amount) < 400 &&
    /walmart|target|costco/i.test(description)) {
  // Flag for review — could be groceries
  labelConfidence = Math.max(0.55, labelConfidence - 0.15);
  aiAssisted = true;
}

// Micro-transactions (< $5) at dining merchants are likely coffee/snack
if (category === "dining" && Math.abs(amount) < 5) {
  category = "coffee";
  labelConfidence = 0.70;
}
```

3. These are heuristics. Keep them conservative — only fire when amount strongly disambiguates.

**Verify:** Check the transaction history for small Walmart charges, micro-transactions at restaurants, and convenience store purchases. Classification should improve.

---

### Task 3.3 — Direction Hint Hardening for Navy Federal

**Problem:** Navy Federal exports unsigned amounts (all positive) for many transaction types. The classifier relies on `getDirectionHint()` to flip positive-amount expenses from income to expense. If the description lacks strong directional keywords (`ach debit`, `pos`, `purchase`, etc.), the transaction silently stays as income.

**Fix:**

1. Open `server/classifier.ts`
2. Find `getDirectionHint()` (or equivalent direction-detection logic in Pass 3b)
3. Add Navy Federal-specific patterns to the strong outflow tier:

```typescript
// Additional outflow patterns common in Navy Federal exports
"checkcard",        // "CHECKCARD 0412 MERCHANT NAME"
"ach pmt",          // ACH payment
"recurring pmt",    // Recurring payment
"bill pmt",         // Bill payment
"online pmt",       // Online payment
"point of sale",    // Full POS text
```

4. Add a fallback heuristic: if amount is positive, no direction hint found, but the description matches ANY merchant in CATEGORY_RULES with a category that is always an expense (dining, coffee, gas, groceries, entertainment, software, fitness, shopping, convenience, delivery, parking) → treat as outflow.

```typescript
// Fallback: known expense categories imply outflow
if (flowType === "inflow" && !hasDirectionHint && 
    EXPENSE_ONLY_CATEGORIES.has(matchedCategory)) {
  flowType = "outflow";
  transactionClass = "expense";
}
```

**Verify:** Search the Navy Federal transaction history for transactions currently classified as income that are clearly expenses (restaurant charges, gas stations, subscriptions showing as positive amounts). They should flip to outflow/expense.

---

## Phase 4 — Smarter Detection (Do Fourth)

### Task 4.1 — Candidate Key Redesign

**Problem:** `candidateKey` format is `"merchantKey|avgAmount.toFixed(2)"`. When a subscription price changes (e.g., Netflix $9.99 → $15.49), the key changes. The user's old review ("essential" or "leak") is orphaned. The service reappears as a new unreviewed candidate.

**Fix:**

1. Open `server/recurrenceDetector.ts`
2. Find where `candidateKey` is constructed
3. Change the key format from `"${merchantKey}|${avgAmount.toFixed(2)}"` to just `"${merchantKey}"`
4. If a merchant has multiple distinct amount buckets (e.g., a user has two different subscription tiers), append a bucket index: `"${merchantKey}:${bucketIndex}"` — but only when there are 2+ buckets for the same merchant
5. When the average amount changes between detections, surface it as metadata on the candidate:

```typescript
interface RecurringCandidate {
  // existing fields...
  priceHistory?: { amount: number; date: string }[];
  priceChanged?: boolean;
}
```

6. On the Leaks page card, show a note when `priceChanged === true`: "Price changed from $X.XX to $Y.YY"

**Migration concern:** Existing rows in `recurringReviews` use the old `merchantKey|amount` format. Add a one-time migration that strips the `|amount` suffix from existing `candidateKey` values. Handle collisions (multiple reviews for the same merchant at different amounts) by keeping the most recent review.

**Verify:** If any subscription in the transaction history had a price change over time, confirm that the review status persists across the price change instead of creating a duplicate unreviewed card.

---

### Task 4.2 — Subscription Likelihood Signal

**Problem:** The Leaks page shows ALL recurring patterns as potential subscription leaks. A user who eats at the same restaurant every Friday sees it flagged as a "leak." Weekly gas fill-ups appear as wasteful subscriptions. These are intentional spending habits, not forgotten subscriptions.

**Fix:**

1. Open `server/recurrenceDetector.ts`
2. Add an `isSubscriptionLike` boolean to the `RecurringCandidate` interface
3. Compute it based on these signals:

```typescript
const isSubscriptionLike = (
  // Strong subscription signals
  ["entertainment", "software", "fitness"].includes(category) ||
  // Exact same amount every time (subscription pricing)
  amountStdDev < 1.0 ||
  // Monthly or annual frequency (most subscriptions)
  (frequency === "monthly" || frequency === "annual") && amountStdDev < 3.0
) && !(
  // Anti-subscription signals
  ["dining", "gas", "groceries", "coffee", "convenience"].includes(category) &&
  amountStdDev > 5.0  // Variable amounts = habit, not subscription
);
```

4. On the client in `Leaks.tsx`, split the display into two sections:
   - **"Subscriptions to Review"** — candidates where `isSubscriptionLike === true`
   - **"Recurring Habits"** — candidates where `isSubscriptionLike === false`, shown in a collapsed/secondary section with a note like "These are regular spending patterns, not subscriptions"

5. The sidebar dot should only pulse for unreviewed subscription-like candidates, not habits.

**Verify:** Check that dining, gas, and grocery recurring patterns appear in the "Habits" section, not the main subscription review list. Entertainment, software, and fitness subscriptions with fixed amounts should appear in the primary review section.

---

## Execution Notes

- **Do phases in order.** Phase 1 fixes are prerequisites for Phase 2 accuracy. Phase 3 classifier improvements feed better data into Phase 4 detection logic.
- **Test against the 3,300-line Navy Federal dataset after each phase.** The transaction history is the ground truth.
- **Don't refactor unrelated code.** Each task is scoped to specific files and specific logic. Avoid cascading changes.
- **Preserve all existing API contracts.** The React client expects specific response shapes from each endpoint. Don't change response schemas without updating the client.
- **The `recurrenceDetector.ts` engine is shared.** Both the Recurring Expenses system and the Leak Identifier consume `detectRecurringCandidates()`. Changes to the detector affect both downstream features. Test both after any detector change.

---

## File Map

| File | Role | Phases |
|---|---|---|
| `shared/schema.ts` | Shared types, DB schema, constants | 1.1 |
| `server/routes.ts` | API endpoints, upload handler, sync logic | 1.1, 1.2 |
| `server/classifier.ts` | Transaction classification (1,832 lines) | 3.1, 3.2, 3.3 |
| `server/recurrenceDetector.ts` | Recurring expense detection engine (456 lines) | 4.1, 4.2 |
| `server/dashboardQueries.ts` | Dashboard summary calculations | 2.1, 2.2 |
| `server/transactionUtils.ts` | Merchant normalization | — |
| `server/csvParser.ts` | CSV parsing, amount normalization | — |
| `client/src/pages/Leaks.tsx` | Subscription leak review UI | 1.1, 4.2 |
| `client/src/components/layout/AppLayout.tsx` | Sidebar nav, notification dot | 1.1, 4.2 |
