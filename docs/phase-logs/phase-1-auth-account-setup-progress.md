# Phase 1 — branch progress log

**Branch:** `feature/phase-1-auth-account-setup`

**Last updated:** 2026-04-01

## Checkpoint (Tasks 1–4)

| Task | Status (this branch) |
|------|----------------------|
| **1** — Tooling & foundation | `package.json` scripts (`dev`, `build`, `start`, `check`, `test`, `db:push`), TypeScript/Vite/Vitest baseline, `script/build.ts`, `.env.example`, `README`, failing→passing `server/project-config.test.ts`. |
| **2** — Schema & DB/session | `shared/schema.ts` (users, accounts, user_preferences, session table), `drizzle.config.ts`, `server/db.ts` with pool + `ensureUserPreferences`, `connect-pg-simple` session store wiring, `server/schema.test.ts`. |
| **3** — Auth & storage | `server/auth.ts` (bcrypt hash/verify), `server/storage.ts` (user/account CRUD, duplicate-email handling), `server/auth.test.ts`. |
| **4** — HTTP API & server shell | `server/routes.ts` (`createApp`, session middleware, auth guards): register/login/logout, `GET /api/auth/me`, account list/create + onboarding-aware behavior, `GET /api/health`; `server/index.ts` (dev Vite / prod static); `server/vite.ts`, `server/static.ts`; `server/routes.test.ts` (supertest + `MemoryStore`). |

## Checkpoint (Tasks 5–8) — stable

**Tasks 5, 6, 7, and 8 are complete** on this branch.

- **Client shell (Task 5):** TanStack Query provider, `wouter` route shell, test setup (`client/src/test/setup.ts`, `App.test.tsx`), shared `queryClient` / utilities as implemented in the branch.
- **Auth hook & signed-out gating (Task 6):** `client/src/hooks/use-auth.ts` wired to `/api/auth/me` and auth mutations; `client/src/pages/Auth.tsx` for login/register; `App.tsx` routes signed-out users to auth and gates the rest accordingly.
- **Account setup gating & first account (Task 7):** Authenticated users with no accounts are steered through setup (create first account / onboarding path) instead of the main app; first-account creation is coordinated with the existing account API so the client lands in a valid post-setup state.
- **Accounts cache:** Query cache for accounts is **user-scoped** (invalidated / keyed per authenticated user) so switching users or sessions does not show another user’s account list.
- **Protected layout & post-setup routes (Task 8):** Authenticated shell after setup includes a protected layout (nav/shell) and placeholder routes for the main app areas so navigation structure is in place before real feature pages land.

**Logout:** Still a **placeholder** in the UI — full wiring to the session API / cache invalidation is **Task 9**.

**Suitable for a GitHub checkpoint push** — through Task 8; protected shell and placeholder routes align with the plan; push before deeper Task 9 work if you want a remote milestone.

## Development ports

- **Vite (client dev server):** port **5000** (`vite.config.ts`, `strictPort: true`).
- **Express API:** port **5001** in development via `API_PORT` default in `server/index.ts`; Vite proxies `/api` to that target.

## Git

A **local checkpoint commit** exists on this branch (e.g. foundation/auth work captured in history). **Push to GitHub at stable checkpoints** rather than every micro-edit; align pushes with plan task boundaries when practical.

## Next steps (Task 9)

Per Phase 1 plan (see repo `docs/superpowers/plans/2026-04-01-phase-1-auth-account-setup.md` where present):

- **Task 9 — verification:** Exercise protected-route behavior end-to-end, confirm redirects and post-setup entry, and **wire logout** (API + client state / query cache) replacing the placeholder.
