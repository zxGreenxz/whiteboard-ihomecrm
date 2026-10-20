import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { localCluster, setup, jwt, settings, live, id, ORG, FOREIGN, USER, BUILDING, OTHER_BUILDING, ROOM } from './crm-shared-read-sql-fixture.mjs';
import { projectAvailableRooms, projectAvailableRoomsPage } from './room-read-projection.mjs';

// B3 candidate SQL (hermes_available_rooms_page_v1) against the REAL oracle on a disposable
// PostgreSQL 17 cluster: the production definitions of get_public_available_rooms,
// hermes_sale_listing_payload_v1/rooms_v1, room_sale_workflow_fact_v1 and the Hermes
// admission closure (connection/token/session/policy/metadata grant) run unmodified over
// synthetic data. Oracle = legacy wrapper + projectAvailableRooms (what the connector serves
// today); candidate = page RPC + projectAvailableRoomsPage. Every page must equal the matching
// legacy slice except the source label. Synthetic data only; not evidence of PostgREST/JWT.
// The cluster uses the PostgreSQL 17 builtin C.UTF-8 provider so lower() folds Vietnamese
// letters like the production libc UTF-8 locale (R7: production lc_ctype not measured here).
const slug = 'hermes_available_rooms_page_v1';
const migrationName = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
assert.equal(migrationName.length, 1);
const pageSql = readFileSync(`supabase/migrations/${migrationName[0]}`, 'utf8').replaceAll('\r\n', '\n');
const NOW = Date.parse('2026-10-19T08:00:00Z');
const USER2 = id(20), USER3 = id(21), SESSION = id(32);
const B = { a: id(601), b: id(602), c: id(603), d: id(604), v: id(605), x: id(606), f: id(607), dup: id(608), pct: id(609) };
const R = n => id(700 + n);
const H = { a1: id(811), a2: id(812), c1: id(813), c2: id(814), d1: id(815) };
const SCOPE = { building: id(801), area: id(803), cashbook: id(804) }, AREA = id(802), ACCOUNT = id(805);
const HIDDEN_PHONE = '0900000005', HIDDEN_NAME = 'Khách Ẩn';
const code = expected => error => error.code === expected;
const lit = value => value === null || value === undefined ? 'NULL' : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const row = (columns, values) => `(${columns.map(column => lit(values[column])).join(',')})`;
const insert = (table, columns, rows) => `INSERT INTO ${table}(${columns.join(',')}) VALUES ${rows.map(values => row(columns, values)).join(',')};`;

