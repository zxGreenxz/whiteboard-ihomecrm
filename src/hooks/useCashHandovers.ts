import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialAlreadyRecordedError, FinancialWorkflowError, FinancialWorkflowGuard, type PendingSweepHandler } from '@/lib/financialWorkflow';
import { beforeStateMeta, transitionVerdict, type FinancialPendingRecord, type PendingReconciliation } from '@/lib/financialPending';
// =============================================
// useCashHandovers — data layer cho Bàn giao tiền mặt (/thu-tien).
//
// - useUnhandedVouchers: phiếu thu TM CHƯA bàn giao trong SỔ TIỀN MẶT RIÊNG
//   của chính user — sổ chủ công ty cài ở màn "Sổ nhận tiền" (máy chủ trả qua
//   get_receiving_cashbooks_v1; cũng là sổ nhận tiền mặt của useQuickCollect).
//   Thay cho quy ước tên "…Thu" cũ (đợt 1 sửa phiếu, 25/09/2026).
// - useCashHandoverList: phiên bàn giao mình là người giao/nhận (RLS tự
//   lọc) + badge số phiên CẦN TÔI thao tác.
// - 5 mutation gọi RPC SECURITY DEFINER (migration 20260610130000).
//   Gọi supabase.rpc như METHOD + cast any (types.ts chưa regen —
//   gotcha docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md §4.4).
// =============================================

import { useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { useAuth } from '@/hooks/useAuth';
import { useReceivingCashbooks } from '@/hooks/useReceivingCashbooks';
import { useOrganization } from '@/contexts/OrganizationContext';
import { needsMyAction, type HandoverItemLite, type HandoverLite } from '@/lib/handover';

export interface UnhandedVoucher {
  id: string;
  code: string | null;
  name: string | null;
  /** THU hoặc CHI — bàn giao theo số dư gộp cả phiếu chi. */
  type: 'INCOME' | 'EXPENSE';
  total_amount: number;
  voucher_date: string | null;
  room?: { name: string | null } | null;
  building?: { name: string | null } | null;
}

export interface CashHandover extends HandoverLite {
  from_account_id: string;
  to_account_id: string | null;
  note: string | null;
  cancel_requested_at: string | null;
  items: HandoverItemLite[];
}

/**
 * Phiếu CHƯA bàn giao trong 1 SỔ của chính mình — CẢ phiếu THU lẫn CHI (bàn
 * giao theo số dư ròng). Mặc định sổ tiền mặt riêng của user (màn "Sổ nhận
 * tiền"); chưa cài thì `accountId` rỗng và không tải gì. Truyền `sourceAccountId`
 * để bàn giao từ sổ khác (vd sổ chuyển khoản tkHiep). Loại phiếu CHI chuyển
 * ("Bàn giao tiền mặt →" do confirm sinh ra, mang handover_transfer_id) để
 * không trừ trùng; phiếu THU chuyển ("Nhận bàn giao") vẫn cho quét để bàn giao tiếp.
 */
export const useUnhandedVouchers = (sourceAccountId?: string) => {
  const { selectedOrganizationId } = useOrganization();
  // Cùng khoá truy vấn với HandoverSheet ⇒ chỉ một lần gọi máy chủ.
  const { data: receiving } = useReceivingCashbooks(selectedOrganizationId, null);
  const accountId = sourceAccountId || receiving?.personalCashBook?.id || '';

  const query = useQuery({
    meta: {feedback: "inline"},
    queryKey: ['handover-vouchers', accountId],
    enabled: !!accountId,
    queryFn: async (): Promise<UnhandedVoucher[]> => {
      // PAGED: vượt 1000 phiếu chưa bàn giao mà không phân trang là sót phiếu
      // âm thầm khi bàn giao tiền mặt (fail-open trên tiền — bug cap-1000).
      const data = await fetchAllRows<UnhandedVoucher>(
        (from, to) =>
          supabase
            .from('income_expenses')
            .select('id, code, name, type, total_amount, voucher_date, room:rooms(name), building:buildings(name)')
            .eq('account_id', accountId)
            .in('type', ['INCOME', 'EXPENSE'])
            .eq('approval_status', 'APPROVED')
            .is('deleted_at', null)
            .is('handover_id', null)
            .or('handover_transfer_id.is.null,type.eq.INCOME')
            .order('voucher_date', { ascending: false })
            .order('created_at', { ascending: false })
            .order('id', { ascending: true }) // tiebreaker cho .range() ổn định
            .range(from, to),
        { label: 'handover.unhanded' },
      );
      // fetchAllRows fail-closed: null = lỗi query → throw, không coi là rỗng.
      if (data === null) throw new Error('Lỗi tải phiếu chưa bàn giao');
      return data;
    },
  });

  return { ...query, accountId };
};

/** Mọi phiên bàn giao mình tham gia (RLS lọc) + badge cần-tôi-thao-tác. */
export const useCashHandoverList = () => {
  const { data: currentUser } = useAuth();

  const query = useQuery({
    meta: {feedback: "inline"},
    queryKey: ['cash-handovers'],
    enabled: !!currentUser?.id,
    // Polling nhẹ để người nhận thấy phiên mới mà không cần reload.
    // 60s là đủ cho badge (trước 30s — x2 request nền vô ích trên instance nhỏ).
    // 21/10/2026 (RT-OTHER-5): 60 s → 5 phút. Hub realtime phủ cash_handovers
    // (key ['cash-handovers']) và từ nay bắt kịp sau rớt kết nối, nên poll chỉ
    // còn là lưới an toàn cuối.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<CashHandover[]> => {
      // Select đúng cột UI dùng (CashHandover/HandoverItemLite) thay '*' —
      // bỏ các cột transfer_*/updated_at không ai đọc, nhẹ payload poll.
      const { data, error } = await supabase
        .from('cash_handovers')
        .select(
          'id, code, giver_id, receiver_id, giver_name, receiver_name, total_amount, gross_amount, expense_amount, voucher_count, status, cancel_requested_by, cancel_reason, cancel_requested_at, created_at, confirmed_at, cancelled_at, from_account_id, to_account_id, note, items:cash_handover_items(voucher_id, amount, voucher_code, voucher_date, room_name, building_name, voucher_type)',
        )
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid handover list');
      return data as CashHandover[];
    },
  });

  const actionCount = useMemo(
    () => (query.data ?? []).filter((h) => needsMyAction(h, currentUser?.id)).length,
    [query.data, currentUser],
  );

  return { ...query, actionCount, myId: currentUser?.id };
};

