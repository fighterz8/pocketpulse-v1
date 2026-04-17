# PocketPulse Classifier + Recurrence Overhaul — Technical Specification

**Repo:** `fighterz8/pocketpulse-v1`
**Author:** Nick (project lead)
**Status:** Ready for build planning
**Target:** Incremental ship over 5 phases, each independently deployable

---

## 1. Context and Problem Statement

PocketPulse classifies bank transactions into 21 categories (see `shared/schema.ts::V1_CATEGORIES`), detects recurring expenses via a batch time-series detector, and surfaces "leaks" (recurring charges the user may not want). The current overall accuracy sits at roughly 75–80%, and the failure mode is not isolated — ambiguous merchants, recurring-vs-one-off detection, and category granularity all underperform.

Five concrete defects have been identified in the existing code. This document specifies each fix, its breakage risk, and the exact ship order. **The ship order matters** — several of these changes depend on earlier ones being in place. Do not reorder without re-reading the risk notes.

---

## 2. Defects and Fixes (in ship order)

### Phase 1 — AI classifier category mismatch

**File:** `server/ai-classifier.ts`

**Defect:** The `SYSTEM_PROMPT` (lines 30–85) instructs GPT to classify transactions into categories that do not exist in the application's category enum. The prompt uses `business_software`, `subscriptions`, `transportation`, `health`. The actual enum in `shared/schema.ts::V1_CATEGORIES` uses `software`, `auto`, `gas`, `medical`, `fitness`, etc. The `isValidCategory()` guard (line 110) rejects every drifted category name, and the fallback on line 205 coerces them to `"other"`.

**Impact:** Every transaction that reaches the AI fallback path returns `"other"` in the database, regardless of what GPT actually identified. For a user with a significant portion of merchants not covered by `CATEGORY_RULES`, this is a silent wipeout of the AI layer.

**Fix:**

1. Replace the hand-written category block in `SYSTEM_PROMPT` with a programmatic derivation from `V1_CATEGORIES`:
   ```ts
   import { V1_CATEGORIES } from "../shared/schema.js";
   const CATEGORY_LINES = V1_CATEGORIES.map(c => `- ${c}`).join("\n");
   ```
2. Rewrite the category definitions section to match the actual enum values (`software` not `business_software`, `auto` + `gas` + `travel` + `parking` not `transportation`, `medical` + `fitness` not `health`, no `subscriptions` — use `software` or `entertainment` as appropriate).
3. Update the "Decision rules" section in the prompt accordingly.
4. Add a unit test that asserts every category name mentioned in the prompt string is a member of `V1_CATEGORIES`. This prevents future drift.

**Post-deploy action:** Run a full `reclassifyTransactions` sweep for all users so existing `"other"` rows get re-classified with the fixed prompt.

**Breakage risk: ~15%.**

- Dashboard aggregations (`server/dashboardQueries.ts`) may surface noticeably different numbers overnight as `"other"` rows redistribute into real categories. This is the correct outcome but looks like a behavior change.
- The recurrence detector's `LIFESTYLE_BLOCK_CATEGORIES` and `SUBSCRIPTION_CATEGORIES` tolerance bands will now fire on rows that previously slipped through as `"other"`. Some charges that were wrongly flagged as "recurring" (because `"other"` didn't hit the lifestyle block) will stop being flagged. Again correct, but visible.
- Existing snapshot tests in `server/classifier.test.ts` and `server/upload-classification.test.ts` may fail and need to be updated to the new expected values.

---

### Phase 2 — Merchant cache table (per-user, correction-seeded)

**New file:** `server/merchantCache.ts`
**Schema change:** `shared/schema.ts` — new table
**Integration point:** `server/reclassify.ts`, before the rule-matching pass

