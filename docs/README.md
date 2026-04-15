# PocketPulse — Project Documentation

PocketPulse is a private web application that lets a small-business owner upload bank statement files, automatically sort every charge into a spending category, spot recurring and subscription costs, and see a live dashboard of safe-to-spend money.

---

## What's in This Folder

| File | What It Covers |
|------|----------------|
| [01-upload-import.md](01-upload-import.md) | How bank statement files are uploaded, read, and checked for duplicates |
| [02-ledger.md](02-ledger.md) | Reviewing, editing, and exporting the transaction list |
| [03-insights.md](03-insights.md) | Recurring charges, leak detection, and the spending dashboard |
| [04-foundation.md](04-foundation.md) | Login, app structure, and the core technology underneath |

---

## All Completed Work — Quick Reference

### Data Import & Upload

| Topic | Summary |
|-------|---------|
| CSV Upload Pipeline | Upload one or many bank statement files, assign them to an account, and import all rows in one step |
| Bank of America Format Fixes | Fixed two separate parsing failures specific to Bank of America exports — summary blocks and special characters in descriptions |
| Inline Account Creation | Added the ability to create a new account directly on the upload page instead of navigating away |
| Upload Deduplication | Re-uploading the same file no longer creates duplicate entries; already-seen rows are silently skipped |
| AI Format Detection | When the app doesn't recognize a file's layout, it uses AI to identify which column is the date, amount, and description |
| Skip Count Messaging | The upload summary now shows two separate counts: rows already in your ledger vs. duplicate rows within the same file |

### Ledger & Transaction Review

| Topic | Summary |
|-------|---------|
| Ledger Table | A searchable, filterable, paginated list of every imported transaction |
| Inline Editing | Change a transaction's category, business/personal class, or recurring flag directly in the row |
| CSV Export | Download the current filtered view of your ledger as a spreadsheet |
| Category Propagation | Fix one transaction's category and offer to apply the same fix to all rows from the same merchant |
| Fuzzy Merchant Matching | Propagation now catches slight name variations of the same merchant (e.g. "AMZN" and "AMAZON") |
| Persist Edit Rules | A manual category fix is saved so future uploads of the same merchant are correct from the start |
| UX Quick Wins | Four beta-test quality-of-life improvements: empty states, clearer labels, filter persistence, layout polish |
| Propagation Toast | The "changes applied" confirmation moved from inline text to a floating corner notification |

### Spending Insights

| Topic | Summary |
|-------|---------|
| Recurring Charge Detection | Automatically identifies charges that appear on a regular schedule |
| Safe-to-Spend Dashboard | A hero card showing estimated spendable money, supported by KPI tiles for income, recurring costs, and discretionary spending |
| KPI Card Subtitles | Reworded the small descriptive labels on each dashboard tile to be clearer and less ambiguous |
| Import History | The upload page now shows a log of every previous import with row counts and timestamps |
| Account Selector Fix | Fixed a bug where the account picker on the upload page wouldn't close after making a selection |
| Leak Detection (v1) | First version: flags high-frequency micro-charges and repeat discretionary spending |
| Leak Detection Overhaul | Rebuilt the detection engine to group suspected leaks by merchant, giving more accurate results |
| Merchant Normalization | DoorDash and Amazon purchases now group correctly regardless of how the bank abbreviates them |

### App Foundation

| Topic | Summary |
|-------|---------|
| Authentication | Secure login and logout with encrypted passwords; all pages are protected until you sign in |
| First-Account Gate | New users are guided to name their first account before any data entry is possible |
| Data Storage | Core record-keeping for transactions, uploaded files, accounts, and recurring charge reviews |
| CSV Parsing Engine | The rules-based system that reads raw bank file rows and assigns categories |
| AI Categorization | An optional AI pass that classifies transactions the rules engine couldn't confidently categorize |
| Wipe & Reset Controls | Options to clear all transactions or the entire workspace when starting fresh |
| Design System | Consistent glass-card visual style with a fixed sidebar and smooth page transitions |
