# PocketPulse Phase 1 Design: Authentication and Account Setup

**Date:** 2026-04-01  
**Status:** Approved design baseline with Phase 1 implementation clarifications  
**Phase:** Phase 1  
**Primary Goal:** Establish the secure workspace foundation for PocketPulse through authentication, session handling, protected routing, and initial account setup.

## 1. Context
PocketPulse V1 is a single-owner financial review web application built around a review-first workflow: import transaction data, normalize it, review and correct it, review recurring findings, inspect dashboard summaries, and export reviewed results.

For Phase 1, the project intentionally narrows its implementation scope to authentication and account setup. This sequence provides the trust boundary and workspace structure that later upload, ledger, recurring review, and dashboard features depend on.

This design reconciles four inputs:
- `POCKETPULSE_REPO_MAP_V1_FRESH_START.md` as the source of truth for V1 scope
- `docs/requirements/pocketpulse-v1-requirements-verification-draft.md` as the current requirement wording baseline
- `Diagrams and mockups/ERD.png` as the starting point for the database structure
- `Diagrams and mockups/Dashboard.png`, `ledger.png`, and `recurring_leak.png` as the visual basis for the protected app shell

Where sources differ, this design treats the fresh-start V1 spec as the scope authority and this document as the Phase 1 implementation baseline. The project log currently summarizes the work in four broad phases for reporting simplicity, while the main V1 spec breaks delivery into five implementation phases. For implementation purposes, this document follows the V1 spec's Phase 1 objective while preserving the broader reporting language used in the phase log.

## 2. Phase 1 Scope
### In Scope
- fresh repository setup decisions required to start V1 implementation
- database connection baseline
- user registration for workspace bootstrap
- user login and logout
- session-based authentication
- protected route handling
- authenticated current-user lookup
- initial account setup after first authentication
- protected app shell with placeholder navigation for later phases
- minimum persistence for users, preferences, accounts, and sessions
- documentation updates needed to keep Phase 1 traceable
- branch and repository workflow confirmation for the fresh-start build

### Out of Scope
- CSV upload and import execution
- transaction parsing and normalization
- ledger editing and transaction review logic
- recurring leak detection and review actions
- dashboard calculations and reporting logic
- export generation
- analysis-only routes or screens
- AI-assisted labeling or explanation

## 3. Design Goals
- create a secure and reviewable application entry point
- ensure the user cannot reach later product workflows without first establishing an account context
- align visible navigation with the existing mockups so the prototype already resembles the final product
- keep the architecture simple enough to explain clearly in capstone documentation
- avoid introducing later-phase technical assumptions into the Phase 1 implementation
- make Phase 1 deliverables specific enough to support branch-based implementation and milestone reporting

## 3.1 Delivery Rules for Phase 1
To stay aligned with the main V1 repository plan, Phase 1 implementation should also observe these delivery expectations:
- create a Phase 1 feature branch before meaningful auth work begins
- verify the active repository and remote before the first implementation commit
- push at least once per active work session
- use commit messages that clearly identify the affected layer, such as `auth`, `app`, `db`, or `docs`
- maintain a readable Phase 1 summary covering created files, confirmed auth behavior, and deferred items
- keep the README or working notes updated enough to explain the current login and onboarding path

## 4. Architecture Overview
Phase 1 uses the same high-level technical direction established for PocketPulse V1:
- React SPA frontend
- `wouter` for routing
- TanStack Query for authenticated user/session state and future API-backed page data
- Express + TypeScript backend
- PostgreSQL with Drizzle-managed schema
- session-based auth using a PostgreSQL-backed session store

### Phase 1 architectural boundary
The architectural focus in this phase is the identity boundary between unauthenticated and authenticated users. The system must:
- verify identity
- establish and destroy sessions
- gate protected routes
- require first-time account setup before the user proceeds into the wider workspace

## 5. Data Model
The ERD includes broader entities than Phase 1 needs. For this phase, the implementation should use only the minimum subset required to support authentication and onboarding.

### Core tables for Phase 1
#### `users`
- `id`
- `email`
- `password`
- `display_name`
- `company_name`
- `created_at`
- `updated_at`

#### `user_preferences`
- `user_id`
- `theme`
- `week_starts_on`
- `default_currency`

#### `accounts`
- `id`
- `user_id`
- `label`
- `account_type`
- `last_four`
- `created_at`
- `updated_at`

#### `session`
- PostgreSQL-backed session table used by `connect-pg-simple`
- includes `sid`, `sess`, and `expire`
- indexed on expiry for session-store cleanup behavior

### Reconciliation note
The V1 repository map lists a smaller initial schema shape for `users` and `accounts`. This Phase 1 design keeps that baseline but explicitly allows `display_name`, `account_type`, and timestamps because they support onboarding clarity, auditability, and future reporting without changing the core single-owner model. The implemented work also narrowed `user_preferences` to concrete Phase 1 defaults (`theme`, `week_starts_on`, `default_currency`) instead of carrying forward broader prototype-style preference fields. In implementation, `shared/schema.ts` is the final schema authority for this branch and should override older conceptual column lists when there is a mismatch.

