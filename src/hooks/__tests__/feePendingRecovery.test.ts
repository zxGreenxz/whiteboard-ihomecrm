// @vitest-environment jsdom
// Đợt 3 (plan sửa khoá vĩnh viễn sau rớt mạng): đóng phí kỳ, trả phiếu nháp, huỷ phiếu phí, đóng và huỷ
// điện nước, sinh phí đặc biệt, đề nghị đối soát. Mỗi nơi ba kịch bản: lệnh không tới máy chủ; tới nhưng mất
// phản hồi; dấu cũ gieo sẵn (dạng trước 24/11/2026, không có tên thao tác). Máy chủ giả làm đúng phần luật
// chống trùng của thân hàm production (đọc 24/11/2026): khoá slot rồi đếm phiếu, khoá dòng rồi xét trạng thái.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn(),tables:{} as Record<string,Record<string,unknown>[]>,failRead:null as unknown}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:io.rpc,from:(table:string)=>{
  const filters:((row:Record<string,unknown>)=>boolean)[]=[];let limit=Infinity;
  const run=async(mode:'many'|'maybe'|'one')=>{
    if(io.failRead)return {data:null,error:io.failRead};
    const rows=(io.tables[table]??[]).filter(row=>filters.every(f=>f(row))).slice(0,limit);
    if(mode==='many')return {data:rows,error:null};
    if(mode==='one'&&rows.length!==1)return {data:null,error:{code:'PGRST116',message:'0 rows'}};
    return {data:rows[0]??null,error:null};
  };
  const b:Record<string,unknown>={
    select:()=>b,order:()=>b,
    eq:(c:string,v:unknown)=>{filters.push(r=>r[c]===v);return b;},
    is:(c:string,v:unknown)=>{filters.push(r=>(r[c]??null)===v);return b;},
    in:(c:string,v:unknown[])=>{filters.push(r=>v.includes(r[c]));return b;},
    gte:(c:string,v:string)=>{filters.push(r=>String(r[c])>=v);return b;},
    limit:(n:number)=>{limit=n;return b;},
    maybeSingle:()=>run('maybe'),single:()=>run('one'),
    then:(ok:(v:unknown)=>unknown,ko?:(e:unknown)=>unknown)=>run('many').then(ok,ko),
  };
  return b;
}}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
import {usePayPeriodFee,usePayDraftFeeVoucher,useCancelPeriodFee} from '../usePeriodFees';
import {usePayUtilityBill,useCancelUtilityBill} from '../useUtilityBills';
import {useGenerateSpecialFees} from '../useSpecialFeeBatch';
import {useProposeReconciliation} from '../useReconciliations';
import {FinancialPendingError,PENDING_SETTLE_MS,financialPending} from '@/lib/financialPending';
import {FinancialAlreadyRecordedError} from '@/lib/financialWorkflowError';

type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
const call=(hook:()=>unknown,input:unknown)=>(hook() as Mutation).mutationFn(input);
const lost=()=>new TypeError('Failed to fetch');
const T0=Date.parse('2026-11-24T02:00:00.000Z');
let clock=T0;
const advance=(ms:number)=>{clock+=ms;vi.setSystemTime(clock);};
let seq=0;
const newId=(prefix:string)=>`${prefix}-${++seq}`;
const vouchers=()=>io.tables.income_expenses??(io.tables.income_expenses=[]);
// Kịch bản của lần gọi kế tiếp: 'drop' = lệnh không tới máy chủ; 'lost' = máy chủ ghi xong nhưng phản hồi mất.
let next:'ok'|'drop'|'lost'='ok';
async function server<T>(write:()=>T):Promise<{data:T|null;error:unknown}>{
  const mode=next;next='ok';
  if(mode==='drop')throw lost();
  try{const data=write();if(mode==='lost')throw lost();return {data,error:null};}
  catch(error){if(error instanceof TypeError)throw error;return {data:null,error};}
}
/** Dấu dạng trước 24/11/2026: không tên thao tác, không ghi chú; khoá lưu giữ nguyên. */
function seedOldMark(namespace:string,businessKey:string,extra:{completedIds?:string[];requestKey?:string}={}){
  const scope={namespace,userId:'u1',organizationId:'o1',businessKey};
  const row={...scope,attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:extra.requestKey??'00000000-0000-4000-8000-0000000000bb',completedIds:extra.completedIds??[],startedAt:new Date(T0-60_000).toISOString()};
  localStorage.setItem('ihome:financial-pending:v1:'+[namespace,'u1','o1',businessKey].map(encodeURIComponent).join(':'),JSON.stringify(row));
  return scope;
}

beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});clock=T0;vi.setSystemTime(clock);
  localStorage.clear();vi.clearAllMocks();io.tables={};io.failRead=null;next='ok';seq=0;
  io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    switch(name){
      // pay_period_fee: khoá tư vấn theo slot rồi đếm phiếu chưa huỷ của slot. Không ép ⇒ trả cảnh báo, không ghi.
      case 'pay_period_fee':return server(()=>{
        const slot=`${args.p_building_id}:${args.p_category_key}:${args.p_period_start}`;
        const existing=vouchers().filter(v=>v.slot===slot&&!v.deleted_at);
        if(existing.length&&!args.p_force)return {warning:'duplicate',existing_count:existing.length,existing_amount:1,can_force:true};
        const id=newId('pf');vouchers().push({id,slot,code:'PC-'+id,approval_status:'APPROVED',posting_status:'POSTED',deleted_at:null});
        return {voucher_id:id,code:'PC-'+id};
      });
      // pay_draft_fee_voucher: khoá dòng, đòi UNAPPROVED, gắn sổ rồi duyệt.
      case 'pay_draft_fee_voucher':return server(()=>{
        const row=vouchers().find(v=>v.id===args.p_voucher_id);
        if(!row)throw {code:'P0002',message:'Không tìm thấy phiếu'};
        if(row.approval_status!=='UNAPPROVED')throw {code:'P0001',message:`Phiếu không ở trạng thái nháp (hiện: ${row.approval_status})`};
        Object.assign(row,{approval_status:'APPROVED',posting_status:'POSTED',account_id:args.p_account_id});row.payCount=Number(row.payCount??0)+1;
        return {ok:true,voucher_id:row.id,code:row.code};
      });
      // cancel_period_fee / cancel_utility_bill: khoá dòng; đã huỷ ⇒ lỗi P0001 "đã bị hủy trước đó".
      case 'cancel_period_fee':case 'cancel_utility_bill':return server(()=>{
        const row=vouchers().find(v=>v.id===args.p_voucher_id);
        if(!row)throw {code:'P0002',message:'Không tìm thấy phiếu'};
        if(row.deleted_at)throw {code:'P0001',message:'Phiếu đã bị hủy trước đó'};
        row.deleted_at='2026-11-24T02:00:00Z';row.cancelCount=Number(row.cancelCount??0)+1;
        return {ok:true,voucher_id:row.id};
      });
      // pay_utility_bill: khoá theo công tơ × tháng; đã có phiếu ⇒ 55000 [UTILITY_BILL_DUPLICATE].
      case 'pay_utility_bill':return server(()=>{
        const slot=`${args.p_utility_account_id}:${args.p_period_month}`;
        const existing=vouchers().find(v=>v.slot===slot&&!v.deleted_at);
        if(existing)throw {code:'55000',message:`[UTILITY_BILL_DUPLICATE] Kỳ của công tơ này ĐÃ CÓ phiếu chi ${existing.code}. Không tạo phiếu thứ hai.`};
        const id=newId('ub');vouchers().push({id,slot,code:'PC-'+id,approval_status:'APPROVED',posting_status:'POSTED',deleted_at:null});
        return {voucher_id:id,code:'PC-'+id};
      });
      // generate_special_fees_v1: khoá theo kỳ, chỉ sinh ô chưa có phiếu.
      case 'generate_special_fees_v1':return server(()=>{
        const ids:string[]=[];
        for(const building of args.p_building_ids as string[]){
          const slot=`${building}:${args.p_period}`;
          if(vouchers().some(v=>v.slot===slot))continue;
          const id=newId('sf');vouchers().push({id,slot,code:'PC-'+id,approval_status:'UNAPPROVED',deleted_at:null});ids.push(id);
        }
        return {period:args.p_period,created:ids.length,posted:0,totalAmount:ids.length*100,voucherIds:ids,note:''};
      });
      // propose_reconciliation: chèn một dòng mỗi lần gọi (không có khoá chống trùng).
      case 'propose_reconciliation':return server(()=>{
        const rows=io.tables.cashbook_reconciliations??(io.tables.cashbook_reconciliations=[]);
        const id=newId('rc');rows.push({id,account_id:args.p_account_id,as_of_date:args.p_as_of,proposed_by:'u1',status:'CONFIRMED',created_at:new Date(clock).toISOString()});
        return {id,status:'CONFIRMED',system_balance:0,diff:0};
      });
      default:throw new Error('rpc lạ '+name);
    }
  });
});
afterEach(()=>{vi.useRealTimers();});

