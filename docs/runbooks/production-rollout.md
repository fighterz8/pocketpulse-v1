# PocketPulse production rollout runbook

## Scope

This runbook stages the verified Slices 0–8 release from production baseline
`28b945269c398bfeb9ee82a2a0602870fb2f03ab`. The application changes are
verified through `9eef95bdbf5ddf61dde4cc890cab55a01990e0fe`; the final release SHA also
includes this runbook and the release-gate automation and must be recorded from
the reviewed PR before rollout.

The first production release is **code and additive schema only**. Billing,
Checkout, Transaction Enhancement, full reclassification, and CSV format
assistance remain off. A public paid launch is a later release with separate
commercial, legal, provider, and production approvals.

## Safety facts

- Vercel project `pocketpulse-v1` is not currently Git-linked. Merging `main`
  does not itself prove or trigger a production deployment; deployment remains
  a separate manual action.
- Vercel's serverless entrypoint (`api/index.ts`) does not run migrations.
  Production migrations must be applied deliberately before any new
  schema-dependent feature is enabled.
- Migrations `0013` through `0018` are additive. Code rollback must not attempt
  a destructive database down-migration; the prior application ignores the new
  tables and columns.
- All enhancement flags default to false. `OPENAI_API_KEY` alone cannot start
  provider work.
- Billing defaults off, Checkout has a second independent flag, and the current
  adapter rejects `sk_live_` keys. The present release cannot accidentally
  become a live paid launch.
- Production currently has none of the new `POCKETPULSE_*` opt-in variables.
  Preserve that absence through the code-only release.
- GitHub `main` is currently unprotected. A merge must not proceed merely
  because GitHub permits it; the named release-gate check and reviewed SHA are
  mandatory human gates until branch protection is configured.

## Approval gates

| Gate | Approval required | Authorized action |
| --- | --- | --- |
| R0 — preparation | Already authorized | Local audit, CI, runbook, and inert preview verification |
| R1 — publish branch | Nick | Push the branch and open a review PR; no merge |
| R2 — schema | Nick immediately before execution | Create/confirm a Neon restore point and apply migrations `0013`–`0018` to production |
| R3 — code release | Nick after R2 verification | Merge the reviewed commit and manually deploy that exact commit with all paid flags off |
| R4 — paid-launch decision | Explicit business approval | Re-decide processor versus merchant of record, tax/accounting posture, refund policy, support workflow, price, trial, and launch geography |
| R5 — live canary | Explicit production billing approval | Add reviewed live-key support and a user-scoped canary, configure live Stripe, then enable a bounded canary |

Do not combine R2 through R5 into one approval.

## R0/R1 — release candidate verification

1. Confirm the candidate and baseline:

   ```bash
   git fetch origin main
   test "$(git rev-parse origin/main)" = "28b945269c398bfeb9ee82a2a0602870fb2f03ab"
   release_candidate_sha=$(git rev-parse HEAD)
   test -n "$release_candidate_sha"
   test -z "$(git status --short)"
   ```

2. Require the GitHub `Release gates` workflow to pass on the PR. It applies
   all migrations to disposable PostgreSQL 16, checks Drizzle and TypeScript,
   runs the full test suite serially, builds production artifacts, and audits
   production dependencies.
   GitHub currently has no `main` branch protection, so verify the named check
   manually and compare its SHA to `$release_candidate_sha`. Enabling a branch
   rule that requires `TypeScript, database, tests, build, and audit` is a
   separate repository-setting action, not implied by this runbook.
3. Review the complete `origin/main...HEAD` diff. This is a 45-commit release;
   do not squash away the verified slice checkpoints.
4. Confirm the production baseline before any mutation:

   ```bash
   curl --fail --silent --show-error https://pocket-pulse.com/api/health
   test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
     https://pocket-pulse.com/api/billing/plan)" = "404"
   ```

   The billing-plan route is new in this release, so 404 is the expected
   baseline response and 200 is required only after R3.

5. In Vercel Production environment settings, confirm these variables remain
   absent (or exactly `false` where present):

   ```text
   POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED
   POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED
   POCKETPULSE_FULL_RECLASSIFY_ENABLED
   POCKETPULSE_BILLING_ENABLED
   POCKETPULSE_BILLING_CHECKOUT_ENABLED
   ```

   Do not copy sandbox Stripe credentials into the main project.

## R2 — apply additive production migrations

1. Confirm Neon point-in-time restore coverage or create a production restore
   point/branch immediately before migration.
2. Use a temporary `0600` environment file. Never write production variables
   into the repository:

   ```bash
   source /home/nick/.openclaw/secrets/vercel.env
   rollout_env=$(mktemp /tmp/pocketpulse-production-env.XXXXXX)
   chmod 600 "$rollout_env"
   cleanup_rollout_env() {
     if [ -f "$rollout_env" ]; then
       shred -u -- "$rollout_env"
     fi
   }
   trap cleanup_rollout_env EXIT HUP INT TERM

   vercel env pull "$rollout_env" \
     --environment=production \
     --yes \
     --scope fighterz8s-projects \
     --token "$VERCEL_TOKEN"

   (
     set -a
     . "$rollout_env"
     set +a
     npm run db:migrate
     npm run db:migrate
     npm run db:verify-release
   )

   cleanup_rollout_env
   trap - EXIT HUP INT TERM
   unset rollout_env
   ```