function dataSql() {
  const building = (id, user, name, extra = {}) => ({ id, organization_id: ORG, user_id: user, name, name_sort: name.toLowerCase(), code: name.replace(/\s+/g, ''),
    is_virtual: false, deleted_at: null, province: 'TP', district: 'Quận 2', ward: 'Phường 1', street_address: null, public_contact_name: null, public_contact_phone: null, ...extra });
  const buildings = [
    building(B.a, USER, 'Tòa A', { street_address: 'Số 1, Đường X', public_contact_name: 'Quản lý A', public_contact_phone: '0900000011' }),
    building(B.b, USER, 'Tòa B', { street_address: '12 Đường Y' }),
    building(B.c, USER2, 'Tòa C', { street_address: '', public_contact_name: ' ', public_contact_phone: '' }),
    building(B.d, USER3, 'Tòa D'), building(B.v, USER, 'Tòa V', { is_virtual: true }),
    building(B.x, USER, 'Tòa X', { deleted_at: '2026-01-01T00:00:00Z' }),
    { ...building(B.f, USER, 'Tòa F'), organization_id: FOREIGN },
    building(B.dup, USER, 'Tòa A', { street_address: 'Số 9, Đường Z' }), building(B.pct, USER, 'Tòa 100%_Full'),
  ];
  const room = (id, building, name, extra = {}) => ({ id, organization_id: ORG, building_id: building, name, name_sort: name, deleted_at: null, code: `P${name}`,
    floor: Number(name[0]), status: 'AVAILABLE', area: 20.5, rent_price: 3000000, deposit_amount: 3000000, description: null, amenities: '["Máy lạnh"]',
    sale_note: null, room_type: null, images: '["https://example.invalid/PRIVATE_IMAGE"]', sale_bonus_note: 'PRIVATE_BONUS', ...extra });
  const rooms = [
    room(R(1), B.a, '101'), room(R(2), B.a, '102'),
    room(R(3), B.a, '201', { status: 'OCCUPIED' }), room(R(4), B.a, '202', { status: 'OCCUPIED' }), room(R(5), B.a, '203', { status: 'OCCUPIED' }),
    room(R(6), B.a, '301', { status: 'OCCUPIED' }), room(R(7), B.a, '302', { status: 'RESERVED' }), room(R(8), B.a, '303'), room(R(9), B.a, '304'),
    room(R(10), B.a, '305'), room(R(11), B.a, '306', { status: 'MAINTENANCE' }),
    room(R(12), B.a, '401', { status: 'OCCUPIED', rent_price: 3300000 }), room(R(13), B.a, '402', { status: 'OCCUPIED' }), room(R(14), B.a, '403', { status: 'OCCUPIED' }),
    room(R(15), B.a, '404', { status: 'OCCUPIED' }), room(R(16), B.a, '405', { status: 'OCCUPIED' }), room(R(17), B.a, '406', { deleted_at: '2026-02-01T00:00:00Z' }),
    room(R(18), B.a, '407'),
    room(R(19), B.a, '501', { description: 'd'.repeat(300), sale_note: 'n'.repeat(300), room_type: 'Studio ' + 't'.repeat(150), amenities: '["Máy lạnh",{"name":"Tủ lạnh"},"Giường"]', area: 25.5 }),
    room(R(20), B.a, '502', { floor: null, area: null, rent_price: null, deposit_amount: null, amenities: null, description: ' Mô tả ' }),
    room(R(21), B.b, '101'), room(R(22), B.b, '102', { status: 'OCCUPIED' }), room(R(35), B.b, '201'), room(R(36), B.b, '202'),
    room(R(23), B.c, '101', { status: 'OCCUPIED' }), room(R(24), B.c, '102', { status: 'OCCUPIED' }), room(R(25), B.c, '103'),
    room(R(26), B.c, '104', { status: 'OCCUPIED', rent_price: 4000000 }), room(R(27), B.c, '105', { status: 'OCCUPIED' }),
    room(R(28), B.d, '101'), room(R(29), B.v, '101'), room(R(30), B.x, '101'), { ...room(R(31), B.f, '101'), organization_id: FOREIGN },
    room(R(32), B.dup, '101'), room(R(33), B.pct, '101'), { ...room(R(34), B.a, '601'), organization_id: null },
  ];
  const contract = (n, roomId, extra = {}) => ({ id: id(900 + n), organization_id: ORG, user_id: USER, room_id: roomId, status: 'ACTIVE', contract_number: `HD${n}`,
    start_date: '2026-01-01', end_date: '2027-12-31', expected_move_out_date: null, actual_end_date: null, deleted_at: null, created_at: '2026-01-01', ...extra });
  const contracts = [
    contract(1, R(1), { status: 'TERMINATED', actual_end_date: '2026-05-01' }), contract(2, R(2), { deleted_at: '2026-06-01T00:00:00Z' }),
    contract(3, R(3), { expected_move_out_date: '2026-11-10' }), contract(4, R(4), { expected_move_out_date: '2026-11-18' }),
    contract(5, R(5), { expected_move_out_date: '2026-11-19' }), contract(6, R(6), { expected_move_out_date: '2026-10-01' }),
    contract(12, R(12)), contract(13, R(13)), contract(14, R(14)), contract(15, R(15)), contract(16, R(16), { start_date: '2026-12-01' }),
    contract(22, R(22), { expected_move_out_date: '2026-10-30' }), contract(23, R(23), { expected_move_out_date: '2026-11-10' }),
    contract(24, R(24), { expected_move_out_date: '2026-10-25' }), contract(26, R(26)), contract(27, R(27)),
  ];
  const pass = (roomId, user, building, extra = {}) => ({ user_id: user, building_id: building, room_id: roomId, organization_id: ORG, active: true,
    contact_name: null, contact_phone: null, sale_policy: null, pass_price: null, avail_date: null, contact_manager: false, ...extra });
  const passes = [
    pass(R(12), USER, B.a, { contact_manager: true, contact_name: HIDDEN_NAME, contact_phone: HIDDEN_PHONE, pass_price: 2900000, sale_policy: 'Chính sách pass 12' }),
    pass(R(13), USER, B.a, { contact_name: 'Khách Thử', contact_phone: '0900000002', pass_price: 2800000, avail_date: '2026-12-01', sale_policy: 'p'.repeat(300) }),
    pass(R(14), USER, B.a, { contact_name: 'k'.repeat(100), contact_phone: '9'.repeat(90), avail_date: '2026-10-01' }),
    pass(R(15), USER3, B.a, { contact_phone: '0900000015' }), pass(R(16), USER, B.a), pass(R(18), USER, B.a, { active: false }),
    pass(R(26), USER2, B.c, { contact_name: 'Khách C', contact_phone: '0900000007', pass_price: 3500000 }), pass(R(27), USER, B.c),
  ];
  return [
    `INSERT INTO auth.users(id) VALUES('${USER2}'),('${USER3}') ON CONFLICT DO NOTHING;`,
    insert('public.buildings', ['id', 'organization_id', 'user_id', 'name', 'name_sort', 'code', 'is_virtual', 'deleted_at', 'province', 'district', 'ward', 'street_address', 'public_contact_name', 'public_contact_phone'], buildings),
    insert('public.rooms', ['id', 'organization_id', 'building_id', 'name', 'name_sort', 'deleted_at', 'code', 'floor', 'status', 'area', 'rent_price', 'deposit_amount', 'description', 'amenities', 'sale_note', 'room_type', 'images', 'sale_bonus_note'], rooms),
    insert('public.contracts', ['id', 'organization_id', 'user_id', 'room_id', 'status', 'contract_number', 'start_date', 'end_date', 'expected_move_out_date', 'actual_end_date', 'deleted_at', 'created_at'], contracts),
    insert('public.room_pass_listings', ['user_id', 'building_id', 'room_id', 'organization_id', 'active', 'contact_name', 'contact_phone', 'sale_policy', 'pass_price', 'avail_date', 'contact_manager'], passes),
    insert('public.hotlines', ['id', 'user_id', 'name', 'phone_number', 'is_active', 'created_at', 'organization_id'], [
      { id: H.a1, user_id: USER, name: 'Hotline A1', phone_number: '0900000001', is_active: true, created_at: '2026-01-01', organization_id: ORG },
      { id: H.a2, user_id: USER, name: 'Hotline A2', phone_number: '0900000003', is_active: true, created_at: '2026-02-01', organization_id: ORG },
      { id: H.c1, user_id: USER2, name: 'Hotline C1', phone_number: '0900000021', is_active: true, created_at: '2026-01-01', organization_id: ORG },
      { id: H.c2, user_id: USER2, name: 'Hotline C2', phone_number: '0900000022', is_active: true, created_at: '2026-03-01', organization_id: ORG },
      { id: H.d1, user_id: USER3, name: 'Hotline D', phone_number: '0900000031', is_active: true, created_at: '2026-01-01', organization_id: ORG }]),
    insert('public.public_room_settings', ['owner_id', 'soon_days', 'hotline_id', 'sale_policy', 'organization_id'], [
      { owner_id: USER, soon_days: 30, hotline_id: null, sale_policy: 'Chính sách A', organization_id: ORG },
      { owner_id: USER2, soon_days: 10, hotline_id: H.c2, sale_policy: '  Chính sách C  ', organization_id: ORG }]),
    insert('public.public_room_share_tokens', ['token', 'owner_id', 'organization_id', 'revoked', 'created_at'], [
      { token: 'tok-PRIVATE-a1', owner_id: USER, organization_id: ORG, revoked: false, created_at: '2026-01-01' },
      { token: 'tok-PRIVATE-a2', owner_id: USER, organization_id: ORG, revoked: false, created_at: '2026-02-01' },
      { token: 'tok-PRIVATE-c', owner_id: USER2, organization_id: ORG, revoked: false, created_at: '2026-01-01' },
      { token: 'tok-PRIVATE-d', owner_id: USER3, organization_id: ORG, revoked: true, created_at: '2026-01-01' },
      { token: 'tok-PRIVATE-f', owner_id: USER, organization_id: FOREIGN, revoked: false, created_at: '2026-01-01' }]),
    insert('public.room_turnovers', ['organization_id', 'room_id', 'status', 'expected_ready_on'], [
      { organization_id: ORG, room_id: R(2), status: 'PENDING', expected_ready_on: '2026-10-25' },
      { organization_id: ORG, room_id: R(35), status: 'PENDING', expected_ready_on: null },
      { organization_id: ORG, room_id: R(36), status: 'PENDING', expected_ready_on: '2026-10-01' }]),
    insert('public.deposits', ['room_id', 'contract_id', 'status', 'organization_id'], [{ room_id: R(8), contract_id: null, status: 'PENDING', organization_id: ORG }]),
    insert('public.room_next_claims', ['organization_id', 'room_id', 'status'], [{ organization_id: ORG, room_id: R(9), status: 'LIVE' }]),
    `INSERT INTO public.room_sale_locks(organization_id,building_id,room_id,released_at,expires_at) VALUES
      ('${ORG}','${B.a}','${R(10)}',NULL,now()+interval '1 hour'),('${ORG}','${B.a}','${R(1)}',now()-interval '1 hour',now()+interval '1 hour'),
      ('${ORG}','${B.b}','${R(21)}',NULL,now()-interval '1 minute');`,
    `INSERT INTO public.areas(id,organization_id,deleted_at,user_id,name) VALUES('${AREA}','${ORG}',NULL,'${USER}','Khu 1');
     INSERT INTO public.area_buildings(organization_id,area_id,building_id) VALUES('${ORG}','${AREA}','${B.b}'),('${ORG}','${AREA}','${B.c}');
     INSERT INTO public.accounts(id,organization_id) VALUES('${ACCOUNT}','${ORG}');
     INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id,area_id,cashbook_id) VALUES
       ('${SCOPE.building}','${ORG}','BUILDING','${B.a}',NULL,NULL),('${SCOPE.area}','${ORG}','AREA',NULL,'${AREA}',NULL),('${SCOPE.cashbook}','${ORG}','CASHBOOK',NULL,NULL,'${ACCOUNT}');`,
  ].join('\n');
}

