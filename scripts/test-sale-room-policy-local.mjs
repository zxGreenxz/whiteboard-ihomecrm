// Real authorization and real canonical writers on the disposable loopback DB.
// Only fixture setup mutates synthetic role grants/timestamps; no product stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { saleQuickClient, seedSaleQuickFixture } from './sale-quick-local-fixture.mjs';
const migration='supabase/migrations/20261021063721_sale_room_timed_policy_v1.sql';
const sql=readFileSync(migration,'utf8');

test('Direct sale metadata and timed policy / real local PostgreSQL',async t=>{
 const admin=await saleQuickClient();
 const f=await seedSaleQuickFixture();
 const names={landlord:'Chủ trọ',company:'Chủ công ty',manager:'Quản Lý Tòa',saleAdmin:'Sale Admin',sale:'Sale',other:'Viewer'};
 for(const [role,name] of Object.entries(names))await admin.query('UPDATE public.organization_roles SET name=$2 WHERE id=$1',[f.roles[role],name]);
 const templates={sale:randomUUID(),saleAdmin:randomUUID(),viewer:randomUUID()};
 for(const [name,id] of Object.entries(templates))await admin.query('INSERT INTO public.roles(id,user_id,organization_id,name,permissions) VALUES($1,$2,$3,$4,$5)',
  [id,f.actors.landlord,f.org,{sale:'SaLe',saleAdmin:'Sale Admin',viewer:'Viewer'}[name],JSON.stringify(name==='sale'?{rooms:{view:true},sale_phong:{view:true}}:[])]);
 await admin.query(sql);
 const clients=Object.fromEntries(await Promise.all(Object.entries(f.actors).map(async([role,actor])=>[role,await saleQuickClient(actor)])));
 const revision=async(room=f.rooms[0])=>(await admin.query('SELECT md5(to_jsonb(r)::text) value FROM public.rooms r WHERE id=$1',[room])).rows[0].value;
 const inv=async(role='landlord',org=f.org)=>(await clients[role].query('SELECT public.get_sale_room_inventory_v1($1) value',[org])).rows[0].value;
 const row=async(role='landlord',room=f.rooms[0])=>(await inv(role)).rooms.find(r=>r.id===room);
 const patch=async(role,fields,opts={})=>(await clients[role].query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5) value',
  [opts.org??f.org,opts.room??f.rooms[0],opts.revision??await revision(opts.room),opts.request??randomUUID(),fields])).rows[0].value;
 const policy=(offset=0)=>({title:'Ưu đãi mùa mới',content:'Miễn phí gửi xe',starts_at:new Date(Date.now()+offset-60_000).toISOString(),ends_at:new Date(Date.now()+offset+3_600_000).toISOString()});
 const save=async(role='sale',p=policy(),opts={})=>(await clients[role].query('SELECT public.save_room_sale_policy_v1($1,$2,$3,$4,$5) value',
  [opts.org??f.org,opts.room??f.rooms[0],opts.revision??await revision(opts.room),opts.request??randomUUID(),p])).rows[0].value;
 const cancel=async(receipt,role='manager',opts={})=>(await clients[role].query('SELECT public.cancel_room_sale_policy_v1($1,$2,$3,$4,$5) value',
  [opts.org??f.org,receipt.policy.id,opts.version??receipt.policy.version,opts.request??randomUUID(),opts.reason??'Ngưng ưu đãi thử nghiệm'])).rows[0].value;
 const denied=(fn,code='42501')=>assert.rejects(fn,e=>e.code===code);
 const grant=async(role,key='sale_phong.edit',effect='ALLOW')=>admin.query(`INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
  VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role_id,permission_key) DO UPDATE SET effect=excluded.effect`,[role==='other'?f.otherOrg:f.org,f.roles[role],key,effect]);
 try {
  await t.test('P01 Cả năm vai trò nhận quyền sale riêng, không cấp quyền tài chính hay rooms.edit mới',async()=>{
   for(const role of ['landlord','company','manager','saleAdmin','sale']) {
    assert.equal((await admin.query("SELECT effect FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles[role]])).rows[0]?.effect,'ALLOW');
    assert.equal((await row(role)).capabilities.edit,true);
   }
   for(const role of ['sale','saleAdmin'])assert.equal((await admin.query("SELECT count(*)::int n FROM public.role_permissions WHERE role_id=$1 AND permission_key IN ('rooms.edit','income_expenses.approve')",[f.roles[role]])).rows[0].n,0);
   assert.equal((await admin.query("SELECT count(*)::int n FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles.other])).rows[0].n,0);
  });
  await t.test('P02 Sale sửa metadata và thưởng nội bộ trong tòa được giao',async()=>{
   const result=await patch('sale',{rent_price:3200000,sale_note:'Ghi chú nền',sale_bonus_note:'Nội bộ sale',area:25,description:'Thông tin mới'});
   assert.equal(result.fields.rent_price,3200000);assert.equal((await row('sale')).sale_bonus_note,'Nội bộ sale');
  });
  await t.test('P03 Sale Admin và quản lý không vượt tòa/công ty qua quyền sale mới',async()=>{
   for(const role of ['sale','saleAdmin','manager'])await denied(()=>patch(role,{rent_price:1},{room:f.rooms[2]}));
   await denied(()=>save('company',policy(),{room:f.rooms[3],org:f.otherOrg}));
  });
  await t.test('P04 Thu hồi quyền sale còn hiệu lực sau migration replay; DENY không bị ghi đè',async()=>{
   await admin.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles.sale]);
   await grant('saleAdmin','sale_phong.edit','DENY');await admin.query(sql);
   await denied(()=>patch('sale',{sale_note:'Không được lưu'}));await denied(()=>patch('saleAdmin',{sale_note:'Không được lưu'}));
   assert.equal((await admin.query("SELECT effect FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles.saleAdmin])).rows[0].effect,'DENY');
   await grant('sale');await grant('saleAdmin');
  });
  await t.test('P05 Tình trạng gõ tay phải có cặp khóa live; không đổi trạng thái thuê',async()=>{
   const current=await row('sale');assert.match(current.sale_fact_key,/^[a-f0-9]{32}$/);
   await denied(()=>patch('sale',{sale_status_note:'Sẵn sàng'}),'22023');
   await denied(()=>patch('sale',{sale_status_note:'Sẵn sàng',sale_status_note_key:'0'.repeat(32)}),'PT409');
   await denied(()=>patch('sale',{status:'OCCUPIED'}),'22023');
   await patch('sale',{sale_status_note:'Gọi trước khi xem',sale_status_note_key:current.sale_fact_key});
   const saved=await row('sale');assert.equal(saved.sale_status_note_raw,'Gọi trước khi xem');assert.equal(saved.sale_status_note,'Gọi trước khi xem');
   await patch('sale',{sale_status_note:null,sale_status_note_key:null});assert.equal((await row('sale')).sale_status_note,null);
  });
  await t.test('P06 Hai Sale mở cùng phiên bản: đúng một metadata thành công',async()=>{
   const old=await revision();const out=await Promise.allSettled([patch('sale',{room_type:'A'},{revision:old}),patch('saleAdmin',{room_type:'B'},{revision:old})]);
   assert.equal(out.filter(x=>x.status==='fulfilled').length,1);assert.equal(out.find(x=>x.status==='rejected').reason.code,'PT409');
  });
  let active;
  await t.test('P07 Sale đăng chính sách trực tiếp, audit đúng người và room CAS thay đổi',async()=>{
   const before=await revision();active=await save();assert.equal(active.policy.status,'ACTIVE');assert.notEqual(active.revision,before);
   const persisted=(await admin.query('SELECT created_by,version FROM app_private.room_sale_policies_v1 WHERE id=$1',[active.policy.id])).rows[0];
   assert.equal(persisted.created_by,f.actors.sale);assert.equal(Number(persisted.version),1);
  });
  await t.test('P08 Base note vẫn riêng; hiệu lực public chỉ ghép content, không chép title/bonus',async()=>{
   const current=await row('sale');assert.equal(current.sale_note,'Ghi chú nền');assert.equal(current.active_policy_text,'Miễn phí gửi xe');
   assert.equal(current.effective_sale_note,'Ghi chú nền\nMiễn phí gửi xe');assert.equal(current.policy.id,active.policy.id);
  });
  await t.test('P09 Không đăng hai chương trình chồng thời gian cùng phòng',async()=>denied(()=>save('manager'),'PT409'));
  await t.test('P10 Dữ liệu thiếu, extra keys, khoảng rỗng, thiếu múi giờ và chính sách đã hết hạn đều bị từ chối',async()=>{
   for(const value of [{...policy(),approved:true},{...policy(),content:' '},{...policy(),ends_at:policy().starts_at},{...policy(),starts_at:'2026-10-21T12:00:00'},policy(-7_200_000)])
    await denied(()=>save('sale',value,{room:f.rooms[1]}),'22023');
  });
  await t.test('P11 Ngưng chính sách có version/reason, audit và invalidate room revision',async()=>{
   await denied(()=>cancel(active,'sale',{reason:' '}),'22023');await denied(()=>cancel(active,'sale',{reason:'x'.repeat(501)}),'22023');await denied(()=>cancel(active,'sale',{version:9}),'PT409');
   const old=await revision();const stopped=await cancel(active,'sale');assert.equal(stopped.policy.status,'CANCELLED');assert.equal(stopped.policy.version,2);assert.notEqual(stopped.revision,old);
   assert.equal((await row('sale')).active_policy_text,null);assert.equal((await row('sale')).effective_sale_note,'Ghi chú nền');
  });
  await t.test('P12 Lưu lại đúng request khi mất phản hồi trả cùng receipt, không nhân đôi policy',async()=>{
   const request=randomUUID(),old=await revision(),p=policy();const first=await save('sale',p,{request,revision:old});
   assert.deepEqual(await save('sale',p,{request,revision:old}),first);
   assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.room_sale_policy_receipts_v1 WHERE organization_id=$1 AND request_id=$2',[f.org,request])).rows[0].n,1);
   await denied(()=>save('sale',{...p,content:'Khác'},{request,revision:old}),'22023');active=first;
  });
  await t.test('P13 Replay cũng phải kiểm quyền mới nhất',async()=>{
   const p=policy(7_200_000),request=randomUUID(),old=await revision();const first=await save('sale',p,{request,revision:old});
   await admin.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.edit'",[f.roles.sale]);
   try{await denied(()=>save('sale',p,{request,revision:old}));}finally{await grant('sale');}
   await cancel(first);
  });
  await t.test('P14 Cancel retry exact trả cùng receipt nhưng đổi reason cùng key bị từ chối',async()=>{
   const request=randomUUID();const first=await cancel(active,'sale',{request});assert.deepEqual(await cancel(active,'sale',{request}),first);
   await denied(()=>cancel(active,'sale',{request,reason:'Khác'}),'22023');
  });
  await t.test('P15 Policy hẹn giờ không hiện sớm; resolver áp dụng [start,end) không cần cron',async()=>{
   const planned=await save('manager',policy(7_200_000));assert.equal(planned.policy.status,'SCHEDULED');
   assert.equal((await row('sale')).active_policy_text,null);assert.ok((await inv('sale')).next_policy_boundary_at);
   const at=async(time)=>(await admin.query('SELECT app_private.room_sale_policy_current_v1($1,$2,$3) p,app_private.room_sale_policy_active_text_v1($1,$2,$3) content',[f.org,f.rooms[0],time])).rows[0];
   assert.equal((await at(planned.policy.starts_at)).p.status,'ACTIVE');assert.equal((await at(planned.policy.starts_at)).content,'Miễn phí gửi xe');
   assert.equal((await at(planned.policy.ends_at)).p.status,'EXPIRED');assert.equal((await at(planned.policy.ends_at)).content,null);
   await cancel(planned);
  });
  await t.test('P16 Public/get_my/worker đọc cùng campaign và tự mất sau expiry; base text còn',async()=>{
   const token=`policy-local-${randomUUID()}`;
   await admin.query('BEGIN');await admin.query('SET LOCAL session_replication_role=replica');
   await admin.query('INSERT INTO public.public_room_share_tokens(owner_id,token,organization_id,revoked,label) VALUES($1,$2,$3,false,$4)',[f.actors.landlord,token,f.org,'Local policy']);
   await admin.query('COMMIT');
   const p=await save('sale');
   const publicRead=async()=>(await admin.query('SELECT public.get_public_available_rooms($1) value',[token])).rows[0].value;
   const workerRead=async()=>(await admin.query('SELECT public.zalo_phong_trong_cho_worker_v1($1) value',[f.org])).rows[0].value;
   const mineRead=async()=>(await clients.landlord.query('SELECT public.get_my_available_rooms() value')).rows[0].value;
   for(const read of [publicRead,workerRead,mineRead])assert.equal((await read()).rooms.find(r=>r.id===f.rooms[0]).sale_note,'Ghi chú nền\nMiễn phí gửi xe');
   for(const read of [publicRead,mineRead]){
    const room=(await read()).rooms.find(r=>r.id===f.rooms[0]);assert.equal(room.sale_note_base,'Ghi chú nền');
    assert.equal(room.active_policy_text,'Miễn phí gửi xe');assert.equal(Date.parse(room.active_policy_ends_at),Date.parse(p.policy.ends_at));
    assert.ok(!('policy' in room));assert.ok(!('created_by' in room));
   }
   await admin.query("UPDATE app_private.room_sale_policies_v1 SET starts_at=clock_timestamp()-interval '2h',ends_at=clock_timestamp()-interval '1h' WHERE id=$1",[p.policy.id]);
   for(const read of [publicRead,workerRead,mineRead])assert.equal((await read()).rooms.find(r=>r.id===f.rooms[0]).sale_note,'Ghi chú nền');
   for(const read of [publicRead,mineRead]){const room=(await read()).rooms.find(r=>r.id===f.rooms[0]);assert.equal(room.active_policy_text,null);assert.equal(room.active_policy_ends_at,null);}
  });
  await t.test('P17 Ngưng/lưu policy khác scope không được nhìn thấy payload',async()=>{
   const p=await save('company',policy(),{room:f.rooms[2]});await denied(()=>cancel(p,'sale'));await denied(()=>cancel(p,'other',{org:f.org}));await cancel(p,'company');
  });
  await t.test('P18 Hai request policy đồng thời cùng room revision chỉ một ghi được',async()=>{
   const old=await revision(),p=policy();const results=await Promise.allSettled([save('sale',p,{revision:old}),save('saleAdmin',p,{revision:old})]);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'PT409');
   await cancel(results.find(x=>x.status==='fulfilled').value);
  });
  await t.test('P19 Hai session cùng request policy trả cùng receipt',async()=>{
   const other=await saleQuickClient(f.actors.sale);try{
    const args=[f.org,f.rooms[0],await revision(),randomUUID(),policy()];
    const results=await Promise.all([clients.sale,other].map(db=>db.query('SELECT public.save_room_sale_policy_v1($1,$2,$3,$4,$5) value',args)));
    assert.deepEqual(results[0].rows[0].value,results[1].rows[0].value);await cancel(results[0].rows[0].value);
   }finally{await other.end();}
  });
  await t.test('P20 Người dùng không được ghi thẳng campaign/receipt hoặc gọi private helper',async()=>{
   await denied(()=>clients.sale.query('SELECT * FROM app_private.room_sale_policies_v1'));
   await denied(()=>clients.sale.query('SELECT * FROM app_private.room_sale_policy_receipts_v1'));
   await denied(()=>clients.sale.query('SELECT app_private.room_sale_policy_active_text_v1($1,$2,now())',[f.org,f.rooms[0]]));
  });
  await t.test('P21 Không đăng nhập không được lưu/ngưng; public policy read không trả audit/bonus',async()=>{
   const anon=await saleQuickClient(),old=await revision();try{await anon.query('SET ROLE anon');await denied(()=>anon.query('SELECT public.save_room_sale_policy_v1($1,$2,$3,$4,$5)',[f.org,f.rooms[0],old,randomUUID(),policy()]));}finally{await anon.end();}
   const projected=(await admin.query("SELECT app_private.room_sale_policy_overlay_v1(jsonb_build_object('rooms',jsonb_build_array(jsonb_build_object('id',$1::text,'building_id',$2::text,'sale_note','base')))) value",[f.rooms[0],f.buildings[0]])).rows[0].value;
   assert.ok(!JSON.stringify(projected).includes('created_by'));assert.ok(!JSON.stringify(projected).includes('sale_bonus_note'));
  });
  await t.test('P22 Inventory tòa giữ đủ metadata để xuất; staff không quản settings của owner',async()=>{
   const data=await inv('sale');assert.equal(data.settings_owner_id,f.actors.landlord);assert.equal(data.can_manage_account_settings,false);
   for(const key of ['public_contact_name','public_contact_phone','public_map_url','public_lift_type','floor_layouts','area_ids','elec_rate'])assert.ok(key in data.buildings[0],key);
  });
  await t.test('P23 Template đúng tên nhận sale edit, giữ quyền khác và không tái cấp khi replay',async()=>{
   const read=async(id)=>(await admin.query('SELECT permissions FROM public.roles WHERE id=$1',[id])).rows[0].permissions;
   assert.deepEqual(await read(templates.sale),{rooms:{view:true},sale_phong:{view:true,edit:true}});
   assert.deepEqual(await read(templates.saleAdmin),{sale_phong:{edit:true}});assert.deepEqual(await read(templates.viewer),[]);
   await admin.query("UPDATE public.roles SET permissions=jsonb_set(permissions,'{sale_phong,edit}','false'::jsonb) WHERE id=$1",[templates.sale]);
   await admin.query(sql);assert.equal((await read(templates.sale)).sale_phong.edit,false);
  });
  await t.test('P24 Cấm riêng một nhân viên còn hiệu lực sau cấp mặc định và migration replay',async()=>{
   const id=randomUUID();await admin.query('BEGIN');await admin.query(`INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,scope_mode)
    VALUES($1,$2,$3,'sale_phong.edit','DENY','Local acceptance','ORGANIZATION')`,[id,f.org,f.memberships.sale]);
   await admin.query(`INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id)
    SELECT organization_id,$1,id FROM public.authorization_scopes WHERE organization_id=$2 AND scope_type='ORGANIZATION'`,[id,f.org]);await admin.query('COMMIT');
   try{await admin.query(sql);await denied(()=>patch('sale',{sale_note:'Bị cấm riêng'}));await denied(()=>save('sale'));assert.equal((await row('sale')).capabilities.edit,false);}
   finally{await admin.query('DELETE FROM public.member_permission_overrides WHERE id=$1',[id]);}
  });
  await t.test('P25 Chính sách nối tiếp cùng phòng không chồng giờ, hiển thị cả hai để ngưng đúng hồ sơ',async()=>{
   const first=await save('sale',policy(7_200_000));
   const next={...policy(14_400_000),starts_at:first.policy.ends_at,content:'Ưu đãi nối tiếp'};
   const second=await save('sale',next);const current=await row('sale');
   assert.deepEqual(current.policies.map(p=>p.id),[first.policy.id,second.policy.id]);assert.equal(current.policy.id,first.policy.id);
   await cancel(second,'sale');assert.deepEqual((await row('sale')).policies.map(p=>p.id),[first.policy.id]);await cancel(first,'sale');
  });
 } finally {for(const client of Object.values(clients))await client.end();await admin.end();}
});
