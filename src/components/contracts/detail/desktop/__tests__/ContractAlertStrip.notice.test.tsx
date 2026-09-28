// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { ContractAlertStrip } from '../ContractAlertStrip';

afterEach(cleanup);
it('keeps a due or overdue notice actionable while the contract is active', () => {
  const manage = vi.fn();
  const props = {contract:{expected_move_out_date:'2026-09-27',deposit_remaining:0} as ContractWithRelations,
    isActive:true,isExpiringSoon:false,daysRemaining:90,sideLoadErrors:[],pendingForfeitCount:0,pendingRefundCount:0};
  render(<ContractAlertStrip {...props} today="2026-09-28" onManageNotice={manage} />);
  screen.getByText(/Đã quá ngày dự kiến trả phòng/);
  fireEvent.click(screen.getByRole('button',{name:'Sửa / hủy báo trả phòng'}));
  expect(manage).toHaveBeenCalledOnce();
});
