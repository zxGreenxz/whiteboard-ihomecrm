import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupUpsert, fullReadPath, BUILDING, ROOM, SCOPE, SCOPE2, ROOM2, ROOM3, CONTRACT, CUSTOMER, PHONE, binding } from './room-pass-upsert-sql-fixture.mjs';
import { id, ORG, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';
import { roomPassResult, ROOM_PASS_TOOLS } from './room-pass-contract.mjs';

// Đọc đầy đủ cho người hỏi (chủ chốt 16/10): hermes_room_pass_upsert_v2 bọc v1.
// v1 vẫn quyết định mọi quyền/biên nhận; v2 chỉ thay SĐT che bằng SĐT đầy đủ của
// đúng khách đại diện / liên hệ tin pass mà v1 vừa trả. Synthetic rows only.
const fullRead = readFileSync(fullReadPath, 'utf8');
const req = n => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { row: { organizationId: ORG } };
const lookup = { buildingName: 'le van tho', roomCode: '103' };
const OLD_CONTRACT = '0d0d0d0d-0000-4000-8000-000000000001', OLD_CUSTOMER = '0d0d0d0d-0000-4000-8000-000000000002', NEW_CONTRACT = '0d0d0d0d-0000-4000-8000-000000000003';

test('v2 lookup: same rooms and authority as v1, representative phone in full only for the private reply', { timeout: 60000 }, async t => {
  const { db, call, call2 } = await setupUpsert(t, { fullRead });
  const masked = await call('lookup', lookup), full = await call2('lookup', lookup);
  assert.deepEqual(full.rooms.map(room => room.roomId), masked.rooms.map(room => room.roomId));
  assert.deepEqual(masked.rooms[0].representative, { name: 'Nguyễn Duẩn', phoneMasked: '***8160' }, 'applied v1 is unchanged');
  assert.deepEqual(full.rooms[0].representative, { name: 'Nguyễn Duẩn', phone: PHONE });
  assert.deepEqual({ ...full.rooms[0], representative: null }, { ...masked.rooms[0], representative: null }, 'only the contact changes');
  assert.deepEqual(roomPassResult('lookup', full, identity, {}), full);
  // Authority stays v1's: overlay excludes BUILDING2, CRM read scope, Action, other org.
  assert.deepEqual((await call2('lookup', { buildingName: 'Quang Trung', roomCode: '103' })).rooms, []);
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid,'${SCOPE2}'::uuid]`);
  assert.deepEqual((await call2('lookup', { buildingName: 'Quang Trung', roomCode: '103' })).rooms.map(room => room.roomId), [ROOM2]);
  await db.exec(`DELETE FROM public.fixture_read_acl WHERE building_id='${BUILDING}'`);
  assert.deepEqual((await call2('lookup', lookup)).rooms, [], 'form read scope');
  await db.exec(`INSERT INTO public.fixture_read_acl VALUES('${BUILDING}')`);
  await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  await assert.rejects(call2('lookup', lookup), error => error.code === '42501', 'no Action, no lookup');
  await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_pass_listings']");
  await assert.rejects(call2('lookup', lookup, binding, 'anon'), error => error.code === '42501');
  await assert.rejects(call2('lookup', lookup, binding, 'authenticated', FOREIGN), error => /42501|PT409/.test(error.code));
  await assert.rejects(call2('delete', lookup), error => error.code === '22023');
});

test('v2 lookup: a room whose only contract ended shows no representative (never the former tenant)', { timeout: 60000 }, async t => {
  const { db, call2 } = await setupUpsert(t, { fullRead });
  await db.exec(`INSERT INTO public.contracts VALUES('${OLD_CONTRACT}','${ROOM3}','TERMINATED',null);
    INSERT INTO public.customers VALUES('${OLD_CUSTOMER}','Khách cũ','0977000111',null);
    INSERT INTO public.contract_customers VALUES('${OLD_CONTRACT}','${OLD_CUSTOMER}',true)`);
  const found = await call2('lookup', { buildingName: 'le van tho', roomCode: '1103' });
  assert.deepEqual(found.rooms.map(room => [room.roomId, room.hasActiveContract, room.representative]), [[ROOM3, false, null]]);
  assert.equal(JSON.stringify(found).includes('0977000111'), false);
});

test('v2 upsert/status: contact phone in full; receipt, writer and replay are v1\'s', { timeout: 60000 }, async t => {
  const { db, call, call2, count } = await setupUpsert(t, { fullRead });
  const input = { requestId: req(1), roomId: ROOM, customerPhone: '0900000001', customerName: 'Duẩn', passPrice: 3500000 };
  const created = await call2('upsert', input);
  assert.deepEqual(created.contact, { name: 'Duẩn', phone: '0900000001' });
  assert.equal(roomPassResult('upsert', created, identity, input).contact.phone, '0900000001');
  assert.deepEqual(await call2('upsert', input), created, 'replay by requestId');
  assert.deepEqual((await call('status', { requestId: req(1) })).contact, { name: 'Duẩn', phoneMasked: '***0001' }, 'stored receipt stays masked');
  assert.deepEqual(await call2('status', { requestId: req(1) }), created);
  assert.equal(await count('app_private.hermes_room_pass_receipts'), 1);
  // Auto-filled representative: public page keeps the manager, the private reply shows the number.
  const auto = await call2('upsert', { requestId: req(2), roomId: ROOM3, passPrice: 3000000 });
  assert.equal(auto.contactSource, 'unchanged');
  await db.exec(`INSERT INTO public.contracts VALUES('${NEW_CONTRACT}','${ROOM3}','ACTIVE',null);
    INSERT INTO public.contract_customers VALUES('${NEW_CONTRACT}','${CUSTOMER}',true);
    UPDATE public.room_pass_listings SET active=false WHERE room_id='${ROOM3}'`);
  const represented = await call2('upsert', { requestId: req(3), roomId: ROOM3, passPrice: 3000000 });
  assert.deepEqual([represented.contactSource, represented.contact], ['representative', { name: 'Nguyễn Duẩn', phone: PHONE }]);
  assert.equal((await db.query('SELECT contact_manager FROM public.room_pass_listings WHERE id=$1', [represented.listing.listingId])).rows[0].contact_manager, true);
  assert.deepEqual(await call2('status', { requestId: id('9') }), { requestId: id('9'), outcome: 'not_found', listing: null });
  // Denials come from v1 before v2 reads anything.
  await assert.rejects(call2('upsert', { ...input, requestId: req(4), roomId: ROOM2 }), error => error.code === '42501');
  assert.equal(await count('app_private.hermes_room_pass_receipts'), 3);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.contracts WHERE id=$1", [CONTRACT])).rows[0].n, 1);
});

test('contract: v2 contact accepted, legacy masked receipt still reconciles, malformed contact refused', () => {
  const listing = { listingId: id('f'), buildingId: BUILDING, roomId: ROOM, active: true, revision: 'a'.repeat(64) };
  const value = contact => ({ requestId: req(1), outcome: 'applied', change: 'created', listing, contact, contactSource: 'provided' });
  const input = { requestId: req(1), roomId: ROOM, customerPhone: '0900000001' };
  for (const ok of [{ name: 'Duẩn', phone: '0900000001' }, { name: null, phone: null }, { name: 'Duẩn', phoneMasked: '***0001' }])
    assert.deepEqual(roomPassResult('upsert', value(ok), identity, input).contact, ok);
  for (const bad of [{ name: 'Duẩn', phone: '090\n0000001' }, { name: 'Duẩn', phone: 1 }, { name: 'Duẩn', phone: '0900000001', phoneMasked: '***0001' },
    { name: 'Duẩn', phoneMasked: '0900000001' }, { phone: '0900000001' }]) assert.throws(() => roomPassResult('upsert', value(bad), identity, input), JSON.stringify(bad));
  const tool = ROOM_PASS_TOOLS.find(item => item.name === 'crm_room_lookup');
  assert.match(tool.description, /SĐT đầy đủ; chỉ trả lời riêng người hỏi, không đưa vào tin nhóm/);
  assert.doesNotMatch(tool.description, /đã che/);
});

// Mutation evidence: the representative of v2 must be chosen exactly like v1
// (active contract only). Dropping that filter leaks a former tenant's phone.
test('mutation is caught: v2 representative restricted to the active contract', { timeout: 90000 }, async t => {
  const anchor = "WHERE ct.room_id=(room.value->>'roomId')::uuid AND ct.deleted_at IS NULL AND ct.status IN ('ACTIVE','EXTENDED')";
  assert.equal(fullRead.split(anchor).length, 2, 'anchor');
  const probe = async ({ db, call2 }) => {
    await db.exec(`INSERT INTO public.contracts VALUES('${OLD_CONTRACT}','${ROOM3}','TERMINATED',null);
      INSERT INTO public.customers VALUES('${OLD_CUSTOMER}','Khách cũ','0977000111',null);
      INSERT INTO public.contract_customers VALUES('${OLD_CONTRACT}','${OLD_CUSTOMER}',true)`);
    return JSON.stringify(await call2('lookup', { buildingName: 'le van tho', roomCode: '1103' })).includes('0977000111');
  };
  assert.equal(await probe(await setupUpsert(t, { fullRead })), false, 'reviewed SQL');
  const mutant = fullRead.replace(anchor, "WHERE ct.room_id=(room.value->>'roomId')::uuid AND ct.deleted_at IS NULL");
  assert.equal(await probe(await setupUpsert(t, { fullRead: mutant })), true, 'mutant leaks the former tenant');
});
