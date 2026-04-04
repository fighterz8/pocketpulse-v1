# Report 1: Transaction Classification System

**File:** `server/classifier.ts` (~1,832 lines)  
**Supporting:** `server/transactionUtils.ts`, `server/csvParser.ts`  
**Entry point:** `classifyTransaction(rawDescription: string, amount: number): ClassificationResult`

---

## What It Produces

Every transaction is classified into these fields:

| Field | Values | Source |
|---|---|---|
| `transactionClass` | `income` / `expense` / `transfer` / `refund` | 12-pass state machine |
| `flowType` | `inflow` / `outflow` | Amount sign + direction hint |
| `category` | 21 categories (see V1_CATEGORIES) | Keyword rules |
| `recurrenceType` | `recurring` / `one-time` | Rules + heuristics |
| `merchant` | Cleaned display name | `normalizeMerchant()` |
| `labelConfidence` | 0.55 – 0.92 | Rule-defined per category |
| `labelReason` | Human-readable explanation | Per-pass |
| `aiAssisted` | boolean | Flag for LLM review |

---

## Step 0 — CSV Parsing & Amount Normalization

Before classification runs, the CSV parser (`server/csvParser.ts`) handles:

- **Column header detection:** Fuzzy-maps headers like `"Trans Date"`, `"Posting Date"`, `"Debit"`, `"Credit"`, `"Description"` to canonical fields.
- **Amount normalization** (`normalizeAmount()`): Handles `$1,234.56`, `(1234.56)` accounting format, and strips currency symbols.
- **Signed amount derivation** (`deriveSignedAmount()`): Resolves either a single `amount` column or split `debit` / `credit` columns into one signed number. Debit → negative (outflow), credit → positive (inflow).
- **Flow inference** (`inferFlowType()`): `signedAmount < 0 → outflow`, else `inflow`. This is the primary flow signal.
- **Date normalization** (`parseDate()`): Handles `MM/DD/YYYY`, `M/D/YYYY`, `YYYY-MM-DD`, `MM/DD/YY`, `MM-DD-YYYY`.

**Known gap:** Amount sign conventions vary by bank. Some banks export all amounts as positive and express direction only through separate debit/credit columns or description text. Others use negatives for outflow. The system handles the most common formats but will fail silently on unusual ones.

---

## Merchant Normalization

`normalizeMerchant()` in `transactionUtils.ts` runs before classification:

1. Iteratively strips leading POS prefixes (`SQ *`, `TST *`, `SP *`, `AMZN *`, `APPLE.COM/BILL`, `ACH DEBIT`, `DEBIT-DC NNNN`, `POS PURCHASE`, etc.) in a loop until stable.
2. Strips trailing location suffix (e.g. ` CA`, ` TX 77001`).
3. Strips trailing reference/auth codes (`REF #...`, `AUTH #...`, long digit strings).
4. Collapses whitespace.
5. Title-cases the result.

**Known gap:** Some bank descriptions are so heavily encoded (e.g. `CHECKCARD 0412 FRYS FOOD #659 SURPRISE AZ 00000000000`) that the output after stripping is still noisy. The TRAILING_NOISE_REGEX may clip part of the merchant name.

---

## The 12-Pass State Machine

Classification runs as a sequential state machine. Each pass can override earlier passes (Pass 6 intentionally overrides Passes 1–2 for specific cases like debt transfers).

### Pass 1 — Transfer Detection
Checks if `rawDescription.toLowerCase()` contains any of 19 transfer keywords: `transfer`, `zelle`, `venmo`, `cash app`, `wire`, `paypal`, `mobile deposit`, etc.

→ Sets `transactionClass = "transfer"`, `category = "other"`.

**Gap:** Transfer detection only fires on keyword presence, not context. "Transfer to auto loan" correctly becomes debt (Pass 6 overrides it), but "Zelle payment to Joe's Landscaping" is permanently stuck as a transfer instead of housing/other.

### Pass 2 — Refund Detection
Checks for `refund`, `return credit`, `reversal`, `chargeback`, `adjustment cr`.