const useInvalidateHandover = () => {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      'cash-handovers',
      'handover-vouchers',
      'income-expenses',
      'accounts-with-balance',
      'accounts',
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
};

interface VoucherHandover { id: string; code: string | null; status: string | null }

/** Đọc mỗi lần tối đa chừng này mã phiếu, để đường dẫn PostgREST không quá dài khi chọn cả trăm phiếu. */
const VOUCHER_READ_CHUNK = 100;

/**
 * Phiên bàn giao đang chứa các phiếu đã chọn (đọc TRƯỚC khi ghi dấu, không ghi gì). Thiếu phiếu nào trong kết quả đọc
 * thì không kết luận được: ném lỗi, không gửi lệnh.
 */
export async function readVoucherHandovers(voucherIds: readonly string[]): Promise<VoucherHandover[]> {
  const handoverIds = new Set<string>();
  for (let start = 0; start < voucherIds.length; start += VOUCHER_READ_CHUNK) {
    const chunk = voucherIds.slice(start, start + VOUCHER_READ_CHUNK);
    const { data, error } = await supabase.from('income_expenses').select('id, handover_id').in('id', chunk);
    if (error) throw error;
    const rows = Array.isArray(data) ? data as { id?: unknown; handover_id?: unknown }[] : null;
    if (!rows || chunk.some(id => !rows.some(row => row.id === id))) {
      throw new FinancialWorkflowError('Chưa đọc được trạng thái bàn giao của các phiếu đã chọn. Tải lại danh sách phiếu rồi thử lại.', 'failure', []);
    }
    for (const row of rows) if (typeof row.handover_id === 'string' && row.handover_id) handoverIds.add(row.handover_id);
  }
  if (!handoverIds.size) return [];
  const ids = [...handoverIds];
  const { data, error } = await supabase.from('cash_handovers').select('id, code, status').in('id', ids);
  if (error) throw error;
  const rows = Array.isArray(data) ? data as { id?: unknown; code?: unknown; status?: unknown }[] : [];
  return ids.map(id => {
    const row = rows.find(item => item.id === id);
    return { id, code: typeof row?.code === 'string' ? row.code : null, status: typeof row?.status === 'string' ? row.status : null };
  });
}