3. Recheck the still-running baseline application. If health, login, import,
   Dashboard, Ledger, or Leak Hunter regresses, stop. Keep the additive schema
   and do not deploy the new code until the cause is understood.

## R3 — deploy the exact candidate with paid features off

1. Merge only after PR review and a green `Release gates` workflow.
2. Confirm `main` resolves to the reviewed candidate commit.
3. Build deployment input from a clean Git archive, link the temporary source
   to `pocketpulse-v1`, and deploy manually. This avoids accidentally using a
   dirty worktree or the isolated billing-sandbox project:

   ```bash
   source /home/nick/.openclaw/secrets/vercel.env
   rollout_src=$(mktemp -d /tmp/pocketpulse-production-source.XXXXXX)
   cleanup_rollout_src() {
     if [ -d "$rollout_src" ]; then
       gio trash "$rollout_src"
     fi
   }
   trap cleanup_rollout_src EXIT HUP INT TERM

   git archive HEAD | tar -x -C "$rollout_src"
   vercel link --yes \
     --project pocketpulse-v1 \
     --scope fighterz8s-projects \
     --token "$VERCEL_TOKEN" \
     --cwd "$rollout_src"
   vercel deploy --prod --force --yes --archive=tgz \
     --scope fighterz8s-projects \
     --token "$VERCEL_TOKEN" \
     --cwd "$rollout_src"

   cleanup_rollout_src
   trap - EXIT HUP INT TERM
   unset rollout_src
   ```
4. Before confirming the deployment, record the current rollback target:

   ```text
   deployment: dpl_72jWwbE3cr9mswDQ5vqUpHC2UzF8
   immutable URL: https://pocketpulse-v1-69yu1af92-fighterz8s-projects.vercel.app
   ```

5. Immediately verify:

   - `/api/health` returns 200.
   - `/api/billing/plan` returns `checkoutAvailable: false`.
   - An unsigned billing webhook is not accepted.
   - Registration/login and an existing-user login work.
   - A normal CSV import populates Dashboard, Ledger, and Leak Hunter without a
     refresh.
   - Data wipe immediately returns those views to their empty states.
   - Account shows PocketPulse Free and Data Controls.
   - No normal upload, navigation, or idle page produces a Stripe or OpenAI
     request.

6. Observe Vercel function errors, 5xx responses, database connection pressure,
   and authentication failures for at least 15 minutes. Keep every new paid
   flag off throughout this window.

## Code rollback

If the code release regresses the Free application:

1. Set all five opt-in flags to false first if any were changed unexpectedly.
2. Roll the Vercel project back:

   ```bash
   source /home/nick/.openclaw/secrets/vercel.env
   vercel rollback dpl_72jWwbE3cr9mswDQ5vqUpHC2UzF8 --yes \
     --scope fighterz8s-projects \
     --token "$VERCEL_TOKEN"
   ```

   If the CLI rollback path is unavailable,
   reassign `pocket-pulse.com`, `www.pocket-pulse.com`, and the canonical Vercel
   alias to the recorded immutable URL.
3. Re-run the baseline health, auth, import, Dashboard, Ledger, and Leak Hunter
   checks.
4. Leave migrations `0013`–`0018` in place. They are additive and are ignored
   by the prior code; dropping them would create unnecessary data-loss risk.
5. Record the failed deployment ID, first failing request, error timestamp, and
   rollback completion time before starting a fix.

## R4/R5 — prerequisites for a public paid launch

The code-only release does not authorize or technically enable live billing.
Before public checkout:

1. Update ADR 0001 with a current Stripe versus merchant-of-record fee review,
   selling entity and launch geography, tax/accounting review, refund policy,
   dispute handling, billing support ownership, and explicit approval.
2. Decide whether `$5/month` and seven trial days remain the launch offer.
3. Add and test explicit `sk_live_` support. The current configuration rejects
   live keys by design.
4. Add a user-scoped canary gate. The current Checkout flag is global and is
   not sufficient for a controlled production canary.
5. Create a live product/price, Portal configuration, and webhook endpoint;
   store live secrets only in the main Vercel Production environment.
6. Enable billing with Checkout still off, verify webhook health and the Free
   application, then separately approve Checkout for the allowlisted canary.
7. Complete one explicitly approved real-charge/refund cycle, verify signed
   lifecycle events and entitlement revocation, then decide whether to widen.
8. Enable Transaction Enhancement separately and only for entitled users after
   confirming usage budgets and operational monitoring. CSV assistance remains
   an independent gate.

## Evidence to retain

- PR URL and approved candidate SHA.
- Green `Release gates` run URL.
- Neon restore-point/branch identifier.
- Migration start/end timestamps and verification output.
- Pre-release and post-release Vercel deployment IDs.
- Smoke-test results and 15-minute monitoring result.
- Any rollback decision and completion timestamp.
