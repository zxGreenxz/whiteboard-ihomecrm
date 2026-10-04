import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20261004062237_gmail_bill_income_expense.sql';
const db = new PGlite();
const org = '00000000-0000-4000-8000-000000000001';
const otherOrg = '00000000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000003';
const otherActor = '00000000-0000-4000-8000-000000000004';
const building = '00000000-0000-4000-8000-000000000005';
const otherBuilding = '00000000-0000-4000-8000-000000000006';
const category = '00000000-0000-4000-8000-000000000007';
const account = '00000000-0000-4000-8000-000000000008';
const source = { provider: 'grab', mailbox: 'user@example.com', message_id: 'abc123', receipt_id: 'A-123' };
const voucher = { type: 'EXPENSE', name: 'Grab food', building_id: building, voucher_date: '2026-10-04', attachments: [], business_result_accounting: true };
const items = [{ income_expense_type_id: category, description: 'Food', quantity: 1, unit_price: 85000, start_date: '2026-10-04', end_date: '2026-10-04' }];

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${actor}'),('${otherActor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE'); INSERT INTO organizations(id) VALUES('${org}'),('${otherOrg}');
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz); INSERT INTO buildings VALUES('${building}','${org}',NULL),('${otherBuilding}','${otherOrg}',NULL);
    CREATE TABLE organization_memberships(id uuid DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
    INSERT INTO organization_memberships(user_id,organization_id,status,valid_from,valid_to) VALUES('${actor}','${org}','ACTIVE',now()-interval '1 day',NULL),('${otherActor}','${otherOrg}','ACTIVE',now()-interval '1 day',NULL);
    CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,deleted_at timestamptz);
    INSERT INTO accounts VALUES('${account}','${org}','${actor}',NULL);
    CREATE TABLE cashbook_possession_bindings(cashbook_id uuid,organization_id uuid,membership_id uuid,possession_kind text,valid_to timestamptz);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY,is_restricted boolean);
    INSERT INTO income_expense_types VALUES('${category}',false);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,approval_status text DEFAULT 'UNAPPROVED',account_id uuid,has_restricted_item boolean DEFAULT false,deleted_at timestamptz);
    CREATE TABLE income_expense_items(income_expense_id uuid,income_expense_type_id uuid);
    CREATE TABLE writer_calls(args jsonb);
    CREATE FUNCTION my_org_ids() RETURNS uuid[] LANGUAGE sql SECURITY DEFINER AS $$ SELECT array_agg(organization_id) FROM organization_memberships WHERE user_id=auth.uid() AND status='ACTIVE' AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp()) $$;
    CREATE FUNCTION sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${otherOrg}'::uuid] $$;
    CREATE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.super_admin',true),'')='yes' $$;
    CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM buildings WHERE id=$1 AND organization_id=ANY(my_org_ids()) AND deleted_at IS NULL) AND coalesce(current_setting('test.building_denied',true),'')<>'yes' $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('test.org_locked',$1::text,true); RETURN 1; END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('test.org_locked',true) IS DISTINCT FROM $2::text THEN RAISE EXCEPTION 'Missing prior organization lock'; END IF;
      RETURN QUERY SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND $3='income_expenses.create' AND can_access_building($4) AND coalesce(current_setting('test.permission_denied',true),'')<>'yes'; END $$;
    CREATE FUNCTION app_private.authorize_income_expense_on_building(uuid,uuid,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND can_access_building($4) AND CASE $3 WHEN 'create' THEN coalesce(current_setting('test.canonical_create_denied',true),'')<>'yes' WHEN 'restricted_create' THEN coalesce(current_setting('test.restricted_create_denied',true),'')<>'yes' ELSE false END $$;
    CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.view_denied',true),'')<>'yes' AND EXISTS(SELECT 1 FROM income_expenses WHERE id=$1 AND deleted_at IS NULL) $$;
    CREATE FUNCTION create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS income_expenses LANGUAGE plpgsql AS $$ DECLARE r income_expenses; BEGIN
      IF NOT app_private.authorize_income_expense_on_building(auth.uid(),(SELECT organization_id FROM buildings WHERE id=p_building_id),'create',p_building_id)
        OR (EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) i JOIN income_expense_types t ON t.id=(i->>'income_expense_type_id')::uuid WHERE t.is_restricted)
          AND NOT app_private.authorize_income_expense_on_building(auth.uid(),(SELECT organization_id FROM buildings WHERE id=p_building_id),'restricted_create',p_building_id))
        OR (p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=p_account_id AND (a.user_id=auth.uid() OR EXISTS(SELECT 1 FROM cashbook_possession_bindings b JOIN organization_memberships m ON m.id=b.membership_id WHERE b.cashbook_id=a.id AND b.organization_id=a.organization_id AND m.user_id=auth.uid() AND m.status='ACTIVE' AND b.valid_to IS NULL AND b.possession_kind IN ('CUSTODIAN','OPERATOR')))))
        THEN RAISE EXCEPTION 'Canonical create/restricted/cashbook permission denied' USING ERRCODE='42501'; END IF;
      INSERT INTO writer_calls VALUES(jsonb_build_object('type',p_type,'name',p_name,'building_id',p_building_id,'items',p_items,'key',p_idempotency_key,'date',p_voucher_date,'attachments',p_attachments,'notes',p_notes,'business_result_accounting',p_business_result_accounting));
      INSERT INTO income_expenses(organization_id,building_id,account_id) SELECT organization_id,id,p_account_id FROM buildings WHERE id=p_building_id RETURNING * INTO r;
      INSERT INTO income_expense_items SELECT r.id,(i->>'income_expense_type_id')::uuid FROM jsonb_array_elements(p_items) i;
      IF coalesce(current_setting('test.writer_fail',true),'')='yes' THEN RAISE EXCEPTION 'Canonical spending engine denied' USING ERRCODE='42501'; END IF;
      RETURN r; END $$;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
  `);
  if (existsSync(path)) {
    await db.exec(readFileSync(path, 'utf8'));
    await db.exec(readFileSync(path, 'utf8'));
  }
}, 30000);
afterAll(() => db.close());
async function tx(fn: () => Promise<void>) {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]);
    await db.exec('SET LOCAL ROLE authenticated');
    await fn();
  } finally { await db.exec('ROLLBACK'); }
}
async function denied(fn: () => Promise<unknown>, code = '42501') {
  await db.exec('SAVEPOINT denied');
  try { await expect(fn()).rejects.toMatchObject({ code }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); }
}
async function create(s: unknown = source, v: unknown = voucher, i: unknown = items, organization = org) {
  return (await db.query<{ r: { id: string; created: boolean } }>('SELECT create_income_expense_from_email_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) r', [organization, JSON.stringify(s), JSON.stringify(v), JSON.stringify(i)])).rows[0].r;
}
async function lookup(s: unknown = [source], organization = org) {
  return (await db.query<{ r: unknown }>('SELECT get_imported_email_bills_v1($1,$2::jsonb) r', [organization, JSON.stringify(s)])).rows[0].r;
}
async function counts() {
  await db.exec('RESET ROLE');
  const r = (await db.query<{ vouchers: number; claims: number; calls: number }>('SELECT (SELECT count(*)::int FROM income_expenses) vouchers,(SELECT count(*)::int FROM email_bill_imports) claims,(SELECT count(*)::int FROM writer_calls) calls')).rows[0];
  await db.exec('SET LOCAL ROLE authenticated');
  return r;
}

describe('email bill SQL boundary with authenticated JWT', () => {
  it('installs both RPCs idempotently', async () => {
    const rows = (await db.query("SELECT proname,provolatile,prosecdef FROM pg_proc WHERE proname IN ('create_income_expense_from_email_v1','get_imported_email_bills_v1')")).rows;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ proname: 'create_income_expense_from_email_v1', provolatile: 'v', prosecdef: true })]));
    for (const role of ['authenticated', 'anon', 'service_role']) {
      expect((await db.query<{ permitted: boolean }>("SELECT has_function_privilege($1,'app_private.can_replay_email_bill_v1(uuid,uuid)','EXECUTE') permitted", [role])).rows[0].permitted).toBe(false);
    }
  });
  it('records one unapproved canonical voucher and an immutable receipt; retries return its id', () => tx(async () => {
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    const first = await create();
    expect(first).toEqual({ id: expect.any(String), created: true });
    expect(await create({ ...source, mailbox: 'another@example.com', message_id: 'def456' })).toEqual({ id: first.id, created: false });
    expect(await create({ ...source, provider: ' GRAB ', receipt_id: ' a-123 ' })).toEqual({ id: first.id, created: false });
    expect(await counts()).toEqual({ vouchers: 1, claims: 1, calls: 1 });
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: true }]);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT approval_status FROM income_expenses')).rows).toEqual([{ approval_status: 'UNAPPROVED' }]);
    const args = (await db.query<{ args: Record<string, unknown> }>('SELECT args FROM writer_calls')).rows[0].args;
    expect(args).toMatchObject({ type: 'EXPENSE', name: 'Grab food', items, building_id: building, date: '2026-10-04', attachments: [], notes: null });
    expect(args.key).toMatch(/^email-bill:[a-f0-9]{64}$/);
    const receipt = (await db.query('SELECT provider,receipt_id,mailbox,message_id,payload_hash FROM email_bill_imports')).rows[0];
    expect(receipt).toMatchObject({ provider: 'grab', receipt_id: 'A-123', mailbox: 'user@example.com', message_id: 'abc123', payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }));
  it('rejects different financial payload under the same bill identity', () => tx(async () => {
    await create(); await denied(() => create(source, { ...voucher, name: 'Changed' }), '23505');
    await denied(() => create(source, voucher, [{ ...items[0], unit_price: 1 }]), '23505');
    expect(await counts()).toEqual({ vouchers: 1, claims: 1, calls: 1 });
  }));
  it('preserves null auto-accounting and missing item description for the canonical engine', () => tx(async () => {
    const { description: _description, ...withoutDescription } = items[0];
    await create(source, { ...voucher, business_result_accounting: null }, [withoutDescription]);
    await db.exec('RESET ROLE');
    expect((await db.query<{ args: Record<string, unknown> }>('SELECT args FROM writer_calls')).rows[0].args)
      .toMatchObject({ business_result_accounting: null, items: [withoutDescription] });
  }));
  it('rechecks changed JWT, expired membership, permission and building on replay and lookup', () => tx(async () => {
    await create();
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [otherActor]);
    await denied(() => create()); await denied(() => lookup());
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]);
    for (const setting of ['test.building_denied', 'test.permission_denied']) {
      await db.query('SELECT set_config($1,$2,true)', [setting, 'yes']);
      await denied(() => create()); await denied(() => lookup());
      await db.query('SELECT set_config($1,$2,true)', [setting, 'no']);
    }
    await db.exec("RESET ROLE; UPDATE organization_memberships SET valid_to=now()-interval '1 second'; SET LOCAL ROLE authenticated");
    await denied(() => create()); await denied(() => lookup());
  }));
  it('rejects unauthenticated, cross-org and mismatched buildings before any financial write', () => tx(async () => {
    await denied(() => create(source, voucher, items, otherOrg));
    await denied(() => create(source, { ...voucher, building_id: otherBuilding }));
    await denied(() => lookup([source], otherOrg));
    await db.exec("SET LOCAL request.jwt.claim.sub=''"); await denied(() => create()); await denied(() => lookup());
    expect(await counts()).toEqual({ vouchers: 0, claims: 0, calls: 0 });
  }));
  it.each(['test.canonical_create_denied', 'test.restricted_create_denied', 'test.view_denied'])('hides the receipt and denies replay after %s is revoked', (setting) => tx(async () => {
    await db.exec('RESET ROLE; UPDATE income_expense_types SET is_restricted=true; SET LOCAL ROLE authenticated');
    await create();
    await db.query('SELECT set_config($1,$2,true)', [setting, 'yes']);
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    await denied(() => create());
    await denied(() => create(source, { ...voucher, name: 'Changed' }));
    expect(await counts()).toEqual({ vouchers: 1, claims: 1, calls: 1 });
  }));
  it.each(['CUSTODIAN', 'OPERATOR'])('requires current %s possession after account ownership is lost', (kind) => tx(async () => {
    const withAccount = { ...voucher, account_id: account };
    const first = await create(source, withAccount);
    await db.exec(`RESET ROLE; UPDATE accounts SET user_id='${otherActor}';
      INSERT INTO cashbook_possession_bindings SELECT '${account}','${org}',id,'${kind}',NULL FROM organization_memberships WHERE user_id='${actor}'; SET LOCAL ROLE authenticated`);
    expect(await create(source, withAccount)).toEqual({ id: first.id, created: false });
    await db.exec("RESET ROLE; UPDATE cashbook_possession_bindings SET valid_to=clock_timestamp(); SET LOCAL ROLE authenticated");
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    await denied(() => create(source, withAccount));
    await db.exec("RESET ROLE; UPDATE cashbook_possession_bindings SET valid_to=NULL,possession_kind='KNOWER'; SET LOCAL ROLE authenticated");
    await denied(() => create(source, withAccount));
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    expect(await counts()).toEqual({ vouchers: 1, claims: 1, calls: 1 });
  }));
  it('lets the canonical writer create for a creator without read permission, then hides replay', () => tx(async () => {
    await db.exec("SET LOCAL test.view_denied='yes'");
    expect((await create()).created).toBe(true);
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    await denied(() => create());
    expect(await counts()).toEqual({ vouchers: 1, claims: 1, calls: 1 });
  }));
  it.each([
    null, [], { ...source, provider: 'amazon' }, { ...source, receipt_id: '' }, { ...source, receipt_id: 'a'.repeat(201) },
    { ...source, receipt_id: 123 }, { ...source, receipt_id: 'A\n123' }, { ...source, mailbox: 'bad' }, { ...source, mailbox: 'a'.repeat(320) + '@x.com' },
    { ...source, message_id: {} }, { ...source, message_id: 'x'.repeat(129) }, { ...source, access_token: 'secret' },
  ])('rejects malformed source %# without claiming anything', (s) => tx(async () => {
    await denied(() => create(s), '22023'); await denied(() => lookup([s]), '22023');
    expect(await counts()).toEqual({ vouchers: 0, claims: 0, calls: 0 });
  }));
  it.each([
    { ...voucher, type: 'INCOME' }, { ...voucher, total_amount: 1 }, { ...voucher, approval_status: 'APPROVED' },
    { ...voucher, name: 12 }, { ...voucher, building_id: null }, { ...voucher, business_result_accounting: 'true' },
    { ...voucher, attachments: {} }, { ...voucher, voucher_date: 'invalid' }, { ...voucher, name: 'x'.repeat(501) },
  ])('rejects untrusted voucher fields %# before canonical writer', (v) => tx(async () => {
    await denied(() => create(source, v), '22023'); expect(await counts()).toEqual({ vouchers: 0, claims: 0, calls: 0 });
  }));
  it.each([null, [], {}, [{ ...items[0], approval_status: 'APPROVED' }], [{ ...items[0], quantity: '1' }], [{ ...items[0], unit_price: -1 }], [{ ...items[0], quantity: 0 }], [{ ...items[0], quantity: 1.5 }], [{ ...items[0], income_expense_type_id: 'bad' }]])('rejects malformed items %#', (i) => tx(async () => {
    await denied(() => create(source, voucher, i), '22023'); expect(await counts()).toEqual({ vouchers: 0, claims: 0, calls: 0 });
  }));
  it('rolls back claim and canonical side effects together on spending-engine failure', () => tx(async () => {
    await db.exec("SET LOCAL test.writer_fail='yes'"); await denied(() => create());
    expect(await counts()).toEqual({ vouchers: 0, claims: 0, calls: 0 });
    await db.exec("SET LOCAL test.writer_fail='no'"); expect((await create()).created).toBe(true);
  }));
  it('denies direct registry reads/writes and RPC execution for service and anonymous roles', () => tx(async () => {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await db.exec(`SET LOCAL ROLE ${role}`);
      await denied(() => db.exec('SELECT * FROM email_bill_imports'));
      await denied(() => db.exec('DELETE FROM email_bill_imports'));
      await denied(() => db.exec("UPDATE email_bill_imports SET receipt_id='changed'"));
      await denied(() => db.exec('INSERT INTO email_bill_imports DEFAULT VALUES'));
      if (role !== 'authenticated') { await denied(() => create()); await denied(() => lookup()); }
    }
  }));
  it('enforces unique org/provider/receipt in storage, even against bypassing the RPC', () => tx(async () => {
    await create(); await db.exec('RESET ROLE');
    await denied(() => db.exec('INSERT INTO email_bill_imports SELECT * FROM email_bill_imports'), '23505');
  }));
  it('isolates receipt identity by provider and organization, with stable distinct writer keys', () => tx(async () => {
    const a = await create(); const b = await create({ ...source, provider: 'shopee' });
    expect(a.id).not.toBe(b.id);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [otherActor]);
    expect(await lookup([source], otherOrg)).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    const c = await create(source, { ...voucher, building_id: otherBuilding }, items, otherOrg);
    expect([a.id, b.id]).not.toContain(c.id);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT count(DISTINCT args->>\'key\')::int n FROM writer_calls')).rows).toEqual([{ n: 3 }]);
  }));
  it('does not disclose imported receipts from a building the caller cannot create on', () => tx(async () => {
    await create();
    await db.exec(`RESET ROLE;
      INSERT INTO buildings VALUES('${category}','${org}',NULL);
      CREATE OR REPLACE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${category}'::uuid $$;
      SET LOCAL ROLE authenticated`);
    expect(await lookup()).toEqual([{ provider: 'grab', receipt_id: 'A-123', imported: false }]);
    await denied(() => create(source, { ...voucher, building_id: category }));
  }));
  it('sandbox restrictive RLS remains effective even if a permissive read policy is added later', () => tx(async () => {
    await create();
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [otherActor]);
    await create(source, { ...voucher, building_id: otherBuilding }, items, otherOrg);
    await db.exec(`RESET ROLE;
      GRANT SELECT ON email_bill_imports TO authenticated;
      CREATE POLICY test_future_read ON email_bill_imports FOR SELECT TO authenticated USING(true);
      SET LOCAL ROLE authenticated;
      SET LOCAL test.super_admin='yes'`);
    expect((await db.query('SELECT organization_id FROM email_bill_imports')).rows).toEqual([{ organization_id: org }]);
  }));
  it('validates lookup shape and bound before returning any results', () => tx(async () => {
    await denied(() => lookup(null), '22023'); await denied(() => lookup({}), '22023');
    await denied(() => lookup(Array.from({ length: 101 }, () => source)), '22023');
    expect(await lookup([])).toEqual([]);
  }));
});
