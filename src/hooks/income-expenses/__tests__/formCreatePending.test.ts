// @vitest-environment jsdom
// Đợt 3: form lập phiếu Thu/Chi. Đường chính create_income_expense_v1 chống trùng theo khoá (claim
// canonical_write_operations, so băm nội dung, chờ lệnh cũ còn chạy — production 24/11/2026). Đường compat
// ie_compat_insert_v2 nhận p_row.id do trình duyệt sinh: gửi lại cùng mã thì khoá chính chặn phiếu thứ hai, và
// phép đối chiếu tra đúng phiếu theo mã đó. Dấu cũ (trước bản này) không có mã nên chỉ tra gần đúng.
import {renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn(),user:{id:'u1',user_metadata:{full_name:'Tâm'}} as unknown,hideRead:false}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>io.user}));
vi.mock('../accountingClass',()=>({loadIncomeExpenseAccountingClassResolver:async()=>()=>'PNL'}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn(),warning:vi.fn()}}));
type Voucher={id:string;code:string;user_id:string;type:string;building_id:string;room_id:string|null;created_at:string;deleted_at:null};
// drop: lệnh gọi kế tiếp tới hàm đó không tới máy chủ; lost: máy chủ ghi xong nhưng phản hồi mất.
const db=vi.hoisted(()=>({vouchers:[] as Voucher[],claims:new Map<string,{hash:string;id:string}>(),drop:null as string|null,lost:null as string|null,routeOff:false,seq:0}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:io.rpc,from:()=>{
  const filters:((v:Voucher)=>boolean)[]=[];
  const rows=()=>io.hideRead?[]:db.vouchers.filter(v=>filters.every(f=>f(v)));
  const b:Record<string,unknown>={select:()=>b,order:()=>b,limit:()=>b,
    eq:(c:keyof Voucher,v:unknown)=>{filters.push(r=>r[c]===v);return b;},
    is:(c:keyof Voucher,v:unknown)=>{filters.push(r=>(r[c]??null)===v);return b;},
    gte:(c:keyof Voucher,v:string)=>{filters.push(r=>String(r[c])>=v);return b;},
    maybeSingle:async()=>({data:rows()[0]??null,error:null}),
    then:(ok:(v:unknown)=>unknown)=>Promise.resolve({data:rows(),error:null}).then(ok)};
  return b;
}}}));
import {createVoucherFromForm} from '../formCreatePending';
import {useCreateIncomeExpense} from '../mutations';
import type {CreateIncomeExpenseInput} from '../types';
import {FinancialPendingError,PENDING_SETTLE_MS,financialPending} from '@/lib/financialPending';
import {FinancialAlreadyRecordedError} from '@/lib/financialWorkflowError';

const T0=Date.parse('2026-11-24T02:00:00.000Z');let clock=T0;
const advance=(ms:number)=>{clock+=ms;vi.setSystemTime(clock);};
const scope={namespace:'voucher-form-create',userId:'u1',organizationId:'o1',businessKey:'EXPENSE:b1:'};
const form=(over:Partial<CreateIncomeExpenseInput>={}):CreateIncomeExpenseInput=>({
  type:'EXPENSE',name:'Mua bóng đèn',building_id:'b1',account_id:'a1',voucher_date:'2026-11-24',business_result_accounting:null,attachments:[],
  items:[{income_expense_type_id:'t1',quantity:1,unit_price:120_000,start_date:'2026-11-01',end_date:'2026-11-30'}],...over,
});
const repeat={repeat_cycle:'MONTH' as const,repeat_count:2};
const create=(input:CreateIncomeExpenseInput)=>(renderHook(()=>useCreateIncomeExpense()).result.current as unknown as {mutationFn:(i:CreateIncomeExpenseInput)=>Promise<{id?:string}>}).mutationFn(input);
const submit=(data:CreateIncomeExpenseInput)=>createVoucherFromForm(data,{userId:'u1',organizationId:'o1',create});
const rpcCalls=(name:string)=>io.rpc.mock.calls.filter(c=>c[0]===name).map(c=>c[1] as Record<string,unknown>);
const newVoucher=(id:string,args:{type?:unknown;building_id?:unknown;room_id?:unknown}):Voucher=>({id,code:'PC-'+id,user_id:'u1',type:String(args.type),building_id:String(args.building_id),room_id:(args.room_id as string|null)??null,created_at:new Date(clock).toISOString(),deleted_at:null});

beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});clock=T0;vi.setSystemTime(clock);
  localStorage.clear();vi.clearAllMocks();Object.assign(db,{vouchers:[],claims:new Map(),drop:null,lost:null,routeOff:false,seq:0});io.hideRead=false;
  io.user={id:'u1',user_metadata:{full_name:'Tâm'}};
  io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    const mode=db.drop===name?'drop':db.lost===name?'lost':'ok';
    if(mode==='drop')db.drop=null;if(mode==='lost')db.lost=null;
    if(mode==='drop')throw new TypeError('Failed to fetch');
    let result:{data:unknown;error:unknown};
    if(name==='create_income_expense_v1'){
      const {p_idempotency_key:key,...payload}=args;const hash=JSON.stringify(payload);const claim=db.claims.get(String(key));
      if(claim)result=claim.hash===hash?{data:db.vouchers.find(v=>v.id===claim.id),error:null}:{data:null,error:{code:'23505',message:'idempotency_key đã được dùng với payload khác'}};
      else if(db.routeOff)result={data:null,error:{code:'0A000',message:'Hạng mục chỉ được sinh từ hệ thống'}};
      else{const v=newVoucher('v'+(++db.seq),{type:args.p_type,building_id:args.p_building_id,room_id:args.p_room_id});db.vouchers.push(v);db.claims.set(String(key),{hash,id:v.id});result={data:v,error:null};}
    }else if(name==='ie_compat_insert_v2'){
      const row=args.p_row as Record<string,unknown>;const id=typeof row.id==='string'?row.id:'v'+(++db.seq);
      if(db.vouchers.some(v=>v.id===id))result={data:null,error:{code:'23505',message:'duplicate key value violates unique constraint "income_expenses_pkey"'}};
      else{db.vouchers.push(newVoucher(id,row));result={data:{id,approval_status:'UNAPPROVED'},error:null};}
    }else throw new Error('rpc lạ '+name);
    if(mode==='lost')throw new TypeError('Failed to fetch');
    return result;
  });
});
afterEach(()=>{vi.useRealTimers();});

