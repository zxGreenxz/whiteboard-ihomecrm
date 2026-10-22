import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { localCluster, setup, jwt, id, ORG, FOREIGN, USER, ROLE, BUILDING, OTHER_BUILDING, ROOM } from './crm-shared-read-sql-fixture.mjs';

// B5d (20261020175803): the two INVOKER directories and the DEFINER company-name helper on a disposable
// PostgreSQL 17 cluster with the crm-shared-read fixture (real authorized_scope_v3, real fixture RLS on
// buildings/rooms keyed by buildings.view). Proves: only RLS-visible buildings of the list appear, deleted
// and virtual buildings and soft-deleted rooms never appear, exact match beats contains, lower() folds
// Vietnamese letters (builtin C.UTF-8 like production), 22023/42501 edges, idempotent re-apply, ACL.
// Synthetic data only; not evidence of PostgREST/JWT on production.
const slug = 'hermes_name_directory_v1';
const migrationName = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
assert.equal(migrationName.length, 1);
const sql = readFileSync(`supabase/migrations/${migrationName[0]}`, 'utf8').replaceAll('\r\n', '\n');
const [USER2, MEMBER2, BINDING2, SCOPE2, B2, B3, BV, BX] = [20, 21, 22, 23, 601, 602, 603, 604].map(id);
const R = n => id(700 + n);
const code = expected => error => error.code === expected;

