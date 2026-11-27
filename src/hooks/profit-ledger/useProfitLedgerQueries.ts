// Hook ĐỌC của sổ tổng lợi nhuận cổ đông (Đợt 2). Mỗi hook gọi đúng một RPC đã phát hành ở Đợt 1,
// tên viết thẳng tại chỗ gọi (gate rpc-name-literal / rpc-arg-names), payload qua bộ đọc chặt
// (thiếu số ⇒ lỗi, không bao giờ hiện 0 đ).
//
// Mọi hook trả dữ liệu ở MỌI route của công tắc: màn hình tự quyết ẩn/hiện bằng `route`
// (profitLedgerRouteState) hoặc `ready` (E3). Lỗi hiện tại chỗ (`errorDisplay: 'inline'`): màn hình
// bọc QueryRegion hoặc tự đọc `error` qua profitLedgerErrorMessage(error, 'read').

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { classifyDbError, isRetryable } from '@/lib/contracts/errors';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { rpcNullable } from '@/lib/rpcNullable';
import { isProfitLedgerForbidden } from '@/lib/profitLedger/errors';
import {
  readLedgerPayoutDetail, readManagerLedger, readMyProfitLedger, readShareholderLedger,
  readShareholderLedgerEntries,
  type LedgerPayoutDetail, type ManagerLedger, type MyProfitLedger, type ShareholderLedger,
  type ShareholderLedgerEntries,
} from '@/lib/profitLedger/ledgerReaders';
import { readMarkerPreview, type MarkerPreview } from '@/lib/profitLedger/actionReaders';
import {
  readAdvanceOptions, readAdvancePreview, readMyShareholderPosition, readSettlementPreview, readShareholderPositions,
  type AdvanceOptions, type AdvancePreview, type MyShareholderPosition, type SettlementPreview, type ShareholderPositions,
} from '@/lib/profitLedger/positionReaders';
import { readUnlockSalaryImpact, type UnlockSalaryImpact } from '@/lib/profitLedger/salaryReaders';
import { day, instant, list, money, obj, optStr, str } from '@/lib/profitLedger/readPrimitives';
import type { ProfitLedgerSubjectKind } from '@/lib/profitLedger/sharedReaders';
import { isProfitLedgerVoucher } from '@/lib/profitLedger/vouchers';

/** Lỗi đọc chỉ thử lại khi máy chủ bận ở tầng khoá; quyền / đầu vào sai thử lại cũng sai y vậy. */
const retryBusyOnce = (failureCount: number, error: unknown) =>
  failureCount < 1 && isRetryable(classifyDbError(error));

/* E1 — sổ tổng theo cổ đông (chủ: distribute | lock | unlock | manage_shareholders). */
export function useShareholderProfitLedger(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ['profit-ledger', organizationId ?? null],
    enabled: !!organizationId,
    retry: retryBusyOnce,
    meta: { label: 'sổ tổng lợi nhuận cổ đông', errorDisplay: 'inline' },
    queryFn: async (): Promise<ShareholderLedger> => {
      const org = organizationId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_ledger_v1', { p_organization_id: org });
      if (error) throw error;
      return readShareholderLedger(data, org);
    },
  });
}

/* E2 — sổ chi tiết một cổ đông (kể cả cổ đông đã xoá), có số dư chạy. */
export function shareholderEntryOptions(
  organizationId: string | null | undefined,
  shareholderId: string | null | undefined,
) {
  return {
    queryKey: ['profit-ledger-entries', organizationId ?? null, shareholderId ?? null],
    enabled: !!organizationId && !!shareholderId,
    retry: retryBusyOnce,
    meta: { label: 'sổ chi tiết lợi nhuận', errorDisplay: 'inline' },
    queryFn: async (): Promise<ShareholderLedgerEntries> => {
      const org = organizationId as string;
      const sh = shareholderId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_ledger_entries_v1', {
        p_organization_id: org,
        p_shareholder_id: sh,
      });
      if (error) throw error;
      return readShareholderLedgerEntries(data, org, sh);
    },
  };
}

export function useShareholderProfitLedgerEntries(organizationId: string | null | undefined, shareholderId: string | null | undefined) {
  return useQuery(shareholderEntryOptions(organizationId,shareholderId));
}

/**
 * E3 — cổ đông tự xem (cần reports_finance.profit_distribution HOẶC advance_own_cashbook).
 * `data === null` ⇔ máy chủ trả 42501 PROFIT_LEDGER_FORBIDDEN (không phải cổ đông của công ty / thiếu
 * quyền): màn hình ẨN khối, không báo lỗi. Lỗi khác vẫn ném (không trả rỗng che lỗi).
 */
