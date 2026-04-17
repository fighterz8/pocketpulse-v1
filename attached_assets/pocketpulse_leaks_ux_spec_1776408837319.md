# PocketPulse — Leak Detection UX Honesty Fixes

**Repo:** `fighterz8/pocketpulse-v1` (post rule-migration merge)
**Author:** Nick (project lead)
**Purpose:** Fix three ways the Leaks page currently misleads users, without touching the underlying detection engine.
**Scope:** Small. One backend file, one frontend file. ~80 lines of changed code + 5 new tests. Half a day of agent work.

---

## 1. Context

The leak detection engine (`server/cashflow.ts::detectLeaks`) is sound — multi-signal classification, mutual exclusion with the recurring detector, category-stratified thresholds, catch-all rule with confidence capping. That code is **not** what this spec changes.

The problem is that the UI presents engine output in three misleading ways, and one backend calculation produces numbers that don't mean what the label claims. Users trust numbers; the numbers have to be trustworthy.

This spec fixes:
1. `monthlyAmount` is computed from the transactions' own date range, not the query window. The `/mo` label on the UI reads as a forward-looking rate — it isn't one.
2. The summary line totals `recentSpend` and `monthlyAmount` across all leaks regardless of confidence. Low-confidence catch-all items inflate the total, giving users an exaggerated sense of their "flagged spend."
3. Every leak is rendered identically regardless of whether it's an ongoing pattern or brand new. "New this period" is actionable; "been happening for 6 months" is status quo. The engine has `firstDate` and doesn't use it.

No engine changes. No new categories. No threshold changes. These are three surgical UX corrections.

---

## 2. Fix 1 — `monthlyAmount` uses the query window

### Current behavior (wrong)

`server/cashflow.ts:156-158` and `server/cashflow.ts:160-169`:

```ts
function getMonthFactor(rangeDays: number): number {
  return Math.max(1, rangeDays / 30);
}

function getRangeDaysFromTransactions(txns: TxRow[]): number {
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  if (dates.length < 2) return 30;
  const minDate = new Date(`${dates[0]}T00:00:00Z`);
  const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  return Math.max(
    1,
    Math.floor((maxDate.getTime() - minDate.getTime()) / 86_400_000) + 1,
  );
}
```

`monthlyAmount = totalSpend / monthFactor` where `monthFactor = max(1, rangeDays / 30)`.

Two bugs with user impact:
- `rangeDays` is derived from the transactions' own date range, not the query window the user is looking at. If the user selects January and the 4 transactions are clustered Jan 15–22, `rangeDays` is ~8 → `monthFactor = 1` → `monthlyAmount = totalSpend`. The number shown is *total* spend in that cluster, labeled as *per month*.
- The `Math.max(1, ...)` floor means any window shorter than 30 days produces `monthFactor = 1`. A week of heavy spending shows up as its full total labeled `/mo`.

### Fix

Pass the query-window `rangeDays` into `detectLeaks` (the caller already computes it — `server/routes.ts:1289-1295` — and already passes it in via `options.rangeDays`), and **make it required**. Remove the fallback to transaction-range computation.

Changes:

1. **`server/cashflow.ts`**:
   - Delete `getRangeDaysFromTransactions` (lines 160-169).
   - Change the function signature:
     ```ts
     export function detectLeaks(
       txns: TxRow[],
       options: { rangeDays: number; recurringMerchantKeys?: ReadonlySet<string> },
     ): LeakItem[]
     ```
     Note: `rangeDays` moves from optional to required.
   - Remove the `?? getRangeDaysFromTransactions(txns)` fallback on line 197.

2. **`server/routes.ts:1330`**: already passes `{ rangeDays, recurringMerchantKeys }`. No change needed — the param is already being supplied.

3. **`server/cashflow.test.ts`**: every `detectLeaks(txns)` call without `rangeDays` must be updated to pass an explicit `rangeDays`. Pick a reasonable default for each test (e.g. `rangeDays: 120` for tests that build 4 monthly transactions; `rangeDays: 90` for 3-month test cases). Do NOT change any assertions — the point is to exercise the engine with a real query window, not to change what's being asserted.

### Acceptance criteria

- `detectLeaks(txns)` without `rangeDays` is a TypeScript compile error.
- A test case with 4 transactions clustered in the first week of a 30-day window produces the same `monthlyAmount` as the same 4 transactions spread evenly across the month (because both get `monthFactor = 1` now that the window is 30 days).
- A test case with 4 transactions spread across 90 days and `rangeDays: 90` produces `monthlyAmount = totalSpend / 3`, not `totalSpend / 1`.

### Breakage risk: ~10%

Pure refactor of the input contract. The one real risk: any other caller of `detectLeaks` that doesn't currently pass `rangeDays`. Search the codebase for all call sites before merging:
```bash
grep -rn "detectLeaks(" server/ client/
```
Every call must be updated. Expected call sites: `routes.ts` (already correct) and tests. No other production code should call `detectLeaks`.

---

## 3. Fix 2 — Confidence-weighted summary totals