**Defect:** There is no persistent memory of "we've seen this merchant before." When `aiClassifyBatch` successfully classifies `BLUE BOTTLE #1174` on Monday, the same or a similar merchant string on Tuesday pays the full OpenAI round-trip again. User corrections from `getMerchantRules()` are applied (line 107 of `reclassify.ts`), but only for merchants the user has personally corrected — there is no automatic learning from AI or rule outcomes.

**Impact:** Unnecessary AI cost, unnecessary latency on every upload, and no compounding accuracy gain over time.

**Fix — schema:**

```ts
// In shared/schema.ts — new table
export const merchantClassifications = pgTable("merchant_classifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  merchantKey: text("merchant_key").notNull(),          // recurrenceKey() output
  category: text("category").notNull(),
  transactionClass: text("transaction_class").notNull(),
  recurrenceType: text("recurrence_type").notNull(),
  labelConfidence: decimal("label_confidence", { precision: 3, scale: 2 }).notNull(),
  source: text("source").notNull(),                      // "manual" | "ai" | "rule-seed"
  hitCount: integer("hit_count").notNull().default(1),
  lastUsedAt: timestamp("last_used_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  userMerchantIdx: uniqueIndex("merchant_cache_user_merchant_idx").on(t.userId, t.merchantKey),
}));
```

**Fix — lookup path in `reclassify.ts`:**

Insert a new Phase 0.5 between the rule-matching pass and the AI fallback:

1. Compute `recurrenceKey(merchant)` for every transaction.
2. Batch-fetch all cache entries for this user keyed by those values.
3. For any transaction with a cache hit, apply the cached category/class/recurrence, set `labelSource: "cache"` and `labelConfidence: cached.labelConfidence`, and mark `needsAi: false`.
4. Increment `hitCount` and update `lastUsedAt` on hit (can be done async, non-blocking).

**Fix — write-back path:**

- When `aiClassifyBatch` returns a result with `labelConfidence >= 0.70`, upsert it into `merchant_classifications` with `source: "ai"`.
- When a user manually corrects a transaction (existing `userCorrected` flow), upsert with `source: "manual"` and `labelConfidence: 1.0`. Manual always wins over AI on conflict.
- Do **NOT** seed from `labelSource: "rule"` in Phase 2. Rule migration is Phase 5.

**Seeding strategy for day one:**

Seed the cache from the user's existing `transactions` table where `userCorrected = true` OR `labelSource = "manual"`. This guarantees the cache starts with known-good data only. Do not import AI-labeled or rule-labeled historical rows in Phase 2 — doing so would lock in existing errors.

**Breakage risk: ~40%.**

- Cache poisoning if seeded from bad data. Mitigation: strict source filter on initial seed (manual only), never `rule` or `ai`.
- Cache invalidation semantics must be decided explicitly. This spec chooses **per-user** cache (not global) — one user's weird correction never leaks to other users. Downside: no cross-user network effect. Revisit after 90 days of telemetry.
- Schema migration must be coordinated with `drizzle.config.ts`. Run migration in a maintenance window; block uploads for the duration.
- Race condition: two concurrent uploads for the same user with the same merchant. Upsert with `ON CONFLICT (user_id, merchant_key) DO UPDATE` resolves this; last write wins on equal-confidence sources, manual always beats ai, ai always beats rule-seed.

---

### Phase 3 — Delete Pass 9b amount-range heuristic

**File:** `server/classifier.ts`, lines 1879–1917

**Defect:** When no keyword rule matches and the transaction is still categorized as `"other"`, Pass 9b guesses the category from the dollar amount: $2–$7 → coffee, $8–$22 → dining, $23–$60 → dining, $0.99–$2.99 with "fee" keyword → fees. These are labeled with confidence 0.35–0.45, which reads as "low confidence" but is enough to silence the `aiAssisted` escalation signal because `category === "other"` is one of the conditions on line 1894.

**Impact:** False positives are planted with just enough confidence to avoid AI review. A $5 parking meter becomes coffee. A $15 Uber becomes dining. These incorrect labels also pollute the user's "spending by category" dashboard with fake dining spend.

**Fix:**

