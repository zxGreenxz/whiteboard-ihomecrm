import { expect, it } from 'vitest';
import { withMessageSenders } from '../messageSenders';
import { buildThreadItems } from '../threadItems';
import type { ZaloAccount, ZaloConversation, ZaloMessage } from '../types';

const conversation = (values: Partial<ZaloConversation>) => ({ id: 'group', accountId: 'a', name: 'Nhóm thử', isGroup: true, ...values }) as ZaloConversation;
const account = { id: 'a', name: 'Tài khoản A', avatarUrl: 'https://example.test/self.png' } as ZaloAccount;
const contact = conversation({ id: 'friend', isGroup: false, peerUid: 'member-1', name: 'An', avatarUrl: 'https://example.test/an.png' });
const message = (values: Partial<ZaloMessage> = {}): ZaloMessage => ({ id: 'm1', dir: 'in', createdAt: '2026-10-11T10:00:00Z', ...values });

it('resolves private incoming and own outgoing avatars from the correct conversation/account', () => {
  const [incoming, outgoing] = withMessageSenders([message(), message({ dir: 'out' })], contact, [], account);
  expect(incoming?.sender).toMatchObject({ name: 'An', avatarUrl: contact.avatarUrl });
  expect(outgoing?.sender).toMatchObject({ name: 'Tài khoản A', avatarUrl: account.avatarUrl });
});

it('uses group sender UID and never substitutes the group avatar or a different account contact', () => {
  const group = conversation({ avatarUrl: 'https://example.test/group.png' });
  const other = { ...contact, accountId: 'b', name: 'Sai tài khoản' };
  const [known, unknown] = withMessageSenders([message({ senderId: 'member-1' }), message({ id: 'm2', senderId: 'unknown-9876' })], group, [other, contact], account);
  expect(known?.sender?.name).toBe('An');
  expect(known?.sender?.avatarUrl).toBe(contact.avatarUrl);
  expect(unknown?.sender).toMatchObject({ name: 'Thành viên · 9876', avatarUrl: undefined });
  expect(withMessageSenders([message({ senderId: 'member-1' })], group, [other], account)[0]?.sender?.avatarUrl).toBeUndefined();
});

it('does not attribute unknown or system messages to someone else', () => {
  const result = withMessageSenders([message(), message({ id: 'm2' }), message({ type: 'sys' })], conversation({}), [], { ...account, id: 'b' });
  expect(result[0]?.sender?.name).toBe('Thành viên chưa xác định');
  expect(result[0]?.sender?.id).not.toBe(result[1]?.sender?.id);
  expect(result[2]?.sender).toBeUndefined();
  expect(withMessageSenders([message({ dir: 'out' })], conversation({}), [], { ...account, id: 'b' })[0]?.sender?.avatarUrl).toBeUndefined();
});

it('separates albums and message groups belonging to different members', () => {
  const messages = [message({ senderId: 'one', type: 'image' }), message({ id: 'm2', senderId: 'two', type: 'image' })];
  const items = buildThreadItems(withMessageSenders(messages, conversation({}), [], account));
  expect(items.filter(item => item.kind === 'album')).toHaveLength(0);
  expect(items.filter(item => item.kind === 'msg').every(item => !item.grouped)).toBe(true);
});

it('keeps same-member albums intact while unknown members cannot be merged', () => {
  const group = conversation({});
  const pairs = (senderId?: string) => [message({ senderId, type: 'image' }), message({ id: 'm2', senderId, type: 'image' })];
  expect(buildThreadItems(withMessageSenders(pairs('one'), group, [], account)).filter(item => item.kind === 'album')).toHaveLength(1);
  expect(buildThreadItems(withMessageSenders(pairs(), group, [], account)).filter(item => item.kind === 'album')).toHaveLength(0);
});
