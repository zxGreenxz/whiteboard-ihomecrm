import { ConfirmedDepositIncome, recoverableRoomDeposit } from '@/lib/depositIncomeRpc';
// @vitest-environment jsdom
vi.mock('@/hooks/useDepositIncomeHold',()=>({useDepositIncomeHold:()=>({data:null,isError:false,isLoading:false,refetch:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
// "Nhập nhanh" (trang Thu chi mobile): hạng mục Tiền cọc phải có phòng — "toàn tòa nhà" không đủ,
// vì cọc chỉ vào hợp đồng theo phòng (depositRoomRule.ts). Không cho bấm Lưu và nói rõ lý do.
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPOSIT_ROOM_REQUIRED_MESSAGE } from '@/lib/depositRoomRule';

const h = vi.hoisted(() => ({ create: vi.fn(),rpc:vi.fn() }));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user-a'})}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: h.rpc } }));
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
  function Host(){const [open,setOpen]=useState(true);return <IncomeExpenseQuickCreateDialog open={open} onOpenChange={setOpen} defaultType="INCOME" />;}
  render(<Host/>);
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

it('sau mất phản hồi rồi mở lại, đối chiếu đúng mã và không thu lần hai',async()=>{
  h.create.mockRejectedValueOnce(new Error('network error'));
  h.rpc.mockResolvedValue({data:'11111111-1111-4111-8111-111111111111',error:null});
  fireEvent.click(nhap('G03','chọn Tiền Cọc'));
  await screen.findByRole('alert');
  const key=h.create.mock.calls[0][0].idempotency_key;
  cleanup();
  fireEvent.click(nhap('G03','chọn Tiền Cọc'));
  await waitFor(()=>expect(h.rpc).toHaveBeenCalledWith('get_own_deposit_income_v1',{p_organization_id:'o1',p_request_key:key}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Lưu phiếu thu'})).toBeNull());
  expect(h.create).toHaveBeenCalledTimes(1);
});

it('giữ đúng mã do Sale cấp khi gọi lại và khi khôi phục lần thu sau mất mạng',async()=>{
  const key='sale-caller-key';
  const id='11111111-1111-4111-8111-111111111111';
  const save=vi.fn(async(request:string)=>{expect(request).toBe(key);return {id};});
  await recoverableRoomDeposit('o1','g03',key,save);
  await recoverableRoomDeposit('o1','g03',key,save);
  save.mockRejectedValueOnce(new Error('network error'));
  await expect(recoverableRoomDeposit('o1','g03',key,save)).rejects.toThrow('network error');
  h.rpc.mockResolvedValueOnce({data:id,error:null});
  await expect(recoverableRoomDeposit('o1','g03','new-on-remount',save)).rejects.toBeInstanceOf(ConfirmedDepositIncome);
  expect(h.rpc).toHaveBeenLastCalledWith('get_own_deposit_income_v1',{p_organization_id:'o1',p_request_key:key});
  expect(save).toHaveBeenCalledTimes(3);
});
