import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),read:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:unknown)=>o,useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:()=>{const chain:Record<string,unknown>={};for(const k of ['select','eq','in','order'])chain[k]=()=>chain;chain.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve(m.read()).then(resolve);return chain;}}}));
import {useMyDaySummary,useMyMissions,usePendingLeaveRequests,useMyOpenInspections,useStartInspection,useSubmitInspectionPhoto,useCompleteInspection,useReportDeviceIssue,useRequestLeaveRange,useApproveLeaveBatch,useLeaveWorkdays,leaveRequestErrorMessage,fetchGeoOkCount} from '@/hooks/useMyDay';
const read=(h:unknown)=>(h as {queryFn:()=>Promise<unknown>}).queryFn();
const mutate=(h:unknown,input:unknown)=>(h as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn(input);
beforeEach(()=>{m.rpc.mockReset().mockResolvedValue({data:null,error:null});m.read.mockReset().mockReturnValue({data:null,error:null,count:null});});
describe('day and inspection feedback source',()=>{
 it.each([['day',useMyDaySummary],['missions',useMyMissions],['pending leaves',usePendingLeaveRequests],['open inspections',()=>useMyOpenInspections('2026-09-30','u')]])('rejects an unconfirmed %s source instead of empty or pending',async(_,hook)=>{await expect(read(hook())).rejects.toThrow();});
 it('does not convert a missing exact photo count to zero',async()=>{await expect(fetchGeoOkCount('s')).rejects.toThrow();});
 it.each([
  ['start',useStartInspection,{buildingId:'b',type:'FULL'}],
  ['photo',useSubmitInspectionPhoto,{sessionId:'s',slot:'gps',storagePath:'path',sha256:'hash',lat:null,lng:null}],
  ['complete',useCompleteInspection,{sessionId:'s',conditionNote:'OK'}],
  ['device report',useReportDeviceIssue,{sessionId:'s',reason:'GPS'}],
  ['leave request',useRequestLeaveRange,{from:'2026-11-20',to:'2026-11-23'}],
  ['leave batch decision',useApproveLeaveBatch,{user:'u',dates:['2026-11-20'],approve:true}],
 ])('does not claim success for a missing %s receipt',async(_,hook,input)=>{await expect(mutate(hook(),input)).rejects.toThrow();});
 it('keeps a confirmed zero photos distinct from an unread count',async()=>{m.read.mockReturnValue({data:null,error:null,count:0});expect(await fetchGeoOkCount('s')).toBe(0);});
 it('accepts actual empty mission and inspection lists',async()=>{m.rpc.mockResolvedValue({data:[],error:null});m.read.mockReturnValue({data:[],error:null});expect(await read(useMyMissions())).toEqual([]);expect(await read(useMyOpenInspections('2026-09-30','u'))).toEqual([]);});
 // Đơn 20/11 → 23/11/2026: ngày làm việc 20, 21, 23 (Chủ nhật 22/11 không tính).
 const don={from:'2026-11-20',to:'2026-11-23',requested:['2026-11-20','2026-11-21','2026-11-23'],existing:[],holidays:[],batch:'b-1'};
 it('accepts a receipt where a company holiday in the range was skipped by the server',async()=>{
  m.rpc.mockResolvedValue({data:{...don,requested:['2026-11-20','2026-11-23'],holidays:['2026-11-21']},error:null});
  await expect(mutate(useRequestLeaveRange(),{from:'2026-11-20',to:'2026-11-23'})).resolves.toMatchObject({holidays:['2026-11-21']});
 });
 it('reads the company workday calendar of every month the range touches and rejects a malformed calendar',async()=>{
  m.rpc.mockResolvedValue({data:['2026-11-30','2026-12-01'],error:null});
  expect(await read(useLeaveWorkdays('2026-11-30','2026-12-01'))).toEqual(['2026-11-30','2026-12-01','2026-11-30','2026-12-01']);
  expect(m.rpc.mock.calls.map(c=>c[1])).toEqual([{p_month:'2026-11-01'},{p_month:'2026-12-01'}]);
  expect((useLeaveWorkdays('','') as unknown as {enabled:boolean}).enabled).toBe(false);
  m.rpc.mockResolvedValue({data:[{date:'2026-11-30'}],error:null});
  await expect(read(useLeaveWorkdays('2026-11-30','2026-11-30'))).rejects.toThrow();
 });
 it('sends the chosen range with a trimmed reason and accepts a receipt covering exactly its working days',async()=>{
  m.rpc.mockResolvedValue({data:{...don,requested:['2026-11-20','2026-11-23'],existing:['2026-11-21']},error:null});
  await expect(mutate(useRequestLeaveRange(),{from:'2026-11-20',to:'2026-11-23',reason:'  Về quê '})).resolves.toMatchObject({requested:['2026-11-20','2026-11-23']});
  expect(m.rpc).toHaveBeenCalledWith('request_paid_leave_range',{p_from:'2026-11-20',p_to:'2026-11-23',p_reason:'Về quê'});
  m.rpc.mockResolvedValue({data:{...don,from:'2026-11-20',to:'2026-11-20',requested:['2026-11-20'],batch:'b-2'},error:null});
  await mutate(useRequestLeaveRange(),{from:'2026-11-20',to:'2026-11-20',reason:'   '});
  expect(m.rpc).toHaveBeenLastCalledWith('request_paid_leave_range',{p_from:'2026-11-20',p_to:'2026-11-20',p_reason:null});
 });
 it.each([
  ['another range',{...don,to:'2026-11-24'}],
  ['a missing working day',{...don,requested:['2026-11-20','2026-11-23']}],
  ['a Sunday the server never books',{...don,requested:[...don.requested,'2026-11-22']}],
 ])('does not confirm a leave request whose receipt has %s',async(_,data)=>{m.rpc.mockResolvedValue({data,error:null});await expect(mutate(useRequestLeaveRange(),{from:'2026-11-20',to:'2026-11-23'})).rejects.toThrow();});
 it('confirms a batch decision only for the same person, decision and every distinct day',async()=>{
  m.rpc.mockResolvedValue({data:{approved:true,user:'u',dates:['2026-11-20','2026-11-21']},error:null});
  await expect(mutate(useApproveLeaveBatch(),{user:'u',dates:['2026-11-21','2026-11-20','2026-11-21'],approve:true})).resolves.toMatchObject({approved:true});
  expect(m.rpc).toHaveBeenCalledWith('approve_leave_batch',{p_user:'u',p_dates:['2026-11-21','2026-11-20','2026-11-21'],p_approve:true});
  const batch=useApproveLeaveBatch();
  for(const data of [{approved:false,user:'u',dates:['2026-11-20','2026-11-21']},{approved:true,user:'v',dates:['2026-11-20','2026-11-21']},{approved:true,user:'u',dates:['2026-11-20']}]){
   m.rpc.mockResolvedValue({data,error:null});
   await expect(mutate(batch,{user:'u',dates:['2026-11-20','2026-11-21'],approve:true})).rejects.toThrow();
  }
 });
 it('shows the server sentence for leave_* business errors and a safe fallback otherwise',()=>{
  expect(leaveRequestErrorMessage({code:'P0001',hint:'leave_quota_exceeded',message:'Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại'})).toBe('Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại.');
  expect(leaveRequestErrorMessage({code:'PT409',hint:'leave_day_changed',message:'Ngày 21/11/2026 vừa đổi trạng thái — tải lại rồi gửi lại đơn'})).toContain('21/11/2026');
  const fallback=leaveRequestErrorMessage({code:'XX000',hint:'other',message:'private sql detail'});
  expect(fallback).toContain('Chưa xác nhận được kết quả gửi đơn nghỉ phép');
  expect(fallback).not.toContain('private sql');
 });
});


it.each(['ok','out_of_range','gps_denied'])('accepts the actual SQL photo status %s without reclassifying it as a failure',async(status)=>{
 m.rpc.mockResolvedValue({data:{accepted:true,geofence_status:status,distance_m:status==='out_of_range'?120:null},error:null});
 expect(await mutate(useSubmitInspectionPhoto(),{sessionId:'s',slot:'gps',storagePath:'path',sha256:'hash',lat:null,lng:null})).toMatchObject({accepted:true,geofence_status:status});
});
it('accepts confirmed summary values including no next milestone',async()=>{
 const data={today:{date:'2026-09-30',status:'pending_leave',tick_source:null},attend:{n_chuan:26,day_rate:100000,ticked_days:1,tam_tinh:100000,budget:2600000},streak:{current:1,best:2,breaks_no_leave:0,shields_free_left:1,shields_reserve_left:0,banked:[],next:null},pending_checks:[],leave:{quota:9,used:2,left:7},stage:'live'};
 m.rpc.mockResolvedValue({data,error:null});expect(await read(useMyDaySummary())).toMatchObject(data);
});
// Điểm Chủ nhật V5.1 tích 0,5/ngày (streak_v5.sunday_point) nên số dư là số lẻ — dữ liệu prod 01/10/2026.
it('accepts a half-day Sunday point balance from the V5.1 shield bank',async()=>{
 const data={today:{date:'2026-10-01',status:'pending',tick_source:null},attend:{n_chuan:27,day_rate:222222,ticked_days:0,tam_tinh:0,budget:6000000},streak:{current:0,best:0,breaks_no_leave:0,shields_free_left:1,shields_reserve_left:2,shields_perfect_left:2,sunday_points_left:1.5,banked:[],next:{milestone:4,delta:300000,days_to_go:4}},pending_checks:[],leave:{quota:10,used:0,left:10},stage:'live'};
 m.rpc.mockResolvedValue({data,error:null});expect(await read(useMyDaySummary())).toMatchObject(data);
});
it('still rejects a negative Sunday point balance',async()=>{
 const data={today:{date:'2026-10-01',status:'pending',tick_source:null},attend:{n_chuan:27,day_rate:222222,ticked_days:0,tam_tinh:0,budget:6000000},streak:{current:0,best:0,breaks_no_leave:0,shields_free_left:1,shields_reserve_left:0,shields_perfect_left:0,sunday_points_left:-0.5,banked:[],next:null},pending_checks:[],leave:{quota:10,used:0,left:10},stage:'live'};
 m.rpc.mockResolvedValue({data,error:null});await expect(read(useMyDaySummary())).rejects.toThrow();
});
it('preserves a confirmed completion without claiming a new day tick from a closed-session replay',async()=>{
 m.rpc.mockResolvedValue({data:{status:'passed',message:'Phiên đã đóng trước đó'},error:null});
 expect(await mutate(useCompleteInspection(),{sessionId:'s',conditionNote:'OK'})).toMatchObject({status:'passed',message:'Phiên đã đóng trước đó'});
});

it.each([useStartInspection,useSubmitInspectionPhoto,useCompleteInspection,useReportDeviceIssue,useRequestLeaveRange,useApproveLeaveBatch])('form-owned day mutation suppresses the global fallback notification',hook=>{expect((hook() as unknown as {meta?:{handlesFeedback:boolean}}).meta?.handlesFeedback).toBe(true);});
