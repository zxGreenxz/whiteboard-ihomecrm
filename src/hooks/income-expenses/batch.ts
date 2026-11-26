import {findOwnVoucherRequests,findOwnDepositIncome,recordDepositIncome} from '@/lib/depositIncomeRpc';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,isConfirmedFinancialRejection,workflowErrorMessage,type FinancialWorkflowProgress} from '@/lib/financialWorkflow';
import {financialReadRows} from '@/lib/financialReadValidation';
import {runFinancialPending} from '@/lib/financialPendingAction';
import {formatPendingTime,priorAttemptSettled,type FinancialPendingRecord,type PendingReconciliation} from '@/lib/financialPending';
import { VoucherPartialError, voucherFailureMessage, voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { batchChildVoucherName, type IncomeExpenseBatchFormValues } from "@/lib/incomeExpenseValidation";
import type { ImportIncomeExpenseRow } from "./types";
import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { reviseIncomeExpense, VOUCHER_QUERY_KEYS } from "./revisions";
import { revisionErrorMessage } from "@/lib/incomeExpenseRevision";

// Compat gateway V2 (Stage-7b drain): RPC chưa có trong generated types cho tới
// lần regen sau forward-apply — gọi qua cast (mẫu financeV2Mutations.ts).
// Server ép birth UNAPPROVED/PENDING (import/batch hết default-APPROVED — §8).
type CompatRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};
const compatRpc = (
  fn: string,
  args?: Record<string, unknown>,
): PromiseLike<CompatRpcResult> =>
  (supabase.rpc as unknown as (
    f: string,
    a?: Record<string, unknown>,
  ) => PromiseLike<CompatRpcResult>)(fn, args);

/**
 * Huỷ một danh sách phiếu lẫn lộn THU/CHI, mỗi loại đi ĐÚNG cửa của nó.
 *
 * ie_compat_cancel_v2 từ chối phiếu ĐÃ GHI SỔ ("dùng reversal, không hủy trực
 * tiếp"). Từ Đợt B, phiếu THU tự ghi sổ ngay khi tạo ⇒ mọi đợt có phiếu thu sẽ
 * hỏng nếu vẫn đẩy tất cả vào compat. Phiếu THU đi cửa riêng
 * cancel_income_voucher_v1 (tự đảo bút toán, tự mở lại nợ hoá đơn); phiếu CHI
 * giữ nguyên đường cũ.
 *
 * Trả về số phiếu đã huỷ + danh sách lỗi theo từng phiếu để caller báo cho
 * đúng, thay vì hỏng cả mẻ chỉ vì một phiếu.
 */
async function cancelVouchersSplitByType(
  vouchers: { id: string; type?: string | null }[], reason: string,
  recordCompleted?:(ids:string[])=>void,
): Promise<{ cancelled: number; failures: { id: string; message: string; outcomeUnknown:boolean }[]; completedIds: string[] }> {
  const incomes = vouchers.filter(v => v.type === "INCOME");
  const others = vouchers.filter(v => v.type !== "INCOME");
  const failures: {id:string;message:string;outcomeUnknown:boolean}[] = [];
  const completedIds: string[] = [];
  let cancelled = 0;
  if (others.length) {
    try {
      const {data,error} = await compatRpc("ie_compat_cancel_v2", {p_ids:others.map(v=>v.id),p_reason:reason});
      if (error) throw error;
      const count = (data as {cancelled?:unknown} | null)?.cancelled;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > others.length) throw new TypeError("Missing cancellation receipt");
      if(recordCompleted && count!==others.length){
        const {data:rows,error:readError}=await supabase.from('income_expenses').select('id,approval_status').in('id',others.map(v=>v.id));
        if(readError || !Array.isArray(rows) || others.some(v=>!rows.some(row=>row.id===v.id&&row.approval_status==='CANCELLED')))throw new TypeError('Chưa xác nhận được từng phiếu chi trong đợt đã huỷ.');
      }
      cancelled += count; completedIds.push(...others.map(v=>v.id));
      recordCompleted?.(others.map(v=>v.id));
    } catch(error) {
      failures.push(...others.map(v=>({id:v.id,message:voucherFailureMessage(error,"huỷ phiếu"),outcomeUnknown:!isConfirmedFinancialRejection(error)})));
    }
  }
  for (const v of incomes) {
    try {
      const {data,error} = await compatRpc("cancel_income_voucher_v1", {p_voucher:v.id,p_reason:reason});
      if (error) throw error;
      const receipt = data as {id?:unknown;changed?:unknown} | null;
      if ((recordCompleted&&receipt?.id!==v.id) || typeof receipt?.changed !== "boolean") throw new TypeError("Missing cancellation receipt");
      if (receipt.changed) cancelled++;
      completedIds.push(v.id);
      recordCompleted?.([v.id]);
    } catch(error) { failures.push({id:v.id,message:voucherFailureMessage(error,"huỷ phiếu thu"),outcomeUnknown:!isConfirmedFinancialRejection(error)}); }
  }
  return {cancelled,failures,completedIds};
}

interface ExcelImportResult {
  successCount:number;createdVouchers:Array<{row:number;id:string;code:string|null}>;failedCount:number;errors:Array<{row:number;message:string}>;
  /**
   * Đợt 9: kết quả ĐỐI CHIẾU lượt nhập trước còn chưa rõ (giờ gửi của lượt đó). Tệp vừa chọn CHƯA được nhập. Ở kết quả này
   * `row` là số dòng Excel (không phải vị trí trong lượt vừa bấm).
   */
  reconciledFrom?:string;
  /** Dòng của lượt trước tra gần đúng thấy phiếu giống: chỉ báo «có thể đã ghi», không gửi lại. */
  possiblyWritten?:Array<{row:number;codes:string[]}>;
}
class ExcelImportUnconfirmed extends TypeError {
  constructor(readonly result:ExcelImportResult){super('Một số dòng Excel chưa được đối chiếu với máy chủ.');}
}
// Ảnh chụp lượt nhập của người nhập × công ty: khoá này phủ lượt chưa rõ kết quả; các dòng giống hệt nhau đã ghi xong vẫn
// là các phiếu độc lập hợp lệ (mỗi dòng một mã yêu cầu riêng).
const excelSnapshotKey=(userId:string,organizationId:string)=>`ihome:excel-import-pending:v1:${userId}:${organizationId}`;

