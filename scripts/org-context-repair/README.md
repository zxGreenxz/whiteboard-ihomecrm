# Organization context repair

The requested end state is to restore the affected iHome CRM images, make organization identity explicit throughout superadmin workflows without weakening other roles, and verify the complete release on production. The existing account selector alone does not meet that requirement.

## Manual backup preflight

`Organization context backup` runs only by manual dispatch on the exact reviewed `main` commit in the `zxGreenxz/whiteboard-ihomecrm` repository. It uses the already configured `SUPABASE_DB_PASSWORD` and `SUPABASE_PAT` in place; it never exports those credentials.

Inputs:

- `expected_sha`: exact 40-character `main` SHA that contains the reviewed workflow and scripts.
- `recipient_public_key`: base64 encoding of a PEM RSA public key, at least 3072 bits. Keep the matching private key in the operator's local backup directory, outside Git.

The job runs the existing full-backup script and eligibility check, then captures current function definitions, policies, triggers, columns, grants and the affected attachment metadata in a read-only transaction. It encrypts both the full dump and the catalog snapshot for the local recipient before artifact upload. The artifact contains only `backup.encrypted`, `envelope.json` and `receipt.json`; retention is seven days. Download, decrypt with `unsealFiles`, and retain the verified dump in `%USERPROFILE%/ihomecrm-backups` before proceeding. This preflight backup does not substitute for the fresh backup required by the eventual apply lane.

After downloading/extracting the artifact, use `node scripts/org-context-repair/unseal-backup.mjs --artifact-dir PATH --private-key PATH --sha SHA`. This verifies encrypted and decrypted digests, recipient, project and commit identity, then writes the three payload files and a local verification receipt outside the repository. It does not restore or connect to any database. Keep the original manifest unchanged; `local-verification.json` records the new local dump path.

This workflow cannot apply migrations, alter policies, repair attachments or deploy the app. The production repair remains a separate forward migration with current catalog preconditions and the existing backup/provenance gates. Do not add an arbitrary-SQL input or use legacy migration replay.

## Evidence and outstanding work

- 2026-09-10: found the actual Git checkout from the account-company release, based on production/main commit `52ff794629bbf6b887008faa993534269a26cd90`; created a separate `fix/superadmin-org-repair` worktree.
- Repository secret names confirm the CI environment has backup and Supabase API credentials. Presence is not proof that the credentials currently connect; the manual preflight must succeed.
- GitNexus rebuilt at this commit; high-risk freshness gate passes. The older UA graph remains stale and is not used as architecture evidence.
- Earlier production read-only measurements found 30 referenced images with NULL storage-link organization, plus four unclassified objects without a proven voucher reference. NATHAN could read their 29 parent vouchers but none of the 30 affected files. Re-measure before repairing.
- The manual preflight at `450461a7d27dac17d3e3cd4b1bf0c6c7dd37d114` (GitHub run `34479195797`, job `102877427389`) reached PostgreSQL but failed password authentication. The user has been asked to update the existing `SUPABASE_DB_PASSWORD` secret, without posting it in chat. No full dump was produced and no production repair has run.
- An authenticated, read-only Dashboard export captured 1,544 function definitions, 1,119 policies, 534 triggers and 5,655 columns on 2026-09-10 at 12:57 UTC. The complete export is outside Git in the operator's backup directory. It is catalog evidence, not a full data backup.
- The local review currently patches 43 existing function definitions using exact before/after hashes. Private helpers resolve validated company context, salary periods and parent-bound type/account choices. Existing function ACLs, ownership and execution settings remain unchanged in the local before/after comparison. No RLS policy or bucket visibility is altered.
- Browser requests carry the per-account working company. Server helpers validate active, unexpired membership; existing operation-specific permission checks remain authoritative. New upload metadata covers seven private buckets, and existing-record upload callers resolve the parent company's identity. Income/expense parent attachment writes also bind new images inside the same transaction.
- A read-only recheck at 13:59 UTC still found 34 unclassified income/expense images for the affected superadmin. A subsequent bucket breakdown found no unclassified images by that uploader in customer ID cards (994 classified), customer images (30), templates (10), jobs (11), or payment receipts (19). These counts do not prove access under every role.
- At 14:56 UTC the disposable PostgreSQL verification passed for all 43 exported function bodies (review SHA-256 `844c51d10a7b2a8e93bd92d0ed8260d9a74c449de365179c7a52084e0593b830`). It reproduced the old `delete_staff_member` operation revoking both companies, then verified selected-company removal, preservation of the other company's assignments and legacy role, and last-owner rejection. Assignment triggers and live RLS are not included in this bounded fixture.
- Production REST preflight accepted `x-ihomecrm-organization-id` from the production origin (HTTP 200 with the header reflected in the allow-list). The request contained no credentials or data mutation; this verifies CORS compatibility, not server authorization behavior.
- The authoritative worktree is now `C:/Users/51103/codex-workspaces/superadmin-org-repair`, branch `fix/superadmin-org-repair-stable`, outside OneDrive. The original worktree remains intact. Severe system memory pressure caused repeated Windows `UNKNOWN` file errors in both locations; the new dependency installation also omitted some files. Repair dependencies before treating any new frontend test/build run as valid.

## Current review and limits

Generate the review with `build-review.mjs LOCAL_CATALOG_JSON organization.review.sql`. It defaults to ROLLBACK and is not a deployable migration. `verify-live-review.mjs LOCAL_CATALOG_JSON LOCAL_REPORT_JSON` uses disposable PGlite, compiles the exported functions, exercises rollback and a second idempotent application, reproduces the old cross-company salary-unlock behavior and verifies the new rejection. It also exercises parent-bound type, virtual-building and account resolution against same-name records in two companies. Date, authorization, normalization, demo-list and feature-route dependencies are explicitly bounded fixtures, not the full production graph.

Local upload tests cover all seven buckets, legacy single-company behavior, revoked/expired membership rejection, existing-path ownership, v2 finance intents and uploader identity. Mutation checks removed the upload membership guard and whole-batch salary guard independently; both caused the expected regression failure and were restored. The receipts remain outside Git.

Still required before completion:

- Finish the organization-source inventory and resolve remaining platform-wide V5 payroll/background-job semantics. Live ACLs show `v5_run_job`, `v5_run_tier`, `v5_run_score`, `v5_expire_stale`, `v5_close_period` and `v5_recompute_streak` are executable only by postgres/service_role. The interactive V5 configuration setter now refuses to edit a configuration owned by another company; this is not a claim that every V5 background function is tenant-scoped. Global configuration reads and legacy salary rows still need an explicit scope review.
- Finish runtime verification and exact-release UI tests; a previous full TypeScript run found two new errors which have been corrected, but the complete ratchet must be rerun. The source inventory encountered a transient Windows file-read error and must complete successfully before its counts are reported.
- Re-measure affected image references and catalog hashes, create the forward migration/provenance entry, obtain the required fresh full backup, and use the reviewed apply lane. Repair only proven parent-linked images; leave unreferenced/quarantined objects unassigned.
- Run actual-role checks (including NATHAN and negative cross-company cases), HTTP image checks, policy/invariant fingerprints, required gates and production promotion verification. No production app or database change has been applied by this repair task yet.

Run the synthetic backup tests with `node --test scripts/org-context-repair/sealed-artifact.test.mjs`. They also run in the normal CI quality gate without credentials and in the manual job before credentials are used.