Delete lines 1879–1917 entirely. Leave the transaction as `category: "other"` so the `aiAssisted` flag correctly fires.

**Prerequisite:** Phase 2 must be deployed first, so that truly novel merchants land in the cache after AI resolves them — otherwise `"other"` rows will keep re-requesting AI every upload.

**Breakage risk: ~25%.**

- Users without an `OPENAI_API_KEY` configured will see more `"other"` rows on their dashboard than before (which is the honest outcome, but visible).
- AI fallback volume increases proportionally to the number of rows that Pass 9b was silently catching. Monitor OpenAI spend for the week following deploy.
- A few `classifier.test.ts` cases that assert on the amount-range output will need to be removed or updated.

---

### Phase 4 — Subordinate classifier recurrence to the batch detector

**Files:** `server/classifier.ts`, `server/recurrenceDetector.ts`, `shared/schema.ts`, `server/storage.ts`

**Defect:** The classifier assigns `recurrenceType` per-row based on keyword heuristics (passes 8, 8b, 9 — lines 1840–1877). The batch detector (`recurrenceDetector.ts`) is the authoritative recurrence engine — it uses median interval, standard deviation, monthly coverage, and category-stratified tolerance. When these two disagree, the classifier's per-row hint is written to the DB first and the batch detector may or may not overwrite it later, depending on whether the transaction hits the detector's minimum count threshold. The result is inconsistent recurrence state across the DB.

**Impact:** The "recurring leak identifier" produces unreliable output because the `recurrenceType` field can be set by either of two independent systems with different criteria. A brand-new Netflix charge is flagged recurring by the classifier (keyword "subscription" matches), then *not* flagged by the detector (only one occurrence — below minimum), causing a flicker.

**Fix:**

1. Add a new field to the transactions table:
   ```ts
   recurrenceSource: text("recurrence_source").notNull().default("none"),
     // "none" | "hint" | "detected"
   ```
2. In `classifier.ts`, keep passes 8 / 8b / 9 but mark their output as **tentative**. The `ClassificationResult` type gains:
   ```ts
   recurrenceHint: "recurring" | "one-time";  // was recurrenceType
   ```
   The field is renamed to make its tentative nature explicit.
3. In `reclassify.ts` and the upload path, persist `recurrenceHint` as `recurrenceType` on write but always set `recurrenceSource: "hint"` for these.
4. In `recurrenceDetector.ts`'s `syncRecurringCandidates` routine (or wherever the batch detector writes back to the `transactions` table), upgrade rows it confirms as recurring to `recurrenceSource: "detected"` with `recurrenceType: "recurring"`. For rows the detector explicitly rejects (amount pattern too erratic, lifestyle category, etc.), downgrade to `recurrenceType: "one-time"` and `recurrenceSource: "detected"`.
5. In the leak identifier and any UI surface that depends on "is this recurring," prefer `recurrenceSource === "detected"` as the trust signal. `"hint"` can be shown with a "tentative" indicator or suppressed from the leak view.

