import { describe, expect, it } from 'vitest';
import {
  PROFIT_PERMISSION_HINTS, isOwnerRoleName, isProfitLedgerOrgScopedKey, profitPermissionHints,
} from '../permissionHints';

describe('lời nhắc khi cấp quyền sổ tổng', () => {
  it('tạm ứng: luôn có ghi chú; chưa GIỮ sổ nào (chỉ KNOWER) ⇒ thêm cảnh báo', () => {
    const hints = profitPermissionHints({ permissionKey: 'shareholder_profit.advance_own_cashbook', effect: 'ALLOW', cashbooksHeld: [{ kind: 'KNOWER' }], memberIsOwner: false });
    expect(hints).toEqual([
      { tone: 'info', text: PROFIT_PERMISSION_HINTS.advanceInfo },
      { tone: 'warning', text: PROFIT_PERMISSION_HINTS.advanceNoCashbook },
    ]);
    expect(profitPermissionHints({ permissionKey: 'shareholder_profit.advance_own_cashbook', effect: 'ALLOW', cashbooksHeld: [{ kind: 'CUSTODIAN' }], memberIsOwner: false }))
      .toEqual([{ tone: 'info', text: PROFIT_PERMISSION_HINTS.advanceInfo }]);
  });
  it('chi lợi nhuận cho người không phải chủ ⇒ cảnh báo; chủ ⇒ không', () => {
    expect(profitPermissionHints({ permissionKey: 'shareholder_profit.distribute', effect: 'ALLOW', cashbooksHeld: [], memberIsOwner: false }))
      .toEqual([{ tone: 'warning', text: PROFIT_PERMISSION_HINTS.distributeNonOwner }]);
    expect(profitPermissionHints({ permissionKey: 'shareholder_profit.distribute', effect: 'ALLOW', cashbooksHeld: [], memberIsOwner: true })).toEqual([]);
  });
  it('ngoại lệ CẤM không cần nhắc; khoá khác không nhắc', () => {
    expect(profitPermissionHints({ permissionKey: 'shareholder_profit.distribute', effect: 'DENY', cashbooksHeld: [], memberIsOwner: false })).toEqual([]);
    expect(profitPermissionHints({ permissionKey: 'income_expenses.view', effect: 'ALLOW', cashbooksHeld: [], memberIsOwner: false })).toEqual([]);
  });
  it('vai chủ theo tên; ba khoá mới chỉ nhận phạm vi công ty', () => {
    expect(isOwnerRoleName('Chủ công ty')).toBe(true);
    expect(isOwnerRoleName('Chủ sở hữu tổ chức')).toBe(true);
    expect(isOwnerRoleName('Quản Lý Tòa')).toBe(false);
    expect(isOwnerRoleName(undefined)).toBe(false);
    expect(['shareholder_profit.advance_own_cashbook', 'shareholder_profit.view_percent', 'shareholder_profit.view_building_totals'].every(isProfitLedgerOrgScopedKey)).toBe(true);
    expect(isProfitLedgerOrgScopedKey('shareholder_profit.distribute')).toBe(false);
  });
});
