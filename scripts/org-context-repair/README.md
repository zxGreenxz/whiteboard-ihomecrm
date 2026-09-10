# Organization context repair

The requested end state is to restore the affected iHome CRM images, make organization identity explicit throughout superadmin workflows without weakening other roles, and verify the complete release on production. The existing account selector alone does not meet that requirement.

## Manual backup preflight

`Organization context backup` runs only by manual dispatch on the exact reviewed `main` commit in the private `zxGreenxz/whiteboard-ihomecrm` repository. It uses the already configured `SUPABASE_DB_PASSWORD` and `SUPABASE_PAT` in place; it never exports those credentials.

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
- Current audit also identified implicit organization selection in member/role administration, settings, legacy writers and salary operations. These still require implementation and actual-role/cross-tenant tests. The current changes are the backup prerequisite, not completion of the user goal.

Run the synthetic backup tests with `node --test scripts/org-context-repair/sealed-artifact.test.mjs`. They also run in the normal CI quality gate without credentials and in the manual job before credentials are used.
