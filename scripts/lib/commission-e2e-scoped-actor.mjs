import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { signInTest, request } from '../test-voucher-detail-read-authz.mjs';

// Route /thanh-toan uses collect; finance and contract readers/writers enforce
// their own permissions. Every override is limited to the same BUILDING scope.
export const SCOPED_PERMISSIONS = ['buildings.view', 'rooms.view', 'contracts.view', 'contracts.create',
  'contracts.edit', 'income_expenses.view', 'income_expenses.create', 'thu_tien.view', 'thu_tien.collect'];

export async function createScopedActor({ ctx, db, organizationId, buildingId, ownerId, marker, record }) {
  assert.equal(ctx.cred.testRef, 'hzulujxgonszuleqticb', 'scoped actor is TEST-only');
  assert.equal(organizationId, 'aaaa0000-0000-4000-8000-000000000001', 'use existing REAL clone only');
  const email = `${marker.toLowerCase()}@example.invalid`, password = `Tt!${randomBytes(24).toString('base64url')}`;
  const response = await fetch(`${ctx.url}/auth/v1/admin/users`, { method: 'POST', headers: {
    apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ email, password, email_confirm: true }) });
  assert.equal(response.status, 200, 'isolated TEST auth user creation');
  const actor = { id: (await response.json()).id, membershipId: randomUUID(), accountId: randomUUID() };
  assert(actor.id); record(actor); // retain cleanup identity before any later failure
  const scope = await db.query("select id from public.authorization_scopes where organization_id=$1 and scope_type='BUILDING' and building_id=$2", [organizationId, buildingId]);
  assert.equal(scope.rows.length, 1, 'existing authorization scope for exactly one building');
  await db.query(`insert into public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from)
    values($1,$2,$3,'STAFF','ACTIVE',now()-interval '1 day')`, [actor.membershipId, organizationId, actor.id]);
  await db.query(`with overrides as (insert into public.member_permission_overrides
    (organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
    select $1,$2,permission,'ALLOW',$3,$4,'SCOPED' from unnest($5::text[]) permission returning id)
    insert into public.member_override_scopes(organization_id,override_id,scope_id)
    select $1,id,$6 from overrides`, [organizationId, actor.membershipId, marker, ownerId, SCOPED_PERMISSIONS, scope.rows[0].id]);
  // Personal TEST cashbook is visible by possession; no broad cashbook grant.
  await db.query(`insert into public.accounts(id,user_id,organization_id,name,code,initial_amount,initial_date)
    values($1,$2,$3,$4,$4,0,current_date)`, [actor.accountId, actor.id, organizationId, marker]);
  return signInTest(ctx, email, password);
}

export async function assertScopedActor({ ctx, db, session, organizationId, buildingId, fixtureContractId }) {
  const other = await db.query(`select c.id from public.contracts c join public.rooms r on r.id=c.room_id
    where c.organization_id=$1 and r.building_id<>$2 and c.deleted_at is null limit 1`, [organizationId, buildingId]);
  assert.equal(other.rows.length, 1, 'negative scope fixture exists');
  const query = id => request(ctx, session.access_token, 'rpc/list_contract_commission_followups_v2',
    { p_organization_id: organizationId, p_contract_ids: [id], p_unresolved_only: false });
  const visible = await query(fixtureContractId);
  assert.equal(visible.status, 200); assert.equal(visible.json.rows.length, 2);
  assert(visible.json.rows.every(row => row.contract_id === fixtureContractId && row.building_id === buildingId && row.can_manage));
  const denied = await query(other.rows[0].id);
  assert.equal(denied.status, 200); assert.equal(denied.json.total, 0); assert.deepEqual(denied.json.rows, []);
  const raw = await request(ctx, session.access_token, `contracts?select=id&id=eq.${other.rows[0].id}`);
  assert.equal(raw.status, 200); assert.deepEqual(raw.json, []);
  const buildings = await request(ctx, session.access_token, 'buildings?select=id');
  assert.equal(buildings.status, 200); assert.deepEqual(buildings.json.map(row => row.id), [buildingId]);
  return { mode: 'isolated-scoped-staff', buildingId, permissions: SCOPED_PERMISSIONS,
    visibleFixture: true, managesFixture: true, otherBuildingContractInvisible: true, visibleBuildingCount: 1 };
}
