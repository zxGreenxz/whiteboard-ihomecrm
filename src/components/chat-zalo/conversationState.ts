import type { ZaloConversation, ZaloLabel } from './types';

/** Mã nhãn chỉ duy nhất trong một tài khoản Zalo. */
export const zaloLabelKey = (label: Pick<ZaloLabel, 'accountId' | 'labelId'>) => `${label.accountId}:${label.labelId}`;
export function conversationHasLabel(conversation: ZaloConversation, selected: string | null): boolean {
  return selected === null || !!conversation.accountId && (conversation.labelIds ?? []).some(labelId =>
    zaloLabelKey({ accountId: conversation.accountId!, labelId }) === selected);
}
export const hasCrmLink = (conversation: ZaloConversation) =>
  !!(conversation.customerId || conversation.leadId || conversation.contractId || conversation.roomId);
export const isTenantConversation = (conversation: ZaloConversation) =>
  !!(conversation.contractId || conversation.roomId);
