import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

/**
 * Checks the privileges the BROWSER-FACING definer functions depend on, as the
 * roles that actually hold them.
 *
 * The rest of the SQL suite runs PGlite as superuser, which bypasses every GRANT.
 * That is how five shipped RPCs - openclaw_takeover_conversation_v1,
 * openclaw_release_takeover_v1, openclaw_assign_conversation_v1 and two more -
 * came to SELECT public.organization_memberships while running as
 * `openclaw_function_owner`, a NOLOGIN NOINHERIT NOBYPASSRLS role with no privilege
 * on that table. Every one of them would have raised 42501 on its first real call,
 * and 115 green SQL tests said nothing.
 */
const HARNESS_TIMEOUT = 45_000;

async function withDatabase(operation) {
  const database = await createDisposableOpenClawDatabase({ verifyCli: false });
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

/** Runs `sql` as `role`, returning the error message instead of throwing. */
async function attemptAs(database, role, sql) {
  await database.query("begin");
  try {
    await database.query(`set local role ${role}`);
    await database.query(sql);
    return null;
  } catch (error) {
    return error.message;
  } finally {
    await database.query("rollback");
  }
}

describe("browser RPC privileges under the owning role", () => {
  it("lets the function owner read the memberships its own RPCs join to", async () => {
    await withDatabase(async (database) => {
      expect(
        await attemptAs(
          database,
          "openclaw_function_owner",
          "select 1 from public.organization_memberships limit 1",
        ),
      ).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("still keeps that table away from the browser roles", async () => {
    await withDatabase(async (database) => {
      // The grant exists for SECURITY DEFINER bodies, not for callers. A member must
      // not be able to enumerate an organization's roster directly.
      for (const role of ["anon", "authenticated"]) {
        expect(
          await attemptAs(
            database,
            role,
            "select 1 from public.organization_memberships limit 1",
          ),
          role,
        ).toMatch(/permission denied/iu);
      }
    });
  }, HARNESS_TIMEOUT);

  it("grants the function owner nothing beyond reading memberships", async () => {
    await withDatabase(async (database) => {
      // SELECT only: a definer body that could write the roster would be a privilege
      // escalation path out of every OpenClaw RPC.
      for (const statement of [
        "insert into public.organization_memberships(id) values (gen_random_uuid())",
        "update public.organization_memberships set status = status",
        "delete from public.organization_memberships",
      ]) {
        expect(
          await attemptAs(database, "openclaw_function_owner", statement),
          statement,
        ).toMatch(/permission denied/iu);
      }
    });
  }, HARNESS_TIMEOUT);

  it("exposes the takeover reader to authenticated and to nobody else", async () => {
    await withDatabase(async (database) => {
      const denied = await attemptAs(
        database,
        "anon",
        "select public.openclaw_list_takeovers_v1('{}'::jsonb)",
      );
      expect(denied).toMatch(/permission denied/iu);

      // `authenticated` may CALL it; without a JWT the body refuses on its own terms
      // (authentication required), which is a different failure from a missing grant
      // and is what proves the grant landed.
      const called = await attemptAs(
        database,
        "authenticated",
        "select public.openclaw_list_takeovers_v1('{}'::jsonb)",
      );
      expect(called).not.toMatch(/permission denied for function/iu);
    });
  }, HARNESS_TIMEOUT);
});
