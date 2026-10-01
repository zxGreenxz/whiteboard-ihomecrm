import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {useOrganization} from '@/contexts/OrganizationContext';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadRows} from '@/lib/financialReadValidation';
// =============================================
// useDeletePayment
// "Hoàn tác" KHÔNG BAO GIỜ là xoá. Không lỗi phân quyền / đóng băng / rollout
// nào được rơi xuống đường xoá huỷ diệt.
//
// Đợt 5 — có HAI kết cục, server tự chọn theo chế độ kế toán của tổ chức:
//  - Linh hoạt + kỳ còn mở  → huỷ TẠI CHỖ chính phiếu thu, KHÔNG sinh phiếu nào.
//  - Chuẩn kế toán          → sinh phiếu chi đối ứng như trước.
//  - Kỳ đã đóng             → server CHẶN kèm lý do; không có đường vòng nào ở
//                             FE, vì một khoản tiền rời khỏi tháng đã chia lợi
//                             nhuận phải là quyết định có người ký.
// Payment không có collection_id vẫn đi adapter v3 như cũ.
//
// Lý do hoàn tác do NGƯỜI BẤM gõ (≥ 8 ký tự, đợt 1 sửa phiếu 25/09/2026): câu
// điền sẵn cũ làm mọi lần huỷ — kể cả 6/17 lần thu trùng — đều mang cùng một lý
// do vô nghĩa, không truy được vì sao tiền rời sổ.
// =============================================

import { invoiceFailureMessage } from '@/lib/invoiceFeedback';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { todayISO } from '@/lib/collect';
import { reverseInvoicePaymentBySource, type ReversalMode } from '@/lib/paymentRecordRpc';
import { periodBlockCodeFromError, periodBlockMessage } from '@/lib/cashbookClosing';
import { REVISION_REASON_MAX, REVISION_REASON_MIN } from '@/lib/incomeExpenseRevision';

interface DeletePaymentInput {
  payment_id?: string | null;
  collection_id?: string | null;
  /** Lý do hoàn tác người dùng gõ — bắt buộc, 8..1000 ký tự. */
  reason: string;
}

/** Câu báo khi lý do hoàn tác chưa đủ dài (chặn trước khi gọi máy chủ). */
export const UNDO_REASON_REQUIRED_TEXT = `Phải ghi lý do hoàn tác (ít nhất ${REVISION_REASON_MIN} ký tự).`;

type DeletePaymentResult = {
  payment_id: string | null;
  collection_id: string | null;
  mode: 'COLLECTION_REVERSED' | 'LEGACY_PAYMENT_REVERSED';
  reversalMode: ReversalMode | null;
};

/**
 * Vì sao không hoàn tác được — mã ổn định từ can_reverse_collection_v1 (đủ bộ đo trên prod 01/10/2026:
 * ALREADY_REVERSED, NOT_COLLECTOR, NOT_LIFO, CREDIT_USED + mã khoá kỳ của period_block_code_v1).
 */
export type CollectionReversalBlockCode =
  | 'ALREADY_REVERSED'
  | 'NOT_COLLECTOR'
  | 'NOT_LIFO'
  | 'CREDIT_USED'
  | 'CASHBOOK_CLOSED'
  | 'HANDOVER_LOCKED'
  | 'PROFIT_LOCKED'
  | 'UNKNOWN';

export interface CollectionReversalEligibility {
  collection_id: string;
  mode: 'IN_PLACE_CANCEL' | 'COUNTER_VOUCHER' | 'BLOCKED';
  reason_code: CollectionReversalBlockCode | null;
}

export const COLLECTION_BLOCK_TEXT: Record<CollectionReversalBlockCode, string> = {
  ALREADY_REVERSED: 'Khoản thu này đã được hoàn tác trước đó.',
  NOT_COLLECTOR: 'Chỉ người đã thu khoản này mới hoàn tác được.',
  NOT_LIFO: 'Phải hoàn tác lần thu mới nhất của hoá đơn trước, rồi mới tới lần thu này.',
  CREDIT_USED: 'Tiền thừa của lần thu này đã được dùng trả hoá đơn khác — hoàn tác khoản dùng tiền thừa đó trước.',
  CASHBOOK_CLOSED:
    'Sổ quỹ chứa khoản thu này đã chốt & bàn giao — kỳ đó khoá vĩnh viễn. Muốn điều chỉnh, hãy nhờ quản trị lập phiếu chi đối ứng ở kỳ hiện tại.',
  HANDOVER_LOCKED:
    'Phiếu thu nằm trong một phiên bàn giao đã xác nhận — hai bên phải huỷ phiên đó trước.',
  PROFIT_LOCKED:
    'Tháng của khoản thu này đã chốt lợi nhuận — mọi phiếu của tháng bị khoá; nhờ chủ công ty mở khoá tháng.',
  UNKNOWN: 'Kỳ kế toán của khoản thu này đã đóng nên không hoàn tác được.',
};

