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
// =============================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { todayISO } from '@/lib/collect';
import { reverseInvoicePaymentBySource, type ReversalMode } from '@/lib/paymentRecordRpc';
import { periodBlockMessage } from '@/lib/cashbookClosing';

interface DeletePaymentInput {
  payment_id?: string | null;
  collection_id?: string | null;
}

type DeletePaymentResult = {
  payment_id: string | null;
  collection_id: string | null;
  mode: 'COLLECTION_REVERSED' | 'LEGACY_PAYMENT_REVERSED';
  reversalMode: ReversalMode | null;
};

/** Vì sao không hoàn tác được — mã ổn định từ can_reverse_collection_v1. */
export type CollectionReversalBlockCode =
  | 'ALREADY_REVERSED'
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
  CASHBOOK_CLOSED:
    'Sổ quỹ chứa khoản thu này đã chốt & bàn giao — kỳ đó khoá vĩnh viễn. Muốn điều chỉnh, hãy nhờ quản trị lập phiếu chi đối ứng ở kỳ hiện tại.',
  HANDOVER_LOCKED:
    'Phiếu thu nằm trong một phiên bàn giao đã xác nhận — hai bên phải huỷ phiên đó trước.',
  PROFIT_LOCKED:
    'Lợi nhuận của tháng chứa khoản thu này đã chốt và đã chia cho cổ đông. Hệ thống không tự huỷ khoản thu của tháng đó; muốn điều chỉnh, hãy nhờ quản trị lập phiếu chi đối ứng ở kỳ hiện tại.',
  UNKNOWN: 'Kỳ kế toán của khoản thu này đã đóng nên không hoàn tác được.',
};

/**
 * Hỏi server trước khi bày nút, để người dùng không bấm rồi mới ăn lỗi — và để
 * hộp xác nhận nói ĐÚNG chuyện sắp xảy ra (huỷ tại chỗ hay sinh phiếu đối ứng).
 */
export const useCollectionReversalEligibility = (collectionIds: string[]) => {
  const ids = [...new Set(collectionIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ['can-reverse-collection', ids.join(',')],
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, CollectionReversalEligibility>> => {
      const { data, error } = await (supabase.rpc as any)('can_reverse_collection_v1', {
        p_collection_ids: ids,
      });
      if (error) throw new Error(error.message);
      const map: Record<string, CollectionReversalEligibility> = {};
      for (const row of (data ?? []) as CollectionReversalEligibility[]) {
        map[row.collection_id] = row;
      }
      return map;
    },
  });
};

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      payment_id,
      collection_id,
    }: DeletePaymentInput): Promise<DeletePaymentResult> => {
      const paymentId = payment_id?.trim() || null;
      let collectionId = collection_id?.trim() || null;

      // Older callers only know payment_id. Resolve its collection once so a
      // multi-tender V5 receipt still reverses at collection scope.
      if (!collectionId) {
        if (!paymentId) {
          throw new Error('Không tìm thấy nguồn giao dịch cần hoàn tác');
        }
        const { data: payment, error: paymentError } = await (supabase as any)
          .from('payments')
          .select('id, collection_id')
          .eq('id', paymentId)
          .single();
        if (paymentError || !payment) {
          throw paymentError ?? new Error('Không tìm thấy giao dịch thu');
        }
        collectionId = (payment as { collection_id?: string | null }).collection_id ?? null;
      }

      const outcome = await reverseInvoicePaymentBySource(
        (fn, args) => (supabase.rpc as any)(fn, args),
        {
          payment_id: paymentId,
          collection_id: collectionId,
          reversal_date: todayISO(),
          reason: 'Hoàn tác thu tiền từ giao diện hóa đơn',
          idempotency_key: collectionId
            ? `revcollection-${collectionId}`
            : `revpayment-${paymentId}`,
        },
      );

      return {
        payment_id: paymentId,
        collection_id: collectionId,
        mode: outcome.source === 'COLLECTION'
          ? 'COLLECTION_REVERSED'
          : 'LEGACY_PAYMENT_REVERSED',
        reversalMode: outcome.reversalMode,
      };
    },
    onSuccess: (result) => {
      // Đợt 5: huỷ tại chỗ đổi TRẠNG THÁI phiếu thu gốc và rút tiền khỏi sổ
      // quỹ ngay, nên mọi màn hình đọc sổ quỹ / dòng tiền / phân tích tài chính
      // phải được kéo lại — thiếu là người dùng nhìn hai con số khác nhau cho
      // tới lúc F5.
      for (const key of [
        ['invoice-payments-summary'],
        ['invoices'],
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
        ['cash-book'],
        ['cash-book-summary'],
        ['cash-flow-by-day'],
        ['voucher-detail'],
        ['voucher-cancellation'],
        ['ie-history'],
        ['settlement-report'],
        ['financial-analysis'],
        ['can-reverse-collection'],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      const description = result.mode !== 'COLLECTION_REVERSED'
        ? 'Payment cũ đã được hoàn tác bằng adapter v3; lịch sử gốc được giữ nguyên.'
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
        description: periodBlockMessage(error.message) ?? error.message,
      });
    },
  });
};
