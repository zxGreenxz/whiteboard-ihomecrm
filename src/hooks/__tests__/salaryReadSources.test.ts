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
const useReadQuery=(engine:'legacy'|'v5'='legacy')=>(useManagerSalary('2026-09-01',engine) as unknown as {queryFn:()=>Promise<{managers:unknown[]}>}).queryFn();
beforeEach(()=>{h.tables={manager_salary_config:{data:[{staff_id:'staff',user_id:'owner',organization_id:'org',base_salary:100,default_room_rent:0}],error:null}};h.rpcs={v5_month_money_bulk:{data:{},error:null}};});
describe('required salary read sources',()=>{
 it('keeps a confirmed empty configuration distinct from failure',async()=>{h.tables.manager_salary_config.data=[];await expect(useReadQuery()).resolves.toMatchObject({managers:[]});});
 it.each(['manager_salary_config','profiles','salary_monthly','shareholders','profit_monthly','income_expenses','buildings','income_expense_types'])('rejects a missing %s response instead of calculating zeros',async table=>{h.tables[table]={data:null,error:null};await expect(useReadQuery()).rejects.toThrow();});
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
