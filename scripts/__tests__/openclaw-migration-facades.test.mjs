import { describe, expect, it } from "vitest";

import {
  createDisposableOpenClawDatabase,
  OPENCLAW_MIGRATIONS,
} from "../test-openclaw-migrations.mjs";

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
const STALE_CELL = "dddd2000-0000-4000-8000-000000000099";

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

/**
 * A rollout run that PERMITS activation. Handing a lease to a new cell is an
 * activation, so exercising the success path needs a real rollout rather than a
 * trigger bypass - bypassing would also disable the foreign keys this handover
 * depends on, and prove nothing.
 */
async function seedPermittingRollout(database, status = "RUNNING") {
  // The guard demands a digest per reviewed migration, so the fixture is built from
  // the manifest itself rather than an empty object.
  const digests = JSON.stringify({
    ...Object.fromEntries(OPENCLAW_MIGRATIONS.map((file) => [file, "e".repeat(64)])),
    // Must equal the cell rows themselves: the guard compares the run against the
    // cell it is about to activate, so inventing values here would only prove that
    // a fixture can agree with itself.
    cellReviewedCommitSha: SHA,
    cellImageDigest: DIGEST,
    cellConfigDigest: CONFIG,
  });
  // The manifest hash is derived by the database, not asserted here: hardcoding it
  // would make this fixture drift silently the day the manifest changes.
  await database.query(
    `insert into public.openclaw_rollout_runs(
       organization_id, reviewed_commit_sha, migration_manifest_sha256, upstream_sri,
       upstream_git_head, patch_series_sha256, built_tgz_sha256, artifact_digests,
       project_ref, stage, stage_version, stage_entered_at, status, started_at,
       completed_at)
     values ($1, $2, app_private.openclaw_rollout_manifest_hash_v1($3::jsonb), 'sha384-x',
             $2, $4, $4, $3::jsonb, 'tryymsxyyckgbrmmvozx',
             'SALES_GROUPS', 1, clock_timestamp(), $5, clock_timestamp(),
             case when $5 = 'COMPLETE' then clock_timestamp() end)`,
    [ORG, SHA, digests, "d".repeat(64), status],
  );
}

/**
 * Brings the NEW cell to the state migrate-cell.sh leaves it in just before the
 * lease step: current, and holding a live credential. Step 7 (rotate) runs before
 * step 8 (acquire), so at handover time the new cell is the reviewed one.
 */
async function promoteNewCell(database, account) {
  await database.query("set session_replication_role = replica");
  await database.query(
    `update public.openclaw_runtime_cells set is_current = (id = $2)
     where organization_id = $1 and account_id = $3`,
    [ORG, NEW_CELL, account],
  );
  await database.query(
    `insert into public.openclaw_runtime_credentials(
       organization_id, account_id, cell_id, credential_generation, credential_hash,
       allowed_scopes)
     values ($1, $2, $3, 1, $4, array['heartbeat'])`,
    [ORG, account, NEW_CELL, "1".repeat(64)],
  );
  await database.query("set session_replication_role = origin");
}

/**
 * A REVOKED lease with a high fencing token on an unrelated cell of the same
 * account, standing in for one left behind by an aborted migration.
 */
