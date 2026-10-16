// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type PropsWithChildren } from 'react';
import type { ZaloConversation, ZaloLabel } from '../types';

// .env của worktree có thể trỏ production: chặn mọi đường tới Supabase thật.
// RecipientPicker không được gọi DB — chạm vào client là test đỏ ngay.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: new Proxy({}, { get: (_t, key) => { throw new Error(`RecipientPicker không được gọi supabase.${String(key)}`); } }),
}));
// Giữ LabelFilter thật (lựa chọn theo nick); portal/focus của Popover lồng trong
// Dialog thuộc phần kiểm trình duyệt — cùng cách với conversationState.test.
// Ghi lại `modal`: thiếu nó thì khoá cuộn của Dialog nuốt thao tác cuộn danh sách
// nhãn (đã đo trên Chromium: scrollTop đứng yên ở 0).
const popover = vi.hoisted(() => ({ modal: [] as unknown[] }));
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, modal }: PropsWithChildren<{ modal?: boolean }>) => { popover.modal.push(modal); return <>{children}</>; },
  PopoverTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

import RecipientPicker from '../automation/RecipientPicker';

afterEach(cleanup);

const conv = (id: string, accountId: string, labelIds: number[], kind: 'group' | 'sale' | 'tenant'): ZaloConversation => ({
  id, accountId, labelIds, name: `Hội thoại ${id}`, phone: '', sub: '', initials: id.slice(0, 2), tone: 'emerald',
  isGroup: kind === 'group', isSalePartner: kind === 'sale', profile: { kind: 'unknown' }, messages: [],
}) as unknown as ZaloConversation;

const labels: ZaloLabel[] = [
  { accountId: 'acc-ihome', accountName: 'Ihome', labelId: 1, name: 'Công việc', color: '#16a34a' },
  { accountId: 'acc-tam', accountName: 'Nguyễn Tâm', labelId: 1, name: 'Công việc', color: '#2563eb' },
  { accountId: 'acc-ihome', accountName: 'Ihome', labelId: 2, name: 'Môi giới', color: '#f59e0b' },
];

const conversations = [
  conv('nhom-ihome-1', 'acc-ihome', [1], 'group'),
  conv('sale-ihome-1', 'acc-ihome', [1, 2], 'sale'),
  conv('sale-ihome-2', 'acc-ihome', [2], 'sale'),
  conv('nhom-tam-1', 'acc-tam', [1], 'group'),
  // Khách thuê mang nhãn "Công việc" vẫn KHÔNG được hiện — nhãn chỉ thu hẹp.
  conv('khach-thue', 'acc-ihome', [1], 'tenant'),
];

