import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

/**
 * Executes the migration/recovery facades AS THE ROLE THAT WILL CALL THEM.
 *
 * The rest of the SQL suite runs PGlite as superuser, which bypasses every GRANT
 * and every RLS policy. That is why ten facades could ship unable to run at all
 * while `test:openclaw:sql:fast` stayed at 101/101: a missing
 * `grant execute … to openclaw_service_dispatcher` is invisible to a superuser.
 *
 * Every assertion here therefore runs inside `set local role service_role`, the
 * role the Edge functions and operator adapters actually authenticate as.
 */
const ORG = "dddd0000-0000-4000-8000-000000000001";

/** Runs `operation` with the given role, always restoring the previous role. */
async function asRole(database, role, operation) {
  await database.query("begin");
  try {
    await database.query(`set local role ${role}`);
    return await operation();
  } finally {
    await database.query("rollback");
  }
}

async function seed(database) {
  await database.query(
    `insert into public.organizations(id, name) values ($1, 'facade-harness')
     on conflict (id) do nothing`,
    [ORG],
  );
}

/** Cell rows are per (organization, account), so ids carry both slot and account. */
const cellId = (slot, accountIndex) =>
  `dddd2000-0000-4000-8000-0000000000${slot}${accountIndex}`;
const OLD_CELL = cellId(1, 0);
const NEW_CELL = cellId(2, 0);
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const CONFIG = "c".repeat(64);

/**
 * ONE active account plus one retired account holding a historical lease.
 *
 * A review finding claimed an organization with N accounts would lose N-1 leases.
 * The schema forbids that premise: `openclaw_accounts_one_active_per_org_uidx`
 * allows a single active account per organization. The per-account handover is
 * still the right shape - a retired account can still own historical leases whose
 * fencing tokens must not out-rank the new cell - so this seeds exactly that.
 */
async function seedTwoAccountCells(database) {
  // Seeding a READY cell and an ACTIVE lease trips the canonical activation guard,
  // which is correct product behaviour and not what these assertions are about.
  // Superuser-only bypass, scoped to the seed and restored immediately after.
  await database.query("set session_replication_role = replica");
  const accounts = [
    "dddd1000-0000-4000-8000-00000000000a",
    "dddd1000-0000-4000-8000-00000000000b",
  ];
  for (const [index, account] of accounts.entries()) {
    await database.query(
      `insert into public.openclaw_accounts(id, organization_id, account_profile, is_active)
       values ($1, $2, $3, $4) on conflict (id) do nothing`,
      [account, ORG, `profile-${index}`, index === 0],
    );
    for (const [slot, current] of [[1, true], [2, false]]) {
      await database.query(
        `insert into public.openclaw_runtime_cells(
           id, organization_id, account_id, cell_generation, state, is_current,
           reviewed_commit_sha, image_digest, config_digest)
         values ($1, $2, $3, $4, 'READY', $5, $6, $7, $8)
         on conflict (id) do nothing`,
        [
          cellId(slot, index),
          ORG, account, index + 1, current, SHA, DIGEST, CONFIG,
        ],
      );
    }
    await database.query(
      `insert into public.openclaw_runtime_leases(
         organization_id, account_id, cell_id, lease_generation, fencing_token,
         status, expires_at)
       values ($1, $2, $3, 1, $4, 'ACTIVE', clock_timestamp() + interval '1 hour')`,
      [ORG, account, cellId(1, index), index + 1],
    );
  }
  await database.query("set session_replication_role = origin");
  return accounts;
}

async function withDatabase(operation) {
  const database = await createDisposableOpenClawDatabase({ verifyCli: false });
  try {
    await seed(database);
    return await operation(database);
  } finally {
    await database.close();
  }
}

/** The service facades an operator adapter calls, with a minimal valid request. */
const FACADES = [
  ["openclaw_service_begin_global_stop_v1", { reason: "planned-vps-migration" }],
  ["openclaw_service_drain_outbox_v1", {}],
  ["openclaw_service_freeze_outbox_v1", { states: ["QUEUED", "LEASED"] }],
  ["openclaw_service_expire_dispatching_to_unknown_v1", {}],
  ["openclaw_service_reconcile_migration_gaps_v1", {}],
];

/** Resume is separate: it is gated by the canonical activation guard, see below. */
const RESUME_FACADE = ["openclaw_service_resume_after_migration_v1", { reason: "migration-complete" }];

