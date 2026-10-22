import type { IncomeExpenseBatchSummary, IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
import type { PermissionsMap } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { canWritePosting, canWriteWorkflow, type FinanceV2OrgRoutes } from '@/lib/financeV2Route';
import { hasCompleteVoucherDetail } from '@/lib/incomeExpenseDetailRead';
import { isNonCashVoucher } from '@/lib/financeV2VoucherState';

export interface QuickExpenseContext {
  organizationId: string | null;
  permissions: PermissionsMap | undefined;
  routes: FinanceV2OrgRoutes;
  cashbookIds: ReadonlySet<string>;
  ready: boolean;
}

/** UI eligibility only; the existing atomic writer remains the authority. */
export function quickExpenseReason(v: IncomeExpenseWithRelations, ctx: QuickExpenseContext): string | null {
  if (!ctx.ready) return 'Đang kiểm tra quyền và sổ quỹ. Vui lòng chờ.';
  if (!ctx.organizationId || v.organization_id !== ctx.organizationId) return 'Phiếu không thuộc công ty đang chọn.';
  if (!hasCompleteVoucherDetail(v)) return 'Chưa tải đủ thông tin phiếu.';
  if (v.type !== 'EXPENSE') return 'Chi nhanh chỉ áp dụng cho phiếu chi.';
  if (v.approval_status !== 'UNAPPROVED' || v.posting_status !== 'UNPOSTED') return 'Chỉ chọn phiếu chờ duyệt và chưa chi.';
  if (v.review_state !== 'PENDING' && v.review_state !== 'CHANGES_REQUESTED') return 'Trạng thái xử lý của phiếu chưa cho phép duyệt.';
  if (v.posting_mode !== 'CASHBOOK' || isNonCashVoucher(v) || v.system_source?.startsWith('reservation.')) return 'Phiếu này cần xử lý trong nghiệp vụ gốc.';
  if (!canWriteWorkflow(ctx.routes) || !canWritePosting(ctx.routes)) return 'Công ty chưa cho phép duyệt và chi nhanh.';
  // canUse(null) asks whether permission exists anywhere, which is not enough
  // for an organization-wide voucher without a building.
  if (!canUse(ctx.permissions, 'income_expenses', 'approve', v.building_id ?? '__no_building__')) return 'Bạn không có quyền duyệt phiếu tại tòa nhà này.';
  if (!v.account_id) return 'Phiếu chưa có sổ quỹ.';
  if (v.account_is_virtual !== false || !ctx.cashbookIds.has(v.account_id)) return 'Bạn chưa có quyền chi từ sổ quỹ của phiếu.';
  if (!Number.isFinite(v.total_amount) || v.total_amount <= 0) return 'Số tiền chi phải lớn hơn 0.';
  if (!v.attachments?.length || v.attachments.some(url => !url.trim())) return 'Phiếu chưa có ảnh hoặc tệp chứng từ hợp lệ.';
  return null;
}

/** Never silently approve edited data after the user selected a snapshot. */
export function sameQuickExpenseSnapshot(a: IncomeExpenseWithRelations, b: IncomeExpenseWithRelations): boolean {
  const fields = ['id', 'organization_id', 'building_id', 'type', 'account_id', 'total_amount',
    'approval_status', 'posting_status', 'posting_mode', 'review_state', 'approval_version',
    'posting_version', 'updated_at'] as const;
  return fields.every(key => a[key] === b[key]) && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
}

/** Completed/cancelled children are not paid again when continuing an unfinished batch. */
export function quickExpenseBatchTargets(batch: IncomeExpenseBatchSummary): IncomeExpenseWithRelations[] {
  return batch.vouchers.filter(v => v.approval_status !== 'CANCELLED' &&
    !(v.approval_status === 'APPROVED' && v.posting_status === 'POSTED'));
}

type BatchMembership = { id: string; organization_id?: string | null; type: string; voucher_ids?: readonly string[] };
export function sameQuickExpenseBatchMembership(a: BatchMembership, b: BatchMembership): boolean {
  const ids = new Set(a.voucher_ids);
  return a.id === b.id && a.organization_id === b.organization_id && a.type === b.type &&
    !!a.voucher_ids?.length && !!b.voucher_ids?.length && ids.size === a.voucher_ids.length &&
    new Set(b.voucher_ids).size === b.voucher_ids.length && ids.size === b.voucher_ids.length && b.voucher_ids.every(id => ids.has(id));
}

export function quickExpenseBatchReason(
  batch: IncomeExpenseBatchSummary, ctx: QuickExpenseContext,
  childReason: (v: IncomeExpenseWithRelations) => string | null = v => quickExpenseReason(v, ctx),
): string | null {
  if (!ctx.ready) return 'Đang kiểm tra quyền và sổ quỹ. Vui lòng chờ.';
  if (!ctx.organizationId || batch.organization_id !== ctx.organizationId) return 'Phiếu tổng không thuộc công ty đang chọn.';
  if (batch.type !== 'EXPENSE') return 'Chi nhanh chỉ áp dụng cho phiếu tổng chi.';
  const ids = new Set(batch.voucher_ids);
  if (!batch.voucher_ids?.length || ids.size !== batch.voucher_ids.length ||
    batch.vouchers.length !== ids.size || batch.voucher_count !== ids.size ||
    new Set(batch.vouchers.map(v => v.id)).size !== ids.size || batch.vouchers.some(v => !ids.has(v.id))) {
    return 'Chưa hiển thị đủ toàn bộ phiếu trong đợt. Mở chi tiết phiếu tổng hoặc bỏ bộ lọc để kiểm tra.';
  }
  if (batch.vouchers.some(v => v.organization_id !== ctx.organizationId || v.type !== 'EXPENSE')) return 'Có phiếu con không đúng công ty hoặc loại phiếu chi.';
  const targets = quickExpenseBatchTargets(batch);
  if (!targets.length) return 'Đợt này không còn phiếu chờ duyệt và chi.';
  for (const child of targets) {
    const reason = childReason(child);
    if (reason) return `${child.code || child.name}: ${reason}`;
  }
  return null;
}

export function sameQuickExpenseBatchSnapshot(a: IncomeExpenseBatchSummary, b: IncomeExpenseBatchSummary): boolean {
  if (!sameQuickExpenseBatchMembership(a, b) || a.vouchers.length !== b.vouchers.length ||
    JSON.stringify(a.attachments) !== JSON.stringify(b.attachments)) return false;
  const fresh = new Map(b.vouchers.map(v => [v.id, v]));
  return a.vouchers.every(v => { const row = fresh.get(v.id); return !!row && sameQuickExpenseSnapshot(v, row); });
}

export interface QuickExpenseResult {
  id: string;
  label: string;
  status: 'success' | 'skipped' | 'unknown';
  message: string;
}
