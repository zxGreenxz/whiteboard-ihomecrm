// @vitest-environment jsdom
// Đợt 3: phiếu tổng (cả bảo trì đa toà) tra đúng đợt theo mã do trình duyệt sinh (cách D). Mã đợt chính là mã yêu
// cầu của dấu, nên gửi lại sau khi "chưa thấy" vẫn dùng đúng mã đó và khoá chính của income_expense_batches chặn
// đợt thứ hai. Lỗi từ chối rõ mà các phiếu con đã huỷ lại và đợt đã xoá (đã kiểm) thì gỡ dấu ngay.
import {renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
type Row=Record<string,unknown>;
const io=vi.hoisted(()=>({tables:{} as Record<string,Row[]>,rpc:vi.fn(),fail:{} as Record<string,'drop'|'lost'|'reject'|undefined>,seq:0,claims:new Map<string,string>(),now:()=>new Date().toISOString()}));
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
vi.mock('../accountingClass',()=>({loadIncomeExpenseAccountingClassResolver:async()=>(id:string)=>id==='tcoc'?'DEPOSIT':'PNL'}));
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
  localStorage.clear();vi.clearAllMocks();io.tables={};io.fail={};io.seq=0;io.claims=new Map();
  io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    const f=once(name);
    if(f==='drop')throw new TypeError('Failed to fetch');
    if(f==='reject')return {data:null,error:{code:'55000',message:'Sổ quỹ đã khoá tại ngày phiếu'}};
    const vouchers=io.tables.income_expenses??(io.tables.income_expenses=[]);
    if(name==='ie_compat_insert_v2'||name==='ie_compat_insert_keyed_v1'){
      const key=name==='ie_compat_insert_keyed_v1'?String(args.p_request_key):null;
      const claim=key?io.claims.get(key):undefined;
      if(claim)return {data:{id:claim,approval_status:'UNAPPROVED',replayed:true},error:null};
      const row=args.p_row as Row;const id=`v${++io.seq}`;
      vouchers.push({id,code:'PC-'+id,type:row.type,approval_status:'UNAPPROVED',deleted_at:null,user_id:'u1',created_at:new Date(clock).toISOString()});
      if(key)io.claims.set(key,id);
      if(f==='lost')throw new TypeError('Failed to fetch');
      return {data:{id},error:null};
    }
    if(name==='get_own_income_expense_requests_v1'){
      const wanted=args.p_request_keys as string[];
      return {data:wanted.flatMap(k=>io.claims.has(k)?[{voucher_id:io.claims.get(k),write_path:'compat',request_key:k}]:[]),error:null};
    }
    if(name==='get_own_deposit_income_v1')return {data:null,error:null};
    if(name==='create_deposit_income_v1'){
      const id=`00000000-0000-4000-8000-${String(++io.seq).padStart(12,'0')}`;
      vouchers.push({id,code:'PT-'+io.seq,type:'INCOME',approval_status:'APPROVED',deleted_at:null,user_id:'u1',created_at:new Date(clock).toISOString()});
      return {data:{id,code:'PT-'+io.seq,approval_status:'APPROVED',reservation_id:null,reservation:null},error:null};
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
    io.fail.ie_compat_insert_keyed_v1='reject';
    const error=await submit().then(()=>null,(e:unknown)=>e);
    expect(error).not.toBeInstanceOf(VoucherPartialError);expect((error as Error).message).toMatch(/đã được huỷ lại/);
    expect(batches()).toHaveLength(0);expect(activeChildren()).toHaveLength(0);expect(financialPending.read(scope)).toBeNull();
    await expect(submit()).resolves.toMatchObject({voucherIds:['v1','v2']});
  });
  it('đợt 10a: mỗi phiếu con mang mã yêu cầu <mã lượt>:<vị trí> qua ie_compat_insert_keyed_v1',async()=>{
    await submit();
    const keys=io.rpc.mock.calls.filter(c=>c[0]==='ie_compat_insert_keyed_v1').map(c=>(c[1] as Row).p_request_key as string);
    expect(keys).toHaveLength(2);expect(keys[0]).toMatch(/^[0-9a-f-]{36}:0$/);expect(keys[1]).toBe(keys[0].replace(/:0$/,':1'));
    expect(io.rpc.mock.calls.some(c=>c[0]==='ie_compat_insert_v2')).toBe(false);
  });
  it('đợt 10a: phiếu con mất phản hồi: tra đúng phiếu con theo mã yêu cầu ⇒ báo mã phiếu con còn hiệu lực, không gửi lại (trước: chặn tới hộp cảnh báo)',async()=>{
    io.fail.ie_compat_insert_keyed_v1='lost';
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(financialPending.read(scope)).not.toBeNull();expect(activeChildren()).toHaveLength(1);
    const error=await submit().then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain('PC-v1');
    expect(io.rpc.mock.calls.filter(c=>c[0]==='ie_compat_insert_keyed_v1')).toHaveLength(1);
    expect(activeChildren()).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('đợt 10a: phiếu con không tới máy chủ, đợt đã dọn, không còn phiếu nào hiệu lực ⇒ dưới 2 phút chờ; quá 2 phút lập lại thành lượt mới, một bộ phiếu',async()=>{
    io.fail.ie_compat_insert_keyed_v1='drop';
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(batches()).toHaveLength(0);expect(activeChildren()).toHaveLength(0);
    await expect(submit()).rejects.toBeInstanceOf(FinancialPendingError);
    advance(PENDING_SETTLE_MS);
    const result=await submit();
    expect(result.voucherIds).toHaveLength(2);expect(batches()).toHaveLength(1);expect(activeChildren()).toHaveLength(2);
    expect(financialPending.read(scope)).toBeNull();
  });
  it('đợt 10a: phiếu con đã huỷ lại khi dọn ⇒ lần sau tra thấy đã huỷ, coi là chưa ghi; lượt mới KHÔNG nhận lại phiếu đã huỷ',async()=>{
    const original=io.rpc.getMockImplementation() as (n:string,a:Record<string,unknown>)=>Promise<unknown>;
    io.rpc.mockImplementationOnce(async(name:string,args:Record<string,unknown>)=>{
      // Phiếu con đầu ghi xong bình thường (qua máy chủ giả), phiếu con thứ hai không tới máy chủ.
      const result=await original(name,args);io.fail.ie_compat_insert_keyed_v1='drop';return result;
    });
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    expect((io.tables.income_expenses??[]).map(v=>v.approval_status)).toEqual(['CANCELLED']);
    advance(PENDING_SETTLE_MS);
    const result=await submit();
    expect(result.voucherIds).toEqual(['v2','v3']);expect(activeChildren()).toHaveLength(2);
  });
  it('đợt 10a: phiếu con tìm thấy theo mã mà không đọc được trạng thái ⇒ chưa kết luận, không gửi lại',async()=>{
    io.fail.ie_compat_insert_keyed_v1='lost';
    await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
    io.tables.income_expenses=[];advance(PENDING_SETTLE_MS*5);
    const calls=io.rpc.mock.calls.filter(c=>c[0]==='ie_compat_insert_keyed_v1').length;
    await expect(submit()).rejects.toBeInstanceOf(FinancialPendingError);
    expect(io.rpc.mock.calls.filter(c=>c[0]==='ie_compat_insert_keyed_v1')).toHaveLength(calls);
  });
  it('đợt 10a (review N2): phiếu con thu cọc không tới / không thấy theo mã ⇒ chưa kết luận (tra cọc chỉ thấy phiếu đọc được), không lập lượt mới',async()=>{
    const depositInput={...input,type:'INCOME',items:[{...item,income_expense_type_id:'tcoc',room_id:'r1'},{...item,building_id:'b2'}]};
    const submitIncome=()=>(renderHook(()=>useCreateIncomeExpenseBatch()).result.current as unknown as {mutationFn:(i:unknown)=>Promise<unknown>}).mutationFn(depositInput);
    io.fail.create_deposit_income_v1='drop';
    await expect(submitIncome()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(batches()).toHaveLength(0);
    expect(financialPending.read({...scope,businessKey:'INCOME'})?.meta).toMatchObject({depositAt:'0',children:2});
    advance(PENDING_SETTLE_MS*5);
    await expect(submitIncome()).rejects.toBeInstanceOf(FinancialPendingError);
    expect(batches()).toHaveLength(0);
    expect(io.rpc.mock.calls.filter(c=>c[0]==='create_deposit_income_v1')).toHaveLength(1);
  });
  it('đợt 10a (review lượt 2): phiếu con thu cọc CHƯA TỪNG GỬI (phiếu thường trước nó rớt trước khi tới máy chủ) ⇒ chưa ghi; quá 2 phút lập lại một bộ',async()=>{
    const mixed={...input,type:'INCOME',items:[{...item,building_id:'b2'},{...item,income_expense_type_id:'tcoc',room_id:'r1'}]};
    const submitMixed=()=>(renderHook(()=>useCreateIncomeExpenseBatch()).result.current as unknown as {mutationFn:(i:unknown)=>Promise<{voucherIds:string[]}>}).mutationFn(mixed);
    io.fail.ie_compat_insert_keyed_v1='drop';
    await expect(submitMixed()).rejects.toBeInstanceOf(VoucherPartialError);
    expect(io.rpc.mock.calls.filter(c=>c[0]==='create_deposit_income_v1')).toHaveLength(0);
    advance(PENDING_SETTLE_MS);
    const result=await submitMixed();
    expect(result.voucherIds).toHaveLength(2);expect(batches()).toHaveLength(1);
    expect(io.rpc.mock.calls.filter(c=>c[0]==='create_deposit_income_v1')).toHaveLength(1);
  });
  it('dấu của bản trước đợt 10a (không số phiếu con): đợt đã dọn mà phiếu con chưa biết mã ⇒ giữ dấu, không gửi lại',async()=>{
    const batchId='00000000-0000-4000-8000-0000000000bb';
    localStorage.setItem('ihome:financial-pending:v1:voucher-batch-create:u1:o1:EXPENSE',JSON.stringify({...scope,attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:batchId,completedIds:[batchId],startedAt:new Date(T0-30_000).toISOString(),operation:'tạo phiếu tổng',meta:{batchId:'request-key'}}));
    advance(PENDING_SETTLE_MS*5);
    await expect(submit()).rejects.toBeInstanceOf(FinancialPendingError);
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it('dọn sau lỗi hỏng, đợt còn trên máy chủ: báo mã đợt, không gửi lại',async()=>{
    io.rpc.mockImplementationOnce(async()=>({data:{id:'v-dau'},error:null}));
    (io.tables.income_expenses??=[]).push({id:'v-dau',code:'PC-dau',approval_status:'UNAPPROVED',deleted_at:null});
    io.fail.ie_compat_insert_keyed_v1='reject';io.fail['income_expense_batches.delete']='reject';
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
  io.fail.ie_compat_insert_keyed_v1='reject';io.fail.ie_compat_cancel_v2='drop';
  await expect(submit()).rejects.toBeInstanceOf(VoucherPartialError);
  expect(batches()).toHaveLength(0);expect(activeChildren()).toHaveLength(1);
  // Đợt 10a: phép đối chiếu có đọc theo mã yêu cầu (get_own_*), nên chỉ đếm lệnh GHI.
  const writes=()=>io.rpc.mock.calls.filter(c=>!String(c[0]).startsWith('get_own_')).length;
  const calls=writes();
  await expect(submit()).rejects.toThrow(/PC-dau/);
  expect(writes()).toBe(calls);expect(financialPending.read(scope)).toBeNull();
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