→ Sets `transactionClass = "refund"`. Does not fire if already a transfer.

**Gap:** Bare `return` is intentionally excluded to avoid false positives (e.g. "RETURN VONS"). This means store returns described only as "RETURN ALBERTSONS" miss refund classification.

### Pass 3 — Income Detection
Only fires for `amount >= 0` and non-transfer/refund. Checks for `deposit`, `payment received`, `direct dep`, `ach credit`, `wire from`, `invoice`.

→ Sets `transactionClass = "income"`, `category = "income"`.

### Pass 3b — Direction Hint Correction
Critical for banks that export unsigned (all-positive) amounts. Uses `getDirectionHint()` which checks two ordered tiers:

**Tier 1 — Strong outflow patterns** (checked first):
`transfer to`, `payment to`, `ach debit`, `pos`, `purchase`, `withdrawal`, `atm fee`, `bill pay`, `autopay`, `debit`

**Tier 2 — Inflow patterns**:
`transfer from`, `ach credit`, `direct deposit`, `salary`, `payroll`, `refund`, `reversal`, `return`

If `transactionClass` is still "income" (from positive amount default) but a strong outflow hint is present → flips to `expense` / `outflow`.

**Gap:** Navy Federal and some other banks write descriptions that don't contain any of these strong signals for many merchant transactions. A $50 "FIREHOUSE SUBS" charge may land as income if the bank exports it unsigned with no directional prefix.

### Pass 4 — Standalone "credit" Keyword
Handles "ANNUAL FEE CREDIT", "CREDIT MEMO". Uses word-boundary regex `/(^|\s)credit($|\s)/`.

→ Sets `transactionClass = "refund"` when no income context exists.

### Pass 5 — Transfer Direction Refinement
If still a transfer, uses `getDirectionHint()` to set `flowType` ("TRANSFER TO SAVINGS" → outflow, "TRANSFER FROM CHECKING" → inflow).

### Pass 6 — Merchant Rule Matching (Core Pass)

The largest pass. Iterates through `CATEGORY_RULES` array (order matters — first match wins):

**Rule order and confidences:**
| Priority | Category | Confidence | Notes |
|---|---|---|---|
| 1 | `debt` | 0.92 | Has explicit `transactionClass: "expense"` to override transfers |
| 2 | `fees` | 0.88 | ATM, NSF, maintenance fees |
| 3 | `insurance` | 0.90 | Major insurers + bare keyword |
| 4 | `entertainment` | 0.90 | Streaming services, marked recurring |
| 5 | `software` (consumer) | 0.90 | Spotify, Apple, Adobe, marked recurring |
| 6 | `software` (business) | 0.85 | GitHub, AWS, SaaS tools |
| 7 | `housing` | 0.80 | Mortgage servicers, home stores, BUT also Airbnb |
| 8 | `utilities` | 0.85 | All major carriers and utilities |
| 9 | `travel` | 0.85 | Airlines, hotels, booking platforms |
| 10 | `gas` | 0.85 | Gas stations |
| 11 | `parking` | 0.85 | Parking apps |
| 12 | `auto` | 0.80 | Rideshare, maintenance, tolls |
| 13 | `groceries` | 0.85 | Major chains, ethnic markets |
| 14 | `coffee` | 0.85 | Coffee chains (before dining so Starbucks wins here) |
| 15 | `delivery` | 0.90 | Food delivery apps (before dining so DoorDash wins) |
| 16 | `convenience` | 0.85 | 7-Eleven, Circle K, etc. |
| 17 | `dining` | 0.80 | Restaurants, fast food, bars |
| 18 | `medical` | 0.80 | Pharmacies, hospitals, mental health |
| 19 | `fitness` | 0.88 | Gyms, studios, marked recurring |
| 20 | `shopping` | 0.70 | Amazon, Target, Walmart, etc. |

Each rule can optionally set:
- `transactionClass`: explicit override (only debt and fees use this)
- `recurrenceType`: marks as recurring (entertainment, software consumer, fitness)

**Major known gaps in Pass 6:**

