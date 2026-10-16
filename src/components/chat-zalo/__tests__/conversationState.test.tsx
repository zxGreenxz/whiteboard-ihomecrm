// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { conversationHasLabel, hasCrmLink, isTenantConversation, zaloLabelKey } from '../conversationState';
import type { ZaloConversation, ZaloLabel } from '../types';
import ThreadSearchBar from '../ThreadSearchBar';
import BroadcastDialog from '../BroadcastDialog';
import ConversationList from '../ConversationList';
// Keep the real LabelFilter and its account-aware choices. Portal/focus behavior
// of a nested Dialog + Popover belongs to the browser test, not this data-flow case.
// `modal` được ghi lại: trong Dialog, Popover không modal bị khoá cuộn của Dialog
// nuốt thao tác cuộn danh sách nhãn.
const popover = vi.hoisted(() => ({ modal: [] as unknown[] }));
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, modal }: PropsWithChildren<{ modal?: boolean }>) => { popover.modal.push(modal); return <>{children}</>; },
  PopoverTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
const crm = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/hooks/chat-zalo/useZaloCrmProfile', () => ({ useZaloCrmSummary: (id: string, linked: boolean) => {
  crm.read(id, linked);
  return { data: { contract: { id: 'contract-1', contract_number: 'HD-123' } }, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() };
} }));
import CrmInfoCard from '../CrmInfoCard';

afterEach(cleanup);
const conv = (id: string, accountId: string) => ({ id, accountId, name: `Khách ${id}`, phone: '', sub: '', initials: id, tone: 'emerald', labelIds: [7], profile: { kind: 'unknown' }, messages: [] }) as ZaloConversation;
const labels: ZaloLabel[] = [
  { accountId: 'account-a', accountName: 'Zalo A', labelId: 7, name: 'Sale A', color: '#ff0000' },
  { accountId: 'account-b', accountName: 'Zalo B', labelId: 7, name: 'Sale B', color: '#0000ff' },
];

it('the same numeric label on two accounts does not match the other account', () => {
  expect(conversationHasLabel(conv('A', 'account-a'), zaloLabelKey(labels[0]!))).toBe(true);
  expect(conversationHasLabel(conv('B', 'account-b'), zaloLabelKey(labels[0]!))).toBe(false);
});

it('broadcast filters and select-all retain only the account owning the selected label', async () => {
  const send = vi.fn().mockResolvedValue(1);
  popover.modal.length = 0;
  render(<BroadcastDialog open onOpenChange={vi.fn()} conversations={[conv('A', 'account-a'), conv('B', 'account-b')]} labels={labels} onSend={send} />);
  expect(popover.modal.length).toBeGreaterThan(0);
  expect(popover.modal.every((m) => m === true)).toBe(true);
  expect(screen.getByTitle('Sale A')).toBeTruthy();
  expect(screen.getByTitle('Sale B')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Phân loại' }));
  fireEvent.click(screen.getByRole('button', { name: /Sale A/ }));
  expect(screen.queryByRole('button', { name: /Khách B/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Chọn tất cả' }));
  fireEvent.change(screen.getByPlaceholderText('Nhập nội dung gửi tới các hội thoại đã chọn…'), { target: { value: 'Test selected label' } });
  fireEvent.click(screen.getByRole('button', { name: 'Gửi tới 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(['A'], 'Test selected label'));
});

it('customer alone is not a tenant; a contract or room makes CRM available even without customer/lead', () => {
  const customer = { ...conv('A', 'account-a'), customerId: 'customer-1' };
  expect(isTenantConversation(customer)).toBe(false);
  for (const linked of [{ contractId: 'contract-1' }, { roomId: 'room-1' }]) {
    const c = { ...conv('A', 'account-a'), ...linked };
    expect(isTenantConversation(c)).toBe(true);
    expect(hasCrmLink(c)).toBe(true);
  }
});

it('changing a search to a different single result navigates to that result', async () => {
  const navigate = vi.fn();
  render(<ThreadSearchBar messages={[{ id: 'a', text: 'phòng một' }, { id: 'b', text: 'phòng hai' }]} onNavigate={navigate} onTerm={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'mot' } });
  await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('a'));
  fireEvent.change(input, { target: { value: 'hai' } });
  await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('b'));
});

it('loads the CRM card for a conversation linked only to a contract', () => {
  render(<CrmInfoCard conv={{ ...conv('A', 'account-a'), contractId: 'contract-1' }} />);
  expect(crm.read).toHaveBeenCalledWith('A', true);
  expect(screen.getByText('HD-123')).toBeTruthy();
});

it('does not invent zero automation runs when no daily count is available', () => {
  render(<ConversationList conversations={[]} totalCount={0} activeId="" filter="all" search="" automationActive={1} onFilter={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} />);
  expect(screen.queryByText(/Đã chạy 0 lượt/)).toBeNull();
  expect(screen.getByText('Xem nhật ký trong mục Tự động hoá')).toBeTruthy();
});
