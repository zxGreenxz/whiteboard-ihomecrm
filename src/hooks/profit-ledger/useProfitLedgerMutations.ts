// Hook GHI của sổ tổng lợi nhuận cổ đông (Đợt 2): E5 lập phiếu chi · E6 huỷ phiếu · E9 đặt/gỡ mốc ·
// E16 xác nhận phần lợi nhuận trong phiếu lương.
//
// KHOÁ CHỐNG GỬI TRÙNG: mỗi lượt bấm chạy qua persistentFinancialWorkflow(…, {scope:'target'}) gắn
// công ty CỦA CHỦ THỂ; `progress.requestKey` (UUID) là `p_idempotency_key`.
//   - Máy chủ bận ở tầng khoá (40P01/40001/55P03): tự gửi lại CÙNG khoá trong cùng lượt (busyRetry).
//   - Chưa rõ kết quả (mất mạng, biên nhận hỏng): luồng giữ dấu chờ đối chiếu và KHOÁ gửi lại; lần
//     bấm sau đi đường đối chiếu: gửi lại ĐÚNG khoá cũ (các lệnh này idempotent: cùng khoá + cùng nội
//     dung ⇒ máy chủ trả y hệt kết quả cũ). Khác nội dung ⇒ 23505 ⇒ vẫn khoá, người dùng phải đối chiếu.
//   - Từ chối chắc chắn (22023, 42501, 55000, PT409…): giao dịch đã lùi, lần bấm sau dùng khoá mới.
// Hook KHÔNG tự toast: hộp thoại đọc lỗi bằng profitLedgerErrorMessage và tự hiện câu tại chỗ.

import { useRef } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { readCreatedVoucherReceipt } from '@/lib/createdVoucherReceipt';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { rpcNullable } from '@/lib/rpcNullable';
import { withBusyRetry, type RpcResponse } from '@/lib/profitLedger/busyRetry';
import {
  readLedgerCancelResult, readLedgerPayoutResult, readMarkerResult, readSalaryResolveResult,
  type LedgerCancelResult, type LedgerPayoutResult, type MarkerResult, type SalaryResolveResult,
} from '@/lib/profitLedger/actionReaders';
import type { ProfitLedgerSubjectKind } from '@/lib/profitLedger/sharedReaders';
import type { ProfitCancelExpectedState } from '@/lib/profitLedger/vouchers';

const CANCEL_EXPECTED_STATES: readonly ProfitCancelExpectedState[] = ['PENDING', 'APPROVED_UNPOSTED', 'POSTED'];

/**
 * Mọi khoá màn hình đọc từ sổ tổng hoặc từ phiếu mà sổ tổng chạm. Gọi sau MỌI thao tác ghi của sổ
 * tổng (chi, huỷ, mốc, xác nhận lương) VÀ của các luồng làm số dư đổi: chốt / mở khoá / đặt lại lợi
 * nhuận tháng, chốt / mở chốt / trả lương — bước 2 nối vào các mutation đó.
 * (Khớp theo phần tử ĐẦU của khoá: liệt kê từng gốc, `['profit-ledger']` không phủ `['profit-ledger-entries']`.)
 */
export const PROFIT_LEDGER_INVALIDATE_KEYS = [
  ['profit-ledger'],
  ['profit-ledger-entries'],
  ['profit-ledger-payout'],
  ['profit-ledger-marker-preview'],
  ['profit-payout-preview'],
  ['my-profit-ledger'],
  ['profit-manager-ledger'],
  ['manager-ledger-payouts'],
  ['profit-unlock-salary-impact'],
  ['income-expenses'],
  ['income-expense'],
  ['voucher-with-batch'],
  ['accounts-with-balance'],
  ['pending-approvals'],
  ['manager-salary'],
  ['cash-flow-by-day'],
  ['shareholder-distributions'],
  ['manager-salary-payouts'],
] as const;

export function invalidateProfitLedgerQueries(queryClient: QueryClient): void {
  for (const key of PROFIT_LEDGER_INVALIDATE_KEYS) void queryClient.invalidateQueries({ queryKey: key });
}

function requireId(value: string | null | undefined, message: string): string {
  if (typeof value !== 'string' || !value) throw new FinancialWorkflowError(message, 'failure', []);
  return value;
}

/**
 * Chạy một lệnh ghi idempotent của sổ tổng trong luồng chống gửi trùng.
 * `call(key)` dựng lời gọi RPC với đúng khoá; `read` đọc biên nhận (lệch hợp đồng ⇒ ném TypeError ⇒
 * "chưa rõ kết quả").
 */