test('name directory: buildings and rooms under the asker RLS, company name for members only', { timeout: 240000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  // Columns the directories read that the shared fixture does not declare; a second member limited to one building.
  await pool.query(`ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS code text, ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false;
    ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text, ADD COLUMN IF NOT EXISTS floor integer;
    UPDATE public.organizations SET name='Công ty Thử' WHERE id='${ORG}';
    UPDATE public.organizations SET name='Công ty Khác' WHERE id='${FOREIGN}';
    UPDATE public.buildings SET name='Toà 950NK', code='950NK' WHERE id='${BUILDING}';
    INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code,is_virtual,deleted_at) VALUES
      ('${B2}','${ORG}','${USER}','London Garden','london garden',NULL,false,NULL),
      ('${B3}','${ORG}','${USER}','Tòa Điện Biên Phủ','toa dien bien phu','DBP',false,NULL),
      ('${BV}','${ORG}','${USER}','Toà Ảo','toa ao','AO',true,NULL),
      ('${BX}','${ORG}','${USER}','Toà Đã Xoá','toa da xoa','XOA',false,now());
    UPDATE public.rooms SET name='London 5', code='L5', floor=5 WHERE id='${ROOM}';
    INSERT INTO public.rooms(id,organization_id,building_id,name,name_sort,deleted_at,code,floor) VALUES
      ('${R(1)}','${ORG}','${BUILDING}','London 50','london 50',NULL,NULL,5),
      ('${R(2)}','${ORG}','${BUILDING}','London 5','london 5',now(),NULL,5),
      ('${R(3)}','${ORG}','${B2}','London 5','london 5',NULL,NULL,5),
      ('${R(4)}','${ORG}','${B2}','Phòng Đẹp','phong dep',NULL,'PD1',1),
      ('${R(5)}','${ORG}','${BV}','London 5','london 5',NULL,NULL,5),
      ('${R(6)}','${ORG}','${BX}','London 5','london 5',NULL,NULL,5),
      ('${R(7)}','${FOREIGN}','${OTHER_BUILDING}','London 5','london 5',NULL,NULL,5);
    INSERT INTO auth.users(id) VALUES('${USER2}');
    INSERT INTO public.organization_memberships(id,organization_id,user_id,status) VALUES('${MEMBER2}','${ORG}','${USER2}','ACTIVE');
    INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${SCOPE2}','${ORG}','BUILDING','${BUILDING}');
    INSERT INTO public.role_bindings VALUES('${BINDING2}','${ORG}','${MEMBER2}','${ROLE}',now()-interval '1 day',null);
    INSERT INTO public.role_binding_scopes VALUES('${ORG}','${BINDING2}','${SCOPE2}');`);
  await pool.query(sql); await pool.query(sql); // Idempotent re-apply of the same candidate.
  const buildings = (ids, user = USER) => jwt(pool, async c => (await c.query('SELECT public.hermes_building_directory_v1($1::uuid,$2::uuid[]) value', [ORG, ids])).rows[0].value, user);
  const rooms = (ids, name, user = USER, org = ORG) => jwt(pool, async c => (await c.query('SELECT public.hermes_room_directory_v1($1::uuid,$2::uuid[],$3) value', [org, ids, name])).rows[0].value, user);
  const company = (org, user = USER) => jwt(pool, async c => (await c.query('SELECT public.hermes_organization_name_v1($1::uuid) value', [org])).rows[0].value, user);
  const ALL = [BUILDING, B2, B3, BV, BX, OTHER_BUILDING];

  await t.test('buildings: only the listed, live, real buildings the RLS shows; sorted by name; foreign/deleted/virtual never named', async () => {
    assert.deepEqual(await buildings(ALL), { buildings: [{ id: B2, name: 'London Garden', code: null }, { id: BUILDING, name: 'Toà 950NK', code: '950NK' },
      { id: B3, name: 'Tòa Điện Biên Phủ', code: 'DBP' }] });
    assert.deepEqual(await buildings([B3]), { buildings: [{ id: B3, name: 'Tòa Điện Biên Phủ', code: 'DBP' }] });
    assert.deepEqual(await buildings([BV, BX, OTHER_BUILDING]), { buildings: [] });
    // The second member's CRM scope (buildings.view) covers one building: the others of the same list stay unseen, not refused.
    assert.deepEqual(await buildings(ALL, USER2), { buildings: [{ id: BUILDING, name: 'Toà 950NK', code: '950NK' }] });
    for (const bad of [[], null, Array.from({ length: 257 }, (_, n) => id(1000 + n))]) await assert.rejects(buildings(bad), code('22023'), JSON.stringify(bad));
    await assert.rejects(jwt(pool, async c => c.query('SELECT public.hermes_building_directory_v1($1::uuid,$2::uuid[])', [null, [BUILDING]])), code('22023'));
  });
  // Thu chi Mốc 3 (20261022044120): danh bạ v2 = v1 + toà ảo khi p_include_virtual (khoá thu chi). Chỉ nạp định nghĩa hàm này (file còn lõi
  // giải tên ghi v2 cần hàm bỏ dấu/thành viên mà fixture này không có).
  await t.test('Thu chi Mốc 3 — danh bạ v2: false = v1; true thêm toà ảo dưới RLS người hỏi; NULL ⇒ 22023', async () => {
    const virtualSql = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => /^\d{14}_hermes_name_directory_virtual_v1\.sql$/.test(name))}`, 'utf8')
      .replaceAll('\r\n', '\n');
    const start = virtualSql.indexOf('CREATE OR REPLACE FUNCTION public.hermes_building_directory_v2(');
    await pool.query(virtualSql.slice(start, virtualSql.indexOf('END $fn$;', start) + 'END $fn$;'.length) +
      '\nREVOKE ALL ON FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.hermes_building_directory_v2(uuid,uuid[],boolean) TO authenticated;');
    const v2 = (ids, include, user = USER) => jwt(pool, async c => (await c.query('SELECT public.hermes_building_directory_v2($1::uuid,$2::uuid[],$3) value', [ORG, ids, include])).rows[0].value, user);
    assert.deepEqual(await v2(ALL, false), await buildings(ALL), 'false = v1');
    assert.deepEqual(await v2(ALL, true), { buildings: [{ id: B2, name: 'London Garden', code: null }, { id: BUILDING, name: 'Toà 950NK', code: '950NK' },
      { id: BV, name: 'Toà Ảo', code: 'AO' }, { id: B3, name: 'Tòa Điện Biên Phủ', code: 'DBP' }] }, 'toà ảo có, toà đã xoá/công ty khác vẫn không');
    assert.deepEqual(await v2(ALL, true, USER2), { buildings: [{ id: BUILDING, name: 'Toà 950NK', code: '950NK' }] }, 'RLS người hỏi vẫn quyết');
    await assert.rejects(v2(ALL, null), code('22023'));
  });
  await t.test('rooms: exact name/code first, contains otherwise, Vietnamese case folding, deleted rooms and rooms of deleted/virtual/foreign buildings never appear, ≤ 50', async () => {
    const room = (rid, name, cod, building) => ({ id: rid, name, code: cod, floor: 5, buildingId: building });
    assert.deepEqual(await rooms(ALL, ' london 5 '), { rooms: [room(R(3), 'London 5', null, B2), room(ROOM, 'London 5', 'L5', BUILDING)] }, 'exact beats London 50; deleted/virtual/foreign copies absent');
    assert.deepEqual(await rooms([BUILDING], 'LONDON'), { rooms: [room(ROOM, 'London 5', 'L5', BUILDING), room(R(1), 'London 50', null, BUILDING)] }, 'contains, building then name');
    assert.deepEqual(await rooms(ALL, 'l5'), { rooms: [room(ROOM, 'London 5', 'L5', BUILDING)] }, 'exact code');
    assert.deepEqual(await rooms(ALL, 'PHÒNG ĐẸP'), { rooms: [{ id: R(4), name: 'Phòng Đẹp', code: 'PD1', floor: 1, buildingId: B2 }] }, 'Unicode lower()');
    assert.deepEqual(await rooms(ALL, 'pd'), { rooms: [{ id: R(4), name: 'Phòng Đẹp', code: 'PD1', floor: 1, buildingId: B2 }] }, 'contains in code');
    assert.deepEqual(await rooms(ALL, 'Phòng 99'), { rooms: [] });
    assert.deepEqual(await rooms([B2], 'London 5', USER2), { rooms: [] }, 'outside the second member RLS: unseen');
    assert.deepEqual(await rooms(ALL, 'London 5', USER, FOREIGN), { rooms: [] }, 'another company: nothing, no error');
    for (const bad of ['', '   ', 'x'.repeat(61), 'a\u0001b']) await assert.rejects(rooms(ALL, bad), code('22023'), JSON.stringify(bad));
    await assert.rejects(rooms([], 'London 5'), code('22023'));
    await pool.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,name_sort,code,floor) SELECT ('${id(900).slice(0, -3)}'||lpad(g::text,3,'0'))::uuid,'${ORG}','${B3}','Cap '||g,'cap',NULL,1 FROM generate_series(1,60) g`);
    assert.equal((await rooms([B3], 'cap')).rooms.length, 50, 'capped at 50 rows');
  });
  await t.test('company name: the member reads its own company; another company or a non-member is 42501; anon cannot execute', async () => {
    assert.deepEqual(await company(ORG), { id: ORG, name: 'Công ty Thử' });
    assert.deepEqual(await company(ORG, USER2), { id: ORG, name: 'Công ty Thử' });
    await assert.rejects(company(FOREIGN), code('42501'));
    await assert.rejects(company(ORG, id(777)), code('42501'), 'not a member');
    await assert.rejects(jwt(pool, async c => c.query('SELECT public.hermes_organization_name_v1($1::uuid)', [null])), code('22023'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE anon');
      for (const call of ['public.hermes_organization_name_v1($1::uuid)', 'public.hermes_building_directory_v1($1::uuid,ARRAY[$1::uuid])', "public.hermes_room_directory_v1($1::uuid,ARRAY[$1::uuid],'x')"]) {
        await client.query('SAVEPOINT s');
        await assert.rejects(client.query(`SELECT ${call}`, [ORG]), code('42501'), call);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  await t.test('catalog: INVOKER directories without app_private, STABLE, owner postgres, EXECUTE only for authenticated', async () => {
    const { rows } = await pool.query(`SELECT p.proname,p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) AS owner,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS svc,pg_get_functiondef(p.oid) AS def FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.proname IN('hermes_building_directory_v1','hermes_room_directory_v1','hermes_organization_name_v1') ORDER BY p.proname`);
    assert.deepEqual(rows.map(row => [row.proname, row.prosecdef, row.provolatile, row.owner, row.auth, row.anon, row.svc]), [
      ['hermes_building_directory_v1', false, 's', 'postgres', true, false, false], ['hermes_organization_name_v1', true, 's', 'postgres', true, false, false],
      ['hermes_room_directory_v1', false, 's', 'postgres', true, false, false]]);
    for (const row of rows.filter(row => !row.prosecdef)) assert.doesNotMatch(row.def, /app_private/, row.proname);
  });
});

// R2c part 2 (c) (20261021044821): public.hermes_user_display_name_v1() — the display name of the CALLER's own profile,
// read under the caller's RLS (INVOKER), for crm_auth_context ("Tôi đang kết nối CRM bằng tài khoản nào?"). Proves: own
// name only (another user's JWT gives that user's own), sanitised text, null without a visible profile, RLS decides
// (a DEFINER mutant leaks the hidden name and is caught), anon/service_role denied, no email/phone, $requires$, revert.
const displayName = readdirSync('supabase/migrations').filter(name => /^\d{14}_hermes_user_display_name_v1\.sql$/.test(name));
test('user display name: the caller\'s own profile name under the caller\'s RLS; never another user, email or phone', { timeout: 240000 }, async t => {
  assert.equal(displayName.length, 1);
  const forward = readFileSync(`supabase/migrations/${displayName[0]}`, 'utf8');
  const revert = readFileSync('docs/plans/hermes-crm/revert/hermes_user_display_name_revert_v1.sql', 'utf8');
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  const [OTHER_USER, NO_PROFILE] = [30, 31].map(id);
  // The production shape of profiles that matters here, and its self-view RLS ("Users can view own profile").
  await pool.query(`CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text NOT NULL CHECK (char_length(full_name)>0),phone text,email text);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid()=id);
    GRANT SELECT ON public.profiles TO authenticated;
    INSERT INTO public.profiles VALUES('${USER}','  Người Dùng'||chr(10)||'Thử  ','0900000001','nguoi.dung@example.invalid'),
      ('${OTHER_USER}',repeat('Ă',130),null,'khac@example.invalid');`);
  await pool.query(forward); await pool.query(forward); // idempotent, as the lane runs it twice
  const read = user => jwt(pool, async c => (await c.query('SELECT public.hermes_user_display_name_v1() value')).rows[0].value, user);
  assert.deepEqual(await read(USER), { id: USER, name: 'Người Dùng Thử' }, 'own name; the newline becomes a space, outer spaces trimmed');
  assert.deepEqual(await read(OTHER_USER), { id: OTHER_USER, name: 'Ă'.repeat(120) }, 'another JWT: that user\'s own name only, 120 characters');
  assert.deepEqual(await read(NO_PROFILE), { id: NO_PROFILE, name: null }, 'no profile: null');
  const answer = JSON.stringify(await read(USER));
  assert.ok(!answer.includes('example.invalid') && !answer.includes('0900000001'), 'never email or phone');
  // RLS decides: without the self-view policy the caller sees no profile and gets null (INVOKER). A DEFINER mutant would
  // bypass RLS and leak the name — caught here.
  const live = forward.slice(forward.indexOf('CREATE OR REPLACE FUNCTION public.hermes_user_display_name_v1()'), forward.indexOf('END $fn$;') + 'END $fn$;'.length);
  await pool.query('DROP POLICY "Users can view own profile" ON public.profiles');
  try {
    assert.deepEqual(await read(USER), { id: USER, name: null }, 'RLS hides the profile: null');
    await pool.query(live.replace('SECURITY INVOKER', 'SECURITY DEFINER'));
    await assert.rejects(async () => assert.deepEqual(await read(USER), { id: USER, name: null }), { code: 'ERR_ASSERTION' }, 'the DEFINER mutant leaks the hidden name');
    await pool.query(live);
  } finally { await pool.query('CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid()=id)'); }
  assert.equal((await read(USER)).name, 'Người Dùng Thử');
  // Roles: anon and service_role cannot execute; authenticated without a user id is refused.
  for (const role of ['anon', 'service_role']) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(client.query('SELECT public.hermes_user_display_name_v1()'), /permission denied/, role);
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  }
  const anonymous = await pool.connect();
  try { await anonymous.query('BEGIN'); await anonymous.query("SELECT set_config('request.jwt.claim.role','authenticated',true)"); await anonymous.query('SET LOCAL ROLE authenticated');
    await assert.rejects(anonymous.query('SELECT public.hermes_user_display_name_v1()'), error => error.code === '42501');
  } finally { await anonymous.query('ROLLBACK').catch(() => {}); anonymous.release(); }
  // Catalog: INVOKER, STABLE, owner postgres, fixed search path, exact ACL.
  const row = (await pool.query(`SELECT p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) owner,p.proconfig,
    has_function_privilege('authenticated',p.oid,'EXECUTE') a,has_function_privilege('anon',p.oid,'EXECUTE') n,has_function_privilege('service_role',p.oid,'EXECUTE') s,
    has_function_privilege('hermes_store_executor',p.oid,'EXECUTE') h FROM pg_proc p WHERE p.oid='public.hermes_user_display_name_v1()'::regprocedure`)).rows[0];
  assert.deepEqual(row, { prosecdef: false, provolatile: 's', owner: 'postgres', proconfig: ['search_path=pg_catalog, public'], a: true, n: false, s: false, h: false });
  // $requires$: without profiles.full_name the file stops (one transaction, nothing created).
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('DROP FUNCTION public.hermes_user_display_name_v1()'); await client.query('ALTER TABLE public.profiles RENAME COLUMN full_name TO display_name');
    await assert.rejects(client.query(forward), /hermes_user_display_name_dependency_invalid: public\.profiles\.full_name/);
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  assert.equal((await read(USER)).name, 'Người Dùng Thử', 'rolled back: the function is still there');
  // Revert artifact: removes the function (PostgREST answers PGRST202 ⇒ the connector reports null); twice; forward again.
  await pool.query(revert); await pool.query(revert);
  assert.equal((await pool.query("SELECT to_regprocedure('public.hermes_user_display_name_v1()') v")).rows[0].v, null);
  await pool.query(forward);
  assert.deepEqual(await read(USER), { id: USER, name: 'Người Dùng Thử' });
});
