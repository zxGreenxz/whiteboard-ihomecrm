// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractReturnStep } from '../ContractReturnStep';

afterEach(cleanup);
const defaults = () => ({ actualDate: '2026-09-28', onDateChange: vi.fn(), kind: null,
  onKindChange: vi.fn(), changeReason: '', onReasonChange: vi.fn(), returnNote: 'Khách trả phòng.', onReturnNoteChange: vi.fn(), pending: false,
  onDefer: vi.fn(), onContinue: vi.fn() });

describe('bước ghi trả phòng', () => {
  it.each(['', '  \n\t  '])('chặn cả hai nhánh khi nội dung trống: %j', (returnNote) => {
    render(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" returnNote={returnNote} />);
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }).hasAttribute('disabled')).toBe(true);
  });
  it.each([
    ['NATURAL_EXPIRY', 'Khách trả phòng do hết hạn hợp đồng.'],
    ['EARLY_RETURN', 'Khách trả phòng trước thời hạn hợp đồng.'],
    ['FORFEIT', 'Khách trả phòng và bỏ cọc.'],
  ] as const)('điền câu mẫu theo loại %s bằng thao tác bấm', (kind, note) => {
    const props = defaults();
    render(<ContractReturnStep {...props} kind={kind} returnNote="" />);
    expect(props.onReturnNoteChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    expect(props.onReturnNoteChange).toHaveBeenCalledWith(note);
  });
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

describe('ba trường hợp dưới Trả phòng trước hạn', () => {
  const early = (reason: 'SALE_ASSISTED' | 'SELF_FOUND' | 'LANDLORD_AGREEMENT' | null, saleName = '') =>
    ({ reason, onReasonChange: vi.fn(), saleName, onSaleNameChange: vi.fn() });
  it('chưa chọn trường hợp thì khoá cả hai nhánh; chọn được ba trường hợp', () => {
    const choice = early(null);
    render(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" early={choice} />);
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Tự tìm khách sang phòng'));
    expect(choice.onReasonChange).toHaveBeenCalledWith('SELF_FOUND');
    expect(screen.getByLabelText('Nhờ sale tìm khách sang phòng')).toBeTruthy();
    expect(screen.getByLabelText('Chủ nhà hỗ trợ thanh lý sớm')).toBeTruthy();
  });
  it('nhờ sale bắt tên sale, ẩn quyết toán ngay; tự tìm cũng ẩn quyết toán ngay; chủ nhà hỗ trợ cho cả hai nhánh', () => {
    const { rerender } = render(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" early={early('SALE_ASSISTED')} />);
    expect(screen.queryByRole('button', { name: 'Tiếp tục quyết toán ngay' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Nhập tên sale / môi giới.')).toBeTruthy();
    rerender(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" early={early('SALE_ASSISTED', 'Minh')} />);
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('early-reason-note').textContent).toMatch(/Phòng giữ 3 ngày/);
    rerender(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" early={early('SELF_FOUND')} />);
    expect(screen.queryByRole('button', { name: 'Tiếp tục quyết toán ngay' })).toBeNull();
    rerender(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" early={early('LANDLORD_AGREEMENT')} />);
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('early-reason-note').textContent).toMatch(/rao bán lại ngay/);
  });
  it('hồ sơ đã ghi mà chưa đủ điều kiện quyết toán: hiện lý do và khoá nút', () => {
    const exitCase = { initial_kind: 'EARLY_RETURN', current_kind: 'EARLY_RETURN' } as const;
    render(<ContractReturnStep {...defaults()} kind="EARLY_RETURN" exitCase={exitCase} continueBlocked="Chưa có hợp đồng của khách nhận phòng." />);
    expect(screen.getByRole('alert').textContent).toBe('Chưa có hợp đồng của khách nhận phòng.');
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }).hasAttribute('disabled')).toBe(true);
  });
});
