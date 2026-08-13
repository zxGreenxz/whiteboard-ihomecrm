// Hooks dữ liệu cho trang Chat Zalo (Supabase + Realtime).
// Map row DB → shape ZaloConversation/ZaloMessage mà các component dùng.
//
// ORG-SCOPED (2026-08-13): mỗi công ty một khu Zalo riêng. Mọi query lọc theo
// organization_id của org hiện hành (useOrganization — user đa-org lấy org[0]
// cho tới khi có switcher); RLS phía DB là hàng rào thật, filter ở đây để
// user đa-org không thấy trộn dữ liệu và để realtime không refetch chéo org.
//
// BA QUY TẮC CHỐNG EGRESS (sự cố 3.1GB 26/06 — GIỮ NGUYÊN khi sửa file này):
//   1. Debounce invalidate realtime ≥400ms (gom bão event bulk-sync về 1 refetch).
//   2. Chọn cột tường minh CONV_COLS/MSG_COLS — cấm select('*'); thêm cột hiển
//      thị mới thì thêm vào hằng.
//   3. LIMIT trần: CONV_LIMIT 5000 / MSG_LIMIT 1000 (tin mới nhất, đảo client).
import { useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import type {
  ZaloConversation, ZaloMessage, ZaloAutomations, ZaloAccount, ZaloLabel, ToneKey, TagKey,
} from '@/components/chat-zalo/types';

// Cast một chỗ cho các bảng zalo_* (types sinh tự động có đủ nhưng shape query
// động ở đây tồn tại từ trước ratchet rpc-cast — KHÔNG thêm cast mới ngoài dòng này).
const db = supabase as any;

const CONV_COLS = 'id, account_id, label_ids, peer_name, initials, peer_avatar_url, tone, last_message_at, sub_label, sub_tone, last_message_text, unread_count, list_tag, is_online, header_tag, header_sub, peer_phone, profile, is_pinned, is_muted, marked_unread, thread_type, customer_id, lead_id, contract_id, room_id';
const MSG_COLS = 'id, msg_type, body, direction, media_label, media_url, media_tone, media_meta, created_at, status, reaction_emoji, reply_to, cli_msg_id';
const CONV_LIMIT = 5000;
const MSG_LIMIT = 1000;

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
    labelIds: Array.isArray(r.label_ids) ? r.label_ids.map(Number) : [],
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
    pinned: !!r.is_pinned,
    muted: !!r.is_muted,
    markedUnread: !!r.marked_unread,
    hasMessages: !!r.last_message_at,
    isGroup: r.thread_type === 'group' || !!(r.profile && r.profile.isGroup),
    customerId: r.customer_id || null,
    leadId: r.lead_id || null,
    contractId: r.contract_id || null,
    roomId: r.room_id || null,
  };
}
export function mapMsg(r: any): ZaloMessage {
  const t = r.msg_type;
  const type = t === 'sys' ? 'sys'
    : t === 'image' ? 'image'
    : t === 'video' ? 'video'
    : t === 'voice' ? 'voice'
    : t === 'file' ? 'file'
    : t === 'sticker' ? 'sticker'
    : undefined;
  const isMedia = !!type && type !== 'sys';
  const body = (r.body && String(r.body).trim()) ? r.body : (isMedia ? undefined : '[Tin nhắn]');
  return {
    id: r.id,
    type,
    dir: r.direction,
    text: body,
    label: r.media_label || undefined,
    mediaUrl: r.media_url || undefined,
    videoThumb: r.media_meta?.thumb || undefined,
    imgTone: r.media_tone || undefined,
    mediaMeta: r.media_meta || null,
    time: fmtClock(r.created_at),
    createdAt: r.created_at,
    tick: r.status === 'seen' ? 'seen'
      : r.status === 'sent' ? 'sent'
      : r.status === 'failed' ? 'failed'
      : r.status === 'pending' ? 'pending'
      : undefined,
    react: r.reaction_emoji || undefined,
    reply: r.reply_to || undefined,
    cliId: r.cli_msg_id || undefined,
  };
}

// Prefix ổn định cho invalidate (realtime dùng prefix — khớp mọi biến thể org).
export const QK = {
  conversations: ['zalo', 'conversations'] as const,
  messages: (id: string) => ['zalo', 'messages', id] as const,
  automations: ['zalo', 'automations'] as const,
  templates: ['zalo', 'templates'] as const,
  accounts: ['zalo', 'accounts'] as const,
  labels: ['zalo', 'labels'] as const,
};

/** organization_id của khu Zalo hiện hành (org đầu tiên của user). */
export function useZaloOrgId(): string | null {
  const { organization } = useOrganization();
  return organization?.id ?? null;
}

function mapAccount(r: any): ZaloAccount {
  return {
    id: r.id, name: r.name, kind: r.kind, status: r.status,
    zaloUid: r.zalo_uid, avatarUrl: r.avatar_url, qrData: r.qr_data, lastError: r.last_error,
  };
}