// ── Đợt 9: đối chiếu lượt nhập Excel chưa rõ kết quả (cách D) ──────────────────────────────────────────────────────────
// Thân hàm production đã đọc (26/11/2026, chỉ đọc):
//   - ie_compat_insert_v2 (md5 e77ca61f): không có mã yêu cầu, nhưng nhận `p_row.id` cho người gọi thường và chèn phiếu +
//     dòng + nhật ký trong MỘT lời gọi. Mỗi dòng thường mang mã phiếu do trình duyệt sinh, ghi vào ảnh chụp TRƯỚC khi gửi:
//     tra đúng phiếu theo mã đó; khoá chính chặn phiếu thứ hai nếu cùng mã bị gửi lại.
//   - create_deposit_income_v1 → app_private.write_deposit_income_v1 (a276671a / 18a2d3e7): khoá phòng + công ty TRƯỚC khi
//     claim mã yêu cầu (deposit_income_requests), claim và phiếu cùng giao dịch; get_own_deposit_income_v1 (9e07b513) tra
//     đúng phiếu theo mã yêu cầu (`<mã lượt>:<dòng Excel>`).
//   - RLS đọc income_expenses: thấy phiếu khi có phạm vi toà (accessible_building_ids) hoặc là quản trị; phiếu nhập Excel
//     không gắn sổ nên quyền theo sổ không giúp. Người nhập chọn toà trong danh sách toà mình thấy.
// Ảnh chụp bản trước không có mã phiếu dự kiến: dòng chưa rõ chỉ tra gần đúng (người tạo, loại, toà, khoản mục, ngày, số
// tiền, tạo sau giờ kẹt, trừ phiếu đã biết) và chỉ được báo «có thể đã ghi», không gửi lại.
// Đợt 10a: dòng thường đi ie_compat_insert_keyed_v1 với mã yêu cầu `<mã lượt>:<dòng Excel>` (cùng dạng dòng thu cọc), ảnh
// chụp đánh dấu `keyed`. Dòng thường của ảnh chụp đó mà không đọc thấy phiếu theo mã phiếu thì tra đúng theo mã yêu cầu
// (get_own_income_expense_requests_v1: phiếu của chính người nhập, không cần quyền đọc phiếu); không thấy nữa là chưa ghi.
// Dòng thu cọc vẫn tra qua get_own_deposit_income_v1 — hàm đó chỉ thấy phiếu người nhập đọc được (như bản trước). Không tra
// gần đúng cho ảnh chụp có `keyed`.
interface ExcelSnapshotRow {sourceRow:number;type:string;buildingId:string;itemTypeId?:string;voucherDate:string;amount:number;deposit?:boolean;voucherId?:string}
interface ExcelSnapshot {attemptId:string;keyed?:boolean;rows:ExcelSnapshotRow[];createdVouchers:Array<{row:number;id:string;code:string|null}>;unconfirmedRows:number[];failedRows:number[]}
/** Lệch giờ trình duyệt ↔ máy chủ chấp nhận khi tra phiếu «tạo sau giờ kẹt». Rộng chỉ làm báo «có thể đã ghi» nhiều hơn. */
const EXCEL_CLOCK_SKEW_MS=60*60_000;
/** Số phiếu tối đa đọc một lần khi tra gần đúng; chạm trần thì dòng chưa thấy không được coi là chưa ghi. */
const EXCEL_LOOKUP_LIMIT=1000;
/**
 * Mỗi lệnh đọc `.in(...)` của phép đối chiếu mang tối đa chừng này giá trị: PostgREST đọc qua GET, danh sách mã dài làm URL
 * vượt giới hạn và máy chủ trả lỗi (án lệ `useInvoiceCollectors.ts`) ⇒ lượt nhập lớn sẽ hỏng đối chiếu ở MỌI lần bấm.
 */
const EXCEL_IN_CHUNK=100;
const chunksOf=<T,>(items:readonly T[]):T[][]=>Array.from({length:Math.ceil(items.length/EXCEL_IN_CHUNK)},(_,part)=>items.slice(part*EXCEL_IN_CHUNK,(part+1)*EXCEL_IN_CHUNK));
const isRowNumber=(value:unknown):value is number=>Number.isInteger(value)&&(value as number)>0;

function readExcelSnapshot(key:string,attemptId:string):ExcelSnapshot|null{
  let parsed:unknown;
  try{const raw=localStorage.getItem(key);if(!raw)return null;parsed=JSON.parse(raw);}
  catch{/* Ảnh chụp không đọc được ⇒ coi như mất: đối chiếu theo khoảng giờ của dấu. */parsed=null;}
  const value=parsed as Partial<ExcelSnapshot>|null;
  if(!value||value.attemptId!==attemptId||!Array.isArray(value.rows)||!Array.isArray(value.createdVouchers)
    ||!Array.isArray(value.unconfirmedRows)||!Array.isArray(value.failedRows)||(value.keyed!==undefined&&typeof value.keyed!=='boolean'))return null;
  const rowsOk=value.rows.every(row=>row&&isRowNumber(row.sourceRow)&&typeof row.type==='string'&&typeof row.buildingId==='string'
    &&(row.itemTypeId===undefined||typeof row.itemTypeId==='string')&&typeof row.voucherDate==='string'&&Number.isFinite(row.amount)
    &&(row.voucherId===undefined||typeof row.voucherId==='string')&&(row.deposit===undefined||typeof row.deposit==='boolean'));
  const createdOk=value.createdVouchers.every(row=>row&&isRowNumber(row.row)&&row.row<=value.rows!.length&&typeof row.id==='string'&&!!row.id);
  if(!rowsOk||!createdOk||!value.unconfirmedRows.every(isRowNumber)||!value.failedRows.every(isRowNumber))return null;
  return value as ExcelSnapshot;
}

interface VoucherCandidate {id:string;code:string|null;type?:string;building_id?:string;voucher_date?:string;total_amount?:number|string;income_expense_items?:Array<{income_expense_type_id?:string}>|null}
const voucherRows=(data:unknown,what:string):VoucherCandidate[]=>{
  if(!Array.isArray(data))throw new TypeError(`Chưa đọc được ${what} để đối chiếu lượt nhập Excel.`);
  return data as VoucherCandidate[];
};

/** Không còn ảnh chụp đúng lượt: chỉ còn giờ của dấu. Phiếu của người nhập tạo quanh giờ đó ⇒ «có thể đã ghi». */
async function reconcileExcelWithoutSnapshot(pending:FinancialPendingRecord,settled:boolean):Promise<PendingReconciliation<ExcelImportResult>>{
  const since=new Date(Date.parse(pending.startedAt)-EXCEL_CLOCK_SKEW_MS).toISOString();
  const until=new Date(Date.parse(pending.activeAt??pending.startedAt)+EXCEL_CLOCK_SKEW_MS).toISOString();
  const {data,error}=await supabase.from('income_expenses').select('id, code, created_at')
    .eq('user_id',pending.userId).eq('organization_id',pending.organizationId).gte('created_at',since).lte('created_at',until)
    .order('created_at',{ascending:false}).limit(50);
  if(error)throw error;
  const found=voucherRows(data,'danh sách phiếu');
  const codes=[...new Set([...found.map(row=>row.code||row.id),...pending.completedIds.filter(id=>!found.some(row=>row.id===id))])];
  if(codes.length)return {outcome:'already-written',recordIds:codes,
    message:`Lượt nhập Excel lúc ${formatPendingTime(pending.startedAt)} chưa đối chiếu được từng dòng (trình duyệt không còn danh sách dòng của lượt đó). Có thể lượt đó đã tạo các phiếu: ${codes.join(', ')}. Kiểm tra danh sách thu chi trước khi nhập lại; chỉ nhập lại các dòng chưa có phiếu.`};
  return settled?{outcome:'not-written'}:null;
}

/**
 * Kết luận từng dòng của lượt nhập trước từ ảnh chụp đã lưu. Luôn kết luận được khi đọc được máy chủ: dòng chưa thấy chỉ
 * còn «mở» khi lượt đó chưa chắc đã kết thúc (dưới 2 phút); đọc hỏng thì ném lỗi (lõi giữ dấu, lần bấm sau đọc lại).
 *  - Không dòng nào đã ghi / có thể đã ghi ⇒ `not-written`: lõi gỡ dấu và nhập tệp vừa chọn.
 *  - Còn lại ⇒ `{result}`: màn kết quả từng dòng của lượt trước; tệp vừa chọn không được nhập (không tự nhập lại cả tệp).
 */
