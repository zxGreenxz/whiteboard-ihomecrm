// Hooks dữ liệu cho trang Chat Zalo (Supabase + Realtime).
// Map row DB → shape ZaloConversation/ZaloMessage mà các component Phần 1 dùng
// (JSX giữ nguyên). RPC mới cast `as any` cho gọn (types.ts đã regen nhưng tránh
// vướng kiểu hàm sinh tự động).
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type {
  ZaloConversation, ZaloMessage, ZaloAutomations, ZaloAccount, ToneKey, TagKey,
} from '@/components/chat-zalo/types';

const db = supabase as any;

// ── format giờ/ngày hiển thị ──
const pad = (n: number) => String(n).padStart(2, '0');
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayDiff(ts: string): number {
  return Math.round((startOfDay(new Date()).getTime() - startOfDay(new Date(ts)).getTime()) / 86400000);
}
function fmtClock(ts: string): string { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtListTime(ts?: string | null): string {
  if (!ts) return '';
  const diff = dayDiff(ts);
  if (diff <= 0) return fmtClock(ts);
  if (diff === 1) return 'Hôm qua';
  const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function fmtDay(ts?: string | null): string {
  if (!ts) return 'Hôm nay';
  const diff = dayDiff(ts);
  if (diff <= 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function initialsFrom(name: string): string {
  const parts = (name || '').trim().split(/\s+/);
  return (parts[parts.length - 1] || '?').slice(0, 2);
}

// ── mappers ──
function mapConv(r: any): ZaloConversation {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.peer_name,
    initials: r.initials || initialsFrom(r.peer_name),
    avatarUrl: r.peer_avatar_url,
    tone: (r.tone as ToneKey) || 'emerald',
    time: fmtListTime(r.last_message_at),
    sub: r.sub_label || '',
    subTone: (r.sub_tone as ToneKey) || null,
    preview: r.last_message_text || '',
    unread: r.unread_count || 0,
    listTag: r.list_tag || null,
    online: !!r.is_online,
    headerTag: r.header_tag || { l: '', t: 'neutral' as TagKey },
    headerSub: r.header_sub || '',
    phone: r.peer_phone || '',
    day: fmtDay(r.last_message_at),
    profile: r.profile || { kind: 'unknown' },
    messages: [],
  };
}
function mapMsg(r: any): ZaloMessage {
  const isImg = r.msg_type === 'image';
  const body = (r.body && String(r.body).trim()) ? r.body : (isImg ? undefined : '[Tin nhắn]');
  return {
    id: r.id,
    type: r.msg_type === 'sys' ? 'sys' : isImg ? 'image' : undefined,
    dir: r.direction,
    text: body,
    label: r.media_label || undefined,
    mediaUrl: r.media_url || undefined,
    imgTone: r.media_tone || undefined,
    time: fmtClock(r.created_at),
    tick: r.status === 'seen' ? 'seen' : r.status === 'sent' ? 'sent' : undefined,
    react: r.reaction_emoji || undefined,
    reply: r.reply_to || undefined,
  };
}

const QK = {
  conversations: ['zalo', 'conversations'] as const,
  messages: (id: string) => ['zalo', 'messages', id] as const,
  automations: ['zalo', 'automations'] as const,
  templates: ['zalo', 'templates'] as const,
  accounts: ['zalo', 'accounts'] as const,
};

function mapAccount(r: any): ZaloAccount {
  return {
    id: r.id, name: r.name, kind: r.kind, status: r.status,
    zaloUid: r.zalo_uid, avatarUrl: r.avatar_url, qrData: r.qr_data, lastError: r.last_error,
  };
}

// ── Danh sách hội thoại ──
export function useZaloConversations() {
  return useQuery({
    queryKey: QK.conversations,
    queryFn: async (): Promise<ZaloConversation[]> => {
      const { data, error } = await db
        .from('zalo_conversations')
        .select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (error) { console.error('useZaloConversations', error); return []; }
      return (data || []).map(mapConv);
    },
  });
}

// ── Tin nhắn của 1 hội thoại ──
export function useZaloMessages(convId?: string) {
  return useQuery({
    queryKey: QK.messages(convId || ''),
    enabled: !!convId,
    queryFn: async (): Promise<ZaloMessage[]> => {
      const { data, error } = await db
        .from('zalo_messages')
        .select('*')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });
      if (error) { console.error('useZaloMessages', error); return []; }
      return (data || []).map(mapMsg);
    },
  });
}

// ── Gửi tin (optimistic) ──
export function useSendZaloMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string; body: string }) => {
      const cliId = `cli_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const { data, error } = await db.rpc('zalo_send_message', {
        p_conversation_id: v.conversationId, p_type: 'text', p_body: v.body, p_cli_msg_id: cliId,
      });
      if (error) throw error;
      return data;
    },
    onMutate: async (v) => {
      const key = QK.messages(v.conversationId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ZaloMessage[]>(key);
      const optimistic: ZaloMessage = {
        dir: 'out', text: v.body,
        time: `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`, tick: 'sent',
      };
      qc.setQueryData<ZaloMessage[]>(key, [...(prev || []), optimistic]);
      return { prev, key };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.key) qc.setQueryData(ctx.key, ctx.prev);
      toast.error('Không gửi được tin nhắn');
      console.error('zalo_send_message', err);
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
  });
}

// ── Thả reaction (lạc quan) ──
export function useReactMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: string; emoji: string; conversationId: string }) => {
      const { error } = await db.rpc('zalo_react_message', { p_message_id: v.messageId, p_emoji: v.emoji });
      if (error) throw error;
    },
    onMutate: async (v) => {
      const key = QK.messages(v.conversationId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ZaloMessage[]>(key);
      qc.setQueryData<ZaloMessage[]>(key, (prev || []).map((m) => (m.id === v.messageId ? { ...m, react: v.emoji } : m)));
      return { prev, key };
    },
    onError: (e, _v, ctx) => { if (ctx?.key) qc.setQueryData(ctx.key, ctx.prev); toast.error('Không thả được cảm xúc'); console.error('zalo_react', e); },
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) }),
  });
}

// ── Thu hồi tin của mình ──
export function useRecallMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: string; conversationId: string }) => {
      const { error } = await db.rpc('zalo_recall_message', { p_message_id: v.messageId });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: any) => { toast.error(e?.message || 'Không thu hồi được'); console.error('zalo_recall', e); },
  });
}

// ── Tải thêm tin cũ (chỉ NHÓM) ──
export function useLoadHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string }) => {
      const { error } = await db.rpc('zalo_load_history', { p_conversation_id: v.conversationId, p_count: 60 });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success('Đang tải thêm tin cũ…');
      // worker xử lý bất đồng bộ → realtime cập nhật; chốt lại sau ~3s cho chắc
      setTimeout(() => qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) }), 3000);
    },
    onError: (e: any) => { toast.error(e?.message || 'Không tải được tin cũ'); console.error('zalo_load_history', e); },
  });
}

// ── Đánh dấu đã đọc ──
export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await db.rpc('zalo_mark_read', { p_conversation_id: conversationId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.conversations }),
  });
}

// ── Tự động hoá ──
export function useZaloAutomations() {
  return useQuery({
    queryKey: QK.automations,
    queryFn: async (): Promise<ZaloAutomations> => {
      const { data, error } = await db.from('zalo_automations').select('kind, enabled');
      if (error) { console.error('useZaloAutomations', error); }
      const rows: { kind: string; enabled: boolean }[] = data || [];
      const get = (k: string) => rows.find((r) => r.kind === k)?.enabled ?? false;
      return { broadcastOn: get('broadcast_vacant'), autoReplyOn: get('auto_reply') };
    },
  });
}

export function useToggleAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { kind: 'broadcast_vacant' | 'auto_reply'; enabled: boolean }) => {
      const { error } = await db.rpc('zalo_toggle_automation', { p_kind: v.kind, p_enabled: v.enabled });
      if (error) throw error;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: QK.automations });
      const prev = qc.getQueryData<ZaloAutomations>(QK.automations);
      const field = v.kind === 'broadcast_vacant' ? 'broadcastOn' : 'autoReplyOn';
      qc.setQueryData<ZaloAutomations>(QK.automations, { ...(prev || { broadcastOn: false, autoReplyOn: false }), [field]: v.enabled } as ZaloAutomations);
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx) qc.setQueryData(QK.automations, ctx.prev); toast.error('Không đổi được trạng thái'); },
    onSettled: () => qc.invalidateQueries({ queryKey: QK.automations }),
  });
}

// ── Thư viện mẫu tin ──
export function useZaloTemplates() {
  return useQuery({
    queryKey: QK.templates,
    queryFn: async (): Promise<{ title: string; color: string }[]> => {
      const { data, error } = await db
        .from('zalo_message_templates')
        .select('title, color, sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (error) { console.error('useZaloTemplates', error); return []; }
      return (data || []).map((t: any) => ({ title: t.title, color: t.color || 'hsl(152 69% 38%)' }));
    },
  });
}

// ── Tài khoản Zalo (kết nối / chuyển / ngắt) ──
export function useZaloAccounts() {
  return useQuery({
    queryKey: QK.accounts,
    queryFn: async (): Promise<ZaloAccount[]> => {
      const { data, error } = await db
        .from('zalo_accounts')
        .select('id, name, kind, status, zalo_uid, avatar_url, qr_data, last_error')
        .order('created_at', { ascending: true });
      if (error) { console.error('useZaloAccounts', error); return []; }
      return (data || []).map(mapAccount);
    },
    // poll nhẹ phòng khi realtime accounts chưa kịp (lúc đang quét QR)
    refetchInterval: 4000,
  });
}

export function useRequestConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { accountId?: string; name?: string }): Promise<ZaloAccount> => {
      const { data, error } = await db.rpc('zalo_request_connect', {
        p_account_id: v.accountId ?? null, p_name: v.name ?? null,
      });
      if (error) throw error;
      return mapAccount(data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.accounts }),
    onError: (e) => { toast.error('Không khởi tạo được kết nối'); console.error('zalo_request_connect', e); },
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await db.rpc('zalo_disconnect_account', { p_account_id: accountId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.accounts }),
    onError: (e) => { toast.error('Không ngắt được kết nối'); console.error('zalo_disconnect_account', e); },
  });
}

// ── Realtime: cập nhật danh sách + luồng tin + trạng thái tài khoản tức thì ──
export function useZaloRealtime(activeId?: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const convCh = supabase
      .channel('zalo-convs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_conversations' }, () => {
        qc.invalidateQueries({ queryKey: QK.conversations });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_accounts' }, () => {
        qc.invalidateQueries({ queryKey: QK.accounts });
      })
      .subscribe();
    return () => { supabase.removeChannel(convCh); };
  }, [qc]);

  useEffect(() => {
    if (!activeId) return;
    const msgCh = supabase
      .channel(`zalo-msg-${activeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_messages', filter: `conversation_id=eq.${activeId}` }, () => {
        qc.invalidateQueries({ queryKey: QK.messages(activeId) });
        qc.invalidateQueries({ queryKey: QK.conversations });
      })
      .subscribe();
    return () => { supabase.removeChannel(msgCh); };
  }, [activeId, qc]);
}
