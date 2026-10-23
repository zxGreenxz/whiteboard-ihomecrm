// =============================================================================
// profitLockPrecheck.ts — lưới mềm trước khi CHỐT lợi nhuận (đợt rà 21/10, F20 + F07).
//
// 1. Bộ dò chi cố định dùng chung (profitReportChecks.ts) chạy cho đúng các toà SẮP CHỐT
//    của tháng: còn THIẾU / THIẾU SỐ / CÓ THỂ TRÙNG ⇒ hộp xác nhận liệt kê và bắt người
//    chốt tick "đã xem" mới bấm chốt được. KHÔNG chặn cứng: tick là chốt được.
//    Dò lỗi/không tải được cũng phải tick (không biết thì không được coi là đủ).
// 2. Toà VẬN HÀNH CHO CHỦ NHÀ trong kỳ (landlord_operations_list_v1): chỉ để gắn nhãn
//    "LN chốt là của cả toà, chưa trừ phần chủ nhà" và để bộ dò không đòi Tiền nhà.
//
// Hàm thuần, không gọi mạng, không React.
// =============================================================================

import type { ProfitReportChecksResult } from '@/lib/profitReportChecks';

export type LockPrecheckStatus = 'idle' | 'loading' | 'error' | 'clean' | 'issues';

export interface LockPrecheck {
  status: LockPrecheckStatus;
  /** Phải tick "đã xem" trước khi chốt. */
  needsAck: boolean;
  /** Đang dò ⇒ chưa cho bấm chốt (chờ kết quả, không đoán là đủ). */
  blocksConfirm: boolean;
  issueCount: number;
}

export const resolveLockPrecheck = (input: {
  /** Có toà nào sắp chốt không. */
  hasTargets: boolean;
  isLoading: boolean;
  isError: boolean;
  checks: ProfitReportChecksResult | null | undefined;
}): LockPrecheck => {
  if (!input.hasTargets) return { status: 'idle', needsAck: false, blocksConfirm: false, issueCount: 0 };
  if (input.isError) return { status: 'error', needsAck: true, blocksConfirm: false, issueCount: 0 };
  if (input.isLoading || !input.checks) {
    return { status: 'loading', needsAck: false, blocksConfirm: true, issueCount: 0 };
  }
  const issueCount = input.checks.fixedFees.issues.length;
  return issueCount > 0
    ? { status: 'issues', needsAck: true, blocksConfirm: false, issueCount }
    : { status: 'clean', needsAck: false, blocksConfirm: false, issueCount: 0 };
};

/** Khoá nhận diện tập cảnh báo — đổi tập (chọn nhà khác, dữ liệu mới) thì phải tick lại. */
export const lockPrecheckSignature = (
  targetBuildingIds: readonly string[],
  checks: ProfitReportChecksResult | null | undefined,
  status: LockPrecheckStatus,
): string =>
  [
    status,
    [...targetBuildingIds].sort().join(','),
    ...(checks?.fixedFees.issues ?? []).map((c) => `${c.buildingId}:${c.key}:${c.status}:${Math.round(c.actual)}`),
  ].join('|');

/** Trường nào cũng tuỳ chọn: kiểu suy từ zod ở tsconfig.app (không strict) ra toàn trường `?`. */
export interface LandlordOperationLike {
  building_id?: string;
  organization_id?: string | null;
  /** 'YYYY-MM-DD' — tháng bắt đầu vận hành. */
  effective_from?: string;
  is_active?: boolean;
}

/**
 * Toà vận hành cho chủ nhà trong kỳ `period` ('YYYY-MM-01'): đang bật và bắt đầu
 * từ tháng đó trở về trước. `organizationId` rỗng ⇒ không lọc công ty.
 */
export const landlordOperatedBuildingIds = (
  operations: readonly LandlordOperationLike[] | null | undefined,
  period: string,
  organizationId?: string | null,
): Set<string> => {
  const ym = /^(\d{4}-\d{2})/.exec(period)?.[1];
  const out = new Set<string>();
  if (!ym) return out;
  for (const op of operations ?? []) {
    if (op.is_active !== true || !op.building_id) continue;
    if (organizationId && op.organization_id && op.organization_id !== organizationId) continue;
    const from = /^(\d{4}-\d{2})/.exec(op.effective_from ?? '')?.[1];
    if (!from || from > ym) continue;
    out.add(op.building_id);
  }
  return out;
};

/** Nhãn F07 — chỉ nhãn, không đổi số. */
export const LANDLORD_OPERATED_LOCK_LABEL =
  'Vận hành cho chủ nhà — LN chốt là của cả toà, chưa trừ phần chủ nhà (xem tab Quyết toán vận hành)';