async function runLedgerWrite<T>(options: {
  workflow: ReturnType<typeof persistentFinancialWorkflow>;
  businessKey: string;
  operation: string;
  organizationId: string;
  call: (idempotencyKey: string) => PromiseLike<RpcResponse>;
  read: (data: unknown) => Promise<T> | T;
  receiptId: (result: T) => string;
  receiptLabel: string;
}): Promise<T> {
  const { workflow, call, read } = options;
  return workflow.run(
    options.businessKey,
    options.operation,
    async (progress) => {
      const { data, error } = await withBusyRetry(() => call(progress.requestKey));
      if (error) throw error;
      const result = await read(data);
      progress.completed.push({ id: options.receiptId(result), label: options.receiptLabel });
      return result;
    },
    // Đối chiếu lần trước chưa rõ kết quả: gửi lại ĐÚNG khoá cũ. Lỗi ⇒ chưa chứng minh được gì:
    // ném lỗi lên FinancialWorkflowGuard — ở lượt đối chiếu nó giữ nguyên dấu chờ đối chiếu
    // (kết quả "unknown", không xoá dấu) y như khi trả null, nhưng giữ được nguyên nhân thật.
    async (_pending, progress) => {
      const { data, error } = await withBusyRetry(() => call(progress.requestKey));
      if (error) throw error;
      return { result: await read(data) };
    },
    options.organizationId,
  );
}

/* ───────────────────────────── E5 lập phiếu chi lợi nhuận cổ đông ───────────────────────────── */

export interface CreateProfitLedgerPayoutInput {
  /** Công ty của cổ đông. */
  organizationId: string;
  shareholderId: string;
  amount: number;
  /** Sổ quỹ TIỀN THẬT của công ty (SELF_ADVANCE: sổ đang giữ). */
  accountId: string;
  voucherDate: string;
  /** Ghi chú; khi có tạm ứng đây là "lý do tạm ứng" (8..500). */
  note: string | null;
  /** Đã tick "tôi xác nhận tạm ứng" (chỉ bật khi có phần tạm ứng). */
  allowAdvance: boolean;
}

export interface CreateProfitLedgerPayoutResult extends LedgerPayoutResult {
  /** Mã phiếu (đọc lại sau khi lập; đọc hỏng ⇒ null, không phải lỗi ghi). */
  code: string | null;
}

