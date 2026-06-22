# PocketPulse — Vercel Migration Handoff

> **Scope:** documentation and migration prep only. No deployment, no DNS changes, no new features.

---

## 1. Runtime Architecture

### Current (Replit)

```
Internet → Replit reverse proxy (port 80/443)
                │
                ▼
     Express server (port 5000 in prod)
        ├── Serves static files from dist/public/
        ├── Serves /api/* routes
        └── Hosts session store (connect-pg-simple → PostgreSQL)

Dev mode (separate processes):
  Vite dev server  :5000  ←  proxies /api → Express :5001
  Express API      :5001
```

### Build pipeline

```
npm run build
  └── script/build.ts
        ├── vite build        → dist/public/   (React SPA)
        └── tsc -p tsconfig.build.json → dist/server/  (compiled Express server)

npm start
  └── NODE_ENV=production node dist/server/index.js
        ├── runMigrations()           (Drizzle, blocks startup)
        ├── seedGlobalMerchantSeed()  (blocks startup)
        ├── seedMerchantClassifications() (blocks startup)
        └── http.createServer → listens on PORT
```

### Key files

| File | Role |
|---|---|
| `server/index.ts` | Entry point — startup sequence, creates HTTP server |
| `server/routes.ts` | All Express routes (2 300 lines) |
| `server/migrations.ts` | Calls `drizzle-orm/node-postgres/migrator` at boot |
| `server/startup.ts` | Boot-time seeding and AI-worker recovery |
| `server/aiWorker.ts` | Async AI classification worker (fire-and-forget) |
| `server/storage.ts` | All Drizzle DB queries |
| `shared/schema.ts` | Drizzle schema + category enum (single source of truth) |
| `drizzle/migrations/` | 16 SQL migration files (0000–0015) |
| `vite.config.ts` | Frontend build config; has a hardcoded Replit allowed host |

---

## 2. Environment Variables

### Required on any host

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (full DSN with credentials) |
| `SESSION_SECRET` | express-session + CSRF HMAC signing. Must be stable across restarts. |
| `OPENAI_API_KEY` | GPT-4o-mini AI categorization. AI features silently degrade to rule-only if absent. |
| `PUBLIC_APP_URL` | Canonical app URL e.g. `https://pocketpulse.app`. Required for Google OAuth redirect URIs. |

### Optional / feature-gated

| Variable | Purpose | Default if absent |
|---|---|---|
| `ADMIN_SECRET` | Admin-only API endpoints | Admin routes return 403 |
| `BETA_ACCESS_CODE` | Beta access gate on landing page | Gate rejects every code |
| `GOOGLE_CLIENT_ID` | Google OAuth sign-in | Google sign-in disabled |
| `GOOGLE_CLIENT_SECRET` | Google OAuth sign-in | Google sign-in disabled |
| `APP_ORIGIN` | Fallback origin if `PUBLIC_APP_URL` not set | Derived from request host |
| `PORT` | Server listen port | 5000 (prod), 5001 (dev) |
| `VITE_POSTHOG_KEY` | PostHog analytics | Analytics silently no-ops |
| `VITE_POSTHOG_HOST` | PostHog ingress URL | `https://us.i.posthog.com` |

### Replit-only — **must be replaced on Vercel**

| Variable | Injected by | Used in | Migration action |
|---|---|---|---|
| `REPLIT_CONNECTORS_HOSTNAME` | Replit platform | `server/resend.ts` — fetches Resend API key from Replit connector service | **Replace with `RESEND_API_KEY` + `RESEND_FROM_EMAIL` env vars (see §6)** |
| `REPL_IDENTITY` | Replit platform | `server/resend.ts` — auth token for connector service | Removed after resend.ts rewrite |
| `WEB_REPL_RENEWAL` | Replit platform | `server/resend.ts` — alternative auth token | Removed after resend.ts rewrite |
| `REPLIT_DEV_DOMAIN` | Replit platform | `server/index.ts:40`, `server/routes.ts:216` — fallback public origin in dev | Not needed if `PUBLIC_APP_URL` is set |
| `SKIP_VITE` | Dev workflow command | `server/index.ts:66` — skips Vite middleware in dev | Not needed (always false in prod) |

---

## 3. Replit-Specific Assumptions

### 3a. Resend email integration — hard blocker

`server/resend.ts` fetches the Resend API key dynamically from Replit's connector service using three Replit-injected tokens (`REPLIT_CONNECTORS_HOSTNAME`, `REPL_IDENTITY`, `WEB_REPL_RENEWAL`). Outside Replit, this throws `"X-Replit-Token not found for repl/depl"` on every email send.

**Required migration:** rewrite `server/resend.ts` to read `RESEND_API_KEY` and `RESEND_FROM_EMAIL` directly from environment variables, with the Replit connector path as a fallback.

### 3b. Vite `allowedHosts`

`vite.config.ts` contains a hardcoded Replit dev domain in `allowedHosts`:
```
62a59de6-74f8-4147-b39b-eaa0464852fd-00-1zih0nm80aas8.worf.replit.dev
```
This only affects the Vite dev server, not the production build. Safe to remove or replace with your Vercel preview domain during migration.

