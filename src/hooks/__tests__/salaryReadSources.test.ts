import { beforeEach, describe, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({tables:{} as Record<string,{data:unknown;error:unknown}>,rpcs:{} as Record<string,{data:unknown;error:unknown}>}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
vi.mock('@/hooks/useSalaryExtras',()=>({EMPTY_SALARY_EXTRAS:{recurring:[],overrides:[],available:false},fetchSalaryExtras:async()=>({recurring:[],overrides:[],available:true})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:async(name:string)=>h.rpcs[name]??{data:[],error:null},from:(table:string)=>{
 const builder:Record<string,unknown>={};
 for(const method of ['select','eq','lte','gte','in','is','neq','order'])builder[method]=()=>builder;
 builder.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve(h.tables[table]??{data:[],error:null}).then(resolve);
 return builder;
}}}));
import {useManagerSalary,useStaffDisplayMonth} from '../useManagerSalary';
import type {SalManager} from '@/lib/managerSalary';
const useReadQuery=(engine:'legacy'|'v5'='legacy')=>(useManagerSalary('2026-09-01',engine) as unknown as {queryFn:()=>Promise<{managers:SalManager[]}>}).queryFn();
// E12 salary_profit_inputs_v1 — dòng trung tính của nhân viên không phải cổ đông.
const profitStaff=(over:Record<string,unknown>={})=>({staff_id:'staff',organization_id:'org',shareholder_id:null,sheet_status:'NONE',profit_draft:false,allocations:[],by_building:[],allocated_total:0,investment_month:0,investment_cap:0,marker_through:null,settled_by_marker:false,settlement:null,paid_lines:[],paid_investment:0,paid_offset:0,advance_open:0,advance_offset_month:0,suggested_advance_offset:0,remaining_offset:0,offset_conflict:false,needs_review:{count:0,suggested:0},...over});
beforeEach(()=>{h.tables={manager_salary_config:{data:[{staff_id:'staff',user_id:'owner',organization_id:'org',base_salary:100,default_room_rent:0}],error:null}};h.rpcs={v5_month_money_bulk:{data:{},error:null},salary_profit_inputs_v1:{data:{period_month:'2026-09-01',staff:[profitStaff()]},error:null}};});
describe('required salary read sources',()=>{
 it('keeps a confirmed empty configuration distinct from failure',async()=>{h.tables.manager_salary_config.data=[];await expect(useReadQuery()).resolves.toMatchObject({managers:[]});});
 it.each(['manager_salary_config','profiles','salary_monthly','income_expenses','income_expense_types'])('rejects a missing %s response instead of calculating zeros',async table=>{h.tables[table]={data:null,error:null};await expect(useReadQuery()).rejects.toThrow();});
 it.each(['shareholders','profit_monthly','profit_allocations','buildings'])('no longer reads %s directly — profit share comes from the server (E12)',async table=>{h.tables[table]={data:null,error:null};await expect(useReadQuery()).resolves.toMatchObject({managers:[{investment:0,profit:null}]});});
 it('rejects a missing or failed profit-input read instead of an investment of zero',async()=>{
  h.rpcs.salary_profit_inputs_v1={data:null,error:null};await expect(useReadQuery()).rejects.toThrow();
  const error={code:'42501',message:'SALARY_PROFIT_DENIED: x'};h.rpcs.salary_profit_inputs_v1={data:null,error};await expect(useReadQuery()).rejects.toBe(error);
  h.rpcs.salary_profit_inputs_v1={data:{period_month:'2026-09-01',staff:[]},error:null};await expect(useReadQuery()).rejects.toThrow();
 });
 it('shareholder: investment from LOCKED allocations with server labels; profit advance lowers take-home inside advance',async()=>{
  h.rpcs.salary_profit_inputs_v1={data:{period_month:'2026-09-01',staff:[profitStaff({shareholder_id:'sh',sheet_status:'DRAFT',allocations:[{building_id:'b1',building_label:'T1',amount:'300',status:'LOCKED',is_stale:false},{building_id:'b2',building_label:'T2',amount:50,status:'DRAFT',is_stale:false}],investment_month:300,investment_cap:300,advance_offset_month:120,suggested_advance_offset:120})]},error:null};
  const [m]=(await useReadQuery()).managers;
  expect(m).toMatchObject({investment:300,investmentBy:[{b:'T1',amount:300}],investmentLocked:true,advance:120,profit:{advanceOffset:120,investmentMonth:300}});
  expect(m.calc).toMatchObject({gross:400,takehome:280});
 });
 it('shareholder whose company still has unlocked buildings and no locked share: profit pending, not zero',async()=>{
  h.rpcs.salary_profit_inputs_v1={data:{period_month:'2026-09-01',staff:[profitStaff({shareholder_id:'sh',sheet_status:'DRAFT',profit_draft:true})]},error:null};
  await expect(useReadQuery()).resolves.toMatchObject({managers:[{investmentLocked:false}]});
 });
 it('does not replace a missing work ledger with no work',async()=>{h.rpcs.salary_work_ledger={data:null,error:null};await expect(useReadQuery()).rejects.toThrow();});
 it('preserves a permission-filtered v5 response with omitted staff keys',async()=>{await expect(useReadQuery('v5')).resolves.toMatchObject({managers:[{base:100}]});});
 it('does not use legacy amounts when the entire v5 response is missing',async()=>{h.rpcs.v5_month_money_bulk={data:null,error:null};await expect(useReadQuery('v5')).rejects.toThrow();});
 it('retains an error loading streaks instead of presenting zero streak',async()=>{const error={code:'42501',message:'denied'};h.tables.salary_streak_state={data:null,error};await expect(useReadQuery('v5')).rejects.toBe(error);});
 it('rejects missing streak rows',async()=>{h.tables.salary_streak_state={data:null,error:null};await expect(useReadQuery('v5')).rejects.toThrow();});
 it('does not choose a display month from missing locked salary rows',async()=>{h.rpcs.salary_staff_months={data:{},error:null};h.tables.salary_monthly={data:null,error:null};const query=useStaffDisplayMonth('staff') as unknown as {queryFn:()=>Promise<unknown>};await expect(query.queryFn()).rejects.toThrow();});
});

it('rejects malformed configured base salary rather than replacing it with zero',async()=>{
 h.tables.manager_salary_config.data=[{staff_id:'staff',user_id:'owner',organization_id:'org',base_salary:'bad'}];
 await expect(useReadQuery()).rejects.toThrow();
});
it('rejects malformed monthly paid value rather than presenting no prior payment',async()=>{
 h.tables.salary_monthly={data:[{staff_id:'staff',period_month:'2026-09-01',paid:'bad'}],error:null};
 await expect(useReadQuery()).rejects.toThrow();
});

it.each([null,undefined])('cross-review: missing invoice total %j is not zero salary rent',async total_amount=>{
 h.tables.manager_salary_config.data=[{staff_id:'staff',user_id:'owner',organization_id:'org',base_salary:100,room_id:'room'}];
 h.tables.invoices={data:[{id:'invoice',room_id:'room',total_amount,remaining_amount:50}],error:null};
 await expect(useReadQuery()).rejects.toThrow();
});
it.each([null,undefined])('cross-review: missing invoice remaining %j is not the invoice total',async remaining_amount=>{
 h.tables.manager_salary_config.data=[{staff_id:'staff',user_id:'owner',organization_id:'org',base_salary:100,room_id:'room'}];
 h.tables.invoices={data:[{id:'invoice',room_id:'room',total_amount:100,remaining_amount}],error:null};
 await expect(useReadQuery()).rejects.toThrow();
});
it.each([null,{}, {attend_amount:null,streak_amount:0,ticked_days:0,n_chuan:0}])('cross-review: a present malformed v5 staff entry %j cannot become legacy or zero salary',async entry=>{
 h.rpcs.v5_month_money_bulk={data:{staff:entry},error:null};await expect(useReadQuery('v5')).rejects.toThrow();
});
it('cross-review: explicit zero v5 amounts remain valid while omitted staff keys keep the authorized legacy fallback',async()=>{
 h.rpcs.v5_month_money_bulk={data:{staff:{attend_amount:0,streak_amount:0,ticked_days:0,n_chuan:0}},error:null};
 await expect(useReadQuery('v5')).resolves.toMatchObject({managers:[{base:0}]});
});