describe('đường chính create_income_expense_v1 (cách B)',()=>{
  it('lệnh không tới máy chủ: bấm lại gửi ngay cùng mã, một phiếu',async()=>{
    db.drop='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    expect(financialPending.read(scope)?.operation).toBe('lập phiếu thu/chi');
    await expect(submit(form())).resolves.toMatchObject({id:'v1'});
    const keys=rpcCalls('create_income_expense_v1').map(a=>a.p_idempotency_key);
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(db.vouchers).toHaveLength(1);
    expect(financialPending.read(scope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận lại đúng phiếu cũ',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    await expect(submit(form())).resolves.toMatchObject({id:'v1'});
    expect(db.vouchers).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('tới nhưng mất phản hồi, người dùng sửa nội dung rồi lưu: máy chủ báo mã đã dùng ⇒ báo đã lập ở lần trước, không lập thêm',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const error=await submit(form({name:'Mua bóng đèn LED'})).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toMatch(/lần gửi trước/i);
    expect(db.vouchers).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('lần gửi đầu vẫn sinh mã mới mỗi lần (không dấu ⇒ không dùng lại mã)',async()=>{
    await submit(form());await submit(form());
    const keys=rpcCalls('create_income_expense_v1').map(a=>a.p_idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);expect(db.vouchers).toHaveLength(2);
  });
});

describe('đường compat ie_compat_insert_v2 (cách D: mã phiếu do trình duyệt sinh)',()=>{
  it('phiếu lặp, lệnh không tới máy chủ: gửi lại cùng mã phiếu, một phiếu',async()=>{
    db.drop='ie_compat_insert_v2';await expect(submit(form(repeat))).rejects.toThrow();
    await expect(submit(form(repeat))).resolves.toMatchObject({id:expect.any(String)});
    const ids=rpcCalls('ie_compat_insert_v2').map(a=>(a.p_row as {id?:string}).id);
    expect(ids).toHaveLength(2);expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);expect(ids[1]).toBe(ids[0]);
    expect(db.vouchers).toHaveLength(1);expect(db.vouchers[0].id).toBe(ids[0]);
  });
  it('phiếu lặp, tới nhưng mất phản hồi: tra đúng phiếu theo mã ⇒ báo mã phiếu, không gửi lần hai',async()=>{
    db.lost='ie_compat_insert_v2';await expect(submit(form(repeat))).rejects.toThrow();
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain(db.vouchers[0].code);
    expect(rpcCalls('ie_compat_insert_v2')).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('đường chính rơi sang compat (0A000), mất phản hồi: tra đúng phiếu theo mã, không phiếu thứ hai',async()=>{
    db.routeOff=true;db.lost='ie_compat_insert_v2';
    await expect(submit(form())).rejects.toThrow();
    expect(db.vouchers).toHaveLength(1);
    await expect(submit(form())).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(db.vouchers).toHaveLength(1);expect(rpcCalls('ie_compat_insert_v2')).toHaveLength(1);
  });
  it('phép tra không thấy (quyền đọc) nhưng máy chủ đã có phiếu: khoá chính trả 23505 ⇒ báo có thể đã lập, không lập thêm',async()=>{
    db.lost='ie_compat_insert_v2';await expect(submit(form(repeat))).rejects.toThrow();
    io.hideRead=true;
    await expect(submit(form(repeat))).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(db.vouchers).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
});

describe('đổi đường giữa hai lần gửi (máy chủ không chống trùng chéo đường)',()=>{
  it('lần trước đi đường chính và mất phản hồi, lần này là phiếu lặp: tra gần đúng thấy phiếu ⇒ báo có thể đã lập, không lập qua compat',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toMatch(/Có thể/);
    expect(rpcCalls('ie_compat_insert_v2')).toHaveLength(0);expect(db.vouchers).toHaveLength(1);
  });
  it('lần trước không tới máy chủ, lần này đổi đường: không gửi ngay, chỉ gửi lại sau 2 phút',async()=>{
    db.drop='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    await expect(submit(form(repeat))).rejects.toBeInstanceOf(FinancialPendingError);
    expect(rpcCalls('ie_compat_insert_v2')).toHaveLength(0);
    advance(PENDING_SETTLE_MS);
    await expect(submit(form(repeat))).resolves.toMatchObject({id:expect.any(String)});expect(db.vouchers).toHaveLength(1);
  });
});

describe('dấu cũ gieo sẵn (trước bản này: không mã gửi lại, không tên thao tác)',()=>{
  const seed=(startedAt:number)=>localStorage.setItem('ihome:financial-pending:v1:voucher-form-create:u1:o1:EXPENSE%3Ab1%3A',JSON.stringify({...scope,attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:'00000000-0000-4000-8000-0000000000bb',completedIds:[],startedAt:new Date(startedAt).toISOString()}));
  it('có phiếu của mình cùng loại, toà, phòng sau giờ kẹt ⇒ báo "có thể đã lập" kèm mã, không gửi',async()=>{
    seed(T0-30_000);db.vouchers.push(newVoucher('v-cu',{type:'EXPENSE',building_id:'b1',room_id:null}));
    const error=await submit(form()).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toMatch(/Có thể.*PC-v-cu/);
    expect(io.rpc).not.toHaveBeenCalled();expect(financialPending.read(scope)).toBeNull();
  });
  it('không thấy phiếu nào: dưới 2 phút chờ; quá 2 phút gửi lại, một phiếu',async()=>{
    seed(T0-30_000);
    await expect(submit(form())).rejects.toBeInstanceOf(FinancialPendingError);expect(io.rpc).not.toHaveBeenCalled();
    advance(PENDING_SETTLE_MS);
    await expect(submit(form())).resolves.toMatchObject({id:'v1'});expect(db.vouchers).toHaveLength(1);
  });
  it('phiếu của người khác, hoặc tạo trước giờ kẹt quá lâu, không bị nhận nhầm',async()=>{
    seed(T0);advance(PENDING_SETTLE_MS);
    db.vouchers.push({...newVoucher('v-nguoi-khac',{type:'EXPENSE',building_id:'b1',room_id:null}),user_id:'u2'});
    db.vouchers.push({...newVoucher('v-hom-qua',{type:'EXPENSE',building_id:'b1',room_id:null}),created_at:new Date(T0-24*3600_000).toISOString()});
    await expect(submit(form())).resolves.toMatchObject({id:'v1'});
  });
});

it('phiên hết hạn: báo lỗi trước khi ghi dấu, không để lại dấu, không gọi máy chủ',async()=>{
  io.user=null;
  await expect(submit(form())).rejects.toMatchObject({code:'PGRST301'});
  expect(financialPending.read(scope)).toBeNull();expect(io.rpc).not.toHaveBeenCalled();
});
