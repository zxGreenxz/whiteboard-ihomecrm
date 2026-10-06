// @vitest-environment jsdom
// "Nhập nhanh" (trang Thu chi mobile): hạng mục Tiền cọc phải có phòng — "toàn tòa nhà" không đủ,
// vì cọc chỉ vào hợp đồng theo phòng (depositRoomRule.ts). Không cho bấm Lưu và nói rõ lý do.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPOSIT_ROOM_REQUIRED_MESSAGE } from '@/lib/depositRoomRule';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: '1392QT', code: '1392QT' }] }),
  useIncomeExpenseFormRooms: () => ({ data: [{ id: 'g03', name: 'G03', code: null, building_id: 'b1' }] }),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [{ id: 'a1', name: 'TKHIEP', is_default: true }] }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({
  useIncomeExpenseTypes: () => ({
    data: [
      { id: 'tien-coc', name: 'Tiền Cọc', category: 'Tiền Cọc', type: 'income', is_deposit: true },
      { id: 'thu-khac', name: 'thu chi khác', category: 'Khác', type: 'income', is_deposit: false },
    ],
  }),
  useCreateIncomeExpenseType: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpense: () => ({ mutateAsync: h.create, isPending: false }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: undefined }) }));
vi.mock('@/hooks/useCanManageIeTypes', () => ({ useCanManageIeTypes: () => ({ canManage: false }) }));
// Ô gợi ý hạng mục thật là dropdown theo con trỏ; ở đây chỉ cần đường "chọn một hạng mục".
vi.mock('../QuickCategoryInput', () => ({
  default: ({ value, onChange, onSelect }: { value: string; onChange: (v: string) => void; onSelect: (t: { id: string; name: string; category: string; type: 'income' }) => void }) => (
    <>
      <input aria-label="Nhập nhanh" value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onSelect({ id: 'tien-coc', name: 'Tiền Cọc', category: 'Tiền Cọc', type: 'income' })}>chọn Tiền Cọc</button>
      <button type="button" onClick={() => onSelect({ id: 'thu-khac', name: 'thu chi khác', category: 'Khác', type: 'income' })}>chọn thu chi khác</button>
    </>
  ),
}));
vi.mock('@/components/income-expense-types/CategoryCombobox', () => ({ default: () => null }));

import IncomeExpenseQuickCreateDialog from '../IncomeExpenseQuickCreateDialog';

class ResizeObserverFake { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverFake);
afterEach(cleanup);

const nhap = (phong: string, chon: string) => {
  render(<IncomeExpenseQuickCreateDialog open onOpenChange={() => {}} defaultType="INCOME" />);
  const o = screen.getByLabelText('Nhập nhanh');
  fireEvent.change(o, { target: { value: `${phong} 1392QT ` } });
  fireEvent.click(screen.getByText(chon));
  fireEvent.change(o, { target: { value: `${(o as HTMLInputElement).value}1000` } });
  return screen.getByRole('button', { name: 'Lưu phiếu thu' }) as HTMLButtonElement;
};

describe('Nhập nhanh: Tiền cọc bắt buộc phòng', () => {
  it('toàn tòa nhà + Tiền Cọc ⇒ khoá Lưu, báo rõ lý do ở dòng Phòng', () => {
    const luu = nhap('toa', 'chọn Tiền Cọc');
    expect(luu.disabled).toBe(true);
    expect(screen.getByText(DEPOSIT_ROOM_REQUIRED_MESSAGE)).toBeTruthy();
  });

  it('có phòng G03 + Tiền Cọc ⇒ lưu được', () => {
    const luu = nhap('G03', 'chọn Tiền Cọc');
    expect(luu.disabled).toBe(false);
    expect(screen.queryByText(DEPOSIT_ROOM_REQUIRED_MESSAGE)).toBeNull();
  });

  it('toàn tòa nhà + hạng mục thường ⇒ vẫn lưu được', () => {
    const luu = nhap('toa', 'chọn thu chi khác');
    expect(luu.disabled).toBe(false);
  });
});
