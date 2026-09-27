import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedLegacy} from './legacy-entrypoints-live.mjs';
import {legacyLedger,cleanupLegacy,assertIncomingClosure,triggerDigest} from './legacy-fixture-cleanup.mjs';
export async function managerDecisions({query},exclude=null) {
  const actor=(await query("SELECT id FROM auth.users WHERE email='demo.quanly@username.ihomecrm.local'")).rows[0].id;
  await query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);
  return (await query("SELECT id,public.can_do_on_building('contracts','edit',id) AS allowed FROM public.buildings WHERE organization_id='dddd0000-0000-4000-8000-000000000001' AND id IS DISTINCT FROM $1 ORDER BY id",[exclude])).rows;
}
export async function seedAuth(ctx,{draftAdapter=false}={}) {
  const {query}=ctx,building=randomUUID(),override=randomUUID(),marker='p1a1-auth-'+randomUUID();
  const owner=(await query("SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local'")).rows[0].id;
  const existingDecisions=await managerDecisions(ctx);
  await query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
  await query("INSERT INTO public.buildings(id,organization_id,user_id,name,province,district,ward) VALUES($1,'dddd0000-0000-4000-8000-000000000001',$2,$3,'TEST','TEST','TEST')",[building,owner,marker]);
  const scopes=(await query('SELECT * FROM public.authorization_scopes WHERE building_id=$1',[building])).rows;assert.equal(scopes.length,1);
  const f=await seedLegacy(ctx,{status:'ACTIVE',buildingId:building,marker,draftAdapter,deduction:draftAdapter?0:100});
  const manager=(await query("SELECT id FROM auth.users WHERE email='demo.quanly@username.ihomecrm.local'")).rows[0].id;
  const member=(await query("SELECT id FROM public.organization_memberships WHERE user_id=$1 AND organization_id=$2 AND status='ACTIVE'",[manager,f.organizationId])).rows[0].id;
  await query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,scope_mode) VALUES($1,$2,$3,'contracts.edit','ALLOW',$4,'SCOPED')",[override,f.organizationId,member,marker]);
  await query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)',[f.organizationId,override,scopes[0].id]);
  await query('SET CONSTRAINTS ALL IMMEDIATE');
  assert.deepEqual(await managerDecisions(ctx,building),existingDecisions);
  const authority=(await query("SELECT public.is_super_admin() AS super,public.can_do_on_building('contracts','edit',$1) AS allowed",[building])).rows[0];
  assert.deepEqual(authority,{super:false,allowed:true});
  return {...f,override,scope:scopes[0].id,manager,member,existingDecisions,authority};
}
export async function denyAuth({query},f) {
  const r=await query("UPDATE public.member_permission_overrides SET effect='DENY' WHERE id=$1 AND reason=$2 AND membership_id=$3 AND permission_key='contracts.edit'",[f.override,f.marker,f.member]);assert.equal(r.rowCount,1);
  await query('SET CONSTRAINTS ALL IMMEDIATE');
  await query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.manager]);
  assert.equal((await query("SELECT public.can_do_on_building('contracts','edit',$1) AS allowed",[f.building])).rows[0].allowed,false);
}
export async function cleanupAuth(ctx,f,guards) {
  const {query}=ctx;
  assert.deepEqual(await managerDecisions(ctx,f.building),f.existingDecisions,'Existing manager rights unchanged during fixture');
  const ledger=await legacyLedger(ctx,[f]);
  const overrides=(await query('SELECT * FROM public.member_permission_overrides WHERE id=$1',[f.override])).rows;
  const edges=(await query('SELECT * FROM public.member_override_scopes WHERE override_id=$1',[f.override])).rows;
  assert.equal(overrides.length,1);assert.equal(overrides[0].reason,f.marker);assert.equal(overrides[0].membership_id,f.member);
  assert.equal(edges.length,1);assert.equal(edges[0].scope_id,f.scope);
  const authClosure=await assertIncomingClosure(ctx,{'public.member_permission_overrides':overrides,'public.member_override_scopes':edges});
  await query('SET CONSTRAINTS ALL DEFERRED');
  assert.equal((await query('DELETE FROM public.member_override_scopes WHERE override_id=$1 AND scope_id=$2',[f.override,f.scope])).rowCount,1);
  assert.equal((await query('DELETE FROM public.member_permission_overrides WHERE id=$1',[f.override])).rowCount,1);
  const cleanup=await cleanupLegacy(ctx,{fixtures:[f],ledger,expectedTriggerDigest:guards,buildingBaselines:[{id:f.building,total_rooms:0}]});
  const buildings=(await query('SELECT * FROM public.buildings WHERE id=$1',[f.building])).rows;
  const scopes=(await query('SELECT * FROM public.authorization_scopes WHERE building_id=$1',[f.building])).rows;
  assert.equal(buildings.length,1);assert.equal(buildings[0].name,f.marker);assert.equal(scopes.length,1);assert.equal(scopes[0].id,f.scope);
  const buildingClosure=await assertIncomingClosure(ctx,{'public.buildings':buildings,'public.authorization_scopes':scopes});
  assert.equal((await query('DELETE FROM public.authorization_scopes WHERE id=$1',[f.scope])).rowCount,1);
  assert.equal((await query('DELETE FROM public.buildings WHERE id=$1',[f.building])).rowCount,1);
  await query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const [t,id]of [['buildings',f.building],['authorization_scopes',f.scope],['member_permission_overrides',f.override]])assert.equal(Number((await query(`SELECT count(*) AS n FROM public.${t} WHERE id=$1`,[id])).rows[0].n),0);
  assert.equal(Number((await query('SELECT count(*) AS n FROM public.member_override_scopes WHERE override_id=$1',[f.override])).rows[0].n),0);
  assert.deepEqual(await managerDecisions(ctx),f.existingDecisions,'Existing manager rights unchanged after cleanup');
  assert.equal(await triggerDigest(ctx),guards);
  return {authClosure,buildingClosure,...cleanup,existingManagerDecisionsUnchanged:true,authorizationVersion:'Natural trigger increments retained; no shared membership or role edits'};
}
