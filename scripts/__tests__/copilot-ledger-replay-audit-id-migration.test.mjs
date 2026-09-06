import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL(
  '../../supabase/migrations/20260906182318_copilot_ledger_replay_audit_id_v1.sql',
  import.meta.url,
);
const legacySource = readFileSync(
  new URL('../../supabase/migrations/20260830171108_copilot_income_expense_rpc_hardening_v1.sql', import.meta.url),
  'utf8',
);
const wrapperSource = readFileSync(
  new URL('../../supabase/migrations/20260903072353_copilot_action_income_expense_annotate_v1.sql', import.meta.url),
  'utf8',
);
const planSource = readFileSync(
  new URL('../../supabase/migrations/20260903212610_copilot_action_zalo_phat_song_v1.sql', import.meta.url),
  'utf8',
);

const org = 'dddd0000-0000-4000-8000-000000000001';
const otherOrg = 'cccc0000-0000-4000-8000-000000000001';
const actor = 'dddd2000-0000-4000-8000-000000000001';
const otherActor = 'cccc2000-0000-4000-8000-000000000001';
const building = 'dddd1000-0000-4000-8000-000000000001';
const typeId = 'dddd3000-0000-4000-8000-000000000001';
const payload = {
  organization_id: org,
  building_id: building,
  type_id: typeId,
  type: 'EXPENSE',
  name: 'Chi phi test replay',
  amount: 125000,
  voucher_date: '2026-09-06',
};

function functionDefinition(source, schema, name) {
  const start = source.search(
    new RegExp(`CREATE OR REPLACE FUNCTION\\s+${schema}\\.${name}\\s*\\(`, 'i'),
  );
  assert.notEqual(start, -1, `missing ${schema}.${name}`);
  const tail = source.slice(start);
  const as = tail.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  assert.ok(as, `missing dollar quote for ${schema}.${name}`);
  const close = tail.indexOf(as[1], as.index + as[0].length);
  assert.notEqual(close, -1, `unterminated ${schema}.${name}`);
  const semicolon = tail.indexOf(';', close + as[1].length);
  assert.notEqual(semicolon, -1, `missing semicolon for ${schema}.${name}`);
  return tail.slice(0, semicolon + 1);
}

const legacyDefinition = functionDefinition(
  legacySource,
  'public',
  'copilot_execute_income_expense_v1',
).replace(
  'public.copilot_execute_income_expense_v1(',
  'public.copilot_execute_income_expense_legacy_v1(',
);
const wrapperDefinition = functionDefinition(
  wrapperSource,
  'public',
  'copilot_execute_income_expense_v1',
);
const planDefinition = functionDefinition(
  planSource,
  'public',
  'copilot_plan_execute_step_v1',
);

const bootstrap = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE function_owner;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA app_private;
CREATE FUNCTION extensions.digest(p_value bytea, p_algorithm text)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT pg_catalog.sha256(p_value) $$;
CREATE FUNCTION extensions.gen_random_uuid()
RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;
CREATE FUNCTION extensions.gen_random_bytes(p_size integer)
RETURNS bytea LANGUAGE sql VOLATILE AS $$
  SELECT substring(
    decode(
      replace(gen_random_uuid()::text, '-', '') ||
      replace(gen_random_uuid()::text, '-', ''),
      'hex'
    )
    FROM 1 FOR p_size
  )
