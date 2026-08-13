// Tiện ích hội thoại: ghim / tắt thông báo / đánh dấu chưa đọc (optimistic +
// rollback), soạn tin theo SĐT (job async + poll), xoá phía mình, seen/typing.
import { useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { QK } from '@/hooks/useZaloChat';
import type { ZaloConversation } from '@/components/chat-zalo/types';

export function useSetConversationFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string; pinned?: boolean; muted?: boolean; markedUnread?: boolean }) => {
      const { error } = await supabase.rpc('zalo_set_conversation_flags', {
        p_conversation_id: v.conversationId,
        p_pinned: v.pinned,
        p_muted: v.muted,
        p_marked_unread: v.markedUnread,
      });
      if (error) throw error;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: QK.conversations });
      // Optimistic trên MỌI biến thể key (['zalo','conversations', orgId])
      const entries = qc.getQueriesData<ZaloConversation[]>({ queryKey: QK.conversations });
      for (const [key, list] of entries) {
        if (!list) continue;
        qc.setQueryData<ZaloConversation[]>(key, list.map((c) => (c.id === v.conversationId
          ? {
              ...c,
              pinned: v.pinned ?? c.pinned,
              muted: v.muted ?? c.muted,
              markedUnread: v.markedUnread ?? c.markedUnread,
            }
          : c)).sort((a, b) => Number(b.pinned) - Number(a.pinned)));
      }
      return { entries };
    },
    onError: (e: Error, _v, ctx) => {
      for (const [key, list] of ctx?.entries || []) qc.setQueryData(key, list);
      toast.error(e?.message || 'Không đổi được trạng thái hội thoại');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QK.conversations }),
  });
}

// Soạn tin mới theo SĐT: có sẵn → mở luôn; chưa → worker findUser (poll job).
export function useStartChatByPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { accountId: string; phone: string }): Promise<string> => {
      const { data, error } = await supabase.rpc('zalo_start_chat_by_phone', {
        p_account_id: v.accountId, p_phone: v.phone,
      });
      if (error) throw error;
      const res = data as { status?: string; conversation_id?: string; job_id?: string } | null;
      if (res?.status === 'ready' && res.conversation_id) return res.conversation_id;
      const jobId = res?.job_id;
      if (!jobId) throw new Error('Không khởi tạo được tìm kiếm');
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: job } = await supabase
          .from('zalo_send_queue')
          .select('status, result, last_error')
          .eq('id', jobId)
          .maybeSingle();
        if (job?.status === 'sent') {
          const cid = (job.result as { conversation_id?: string } | null)?.conversation_id;
          if (cid) return cid;
          throw new Error('Worker không trả về hội thoại');
        }
        if (job?.status === 'failed') throw new Error(job.last_error || 'Số này không dùng Zalo');
      }
      throw new Error('Tìm kiếm quá lâu — worker có đang chạy không?');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.conversations }),
    onError: (e: Error) => { toast.error(e?.message || 'Không tìm được số này trên Zalo'); },
  });
}

export function useDeleteMessageForMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: string; conversationId: string }) => {
      const { error } = await supabase.rpc('zalo_delete_message_for_me', { p_message_id: v.messageId });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      toast.success('Đã xoá tin ở phía bạn');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không xoá được'); },
  });
}

// Seen/typing outbound — best-effort, fire & forget, throttle phía client.
export function useThreadPresence() {
  const lastSeen = useRef<Record<string, number>>({});
  const lastTyping = useRef<Record<string, number>>({});

  const sendSeen = useCallback((conversationId: string) => {
    const now = Date.now();
    if (now - (lastSeen.current[conversationId] || 0) < 5000) return;
    lastSeen.current[conversationId] = now;
    supabase.rpc('zalo_send_seen', { p_conversation_id: conversationId })
      .then(({ error }) => { if (error) console.error('zalo_send_seen', error.message); });
  }, []);

  const sendTyping = useCallback((conversationId: string) => {
    const now = Date.now();
    if (now - (lastTyping.current[conversationId] || 0) < 5000) return;
    lastTyping.current[conversationId] = now;
    supabase.rpc('zalo_send_typing', { p_conversation_id: conversationId })
      .then(({ error }) => { if (error) console.error('zalo_send_typing', error.message); });
  }, []);

  return { sendSeen, sendTyping };
}
