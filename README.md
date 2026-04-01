# PocketPulse

Small-business cashflow analysis web application (Phase 1: auth and account setup).

## Stack

TypeScript, Node.js, Express, React, Vite, Wouter, TanStack Query, PostgreSQL, Drizzle ORM, express-session, connect-pg-simple, bcrypt, Vitest.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `SESSION_SECRET`, and `APP_ORIGIN`.
2. `npm install`
3. `npm run db:push` — requires a `drizzle.config.ts` and schema (added in later Phase 1 tasks).

## Scripts

| Script    | Description                                      |
| --------- | ------------------------------------------------ |
| `npm run dev` | Vite dev server on `http://localhost:5000`; `/api` requests proxy to `http://localhost:5001` by default |
| `npm run build` | Production client bundle → `dist/public`; compiled server → `dist/server` |
| `npm run start` | Production: compiled Express from `dist/server/index.js` serves `/api` + static SPA (`dist/public`) |
| `npm run check` | Typecheck with `tsc --noEmit`                    |
| `npm test`    | Run Vitest                                       |
| `npm run db:push` | Push Drizzle schema (after config exists)    |

### Production `npm start`

After `npm run build`, `npm start` runs Express with the API and the Vite production bundle from `dist/public` on one server. Default listen port is `5000` (`PORT`).

## Ports

- Vite dev server (`npm run dev`): `5000` (`vite.config.ts`); override Vite’s proxy target with `API_PORT` if the API is not on `5001`.
- Express API (development): `5001` by default (`API_PORT`); this process also attaches Vite middleware so you can open the app on `5001` without running Vite separately.
- Express (production): `5000` by default (`PORT`).

## Local development

Typical split (browser always hits Vite first):

1. Start the API + Vite-middleware server: `API_PORT=5001 tsx server/index.ts` (listens on `5001`).
2. Start the Vite dev server: `npm run dev` (listens on `5000`, proxies `/api` to `http://localhost:5001`).

Open `http://localhost:5000` for HMR; session cookies are set for `localhost` across the proxy. You can also open `http://localhost:5001` to use the same Express+Vite stack without the proxy.
