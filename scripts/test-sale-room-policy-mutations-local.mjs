// Mutation proofs run only against the isolated loopback fixture DB. Each DDL
// mutation and its writes are rolled back before the next probe/other client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saleQuickClient, seedSaleQuickFixture } from './sale-quick-local-fixture.mjs';

test('Timed policy native PostgreSQL mutation proofs',async t=>{
 const db=await saleQuickClient(),f=await seedSaleQuickFixture();
 await db.query(`INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
  VALUES($1,$2,'sale_phong.edit','ALLOW')`,[f.org,f.roles.sale]);
 const defs={};
 for(const [name,signature] of Object.entries({save:'public.save_room_sale_policy_v1(uuid,uuid,text,uuid,jsonb)',
  cancel:'public.cancel_room_sale_policy_v1(uuid,uuid,bigint,uuid,text)',
  active:'app_private.room_sale_policy_active_text_v1(uuid,uuid,timestamptz)',
  patch:'public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb)',
  can:'app_private.sale_room_can_edit_v1(uuid,uuid)',authorize:'app_private.sale_room_authorize_edit_v1(uuid,uuid)'}))
  defs[name]=(await db.query('SELECT pg_get_functiondef($1::regprocedure) def',[signature])).rows[0].def;
 const replace=(source,old,next)=>{assert.equal(source.split(old).length,2,`unique mutation anchor ${old}`);return source.replace(old,()=>next);};
 const asActor=async(fn)=>{
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[f.actors.sale,JSON.stringify({sub:f.actors.sale,role:'authenticated'})]);
  await db.query('SET LOCAL ROLE authenticated');
  const result=await fn();await db.query('RESET ROLE');return result;
 };
 const rev=async()=>(await db.query('SELECT md5(to_jsonb(r)::text) value FROM public.rooms r WHERE id=$1',[f.rooms[0]])).rows[0].value;
 const policy=()=>({title:'Local mutation',content:'Nội dung hiệu lực',starts_at:new Date(Date.now()-60_000).toISOString(),ends_at:new Date(Date.now()+3_600_000).toISOString()});
 const save=async(p=policy(),request=randomUUID(),revision=null)=>{
  const current=revision??await rev();
  return asActor(async()=>(await db.query('SELECT public.save_room_sale_policy_v1($1,$2,$3,$4,$5) value',[f.org,f.rooms[0],current,request,p])).rows[0].value);
 };
 const cancel=async(p,version=p.policy.version)=>asActor(async()=>(await db.query('SELECT public.cancel_room_sale_policy_v1($1,$2,$3,$4,$5) value',[f.org,p.policy.id,version,randomUUID(),'Local mutation cleanup'])).rows[0].value);
 // Expected SQL errors need their own savepoint so the mutation probe remains
 // usable; business execution still uses the real authenticated API role.
 const expectCode=async(fn,code)=>{
  await db.query('SAVEPOINT expected_error');let error;
  try{await fn();}catch(e){error=e;}
  await db.query('ROLLBACK TO SAVEPOINT expected_error');await db.query('RESET ROLE');
  assert.equal(error?.code,code);
 };
 const proof=async(name,changes,probe)=>t.test(name,async()=>{
  for(const mutated of [false,true]){
   await db.query('BEGIN');
   try{
    if(mutated)for(const change of changes)await db.query(change);
    if(mutated)await assert.rejects(probe,e=>e.code==='ERR_ASSERTION');
    else await probe();
   }finally{await db.query('ROLLBACK');}
  }
 });
 try{
  await proof('MP01 Bỏ CAS thì phép thử phòng cũ phát hiện ghi đè',[
   replace(defs.save,'IF md5(to_jsonb(r)::text)<>p_expected_revision THEN','IF false THEN')],async()=>{
    const old=await rev();await db.query('UPDATE public.rooms SET updated_at=clock_timestamp() WHERE id=$1',[f.rooms[0]]);
    await expectCode(()=>save(policy(),randomUUID(),old),'PT409');
   });
  await proof('MP02 Bỏ chặn thời gian chồng nhau thì phép thử phát hiện campaign thứ hai',[
   replace(defs.save,'IF EXISTS(SELECT 1 FROM app_private.room_sale_policies_v1 x','IF false AND EXISTS(SELECT 1 FROM app_private.room_sale_policies_v1 x')],async()=>{
    await save();await expectCode(()=>save(),'PT409');
   });
  await proof('MP03 Bỏ điều kiện hết hạn thì phép thử phát hiện nội dung còn hiệu lực',[
   replace(defs.active,'AND p.ends_at>p_at','')],async()=>{
    const first=await save();const value=(await db.query('SELECT app_private.room_sale_policy_active_text_v1($1,$2,$3) value',[f.org,f.rooms[0],first.policy.ends_at])).rows[0].value;
    assert.equal(value,null);
   });
  await proof('MP04 Bỏ fact guard thì phép thử phát hiện status note gắn sai tình trạng',[
   replace(defs.patch,"IF p_patch?'sale_status_note' AND p_patch->'sale_status_note'<>'null'::jsonb","IF false AND p_patch?'sale_status_note' AND p_patch->'sale_status_note'<>'null'::jsonb")],async()=>{
    const args=[f.org,f.rooms[0],await rev(),randomUUID(),{sale_status_note:'Sai khóa',sale_status_note_key:'0'.repeat(32)}];
    await expectCode(()=>asActor(()=>db.query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5)',args)),'PT409');
   });
  await proof('MP05 Bỏ receipt fingerprint thì phép thử phát hiện cùng key đổi nội dung',[
   replace(defs.save,'IF old.payload_hash<>request_hash THEN','IF false THEN')],async()=>{
    const p=policy(),request=randomUUID(),old=await rev();await save(p,request,old);
    await expectCode(()=>save({...p,content:'Nội dung khác'},request,old),'22023');
   });
  await proof('MP06 Bỏ quyền sale ở cả hai thời điểm thì phép thử phát hiện nhân viên bị thu hồi vẫn lưu được',[
   defs.can.replace(/AS \$function\$[\s\S]*\$function\$/,'AS $function$ SELECT true $function$'),
   defs.authorize.replace(/AS \$function\$[\s\S]*\$function\$/,'AS $function$ SELECT true $function$')],async()=>{
    await db.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles.sale]);
    await expectCode(()=>save(),'42501');
   });
  await proof('MP07 Bỏ version khi ngưng thì phép thử phát hiện ghi từ hồ sơ cũ',[
   replace(defs.cancel,'IF p.version<>p_expected_version OR p.cancelled_at IS NOT NULL THEN','IF p.cancelled_at IS NOT NULL THEN')],async()=>{
    const first=await save();await expectCode(()=>cancel(first,9),'PT409');
   });
 }finally{await db.end();}
});
