import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({rpc:vi.fn(), responses:[] as {data:unknown;error:unknown}[], writes:[] as string[]}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query', () => ({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u',email:'demo'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{
  rpc:h.rpc,
  from:(table:string)=>{
    const builder:Record<string,unknown>={};
    for(const method of ['select','update','upsert','delete','insert','eq','neq','in','is','order','limit','maybeSingle','single','not']) builder[method]=()=>{
      if(['insert','update','upsert','delete'].includes(method))h.writes.push(table+':'+method);return builder;
    };
    builder.then=(resolve:(result:unknown)=>void)=>Promise.resolve(h.responses.shift()??{data:null,error:null}).then(resolve);
    return builder;
  },
}}));
import { useSalaryPayout, useUnlockSalaryMonth, useLockSalaryMonth, useSaveSalaryAdjustment, useDeleteSalaryAdjustment, useToggleJobExcluded } from '../useManagerSalary';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
const input={ownerId:'owner',staffId:'staff',staffName:'An',periodMonth:'2026-09-01',amount:100,account_id:'account',voucher_date:'2026-09-30'};
beforeEach(()=>{h.rpc.mockReset();h.responses=[];h.writes=[];});
describe('salary financial feedback',()=>{
  it('does not call a zero-row adjustment update successful or repeat an unknown update',async()=>{
    h.responses=[{data:null,error:null}];
    const hook=useSaveSalaryAdjustment() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    const args={ownerId:'owner',staffId:'staff',periodMonth:'2026-09-01',id:'adjustment',kind:'BONUS',label:'Thưởng',amount:10};
    await expect(hook.mutationFn(args)).rejects.toBeInstanceOf(FinancialWorkflowError);
    await expect(hook.mutationFn(args)).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(h.writes).toEqual(['salary_adjustments:update']);
  });
  it('reports delete with no returned row as no change',async()=>{
    h.responses=[{data:[],error:null}];
    const hook=useDeleteSalaryAdjustment() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(hook.mutationFn('adjustment')).resolves.toMatchObject({changed:false});
  });
  it('does not claim a zero-row job reward update succeeded',async()=>{
    h.responses=[{data:[],error:null}];
    const hook=useToggleJobExcluded() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(hook.mutationFn({jobId:'job',excluded:true})).rejects.toThrow();
  });
  it('retains an authoritative zero unlock count as no change',async()=>{
    h.rpc.mockResolvedValue({data:{state:'DRAFT',period_month:'2026-09-01',unlocked_count:0},error:null});
    const hook=useUnlockSalaryMonth() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(hook.mutationFn({periodMonth:'2026-09-01',staffIds:['staff']})).resolves.toEqual({count:0});
  });
  it('does not accept a lock receipt for a different period',async()=>{
    h.rpc.mockResolvedValue({data:{state:'LOCKED',period_month:'2026-08-01',locked_count:1},error:null});
    const hook=useLockSalaryMonth() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(hook.mutationFn({ownerId:'owner',periodMonth:'2026-09-01',managers:[]})).rejects.toBeInstanceOf(FinancialWorkflowError);
  });
  it('does not unlock when the existing monthly rows cannot be read',async()=>{
    h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
    const error={code:'42501',message:'denied'};h.responses=[{data:null,error}];
    const hook=useUnlockSalaryMonth() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(hook.mutationFn({periodMonth:input.periodMonth,staffIds:['staff']})).rejects.toBe(error);
    expect(h.writes).toEqual([]);
  });
  it('retains the changed monthly IDs if clearing snapshots succeeds but unlocking fails',async()=>{
    h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
    h.responses=[{data:[{id:'month1'}],error:null},{data:null,error:null},{data:[],error:null},{data:null,error:{message:'denied'}}];
    const hook=useUnlockSalaryMonth() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    const args={periodMonth:input.periodMonth,staffIds:['staff']};
    const error=await hook.mutationFn(args).catch(e=>e);
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    if (!(error instanceof FinancialWorkflowError)) throw new Error("Expected partial workflow result");
    expect(error.completed[0].id).toBe('month1');
    await expect(hook.mutationFn(args)).rejects.toBe(error);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('retains a created legacy salary voucher when its items fail and blocks another voucher',async()=>{
    h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
    h.responses=[{data:{id:'building',organization_id:'org'},error:null},{data:[{id:'type',name:'Lương quản lý'}],error:null},{data:{id:'voucher1'},error:null},{data:null,error:{message:'SQL item failed'}}];
    const hook=useSalaryPayout() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    const error=await hook.mutationFn(input).catch(e=>e);
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    if (!(error instanceof FinancialWorkflowError)) throw new Error("Expected partial workflow result");
    expect(error.completed[0].id).toBe('voucher1');
    await expect(hook.mutationFn(input)).rejects.toBe(error);
    expect(h.writes.filter(item=>item==='income_expenses:insert')).toHaveLength(1);
  });
  it('does not claim a null canonical payout response was successful',async()=>{
    h.rpc.mockResolvedValue({data:null,error:null});
    const hook=useSalaryPayout() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    const error=await hook.mutationFn(input).catch(e=>e);
    if (!(error instanceof FinancialWorkflowError)) throw new Error("Expected unknown workflow result");
    expect(error.outcome).toBe('unknown');
    await expect(hook.mutationFn(input)).rejects.toBe(error);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

vi.mock('@/lib/persistentFinancialWorkflow',async()=>{const {FinancialWorkflowGuard}=await import('@/lib/financialWorkflow');return {persistentFinancialWorkflow:()=>new FinancialWorkflowGuard()};});

it('a legacy commission approval requires matching returned IDs before claiming progress',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:[],error:null},{data:{id:'month1'},error:null},{data:null,error:null},{data:[],error:null}];
 const hook=useLockSalaryMonth() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 const manager={id:'staff',base:100,bonusAuto:[],commission:10,investment:0,advance:0,roomRent:0,paid:0,commissionItems:[{voucherId:'commission1'}],ledger:[],calc:{autoSum:0,adjSum:0,gross:110,takehome:110}};
 await expect(hook.mutationFn({ownerId:'owner',periodMonth:'2026-09-01',managers:[manager]})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes).toEqual(['income_expenses:update']);
});
it('a zero-row monthly payout update does not complete a created salary voucher',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:{id:'building',organization_id:'org'},error:null},{data:[{id:'type',name:'Lương quản lý'}],error:null},{data:{id:'voucher1'},error:null},{data:null,error:null},{data:{id:'month1'},error:null},{data:{paid:0},error:null},{data:[],error:null},{data:{code:'PC1',approval_status:'APPROVED',posting_status:'POSTED'},error:null}];
 const hook=useSalaryPayout() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 const error=await hook.mutationFn(input).catch(cause=>cause);
 expect(error).toBeInstanceOf(FinancialWorkflowError);
 if(!(error instanceof FinancialWorkflowError))throw new Error('Expected partial outcome');
 expect(error.outcome).toBe('partial');expect(error.completed).toEqual(expect.arrayContaining([expect.objectContaining({id:'voucher1'})]));
 await expect(hook.mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes.filter(item=>item==='income_expenses:insert')).toHaveLength(1);
});

