# Personal Wallet Pinned Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this cohesive task with independent review.

**Goal:** A home-screen icon installed from Ví cá nhân always opens `/finance/personal-wallet`, including after login and cold relaunch. User explicitly requested this behavior following production rollout.

**Architecture:** Dedicated personal manifest identity/start URL, early CSP-safe manifest selection and synchronization on SPA route changes. Preserve safe internal destination through login URL and both auth redirect paths. Keep all authentication, personal permission and org boundaries unchanged.

**Tech Stack:** React Router6, React Query, Supabase Auth, static Web App Manifest, Vitest and Playwright.

## Global Constraints

- Read docs/engineering/PROJECT_CONTRACT.md; worktree C:/Users/Nguyen Tam/codex-worktrees/vi-ca-nhan-mobile-demo, branch codex/personal-wallet-pinned-launch, base4638be6efa9d587031af8a99cf1029063bad6e63. Primary checkout WIP untouched.
- Vietnamese product copy. No schema/money mutations/auth bypass/org auto-selection. No user-wide remembered-last-page preference. Existing CRM installation remains a separate identity with start `/`.
- Core user behavior already explicit: pin exact personal screen and return there after sign-in/reopen. No additional design approval needed for this bug fix.
- No inline script or relaxed CSP. Existing SW is push-only and must remain so. Session persistence already uses localStorage/persistSession=true; don't alter token handling.
- New login target must be same-origin absolute internal path, reject external/protocol-relative/backslash/control/encoded separator escapes and auth-loop paths. Preserve safe search/hash. A login URL reload must retain destination. Default login stays `/`.
- User may need to re-add the home-screen icon because old icon installed global CRM manifest. Do not claim physical iOS install/relaunch verified by headless Chromium.
- Node24 absolute runtime; npm_execpath C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js for wrapper tooling. Secrets only primary vault, never output/copy.
- Exact staging; commit trailer Co-Authored-By: Codex <noreply@openai.com>. Controller runs full gate/build/E2E/release. Author focused tests and mutation proofs only.

## Evidence and decision

- public/manifest.webmanifest has id `/`, start_url `/` for all routes.
- ProtectedRoute saves `state.from`, but useLogin.onSuccess unconditionally navigates `/`.
- PublicRoute when authenticated unconditionally Navigate `/`; must fix both to avoid auth-event race.
- Organization chooser is on the resulting homepage, not a mandatory personal-route guard. MainLayout hides the mobile header on personal screen. Preserve module permission checks.
- index.html static manifest link; strict CSP permits same-origin external scripts, forbids inline. AppRoutes RouteTreeCommit is suitable place to signal route change after commit.
- Browser standards: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/start_url and /id; https://developer.apple.com/videos/play/wwdc2023/10120/.

## Task1: Pinned personal entry and safe login return (one cohesive deliverable)

**Files:**
- public/personal-wallet.webmanifest (new): name Ví cá nhân, unique id and start_url `/finance/personal-wallet`, scope `/` to keep login in installed window; reuse existing valid192/512/maskable icons.
- public/pwa-manifest.js (new): self-contained external boot script selects personal manifest/apple title on personal path or login with safe personal next target; normal routes use global manifest/title. React SPA route-change event updates selection. No interception of navigation or auth.
- index.html: load selector after manifest/apple title tags, before app module.
- src/app/routes/index.tsx: signal selector on pathname/search changes, preserve splash lifecycle.
- src/lib/authRedirect.ts (new): pure safe target/resolve-from-login helpers, URL `next` primary and safe legacy state.from fallback; invalid/missing targets -> `/`; auth-loop targets rejected.
- src/components/auth/ProtectedRoute.tsx: propagate full requested route into `/login?next=...` while retaining state; loading/error behavior preserved.
- src/components/auth/PublicRoute.tsx: authenticated login returns resolved target; ordinary forgot-password behavior remains home.
- src/pages/auth/Login.tsx and src/hooks/useAuth.ts: login mutation gets same validated destination and replace navigation, avoiding race with PublicRoute.
- Focused new tests under src/lib/__tests__, src/components/auth/__tests__, scripts/__tests__ or equivalent existing runner. Update useAuthMutationKeys mocks only if interface requires it.
- Focused headless spec under .e2e-fleet/specs for manifest selection/login refresh/relaunch; controller may own separate actual production DEMO harness.

**Interfaces:** A pure safe internal URL resolver shared by both login redirect paths; author chooses exact signatures and documents them. Route-change event `pwa-route-change` carries no secrets/state and script reads current URL only.

- [ ] Write regression tests for actual current behavior (wrong `/` after login, global manifest selected on personal page), run RED before fixing.
- [ ] Implement target handling and manifest identity. Avoid public global remembers, new guards or service-worker cache changes.
- [ ] Run focused GREEN covering logged-out URL with query/hash, login page reload, authenticated login entry, login success race, ordinary root login, unsafe next variants, stale/invalid state, company-unselected personal route and route transitions between CRM/personal.
- [ ] Test actual executable boot script/manifest files, not source regex: cold page and client navigation, login-next, unrelated pages, false path prefixes, manifest/start/id/icons resolution.
- [ ] Use scripts/dot-bien.mjs to kill unsafe redirect and dropped-destination mutants; restore hash. No production schema or business writes.
- [ ] Focused browser demo/fixture test asserts current DOM route+manifest and fresh launch from manifest start URL; no claim actual iOS installation automated. Check console/page errors.
- [ ] Report exact commands/results/limits/raw log paths to `.superpowers/sdd/2026-10-05-personal-wallet-pinned-launch/task-1-report.md`, commit only author files.

## Task2: Integration, independent review and production (controller)

- [ ] Build and bundle, headless actual auth DEMO or TEST through login → wallet → reload/cold context, no financial writes; test read-only denied cases where applicable. Use no real-org business writes.
- [ ] Stage source, full gate (incl live owner/org isolation), generator artifacts inspected; independent final diff review for auth/security. Fix only findings, scoped re-review.
- [ ] Draft PR, attach; fresh fetch/rebase, FFmain. Verify exactSHA actual CI steps then promote dry/apply. No schema lane required.
- [ ] Verify actual deployment SHA/READY/alias + live production deep-link/login/manifest smoke. Give user exact new pin/re-pin steps and physical-device limitation.