export function useMyProfitLedger(organizationId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['my-profit-ledger', organizationId ?? null],
    enabled: !!organizationId && (options.enabled ?? true),
    retry: retryBusyOnce,
    meta: { label: 'lợi nhuận của bạn', errorDisplay: 'inline' },
    queryFn: async (): Promise<MyProfitLedger | null> => {
      const org = organizationId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_my_ledger_v1', { p_organization_id: org });
      if (error) {
        if (isProfitLedgerForbidden(error)) return null;
        throw error;
      }
      return readMyProfitLedger(data, org);
    },
  });
}

/*
 * ───────────── Tạm ứng cổ đông + chốt chi lợi nhuận theo tháng (migration 20261118041911) ─────────────
 * (Thay E4 `shareholder_profit_payout_preview_v1` — xem trước theo số tiền nhập tay — web không còn gọi.)
 * R1, R3, R4 là hàm VOLATILE (kiểm quyền của NGƯỜI KHÁC, có khoá dòng): PHẢI gọi bằng POST — mặc định của
 * `supabase.rpc`. KHÔNG thêm `{ get: true }` (giao dịch chỉ đọc ⇒ 25006).
 */

/* R1 — vị thế mọi cổ đông: "lợi nhuận chưa chi" và "tạm ứng đang có" (chủ: như E1). */
export function useShareholderProfitPositions(organizationId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['profit-positions', organizationId ?? null],
    enabled: !!organizationId && (options.enabled ?? true),
    retry: retryBusyOnce,
    meta: { label: 'lợi nhuận chưa chi và tạm ứng của cổ đông', errorDisplay: 'inline' },
    queryFn: async (): Promise<ShareholderPositions> => {
      const org = organizationId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_positions_v1', { p_organization_id: org });
      if (error) throw error;
      return readShareholderPositions(data, org);
    },
  });
}

/**
 * R2 — vị thế của chính cổ đông đang đăng nhập + các lần chốt còn hiệu lực (quyền như E3).
 * `data === null` ⇔ máy chủ trả 42501 PROFIT_LEDGER_FORBIDDEN: màn hình ẨN khối. Lỗi khác vẫn ném.
 */
export function useMyShareholderPosition(organizationId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['my-profit-position', organizationId ?? null],
    enabled: !!organizationId && (options.enabled ?? true),
    retry: retryBusyOnce,
    meta: { label: 'lợi nhuận chưa chi và tạm ứng của bạn', errorDisplay: 'inline' },
    queryFn: async (): Promise<MyShareholderPosition | null> => {
      const org = organizationId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_my_position_v1', { p_organization_id: org });
      if (error) {
        if (isProfitLedgerForbidden(error)) return null;
        throw error;
      }
      return readMyShareholderPosition(data, org);
    },
  });
}

/**
 * R3 — lựa chọn cho chế độ "Tạm Ứng" của form Thu chi: sổ đang giữ, người nhận có quyền tạm ứng, hạng mục.
 * Không có số tiền nào. `data === null` ⇔ người gọi không thuộc công ty (42501 PROFIT_LEDGER_FORBIDDEN):
 * form coi như không có chế độ Tạm Ứng. Lỗi khác vẫn ném để form báo "chưa kiểm tra được".
 */
export function useShareholderAdvanceOptions(organizationId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['profit-advance-options', organizationId ?? null],
    enabled: !!organizationId && (options.enabled ?? true),
    retry: retryBusyOnce,
    meta: { label: 'lựa chọn phiếu Tạm Ứng', errorDisplay: 'inline' },
    queryFn: async (): Promise<AdvanceOptions | null> => {
      const { data, error } = await supabase.rpc('shareholder_profit_advance_options_v1', { p_organization_id: organizationId as string });
      if (error) {
        if (isProfitLedgerForbidden(error)) return null;
        throw error;
      }
      return readAdvanceOptions(data);
    },
  });
}

/**
 * R4 — xem trước một phiếu tạm ứng. Gọi được khi CHƯA nhập số tiền / chưa chọn sổ. Máy chủ chỉ trả số
 * của cổ đông (`position`) cho người có quyền chi lợi nhuận hoặc chính người nhận; người giữ sổ lập hộ
 * nhận `position = null`. Lớp gọi tự debounce số tiền (~400 ms) rồi mới đổi tham số.
 */
export function useShareholderAdvancePreview(input: {
  shareholderId: string | null | undefined;
  amount: number | null;
  accountId: string | null;
  enabled?: boolean;
}) {
  const amount = input.amount !== null && Number.isFinite(input.amount) && input.amount > 0 ? input.amount : null;
  return useQuery({
    queryKey: ['profit-advance-preview', input.shareholderId ?? null, amount, input.accountId ?? null],
    enabled: !!input.shareholderId && (input.enabled ?? true),
    staleTime: 0,
    retry: retryBusyOnce,
    meta: { label: 'xem trước phiếu tạm ứng', errorDisplay: 'inline' },
    queryFn: async (): Promise<AdvancePreview> => {
      const shareholderId = input.shareholderId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_advance_preview_v1', {
        p_shareholder_id: shareholderId,
        // Không có DEFAULT nhưng nhận NULL: chưa có số tiền / sổ ⇒ chỉ xem vị thế và lý do khoá.
        p_amount: rpcNullable(amount),
        p_account_id: rpcNullable(input.accountId ?? null),
      });
      if (error) throw error;
      return readAdvancePreview(data, { shareholderId, amount, accountId: input.accountId ?? null });
    },
  });
}

