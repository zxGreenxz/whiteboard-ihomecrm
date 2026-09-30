// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LeaseTermBadge from '../LeaseTermBadge';

afterEach(cleanup);
it('giữ ngày và ô sửa khi lưu thời hạn hợp đồng thất bại', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline'));
  render(<LeaseTermBadge trangThai="xong" han={{ from: '01/09/2026', to: '01/09/2027', nguon: 'cap-ngay' }} coAnh canEdit onDocLai={vi.fn()} onSua={save} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sửa ngày' }));
  fireEvent.change(screen.getByLabelText('Hợp đồng đến ngày'), { target: { value: '2028-09-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Hợp đồng đến ngày')).toHaveProperty('value', '2028-09-01');
  expect((await screen.findByRole('alert')).textContent).toContain('Chưa lưu được thời hạn hợp đồng');
});

it('ngày kết thúc trước ngày bắt đầu hiện lỗi và focus đúng ô, không ghi',()=>{
  const save=vi.fn();render(<LeaseTermBadge trangThai="xong" han={{from:'01/09/2026',to:'01/09/2027',nguon:'cap-ngay'}} coAnh canEdit onDocLai={vi.fn()} onSua={save}/>);
  fireEvent.click(screen.getByRole('button',{name:'Sửa ngày'}));fireEvent.change(screen.getByLabelText('Hợp đồng đến ngày'),{target:{value:'2025-09-01'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
  expect(screen.getByRole('alert').textContent).toContain('Ngày kết thúc');expect(document.activeElement).toBe(screen.getByLabelText('Hợp đồng đến ngày'));expect(save).not.toHaveBeenCalled();
});