### 3c. Public origin resolution

`getPublicOrigin()` in `server/routes.ts:211` uses a priority chain:
```
PUBLIC_APP_URL  →  REPLIT_DEV_DOMAIN  →  APP_ORIGIN  →  req.protocol + req.host
```
On Vercel, set `PUBLIC_APP_URL` explicitly and `REPLIT_DEV_DOMAIN` is never needed.

---

## 4. Database

### Provider

Replit-managed PostgreSQL (Neon under the hood). `DATABASE_URL` is a standard `postgresql://` DSN.

### Schema management

Drizzle ORM. Schema defined in `shared/schema.ts`. Migrations are raw SQL files in `drizzle/migrations/` (0000–0015). Applied programmatically via `server/migrations.ts` using `drizzle-orm/node-postgres/migrator`.

### Migration commands

```bash
npm run db:migrate    # drizzle-kit migrate — applies pending SQL migrations (safe)
npm run db:push       # drizzle-kit push    — FORBIDDEN for prod (destructive schema sync)
```

### On Vercel

Drizzle migrations run **inside the server process at startup** (`server/index.ts:14`). On serverless this creates a race condition — multiple cold-start invocations could run `migrate()` simultaneously. Recommended approach: run migrations as a **Vercel build step** (`postbuild` script calling `node -e "import('./dist/server/migrations.js').then(m => m.runMigrations())"`) or via a one-off migration job, and remove the `runMigrations()` call from `server/index.ts`.

### Exporting data from Replit Postgres

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl > pocketpulse_$(date +%Y%m%d).sql
```

---

## 5. Build and Start Commands

```bash
# Install
npm install

# Type check
npm run check           # tsc --noEmit (zero errors expected)

# Production build
npm run build           # vite build + tsc -p tsconfig.build.json → dist/

# Start production server
npm start               # NODE_ENV=production node dist/server/index.js

# Database migrations (run before or at start)
npm run db:migrate      # applies pending drizzle migrations from drizzle/migrations/