const SCHEMA = `
ALTER TABLE public.rooms ADD COLUMN code text,ADD COLUMN floor integer,ADD COLUMN status text NOT NULL DEFAULT 'AVAILABLE',ADD COLUMN area numeric(10,2),
  ADD COLUMN max_occupants integer,ADD COLUMN rent_price numeric(15,2),ADD COLUMN deposit_amount numeric(15,2),ADD COLUMN description text,
  ADD COLUMN images jsonb DEFAULT '[]',ADD COLUMN amenities jsonb DEFAULT '[]',ADD COLUMN sale_note text,ADD COLUMN room_type text,ADD COLUMN sale_bonus_note text;
ALTER TABLE public.buildings ADD COLUMN code text,ADD COLUMN is_virtual boolean NOT NULL DEFAULT false,ADD COLUMN province text,ADD COLUMN district text,
  ADD COLUMN ward text,ADD COLUMN street_address text,ADD COLUMN total_floors integer,ADD COLUMN floor_layouts jsonb,ADD COLUMN images jsonb DEFAULT '[]',
  ADD COLUMN public_contact_name text,ADD COLUMN public_contact_phone text,ADD COLUMN public_map_url text,ADD COLUMN public_lift_type text;
ALTER TABLE public.areas ADD COLUMN user_id uuid,ADD COLUMN name text;
CREATE TABLE public.public_room_share_tokens(token text PRIMARY KEY,owner_id uuid NOT NULL,label text,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),organization_id uuid);
CREATE TABLE public.public_room_settings(owner_id uuid PRIMARY KEY,soon_days integer NOT NULL DEFAULT 30,show_rented boolean NOT NULL DEFAULT true,hotline_id uuid,updated_at timestamptz NOT NULL DEFAULT now(),organization_id uuid,sale_policy text);
CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,building_id uuid NOT NULL,room_id uuid NOT NULL,contact_name text,contact_phone text,sale_policy text,pass_price numeric,active boolean NOT NULL DEFAULT true,avail_date date,contact_manager boolean NOT NULL DEFAULT false,organization_id uuid);
CREATE TABLE public.hotlines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,phone_number text NOT NULL,is_active boolean DEFAULT true,user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),organization_id uuid);
CREATE TABLE public.room_turnovers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,room_id uuid NOT NULL UNIQUE,status text NOT NULL,expected_ready_on date);
CREATE TABLE public.room_next_claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,room_id uuid NOT NULL,reservation_id uuid,status text NOT NULL DEFAULT 'LIVE');
CREATE TABLE public.room_sale_locks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,building_id uuid,room_id uuid NOT NULL,released_at timestamptz,expires_at timestamptz NOT NULL);
CREATE TABLE public.building_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),building_id uuid NOT NULL,service_id uuid NOT NULL,is_active boolean NOT NULL DEFAULT true,unit_price_override numeric(15,2),organization_id uuid);
CREATE TABLE public.services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,name text,type text,unit_price numeric(15,2) DEFAULT 0,unit text,deleted_at timestamptz,organization_id uuid);
CREATE TABLE public.deposits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,contract_id uuid,status text NOT NULL DEFAULT 'PENDING',deleted_at timestamptz,organization_id uuid);
CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,contract_id uuid,type text,approval_status text,deleted_at timestamptz,organization_id uuid);
CREATE FUNCTION public.ie_has_deposit_item(p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`;
const ORACLE_FUNCTIONS = ['public.room_has_holding_deposit', 'app_private.room_sale_workflow_base_fact_v1', 'app_private.room_sale_lock_open_id_v1',
  'app_private.room_sale_workflow_fact_v1', 'public.get_public_available_rooms', 'app_private.hermes_sale_listing_payload_v1',
  'public.hermes_scope_buildings_v1', 'public.hermes_sale_listing_rooms_v1'];