// ── Danh sách hội thoại (ghim lên đầu, còn lại theo tin mới nhất) ──
export function useZaloConversations() {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.conversations, orgId],
    enabled: !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloConversation[]> => {
      const { data, error } = await db
        .from('zalo_conversations')
        .select(CONV_COLS)
        .eq('organization_id', orgId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(CONV_LIMIT);
      if (error) throw error;
      const list = (data || []).map(mapConv);
      // ghim lên đầu — sort client-side, không đổi query
      return list.sort((a: ZaloConversation, b: ZaloConversation) => Number(b.pinned) - Number(a.pinned));
    },
  });
}

// ── Tin nhắn của 1 hội thoại ──
export function useZaloMessages(convId?: string) {
  return useQuery({
    queryKey: QK.messages(convId || ''),
    enabled: !!convId,
    retry: 1,
    queryFn: async (): Promise<ZaloMessage[]> => {
      // Lấy MSG_LIMIT tin MỚI nhất (desc) rồi đảo lại — tránh kéo cả lịch sử.
      // Bỏ tin đã "xoá phía mình" (hidden_at).
      const { data, error } = await db
        .from('zalo_messages')
        .select(MSG_COLS)
        .eq('conversation_id', convId)
        .is('hidden_at', null)
        .order('created_at', { ascending: false })
        .limit(MSG_LIMIT);
      if (error) throw error;
      return (data || []).slice().reverse().map(mapMsg);
    },
  });
}

// ── Gửi tin text (optimistic → thay bằng dòng thật khi RPC trả về) ──
export function useSendZaloMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      conversationId: string; body: string;
      replyToMessageId?: string; replyPreview?: { name: string; text: string } | null;
      mentions?: { uid: string; pos: number; len: number }[];
    }) => {
      // §13.15 — cli id phải TOÀN CỤC duy nhất; bộ đếm per-view trùng trong
      // cửa sổ dedup làm tin thứ 2 bị nuốt.
      const cliId = crypto.randomUUID();
      const { data, error } = await db.rpc('zalo_send_message', {
        p_conversation_id: v.conversationId, p_type: 'text', p_body: v.body, p_cli_msg_id: cliId,
        p_reply_to: v.replyPreview ?? null,
        p_reply_to_message_id: v.replyToMessageId ?? null,
        p_mentions: v.mentions && v.mentions.length ? v.mentions : null,
      });
      if (error) throw error;
      return { row: data, cliId };
    },
    onMutate: async (v) => {
      const key = QK.messages(v.conversationId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ZaloMessage[]>(key);
      const cliId = `optimistic_${Date.now()}`;
      const optimistic: ZaloMessage = {
        dir: 'out', text: v.body, cliId,
        reply: v.replyPreview || undefined,
        time: `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`, tick: 'pending',
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<ZaloMessage[]>(key, [...(prev || []), optimistic]);
      return { prev, key, optimisticCliId: cliId };
    },
    onSuccess: (res, v, ctx) => {
      // Thay bubble lạc quan bằng dòng thật NGAY (có id → thao tác được liền),
      // không phải chờ refetch.
      if (ctx?.key && res?.row) {
        const real = mapMsg(res.row);
        qc.setQueryData<ZaloMessage[]>(ctx.key, (cur) =>
          (cur || []).map((m) => (m.cliId === ctx.optimisticCliId ? real : m)));
      }
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
      setTimeout(() => qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) }), 3000);
    },
    onError: (e: any) => { toast.error(e?.message || 'Không tải được tin cũ'); console.error('zalo_load_history', e); },
  });
}

// ── Đánh dấu đã đọc (xoá cả cờ đánh-dấu-chưa-đọc thủ công) ──
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

// ── Tự động hoá (theo TỔ CHỨC) ──
export function useZaloAutomations() {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.automations, orgId],
    enabled: !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloAutomations> => {
      const { data, error } = await db.from('zalo_automations')
        .select('kind, enabled').eq('organization_id', orgId);
      if (error) throw error;
      const rows: { kind: string; enabled: boolean }[] = data || [];
      const get = (k: string) => rows.find((r) => r.kind === k)?.enabled ?? false;
      return { broadcastOn: get('broadcast_vacant'), autoReplyOn: get('auto_reply') };
    },
  });
}

export function useToggleAutomation() {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();
  return useMutation({
    mutationFn: async (v: { kind: 'broadcast_vacant' | 'auto_reply'; enabled: boolean }) => {
      const { error } = await db.rpc('zalo_toggle_automation', {
        p_kind: v.kind, p_enabled: v.enabled, p_organization_id: orgId,
      });
      if (error) throw error;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: QK.automations });
      const key = [...QK.automations, orgId];
      const prev = qc.getQueryData<ZaloAutomations>(key);
      const field = v.kind === 'broadcast_vacant' ? 'broadcastOn' : 'autoReplyOn';
      qc.setQueryData<ZaloAutomations>(key, { ...(prev || { broadcastOn: false, autoReplyOn: false }), [field]: v.enabled } as ZaloAutomations);
      return { prev, key };
    },
    onError: (_e, _v, ctx) => { if (ctx) qc.setQueryData(ctx.key, ctx.prev); toast.error('Không đổi được trạng thái'); },
    onSettled: () => qc.invalidateQueries({ queryKey: QK.automations }),
  });
}

