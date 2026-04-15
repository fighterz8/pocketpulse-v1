# Data Import & Upload

This section covers everything related to getting your bank statement files into PocketPulse — from the initial upload flow to how the app handles unusual file formats and prevents duplicate data.

---

## CSV Upload Pipeline

The core feature that lets you bring real bank data into the app for the first time.

**What changed:**
- A multi-file upload screen was built where you pick one or more bank statement files and assign each to a named account
- A reading engine processes each file row by row, extracts the date, amount, and merchant name, and saves every transaction
- An import summary appears after each upload showing how many transactions were added

**What it looks like now:**
- The Upload page lets you select files, choose or create an account, and click Import
- After importing, a results card shows how many rows were added successfully

---

## Bank of America: Zelle & Description Parsing Fix

Bank of America statement files sometimes include Zelle payment descriptions with commas inside them, which confused the reader into thinking a single cell was two separate columns.

**What changed:**
- The file reader now correctly handles descriptions that contain commas by respecting the file's quoting rules
- Zelle transactions no longer cause the entire row to be silently dropped or misread

**What it looks like now:**
- Zelle payments from Bank of America files import correctly with the full merchant description intact

---

## Bank of America: Summary Block & Special Character Fix

Bank of America exports sometimes include a short summary section at the top — account number, date range, opening and closing balance — before the actual transaction rows begin. They also occasionally include special characters inside descriptions without handling them properly.

**What changed:**
- The reader now detects and skips the summary header block before looking for transaction rows
- It also handles unusual characters inside description fields without crashing

**What it looks like now:**
- Bank of America files with summary blocks or unusual description formatting import cleanly without errors

---

## Inline Account Creation

Previously, importing a file into a new account required leaving the upload page, creating the account elsewhere, then coming back.

**What changed:**
- A "Create new account" option was added directly in the account selector on the upload page
- You type the new account name, confirm it, and the account is created immediately
- The file is then queued to that new account without any page navigation

**What it looks like now:**
- The account dropdown on the upload page includes a "+ New account" option that opens a small inline form

---

## Incremental Upload Deduplication

Early versions of the app created duplicate entries if you uploaded the same file twice, or if two exports from different dates shared some of the same rows.

**What changed:**
- Every transaction row is fingerprinted based on its date, amount, and description
- Before saving, the app checks whether a matching fingerprint already exists in your ledger for that account
- Rows already present are silently skipped — nothing is duplicated

**What it looks like now:**
- Re-uploading a file you've already imported produces zero new rows and shows a "previously imported" count
- You can safely re-import an updated export and only the genuinely new rows will be added

---

## AI-Powered CSV Format Detection

Some bank statement files use column layouts that the standard reader doesn't recognize, causing files to fail or import with data in the wrong fields.

**What changed:**
- When the app sees an unfamiliar layout, it asks an AI service to identify which column holds the date, amount, and description
- The detected layout is saved so future files from the same bank are recognized instantly
- The AI is only used when the layout is genuinely ambiguous — recognized formats go through the fast built-in reader
- Only column header names are shared with the AI, never the actual transaction values

**What it looks like now:**
- Files from unusual or unsupported banks now import correctly rather than failing
- First-time imports of an unknown format may take a moment longer; subsequent imports of the same format are instant

---

## Clearer Skip Count Messaging

The original import results showed a single "skipped rows" number, which lumped together two very different situations: rows already in your ledger from a previous import, and duplicate rows within the same file.

**What changed:**
- The import results now show two separate counts with distinct labels
- "Already in your ledger" covers rows that match something imported before
- "Duplicate rows in this file" covers rows that appeared more than once within the file just uploaded

**What it looks like now:**
- After every import, the results card shows both numbers separately so you know exactly why each row was skipped