const handoverLabel = (handovers: readonly VoucherHandover[]) => handovers.map(item => item.code ?? item.id).join(', ');
const alreadyInHandover = (handovers: readonly VoucherHandover[]) => new FinancialAlreadyRecordedError(
  `Phiếu đã chọn đã nằm trong phiên bàn giao ${handoverLabel(handovers)} (có thể do lần gửi trước). Mở danh sách phiên để kiểm tra; tải lại danh sách phiếu chưa bàn giao trước khi lập phiên mới.`,
  handovers.map(item => item.code ?? item.id),
);

/**
 * Lập phiên bàn giao tiền (cách A, đợt 4). `create_cash_handover` (production, md5 e88b4358…) khoá các phiếu
 * `FOR UPDATE` TRƯỚC khi đòi `handover_id IS NULL` cho từng phiếu, nên gửi lại một tập phiếu, kể cả khi lệnh cũ còn
 * chạy, không thể đưa một phiếu vào hai phiên (lần sau P0001). Vì vậy dấu của lần gửi trước luôn kết luận được:
 * phiếu đang chọn đã nằm trong phiên ⇒ báo mã phiên, không gửi; dấu đã nhận mã phiên ⇒ báo phiên đó; còn lại ⇒ gửi lại
 * ngay. Dấu khoá chung của bản trước (`new`, không tên thao tác) đi đúng đường này nên không chặn phiên khác.
 */
export const useCreateHandover = () => {
  const invalidate = useInvalidateHandover();
  const guard = useRef(persistentFinancialWorkflow('handover-create',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (args: { receiverId: string; voucherIds: string[]; note?: string }) => {
      const voucherIds = [...new Set(args.voucherIds)];
      // Đọc trước khi ghi dấu: lỗi đọc (hết phiên, mất mạng) không để lại dấu nào.
      const taken = await readVoucherHandovers(voucherIds);
      return guard.current.run('new', 'lập phiên bàn giao tiền', async () => {
      if (taken.length) throw alreadyInHandover(taken);
      const { data, error } = await supabase.rpc('create_cash_handover', {
        p_receiver_id: args.receiverId,
        p_voucher_ids: voucherIds,
        p_note: args.note ?? undefined,
      });
      // Ném NGUYÊN error (PostgrestError có .code) — new Error(error.message)
      // làm rơi code, friendlyError hết nhận diện được 55000/42501.
      if (error) {
        // P0001 «phiếu không hợp lệ / đã nằm trong phiên khác»: lệnh cũ vừa chạy xong trước lần gửi này. Đọc lại để báo
        // đúng mã phiên thay cho câu chung; đọc hỏng thì giữ lỗi gốc.
        if (String((error as {code?:unknown}).code ?? '') === 'P0001') {
          let now: VoucherHandover[] = [];
          try { now = await readVoucherHandovers(voucherIds); } catch { /* đọc lại hỏng: báo lỗi gốc của máy chủ */ }
          if (now.length) throw alreadyInHandover(now);
        }
        throw error;
      }
      const value = data as {id?:unknown;code?:unknown;total_amount?:unknown;voucher_count?:unknown} | null;
      if (!value || typeof value.id !== 'string' || !value.id || typeof value.code !== 'string' || typeof value.total_amount !== 'number' || !Number.isFinite(value.total_amount) || !Number.isInteger(value.voucher_count) || value.voucher_count!==new Set(args.voucherIds).size) throw new FinancialWorkflowError('Chưa xác nhận được kết quả lập phiên bàn giao. Đối chiếu các phiếu đã chọn trước khi lập lại.', 'unknown', typeof value?.id === 'string' ? [{id:value.id,label:'Phiên cần đối chiếu'}] : []);
      return data as {
        id: string;
        code: string;
        total_amount: number;
        gross_amount?: number;
        expense_amount?: number;
        voucher_count: number;
      };
      }, async pending => {
        // Phiếu đang chọn đã nằm trong phiên: lần trước (hoặc ai đó) đã lập. Báo mã phiên, không gửi lần mới.
        if (taken.length) return { outcome: 'already-written', message: alreadyInHandover(taken).message, recordIds: taken.map(item => item.code ?? item.id) };
        // Dấu cũ đã nhận mã phiên từ máy chủ: phiên đó có thật. Báo một lần rồi gỡ dấu; lần bấm sau là lượt mới.
        if (pending.completedIds.length) {
          const codes = await handoverCodes(pending.completedIds);
          return { outcome: 'already-written', message: `Lần gửi trước đã lập phiên bàn giao ${codes.join(', ')}. Mở danh sách phiên để kiểm tra trước khi lập thêm.`, recordIds: codes };
        }
        // Phiếu đang chọn còn trống: máy chủ khoá phiếu rồi mới xét `handover_id`, nên gửi lại ngay không thể đưa
        // phiếu nào vào hai phiên, kể cả khi lệnh cũ vẫn đang chạy hoặc dấu là của một tập phiếu khác.
        return { outcome: 'not-written', serverDedupesRequestKey: true };
      });
    },
    onSuccess: invalidate,
    // Lỗi hoặc chưa rõ kết quả: tải lại danh sách phiếu để phiếu đã vào phiên không còn được chọn.
    onError: invalidate,
  });
};