export function useCreateProfitLedgerPayout() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-payout', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: CreateProfitLedgerPayoutInput): Promise<CreateProfitLedgerPayoutResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của cổ đông. Tải lại rồi lập phiếu.');
      const shareholderId = requireId(input.shareholderId, 'Chọn cổ đông nhận khoản chi.');
      return runLedgerWrite({
        workflow: workflow.current,
        businessKey: `shareholder:${shareholderId}`,
        operation: 'lập phiếu chi lợi nhuận',
        organizationId,
        call: (key) => supabase.rpc('shareholder_profit_ledger_payout_v1', {
          p_shareholder_id: shareholderId,
          p_amount: input.amount,
          p_account_id: input.accountId,
          p_voucher_date: input.voucherDate,
          // Không có DEFAULT nhưng nhận NULL (không ghi chú).
          p_note: rpcNullable(input.note?.trim() || null),
          p_allow_advance: input.allowAdvance,
          p_idempotency_key: key,
        }),
        read: async (data) => {
          const result = readLedgerPayoutResult(data, { shareholderId, amount: input.amount });
          const receipt = await readCreatedVoucherReceipt({ voucher_id: result.voucher_id });
          return { ...result, code: receipt.code || null };
        },
        receiptId: (result) => result.voucher_id,
        receiptLabel: 'Phiếu chi lợi nhuận đã lập',
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}

/* ───────────────────────────── E6 huỷ phiếu chi theo sổ tổng ───────────────────────────── */

export interface CancelProfitLedgerPayoutInput {
  voucherId: string;
  /** Công ty của phiếu. */
  organizationId: string;
  /** 8..1000 ký tự (máy chủ cắt khoảng trắng). */
  reason: string;
  /** Trạng thái phiếu ĐANG HIỆN lúc bấm (expectedCancelState) — LUÔN gửi; phiếu đổi ⇒ PT409. */
  expectedState: ProfitCancelExpectedState;
}

export function useCancelProfitLedgerPayout() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-cancel', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: CancelProfitLedgerPayoutInput): Promise<LedgerCancelResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của phiếu. Tải lại phiếu rồi huỷ.');
      const voucherId = requireId(input.voucherId, 'Chưa xác định được phiếu cần huỷ.');
      const expectedState = input.expectedState;
      // Không bao giờ gửi kỳ vọng rỗng/lạ: thiếu kỳ vọng thì máy chủ huỷ không so trạng thái (đường cũ).
      if (!CANCEL_EXPECTED_STATES.includes(expectedState)) {
        throw new FinancialWorkflowError('Chưa xác định được trạng thái phiếu. Tải lại phiếu rồi huỷ.', 'failure', []);
      }
      return runLedgerWrite({
        workflow: workflow.current,
        businessKey: `voucher:${voucherId}`,
        operation: 'huỷ phiếu chi',
        organizationId,
        call: (key) => supabase.rpc('profit_ledger_payout_cancel_v1', {
          p_voucher_id: voucherId,
          p_reason: input.reason.trim(),
          p_idempotency_key: key,
          p_expected_state: expectedState,
        }),
        read: (data) => readLedgerCancelResult(data, voucherId),
        receiptId: (result) => result.voucher_id,
        receiptLabel: 'Phiếu đã huỷ',
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}

/* ───────────────────────────── E9 đặt / đè / gỡ mốc đã trả đủ ───────────────────────────── */

export interface SetProfitLedgerMarkerInput {
  organizationId: string;
  subjectKind: ProfitLedgerSubjectKind;
  subjectId: string;
  /** 'YYYY-MM-01' của tháng đã qua; null = gỡ mốc. */
  settledThroughMonth: string | null;
  reason: string;
  /** = current_marker.id của lần xem trước (E8); null khi chủ thể chưa từng có dòng mốc. */
  expectedMarkerId: string | null;
  /** Bắt buộc true khi xem trước báo advance_erased > 0. */
  acknowledgeAdvanceErase: boolean;
}

export function useSetProfitLedgerMarker() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-marker', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: SetProfitLedgerMarkerInput): Promise<MarkerResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty. Tải lại rồi đặt mốc.');
      const subjectId = requireId(input.subjectId, 'Chưa xác định được người cần đặt mốc.');
      return runLedgerWrite({
        workflow: workflow.current,
        businessKey: `${input.subjectKind}:${subjectId}`,
        operation: 'đặt mốc đã trả đủ',
        organizationId,
        call: (key) => supabase.rpc('profit_ledger_set_marker_v1', {
          p_organization_id: organizationId,
          p_subject_kind: input.subjectKind,
          p_subject_id: subjectId,
          // Không có DEFAULT nhưng nhận NULL: tháng NULL = gỡ mốc; id NULL = chưa từng có mốc.
          p_settled_through_month: rpcNullable(input.settledThroughMonth),
          p_reason: input.reason.trim(),
          p_expected_marker_id: rpcNullable(input.expectedMarkerId),
          p_acknowledge_advance_erase: input.acknowledgeAdvanceErase,
          p_idempotency_key: key,
        }),
        read: (data) => readMarkerResult(data, { settledThroughMonth: input.settledThroughMonth }),
        receiptId: (result) => result.marker_id,
        receiptLabel: 'Mốc đã ghi',
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}

/* ───────────────────────────── E16 xác nhận phần lợi nhuận của phiếu lương ───────────────────────────── */

export interface ResolveSalaryProfitLineInput {
  /** Công ty của dòng phiếu lương. */
  organizationId: string;
  lineId: string;
  /** Y: phần đầu tư (cùng dấu phần còn lại của tháng; tháng lỗ thì âm). */
  investment: number;
  /** D: phần bù tạm ứng (≥ 0). */
  offset: number;
  reason: string;
}

export function useResolveSalaryProfitLine() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-salary-resolve', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: ResolveSalaryProfitLineInput): Promise<SalaryResolveResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của phiếu lương. Tải lại rồi xác nhận.');
      const lineId = requireId(input.lineId, 'Chưa xác định được dòng phiếu lương cần xác nhận.');
      return runLedgerWrite({
        workflow: workflow.current,
        businessKey: `line:${lineId}`,
        operation: 'xác nhận phần lợi nhuận trong phiếu lương',
        organizationId,
        call: (key) => supabase.rpc('profit_ledger_salary_resolve_v1', {
          p_line_id: lineId,
          p_investment_amount: input.investment,
          p_advance_offset_amount: input.offset,
          p_reason: input.reason.trim(),
          p_idempotency_key: key,
        }),
        read: (data) => readSalaryResolveResult(data, lineId),
        receiptId: (result) => result.line_id,
        receiptLabel: 'Dòng phiếu lương đã xác nhận',
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}