async function reconcileExcelImport(pending:FinancialPendingRecord,snapshotKey:string):Promise<PendingReconciliation<ExcelImportResult>>{
  const attemptKey=pending.requestKey??pending.attemptId;
  const settled=priorAttemptSettled(pending);
  const snapshot=readExcelSnapshot(snapshotKey,attemptKey);
  if(!snapshot)return reconcileExcelWithoutSnapshot(pending,settled);
  type Verdict={kind:'written';id:string;code:string|null}|{kind:'maybe';codes:string[]}|{kind:'rejected'}|{kind:'missing'};
  const verdicts=new Map<number,Verdict>();
  snapshot.createdVouchers.forEach(created=>verdicts.set(created.row-1,{kind:'written',id:created.id,code:created.code??null}));
  const unconfirmed=new Set(snapshot.unconfirmedRows);
  snapshot.rows.forEach((row,index)=>{
    if(!verdicts.has(index)&&snapshot.failedRows.includes(row.sourceRow)&&!unconfirmed.has(row.sourceRow))verdicts.set(index,{kind:'rejected'});
  });
  const open=snapshot.rows.map((row,index)=>({row,index})).filter(({index})=>!verdicts.has(index));
  // Dòng thu cọc: tra đúng theo mã yêu cầu. Ảnh chụp bản trước không ghi cờ thu cọc ⇒ dòng THU nào cũng tra thử.
  const depositFound=new Set<number>();
  for(const {row,index} of open){
    if(row.deposit===false||(row.deposit===undefined&&row.type!=='INCOME'))continue;
    const id=await findOwnDepositIncome(pending.organizationId,`${attemptKey}:${row.sourceRow}`);
    if(id){verdicts.set(index,{kind:'written',id,code:null});depositFound.add(index);}
  }
  // Dòng thường mang mã phiếu dự kiến: tra đúng theo mã; cùng lượt đọc mã chứng từ của phiếu đã biết mà chưa có mã chứng
  // từ. Chỉ đọc mã còn mở / mã cần số chứng từ, chia lô; một lô đọc hỏng ⇒ cả lần đối chiếu chưa kết luận (ném lỗi).
  const planned=open.filter(({row,index})=>!verdicts.has(index)&&row.voucherId).map(({row,index})=>({index,id:row.voucherId!}));
  if(planned.length||depositFound.size){
    const needCode=[...verdicts.values()].flatMap(verdict=>verdict.kind==='written'&&!verdict.code?[verdict.id]:[]);
    const found=new Map<string,string|null>();
    for(const part of chunksOf([...new Set([...planned.map(row=>row.id),...needCode])])){
      const {data,error}=await supabase.from('income_expenses').select('id, code').in('id',part);
      if(error)throw error;
      for(const row of voucherRows(data,'phiếu của lượt nhập'))found.set(row.id,row.code??null);
    }
    for(const [index,verdict] of verdicts)if(verdict.kind==='written'&&!verdict.code&&found.get(verdict.id))verdicts.set(index,{...verdict,code:found.get(verdict.id)!});
    for(const {index,id} of planned)if(found.has(id))verdicts.set(index,{kind:'written',id,code:found.get(id)??null});
  }
  // Đợt 10a: ảnh chụp có mã yêu cầu theo dòng ⇒ dòng thường chưa thấy theo mã phiếu thì tra đúng theo mã yêu cầu (phiếu
  // của chính người nhập, không qua quyền đọc phiếu). Không thấy nữa ⇒ chưa ghi (khi lượt đó chắc chắn đã kết thúc).
  if(snapshot.keyed){
    const keyedOpen=open.filter(({row,index})=>!verdicts.has(index)&&row.voucherId);
    if(keyedOpen.length){
      const byKey=await findOwnVoucherRequests(pending.organizationId,keyedOpen.map(({row})=>`${attemptKey}:${row.sourceRow}`));
      for(const {row,index} of keyedOpen){const id=byKey.get(`${attemptKey}:${row.sourceRow}`)?.id;if(id)verdicts.set(index,{kind:'written',id,code:null});}
    }
    for(const {index} of open)if(!verdicts.has(index)&&settled)verdicts.set(index,{kind:'missing'});
  }
  // Còn chưa thấy (ảnh chụp bản trước đợt 10a: mã dự kiến không có trên máy chủ, hoặc không có mã): tra gần đúng, trừ phiếu
  // đã biết. Ngày phiếu chia lô như trên; lô chạm trần số dòng thì dòng chưa thấy ở các ngày đó không được coi là chưa ghi.
  const rest=snapshot.keyed?[]:open.filter(({index})=>!verdicts.has(index));
  if(rest.length){
    const since=new Date(Date.parse(pending.startedAt)-EXCEL_CLOCK_SKEW_MS).toISOString();
    const candidates:VoucherCandidate[]=[];
    const saturated=new Set<string>();
    for(const part of chunksOf([...new Set(rest.map(({row})=>row.voucherDate))])){
      const {data,error}=await supabase.from('income_expenses')
        .select('id, code, type, building_id, voucher_date, total_amount, created_at, income_expense_items(income_expense_type_id)')
        .eq('user_id',pending.userId).eq('organization_id',pending.organizationId).gte('created_at',since)
        .in('voucher_date',part).order('created_at',{ascending:false}).limit(EXCEL_LOOKUP_LIMIT);
      if(error)throw error;
      const rows=voucherRows(data,'danh sách phiếu');
      if(rows.length>=EXCEL_LOOKUP_LIMIT)part.forEach(date=>saturated.add(date));
      candidates.push(...rows);
    }
    const known=new Set([...verdicts.values()].flatMap(verdict=>verdict.kind==='written'?[verdict.id]:[]));
    for(const {row,index} of rest){
      const matches=candidates.filter(item=>!known.has(item.id)&&item.type===row.type&&item.building_id===row.buildingId
        &&item.voucher_date===row.voucherDate&&Number(item.total_amount)===row.amount
        // Dòng hạng mục bị RLS che (hạng mục hạn chế) ⇒ không so được khoản mục: vẫn tính là ứng viên (nghiêng về an toàn).
        &&(!row.itemTypeId||!item.income_expense_items?.length||item.income_expense_items.some(line=>line.income_expense_type_id===row.itemTypeId)));
      if(matches.length)verdicts.set(index,{kind:'maybe',codes:matches.map(item=>item.code||item.id)});
      else if(saturated.has(row.voucherDate))verdicts.set(index,{kind:'maybe',codes:[]});
      else if(settled)verdicts.set(index,{kind:'missing'});
    }
  }
  // Còn dòng chưa thấy mà lượt trước chưa chắc đã kết thúc: chưa kết luận (lõi báo «đang chờ kết quả»).
  if(snapshot.rows.some((_,index)=>!verdicts.has(index)))return null;
  const all=snapshot.rows.map((row,index)=>({row,verdict:verdicts.get(index)!}));
  if(!all.some(({verdict})=>verdict.kind==='written'||verdict.kind==='maybe'))return {outcome:'not-written'};
  const written=all.flatMap(({row,verdict})=>verdict.kind==='written'?[{row:row.sourceRow,id:verdict.id,code:verdict.code}]:[]);
  const possiblyWritten=all.flatMap(({row,verdict})=>verdict.kind==='maybe'?[{row:row.sourceRow,codes:verdict.codes}]:[]);
  const errors=all.flatMap(({row,verdict})=>verdict.kind==='rejected'
    ?[{row:row.sourceRow,message:'Chưa ghi: dòng này bị từ chối ở lượt nhập trước. Sửa dòng rồi nhập lại.'}]
    :verdict.kind==='missing'?[{row:row.sourceRow,message:'Chưa ghi: không thấy phiếu của dòng này trên máy chủ. Nhập lại dòng này.'}]:[]);
  return {result:{successCount:written.length,createdVouchers:written,failedCount:errors.length+possiblyWritten.length,errors,possiblyWritten,
    reconciledFrom:formatPendingTime(pending.startedAt)}};
}

