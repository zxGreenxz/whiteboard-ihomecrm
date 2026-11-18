// Hook GHI của sổ tổng lợi nhuận cổ đông: W1 lập phiếu tạm ứng · W2 chốt chi lợi nhuận đến hết tháng N ·
// W3 huỷ lần chốt không có phiếu tiền · E6 huỷ phiếu · E9 đặt/gỡ mốc ·
// E16 xác nhận phần lợi nhuận trong phiếu lương.
// (E5 `shareholder_profit_ledger_payout_v1` — lập phiếu chi theo số tiền nhập tay — web không còn gọi từ 18/11/2026.)
//
// KHOÁ CHỐNG GỬI TRÙNG: mỗi lượt bấm chạy qua persistentFinancialWorkflow(…, {scope:'target'}) gắn
// công ty CỦA CHỦ THỂ; `progress.requestKey` (UUID) là `p_idempotency_key`.
//   - Máy chủ bận ở tầng khoá (40P01/40001/55P03): tự gửi lại CÙNG khoá trong cùng lượt (busyRetry).
//   - Chưa rõ kết quả (mất mạng, biên nhận hỏng): luồng giữ dấu chờ đối chiếu và KHOÁ gửi lại; lần
//     bấm sau đi đường đối chiếu: gửi lại ĐÚNG khoá cũ (các lệnh này idempotent: cùng khoá + cùng nội
//     dung ⇒ máy chủ trả y hệt kết quả cũ). Khác nội dung (vd đã tải lại trang rồi nhập khác) ⇒ 23505
//     "khoá đã dùng" của CHÍNH lệnh ⇒ lần trước ĐÃ ghi: xoá dấu chờ, ném ProfitLedgerPriorWrittenError
//     ("đã ghi, tải lại để xem"), lần bấm sau là lệnh mới với khoá mới. Lỗi khác ⇒ vẫn khoá.
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
  readLedgerCancelResult, readMarkerResult, readSalaryResolveResult,
  type LedgerCancelResult, type MarkerResult, type SalaryResolveResult,
} from '@/lib/profitLedger/actionReaders';
import {
  readAdvanceResult, readSettleResult, readSettlementVoidResult,
  type AdvanceResult, type SettleResult, type SettlementVoidResult,
} from '@/lib/profitLedger/positionReaders';
import {
  isLedgerIdempotencyConflict, ProfitLedgerPriorWrittenError, type ProfitLedgerWriteOperation,
} from '@/lib/profitLedger/errors';
import type { ProfitLedgerSubjectKind } from '@/lib/profitLedger/sharedReaders';
import type { ProfitCancelExpectedState } from '@/lib/profitLedger/vouchers';

const CANCEL_EXPECTED_STATES: readonly ProfitCancelExpectedState[] = ['PENDING', 'APPROVED_UNPOSTED', 'POSTED'];

/**
 * Mọi khoá màn hình đọc từ sổ tổng hoặc từ phiếu mà sổ tổng chạm. Gọi sau MỌI thao tác ghi của sổ
 * tổng (tạm ứng, chốt, huỷ, mốc, xác nhận lương) VÀ của các luồng làm số dư đổi: chốt / mở khoá / đặt lại
 * lợi nhuận tháng, chốt / mở chốt / trả lương — bước 2 nối vào các mutation đó.
 * (Khớp theo phần tử ĐẦU của khoá: liệt kê từng gốc, `['profit-ledger']` không phủ `['profit-ledger-entries']`.)
 */
