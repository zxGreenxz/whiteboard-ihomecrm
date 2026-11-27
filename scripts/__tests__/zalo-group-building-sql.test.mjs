import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('account-scoped edits merge under the existing RPC and reject stale or foreign buildings', async () => {
  const db = new PGlite();
  const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const org = id(1), account = id(2), conv = id(3), building = id(4), foreign = id(5);
  const migration = await readFile(new URL('../../supabase/migrations/20261127091238_zalo_nhom_phong_theo_toa.sql', import.meta.url), 'utf8');
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.sub')::uuid $$;
      CREATE FUNCTION public.zalo_can(text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='${org}'::uuid $$;
      CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1<>'${id(8)}'::uuid $$;
      CREATE TABLE zalo_accounts(id uuid primary key,organization_id uuid);
      CREATE TABLE zalo_conversations(id uuid primary key,account_id uuid,organization_id uuid,thread_type text,thread_id text,is_sale_partner boolean);
      CREATE TABLE buildings(id uuid primary key,organization_id uuid,is_virtual boolean,deleted_at timestamptz);
      CREATE TABLE zalo_automations(id uuid default gen_random_uuid(),user_id uuid,organization_id uuid,kind text,enabled boolean,config jsonb,updated_at timestamptz,unique(organization_id,kind));
      INSERT INTO zalo_accounts VALUES ('${account}','${org}');
      INSERT INTO zalo_conversations VALUES ('${conv}','${account}','${org}','group','first',true),
        ('${id(6)}','${account}','${org}','group','second',true);
      INSERT INTO buildings VALUES ('${building}','${org}',false,null),('${foreign}','${id(7)}',false,null),('${id(8)}','${org}',false,null);`);
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${id(9)}'`);
    const save = async (expected, changes, add = []) => (await db.query(
      'SELECT public.zalo_save_account_recipients_v1($1,$2,$3::uuid[],ARRAY[]::uuid[],$4::jsonb,$5::jsonb) AS saved',
      [org, account, '{' + add.join(',') + '}', JSON.stringify(expected), JSON.stringify(changes)])).rows[0].saved.config;
    const scope = (k, v) => ({ groupBuildings: { [k]: v } });
    const legacy = async (config) => (await db.query(
      "SELECT (public.zalo_luu_tu_dong_hoa('broadcast_vacant',true,$1::jsonb,$2)).config AS cfg",
      [JSON.stringify(config), org])).rows[0].cfg;
    assert.deepEqual(await legacy(scope('outside', foreign)), {});
    assert.deepEqual((await save(scope('first', null), scope('first', building), [conv])).recipients, [conv]);
    assert.deepEqual((await save(scope('second', null), scope('second', building))).groupBuildings, { first: building, second: building });
    await assert.rejects(save(scope('first', foreign), scope('first', null)), e => e.code === '40001');
    for (const denied of [foreign, id(8)]) await assert.rejects(save(scope('first', building), scope('first', denied)), e => e.code === '22023');
    await assert.rejects(save(scope('outside', null), scope('outside', building)), e => e.code === '42501');
    assert.deepEqual((await save({}, { schedule: { time: '08:30' } })).groupBuildings, { first: building, second: building });
    const scopes = { first: building, second: building };
    assert.deepEqual(await legacy({ template: { introText: 'Liên hệ' } }), { template: { introText: 'Liên hệ' }, groupBuildings: scopes });
    assert.deepEqual(await legacy(scope('first', foreign)), { groupBuildings: scopes });
    assert.deepEqual((await save(scope('first', building), scope('first', null))).groupBuildings, { second: building });
  } finally { await db.close(); }
}, 30_000);
