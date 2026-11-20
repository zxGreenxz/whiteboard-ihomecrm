// @vitest-environment node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
function definition(source, name) {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION ' + name + '(');
  const end = source.indexOf('$fn$;', source.indexOf('AS $fn$', start) + 7);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + 5);
}

test('R4 and W1 use the same tenant-scoped maker classification; a second migration run is inert', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA app_private; CREATE SCHEMA auth;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $$;
      CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.super', true) = 'yes' $$;
      CREATE TABLE organization_memberships(id uuid, organization_id uuid, user_id uuid, status text,valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE role_bindings(membership_id uuid,organization_id uuid,role_id uuid,valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE organization_roles(id uuid,organization_id uuid,status text,system_key text,name text);
      SET check_function_bodies=off;`);
    const owner = migration('20260827140000_chu_cong_ty_doi_co_kqkd_phieu_bo_coc.sql');
    await db.exec(definition(owner, 'app_private.ie_actor_is_company_owner_v1'));
    const base = migration('20261118041911_tam_ung_co_dong_va_chot_chi_loi_nhuan.sql');
    for (const fn of ['public.shareholder_profit_advance_preview_v1','public.shareholder_profit_advance_v1']) {
      await db.exec(definition(base, fn));
    }
    const change = migration('20261121004800_phan_loai_tam_ung_do_chu_lap.sql');
    await db.exec(change);
    await db.exec(change);
    const org = '20000000-0000-4000-8000-000000000001';
    const other = '20000000-0000-4000-8000-000000000002';
    await db.exec(`INSERT INTO organization_memberships VALUES (auth.uid(),'${org}',auth.uid(),'ACTIVE',NULL,NULL);
      INSERT INTO organization_roles VALUES ('${org}','${org}','ACTIVE',NULL,'Chủ công ty');
      INSERT INTO role_bindings VALUES (auth.uid(),'${org}','${org}',NULL,NULL);`);
    async function kind(id, self) {
      const result = await db.query('SELECT app_private.profit_advance_maker_kind_v1($1,$2) AS kind',[id,self]);
      return result.rows[0].kind;
    }
    assert.equal(await kind(org,true),'OWNER');
    assert.equal(await kind(org,false),'OWNER');
    assert.equal(await kind(other,true),'CUSTODIAN_ADVANCE');
    assert.equal(await kind(other,false),'CUSTODIAN_FOR_PAYEE');
    await db.exec("UPDATE organization_memberships SET status='REVOKED'");
    assert.equal(await kind(org,false),'CUSTODIAN_FOR_PAYEE');
    await db.exec("SET test.super='yes'");
    assert.equal(await kind(other,false),'OWNER');
    const refs = await db.query("SELECT proname FROM pg_proc WHERE proname IN ('shareholder_profit_advance_preview_v1','shareholder_profit_advance_v1') AND prosrc LIKE '%app_private.profit_advance_maker_kind_v1(%'");
    assert.equal(refs.rows.length,2);
  } finally { await db.close(); }
});
