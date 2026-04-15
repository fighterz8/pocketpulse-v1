# App Foundation

This section covers the core infrastructure that every other feature is built on — login, data storage, the categorization engine, and the overall visual design.

---

## Authentication

Secures the app so that only the owner can access their financial data.

**What changed:**
- A login page was built with username and password fields
- Passwords are stored in encrypted form — the actual password is never saved in plain text
- All pages are protected: navigating to any page while logged out redirects to the login screen
- A logout button clears the session immediately

**What it looks like now:**
- Visiting the app goes directly to a login screen; after signing in, you have access to all pages until you log out or the session expires

---

## First-Account Onboarding Gate

New users had no account to assign transactions to, which caused errors when they tried to upload files.

**What changed:**
- On first login, users are shown a guided prompt to name their first account (e.g. "Chase Checking") before accessing any other part of the app
- The prompt explains why an account is needed and keeps the process simple — just a name field and a confirm button
- Once the first account exists, the prompt never appears again

**What it looks like now:**
- Brand-new users are walked through account creation in one step immediately after login; returning users go straight to the dashboard

---

## Data Storage

The underlying record-keeping system that keeps your transactions, uploads, and settings safe across sessions.

**What changed:**
- Separate record sets were set up for accounts, uploaded files, individual transactions, recurring charge reviews, and saved format layouts for recognized banks
- All records are tied to the logged-in owner so nothing is mixed between users
- The storage layout was designed to support filtering, duplicate detection, and recurring pattern analysis efficiently

**What it looks like now:**
- All your data persists between sessions — closing the browser and coming back shows everything exactly as you left it

---

## CSV Reading & Categorization Engine

The rules-based system that reads raw bank statement rows and turns them into organized transactions.

**What changed:**
- A reader was built that processes each row of a bank file and extracts the date, amount, and merchant name
- Amount direction detection was added to correctly determine whether a number represents money in or money out based on the column names in the file
- Merchant names are cleaned up by stripping bank-added codes, payment prefixes, and reference numbers
- A 13-pass categorization system assigns each transaction to one of 21 categories based on the merchant name and amount

**What it looks like now:**
- Imported transactions have clean merchant names and categories automatically filled in, with no manual work required for recognized merchants

---

## AI Categorization

An optional second pass that classifies transactions the rules engine wasn't confident about.

**What changed:**
- After the rules engine runs, any uncategorized transactions are batched and sent to an AI service
- The AI receives the merchant name, amount, and description, and returns a suggested category
- Only uncategorized transactions are sent — already-categorized rows are never re-processed unless you click the Re-categorize button
- A progress indicator on the Ledger page shows the AI pass completing in real time

**What it looks like now:**
- Unusual or uncommon merchants that the rules engine doesn't recognize are still categorized, often correctly
- The "Re-categorize with AI" button on the Ledger page lets you trigger a fresh pass at any time

---

## Wipe Data & Reset Controls

Allows you to clear your data and start over without deleting the whole account.

**What changed:**
- A "Wipe transactions" action was added that removes all imported transaction data while keeping accounts and settings
- A "Reset workspace" action removes everything — transactions, accounts, and all settings — returning the app to a blank state
- Both actions require a confirmation step before anything is deleted

**What it looks like now:**
- Both options are available in the app settings area; the upload results page notes that the "previously imported" skip count resets after a wipe

---

## Design System

The visual language used consistently across every page of the app.

**What changed:**
- A glass-card style was established: white semi-transparent cards with a soft shadow on a light blue gradient background
- A fixed left sidebar was built with the PocketPulse wordmark, an ECG-style pulse icon, and navigation links
- Animated page transitions were added using smooth fade-in and slide-up effects
- A consistent tile style was defined — bold headline number, small uppercase label, subdued supporting text

**What it looks like now:**
- Every page uses the same card and spacing system, with smooth transitions between them, giving the app a consistent and polished look throughout
