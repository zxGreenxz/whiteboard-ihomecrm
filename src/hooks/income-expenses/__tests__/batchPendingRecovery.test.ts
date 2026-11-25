// @vitest-environment jsdom
// Đợt 3: phiếu tổng (cả bảo trì đa toà) tra đúng đợt theo mã do trình duyệt sinh (cách D). Mã đợt chính là mã yêu
// cầu của dấu, nên gửi lại sau khi "chưa thấy" vẫn dùng đúng mã đó và khoá chính của income_expense_batches chặn
// đợt thứ hai. Lỗi từ chối rõ mà các phiếu con đã huỷ lại và đợt đã xoá (đã kiểm) thì gỡ dấu ngay.
import {renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
type Row=Record<string,unknown>;
const io=vi.hoisted(()=>({tables:{} as Record<string,Row[]>,rpc:vi.fn(),fail:{} as Record<string,'drop'|'lost'|'reject'|undefined>,seq:0,now:()=>new Date().toISOString()}));
const once=(key:string)=>{const mode=io.fail[key];io.fail[key]=undefined;return mode;};
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:io.rpc,from:(table:string)=>{
  const rows=()=>io.tables[table]??(io.tables[table]=[]);
  const filters:((r:Row)=>boolean)[]=[];let op:'select'|'insert'|'delete'='select';let pending:Row[]=[];
  const exec=async(mode:'many'|'one'|'maybe')=>{
    if(op==='insert'){
      const f=once(`${table}.insert`);
      if(f==='drop')throw new TypeError('Failed to fetch');
      if(f==='reject')return {data:null,error:{code:'42501',message:'denied'}};
      for(const row of pending){if(row.id&&rows().some(r=>r.id===row.id))return {data:null,error:{code:'23505',message:'duplicate key value violates unique constraint'}};}
      const inserted=pending.map(row=>({id:row.id??`${table}-${++io.seq}`,created_at:io.now(),...row}));rows().push(...inserted);
      if(f==='lost')throw new TypeError('Failed to fetch');
      return {data:mode==='many'?inserted:inserted[0],error:null};
    }
    if(op==='delete'){
      if(once(`${table}.delete`)==='reject')return {data:null,error:{code:'42501',message:'denied'}};
      const gone=rows().filter(r=>filters.every(f=>f(r)));io.tables[table]=rows().filter(r=>!gone.includes(r));
      return {data:gone,error:null};
    }
    const found=rows().filter(r=>filters.every(f=>f(r)));
    if(mode==='many')return {data:found,error:null};
    if(mode==='one'&&found.length!==1)return {data:null,error:{code:'PGRST116',message:'0 rows'}};
    return {data:found[0]??null,error:null};
  };
  const b:Row={
    insert:(value:Row|Row[])=>{op='insert';pending=Array.isArray(value)?value:[value];return b;},
    delete:()=>{op='delete';return b;},select:()=>b,order:()=>b,limit:()=>b,
    eq:(c:string,v:unknown)=>{filters.push(r=>r[c]===v);return b;},
    in:(c:string,v:unknown[])=>{filters.push(r=>v.includes(r[c]));return b;},
    gte:(c:string,v:string)=>{filters.push(r=>String(r[c])>=v);return b;},
    single:()=>exec('one'),maybeSingle:()=>exec('maybe'),
    then:(ok:(v:unknown)=>unknown,ko?:(e:unknown)=>unknown)=>exec('many').then(ok,ko),
  };
  return b;
}}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1',user_metadata:{full_name:'Tâm'}})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
vi.mock('../accountingClass',()=>({loadIncomeExpenseAccountingClassResolver:async()=>()=>'PNL'}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn(),warning:vi.fn()}}));
import {useCreateIncomeExpenseBatch} from '../batch';
import {FinancialPendingError,PENDING_SETTLE_MS,financialPending} from '@/lib/financialPending';
import {FinancialAlreadyRecordedError} from '@/lib/financialWorkflowError';
import {VoucherPartialError} from '@/lib/voucherFeedback';