### Current behavior (misleading)

`client/src/pages/Leaks.tsx:313-314`:

```ts
const totalFlagged = leaks.reduce((s, l) => s + l.recentSpend, 0);
const totalMonthly = leaks.reduce((s, l) => s + l.monthlyAmount, 0);
```

Lines 347-353 render this as:
```
{leaks.length} leaks detected in {month}
{totalFlagged} flagged (~{totalMonthly}/mo)
```

Problem: Low-confidence catch-all items (the `banking`, `software`, `other` merchants that qualified only on frequency+amount heuristics) are summed at full weight alongside high-confidence items. A user with two Medium leaks at $300 each and six Low leaks at $50 each sees `$900 flagged` and assumes most of that is real spending exposure. Only $600 of it has decent signal.

### Fix

**Option chosen: show the breakdown by confidence, not a weighted single number.** A weighted single number is still one number the user has to interpret; a breakdown lets them see the shape.

Changes to `client/src/pages/Leaks.tsx`:

1. Replace the two `reduce` calls with a single pass that builds:
   ```ts
   const totals = leaks.reduce(
     (acc, l) => {
       acc.all.flagged += l.recentSpend;
       acc.all.monthly += l.monthlyAmount;
       acc.all.count += 1;
       if (l.confidence === "High") {
         acc.high.flagged += l.recentSpend;
         acc.high.monthly += l.monthlyAmount;
         acc.high.count += 1;
       } else if (l.confidence === "Medium") {
         acc.medium.flagged += l.recentSpend;
         acc.medium.monthly += l.monthlyAmount;
         acc.medium.count += 1;
       } else {
         acc.low.flagged += l.recentSpend;
         acc.low.monthly += l.monthlyAmount;
         acc.low.count += 1;
       }
       return acc;
     },
     {
       all:    { flagged: 0, monthly: 0, count: 0 },
       high:   { flagged: 0, monthly: 0, count: 0 },
       medium: { flagged: 0, monthly: 0, count: 0 },
       low:    { flagged: 0, monthly: 0, count: 0 },
     },
   );
   ```

2. Replace the summary `<motion.p>` (lines 341-355) with a two-line summary:
   - **Line 1** (unchanged structure): `{count} leaks detected in {month} · {all.flagged} flagged`
   - **Line 2** (new): a small breakdown that only renders segments with count > 0:
     ```
     High: {high.count} ({high.flagged})  ·  Medium: {medium.count} ({medium.flagged})  ·  Low: {low.count} ({low.flagged})
     ```
     Each segment gets a small color dot matching the existing `CONFIDENCE_COLORS` palette (emerald / amber / slate).
   - Remove the `(~{totalMonthly}/mo)` suffix. Now that Fix 1 makes `monthlyAmount` a real rate, show a separate monthly-rate number only on individual cards, not in the page summary. (Rationale: summing monthly rates across differently-behaving leaks produces a number that means nothing — a micro-spend coffee habit's "monthly rate" doesn't compose additively with a repeat-discretionary dining rate.)

3. Keep the data-testid attributes on the new elements for test stability.

### Acceptance criteria

