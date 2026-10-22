import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {seedSaleQuickFixture,saleQuickClient} from './sale-quick-local-fixture.mjs';
import {projectAvailableRooms,projectAvailableRoomsPage} from '../infra/hermes-broker/room-read-projection.mjs';

const f=await seedSaleQuickFixture(),admin=await saleQuickClient(),db=await saleQuickClient(f.actors.manager),results=[];
const user=f.actors.manager,assistant=randomUUID(),session=randomUUID(),provider=randomUUID(),connection=randomUUID();
const digest=createHash('sha256').update(randomUUID()).digest('hex');
const binding={connectionId:connection,tokenDigest:digest,expectedEpoch:1,expectedSessionRevision:1};
async function check(id,request,fn){try{const detail=await fn();results.push({id,request,status:'passed',detail});}catch(error){results.push({id,request,status:'failed',error:{code:error.code??null,message:error.message}});throw error;}}
try{
 await admin.query('BEGIN');await admin.query('SET LOCAL session_replication_role=replica');
 const scope=(await admin.query("SELECT id FROM public.authorization_scopes WHERE organization_id=$1 AND scope_type='BUILDING' AND building_id=$2",[f.org,f.buildings[0]])).rows[0].id;
 await admin.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='rooms.view'");
 await admin.query(`INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,scope_ids,updated_by) VALUES($1,true,1,ARRAY['rooms.view'],$2,$3)`,[f.org,[scope],user]);
 await admin.query('INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES($1,$2,$3)',[assistant,f.org,user]);
 await admin.query(`INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at) VALUES($1,$2,$3,$4,$5,'ACTIVE','{"synthetic_local":true}',now()+interval '1 hour')`,[session,assistant,f.org,user,provider]);
 await admin.query(`INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,read_capabilities,scope_ids,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
  VALUES($1,$2,$3,$4,'ACTIVE',ARRAY['rooms.view'],$5,$6,$7,now()+interval '1 hour',$8)`,[connection,assistant,f.org,user,[scope],session,digest,randomUUID()]);
 await admin.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest,connection]);
 const token='hermes-policy-parity-'+randomUUID();
 await admin.query('INSERT INTO public.public_room_share_tokens(owner_id,token,organization_id,revoked,label) VALUES($1,$2,$3,false,$4)',[f.actors.landlord,token,f.org,'Local policy parity']);
 await admin.query("UPDATE public.rooms SET sale_note='Ghi chú nền' WHERE id=$1",[f.rooms[0]]);
 await admin.query('COMMIT');
 await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[JSON.stringify({sub:user,role:'authenticated',session_id:provider})]);
 const page=async(overrides={})=>(await db.query('SELECT public.hermes_available_rooms_page_v1($1,$2,$3,$4,$5,$6,$7) value',
  [binding,overrides.org??f.org,overrides.buildings??null,'',null,overrides.limit??50,overrides.offset??0])).rows[0].value;
 const compare=async(expected)=>{
  const legacy=(await db.query('SELECT public.hermes_sale_listing_rooms_v1($1) value',[f.org])).rows[0].value;
  const raw=await page(),readAt=Date.now();
  const left=projectAvailableRooms(legacy,{allowedBuildingIds:[f.buildings[0]],offset:0,limit:50,readAt});
  const right=projectAvailableRoomsPage(raw.result,{offset:0,limit:50,readAt});
  assert.deepEqual({...right,source:left.source},left);
  const note=right.rooms.find(room=>room.id===f.rooms[0])?.salePolicy;
  assert.equal(note,expected);
  assert.deepEqual(raw.authority.buildingIds,[f.buildings[0]]);
  assert(raw.result.rooms.every(room=>room.building_id===f.buildings[0]));
  assert(!JSON.stringify(raw).includes('Nội bộ thử nghiệm'));
  assert(!raw.result.rooms.some(room=>'policy' in room||'active_policy_text' in room||'sale_bonus_note' in room));
  const publicRoom=(await admin.query('SELECT public.get_public_available_rooms($1) value',[token])).rows[0].value.rooms.find(room=>room.id===f.rooms[0]);
  assert.equal(legacy.rooms.find(room=>room.id===f.rooms[0]).sale_note,publicRoom.sale_note);
  assert.equal(raw.result.rooms.find(room=>room.id===f.rooms[0]).sale_note,[...publicRoom.sale_note].slice(0,241).join(''));
  return{rooms:right.rooms.length,total:right.totalInSnapshot,salePolicy:note};
 };
 const save=async()=>{
  const revision=(await admin.query('SELECT md5(to_jsonb(r)::text) revision FROM public.rooms r WHERE id=$1',[f.rooms[0]])).rows[0].revision;
  return(await db.query('SELECT public.save_room_sale_policy_v1($1,$2,$3,$4,$5) value',[f.org,f.rooms[0],revision,randomUUID(),
   {title:'Chương trình local',content:'Miễn phí gửi xe',starts_at:new Date(Date.now()-3600000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()}])).rows[0].value;
 };
 await check('HP01','Hermes legacy và page giữ cùng danh sách/phạm vi khi chưa có chương trình',()=>compare('Ghi chú nền'));
 const saved=await save();
 await check('HP02','Canonical web writer lưu ACTIVE; cả legacy/page và public trả cùng chính sách',()=>compare('Ghi chú nền\nMiễn phí gửi xe'));
 await admin.query("UPDATE app_private.room_sale_policies_v1 SET starts_at=clock_timestamp()+interval '1h',ends_at=clock_timestamp()+interval '2h' WHERE id=$1",[saved.policy.id]);
 await check('HP03','Chính sách chưa đến giờ không lộ trên Hermes hoặc public',()=>compare('Ghi chú nền'));
 await admin.query("UPDATE app_private.room_sale_policies_v1 SET starts_at=clock_timestamp()-interval '2h',ends_at=clock_timestamp()-interval '1h' WHERE id=$1",[saved.policy.id]);
 await check('HP04','Chính sách đã hết giờ tự biến mất ở lần đọc mới, giữ ghi chú nền',()=>compare('Ghi chú nền'));
 await db.query('SELECT public.cancel_room_sale_policy_v1($1,$2,$3,$4,$5)',[f.org,saved.policy.id,saved.policy.version,randomUUID(),'Dừng local']);
 await check('HP05','Policy CANCELLED không trở lại trong hai nguồn danh sách',()=>compare('Ghi chú nền'));
 await admin.query('UPDATE public.rooms SET sale_note=$2 WHERE id=$1',[f.rooms[0],'A'.repeat(500)]);await save();
 await check('HP06','Nội dung dài giữ giới hạn transport241/display240 và bằng canonical oracle đã rút gọn',()=>compare('A'.repeat(239)+'…'));
 await check('HP07','Phân trang giữ tổng và không tự mở phạm vi tòa/công ty',async()=>{
  const empty=(await page({offset:1,limit:1})).result;assert.equal(empty.totalCount,1);assert.equal(empty.rooms.length,0);
  for(const overrides of [{buildings:[f.buildings[1]]},{org:f.otherOrg}])await assert.rejects(()=>page(overrides),e=>e.code==='42501');
 });
 await check('HP08','Thu hồi rooms.view ở kết nối chặn page, không suy quyền đọc từ quyền sửa CRM',async()=>{
  await admin.query("UPDATE app_private.hermes_connections SET read_capabilities='{}' WHERE id=$1",[connection]);
  await assert.rejects(()=>page(),e=>['42501','PT409'].includes(e.code));
 });
 console.log(JSON.stringify({tests:results.length,passed:results.filter(r=>r.status==='passed').length,results},null,2));
}finally{
 writeFileSync(new URL('../test-results/sale-quick-local/hermes-policy-parity-postgres.json',import.meta.url),JSON.stringify({
  layer:'Real local PostgreSQL canonical writers/readers/auth plus production JS projections; synthetic sessions; time states set on isolated fixture only; no HTTP or LLM claim',results},null,2)+'\n');
 await db.end();await admin.end();
}