const T0=Date.parse('2026-11-24T02:00:00.000Z');let clock=T0;
const advance=(ms:number)=>{clock+=ms;vi.setSystemTime(clock);};
const scope={namespace:'voucher-batch-create',userId:'u1',organizationId:'o1',businessKey:'EXPENSE'};
const item={income_expense_type_id:'t1',quantity:1,unit_price:100,building_id:'b1',room_id:null,start_date:'2026-11-01',end_date:'2026-11-30'};
const input={type:'EXPENSE',shared_name:'Bảo trì thang máy',account_id:'a1',voucher_date:'2026-11-24',items:[item,{...item,building_id:'b2'}]};
const submit=()=>(renderHook(()=>useCreateIncomeExpenseBatch()).result.current as unknown as {mutationFn:(i:unknown)=>Promise<{batch:{id:string};voucherIds:string[]}>}).mutationFn(input);
const batches=()=>io.tables.income_expense_batches??[];
const activeChildren=()=>(io.tables.income_expenses??[]).filter(v=>v.approval_status!=='CANCELLED');

beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});clock=T0;vi.setSystemTime(clock);
  localStorage.clear();vi.clearAllMocks();io.tables={};io.fail={};io.seq=0;
  io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    const f=once(name);
    if(f==='drop')throw new TypeError('Failed to fetch');
    if(f==='reject')return {data:null,error:{code:'55000',message:'Sổ quỹ đã khoá tại ngày phiếu'}};
    const vouchers=io.tables.income_expenses??(io.tables.income_expenses=[]);
    if(name==='ie_compat_insert_v2'){
      const row=args.p_row as Row;const id=`v${++io.seq}`;
      vouchers.push({id,code:'PC-'+id,type:row.type,approval_status:'UNAPPROVED',deleted_at:null,user_id:'u1',created_at:new Date(clock).toISOString()});
      if(f==='lost')throw new TypeError('Failed to fetch');
      return {data:{id},error:null};
    }
    if(name==='ie_compat_cancel_v2'){
      const ids=args.p_ids as string[];for(const v of vouchers)if(ids.includes(String(v.id)))v.approval_status='CANCELLED';
      return {data:{cancelled:ids.length},error:null};
    }
    throw new Error('rpc lạ '+name);
  });
});
afterEach(()=>{vi.useRealTimers();});