/**
 * R5 — xem trước "chốt chi lợi nhuận đến hết tháng N". `throughMonth = null` ⇒ máy chủ chọn tháng đủ điều
 * kiện MỚI NHẤT (có thể là tháng không còn gì để chốt — `blocked_reason = NOTHING_TO_SETTLE`). `accountId`
 * chỉ để máy chủ biết đã chọn sổ chưa.
 */
export function useProfitSettlementPreview(input: {
  shareholderId: string | null | undefined;
  throughMonth: string | null;
  accountId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['profit-settlement-preview', input.shareholderId ?? null, input.throughMonth, input.accountId ?? null],
    enabled: !!input.shareholderId && (input.enabled ?? true),
    staleTime: 0,
    // Giữ lần xem trước cũ trong lúc tải lại (đổi sổ quỹ không làm các ô của hộp chốt biến mất rồi hiện lại).
    // Lớp gọi PHẢI xét `isPlaceholderData`: số cũ chỉ để hiện, không được gửi và không dùng cho cổ đông / tháng khác.
    placeholderData: keepPreviousData,
    retry: retryBusyOnce,
    meta: { label: 'xem trước chốt chi lợi nhuận', errorDisplay: 'inline' },
    queryFn: async (): Promise<SettlementPreview> => {
      const shareholderId = input.shareholderId as string;
      const { data, error } = await supabase.rpc('shareholder_profit_settlement_preview_v1', {
        p_shareholder_id: shareholderId,
        // Không có DEFAULT nhưng nhận NULL: tháng NULL = tháng đủ điều kiện mới nhất; sổ NULL = chưa chọn.
        p_through_month: rpcNullable(input.throughMonth),
        p_account_id: rpcNullable(input.accountId ?? null),
      });
      if (error) throw error;
      return readSettlementPreview(data, { shareholderId, throughMonth: input.throughMonth, accountId: input.accountId ?? null });
    },
  });
}

/* E7 — chi tiết một phiếu chi lợi nhuận / lương điều hành để duyệt hoặc huỷ: lúc lập và bây giờ. */
async function fetchProfitLedgerPayoutDetail(voucherId: string): Promise<LedgerPayoutDetail> {
  const { data, error } = await supabase.rpc('profit_ledger_payout_detail_v1', { p_voucher_id: voucherId });
  if (error) throw error;
  return readLedgerPayoutDetail(data, voucherId);
}

export function useProfitLedgerPayoutDetail(voucherId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['profit-ledger-payout', voucherId ?? null],
    enabled: !!voucherId && (options.enabled ?? true),
    retry: retryBusyOnce,
    meta: { label: 'phiếu chi lợi nhuận', errorDisplay: 'inline' },
    queryFn: () => fetchProfitLedgerPayoutDetail(voucherId as string),
  });
}

/**
 * E8 — xem trước mốc "đã trả đủ đến hết tháng X" đặt NGAY BÂY GIỜ. `settledThroughMonth = null` là
 * xem trước GỠ mốc (hợp lệ). Tháng phải là 'YYYY-MM-01' của một tháng đã qua.
 */
export function useProfitLedgerMarkerPreview(input: {
  organizationId: string | null | undefined;
  subjectKind: ProfitLedgerSubjectKind;
  subjectId: string | null | undefined;
  settledThroughMonth: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['profit-ledger-marker-preview', input.organizationId ?? null, input.subjectKind, input.subjectId ?? null, input.settledThroughMonth],
    enabled: !!input.organizationId && !!input.subjectId && (input.enabled ?? true),
    staleTime: 0,
    retry: retryBusyOnce,
    meta: { label: 'xem trước mốc đã trả đủ', errorDisplay: 'inline' },
    queryFn: async (): Promise<MarkerPreview> => {
      const subjectId = input.subjectId as string;
      const { data, error } = await supabase.rpc('profit_ledger_marker_preview_v1', {
        p_organization_id: input.organizationId as string,
        p_subject_kind: input.subjectKind,
        p_subject_id: subjectId,
        p_settled_through_month: rpcNullable(input.settledThroughMonth),
      });
      if (error) throw error;
      return readMarkerPreview(data, { subjectKind: input.subjectKind, subjectId, settledThroughMonth: input.settledThroughMonth });
    },
  });
}