// Import phiếu thu/chi hàng loạt từ Excel
export const useImportIncomeExpenses = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-excel-import');

  return useMutation({
    mutationFn: async (
      rows: ImportIncomeExpenseRow[]
    ): Promise<ExcelImportResult> => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      if(rows.some(row=>!Number.isFinite(row.amount)||row.amount<=0))throw new Error('Nhập số tiền hợp lệ lớn hơn 0 ở từng dòng Excel.');
      const snapshotKey=excelSnapshotKey(user.id,selectedOrganizationId??'');
      // Đợt 9: phép đọc hạng mục đưa ra TRƯỚC khi ghi dấu: đọc hỏng thì chưa gửi gì, báo lỗi ngay, không để lại dấu.
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          rows.map((row) => row.income_expense_type_id),
        );
      // Mỗi dòng thường mang một mã phiếu do trình duyệt sinh (ie_compat_insert_v2 nhận `p_row.id`): lần đối chiếu tra đúng
      // phiếu theo mã. Hạng mục không đọc thấy ⇒ dòng đó bị từ chối rõ ở vòng ghi, không gửi.
      const plan=rows.map((row,index)=>{
        let accountingClass:ReturnType<typeof accountingClassFor>|null=null;
        try{accountingClass=accountingClassFor(row.income_expense_type_id);}
        catch{/* Hạng mục không có trong danh mục đọc được: vòng ghi từ chối rõ dòng này. */}
        const deposit=row.type==='INCOME'&&accountingClass==='DEPOSIT';
        return {sourceRow:row.source_row??index+1,accountingClass,deposit,voucherId:deposit?undefined:crypto.randomUUID()};
      });
      let reconciled=false;
      try { const imported=await workflow.run('excel-import','nhập phiếu từ Excel',async progress=>{
      let successCount = 0;
      const createdVouchers: Array<{ row: number; id: string; code: string | null }> = [];
      let failedCount = 0;
      const errors: Array<{ row: number; message: string }> = [];

      const unconfirmedRows:number[]=[];
      const failedRows:number[]=[];
      const snapshotRows:ExcelSnapshotRow[]=rows.map((row,index)=>({sourceRow:plan[index].sourceRow,type:row.type,buildingId:row.building_id,itemTypeId:row.income_expense_type_id,voucherDate:row.voucher_date,amount:row.amount,deposit:plan[index].deposit,...(plan[index].voucherId?{voucherId:plan[index].voucherId}:{})}));
      const writeSnapshot=()=>localStorage.setItem(snapshotKey,JSON.stringify({attemptId:progress.requestKey,keyed:true,rows:snapshotRows,createdVouchers,unconfirmedRows,failedRows}));
      // Ảnh chụp đầu (vị trí dòng thật, mã phiếu dự kiến; không tên người, không ghi chú) phải có TRƯỚC lệnh ghi đầu tiên.
      try { writeSnapshot(); }
      catch (storageError) { throw new FinancialWorkflowError('Trình duyệt chưa lưu được danh sách dòng của lượt nhập nên chưa gửi dòng nào. Kiểm tra quyền lưu dữ liệu của trình duyệt rồi nhập lại.','failure',[],storageError); }
      const saveSnapshot=()=>{ try { writeSnapshot(); } catch { /* Ảnh chụp đầu đã có mã phiếu dự kiến của mọi dòng: bản lưu hỏng giữa chừng thì phép đối chiếu tra thẳng theo mã đó. */ } };
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // organization_id do server suy (ie_compat_insert_v2 SECURITY DEFINER,
          // strip field client gửi) — không đọc buildings ở client vì RLS chỉ mở
          // cho ai có scope buildings.view, còn Thu/Chi cho phép all_buildings.
          // Phiếu + item trong MỘT call server-side (birth UNAPPROVED — §8).
          const accountingClass=plan[i].accountingClass;
          if(!accountingClass)throw new FinancialWorkflowError('Không tìm thấy hạng mục thu/chi của dòng này. Kiểm tra lại hạng mục rồi nhập lại dòng này.','failure',[]);
          const args = {
            p_row: {
              ...(plan[i].voucherId?{id:plan[i].voucherId}:{}),
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              voucher_date: row.voucher_date,
            },
            p_items: [
              {
                income_expense_type_id: row.income_expense_type_id,
                accounting_class: accountingClass,
                description: row.item_name,
                quantity: 1,
                unit_price: row.amount,
              },
            ],
          };
          const incomeDeposit=plan[i].deposit;
          if(incomeDeposit && !row.room_id)throw {code:'22023',message:'Chọn phòng cho dòng thu cọc trước khi nhập.'};
          // Mã yêu cầu của dòng = `<mã lượt>:<dòng Excel>` cho cả hai đường (đợt 10a: dòng thường đi ie_compat_insert_keyed_v1).
          const rowKey=progress.requestKey+':'+snapshotRows[i].sourceRow;
          const {data:created,error:compatError}=incomeDeposit ?
            {data:await recordDepositIncome(selectedOrganizationId!,rowKey,{
              type:row.type,name:row.name,building_id:row.building_id,room_id:row.room_id,
              payer_name:row.payer_name??null,voucher_date:row.voucher_date,batch_child:true,
            },args.p_items,{channel:'finance'}),error:null}:await compatRpc('ie_compat_insert_keyed_v1',{...args,p_request_key:rowKey});
          if (compatError) throw compatError;

          const receipt = created as {id?: string; code?: string} | null;
          if (typeof receipt?.id!=="string"||!receipt.id) throw new TypeError("Chưa xác nhận kết quả: Failed to fetch receipt");
          createdVouchers.push({ row: i + 1, id: receipt.id, code: receipt.code ?? null });
          progress.completed.push({id:receipt.id,label:`Đã tạo phiếu ${receipt.code??receipt.id} từ dòng ${snapshotRows[i].sourceRow}`});
          successCount++;
          saveSnapshot();
        } catch (err: any) {
          failedCount++;
          failedRows.push(snapshotRows[i].sourceRow);
          errors.push({ row: i + 1, message: voucherFailureMessage(err, "nhập phiếu") });
          if(!isConfirmedFinancialRejection(err))unconfirmedRows.push(snapshotRows[i].sourceRow);
          saveSnapshot();
        }
      }

      const result={successCount,failedCount,errors,createdVouchers};
      // Còn dòng chưa rõ, hoặc đã có phiếu mà còn dòng lỗi: giữ dấu để lần bấm sau trả lại kết quả từng dòng của lượt này
      // (hàm đối chiếu bên dưới luôn kết luận được), không nhập lại cả tệp.
      if(unconfirmedRows.length || (failedCount>0 && createdVouchers.length>0))throw new ExcelImportUnconfirmed(result);
      localStorage.removeItem(snapshotKey);
      return result;
      },async pending=>{
        const verdict=await reconcileExcelImport(pending,snapshotKey);
        reconciled=!!verdict&&'result' in verdict;
        return verdict;
      },selectedOrganizationId??undefined);
      // Đã trả kết quả của lượt trước: ảnh chụp của lượt đó không còn dùng tới (dấu đã gỡ).
      if(reconciled){ try { localStorage.removeItem(snapshotKey); } catch { /* Ảnh chụp sót lại không chặn gì: không còn dấu nào trỏ tới mã lượt đó. */ } }
      return imported;
      } catch(error) {
        // Preserve row outcomes for the result screen while the durable guard stays blocked.
        let cause:unknown=error;const seen=new Set<unknown>();
        while(cause && !seen.has(cause)){
          if(cause instanceof ExcelImportUnconfirmed)return cause.result;
          seen.add(cause);cause=typeof cause==='object'?(cause as {cause?:unknown}).cause:undefined;
        }
        if(error instanceof FinancialWorkflowError&&error.outcome!=='failure'){
          let rows:unknown;
          try{const raw=localStorage.getItem(snapshotKey);const snapshot=raw?JSON.parse(raw) as {unconfirmedRows?:unknown;failedRows?:unknown}:null;rows=snapshot?.failedRows??snapshot?.unconfirmedRows;}
          catch{/* Ảnh chụp hỏng: câu báo của lõi vẫn đi nguyên, chỉ thiếu danh sách dòng. */rows=undefined;}
          if(Array.isArray(rows)&&rows.length>0&&rows.every(row=>Number.isInteger(row)&&row>0))throw new FinancialWorkflowError(`${workflowErrorMessage(error,'nhập phiếu từ Excel')} Dòng Excel chưa hoàn tất: ${rows.join(', ')}.`,error.outcome,error.completed,error);
        }
        throw error;
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      if (result.reconciledFrom) {
        const maybe=result.possiblyWritten?.length??0;
        const missing=result.errors.length;
        toast.warning(`Đã đối chiếu lượt nhập Excel lúc ${result.reconciledFrom}: ${result.successCount} dòng đã có phiếu${maybe?`, ${maybe} dòng có thể đã ghi`:''}${missing?`, ${missing} dòng chưa ghi`:''}. Tệp vừa chọn chưa được nhập; xem từng dòng rồi chỉ nhập lại các dòng chưa ghi.`);
      } else if (result.failedCount > 0) {
        toast.warning(`Đã tạo ${result.successCount} phiếu${result.createdVouchers.length?": "+result.createdVouchers.map(v=>v.code??v.id).join(", "):""}; ${result.failedCount} dòng chưa hoàn tất. Xem lỗi từng dòng và đối chiếu trước khi nhập lại.`);
      } else if (result.successCount > 0) {
        toast.success(`Đã tạo ${result.successCount} phiếu từ Excel. Xem trạng thái từng phiếu trong danh sách thu chi.`);
      } else toast.info("Không có dòng dữ liệu để nhập.");
    },
    onError: (error) => {
      toast.error(error instanceof FinancialWorkflowError ? workflowErrorMessage(error,'nhập phiếu từ Excel') : voucherFailureMessage(error, 'nhập phiếu từ Excel'));
    },
  });
};