describe('phiếu tổng: mã đợt do trình duyệt sinh',()=>{
  it('đợt mang đúng mã yêu cầu của dấu',async()=>{
    const result=await submit();
    expect(result.batch.id).toMatch(/^[0-9a-f-]{36}$/);expect(batches()).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('lệnh tạo đợt không tới máy chủ: dưới 2 phút chờ; quá 2 phút không thấy đợt thì gửi lại đúng mã đợt, một đợt',async()=>{
    io.fail['income_expense_batches.insert']='drop';
    await expect(submit()).rejects.toThrow();
    const key=financialPending.read(scope)?.requestKey;expect(key).toBeTruthy();
    await expect(submit()).rejects.toBeInstanceOf(FinancialPendingError);
    advance(PENDING_SETTLE_MS);
    const result=await submit();
    expect(result.batch.id).toBe(key);expect(batches()).toHaveLength(1);expect(activeChildren()).toHaveLength(2);
  });
  it('lệnh tạo đợt tới nhưng mất phản hồi: tra thấy đợt theo mã ⇒ báo mã đợt, không tạo đợt thứ hai',async()=>{
    io.fail['income_expense_batches.insert']='lost';
    await expect(submit()).rejects.toThrow();expect(batches()).toHaveLength(1);
    const error=await submit().then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain(String(batches()[0].id));
    expect(batches()).toHaveLength(1);expect(io.rpc).not.toHaveBeenCalled();expect(financialPending.read(scope)).toBeNull();
  });
  it('phiếu con bị từ chối rõ, đã huỷ lại phiếu con và xoá đợt: gỡ dấu ngay, lập lại được',async()=>{
    io.rpc.mockImplementationOnce(async()=>({data:{id:'v-dau'},error:null}));
    (io.tables.income_expenses??=[]).push({id:'v-dau',code:'PC-dau',approval_status:'UNAPPROVED',deleted_at:null});
    io.fail.ie_compat_insert_v2='reject';
    const error=await submit().then(()=>null,(e:unknown)=>e);
    expect(error).not.toBeInstanceOf(VoucherPartialError);expect((error as Error).message).toMatch(/đã được huỷ lại/);
    expect(batches()).toHaveLength(0);expect(activeChildren()).toHaveLength(0);expect(financialPending.read(scope)).toBeNull();
    await expect(submit()).resolves.toMatchObject({voucherIds:['v1','v2']});
  });
  it('phiếu con mất phản hồi: giữ dấu (có thể còn phiếu con chưa biết), không gửi lại',async()=>{
    io.fail.ie_compat_insert_v2='lost';
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(financialPending.read(scope)).not.toBeNull();
    const calls=io.rpc.mock.calls.length;advance(PENDING_SETTLE_MS*5);
    await expect(submit()).rejects.toBeInstanceOf(FinancialPendingError);
    expect(io.rpc).toHaveBeenCalledTimes(calls);
  });
  it('dọn sau lỗi hỏng, đợt còn trên máy chủ: báo mã đợt, không gửi lại',async()=>{
    io.rpc.mockImplementationOnce(async()=>({data:{id:'v-dau'},error:null}));
    (io.tables.income_expenses??=[]).push({id:'v-dau',code:'PC-dau',approval_status:'UNAPPROVED',deleted_at:null});
    io.fail.ie_compat_insert_v2='reject';io.fail['income_expense_batches.delete']='reject';
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(batches()).toHaveLength(1);
    const calls=io.rpc.mock.calls.length;
    const error=await submit().then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain(String(batches()[0].id));
    expect(io.rpc).toHaveBeenCalledTimes(calls);
  });
});

it('đợt đã xoá nhưng huỷ lại phiếu con hỏng: báo mã phiếu con còn hiệu lực, không gửi lại',async()=>{
  io.rpc.mockImplementationOnce(async()=>({data:{id:'v-dau'},error:null}));
  (io.tables.income_expenses??=[]).push({id:'v-dau',code:'PC-dau',approval_status:'UNAPPROVED',deleted_at:null});
  io.fail.ie_compat_insert_v2='reject';io.fail.ie_compat_cancel_v2='drop';
  await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
  expect(batches()).toHaveLength(0);expect(activeChildren()).toHaveLength(1);
  const calls=io.rpc.mock.calls.length;
  await expect(submit()).rejects.toThrow(/PC-dau/);
  expect(io.rpc).toHaveBeenCalledTimes(calls);expect(financialPending.read(scope)).toBeNull();
});

describe('dấu cũ gieo sẵn (mã đợt do máy chủ sinh, không tên thao tác)',()=>{
  const seed=(completedIds:string[]=[])=>localStorage.setItem('ihome:financial-pending:v1:voucher-batch-create:u1:o1:EXPENSE',JSON.stringify({...scope,attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:'00000000-0000-4000-8000-0000000000bb',completedIds,startedAt:new Date(T0-30_000).toISOString()}));
  it('đã nhận mã đợt và đợt còn ⇒ báo mã đợt, không gửi',async()=>{
    (io.tables.income_expense_batches??=[]).push({id:'batch-cu',type:'EXPENSE',user_id:'u1',created_at:new Date(T0-20_000).toISOString()});
    seed(['batch-cu']);
    await expect(submit()).rejects.toThrow(/batch-cu/);expect(io.rpc).not.toHaveBeenCalled();expect(financialPending.read(scope)).toBeNull();
  });
  it('chưa nhận mã đợt, có đợt của mình cùng loại sau giờ kẹt ⇒ báo "có thể đã tạo" kèm mã',async()=>{
    (io.tables.income_expense_batches??=[]).push({id:'batch-cu',type:'EXPENSE',user_id:'u1',created_at:new Date(T0-20_000).toISOString()});
    seed();
    await expect(submit()).rejects.toThrow(/Có thể.*batch-cu/);expect(io.rpc).not.toHaveBeenCalled();
  });
  it('chưa nhận mã đợt, không thấy đợt nào ⇒ quá 2 phút thì lập',async()=>{
    seed();advance(PENDING_SETTLE_MS);
    await expect(submit()).resolves.toMatchObject({voucherIds:['v1','v2']});expect(batches()).toHaveLength(1);
  });
});
