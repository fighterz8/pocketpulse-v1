# Diagnostic Brief — AI Classification Not Firing

**Repo:** `fighterz8/pocketpulse-v1`
**Goal:** Determine why the AI classifier layer is never invoked despite the pipeline being wired up correctly. OpenAI API credits show zero usage and Tool A reports have never shown `labelSource: "ai"`.

## Investigation order

Start with **Hypothesis 3** — code inspection strongly suggests it is the root cause. If confirmed, the fix is two one-line changes and you are authorized to implement them (see Hypothesis 3's "Proposed fix" section for exact changes). For all other hypotheses: diagnose only, do not fix without approval.

## Symptoms

- Two separate test suite runs (`/dev/test-suite/classification`) returned verdicts where every row's `labelSource` is either `"rule"` or `"cache"`. Never `"ai"`.
- OpenAI billing shows zero API credit usage since the AI classifier was wired into `classifyPipeline.ts`.
- The Tool A report shows 9 category misses out of 50, all of pattern `other → {real_category}`. These are exactly the rows the AI fallback was designed to catch.

## Hypotheses to check

### Hypothesis 1 — `OPENAI_API_KEY` not set in the deployed environment

`server/ai-classifier.ts::getClient()` returns `null` when the env var is missing. `aiClassifyBatch()` then silently returns an empty result map with no warning logged.

**Check:**
- Is `OPENAI_API_KEY` present in the Replit secrets for the running environment?
- Does `process.env.OPENAI_API_KEY` have a non-empty value at server boot?
- Add one diagnostic log line at server startup that prints `[startup] OPENAI_API_KEY present: ${Boolean(process.env.OPENAI_API_KEY)}` (do NOT log the key itself, only presence). Restart and check the boot log.

### Hypothesis 2 — Global seed contains `category: "other"` rows that satisfy the cache hit and short-circuit AI

`classifyPipeline.ts` Phase 1.8 treats any global seed hit as resolved — it sets `labelSource: "cache"` and `needsAi: false`. If the global seed has any entries where the `category` column is `"other"`, rows matching those keys never reach the AI phase, even though they should.

**Check:**
- Query the production database: `SELECT category, COUNT(*) FROM merchant_classifications_global GROUP BY category;`
- Count of `"other"` entries in `merchant_classifications_global`. Any count > 0 is the bug.
- Also check: `SELECT category, COUNT(*) FROM merchant_classifications GROUP BY category;` — same bug is possible in the per-user cache if AI ever wrote an `"other"` result with confidence ≥ 0.7.

### Hypothesis 3 — Cache and global seed unconditionally set `needsAi = false` (LEADING SUSPECT)

**This is almost certainly the root cause.** Confirmed by reading the current code at `classifyPipeline.ts`.

The cache-hit block (around line 240) does:
```ts
row.labelSource = "cache";
row.aiAssisted = false;
row.fromCache = true;
row.needsAi = false;           // ← unconditional
```

The global-seed-hit block (around line 280) does the same thing. Both blocks short-circuit AI regardless of the stored category.

**Why this causes the observed symptoms:**

1. A merchant gets classified as `category: "other"` on first encounter (no rule matched, no cache hit, AI was either unavailable or produced "other" itself).
2. The "other" result gets written to the per-user cache or sits in the global seed with `category: "other"`.
3. Every subsequent encounter of that merchant hits the cache, sets `needsAi = false`, and returns "other" — AI never runs.
4. Nick's Tool A report shows every miss as `other → something`, confidence 55%, with `labelSource: "rule"` or `"cache"` but never `"ai"`. Matches perfectly.

**Confirm:**
- Read the cache-hit and global-seed-hit blocks in `classifyPipeline.ts`.
- Confirm both unconditionally set `needsAi = false` on hit.
- Query the DB: `SELECT category, COUNT(*) FROM merchant_classifications WHERE user_id = <nick's id> GROUP BY category;` — confirm at least a handful of "other" entries exist in his per-user cache. If so, this is the bug end-to-end.

**Proposed fix (do not implement yet — describe and wait for approval):**

In both blocks, replace `row.needsAi = false;` with `row.needsAi = hit.category === "other";`. This keeps the cache metadata visible in the audit trail (labelSource remains "cache" so the developer can see the cache was consulted) but forces AI re-classification when the cache's stored answer is useless. AI results that improve on "other" then get written back to the cache so the same merchant converges over time.

This also applies to the global seed block. Same one-line change.

### Hypothesis 4 — AI call happens but timeout eats it silently

`aiClassifyBatch` is wrapped in `Promise.race` with a 6-second timeout (upload) or 90-second timeout (reclassify). On timeout the result map is empty and the pipeline proceeds with the original rule/cache answers.

**Check:**
- Add a temporary log line immediately after the `Promise.race` in `classifyPipeline.ts`: log `aiCandidates.length` (how many rows were sent) and `aiResults.size` (how many came back).
- Run one classification sample through the pipeline. If `aiCandidates.length > 0` but `aiResults.size === 0`, it's a timeout or API error. If `aiCandidates.length === 0`, it's one of hypotheses 2 or 3.

### Hypothesis 5 — AI candidate list is being built from a pre-filter that excludes the right rows

**Check:**
- Find every place `aiCandidates.push()` is called in `classifyPipeline.ts`.
- Confirm the predicate matches: `(labelConfidence < threshold || category === "other") && labelSource !== "user-rule" && labelSource !== "cache"`.
- If `labelSource !== "cache"` is in the condition, that is the bug per Hypothesis 3. Cache hits with category="other" should still be eligible for AI re-classification.

## Output

Produce a short written report with the following structure. Paste it back as the agent response.

```
## Diagnostic Report

Root cause: <hypothesis 1/2/3/4/5 — one of these, or a new cause discovered during investigation>

Evidence:
- <what you checked>
- <what you found>
- <relevant log output or query result>

Proposed fix (describe, do not implement): <one paragraph>

Risk of proposed fix: <low / medium / high, with reasoning>

Other issues noticed during investigation: <list any unrelated bugs found, do not fix them>
```

## Rules

- **Exception for Hypothesis 3 only:** if you confirm Hypothesis 3 is the cause, implement the two one-line changes described in its "Proposed fix" section. Report the before/after code for each change in your output. After implementing, run the test suite once to confirm some rows now land at `labelSource: "ai"`. Do not make any other code changes.
- For any other hypothesis that turns out to be the cause: do not fix it. Describe the fix, stop, wait for approval.
- Temporary `console.log` statements for observation are fine. Remove them when done.
- Do not modify the test suite.
- If you find multiple causes, report all of them.
- If the investigation produces an ambiguous result, say so honestly. Do not invent a cause.

## Estimated effort

30–60 minutes of investigation. If it takes longer than that, stop and report what you've found so far — do not spiral into the codebase.
