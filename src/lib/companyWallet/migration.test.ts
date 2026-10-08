import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20261008164757_company_wallets_and_payment_kinds.sql';
const sql = readFileSync(path, 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [owner, other, org, foreignOrg, account, secondAccount, foreignAccount, building, foreignBuilding] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const db = new PGlite();
type WalletRow = { id: string; version: number; is_preferred: boolean; hidden: boolean; balance: number | null; balance_visible: boolean; can_use: boolean };
type Snapshot = { wallets: WalletRow[]; transactions: { id: string; total_amount: number; posting_status: string; approval_status: string; deleted_at: string | null }[] };
beforeAll(async () => {
 await db.exec(`
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.super_admin',true),'')='yes' $$;
  CREATE FUNCTION sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT CASE WHEN coalesce(current_setting('test.sandbox',true),'')='yes' THEN ARRAY['${org}'::uuid] ELSE ARRAY[]::uuid[] END $$;
  CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${owner}'),('${other}');
  CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES('${org}'),('${foreignOrg}');
  CREATE TABLE organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,status text);
  INSERT INTO organization_memberships(user_id,organization_id,status) VALUES('${owner}','${org}','ACTIVE'),('${owner}','${foreignOrg}','ACTIVE'),('${other}','${org}','ACTIVE');
  ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY; CREATE POLICY own_membership ON organization_memberships FOR SELECT TO authenticated USING(user_id=auth.uid());
  CREATE TABLE accounts(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,name text,initial_amount numeric,deleted_at timestamptz,is_virtual boolean DEFAULT false);
  INSERT INTO accounts VALUES('${account}','${owner}','${org}','Main',1000,NULL,false),('${secondAccount}','${owner}','${org}','Second',0,NULL,false),('${foreignAccount}','${owner}','${foreignOrg}','Foreign',999,NULL,false);
  CREATE TABLE fixture_cashbook_rights(cashbook_id uuid,user_id uuid,can_use boolean,balance_visible boolean,can_read boolean);
  INSERT INTO fixture_cashbook_rights VALUES('${account}','${owner}',true,true,true),('${secondAccount}','${owner}',true,true,true),('${foreignAccount}','${owner}',true,true,true),('${account}','${other}',true,true,true);
  ALTER TABLE accounts ENABLE ROW LEVEL SECURITY; CREATE POLICY readable_account ON accounts FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM fixture_cashbook_rights r WHERE r.cashbook_id=id AND r.user_id=auth.uid() AND r.can_read));
  CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz); INSERT INTO buildings VALUES('${building}','${org}',NULL),('${foreignBuilding}','${foreignOrg}',NULL);
  CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,maker_user_id uuid,organization_id uuid,account_id uuid,building_id uuid,code text DEFAULT 'PC001',type text,name text,total_amount numeric,voucher_date date,approval_status text DEFAULT 'APPROVED',posting_status text DEFAULT 'POSTED',review_state text,attachments jsonb DEFAULT '[]',created_at timestamptz DEFAULT now(),deleted_at timestamptz);
  ALTER TABLE income_expenses ENABLE ROW LEVEL SECURITY; CREATE POLICY readable_voucher ON income_expenses FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM fixture_cashbook_rights r WHERE r.cashbook_id=account_id AND r.user_id=auth.uid() AND r.can_read));
  CREATE TABLE fixture_postings(account_id uuid,amount numeric);
  ALTER TABLE fixture_postings ENABLE ROW LEVEL SECURITY; CREATE POLICY readable_posting ON fixture_postings FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM fixture_cashbook_rights r WHERE r.cashbook_id=account_id AND r.user_id=auth.uid() AND r.balance_visible));
  CREATE VIEW accounts_with_balance_v2 WITH(security_invoker=true) AS SELECT a.*,initial_amount+coalesce((SELECT sum(amount) FROM fixture_postings p WHERE p.account_id=a.id),0) current_amount FROM accounts a WHERE deleted_at IS NULL;
  CREATE FUNCTION list_cashbooks_for_expense_v2() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT a.id,a.name FROM accounts a JOIN fixture_cashbook_rights r ON r.cashbook_id=a.id WHERE r.user_id=auth.uid() AND r.can_use AND a.deleted_at IS NULL $$;
  CREATE FUNCTION list_cashbook_visibility_v2() RETURNS TABLE(cashbook_id uuid,balance_visible boolean) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT cashbook_id,balance_visible FROM fixture_cashbook_rights WHERE user_id=auth.uid() $$;
  CREATE FUNCTION app_private.finance_v2_visible_vouchers() RETURNS SETOF income_expenses LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT v.* FROM income_expenses v WHERE EXISTS(SELECT 1 FROM fixture_cashbook_rights r WHERE r.cashbook_id=v.account_id AND r.user_id=auth.uid() AND r.can_read) $$;
  CREATE TABLE writer_calls(args jsonb);
  CREATE TABLE fixture_writer_receipts(request_key text PRIMARY KEY,voucher_id uuid);
  -- Canonical writer is a collaborator: tests assert exact delegation/atomicity, not reproduce its money engine.
  CREATE FUNCTION create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS income_expenses LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE v income_expenses; pending boolean:=coalesce(current_setting('test.pending',true),'')='yes'; BEGIN
   IF coalesce(current_setting('test.writer_denied',true),'')='yes' THEN RAISE EXCEPTION 'real writer rejected scope' USING ERRCODE='42501'; END IF;
   SELECT ie.* INTO v FROM income_expenses ie JOIN fixture_writer_receipts r ON r.voucher_id=ie.id WHERE r.request_key=p_idempotency_key;
   IF FOUND THEN RETURN v; END IF;
   INSERT INTO writer_calls VALUES(jsonb_build_object('account',p_account_id,'items',p_items,'key',p_idempotency_key,'attachments',p_attachments,'notes',p_notes,'room',p_room_id));
   INSERT INTO income_expenses(user_id,maker_user_id,organization_id,account_id,building_id,type,name,total_amount,voucher_date,attachments,approval_status,posting_status)
   SELECT auth.uid(),auth.uid(),organization_id,p_account_id,p_building_id,p_type,p_name,(p_items->0->>'unit_price')::numeric,p_voucher_date,p_attachments,CASE WHEN pending THEN 'UNAPPROVED' ELSE 'APPROVED' END,CASE WHEN pending THEN 'UNPOSTED' ELSE 'POSTED' END FROM buildings WHERE id=p_building_id RETURNING * INTO v;
   IF NOT pending THEN INSERT INTO fixture_postings VALUES(p_account_id,CASE WHEN p_type='INCOME' THEN v.total_amount ELSE -v.total_amount END); END IF;
   INSERT INTO fixture_writer_receipts VALUES(p_idempotency_key,v.id);
   RETURN v;
  END $$;
  CREATE TABLE app_private.org_boundary_exemptions(table_name text PRIMARY KEY,reason text,decided_by text,expires_at date,replacement_policy text);
  CREATE TABLE personal_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,type text,amount numeric,txn_date date,description text,category text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
  GRANT USAGE ON SCHEMA auth,app_private TO authenticated;
  GRANT SELECT ON organization_memberships,accounts,fixture_cashbook_rights,buildings,income_expenses,fixture_postings,accounts_with_balance_v2 TO authenticated;
 `);
 await db.exec(readFileSync('supabase/migrations/20261004212309_personal_finance_wallets.sql', 'utf8'));
 await db.exec(sql); await db.exec(sql);
 await db.exec(`CREATE FUNCTION fixture_fail_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('test.fail_origin',true),'')='yes' THEN RAISE EXCEPTION 'origin write failed' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fixture_origin_failure BEFORE INSERT ON company_wallet_voucher_origins FOR EACH ROW EXECUTE FUNCTION fixture_fail_origin();`);
}, 30000);
afterAll(() => db.close());
async function tx(fn: () => Promise<void>) { await db.exec('BEGIN'); try { await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]); await fn(); } finally { await db.exec('ROLLBACK'); } }
async function denied(fn: () => Promise<unknown>, code: string) { await db.exec('SAVEPOINT denied'); try { await expect(fn()).rejects.toMatchObject({ code }); } finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); } }
async function asActor(actor = owner) { await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]); await db.exec('SET LOCAL ROLE authenticated'); }
async function mutate(payload: unknown, key = id(100), organization = org) { return (await db.query<{ r: { wallet: WalletRow } }>('SELECT company_wallet_mutate($1,$2,$3::jsonb) r', [organization, key, JSON.stringify(payload)])).rows[0].r; }
async function createWallet(accountId = account, key = id(100), kind = 'bank') { return (await mutate({ action: 'create', data: { name: `Wallet ${accountId}`, kind, account_id: accountId, is_preferred: true } }, key)).wallet; }
async function snapshot(organization = org) { return (await db.query<{ r: Snapshot }>('SELECT company_wallet_snapshot($1) r', [organization])).rows[0].r; }
const input = { type: 'EXPENSE', name: 'Company purchase', building_id: building, account_id: account, attachments: ['https://example.test/bill.png'], voucher_date: '2026-10-08', items: [{ income_expense_type_id: id(30), description: 'Paper', quantity: 1, unit_price: 100, start_date: '2026-10-08', end_date: '2026-10-08' }] };
async function voucher(walletId: string, payload = input, key = 'request-1', organization = org) { return (await db.query<{ r: { id: string; wallet_id: string; posting_status: string } }>('SELECT create_company_wallet_voucher($1,$2,$3,$4::jsonb) r', [organization, walletId, key, JSON.stringify(payload)])).rows[0].r; }
async function count(table: string) { return (await db.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }

describe('company wallet migration with authenticated actor RLS', () => {
 it('applies twice and exposes only explicit authenticated RPCs; writers remain volatile', async () => {
  for (const signature of ['company_wallet_mutate(uuid,uuid,jsonb)', 'create_company_wallet_voucher(uuid,uuid,text,jsonb)']) {
   const row = (await db.query<{ volatility: string; anon: boolean; authenticated: boolean }>("SELECT p.provolatile volatility,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated FROM pg_proc p WHERE p.oid=$1::regprocedure", [signature])).rows[0];
   expect(row).toEqual({ volatility: 'v', anon: false, authenticated: true });
  }
 });
 it('maps each owned cashbook once, switches preference atomically, replays and checks CAS', () => tx(async () => {
  await asActor(); const first = await createWallet(); const second = await createWallet(secondAccount, id(101));
  expect((await snapshot()).wallets.find(w => w.id === first.id)).toMatchObject({ is_preferred: false, version: 2 });
  expect((await snapshot()).wallets.find(w => w.id === second.id)?.is_preferred).toBe(true);
  expect(await createWallet(secondAccount, id(101))).toEqual(second);
  await denied(() => createWallet(account, id(102)), '23505');
  await denied(() => mutate({ action: 'update', id: first.id, expected_version: 1, data: { name: 'Stale' } }, id(103)), 'PT409');
  await denied(() => mutate({ action: 'create', data: { name: 'X', kind: 'bank', account_id: foreignAccount } }, id(104)), '42501');
  await denied(() => mutate({ action: 'create', data: { name: 'X', kind: 'bank', account_id: account, user_id: other } }, id(105)), '22023');
  await denied(() => db.exec(`INSERT INTO company_wallets(user_id,organization_id,account_id,name,kind) VALUES('${owner}','${org}','${account}','Bypass','cash')`), '42501');
 }));
 it('separates actor/org configuration and denies departed membership, even replay', () => tx(async () => {
  await asActor(); const wallet = await createWallet();
  await db.exec('RESET ROLE'); await asActor(other);
  expect((await snapshot()).wallets).toEqual([]);
  await denied(() => mutate({ action: 'update', id: wallet.id, expected_version: 1, data: { name: 'Steal' } }, id(102)), '42501');
  await denied(() => snapshot(foreignOrg), '42501');
  await db.exec('RESET ROLE'); await db.query("UPDATE organization_memberships SET status='INACTIVE' WHERE user_id=$1 AND organization_id=$2", [owner, org]); await asActor();
  await denied(() => createWallet(), '42501'); await denied(() => snapshot(), '42501');
  expect(await count('company_wallets')).toBe(0);
 }));
 it('hides sandbox records from administrators and rejects definer RPCs for them', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); await voucher(wallet.id);
  await db.exec("SET LOCAL test.super_admin='yes'; SET LOCAL test.sandbox='yes'");
  for (const table of ['company_wallets', 'company_wallet_requests', 'company_wallet_voucher_origins']) expect(await count(table)).toBe(0);
  await denied(() => snapshot(), '42501'); await denied(() => createWallet(), '42501'); await denied(() => voucher(wallet.id), '42501');
 }));
 it('does not expose submitted bill provenance after voucher visibility is revoked', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); await voucher(wallet.id);
  expect(await count('company_wallet_voucher_origins')).toBe(1);
  await db.exec('RESET ROLE'); await db.query('UPDATE fixture_cashbook_rights SET can_read=false,balance_visible=false,can_use=false WHERE cashbook_id=$1 AND user_id=$2', [account, owner]); await asActor();
  expect(await count('company_wallet_voucher_origins')).toBe(0); expect((await snapshot()).transactions).toEqual([]);
 }));
 it('delegates one canonical write, atomically stores origin and preserves idempotency', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); const created = await voucher(wallet.id);
  expect(await voucher(wallet.id)).toEqual(created); expect(created.wallet_id).toBe(wallet.id);
  await denied(() => voucher(wallet.id, { ...input, name: 'Different' }), '23505');
  await denied(() => voucher(wallet.id, { ...input, account_id: secondAccount }, 'wrong-account'), '42501');
  await denied(() => voucher(wallet.id, { ...input, building_id: foreignBuilding }, 'wrong-building'), '42501');
  await db.exec('RESET ROLE'); expect(await count('income_expenses')).toBe(1); expect(await count('company_wallet_voucher_origins')).toBe(1); expect(await count('personal_transactions')).toBe(0); expect(await count('writer_calls')).toBe(1);
  const args = (await db.query<{ args: { account: string; attachments: string[]; items: unknown; key: string } }>('SELECT args FROM writer_calls')).rows[0].args;
  expect(args).toMatchObject({ account, attachments: input.attachments, items: input.items }); expect(args.key).toMatch(/^company-wallet:/);
 }));
 it('rechecks custody on replay and hides revoked balances instead of inventing zero', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); await voucher(wallet.id);
  expect((await snapshot()).wallets[0]).toMatchObject({ balance: 900, balance_visible: true, can_use: true });
  await db.exec('RESET ROLE'); await db.query('UPDATE fixture_cashbook_rights SET can_use=false,balance_visible=false WHERE cashbook_id=$1 AND user_id=$2', [account, owner]); await asActor();
  expect((await snapshot()).wallets[0]).toMatchObject({ balance: null, balance_visible: false, can_use: false });
  await denied(() => voucher(wallet.id), '42501');
  const hidden = await mutate({ action: 'update', id: wallet.id, expected_version: 1, data: { hidden: true } }, id(102)); expect(hidden.wallet.hidden).toBe(true);
 }));
 it('rechecks canonical building authority on replay even when membership and custody remain', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); await voucher(wallet.id);
  await db.exec("SET LOCAL test.writer_denied='yes'"); await denied(() => voucher(wallet.id), '42501');
  expect((await snapshot()).wallets[0].can_use).toBe(true);
 }));
 it('rolls back both voucher and origin on failure without fallback or personal writes', () => tx(async () => {
  await asActor(); const wallet = await createWallet(); await db.exec("SET LOCAL test.fail_origin='yes'"); await denied(() => voucher(wallet.id), '23514');
  await db.exec("SET LOCAL test.fail_origin=''; SET LOCAL test.writer_denied='yes'"); await denied(() => voucher(wallet.id), '42501');
  await db.exec('RESET ROLE'); for (const table of ['income_expenses', 'company_wallet_voucher_origins', 'fixture_postings', 'writer_calls', 'personal_transactions']) expect(await count(table)).toBe(0);
 }));
 it('keeps full cashbook balance separate from page-origin vouchers and pending/reversed states', () => tx(async () => {
  const wallet = await createWallet(); await db.query('INSERT INTO fixture_postings VALUES($1,250)', [account]);
  await asActor(); await db.exec("SET LOCAL test.pending='yes'"); const pending = await voucher(wallet.id); expect(pending.posting_status).toBe('UNPOSTED');
  expect((await snapshot()).wallets[0].balance).toBe(1250);
  await db.exec("SET LOCAL test.pending=''"); const posted = await voucher(wallet.id, input, 'second');
  expect((await snapshot()).wallets[0].balance).toBe(1150);
  await db.exec('RESET ROLE'); await db.query('INSERT INTO fixture_postings VALUES($1,100)', [account]); await db.query("UPDATE income_expenses SET posting_status='REVERSED',approval_status='CANCELLED' WHERE id=$1", [posted.id]); await asActor();
  const state = await snapshot(); expect(state.wallets[0].balance).toBe(1250); expect(state.transactions).toHaveLength(2); expect(state.transactions.find(v => v.id === posted.id)?.posting_status).toBe('REVERSED');
  await denied(() => mutate({ action: 'delete', id: wallet.id, expected_version: 1, data: {} }, id(103)), '23514');
  await denied(() => mutate({ action: 'update', id: wallet.id, expected_version: 1, data: { account_id: secondAccount } }, id(104)), '23514');
 }));
 it('aggregates every source row beyond the REST cap and omits unrelated vouchers', () => tx(async () => {
  const wallet = await createWallet();
  await db.query(`WITH inserted AS (INSERT INTO income_expenses(user_id,maker_user_id,organization_id,account_id,building_id,type,name,total_amount,voucher_date)
   SELECT $1,$1,$2,$3,$4,'EXPENSE','Bulk',1,'2026-10-08' FROM generate_series(1,1005) RETURNING id)
   INSERT INTO company_wallet_voucher_origins(voucher_id,wallet_id,user_id,organization_id,idempotency_key,payload) SELECT id,$5,$1,$2,id::text,'{}'::jsonb FROM inserted`, [owner, org, account, building, wallet.id]);
  await db.query("INSERT INTO income_expenses(user_id,organization_id,account_id,type,name,total_amount,voucher_date) VALUES($1,$2,$3,'EXPENSE','Unrelated',999999,'2026-10-08')", [owner, org, account]);
  await asActor(); const state = await snapshot(); expect(state.transactions).toHaveLength(1005); expect(state.transactions.reduce((sum, row) => sum + row.total_amount, 0)).toBe(1005); expect(state.wallets[0].balance).toBe(1000);
 }));
 it('personal card kinds remain separate and per-kind preferences preserve old kinds', () => tx(async () => {
  await asActor();
  const personal = async (data: unknown, key: number) => (await db.query<{ r: { entities: { id: string; kind: string; is_preferred: boolean }[] } }>("SELECT personal_finance_mutate($1,$2::jsonb) r", [id(key), JSON.stringify({ action: 'wallet.create', data })])).rows[0].r.entities[0];
  const sp = await personal({ name: 'SP', kind: 'sp_card', is_preferred: true }, 201);
  const credit = await personal({ name: 'Credit', kind: 'credit_card', is_preferred: true }, 202);
  const bank = await personal({ name: 'Bank A', kind: 'bank', is_preferred: true }, 203);
  await personal({ name: 'Bank B', kind: 'bank', is_preferred: true }, 204); await personal({ name: 'Old Ewallet', kind: 'ewallet' }, 205);
  const rows = (await db.query<{ id: string; is_preferred: boolean }>('SELECT id,is_preferred FROM personal_wallets')).rows;
  expect(rows.find(r => r.id === sp.id)?.is_preferred).toBe(true); expect(rows.find(r => r.id === credit.id)?.is_preferred).toBe(true); expect(rows.find(r => r.id === bank.id)?.is_preferred).toBe(false);
 }));
 it('kills a full-balance mutation against the same money assertion in memory', () => tx(async () => {
  const wallet = await createWallet(); await voucher(wallet.id);
  const definition = (await db.query<{ body: string }>("SELECT pg_get_functiondef('company_wallet_snapshot(uuid)'::regprocedure) body")).rows[0].body;
  const mutated = definition.replace('THEN a.current_amount ELSE NULL', 'THEN 0::numeric ELSE NULL'); expect(mutated).not.toBe(definition);
  await db.exec(mutated); await asActor();
  // The production file is never rewritten; transaction rollback restores the original catalog.
  const observed = (await snapshot()).wallets[0].balance;
  expect(() => expect(observed).toBe(900)).toThrow();
 }));
 it('kills removal of the company account boundary using the cross-org rejection assertion', () => tx(async () => {
  const definition = (await db.query<{ body: string }>("SELECT pg_get_functiondef('company_wallet_mutate(uuid,uuid,jsonb)'::regprocedure) body")).rows[0].body;
  const mutated = definition.replace('AND a.organization_id=p_organization_id', ''); expect(mutated).not.toBe(definition);
  await db.exec(mutated); await asActor();
  await expect(expect(createWallet(foreignAccount, id(301))).rejects.toMatchObject({ code: '42501' })).rejects.toThrow();
 }));
 it('kills removal of actor isolation with an authenticated raw-table read assertion', () => tx(async () => {
  await createWallet();
  await db.exec(`ALTER POLICY company_wallet_owner ON company_wallets USING(EXISTS(SELECT 1 FROM organization_memberships m WHERE m.user_id=auth.uid() AND m.organization_id=company_wallets.organization_id AND m.status='ACTIVE'))`);
  await asActor(other); const observed = await count('company_wallets');
  expect(() => expect(observed).toBe(0)).toThrow();
 }));
});