/** Dấu ghi từ bản này: mã đợt chính là mã yêu cầu của dấu. Dấu cũ hơn chỉ biết mã đợt khi đã nhận (completedIds[0]). */
const BATCH_ID_FROM_KEY = 'request-key';
/**
 * Đợt 10a: phiếu con thứ i của lượt gửi mang mã yêu cầu `<attemptId>:<i>`; dấu ghi kèm số phiếu con (`children`) và vị trí
 * các phiếu con thu cọc (`depositAt`, chuỗi "0,3"; rỗng nếu không có).
 */
const CHILD_MODE_ATTEMPT = 'attempt-v1';

/**
 * Đợt đã nhận mã rồi bị xoá (lỗi giữa chừng, đã dọn): tra ĐÚNG từng phiếu con của lượt trước theo mã yêu cầu (đường thường:
 * get_own_income_expense_requests_v1, không qua quyền đọc phiếu; phiếu cọc: get_own_deposit_income_v1), cộng các phiếu con
 * đã nhận mã. Còn phiếu nào hiệu lực ⇒ báo mã để huỷ; không còn phiếu nào hiệu lực ⇒ lần trước không để lại gì: chưa ghi
 * (lõi chỉ nhận sau 2 phút), lần gửi lại là lượt mới với mã phiếu con mới. Chưa kết luận (giữ dấu) khi: phiếu tìm thấy mà
 * không đọc được trạng thái; hoặc phiếu con thu cọc không thấy theo mã — get_own_deposit_income_v1 chỉ thấy phiếu người gọi
 * đọc được, nên «không thấy» chưa chắc là «chưa ghi» (review đợt 10a).
 */
async function reconcileKeyedBatchChildren<T>(pending: FinancialPendingRecord, batchId: string, children: number, depositAt: ReadonlySet<number>): Promise<PendingReconciliation<T>> {
  const keys = Array.from({ length: children }, (_, index) => `${pending.attemptId}:${index}`);
  const byKey = await findOwnVoucherRequests(pending.organizationId, keys);
  const confirmed = pending.completedIds.filter(id => id !== batchId);
  const ids = new Set(confirmed);
  let depositUnseen = false;
  // Phiếu con gửi lần lượt và dừng ở phiếu lỗi đầu tiên: vị trí < số phiếu đã nhận mã là đã xác nhận (mã có trong dấu), vị trí
  // đúng bằng là phiếu chưa rõ, vị trí lớn hơn chưa từng gửi (review lượt 2).
  for (const [index, key] of keys.entries()) {
    if (depositAt.has(index)) {
      if (index !== confirmed.length) continue;
      const id = await findOwnDepositIncome(pending.organizationId, key);
      if (id) ids.add(id); else depositUnseen = true;
    } else {
      const id = byKey.get(key)?.id;
      if (id) ids.add(id);
    }
  }
  if (ids.size) {
    const { data: rows, error } = await supabase.from('income_expenses').select('id, code, approval_status, deleted_at').in('id', [...ids]);
    if (error) throw error;
    if (!Array.isArray(rows)) throw new TypeError('Chưa đọc được phiếu con để đối chiếu.');
    const read = rows as { id: string; code: string | null; approval_status: string | null; deleted_at: string | null }[];
    if ([...ids].some(id => !read.some(row => row.id === id))) return null;
    const live = read.filter(row => row.approval_status !== 'CANCELLED' && !row.deleted_at);
    if (live.length) {
      const codes = live.map(row => row.code || row.id);
      return { outcome: 'already-written', message: `Phiếu tổng lần trước chưa hoàn tất; còn phiếu con chưa huỷ (mã ${codes.join(', ')}). Kiểm tra và huỷ các phiếu này trước khi lập lại.`, recordIds: codes };
    }
  }
  if (depositUnseen) return null;
  return { outcome: 'not-written' };
}
/** Lệch giờ trình duyệt ↔ máy chủ chấp nhận khi tra đợt "tạo sau giờ kẹt" (chỉ cho dấu cũ chưa nhận mã đợt). */
const BATCH_CLOCK_SKEW_MS = 60 * 60_000;

/**
 * Đối chiếu lần tạo phiếu tổng chưa rõ kết quả (cách D, đợt 3). Thứ tự bước: đợt → từng phiếu con → nối phiếu vào
 * đợt; lỗi giữa chừng thì huỷ lại phiếu con và xoá đợt. Vì vậy:
 *  - Đợt còn trên máy chủ ⇒ lần trước đã ghi: báo mã đợt, không tạo thêm.
 *  - Đợt chưa từng được nhận mã và không có trên máy chủ ⇒ chưa ghi (lõi chỉ nhận sau 2 phút); gửi lại cùng mã đợt.
 *  - Đợt đã được nhận rồi bị xoá ⇒ lần trước đã tới bước phiếu con: phiếu con còn hiệu lực thì báo mã. Dấu từ đợt 10a
 *    tra đúng mọi phiếu con theo mã yêu cầu (`reconcileKeyedBatchChildren`), nên phiếu con mất phản hồi cũng tìm được;
 *    dấu cũ hơn không biết mã phiếu con mất phản hồi ⇒ chưa kết luận (hộp cảnh báo).
 */