/** Mã phiên (BG…) của các phiên theo id; đọc hỏng thì dùng id. */
async function handoverCodes(ids: readonly string[]): Promise<string[]> {
  try {
    const { data, error } = await supabase.from('cash_handovers').select('id, code').in('id', [...ids]);
    const rows = !error && Array.isArray(data) ? data as { id?: unknown; code?: unknown }[] : [];
    return ids.map(id => {
      const code = rows.find(row => row.id === id)?.code;
      return typeof code === 'string' && code ? code : id;
    });
  } catch {
    return [...ids];
  }
}

// ── Bốn thao tác trên một phiên (đợt 5) ──────────────────────────────────────────────────────────────────────────
// Mỗi thao tác một namespace (`handover-confirm`, `handover-cancel-request`, `handover-cancel-confirm`,
// `handover-cancel-reject`). Trước đó cả bốn chung dấu `handover-lifecycle` theo mã phiên và cùng tên thao tác, nên
// dấu cũ ở đó không cho biết là thao tác nào: nó chặn đúng phiên đó qua hộp cảnh báo (`legacy`).
// Cách C: thân hàm production (25/11/2026) confirm_cash_handover, request_cancel_handover, confirm_cancel_handover,
// reject_cancel_handover đều khoá phiên FOR UPDATE rồi mới xét trạng thái và báo lỗi rõ (P0001) khi phiên đã đổi, nên
// gửi lại không ghi hai lần. Trình duyệt đọc trạng thái phiên trước khi ghi dấu; lần bấm sau so lại.
interface HandoverState { id: string; code: string | null; status: string | null; cancelRequestedBy: string | null; cancelRequestedAt: string | null }
async function readHandoverState(handoverId: string): Promise<HandoverState | null> {
  const { data, error } = await supabase.from('cash_handovers').select('id, code, status, cancel_requested_by, cancel_requested_at').eq('id', handoverId).maybeSingle();
  if (error) throw error;
  const row = data as { id?: unknown; code?: unknown; status?: unknown; cancel_requested_by?: unknown; cancel_requested_at?: unknown } | null;
  if (!row || row.id !== handoverId) return null;
  const text = (value: unknown) => typeof value === 'string' && value ? value : null;
  return { id: handoverId, code: text(row.code), status: text(row.status), cancelRequestedBy: text(row.cancel_requested_by), cancelRequestedAt: text(row.cancel_requested_at) };
}
const handoverSignature = (row: HandoverState) => [row.status, row.cancelRequestedBy, row.cancelRequestedAt].map(value => value ?? '').join('|');
const HANDOVER_STATUS: Record<string, string> = { PENDING: 'Chờ nhận', CONFIRMED: 'Đã nhận', CANCELLED: 'Đã huỷ' };
const handoverStateLabel = (row: HandoverState) => `${HANDOVER_STATUS[row.status ?? ''] ?? row.status ?? 'không rõ'}${row.cancelRequestedBy && row.status !== 'CANCELLED' ? ', đang có yêu cầu huỷ' : ''}`;
/**
 * Hàm đối chiếu CHỈ ĐỌC của một thao tác trên phiên, dùng chung cho lần bấm và quét nền khi mở app (đợt 11). Máy chủ khoá
 * phiên rồi mới xét (`serverLocksFirst`), nên «như trước khi bấm» là `not-written` kèm `serverDedupesRequestKey`: lần bấm
 * gửi lại ngay, quét nền để nguyên dấu.
 */