// ── Thư viện mẫu tin (picker chèn BODY — title chỉ là nhãn) ──
export interface ZaloTemplateItem { id: string; title: string; body: string; color: string }
export function useZaloTemplates() {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.templates, orgId],
    enabled: !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloTemplateItem[]> => {
      const { data, error } = await db
        .from('zalo_message_templates')
        .select('id, title, body, color, sort_order')
        .eq('organization_id', orgId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data || []).map((t: any) => ({
        id: t.id, title: t.title,
        body: (t.body && String(t.body).trim()) ? t.body : t.title,
        color: t.color || 'hsl(152 69% 38%)',
      }));
    },
  });
}

// ── Nhãn "Phân loại" ──
export function useZaloLabels() {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.labels, orgId],
    enabled: !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloLabel[]> => {
      const { data, error } = await db.from('zalo_labels')
        .select('label_id, name, color, emoji, sort_order')
        .eq('organization_id', orgId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      const seen = new Map<number, ZaloLabel>();
      for (const r of (data || [])) if (!seen.has(r.label_id)) seen.set(r.label_id, { labelId: r.label_id, name: r.name, color: r.color, emoji: r.emoji });
      return [...seen.values()];
    },
  });
}

// ── Chia sẻ / Gửi hàng loạt ──
export function useBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationIds: string[]; body: string }): Promise<number> => {
      const { data, error } = await db.rpc('zalo_broadcast', { p_conversation_ids: v.conversationIds, p_body: v.body });
      if (error) throw error;
      return Number(data) || 0;
    },
    onSuccess: (n) => { toast.success(`Đã gửi tới ${n} hội thoại`); qc.invalidateQueries({ queryKey: QK.conversations }); },
    onError: (e: any) => { toast.error(e?.message || 'Không gửi được'); console.error('zalo_broadcast', e); },
  });
}

// ── Tài khoản Zalo (của TỔ CHỨC hiện hành) ──
export function useZaloAccounts() {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.accounts, orgId],
    enabled: !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloAccount[]> => {
      const { data, error } = await db
        .from('zalo_accounts')
        .select('id, name, kind, status, zalo_uid, avatar_url, qr_data, last_error')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(mapAccount);
    },
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });
}

export function useRequestConnect() {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();
  return useMutation({
    mutationFn: async (v: { accountId?: string; name?: string }): Promise<ZaloAccount> => {
      const { data, error } = await db.rpc('zalo_request_connect', {
        p_account_id: v.accountId ?? null, p_name: v.name ?? null, p_organization_id: orgId,
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
  const orgId = useZaloOrgId();

  // Debounce gộp bão event bulk-sync về ~1 refetch/đợt (quy tắc egress #1).
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debouncedInvalidate = useCallback((key: readonly unknown[], ms = 400) => {
    const k = key.join('|');
    const t = timers.current;
    if (t[k]) clearTimeout(t[k]);
    t[k] = setTimeout(() => { delete t[k]; qc.invalidateQueries({ queryKey: key as any }); }, ms);
  }, [qc]);
  useEffect(() => {
    const t = timers.current;
    return () => { for (const k in t) clearTimeout(t[k]); };
  }, []);

  useEffect(() => {
    if (!orgId) return;
    // Filter theo org ngay ở subscription: user đa-org không nhận event của
    // org khác → không refetch chéo (đúng tinh thần tách bạch + egress).
    const convCh = supabase
      .channel('zalo-convs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_conversations', filter: `organization_id=eq.${orgId}` }, () => {
        debouncedInvalidate(QK.conversations);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_accounts', filter: `organization_id=eq.${orgId}` }, () => {
        debouncedInvalidate(QK.accounts, 200);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_labels', filter: `organization_id=eq.${orgId}` }, () => {
        debouncedInvalidate(QK.labels);
      })
      .subscribe();
    return () => { supabase.removeChannel(convCh); };
  }, [debouncedInvalidate, orgId]);

  useEffect(() => {
    if (!activeId) return;
    const msgCh = supabase
      .channel(`zalo-msg-${activeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_messages', filter: `conversation_id=eq.${activeId}` }, () => {
        debouncedInvalidate(QK.messages(activeId));
        debouncedInvalidate(QK.conversations);
      })
      .subscribe();
    return () => { supabase.removeChannel(msgCh); };
  }, [activeId, debouncedInvalidate]);
}
