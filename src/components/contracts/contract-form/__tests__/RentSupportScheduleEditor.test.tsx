// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import type { ContractFormData } from '@/lib/contractValidation';
import { RentSupportScheduleEditor } from '../RentSupportScheduleEditor';
afterEach(cleanup);
const toggle = () => fireEvent.click(screen.getByRole('button', { name: /Lịch hỗ trợ tiền thuê/ }));
function Harness({ start = '2026-09-20', end = '2026-10-05' }) {
  const form = useForm<ContractFormData>({ defaultValues: { start_date: start, end_date: '2027-09-20', start_billing_date: start, end_billing_date: end, rent_price: 4000000 } });
  return <Form {...form}><RentSupportScheduleEditor form={form} /><button onClick={() => form.setValue('end_billing_date', '2026-10-31')}>Đổi kỳ đầu</button></Form>;
}
it('starts collapsed, keeps a one-line summary and opens on demand', () => {
  render(<Harness />);
  const header = screen.getByRole('button', { name: /Lịch hỗ trợ tiền thuê/ });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByText('Chưa có hỗ trợ')).toBeTruthy();
  expect(screen.queryByLabelText('Số tháng giai đoạn 1')).toBeNull();
  toggle();
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.change(screen.getByLabelText('Số tháng giai đoạn 1'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Hỗ trợ mỗi tháng giai đoạn 1'), { target: { value: '300000' } });
  toggle();
  expect(screen.queryByLabelText('Số tháng giai đoạn 1')).toBeNull();
  expect(screen.getByText(/1 giai đoạn · tổng 900.000/)).toBeTruthy();
});
it('shows consecutive month/year segments and 1.8m total before saving', () => {
  render(<Harness />);
  toggle();
  expect(screen.getAllByLabelText(/Số tháng giai đoạn/)).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Số tháng giai đoạn 1'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Hỗ trợ mỗi tháng giai đoạn 1'), { target: { value: '300000' } });
  expect(screen.getByText('09/2026 · 10/2026 · 11/2026')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Thêm giai đoạn kế tiếp' }));
  fireEvent.change(screen.getByLabelText('Số tháng giai đoạn 2'), { target: { value: '9' } });
  fireEvent.change(screen.getByLabelText('Hỗ trợ mỗi tháng giai đoạn 2'), { target: { value: '100000' } });
  expect(screen.getByText('12/2026 · 01/2027 · 02/2027 · 03/2027 · 04/2027 · 05/2027 · 06/2027 · 07/2027 · 08/2027')).toBeTruthy();
  expect(screen.getByText(/Tổng hỗ trợ khách: 1.800.000/)).toBeTruthy();
  expect(screen.getByText(/Toà chịu.*không khấu trừ/)).toBeTruthy();
});
it('requires dates instead of assuming the current month', () => {
  render(<Harness start="" end="" />);
  toggle();
  expect(screen.getByText(/Nhập ngày bắt đầu.*ngày kết thúc kỳ đầu/)).toBeTruthy();
  expect(screen.queryByText('09/2026')).toBeNull();
});
it('retains September schedule while changing the actual first invoice to October', () => {
  render(<Harness start="2026-09-28" end="2026-10-05" />);
  toggle();
  fireEvent.change(screen.getByLabelText('Số tháng giai đoạn 1'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Hỗ trợ mỗi tháng giai đoạn 1'), { target: { value: '300000' } });
  fireEvent.click(screen.getByText('Đổi kỳ đầu'));
  expect(screen.getByText('09/2026 · 10/2026 · 11/2026')).toBeTruthy();
  expect(screen.getByText(/09\/2026.*chưa có kỳ hóa đơn đủ điều kiện/)).toBeTruthy();
  expect(screen.getByText(/Kỳ đầu dự kiến: 10\/2026/)).toBeTruthy();
});
it('defaults Sale to commission only and names the bonus fallback explicitly', () => {
  render(<Harness />);
  toggle();
  fireEvent.change(screen.getByLabelText('Người chịu hỗ trợ'), { target: { value: 'SALE' } });
  expect((screen.getByLabelText('Nguồn khấu trừ') as HTMLSelectElement).value).toBe('COMMISSION_ONLY');
  expect(screen.getByText('Thưởng trước, phần thiếu chuyển sang hoa hồng')).toBeTruthy();
});
