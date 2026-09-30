import {normalizeDateOnly} from '@/lib/firstInvoiceBuilder';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
// Đợt 6 — Chốt sổ & bàn giao quỹ, hai bên xác nhận.
//
// ĐẶT TÊN theo trục "chốt sổ / closure", CỐ Ý KHÔNG dùng chữ "bàn giao" ở tên
// hàm/khoá cache: repo này đã có ba thứ khác mang chữ đó — `cash_handovers`
// (bàn giao THEO PHIẾU, 7 phiên đang chạy), `asset_handovers` (bàn giao tài
// sản) và `cashbooks.manage_custody` (giao/nhận quyền giữ sổ). Trộn thêm nghĩa
// thứ tư vào là người đọc code lẫn người dùng đều nhầm.
//
// Tương tự, mã lỗi mới là [CLOSURE_*]; [CASHBOOK_CLOSED] giữ nguyên nghĩa "kỳ
// đã khoá" mà src/lib/cashbookClosing.ts đã dịch sẵn từ Đợt 3.

import { useEffect, useRef } from "react";
import { rpcNullable } from "@/lib/rpcNullable";
import { batBuoc } from "@/lib/queryGuard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { FinancialWorkflowError, FinancialWorkflowGuard } from '@/lib/financialWorkflow';
import { format } from 'date-fns';

function unknownClosing(operation: string): never {
  throw new FinancialWorkflowError('Chưa xác nhận được kết quả ' + operation + '. Tải lại đề nghị và đối chiếu trước khi thực hiện tiếp.', 'unknown', []);
}
function closingRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

export interface ClosingBlocker {
  code: string;
  blocking: boolean;
  detail: string;
  count_n: number;
}

export interface PendingClosure {
  request_id: string;
  cashbook_id: string;
  cashbook_name: string;
  closed_through: string;
  counted_balance: number;
  system_balance: number;
  difference: number;
  note: string | null;
  created_at: string;
  proposed_by: string;
  proposed_by_name: string | null;
  confirmer_user_id: string;
  confirmer_name: string | null;
  is_mine_to_confirm: boolean;
}

export interface ConfirmedClosure {
  closure_id: number;
  cashbook_id: string;
  cashbook_name: string;
  closed_through: string;
  counted_balance: number;
  system_balance: number;
  difference: number;
  basis: string;
  confirmed_at: string;
  proposed_by_name: string | null;
  confirmed_by_name: string | null;
}

/**
 * PA4 — trạng thái chốt của từng sổ so với MỘT THÁNG. Đây là lưới an toàn:
 * nghi thức đã đủ chức năng nhưng prod 0 closure vì không màn nào trả lời được
 * "tháng này sổ nào chưa chốt".
 */
export interface MonthlyClosingStatus {
  cashbook_id: string;
  cashbook_name: string;
  bank_name: string | null;
  is_bank: boolean;
  closed_through: string | null;
  covered: boolean;
  has_pending_request: boolean;
  activity_count: number;
  balance_at_month_end: number | null;
  needs_closing: boolean;
  /**
   * Câu hỏi của HỆ THỐNG: có tồn tại một CẶP hai người khác nhau (một đề nghị,
   * một ký)? false = phải gán ai đó vào vai trò "Kế toán" trước, nhắc chốt là
   * vô nghĩa. Đo 30/07: org thật có 10/16 sổ thuộc loại này.
   */
  can_be_closed: boolean;
  confirmer_count: number;
  /**
   * Câu hỏi của NGƯỜI ĐANG XEM. Tách khỏi `can_be_closed` sau khi đo trên
   * trình duyệt: sổ "Hiệp Thu" chốt được (NATHAN đề nghị → chủ ký) nhưng CHỦ
   * mở hộp thoại ra thì ăn blocker NO_CONFIRMER, vì `cashbook_close_confirmers_v1`
   * loại chính người gọi và trên sổ đó chủ là người ký duy nhất.
   *
   * `i_can_propose` còn đòi ĐANG GIỮ SỔ (CUSTODIAN) — điều kiện thật của
   * `propose_cashbook_closing_v1`. Chỉ hiện nút "Chốt sổ" khi cờ này bật.
   */
  i_can_propose: boolean;
  i_can_confirm: boolean;
}

/** Mọi thứ đọc được đều đổi sau một lần chốt — gom một chỗ để khỏi sót. */
const CLOSING_KEYS = [
  ["cashbook-closings"],
  ["cashbook-closing-blockers"],
  ["cashbook-closing-monthly"],
  ["accounts-with-balance"],
  ["accounts"],
  ["cash-book-summary"],
  ["cash-flow-by-day"],
  ["settlement-report"],
  ["income-expenses"],
];

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of CLOSING_KEYS) qc.invalidateQueries({ queryKey: key });
}

