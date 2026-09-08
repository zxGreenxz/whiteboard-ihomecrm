// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdministrativeAddressPreview from '../AdministrativeAddressPreview';
import { convertCustomerAddress } from '@/lib/customerAddressConversion';
vi.mock('@/lib/customerAddressConversion', () => ({ convertCustomerAddress: vi.fn() }));
const convert = vi.mocked(convertCustomerAddress);
const result = { source: 'goong-v2' as const, candidates: [{ id: 'fixture', province: 'Hà Nội', ward: 'Yên Hòa',
  formattedAddress: '91 Trung Kính, Yên Hòa, Hà Nội', oldAddress: 'Trung Hòa, Cầu Giấy, Hà Nội' }] };
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
describe('AdministrativeAddressPreview', () => {
  it('can retry A after cancelling its pending lookup by switching A to B and back', async () => {
    let resolveOld!: (value: typeof result) => void;
    convert.mockImplementationOnce(() => new Promise(r => { resolveOld = r; })).mockResolvedValue(result);
    const view = render(<AdministrativeAddressPreview address="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    view.rerender(<AdministrativeAddressPreview address="B" />);
    view.rerender(<AdministrativeAddressPreview address="A" />);
    const button = screen.getByRole('button', { name: 'Tra địa chỉ mới' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolveOld(result));
    expect(screen.queryByText(result.candidates[0].formattedAddress)).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText(result.candidates[0].formattedAddress)).toBeTruthy();
  });
  it('converts only on request and displays the result separately with its source', async () => {
    convert.mockResolvedValue(result);
    render(<AdministrativeAddressPreview address="91 Trung Kính, Trung Hòa, Cầu Giấy, Hà Nội" />);
    expect(convert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    expect(await screen.findByText(result.candidates[0].formattedAddress)).toBeTruthy();
    expect(screen.getByText(/Goong V2/)).toBeTruthy();
    expect(screen.getByText('91 Trung Kính, Trung Hòa, Cầu Giấy, Hà Nội')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lưu' })).toBeNull();
  });
  it('aborts stale work and never displays a result for the previous address', async () => {
    let resolve!: (value: typeof result) => void;
    convert.mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(<AdministrativeAddressPreview address="Địa chỉ cũ" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    const signal = convert.mock.calls[0][1];
    view.rerender(<AdministrativeAddressPreview address="Địa chỉ vừa sửa" />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(result));
    expect(screen.queryByText(result.candidates[0].formattedAddress)).toBeNull();
    expect((screen.getByRole('button', { name: 'Tra địa chỉ mới' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('clears an already displayed result immediately on source edit', async () => {
    convert.mockResolvedValue(result);
    const view = render(<AdministrativeAddressPreview address="Địa chỉ cũ" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    await screen.findByText(result.candidates[0].formattedAddress);
    view.rerender(<AdministrativeAddressPreview address="Địa chỉ khác" />);
    expect(screen.queryByText(result.candidates[0].formattedAddress)).toBeNull();
  });
  it('allows retry after no results or provider error without showing a guessed address', async () => {
    convert.mockResolvedValueOnce({ source: 'goong-v2', candidates: [] }).mockRejectedValueOnce(new Error('Dịch vụ đang bận.'));
    render(<AdministrativeAddressPreview address="Địa chỉ mẫu" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    expect(await screen.findByText(/Chưa tìm được/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Dịch vụ đang bận.');
  });
  it('bounds even a session refresh that never settles and cancels on unmount', async () => {
    vi.useFakeTimers(); convert.mockImplementation(() => new Promise(() => {}));
    const view = render(<AdministrativeAddressPreview address="Địa chỉ mẫu" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    await act(async () => vi.advanceTimersByTime(15000));
    expect(screen.getByRole('alert').textContent).toContain('quá lâu');
    expect(convert.mock.calls[0][1].aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    view.unmount(); expect(convert.mock.calls[1][1].aborted).toBe(true);
  });
  it('disables lookup when there is no usable address', () => {
    render(<AdministrativeAddressPreview address="" />);
    expect((screen.getByRole('button', { name: 'Tra địa chỉ mới' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('presents multiple suggestions without silently treating the first as confirmed', async () => {
    convert.mockResolvedValue({ ...result, candidates: [result.candidates[0], { ...result.candidates[0], id: 'second', formattedAddress: 'Địa chỉ ứng viên thứ hai' }] });
    render(<AdministrativeAddressPreview address="Địa chỉ mẫu" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tra địa chỉ mới' }));
    expect(await screen.findByText(/Có 2 kết quả/)).toBeTruthy();
    expect(screen.getByText('Địa chỉ ứng viên thứ hai')).toBeTruthy();
  });
});
