import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../../supabase/migrations/", import.meta.url);
const source = (name) => readFileSync(new URL(name, dir), "utf8");
function definition(sql, name) {
  const start = sql.search(
    new RegExp(
      `CREATE OR REPLACE FUNCTION\\s+${name.replace(".", "\\.")}\\s*\\(`,
      "i",
    ),
  );
  assert.notEqual(start, -1, `missing ${name}`);
  const tail = sql.slice(start),
    quote = tail.match(/\bAS\s+(\$[\w]*\$)/i);
  return tail.slice(
    0,
    tail.indexOf(
      ";",
      tail.indexOf(quote[1], quote.index + quote[0].length) + quote[1].length,
    ) + 1,
  );
}
const org = "dddd0000-0000-4000-8000-000000000001";
const actor = "dddd2000-0000-4000-8000-000000000001";
const building = "dddd1000-0000-4000-8000-000000000001";
const room = "dddd3000-0000-4000-8000-000000000001";
const listing = "dddd4000-0000-4000-8000-000000000001";
const other = "cccc0000-0000-4000-8000-000000000001";
const action = "room_pass.set_active";
const bootstrap = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256($1) $$;
CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql VOLATILE AS $$ SELECT decode(replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),'hex') $$;
CREATE FUNCTION app_private.copilot_payload_hash_v1(jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to($1::text,'UTF8')) $$;
CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, deleted_at timestamptz);
CREATE TABLE public.rooms(id uuid PRIMARY KEY, building_id uuid REFERENCES buildings, organization_id uuid, name text, deleted_at timestamptz);
CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY, user_id uuid NOT NULL, organization_id uuid, building_id uuid REFERENCES buildings, room_id uuid REFERENCES rooms, active boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), contact_name text, contact_phone text);
CREATE UNIQUE INDEX room_pass_listings_room_active_uniq ON public.room_pass_listings(room_id) WHERE active;
CREATE TABLE app_private.copilot_write_confirmations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nonce_digest bytea UNIQUE NOT NULL,user_id uuid NOT NULL, organization_id uuid NOT NULL,tool text NOT NULL,payload_hash bytea NOT NULL,permission_key text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE TABLE public.ai_write_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,organization_id uuid NOT NULL,tool text NOT NULL,idempotency_key text UNIQUE NOT NULL,entity_table text,entity_id uuid,payload jsonb);
CREATE TABLE app_private.copilot_action_registry(action_id text PRIMARY KEY,version integer,label_vi text,permission_key text,risk text,executor_kind text,consent_required text,preview_rpc text,execute_rpc text,verify_kind text,produces_entity_table text,consumes_ref_table text,rollback_rpc text,rollback_note text,flag_contract_id text,enabled boolean);
CREATE TABLE public.copilot_feature_flags(scope text,contract_id text,state text,reason text,evidence_link text,rollback_reference text,canary_org uuid,expires_at timestamptz,PRIMARY KEY(scope,contract_id));
CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz DEFAULT now(),expires_at timestamptz);
CREATE TABLE app_private.fixture_policy(role_allowed boolean,org_wide boolean,building_ids uuid[],domain_allowed boolean);
INSERT INTO app_private.fixture_policy VALUES(true,false,ARRAY['${building}'::uuid],true);
CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT role_allowed FROM app_private.fixture_policy $$;
CREATE FUNCTION app_private.copilot_plan_role_allowed_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT role_allowed FROM app_private.fixture_policy $$;
CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT p.org_wide,p.building_ids,ARRAY[]::uuid[] FROM app_private.fixture_policy p WHERE $1='sale_phong.manage_pass_listings' AND $2='${org}' $$;
CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT domain_allowed FROM app_private.fixture_policy $$;
CREATE TABLE app_private.test_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payload jsonb);
CREATE FUNCTION app_private.copilot_ledger_append_v1(jsonb) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE v_id uuid; BEGIN INSERT INTO app_private.test_ledger(payload) VALUES($1) RETURNING id INTO v_id; RETURN v_id; END $$;
INSERT INTO public.buildings VALUES('${building}','${org}','Toà thử',NULL);
INSERT INTO public.rooms VALUES('${room}','${building}','${org}','Phòng thử',NULL);
INSERT INTO public.room_pass_listings VALUES('${listing}','${other}','${org}','${building}','${room}',false,now(),'PRIVATE CONTACT','PRIVATE PHONE');
SELECT set_config('request.jwt.claim.sub','${actor}',false);
`;
async function setup() {
  const db = new PGlite();
  try {
    await db.exec(bootstrap);
    const domain = source("20260617090000_room_pass_listings.sql");
    await db.exec(definition(domain, "public.can_manage_pass_listing"));
    await db.exec(definition(domain, "public.set_room_pass_listing_active"));
    await db.exec(
      definition(
        source("20260903043956_copilot_action_registry_policy_ledger_v1.sql"),
        "app_private.copilot_action_gate_v1",
      ),
    );
    const migration = readdirSync(dir).find((n) =>
      n.endsWith("_copilot_action_room_pass_active_v1.sql"),
    );
    assert.ok(migration, "room-pass migration must exist");
    await db.exec(source(migration));
    await db.exec(source(migration)); // Forward migration replay in the isolated fixture.
    assert.equal(
      (
        await db.query(
          `SELECT state FROM copilot_feature_flags WHERE contract_id=$1`,
          [action],
        )
      ).rows[0].state,
      "disabled",
    );
    await db.exec(`UPDATE copilot_feature_flags SET state='enabled'`);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function preview(db, active = true, organization = org, id = listing) {
  return (
    await db.query(
      "SELECT public.copilot_preview_room_pass_active_v1($1::uuid,$2::jsonb) result",
      [organization, { listing_id: id, active }],
    )
  ).rows[0].result;
}
async function execute(db, p, payload = p.canonical) {
  return (
    await db.query(
      "SELECT public.copilot_execute_room_pass_active_v1($1,$2::jsonb) result",
      [p.confirmation_nonce, payload],
    )
  ).rows[0].result;
}
async function state(db) {
  return (
    await db.query(
      `SELECT active,(SELECT count(*)::int FROM ai_write_audit) audits,(SELECT count(*)::int FROM app_private.test_ledger) ledger FROM room_pass_listings WHERE id='${listing}'`,
    )
  ).rows[0];
}
test("canonical setter supports activate/deactivate/retoggle with one audit per fresh consent and safe results", async () => {
  const db = await setup();
  try {
    for (const active of [true, false, true]) {
      const p = await preview(db, active),
        again = await preview(db, active);
      assert.deepEqual(p.canonical, again.canonical);
      assert.notEqual(p.confirmation_nonce, again.confirmation_nonce);
      assert.equal(p.preview.trang_thai_cu, !active);
      assert.equal(p.preview.trang_thai_moi, active);
      const result = await execute(db, p);
      assert.equal(result.entity_id, listing);
      assert.equal(result.entity_table, "room_pass_listings");
      assert.ok(result.audit_id);
      assert.equal((await state(db)).active, active);
      await assert.rejects(execute(db, p), /confirmation_already_used/);
      // Sequential consumption check, not independent-session race evidence.
      await assert.rejects(execute(db, again), /payload_changed/);
      assert.doesNotMatch(
        JSON.stringify([p, result]),
        /PRIVATE|contact_phone|contact_name/,
      );
    }
    assert.deepEqual(await state(db), { active: true, audits: 3, ledger: 3 });
    const rows = (
      await db.query(
        "SELECT payload FROM ai_write_audit UNION ALL SELECT payload FROM app_private.test_ledger",
      )
    ).rows;
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE|contact_phone|contact_name/,
    );
    assert.equal(
      (
        await db.query(`SELECT count(*)::int n FROM ai_write_audit a JOIN app_private.copilot_write_confirmations c
      ON a.idempotency_key='copilot_action:room_pass.set_active:'||c.id::text WHERE c.consumed_at IS NOT NULL`)
      ).rows[0].n,
      3,
    );
  } finally {
    await db.close();
  }
});
test("all current boundaries deny preview and revoked execution without mutation", async () => {
  const db = await setup();
  try {
    const scenarios = [
      [
        `UPDATE app_private.fixture_policy SET role_allowed=false`,
        `UPDATE app_private.fixture_policy SET role_allowed=true`,
        /not_permitted/,
      ],
      [
        `UPDATE app_private.fixture_policy SET building_ids=ARRAY['${other}'::uuid]`,
        `UPDATE app_private.fixture_policy SET building_ids=ARRAY['${building}'::uuid]`,
        /not_permitted/,
      ],
      [
        `UPDATE app_private.fixture_policy SET domain_allowed=false`,
        `UPDATE app_private.fixture_policy SET domain_allowed=true`,
        /not_permitted/,
      ],
      [
        `UPDATE copilot_feature_flags SET state='disabled'`,
        `UPDATE copilot_feature_flags SET state='enabled'`,
        /copilot_action_disabled/,
      ],
      [
        `INSERT INTO app_private.tenant_emergency_denies(organization_id) VALUES('${org}')`,
        `DELETE FROM app_private.tenant_emergency_denies`,
        /tenant_emergency_denied/,
      ],
    ];
    for (const [deny, restore, error] of scenarios) {
      const p = await preview(db);
      await db.exec(deny);
      await assert.rejects(preview(db), error);
      await assert.rejects(execute(db, p), error);
      await db.exec(restore);
    }
    await assert.rejects(preview(db, true, other), /not_permitted/);
    for (const table of ["room_pass_listings", "rooms", "buildings"]) {
      const p = await preview(db);
      await db.exec(`UPDATE ${table} SET organization_id=NULL`);
      await assert.rejects(preview(db), /entity_not_found/);
      await assert.rejects(execute(db, p), /entity_not_found/);
      await db.exec(`UPDATE ${table} SET organization_id='${org}'`);
    }
    assert.deepEqual(await state(db), { active: false, audits: 0, ledger: 0 });
  } finally {
    await db.close();
  }
});

test("public ABI ACL is authenticated-only; internal observer is inaccessible and identity is bound", async () => {
  const db = await setup();
  try {
    const names = [
      "public.copilot_preview_room_pass_active_v1(uuid,jsonb)",
      "public.copilot_execute_room_pass_active_v1(text,jsonb)",
      "app_private.copilot_room_pass_observe_v1(uuid,jsonb)",
    ];
    for (const name of names) {
      const info = (
        await db.query(
          `SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure`,
          [name],
        )
      ).rows[0];
      assert.equal(info.prosecdef, true);
      assert.equal(info.provolatile, "v");
      assert.deepEqual(info.proconfig, [
        "search_path=pg_catalog, public, app_private, extensions",
      ]);
      for (const role of ["anon", "service_role", "authenticated"]) {
        assert.equal(
          (
            await db.query(
              `SELECT has_function_privilege($1,$2,'EXECUTE') allowed`,
              [role, name],
            )
          ).rows[0].allowed,
          role === "authenticated" && name.startsWith("public."),
        );
      }
    }
    // Real SET ROLE checks entrypoint ACL and SECURITY DEFINER behavior, while
    // controlled helper state tests policy decisions (not live membership/RLS).
    await db.exec("SET ROLE authenticated");
    const p = await preview(db);
    await execute(db, p);
    await assert.rejects(
      db.query("SELECT app_private.copilot_room_pass_observe_v1($1,$2)", [
        org,
        { listing_id: listing, active: false },
      ]),
      /permission denied/,
    );
    await db.exec("RESET ROLE");
    for (const [column, value, error] of [
      ["tool", "other.action", /confirmation_contract_mismatch/],
      ["permission_key", "other.permission", /confirmation_contract_mismatch/],
      ["organization_id", other, /organization_mismatch/],
    ]) {
      const next = await preview(db, false);
      await db.query(
        `UPDATE app_private.copilot_write_confirmations SET ${column}=$1 WHERE nonce_digest=extensions.digest(decode($2,'hex'),'sha256')`,
        [value, next.confirmation_nonce],
      );
      await assert.rejects(execute(db, next), error);
    }
    assert.equal((await state(db)).audits, 1);
  } finally {
    await db.close();
  }
});
test("nonce binding, expiry, payload, stale revision and same-transaction ABA fail closed", async () => {
  const db = await setup();
  try {
    const p = await preview(db);
    await assert.rejects(
      execute(db, p, { ...p.canonical, active: false }),
      /payload_changed/,
    );
    await assert.rejects(
      execute(db, { ...p, confirmation_nonce: "bad" }),
      /confirmation_required/,
    );
    await assert.rejects(
      execute(db, { ...p, confirmation_nonce: "11".repeat(32) }),
      /confirmation_not_found/,
    );
    await db.exec(
      `SELECT set_config('request.jwt.claim.sub','${other}',false)`,
    );
    await assert.rejects(execute(db, p), /confirmation_not_found/);
    await db.exec(
      `SELECT set_config('request.jwt.claim.sub','${actor}',false)`,
    );
    await db.exec(
      `UPDATE app_private.copilot_write_confirmations SET expires_at=now()-interval '1 minute'`,
    );
    await assert.rejects(execute(db, p), /confirmation_expired/);
    await db.exec("BEGIN");
    const stale = await preview(db);
    await db.exec(
      `SELECT set_room_pass_listing_active('${listing}',true); SELECT set_room_pass_listing_active('${listing}',false)`,
    );
    assert.notDeepEqual((await preview(db)).canonical, stale.canonical);
    await assert.rejects(execute(db, stale), /payload_changed/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await state(db), { active: false, audits: 0, ledger: 0 });
  } finally {
    await db.close();
  }
});
test("unique activation conflict atomically rolls back nonce, audit and canonical mutation", async () => {
  const db = await setup();
  try {
    const p = await preview(db);
    await db.exec(
      `INSERT INTO room_pass_listings(id,user_id,organization_id,building_id,room_id,active) VALUES('${other}','${actor}','${org}','${building}','${room}',true)`,
    );
    await assert.rejects(execute(db, p), /room_pass_listings_room_active_uniq/);
    assert.deepEqual(await state(db), { active: false, audits: 0, ledger: 0 });
    assert.equal(
      (
        await db.query(
          "SELECT consumed_at FROM app_private.copilot_write_confirmations",
        )
      ).rows[0].consumed_at,
      null,
    );
    await db.exec(`SELECT set_room_pass_listing_active('${other}',false)`);
    await execute(db, p);
    assert.equal((await state(db)).active, true);
  } finally {
    await db.close();
  }
});

async function installPlan(db) {
  await db.exec(`
    CREATE TABLE app_private.copilot_action_policy(id boolean PRIMARY KEY,max_direct_risk text,revision bigint);
    INSERT INTO app_private.copilot_action_policy VALUES(true,'L3',7);
    CREATE TABLE app_private.copilot_plans(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,execute_deadline timestamptz,expires_at timestamptz,version integer,consent_confirmation_id uuid,consent_kind text,step_up_confirmation_id uuid,standing_grant_ids uuid[],policy_revision bigint,failure_reason text,updated_at timestamptz);
    CREATE TABLE app_private.copilot_plan_steps(plan_id uuid,step_no integer,action_id text,action_version integer,permission_key text,canonical jsonb,payload_digest bytea,payload jsonb,status text,ref_step integer,outcome jsonb,error_code text,error_detail text,executed_at timestamptz,ledger_id uuid,PRIMARY KEY(plan_id,step_no));
    CREATE TABLE app_private.copilot_standing_grants(id uuid PRIMARY KEY,revoked_at timestamptz,expires_at timestamptz);
    CREATE FUNCTION app_private.copilot_action_flag_allows_v1(text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='copilot.execution_plan' AND $2='${org}' $$;
  `);
  await db.exec(
    definition(
      source("20260903212610_copilot_action_zalo_phat_song_v1.sql"),
      "public.copilot_plan_execute_step_v1",
    ),
  );
}
async function createPlan(db, active) {
  const p = await preview(db, active);
  const id = (
    await db.query(`INSERT INTO app_private.copilot_plans(id,user_id,organization_id,status,execute_deadline,expires_at,version,consent_kind,policy_revision,updated_at)
    VALUES(gen_random_uuid(),'${actor}','${org}','APPROVED',now()+interval '5 minutes',now()+interval '5 minutes',1,'click',7,now()) RETURNING id`)
  ).rows[0].id;
  await db.query(
    `INSERT INTO app_private.copilot_plan_steps(plan_id,step_no,action_id,action_version,permission_key,canonical,payload_digest,payload,status)
    VALUES($1,1,'room_pass.set_active',1,'sale_phong.manage_pass_listings',$2::jsonb,app_private.copilot_payload_hash_v1($2::jsonb),$3::jsonb,'PENDING')`,
    [id, p.canonical, { listing_id: listing, active }],
  );
  return id;
}
const runPlan = (db, id) =>
  db
    .query(
      "SELECT copilot_plan_execute_step_v1($1::uuid,1,1,$2::uuid) result",
      [id, org],
    )
    .then((r) => r.rows[0].result);

test("post-lock boundary rejects emergency activation and flag expiry after transaction start", async () => {
  const db = await setup();
  try {
    const cases = [
      [
        "UPDATE copilot_feature_flags SET expires_at=clock_timestamp()",
        /copilot_action_disabled/,
      ],
      [
        `INSERT INTO app_private.tenant_emergency_denies(organization_id,permission_key,active_from)
        VALUES('${org}',NULL,clock_timestamp())`,
        /tenant_emergency_denied/,
      ],
      [
        `INSERT INTO app_private.tenant_emergency_denies(organization_id,permission_key,active_from,expires_at)
        VALUES('${org}','sale_phong.manage_pass_listings',clock_timestamp(),clock_timestamp()+interval '1 day')`,
        /tenant_emergency_denied/,
      ],
    ];
    for (const [transition, expected] of cases) {
      const p = await preview(db);
      await db.exec("BEGIN");
      try {
        // Separate the wall clock from transaction start even on coarse clocks.
        // This is a temporal-predicate probe, not a concurrent-session test.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await db.exec(transition);
        // Assert in PostgreSQL: JS Date truncates PostgreSQL microseconds.
        assert.equal(
          (
            await db.query(`SELECT EXISTS(
          SELECT 1 FROM copilot_feature_flags WHERE expires_at>transaction_timestamp() AND expires_at<=clock_timestamp()
          UNION ALL SELECT 1 FROM app_private.tenant_emergency_denies WHERE active_from>transaction_timestamp() AND active_from<=clock_timestamp()
        ) matches`)
          ).rows[0].matches,
          true,
        );
        await db.exec("SAVEPOINT before_execute");
        await assert.rejects(execute(db, p), expected);
        await db.exec("ROLLBACK TO SAVEPOINT before_execute");
        assert.deepEqual(await state(db), {
          active: false,
          audits: 0,
          ledger: 0,
        });
        assert.equal(
          (
            await db.query(
              `SELECT consumed_at FROM app_private.copilot_write_confirmations
          WHERE nonce_digest=extensions.digest(decode($1,'hex'),'sha256')`,
              [p.confirmation_nonce],
            )
          ).rows[0].consumed_at,
          null,
        );
      } finally {
        await db.exec("ROLLBACK");
      }
    }
  } finally {
    await db.close();
  }
});

test("wall-clock emergency checks retain future, expired and unrelated permission/org exclusions", async () => {
  const db = await setup();
  try {
    const cases = [
      `INSERT INTO app_private.tenant_emergency_denies(organization_id,active_from) VALUES('${org}',clock_timestamp()+interval '1 day')`,
      `INSERT INTO app_private.tenant_emergency_denies(organization_id,active_from,expires_at) VALUES('${org}',clock_timestamp(),clock_timestamp())`,
      `INSERT INTO app_private.tenant_emergency_denies(organization_id,permission_key,active_from) VALUES('${org}','other.permission',clock_timestamp())`,
      `INSERT INTO app_private.tenant_emergency_denies(organization_id,active_from) VALUES('${other}',clock_timestamp())`,
      `UPDATE copilot_feature_flags SET expires_at=clock_timestamp()+interval '1 day'`,
    ];
    for (const transition of cases) {
      const p = await preview(db);
      await db.exec("BEGIN");
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await db.exec(transition);
        const result = await execute(db, p);
        assert.equal(result.active, true);
        assert.deepEqual(await state(db), {
          active: true,
          audits: 1,
          ledger: 1,
        });
      } finally {
        await db.exec("ROLLBACK");
      }
    }
  } finally {
    await db.close();
  }
});

test("actual generic plan step re-previews unchanged canonical, reads back and CAS-rejects repeated execution", async () => {
  const db = await setup();
  try {
    await installPlan(db);
    for (const active of [true, false, true]) {
      const id = await createPlan(db, active),
        result = await runPlan(db, id);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.step.status, "DONE");
      assert.ok(result.step.outcome.audit_id);
      assert.equal(result.step.outcome.entity_id, listing);
      await assert.rejects(runPlan(db, id), /plan_not_approved/);
      assert.equal((await state(db)).active, active);
    }
    assert.deepEqual(await state(db), { active: true, audits: 3, ledger: 6 });
    const rows = (
      await db.query("SELECT outcome FROM app_private.copilot_plan_steps")
    ).rows;
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE|contact_phone|contact_name/,
    );
  } finally {
    await db.close();
  }
});
test("actual plan re-preview refuses changed state and rolls back a conflicting action with durable step failure only", async () => {
  const db = await setup();
  try {
    await installPlan(db);
    const stale = await createPlan(db, true);
    await db.exec(
      `SELECT set_room_pass_listing_active('${listing}',true); SELECT set_room_pass_listing_active('${listing}',false)`,
    );
    const result = await runPlan(db, stale);
    assert.equal(result.ok, false);
    assert.equal(result.step.error_code, "payload_changed");
    assert.deepEqual(await state(db), { active: false, audits: 0, ledger: 1 });
    const conflict = await createPlan(db, true);
    await db.exec(
      `INSERT INTO room_pass_listings(id,user_id,organization_id,building_id,room_id,active) VALUES('${other}','${actor}','${org}','${building}','${room}',true)`,
    );
    const failed = await runPlan(db, conflict);
    assert.equal(failed.ok, false);
    assert.equal(failed.step.status, "FAILED");
    assert.deepEqual(await state(db), { active: false, audits: 0, ledger: 2 });
    assert.equal(
      (
        await db.query(
          `SELECT count(*)::int n FROM app_private.copilot_write_confirmations WHERE consumed_at IS NOT NULL`,
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