describe("migration facades under the calling role", () => {
  it("is a real role switch, not a superuser no-op", async () => {
    await withDatabase(async (database) => {
      const asService = await asRole(database, "service_role", async () =>
        (await database.query("select current_user as who")).rows[0].who);
      expect(asService).toBe("service_role");
      const asDefault = (await database.query("select current_user as who")).rows[0].who;
      expect(asDefault).not.toBe("service_role");
    });
  });

  it("executes the whole migration sequence as service_role, in order", async () => {
    await withDatabase(async (database) => {
      const failures = [];
      // ONE transaction, in the order migrate-cell.sh runs them: freeze legitimately
      // refuses before global-stop, so running each step in its own rolled-back
      // transaction would test a state the real script never reaches.
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        for (const [facade, extra] of FACADES) {
          const request = JSON.stringify({ version: 1, organizationId: ORG, ...extra });
          try {
            await database.query(`select public.${facade}($1::jsonb) as result`, [request]);
          } catch (error) {
            failures.push(`${facade}: ${String(error.message).split("\n")[0]}`);
            // A failed statement aborts the transaction, so restart it to keep
            // collecting every failure instead of stopping at the first.
            await database.query("rollback");
            await database.query("begin");
            await database.query("set local role service_role");
          }
        }
      } finally {
        await database.query("rollback");
      }
      expect(failures).toEqual([]);
    });
  });

  it("refuses to resume while the canonical rollout stage forbids activation", async () => {
    await withDatabase(async (database) => {
      // Clearing GLOBAL_STOP is an ACTIVATION. The activation guard owns that
      // decision, and a migration script must not be able to route around it.
      let message = "";
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        // The guard fires on the TRANSITION out of a stop, so the stop must exist
        // first - resuming an organization that was never stopped is a no-op.
        await database.query(
          `select public.openclaw_service_begin_global_stop_v1($1::jsonb)`,
          [JSON.stringify({ version: 1, organizationId: ORG, reason: "pre-resume" })],
        );
        await database.query(
          `select public.${RESUME_FACADE[0]}($1::jsonb)`,
          [JSON.stringify({ version: 1, organizationId: ORG, ...RESUME_FACADE[1] })],
        );
      } catch (error) {
        message = String(error.message);
      } finally {
        await database.query("rollback");
      }
      expect(message).toMatch(/rollout stage does not permit activation/u);
    });
  });

  it("refuses to hand over a lease while the rollout stage forbids activation", async () => {
    await withDatabase(async (database) => {
      await seedTwoAccountCells(database);
      // Handing a lease to a new cell IS an activation. The canonical activation
      // guard owns that decision and a migration script must not route around it,
      // so the successful path needs a permitting rollout run - fixture owned by the
      // rollout tooling, not by this harness.
      let message = "";
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        await database.query(
          `select public.openclaw_service_acquire_migration_lease_v1($1::jsonb)`,
          [JSON.stringify({
            version: 1, organizationId: ORG, oldCellId: OLD_CELL, newCellId: NEW_CELL,
          })],
        );
      } catch (error) {
        message = String(error.message);
      } finally {
        await database.query("rollback");
      }
      expect(message).toMatch(/rollout stage does not permit activation/u);
    });
  });

  it("refuses to retire the old cell while any account still has no new lease", async () => {
    await withDatabase(async (database) => {
      await seedTwoAccountCells(database);
      let message = "";
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        await database.query(
          `select public.openclaw_service_revoke_migration_lease_v1($1::jsonb)`,
          [JSON.stringify({
            version: 1, organizationId: ORG, oldCellId: OLD_CELL, newCellId: NEW_CELL,
          })],
        );
      } catch (error) {
        message = String(error.message);
      } finally {
        await database.query("rollback");
      }
      expect(message).toMatch(/hold no active lease on the new cell/u);
    });
  });

  it("denies the same facades to anon and authenticated", async () => {
    await withDatabase(async (database) => {
      for (const role of ["anon", "authenticated"]) {
        let denied = false;
        try {
          await asRole(database, role, () =>
            database.query(
              `select public.openclaw_service_begin_global_stop_v1($1::jsonb)`,
              [JSON.stringify({ version: 1, organizationId: ORG, reason: "x" })],
            ));
        } catch (error) {
          denied = /permission denied/iu.test(String(error.message));
        }
        expect(denied, `${role} was not denied`).toBe(true);
      }
    });
  });

  it("keeps GLOBAL_STOP idempotent across a retried step", async () => {
    await withDatabase(async (database) => {
      const request = JSON.stringify({ version: 1, organizationId: ORG, reason: "retry" });
      const versions = await asRole(database, "service_role", async () => {
        const first = await database.query(
          `select public.openclaw_service_begin_global_stop_v1($1::jsonb) as result`,
          [request],
        );
        const second = await database.query(
          `select public.openclaw_service_begin_global_stop_v1($1::jsonb) as result`,
          [request],
        );
        return [first.rows[0].result.controlVersion, second.rows[0].result.controlVersion];
      });
      // A repeated step must not mint a new control version.
      expect(versions[0]).toBe(versions[1]);
    });
  });

  it("refuses to freeze the outbox while GLOBAL_STOP is inactive", async () => {
    await withDatabase(async (database) => {
      let message = "";
      try {
        await asRole(database, "service_role", () =>
          database.query(
            `select public.openclaw_service_freeze_outbox_v1($1::jsonb)`,
            [JSON.stringify({ version: 1, organizationId: ORG, states: ["QUEUED"] })],
          ));
      } catch (error) {
        message = String(error.message);
      }
      expect(message).toMatch(/GLOBAL_STOP is inactive/u);
    });
  });
});