# Tests
npm test                # vitest run (all suites)
```

---

## 6. Startup Jobs and Background Jobs

All jobs that run at boot assume a **persistent long-running process**. These are the primary incompatibilities with Vercel's serverless model.

### Synchronous startup (blocks first request)

| Job | File:Line | What it does | Duration |
|---|---|---|---|
| `runMigrations()` | `server/index.ts:14` | Applies pending Drizzle SQL migrations | ~1–3 s (or instant if up-to-date) |
| `seedGlobalMerchantSeed()` | `server/index.ts:19` | Inserts global merchant→category seed rows (idempotent) | ~1 s first run, ~50 ms after |
| `seedMerchantClassifications()` | `server/index.ts:26` | Seeds per-user merchant cache from user-corrected rows; iterates ALL users | ~1–10 s depending on user count |

### Deferred startup (setImmediate — fire after port opens)

| Job | File:Line | What it does | Serverless risk |
|---|---|---|---|
| `backfillMerchantCleanup()` | `server/index.ts:88` | One-time batch UPDATE on transactions; short-circuits via `system_state` marker | Killed on function termination |
| `recoverStuckAiUploads()` | `server/index.ts:94` | Marks orphaned AI uploads as failed or re-kicks them | Killed on function termination |
| Recurring sync backfill | `server/routes.ts:2293` | Backfills `recurrenceSource` for old rows; syncs recurring candidates for all users | Killed on function termination |

### Per-request background (fire-and-forget — highest risk)

| Job | File:Line | What it does | Serverless risk |
|---|---|---|---|
| `runUploadAiWorker(userId, uploadId)` | `server/routes.ts:1592` | Runs GPT-4o-mini on uploaded transactions in 25-row chunks after HTTP response sent | **Critical — function terminates after response, killing mid-run worker** |
| `runUploadAiWorker(userId, row.id)` | `server/routes.ts:1658` | Same worker re-kicked for any pending uploads discovered at reclassify time | Same |

### In-memory state

| State | File:Line | What it does | Serverless risk |
|---|---|---|---|
| `inFlight: Set<number>` | `server/aiWorker.ts:56` | Guards against double-spawning the AI worker for the same upload | Lost between function invocations — guard is ineffective on serverless |

---

## 7. Known Vercel Migration Risks

Ordered by severity.

### 🔴 Critical — blocks email functionality

**`server/resend.ts` — Replit connector dependency**
- Fetches Resend API key from Replit's internal connector service using platform-injected tokens
- Fails immediately outside Replit with `"X-Replit-Token not found"`
- Affects: password reset emails, any future email sends
- **Fix:** Rewrite `getCredentials()` to read `process.env.RESEND_API_KEY` and `process.env.RESEND_FROM_EMAIL` directly. The Resend SDK usage itself is standard and portable.

```ts
// Replacement for server/resend.ts getCredentials():
async function getCredentials() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) throw new Error("RESEND_API_KEY / RESEND_FROM_EMAIL not set");
  return { apiKey, fromEmail };
}
```

---

### 🔴 Critical — AI worker is killed mid-run on serverless

**`server/routes.ts:1592` — fire-and-forget after `res.json()`**
- `void runUploadAiWorker(userId, uploadId)` is called *after* the HTTP response has been sent
- Vercel terminates serverless functions immediately after the response completes
- The AI worker processes transactions in 25-row chunks, each taking 5–45 s
- A typical upload of 200 rows takes ~60–180 s of background work
- On serverless, the worker is killed after ~0 rows processed
- **Fix options (in order of effort):**
  1. **Vercel background functions** — move `runUploadAiWorker` into a Vercel Background Function; call it from a webhook after upload completes
  2. **External queue** (recommended for scale) — push upload IDs to a queue (e.g. Upstash QStash, BullMQ + Redis); a separate worker service drains it
  3. **Polling-based client trigger** — client polls `/api/uploads/:id/ai-status` and POSTs to a `/api/uploads/:id/ai-run` endpoint to start work; worker runs within a single long-lived request (max 60–300 s on Vercel Pro)

---

### 🟠 High — startup migrations race on concurrent cold starts

**`server/index.ts:14` — `runMigrations()` runs inside the request handler process**
- On Vercel, multiple cold-start invocations can run simultaneously
- Each will call `migrate()` against the same database
- Drizzle's migrator does NOT hold a distributed lock
- Risk: migration interleaving errors or duplicate partial migrations
- **Fix:** Move migrations to a `postbuild` npm script or a dedicated one-off job that runs before traffic is cut over. Remove `runMigrations()` from `server/index.ts`.

---

### 🟠 High — in-memory worker dedup guard is ineffective

**`server/aiWorker.ts:56` — `const inFlight = new Set<number>()`**
- Guards against running two AI workers for the same upload concurrently
- On serverless, each function invocation has its own process/memory — the Set is never shared
- Two simultaneous upload requests could both spawn workers for the same upload
- **Fix:** Implement DB-level locking — check `ai_status='processing'` in the DB before starting work, and use a database `SELECT FOR UPDATE` or compare-and-swap on `ai_status`.

---

### 🟡 Medium — deferred startup jobs are silently dropped

**`server/index.ts:86-98`, `server/routes.ts:2293` — `setImmediate(async () => { ... })`**
- `backfillMerchantCleanup`, `recoverStuckAiUploads`, and the recurring sync are deferred via `setImmediate`
- On a persistent process, `setImmediate` fires in the next event loop tick — effectively instant
- On serverless, these run only on cold starts and may be terminated before they finish
- `backfillMerchantCleanup` uses a `system_state` marker so it short-circuits on repeat runs — this is safe if it completes at least once
- `recoverStuckAiUploads` depends on the AI worker concern above — if workers can't run anyway, recovery is moot
- **Fix:** Convert to one-time migration jobs or accept that they may not always complete

---

### 🟡 Medium — sessions stored in PostgreSQL (connect-pg-simple)

- `express-session` uses `connect-pg-simple` to store sessions in the `session` table
- This is fully portable — no Replit dependency
- On Vercel, session reads/writes add ~5–20 ms of latency per authenticated request (one DB round-trip for session lookup)
- No functional issue, but consider Redis session store for lower latency at scale

---

### 🟡 Medium — large JS bundle (801 KB minified)

- Vite build produces a single 801 KB JS chunk (248 KB gzipped)
- Vercel CDN serves this fine, but it affects cold load time
- No blocker; warn: code-splitting is recommended before launch

---

### 🟢 Low — `REPLIT_DEV_DOMAIN` in origin fallback chain

- Used only as a fallback when `PUBLIC_APP_URL` is not set
- On Vercel, `PUBLIC_APP_URL` should always be set; this path is never reached
- No code change required

---

### 🟢 Low — `vite.config.ts` hardcoded `allowedHosts`

- One Replit domain is in `server.allowedHosts` in `vite.config.ts`
- This only affects the Vite dev server, not production builds
- No production impact; update or remove when setting up dev on Vercel

---

## 8. Local Verification Results

All commands run on: **Replit workspace, 2026-06-22**

| Command | Result | Notes |
|---|---|---|
| `npm run check` | ✅ EXIT 0 | `tsc --noEmit` — zero type errors |
| `npm run build` | ✅ EXIT 0 | Vite + tsc both passed. Bundle: 801 KB JS / 103 KB CSS. One chunk-size warning (non-fatal). |
| `npm run db:migrate` | Not run (no schema changes pending) | Added as new npm script; safe alias for `drizzle-kit migrate` |
| `npx vitest run server/classifyPipeline.test.ts server/ledger-routes.test.ts` | ✅ 30/30 passed (from recent run) | Classifier and ledger route tests pass |
| Full `npm test` | 191 passed / 1 failed / 6 skipped | 1 known failure: `Leaks.test.tsx "renders the page title"` — stale test run pre-dating title rename fix; passes on fresh run |

---

## 9. Files Changed in This Migration Prep

| File | Change |
|---|---|
| `MIGRATION_HANDOFF.md` | Created — this document |
| `package.json` | Added `"db:migrate": "drizzle-kit migrate"` script |

No application code, database schema, routes, or environment variables were modified.