### Preferences lifecycle
If `user_preferences` is included in the initial schema, the preferred Phase 1 behavior is to create a default preferences row at registration time. If that adds unnecessary complexity to the first implementation pass, the row may be created lazily on first authenticated use, but the fallback behavior must be deterministic and documented.

### Deferred tables
The following ERD ideas remain valid for later phases but should not be implemented unless Phase 1 work requires them directly:
- import batches / uploads
- transactions
- transaction reviews
- recurring patterns
- leak flags
- pattern-to-transaction joins

## 6. Functional Behavior
### 6.1 Registration
- a new user can create a workspace account
- required fields should include at least email, password, and display name
- company name may be included as part of workspace identity
- on successful registration, the system should create the user, initialize a session, and return authenticated state

### 6.2 Login
- an existing user can log in with valid credentials
- invalid credentials should produce a clear error message without revealing unnecessary security details
- successful login should create a session and return the current authenticated user

### 6.3 Session Handling
- authenticated sessions persist until logout or expiration
- protected routes are inaccessible without an active session
- logout must destroy the session and return the user to the authentication view
- page refresh should not log the user out if the session is still valid

### 6.4 First-Time Account Setup
- after successful login or registration, the application checks whether the user has at least one account
- if no account exists, the user is routed to `AccountSetup`
- the user must be able to create at least one account with:
  - account label/name
  - optional last four digits
  - optional account type
- after the first account is created successfully, the user enters the protected app shell

### 6.5 Protected App Shell
The protected application shell should already reflect the product structure shown in the mockups, even if later pages are placeholders.

Expected navigation:
- `Dashboard` at `/`
- `Upload` at `/upload`
- `Ledger` at `/transactions`
- `Recurring Leak Review` implemented through the `Leaks` page at `/leaks`
- `Logout`

The shell exists in Phase 1 for orientation, routing continuity, and visual consistency. It is not required to contain full business behavior yet.

## 7. Frontend Design
### Main units
#### `client/src/pages/Auth.tsx`
- contains login and registration interactions
- displays clear success/failure states
- should stay focused on authentication behavior rather than broader onboarding logic

#### `client/src/pages/AccountSetup.tsx`
- handles first account creation after authentication
- only appears for authenticated users who do not yet have any accounts
- should communicate clearly why account setup is required before proceeding

#### `client/src/components/layout/AppLayout.tsx`
- provides left-side navigation consistent with the mockups
- wraps protected pages
- gives Phase 1 a coherent PocketPulse identity before later phases are built

#### `client/src/hooks/use-auth.ts`
- fetches current authenticated user
- provides auth state to route guards and page components
- should centralize session-aware client behavior

#### `client/src/App.tsx`
- owns the route map
- gates unauthenticated access
- gates incomplete onboarding when no account exists
- preserves canonical route names from the V1 repository map even when later pages remain placeholders

#### Placeholder page units expected in Phase 1
These should exist as protected placeholders, even if they do not yet implement later business behavior:
- `client/src/pages/Dashboard.tsx`
- `client/src/pages/Upload.tsx`
- `client/src/pages/Ledger.tsx`
- `client/src/pages/Leaks.tsx`
- `client/src/pages/not-found.tsx`

## 8. Backend Design
### Main units
#### `server/auth.ts`
- password hashing and comparison
- login/register behavior
- session creation and destruction
- authenticated user retrieval helpers

#### `server/routes.ts`
- registers auth and account-setup API routes
- applies authentication checks
- keeps request/response handling separate from persistence logic

#### `server/storage.ts`
- creates and reads users
- creates and lists user accounts
- exposes focused data-access methods for onboarding and auth checks

#### `server/db.ts`
- database connection setup
- shared access to the configured database layer

## 9. Route and API Design
### Authentication routes
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Account setup routes
- `GET /api/accounts`
- `POST /api/accounts`

### Expected Phase 1 API responsibilities
- return authenticated user state in a predictable format
- return account presence so the client can determine onboarding state
- reject unauthenticated access to protected account routes

### Suggested response-shape baseline
These are not strict transport contracts yet, but they should be kept stable enough to avoid unnecessary frontend rework during Phase 1.

#### `GET /api/auth/me`
- authenticated response should include at least:
  - user identifier
  - email
  - display name or workspace label fields used by the client
  - authenticated flag or equivalent state
- unauthenticated response should clearly indicate no active user session

#### `GET /api/accounts`
- authenticated response should return the current user's account list
- an empty list should be treated as the trigger for first-time account setup
- unauthenticated requests should be rejected

## 10. User Flow
### Primary Phase 1 flow
1. user opens PocketPulse
2. unauthenticated user sees the `Auth` page
3. user registers or logs in
4. server creates a valid session
5. client fetches `GET /api/auth/me`
6. client checks whether the user has at least one account
7. if not, client routes to `AccountSetup`
8. user creates the first account
9. client routes into the protected app shell

### Returning user flow
1. returning user opens PocketPulse
2. session is still valid
3. client fetches current user and account state
4. user is routed directly into the protected shell

