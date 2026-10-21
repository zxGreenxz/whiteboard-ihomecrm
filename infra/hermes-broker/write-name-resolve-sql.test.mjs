import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { localCluster, setup, jwt, id, ORG, FOREIGN, USER, ROLE, BUILDING } from './crm-shared-read-sql-fixture.mjs';

// D7 (NEN-CHUNG-THAO-TAC-GHI.md mục 7): giải tên cho thao tác GHI bằng hàm SQL dùng chung public.hermes_write_name_resolve_v1,
// trên cụm PostgreSQL 17 dùng một lần với fixture crm-shared-read (RLS thật theo buildings.view + authorized_scope_v3). Bảng
// tên thường gọi, loại việc, hồ sơ là bảng fixture với RLS tối giản do test khai (không phải bản chép policy production).
// Chạy MỌI ca của name-match-vectors.json (cùng bộ vector với test web hermesNameMatchParity.test.ts), cộng các cạnh
// 42501/22023, RLS hẹp, idempotent, ACL/catalog. Dữ liệu giả.
const slug = 'hermes_write_name_resolve_v1';
const files = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
assert.equal(files.length, 1);
const sql = readFileSync(`supabase/migrations/${files[0]}`, 'utf8').replaceAll('\r\n', '\n');
const vectors = JSON.parse(readFileSync('infra/hermes-broker/name-match-vectors.json', 'utf8'));
const KEYS = new Map();
const uuidOf = key => { if (!KEYS.has(key)) KEYS.set(key, id(800 + KEYS.size)); return KEYS.get(key); };
const [USER2, MEMBER2, BINDING2, SCOPE2] = [30, 31, 32, 33].map(id);
const lit = value => value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const code = expected => error => error.code === expected;

async function seed(pool) {
  const b = vectors.buildings, r = vectors.rooms;
  await pool.query(`ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS code text, ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false;
    ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
    CREATE TABLE public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
    ALTER TABLE public.building_common_names ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_crm ON public.building_common_names FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.buildings x WHERE x.id=building_id));
    CREATE TABLE public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text NOT NULL,is_active boolean);
    ALTER TABLE public.job_types ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_crm ON public.job_types FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()));
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text,hidden boolean NOT NULL DEFAULT false);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_crm ON public.profiles FOR SELECT TO authenticated USING(NOT hidden);
    GRANT SELECT ON public.building_common_names,public.job_types,public.profiles TO authenticated;
    -- Cùng thân với helper production (20261014094913): thành viên ACTIVE còn hiệu lực của công ty.
    CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid)
    RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
     SELECT auth.role()='authenticated' AND auth.uid() IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.organization_memberships m WHERE m.user_id=p_user AND m.organization_id=p_org
       AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp())
       AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
    $fn$;
    REVOKE ALL ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
    INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code,is_virtual,deleted_at) VALUES
      ${b.map(x => `(${lit(uuidOf(x.key))},'${ORG}','${USER}',${lit(x.name)},${lit(x.name.toLowerCase())},${lit(x.code)},${x.virtual === true},${x.deleted ? 'now()' : 'NULL'})`).join(',')},
      ('${id(899)}','${FOREIGN}','${USER}','1392QT','1392qt','1392QT',false,NULL);
    INSERT INTO public.building_common_names(organization_id,building_id,name) VALUES
      ${b.flatMap(x => (x.commonNames ?? []).map(name => `('${ORG}',${lit(uuidOf(x.key))},${lit(name)})`)).join(',')};
    INSERT INTO public.rooms(id,organization_id,building_id,name,name_sort,deleted_at,code) VALUES
      ${r.map(x => `(${lit(uuidOf(x.key))},'${ORG}',${lit(uuidOf(x.building))},${lit(x.name)},${lit(x.name.toLowerCase())},${x.deleted ? 'now()' : 'NULL'},${lit(x.code)})`).join(',')};
    INSERT INTO public.job_types(id,organization_id,name,is_active) VALUES
      ${vectors.jobTypes.map(x => `(${lit(uuidOf(x.key))},'${ORG}',${lit(x.name)},${x.active === false ? 'false' : 'NULL'})`).join(',')},
      ('${id(898)}','${FOREIGN}','Lau kính',true);
    INSERT INTO public.profiles(id,full_name,hidden) VALUES
      ${vectors.people.map(x => `(${lit(uuidOf(x.key))},${lit(x.name)},${x.hiddenByRls === true})`).join(',')};
    INSERT INTO public.organization_memberships(organization_id,user_id,status,revoked_at) VALUES
      ${vectors.people.map(x => `('${ORG}',${lit(uuidOf(x.key))},${lit(x.membership ?? 'ACTIVE')},${x.membership ? 'now()' : 'NULL'})`).join(',')};
    INSERT INTO auth.users(id) VALUES('${USER2}');
    INSERT INTO public.organization_memberships(id,organization_id,user_id,status) VALUES('${MEMBER2}','${ORG}','${USER2}','ACTIVE');
    INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${SCOPE2}','${ORG}','BUILDING','${BUILDING}');
    INSERT INTO public.role_bindings VALUES('${BINDING2}','${ORG}','${MEMBER2}','${ROLE}',now()-interval '1 day',null);
    INSERT INTO public.role_binding_scopes VALUES('${ORG}','${BINDING2}','${SCOPE2}');`);
}