async function installFixture(pool) {
  await setup(pool);
  await pool.query(SCHEMA);
  for (const name of ORACLE_FUNCTIONS) { assert(live.has(name), name); await pool.query(live.get(name)); }
  await pool.query(dataSql());
  await pool.query(pageSql); await pool.query(pageSql); // Idempotent forward file.
}
async function connection(pool) {
  const prepared = await jwt(pool, async c => (await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value", [ORG])).rows[0].value);
  const tokenDigest = 'b'.repeat(64), expiry = Date.now() + 600000;
  const activated = (await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value', [JSON.stringify({ connectionId: prepared.id, expectedEpoch: 1,
    operationId: id(33), intentSecret: prepared.intentSecret, userId: USER, providerSessionId: SESSION, credentialRef: id(31), tokenDigest, tokenExpiresAt: expiry,
    sessionExpiresAt: Date.now() + 3600000, sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abcd' } })])).rows[0].value;
  return { connection: activated.connection, tokenDigest, expiry, binding: { connectionId: prepared.id, tokenDigest, expectedEpoch: 2, expectedSessionRevision: 1 } };
}
// One statement as the authenticated user with the JWT claims PostgREST would expose.
async function asUser(client, user, session) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',$2,true)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await client.query('SET LOCAL ROLE authenticated');
}
async function pageRaw(pool, binding, args = {}, actor = {}) {
  return jwt(pool, async c => {
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.user ?? USER, session_id: actor.session ?? SESSION })]);
    return (await c.query('SELECT public.hermes_available_rooms_page_v1($1::jsonb,$2::uuid,$3::uuid[],$4,$5::text[],$6,$7) value',
      [JSON.stringify(binding), args.organizationId ?? ORG, args.buildingIds ?? null, args.buildingName ?? '', args.statuses ?? null, args.limit ?? 50, args.offset ?? 0])).rows[0].value;
  }, actor.user ?? USER);
}
async function candidate(pool, binding, args = {}) {
  const value = await pageRaw(pool, binding, args);
  return { value, projected: projectAvailableRoomsPage(value.result, { offset: args.offset ?? 0, limit: args.limit ?? 50, readAt: NOW }) };
}
async function oracle(pool, allowed, args = {}) {
  const payload = await jwt(pool, async c => (await c.query('SELECT public.hermes_sale_listing_rooms_v1($1::uuid) value', [ORG])).rows[0].value);
  return projectAvailableRooms(payload, { allowedBuildingIds: allowed, buildingName: args.buildingName ?? '', offset: args.offset ?? 0, limit: args.limit ?? 50, readAt: NOW });
}
const permitted = pool => jwt(pool, async c => (await c.query("SELECT public.hermes_scope_buildings_v1('rooms.view',$1::uuid) value", [ORG])).rows[0].value);
const strip = ({ source, ...rest }) => rest;
const ids = result => result.rooms.map(room => room.id);

