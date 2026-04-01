# Phase 1 Auth Visual Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved bright premium auth/onboarding visual foundation on `Auth` and `AccountSetup` without changing Phase 1 behavior.

**Architecture:** Keep the implementation scoped to `client/src/pages/Auth.tsx`, `client/src/pages/AccountSetup.tsx`, and auth-specific selectors in `client/src/index.css`. Use test-first updates in `client/src/App.test.tsx` to lock in the auth-only layout treatment and verify that onboarding inherits the same visual system without altering protected-shell behavior.

**Tech Stack:** React, TypeScript, Vite, Vitest, React Testing Library, CSS

---

## File Structure

**Modify**
- `client/src/App.test.tsx` — auth/onboarding UI assertions for the visual foundation wrapper/classes and any stable minimal-copy changes
- `client/src/pages/Auth.tsx` — apply the approved auth visual structure and minimal messaging
- `client/src/pages/AccountSetup.tsx` — apply the same visual structure to onboarding
- `client/src/index.css` — auth-scoped premium light-mode styling only

**Do not modify**
- protected shell layout/components
- server code
- routing/auth logic
- dark mode

### Task 1: Implement the approved auth/onboarding visual foundation

**Files:**
- Modify: `client/src/App.test.tsx`
- Modify: `client/src/pages/Auth.tsx`
- Modify: `client/src/pages/AccountSetup.tsx`
- Modify: `client/src/index.css`

- [ ] **Step 1: Write the failing test**

Add focused assertions in `client/src/App.test.tsx` proving:
- signed-out auth view renders inside an auth-specific premium layout wrapper
- zero-account onboarding renders inside the same wrapper/card treatment
- the tests stay scoped to auth-facing screens only

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/App.test.tsx`

Expected: FAIL because the new auth/onboarding visual wrapper classes or structure are not implemented yet.

- [ ] **Step 3: Write minimal implementation**

Implement the approved design in:
- `client/src/pages/Auth.tsx`
- `client/src/pages/AccountSetup.tsx`
- `client/src/index.css`

Constraints:
- keep copy minimal
- keep layout centered and single-panel
- use a brighter premium blue-led background treatment
- use a stronger card surface, spacing, and hierarchy
- implement all relevant visual requirements from `docs/superpowers/specs/2026-04-01-phase-1-auth-visual-foundation-design.md` §§5–8
- keep CSS auth-scoped so protected screens are unchanged
- preserve accessibility for text, buttons, inputs, focus, and error states

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/App.test.tsx`

Expected: PASS

- [ ] **Step 5: Run broader verification**

Run:
- `DATABASE_URL='postgresql://postgres:password@helium/heliumdb?sslmode=disable' POCKETPULSE_STORAGE_TESTS=1 npm test`
- `npm run check`

Expected:
- all tests pass
- typecheck passes

- [ ] **Step 6: Quick visual smoke in dev**

Open the auth and onboarding screens in the running app and confirm:
- the background is clearly non-flat and brighter than the darker exploration
- messaging is minimal
- card treatment feels premium and centered
- the protected shell remains unchanged

- [ ] **Step 7: Review implementation against approved spec**

Confirm the finished UI still matches:
- `docs/superpowers/specs/2026-04-01-phase-1-auth-visual-foundation-design.md`

Spec reminders:
- auth-facing screens only
- bright premium editorial tone
- minimal messaging
- stronger non-flat background
- no dark mode yet
- no protected-shell redesign

- [ ] **Step 8: Commit**

```bash
git add client/src/App.test.tsx client/src/pages/Auth.tsx client/src/pages/AccountSetup.tsx client/src/index.css
git commit -m "feat(ui): add auth visual foundation"
```

### Task 2: Final verification and optional docs sync

**Files:**
- Modify if needed: `README.md`
- Modify if needed: `docs/phase-logs/phase-1-testing-approach.md`

- [ ] **Step 1: Check whether docs need updating**

Only update docs if the implementation changes any user-facing verification wording materially, such as:
- auth screen presentation expectations for screenshots
- references to capture-ready screens

- [ ] **Step 2: If needed, write the minimal doc change**

Keep changes narrow and descriptive. Do not turn this task into a broad documentation rewrite.

- [ ] **Step 3: Re-run verification if docs or tests changed**

Run:
- `npx vitest run client/src/App.test.tsx`
- `npm run check`

Expected: PASS

- [ ] **Step 4: Commit doc sync if needed**

```bash
git add README.md docs/phase-logs/phase-1-testing-approach.md
git commit -m "docs(ui): note auth visual polish"
```