async function reconcileBatchCreate<T>(pending: FinancialPendingRecord, type: string): Promise<PendingReconciliation<T>> {
  const keyed = pending.meta?.batchId === BATCH_ID_FROM_KEY && !!pending.requestKey;
  const batchId = keyed ? pending.requestKey! : pending.completedIds[0];
  if (!batchId) {
    // Dấu cũ chưa nhận mã đợt: mã đợt do máy chủ sinh nên chỉ tra gần đúng (đợt của mình, cùng loại, sau giờ kẹt).
    const since = new Date(Date.parse(pending.startedAt) - BATCH_CLOCK_SKEW_MS).toISOString();
    const { data, error } = await supabase.from('income_expense_batches').select('id, created_at')
      .eq('user_id', pending.userId).eq('type', type).gte('created_at', since).order('created_at', { ascending: false }).limit(5);
    if (error) throw error;
    if (!Array.isArray(data)) throw new TypeError('Chưa đọc được danh sách phiếu tổng để đối chiếu.');
    const ids = (data as { id: string }[]).map(row => row.id);
    if (ids.length) return { outcome: 'already-written', message: `Có thể phiếu tổng đã được tạo ở lần gửi trước (mã đợt ${ids.join(', ')}). Mở danh sách phiếu tổng để kiểm tra trước khi lập lại.`, recordIds: ids };
    return { outcome: 'not-written' };
  }
  const { data: batch, error: batchError } = await supabase.from('income_expense_batches').select('id').eq('id', batchId).maybeSingle();
  if (batchError) throw batchError;
  if (batch) {
    return { outcome: 'already-written', message: `Phiếu tổng đã được tạo ở lần gửi trước (mã đợt ${batchId}). Mở danh sách phiếu tổng để kiểm tra trước khi lập lại.`, recordIds: [batchId] };
  }
  const batchConfirmed = pending.completedIds.includes(batchId);
  if (!batchConfirmed) return { outcome: 'not-written' };
  const children = pending.meta?.childMode === CHILD_MODE_ATTEMPT ? pending.meta.children : undefined;
  const depositAt = pending.meta?.childMode === CHILD_MODE_ATTEMPT ? pending.meta.depositAt : undefined;
  if (typeof children === 'number' && Number.isInteger(children) && children > 0 && children <= 500 && typeof depositAt === 'string' && /^(\d+(,\d+)*)?$/.test(depositAt)) {
    return reconcileKeyedBatchChildren(pending, batchId, children, new Set(depositAt ? depositAt.split(',').map(Number) : []));
  }
  const childIds = pending.completedIds.filter(id => id !== batchId);
  if (childIds.length) {
    const { data: rows, error } = await supabase.from('income_expenses').select('id, code, approval_status, deleted_at').in('id', childIds);
    if (error) throw error;
    if (!Array.isArray(rows)) throw new TypeError('Chưa đọc được phiếu con để đối chiếu.');
    const live = (rows as { id: string; code: string | null; approval_status: string | null; deleted_at: string | null }[])
      .filter(row => row.approval_status !== 'CANCELLED' && !row.deleted_at);
    if (live.length) {
      const codes = live.map(row => row.code || row.id);
      return { outcome: 'already-written', message: `Phiếu tổng lần trước chưa hoàn tất; còn phiếu con chưa huỷ (mã ${codes.join(', ')}). Kiểm tra và huỷ các phiếu này trước khi lập lại.`, recordIds: codes };
    }
  }
  return null;
}

// Tạo phiếu tổng = INSERT 1 batch + N phiếu con + N junction + N items.
export const useCreateIncomeExpenseBatch = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (input: IncomeExpenseBatchFormValues) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          input.items.map((item) => item.income_expense_type_id),
        );
      // Đợt 10a: vị trí các phiếu con thu cọc ghi vào dấu (phép đối chiếu không kết luận «chưa ghi» cho chúng khi không thấy).
      // Xét TRƯỚC khi ghi dấu: hạng mục không đọc được thì báo lỗi ngay, chưa ghi gì.
      const depositAt = input.type === 'INCOME'
        ? input.items.flatMap((item, index) => accountingClassFor(item.income_expense_type_id) === 'DEPOSIT' ? [index] : []).join(',')
        : '';

      return runFinancialPending({namespace:"voucher-batch-create",userId:user.id,organizationId:selectedOrganizationId ?? "",businessKey:input.type},async progress=>{
      // 1. INSERT batch metadata. Mã đợt = mã yêu cầu của dấu (UUID do trình duyệt sinh): phép đối chiếu tra đúng
      //    đợt theo mã này, và lần gửi lại dùng lại đúng mã nên khoá chính chặn đợt thứ hai (cách D).
      const { data: batch, error: batchError } = await supabase
        .from("income_expense_batches")
        .insert(withOrg({
          id: progress.requestKey,
          user_id: user.id,
          name: input.shared_name,
          type: input.type,
          payer_name: input.payer_name ?? null,
          attachments: input.attachments ?? [],
          notes: input.notes ?? null,
        }, selectedOrganizationId))
        .select()
        .single();

      if (batchError || !batch) {
        throw batchError ?? new Error("Chưa nhận được kết quả tạo đợt phiếu");
      }

      if(!batch.id)throw new TypeError("Chưa xác nhận mã đợt phiếu");
      progress.recordCompleted([batch.id]);
      // 2. Tạo N phiếu con qua ie_compat_insert_v2 (phiếu + item atomic mỗi
      //    call, birth UNAPPROVED — §8). Tạo TỪNG phiếu để giữ thứ tự rõ ràng
      //    (tương ứng với items input). Nếu lỗi ở giữa: rollback bằng cách xoá
      //    batch (CASCADE xoá junction) + huỷ phiếu con đã tạo.
      // Mang theo `type`: rollback phải biết phiếu nào đi cửa THU, phiếu nào đi
      // đường compat cũ (cả đợt cùng một type nên gán thẳng từ input).
      const childVouchers: { id: string; type?: string | null }[] = [];
      try {
        for (const [itemIndex,item] of input.items.entries()) {
          const args={
              p_row: {
                user_id: user.id,
                creator_name: creatorName,
                type: input.type,
                name: batchChildVoucherName(input.shared_name, item),
                building_id: item.building_id,
                room_id: item.room_id ?? null,
                account_id: input.account_id,
                payer_name: input.payer_name ?? null,
                attachments: input.attachments ?? [],
                business_result_accounting: input.business_result_accounting ?? null,
                voucher_date: input.voucher_date,
                repeat_cycle: "NONE",
                repeat_infinity: false,
                repeat_count: 0,
                repeat_remaining: 0,
              },
              p_items: [
                {
                  income_expense_type_id: item.income_expense_type_id,
                  accounting_class: accountingClassFor(item.income_expense_type_id),
                  description: item.description ?? null,
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  start_date: item.start_date ?? null,
                  end_date: item.end_date ?? null,
                },
              ],
          };
          const isDeposit=input.type==='INCOME' && accountingClassFor(item.income_expense_type_id)==='DEPOSIT';
          // Đợt 10a: mỗi phiếu con mang mã yêu cầu `<mã lượt gửi>:<vị trí>` (cả phiếu cọc lẫn phiếu thường, đường thường đi
          // ie_compat_insert_keyed_v1). Mã theo LƯỢT gửi, không theo dấu: lần gửi lại sau khi lượt trước đã dọn sạch là lượt
          // mới, không nhận lại phiếu con đã huỷ của lượt trước.
          const childKey=progress.attemptId+':'+itemIndex;
          const {data:created,error:voucherError}=isDeposit
            ? {data:await recordDepositIncome(selectedOrganizationId!,childKey,
                {...args.p_row,user_id:undefined,creator_name:undefined,batch_child:true},args.p_items,{channel:'finance'}),error:null}
            : await compatRpc('ie_compat_insert_keyed_v1',{...args,p_request_key:childKey});

          const voucherId = (created as { id?: string } | null)?.id;
          if (voucherError || !voucherId) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push({ id: voucherId, type: input.type });
          progress.recordCompleted([voucherId]);
        }

        // 3. INSERT junction rows (bảng batch_items — ngoài phạm vi drain).
        const linkRows = childVouchers.map((v) => ({
          batch_id: (batch as any).id,
          income_expense_id: v.id,
        }));
        const { error: linkError } = await supabase
          .from("income_expense_batch_items")
          .insert(withOrgAll(linkRows, selectedOrganizationId));
        if (linkError) throw linkError;
      } catch (error: unknown) {
        // Keep all receipts even if compensation fails; the user must reconcile,
        // never blindly create the whole batch again after a multi-step failure.
        let cancelled = 0;
        let cleanupFailed = false;
        try {
          if (childVouchers.length > 0) {
            const cleanup = await cancelVouchersSplitByType(childVouchers, "Rollback tạo phiếu tổng lỗi");
            cancelled = cleanup.cancelled;
            cleanupFailed = cleanup.failures.length > 0 || cleanup.cancelled !== childVouchers.length;
          }
          // Đọc lại đúng một dòng bị xoá: RLS có thể xoá 0 dòng mà không báo lỗi.
          const removed = await supabase.from("income_expense_batches").delete().eq("id", (batch as any).id).select("id");
          cleanupFailed ||= !!removed.error || !Array.isArray(removed.data) || removed.data.length !== 1;
        } catch { cleanupFailed = true; }
        // Bước hỏng bị từ chối rõ (không ghi gì) và mọi bước trước đã được dọn, kiểm lại: không còn gì chờ đối chiếu.
        // Gỡ dấu để người dùng sửa lỗi rồi lập lại ngay. Bước hỏng chưa rõ kết quả thì có thể còn một phiếu con chưa
        // biết mã, nên vẫn giữ dấu.
        if (!cleanupFailed && isConfirmedFinancialRejection(error)) {
          progress.releaseCompleted();
          throw new FinancialWorkflowError(
            `Chưa tạo được đợt phiếu: ${voucherFailureMessage(error, "tạo đợt phiếu")} Các phiếu con đã tạo (${cancelled}) đã được huỷ lại và đợt đã được xoá; sửa lỗi rồi lập lại.`,
            "failure", [], error,
          );
        }
        throw new VoucherPartialError(
          `Chưa hoàn tất đợt phiếu. Đã nhận kết quả tạo ${childVouchers.length} phiếu, đã huỷ lại ${cancelled} phiếu.${cleanupFailed ? " Chưa xác nhận được việc dọn toàn bộ đợt." : ""} Hãy kiểm tra danh sách phiếu trước khi lập đợt mới.`,
          childVouchers.map(v => v.id), (batch as any).id, error,
        );
      }

      return { batch, voucherCount: childVouchers.length, voucherIds: childVouchers.map(v=>v.id) };
      },undefined,{operation:'tạo phiếu tổng',meta:{batchId:BATCH_ID_FROM_KEY,childMode:CHILD_MODE_ATTEMPT,children:input.items.length,depositAt},reconcile:pending=>reconcileBatchCreate(pending,input.type)});
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (!options.silent) toast.success(`Đã tạo ${result.voucherCount} phiếu trong một đợt. Xem trạng thái từng phiếu trong danh sách thu chi.`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      console.error("Error creating income expense batch:", error);
      if (!options.silent) toast.error(voucherFailureMessage(error, "tạo đợt phiếu"));
    },
  });
};

