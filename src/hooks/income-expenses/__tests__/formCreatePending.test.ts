// @vitest-environment jsdom
// Đợt 3: form lập phiếu Thu/Chi. Đường chính create_income_expense_v1 chống trùng theo khoá (claim
// canonical_write_operations, so băm nội dung, chờ lệnh cũ còn chạy — production 24/11/2026). Đợt 10a: đường compat đi
// ie_compat_insert_keyed_v1 với CÙNG khoá (và p_row.id = mã yêu cầu): cùng nội dung trả lại phiếu cũ, khác nội dung 23505,
// đường chính đã ghi xong cùng khoá thì 23505 kèm mã phiếu; get_own_income_expense_requests_v1 tra phiếu compat theo khoá. Máy chủ
// giả dưới đây làm đúng các luật đó. Dấu trước đợt 3 không có mã nên chỉ tra gần đúng (lối ra một lần).
import {renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn(),user:{id:'u1',user_metadata:{full_name:'Tâm'}} as unknown,hideRead:false,nearMatchReads:0}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>io.user}));
vi.mock('../accountingClass',()=>({loadIncomeExpenseAccountingClassResolver:async()=>()=>'PNL'}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn(),warning:vi.fn()}}));
type Voucher={id:string;code:string;user_id:string;type:string;building_id:string;room_id:string|null;created_at:string;deleted_at:null};
// drop: lệnh gọi kế tiếp tới hàm đó không tới máy chủ; lost: máy chủ ghi xong nhưng phản hồi mất.
const db=vi.hoisted(()=>({vouchers:[] as Voucher[],claims:new Map<string,{hash:string;id:string}>(),compatClaims:new Map<string,{hash:string;id:string}>(),drop:null as string|null,lost:null as string|null,routeOff:false,lookupBlind:false,seq:0}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:io.rpc,from:()=>{
  const filters:((v:Voucher)=>boolean)[]=[];let sort:{col:keyof Voucher;asc:boolean}|null=null;let take=Infinity;
  const rows=()=>{if(io.hideRead)return [];const found=db.vouchers.filter(v=>filters.every(f=>f(v)));if(sort){const {col,asc}=sort;found.sort((a,b2)=>String(a[col]).localeCompare(String(b2[col]))*(asc?1:-1));}return found.slice(0,take);};
  const b:Record<string,unknown>={select:()=>b,order:(col:keyof Voucher,o?:{ascending?:boolean})=>{sort={col,asc:o?.ascending!==false};return b;},limit:(n:number)=>{take=n;return b;},
    eq:(c:keyof Voucher,v:unknown)=>{filters.push(r=>r[c]===v);return b;},
    is:(c:keyof Voucher,v:unknown)=>{filters.push(r=>(r[c]??null)===v);return b;},
    // Chỉ phép tra gần đúng (phiếu tạo sau giờ kẹt) dùng gte: đếm để biết dấu có khoá không còn tra gần đúng.
    gte:(c:keyof Voucher,v:string)=>{io.nearMatchReads++;filters.push(r=>String(r[c])>=v);return b;},
    maybeSingle:async()=>({data:rows()[0]??null,error:null}),
    then:(ok:(v:unknown)=>unknown)=>Promise.resolve({data:rows(),error:null}).then(ok)};
  return b;
}}}));
import {createVoucherFromForm,pendingCreateElsewhere,voucherFormCreateKey} from '../formCreatePending';
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
  localStorage.clear();vi.clearAllMocks();Object.assign(db,{vouchers:[],claims:new Map(),compatClaims:new Map(),drop:null,lost:null,routeOff:false,lookupBlind:false,seq:0});io.hideRead=false;io.nearMatchReads=0;
  io.user={id:'u1',user_metadata:{full_name:'Tâm'}};
  io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    const mode=db.drop===name?'drop':db.lost===name?'lost':'ok';
    if(mode==='drop')db.drop=null;if(mode==='lost')db.lost=null;
    if(mode==='drop')throw new TypeError('Failed to fetch');
    let result:{data:unknown;error:unknown};
    if(name==='create_income_expense_v1'){
      // Như thân production: kiểm hạng mục (chỉ-hệ-thống 0A000, hạn chế 42501) TRƯỚC bước giữ mã, rồi mới tra mã.
      const {p_idempotency_key:key,...payload}=args;const hash=JSON.stringify(payload);const claim=db.claims.get(String(key));
      const restricted=(args.p_items as {income_expense_type_id?:string}[]).some(item=>item.income_expense_type_id==='t-han-che');
      const overLimit=(args.p_items as {unit_price?:number}[]).some(item=>Number(item.unit_price)>9_999_999);
      if(db.routeOff)result={data:null,error:{code:'0A000',message:'Hạng mục chỉ được sinh từ hệ thống'}};
      else if(restricted)result={data:null,error:{code:'42501',message:'Không có quyền tạo hạng mục thu/chi hạn chế'}};
      else if(overLimit)result={data:null,error:{code:'P0001',message:'Thành tiền hạng mục 1 vượt giới hạn'}};
      else if(claim)result=claim.hash===hash?{data:db.vouchers.find(v=>v.id===claim.id),error:null}:{data:null,error:{code:'23505',message:'idempotency_key đã được dùng với payload khác'}};
      else{const v=newVoucher('v'+(++db.seq),{type:args.p_type,building_id:args.p_building_id,room_id:args.p_room_id});db.vouchers.push(v);db.claims.set(String(key),{hash,id:v.id});result={data:v,error:null};}
    }else if(name==='ie_compat_insert_v2'||name==='ie_compat_insert_keyed_v1'){
      const row=args.p_row as Record<string,unknown>;const id=typeof row.id==='string'?row.id:'v'+(++db.seq);
      const key=name==='ie_compat_insert_keyed_v1'?String(args.p_request_key):null;
      const hash=JSON.stringify({row:args.p_row,items:args.p_items});const own=key?db.compatClaims.get(key):undefined;const main=key?db.claims.get(key):undefined;
      // Thứ tự của ie_compat_insert_keyed_v1: claim của chính nó (trả lại / 23505) → claim đường chính đã xong (23505) → ghi.
      if(own)result=own.hash===hash?{data:{id:own.id,approval_status:'UNAPPROVED',replayed:true},error:null}
        :{data:null,error:{code:'23505',message:'Mã yêu cầu đã dùng với nội dung khác',details:own.id,hint:'ie_request_key_payload_mismatch'}};
      else if(main)result={data:null,error:{code:'23505',message:'Mã yêu cầu đã được dùng ở đường ghi chính',details:main.id,hint:'ie_request_key_used_by_canonical'}};
      else if(db.vouchers.some(v=>v.id===id))result={data:null,error:{code:'23505',message:'duplicate key value violates unique constraint "income_expenses_pkey"'}};
      else{db.vouchers.push(newVoucher(id,row));if(key)db.compatClaims.set(key,{hash,id});result={data:{id,approval_status:'UNAPPROVED'},error:null};}
    }else if(name==='get_own_income_expense_requests_v1'){
      // Phiếu đã ghi xong theo mã ở cả hai đường (lookupBlind: giả lần tra chạy trước khi lệnh đường chính kịp commit).
      const wanted=args.p_request_keys as string[];
      result={data:db.lookupBlind?[]:wanted.flatMap(k=>[
        ...(db.compatClaims.has(k)?[{voucher_id:db.compatClaims.get(k)!.id,write_path:'compat',request_key:k}]:[]),
        ...(db.claims.has(k)?[{voucher_id:db.claims.get(k)!.id,write_path:'canonical',request_key:k}]:[]),
      ]),error:null};
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

describe('đợt 10a: đường compat có khoá (ie_compat_insert_keyed_v1, cách B)',()=>{
  const K='ie_compat_insert_keyed_v1';
  it('phiếu lặp đi hàm có khoá: khoá = khoá của đường chính, mã phiếu = mã yêu cầu; không gọi ie_compat_insert_v2',async()=>{
    await submit(form(repeat));
    const [args]=rpcCalls(K);const id=(args.p_row as {id?:string}).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);expect(args.p_request_key).toBe(`ie-create-${id}`);
    expect(rpcCalls('ie_compat_insert_v2')).toHaveLength(0);
  });
  it('phiếu lặp, lệnh không tới máy chủ: gửi lại ngay cùng khoá và cùng mã phiếu, một phiếu',async()=>{
    db.drop=K;await expect(submit(form(repeat))).rejects.toThrow();
    await expect(submit(form(repeat))).resolves.toMatchObject({id:expect.any(String)});
    const calls=rpcCalls(K);
    expect(calls).toHaveLength(2);expect(calls[1].p_request_key).toBe(calls[0].p_request_key);
    expect((calls[1].p_row as {id?:string}).id).toBe((calls[0].p_row as {id?:string}).id);
    expect(db.vouchers).toHaveLength(1);
  });
  it('phiếu lặp, tới nhưng mất phản hồi: tra phiếu theo khoá ⇒ báo mã phiếu, không gửi lần hai',async()=>{
    db.lost=K;await expect(submit(form(repeat))).rejects.toThrow();
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain(db.vouchers[0].code);
    expect(rpcCalls(K)).toHaveLength(1);expect(rpcCalls('get_own_income_expense_requests_v1')).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('đường chính rơi sang compat (0A000), mất phản hồi: tra theo khoá, không phiếu thứ hai',async()=>{
    db.routeOff=true;db.lost=K;
    await expect(submit(form())).rejects.toThrow();
    expect(db.vouchers).toHaveLength(1);
    await expect(submit(form())).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(db.vouchers).toHaveLength(1);expect(rpcCalls(K)).toHaveLength(1);
  });
  it('mất phản hồi mà người dùng không đọc được phiếu (quyền đọc): tra theo khoá vẫn thấy ⇒ báo đã lập, không gửi lại',async()=>{
    db.lost=K;await expect(submit(form(repeat))).rejects.toThrow();
    io.hideRead=true;
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain(db.vouchers[0].id);
    expect(rpcCalls(K)).toHaveLength(1);expect(db.vouchers).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('dấu của bản trước đợt 10a (compat không khoá, đã ghi, không đọc được phiếu): gửi lại cùng khoá ⇒ khoá chính trả 23505 ⇒ báo đã lập',async()=>{
    const R='00000000-0000-4000-8000-0000000000cc';
    localStorage.setItem('ihome:financial-pending:v1:voucher-form-create:u1:o1:EXPENSE%3Ab1%3A',JSON.stringify({...scope,attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:R,completedIds:[],startedAt:new Date(T0-30_000).toISOString(),operation:'lập phiếu thu/chi',meta:{dedupe:'request-key-v1',canonical:false,items:'t1',deposit:false}}));
    db.vouchers.push(newVoucher(R,{type:'EXPENSE',building_id:'b1',room_id:null}));io.hideRead=true;
    await expect(submit(form(repeat))).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(rpcCalls(K)).toHaveLength(1);expect(db.vouchers).toHaveLength(1);expect(financialPending.read(scope)).toBeNull();
  });
});

describe('đợt 10a: đổi đường giữa hai lần gửi — tra phiếu theo khoá ở cả hai đường, không tra gần đúng',()=>{
  it('lần trước đi đường chính và mất phản hồi, lần này là phiếu lặp: tra theo khoá thấy phiếu đường chính ⇒ báo đúng mã phiếu ngay, không lập qua compat',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).not.toMatch(/Có thể/);
    expect((error as Error).message).toContain('PC-v1');
    expect(rpcCalls('ie_compat_insert_keyed_v1')).toHaveLength(0);
    expect(db.vouchers).toHaveLength(1);expect(io.nearMatchReads).toBe(0);expect(financialPending.read(scope)).toBeNull();
  });
  it('hàng rào thứ hai: lần tra không kịp thấy phiếu đường chính ⇒ chờ 2 phút rồi compat cùng khoá; máy chủ thấy khoá đường chính đã ghi ⇒ báo đã lập, không phiếu thứ hai',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    db.lookupBlind=true;
    await expect(submit(form(repeat))).rejects.toBeInstanceOf(FinancialPendingError);
    advance(PENDING_SETTLE_MS);
    const error=await submit(form(repeat)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain('v1');
    expect(rpcCalls('ie_compat_insert_keyed_v1')[0].p_request_key).toBe(rpcCalls('create_income_expense_v1')[0].p_idempotency_key);
    expect(db.vouchers).toHaveLength(1);expect(io.nearMatchReads).toBe(0);
  });
  it('lần trước không tới máy chủ, lần này đổi đường: không gửi ngay, chỉ gửi lại sau 2 phút, một phiếu',async()=>{
    db.drop='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    await expect(submit(form(repeat))).rejects.toBeInstanceOf(FinancialPendingError);
    expect(rpcCalls('ie_compat_insert_keyed_v1')).toHaveLength(0);
    advance(PENDING_SETTLE_MS);
    await expect(submit(form(repeat))).resolves.toMatchObject({id:expect.any(String)});expect(db.vouchers).toHaveLength(1);
  });
  it('lần trước đi compat và mất phản hồi, lần này đường chính: tra theo khoá thấy phiếu compat ⇒ báo mã, không gửi đường chính',async()=>{
    db.lost='ie_compat_insert_keyed_v1';await expect(submit(form(repeat))).rejects.toThrow();
    io.hideRead=true;
    await expect(submit(form())).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(rpcCalls('create_income_expense_v1')).toHaveLength(0);expect(db.vouchers).toHaveLength(1);
  });
});

describe('review lượt 1: đổi phạm vi hoặc hạng mục sau một lần chưa rõ kết quả',()=>{
  it('đổi phòng/toà/loại khi dấu cũ còn ⇒ có câu chặn; đúng phạm vi cũ hoặc dấu đã gỡ ⇒ không chặn',async()=>{
    db.drop='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const ctx={userId:'u1',organizationId:'o1'};const stuck=voucherFormCreateKey(form());
    expect(pendingCreateElsewhere(ctx,stuck,form({room_id:'r2'}))).toMatch(/đã đổi/);
    expect(pendingCreateElsewhere(ctx,stuck,form({type:'INCOME'}))).toMatch(/đã đổi/);
    expect(pendingCreateElsewhere(ctx,stuck,form())).toBeNull();
    await submit(form());expect(financialPending.read(scope)).toBeNull();
    expect(pendingCreateElsewhere(ctx,stuck,form({room_id:'r2'}))).toBeNull();
  });
  it('đợt 10a: đổi hạng mục giữa hai lần: tra theo khoá thấy phiếu đường chính ⇒ báo đã lập ngay, không gửi lần hai',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const changed=form({items:[{...form().items[0],income_expense_type_id:'t2'}]});
    const error=await submit(changed).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain('PC-v1');
    expect(rpcCalls('create_income_expense_v1')).toHaveLength(1);expect(db.vouchers).toHaveLength(1);expect(io.nearMatchReads).toBe(0);
  });
  it('đợt 10a (review N1): đổi sang hạng mục mà đường chính từ chối TRƯỚC bước giữ mã ⇒ vẫn báo đã lập (tra theo khoá), không gỡ dấu rồi lập phiếu thứ hai',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const restricted=form({items:[{...form().items[0],income_expense_type_id:'t-han-che'}]});
    advance(PENDING_SETTLE_MS);
    const error=await submit(restricted).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(rpcCalls('create_income_expense_v1')).toHaveLength(1);expect(db.vouchers).toHaveLength(1);
  });
  it('đợt 10a (review lượt 2): đã thấy phiếu đường chính, cùng hạng mục nhưng số tiền mới bị từ chối TRƯỚC bước giữ mã ⇒ báo đã lập kèm mã, không gỡ dấu rồi lập phiếu thứ hai',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const tooBig=form({items:[{...form().items[0],unit_price:99_999_999}]});
    const error=await submit(tooBig).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as FinancialAlreadyRecordedError).recordIds).toEqual(['v1']);
    expect(db.vouchers).toHaveLength(1);
    // Dấu đã gỡ vì đã biết phiếu: lần lưu kế tiếp là việc mới của người dùng sau khi xem phiếu v1.
    expect(financialPending.read(scope)).toBeNull();
  });
  it('đợt 10a: cùng đường, cùng hạng mục, tra theo khoá thấy phiếu đường chính ⇒ gửi lại cùng khoá để máy chủ trả lại đúng phiếu cũ',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    await expect(submit(form())).resolves.toMatchObject({id:'v1'});
    const keys=rpcCalls('create_income_expense_v1').map(a=>a.p_idempotency_key);
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(db.vouchers).toHaveLength(1);
  });
  it('đợt 10a: hạng mục mới làm đường chính rơi sang compat, lần tra không kịp thấy: compat cùng khoá thấy đường chính đã ghi ⇒ không phiếu thứ hai',async()=>{
    db.lost='create_income_expense_v1';await expect(submit(form())).rejects.toThrow();
    const changed=form({items:[{...form().items[0],income_expense_type_id:'t2'}]});
    advance(PENDING_SETTLE_MS);db.lookupBlind=true;db.routeOff=true;
    const error=await submit(changed).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toContain('v1');
    expect(db.vouchers).toHaveLength(1);
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
  it('review lượt 2: nhiều phiếu giống nhau trong cửa sổ ⇒ báo các phiếu MỚI nhất (phiếu của lần kẹt không bị đẩy ra ngoài)',async()=>{
    seed(T0-30_000);
    for(let i=1;i<=6;i++)db.vouchers.push({...newVoucher('v-'+i,{type:'EXPENSE',building_id:'b1',room_id:null}),created_at:new Date(T0-50*60_000+i*60_000).toISOString()});
    const error=await submit(form()).then(()=>null,(e:unknown)=>e);
    expect((error as Error).message).toContain('PC-v-6');expect((error as Error).message).not.toContain('PC-v-1');
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