async function seedStaleLease(database, account, token) {
  await database.query("set session_replication_role = replica");
  await database.query(
    `insert into public.openclaw_runtime_cells(
       id, organization_id, account_id, cell_generation, state, is_current,
       reviewed_commit_sha, image_digest, config_digest)
     values ($1, $2, $3, 9, 'RETIRED', false, $4, $5, $6) on conflict (id) do nothing`,
    [STALE_CELL, ORG, account, SHA, DIGEST, CONFIG],
  );
  await database.query(
    `insert into public.openclaw_runtime_leases(
       organization_id, account_id, cell_id, lease_generation, fencing_token,
       status, expires_at, released_at)
     values ($1, $2, $3, 9, $4, 'REVOKED',
             clock_timestamp() + interval '1 minute', clock_timestamp())`,
    [ORG, account, STALE_CELL, token],
  );
  await database.query("set session_replication_role = origin");
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

/**
 * Each assertion builds its OWN disposable PGlite database and replays all twelve
 * migrations, which takes seconds - and longer when the eight SQL harness files run
 * in parallel under `test:openclaw:sql:fast`. The 5s default turned that contention
 * into three red tests that pass in isolation. Bounded, and kept close to the ~4s
 * these actually take: at 120s a genuine hang would burn ~26 minutes across the file
 * before the suite went red.
 */
const HARNESS_TIMEOUT = 45_000;

describe("migration facades under the calling role", () => {
  it("is a real role switch, not a superuser no-op", async () => {
    await withDatabase(async (database) => {
      const asService = await asRole(database, "service_role", async () =>
        (await database.query("select current_user as who")).rows[0].who);
      expect(asService).toBe("service_role");
      const asDefault = (await database.query("select current_user as who")).rows[0].who;
      expect(asDefault).not.toBe("service_role");
    });
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

  it("attributes a step to the rollout that authorized it", async () => {
    await withDatabase(async (database) => {
      await seedTwoAccountCells(database);
      await seedPermittingRollout(database);
      let entry;
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        await database.query(
          `select public.openclaw_service_drain_outbox_v1($1::jsonb)`,
          [JSON.stringify({
            version: 1, organizationId: ORG,
            requestId: "dddd3000-0000-4000-8000-000000000001",
          })],
        );
        await database.query("reset role");
        entry = await database.query(
          `select request_id, correlation_id, redacted_evidence
           from public.openclaw_audit_events
           where organization_id = $1 and event_type = 'OPENCLAW_MIGRATION_STEP'
           order by organization_sequence desc limit 1`,
          [ORG],
        );
      } finally {
        await database.query("rollback");
      }
      const run = entry.rows[0];
      // A reviewer can now answer "was this migration approved?" from the log alone.
      expect(run.redacted_evidence.rolloutRunId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(run.redacted_evidence.rolloutStage).toBe("SALES_GROUPS");
      // Steps of one adapter invocation correlate; the run id ties them together.
      expect(run.correlation_id).toBe(run.redacted_evidence.rolloutRunId);
      expect(run.request_id).toBe("dddd3000-0000-4000-8000-000000000001");
    });
  }, HARNESS_TIMEOUT);

  it("does not credit a step to a rollout that already finished", async () => {
    await withDatabase(async (database) => {
      await seedTwoAccountCells(database);
      // Inserted COMPLETE rather than transitioned into it: the rollout state machine
      // refuses an UPDATE that skips its own checkpoints, and this test is about how
      // the audit READS a finished run, not about how one legitimately finishes.
      await seedPermittingRollout(database, "COMPLETE");
      let entry;
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        await database.query(
          `select public.openclaw_service_drain_outbox_v1($1::jsonb)`,
          [JSON.stringify({ version: 1, organizationId: ORG })],
        );
        await database.query("reset role");
        entry = await database.query(
          `select correlation_id, redacted_evidence from public.openclaw_audit_events
           where organization_id = $1 and event_type = 'OPENCLAW_MIGRATION_STEP'
           order by organization_sequence desc limit 1`,
          [ORG],
        );
      } finally {
        await database.query("rollback");
      }
      // COMPLETE rows accumulate forever. Matching them made the whole signal
      // worthless: after an organization's first rollout finished, every later step -
      // planned or not - inherited that run's id and `rolloutRunId: null` could never
      // appear again. A finished rollout authorizes nothing.
      expect(entry.rows[0].redacted_evidence.rolloutRunId).toBeNull();
      expect(entry.rows[0].correlation_id).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("ignores a request id that is not a uuid instead of failing the step", async () => {
    await withDatabase(async (database) => {
      let entry;
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        await database.query(
          `select public.openclaw_service_drain_outbox_v1($1::jsonb)`,
          [JSON.stringify({ version: 1, organizationId: ORG, requestId: "'; drop--" })],
        );
        await database.query("reset role");
        entry = await database.query(
          `select request_id from public.openclaw_audit_events
           where organization_id = $1 and event_type = 'OPENCLAW_MIGRATION_STEP'
           order by organization_sequence desc limit 1`,
          [ORG],
        );
      } finally {
        await database.query("rollback");
      }
      // Caller-supplied text must not widen what the audit column accepts, and must
      // not take the migration down either.
      expect(entry.rows[0].request_id).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("hands the lease over atomically, and is idempotent on retry", async () => {
    await withDatabase(async (database) => {
      const [activeAccount] = await seedTwoAccountCells(database);
      await seedPermittingRollout(database);
      await promoteNewCell(database, activeAccount);
      // A stale lease left behind by an aborted migration, on a cell that is NOT the
      // one being handed over, carrying a much higher token. The handover fences
      // above every lease the account ever held - not just the old cell's - so
      // without this row both rules produce the same number and a regression to
      // per-cell fencing would stay green.
      await seedStaleLease(database, activeAccount, 99);
      const request = JSON.stringify({
        version: 1, organizationId: ORG, oldCellId: OLD_CELL, newCellId: NEW_CELL,
      });
      await database.query("begin");
      try {
        await database.query("set local role service_role");
        const first = await database.query(
          `select public.openclaw_service_acquire_migration_lease_v1($1::jsonb) as result`,
          [request],
        );
        expect(first.rows[0].result.movedAccounts).toBe(1);

        await database.query("reset role");
        const active = await database.query(
          `select account_id, cell_id, fencing_token from public.openclaw_runtime_leases
           where organization_id = $1 and account_id = $2
             and status = 'ACTIVE' and released_at is null`,
          [ORG, activeAccount],
        );
        // Scoped to the handed-over account on purpose: the OTHER account's lease
        // sits on its own cell and must NOT be touched by a per-cell handover.
        // The partial unique index allows exactly one active lease per account, so a
        // second ACTIVE row would have raised rather than reached this assertion.
        expect(active.rows).toHaveLength(1);
        const untouched = await database.query(
          `select cell_id from public.openclaw_runtime_leases
           where organization_id = $1 and account_id <> $2 and status = 'ACTIVE'`,
          [ORG, activeAccount],
        );
        expect(untouched.rows).toHaveLength(1);
        // The VALUE, not just the count: a handover that wrongly moved every account
        // in the organization would revoke this lease and mint a new ACTIVE one on
        // NEW_CELL - still exactly one row, so a length-only check stays green.
        expect(untouched.rows[0].cell_id).toBe(cellId(1, 1));
        expect(active.rows[0].cell_id).toBe(NEW_CELL);

        const previous = await database.query(
          `select max(fencing_token) as token from public.openclaw_runtime_leases
           where organization_id = $1 and account_id = $2 and status = 'REVOKED'`,
          [ORG, activeAccount],
        );
        // Guard the guard: `max()` over an empty set is NULL and `Number(null)` is 0,
        // so this comparison would pass vacuously if the revoke ever stopped happening.
        expect(previous.rows[0].token).not.toBeNull();
        expect(Number(previous.rows[0].token)).toBe(99);
        expect(Number(active.rows[0].fencing_token))
          .toBeGreaterThan(Number(previous.rows[0].token));

        await database.query("set local role service_role");
        const again = await database.query(
          `select public.openclaw_service_acquire_migration_lease_v1($1::jsonb) as result`,
          [request],
        );
        // A retried step after a lost response must not mint a second lease.
        expect(again.rows[0].result.movedAccounts).toBe(0);
        expect(again.rows[0].result.alreadyOnNewCell).toBe(1);
      } finally {
        await database.query("rollback");
      }
    });
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

  it("leaves a hash-chained audit entry for every step it performs", async () => {
    await withDatabase(async (database) => {
      await database.query("begin");
      let entries;
      try {
        await database.query("set local role service_role");
        for (const [facade, extra] of FACADES) {
          await database.query(
            `select public.${facade}($1::jsonb)`,
            [JSON.stringify({ version: 1, organizationId: ORG, ...extra })],
          );
        }
        // service_role has no read grant on the audit log, and should not: drop
        // back to the owning role to inspect what the facades wrote.
        await database.query("reset role");
        entries = await database.query(
          `select event_type, organization_sequence, previous_hash, event_hash,
                  redacted_evidence
           from public.openclaw_audit_events
           where organization_id = $1 and event_type = 'OPENCLAW_MIGRATION_STEP'
           order by organization_sequence`,
          [ORG],
        );
      } finally {
        // Read the rows BEFORE rolling back; the assertions run after.
        await database.query("rollback");
      }

      // One entry per step: these facades stop an organization's outbound and force
      // an org-wide QR re-login, so an untraceable invocation is unacceptable.
      expect(entries.rows).toHaveLength(FACADES.length);
      const steps = entries.rows.map((row) => row.redacted_evidence.step);
      expect(steps).toEqual([
        "global-stop", "drain-outbox", "freeze-outbox",
        "move-expired-dispatching-to-unknown", "reconcile-gaps-and-unknown",
      ]);

      // The chain must actually link, and the sequence must not skip.
      for (const [index, row] of entries.rows.entries()) {
        expect(row.redacted_evidence.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
        // Content-free: the request itself never enters the evidence.
        expect(Object.keys(row.redacted_evidence).sort()).toEqual([
          "actorId", "callerRole", "currentUser", "organizationId", "requestDigest",
          "requestId", "rolloutRunId", "rolloutStage", "sessionUser", "step", "version",
        ]);
        // Inside the evidence, which IS hash-chained. append_openclaw_audit_v1 hashes
        // previous_hash|sequence|event_type|evidence_hash, so the actor_id/request_id
        // COLUMNS sit outside the chain and could be edited without breaking it.
        expect(row.redacted_evidence).toHaveProperty("actorId");
        // The role is read from the session, so it reports what actually ran the
        // step - not what the request claimed. These calls used the service key.
        expect(row.redacted_evidence.callerRole).toBe("service_role");
        // No canonical rollout backs this fixture, and the record says so rather
        // than staying silent: that IS the planned/unplanned distinction.
        expect(row.redacted_evidence.rolloutRunId).toBeNull();
        // A service key carries no `sub`, so this is null on every call these
        // facades can currently receive. Pinned so the claim stays honest.
        expect(row.redacted_evidence.actorId).toBeNull();
        if (index === 0) continue;
        expect(row.previous_hash).toBe(entries.rows[index - 1].event_hash);
        expect(Number(row.organization_sequence))
          .toBe(Number(entries.rows[index - 1].organization_sequence) + 1);
      }
    });
  }, HARNESS_TIMEOUT);

  it("narrows the retention cron role without cutting what it already had", async () => {
    await withDatabase(async (database) => {
      const privileges = async (role, table) => (await database.query(
        `select privilege_type from information_schema.table_privileges
         where grantee = $1 and table_name = $2 order by privilege_type`,
        [role, table],
      )).rows.map((row) => row.privilege_type);

      // The cron KEEPS the access it had before this task. An earlier version of
      // this test asserted the opposite and locked in a production break: a blanket
      // revoke had stripped select/update on openclaw_outbox (granted by the RPC
      // surface) and select on control_states / runtime_credentials (granted by the
      // retention source loop), so smoke cleanup and retention scanning hit 42501.
      expect(await privileges("openclaw_maintenance_writer", "openclaw_outbox"))
        .toEqual(["SELECT", "UPDATE"]);
      for (const table of ["openclaw_control_states", "openclaw_runtime_credentials"]) {
        expect(await privileges("openclaw_maintenance_writer", table), table)
          .toContain("SELECT");
      }

      // But it does NOT keep the write verbs this task briefly handed it.
      expect(await privileges("openclaw_maintenance_writer", "openclaw_control_states"))
        .not.toContain("INSERT");
      expect(await privileges("openclaw_maintenance_writer", "openclaw_runtime_leases"))
        .toEqual([]);
      expect(await privileges("openclaw_maintenance_writer", "openclaw_accounts"))
        .toEqual([]);
      expect(await privileges("openclaw_maintenance_writer", "openclaw_qr_challenges"))
        .not.toContain("UPDATE");

      // And the migration surface really is owned by the dedicated role.
      const owners = await database.query(
        `select proname, pg_get_userbyid(proowner) as owner
         from pg_proc where proname in (
           'openclaw_set_global_stop_v1', 'openclaw_handover_leases_v1',
           'openclaw_require_fresh_qr_v1'
         )`,
      );
      expect(owners.rows.length).toBeGreaterThan(0);
      for (const row of owners.rows) expect(row.owner).toBe("openclaw_migration_writer");

      // The migration role must not be able to read the audit chain it appends to.
      expect(await privileges("openclaw_migration_writer", "openclaw_audit_events"))
        .toEqual([]);
    });
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);

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
  }, HARNESS_TIMEOUT);
});
