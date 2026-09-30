import {beforeEach,it,expect,vi} from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc}}));
import {trangThaiPin,xacThucPin,tieuTokenStepUp} from '../stepUpClient';import {dsGrant,taoGrant,baoCaoNgayGrant} from '../standingGrantClient';
beforeEach(()=>rpc.mockReset());
it.each([{data:null},{data:{}},{data:{da_dat:false,failed_attempts:'bad',locked_until:null}}])('PIN status malformed không giả chưa đặt PIN: %j',async({data})=>{rpc.mockResolvedValue({data,error:null});expect(await trangThaiPin()).toMatchObject({ok:false,trangThai:null});});
it.each([{data:null},{data:{}},{data:[{grant_id:'g',action_id:'a',max_per_day:'bad',used_today:0}]}])('grants malformed không giả empty hoặc 0 budgets: %j',async({data})=>{rpc.mockResolvedValue({data,error:null});expect(await dsGrant('org')).toMatchObject({ok:false,danhSach:[]});});
it.each([{data:{date:'2026-09-30',total_amount:0}},{data:{date:'2026-09-30',plans:[{}],total_amount:0}},{data:{date:'2026-09-30',plans:[],total_amount:'bad'}}])('report thiếu plans/row/total không giả success: %j',async({data})=>{rpc.mockResolvedValue({data,error:null});expect(await baoCaoNgayGrant('org','2026-09-30')).toMatchObject({ok:false,ke:[],tongTien:null});});
it.each([{max_per_day:undefined},{max_per_day:3},{action_id:'another'},{expires_at:null}])('create grant receipt không được fallback giá trị người nhập: %j',async patch=>{rpc.mockResolvedValue({data:{ok:true,grant_id:'g',action_id:'a',max_per_day:2,expires_at:'2026-10-01T00:00:00Z',...patch},error:null});expect(await taoGrant({organizationId:'org',actionId:'a',constraints:{},maxPerDay:2,expiresAt:'2026-10-01T00:00:00Z',reason:'Reason',stepUpToken:'token'})).toMatchObject({ok:false,grant:null});});

const grantRow = { grant_id: 'grant-a', action_id: 'action-a', label_vi: 'Hành động A', constraints: {}, max_per_day: 2, used_today: 0, used_on: null, expires_at: '2026-10-01T00:00:00Z', revoked_at: null, revoked_by: null, reason: 'Đã đối chiếu', granter_user_id: 'admin-a', created_at: '2026-09-30T00:00:00Z' };
it.each([{expires_at:null},{expires_at:'BAD'},{created_at:null},{granter_user_id:null},{constraints:{max_amount:'200'}},{constraints:{building_ids:['building-a',2]}}])('grant required expiration/constraints không fallback: %j',async patch=>{
 rpc.mockResolvedValue({data:[{...grantRow,...patch}],error:null});expect(await dsGrant('org')).toMatchObject({ok:false,danhSach:[]});
});
it('báo cáo đúng envelope nhưng sai ngày yêu cầu không success',async()=>{
 rpc.mockResolvedValue({data:{date:'2026-09-29',plans:[],plan_count:0,total_amount:0},error:null});expect(await baoCaoNgayGrant('org','2026-09-30')).toMatchObject({ok:false,ngay:null});
});
it('báo cáo valid envelope nhưng approval date sai không bỏ qua',async()=>{
 rpc.mockResolvedValue({data:{date:'2026-09-30',plans:[{plan_id:'p',approved_at:'BAD',plan_status:'DONE',max_risk:'L4',step_count:1,standing_grant_ids:['g']}],plan_count:1,total_amount:0},error:null});expect(await baoCaoNgayGrant('org','2026-09-30')).toMatchObject({ok:false,ke:[]});
});
it.each([null,'BAD','2020-01-01T00:00:00Z'])('verify thiếu/sai/quá hạn expires không cất token hoặc tự gia hạn: %j',async expiry=>{
 rpc.mockResolvedValue({data:{ok:true,step_up_token:'test-nonce',expires_at:expiry},error:null});expect(await xacThucPin('9284','org')).toMatchObject({ok:false,maLoi:'phan_hoi_khong_doc_duoc'});expect(tieuTokenStepUp('org')).toBeNull();
});
