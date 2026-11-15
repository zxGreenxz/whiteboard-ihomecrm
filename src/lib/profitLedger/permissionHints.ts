// Lời nhắc tại chỗ khi cấp quyền của sổ tổng lợi nhuận ở Thành viên → Ngoại lệ (D2.13).
// Chỉ là lời nhắc: KHÔNG chặn lưu (máy chủ vẫn là chốt cuối, quyền chỉ có tác dụng khi đủ điều kiện).

/** Ba khoá mới của sổ tổng chỉ nhận phạm vi CÔNG TY (scope_kinds = {ORGANIZATION}). */
export const PROFIT_LEDGER_ORG_SCOPED_KEYS = [
  'shareholder_profit.advance_own_cashbook',
  'shareholder_profit.view_percent',
  'shareholder_profit.view_building_totals',
] as const;

export function isProfitLedgerOrgScopedKey(key: string): boolean {
  return (PROFIT_LEDGER_ORG_SCOPED_KEYS as readonly string[]).includes(key);
}

/**
 * Vai "chủ" theo đúng vị ngữ máy chủ (ie_actor_is_company_owner_v1): vai hệ thống TENANT_OWNER mang tên
 * "Chủ sở hữu tổ chức", hoặc vai tự tạo "Chủ công ty". Màn phân quyền không có system_key nên so theo tên.
 */
export const OWNER_ROLE_NAMES = ['Chủ sở hữu tổ chức', 'Chủ công ty'] as const;

export function isOwnerRoleName(name: string | null | undefined): boolean {
  return !!name && (OWNER_ROLE_NAMES as readonly string[]).includes(name.trim());
}

export interface PermissionHint {
  tone: 'info' | 'warning';
  text: string;
}

export const PROFIT_PERMISSION_HINTS = {
  advanceInfo: 'Chỉ chi cho chính người này, từ sổ quỹ người đó đang giữ; mọi khoản chờ chủ duyệt; vượt số còn phải trả là tạm ứng.',
  advanceNoCashbook: 'Người này chưa giữ sổ quỹ nào — quyền tạm ứng chưa dùng được cho tới khi được giao giữ sổ.',
  distributeNonOwner: 'Người này không phải chủ: quyền chi lợi nhuận cho họ thấy số dư và tỷ lệ của MỌI cổ đông, và lập được phiếu chi cho bất kỳ cổ đông nào.',
} as const;

export function profitPermissionHints(input: {
  permissionKey: string;
  effect: 'ALLOW' | 'DENY';
  /** Sổ người đó đang được gắn (kind: CUSTODIAN = giữ sổ, KNOWER = chỉ biết). */
  cashbooksHeld: readonly { kind: string }[];
  memberIsOwner: boolean;
}): PermissionHint[] {
  if (input.effect !== 'ALLOW') return [];
  if (input.permissionKey === 'shareholder_profit.advance_own_cashbook') {
    const hints: PermissionHint[] = [{ tone: 'info', text: PROFIT_PERMISSION_HINTS.advanceInfo }];
    if (!input.cashbooksHeld.some((cashbook) => cashbook.kind === 'CUSTODIAN')) {
      hints.push({ tone: 'warning', text: PROFIT_PERMISSION_HINTS.advanceNoCashbook });
    }
    return hints;
  }
  if (input.permissionKey === 'shareholder_profit.distribute' && !input.memberIsOwner) {
    return [{ tone: 'warning', text: PROFIT_PERMISSION_HINTS.distributeNonOwner }];
  }
  return [];
}
