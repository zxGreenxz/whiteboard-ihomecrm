// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ZaloConversation } from '../types';
import ConversationList from '../ConversationList';

afterEach(cleanup);
const conv = (id: string) => ({ id, accountId: 'account-a', name: `Khách ${id}`, phone: '', sub: '', initials: id, tone: 'emerald', labelIds: [], profile: { kind: 'unknown' }, messages: [] }) as unknown as ZaloConversation;
const props = { activeId: '', filter: 'all' as const, search: '', automationActive: 0, onFilter: vi.fn(), onSearch: vi.fn(), onSelect: vi.fn() };

it('báo số dòng hiện / tổng khớp do hàm SQL trả, không phải độ dài trang', () => {
  render(<ConversationList {...props} conversations={[conv('1'), conv('2')]} matchCount={450} totalCount={900} />);
  expect(screen.getByText('Hiển thị 2/450 — gõ tìm kiếm để thu hẹp')).toBeTruthy();
  expect(screen.getByText('900')).toBeTruthy();
});

it('không nhắc thu hẹp khi đã hiện đủ; ô tìm giới hạn 200 ký tự như hàm', () => {
  render(<ConversationList {...props} conversations={[conv('1')]} matchCount={1} totalCount={1} />);
  expect(screen.queryByText(/gõ tìm kiếm để thu hẹp/)).toBeNull();
  expect(screen.getByPlaceholderText('Tìm theo tên, SĐT, mã phòng…').getAttribute('maxlength')).toBe('200');
});

it('danh sách nền chưa tải xong thì số đếm là khối xám, không phải 0', () => {
  render(<ConversationList {...props} conversations={[conv('1')]} matchCount={1} />);
  expect(screen.queryByText('0')).toBeNull();
});

it('cột danh sách lỗi khi chưa có trang nào: không báo "không có hội thoại phù hợp" như kết quả thật', () => {
  render(<ConversationList {...props} conversations={[]} matchCount={0} totalCount={5} listUnavailable />);
  expect(screen.queryByText('Không có hội thoại phù hợp')).toBeNull();
  expect(screen.getByText('Chưa tải được danh sách hội thoại')).toBeTruthy();
});
