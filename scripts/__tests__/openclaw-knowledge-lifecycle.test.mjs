import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

/**
 * Drives the knowledge lifecycle through the TRIGGERS that guard it.
 *
 * `20260727090000` replaced the append-only trigger on openclaw_knowledge_versions
 * with `guard_openclaw_retention_redaction_v1`, whose only exemptions were
 * DRAFT→PUBLISHED and PUBLISHED→ARCHIVED. Everything else demanded
 * `current_user = 'openclaw_maintenance_writer'`. The validate step writes
 * `validation_result` while staying DRAFT and runs as `openclaw_function_owner`, so
 * it raised 42501 on every call - and because publish hard-requires a non-null
 * validation_result that nothing else writes, publish was unreachable too. The
 * entire lifecycle was dead and 119 green SQL tests said nothing, because PGlite
 * runs as superuser and `current_user` inside a SECURITY DEFINER body is the
 * function's OWNER rather than the session role.
 *
 * These assertions run the UPDATEs as that owner, which is the only way the guard
 * is exercised at all.
 */
const HARNESS_TIMEOUT = 45_000;

const ORG = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT = "dddd1000-0000-4000-8000-00000000000a";
const SOURCE = "dddd5000-0000-4000-8000-000000000001";
const VERSION = "dddd6000-0000-4000-8000-000000000001";

async function withSeededDatabase(operation) {
  const database = await createDisposableOpenClawDatabase({ verifyCli: false });
  try {
    // Seeded with triggers off, then restored, so the UPDATEs under test meet the
    // real guard rather than a disabled one.
    await database.query("set session_replication_role = replica");
    await database.query(
      `insert into public.organizations(id, name) values ($1, 'knowledge-harness')
       on conflict (id) do nothing`,
      [ORG],
    );
    await database.query(
      `insert into public.openclaw_knowledge_sources(
         id, organization_id, account_id, title, source_kind, sensitivity, current_version)
       values ($1, $2, $3, 'FAQ', 'FAQ', 'CUSTOMER_SAFE', 1) on conflict (id) do nothing`,
      [SOURCE, ORG, ACCOUNT],
    );
    await database.query(
      `insert into public.openclaw_knowledge_versions(
         id, organization_id, account_id, source_id, version, sensitivity,
         lifecycle_state, content, content_hash)
       values ($1, $2, $3, $4, 1, 'CUSTOMER_SAFE', 'DRAFT', 'noi dung', $5)
       on conflict (id) do nothing`,
      [VERSION, ORG, ACCOUNT, SOURCE, "a".repeat(64)],
    );
    await database.query("set session_replication_role = origin");
    return await operation(database);
  } finally {
    await database.close();
  }
}

/** Runs `sql` as the role that owns the knowledge write function. */
async function asFunctionOwner(database, sql, params = []) {
  await database.query("begin");
  try {
    await database.query("set local role openclaw_function_owner");
    await database.query(sql, params);
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  } finally {
    await database.query("rollback");
  }
}

describe("knowledge lifecycle under the retention guard", () => {
  it("lets a draft record its validation result", async () => {
    await withSeededDatabase(async (database) => {
      expect(
        await asFunctionOwner(
          database,
          `update public.openclaw_knowledge_versions
           set validation_result = jsonb_build_object('version', 1, 'valid', true)
           where organization_id = $1 and id = $2`,
          [ORG, VERSION],
        ),
      ).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("lets a draft be published and a draft be archived", async () => {
    await withSeededDatabase(async (database) => {
      expect(
        await asFunctionOwner(
          database,
          `update public.openclaw_knowledge_versions
           set lifecycle_state = 'PUBLISHED', published_at = clock_timestamp()
           where organization_id = $1 and id = $2`,
          [ORG, VERSION],
        ),
        "DRAFT -> PUBLISHED",
      ).toBeNull();

      // The archive RPC accepts a DRAFT and sets published_at at the same time,
      // which is why this needs its own exemption.
      expect(
        await asFunctionOwner(
          database,
          `update public.openclaw_knowledge_versions
           set lifecycle_state = 'ARCHIVED', archived_at = clock_timestamp(),
               published_at = coalesce(published_at, clock_timestamp())
           where organization_id = $1 and id = $2`,
          [ORG, VERSION],
        ),
        "DRAFT -> ARCHIVED",
      ).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("still refuses everything the guard exists to stop", async () => {
    await withSeededDatabase(async (database) => {
      for (const [label, sql] of [
        // Redaction proper: only openclaw_maintenance_writer may do this.
        ["redact content", `update public.openclaw_knowledge_versions
          set content = '[REDACTED_BY_RETENTION]' where organization_id = $1 and id = $2`],
        // The exemption is null -> non-null. The reverse is the redaction path.
        ["clear validation_result", `update public.openclaw_knowledge_versions
          set validation_result = null where organization_id = $1 and id = $2`],
        // Byte-identical means byte-identical: piggybacking a content change onto a
        // validation write must not slip through.
        ["validate AND edit content", `update public.openclaw_knowledge_versions
          set validation_result = jsonb_build_object('version', 1, 'valid', true),
              content = 'noi dung khac' where organization_id = $1 and id = $2`],
        ["sensitivity downgrade", `update public.openclaw_knowledge_versions
          set sensitivity = 'RESTRICTED' where organization_id = $1 and id = $2`],
        ["delete", `delete from public.openclaw_knowledge_versions
          where organization_id = $1 and id = $2`],
      ]) {
        expect(
          await asFunctionOwner(database, sql, [ORG, VERSION]),
          label,
        ).not.toBeNull();
      }
    });
  }, HARNESS_TIMEOUT);
});