/**
 * Câu hiện cho một lỗi hoàn tác. Tháng đã chốt lợi nhuận: hàm hoàn tác trên máy
 * chủ còn trả câu cũ "liên hệ quản trị lập phiếu chi đối ứng" — trái với luật khoá
 * tháng tuyệt đối (chủ công ty mở khoá tháng) — nên thay bằng câu mới, trừ khi
 * máy chủ đã nói câu mới (kèm tháng + toà).
 */
export function undoErrorText(message: string | null | undefined): string {
  const msg = message ?? '';
  if (periodBlockCodeFromError(msg) === 'PROFIT_LOCKED') {
    const raw = msg.replace(/^\[[A-Z_]+\]\s*/, '').trim();
    return /mở\s+kh(?:oá|óa)\s+tháng/i.test(raw) ? raw : COLLECTION_BLOCK_TEXT.PROFIT_LOCKED;
  }
  if (msg === 'Chỉ người đã thu khoản này mới hoàn tác được.' || msg === UNDO_REASON_REQUIRED_TEXT) return msg;
  return periodBlockMessage(msg) ?? invoiceFailureMessage({message:msg},'hoàn tác khoản thu');
}

/**
 * Hỏi server trước khi bày nút, để người dùng không bấm rồi mới ăn lỗi — và để
 * hộp xác nhận nói ĐÚNG chuyện sắp xảy ra (huỷ tại chỗ hay sinh phiếu đối ứng).
 */