/* E10 — sổ lương điều hành (pay_manager | distribute | lock | manage_shareholders). */
export function useProfitManagerLedger(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ['profit-manager-ledger', organizationId ?? null],
    enabled: !!organizationId,
    retry: retryBusyOnce,
    meta: { label: 'sổ lương điều hành', errorDisplay: 'inline' },
    queryFn: async (): Promise<ManagerLedger> => {
      const org = organizationId as string;
      const { data, error } = await supabase.rpc('profit_manager_ledger_v1', { p_organization_id: org });
      if (error) throw error;
      return readManagerLedger(data, org);
    },
  });
}

/**
 * E14 — trước khi mở khoá / đặt lại / chốt lại một tháng lợi nhuận: ai đã nhận phần đó qua lương, số
 * dư sổ tổng của ai đổi. `buildingIds = null` = mọi toà của kỳ. Lỗi/đang tải ⇒ màn hình KHOÁ nút.
 */
export function useProfitUnlockSalaryImpact(input: {
  organizationId: string | null | undefined;
  periodMonth: string | null | undefined;
  buildingIds: readonly string[] | null;
  enabled?: boolean;
}) {
  const buildingIds = input.buildingIds ? [...input.buildingIds].sort() : null;
  return useQuery({
    queryKey: ['profit-unlock-salary-impact', input.organizationId ?? null, input.periodMonth ?? null, buildingIds],
    enabled: !!input.organizationId && !!input.periodMonth && (input.enabled ?? true),
    staleTime: 0,
    retry: retryBusyOnce,
    meta: { label: 'ảnh hưởng tới lương khi mở khoá', errorDisplay: 'inline' },
    queryFn: async (): Promise<UnlockSalaryImpact> => {
      const org = input.organizationId as string;
      const period = input.periodMonth as string;
      const { data, error } = await supabase.rpc('profit_unlock_salary_impact_v1', {
        p_organization_id: org,
        p_period_month: period,
        // Có DEFAULT NULL ⇒ undefined (bỏ khoá khỏi JSON) khi xét mọi toà.
        p_building_ids: buildingIds ?? undefined,
      });
      if (error) throw error;
      return readUnlockSalaryImpact(data, org, period);
    },
  });
}

/* Phiếu lương điều hành của một người nhận (mọi trạng thái duyệt, chưa xoá) — cho cột Huỷ / sổ phiếu. */
export interface ManagerLedgerPayout {
  id: string;
  code: string | null;
  voucher_date: string;
  total_amount: number;
  approval_status: string;
  posting_status: string | null;
  system_source: string | null;
  account_id: string | null;
  account_name: string | null;
  created_at: string;
  /** Phiếu lập theo sổ tổng: huỷ bằng hộp huỷ có lý do. Phiếu cũ (`salary.manager` / không nguồn) huỷ theo đường cũ. */
  is_ledger_voucher: boolean;
}

export function useManagerLedgerPayouts(organizationId: string | null | undefined, managerId: string | null | undefined) {
  return useQuery({
    queryKey: ['manager-ledger-payouts', organizationId ?? null, managerId ?? null],
    enabled: !!organizationId && !!managerId,
    meta: { label: 'phiếu lương điều hành', errorDisplay: 'inline' },
    queryFn: async (): Promise<ManagerLedgerPayout[]> => {
      const org = organizationId as string;
      const manager = managerId as string;
      const rows = await fetchAllRows<unknown>(
        (from, to) => supabase
          .from('income_expenses')
          .select('id, code, voucher_date, total_amount, approval_status, posting_status, system_source, account_id, created_at, account:accounts!income_expenses_account_id_fkey(name)')
          .eq('organization_id', org)
          .eq('type', 'EXPENSE')
          .eq('profit_manager_id', manager)
          .is('deleted_at', null)
          .order('voucher_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'profitLedger.managerPayouts' },
      );
      return list(rows, 'manager-ledger-payouts', (row, path) => {
        const account = row.account == null ? null : obj(row.account, `${path}.account`);
        const systemSource = optStr(row.system_source, `${path}.system_source`);
        return {
          id: str(row.id, `${path}.id`),
          code: optStr(row.code, `${path}.code`),
          voucher_date: day(row.voucher_date, `${path}.voucher_date`),
          total_amount: money(row.total_amount, `${path}.total_amount`),
          approval_status: str(row.approval_status, `${path}.approval_status`),
          posting_status: optStr(row.posting_status, `${path}.posting_status`),
          system_source: systemSource,
          account_id: optStr(row.account_id, `${path}.account_id`),
          account_name: account ? optStr(account.name ?? null, `${path}.account.name`) : null,
          created_at: instant(row.created_at, `${path}.created_at`),
          is_ledger_voucher: isProfitLedgerVoucher(systemSource),
        };
      });
    },
  });
}