export const PROFIT_LEDGER_INVALIDATE_KEYS = [
  ['profit-ledger'],
  ['profit-ledger-entries'],
  ['profit-ledger-payout'],
  ['profit-ledger-marker-preview'],
  ['profit-positions'],
  ['my-profit-position'],
  ['profit-advance-options'],
  ['profit-advance-preview'],
  ['profit-settlement-preview'],
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

/** Kết quả nội bộ của lượt đối chiếu: lần gửi trước ĐÃ ghi nhưng không có biên nhận để trả. */
const PRIOR_WRITTEN: unique symbol = Symbol('profit-ledger-prior-written');

/**
 * Kết quả nội bộ của lượt đối chiếu: máy chủ trả một từ chối CHỨNG MINH lần gửi trước CHƯA ghi (và lần này cũng
 * không ghi). Mang theo lỗi gốc để ném lại cho hộp thoại sau khi dấu chờ đã được xoá.
 */
class ProvenNotWritten {
  constructor(readonly error: unknown) {}
}

/**
 * Hai từ chối của lệnh chốt (W2) chứng minh "chưa ghi": PT409 `PROFIT_LEDGER_SETTLE_CHANGED` (số liệu vừa đổi) và
 * 22023 `PROFIT_LEDGER_SETTLE_NOTHING` (không còn gì để chốt). Máy chủ xét khoá chống gửi trùng TRƯỚC hai phép
 * kiểm này (migration 20261118041911, bước 4 rồi mới bước 6): lần gửi trước mà đã ghi thì cùng khoá đã trả biên
 * nhận cũ (cùng nội dung) hoặc 23505 (khác nội dung) trước khi tới đây. Tới được đây rồi bị từ chối ⇒ cả giao
 * dịch lùi, chưa có gì được ghi — kể cả ở lần gửi trước. Chỉ nhận hai mã có ĐÚNG MỘT chỗ ném sau bước xét khoá
 * (mã tháng `…_SETTLE_MONTH` còn một chỗ ném TRƯỚC bước đó nên không dùng làm bằng chứng).
 */
function settleRejectionProvesNotWritten(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as { code?: unknown; message?: unknown };
  if (typeof row.message !== 'string') return false;
  if (row.code === 'PT409') return /^PROFIT_LEDGER_SETTLE_CHANGED\s*:/.test(row.message);
  if (row.code === '22023') return /^PROFIT_LEDGER_SETTLE_NOTHING\s*:/.test(row.message);
  return false;
}

/**
 * Chạy một lệnh ghi idempotent của sổ tổng trong luồng chống gửi trùng.
 * `call(key)` dựng lời gọi RPC với đúng khoá; `read` đọc biên nhận (lệch hợp đồng ⇒ ném TypeError ⇒
 * "chưa rõ kết quả"); `kind` chọn đúng câu 23505 "khoá đã dùng" của lệnh này.
 */
async function runLedgerWrite<T>(options: {
  workflow: ReturnType<typeof persistentFinancialWorkflow>;
  kind: ProfitLedgerWriteOperation;
  businessKey: string;
  operation: string;
  organizationId: string;
  call: (idempotencyKey: string) => PromiseLike<RpcResponse>;
  read: (data: unknown) => Promise<T> | T;
  receiptId: (result: T) => string;
  receiptLabel: string;
  /**
   * Chỉ cho lượt ĐỐI CHIẾU: từ chối này của máy chủ chứng minh lần gửi trước chưa ghi gì ⇒ xoá dấu chờ, ném lại
   * đúng lỗi đó (hộp thoại gỡ khoá, tải lại số). Vắng ⇒ mọi lỗi khác 23505-khoá-đã-dùng đều giữ dấu chờ.
   * Hẹp theo từng lệnh — không đổi hành vi chung của FinancialWorkflowGuard cho các luồng tiền khác.
   */
  provesNotWritten?: (error: unknown) => boolean;
}): Promise<T> {
  const { workflow, call, read } = options;
  const outcome = await workflow.run<T | typeof PRIOR_WRITTEN | ProvenNotWritten>(
    options.businessKey,
    options.operation,
    async (progress) => {
      const { data, error } = await withBusyRetry(() => call(progress.requestKey));
      if (error) throw error;
      const result = await read(data);
      progress.completed.push({ id: options.receiptId(result), label: options.receiptLabel });
      return result;
    },
    // Đối chiếu lần trước chưa rõ kết quả: gửi lại ĐÚNG khoá cũ.
    async (_pending, progress) => {
      const { data, error } = await withBusyRetry(() => call(progress.requestKey));
      if (error) {
        // 23505 "khoá đã dùng với nội dung khác" của CHÍNH lệnh này: dòng chống gửi trùng chỉ còn khi lần
        // trước ĐÃ ghi xong ⇒ đối chiếu xong. Trả kết quả để FinancialWorkflowGuard xoá dấu chờ (lần sau
        // khoá mới); bên ngoài đổi thành lỗi "đã ghi, tải lại để xem" — nội dung mới máy chủ đã lùi.
        if (isLedgerIdempotencyConflict(error, options.kind)) return { result: PRIOR_WRITTEN };
        // Từ chối chứng minh "chưa ghi" (theo từng lệnh): cũng là đối chiếu xong ⇒ guard xoá dấu chờ; bên ngoài
        // ném lại đúng lỗi này.
        if (options.provesNotWritten?.(error)) return { result: new ProvenNotWritten(error) };
        // Lỗi khác ⇒ chưa chứng minh được gì: ném lên guard — ở lượt đối chiếu nó giữ nguyên dấu chờ
        // (kết quả "unknown", không xoá dấu) và giữ được nguyên nhân thật.
        throw error;
      }
      return { result: await read(data) };
    },
    options.organizationId,
  );
  if (outcome === PRIOR_WRITTEN) throw new ProfitLedgerPriorWrittenError(options.kind);
  if (outcome instanceof ProvenNotWritten) throw outcome.error;
  return outcome;
}

/* ───────────────────────────── W1 lập phiếu tạm ứng cho cổ đông ───────────────────────────── */

export interface CreateShareholderAdvanceInput {
  /** Công ty của cổ đông. */
  organizationId: string;
  /** Người nhận: chính mình (tự tạm ứng) hoặc một cổ đông có quyền tạm ứng (người giữ sổ lập hộ). */
  shareholderId: string;
  amount: number;
  /** Sổ quỹ TIỀN THẬT người gọi đang GIỮ. */
  accountId: string;
  voucherDate: string;
  /** Ghi chú tuỳ ý (≤ 500 ký tự). */
  note: string | null;
}

export interface CreateShareholderAdvanceResult extends AdvanceResult {
  /** Mã phiếu (đọc lại sau khi lập; đọc hỏng ⇒ null, không phải lỗi ghi). */
  code: string | null;
}

export function useCreateShareholderAdvance() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-advance', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: CreateShareholderAdvanceInput): Promise<CreateShareholderAdvanceResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của cổ đông. Tải lại rồi lập phiếu.');
      const shareholderId = requireId(input.shareholderId, 'Chọn người nhận tạm ứng.');
      return runLedgerWrite({
        workflow: workflow.current,
        kind: 'advance',
        businessKey: `shareholder:${shareholderId}`,
        operation: 'lập phiếu tạm ứng',
        organizationId,
        call: (key) => supabase.rpc('shareholder_profit_advance_v1', {
          p_shareholder_id: shareholderId,
          p_amount: input.amount,
          p_account_id: input.accountId,
          p_voucher_date: input.voucherDate,
          // Không có DEFAULT nhưng nhận NULL (không ghi chú).
          p_note: rpcNullable(input.note?.trim() || null),
          p_idempotency_key: key,
        }),
        read: async (data) => {
          const result = readAdvanceResult(data, { shareholderId, amount: input.amount });
          const receipt = await readCreatedVoucherReceipt({ voucher_id: result.voucher_id });
          return { ...result, code: receipt.code || null };
        },
        receiptId: (result) => result.voucher_id,
        receiptLabel: 'Phiếu tạm ứng đã lập',
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}

/* ───────────────────────────── W2 chốt chi lợi nhuận đến hết tháng N ───────────────────────────── */

export interface SettleShareholderProfitInput {
  /** Công ty của cổ đông. */
  organizationId: string;
  shareholderId: string;
  /** 'YYYY-MM-01' — tháng ĐANG HIỆN ở lần xem trước. */
  throughMonth: string;
  /** Hai số ĐANG HIỆN ở lần xem trước (R5). Lệch một trong hai ⇒ máy chủ trả PT409, không ghi gì. */
  expectedRecognized: number;
  expectedCash: number;
  /** Bắt buộc khi có tiền thực chi; lần chốt không ra tiền thì null. */
  accountId: string | null;
  voucherDate: string | null;
  note: string | null;
}

export interface SettleShareholderProfitResult extends SettleResult {
  /** Mã phiếu chi tiền (null khi lần chốt không ra tiền hoặc đọc lại mã hỏng). */
  code: string | null;
}

export function useSettleShareholderProfit() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-settle', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: SettleShareholderProfitInput): Promise<SettleShareholderProfitResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của cổ đông. Tải lại rồi chốt.');
      const shareholderId = requireId(input.shareholderId, 'Chọn cổ đông cần chốt chi lợi nhuận.');
      const throughMonth = requireId(input.throughMonth, 'Chọn tháng chốt.');
      // Không bao giờ gửi số kỳ vọng rỗng / lạ: đó là số chủ đã xem, máy chủ so-rồi-ghi trên cả hai.
      if (!Number.isFinite(input.expectedRecognized) || !(input.expectedRecognized > 0)
          || !Number.isFinite(input.expectedCash) || input.expectedCash < 0) {
        throw new FinancialWorkflowError('Chưa có số xem trước của lần chốt. Tải lại xem trước rồi chốt.', 'failure', []);
      }
      const hasCash = input.expectedCash > 0;
      return runLedgerWrite({
        workflow: workflow.current,
        kind: 'settle',
        businessKey: `shareholder:${shareholderId}`,
        operation: 'chốt chi lợi nhuận',
        organizationId,
        call: (key) => supabase.rpc('shareholder_profit_settle_v1', {
          p_shareholder_id: shareholderId,
          p_through_month: throughMonth,
          // Không có DEFAULT nhưng nhận NULL: lần chốt không ra tiền thì không cần sổ quỹ / ngày chi.
          p_account_id: rpcNullable(hasCash ? input.accountId : null),
          p_voucher_date: rpcNullable(hasCash ? input.voucherDate : null),
          p_note: rpcNullable(input.note?.trim() || null),
          p_expected_recognized: input.expectedRecognized,
          p_expected_cash: input.expectedCash,
          p_idempotency_key: key,
        }),
        read: async (data) => {
          const result = readSettleResult(data, { throughMonth });
          if (!result.voucher_id) return { ...result, code: null };
          const receipt = await readCreatedVoucherReceipt({ voucher_id: result.voucher_id });
          return { ...result, code: receipt.code || null };
        },
        receiptId: (result) => result.settlement_id,
        receiptLabel: 'Lần chốt chi lợi nhuận đã ghi',
        // "Kiểm tra lại kết quả" gặp PT409 số liệu vừa đổi (hoặc "không còn gì để chốt") ⇒ lần trước CHƯA ghi:
        // gỡ dấu chờ, hộp tải lại xem trước.
        provesNotWritten: settleRejectionProvesNotWritten,
      });
    },
    onSettled: () => invalidateProfitLedgerQueries(queryClient),
  });
}