**Breakage risk: ~55%.** (Reduced from the originally estimated 60% because this version preserves the classifier's hint rather than stripping it.)

- Schema migration required. `recurrenceSource` must be backfilled on existing rows: rows touched by the batch detector get `"detected"`, everything else gets `"hint"`.
- The leak identifier and dashboard queries need coordinated updates to read the new field. If a UI surface forgets to check `recurrenceSource`, it will over-count recurring items (showing tentative + detected together).
- Tests in `classifier.test.ts` and `recurrenceDetector.test.ts` need updates. The classifier test's `recurrenceType` expectations become `recurrenceHint` expectations.

---

### Phase 5 — Migrate `CATEGORY_RULES` into the merchant cache

**File:** `server/classifier.ts` (reduce), `server/merchantCache.ts` (extend)

**Defect:** `CATEGORY_RULES` in `classifier.ts` is 1,356 lines (lines 109–1464) of hand-written merchant keyword lists. This is the wrong shape of storage for merchant-level data — every new merchant is a code edit and redeploy. It also makes the classifier file nearly 2,000 lines, hard to navigate and review.

**Impact:** High maintenance cost, slow iteration, and the rules don't learn from user corrections (corrections live in a separate `merchant_rules` table and only apply post-hoc).

**Fix:**

1. Categorize each entry in `CATEGORY_RULES` as either **structural** (transfer keywords, refund keywords, income keywords, ACH/debit/wire prefixes — things that describe the *form* of the transaction) or **merchant-specific** (Sallie Mae, Duke Energy, Geico, Netflix, etc.). Structural rules stay in code. Merchant-specific rules migrate out.
2. Build a one-time migration script that walks `CATEGORY_RULES`, expands each keyword into a merchant cache row with `source: "rule-seed"`, `labelConfidence: 0.88` (one notch below rule's current confidence, so AI and manual corrections can override), and inserts them into a **global** seed table (separate from per-user caches). This global seed is consulted after per-user cache miss and before AI fallback.
3. New lookup order in `reclassify.ts`:
   1. Per-user cache (Phase 2)
   2. Global seed cache (Phase 5)
   3. Structural rules in `classifier.ts` (reduced set, ~150 lines)
   4. AI fallback
4. Delete the merchant-specific entries from `CATEGORY_RULES` once the global seed is populated and verified in staging.

**Breakage risk: ~70%.** This is the highest-risk phase and must ship last.

- Every merchant currently covered only by `CATEGORY_RULES` must be in the seed cache before the rule is deleted. Missing even a handful of large-volume merchants (a common utility, a major credit card issuer) causes visible regressions for many users simultaneously.
- The global seed introduces a cross-user data path. A poisoned seed entry (incorrect keyword mapping) affects every user at once. Migration script must be run against a test database first, diffed against expected output, and reviewed before production.
- Users without `OPENAI_API_KEY` are more exposed: if a merchant misses both caches, they have no AI fallback and the row lands in `"other"`. Consider leaving the full `CATEGORY_RULES` in place as a final safety net for at least one release cycle after the cache cutover.
- Tests: `classifier.test.ts` will have dozens of failures as the matching path changes. Rewrite tests to exercise the full `reclassify.ts` pipeline rather than `classifyTransaction()` in isolation.

---

## 3. Ship Order and Dependencies

| Phase | Blocks | Blocked By | Estimated Effort |
|-------|--------|------------|------------------|
| 1: AI category fix | — | — | 1–2 hours |
| 2: Merchant cache | 3, 5 | 1 | 1–2 days |
| 3: Delete Pass 9b | — | 2 | 30 min |
| 4: Recurrence subordination | — | — | 1 day |
| 5: Rule migration | — | 2 | 2–3 days |

Phase 4 has no blockers and no blockees; it can ship in parallel with any other phase.

Phase 2 must ship before Phase 3 (or Phase 3 creates a "more `other` rows" regression with nowhere for those rows to land except AI on every upload).

Phase 5 must ship last. Do not skip Phase 2.

---

## 4. Acceptance Criteria per Phase

### Phase 1
- No category string in `server/ai-classifier.ts::SYSTEM_PROMPT` fails `V1_CATEGORIES.includes()`.
- A unit test enforces this invariant.
- A `reclassify` sweep run against a user with ≥ 200 transactions shows a measurable drop in `"other"` category count and a matching increase in real categories. Target: `"other"` rate drops by at least 30% of its pre-fix value.

### Phase 2
- `merchant_classifications` table exists with the schema above.
- A cache hit in `reclassify.ts` short-circuits both the rule pass and the AI call.
- A successful AI classification with `labelConfidence >= 0.70` is persisted to the cache within the same transaction.
- A user correction via the existing UI path writes to the cache with `source: "manual"`.
- Repeat upload of the same CSV for the same user shows 0 AI calls on the second run.

### Phase 3
- Lines 1879–1917 of `classifier.ts` are removed.
- No test case depends on the removed pass.
- AI call volume after Phase 3 is within 20% of Phase 2 post-stabilization volume (because the cache is absorbing the increase).

### Phase 4
- `recurrenceSource` column exists on `transactions` and is backfilled.
- The leak identifier only surfaces rows where `recurrenceSource === "detected"`.
- A QA scenario: upload 1 Netflix charge → classifier hints `recurring`, detector doesn't confirm (count too low), UI shows "tentative" or hides from leaks. Upload 3 more months of Netflix → detector confirms, UI promotes to a confirmed leak candidate.

### Phase 5
- `CATEGORY_RULES` is reduced to structural rules only — target line count ≤ 200.
- Global seed cache contains every merchant-specific keyword from the pre-migration `CATEGORY_RULES`, verified by a diff script.
- Integration tests exercise the full resolution order (per-user cache → global seed → structural rules → AI).

---

## 5. Testing Strategy

- **Phase 1, 3:** Unit tests in the existing `classifier.test.ts` and `ai-classifier.test.ts` files (create the latter if it doesn't exist).
- **Phase 2, 5:** Integration tests against a test database. The existing `reclassify.test.ts` is the right home for these.
- **Phase 4:** End-to-end test against a seeded DB with known recurring merchants and a known one-off merchant whose description contains the word "monthly" (a classic classifier-hint false positive).
- **Regression guard:** Before Phase 5 ships, run the accuracy report (`server/accuracyReport.ts`) against a production-like dataset. The overall accuracy score must not decrease. Target: ≥ 5-point improvement after all phases ship.

---

## 6. Out of Scope for This Overhaul

The following were considered but explicitly deferred:

- **Cross-user global cache** beyond the rule-seed. Per-user is the right default. Revisit after 90 days of telemetry.
- **Embedding-based fuzzy merchant matching** (e.g., `STARBUCKS #4471` → `STARBUCKS`). The existing `recurrenceKey()` normalizer is good enough for Phase 2. Add embeddings only if cache hit rate plateaus below 70% after Phase 5.
- **Model upgrade from `gpt-4o-mini`.** The current model is fine once the category mismatch is fixed. Cost discipline matters more than model capability here.
- **Frontend changes.** All five phases are backend-only. The UI reads existing fields; the only UI-visible change is the "tentative" indicator introduced in Phase 4, which is trivial.

---

## 7. Rollback Plan per Phase

| Phase | Rollback Method |
|-------|-----------------|
| 1 | Git revert the prompt changes. No DB rollback needed. Re-run reclassify sweep. |
| 2 | Feature-flag the cache lookup. If flag off, behavior reverts to pre-Phase-2 exactly. Table can remain in the DB. |
| 3 | Git revert. Restores Pass 9b. No DB change. |
| 4 | Feature-flag the `recurrenceSource` read in the leak identifier. If flag off, UI reads `recurrenceType` directly as before. |
| 5 | Revert the migration script, restore the deleted `CATEGORY_RULES` entries. Global seed rows can stay in the DB — they will simply not be consulted. |

Every phase should ship behind a feature flag that can be toggled without a redeploy.

---

## 8. Notes for the Build Agent

- Do not skip Phase 2 to get to Phase 5 faster. The rule migration without a working cache underneath is the fastest way to regress the app.
- Do not combine phases into a single PR. Each phase should be its own PR, reviewable and revertable independently.
- When in doubt on a schema change, prefer adding a new field over mutating an existing one. Field mutations require data migration; field additions don't.
- Keep the existing audit trail (`labelSource`, `labelConfidence`, `labelReason`) populated on every write path. This is the only reason the system is currently debuggable; preserve it.
- The existing `accuracyReport.ts` is the source of truth for whether this overhaul is working. Run it before Phase 1 to capture a baseline, then after each phase. Do not ship a phase whose accuracy report is worse than the prior phase's.
