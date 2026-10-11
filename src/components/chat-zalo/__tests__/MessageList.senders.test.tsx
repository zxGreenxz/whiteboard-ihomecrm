// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import MessageList from '../MessageList';
import { withMessageSenders } from '../messageSenders';
import type { ZaloConversation, ZaloMessage } from '../types';

vi.mock('@/hooks/chat-zalo/useSignedMediaUrl', () => ({ useSignedMediaUrl: (url: string) => url }));
vi.mock('@/hooks/chat-zalo/useMediaThuLai', () => ({ useMediaThuLai: (url: string) => ({ src: url, loi: false, onError: vi.fn() }) }));
afterEach(cleanup);
const sender = { id: 'member-1', name: 'Minh An', avatarUrl: 'https://example.test/an.png' };
const message = (values: Partial<ZaloMessage>): ZaloMessage => ({ id: 'm1', dir: 'in', text: 'Chào nhóm', createdAt: '2026-10-11T10:00:00Z', sender, ...values });
const conversation = (messages: ZaloMessage[], isGroup = true) => ({ id: 'group', name: 'Nhóm thử', isGroup, messages }) as ZaloConversation;

it('shows group member names and avatars, grouping only consecutive messages from the same member', () => {
  render(<MessageList conv={conversation([
    message({}), message({ id: 'm2' }),
    message({ id: 'm3', sender: { id: 'member-2', name: 'Bình' } }),
    message({ id: 'system', type: 'sys', text: 'Thông báo hệ thống' }),
  ])} />);
  expect(screen.getAllByRole('img', { name: 'Ảnh đại diện Minh An' })).toHaveLength(1);
  expect(screen.getByText('Minh An')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Ảnh đại diện Bình' })).toBeTruthy();
  expect(screen.getByText('Thông báo hệ thống')).toBeTruthy();
  expect(screen.getAllByRole('img', { name: /^Ảnh đại diện/ })).toHaveLength(2);
});

it.each(['image', 'video', 'voice', 'file', 'sticker'] as const)('renders sender identity next to %s content', type => {
  render(<MessageList conv={conversation([message({ type })])} />);
  expect(screen.getByRole('img', { name: 'Ảnh đại diện Minh An' })).toBeTruthy();
});

it('renders one avatar for an album and keeps all images in its share action', () => {
  const share = vi.fn();
  const messages = [message({ type: 'image', mediaUrl: 'https://example.test/1.png' }), message({ id: 'm2', type: 'image', mediaUrl: 'https://example.test/2.png' })];
  const view = render(<MessageList conv={conversation(messages)} onShare={share} />);
  expect(screen.getAllByRole('img', { name: 'Ảnh đại diện Minh An' })).toHaveLength(1);
  const image = screen.getAllByRole('button', { name: 'Ảnh' })[0]!;
  fireEvent.mouseEnter(image);
  fireEvent.click(screen.getByTitle('Chia sẻ tin này'));
  expect(share).toHaveBeenCalledWith(messages[0], messages);
  expect(view.container.querySelectorAll('img[alt="Ảnh"]')).toHaveLength(2);
});

it('shows the personal avatar without a group name, and falls back safely when the photo fails', () => {
  const conv = { ...conversation([], false), name: 'Khách thử', avatarUrl: sender.avatarUrl };
  conv.messages = withMessageSenders([message({ sender: undefined })], conv, []);
  render(<MessageList conv={conv} />);
  const avatar = screen.getByRole('img', { name: 'Ảnh đại diện Khách thử' });
  const photo = within(avatar).getByRole('img');
  expect(photo.getAttribute('src')).toBe(sender.avatarUrl);
  fireEvent.error(photo);
  expect(within(avatar).getByText('KT')).toBeTruthy();
  expect(screen.queryByText('Khách thử')).toBeNull();
});

it('shows the actual sending account avatar on outgoing messages', () => {
  render(<MessageList conv={conversation([message({ dir: 'out', sender: { id: 'self:a', name: 'Tài khoản gửi', avatarUrl: 'https://example.test/me.png' } })])} />);
  expect(within(screen.getByRole('img', { name: 'Ảnh đại diện Tài khoản gửi' })).getByRole('img').getAttribute('src')).toBe('https://example.test/me.png');
});
