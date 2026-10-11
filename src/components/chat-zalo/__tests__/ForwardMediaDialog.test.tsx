// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { ForwardMediaResult } from '@/lib/zaloForwardMedia';
import ForwardMediaDialog from '../ForwardMediaDialog';
import AlbumMessage from '../AlbumMessage';
import type { ZaloConversation, ZaloLabel, ZaloMessage } from '../types';

// Native popup layout/focus is covered in the local browser check; retain the real label choices.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@/hooks/chat-zalo/useSignedMediaUrl', () => ({ useSignedMediaUrl: (url: string) => url }));
vi.mock('@/hooks/chat-zalo/useMediaThuLai', () => ({ useMediaThuLai: (url: string) => ({ src: url, loi: false, onError: vi.fn() }) }));

afterEach(cleanup);
const media = (id = 'image-1'): ZaloMessage => ({ id, type: 'image', mediaUrl: `https://example.test/${id}.jpg`, label: `${id}.jpg`, text: 'Chú thích ảnh gốc', tick: 'sent' });
const conv = (id: string, accountId = 'account-a', isGroup = false) => ({ id, accountId, isGroup, name: `Người nhận ${id}`, phone: '', sub: '', labelIds: [7] }) as ZaloConversation;
const conversations = [conv('A'), conv('B', 'account-b', true)];
const labels: ZaloLabel[] = [
  { accountId: 'account-a', accountName: 'Zalo A', labelId: 7, name: 'Sale A' },
  { accountId: 'account-b', accountName: 'Zalo B', labelId: 7, name: 'Sale B' },
];
const queued = (id: string): ForwardMediaResult['recipients'][number] => ({ conversation_id: id, status: 'queued', message_ids: [`forwarded-${id}`], job_id: `job-${id}`, reused: false });
const props = { open: true, onOpenChange: vi.fn(), messages: [media()], conversations, labels, sending: false };
const choose = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Người nhận ${name}`) }));

it('shares the entire image album, including images beyond the visible four', () => {
  const album = Array.from({ length: 5 }, (_, index) => media(`image-${index}`));
  const share = vi.fn();
  const view = render(<AlbumMessage items={album} onShare={share} />);
  fireEvent.mouseEnter(view.container.firstElementChild!);
  fireEvent.click(screen.getByTitle('Chia sẻ tin này'));
  expect(share).toHaveBeenCalledWith(album[0], album);
});

it('previews every album item and filters recipients by account-scoped label', async () => {
  const send = vi.fn().mockResolvedValue({ recipients: [queued('A')] });
  render(<ForwardMediaDialog {...props} messages={[media('one'), media('two')]} onSend={send} />);
  expect(screen.getByText('Album 2 ảnh')).toBeTruthy();
  expect(screen.getByText('one.jpg')).toBeTruthy();
  expect(screen.getByText('two.jpg')).toBeTruthy();
  expect(screen.getByText('Chú thích ảnh gốc')).toBeTruthy();
  expect(screen.getByText('Cá nhân · Gửi bằng Zalo A')).toBeTruthy();
  expect(screen.getByText('Nhóm · Gửi bằng Zalo B')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Sale A/ }));
  expect(screen.queryByRole('checkbox', { name: /Người nhận B/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Chọn tất cả kết quả' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(['A'], expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(await screen.findByText('Đã xếp hàng')).toBeTruthy();
  expect(screen.queryByText('Đã gửi')).toBeNull();
});

it('previews distinct album captions in source order and shows repeated captions only once', () => {
  const captions = ['  Góc cửa sổ  ', '[Hình ảnh]', 'Hướng ban công', 'Góc cửa sổ'];
  const messages = captions.map((text, index) => ({ ...media(`caption-${index}`), text }));
  render(<ForwardMediaDialog {...props} messages={messages} onSend={vi.fn()} />);
  const preview = screen.getByRole('region', { name: 'Nội dung chuyển tiếp' });
  expect(within(preview).getByText('Góc cửa sổ\nHướng ban công', { normalizer: text => text }).textContent).toBe('Góc cửa sổ\nHướng ban công');
  expect(within(preview).queryByText('[Hình ảnh]')).toBeNull();
});

it('shows queued and rejected recipients separately and requires a new explicit selection for another request', async () => {
  const send = vi.fn().mockResolvedValue({ recipients: [queued('A'), { conversation_id: 'B', status: 'rejected', error: 'Tài khoản đã ngắt kết nối.' }] });
  render(<ForwardMediaDialog {...props} onSend={send} />);
  choose('A'); choose('B');
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 2' }));
  expect(await screen.findByText('Không xếp hàng: Tài khoản đã ngắt kết nối.')).toBeTruthy();
  expect(screen.getByText('Đã xếp hàng')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('chưa xác nhận tin đã tới Zalo');
  const firstRequestId = send.mock.calls[0]![1];
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp lần khác' }));
  expect((screen.getByRole('button', { name: 'Chuyển tiếp tới 0' }) as HTMLButtonElement).disabled).toBe(true);
  choose('B');
  send.mockResolvedValueOnce({ recipients: [queued('B')] });
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]![0]).toEqual(['B']);
  expect(send.mock.calls[1]![1]).not.toBe(firstRequestId);
});

it('reconciles an unknown result with exactly the same request and frozen recipients across close/reopen', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('private transport detail')).mockResolvedValueOnce({ recipients: [queued('A')] });
  const view = render(<ForwardMediaDialog {...props} onSend={send} />);
  choose('A');
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }));
  const check = await screen.findByRole('button', { name: 'Kiểm tra lại yêu cầu' });
  expect(screen.queryByText('private transport detail')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chuyển tiếp lần khác' })).toBeNull();
  const firstArgs = send.mock.calls[0];
  view.rerender(<ForwardMediaDialog {...props} open={false} onSend={send} />);
  view.rerender(<ForwardMediaDialog {...props} conversations={[conv('B', 'account-b', true)]} onSend={send} />);
  expect(screen.getByText('Người nhận A')).toBeTruthy();
  expect(screen.queryByText('Người nhận B')).toBeNull();
  expect(check.isConnected).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại yêu cầu' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]).toEqual(firstArgs);
  expect(await screen.findByText('Đã xếp hàng')).toBeTruthy();
});

it('keeps the current source selection intact when a different source request finishes late', async () => {
  let resolveFirst!: (value: ForwardMediaResult) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<ForwardMediaResult>(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce({ recipients: [queued('B')] });
  const view = render(<ForwardMediaDialog {...props} onSend={send} />);
  choose('A');
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }));
  view.rerender(<ForwardMediaDialog {...props} messages={[media('another-source')]} onSend={send} />);
  choose('B');
  await act(async () => { resolveFirst({ recipients: [queued('A')] }); });
  expect(screen.getByText('another-source.jpg')).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: /Người nhận B/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText('Đã xếp hàng')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]![0]).toEqual(['B']);
  expect(send.mock.calls[1]![1]).not.toBe(send.mock.calls[0]![1]);
});

it.each([
  { name: 'pending source', messages: [{ ...media(), tick: 'pending' as const }] },
  { name: 'failed source', messages: [{ ...media(), tick: 'failed' as const }] },
  { name: 'unsaved source', messages: [{ ...media(), id: undefined }] },
  { name: 'missing media', messages: [{ ...media(), mediaUrl: null }] },
  { name: 'mixed album', messages: [media(), { ...media('voice'), type: 'voice' as const }] },
  { name: 'too many images', messages: Array.from({ length: 13 }, (_, index) => media(String(index))) },
])('explains and blocks $name', ({ messages }) => {
  const send = vi.fn();
  render(<ForwardMediaDialog {...props} messages={messages} onSend={send} />);
  choose('A');
  const button = screen.getByRole('button', { name: 'Chuyển tiếp tới 1' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0);
  expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  fireEvent.click(button);
  expect(send).not.toHaveBeenCalled();
});

it('limits a bulk selection to 100 explicit recipients', async () => {
  const send = vi.fn().mockResolvedValue({ recipients: Array.from({ length: 100 }, (_, index) => queued(String(index))) });
  render(<ForwardMediaDialog {...props} conversations={Array.from({ length: 101 }, (_, index) => conv(String(index)))} onSend={send} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chọn 100 hội thoại đầu' }));
  expect((screen.getByRole('checkbox', { name: /Người nhận 100 / }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển tiếp tới 100' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toHaveLength(100);
  expect(send.mock.calls[0]![0]).not.toContain('100');
});
