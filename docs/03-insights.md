# Spending Insights & Analysis

This section covers the features that turn raw transaction data into actionable information — recurring charge detection, the safe-to-spend dashboard, and the leak detection system.

---

## Recurring Charge Detection

The app automatically scans your transactions to identify charges that repeat on a regular schedule.

**What changed:**
- A detection engine was built that groups transactions by merchant and looks for ones appearing at consistent intervals — weekly, monthly, or annually
- Each detected pattern is assigned a monthly-equivalent dollar amount so all costs can be compared on the same scale
- Recurring charges are flagged in the ledger and factored into the dashboard separately from one-time purchases

**What it looks like now:**
- The Dashboard shows a dedicated recurring expenses total
- Individual transactions marked as recurring are labeled in the ledger
- The Leaks page lists all detected recurring patterns ranked by cost

---

## Safe-to-Spend Dashboard

A top-level view of your financial picture for any selected month.

**What changed:**
- A hero card was built showing an estimated "safe to spend" amount — income minus recurring expenses, taxes, and committed bills
- Four key tiles were added: total income, total recurring expenses, total one-time expenses, and total discretionary spending
- A month selector was added so you can review any past month, not just the current one
- A category breakdown and recent transactions strip round out the page

**What it looks like now:**
- The Dashboard page opens to the current month with a large "Safe to Spend" number front and center
- Switching months updates all tiles and the breakdown instantly

---

## KPI Card Subtitle Clarification

Some of the small descriptive labels below the tile numbers were ambiguous — testers were unsure whether "Recurring" meant subscriptions only or all regular bills.

**What changed:**
- The subtitle text on each tile was reworded to be explicit about what it counts
- "Recurring expenses" now clarifies it includes subscriptions, regular bills, and other scheduled charges
- "One-time expenses" is labeled to distinguish it clearly from recurring costs

**What it looks like now:**
- Each tile has a short, clear label that explains exactly what the number represents without guesswork

---

## Import History List

There was no record of past uploads — you had to trust your data was there without any confirmation log.

**What changed:**
- The upload page now includes an import history section listing every previous upload
- Each entry shows the file name, the account it was imported into, the date of import, and how many rows were added

**What it looks like now:**
- Below the upload form, a history list shows all past imports in reverse chronological order

---

## Account Selector Fix

The account picker on the upload page would sometimes stay open after a selection was made, requiring an extra click to close it.

**What changed:**
- The dropdown now closes automatically as soon as you select an account

**What it looks like now:**
- Choosing an account in the upload form works in a single click with no stray open dropdowns

---

## Leak Detection — First Version

The initial leak detection system flagged transactions that looked like "leaky" spending — small, frequent, easily-overlooked charges.

**What changed:**
- Detection rules were built for three patterns: high-frequency micro-charges, repeat discretionary spending, and charges that resemble forgotten subscriptions
- A dedicated Leaks page was built listing every detected pattern ranked by estimated monthly cost
- Each card shows the merchant, estimated monthly total, and how many times it appeared

**What it looks like now:**
- The Leaks page gives a ranked list of spending patterns that may be worth reviewing or canceling

---

## Leak Detection Overhaul — Merchant-First Grouping

The first version grouped leaks by spending category, which made it hard to see which specific merchant was costing the most — "DoorDash" and "Uber Eats" were merged into one vague "delivery" card.

**What changed:**
- The detection engine was rebuilt to group first by merchant, then show the category breakdown within each merchant
- Each card now represents a single merchant with a total monthly cost and category breakdown below it
- Ranking changed to sort by total monthly cost per merchant

**What it looks like now:**
- The Leaks page shows one card per merchant with the merchant name as the headline and a cost breakdown beneath it

---

## Merchant Normalization — DoorDash & Amazon Variants

Even after the merchant-first overhaul, DoorDash and Amazon transactions were still splitting into multiple entries because different charges appeared with different abbreviations in bank statements.

**What changed:**
- DoorDash: charges appearing as "DD *", "Dd*", "DOORDASH", and similar variants are now grouped under a single "DoorDash" entry
- Amazon: charges appearing as "AMZN", "AMAZON.COM", "AMZN MKTP", and other variants are grouped under "Amazon"
- The same normalization applies to recurring charge detection, so variants are counted as one merchant

**What it looks like now:**
- DoorDash and Amazon each appear as a single entry on the Leaks page and in recurring charge detection, with all variants counted together