/* ───────────────────────────── W3 huỷ lần chốt KHÔNG có phiếu tiền ───────────────────────────── */

export interface VoidProfitSettlementInput {
  /** Công ty của cổ đông. */
  organizationId: string;
  settlementId: string;
  /** 8..1000 ký tự (máy chủ cắt khoảng trắng). */
  reason: string;
}

export function useVoidProfitSettlement() {
  const queryClient = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-ledger-settle-void', { scope: 'target' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: VoidProfitSettlementInput): Promise<SettlementVoidResult> => {
      const organizationId = requireId(input.organizationId, 'Chưa xác định được công ty của lần chốt. Tải lại rồi huỷ.');
      const settlementId = requireId(input.settlementId, 'Chưa xác định được lần chốt cần huỷ.');
      return runLedgerWrite({
        workflow: workflow.current,
        kind: 'settle_void',
        businessKey: `settlement:${settlementId}`,
        operation: 'huỷ lần chốt chi lợi nhuận',
        organizationId,
        call: (key) => supabase.rpc('shareholder_profit_settlement_void_v1', {
          p_settlement_id: settlementId,
          p_reason: input.reason.trim(),
          p_idempotency_key: key,
        }),
        read: (data) => readSettlementVoidResult(data, settlementId),
        receiptId: (result) => result.settlement_id,
        receiptLabel: 'Lần chốt đã huỷ',
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
        kind: 'cancel',
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
        kind: 'marker',
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
        kind: 'resolve',
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
