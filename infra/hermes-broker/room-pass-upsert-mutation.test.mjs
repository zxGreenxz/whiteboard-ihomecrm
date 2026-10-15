import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupUpsert, upsertPath, ROOM, ROOM2, BUILDING, BUILDING2, SCOPE, SCOPE2, PHONE } from './room-pass-upsert-sql-fixture.mjs';
import { ORG, USER } from '../hermes-zalo-router/private-command-fixture.mjs';
import { roomPassResult } from './room-pass-contract.mjs';

// Mutation evidence for the authority and privacy guards of
// hermes_room_pass_upsert_v1: each mutant removes ONE guard and the same probe
// that the reviewed SQL denies must then breach. A probe that still fails on
// its mutant would be a vacuous test, so both directions are asserted.
const original = readFileSync(upsertPath, 'utf8');
const mutate = (from, to) => {
  const next = original.replace(from, to);
  assert.notEqual(next, original, `mutation anchor not found: ${from}`);
  return next;
};
const req = n => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const upsert = (call, n, extra = {}) => call('upsert', { requestId: req(n), roomId: ROOM, passPrice: 3500000, ...extra });
const found = async (call, input) => {
  const value = await call('lookup', input);
  if (!value.rooms.length) throw new Error('hermes_action_denied: no room visible');
  return value;
};
// A new listing without contact auto-fills the representative; that phone was
// not given by the user, so the public page must show the manager instead.
const privateRepresentative = async ({ db, call }) => {
  const result = await upsert(call, 12, { contactManager: false });
  const row = (await db.query('SELECT contact_manager FROM public.room_pass_listings WHERE id=$1', [result.listing.listingId])).rows[0];
  if (row.contact_manager) throw new Error('hermes_action_denied: representative phone kept private');
  return result;
};
const probes = [
  { name: 'auto-filled representative forces contactManager', sql: mutate("CASE WHEN v_source='representative' THEN true\n   WHEN", 'CASE WHEN'),
    run: privateRepresentative },
  { name: 'auto-fill marks its contact source', sql: mutate("IF FOUND THEN v_source:='representative'; END IF;", ''), run: privateRepresentative },
  { name: 'saved connection overlay (scope)', sql: mutate('overlay.id=ANY(c.scope_ids) AND ', ''),
    run: ({ call }) => upsert(call, 1, { roomId: ROOM2 }) },
  { name: 'CRM action decision per building', sql: mutate('RETURN COALESCE(decision.allowed,false)', 'RETURN true'),
    async run({ db, call }) {
      await db.exec(`CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz)
        LANGUAGE sql AS $$SELECT false,1::bigint,null::timestamptz$$`);
      return upsert(call, 2);
    } },
  { name: 'authorization version of the decision', sql: mutate("   AND decision.authorization_version::text IS NOT DISTINCT FROM p_authorization_version\n", ''),
    async run({ db, call }) {
      await db.exec(`CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz)
        LANGUAGE sql AS $$SELECT true,2::bigint,null::timestamptz$$`);
      return upsert(call, 3);
    } },
  { name: 'expiring CRM grant (deadline)', sql: mutate('AND (decision.nearest_deadline IS NULL OR decision.nearest_deadline>clock_timestamp())', ''),
    async run({ db, call }) {
      await db.exec("UPDATE public.fixture_action_acl SET deadline=clock_timestamp()-interval '1 second'");
      return upsert(call, 4);
    } },
  { name: 'authorized building scope', sql: mutate("AND (COALESCE(scope.org_wide,false) OR p_building=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))", ''),
    async run({ db, call }) {
      await db.exec(`CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
        LANGUAGE sql AS $$SELECT false,'{}'::uuid[],'{}'::uuid[]$$`);
      return upsert(call, 5);
    } },
  // The canonical writer re-checks this itself, so the breach is the lookup.
  { name: 'canonical can_manage_pass_listing in lookup', sql: mutate('AND COALESCE(public.can_manage_pass_listing(p_building,p_owner),false)', ''),
    async run({ db, call }) {
      await db.exec(`DELETE FROM public.fixture_manage_acl WHERE building_id='${BUILDING}'`);
      return found(call, { buildingName: 'Lê Văn Thọ', roomCode: '103' });
    } },
  { name: 'form read scope in lookup', sql: mutate('AND (b.user_id=auth.uid() OR public.can_access_building(b.id))', ''),
    async run({ db, call }) {
      await db.exec(`DELETE FROM public.fixture_read_acl WHERE building_id='${BUILDING}'`);
      return found(call, { buildingName: 'Lê Văn Thọ', roomCode: '103' });
    } },
  { name: 'CRM permission in the current context', sql: mutate("IF context#>'{permissions,sale_phong.manage_pass_listings}' IS DISTINCT FROM 'true'::jsonb\n   OR ", 'IF '),
    async run({ db, call }) {
      await db.exec(`CREATE OR REPLACE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,
        'isOffboarded',false,'membershipId','${USER}','authorizationVersion',1,'permissions',jsonb_build_object('sale_phong.manage_pass_listings',false))$$`);
      return upsert(call, 6);
    } },
  { name: 'connection Action overlay', sql: mutate("OR NOT('sale_phong.manage_pass_listings'=ANY(c.action_capabilities)) ", ''),
    async run({ db, call }) {
      await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
      return upsert(call, 7);
    } },
  { name: 'deployment registry', sql: mutate("\n   OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings' AND mode='action' AND enabled)", ''),
    async run({ db, call }) {
      await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='sale_phong.manage_pass_listings'");
      return upsert(call, 8);
    } },
  { name: 'requestId intent pin', sql: mutate('\n   OR receipt.input IS DISTINCT FROM p_input', ''),
    async run({ call }) {
      await upsert(call, 9);
      const replay = await upsert(call, 9, { passPrice: 9900000 });
      return replay;
    } },
  { name: 'masked representative phone', sql: mutate("'phoneMasked',CASE WHEN cu.phone IS NULL THEN NULL ELSE '***'||right(regexp_replace(cu.phone,'[^0-9]','','g'),4) END)", "'phoneMasked',cu.phone)"),
    async run({ call }) {
      const value = await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' });
      if (!JSON.stringify(value).includes(PHONE)) throw new Error('hermes_action_denied: phone stayed masked');
      return value;
    } },
];