1. **Walmart ambiguity:** Only "walmart supercenter", "walmart grocery", "walmart neighborhood" → groceries. Plain "WALMART" → shopping. But users frequently use Walmart as their grocery store.

2. **Housing confidence is lowest (0.80):** Keywords like `maintenance`, `lawn`, `cleaning service`, `maid` are in the housing ruleset but are vague enough to misfire on commercial services.

3. **Airbnb in travel AND housing:** Airbnb appears in both `travel` and `housing` rules. Since `travel` comes before `housing` in the list — Airbnb is always classified as `travel`. This is correct for a user booking travel but wrong if they're paying for their own Airbnb rental unit.

4. **"coffee" in dining:** The `dining` keyword list includes `"coffee"` as a bare keyword. Since `coffee` category rules run before `dining`, named coffee shops (Starbucks, Dutch Bros) go to coffee correctly. But a description like "DOWNTOWN COFFEE ROASTERS" with no chain match goes to dining via the bare `coffee` keyword.

5. **Shopping confidence is lowest (0.70):** Most generic purchases land here. A merchant in Etsy, Amazon Marketplace, or any unrecognized e-commerce store routes to shopping — even if it's for medical supplies or business software.

6. **No keyword for unknown merchants:** A merchant not in any of the ~800 keywords currently in CATEGORY_RULES gets category `other` with confidence 0.55 and `aiAssisted = true`. This is the primary accuracy ceiling — the "long tail" of merchants.

### Pass 8 — Recurring Subscription Heuristic
If `recurrenceType` is still "one-time", checks if the raw description contains the literal words: `subscription`, `monthly`, `recurring`, or `membership`.

**Gap:** These literal words don't appear in most bank-formatted descriptions. "Netflix" is caught by the category rule's `recurrenceType: "recurring"` in Pass 6, not this pass. This pass only helps descriptions that literally say "MONTHLY FEE" or "RECURRING CHARGE."

### Pass 9 — Recurring Income Detection
Checks payroll/benefit keywords: `salary`, `payroll`, `direct deposit`, `social security`, `pension`, etc.

### Pass 8b — Legacy RECURRING_KEYWORDS
A second recurring check using a 50+ keyword list that overlaps heavily with CATEGORY_RULES. Catches insurance providers, utilities, and mortgage keywords that weren't explicitly set to recurring in Pass 6.

**Gap:** This is duplicate logic. The `RECURRING_KEYWORDS` list (Pass 8b) and the `recurrenceType: "recurring"` in CATEGORY_RULES (Pass 6) overlap. Entertainment and software are correctly set recurring in Pass 6 but are also in RECURRING_KEYWORDS. Maintenance burden.

### Pass 11 — Income Category Lock
Forces `category = "income"` and `flowType = "inflow"` for any `transactionClass === "income"`. Prevents edge cases.

### Pass 12 — AI Assisted Flag
Sets `aiAssisted = true` when ALL three conditions hold:
1. No merchant rule matched
2. `recurrenceType` is still "one-time"
3. No direction hint in the description

Currently the `aiAssisted` flag exists in the DB but the AI enrichment layer (`server/ai-classifier.ts`) is not called automatically during upload. It exists as an opt-in endpoint.

---

## V1 Category Set (21 categories)

`income` · `housing` · `debt` · `utilities` · `groceries` · `dining` · `coffee` · `delivery` · `convenience` · `gas` · `parking` · `travel` · `auto` · `fitness` · `medical` · `insurance` · `shopping` · `entertainment` · `software` · `fees` · `other`

**Note:** `transfers` was removed from V1 categories but `transactionClass = "transfer"` still exists. Transfers always get `category = "other"` unless overridden to debt.

---

## Current Accuracy Estimate