/** Còn vướng gì trước khi chốt. blocking=false là nhắc nhở, không chặn. */
export const useClosingBlockers = (cashbookId: string | null | undefined) =>
  useQuery({
    meta: { feedback: "inline" },
    queryKey: ["cashbook-closing-blockers", cashbookId],
    enabled: !!cashbookId,
    // Không cache lâu: người dùng vừa đi duyệt phiếu xong quay lại là phải thấy sạch.
    staleTime: 0,
    queryFn: async (): Promise<ClosingBlocker[]> => {
      const { data, error } = await supabase.rpc("cashbook_closing_blockers_v1", {
        p_cashbook: rpcNullable(cashbookId),
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid closing blockers response');
      return data as ClosingBlocker[];
    },
  });

/** Số dư theo posting-truth tới một ngày — CÙNG cơ sở với con số sẽ đóng băng. */
export const useCashbookBalanceAsOf = (
  cashbookId: string | null | undefined,
  asOf?: string | null,
) =>
  useQuery({
    meta: { feedback: "inline" },
    queryKey: ["cashbook-balance-as-of", cashbookId, asOf ?? null],
    enabled: !!cashbookId,
    staleTime: 0,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase.rpc("cashbook_balance_as_of_v1", {
        p_cashbook: rpcNullable(cashbookId),
        p_as_of: asOf ?? undefined,
      });
      if (error) throw error;
      if (typeof data !== 'number' || !Number.isFinite(data)) throw new Error('Invalid cashbook balance response');
      return Number(data);
    },
  });

/**
 * Sổ nào chưa chốt tới hết tháng `month` (chuỗi `YYYY-MM-DD`, ngày nào trong
 * tháng cũng được — server tự `date_trunc`).
 *
 * RPC khai VOLATILE vì gọi `authorize_tenant_action_v3` (bên trong có
 * `FOR SHARE`); hàm ĐỌC khai STABLE mà lấy khoá dòng là chết câm qua PostgREST
 * (`25006`) — án lệ `profit_close_state_v2` hỏng 10 ngày.
 */
export const useCashbookMonthlyClosingStatus = (
  organizationId: string | null | undefined,
  month: string | null | undefined,
) =>
  useQuery({
    meta: { feedback: "inline" },
    queryKey: ["cashbook-closing-monthly", organizationId ?? null, month ?? null],
    enabled: !!organizationId && !!month,
    // Mỗi dòng là một lượt gọi atav3 × số thành viên — không rẻ. Panel không cần
    // tươi từng giây, người dùng vừa chốt xong thì CLOSING_KEYS đã invalidate.
    staleTime: 120_000,
    queryFn: async (): Promise<MonthlyClosingStatus[]> => {
      const { data, error } = await supabase.rpc(
        "cashbook_closing_monthly_status_v1",
        {
          p_organization_id: batBuoc(organizationId, "organizationId"),
          p_month: batBuoc(month, "month"),
        },
      );
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid monthly closing response');
      return data as MonthlyClosingStatus[];
    },
  });

export const useCashbookClosings = (cashbookId?: string | null) =>
  useQuery({
    meta: { feedback: "inline" },
    queryKey: ["cashbook-closings", cashbookId ?? null],
    // Đề nghị chốt do NGƯỜI KHÁC tạo. Mặc định toàn app là staleTime 60s +
    // refetchOnWindowFocus:false (App.tsx), nên người ký đứng sẵn trên trang sẽ
    // KHÔNG BAO GIỜ thấy đề nghị mới. Đây đúng là chỗ nghi thức đối soát thế hệ
    // 1 chết. Đường chính vẫn là thông báo E6b; poll là lưới thứ hai.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<{ pending: PendingClosure[]; closures: ConfirmedClosure[] }> => {
      const { data, error } = await supabase.rpc("list_cashbook_closings_v1", {
        p_cashbook: cashbookId ?? undefined,
      });
      if (error) throw error;
      const value = closingRecord(data);
      if (!Array.isArray(value.pending) || !Array.isArray(value.closures)) throw new Error('Invalid closings response');
      return data as unknown as {
        pending: PendingClosure[];
        closures: ConfirmedClosure[];
      };
    },
  });

/**
 * Ai đủ tư cách NHẬN bàn giao sổ này (đã loại chính mình).
 * Hỏi server chứ không lọc ở client: quyền phụ thuộc cạnh phạm vi theo TỪNG SỔ,
 * client không có đủ dữ liệu để suy ra.
 */
