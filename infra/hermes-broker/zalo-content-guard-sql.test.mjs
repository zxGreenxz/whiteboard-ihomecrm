import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('broadcast content guard attaches atomically and never relabels old queued content',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;
 CREATE TABLE public.zalo_send_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_key text UNIQUE,payload jsonb);
 CREATE FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE q uuid;BEGIN
 SELECT id INTO q FROM public.zalo_send_queue WHERE request_key=$4;
 IF FOUND THEN RETURN jsonb_build_object('status','queued','reused',true,'job_id',q);END IF;
 INSERT INTO public.zalo_send_queue(request_key,payload) VALUES($4,jsonb_build_object('tu_dong',true,'body',$2)) RETURNING id INTO q;
 RETURN jsonb_build_object('status','queued','reused',false,'job_id',q);END$$;
 CREATE FUNCTION public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
 AS $$SELECT public.zalo_enqueue_broadcast_v1($3,$4,$5,$6,$7)$$;
 REVOKE ALL ON FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb),public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb) FROM PUBLIC;`);
 const source=readFileSync(new URL('../../supabase/migrations/20261020184631_zalo_broadcast_content_guard_v2.sql',import.meta.url),'utf8');
 await db.exec(source);await db.exec(source);
 const guard={version:1,fingerprint:'a'.repeat(64)},id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 async function call(key,g=guard,role='service_role',oneshot=false){
  await db.exec(`BEGIN;SET LOCAL ROLE ${role}`);
  try{const result=(await db.query(oneshot?
   'SELECT public.zalo_enqueue_broadcast_oneshot_v2($1,$1,$1,$2,now(),$3,null,$4) result':
   'SELECT public.zalo_enqueue_broadcast_v2($1,$2,now(),$3,null,$4) result',[id,'Snapshot old',key,JSON.stringify(g)])).rows[0].result;
   await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
 }
 await t.test('new queue and snapshot share one commit; replay preserves one row',async()=>{
  const first=await call('new');assert.equal(first.reused,false);
  const replay=await call('new');assert.equal(replay.job_id,first.job_id);assert.equal(replay.reused,true);
  const row=(await db.query("SELECT payload FROM public.zalo_send_queue WHERE request_key='new'")).rows[0];
  assert.deepEqual(row.payload.sale_content_guard,guard);
 });
 await t.test('changed snapshot on same request refuses enqueue; original body/hash survives',async()=>{
  assert.equal((await call('new',{version:1,fingerprint:'b'.repeat(64)})).status,'skipped');
  const row=(await db.query("SELECT payload FROM public.zalo_send_queue WHERE request_key='new'")).rows[0];
  assert.equal(row.payload.body,'Snapshot old');assert.deepEqual(row.payload.sale_content_guard,guard);
 });
 await t.test('invalid guard rolls back canonical queue insertion and browser roles cannot invoke',async()=>{
  await assert.rejects(()=>call('invalid',{version:1,fingerprint:'bad'}),e=>e.code==='22023');
  assert.equal((await db.query("SELECT count(*)::int n FROM public.zalo_send_queue WHERE request_key='invalid'")).rows[0].n,0);
  for(const role of ['anon','authenticated'])await assert.rejects(()=>call('denied',guard,role),e=>e.code==='42501');
 });
 await t.test('one-shot uses same guard boundary without replacing the canonical enqueue',async()=>{
  assert.equal((await call('oneshot',guard,'service_role',true)).status,'queued');
  assert.deepEqual((await db.query("SELECT payload->'sale_content_guard' guard FROM public.zalo_send_queue WHERE request_key='oneshot'")).rows[0].guard,guard);
 });
});