it('does not create a salary type from an unreadable null type list',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:{id:'building',organization_id:'org'},error:null},{data:null,error:null}];
 const hook=useSalaryPayout() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 await expect(hook.mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.writes).toEqual([]);
});

it('retains a newly created monthly salary ID if the following adjustment fails',async()=>{
 h.responses=[{data:null,error:null},{data:{organization_id:'org'},error:null},{data:{id:'month-created'},error:null},{data:null,error:{code:'42501',message:'denied'}}];
 const hook=useSaveSalaryAdjustment() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 const error=await hook.mutationFn({ownerId:'owner',staffId:'staff',periodMonth:'2026-09-01',kind:'BONUS',label:'Thưởng',amount:100}).catch(cause=>cause);
 expect(error).toBeInstanceOf(FinancialWorkflowError);
 if(!(error instanceof FinancialWorkflowError))throw new Error('Expected partial outcome');
 expect(error.completed).toEqual(expect.arrayContaining([expect.objectContaining({id:'month-created'})]));
});

it('does not claim legacy salary snapshots were cleared when the authoritative read is missing',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:[{id:'month1'}],error:null},{data:null,error:null},{data:null,error:null}];
 const hook=useUnlockSalaryMonth() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(hook.mutationFn({periodMonth:input.periodMonth,staffIds:['staff']})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes).toEqual(['salary_work_ledger_snapshot:delete']);
});
it('does not claim legacy salary snapshots were cleared if rows remain',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:[{id:'month1'}],error:null},{data:null,error:null},{data:[{salary_monthly_id:'month1'}],error:null},{data:[{id:'month1'}],error:null}];
 const hook=useUnlockSalaryMonth() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(hook.mutationFn({periodMonth:input.periodMonth,staffIds:['staff']})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes).toEqual(['salary_work_ledger_snapshot:delete']);
});
it('does not claim salary locking completed from a missing snapshot receipt',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:{id:'month1'},error:null},{data:null,error:null},{data:null,error:null}];
 const manager={id:'staff',name:'An',base:100,bonusAuto:[],commission:0,investment:0,advance:0,roomRent:0,paid:0,commissionItems:[],ledger:[],calc:{autoSum:0,adjSum:0,gross:100,takehome:100}};
 const hook=useLockSalaryMonth() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 const error=await hook.mutationFn({ownerId:'owner',periodMonth:input.periodMonth,managers:[manager]}).catch(cause=>cause);
 expect(error).toBeInstanceOf(FinancialWorkflowError);if(!(error instanceof FinancialWorkflowError))throw new Error('Expected partial outcome');expect(error.completed).toEqual(expect.arrayContaining([expect.objectContaining({id:'month1'})]));
});
