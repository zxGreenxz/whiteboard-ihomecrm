import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupUpsert, enablePath, BUILDING, ROOM, LISTING, SCOPE, binding, code, OWNER, BUILDING2, ROOM2, ROOM3, FOREIGN_ROOM, FOREIGN_BUILDING,
  SCOPE2, PHONE } from './room-pass-upsert-sql-fixture.mjs';
import { id, USER, ORG, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';
import { roomPassInput, roomPassResult, roomPassOperation, mayUseRoomPass, ROOM_PASS_TOOLS, ROOM_PASS_ACTION } from './room-pass-contract.mjs';

const req = n => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { row: { organizationId: ORG, userId: USER } };
const full = { requestId: req(1), roomId: ROOM, customerPhone: '0900000001', customerName: 'Duẩn', contactManager: false, passPrice: 3500000,
  availDate: '2026-11-01', salePolicy: 'Điện 3.5k/số; nước 100k/người; phí DV 150k/phòng; tối đa 2 người 2 xe', active: true };

test('room-pass upsert/lookup tools map to fixed operations behind the same independent Action', () => {
  assert.equal(roomPassOperation('crm_room_pass_upsert'), 'upsert');
  assert.equal(roomPassOperation('crm_room_lookup'), 'lookup');
  for (const name of ['__proto__', 'constructor', 'hasOwnProperty', 'crm_room_pass_delete', 'crm_room_pass_upsert_v1']) assert.equal(roomPassOperation(name), null);
  for (const operation of ['upsert', 'lookup']) {
    assert.equal(mayUseRoomPass({ read: [ROOM_PASS_ACTION, 'rooms.view'], action: [] }, operation), false, 'Read never grants the Action');
    assert.equal(mayUseRoomPass({ read: [], action: [ROOM_PASS_ACTION] }, operation), true);
  }
  const upsert = ROOM_PASS_TOOLS.find(tool => tool.name === 'crm_room_pass_upsert');
  assert.deepEqual(upsert.inputSchema.required, ['requestId', 'roomId']);
  assert.equal(upsert.inputSchema.additionalProperties, false);
  for (const phrase of ['crm_room_lookup', 'crm_new_request_id', 'năm hiện tại', 'năm tới', 'salePolicy', 'nội thất', 'crm_room_pass_status', 'Không đổi hợp đồng'])
    assert.ok(upsert.description.includes(phrase), phrase);
  // Production 16/10 14:42: "bạn tạo khách sang phòng được không" was read as moving a
  // tenant to another room. The description leads with what the task means (not a fixed
  // word list) and asks one short question when pass vs. room move is unclear.
  assert.ok(upsert.description.startsWith('Dùng khi khách đang thuê muốn tìm người thay / nhượng lại phòng của mình (pass phòng, sang phòng, khách nhờ sale).'));
  assert.ok(upsert.description.includes('hỏi lại một câu ngắn; Hermes chưa có công cụ chuyển hợp đồng sang phòng khác.'));
  const lookup = ROOM_PASS_TOOLS.find(tool => tool.name === 'crm_room_lookup');
  assert.equal(lookup.annotations.readOnlyHint, true);
  assert.ok(lookup.description.includes('đang có khách') || lookup.description.includes('ĐANG CÓ KHÁCH') || lookup.description.includes('đang có khách thuê'));
});

test('upsert input is normalized like the form and rejects every malformed or extra field', () => {
  const normalized = roomPassInput('upsert', { requestId: req(1), roomId: ROOM, customerPhone: '+84 354 058 160', customerName: '  Duẩn ', salePolicy: ' ',
    passPrice: 3500000, availDate: '2026-11-01' });
  assert.deepEqual(normalized, { requestId: req(1), roomId: ROOM, customerPhone: '0354058160', customerName: 'Duẩn', passPrice: 3500000, availDate: '2026-11-01' },
    'blank salePolicy is absent (keep), never a clear');
  assert.deepEqual(roomPassInput('upsert', normalized), normalized, 'normalization is idempotent across broker/service/adapter');
  assert.deepEqual(roomPassInput('upsert', { requestId: req(1), roomId: ROOM }), { requestId: req(1), roomId: ROOM }, 'absent stays absent (keep/default)');
  assert.deepEqual(roomPassInput('upsert', { requestId: req(1), roomId: ROOM, customerPhone: '', customerName: '   ', salePolicy: '', passPrice: 3200000 }),
    { requestId: req(1), roomId: ROOM, passPrice: 3200000 }, 'empty or blank text = absent: keep the stored phone, name and policy');
  assert.deepEqual(roomPassInput('upsert', { requestId: req(1), roomId: ROOM, customerPhone: ' . - ', customerName: null, salePolicy: null }),
    { requestId: req(1), roomId: ROOM, customerName: null, salePolicy: null }, 'only an explicit null clears');
  assert.deepEqual(roomPassInput('upsert', { requestId: req(1), roomId: ROOM, customerPhone: '0354.058.160', passPrice: null, availDate: null }),
    { requestId: req(1), roomId: ROOM, customerPhone: '0354058160', passPrice: null, availDate: null });
  for (const bad of [{ roomId: ROOM }, { requestId: req(1) }, { ...full, userId: USER }, { ...full, organizationId: ORG }, { ...full, listingId: LISTING },
    { ...full, customerPhone: '12345' }, { ...full, customerPhone: 354058160 }, { ...full, passPrice: 0 }, { ...full, passPrice: -1 }, { ...full, passPrice: 3500000.5 },
    { ...full, passPrice: '3500000' }, { ...full, passPrice: 1_000_000_001 }, { ...full, availDate: '2026-02-30' }, { ...full, availDate: '26-11-01' },
    { ...full, availDate: '1999-12-31' }, { ...full, salePolicy: 'x'.repeat(2001) }, { ...full, salePolicy: `a${String.fromCharCode(7)}b` },
    { ...full, customerName: 'x'.repeat(121) }, { ...full, customerName: `Duẩn${String.fromCharCode(10)}Lê` }, { ...full, contactManager: 'true' }, { ...full, active: 1 },
    { ...full, roomId: 'room-103' }, { ...full, requestId: 'req-1' }]) assert.throws(() => roomPassInput('upsert', bad), JSON.stringify(Object.keys(bad)));
  assert.equal(roomPassInput('upsert', { ...full, salePolicy: `Điện 3.5k${String.fromCharCode(10)}Nước 100k` }).salePolicy.includes(String.fromCharCode(10)), true, 'multi-line policy');
  assert.deepEqual(roomPassInput('lookup', { buildingName: ' 417/57   Lê Văn Thọ ', roomCode: ' 103 ' }), { buildingName: '417/57 Lê Văn Thọ', roomCode: '103' });
  for (const bad of [{ buildingName: 'A', roomCode: '' }, { buildingName: '', roomCode: '1' }, { buildingName: 'A', roomCode: '1', organizationId: ORG },
    { buildingName: 'a b c d e f g h i', roomCode: '1' }, { buildingName: 'x'.repeat(121), roomCode: '1' }, { buildingName: 'A' }])
    assert.throws(() => roomPassInput('lookup', bad));
});

test('broker result validation refuses an unmasked phone or a write for another room', () => {
  const room = { roomId: ROOM, roomName: '103', roomCode: 'P103', roomStatus: 'OCCUPIED', buildingId: BUILDING, buildingName: 'Toà A', hasActiveContract: true,
    representative: { name: 'Nguyễn Duẩn', phoneMasked: '***8160' }, passListing: null };
  assert.deepEqual(roomPassResult('lookup', { organizationId: ORG, rooms: [room], truncated: false }, identity, {}).rooms[0], room);
  for (const phoneMasked of [PHONE, '0354***160', '***08160'])
    assert.throws(() => roomPassResult('lookup', { organizationId: ORG, rooms: [{ ...room, representative: { name: 'X', phoneMasked } }], truncated: false }, identity, {}));
  assert.throws(() => roomPassResult('lookup', { organizationId: FOREIGN, rooms: [], truncated: false }, identity, {}));
  assert.throws(() => roomPassResult('lookup', { organizationId: ORG, rooms: [room, room], truncated: false }, identity, {}));
  const listing = { listingId: LISTING, buildingId: BUILDING, roomId: ROOM, active: true, revision: 'a'.repeat(64) };
  const applied = { requestId: req(1), outcome: 'applied', change: 'created', listing, contact: { name: 'Duẩn', phoneMasked: '***0001' }, contactSource: 'provided' };
  assert.deepEqual(roomPassResult('upsert', applied, identity, full), applied);
  const bare = { requestId: req(1), roomId: ROOM, passPrice: 3500000 };
  const auto = { ...applied, contactSource: 'representative' };
  assert.deepEqual(roomPassResult('upsert', auto, identity, bare), auto);
  for (const [value, input] of [[auto, full], [applied, bare], [{ ...auto, change: 'updated' }, bare], [{ ...applied, contactSource: 'customer' }, full],
    [(({ contactSource, ...rest }) => rest)(applied), full]]) assert.throws(() => roomPassResult('upsert', value, identity, input), 'contactSource must match the input');
  assert.throws(() => roomPassResult('upsert', { ...applied, listing: { ...listing, roomId: ROOM2 } }, identity, full));
  assert.throws(() => roomPassResult('upsert', { ...applied, listing: { ...listing, active: false } }, identity, full));
  assert.throws(() => roomPassResult('upsert', { ...applied, contact: { name: 'Duẩn', phoneMasked: '0900000001' } }, identity, full));
  assert.deepEqual(roomPassResult('status', applied, identity, { requestId: req(1) }), applied, 'status reconciles upsert receipts');
  const setActive = { requestId: req(1), outcome: 'applied', listing };
  assert.deepEqual(roomPassResult('status', setActive, identity, { requestId: req(1) }), setActive, 'and set_active receipts');
  assert.throws(() => roomPassResult('status', { ...applied, requestId: req(2) }, identity, { requestId: req(1) }));
});

test('lookup finds occupied rooms by building words without accents, masks the representative phone and stays inside CRM read, manage and overlay scope',
  { timeout: 60000 }, async t => {
    const { db, call } = await setupUpsert(t);
    const found = await call('lookup', { buildingName: 'le van tho', roomCode: 'Phòng 103' });
    assert.deepEqual(found.rooms.map(room => room.roomId), [ROOM]);
    const [room] = found.rooms;
    assert.equal(room.hasActiveContract, true); assert.equal(room.roomStatus, 'OCCUPIED'); assert.equal(room.buildingId, BUILDING);
    assert.deepEqual(room.representative, { name: 'Nguyễn Duẩn', phoneMasked: '***8160' });
    assert.deepEqual(room.passListing, { listingId: LISTING, active: false, passPrice: null, availDate: null });
    assert.equal(JSON.stringify(found).includes(PHONE), false, 'full phone never leaves SQL');
    assert.deepEqual(roomPassResult('lookup', found, identity, {}), found);
    assert.deepEqual((await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '10' })).rooms.map(r => r.roomId).sort(), [ROOM, ROOM3].sort(), 'partial only without exact');
    assert.equal((await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' })).rooms.some(r => r.roomId === FOREIGN_ROOM), false, 'other company never listed');
    // BUILDING2 is CRM-allowed but outside the saved connection overlay.
    assert.deepEqual((await call('lookup', { buildingName: 'Quang Trung', roomCode: '103' })).rooms, []);
    await db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid,'${SCOPE2}'::uuid]`);
    assert.deepEqual((await call('lookup', { buildingName: 'Quang Trung', roomCode: '103' })).rooms.map(r => r.roomId), [ROOM2]);
    await db.exec(`DELETE FROM public.fixture_read_acl WHERE building_id='${BUILDING}'`);
    assert.deepEqual((await call('lookup', { buildingName: 'le van tho', roomCode: '103' })).rooms, [], 'form read scope (owner or can_access_building)');
    await db.exec(`INSERT INTO public.fixture_read_acl VALUES('${BUILDING}');DELETE FROM public.fixture_manage_acl WHERE building_id='${BUILDING}'`);
    assert.deepEqual((await call('lookup', { buildingName: 'le van tho', roomCode: '103' })).rooms, [], 'canonical can_manage_pass_listing');
    await db.exec(`INSERT INTO public.fixture_manage_acl VALUES('${BUILDING}');UPDATE public.fixture_action_acl SET allowed=false WHERE building_id='${BUILDING}'`);
    assert.deepEqual((await call('lookup', { buildingName: 'le van tho', roomCode: '103' })).rooms, [], 'CRM action decision per building');
  });

test('lookup filters allowed buildings before the cap: 205 forbidden matches sorting first cannot hide the allowed rooms; truncated past 10',
  { timeout: 60000 }, async t => {
    const { db, call } = await setupUpsert(t);
    const forbidden = id('0').replace(/^0{8}/, 'f0f0f0f0');
    await db.exec(`INSERT INTO public.buildings(id,organization_id,user_id,name,code,street_address) VALUES('${forbidden}','${ORG}','${OWNER}','A Toà 417/57 Lê Văn Thọ','A',null);
      INSERT INTO public.rooms(id,organization_id,building_id,name,status) SELECT gen_random_uuid(),'${ORG}','${forbidden}','10'||lpad(n::text,3,'0'),'OCCUPIED' FROM generate_series(1,205) n;
      INSERT INTO public.fixture_read_acl VALUES('${forbidden}')`);
    assert.deepEqual((await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '10' })).rooms.map(r => r.roomId).sort(), [ROOM, ROOM3].sort(),
      'readable but unmanaged building never consumes the cap');
    await db.exec(`INSERT INTO public.rooms(id,organization_id,building_id,name,status) SELECT gen_random_uuid(),'${ORG}','${BUILDING}','2'||lpad(n::text,2,'0')||'10','AVAILABLE' FROM generate_series(1,11) n`);
    const capped = await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '10' });
    assert.equal(capped.rooms.length, 10); assert.equal(capped.truncated, true);
    assert.ok(capped.rooms.every(r => r.buildingId === BUILDING));
    assert.equal((await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' })).truncated, false);
  });

test('upsert creates through the canonical writer, replays by requestId, edits only given fields and never touches contracts or customers',
  { timeout: 60000 }, async t => {
    const { db, call, count } = await setupUpsert(t);
    const snapshot = async () => JSON.stringify((await db.query(`SELECT (SELECT jsonb_agg(c ORDER BY id) FROM public.contracts c) contracts,
      (SELECT jsonb_agg(c ORDER BY id) FROM public.customers c) customers,(SELECT jsonb_agg(c ORDER BY contract_id,customer_id) FROM public.contract_customers c) links,
      (SELECT jsonb_agg(r ORDER BY id) FROM public.rooms r) rooms`)).rows[0]);
    const before = await snapshot();
    const created = await call('upsert', full);
    assert.equal(created.change, 'created'); assert.equal(created.outcome, 'applied'); assert.notEqual(created.listing.listingId, LISTING);
    assert.deepEqual(created.contact, { name: 'Duẩn', phoneMasked: '***0001' });
    assert.deepEqual(roomPassResult('upsert', created, identity, full), created);
    const row = async listingId => (await db.query(`SELECT organization_id,user_id,building_id,room_id,contact_name,contact_phone,sale_policy,pass_price::text,
      avail_date::text,contact_manager,active,created_by FROM public.room_pass_listings WHERE id=$1`, [listingId])).rows[0];
    assert.deepEqual(await row(created.listing.listingId), { organization_id: ORG, user_id: OWNER, building_id: BUILDING, room_id: ROOM, contact_name: 'Duẩn',
      contact_phone: '0900000001', sale_policy: full.salePolicy, pass_price: '3500000', avail_date: '2026-11-01', contact_manager: false, active: true, created_by: USER });
    assert.deepEqual(await call('upsert', full), created, 'same requestId and input replays the receipt');
    assert.deepEqual(await call('status', { requestId: req(1) }), created);
    assert.equal(await count('public.room_pass_listings'), 2);
    await assert.rejects(call('upsert', { ...full, passPrice: 3600000 }), code('PT409'), 'same requestId cannot carry a new intent');
    const audit = (await db.query('SELECT event,metadata FROM public.fixture_action_audit')).rows;
    assert.deepEqual(audit.map(entry => entry.event), ['HERMES_ROOM_PASS_UPSERT']);
    assert.deepEqual(audit[0].metadata, { actor: USER, connectionId: binding.connectionId, requestId: req(1), change: 'created', active: true });
    assert.equal(created.contactSource, 'provided');
    const edited = await call('upsert', { requestId: req(2), roomId: ROOM, passPrice: 3200000 });
    assert.equal(edited.change, 'updated'); assert.equal(edited.listing.listingId, created.listing.listingId); assert.equal(edited.contactSource, 'unchanged');
    assert.deepEqual(await row(created.listing.listingId), { ...(await row(created.listing.listingId)), pass_price: '3200000', sale_policy: full.salePolicy,
      contact_phone: '0900000001', avail_date: '2026-11-01' }, 'absent fields keep their value');
    // A model sending "" for unknown fields must not wipe the stored contact or policy.
    const blank = roomPassInput('upsert', { requestId: req(10), roomId: ROOM, customerPhone: '', customerName: ' ', salePolicy: '', passPrice: 3300000 });
    const kept = await call('upsert', blank);
    assert.equal(kept.contactSource, 'unchanged'); assert.deepEqual(roomPassResult('upsert', kept, identity, blank), kept);
    assert.deepEqual(await row(created.listing.listingId), { organization_id: ORG, user_id: OWNER, building_id: BUILDING, room_id: ROOM, contact_name: 'Duẩn',
      contact_phone: '0900000001', sale_policy: full.salePolicy, pass_price: '3300000', avail_date: '2026-11-01', contact_manager: false, active: true, created_by: USER });
    await call('upsert', { requestId: req(3), roomId: ROOM, salePolicy: null, availDate: null, contactManager: true });
    assert.deepEqual(await row(created.listing.listingId), { organization_id: ORG, user_id: OWNER, building_id: BUILDING, room_id: ROOM, contact_name: 'Duẩn',
      contact_phone: '0900000001', sale_policy: null, pass_price: '3300000', avail_date: null, contact_manager: true, active: true, created_by: USER });
    const hidden = await call('upsert', { requestId: req(4), roomId: ROOM, active: false });
    assert.equal(hidden.listing.active, false); assert.equal(hidden.change, 'updated');
    // No listing shown any more: a new one is created like the form's "Thêm",
    // with the representative auto-filled AND kept private (manager's phone),
    // even if contactManager:false is sent without an explicit customerPhone.
    const second = await call('upsert', { requestId: req(5), roomId: ROOM, passPrice: 3500000, contactManager: false });
    assert.equal(second.change, 'created'); assert.notEqual(second.listing.listingId, created.listing.listingId);
    assert.equal(second.contactSource, 'representative');
    assert.deepEqual(second.contact, { name: 'Nguyễn Duẩn', phoneMasked: '***8160' });
    assert.deepEqual([(await row(second.listing.listingId)).contact_phone, (await row(second.listing.listingId)).contact_manager], [PHONE, true]);
    await call('upsert', { requestId: req(7), roomId: ROOM, active: false });
    // An explicit customerPhone follows the form: contactManager:false shows it.
    const third = await call('upsert', { requestId: req(8), roomId: ROOM, customerPhone: '0911222333', contactManager: false });
    assert.equal(third.contactSource, 'provided');
    assert.deepEqual([(await row(third.listing.listingId)).contact_phone, (await row(third.listing.listingId)).contact_manager], ['0911222333', false]);
    // No active contract, no contact given: nothing is invented.
    const empty = await call('upsert', { requestId: req(9), roomId: ROOM3, passPrice: 2800000 });
    assert.deepEqual([empty.change, empty.contactSource, empty.contact], ['created', 'unchanged', { name: null, phoneMasked: null }]);
    assert.equal((await row(empty.listing.listingId)).contact_manager, false);
    assert.equal(await count('public.room_pass_listings'), 5);
    assert.equal(await count('app_private.hermes_room_pass_receipts'), 9);
    assert.equal(await snapshot(), before, 'contracts, customers and rooms are untouched');
    assert.equal(JSON.stringify((await db.query('SELECT metadata FROM public.fixture_action_audit')).rows).includes('0900000001'), false, 'no phone in audit');
  });

test('upsert denies other company, room outside overlay or CRM scope, missing Action and malformed SQL input without leaving a receipt',
  { timeout: 90000 }, async t => {
    const { db, call, count } = await setupUpsert(t);
    const unchanged = async () => {
      assert.equal(await count('app_private.hermes_room_pass_receipts'), 0);
      assert.equal(await count('public.room_pass_listings'), 1);
    };
    const attempt = (n, extra = {}) => ({ requestId: req(n), roomId: ROOM, passPrice: 3500000, ...extra });
    for (const [n, input] of [[1, { ...attempt(1), passPrice: 1.5 }], [2, { ...attempt(2), availDate: '2026-02-30' }], [3, { ...attempt(3), customerPhone: 'abc' }],
      [4, { ...attempt(4), userId: USER }], [5, { ...attempt(5), salePolicy: ' padded' }], [6, { requestId: req(6) }], [7, { ...attempt(7), passPrice: 1_000_000_001 }],
      [8, { ...attempt(8), active: 'yes' }]]) await assert.rejects(call('upsert', input), code('22023'), `invalid ${n}`);
    await unchanged();
    for (const role of ['anon', 'service_role']) await assert.rejects(call('upsert', attempt(10), binding, role), /permission denied/);
    await assert.rejects(call('upsert', attempt(11), binding, 'authenticated', FOREIGN), code('42501'), 'actor must own the connection');
    await assert.rejects(call('upsert', attempt(12), { ...binding, expectedEpoch: 2 }), code('PT409'));
    await assert.rejects(call('upsert', attempt(13, { roomId: FOREIGN_ROOM })), code('42501'), 'other company');
    await assert.rejects(call('upsert', attempt(14, { roomId: ROOM2 })), code('42501'), 'building outside the saved overlay');
    await db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid,'${SCOPE2}'::uuid];UPDATE public.fixture_action_acl SET allowed=false WHERE building_id='${BUILDING2}'`);
    await assert.rejects(call('upsert', attempt(15, { roomId: ROOM2 })), code('42501'), 'building outside CRM scope');
    await db.exec(`DELETE FROM public.fixture_manage_acl WHERE building_id='${BUILDING}'`);
    await assert.rejects(call('upsert', attempt(16)), code('42501'), 'canonical can_manage_pass_listing');
    await db.exec(`INSERT INTO public.fixture_manage_acl VALUES('${BUILDING}');UPDATE public.fixture_action_acl SET deadline=clock_timestamp()-interval '1 second' WHERE building_id='${BUILDING}'`);
    await assert.rejects(call('upsert', attempt(17)), code('42501'), 'expired CRM grant');
    await db.exec(`UPDATE public.fixture_action_acl SET deadline=null`);
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='sale_phong.manage_pass_listings'");
    await assert.rejects(call('upsert', attempt(18)), code('42501'), 'registry off');
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='sale_phong.manage_pass_listings';UPDATE app_private.hermes_connections SET action_capabilities='{}'");
    await assert.rejects(call('upsert', attempt(19)), code('42501'), 'connection Action overlay off');
    await assert.rejects(call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' }), code('42501'), 'lookup needs the same Action');
    await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_pass_listings'];UPDATE public.fixture_action_acl SET allowed=false");
    await assert.rejects(call('upsert', attempt(20)), code('42501'), 'CRM permission off');
    await db.exec(`UPDATE public.fixture_action_acl SET allowed=true;UPDATE public.rooms SET deleted_at=now() WHERE id='${ROOM3}';UPDATE public.buildings SET is_virtual=true WHERE id='${BUILDING2}'`);
    await assert.rejects(call('upsert', attempt(21, { roomId: ROOM3 })), code('42501'), 'deleted room');
    await assert.rejects(call('upsert', attempt(22, { roomId: ROOM2 })), code('42501'), 'virtual building');
    await assert.rejects(call('upsert', attempt(23, { roomId: id('0') })), code('42501'), 'unknown room');
    await unchanged();
    assert.equal(await count('public.fixture_action_audit'), 0);
    assert.equal((await call('upsert', attempt(24))).change, 'created', 'the same caller is allowed once every guard holds');
  });

