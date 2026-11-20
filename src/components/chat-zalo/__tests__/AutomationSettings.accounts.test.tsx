// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ZaloAccount, ZaloConversation } from '../types';
import AutomationSettingsDialog from '../automation/AutomationSettingsDialog';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/hooks/useZaloChat', () => ({
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
  id, name: id, accountId: id.split('-')[0], isGroup: true, initials: 'N', tone: 'emerald', profile: {},
})) as ZaloConversation[];

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
