# PocketPulse - Small Business Cashflow Analysis

## Overview
Full-stack web application for small-business cashflow analysis with CSV transaction imports, automatic classification, and expense leak detection.

## Architecture
- **Frontend**: React + TypeScript with Tailwind CSS, shadcn/ui components, wouter routing
- **Backend**: Node.js + Express with Passport.js auth (email/password)
- **Database**: PostgreSQL with Drizzle ORM
- **Font**: Plus Jakarta Sans

## Key Files

### Shared
- `shared/schema.ts` - Drizzle schema: users, accounts, uploads, transactions

### Server
- `server/index.ts` - Express app entry point
- `server/db.ts` - PostgreSQL connection pool + Drizzle instance
- `server/auth.ts` - Passport.js local strategy, session management, register/login/logout routes
- `server/routes.ts` - API routes (accounts, upload, transactions, cashflow, leaks, export)
- `server/storage.ts` - Database CRUD operations via Drizzle
- `server/csvParser.ts` - CSV parsing with auto-detection of columns
- `server/classifier.ts` - Rule-based transaction classification (merchant, class, recurrence)
- `server/cashflow.ts` - Cashflow summary calculation + leak detection algorithm

### Client
- `client/src/App.tsx` - Root component with auth-gated routing
- `client/src/hooks/use-auth.ts` - Auth hook (login, register, logout, session)
- `client/src/components/layout/AppLayout.tsx` - Sidebar navigation layout
- `client/src/pages/Dashboard.tsx` - KPI cards, safe-to-spend, cashflow summary
- `client/src/pages/Upload.tsx` - CSV drag-and-drop upload with account selection
- `client/src/pages/Ledger.tsx` - Transaction table with inline classification editing
- `client/src/pages/Leaks.tsx` - Recurring expense leak detection results
- `client/src/pages/Auth.tsx` - Login/Register forms

## API Routes
All prefixed with `/api`:
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Current user
- `GET /api/accounts` - List accounts
- `POST /api/accounts` - Create account
- `POST /api/upload` - Upload CSV (multipart form)
- `GET /api/uploads` - List uploads
- `GET /api/transactions` - List transactions (with optional filters)
- `PATCH /api/transactions/:id` - Update classification (never overwrites user corrections)
- `GET /api/cashflow` - Cashflow summary
- `GET /api/leaks` - Leak detection results
- `GET /api/export/summary` - CSV export of cashflow summary
- `GET /api/export/transactions` - CSV export of all transactions

## Classification System
1. **Rule-based**: Known merchant keywords, transfer/refund detection, recurring patterns
2. **AI-assisted flag**: Set for ambiguous transactions that weren't matched by rules
3. **User corrections**: Marked with `userCorrected=true`, never overwritten by re-classification