export const useCollectionReversalEligibility = (collectionIds: string[]) => {
  const ids = [...new Set(collectionIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ['can-reverse-collection', ids.join(',')],
    meta:{errorDisplay:'inline',label:'điều kiện hoàn tác khoản thu'},
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, CollectionReversalEligibility>> => {
      const { data, error } = await supabase.rpc('can_reverse_collection_v1', {
        p_collection_ids: ids,
      });
      if (error) throw error;
      const map: Record<string, CollectionReversalEligibility> = {};
      for (const row of financialReadRows(data)) {
        if(typeof row.collection_id!=='string'||!row.collection_id||!['IN_PLACE_CANCEL','COUNTER_VOUCHER','BLOCKED'].includes(row.mode)||(row.reason_code!==null&&!Object.prototype.hasOwnProperty.call(COLLECTION_BLOCK_TEXT,row.reason_code)))throw new TypeError('Chưa đọc được điều kiện hoàn tác khoản thu.');
        map[row.collection_id] = {...row,mode:row.mode as CollectionReversalEligibility['mode'],reason_code:row.reason_code as CollectionReversalBlockCode|null};
      }
      return map;
    },
  });
};

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('collection-reversal');

  return useMutation({
    mutationFn: async ({
      payment_id,
      collection_id,
      reason: rawReason,
    }: DeletePaymentInput): Promise<DeletePaymentResult> => {
      // Chặn TRƯỚC mọi lời gọi mạng: không có lý do thật thì không hoàn tác.
      const reason = (rawReason ?? '').trim();
      if (reason.length < REVISION_REASON_MIN || reason.length > REVISION_REASON_MAX) {
        throw new Error(UNDO_REASON_REQUIRED_TEXT);
      }
      const paymentId = payment_id?.trim() || null;
      let collectionId = collection_id?.trim() || null;

      // Older callers only know payment_id. Resolve its collection once so a
      // multi-tender V5 receipt still reverses at collection scope.
      if (!collectionId) {
        if (!paymentId) {
          throw new Error('Không tìm thấy nguồn giao dịch cần hoàn tác');
        }
        const { data: payment, error: paymentError } = await supabase
          .from('payments')
          .select('id, collection_id')
          .eq('id', paymentId)
          .single();
        if (paymentError || !payment) {
          throw paymentError ?? new Error('Không tìm thấy giao dịch thu');
        }
        collectionId = (payment as { collection_id?: string | null }).collection_id ?? null;
      }

      return workflow.run(collectionId??paymentId!,'hoàn tác khoản thu',async progress=>{
      const outcome = await reverseInvoicePaymentBySource(
        (fn, args) => supabase.rpc(fn, args as never),
        {
          payment_id: paymentId,
          collection_id: collectionId,
          reversal_date: todayISO(),
          reason,
          idempotency_key: progress.requestKey,
        },
      );

      const receipt=outcome.result as {collection_id?:unknown;payment_id?:unknown;status?:unknown;mode?:unknown}|null;
      if(collectionId ? receipt?.collection_id!==collectionId||receipt.status!=='REVERSED'||!outcome.reversalMode : receipt?.payment_id!==paymentId||receipt.mode!=='DELETED')throw new TypeError('Chưa xác nhận được nguồn và kết quả hoàn tác khoản thu.');
      progress.completed.push({id:collectionId??paymentId!,label:`Đã hoàn tác ${collectionId?'lần thu':'thanh toán cũ'} ${collectionId??paymentId}`});
      return {
        payment_id: paymentId,
        collection_id: collectionId,
        mode: outcome.source === 'COLLECTION'
          ? 'COLLECTION_REVERSED'
          : 'LEGACY_PAYMENT_REVERSED',
        reversalMode: outcome.reversalMode,
      };
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (result) => {
      // Đợt 5: huỷ tại chỗ đổi TRẠNG THÁI phiếu thu gốc và rút tiền khỏi sổ
      // quỹ ngay, nên mọi màn hình đọc sổ quỹ / dòng tiền / phân tích tài chính
      // phải được kéo lại — thiếu là người dùng nhìn hai con số khác nhau cho
      // tới lúc F5.
      for (const key of [
        ['invoice-payments-summary'],
        ['invoices'],
        ['invoice-rounding-report'],
        ['invoice'],
        ['payments'],
        ['invoice-statistics'],
        ['income-expenses'],
        ['income-expense-batches'],
        ['accounts-with-balance'],
        ['excess-amount'],
        ['invoice-collectors'],
        ['handover-vouchers'],
        ['first-invoice-details'],
        ['contract-deposit-vouchers'],
        ['cash-book-summary'],
        ['cash-flow-by-day'],
        ['voucher-with-batch'],
        ['voucher-cancellation'],
        ['ie-history'],
        ['settlement-report'],
        ['financial-analysis'],
        ['can-reverse-collection'],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      const description = result.mode !== 'COLLECTION_REVERSED'
        ? 'Khoản thanh toán cũ đã được xử lý hoàn tác. Kiểm tra lịch sử hoá đơn và chứng từ liên quan.'
        : result.reversalMode === 'IN_PLACE_CANCEL'
          ? 'Phiếu thu đã chuyển sang ĐÃ HUỶ và tiền đã trừ khỏi sổ quỹ. Không có phiếu đối ứng nào được sinh thêm.'
          : 'Toàn bộ các dòng TM/TK/TT trong cùng lần thu đã được hoàn tác bằng phiếu chi đối ứng.';

      toast({
        title: result.mode === 'COLLECTION_REVERSED'
          ? 'Đã hoàn tác lần thu tiền'
          : 'Đã hoàn tác phiếu thanh toán cũ',
        description,
      });
    },
    onError: (error: Error) => {
      // Kỳ đã đóng đến từ TRIGGER/vị ngữ dùng chung với tiền tố [CASHBOOK_CLOSED]
      // / [HANDOVER_LOCKED] / [PROFIT_LOCKED]; in thẳng SQLERRM ra toast là ném
      // cả dấu ngoặc vuông vào mặt người dùng.
      toast({
        variant: 'destructive',
        title: 'Không thể hoàn tác khoản thu',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,'hoàn tác khoản thu') : periodBlockMessage(error?.message) ? undoErrorText(error?.message) : invoiceFailureMessage(error,'hoàn tác khoản thu'),
      });
    },
  });
};