test('B3: hermes_available_rooms_page_v1 equals the legacy sale-page read slice by slice on the real oracle (PG17)', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  t.after(async () => { await pool.end(); cleanup(); });
  await installFixture(pool);
  const created = await connection(pool), { tokenDigest, expiry, binding } = created;
  let current = created.connection;
  // Re-limit the one connection (epoch bump) and keep the binding current.
  const reconfigure = async (exclusions = { read: [], action: [] }, scopeMode = 'unrestricted', scopeIds = []) => {
    current = await settings(pool, current, exclusions, scopeMode, scopeIds); binding.expectedEpoch = current.epoch; return current;
  };
  const all = await permitted(pool);
  assert.deepEqual([...all].sort(), [BUILDING, B.a, B.b, B.c, B.d, B.v, B.dup, B.pct].sort(), 'rooms.view scope: live company buildings incl. the virtual one, never deleted/foreign');
  const ORDER = [R(33), R(19), R(12), R(13), R(14), R(18), R(6), R(3), R(4), R(1), R(2), R(20), R(32), R(35), R(36), R(21), R(22), R(24), R(25), R(26)];

  await t.test('P1/P5/P6: one owner-aware page equals the legacy projection; every sale state and the hidden pass contact behave as the page', async () => {
    const { value, projected } = await candidate(pool, binding, { limit: 100 });
    assert.deepEqual(value.authority, { organizationId: ORG, userId: USER, connectionId: binding.connectionId, permission: 'rooms.view', buildingIds: [...all].sort(), cashbookIds: [] });
    const expected = await oracle(pool, all, { limit: 100 });
    assert.equal(projected.source, 'hermes_available_rooms_page_v1'); assert.equal(expected.source, 'hermes_sale_listing_rooms_v1');
    assert.deepEqual(strip(projected), strip(expected));
    const by = Object.fromEntries(projected.rooms.map(room => [room.id, room]));
    assert.deepEqual(ids(projected), ORDER, 'order: building name/id (digits before letters, duplicate name by id), floor desc nulls last, room name, id');
    assert.deepEqual([by[R(1)].availability.kind, by[R(2)].availability, by[R(3)].availability, by[R(4)].availability, by[R(6)].availability],
      ['ready', { kind: 'preparing', label: 'Đang chuẩn bị · dự kiến 25/10/2026', availableOn: '2026-10-25' },
        { kind: 'notice', label: 'Sắp trống · 10/11/2026', availableOn: '2026-11-10' }, { kind: 'notice', label: 'Sắp trống · 18/11/2026', availableOn: '2026-11-18' },
        { kind: 'confirm_notice', label: 'Cần xác nhận ngày trống', availableOn: null }]);
    assert.deepEqual([by[R(35)].availability.label, by[R(36)].availability.label], ['Đang chuẩn bị · chưa có ngày dự kiến', 'Đang chuẩn bị · cần xác nhận ngày sẵn sàng']);
    assert.deepEqual([by[R(12)].status, by[R(12)].priceVnd, by[R(12)].rentVnd, by[R(12)].availability.label, by[R(12)].salePolicy, by[R(12)].statusLines],
      ['pass', 2900000, 3300000, 'Khách pass phòng · Liên hệ admin iHome mở cửa', 'Chính sách pass 12', ['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA']]);
    assert.deepEqual(by[R(13)].availability, { kind: 'pass', label: 'Khách pass phòng: 0900000002 (Khách Thử)', availableOn: '2026-12-01' });
    assert.equal(by[R(13)].salePolicy.length, 240);
    assert.deepEqual([by[R(14)].priceVnd, by[R(14)].availability.availableOn, by[R(14)].availability.label], [3000000, null, `Khách pass phòng: ${'9'.repeat(79)}… (${'k'.repeat(79)}…)`]);
    assert.deepEqual([by[R(26)].status, by[R(26)].priceVnd, by[R(24)].availability.kind, by[R(22)].availability.kind], ['pass', 3500000, 'notice', 'notice']);
    assert.deepEqual([by[R(19)].amenities, by[R(19)].salePolicy.length, by[R(19)].roomType.length, by[R(19)].roomType.startsWith('Phòng 26m², Studio ')],
      ['Máy lạnh, Tủ lạnh, Giường', 240, 'Phòng 26m², '.length + 120, true]);
    assert.deepEqual([by[R(20)].floor, by[R(20)].areaM2, by[R(20)].priceVnd, by[R(20)].roomType, by[R(20)].amenities], [null, null, null, null, 'Mô tả']);
    for (const absent of [R(5), R(7), R(8), R(9), R(10), R(11), R(15), R(16), R(17), R(23), R(27), R(28), R(29), R(30), R(31), R(34), ROOM]) assert(!by[absent], `${absent} is not listed`);
    assert.deepEqual(projected.buildings.map(b => [b.id, b.address, b.contact]), [
      [B.pct, 'Phường 1, Quận 2, TP', { name: 'Hotline A1', phone: '0900000001' }],
      [B.a, 'Số 1, Đường X', { name: 'Quản lý A', phone: '0900000011' }], [B.dup, 'Số 9, Đường Z', { name: 'Hotline A1', phone: '0900000001' }],
      [B.b, '12 Đường Y, Phường 1, Quận 2, TP', { name: 'Hotline A1', phone: '0900000001' }], [B.c, 'Phường 1, Quận 2, TP', { name: 'Hotline C2', phone: '0900000022' }]]);
    assert.deepEqual(projected.salePolicies, ['Chính sách A', 'Chính sách C']);
    assert.deepEqual([projected.publishedPages, projected.totalInSnapshot, projected.nextOffset, projected.completeness, projected.listing], [2, 20, null, 'complete', 'published']);
    const text = JSON.stringify(value);
    for (const marker of ['tok-PRIVATE', 'PRIVATE_IMAGE', 'PRIVATE_BONUS', HIDDEN_PHONE, HIDDEN_NAME, '0900000015', 'example.invalid']) assert(!text.includes(marker), marker);
  });

  await t.test('P7: pages of the same snapshot concatenate to the whole list; the page beyond the end is empty', async () => {
    const full = await oracle(pool, all, { limit: 100 });
    const pages = [];
    for (let offset = 0; offset < full.totalInSnapshot; offset += 3) {
      const { projected } = await candidate(pool, binding, { offset, limit: 3 });
      assert.deepEqual(strip(projected), strip(await oracle(pool, all, { offset, limit: 3 })), `offset ${offset}`);
      assert.equal(projected.nextOffset, offset + 3 < full.totalInSnapshot ? offset + 3 : null);
      pages.push(...projected.rooms);
    }
    assert.deepEqual(pages, full.rooms);
    const { projected: beyond } = await candidate(pool, binding, { offset: 2000, limit: 5 });
    assert.deepEqual(strip(beyond), strip(await oracle(pool, all, { offset: 2000, limit: 5 })));
    assert.deepEqual([beyond.rooms, beyond.buildings, beyond.totalInSnapshot, beyond.nextOffset, beyond.salePolicies], [[], [], 20, null, ['Chính sách A', 'Chính sách C']]);
  });

  await t.test('P8: building-name filter is a case-insensitive substring (Vietnamese letters, % and _ literal, duplicate names)', async () => {
    for (const buildingName of ['tòa a', 'TÒA A', 'Tòa', 'tòa c', '100%_', '%', '_', 'Tòa_A', 'nope', ' Tòa A', 'a', 'A']) {
      const { projected } = await candidate(pool, binding, { buildingName, limit: 100 });
      assert.deepEqual(strip(projected), strip(await oracle(pool, all, { buildingName, limit: 100 })), buildingName);
    }
    assert.equal(ids((await candidate(pool, binding, { buildingName: 'TÒA A', limit: 100 })).projected).length, 12);
    assert.deepEqual(ids((await candidate(pool, binding, { buildingName: '100%_', limit: 100 })).projected), [R(33)]);
    assert.deepEqual(ids((await candidate(pool, binding, { buildingName: 'Tòa_A', limit: 100 })).projected), []);
    assert.deepEqual(ids((await candidate(pool, binding, { buildingName: ' Tòa A', limit: 100 })).projected), []);
  });

  await t.test('P9: the status filter is a pure subset of the same ordered list', async () => {
    const full = await oracle(pool, all, { limit: 100 });
    for (const statuses of [['pass'], ['free'], ['soon'], ['free', 'pass'], ['soon', 'free', 'pass']]) {
      for (const args of [{ limit: 100 }, { offset: 1, limit: 2 }]) {
        const { projected } = await candidate(pool, binding, { ...args, statuses });
        const rooms = full.rooms.filter(room => statuses.includes(room.status));
        const offset = args.offset ?? 0, page = rooms.slice(offset, offset + args.limit), used = new Set(page.map(room => room.building.id));
        assert.deepEqual(projected.rooms, page, JSON.stringify([statuses, args]));
        assert.deepEqual([projected.totalInSnapshot, projected.nextOffset], [rooms.length, offset + args.limit < rooms.length ? offset + args.limit : null]);
        assert.deepEqual(projected.buildings, full.buildings.filter(building => used.has(building.id)));
      }
    }
    for (const statuses of [[], ['rented'], ['free', 'free'], ['free', null], ['FREE']]) {
      await assert.rejects(pageRaw(pool, binding, { statuses }), code('22023'), JSON.stringify(statuses));
    }
  });

  await t.test('P2: no live share link is no_sale_page with zero rooms, not an empty published list', async () => {
    await pool.query('UPDATE public.public_room_share_tokens SET revoked=true WHERE organization_id=$1', [ORG]);
    try {
      const { projected } = await candidate(pool, binding, {});
      assert.deepEqual(strip(projected), strip(await oracle(pool, all, {})));
      assert.deepEqual([projected.listing, projected.publishedPages, projected.totalInSnapshot, projected.rooms, projected.buildings], ['no_sale_page', 0, 0, [], []]);
      assert.match(projected.notice, /không phải là hết phòng/);
    } finally { await pool.query("UPDATE public.public_room_share_tokens SET revoked=false WHERE organization_id=$1 AND token<>'tok-PRIVATE-d'", [ORG]); }
    // One owner's page withdrawn: the other owner's buildings stay, publishedPages drops to 1.
    await pool.query('UPDATE public.public_room_share_tokens SET revoked=true WHERE owner_id=$1', [USER2]);
    try {
      const { projected } = await candidate(pool, binding, { limit: 100 });
      assert.deepEqual(strip(projected), strip(await oracle(pool, all, { limit: 100 })));
      assert.equal(projected.publishedPages, 1); assert(!projected.buildings.some(b => b.id === B.c)); assert.deepEqual(projected.salePolicies, ['Chính sách A']);
    } finally { await pool.query('UPDATE public.public_room_share_tokens SET revoked=false WHERE owner_id=$1', [USER2]); }
  });

  await t.test('P4/P10: assistant scope BUILDING/AREA narrows like the legacy map; CASHBOOK-only grants no rooms; explicit narrowing is a subset', async () => {
    for (const [scope, allowed] of [[SCOPE.building, [B.a]], [SCOPE.area, [B.b, B.c]]]) {
      await reconfigure(undefined, 'restricted', [scope]);
      const { value, projected } = await candidate(pool, binding, { limit: 100 });
      assert.deepEqual(value.authority.buildingIds, [...allowed].sort());
      assert.deepEqual(strip(projected), strip(await oracle(pool, allowed, { limit: 100 })));
      assert(projected.rooms.length > 0 && projected.rooms.every(room => allowed.includes(room.building.id)));
      // Narrowing inside the derived set is allowed; any building outside it (even a company one) denies.
      const narrowed = await candidate(pool, binding, { buildingIds: [allowed[0]], limit: 100 });
      assert.deepEqual(strip(narrowed.projected), strip(await oracle(pool, [allowed[0]], { limit: 100 })));
      await assert.rejects(pageRaw(pool, binding, { buildingIds: [B.a, B.b] }), code('42501'));
      await assert.rejects(pageRaw(pool, binding, { buildingIds: [OTHER_BUILDING] }), code('42501'));
      await assert.rejects(pageRaw(pool, binding, { buildingIds: [] }), code('22023'));
    }
    await reconfigure(undefined, 'restricted', [SCOPE.cashbook]);
    await assert.rejects(pageRaw(pool, binding), code('42501'));
    await reconfigure();
    assert.deepEqual(strip((await candidate(pool, binding, { limit: 100 })).projected), strip(await oracle(pool, all, { limit: 100 })));
  });

  await t.test('S1–S8: foreign user, wrong/revoked/expired token, epoch/revision, session, excluded key, CRM DENY, policy off, org and ACL are refused before any room row', async () => {
    const deny = (bound, args, actor) => assert.rejects(pageRaw(pool, bound, args, actor), code('42501'));
    await deny(binding, {}, { user: id(997) });
    await deny({ ...binding, tokenDigest: 'c'.repeat(64) });
    await deny({ ...binding, connectionId: id(996) });
    await deny(binding, {}, { session: id(998) });
    await deny(binding, { organizationId: FOREIGN });
    await assert.rejects(pageRaw(pool, { ...binding, expectedEpoch: binding.expectedEpoch + 1 }), code('PT409'));
    await assert.rejects(pageRaw(pool, { ...binding, expectedSessionRevision: 2 }), code('PT409'));
    for (const malformed of [{ ...binding, extra: 1 }, { connectionId: binding.connectionId, tokenDigest, expectedEpoch: binding.expectedEpoch }, { ...binding, expectedEpoch: 0 },
      { ...binding, tokenDigest: 'not-hex' }]) await assert.rejects(pageRaw(pool, malformed), code('22023'), JSON.stringify(malformed));
    for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 2001 }, { buildingName: 'x'.repeat(121) }, { buildingIds: [B.a, B.a] }]) {
      await assert.rejects(pageRaw(pool, binding, args), code('22023'), JSON.stringify(args));
    }
    await pool.query('UPDATE app_private.hermes_connection_tokens SET revoked_at=now() WHERE token_digest=$1', [tokenDigest]);
    await deny(binding);
    await pool.query("UPDATE app_private.hermes_connection_tokens SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE token_digest=$1", [tokenDigest]);
    await deny(binding);
    await pool.query('UPDATE app_private.hermes_connection_tokens SET expires_at=to_timestamp($2/1000.0) WHERE token_digest=$1', [tokenDigest, expiry]);
    await reconfigure({ read: ['rooms.view'], action: [] });
    await deny(binding);
    await reconfigure();
    await pool.query("UPDATE public.role_permissions SET effect='DENY' WHERE permission_key='rooms.view'");
    await deny(binding);
    await pool.query("UPDATE public.role_permissions SET effect='ALLOW' WHERE permission_key='rooms.view'");
    // Company policy off: the live overlay denies even though CRM still grants rooms.view.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,action_capabilities,scope_ids,updated_by) VALUES($1,false,1,'{}','{}','{}',$2)", [ORG, USER]);
      await asUser(client, USER, SESSION);
      await assert.rejects(client.query('SELECT public.hermes_available_rooms_page_v1($1::jsonb,$2::uuid) value', [JSON.stringify(binding), ORG]), code('42501'));
    } finally { await client.query('ROLLBACK'); client.release(); }
    // ACL: only authenticated executes the page function; the admission helper is private.
    const signature = 'public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)';
    for (const role of ['anon', 'service_role', 'hermes_store_executor']) {
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') value", [role, signature])).rows[0].value, false, role);
    }
    assert.equal((await pool.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') value", [signature])).rows[0].value, true);
    assert.equal((await pool.query("SELECT has_function_privilege('authenticated','app_private.hermes_room_page_admission_v1(jsonb)','EXECUTE') value")).rows[0].value, false);
    const anon = await pool.connect();
    try {
      await anon.query('BEGIN'); await anon.query("SELECT set_config('request.jwt.claim.role','anon',true)"); await anon.query('SET LOCAL ROLE anon');
      await assert.rejects(anon.query('SELECT public.hermes_available_rooms_page_v1($1::jsonb,$2::uuid) value', [JSON.stringify(binding), ORG]), code('42501'));
    } finally { await anon.query('ROLLBACK'); anon.release(); }
    assert.deepEqual(strip((await candidate(pool, binding, { limit: 100 })).projected), strip(await oracle(pool, all, { limit: 100 })), 'clean read still equals the oracle');
  });

  await t.test('G4: each hand mutation of the candidate SQL changes an observation (owners, static building, pass owner, hidden contact, soon_days, base fact, status, narrowing, epoch, ILIKE)', async () => {
    const fn = name => { const match = pageSql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?END \\$fn\\$;`)); assert(match, name); return match[0]; };
    const page = fn('public.hermes_available_rooms_page_v1'), admission = fn('app_private.hermes_room_page_admission_v1');
    const roomIds = async (bound = binding, args = {}) => (await pageRaw(pool, bound, { limit: 100, ...args })).result.rooms.map(room => room.id).sort();
    const clean = await roomIds();
    assert.deepEqual(clean, [...ORDER].sort());
    const mutants = [
      ['owners', page, 'JOIN owners o ON o.owner_id=b.user_id', 'LEFT JOIN owners o ON o.owner_id=b.user_id', async () => assert((await roomIds()).includes(R(28)))],
      ['static building', page, 'AND b.is_virtual=false AND b.deleted_at IS NULL AND b.id=ANY(v_scope)', 'AND b.id=ANY(v_scope)', async () => assert((await roomIds()).includes(R(29)))],
      ['pass owner', page, 'AND pl.user_id=cb.owner_id AND pl.active=true', 'AND pl.active=true', async () => assert((await roomIds()).includes(R(15)))],
      ['hidden contact', page, "AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_phone,81) END AS pass_contact_phone", 'THEN left(pl.contact_phone,81) END AS pass_contact_phone',
        async () => assert(JSON.stringify(await pageRaw(pool, binding, { limit: 100 })).includes(HIDDEN_PHONE))],
      ['soon_days', page, 'pl.id IS NOT NULL,cb.soon_days) fact', 'pl.id IS NOT NULL,30) fact', async () => assert((await roomIds()).includes(R(23)))],
      ['base fact', page, 'CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(', 'CROSS JOIN LATERAL app_private.room_sale_workflow_base_fact_v1(', async () => assert((await roomIds()).includes(R(10)))],
      ['status', page, "WHERE f.status_public IN ('free','soon','pass') AND f.status_public=ANY(v_statuses)", 'WHERE true', async () => assert((await roomIds()).includes(R(5)))],
      ['narrowing', page, "IF NOT(p_building_ids<@v_scope) THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;", '',
        async () => { await reconfigure(undefined, 'restricted', [SCOPE.building]); try { assert((await roomIds(binding, { buildingIds: [B.b] })).includes(R(21))); } finally { await reconfigure(); } }],
      ['epoch', admission, "IF c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch' OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'", 'IF false',
        async () => assert.deepEqual(await roomIds({ ...binding, expectedEpoch: binding.expectedEpoch + 1 }), clean)],
      ['ILIKE', page, "(p_building_name='' OR strpos(lower(b.name),lower(p_building_name))>0)", "(p_building_name='' OR b.name ILIKE '%'||p_building_name||'%')",
        async () => assert((await roomIds(binding, { buildingName: 'Tòa_A' })).length > 0)],
    ];
    for (const [label, original, before, after, observe] of mutants) {
      const mutant = original.replace(before, after);
      assert.notEqual(mutant, original, `${label}: mutation applies`);
      await pool.query(mutant);
      try { await observe(); } finally { await pool.query(original); }
      assert.deepEqual(await roomIds(), clean, `${label}: restored`);
    }
    await reconfigure(undefined, 'restricted', [SCOPE.building]);
    await assert.rejects(pageRaw(pool, binding, { buildingIds: [B.b] }), code('42501'), 'narrowing restored');
    await reconfigure();
    await assert.rejects(pageRaw(pool, { ...binding, expectedEpoch: binding.expectedEpoch + 1 }), code('PT409'), 'epoch restored');
  });
});
