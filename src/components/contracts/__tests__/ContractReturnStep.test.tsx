// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractReturnStep } from '../ContractReturnStep';

afterEach(cleanup);
const defaults = () => ({ actualDate: '2026-09-28', onDateChange: vi.fn(), kind: null,
  onKindChange: vi.fn(), changeReason: '', onReasonChange: vi.fn(), pending: false,
  onDefer: vi.fn(), onContinue: vi.fn() });

describe('bước ghi trả phòng', () => {
  it('bắt chọn loại và ngày thực tế trước cả hai nhánh', () => {
    const props = defaults();
    const { rerender } = render(<ContractReturnStep {...props} />);
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Bỏ cọc'));
    expect(props.onKindChange).toHaveBeenCalledWith('FORFEIT');
    rerender(<ContractReturnStep {...props} kind="FORFEIT" actualDate="" />);
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    rerender(<ContractReturnStep {...props} kind="FORFEIT" />);
    fireEvent.click(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }));
    expect(props.onDefer).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
  });
  it('quyết toán sau được đổi loại nhưng phải ghi lý do và giữ ngày đã trả', () => {
    const props = defaults();
    const exitCase = { initial_kind: 'EARLY_RETURN', current_kind: 'EARLY_RETURN' } as const;
    const { rerender } = render(<ContractReturnStep {...props} kind="FORFEIT" exitCase={exitCase} />);
    expect(screen.queryByRole('button', { name: 'Trả phòng, quyết toán sau' })).toBeNull();
    expect(screen.getByLabelText(/Ngày khách thực tế trả phòng/).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Loại đã ghi lúc trả: Trả phòng trước hạn/)).not.toBeNull();
    rerender(<ContractReturnStep {...props} kind="FORFEIT" exitCase={exitCase} changeReason="Khách xác nhận bỏ cọc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(props.onContinue).toHaveBeenCalledOnce();
  });
  it('đang lưu không cho bấm nhánh còn lại', () => {
    render(<ContractReturnStep {...defaults()} kind="NATURAL_EXPIRY" pending />);
    expect(screen.getByRole('button', { name: 'Đang lưu…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }).hasAttribute('disabled')).toBe(true);
  });
});
