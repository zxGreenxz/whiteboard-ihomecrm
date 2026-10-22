import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saleQuickClient, seedSaleQuickFixture } from './sale-quick-local-fixture.mjs';

test('Sale quick operations / real PostgreSQL + real authorization functions', async t => {
  const f=await seedSaleQuickFixture();
  const admin=await saleQuickClient();
  const clients=Object.fromEntries(await Promise.all(Object.entries(f.actors).map(async ([role,actor])=>[role,await saleQuickClient(actor)])));
  const inventory=async(role='landlord',org=f.org)=> (await clients[role].query('SELECT public.get_sale_room_inventory_v1($1) result',[org])).rows[0].result;
  const revision=async(room=f.rooms[0])=>(await admin.query('SELECT md5(to_jsonb(r)::text) value FROM public.rooms r WHERE id=$1',[room])).rows[0].value;
  const patch=async(role='landlord',fields={sale_note:'Ưu đãi local'},options={})=>{
    const room=options.room??f.rooms[0];
    return (await clients[role].query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5) result',
      [options.org??f.org,room,options.revision??await revision(room),options.request??randomUUID(),fields])).rows[0].result;
  };
  const denied=(action,code='42501')=>assert.rejects(action,error=>error.code===code);
  try {
    await t.test('R01 Chủ trọ xem đủ phòng trống và phòng đã thuê',async()=>{
      const data=await inventory(); assert.equal(data.rooms.length,3);
      assert.ok(data.rooms.some(room=>room.id===f.rooms[1]));
      assert.equal(data.buildings[0].address,'Đường thử nghiệm, Local, Local, Local');
    });
    await t.test('R02 Chủ công ty xem hai tòa thuộc công ty, không thấy công ty khác',async()=>{
      const data=await inventory('company'); assert.equal(data.buildings.length,2); assert.ok(!data.rooms.some(room=>room.id===f.rooms[3]));
    });
    await t.test('R03 Quản lý chỉ xem tòa được giao',async()=>assert.deepEqual((await inventory('manager')).rooms.map(r=>r.id).sort(),f.rooms.slice(0,2).sort()));
    await t.test('R04 Sale Admin chỉ thấy quyền ảnh và báo cọc theo tòa',async()=>{
      const data=await inventory('saleAdmin'); assert.equal(data.rooms.length,2);
      assert.equal(data.rooms[0].capabilities.images,true);assert.equal(data.rooms[0].capabilities.edit,false);assert.equal(data.rooms[0].capabilities.deposit,true);
    });
    await t.test('R05 Sale chỉ xem và giữ tạm; không thấy thưởng nội bộ',async()=>{
      const data=await inventory('sale');assert.equal(data.rooms.length,2);
      assert.equal(data.rooms[0].capabilities.edit,false);assert.equal(data.rooms[0].capabilities.deposit,false);
      assert.equal(data.rooms[0].sale_bonus_note,null);
    });
    await t.test('R06 Chủ trọ cập nhật giá, ưu đãi, diện tích trong một lần lưu',async()=>{
      const fields={rent_price:3500000,area:24.25,sale_note:'Miễn phí gửi xe'};
      const result=await patch('landlord',fields);assert.deepEqual(result.fields,fields);
      const data=await inventory(); const room=data.rooms.find(r=>r.id===f.rooms[0]);assert.equal(room.rent_price,3500000);assert.equal(room.area,24.25);
      assert.equal(room.updated_by_name,'Local landlord');assert.equal(room.revision,result.revision);
    });
    await t.test('R07 Quản lý sửa đúng tòa được giao',async()=>assert.equal((await patch('manager',{room_type:'Studio'})).fields.room_type,'Studio'));
    await t.test('R08 Quản lý không sửa tòa chưa được giao',async()=>denied(()=>patch('manager',{rent_price:1},{room:f.rooms[2]})));
    await t.test('R09 Sale không đổi giá qua gọi trực tiếp',async()=>denied(()=>patch('sale',{rent_price:1})));
    await t.test('R10 Sale Admin chỉ có quyền ảnh vẫn tải được ảnh',async()=>{
      const images=['local/room-01.jpg','https://example.invalid/room-02.jpg'];assert.deepEqual((await patch('saleAdmin',{images})).fields.images,images);
    });
    await t.test('R11 Sale Admin không ghép thay đổi giá vào lần lưu ảnh',async()=>denied(()=>patch('saleAdmin',{images:[],rent_price:1})));
    await t.test('R12 Chủ công ty không ghi chéo công ty',async()=>denied(()=>patch('company',{sale_note:'Sai tổ chức'},{room:f.rooms[3],org:f.otherOrg})));
    await t.test('R13 Không cho đổi trạng thái thuê qua sửa thông tin',async()=>denied(()=>patch('landlord',{status:'AVAILABLE'}),'22023'));
    await t.test('R14 Giá âm hoặc lẻ đồng bị từ chối',async()=>{
      await denied(()=>patch('landlord',{rent_price:-1}),'22023');await denied(()=>patch('landlord',{rent_price:0.5}),'22023');
      await denied(()=>patch('landlord',{rent_price:10_000_000_000_000}),'22023');
    });
    await t.test('R15 Ảnh tạm và đường dẫn vượt thư mục bị từ chối',async()=>{
      for(const image of ['blob:abc','javascript:alert(1)','../private.jpg','//example.invalid/a.jpg'])await denied(()=>patch('landlord',{images:[image]}),'22023');
    });
    await t.test('R16 Hai quản lý mở cùng dữ liệu: lần lưu sau không ghi đè',async()=>{
      const old=await revision();await patch('manager',{sale_note:'Quản lý đã sửa'},{revision:old});
      await denied(()=>patch('company',{sale_note:'Giá trị cũ'},{revision:old}),'PT409');
    });
    await t.test('R17 Mất phản hồi: gửi lại cùng yêu cầu chỉ ghi một lần',async()=>{
      const request=randomUUID(), old=await revision(), fields={description:'Một thay đổi'};
      const first=await patch('manager',fields,{request,revision:old});const replay=await patch('manager',fields,{request,revision:old});
      assert.deepEqual(first,replay);
      assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.sale_room_change_receipts WHERE organization_id=$1 AND request_id=$2',[f.org,request])).rows[0].n,1);
    });
    await t.test('R18 Không tái sử dụng mã yêu cầu cho nội dung khác',async()=>{
      const request=randomUUID(),old=await revision();await patch('manager',{sale_note:'A'},{request,revision:old});
      await denied(()=>patch('manager',{sale_note:'B'},{request,revision:old}),'22023');
    });
    await t.test('R19 Thu hồi quyền có hiệu lực cả với yêu cầu đã lưu',async()=>{
      const request=randomUUID(),old=await revision(),fields={sale_note:'Trước thu hồi'};
      await patch('manager',fields,{request,revision:old});
      await admin.query("UPDATE public.organization_memberships SET status='REVOKED' WHERE id=$1",[f.memberships.manager]);
      try {await denied(()=>patch('manager',fields,{request,revision:old}));}
      finally {await admin.query("UPDATE public.organization_memberships SET status='ACTIVE' WHERE id=$1",[f.memberships.manager]);}
    });
    await t.test('R20 Tài khoản chưa đăng nhập không đọc/ghi được',async()=>{
      const anon=await saleQuickClient();try{
        await anon.query('SET ROLE anon');await denied(()=>anon.query('SELECT public.get_sale_room_inventory_v1($1)',[f.org]));
        const old=await revision();
        await denied(()=>anon.query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5)',[f.org,f.rooms[0],old,randomUUID(),{sale_note:'x'}]));
      }finally{await anon.end();}
    });
    await t.test('R21 Hai phiên lưu đồng thời cùng phiên bản: đúng một thành công',async()=>{
      const old=await revision();
      const results=await Promise.allSettled([patch('manager',{sale_note:'Phiên A'},{revision:old}),patch('company',{sale_note:'Phiên B'},{revision:old})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'PT409');
    });
    await t.test('R22 Hai phiên gửi đồng thời cùng yêu cầu: cùng biên nhận',async()=>{
      const other=await saleQuickClient(f.actors.manager);
      try {
        const args=[f.org,f.rooms[0],await revision(),randomUUID(),{sale_note:'Gửi lại đồng thời'}];
        const results=await Promise.all([clients.manager,other].map(db=>db.query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5) result',args)));
        assert.deepEqual(results[0].rows[0].result,results[1].rows[0].result);
      }finally{await other.end();}
    });
    await t.test('R23 Không công khai biên nhận và dữ liệu trước thay đổi',async()=>denied(()=>clients.sale.query('SELECT * FROM app_private.sale_room_change_receipts')));
    await t.test('R24 Sale bị thu hồi quyền xem không còn thấy phòng',async()=>{
      await admin.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND permission_key='sale_phong.view'",[f.roles.sale]);
      try{assert.equal((await inventory('sale')).rooms.length,0);}
      finally{await admin.query("INSERT INTO public.role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'sale_phong.view')",[f.org,f.roles.sale]);}
    });
    await t.test('R25 Thay đổi bằng luồng khác không gán nhầm người vừa cập nhật',async()=>{
      await patch('manager',{sale_note:'Trong bảng nhanh'});
      await admin.query("UPDATE public.rooms SET description='Luồng khác' WHERE id=$1",[f.rooms[0]]);
      assert.equal((await inventory()).rooms.find(r=>r.id===f.rooms[0]).updated_by_name,null);
    });
  } finally {
    await Promise.all(Object.values(clients).map(db=>db.end()));await admin.end();
  }
});