## 11. Error Handling and Safety
Phase 1 should provide clear, bounded error handling for the main trust-sensitive workflows.

### Required error cases
- invalid login credentials
- duplicate email during registration
- expired or missing session on protected routes
- failed account creation
- failed current-user lookup due to session loss

### Safety expectations
- protected routes must not expose workspace data without authentication
- logout must fully clear the session
- onboarding gating must be enforced consistently on both initial login and refresh
- error messages should be understandable without exposing internal implementation details

### Session and environment expectations
- session cookies should be configured with security-focused defaults appropriate to the active environment
- production deployment should use a protected session secret and PostgreSQL connection string
- the implementation should account for the V1 environment baseline, especially `DATABASE_URL`, `SESSION_SECRET`, and `NODE_ENV`
- trusted origin settings such as `APP_ORIGIN` should be considered when configuring session and cookie behavior outside local development

## 12. Testing and Validation
Phase 1 should define clear validation paths before implementation proceeds too far.

### Manual validation targets
- register a new user successfully
- reject invalid login attempts
- preserve authenticated state across refresh
- redirect logged-out users away from protected pages
- route first-time users to account setup
- create at least one account successfully
- route the user into the protected shell after account setup
- destroy the session on logout

### Recommended automated coverage
- auth route success/failure cases
- session-aware current-user lookup
- account creation under authenticated ownership
- route gating logic where easy to validate
- at least one focused automated check should exist around authentication or session persistence before Phase 1 is considered fully validated

## 13. Acceptance Criteria
Phase 1 is considered complete when:
- a new user can register and receive an authenticated session
- an existing user can log in and log out successfully
- unauthenticated users cannot access protected application routes
- first-time users are forced through account setup before reaching the wider application
- authenticated users with at least one account can enter the protected app shell
- the protected shell reflects the PocketPulse page structure from the approved mockups
- the implementation remains aligned with the V1 scope and does not prematurely absorb later-phase business logic
- the repository has a documented Phase 1 baseline including spec updates and working implementation notes
- the active branch and remote workflow are confirmed for the fresh-start repository

### Requirement traceability
- `AU-01`: login with valid credentials
- `AU-01.1`: redirect authenticated users into the protected application flow; in Phase 1 this may mean account setup first and dashboard access after onboarding is complete
- `AU-01.2`: invalid login denied with visible feedback
- `AU-01.3`: new user registration supported
- `AU-02`: authenticated session maintained until logout or expiration
- `AU-02.1`: protected routes restricted to authenticated users
- `AU-03`: logout supported
- `AU-04`: first-time account setup required before wider workflow access
- `AU-04.1`: first account record can be created with required and optional metadata

## 14. Documentation and Reporting Notes
This phase should generate evidence that can be reused in the capstone paper:
- screenshots of the auth page
- screenshots of the account setup flow
- screenshot of the protected shell with placeholder navigation
- notes on why session auth was selected
- notes on why account setup was moved into onboarding
- branch and commit history showing the fresh-start V1 implementation path
- a short README or working-notes update capturing setup assumptions and the current login path

## 15. Deferred Work
The following should be planned next, not implemented as part of this phase unless explicitly re-approved:
- CSV upload queue
- file validation and parsing
- transaction normalization
- ledger review and editing
- exclusion-from-analysis behavior
- recurring leak review persistence
- dashboard metrics and safe-to-spend calculations
- export behavior

## 16. Recommendation
After this design is approved in written form, the next step should be a detailed implementation plan that breaks Phase 1 into small tasks covering:
- schema setup
- auth backend
- auth frontend
- route protection
- account setup
- protected shell placeholders
- testing and verification

## 17. Phase 1 implementation notes (branch clarification)
These details refine §6–§9 based on the `feature/phase-1-auth-account-setup` implementation; they are transport and infrastructure specifics, not scope changes.

- **Sessions:** The session cookie is named `pocketpulse.sid`. Sessions are stored in PostgreSQL via `connect-pg-simple` using the `session` table from the shared Drizzle schema. The server does not auto-create that table at runtime (`createTableIfMissing: false`); apply schema with `npm run db:push`. Cookie defaults include `httpOnly`, `sameSite: lax`, `secure` in production, and a defined max age (currently one week in code).
- **`GET /api/auth/me`:** No active session returns **200** with `{ authenticated: false }` so the client can treat “signed out” without treating it as an error. If `session.userId` points at a missing user, the server destroys the session and clears the cookie before returning unauthenticated.
- **Protected account APIs:** Unauthenticated calls to `/api/accounts` receive **401** with `{ error: "Unauthorized" }`.
- **Invalid login:** Failed credential checks respond with **401** and `{ error: "Invalid email or password" }` (single message for unknown user and bad password).
- **Client gating:** The app resolves the current user, then loads accounts; only after both succeed does it choose among the auth view, first-account setup, or the protected shell—so refresh preserves onboarding and shell boundaries consistently.
- **Automated tests:** Route-level tests can inject an in-memory session store. Broader storage or database-backed tests require a configured `DATABASE_URL` and `POCKETPULSE_STORAGE_TESTS=1` (see repository test docs or `server/*.test.ts` headers).