test('write name resolve: every shared vector, scope vs RLS, refusal edges, idempotent, ACL', { timeout: 240000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  await seed(pool);
  await pool.query(sql); await pool.query(sql); // Idempotent re-apply of the same candidate.
  // Như production và TEST (đọc 21/10 23:35): authenticated KHÔNG có USAGE trên app_private. Vỏ public SQL-standard phải
  // tới lõi + helper thành viên qua OID gắn lúc tạo; một thân plpgsql tra app_private lúc chạy sẽ đỏ ở đây (42501).
  await pool.query('REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC');
  assert.equal((await pool.query("SELECT has_schema_privilege('authenticated','app_private','USAGE') u")).rows[0].u, false);
  const scope = vectors.buildings.filter(x => x.inScope).map(x => uuidOf(x.key));
  const resolve = (names, { ids = scope, user = USER, org = ORG } = {}) => jwt(pool, async c =>
    (await c.query('SELECT public.hermes_write_name_resolve_v1($1::uuid,$2::uuid[],$3::jsonb) value', [org, ids, JSON.stringify(names)])).rows[0].value, user);
  const nameOf = key => [...vectors.buildings, ...vectors.rooms, ...vectors.jobTypes, ...vectors.people].find(x => x.key === key).name;

  await t.test('every case of name-match-vectors.json', async () => {
    assert.ok(vectors.cases.length >= 40);
    for (const vector of vectors.cases) {
      const names = vector.field === 'room' && vector.building ? { building: nameOf(vector.building), room: vector.wanted } : { [vector.field]: vector.wanted };
      const got = await resolve(names), label = JSON.stringify(vector);
      if (vector.expect) {
        assert.equal(got.status, 'resolved', label);
        assert.deepEqual(got[vector.field], { id: uuidOf(vector.expect), name: nameOf(vector.expect),
          ...(vector.field === 'room' ? { buildingId: uuidOf(vectors.rooms.find(x => x.key === vector.expect).building) } : {}) }, label);
      } else {
        assert.equal(got.status, 'unresolved', label);
        assert.deepEqual([got.field, got.wanted, got.why], [vector.field, vector.wanted, vector.why], label);
        assert.deepEqual(got.candidates.map(entry => entry.buildingName ? `${entry.name} (${entry.buildingName})` : entry.name), vector.candidates ?? [], label);
        assert.equal(got.more, false, label);
      }
    }
  });

  await t.test('combined names: building then room then job type then person; room alone implies its building', async () => {
    assert.deepEqual(await resolve({ building: 'qt', room: 'P.202', jobType: 'sua', person: 'binh' }), { status: 'resolved',
      building: { id: uuidOf('b1'), name: '1392QT' }, room: { id: uuidOf('r12'), name: '202', buildingId: uuidOf('b1') },
      jobType: { id: uuidOf('t1'), name: 'Sửa' }, person: { id: uuidOf('p2'), name: 'Trần Thị Bình' } });
    assert.deepEqual((await resolve({ room: 'a1' })).building, { id: uuidOf('b3'), name: '15KV' });
    // The first unresolved field answers; later fields are not reported.
    assert.deepEqual([(await resolve({ building: 'London', room: '201' })).field, (await resolve({ building: 'qt', room: '999', person: 'x' })).field], ['building', 'room']);
    assert.deepEqual(await resolve({}), { status: 'resolved', building: null, room: null, jobType: null, person: null });
  });

  await t.test('scope vs RLS: outside the write scope is outside_scope; what RLS hides is only not_visible; foreign org never named', async () => {
    // The same building outside the write key's scope: seen, so named, but never resolved.
    assert.deepEqual(await resolve({ building: '1392QT' }, { ids: [uuidOf('b2')] }), { status: 'unresolved', field: 'building', wanted: '1392QT',
      why: 'outside_scope', candidates: [{ name: '1392QT' }], more: false });
    assert.equal((await resolve({ room: '201' }, { ids: [] })).why, 'not_visible');
    // A member whose CRM scope (buildings.view) is one other building sees none of these: not_visible, no names leaked.
    for (const wanted of ['1392QT', 'London', '44TL']) {
      const got = await resolve({ building: wanted }, { user: USER2 });
      assert.deepEqual([got.why, got.candidates], ['not_visible', []], wanted);
    }
    // The foreign company's '1392QT' and 'Lau kính' never appear for this organization.
    assert.equal((await resolve({ building: '1392QT' })).building.id, uuidOf('b1'));
    assert.equal((await resolve({ jobType: 'lau kinh' })).why, 'not_visible');
  });

  await t.test('refusals: 42501 for any role but authenticated or without a JWT subject; 22023 for malformed input', async () => {
    await assert.rejects(pool.query('SELECT public.hermes_write_name_resolve_v1($1::uuid,$2::uuid[],$3::jsonb)', [ORG, scope, '{}']), code('42501'));
    // A JWT subject alone is not enough: a definer/superuser path (current_user ≠ authenticated) with claims set is refused too.
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
      await assert.rejects(owner.query('SELECT public.hermes_write_name_resolve_v1($1::uuid,$2::uuid[],$3::jsonb)', [ORG, scope, '{}']), code('42501'));
    } finally { await owner.query('ROLLBACK'); owner.release(); }
    await assert.rejects(jwt(pool, c => c.query("SELECT set_config('request.jwt.claim.sub','',true); SELECT public.hermes_write_name_resolve_v1($1::uuid,$2::uuid[],'{}'::jsonb)", [ORG, scope])));
    for (const names of [{ city: 'x' }, { building: 1 }, { building: '' }, { building: '  ' }, { building: 'a\u0001b' }, { building: 'x'.repeat(121) }, ['building']])
      await assert.rejects(resolve(names), code('22023'), JSON.stringify(names));
    await assert.rejects(resolve({ building: 'qt' }, { ids: [null] }), code('22023'));
    await assert.rejects(resolve({ building: 'qt' }, { ids: Array.from({ length: 257 }, (_, n) => id(5000 + n)) }), code('22023'));
    await assert.rejects(resolve({ building: 'qt' }, { org: null }), code('22023'));
  });

  await t.test('catalog: INVOKER, search_path empty, STABLE/IMMUTABLE, execute for authenticated only', async () => {
    const { rows } = await pool.query(`SELECT p.proname,p.prosecdef,p.provolatile::text v,p.proconfig,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
        has_function_privilege('hermes_store_executor',p.oid,'EXECUTE') store
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.proname IN ('hermes_name_fold_v1','hermes_room_key_v1','hermes_write_name_resolve_v1','hermes_write_name_resolve_core_v1') ORDER BY 1`);
    assert.deepEqual(rows.map(row => [row.proname, row.prosecdef, row.v, row.proconfig, row.anon, row.auth, row.store]), [
      ['hermes_name_fold_v1', false, 'i', ['search_path=""'], false, true, false],
      ['hermes_room_key_v1', false, 'i', ['search_path=""'], false, true, false],
      ['hermes_write_name_resolve_core_v1', false, 's', ['search_path=""'], false, true, false],
      ['hermes_write_name_resolve_v1', false, 's', ['search_path=""'], false, true, false]]);
    // Vỏ public là thân SQL-standard (OID gắn lúc tạo), không phải plpgsql.
    const body = (await pool.query("SELECT l.lanname, p.prosqlbody IS NOT NULL bound FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)'::regprocedure")).rows[0];
    assert.deepEqual(body, { lanname: 'sql', bound: true });
    const fold = async text => (await pool.query('SELECT public.hermes_name_fold_v1($1) v, public.hermes_room_key_v1($1) k', [text])).rows[0];
    assert.deepEqual(await fold('  TÒA  Điện   Biên Phủ '), { v: 'toa dien bien phu', k: 'toadienbienphu' });
    assert.deepEqual(await fold('Phòng 302'), { v: 'phong 302', k: '302' });
    assert.deepEqual(await fold('P.302'), { v: 'p.302', k: '302' });
    assert.deepEqual(await fold('PD1'), { v: 'pd1', k: 'pd1' }, 'tiền tố chỉ bỏ khi ngay sau là chữ số');
    // NFD input (combining marks) folds like NFC.
    assert.equal((await fold('Lế Văn')).v, 'le van');
  });
});
