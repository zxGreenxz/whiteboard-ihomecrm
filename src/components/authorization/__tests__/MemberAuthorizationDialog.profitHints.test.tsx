// @vitest-environment jsdom
// D2.13: ở Thành viên → Ngoại lệ, quyền sổ tổng có lời nhắc tại chỗ (không chặn lưu); khoá chỉ nhận
// phạm vi công ty mặc định thẳng phạm vi công ty.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ save: vi.fn(), refetch: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/authorization/PermissionPicker', () => ({
  PermissionPicker: ({ onToggle }: { onToggle: (key: string, on: boolean) => void }) => (
    <button type="button" onClick={() => onToggle('shareholder_profit.view_percent', true)}>chọn quyền xem tỷ lệ</button>
  ),
}));
vi.mock('@/hooks/useOrganizationAuthorization', () => {
  const query = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: m.refetch });
  const perm = (key: string, scopeKinds: string[]) => ({ key, resource: key.split('.')[0], action: key.split('.')[1], sensitivity: 'ELEVATED', scopeKinds, requiredDimensions: [], requiresCashbookPossession: false });
  const member = {
    membershipId: 'ms-1', userId: 'u-1', email: 'nv@vidu.vn', fullName: 'Nhân viên A', memberType: 'STAFF', status: 'ACTIVE', version: 3, isSelf: false,
    roleBindings: [{ bindingId: 'b1', roleId: 'r-ql', roleName: 'Quản Lý Tòa', scopeIds: ['scope-b1'] }],
    overrides: [
      { overrideId: 'o1', permissionKey: 'shareholder_profit.advance_own_cashbook', effect: 'ALLOW', scopeMode: 'ORGANIZATION', reason: 'Cho tạm ứng lợi nhuận', expiresAt: null, createdAt: '2026-11-15T00:00:00Z', scopeIds: ['scope-org'] },
      { overrideId: 'o2', permissionKey: 'shareholder_profit.distribute', effect: 'ALLOW', scopeMode: 'ORGANIZATION', reason: 'Nhờ chi hộ', expiresAt: null, createdAt: '2026-11-15T00:00:00Z', scopeIds: ['scope-org'] },
    ],
    cashbooksHeld: [{ cashbookId: 'c1', name: 'Quỹ chung', kind: 'KNOWER' }],
    effectiveKeys: [],
  };
  return {
    useMemberAuthorization: () => query(member),
    useOrganizationRoles: () => query([{ roleId: 'r-ql', name: 'Quản Lý Tòa', isSystem: false, status: 'ACTIVE', version: 1, memberCount: 1, allowKeys: [], denyKeys: [] }]),
    useAuthorizationCatalog: () => query({
      scopes: [
        { scopeId: 'scope-org', scopeType: 'ORGANIZATION', label: 'Toàn công ty', buildingId: null, areaId: null, cashbookId: null },
        { scopeId: 'scope-b1', scopeType: 'BUILDING', label: 'Toà Một', buildingId: 'b1', areaId: null, cashbookId: null },
      ],
      permissions: [
        perm('shareholder_profit.advance_own_cashbook', ['ORGANIZATION']),
        perm('shareholder_profit.view_percent', ['ORGANIZATION']),
        perm('shareholder_profit.distribute', ['ORGANIZATION', 'BUILDING']),
      ],
    }),
    useSaveMemberAuthorization: () => ({ mutateAsync: m.save, isPending: false }),
  };
});

import { MemberAuthorizationDialog } from '../MemberAuthorizationDialog';
import { PROFIT_PERMISSION_HINTS } from '@/lib/profitLedger/permissionHints';

beforeEach(() => { vi.clearAllMocks(); m.save.mockResolvedValue({}); });
afterEach(cleanup);

it('đúng hai cảnh báo (chưa giữ sổ + không phải chủ), kèm ghi chú tạm ứng; lưu vẫn được', async () => {
  render(<MemberAuthorizationDialog membershipId="ms-1" open onOpenChange={vi.fn()} />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /Ngoại lệ/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Ngoại lệ/ }));
  await waitFor(() => expect(screen.getAllByTestId('profit-permission-hint').length).toBe(3));
  const hints = screen.getAllByTestId('profit-permission-hint');
  expect(hints.filter((h) => h.dataset.tone === 'warning').map((h) => h.textContent)).toEqual([
    PROFIT_PERMISSION_HINTS.advanceNoCashbook, PROFIT_PERMISSION_HINTS.distributeNonOwner,
  ]);
  expect(hints.filter((h) => h.dataset.tone === 'info').map((h) => h.textContent)).toEqual([PROFIT_PERMISSION_HINTS.advanceInfo]);

  // Thêm quyền xem tỷ lệ: người này chỉ phụ trách một toà ⇒ phạm vi mặc định là CÔNG TY.
  fireEvent.click(screen.getByRole('button', { name: /Thêm ngoại lệ/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'chọn quyền xem tỷ lệ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
  const rows = screen.getAllByRole('button', { name: 'Sửa' });
  fireEvent.click(rows[rows.length - 1]!);
  fireEvent.change(document.querySelector('[name="overrides.2.reason"]')!, { target: { value: 'Cổ đông xem tỷ lệ của mình' } });
  fireEvent.change(document.querySelector('[name="lydo"]')!, { target: { value: 'Cấp quyền xem sổ tổng' } });
  const dialog = screen.getAllByRole('dialog')[0]!;
  fireEvent.click(within(dialog).getByRole('button', { name: /Lưu phân quyền/ }));
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  const payload = m.save.mock.calls[0]![0] as { overrides: { permission_key: string; scope_mode: string; scope_ids: string[] }[] };
  expect(payload.overrides.map((o) => o.permission_key)).toEqual([
    'shareholder_profit.advance_own_cashbook', 'shareholder_profit.distribute', 'shareholder_profit.view_percent',
  ]);
  expect(payload.overrides[2]).toMatchObject({ scope_mode: 'ORGANIZATION', scope_ids: ['scope-org'] });
});