const feeArgs={buildingId:'b1',categoryKey:'internet',periodStart:'2026-11',periodEnd:'2026-11',amount:100};
const feeScope={namespace:'period-fee-pay',userId:'u1',organizationId:'o1',businessKey:'b1:internet:2026-11:2026-11'};
describe('đóng phí kỳ (cách A: chạy lại không ép)',()=>{
  it('lệnh không tới máy chủ: bấm lại gửi ngay, không ép, ra đúng một phiếu',async()=>{
    next='drop';await expect(call(usePayPeriodFee,feeArgs)).rejects.toThrow();
    expect(financialPending.read(feeScope)).not.toBeNull();
    await expect(call(usePayPeriodFee,feeArgs)).resolves.toMatchObject({id:'pf-1'});
    expect(vouchers()).toHaveLength(1);expect(io.rpc).toHaveBeenCalledTimes(2);
    expect(io.rpc.mock.calls[1][1]).toMatchObject({p_force:false});
    expect(financialPending.read(feeScope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại thấy "kỳ đã có phiếu" ⇒ báo đã ghi ở lần trước, không mở hộp đóng thêm',async()=>{
    next='lost';await expect(call(usePayPeriodFee,feeArgs)).rejects.toThrow();
    const error=await call(usePayPeriodFee,feeArgs).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toMatch(/lần gửi trước/);
    expect(vouchers()).toHaveLength(1);expect(financialPending.read(feeScope)).toBeNull();
  });
  it('"Đóng thêm" mất phản hồi: bấm "Đóng thêm" lần nữa KHÔNG gửi ép, không ra phiếu thứ ba',async()=>{
    vouchers().push({id:'pf-cu',slot:'b1:internet:2026-11',code:'PC-cu',deleted_at:null});
    next='lost';await expect(call(usePayPeriodFee,{...feeArgs,force:true})).rejects.toThrow();
    expect(vouchers()).toHaveLength(2);
    await expect(call(usePayPeriodFee,{...feeArgs,force:true})).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(io.rpc.mock.calls[1][1]).toMatchObject({p_force:false});
    expect(vouchers()).toHaveLength(2);
    // Dấu đã gỡ: lần bấm sau là lượt mới, đi lại đúng đường cảnh báo "đóng thêm" như bình thường.
    await expect(call(usePayPeriodFee,feeArgs)).resolves.toMatchObject({warning:'duplicate'});
  });
  it('dấu cũ gieo sẵn chưa có mã phiếu: gửi lại không ép; dấu cũ có mã phiếu: báo đã ghi, không gửi',async()=>{
    seedOldMark('period-fee-pay',feeScope.businessKey);
    await expect(call(usePayPeriodFee,feeArgs)).resolves.toMatchObject({id:'pf-1'});
    expect(vouchers()).toHaveLength(1);
    seedOldMark('period-fee-pay',feeScope.businessKey,{completedIds:['pf-1']});io.rpc.mockClear();
    await expect(call(usePayPeriodFee,feeArgs)).rejects.toThrow(/pf-1/);
    expect(io.rpc).not.toHaveBeenCalled();expect(financialPending.read(feeScope)).toBeNull();
  });
});

const draftArgs={voucherId:'d1',accountId:'a1'};
const draftScope={namespace:'draft-fee-pay',userId:'u1',organizationId:'o1',businessKey:'d1'};
describe('trả phiếu nháp (cách C: đọc trạng thái phiếu)',()=>{
  beforeEach(()=>{vouchers().push({id:'d1',code:'PC-d1',approval_status:'UNAPPROVED',posting_status:'UNPOSTED',account_id:null,deleted_at:null});});
  it('lệnh không tới máy chủ: phiếu còn nháp ⇒ gửi lại ngay, trả một lần',async()=>{
    next='drop';await expect(call(usePayDraftFeeVoucher,draftArgs)).rejects.toThrow();
    await expect(call(usePayDraftFeeVoucher,draftArgs)).resolves.toMatchObject({id:'d1',approval_status:'APPROVED'});
    expect(vouchers()[0].payCount).toBe(1);expect(financialPending.read(draftScope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: phiếu đã duyệt đúng sổ ⇒ trả kết quả, không gửi lần hai',async()=>{
    next='lost';await expect(call(usePayDraftFeeVoucher,draftArgs)).rejects.toThrow();
    await expect(call(usePayDraftFeeVoucher,draftArgs)).resolves.toMatchObject({id:'d1',code:'PC-d1',approval_status:'APPROVED',posting_status:'POSTED'});
    expect(io.rpc).toHaveBeenCalledTimes(1);expect(vouchers()[0].payCount).toBe(1);expect(financialPending.read(draftScope)).toBeNull();
  });
  it('dấu cũ gieo sẵn, phiếu đã duyệt vào sổ khác ⇒ báo đã duyệt ở lần trước, không gửi',async()=>{
    Object.assign(vouchers()[0],{approval_status:'APPROVED',posting_status:'POSTED',account_id:'a-khac'});
    seedOldMark('draft-fee-pay','d1');
    await expect(call(usePayDraftFeeVoucher,draftArgs)).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
    expect(io.rpc).not.toHaveBeenCalled();expect(financialPending.read(draftScope)).toBeNull();
  });
  it('đọc trạng thái hỏng ⇒ giữ dấu, không gửi',async()=>{
    next='drop';await expect(call(usePayDraftFeeVoucher,draftArgs)).rejects.toThrow();
    io.failRead={code:'500',message:'Failed to fetch'};
    await expect(call(usePayDraftFeeVoucher,draftArgs)).rejects.toBeInstanceOf(FinancialPendingError);
    expect(io.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(draftScope)).not.toBeNull();
  });
});

describe.each([
  ['huỷ phiếu phí',()=>useCancelPeriodFee(),'period-fee-cancel'],
  ['huỷ phiếu điện nước',()=>useCancelUtilityBill('2026-11'),'utility-cancel'],
])('%s (cách A: chạy lại; "đã huỷ trước đó" là xong)',(_label,hook,namespace)=>{
  const scope={namespace,userId:'u1',organizationId:'o1',businessKey:'c1'};
  beforeEach(()=>{vouchers().push({id:'c1',code:'PC-c1',deleted_at:null});});
  it('lệnh không tới máy chủ: bấm lại huỷ ngay',async()=>{
    next='drop';await expect(call(hook,'c1')).rejects.toThrow();
    await expect(call(hook,'c1')).resolves.toBeUndefined();
    expect(vouchers()[0].cancelCount).toBe(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại nhận "đã huỷ trước đó" ⇒ xong, gỡ dấu',async()=>{
    next='lost';await expect(call(hook,'c1')).rejects.toThrow();
    await expect(call(hook,'c1')).resolves.toBeUndefined();
    expect(vouchers()[0].cancelCount).toBe(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('dấu cũ gieo sẵn: chạy lại, không khoá',async()=>{
    seedOldMark(namespace,'c1');
    await expect(call(hook,'c1')).resolves.toBeUndefined();
    expect(vouchers()[0].cancelCount).toBe(1);expect(financialPending.read(scope)).toBeNull();
  });
  it('lần đầu (không có dấu) vẫn báo lỗi "đã huỷ trước đó" như cũ',async()=>{
    vouchers()[0].deleted_at='x';
    await expect(call(hook,'c1')).rejects.toMatchObject({message:'Phiếu đã bị hủy trước đó'});
  });
});

const utilArgs={buildingId:'b1',type:'electric',billingMonth:'2026-11',amount:100,code:'PE1',holder:'A',utilityAccountId:'m1'};
const utilScope={namespace:'utility-pay',userId:'u1',organizationId:'o1',businessKey:'b1:electric:m1:2026-11'};
describe('đóng điện nước (cách A: máy chủ báo trùng nghĩa là đã có phiếu)',()=>{
  it('lệnh không tới máy chủ: bấm lại gửi ngay, một phiếu',async()=>{
    next='drop';await expect(call(usePayUtilityBill,utilArgs)).rejects.toThrow();
    await expect(call(usePayUtilityBill,utilArgs)).resolves.toMatchObject({id:'ub-1'});
    expect(vouchers()).toHaveLength(1);expect(financialPending.read(utilScope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại nhận "ĐÃ CÓ phiếu chi" có mã, gỡ dấu, không phiếu thứ hai',async()=>{
    next='lost';await expect(call(usePayUtilityBill,utilArgs)).rejects.toThrow();
    await expect(call(usePayUtilityBill,utilArgs)).rejects.toMatchObject({message:expect.stringContaining('ĐÃ CÓ phiếu chi PC-ub-1')});
    expect(vouchers()).toHaveLength(1);expect(financialPending.read(utilScope)).toBeNull();
  });
  it('dấu cũ gieo sẵn có mã phiếu ⇒ báo đã ghi, không gửi; chưa có mã ⇒ gửi lại',async()=>{
    seedOldMark('utility-pay',utilScope.businessKey,{completedIds:['ub-cu']});
    await expect(call(usePayUtilityBill,utilArgs)).rejects.toThrow(/ub-cu/);expect(io.rpc).not.toHaveBeenCalled();
    seedOldMark('utility-pay',utilScope.businessKey);
    await expect(call(usePayUtilityBill,utilArgs)).resolves.toMatchObject({id:'ub-1'});
  });
});

const genArgs={period:'2026-11',buildingIds:['b2','b1']};
const genScope={namespace:'special-fee-generate',userId:'u1',organizationId:'o1',businessKey:'2026-11:b1:b2'};
describe('sinh phí đặc biệt (cách A: máy chủ chỉ sinh ô còn thiếu)',()=>{
  it('lệnh không tới máy chủ: bấm lại sinh đủ, một lần mỗi ô',async()=>{
    next='drop';await expect(call(useGenerateSpecialFees,genArgs)).rejects.toThrow();
    await expect(call(useGenerateSpecialFees,genArgs)).resolves.toMatchObject({created:2});
    expect(vouchers()).toHaveLength(2);expect(financialPending.read(genScope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại không sinh thêm ⇒ báo đã chạy ở lần trước',async()=>{
    next='lost';await expect(call(useGenerateSpecialFees,genArgs)).rejects.toThrow();
    const error=await call(useGenerateSpecialFees,genArgs).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect((error as Error).message).toMatch(/lần gửi trước/);
    expect(vouchers()).toHaveLength(2);expect(financialPending.read(genScope)).toBeNull();
  });
  it('dấu cũ gieo sẵn: chạy lại, máy chủ chỉ sinh ô còn thiếu',async()=>{
    vouchers().push({id:'sf-cu',slot:'b1:2026-11',code:'PC-cu',deleted_at:null});
    seedOldMark('special-fee-generate',genScope.businessKey);
    await expect(call(useGenerateSpecialFees,genArgs)).resolves.toMatchObject({created:1});
    expect(vouchers()).toHaveLength(2);
  });
});

const reconArgs={accountId:'a1',asOf:'2026-11-24',countedBalance:0};
const reconScope={namespace:'reconciliation-propose',userId:'u1',organizationId:'o1',businessKey:'a1:2026-11-24'};
describe('đề nghị đối soát (cách D: tra theo sổ, ngày, người đề nghị, sau giờ kẹt)',()=>{
  it('lệnh không tới máy chủ: dưới 2 phút chờ, quá 2 phút không thấy thì gửi lại, một đề nghị',async()=>{
    next='drop';await expect(call(useProposeReconciliation,reconArgs)).rejects.toThrow();
    await expect(call(useProposeReconciliation,reconArgs)).rejects.toThrow(/đang chờ kết quả/);
    expect(io.rpc).toHaveBeenCalledTimes(1);
    advance(PENDING_SETTLE_MS+1);
    await expect(call(useProposeReconciliation,reconArgs)).resolves.toMatchObject({id:'rc-1'});
    expect(io.tables.cashbook_reconciliations).toHaveLength(1);expect(financialPending.read(reconScope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại thấy đề nghị vừa tạo ⇒ báo mã, không tạo thêm',async()=>{
    next='lost';await expect(call(useProposeReconciliation,reconArgs)).rejects.toThrow();
    await expect(call(useProposeReconciliation,reconArgs)).rejects.toThrow(/rc-1/);
    expect(io.tables.cashbook_reconciliations).toHaveLength(1);expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(financialPending.read(reconScope)).toBeNull();
  });
  it('dấu cũ gieo sẵn, không có đề nghị nào sau giờ kẹt ⇒ gửi lại',async()=>{
    seedOldMark('reconciliation-propose',reconScope.businessKey);advance(PENDING_SETTLE_MS);
    await expect(call(useProposeReconciliation,reconArgs)).resolves.toMatchObject({id:'rc-1'});
  });
  it('đề nghị của người khác hoặc của ngày khác không bị nhận nhầm là lần gửi trước',async()=>{
    io.tables.cashbook_reconciliations=[
      {id:'rc-khac-nguoi',account_id:'a1',as_of_date:'2026-11-24',proposed_by:'u2',created_at:new Date(T0).toISOString()},
      {id:'rc-khac-ngay',account_id:'a1',as_of_date:'2026-11-23',proposed_by:'u1',created_at:new Date(T0).toISOString()},
    ];
    seedOldMark('reconciliation-propose',reconScope.businessKey);advance(PENDING_SETTLE_MS);
    await expect(call(useProposeReconciliation,reconArgs)).resolves.toMatchObject({id:'rc-1'});
  });
});
