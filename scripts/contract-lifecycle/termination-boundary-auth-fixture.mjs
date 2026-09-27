import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedAuth,cleanupAuth,managerDecisions} from './legacy-auth-fixture.mjs';
import {authorizeFixtureDelete} from './termination-boundary-live.mjs';
import {assertIncomingClosure} from './legacy-fixture-cleanup.mjs';

export async function seedBoundaryAuth(ctx) {
  await ctx.query('SET CONSTRAINTS ALL DEFERRED');
  const f=await seedAuth(ctx,{draftAdapter:true});f.createOverride=randomUUID();
  await ctx.query('SET CONSTRAINTS ALL DEFERRED');
  await ctx.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,scope_mode) VALUES($1,$2,$3,'contracts.create','DENY',$4,'SCOPED')",[f.createOverride,f.organizationId,f.member,f.marker]);
  await ctx.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)',[f.organizationId,f.createOverride,f.scope]);
  await ctx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await boundaryAuthMode(ctx,f,'DENY','ALLOW');
  return f;
}
export async function boundaryAuthMode(ctx,f,create,edit) {
  for(const [id,effect]of [[f.createOverride,create],[f.override,edit]]) {
    const r=await ctx.query('UPDATE public.member_permission_overrides SET effect=$2 WHERE id=$1 AND membership_id=$3 AND reason=$4',[id,effect,f.member,f.marker]);assert.equal(r.rowCount,1);
  }
  await ctx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await ctx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.manager]);
  const row=(await ctx.query("SELECT public.can_do_on_building('contracts','create',$1) AS create,public.can_do_on_building('contracts','edit',$1) AS edit,public.is_super_admin() AS super",[f.building])).rows[0];
  assert.deepEqual(row,{create:create==='ALLOW',edit:edit==='ALLOW',super:false});
  assert.deepEqual(await managerDecisions(ctx,f.building),f.existingDecisions);
}
export async function deleteOwnedDraft(ctx,f) {
  const row=(await ctx.query('SELECT id,status,contract_id,organization_id FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0];
  assert.equal(row?.status,'DRAFT');assert.equal(row.contract_id,f.contract);assert.equal(row.organization_id,f.organizationId);
  await authorizeFixtureDelete(ctx,f);
  assert.equal((await ctx.query('DELETE FROM public.contract_terminations WHERE id=$1',[f.termination])).rowCount,1);
  await ctx.query('SELECT app_private.close_termination_write_v2($1)',[f.termination]);
  f.termination=null;
}
export async function cleanupBoundaryAuth(ctx,f,guards) {
  const {query}=ctx;
  const rows=(await query('SELECT * FROM public.member_permission_overrides WHERE id=$1',[f.createOverride])).rows;
  const edges=(await query('SELECT * FROM public.member_override_scopes WHERE override_id=$1',[f.createOverride])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].reason,f.marker);assert.equal(rows[0].membership_id,f.member);assert.equal(edges.length,1);assert.equal(edges[0].scope_id,f.scope);
  const createClosure=await assertIncomingClosure(ctx,{'public.member_permission_overrides':rows,'public.member_override_scopes':edges});
  const owned=await query('SELECT c.id FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id WHERE c.id=$1 AND c.organization_id=$2 AND r.organization_id=$2 AND r.id=$3 AND r.name=$4 AND r.building_id=$5',[f.contract,f.organizationId,f.room,f.marker,f.building]);assert.equal(owned.rowCount,1);
  const terms=(await query('SELECT id,organization_id FROM public.contract_terminations WHERE contract_id=$1',[f.contract])).rows;assert(terms.length<=1);
  if(terms.length){assert.equal(terms[0].organization_id,f.organizationId);if(f.termination!==null)assert.equal(terms[0].id,f.termination);f.termination=terms[0].id;}
  else assert.equal(f.termination,null,'Only a confirmed absent termination may be omitted');
  if(f.termination!==null)await query('UPDATE public.contract_terminations SET notes=$2 WHERE id=$1',[f.termination,f.marker]);
  await query('UPDATE public.contracts SET notes=$2 WHERE id=$1 AND room_id=$3 AND organization_id=$4',[f.contract,f.marker,f.room,f.organizationId]);
  await query('SET CONSTRAINTS ALL DEFERRED');
  assert.equal((await query('DELETE FROM public.member_override_scopes WHERE override_id=$1 AND scope_id=$2',[f.createOverride,f.scope])).rowCount,1);
  assert.equal((await query('DELETE FROM public.member_permission_overrides WHERE id=$1',[f.createOverride])).rowCount,1);
  if(f.termination!==null)await authorizeFixtureDelete(ctx,{...f,actor:f.manager});
  const cleanup=await cleanupAuth(ctx,f,guards);
  await query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.manager]);
  if(f.termination!==null)await query('SELECT app_private.close_termination_write_v2($1)',[f.termination]);
  assert.equal(Number((await query('SELECT count(*) AS n FROM app_private.termination_write_capabilities WHERE transaction_id=pg_current_xact_id()')).rows[0].n),0);
  const operations=(await query('SELECT organization_id,operation,subject_scope,actor_id,idempotency_key,subject_id FROM app_private.canonical_write_operations WHERE subject_scope=$1 ORDER BY organization_id,operation,subject_scope,actor_id,idempotency_key',[f.contract])).rows;
  return {...cleanup,createClosure,terminationOperations:operations};
}

export async function rehearseBoundaryAuth(ctx,guards) {
  const f=await seedBoundaryAuth(ctx);
  await ctx.query('SELECT public.reject_contract_termination_v1($1,$2)',[f.termination,'edit only']);
  await deleteOwnedDraft(ctx,f);
  await boundaryAuthMode(ctx,f,'ALLOW','DENY');
  f.termination=(await ctx.query("SELECT public.create_contract_termination_draft_v1($1,'2026-09-28',$2,'NORMAL',0,0,0,0,0,0,0,0,0,0,'TM',$3) AS v",[f.contract,f.marker+':manager-draft',f.marker])).rows[0].v.termination_id;
  assert.equal((await ctx.query('SELECT user_id FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0].user_id,f.manager);
  await deleteOwnedDraft(ctx,f);
  await boundaryAuthMode(ctx,f,'DENY','ALLOW');
  await ctx.query("SELECT public.terminate_contract_forfeit_with_credit_v1($1,'2026-09-28','[]',$2)",[f.contract,f.marker+':manager-credit']);
  f.termination=(await ctx.query('SELECT id FROM public.contract_terminations WHERE contract_id=$1',[f.contract])).rows[0].id;
  const terminal=await cleanupBoundaryAuth(ctx,f,guards);
  const absent=await seedBoundaryAuth(ctx);await deleteOwnedDraft(ctx,absent);
  return {terminal,absent:await cleanupBoundaryAuth(ctx,absent,guards)};
}
