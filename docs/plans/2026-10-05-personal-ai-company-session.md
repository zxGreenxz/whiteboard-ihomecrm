# Remember company and recover personal-wallet AI

> For agentic workers: use superpowers:subagent-driven-development. Approved behavior is supplied by the user; no design confirmation needed.

Goal: restore the last company selected by each account after logout/login, browser restart or PWA login; switching company replaces that preference. Fix the AI permission message caused by missing organization context.

Evidence: live production quick-entry with authenticated DEMO owner and empty body returns organization_required without org, bad_request with authorized org (no provider call or business write). UI maps organization_required to not_permitted and permanently disables both AI channels. Current selection is a single browser-global key, while account ui_preferences supports atomic set_my_ui_preference.

## Task 1: Account company preference
- Reproduce missing cross-session/account selection with tests before implementation.
- Persist selected organization in existing profiles.ui_preferences using atomic set_my_ui_preference, and account-specific local cache for immediate restore/offline fallback. Keep active legacy key synchronized for existing scoped writers. Validate all remembered choices against current authorized directory; never silently choose first company from many.
- Restore server preference on login/browser/PWA new storage, preserve on logout/transient read failure, separate users, and replace on explicit switch. Capture user identity for async operations, reject stale responses, order rapid switches so old save cannot win. Wait for preference loading before asking user to choose. Failures must be visible/retryable, not success-shaped.
- Avoid schema changes, company records writes, extra auth bypass, or broad UI redesign. Keep app-entry bundle budget, strict new modules. Own context/helper/hook/tests and related account preference display only; no quick-entry edits.

## Task 2: AI missing-context recovery
- Root owns errors/feed/composer boundary. Separate organization_required from true permission denial. Do not bypass organization authorization, logging or entitlement policies.
- With no chosen company, offer choosing an authorized company within entry before AI use if needed; restore remembered company without user action when available. Preserve input/photo across selection. Missing-context errors remain retryable and are cleared on scope change; stale in-flight result cannot disable new account/org.
- Cover actual API transport no-org and org selection, reread/retry/voice behavior; no financial save in diagnostic tests.

## Task 3: Verify/release
- Focused regressions, meaningful guard mutation, real TEST roles/preferences (own disposable fixtures, cleanup), mobile login/logout/reload/switch + AI boundary browser checks, no console errors. No production org THẬT business writes.
- Stage exact files, full prepush gate, build+bundle, independent final diff review. Draft PR; exact SHA CI and official production promotion. Live read-only smoke; report any physical-device limits.
