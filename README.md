# PocketPulse

Cashflow analysis for small businesses. Import your bank statements, automatically classify transactions, spot recurring charges, and get a clear picture of where your money is going.

> **Beta** — the core feature set is complete and stable. We're actively gathering feedback before general availability.

---

## Features

**Dashboard**
KPI cards for total income, spending, and net cashflow. Category breakdown, monthly trend table, and a recent-transactions feed. Transactions excluded from analysis are filtered out automatically.

**CSV Import**
Drag-and-drop upload for bank statement exports. Auto-detects column layouts (single-amount and split debit/credit formats, common date formats, quoted fields, currency amounts). Falls back to AI-assisted format detection for non-standard exports. Supports multiple files per import, each mapped to a specific account.

**Transaction Ledger**
Full transaction table with debounced search, filter dropdowns (account, category, class, recurrence, exclusion, date range), and pagination. Click any row to edit fields inline — date, merchant, amount, category, class, recurrence, and exclusion status. User edits are flagged and preserved across automatic re-classification runs. Export the current filtered view to CSV.

**Automatic Classification**
Rules-based keyword classifier covering 21 spending categories with transaction class detection (income, expense, transfer, refund) and recurrence hints. Unrecognized transactions fall back to GPT-4o-mini classification. The classifier runs silently on dashboard load and corrects any rows that have drifted from the current ruleset — leaving user-edited rows untouched.

**Recurring Leak Review**
Detects recurring outflows by grouping on normalized merchant name and amount bucket (25% tolerance), then scoring by interval regularity, amount consistency, transaction count, and recency. Review detected patterns as Essential, Leak, or Dismissed. Review decisions persist and survive re-uploads.

**Account Management**
Multiple accounts per user. Onboarding wizard creates the first account immediately after registration. Accounts can be labelled and used to scope uploads and ledger views.

**Data Management**
Wipe imported transactions without touching account setup, or do a full workspace reset — both gated behind a two-click confirmation. CSV export respects the active filter state.

---

## Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS, Framer Motion |
| Backend | Node.js, Express 5, TypeScript |
| Database | PostgreSQL, Drizzle ORM |
| Auth | bcrypt, express-session, connect-pg-simple |
| Security | Helmet, CSRF (double-submit cookie), express-rate-limit |
| AI | OpenAI GPT-4o-mini (CSV format detection + classification fallback — optional) |
| Testing | Vitest, @testing-library/react, supertest |

---

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL database

### Environment

```
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random string used to sign session cookies |
| `APP_ORIGIN` | Browser origin, e.g. `http://localhost:5000` |

Optional:

| Variable | Description |
|---|---|
| `PORT` | Server port (default `5000`) |
| `OPENAI_API_KEY` | Enables AI-assisted CSV detection and classification fallback |

### Install and run

```bash
npm install
npm run db:push   # apply schema to the database
npm run dev       # development server on localhost:5000
```

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Development server — Express + Vite on `PORT` (default `5000`) |
| `npm run build` | Production build — compiles server TypeScript and bundles client |
| `npm run start` | Production server — compiled Express serves API and static SPA |
| `npm run check` | TypeScript type check (`tsc --noEmit`) |
| `npm test` | Run Vitest test suite |
| `npm run db:push` | Push Drizzle schema to the database |

---

## API

All endpoints require an authenticated session except `POST /api/register`, `POST /api/login`, and `GET /api/csrf-token`. Mutating requests require a valid `X-CSRF-Token` header.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/register` | Create account |
| `POST` | `/api/login` | Authenticate |
| `POST` | `/api/logout` | End session |
| `GET` | `/api/me` | Current user and accounts |
| `GET` | `/api/accounts` | List accounts |
| `POST` | `/api/accounts` | Create account |
| `GET` | `/api/csrf-token` | Fetch CSRF token |
| `POST` | `/api/upload` | Import CSV files (multipart) |
| `GET` | `/api/uploads` | Upload history |
| `GET` | `/api/transactions` | Paginated transactions with filters |
| `PATCH` | `/api/transactions/:id` | Edit a transaction |
| `DELETE` | `/api/transactions` | Wipe all transactions |
| `GET` | `/api/export/transactions` | CSV export (respects active filters) |
| `DELETE` | `/api/workspace-data` | Full workspace reset |
| `GET` | `/api/dashboard-summary` | KPIs, category breakdown, monthly trend |
| `GET` | `/api/recurring-candidates` | Detected recurring expenses with review state |
| `PATCH` | `/api/recurring-reviews/:candidateKey` | Mark a recurring pattern |
| `GET` | `/api/recurring-reviews` | List all recurring reviews |

---

## Project structure

```
├── client/src/
│   ├── pages/          # Dashboard, Upload, Ledger, Leaks, Auth, AccountSetup
│   ├── components/     # Layout, shared UI
│   ├── hooks/          # TanStack Query wrappers for every data domain
│   └── lib/            # API client, query config, utilities
├── server/
│   ├── routes.ts       # All API route handlers
│   ├── storage.ts      # Database access layer
│   ├── csvParser.ts    # Bank statement CSV parser
│   ├── classifier.ts   # Rules-based transaction classifier
│   ├── ai-classifier.ts        # GPT-4o-mini fallback classifier
│   ├── recurrenceDetector.ts   # Recurring expense detection engine
│   ├── dashboardQueries.ts     # Dashboard aggregation queries
│   └── reclassify.ts           # Silent re-classification on dashboard load
├── shared/
│   └── schema.ts       # Drizzle table definitions and shared types
└── drizzle/            # Database migrations
```

---

## Security

- Passwords hashed with bcrypt (cost factor 12)
- Sessions stored server-side in PostgreSQL; cookie is `httpOnly` and `secure` in production
- Double-submit CSRF tokens required on all mutating requests
- Rate limiting on auth and upload endpoints
- HTTP security headers via Helmet
- `userId` guard on every database write — users can only touch their own data