for (const probe of probes) {
  test(`mutation is caught: ${probe.name}`, { timeout: 90000 }, async t => {
    const reviewed = await setupUpsert(t);
    await assert.rejects(probe.run(reviewed), error => /hermes_action_|42501|PT409|denied/.test(`${error.code} ${error.message}`), 'reviewed SQL denies the probe');
    const mutant = await setupUpsert(t, { sql: probe.sql });
    await assert.doesNotReject(probe.run(mutant), 'mutant lets the probe breach');
  });
}

test('broker validator is a second fence: a mutant lookup that leaks the full phone becomes backend_unavailable, not data', { timeout: 90000 }, async t => {
  const leaking = probes.find(probe => probe.name === 'masked representative phone');
  const { call } = await setupUpsert(t, { sql: leaking.sql });
  const value = await call('lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' });
  assert.ok(JSON.stringify(value).includes(PHONE));
  assert.throws(() => roomPassResult('lookup', value, { row: { organizationId: ORG } }, {}));
});

// The contract is mutated in memory and loaded as a data: module whose sibling
// imports are rewritten to absolute file URLs; nothing is written to disk.
const contractUrl = new URL('./room-pass-contract.mjs', import.meta.url);
const contractSource = readFileSync(contractUrl, 'utf8');
const loadContract = source => import(`data:text/javascript;base64,${Buffer.from(source.replace(/from '\.\/([a-z-]+\.mjs)'/g,
  (_, file) => `from '${new URL(`./${file}`, contractUrl).href}'`)).toString('base64')}`);
const blankAsClear = (() => {
  let next = contractSource;
  for (const [from, to] of [['if(!text)return ABSENT;', 'if(!text)return null;'], ['if(!digits)return ABSENT;', 'if(!digits)return null;']]) {
    const changed = next.replace(from, to); assert.notEqual(changed, next, `mutation anchor not found: ${from}`); next = changed;
  }
  return next;
})();
test('mutation is caught: blank text from the model is absent (keep), never a clear of the stored contact/policy', { timeout: 90000 }, async t => {
  for (const [label, source, breach] of [['reviewed contract', contractSource, false], ['mutant contract', blankAsClear, true]]) {
    const { roomPassInput } = await loadContract(source);
    const { db, call } = await setupUpsert(t);
    const created = await upsert(call, 1, { customerPhone: '0900000001', customerName: 'Duẩn', salePolicy: 'Điện 3.5k' });
    await call('upsert', roomPassInput('upsert', { requestId: req(2), roomId: ROOM, customerPhone: '', customerName: '  ', salePolicy: '' }));
    const row = (await db.query('SELECT contact_phone,contact_name,sale_policy FROM public.room_pass_listings WHERE id=$1', [created.listing.listingId])).rows[0];
    assert.equal([row.contact_phone, row.contact_name, row.sale_policy].includes(null), breach, label);
  }
});

test('overlay mutant probe is not vacuous: the second building is CRM-allowed and only the saved overlay excludes it', { timeout: 90000 }, async t => {
  const { db, call } = await setupUpsert(t);
  await assert.rejects(upsert(call, 1, { roomId: ROOM2 }), error => error.code === '42501');
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid,'${SCOPE2}'::uuid]`);
  assert.equal((await upsert(call, 2, { roomId: ROOM2 })).listing.buildingId, BUILDING2);
});