const handoverTransitionReconcile = (handoverId: string, operation: string, reached: (row: HandoverState) => boolean) => async (pending: FinancialPendingRecord): Promise<PendingReconciliation<never>> => {
  const row = await readHandoverState(handoverId);
  const name = row?.code ?? handoverId;
  return transitionVerdict<never>({
    pending, current: row && handoverSignature(row), reached: !!row && reached(row), serverLocksFirst: true,
    onReached: () => ({ outcome: 'already-written', message: `Phiên ${name} đã ở trạng thái ${row ? handoverStateLabel(row) : ''}. Không gửi lại yêu cầu ${operation}.`, recordIds: [name] }),
    otherMessage: `Phiên ${name} đang ở trạng thái ${row ? handoverStateLabel(row) : ''}, đã đổi kể từ lần gửi trước. Không gửi lại yêu cầu ${operation}; tải lại danh sách phiên để kiểm tra.`,
    recordIds: [name],
  });
};
async function runHandoverTransition<T>(guard: FinancialWorkflowGuard, handoverId: string, operation: string, task: () => Promise<T>, reached: (row: HandoverState) => boolean): Promise<T> {
  // Đọc trước khi ghi dấu: lỗi đọc (hết phiên, mất mạng) không để lại dấu nào.
  const before = await readHandoverState(handoverId);
  return guard.run(handoverId, operation, task, handoverTransitionReconcile(handoverId, operation, reached), undefined, before ? { meta: beforeStateMeta(handoverSignature(before)) } : {});
}
// Tên thao tác và trạng thái đích của bốn thao tác: lần bấm và quét nền khi mở app dùng CÙNG hằng này.
const HANDOVER_TRANSITIONS = {
  'handover-confirm': { operation: 'xác nhận nhận bàn giao', reached: (row: HandoverState) => row.status === 'CONFIRMED' },
  'handover-cancel-request': { operation: 'xin huỷ phiên bàn giao', reached: (row: HandoverState) => !!row.cancelRequestedBy && row.status !== 'CANCELLED' },
  'handover-cancel-confirm': { operation: 'đồng ý huỷ phiên bàn giao', reached: (row: HandoverState) => row.status === 'CANCELLED' },
  'handover-cancel-reject': { operation: 'từ chối huỷ phiên bàn giao', reached: (row: HandoverState) => !row.cancelRequestedBy && row.status !== 'CANCELLED' },
} as const;
const HANDOVER_SWEEP_KEYS = ['cash-handovers', 'handover-vouchers', 'income-expenses', 'accounts-with-balance', 'accounts'] as const;
const handoverSweep = (transition: { operation: string; reached: (row: HandoverState) => boolean }): PendingSweepHandler => ({
  scope: 'actor', invalidate: HANDOVER_SWEEP_KEYS,
  reconcile: pending => handoverTransitionReconcile(pending.businessKey, transition.operation, transition.reached)(pending),
});
/**
 * Quét nền khi mở app (đợt 11, `src/lib/pendingSweep.ts`): bốn thao tác trên phiên (khoá nghiệp vụ = mã phiên, phạm vi
 * `actor`). Chỉ gỡ dấu khi phiên đã ở đích hoặc đã đổi hẳn; «như trước khi bấm» giữ dấu cho lần bấm gửi lại.
 */
export const HANDOVER_PENDING_SWEEP: Readonly<Record<string, PendingSweepHandler>> = {
  'handover-confirm': handoverSweep(HANDOVER_TRANSITIONS['handover-confirm']),
  'handover-cancel-request': handoverSweep(HANDOVER_TRANSITIONS['handover-cancel-request']),
  'handover-cancel-confirm': handoverSweep(HANDOVER_TRANSITIONS['handover-cancel-confirm']),
  'handover-cancel-reject': handoverSweep(HANDOVER_TRANSITIONS['handover-cancel-reject']),
};

