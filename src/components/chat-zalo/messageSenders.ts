import { linkMediaAnToan } from '@/lib/zaloContent';
import type { ZaloAccount, ZaloConversation, ZaloMessage } from './types';

/** Resolve only within the active account. A group's picture never identifies its members. */
export function withMessageSenders(
  messages: ZaloMessage[], conversation: ZaloConversation,
  contacts: ZaloConversation[], account?: ZaloAccount,
): ZaloMessage[] {
  const own = account?.id === conversation.accountId ? account : undefined;
  const peers = new Map<string, ZaloConversation>();
  for (const contact of contacts) {
    if (conversation.accountId && contact.accountId === conversation.accountId && !contact.isGroup && contact.peerUid) {
      peers.set(contact.peerUid, contact);
    }
  }
  return messages.map((message, index) => {
    if (message.type === 'sys') return message;
    if (message.dir === 'out') return { ...message, sender: {
      id: `self:${conversation.accountId || conversation.id}`,
      name: own?.name || 'Bạn', avatarUrl: linkMediaAnToan(own?.avatarUrl),
    } };
    if (!conversation.isGroup) return { ...message, sender: {
      id: `peer:${conversation.id}`, name: conversation.name,
      avatarUrl: linkMediaAnToan(conversation.avatarUrl),
    } };
    const peer = message.senderId ? peers.get(message.senderId) : undefined;
    return { ...message, sender: {
      // Unknown identities must not merge two different members into one album.
      id: message.senderId ? `member:${message.senderId}` : `unknown:${message.id || message.cliId || index}`,
      name: peer?.name || (message.senderId ? `Thành viên · ${message.senderId.slice(-4)}` : 'Thành viên chưa xác định'),
      avatarUrl: linkMediaAnToan(peer?.avatarUrl),
    } };
  });
}
