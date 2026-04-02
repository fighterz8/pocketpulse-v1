# PocketPulse

Small-business cashflow analysis web application (Phase 1: auth and account setup).

## Phase 1 status (this branch)

**Branch:** `feature/phase-1-auth-account-setup`

The following is **implemented** on this branch:

- **Backend:** Express app with `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET|POST /api/accounts`, and `GET /api/health`. Passwords hashed with bcrypt; sessions in PostgreSQL via `connect-pg-simple` and `express-session`.
- **Data:** Drizzle schema for users, accounts, user preferences, and the `session` store table; persistence through `server/storage.ts`.
- **Frontend:** React + Wouter + TanStack Query; `Auth` (login/register), `AccountSetup` (first account when the list is empty), and a protected `AppLayout` with placeholder routes: Dashboard (`/`), Upload (`/upload`), Ledger (`/transactions`), Leaks (`/leaks`), plus not-found handling.
- **Gating:** Signed-out users see auth only; authenticated users with zero accounts see account setup; users with at least one account see the protected shell. Logout clears the server session and client caches.

**Still deferred** (not Phase 1): CSV upload pipeline, transaction logic, leak persistence, dashboard metrics, and other items listed in the design doc §15.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `SESSION_SECRET`, and `APP_ORIGIN` (and `PORT` if needed).
2. `npm install`
3. `npm run db:push` — applies `shared/schema.ts` (including the `session` table) to your database.

## Manual verification

With PostgreSQL available and `npm run dev` running (default [http://localhost:5000](http://localhost:5000)):

1. **Register a new user** — On the auth screen, switch to “Create account”, fill email, password, display name (required), optional company name, submit. You should land in **Account setup** if this is the first account for that user.
2. **Invalid login** — Use “Sign in” with a wrong password or unknown email; expect an error such as “Invalid email or password” (no distinction between unknown user and bad password).
3. **Persistent session on refresh** — After a successful login or registration (and after completing setup if applicable), reload the page; you should remain authenticated and see the same gate result (setup vs shell), not the sign-in form.
4. **Zero-account user** — Register a new user (or use an account with no rows in `/api/accounts`); expect **Account setup** until at least one account is created.
5. **Protected shell after first account** — Complete first account creation; expect the sidebar shell and placeholder pages, not the auth form.
6. **Logout** — Use Logout in the shell; expect return to the auth view and no access to shell routes until you sign in again (refresh should stay signed out).

Automated checks: `npm test` and `npm run check`. Optional: `npm run build` for a production bundle sanity check.

## Stack

TypeScript, Node.js, Express, React, Vite, Wouter, TanStack Query, PostgreSQL, Drizzle ORM, express-session, connect-pg-simple, bcrypt, Vitest.

## Scripts

| Script    | Description                                      |
| --------- | ------------------------------------------------ |
| `npm run dev` | Development: Express on `PORT` (default `5000`) with Vite dev middleware — API and SPA on one server (Replit/Cursor preview) |
| `npm run dev:vite` | Optional split setup: standalone Vite on port 5000; `/api` proxies to `http://localhost:5001` by default (override with `API_PORT`) — run `PORT=5001 tsx server/index.ts` in another terminal |
| `npm run build` | Production client bundle → `dist/public`; compiled server → `dist/server` |
| `npm run start` | Production: compiled Express from `dist/server/index.js` serves `/api` + static SPA (`dist/public`) |
| `npm run check` | Typecheck with `tsc --noEmit`                    |
| `npm test`    | Run Vitest                                       |
| `npm run db:push` | Push Drizzle schema to the database          |

### Production `npm start`

After `npm run build`, `npm start` runs Express with the API and the Vite production bundle from `dist/public` on one server. Default listen port is `5000` (`PORT`).

## Ports

- **Default development** (`npm run dev`): one process on `PORT` (default `5000`); same-origin `/api` and Vite HMR.
- **Optional split** (`dev:vite` + `tsx server/index.ts`): Vite on `5000` (`vite.config.ts`); run the server with `PORT=5001` (or set `API_PORT` in the Vite proxy target to match).
- **Production**: `PORT` (default `5000`).

## Local development

**Default (one terminal):** `npm run dev` — open `http://localhost:5000`. No separate API process.

**Optional split** (e.g. debugging Vite in isolation): in one terminal, `PORT=5001 tsx server/index.ts`; in another, `npm run dev:vite`. Open `http://localhost:5000` for HMR; `/api` is proxied to the server on `5001`.

## Evidence and handoff

For capstone or audit evidence, capture screenshots and session notes as described in the Phase 1 design (§14). This README and `docs/phase-logs/phase-1-auth-account-setup-progress.md` record branch status and verification; design clarifications from implementation live in `docs/superpowers/specs/2026-04-01-phase-1-auth-account-setup-design.md` §17.