export const useConfirmHandover = () => {
  const invalidate = useInvalidateHandover();
  const guard = useRef(persistentFinancialWorkflow('handover-confirm',{scope:'actor',legacy:'handover-lifecycle'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (args: { handoverId: string; toAccountId?: string | null }) => runHandoverTransition(guard.current, args.handoverId, HANDOVER_TRANSITIONS['handover-confirm'].operation, async () => {
      const { data, error } = await supabase.rpc('confirm_cash_handover', {
        p_handover_id: args.handoverId,
        p_to_account_id: args.toAccountId ?? undefined,
      });
      if (error) throw error;
      const value = data as {id?:unknown;code?:unknown} | null;
      if (!value || value.id !== args.handoverId || typeof value.code !== 'string') throw new FinancialWorkflowError('Chưa xác nhận được kết quả xử lý phiên bàn giao. Tải lại phiên và đối chiếu trước khi tiếp tục.', 'unknown', [{id:args.handoverId,label:'Phiên cần đối chiếu'}]);
      return data as { id: string; code: string };
    }, HANDOVER_TRANSITIONS['handover-confirm'].reached),
    onSuccess: invalidate,
  });
};

export const useRequestCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  const guard = useRef(persistentFinancialWorkflow('handover-cancel-request',{scope:'actor',legacy:'handover-lifecycle'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (args: { handoverId: string; reason: string }) => runHandoverTransition(guard.current, args.handoverId, HANDOVER_TRANSITIONS['handover-cancel-request'].operation, async () => {
      const { data, error } = await supabase.rpc('request_cancel_handover', {
        p_handover_id: args.handoverId,
        p_reason: args.reason,
      });
      if (error) throw error;
      const value = data as {id?:unknown;code?:unknown} | null;
      if (!value || value.id !== args.handoverId || typeof value.code !== 'string') throw new FinancialWorkflowError('Chưa xác nhận được kết quả xử lý phiên bàn giao. Tải lại phiên và đối chiếu trước khi tiếp tục.', 'unknown', [{id:args.handoverId,label:'Phiên cần đối chiếu'}]);
      return data as { id: string; code: string };
    }, HANDOVER_TRANSITIONS['handover-cancel-request'].reached),
    onSuccess: invalidate,
  });
};

export const useConfirmCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  const guard = useRef(persistentFinancialWorkflow('handover-cancel-confirm',{scope:'actor',legacy:'handover-lifecycle'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (args: { handoverId: string }) => runHandoverTransition(guard.current, args.handoverId, HANDOVER_TRANSITIONS['handover-cancel-confirm'].operation, async () => {
      const { data, error } = await supabase.rpc('confirm_cancel_handover', {
        p_handover_id: args.handoverId,
      });
      if (error) throw error;
      const value = data as {id?:unknown;code?:unknown} | null;
      if (!value || value.id !== args.handoverId || typeof value.code !== 'string') throw new FinancialWorkflowError('Chưa xác nhận được kết quả xử lý phiên bàn giao. Tải lại phiên và đối chiếu trước khi tiếp tục.', 'unknown', [{id:args.handoverId,label:'Phiên cần đối chiếu'}]);
      return data as { id: string; code: string };
    }, HANDOVER_TRANSITIONS['handover-cancel-confirm'].reached),
    onSuccess: invalidate,
  });
};

export const useRejectCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  const guard = useRef(persistentFinancialWorkflow('handover-cancel-reject',{scope:'actor',legacy:'handover-lifecycle'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (args: { handoverId: string }) => runHandoverTransition(guard.current, args.handoverId, HANDOVER_TRANSITIONS['handover-cancel-reject'].operation, async () => {
      const { data, error } = await supabase.rpc('reject_cancel_handover', {
        p_handover_id: args.handoverId,
      });
      if (error) throw error;
      const value = data as {id?:unknown;code?:unknown} | null;
      if (!value || value.id !== args.handoverId || typeof value.code !== 'string') throw new FinancialWorkflowError('Chưa xác nhận được kết quả xử lý phiên bàn giao. Tải lại phiên và đối chiếu trước khi tiếp tục.', 'unknown', [{id:args.handoverId,label:'Phiên cần đối chiếu'}]);
      return data as { id: string; code: string };
    }, HANDOVER_TRANSITIONS['handover-cancel-reject'].reached),
    onSuccess: invalidate,
  });
};