test('status reconciles applied v1 set_active receipts as well and reports not_found without writing', { timeout: 60000 }, async t => {
  const { rpc, call, count } = await setupUpsert(t);
  const observed = await rpc('observe', { listingId: LISTING });
  const applied = await rpc('set_active', { requestId: req(1), listingId: LISTING, active: true, expectedRevision: observed.listing.revision });
  assert.deepEqual(await call('status', { requestId: req(1) }), applied);
  assert.deepEqual(roomPassResult('status', applied, identity, { requestId: req(1) }), applied);
  assert.deepEqual(await call('status', { requestId: req(2) }), { requestId: req(2), outcome: 'not_found', listing: null });
  await assert.rejects(call('upsert', { requestId: req(1), roomId: ROOM, passPrice: 3500000 }), code('PT409'), 'a set_active requestId is not reusable');
  assert.equal(await count('app_private.hermes_room_pass_receipts'), 1);
});

test('registry enable migration flips exactly the room-pass Action, is idempotent and refuses a missing registry row or upsert RPC', { timeout: 60000 }, async t => {
  const { db } = await setupUpsert(t);
  const enable = readFileSync(enablePath, 'utf8');
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='sale_phong.manage_pass_listings'");
  const others = async () => (await db.query("SELECT jsonb_agg(c ORDER BY capability) v FROM app_private.hermes_capabilities c WHERE capability<>'sale_phong.manage_pass_listings'")).rows[0].v;
  const before = await others();
  await db.exec(enable); await db.exec(enable);
  assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings' AND mode='action'")).rows[0].enabled, true);
  assert.deepEqual(await others(), before, 'no other capability changes');
  await db.exec('DROP FUNCTION public.hermes_room_pass_upsert_v1(jsonb,text,jsonb)');
  await assert.rejects(db.exec(enable), /hermes_room_pass_upsert_missing/); await db.exec('ROLLBACK');
  await db.exec("DELETE FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings'");
  await assert.rejects(db.exec(enable), /hermes_room_pass_registry_missing/); await db.exec('ROLLBACK');
});