$$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  raw_user_meta_data jsonb,
  email text
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.buildings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.income_expense_types (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  type text NOT NULL,
  system_only boolean NOT NULL DEFAULT false,
  is_restricted boolean NOT NULL DEFAULT false
);
CREATE TABLE public.income_expenses (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  building_id uuid NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  voucher_date date NOT NULL,
  approval_status text NOT NULL DEFAULT 'UNAPPROVED',
  posting_status text NOT NULL DEFAULT 'UNPOSTED',
  account_id uuid,
  active_posting_id_v2 uuid,
  posting_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  repeat_cycle text NOT NULL DEFAULT 'NONE',
  repeat_next_date date,
  repeat_parent_id uuid
);
CREATE TABLE public.income_expense_items (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  organization_id uuid NOT NULL,
  income_expense_id uuid NOT NULL,
  income_expense_type_id uuid NOT NULL,
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  amount numeric
);
CREATE TABLE public.ai_write_audit (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id uuid NOT NULL,
  tool text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  entity_table text,
  entity_id uuid,
  payload jsonb NOT NULL,
  organization_id uuid NOT NULL
);
CREATE TABLE app_private.copilot_write_confirmations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  nonce_digest bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  tool text NOT NULL,
  payload_hash bytea NOT NULL,
  permission_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE app_private.copilot_ie_writer_context_v1 (
  transaction_id text PRIMARY KEY,
  actor_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  context_name text NOT NULL,
  marker_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION app_private.copilot_payload_hash_v1(p_payload jsonb)
RETURNS bytea LANGUAGE sql IMMUTABLE AS
$$ SELECT extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256') $$;
CREATE FUNCTION public.can_create_restricted_ie()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION app_private.authorized_scope_v3(text, uuid)
RETURNS TABLE(org_wide boolean, building_ids uuid[]) LANGUAGE sql STABLE AS
$$ SELECT true, ARRAY[]::uuid[] $$;
CREATE FUNCTION app_private.copilot_ie_writer_ready_v1(uuid, uuid, text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT true $$;
CREATE FUNCTION public.ie_compat_insert_v2(p_row jsonb, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $writer$
DECLARE v_id uuid := extensions.gen_random_uuid(); v_item jsonb;
BEGIN
  INSERT INTO public.income_expenses(
    id, user_id, organization_id, building_id, type, name, voucher_date,
    approval_status, posting_status, account_id, repeat_cycle
  ) VALUES (
    v_id, (p_row->>'user_id')::uuid, (p_row->>'organization_id')::uuid,
    (p_row->>'building_id')::uuid, p_row->>'type', p_row->>'name',
    (p_row->>'voucher_date')::date, 'UNAPPROVED', 'UNPOSTED', NULL, 'NONE'
  );
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.income_expense_items(
      organization_id, income_expense_id, income_expense_type_id,
      quantity, unit_price, amount
    ) VALUES (
      (v_item->>'organization_id')::uuid, v_id,
      (v_item->>'income_expense_type_id')::uuid,
      (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric, NULL
    );
  END LOOP;
  RETURN jsonb_build_object('id', v_id);
END
$writer$;

INSERT INTO auth.users VALUES ('${actor}', '{"full_name":"Fixture actor"}', 'fixture@example.test');
INSERT INTO public.buildings VALUES ('${building}', '${org}', NULL);
INSERT INTO public.income_expense_types VALUES ('${typeId}', '${org}', 'expense', false, false);
SELECT set_config('request.jwt.claim.sub', '${actor}', false);
`;

async function setup({ withPlan = false } = {}) {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(legacyDefinition);
  await db.exec(`
    ALTER FUNCTION public.copilot_execute_income_expense_legacy_v1(text, jsonb)
      OWNER TO function_owner;
    GRANT USAGE ON SCHEMA public, auth, app_private, extensions TO function_owner;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, auth, app_private
      TO function_owner;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth, app_private, extensions
      TO function_owner;
    REVOKE ALL ON FUNCTION public.copilot_execute_income_expense_legacy_v1(text, jsonb)
      FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_income_expense_legacy_v1(text, jsonb)
      TO authenticated;
  `);
  if (withPlan) await installPlanSurface(db);
  return db;
}

async function installPlanSurface(db) {
  await db.exec(`
    CREATE TABLE app_private.copilot_action_registry (
      action_id text PRIMARY KEY, enabled boolean NOT NULL, version integer NOT NULL,
      executor_kind text NOT NULL, risk text NOT NULL, preview_rpc text NOT NULL,
      execute_rpc text NOT NULL, produces_entity_table text, verify_kind text NOT NULL,
      permission_key text NOT NULL
    );
    CREATE TABLE app_private.copilot_action_policy (
      id boolean PRIMARY KEY DEFAULT true, max_direct_risk text NOT NULL, revision bigint NOT NULL
    );
    CREATE TABLE app_private.copilot_plans (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, organization_id uuid NOT NULL,
      status text NOT NULL, execute_deadline timestamptz, expires_at timestamptz,
      version integer NOT NULL, consent_confirmation_id uuid, consent_kind text,
      step_up_confirmation_id uuid, standing_grant_ids uuid[], policy_revision bigint,
      failure_reason text, updated_at timestamptz
    );
    CREATE TABLE app_private.copilot_plan_steps (
      plan_id uuid NOT NULL, step_no integer NOT NULL, action_id text NOT NULL,
      action_version integer NOT NULL, permission_key text NOT NULL,
      canonical jsonb, payload_digest bytea, payload jsonb, status text NOT NULL,
      ref_step integer, outcome jsonb, error_code text, error_detail text,
      executed_at timestamptz, ledger_id uuid, PRIMARY KEY(plan_id, step_no)
    );
    CREATE TABLE app_private.copilot_standing_grants (
      id uuid PRIMARY KEY, revoked_at timestamptz, expires_at timestamptz
    );
    CREATE TABLE app_private.test_ledger (
      id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(), payload jsonb NOT NULL
    );
    CREATE FUNCTION app_private.copilot_ie_type_allowed_v1(uuid, text, uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.copilot_plan_role_allowed_v1(uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.copilot_action_gate_v1(text, uuid)
    RETURNS jsonb LANGUAGE sql VOLATILE AS $$ SELECT '{"allowed":true}'::jsonb $$;
    CREATE FUNCTION app_private.copilot_ledger_append_v1(p_payload jsonb)
    RETURNS uuid LANGUAGE plpgsql VOLATILE AS $ledger$
    DECLARE v_id uuid;
    BEGIN
      INSERT INTO app_private.test_ledger(payload) VALUES (p_payload) RETURNING id INTO v_id;
      RETURN v_id;
    END
    $ledger$;
    CREATE FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, integer)
    RETURNS jsonb LANGUAGE sql VOLATILE AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.copilot_preview_income_expense_v1(p_org uuid, p_payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $preview$
    DECLARE v_nonce bytea := extensions.gen_random_bytes(32);
    BEGIN
      INSERT INTO app_private.copilot_write_confirmations(
        nonce_digest, user_id, organization_id, tool, payload_hash,
        permission_key, expires_at
      ) VALUES (
        extensions.digest(v_nonce, 'sha256'), auth.uid(), p_org,
        'tao_phieu_thu_chi_nhap', app_private.copilot_payload_hash_v1(p_payload),
        'income_expenses.create', clock_timestamp() + interval '5 minutes'
      );
      RETURN jsonb_build_object('confirmation_nonce', encode(v_nonce, 'hex'), 'canonical', p_payload);
    END
    $preview$;
  `);
  await db.exec(wrapperDefinition);
  await db.exec(planDefinition);
}

async function apply(db) {
  await db.exec(readFileSync(migration, 'utf8'));
}

async function issueNonce(db, nonceHex, issuedPayload = payload, options = {}) {
  await db.query(`
    INSERT INTO app_private.copilot_write_confirmations(
      nonce_digest, user_id, organization_id, tool, payload_hash,
      permission_key, expires_at
    ) VALUES (
      extensions.digest(decode($1, 'hex'), 'sha256'), $2::uuid, $3::uuid,
      'tao_phieu_thu_chi_nhap', app_private.copilot_payload_hash_v1($4::jsonb),
      'income_expenses.create', clock_timestamp() + interval '5 minutes'
    )
  `, [nonceHex, options.userId ?? actor, options.organizationId ?? org, issuedPayload]);
}

async function execute(db, nonceHex, executionPayload = payload, name = 'copilot_execute_income_expense_legacy_v1') {
  return (await db.query(`SELECT public.${name}($1, $2::jsonb) AS result`, [nonceHex, executionPayload])).rows[0].result;
}

async function counts(db) {
  return (await db.query(`SELECT
    (SELECT count(*)::integer FROM public.income_expenses) vouchers,
    (SELECT count(*)::integer FROM public.income_expense_items) items,
    (SELECT count(*)::integer FROM public.ai_write_audit) audits
  `)).rows[0];
}

test('fresh nonce replay returns the exact original audit without another business or audit write', { timeout: 20_000 }, async () => {
  const db = await setup();
  try {
    await apply(db);
    const firstNonce = '11'.repeat(32);
    await issueNonce(db, firstNonce);
    const first = await execute(db, firstNonce);
    assert.equal(first.status, 'da_tao');
    assert.ok(first.entity_id);
    assert.ok(first.audit_id);
    assert.deepEqual(await counts(db), { vouchers: 1, items: 1, audits: 1 });

    const replayNonce = '22'.repeat(32);
    await issueNonce(db, replayNonce);
    const replay = await execute(db, replayNonce);
    assert.equal(replay.status, 'da_tao_truoc_do');
    assert.equal(replay.entity_id, first.entity_id);
    assert.equal(replay.audit_id, first.audit_id);
    assert.ok(replay.created_at);
    assert.deepEqual(await counts(db), { vouchers: 1, items: 1, audits: 1 });
  } finally {
    await db.close();
  }
});

test('replay rejects actor, organization, nonce and payload mismatches without leaking audit identity', { timeout: 20_000 }, async () => {
  const db = await setup();
  try {
    await apply(db);
    await issueNonce(db, '31'.repeat(32));
    const first = await execute(db, '31'.repeat(32));
    const before = await counts(db);

    const cases = [
      {
        nonce: '32'.repeat(32),
        prepare: () => issueNonce(db, '32'.repeat(32), payload, { userId: otherActor }),
        expected: /confirmation_not_found/,
      },
      {
        nonce: '33'.repeat(32),
        prepare: () => issueNonce(db, '33'.repeat(32), payload, { organizationId: otherOrg }),
        expected: /organization_mismatch/,
      },
      {
        nonce: '34'.repeat(32),
        prepare: async () => {},
        expected: /confirmation_not_found/,
      },
      {
        nonce: '35'.repeat(32),
        prepare: () => issueNonce(db, '35'.repeat(32)),
        executionPayload: { ...payload, amount: 125001 },
        expected: /payload_changed/,
      },
    ];
    for (const scenario of cases) {
      await scenario.prepare();
      await assert.rejects(
        execute(db, scenario.nonce, scenario.executionPayload),
        error => scenario.expected.test(String(error)) && !String(error).includes(first.audit_id),
      );
      assert.deepEqual(await counts(db), before);
    }

    for (const [column, value] of [['user_id', otherActor], ['organization_id', otherOrg]]) {
      await db.query(`UPDATE public.ai_write_audit SET ${column} = $1::uuid`, [value]);
      const nonce = column === 'user_id' ? '36'.repeat(32) : '37'.repeat(32);
      await issueNonce(db, nonce);
      await assert.rejects(
        execute(db, nonce),
        error => /copilot_audit_mismatch/.test(String(error)) && !String(error).includes(first.audit_id),
      );
      await db.query(`UPDATE public.ai_write_audit SET ${column} = $1::uuid`, [column === 'user_id' ? actor : org]);
      assert.deepEqual(await counts(db), before);
    }
  } finally {
    await db.close();
  }
});

test('replay fails closed when the original entity is missing', { timeout: 20_000 }, async () => {
  const db = await setup();
  try {
    await apply(db);
    await issueNonce(db, '41'.repeat(32));
    const first = await execute(db, '41'.repeat(32));
    await db.query('DELETE FROM public.income_expense_items WHERE income_expense_id = $1', [first.entity_id]);
    await db.query('DELETE FROM public.income_expenses WHERE id = $1', [first.entity_id]);
    await issueNonce(db, '42'.repeat(32));
    await assert.rejects(
      execute(db, '42'.repeat(32)),
      error => /copilot_audit_mismatch/.test(String(error)) && !String(error).includes(first.audit_id),
    );
    assert.deepEqual(await counts(db), { vouchers: 0, items: 0, audits: 1 });
  } finally {
    await db.close();
  }
});

test('actual wrapper and plan executor propagate replay audit_id with one original execution only', { timeout: 20_000 }, async () => {
  const db = await setup({ withPlan: true });
  try {
    await apply(db);
    await issueNonce(db, '51'.repeat(32));
    const first = await execute(db, '51'.repeat(32), payload, 'copilot_execute_income_expense_v1');
    assert.equal(first.status, 'da_tao');

    const planId = 'dddd4000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO app_private.copilot_action_registry VALUES (
        'income_expense.create_draft', true, 1, 'nonce_abi_v1', 'L4',
        'copilot_preview_income_expense_v1', 'copilot_execute_income_expense_v1',
        'income_expenses', 'ie_draft', 'income_expenses.create'
      );
      INSERT INTO app_private.copilot_action_policy VALUES (true, 'L5', 7);
    `);
    await db.query(`
      INSERT INTO app_private.copilot_plans(
        id, user_id, organization_id, status, execute_deadline, expires_at,
        version, consent_kind, policy_revision, updated_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'APPROVED',
        clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '5 minutes',
        1, 'click', 7, clock_timestamp());
    `, [planId, actor, org]);
    await db.query(`
      INSERT INTO app_private.copilot_plan_steps(
        plan_id, step_no, action_id, action_version, permission_key,
        canonical, payload_digest, payload, status
      ) VALUES ($1::uuid, 1, 'income_expense.create_draft', 1,
        'income_expenses.create', $2::jsonb,
        app_private.copilot_payload_hash_v1($2::jsonb), $2::jsonb, 'PENDING');
    `, [planId, payload]);

    const result = (await db.query(
      `SELECT public.copilot_plan_execute_step_v1($1::uuid, 1, 1, $2::uuid) AS result`,
      [planId, org],
    )).rows[0].result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.step.outcome.audit_id, first.audit_id);
    const step = (await db.query(
      'SELECT status, outcome FROM app_private.copilot_plan_steps WHERE plan_id = $1',
      [planId],
    )).rows[0];
    assert.equal(step.status, 'DONE');
    assert.equal(step.outcome.audit_id, first.audit_id);
    const ledger = (await db.query(
      `SELECT payload FROM app_private.test_ledger ORDER BY (payload->>'event')`,
    )).rows.map(row => row.payload);
    assert.equal(ledger.filter(row => row.event === 'action_executed').length, 1);
    assert.equal(ledger.filter(row => row.event === 'step_done').length, 1);
    assert.equal(ledger.find(row => row.event === 'step_done').audit_id, first.audit_id);
    assert.deepEqual(await counts(db), { vouchers: 1, items: 1, audits: 1 });
  } finally {
    await db.close();
  }
});

test('migration is idempotent and preserves owner, ACL, volatility, security and search_path', { timeout: 20_000 }, async () => {
  const db = await setup();
  try {
    const metadata = async () => (await db.query(`
      SELECT pg_get_userbyid(proowner) owner, proacl, provolatile, prosecdef, proconfig
      FROM pg_proc
      WHERE oid = 'public.copilot_execute_income_expense_legacy_v1(text,jsonb)'::regprocedure
    `)).rows[0];
    const before = await metadata();
    await apply(db);
    const once = await metadata();
    await apply(db);
    const twice = await metadata();
    assert.deepEqual(once, before);
    assert.deepEqual(twice, before);
  } finally {
    await db.close();
  }
});

test('migration refuses an unexpected producer body without replacing it', { timeout: 20_000 }, async () => {
  const db = await setup();
  try {
    const driftedDefinition = legacyDefinition.replace(
      '  -- A replay is allowed only when every audit/entity/item field still proves',
      '  -- Unexpected source drift used by the executable fail-closed fixture.\n' +
      '  -- A replay is allowed only when every audit/entity/item field still proves',
    );
    assert.notEqual(driftedDefinition, legacyDefinition);
    await db.exec(driftedDefinition);
    const before = (await db.query(`
      SELECT prosrc FROM pg_proc
      WHERE oid = 'public.copilot_execute_income_expense_legacy_v1(text,jsonb)'::regprocedure
    `)).rows[0].prosrc;
    await assert.rejects(apply(db), /unexpected legacy replay source sha256/);
    await db.exec('ROLLBACK');
    const after = (await db.query(`
      SELECT prosrc FROM pg_proc
      WHERE oid = 'public.copilot_execute_income_expense_legacy_v1(text,jsonb)'::regprocedure
    `)).rows[0].prosrc;
    assert.equal(after, before);
    assert.equal(after.includes("'audit_id', v_prev.id"), false);
  } finally {
    await db.close();
  }
});