| Transaction type | Estimated accuracy | Reason |
|---|---|---|
| Named chain merchants (Netflix, Shell, Starbucks) | ~97% | Explicit keyword matches |
| Major mortgage/utility servicers | ~92% | Long keyword lists |
| Income (payroll, direct deposit) | ~95% | Strong directional keywords |
| Transfers (Zelle, Venmo) | ~90% | Keyword match, but "Zelle to landscaper" mislabels |
| Restaurants (named chains) | ~90% | DoorDash vs restaurant ordering confusion |
| Groceries (small/ethnic stores) | ~70% | Not in keyword list → "other" |
| Independent businesses | ~50% | Entirely keyword-miss → "other" |
| Unsigned-amount CSV banks | ~75% | Depends on direction hint presence |
| **Overall estimated** | **~75–80%** | Heavy tail of unrecognized merchants |

---

## Known Structural Weaknesses

1. **No ground-truth test set.** There is no benchmark dataset of real transactions with correct labels to measure actual accuracy. `server/classifier.test.ts` tests edge-case logic, not real-world accuracy.

2. **Single-pass, first-match-wins with no scoring.** A description matching two keywords at different priority levels silently takes the first one. No confidence comparison between competing rules.

3. **No per-user learning.** User corrections (`userCorrected = true` on the transaction) are stored but never fed back into the classifier. Every upload starts from scratch.

4. **No amount-based features.** The classifier has no idea what amount the transaction was. A $2.99/mo Spotify charge and a $299 one-time software license would be treated identically.

5. **No merchant frequency features.** If a merchant appears 12 times in a single month, that's a strong signal it's a recurring charge. The classifier doesn't use this context — each transaction is classified independently.

6. **Keyword matching is case-insensitive substring, not word-boundary.** `"energy"` in utilities matches "ENERGY DRINK CO" → utilities incorrectly. `"bar"` is not in the list but `"bar & grill"` and `"pub"` are — still, word-boundary matching would be more precise.

---

## Proposed Overhaul Options

### Option A — Expanded + Tiered Keyword Engine (minimal change)
- Add 500+ merchant name → category mappings from public datasets (Yodlee, Plaid's open merchant database, MCC codes).
- Add word-boundary matching (`\bgas\b` instead of `"gas"`) to reduce false positives.
- Add amount-range signals (amounts < $25 + convenience store name → convenience, not shopping).
- Add a test CSV with 500+ labeled transactions from real bank exports. Run it in CI as a regression test.
- Estimated accuracy improvement: **75% → 85–88%**.

### Option B — MCC Code Integration
Many bank CSVs include a Merchant Category Code (MCC) field. MCCs are a 4-digit ISO standard that directly maps to spending category. If the CSV has this field:
- MCC 5411 → groceries (all grocery stores, no keyword needed)
- MCC 5812 → dining (all restaurants)
- MCC 4814 → utilities (phone/ISP)
- MCC 5912 → medical (pharmacies)

**Implementation:** Add MCC column detection in `csvParser.ts`. Build a `mcc-to-category.ts` mapping table (ISO MCC → V1Category). Use MCC classification first; fall back to keyword rules.
- Estimated accuracy with MCC: **90–95%** on banks that include MCC.
- Estimated coverage: ~60% of bank CSVs include MCC.

### Option C — Embeddings + Vector Similarity (high accuracy, higher complexity)
Pre-compute embeddings for all 21 category descriptions + known merchant examples. At classification time, embed the merchant description and find the nearest category centroid.
- No keyword maintenance.
- Handles novel merchants ("Farmhouse Organics" → groceries by semantic similarity).
- Requires embedding API call per transaction or local model.
- Estimated accuracy: **90–95%** on unknown merchants.

### Option D — LLM Batch Enrichment (already scaffolded)
`server/ai-classifier.ts` already exists. Currently unused during upload. Batch `aiAssisted = true` transactions (estimated 20–30% of all transactions) to an LLM with category list and description. Cost at GPT-4o-mini is roughly $0.01 per 100 transactions.
- High accuracy on long-tail merchants without any keyword list maintenance.
- Adds latency to upload (can be async background job).
- Estimated accuracy on unknown merchants: **88–93%**.

### Recommended Path
**Short term:** Option A + a real test dataset (500 labeled transactions).  
**Medium term:** Option B (MCC codes) + Option D (LLM for `aiAssisted` rows only).  
**Long term:** Option C for a full semantic classifier if keyword maintenance becomes unmanageable.