function Harness({ initial = [], onChange }: { initial?: string[]; onChange?: (ids: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <RecipientPicker
      conversations={conversations}
      labels={labels}
      value={value}
      onChange={(ids) => { onChange?.(ids); setValue(ids); }}
    />
  );
}

const hien = (id: string) => screen.queryByText(`Hội thoại ${id}`) !== null;
const chonNhan = (re: RegExp) => fireEvent.click(screen.getByRole('button', { name: re }));

it('chọn một phân loại chỉ hiện ứng viên mang nhãn đó, khách thuê có nhãn vẫn bị chặn', () => {
  render(<Harness />);
  expect(popover.modal.length).toBeGreaterThan(0);
  expect(popover.modal.every((m) => m === true)).toBe(true);
  // Chưa lọc: giữ nguyên nút cũ và đủ 4 ứng viên (nhóm/sale).
  expect(screen.getByRole('button', { name: 'Chọn tất cả (4)' })).toBeTruthy();
  expect(hien('khach-thue')).toBe(false);

  chonNhan(/^Môi giới\s*Ihome$/);
  expect(screen.getByText('Môi giới · Ihome')).toBeTruthy();
  expect(hien('sale-ihome-1')).toBe(true);
  expect(hien('sale-ihome-2')).toBe(true);
  expect(hien('nhom-ihome-1')).toBe(false);
  expect(hien('nhom-tam-1')).toBe(false);
  expect(hien('khach-thue')).toBe(false);
  expect(screen.getByRole('button', { name: 'Chọn cả phân loại (2)' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Chọn tất cả/ })).toBeNull();

  // Tìm kiếm vẫn chạy chồng lên lọc nhãn.
  fireEvent.change(screen.getByPlaceholderText('Tìm theo tên hội thoại…'), { target: { value: 'ihome-2' } });
  expect(hien('sale-ihome-1')).toBe(false);
  expect(hien('sale-ihome-2')).toBe(true);
  fireEvent.change(screen.getByPlaceholderText('Tìm theo tên hội thoại…'), { target: { value: 'khong-co' } });
  expect(screen.getByText(/thuộc phân loại “Môi giới · Ihome”/)).toBeTruthy();

  // Bỏ lọc: về lại danh sách và nút cũ.
  fireEvent.change(screen.getByPlaceholderText('Tìm theo tên hội thoại…'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
  expect(screen.getByRole('button', { name: 'Chọn tất cả (4)' })).toBeTruthy();
  expect(hien('nhom-tam-1')).toBe(true);
});

it('"Chọn cả phân loại" cộng dồn vào lựa chọn sẵn có, không xoá ai bị ẩn bởi bộ lọc', () => {
  const onChange = vi.fn();
  render(<Harness initial={['nhom-tam-1']} onChange={onChange} />);
  expect(screen.getByText('Đã chọn 1')).toBeTruthy();

  chonNhan(/^Môi giới\s*Ihome$/);
  fireEvent.click(screen.getByRole('button', { name: 'Chọn cả phân loại (2)' }));
  expect(onChange).toHaveBeenLastCalledWith(['nhom-tam-1', 'sale-ihome-1', 'sale-ihome-2']);
  expect(screen.getByText('Đã chọn 3')).toBeTruthy();
  // Người đã chọn nhưng đang bị bộ lọc ẩn KHÔNG phải "người nhận lạc".
  expect(screen.queryByText(/không còn trong danh sách trên/)).toBeNull();

  // Bấm lại không nhân đôi id.
  fireEvent.click(screen.getByRole('button', { name: 'Chọn cả phân loại (2)' }));
  expect(onChange).toHaveBeenLastCalledWith(['nhom-tam-1', 'sale-ihome-1', 'sale-ihome-2']);

  // "Bỏ chọn hết" giữ hành vi cũ.
  fireEvent.click(screen.getByRole('button', { name: 'Bỏ chọn hết' }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(screen.getByText('Đã chọn 0')).toBeTruthy();
});

it('hai nhãn trùng tên, trùng số ở hai nick là hai phân loại khác nhau', () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  // Danh sách lựa chọn hiện tên nick kèm từng nhãn trùng tên.
  expect(screen.getByRole('button', { name: /^Công việc\s*Ihome$/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Công việc\s*Nguyễn Tâm$/ })).toBeTruthy();

  chonNhan(/^Công việc\s*Nguyễn Tâm$/);
  expect(screen.getByText('Công việc · Nguyễn Tâm')).toBeTruthy();
  expect(hien('nhom-tam-1')).toBe(true);
  expect(hien('nhom-ihome-1')).toBe(false);
  expect(hien('sale-ihome-1')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Chọn cả phân loại (1)' }));
  expect(onChange).toHaveBeenLastCalledWith(['nhom-tam-1']);

  chonNhan(/^Công việc\s*Ihome$/);
  expect(screen.getByText('Công việc · Ihome')).toBeTruthy();
  expect(hien('nhom-ihome-1')).toBe(true);
  expect(hien('sale-ihome-1')).toBe(true);
  expect(hien('nhom-tam-1')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Chọn cả phân loại (2)' }));
  expect(onChange).toHaveBeenLastCalledWith(['nhom-tam-1', 'nhom-ihome-1', 'sale-ihome-1']);
});

it('không có nhãn nào thì không hiện bộ lọc phân loại, UI cũ giữ nguyên', () => {
  render(<RecipientPicker conversations={conversations} value={[]} onChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Phân loại' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Chọn tất cả (4)' })).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('Tìm theo tên hội thoại…'), { target: { value: 'tam' } });
  expect(screen.getByRole('button', { name: 'Chọn tất cả (1 kết quả)' })).toBeTruthy();
});
