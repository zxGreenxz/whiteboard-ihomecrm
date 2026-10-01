import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),read:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:unknown)=>o,useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:()=>{const chain:Record<string,unknown>={};for(const k of ['select','eq','in','order'])chain[k]=()=>chain;chain.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve(m.read()).then(resolve);return chain;}}}));
import {useMyDaySummary,useMyMissions,usePendingLeaveRequests,useMyOpenInspections,useStartInspection,useSubmitInspectionPhoto,useCompleteInspection,useReportDeviceIssue,useRequestLeave,fetchGeoOkCount} from '@/hooks/useMyDay';
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
  ['leave request',useRequestLeave,{date:'2026-09-30'}],
 ])('does not claim success for a missing %s receipt',async(_,hook,input)=>{await expect(mutate(hook(),input)).rejects.toThrow();});
 it('keeps a confirmed zero photos distinct from an unread count',async()=>{m.read.mockReturnValue({data:null,error:null,count:0});expect(await fetchGeoOkCount('s')).toBe(0);});
 it('accepts actual empty mission and inspection lists',async()=>{m.rpc.mockResolvedValue({data:[],error:null});m.read.mockReturnValue({data:[],error:null});expect(await read(useMyMissions())).toEqual([]);expect(await read(useMyOpenInspections('2026-09-30','u'))).toEqual([]);});
 it('does not confirm a leave request for another day',async()=>{m.rpc.mockResolvedValue({data:{status:'pending_leave',date:'2026-10-01'},error:null});await expect(mutate(useRequestLeave(),{date:'2026-09-30'})).rejects.toThrow();});
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

it.each([useStartInspection,useSubmitInspectionPhoto,useCompleteInspection,useReportDeviceIssue,useRequestLeave])('form-owned day mutation suppresses the global fallback notification',hook=>{expect((hook() as unknown as {meta?:{handlesFeedback:boolean}}).meta?.handlesFeedback).toBe(true);});
