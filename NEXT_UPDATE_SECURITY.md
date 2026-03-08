# Next Update: Security Hardening

## What Was Completed In This Pass

- Hardened session handling for deployment:
  - `SESSION_SECRET` is now required in production.
  - Session cookies use `Secure` in production.
  - The app trusts the Replit proxy so secure cookies work correctly behind TLS termination.
  - Logout now destroys the server session and clears the session cookie.
- Added basic auth throttling on `POST /api/auth/login` and `POST /api/auth/register` to reduce brute-force pressure.
- Added stricter auth input validation:
  - normalized emails
  - password length guardrails
  - company name length checks
- Removed API response body logging so transaction payloads and user data are no longer copied into application logs.
- Changed server error handling to avoid returning raw internal 5xx error messages to end users.
- Added lightweight security headers:
  - `X-Content-Type-Options`
  - `X-Frame-Options`
  - `Referrer-Policy`
  - `Permissions-Policy`
  - `Strict-Transport-Security` in production
- Hardened CSV upload validation by requiring a CSV filename and expected CSV MIME types.
- Hardened transaction CSV export against spreadsheet formula injection by neutralizing cells that begin with `=`, `+`, `-`, or `@`.
- Confirmed the runtime dependency surface is clean with `npm audit --omit=dev`.

## Current Security Status

### Good Now

- Passwords are bcrypt-hashed.
- Sessions are server-side in PostgreSQL instead of browser-stored tokens.
- Transaction, upload, and account access is scoped by authenticated `userId`.
- Production runtime dependencies currently audit clean.

### Still Needs Work

1. Add explicit CSRF protection for cookie-authenticated write routes.
   - Best next step: reject unsafe cross-origin requests with `Origin` / `Referer` validation first, then add CSRF tokens if needed.

2. Replace in-memory auth throttling with a durable shared limiter.
   - The current limiter is a good first layer, but it resets on restart and would not coordinate across multiple app instances.
   - Best next step: move it to PostgreSQL-backed counters or a dedicated rate-limit store.

3. Add privacy controls around LLM labeling.
   - Right now LLM labeling is opt-in by env flag, which is good.
   - Before wider sharing, add a product-level disclosure and user-controlled consent because transaction descriptions may be sent to Anthropic/OpenAI when enabled.

4. Add stricter upload abuse controls.
   - Good next step: cap CSV row count, reject obviously malformed files earlier, and consider per-user upload throttling.

5. Review secret hygiene around deployment artifacts and local caches.
   - Confirm Replit secrets are only set in the deployment environment.
   - Confirm no environment snapshots or secret-bearing cache files are exposed in shipped assets or shared backups.

6. Add a security-focused environment checklist for production.
   - Required values: `SESSION_SECRET`, `DATABASE_URL`
   - Optional but sensitive: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
   - Recommended: disable LLM labeling by default in production until consent copy exists.

## Recommended Next Security Sprint

1. Add `Origin` / `Referer` validation middleware for all state-changing authenticated routes.
2. Move auth rate limiting to a PostgreSQL-backed store.
3. Add a small security settings/privacy panel that explains LLM labeling and lets admins keep it off.
4. Add upload row-count limits and per-user import throttling.
5. Create a deployment checklist specifically for Replit secrets, custom domains, and rotation procedures.
6. Run the Replit security scan after the above and fix any platform-specific findings it surfaces.

## Validation Snapshot

- `npm run check`: passed
- `npm run build`: passed
- `npm audit --omit=dev`: passed with 0 vulnerabilities

## Notes On Dev Tooling

- A full `npm audit` still reports dev-tooling issues in build-time packages.
- Those do not affect the deployed runtime surface in the same way as production dependencies, but they should still be tracked and updated when safe, especially around `drizzle-kit`.