export const useCashbookCloseConfirmers = (cashbookId: string | null | undefined) =>
  useQuery({
    meta: { feedback: "inline" },
    queryKey: ["cashbook-close-confirmers", cashbookId],
    enabled: !!cashbookId,
    staleTime: 60_000,
    queryFn: async (): Promise<Array<{ user_id: string; full_name: string | null }>> => {
      const { data, error } = await supabase.rpc("cashbook_close_confirmers_v1", {
        p_cashbook: rpcNullable(cashbookId),
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid closing confirmers response');
      return data as Array<{ user_id: string; full_name: string | null }>;
    },
  });

export interface ProposeClosingInput {
  cashbookId: string;
  cashbookName?: string | null;
  countedBalance: number;
  confirmerUserId: string;
  note?: string | null;
}

export const useProposeCashbookClosing = () => {
  const qc = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('closing-propose',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (input: ProposeClosingInput) => guard.current.run(input.cashbookId, 'gửi đề nghị chốt sổ', async () => {
      const { data, error } = await supabase.rpc('propose_cashbook_closing_v1', {
        p_cashbook: input.cashbookId, p_counted_balance: input.countedBalance,
        p_confirmer: input.confirmerUserId, p_note: input.note ?? undefined,
      });
      if (error) throw error;
      const value = closingRecord(data);
      if (typeof value.request_id !== 'string' || !value.request_id || value.cashbook_id!==input.cashbookId || value.status !== 'PENDING') unknownClosing('gửi đề nghị chốt sổ');
      return value;
    }),
    onSuccess: (_res, input) => {
      invalidateAll(qc);
      toast.success('Đã gửi đề nghị chốt sổ ' + (input.cashbookName || '') + '. Đang chờ người nhận xác nhận.');
    },
  });
};

export const useConfirmCashbookClosing = () => {
  const qc = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('closing-request-lifecycle',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (input: { requestId: string; countedBalance: number; cashbookName?: string }) => guard.current.run(input.requestId, 'xác nhận chốt sổ', async () => {
      const { data, error } = await supabase.rpc('confirm_cashbook_closing_v1', {
        p_request: input.requestId, p_counted_balance: input.countedBalance,
      });
      if (error) throw error;
      const value = closingRecord(data);
      if (value.request_id!==input.requestId || !Number.isSafeInteger(value.closure_id) || Number(value.closure_id)<=0 || value.status !== 'CONFIRMED' || typeof value.closed_through !== 'string' || normalizeDateOnly(value.closed_through)!==value.closed_through) unknownClosing('xác nhận chốt sổ');
      return value as {closed_through: string; closure_id: number};
    }),
    onSuccess: (res, input) => {
      invalidateAll(qc);
      toast.success('Đã chốt sổ ' + (input.cashbookName || '') + ' đến ngày ' + format(new Date(res.closed_through), 'dd/MM/yyyy') + '. Các giao dịch đến ngày này đã khóa.');
    },
  });
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deep-link `/finance/cashbooks?close=<cashbook_id>` (thông báo E6a) và
 * `?confirm=<request_id>` (E6b).
 *
 * Dùng ở CẢ hai trang: `CashbooksPage` (desktop) và `CashbooksMobilePage` —
 * trang cha rẽ nhánh theo `usePhoneViewport` nên chỉ nối một bên là điện thoại
 * bấm thông báo xong nằm im.
 *
 * Xoá param sau khi xử lý (`replace: true`) để F5 không bật lại dialog, và giữ
 * `handledRef` để lần render kế tiếp không mở hai lần. Cùng khuôn với deep-link
 * `?handover=` ở ThuTien.tsx.
 */
export function useCashbookClosingDeepLink(handlers: {
  onClose?: (cashbookId: string) => void;
  onConfirm?: (requestId: string) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const handledRef = useRef<string | null>(null);
  const { onClose, onConfirm } = handlers;

  useEffect(() => {
    const closeId = searchParams.get("close");
    const confirmId = searchParams.get("confirm");
    const raw = closeId ?? confirmId;
    if (!raw) {
      handledRef.current = null;
      return;
    }
    if (handledRef.current === raw) return;
    handledRef.current = raw;

    // Chuỗi rác thì chỉ dọn URL, không mở gì — allow-list thông báo đã lọc một
    // lần nhưng người dùng vẫn có thể tự dán tay.
    if (UUID_RE.test(raw)) {
      if (closeId) onClose?.(closeId);
      else if (confirmId) onConfirm?.(confirmId);
    }

    const next = new URLSearchParams(searchParams);
    next.delete("close");
    next.delete("confirm");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, onClose, onConfirm]);
}

export const useCancelCashbookClosing = () => {
  const qc = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('closing-request-lifecycle',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (input: { requestId: string; reason: string; cashbookName?: string }) => guard.current.run(input.requestId, 'hủy đề nghị chốt sổ', async () => {
      const { data, error } = await supabase.rpc('cancel_cashbook_closing_v1', {
        p_request: input.requestId, p_reason: input.reason,
      });
      if (error) throw error;
      const value = closingRecord(data);
      if (value.request_id !== input.requestId || typeof value.changed !== 'boolean' || (value.changed && value.status !== 'CANCELLED')) unknownClosing('hủy đề nghị chốt sổ');
      return value;
    }),
    onSuccess: (res, input) => {
      invalidateAll(qc);
      if (!res.changed) toast.info('Đề nghị chốt sổ ' + (input.cashbookName || '') + ' đã thay đổi trước đó. Danh sách đang được cập nhật.');
      else toast.success('Đã hủy đề nghị chốt sổ ' + (input.cashbookName || '') + '.');
    },
  });
};
