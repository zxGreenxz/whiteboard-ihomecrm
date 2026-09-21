# Stable function gate — Windows process lifecycle

The unchanged catalog query returned no violations, but two exact Node 24.18.0 runs terminated with exit 1 and a Windows libuv `UV_HANDLE_CLOSING` assertion after forced process exit. They were not counted as passes.

Changed only post-fetch process termination in `scripts/check-stable-fn-locks.mjs`: let pending fetch/output handles drain naturally; HTTP failures and catalog violations still set exitCode 1. SQL, catalog scope and lock detection are unchanged.

Verification on 21/09/2026:

- Real CLI child process tests with synthetic offline fetch: success, actual violation and HTTP503. All three failed before the change because queued cleanup was lost; all three passed after it, preserving respective exit codes 0/1/1.
- `scripts/dot-bien.mjs` changed the HTTP failure branch exitCode 1 to 0. Source SHA256 `1681a9bedaf4` → `7bca84b9f089`; suite failed with `expected +0 to be 1`; helper restored the original source digest and exited 0.
- Read-only live catalog run through the existing main-vault loader: session83006 completed exit0 with no Windows assertion, zero catalog violations. This excludes new unapplied feature migrations and does not prove their production deployment.
- Test matrix checked separately: exit0, 770 files, 11 suites; the new Vitest file belongs to the existing scripts/__tests__ app-unit glob.

Independent scoped reviewer `design_html_audit` approved spec and quality for the two-file delta: no changed SQL, both failure branches retain exit1, tests exercise the real CLI and queued cleanup. The missing-PAT forced exit remains before fetch and is outside the reproduced handle issue. Reviewer did not rerun the reported tests. No shared schema or business writes, no changes to query policy or failure criteria.
