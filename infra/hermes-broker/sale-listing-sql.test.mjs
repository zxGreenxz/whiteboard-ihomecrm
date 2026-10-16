import test from 'node:test';
import assert from 'node:assert/strict';
import { setupScheduleHealth, SCHEDULE } from './schedule-health-fixture.mjs';
import { saleListingCandidate, TOKEN_ROW } from './sale-listing-sql-fixture.mjs';
import { projectAvailableRooms } from './room-read-projection.mjs';
import { roomSalePassLabel } from '../../src/lib/roomSaleFacts.ts';
import { ORG, USER, FOREIGN, SESSION, INSTANCE } from '../hermes-zalo-router/private-command-fixture.mjs';

// Candidate SQL 20261016080232 on the disposable schedule/group fixture. The sale
// page reader (get_public_available_rooms) and CRM authority are synthetic PORTS
// (see sale-listing-sql-fixture.mjs); everything named hermes_* here is the actual
// candidate SQL. Synthetic data only. Not evidence of production JWT/RLS/PostgREST.
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PASS_ADMIN = id(1), PASS_CUSTOMER = id(2), RENTED = id(3), OTHER_BUILDING = id(4), OTHER_ROOM = id(5), OTHER_ORG = id(6);
const code = expected => error => error.code === expected;
const uid40 = '1'.repeat(40);
const fn = (sql, name) => sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?END \\$fn\\$;`))[0];

test('Hermes sale listing SQL: the published sale page is the only room source for reads, group preview/send and schedules', { timeout: 300000 }, async t => {
  const x = await setupScheduleHealth(t, { reconcile: true }), { db } = x, sql = saleListingCandidate();
  const roomRow = (room, building, fields = {}) => ({ id: room, building_id: building, name: room.slice(-3), code: `P${room.slice(-2)}`, floor: 1,
    area: 20, rent_price: 3000000, deposit_amount: 3000000, amenities: ['Máy lạnh'], images: ['PRIVATE_IMAGE'], description: null,
    sale_note: null, room_type: null, status_public: 'free', sale_state: 'READY', avail_date: null, sale_today: '2026-10-16',
    expected_ready_on: null, pass_contact_name: null, pass_contact_phone: null, pass_sale_policy: null, pass_price: null,
    pass_avail_date: null, pass_contact_manager: false, ...fields });
  // Page shape: the reader already hides the customer's contact when contact_manager.
  const page = {
    buildings: [{ id: x.BUILDING, name: 'Synthetic building', code: 'B', images: ['PRIVATE_IMAGE'], floor_layouts: { 1: 'PRIVATE_LAYOUT' } },
      { id: OTHER_BUILDING, name: 'Owner without link', code: 'O' }],
    rooms: [roomRow(x.ROOM, x.BUILDING, { name: '101', code: '101', area: 25, rent_price: 5000000 }),
      roomRow(PASS_ADMIN, x.BUILDING, { status_public: 'pass', sale_state: 'PASS', pass_price: 2900000, pass_contact_manager: true }),
      roomRow(PASS_CUSTOMER, x.BUILDING, { status_public: 'pass', sale_state: 'PASS', pass_price: 2800000,
        pass_contact_phone: '0900000002', pass_contact_name: 'Khách Thử', pass_avail_date: '2099-01-01' }),
      roomRow(RENTED, x.BUILDING, { status_public: 'rented', sale_state: 'RENTED' }),
      roomRow(OTHER_ROOM, OTHER_BUILDING)],
  };
  async function arrange() {
    await db.query('UPDATE public.fixture_rooms SET payload=$1::jsonb', [JSON.stringify(page)]);
    await db.exec(`INSERT INTO public.buildings(id,organization_id,user_id,name,code) VALUES('${OTHER_BUILDING}','${ORG}','${FOREIGN}','Owner without link','O');
      INSERT INTO public.rooms(id,organization_id,building_id,status,name,code,area,rent_price) VALUES
        ('${PASS_ADMIN}','${ORG}','${x.BUILDING}','VACANT','001','P01',20,3000000),('${PASS_CUSTOMER}','${ORG}','${x.BUILDING}','VACANT','002','P02',20,3000000),
        ('${RENTED}','${ORG}','${x.BUILDING}','OCCUPIED','003','P03',20,3000000),('${OTHER_ROOM}','${ORG}','${OTHER_BUILDING}','VACANT','005','P05',20,3000000);
      INSERT INTO public.room_pass_listings(id,room_id,user_id,organization_id,active,pass_price,contact_manager,contact_phone,contact_name,avail_date) VALUES
        (gen_random_uuid(),'${PASS_ADMIN}','${USER}','${ORG}',true,2900000,true,'0900000005','Khách Ẩn',NULL),
        (gen_random_uuid(),'${PASS_CUSTOMER}','${USER}','${ORG}',true,2800000,false,'0900000002','Khách Thử','2099-01-01');
      -- The owner without a link is still inside the caller's rooms.view scope: only the page rule hides it.
      CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(permission text,org uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN rooms AND org='${ORG}'::uuid AND permission='rooms.view' THEN ARRAY['${x.BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid] ELSE '{}'::uuid[] END
        FROM public.fixture_authority$$;`);
  }
  async function asUser(statement, params = [], role = 'authenticated') {
    await db.exec(`SAVEPOINT as_user; SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",
      [role, USER, SESSION]);
    try { const rows = (await db.query(statement, params)).rows; await db.exec('RELEASE SAVEPOINT as_user'); return rows; }
    catch (error) { await db.exec('ROLLBACK TO SAVEPOINT as_user; RELEASE SAVEPOINT as_user'); throw error; }
    finally { await db.exec('RESET ROLE'); }
  }
  const listing = async () => (await asUser('SELECT public.hermes_sale_listing_rooms_v1($1::uuid) result', [ORG]))[0].result;
  const listedIds = value => value.rooms.map(room => room.id).sort();
  const fact = async room => (await db.query('SELECT app_private.hermes_group_room_fact_v1($1::uuid,$2::uuid) result', [ORG, room])).rows[0].result;
  async function preview(roomIds) {
    await x.heartbeat();
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session',$2,false)", [USER, SESSION]);
    const binding = { ...x.binding, requestId: id(90) };
    const directory = await x.f.rpc('public.hermes_external_group_directory_v1', binding, 'authenticated');
    const request = { ...binding, roomIds, conversationIds: [x.GROUP], expectedContextVersion: directory.authority.contextVersion,
      intentDigest: 'c'.repeat(64), roomReadDigest: 'd'.repeat(64) };
    return { request, decide: () => x.f.rpc('public.hermes_external_group_preview_decision_v1', request, 'authenticated'),
      send: () => x.f.rpc('public.hermes_external_group_send_v1', request, 'authenticated') };
  }

  await x.each('read: exactly the published page rooms (vacant + both pass), never the unlisted owner, rented rooms or media', async () => {
    await arrange();
    const value = await listing();
    assert.equal(value.pages, 1);
    assert.deepEqual(listedIds(value), [x.ROOM, PASS_ADMIN, PASS_CUSTOMER].sort());
    assert.deepEqual(value.buildings.map(b => b.id), [x.BUILDING]);
    assert.deepEqual([value.buildings[0].page_contact_phone, value.buildings[0].page_sale_policy], ['0900000001', 'Chính sách thử']);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_IMAGE|PRIVATE_LAYOUT|fixture-share-token/);
    const admin = value.rooms.find(room => room.id === PASS_ADMIN);
    assert.deepEqual([admin.pass_contact_manager, admin.pass_contact_phone, admin.pass_price], [true, null, 2900000]);
    // The connector projection over this exact payload: listed price and the page's contact text.
    const out = projectAvailableRooms(value, { allowedBuildingIds: [x.BUILDING], readAt: Date.now() });
    assert.deepEqual(out.rooms.find(room => room.id === PASS_ADMIN).availability.label, 'Khách pass phòng · Liên hệ admin iHome mở cửa');
    assert.equal(out.rooms.find(room => room.id === PASS_CUSTOMER).priceVnd, 2800000);
  });

  await x.each('read: revoked link, link of another company, building moved out and no rooms.view scope each list nothing', async () => {
    await arrange();
    await db.exec(`UPDATE public.public_room_share_tokens SET revoked=true WHERE token='${TOKEN_ROW}'`);
    assert.deepEqual([(await listing()).pages, listedIds(await listing())], [0, []]);
    await db.exec(`UPDATE public.public_room_share_tokens SET revoked=false,organization_id='${OTHER_ORG}' WHERE token='${TOKEN_ROW}'`);
    assert.deepEqual(listedIds(await listing()), []);
    await db.exec(`UPDATE public.public_room_share_tokens SET organization_id='${ORG}' WHERE token='${TOKEN_ROW}';
      UPDATE public.buildings SET organization_id='${OTHER_ORG}' WHERE id='${x.BUILDING}'`);
    assert.deepEqual(listedIds(await listing()), []);
    await db.exec(`UPDATE public.buildings SET organization_id='${ORG}' WHERE id='${x.BUILDING}'; UPDATE public.fixture_authority SET rooms=false`);
    assert.deepEqual(listedIds(await listing()), []);
  });

  await x.each('ACL: only authenticated calls the wrapper; the page core and fact stay private', async () => {
    for (const role of ['anon', 'service_role']) {
      await assert.rejects(asUser('SELECT public.hermes_sale_listing_rooms_v1($1::uuid)', [ORG], role), code('42501'));
    }
    await assert.rejects(asUser('SELECT app_private.hermes_sale_listing_payload_v1($1::uuid)', [ORG]), code('42501'));
    await assert.rejects(asUser('SELECT app_private.hermes_group_room_fact_v1($1::uuid,$2::uuid)', [ORG, x.ROOM]), code('42501'));
  });

  await x.each('fact: pass room uses the pass price and prints the same contact text as the connector, hiding a managed contact', async () => {
    await arrange();
    const admin = await fact(PASS_ADMIN), customer = await fact(PASS_CUSTOMER), vacant = await fact(x.ROOM);
    assert.deepEqual([admin.status, admin.rentVnd, admin.availability], ['pass', 2900000,
      { kind: 'pass', label: roomSalePassLabel({ contactManager: true }), availableOn: null }]);
    assert.doesNotMatch(JSON.stringify(admin), /0900000005|Khách Ẩn/);
    assert.deepEqual(customer.availability, { kind: 'pass',
      label: roomSalePassLabel({ contactManager: false, phone: '0900000002', name: 'Khách Thử' }), availableOn: '2099-01-01' });
    assert.deepEqual([vacant.rentVnd, vacant.availability.kind], [5000000, 'ready']);
    await assert.rejects(fact(RENTED), code('PT409'));
  });

  await x.each('group preview/send: a listed pass room is selectable and its queued text is the page text', async () => {
    await arrange();
    const p = await preview([PASS_ADMIN, x.ROOM]), decided = await p.decide();
    assert.equal(decided.decision.outcome, 'allow');
    assert.deepEqual(decided.roomPayload, await listing());
    const ack = await p.send(), [job] = await x.jobs();
    assert.equal(ack.dispatch.recipients[0].status, 'queued');
    assert.match(job.payload.body, /· P01 \| 20 m² \| 2\.900\.000 đ\/tháng \| Khách pass phòng · Liên hệ admin iHome mở cửa/);
    assert.match(job.payload.body, /· 101 \| 25 m² \| 5\.000\.000 đ\/tháng \| Trống sẵn/);
    assert.doesNotMatch(job.payload.body, /0900000005|0900000002/);
    // Worker admission re-reads the same facts (service role, no user JWT) and accepts them unchanged.
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job.id]);
    assert.equal(await x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), true);
  });

  await x.each('group preview: revoking the share link removes even a previously listed room', async () => {
    await arrange();
    const p = await preview([PASS_ADMIN]);
    await db.exec(`UPDATE public.public_room_share_tokens SET revoked=true WHERE token='${TOKEN_ROW}'`);
    await assert.rejects(p.decide(), code('42501'));
  });

  await x.each('schedule rooms_public_text_v1: bulletin lists the page rooms incl. pass, never rented or unlisted rooms', async () => {
    await arrange();
    await x.manage('create', { requestId: SCHEDULE, settings: x.settings() });
    const queued = await x.run();
    assert.equal(queued.status, 'queued');
    const [job] = await x.jobs(), lines = job.payload.body.split('\n');
    assert.equal(lines[0], 'BẢN TIN PHÒNG TRỐNG'); assert.equal(lines.length, 4);
    assert(lines.some(line => line.endsWith('| Khách pass phòng · Liên hệ admin iHome mở cửa')));
    assert(lines.some(line => line.endsWith('| Khách pass phòng: 0900000002 (Khách Thử)')));
    assert(!lines.some(line => line.includes('P03') || line.includes('P05')));
  });
  await x.each('schedule: no published link means no rooms, never the whole company', async () => {
    await arrange();
    await db.exec(`UPDATE public.public_room_share_tokens SET revoked=true WHERE token='${TOKEN_ROW}'`);
    await x.manage('create', { requestId: SCHEDULE, settings: x.settings() });
    assert.deepEqual(await x.run(), { status: 'skipped', reason: 'no_rooms' });
    assert.equal(await x.count('public.zalo_send_queue'), 0);
  });

  // Hand mutations of the candidate SQL: each removes one rule; the same observation must change.
  await x.each('mutation: dropping the company filter, the listed-status filter or the rooms.view cut is observed', async () => {
    await arrange();
    const core = fn(sql, 'app_private.hermes_sale_listing_payload_v1'), wrapper = fn(sql, 'public.hermes_sale_listing_rooms_v1');
    const mutants = [
      [core, core.replaceAll(' AND b.organization_id=p_org)', ')'), async () => {
        await db.exec(`UPDATE public.buildings SET organization_id='${OTHER_ORG}' WHERE id='${x.BUILDING}'`);
        await db.exec(`CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(permission text,org uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
          SELECT ARRAY['${x.BUILDING}'::uuid]$$`); }],
      [core, core.replace(`WHERE pr->>'status_public' IN ('free','soon','pass')\n        AND`, 'WHERE'), async () => {}],
      [wrapper, wrapper.replace(`WHERE (x->>'building_id')::uuid=ANY(v_buildings) ORDER BY ord LIMIT 2000`, 'ORDER BY ord LIMIT 2000'),
        async () => { await db.exec('UPDATE public.fixture_authority SET rooms=false'); }],
    ];
    for (const [original, mutant, setup] of mutants) {
      assert.notEqual(mutant, original);
      await db.exec('SAVEPOINT mutant');
      try {
        await setup(); const clean = listedIds(await listing());
        await db.exec(mutant); const changed = listedIds(await listing());
        assert.notDeepEqual(changed, clean, 'mutant must change the listed rooms');
      } finally { await db.exec('ROLLBACK TO SAVEPOINT mutant; RELEASE SAVEPOINT mutant'); }
    }
  });
  await x.each('mutation: printing a managed pass contact or refusing pass rooms is observed', async () => {
    await arrange();
    const original = fn(sql, 'app_private.hermes_group_room_fact_v1');
    const leaks = original.replace("WHEN COALESCE(pl.contact_manager,false) THEN 'Khách pass phòng · Liên hệ admin iHome mở cửa'\n      ", '');
    const refuses = original.replace("NOT IN ('free','soon','pass')", "NOT IN ('free','soon')");
    for (const [mutant, observe] of [[leaks, async () => assert.match(JSON.stringify(await fact(PASS_ADMIN)), /0900000005/)],
      [refuses, async () => assert.rejects(fact(PASS_ADMIN), code('PT409'))]]) {
      assert.notEqual(mutant, original);
      await db.exec('SAVEPOINT mutant');
      try { await db.exec(mutant); await observe(); } finally { await db.exec('ROLLBACK TO SAVEPOINT mutant; RELEASE SAVEPOINT mutant'); }
    }
  });
});
