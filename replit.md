# PocketPulse

Small-business cashflow analysis web application. Single-owner microbusiness workflow: upload CSV bank statements from multiple accounts, categorize transactions, identify recurring expense leaks, and view safe-to-spend dashboard insights.

## GitHub
https://github.com/fighterz8/pocketpulse-v1

## Architecture
- **Frontend**: React + Vite on port 5000 (webview port)
- **Backend**: Express + tsx on port 5001 (`PORT=5001 SKIP_VITE=1 npx tsx server/index.ts`)
- **Database**: PostgreSQL via `DATABASE_URL`; Drizzle ORM; schema in `shared/schema.ts`
- **Auth**: express-session + bcrypt; single-owner workspace
- **Styling**: Tailwind CSS v3 + existing plain CSS (coexist via `preflight: false`); config at `tailwind.config.cjs` + `postcss.config.cjs`

## Port Layout
- Vite dev server: 5000 (proxies `/api` to 5001)
- Express API: 5001

## Category System (V1_CATEGORIES — 21 categories)
income, transfers, housing, utilities, groceries, dining, coffee, delivery, convenience, gas, parking, travel, auto, fitness, medical, insurance, shopping, entertainment, software, fees, other

## Key Files
- `shared/schema.ts` — DB schema, V1_CATEGORIES, AUTO_ESSENTIAL_CATEGORIES (single source of truth), Zod insert schemas
- `server/classifier.ts` — 13-pass rules-based classifier; Pass 6 uses word-boundary COMPILED_RULES; Pass 9b uses amount-range signals
- `server/ai-classifier.ts` — GPT-4o-mini batch classifier
- `server/reclassify.ts` — Two-phase rules+AI pipeline (skips user-corrected)
- `server/routes.ts` — All API routes; syncRecurringCandidates() auto-called after upload
- `server/storage.ts` — Drizzle DB queries
- `server/transactionUtils.ts` — getDirectionHint() direction detection; STRONG_OUTFLOW_HINT_PATTERNS (checkcard, ach pmt, bill pmt, etc.)
- `server/recurrenceDetector.ts` — Recurring charge detector; candidateKey = merchantKey (bucketIndex only for secondary tiers); isSubscriptionLike signal
- `server/dashboardQueries.ts` — recurringExpenses from detector's active candidate monthlyEquivalent; leakMonthlyAmount from confirmed-leak candidate monthlyEquivalent
- `client/src/pages/Ledger.tsx` — Ledger with inline editing, AI progress bar, Export CSV
- `client/src/pages/Dashboard.tsx` — Safe-to-spend hero, 30D/60D/90D period selector, recurring/one-time/discretionary KPIs, expense leaks card
- `client/src/pages/Leaks.tsx` — Subscription Leaks page; split into Digital Subscriptions / Recurring Habits sections
- `client/src/hooks/use-recurring.ts` — RecurringCandidate type (includes isSubscriptionLike)
- `server/index.ts` — Startup migration: strips old |amount.toFixed(2) candidateKey suffix from DB
- `scripts/accuracy-report.ts` — Dev/research CLI; runs accuracy metrics without manual review (`npx tsx scripts/accuracy-report.ts [--user-id=N] [--json]`)

## Features Implemented
- User authentication (login/logout, session)
- Multi-file CSV upload with account labeling
- Transaction normalization and unified ledger
- Rules-based + AI categorization (21 categories)
- Inline category/class/recurrence editing in ledger
- Filter/search ledger (account, category, class, recurrence, date, excluded)
- **Export CSV**: `GET /api/transactions/export` — exports current filter view
- AI re-categorization button with animated progress bar
- Recurring charge detection and leak review
- Safe-to-spend dashboard with date range selection
- Wipe/reset workspace actions

## UI Design System (Glass Dashboard)
- **Theme**: Light blue gradient background, glass-style white cards, fixed left sidebar
- **Glass Card**: `.glass-card` utility class — white/semi-transparent bg, border, box-shadow, backdrop-filter
- **Sidebar**: PocketPulse wordmark + SVG pulse-line icon (blue gradient ECG trace), 3 nav links (Dashboard, Ledger, Upload), active item solid blue (#2563eb)
- **Animations**: Framer Motion fade-in + slide-up (`motion.div` with fadeUp variants, staggered by index)
- **Dashboard**: Safe-to-Spend hero card (2/3 wide), Expense Leaks card (1/3), 4 KPI row, 3 KPI row, category + trend cards, recent transactions, tech-stack footer
- **KPI Cards**: `.kpi-label`, `.kpi-value`, `.kpi-sub` — uppercase label, bold value, sub text
- **All pages** (Ledger, Leaks, Upload) use the same glass card system for consistency

## CSRF Rule
All non-GET API calls MUST use `apiFetch` from `client/src/lib/api.ts`

## Spec Alignment (PDF milestone doc)
- AU: Authentication ✅
- UP: Upload and Import ✅
- LD: Ledger and Transaction Review ✅
- RL: Recurring Leak Review ✅
- DB: Dashboard and Reporting ✅
- EX: CSV Export ✅ (filtered ledger export, not raw upload files)
- AI categorization: optional future enhancement per spec, implemented as bonus feature
