import type { IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
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

export interface QuickExpenseResult {
  id: string;
  label: string;
  status: 'success' | 'skipped' | 'unknown';
  message: string;
}
