import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseConversations, parseMessages } from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

const boundedLimit = (limit: number) => Math.max(1, Math.min(100, Math.trunc(limit)));

export interface OpenClawConversationCursor {
  lastReceivedAt: string;
  id: string;
}

export interface OpenClawMessageCursor {
  receivedAt: string;
  id: string;
}

export async function fetchOpenClawConversations(
  organizationId: string,
  accountId: string,
  cursor: OpenClawConversationCursor | null = null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  const { data, error } = await supabase.rpc("openclaw_list_conversations_v1", {
    p_request: {
      version: 1,
      organizationId,
      accountId,
      cursorLastReceivedAt: cursor?.lastReceivedAt ?? null,
      cursorId: cursor?.id ?? null,
      limit: safeLimit,
    },
  });
  if (error) throw error;
  return parseConversations(data);
}

export function useOpenClawInbox(
  organizationId: string | null,
  accountId: string | null,
  cursor: OpenClawConversationCursor | null = null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.conversations(organizationId ?? "", accountId ?? "", cursor?.lastReceivedAt, cursor?.id, safeLimit),
    enabled: Boolean(organizationId && accountId),
    placeholderData: previous => previous,
    queryFn: () => fetchOpenClawConversations(organizationId!, accountId!, cursor, safeLimit),
  });
}

export async function fetchOpenClawMessages(
  organizationId: string,
  accountId: string,
  conversationId: string,
  cursor: OpenClawMessageCursor | null = null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  const { data, error } = await supabase.rpc("openclaw_list_messages_v1", {
    p_request: {
      version: 1,
      organizationId,
      accountId,
      conversationId,
      cursorReceivedAt: cursor?.receivedAt ?? null,
      cursorId: cursor?.id ?? null,
      limit: safeLimit,
    },
  });
  if (error) throw error;
  return parseMessages(data);
}

export function useOpenClawMessages(
  organizationId: string | null,
  accountId: string | null,
  conversationId: string | null,
  cursor: OpenClawMessageCursor | null = null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.messages(organizationId ?? "", accountId ?? "", conversationId ?? "", cursor?.receivedAt, cursor?.id, safeLimit),
    enabled: Boolean(organizationId && accountId && conversationId),
    placeholderData: previous => previous,
    queryFn: () => fetchOpenClawMessages(organizationId!, accountId!, conversationId!, cursor, safeLimit),
  });
}
