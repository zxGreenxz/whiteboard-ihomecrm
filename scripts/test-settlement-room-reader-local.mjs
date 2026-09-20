#!/usr/bin/env node
// Disposable copied database only; every reader invocation uses a real local authenticated JWT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/settlement_t7' });
const id = Object.fromEntries(['org','owner','viewer','admin','member','ownerMember','building','hiddenBuilding','room','hiddenRoom','scope','override','receipt'].map(name => [name, randomUUID()]));
const contracts = [randomUUID(), randomUUID(), randomUUID()];
let seededPermission = false;
const fixture = async fn => { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); await fn(); await db.query('COMMIT'); } catch (error) { await db.query('ROLLBACK'); throw error; } };
function jwt(actor) {
  const secret = fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest-t7.conf', 'utf8').match(/jwt-secret = "([^"]+)"/)[1];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 600 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
async function read(room = id.room, actor = id.viewer) {
  const response = await fetch('http://127.0.0.1:55490/rpc/get_room_cash_lifecycle_v1', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt(actor), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_room_id: room }) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text }; }
  return { status: response.status, body };
}
await db.connect();
try {
  await fixture(async () => {
    await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T7 isolated','ACTIVE')", [id.org, 't7-' + id.org]);
    for (const actor of [id.owner,id.viewer,id.admin]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, 't7-' + actor + '@example.invalid']);
    await db.query("INSERT INTO public.super_admins(user_id,note) VALUES($1,'T7 no membership')", [id.admin]);
    for (const [actor, member] of [[id.owner,id.ownerMember],[id.viewer,id.member]]) await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')", [member,id.org,actor]);
    for (const building of [id.building,id.hiddenBuilding]) await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T7 local','','','')", [building,id.owner,id.org]);
    for (const [room,building] of [[id.room,id.building],[id.hiddenRoom,id.hiddenBuilding]]) await db.query("INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,'T7 room',4000000,4000000)", [room,building,id.org]);
    const seeded = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES('buildings.view','buildings','view','VIEW','TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key"); seededPermission = seeded.rowCount > 0;
    await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)", [id.scope,id.org,id.building]);
    await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'buildings.view','ALLOW','T7 local',$4,'SCOPED')", [id.override,id.org,id.member,id.owner]);
    await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [id.org,id.override,id.scope]);
    for (let i = 0; i < contracts.length; i++) await db.query(`INSERT INTO public.contracts(id,user_id,organization_id,room_id,contract_number,public_code,status,signed_date,start_date,end_date,actual_end_date,rent_price,total_deposit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-12-31',$10,4000000,4000000)`, [contracts[i],id.owner,id.org,id.room,'T7-HD-'+i,'T7-'+contracts[i],i===2?'ACTIVE':'TERMINATED',`2026-0${i+1}-01`,`2026-0${i+1}-10`,i===2?null:`2026-0${i+2}-10`]);
    await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,system_source,has_restricted_item)
      VALUES($1,$2,$3,$4,$5,$6,'INCOME','T7 restricted','T7-SECRET','2026-02-10',9876543,'APPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,'contract.deposit',true)`, [id.receipt,id.owner,id.org,id.building,id.room,contracts[1]]);
  });
  const before = (await db.query('SELECT to_jsonb(v) AS value FROM public.income_expenses v WHERE id=$1', [id.receipt])).rows[0].value;
  const result = await read(); assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.organizationId,id.org,'room scope must identify its organization');
  assert.match(result.body.today,/^\d{4}-\d{2}-\d{2}$/,'today comes from organization timezone');
  assert.equal(result.body.contracts.length,3);
  assert.equal(result.body.contracts.find(row=>row.id===contracts[1]).signedDate,'2026-02-01','reader must expose actual signed_date');
  assert.ok(!JSON.stringify(result.body).includes('T7-SECRET'),'restricted receipt must not leak through room reader');
  await fixture(()=>db.query('UPDATE public.rooms SET organization_id=$1 WHERE id=$2',[randomUUID(),id.room]));
  assert.equal((await read()).status,403,'room/building organization mismatch denied');
  await fixture(()=>db.query('UPDATE public.rooms SET organization_id=$1 WHERE id=$2',[id.org,id.room]));
  const hidden = await read(id.hiddenRoom); assert.ok([403,404].includes(hidden.status),'hidden building denied: '+JSON.stringify(hidden));
  assert.equal((await read(id.room,id.admin)).status,403,'superadmin without active membership must not bypass room scope');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET revoked_at=now() WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'revoked membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET revoked_at=NULL,valid_from=now()+interval '1 day' WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'future membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET valid_from=now()-interval '1 day',valid_to=now()-interval '1 hour' WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'expired membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET valid_to=NULL WHERE id=$1",[id.member]));
  await fixture(()=>db.query("UPDATE public.organizations SET status='SUSPENDED' WHERE id=$1",[id.org]));
  assert.equal((await read()).status,403,'inactive organization denied');
  assert.deepEqual((await db.query('SELECT to_jsonb(v) AS value FROM public.income_expenses v WHERE id=$1',[id.receipt])).rows[0].value,before,'room reader must not mutate vouchers');
  console.log('T7 room reader JWT: signed date / full history / RLS / active scope / no writes PASS');
} finally {
  await fixture(async () => {
    await db.query('DELETE FROM public.income_expenses WHERE id=$1',[id.receipt]);
    await db.query('DELETE FROM public.contracts WHERE id=ANY($1)',[contracts]);
    await db.query('DELETE FROM public.rooms WHERE id=ANY($1)',[[id.room,id.hiddenRoom]]);
    await db.query('DELETE FROM public.member_override_scopes WHERE override_id=$1',[id.override]);
    await db.query('DELETE FROM public.member_permission_overrides WHERE id=$1',[id.override]);
    await db.query('DELETE FROM public.authorization_scopes WHERE id=$1',[id.scope]);
    await db.query('DELETE FROM public.buildings WHERE id=ANY($1)',[[id.building,id.hiddenBuilding]]);
    await db.query('DELETE FROM public.organization_memberships WHERE id=ANY($1)',[[id.member,id.ownerMember]]);
    await db.query('DELETE FROM public.super_admins WHERE user_id=$1',[id.admin]);
    await db.query('DELETE FROM public.organizations WHERE id=$1',[id.org]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1)',[[id.owner,id.viewer,id.admin]]);
    if(seededPermission)await db.query("DELETE FROM public.permission_definitions WHERE key='buildings.view'");
  });
  await db.end();
}