class BatchCancelUnconfirmed extends TypeError {
  constructor(readonly result:{count:number;failures:{id:string;message:string;outcomeUnknown:boolean}[];completedIds:string[]}){super('Một số phiếu trong đợt chưa được đối chiếu.');}
}
// Huỷ tất cả phiếu con của 1 batch (1 click)
export const useCancelIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-batch-cancel');

  return useMutation({
    mutationFn: async (input: { batchId: string; reason: string }) => {
      const { batchId, reason } = input;
      if (reason.trim().length < 8 || reason.trim().length > 2000) throw new Error("Nhập lý do huỷ cả đợt từ 8 đến 2.000 ký tự.");
      // 1–2. Phiếu CÒN HIỆU LỰC của đợt (đọc, không ghi): đọc lại mỗi lần, nên lần chạy sau chỉ huỷ phần còn lại.
      const readBatchVoucherIds = async (): Promise<string[]> => {
        const { data: links, error: linkError } = await supabase
          .from("income_expense_batch_items")
          .select("income_expense_id")
          .eq("batch_id", batchId);
        if (linkError) throw linkError;
        return financialReadRows<{income_expense_id:string}>(links).map((l) => l.income_expense_id);
      };
      // Bước dọn khoản thanh toán của phiếu CHI đường cũ (đợt 5): lần trước đã huỷ phiếu nhưng chưa xoá được khoản đó thì
      // phiếu không còn «hiệu lực» nữa, nên phải tìm riêng: phiếu chi đã huỷ của đợt mà khoản thanh toán vẫn còn.
      const readLeftoverPayments = async (): Promise<string[]> => {
        const ids = await readBatchVoucherIds();
        if (ids.length === 0) return [];
        const { data: cancelledRows, error: cancelledError } = await supabase
          .from("income_expenses").select("id, type, payment_id").in("id", ids).eq("approval_status", "CANCELLED");
        if (cancelledError) throw cancelledError;
        const paymentIds = financialReadRows<{type:string|null;payment_id:string|null}>(cancelledRows).filter(v => v.type !== "INCOME" && v.payment_id).map(v => v.payment_id as string);
        if (paymentIds.length === 0) return [];
        // Như cửa huỷ lẻ: khoản đã đánh dấu hoàn tác (reversed_at) không còn tính vào hoá đơn, không xoá.
        const { data: alive, error: aliveError } = await supabase.from("payments").select("id").in("id", paymentIds).is("reversed_at", null);
        if (aliveError) throw aliveError;
        return financialReadRows<{id:string}>(alive).map(row => row.id);
      };
      // Đọc lại số dòng đã xoá: quyền (RLS) có thể làm lệnh xoá chạm 0 dòng mà không báo lỗi.
      const removeLeftoverPayments = async (leftover: string[]) => {
        if (leftover.length === 0) return;
        const { data: deleted, error: deleteError } = await supabase.from("payments").delete().in("id", leftover).select("id");
        if (deleteError || !Array.isArray(deleted) || deleted.length !== leftover.length) throw new VoucherPartialError(`Phiếu chi đã huỷ của đợt còn ${leftover.length} khoản thanh toán hoá đơn chưa cập nhật được. Hãy kiểm tra phiếu và hoá đơn liên quan trước khi thao tác tiếp.`, [], batchId, deleteError);
      };
      const readActiveVouchers = async () => {
      const ids = await readBatchVoucherIds();
      if (ids.length === 0) return [];

      // Đọc (read-only) các phiếu còn hiệu lực để biết payment_id cần
      // cascade xoá; sau đó huỷ qua ie_compat_cancel_v2 (Stage-7: client
      // không còn UPDATE trực tiếp income_expenses). Phiếu đã POSTED (ghi
      // sổ V2) sẽ bị server từ chối — dùng reversal thay vì huỷ.
      const { data: vouchers, error: readError } = await supabase
        .from("income_expenses")
        .select("id, type, payment_id")
        .in("id", ids)
        .neq("approval_status", "CANCELLED");
      if (readError) {
        throw readError;
      }
      return financialReadRows<any>(vouchers);
      };
      const cancelRemaining = async (progress: FinancialWorkflowProgress) => {
      const activeVouchers = await readActiveVouchers();
      if (activeVouchers.length === 0) return { count: 0, failures: [], completedIds: [] };

      const { cancelled, failures, completedIds } = await cancelVouchersSplitByType(
        activeVouchers,
        reason.trim(),
        ids=>progress.completed.push(...ids.map(id=>({id,label:`Đã huỷ phiếu ${id}`}))),
      );

      // Phiếu THU đã được server gỡ khoản thanh toán bên trong
      // cancel_income_voucher_v1 (đánh dấu reversed_at, hoá đơn tự mở lại nợ).
      // Chỉ còn phiếu CHI đường cũ mới cần client dọn payments hộ.
      const paymentIdsToDelete = activeVouchers
        .filter((v) => v.type !== "INCOME" && v.payment_id && !failures.some(f => f.id === v.id))
        .map((v) => v.payment_id);
      if (paymentIdsToDelete.length > 0) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .in("id", paymentIdsToDelete);
        if (payErr) {
          throw new VoucherPartialError(`Đã huỷ ${cancelled} phiếu nhưng chưa cập nhật được thanh toán hoá đơn. Hãy kiểm tra phiếu và hoá đơn liên quan trước khi thao tác tiếp.`, activeVouchers.filter(v => !failures.some(f => f.id === v.id)).map(v => v.id), batchId, payErr);
        }
      }

      const result={count:cancelled,failures,completedIds};
      if(failures.some(failure=>failure.outcomeUnknown))throw new BatchCancelUnconfirmed(result);
      return result;
      };
      try {return await workflow.run(batchId,'huỷ đợt phiếu',cancelRemaining,async (pending,progress)=>{
        // Cách A (đợt 5): đọc lại phiếu còn hiệu lực rồi chỉ huỷ phần còn. Phiếu đã huỷ không tính là lỗi. Đường huỷ phiếu
        // chi (ie_compat_cancel_v2, production 25/11/2026) không xét phiếu đã huỷ, nên phần còn lại chỉ được chạy khi lần
        // gửi trước chắc chắn đã kết thúc; phiếu thu (cancel_income_voucher_v1) khoá phiếu rồi trả «đã huỷ trước đó».
        // Khoản thanh toán của phiếu CHI đã huỷ mà còn sót được dọn ở cả hai nhánh: lần trước có thể đã huỷ phiếu chi rồi
        // hỏng ở bước xoá khoản, trong khi đợt vẫn còn phiếu khác hiệu lực (review lượt 2).
        const active = await readActiveVouchers();
        const leftover = await readLeftoverPayments();
        if (active.length === 0 && leftover.length === 0) return { result: { count: 0, failures: [], completedIds: [] } };
        // Còn phiếu hiệu lực hoặc còn khoản chưa gỡ: chỉ chạy phần còn, khi lần trước chắc chắn đã kết thúc.
        if (!priorAttemptSettled(pending)) return null;
        await removeLeftoverPayments(leftover);
        if (active.length === 0) return { result: { count: 0, failures: [], completedIds: [] } };
        return { result: await cancelRemaining(progress) };
      },selectedOrganizationId??undefined);
      } catch(error) {
        let cause:unknown=error;const seen=new Set<unknown>();
        while(cause && !seen.has(cause)){
          if(cause instanceof BatchCancelUnconfirmed)return cause.result;
          seen.add(cause);cause=typeof cause==='object'?(cause as {cause?:unknown}).cause:undefined;
        }
        if(error instanceof FinancialWorkflowError && error.completed.length)throw new VoucherPartialError(workflowErrorMessage(error,'huỷ đợt phiếu'),error.completed.map(step=>step.id),batchId,error);
        throw error;
      }
    },
    onSuccess: ({ count, failures }) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["utility-payments"] });
      if (failures?.length) toast.warning(`Đã huỷ ${count} phiếu; ${failures.length} phiếu chưa huỷ được. Kiểm tra lại từng phiếu trước khi thực hiện tiếp.`);
      else if (count === 0) toast.info("Không còn phiếu nào trong đợt cần huỷ. Không có thay đổi mới.");
      else toast.success(`Đã huỷ ${count} phiếu trong đợt.`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'huỷ đợt phiếu'):voucherFailureMessage(error, 'huỷ đợt phiếu'));
      console.error("Error cancelling income expense batch:", error);
    },
  });
};