- When all leaks are Low confidence, the "High:" and "Medium:" segments don't render (the row shows only "Low: N ($X)").
- When the page has no leaks, the empty state is unchanged.
- `totalFlagged` in the first line equals the sum of High + Medium + Low flagged amounts (integrity check).
- No "/mo" number appears anywhere in the page header/summary.
- `data-testid="leaks-summary-inline"` still exists somewhere in the summary block (tests that look for it won't break).

### Breakage risk: ~5%

Frontend-only, additive. Worst case the breakdown doesn't render correctly — visible immediately, easy to fix.

---

## 4. Fix 3 — "New this period" badge

### Current behavior (missing signal)

Every leak card renders identically. A user glancing at the Leaks page cannot distinguish a habit that started 6 months ago from a pattern that first appeared in the selected month. They're both just cards.

The engine already computes `firstDate`. The data is there and unused.

### Fix

A leak is "new this period" when `firstDate >= queryWindow.startDate`. That computation belongs in the UI (which already has both values), not in the engine.

Changes to `client/src/pages/Leaks.tsx`:

1. Add a helper inside `LeakCard`:
   ```ts
   const isNewThisPeriod = l.firstDate >= startDate;
   ```
   (String comparison on ISO dates is correct and safe; both are `YYYY-MM-DD`.)

2. In the header badge row (around line 192-207), add a new badge **only when `isNewThisPeriod` is true**:
   ```tsx
   {isNewThisPeriod && (
     <span
       className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700"
       data-testid={`leak-new-${slug}`}
     >
       New this period
     </span>
   )}
   ```
   Color: blue (`bg-blue-100 text-blue-700`) — distinct from existing category/confidence/subscription-like badges.

3. In the main page component, sort leaks with `isNewThisPeriod` first, then by `recentSpend` descending within each group. The engine's existing sort is `b.recentSpend - a.recentSpend` (`cashflow.ts:407`); do not change the backend. Sort in the frontend after `useQuery` returns data:
   ```ts
   const sortedLeaks = [...leaks].sort((a, b) => {
     const aNew = a.firstDate >= startDate ? 1 : 0;
     const bNew = b.firstDate >= startDate ? 1 : 0;
     if (aNew !== bNew) return bNew - aNew;
     return b.recentSpend - a.recentSpend;
   });
   ```
   Then render from `sortedLeaks` instead of `leaks`. Use `sortedLeaks` in `leaks.map((l, i) => ...)` on line 398.

4. The summary line's `leaks.length` and total computations still use the unsorted `leaks` array — ordering doesn't affect sums.

### Acceptance criteria

- A leak whose earliest transaction falls on or after the selected month's start date renders a "New this period" badge.
- A leak whose earliest transaction predates the selected month does not render the badge.
- All "New this period" leaks sort above all ongoing leaks, with spend-desc ordering preserved within each group.
- No backend changes required.

### Breakage risk: ~3%

Frontend-only, additive. The only real risk is that `firstDate` is sometimes missing or malformed — add a guard:
```ts
const isNewThisPeriod = typeof l.firstDate === "string" && l.firstDate >= startDate;
```

---

## 5. Testing

### Backend (`server/cashflow.test.ts`)

Existing tests continue to pass after Fix 1's signature change (with the small `rangeDays` parameter addition). Add these new tests for Fix 1 specifically:

```ts
describe("detectLeaks: rangeDays parameter", () => {
  it("uses the provided rangeDays, not the transactions' date span", () => {
    // 4 transactions clustered in a single week
    const txns = [
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-01" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-03" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-05" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-07" }),
    ];
    // Query window = 90 days → monthFactor = 3 → monthlyAmount = $24 / 3 = $8
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    const leak = leaks.find((l) => l.merchantKey === "coffeebar");
    expect(leak).toBeDefined();
    expect(leak!.monthlyAmount).toBeCloseTo(8.0, 1);
    expect(leak!.recentSpend).toBeCloseTo(24.0, 1);
  });

  it("a 30-day window makes monthlyAmount equal totalSpend", () => {
    const txns = monthlyTxns("Pizza Place", "-20.00", "dining", 4);
    const leaks = detectLeaks(txns, { rangeDays: 30 });
    const leak = leaks.find((l) => l.merchantKey === "pizza place");
    expect(leak).toBeDefined();
    expect(leak!.monthlyAmount).toBeCloseTo(leak!.recentSpend, 1);
  });
});
```

### Frontend

No new unit tests required for Fixes 2 and 3 — they're rendering-only. If `Leaks.test.tsx` already has a test that asserts on the summary text, update its expected string. Do not add new frontend tests just for these changes.

---

## 6. Out of scope

- Confidence-weighted single number (considered and rejected in Section 3).
- Engine changes to `detectLeaks` beyond the signature tweak in Fix 1.
- Changing the four threshold values (micro_spend, convenience, repeat_discretionary, high-spend fallback) — those are the engine's business and this spec leaves them alone.
- Changing the four category sets (`DISCRETIONARY_CATEGORIES`, `ESSENTIAL_LEAK_EXCLUSIONS`, `CATCH_ALL_HARD_EXCLUSIONS`, `SUBSCRIPTION_LIKE_CATEGORIES`).
- Drift-prevention test on category sets — worthwhile but separate scope.
- Latency optimization on the `/api/leaks` route (the double `listAllTransactionsForExport` call) — worthwhile but separate scope.
- Empty state copy rewrite — cosmetic, low priority.

---

## 7. Ship order

Three fixes, one PR. Ship together:

1. Fix 1 first (backend change, requires test updates for signature).
2. Fix 2 + Fix 3 in the same frontend commit.
3. Squash before push.

Total commits in PR: 2 (backend, frontend). Total new test cases: 2. Expected effort: 3-4 hours.

---

## 8. Acceptance summary

The PR is done when:

- `detectLeaks()` requires a `rangeDays` parameter (TypeScript enforces).
- A clustered-transactions test shows `monthlyAmount` scales with query window, not transaction span.
- The Leaks page summary shows a confidence breakdown (High / Medium / Low with counts and flagged totals).
- The `~$X/mo` number is removed from the page summary (still present on each card).
- Leaks with `firstDate >= startDate` render a blue "New this period" badge and sort above ongoing leaks.
- All existing tests pass.
- Two new test cases in `cashflow.test.ts` pass.

---

## 9. Notes for the build agent

- These are surgical fixes, not a redesign. Resist the urge to refactor adjacent code.
- Do NOT change the engine's threshold values or category sets. Do NOT add new leak buckets.
- Do NOT add "weighted total" as an alternative — the spec explicitly rejected that in favor of breakdown.
- Do NOT add a "New this period" filter toggle. The badge + sort order is the full scope of Fix 3.
- One PR, two commits (backend + frontend), squashed. Not three commits per fix.
- If Fix 1's signature change touches more than one production call site, stop and flag it — the spec assumes `routes.ts` is the only production caller.
