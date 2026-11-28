// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ZaloAccount, ZaloConversation } from '../types';
import AutomationSettingsDialog from '../automation/AutomationSettingsDialog';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/hooks/useZaloChat', () => ({
  useZaloBroadcastBuildings: () => ({ isSuccess: true, data: [{ id: 'bld', name: 'Tòa ví dụ', code: 'ABC', address: '' }] }),
  useZaloAutomationConfigs: () => ({ data: { broadcast_vacant: { enabled: true, config: {
    recipients: ['a-1', 'b-1'], schedule: { time: '08:48' },
  } } }, status: 'success' }),
  useSaveAutomation: () => ({ mutate, isPending: false }),
  useZaloAutomationRuns: () => ({ data: [], status: 'success' }),
}));
vi.mock('../SyncGroupsButton', () => ({ default: () => <button>Đồng bộ nhóm</button> }));
afterEach(() => { cleanup(); mutate.mockClear(); });

const accounts: ZaloAccount[] = [
  { id: 'a', name: 'Nick A', kind: 'personal', status: 'connected' },
  { id: 'b', name: 'Nick B', kind: 'personal', status: 'connected' },
];
const conversations = ['a-1', 'a-2', 'b-1'].map(id => ({
  id, name: id, threadId: 'thread-' + id, accountId: id.split('-')[0], isGroup: true, initials: 'N', tone: 'emerald', profile: {},
})) as ZaloConversation[];

it('chỉnh khoảng cách giữa các nhóm ngay trước danh sách người nhận', () => {
  render(<AutomationSettingsDialog account={accounts[0]} open onOpenChange={() => {}} conversations={conversations} />);
  const gap = screen.getByLabelText('Thời gian gửi giữa các nhóm');
  expect(gap.compareDocumentPosition(screen.getByText('Người nhận · Nick A')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(gap, { target: { value: '240' } });
  fireEvent.blur(gap);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu lịch gửi' }));
  expect(mutate.mock.calls[0][0]).toMatchObject({ changes: { antiSpam: { gapBetweenRecipientsSec: 240 } }, add: [], remove: [] });
});

it('adds and removes daily slots without changing the selected groups or pacing', () => {
  render(<AutomationSettingsDialog account={accounts[0]} open onOpenChange={() => {}} conversations={conversations} />);
  const add = (value: string) => {
    fireEvent.change(screen.getByLabelText('Giờ gửi mới'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Thêm giờ gửi' }));
  };
  add('12:30');
  add('17:00');
  add('12:30');
  expect(screen.getByRole('alert').textContent).toContain('đã có');
  fireEvent.click(screen.getByRole('button', { name: 'Xóa giờ 08:48' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu lịch gửi' }));
  const payload = mutate.mock.calls[0][0];
  expect(Object.keys(payload.changes)).toEqual(['schedule']);
  expect(payload).toMatchObject({ add: [], remove: [], expected: { schedule: { time: '08:48' } },
    changes: { schedule: { time: '12:30', extraTimes: ['17:00'] } } });
});

it('shows this account’s groups and contributes only its changed recipient IDs to the company schedule', () => {
  const view = (account: ZaloAccount) => <AutomationSettingsDialog key={account.id} account={account} open
    onOpenChange={() => {}} conversations={conversations} />;
  const { rerender } = render(view(accounts[0]));
  expect(screen.getByText('Người nhận · Nick A')).toBeTruthy();
  expect(screen.queryByText('b-1')).toBeNull();
  expect((screen.getByLabelText('Giờ gửi chung của công ty') as HTMLInputElement).value).toBe('08:48');
  expect(screen.getByText(/Đã chọn 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Chọn a-2 nhận tin định kỳ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu lịch gửi' }));
  expect(mutate.mock.calls[0][0]).toEqual({ kind: 'broadcast_vacant', accountId: 'a',
    add: ['a-2'], remove: [], changes: {}, expected: {} });
  rerender(view(accounts[1]));
  expect(screen.getByText('Người nhận · Nick B')).toBeTruthy();
  expect(screen.queryByText('a-1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Bỏ chọn hết' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu lịch gửi' }));
  expect(mutate.mock.calls[1][0]).toEqual({ kind: 'broadcast_vacant', accountId: 'b',
    add: [], remove: ['b-1'], changes: {}, expected: {} });
});

it('lưu tòa đã chọn cùng người nhận bằng một lần lưu', () => {
  render(<AutomationSettingsDialog account={accounts[0]} open onOpenChange={() => {}} conversations={conversations} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Chọn a-2 nhận tin định kỳ' }));
  fireEvent.change(screen.getByLabelText('Phạm vi phòng của a-2'), { target: { value: 'bld' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu lịch gửi' }));
  expect(mutate.mock.calls[0][0]).toMatchObject({ add: ['a-2'],
    changes: { groupBuildings: { 'thread-a-2': 'bld' } }, expected: { groupBuildings: { 'thread-a-2': null } } });
});