// Đổi sổ quỹ đồng loạt cho các phiếu con CHỜ DUYỆT của một đợt (UI "Sửa sổ quỹ ở
// phiếu tổng" — chỉ hiện khi mọi phiếu con đang cùng một sổ). Mỗi phiếu là một
// lần sửa có lưu vết (revise_pending_income_expense_v1) với cùng một lý do.
// Đợt có phiếu đã duyệt thì từ chối CẢ ĐỢT trước khi ghi gì: đổi một nửa là đợt
// lệch sổ. Phiếu đã huỷ bỏ qua.
const batchAccountIssues=new Map<string,unknown>();
export const getBatchAccountIssue=(batchId:string)=>batchAccountIssues.get(batchId);

export const useUpdateBatchAccount = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-batch-account');

  return useMutation({
    mutationFn: async (input: { batchId: string; accountId: string; reason: string }) => {
      const { batchId, accountId, reason } = input;
      try {return await workflow.run(batchId,'đổi sổ quỹ cho đợt phiếu',async progress=>{

      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items")
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        throw linkError;
      }
      const ids = financialReadRows(links).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      const { data: rows, error: rowsError } = await supabase
        .from("income_expenses")
        .select("id, code, approval_status, approval_version, account_id")
        .in("id", ids);
      if (rowsError) {
        throw rowsError;
      }
      const live = financialReadRows(rows).filter((r) => r.approval_status !== "CANCELLED");
      const daDuyet = live.filter((r) => r.approval_status !== "UNAPPROVED");
      if (daDuyet.length > 0) {
        const message =
          `Đợt có ${daDuyet.length} phiếu đã duyệt (${daDuyet.slice(0, 3).map((r) => r.code).join(", ")}` +
          `${daDuyet.length > 3 ? "…" : ""}) — chỉ đổi sổ được khi mọi phiếu còn Chờ duyệt.`;
        throw new FinancialWorkflowError(message,'failure',[]);
      }


      let count = 0;
      const completedIds: string[] = [];
      for (const r of live) {
        if (r.account_id === accountId) continue;
        try {
          const result = await reviseIncomeExpense({
            voucherId: r.id,
            expectedApprovalVersion: Number(r.approval_version),
            patch: { account_id: accountId },
            reason,
            // Mã gồm cả sổ đích: revise_pending_income_expense_v1 trả lại kết quả cũ theo mã mà KHÔNG so nội dung, nên lần
            // chạy lại sang sổ khác phải là mã khác (không thì nhận "đã đổi" của lần trước trong khi phiếu vẫn ở sổ cũ).
            idempotencyKey:`${progress.requestKey}:${r.id}:${accountId}`,
          });
          if(result.id!==r.id)throw new TypeError('Chưa xác nhận được đúng phiếu vừa đổi sổ.');
          if (result.changed) { count++; completedIds.push(r.id); progress.completed.push({id:r.id,label:`Đã đổi sổ phiếu ${r.code??r.id}`}); }
        } catch (error) {
          if(!completedIds.length && isConfirmedFinancialRejection(error))throw error;
          throw new VoucherPartialError(`${r.code}: ${revisionErrorMessage(error)} Đã đổi sổ cho ${count} phiếu trước đó. Hãy kiểm tra đợt phiếu trước khi tiếp tục.`, completedIds, batchId, error);
        }
      }

      return { count };
      // Cách A (đợt 6): chạy lại ngay. revise_pending_income_expense_v1 (production 25/11/2026) khoá công ty rồi khoá phiếu
      // FOR UPDATE trước khi tra mã và so phiên bản; vòng trên đọc lại phiếu và bỏ qua phiếu đã ở đúng sổ, nên lần chạy lại
      // chỉ đổi phần còn thiếu, không đổi một phiếu hai lần.
      },async()=>({outcome:'not-written',serverDedupesRequestKey:true}),selectedOrganizationId??undefined);
      }catch(error){
        if(error instanceof FinancialWorkflowError && error.completed.length)throw new VoucherPartialError(workflowErrorMessage(error,'đổi sổ quỹ cho đợt phiếu'),error.completed.map(step=>step.id),batchId,error);
        throw error;
      }
    },
    onSuccess: ({ count }, input) => {
      // Lần chạy lại đã đổi xong phần còn thiếu: câu báo của lần chưa rõ kết quả không còn đúng.
      batchAccountIssues.delete(input.batchId);
      for (const key of VOUCHER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (count === 0) toast.info("Các phiếu đã dùng sổ quỹ này. Không có thay đổi mới.");
      else toast.success(`Đã đổi sổ quỹ cho ${count} phiếu trong đợt.`);
    },
    onError: (error,input) => {
      if(error instanceof VoucherPartialError||voucherOutcomeUnknown(error)) batchAccountIssues.set(input.batchId,error);
      // Đổi dở dang vẫn phải làm mới màn hình: vài phiếu đầu có thể đã đổi.
      for (const key of VOUCHER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      console.error("Error updating batch account:", error);
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'đổi sổ quỹ cho đợt phiếu'):voucherFailureMessage(error, 'đổi sổ quỹ cho đợt phiếu'));
    },
  });
};
