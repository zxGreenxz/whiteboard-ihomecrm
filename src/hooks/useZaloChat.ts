import { ZaloActionUnknownError, zaloActionErrorMessage } from '@/lib/zaloActionFeedback';
import { notifyActionError } from '@/lib/actionFeedback';
import { chuHienThi, docThe, linkMediaAnToan } from '@/lib/zaloContent';
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
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { createBurstScheduler } from '@/lib/realtime/burstScheduler';
import { subscribeResilient } from '@/lib/realtime/subscribeResilient';
import { useOrganization } from '@/contexts/OrganizationContext';
import type {
  ZaloConversation, ZaloMessage, ZaloAutomations, ZaloAccount, ZaloLabel, ToneKey, TagKey, ZaloProfile, ZaloGroupMembers,
} from '@/components/chat-zalo/types';

// Cast một chỗ cho các bảng zalo_* (types sinh tự động có đủ nhưng shape query
// động ở đây tồn tại từ trước ratchet rpc-cast — KHÔNG thêm cast mới ngoài dòng này).
const db = supabase as any;

// Member maps can be large. The list only reads the small profile fields it displays.
const PROFILE_FIELDS = ['kind', 'room', 'roomSub', 'price', 'contractCode', 'contractTerm', 'contractStatus', 'debt', 'issue', 'stage', 'source', 'company', 'phone', 'rooms', 'stats', 'isGroup', 'members', 'desc', 'staff', 'tags'] as const satisfies readonly (keyof ZaloProfile)[];
export const CONV_COLS = 'id, account_id, peer_zalo_uid, label_ids, peer_name, initials, peer_avatar_url, tone, last_message_at, sub_label, sub_tone, last_message_text, unread_count, list_tag, is_online, header_tag, header_sub, peer_phone, is_pinned, is_muted, marked_unread, thread_type, customer_id, lead_id, contract_id, room_id, is_sale_partner,' + PROFILE_FIELDS.map(key => `profile_${key}:profile->${key}`).join(',');
const MSG_COLS = 'id, sender_uid:zalo_raw->>uidFrom, sender_name:zalo_raw->>senderName, msg_type, body, direction, media_label, media_url, media_tone, media_meta, created_at, status, reaction_emoji, reply_to, cli_msg_id';
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
export function mapConv(r: any): ZaloConversation {
  const profile = r.profile || { kind: 'unknown', ...Object.fromEntries(PROFILE_FIELDS.filter(key => r[`profile_${key}`] != null).map(key => [key, r[`profile_${key}`]])) };
  return {
    id: r.id,
    peerUid: r.peer_zalo_uid,
    accountId: r.account_id,
    labelIds: Array.isArray(r.label_ids) ? r.label_ids.map(Number) : [],
    name: r.peer_name,
    initials: r.initials || initialsFrom(r.peer_name),
    avatarUrl: r.peer_avatar_url,
    tone: (r.tone as ToneKey) || 'emerald',
    time: fmtListTime(r.last_message_at),
    sub: r.sub_label || '',
    subTone: (r.sub_tone as ToneKey) || null,
    preview: chuHienThi(r.last_message_text || ''),
    unread: r.unread_count || 0,
    listTag: r.list_tag || null,
    online: !!r.is_online,
    headerTag: r.header_tag || { l: '', t: 'neutral' as TagKey },
    headerSub: r.header_sub || '',
    phone: r.peer_phone || '',
    day: fmtDay(r.last_message_at),
    profile,
    messages: [],
    pinned: !!r.is_pinned,
    muted: !!r.is_muted,
    markedUnread: !!r.marked_unread,
    hasMessages: !!r.last_message_at,
    isGroup: r.thread_type ? r.thread_type === 'group' : !!profile.isGroup,
    isSalePartner: !!r.is_sale_partner,
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
  const body = t === 'sys' && r.direction === 'out' && r.body === '(Tin đã được thu hồi)'
    ? 'Đã yêu cầu thu hồi tin nhắn. Chưa xác nhận kết quả thu hồi trên Zalo.'
    : (r.body && String(r.body).trim()) ? r.body : (isMedia ? undefined : '[Tin nhắn]');
  return {
    id: r.id,
    senderId: typeof r.sender_uid === 'string' && r.sender_uid ? r.sender_uid : undefined,
    senderName: typeof r.sender_name === 'string' && r.sender_name.trim() ? r.sender_name.trim() : undefined,
    type,
    dir: r.direction,
    // Tin chữ: chuỗi máy kiểu "sendBubbleMessage" (tin thẻ ghi trước 10/2026) thành câu đọc được.
    text: body !== undefined && !isMedia ? chuHienThi(String(body)) : body,
    card: isMedia ? null : docThe(r.media_meta),
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
      // hermes-parity:begin zalo-conversations — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
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
      // hermes-parity:end zalo-conversations
    },
  });
}

// ── Tin nhắn của 1 hội thoại ──
export function useZaloMessages(convId?: string) {
  return useQuery({
    queryKey: QK.messages(convId || ''),
    meta: { label: 'tin nhắn Zalo', errorDisplay: 'inline' },
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

export function mapGroupMembers(value: unknown): ZaloGroupMembers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const members: ZaloGroupMembers = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 160) : undefined;
    const avatarUrl = typeof entry.avatarUrl === 'string' ? linkMediaAnToan(entry.avatarUrl) : undefined;
    if (name || avatarUrl) members[id] = { name, avatarUrl };
  }
  return members;
}

export function useZaloGroupMembers(conversation?: ZaloConversation) {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.conversations, orgId, 'members', conversation?.accountId, conversation?.id],
    enabled: !!orgId && !!conversation?.isGroup && !!conversation.accountId,
    meta: { label: 'thành viên nhóm Zalo', errorDisplay: 'inline' },
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ZaloGroupMembers> => {
      const { data, error } = await db.from('zalo_conversations').select('member_profiles:profile->memberProfiles')
        .eq('id', conversation?.id).eq('account_id', conversation?.accountId).eq('organization_id', orgId).eq('thread_type', 'group').single();
      if (error) throw error;
      return mapGroupMembers(data?.member_profiles);
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
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') throw new Error('Unconfirmed Zalo text queue response');
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
      notifyActionError(err, 'Chưa xác nhận được kết quả gửi tin nhắn Zalo');
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
    onError: (e, _v, ctx) => { if (ctx?.key) qc.setQueryData(ctx.key, ctx.prev); notifyActionError(e, 'Chưa xác nhận được kết quả thả cảm xúc'); console.error('zalo_react', e); },
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
      toast.info('Đã tiếp nhận yêu cầu thu hồi tin nhắn. Chưa xác nhận kết quả thu hồi trên Zalo.');
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: any) => { notifyActionError(e, 'Không thu hồi được'); console.error('zalo_recall', e); },
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
      toast.info('Đã yêu cầu tải thêm tin nhắn cũ. Tin nhắn sẽ xuất hiện khi đồng bộ xong.');
      setTimeout(() => qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) }), 3000);
    },
    onError: (e: any) => { notifyActionError(e, 'Không tải được tin cũ'); console.error('zalo_load_history', e); },
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
    onError: (error, _v, ctx) => { if (ctx) qc.setQueryData(ctx.key, ctx.prev); notifyActionError(error,'Chưa xác nhận được trạng thái tự động hóa Zalo'); },
    onSettled: () => qc.invalidateQueries({ queryKey: QK.automations }),
  });
}

// ── Cấu hình tự động hoá đầy đủ (enabled + config jsonb) ──
// Tách khỏi useZaloAutomations: cái đó chỉ lấy 2 cờ bật/tắt cho tab, cái này
// kéo cả `config` nên chỉ nạp khi người dùng thực sự mở màn cài đặt.
export interface ZaloAutomationRow {
  kind: 'broadcast_vacant' | 'auto_reply';
  enabled: boolean;
  config: unknown;
  stats: Record<string, unknown> | null;
  updatedAt: string | null;
}
export function useZaloAutomationConfigs(enabled = true) {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.automations, 'config', orgId],
    enabled: !!orgId && enabled,
    retry: 1,
    queryFn: async (): Promise<Record<string, ZaloAutomationRow>> => {
      const { data, error } = await db.from('zalo_automations')
        .select('kind, enabled, config, stats, updated_at')
        .eq('organization_id', orgId);
      if (error) throw error;
      const ra: Record<string, ZaloAutomationRow> = {};
      for (const r of data || []) {
        ra[r.kind] = {
          kind: r.kind, enabled: !!r.enabled, config: r.config,
          stats: r.stats || null, updatedAt: r.updated_at || null,
        };
      }
      return ra;
    },
  });
}

/** Lưu cả trạng thái bật/tắt lẫn cấu hình. Bỏ trống `config` = chỉ bật/tắt. */
export function useSaveAutomation() {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();
  return useMutation({
    mutationFn: async (v: { kind: 'broadcast_vacant' | 'auto_reply'; enabled: boolean; config?: unknown }) => {
      const { error } = await db.rpc('zalo_luu_tu_dong_hoa', {
        p_kind: v.kind,
        p_enabled: v.enabled,
        p_config: v.config === undefined ? null : v.config,
        p_organization_id: orgId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt tự động hoá');
      qc.invalidateQueries({ queryKey: QK.automations });
    },
    onError: (e: Error) => notifyActionError(e, 'Không lưu được cài đặt'),
  });
}

// ── Nhật ký chạy tự động hoá (chỉ đọc — worker là bên ghi) ──
export interface ZaloAutomationRun {
  id: string;
  kind: 'broadcast_vacant' | 'auto_reply';
  mode: 'full' | 'compact' | 'event' | 'reply' | 'skipped' | 'off' | 'failed';
  reason: string | null;
  recipientsCount: number;
  messagesCount: number;
  detail: Record<string, unknown>;
  createdAt: string;
}
/** Hàng thô từ DB — khai riêng để phần map không phải mượn `any`. */
interface ZaloAutomationRunRow {
  id: string;
  kind: ZaloAutomationRun['kind'];
  mode: ZaloAutomationRun['mode'];
  reason: string | null;
  recipients_count: number | null;
  messages_count: number | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}
const RUNS_LIMIT = 50;
export function useZaloAutomationRuns(enabled = true) {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.automations, 'runs', orgId],
    enabled: !!orgId && enabled,
    retry: 1,
    queryFn: async (): Promise<ZaloAutomationRun[]> => {
      // Cột tường minh + LIMIT trần: cùng quy tắc chống egress với hai bảng kia.
      const { data, error } = await db.from('zalo_automation_runs')
        .select('id, kind, mode, reason, recipients_count, messages_count, detail, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(RUNS_LIMIT);
      if (error) throw error;
      const rows = (data || []) as ZaloAutomationRunRow[];
      return rows.map((r) => ({
        id: r.id, kind: r.kind, mode: r.mode, reason: r.reason,
        recipientsCount: r.recipients_count ?? 0,
        messagesCount: r.messages_count ?? 0,
        detail: r.detail || {},
        createdAt: r.created_at,
      }));
    },
  });
}

/**
 * DỪNG KHẨN CẤP: huỷ mọi tin tự động đang chờ + tắt cả hai công tắc.
 *
 * Vì sao cần một nút riêng thay vì chỉ gạt công tắc: engine xếp CẢ LÔ tin vào
 * hàng đợi với giờ gửi rải sẵn. Gạt công tắc chỉ ngăn lượt SAU — lô đang bay vẫn
 * lần lượt đi ra trong nhiều phút. Đã cắn thật 31/08/2026 ngay lượt chạy đầu
 * tiên: chủ dự án bấm tắt và tin vẫn tiếp tục nhắn.
 */
export interface KetQuaDungKhanCap {
  daHuy: number;
  tinDanhDauThatBai: number;
  conDangGui: number;
}
export function useEmergencyStop() {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();
  return useMutation({
    mutationFn: async (): Promise<KetQuaDungKhanCap> => {
      const { data, error } = await db.rpc('zalo_dung_khan_cap', { p_organization_id: orgId });
      if (error) throw error;
      const r = (data || {}) as Record<string, number>;
      if (!['da_huy','tin_danh_dau_that_bai','con_dang_gui'].every(key => typeof r[key] === 'number' && Number.isInteger(r[key]) && r[key] >= 0)) throw new Error('Unconfirmed emergency stop response');
      return {
        daHuy: r.da_huy ?? 0,
        tinDanhDauThatBai: r.tin_danh_dau_that_bai ?? 0,
        conDangGui: r.con_dang_gui ?? 0,
      };
    },
    onSuccess: (r) => {
      // Nói rõ cả phần KHÔNG chặn được: worker có thể đang cầm 1 tin giữa chừng
      // một lời gọi Zalo, tin đó vẫn sẽ đi ra. Giấu chi tiết này đi thì người
      // dùng thấy một tin lọt sau khi bấm và mất tin vào nút.
      const them = r.conDangGui > 0
        ? ` Còn ${r.conDangGui} tin đang xử lý có thể tiếp tục được gửi.`
        : '';
      (r.conDangGui > 0 ? toast.warning : r.daHuy > 0 ? toast.success : toast.info)(
        r.daHuy > 0
          ? `Đã dừng: huỷ ${r.daHuy} tin đang chờ, tắt cả hai công tắc.${them}`
          : `Không còn tin nào đang chờ. Đã tắt cả hai công tắc.${them}`,
      );
      qc.invalidateQueries({ queryKey: QK.automations });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: Error) => notifyActionError(e, 'Chưa xác nhận được kết quả dừng lịch gửi Zalo'),
  });
}

/** Bật/tắt cờ "hội thoại này là sale" — quyết định ai nhận tin tự động. */
export function useMarkSalePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string; isSale: boolean }) => {
      const { error } = await db.rpc('zalo_danh_dau_sale', {
        p_conversation_id: v.conversationId, p_is_sale: v.isSale,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success(v.isSale ? 'Đã đánh dấu là sale/môi giới' : 'Đã bỏ đánh dấu sale');
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: Error) => notifyActionError(e, 'Không đổi được đánh dấu'),
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
        .select('account_id, label_id, name, color, emoji, sort_order')
        .eq('organization_id', orgId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      const seen = new Map<string, ZaloLabel>();
      for (const r of (data || [])) {
        const key = `${r.account_id}:${r.label_id}`;
        if (!seen.has(key)) seen.set(key, { accountId: r.account_id, labelId: r.label_id, name: r.name, color: r.color, emoji: r.emoji });
      }
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
      if (typeof data !== 'number' || !Number.isInteger(data) || data < 0 || data > v.conversationIds.length) throw new Error('Unconfirmed broadcast queue response');
      return data;
    },
    onSuccess: (n, v) => {
      const total = v.conversationIds.length;
      const message = `Đã xếp ${n}/${total} hội thoại vào hàng đợi gửi`;
      if (n < total) {
        toast.warning(message, { description: `${total - n} hội thoại chưa được xếp hàng. Kiểm tra quyền và trạng thái hội thoại; không gửi lại toàn bộ danh sách.` });
      } else {
        toast.info(message);
      }
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: any) => { notifyActionError(e, 'Chưa xác nhận được kết quả xếp hàng gửi Zalo'); console.error('zalo_broadcast', e); },
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
    // 60 s → 5 phút (21/10/2026, RT-OTHER-5): kênh zalo-convs đã nghe
    // zalo_accounts và bắt kịp sau rớt kết nối; poll chỉ còn là lưới an toàn.
    // Nhịp tim worker (useZaloWorkerStatus) vẫn 60 s — nó không có realtime.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

// ── Nhịp tim worker: worker chết đột ngột thì `zalo_accounts.status` vẫn 'connected' ──
// (05/09–10/10/2026 không ai biết worker đã dừng). RPC chỉ trả thời điểm, không lộ máy chạy.
export interface ZaloWorkerStatus {
  online: boolean;
  heartbeatAt: string | null;
  secondsSince: number | null;
}

export function mapWorkerStatus(raw: unknown): ZaloWorkerStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    online: r.online === true,
    heartbeatAt: typeof r.heartbeat_at === 'string' ? r.heartbeat_at : null,
    secondsSince: typeof r.seconds_since === 'number' ? r.seconds_since : null,
  };
}

export function useZaloWorkerStatus() {
  return useQuery({
    queryKey: ['zalo', 'worker-status'],
    retry: 1,
    queryFn: async (): Promise<ZaloWorkerStatus> => {
      const { data, error } = await db.rpc('zalo_worker_status_v1');
      if (error) throw error;
      return mapWorkerStatus(data);
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
      if (!data || typeof data.id !== 'string' || !data.id || data.status !== 'connecting' || data.kind !== 'personal'
        || (v.accountId && data.id !== v.accountId) || (orgId && data.organization_id !== orgId))
        throw new ZaloActionUnknownError('khởi tạo kết nối Zalo', v.accountId ? {label:'Mã tài khoản',id:v.accountId} : undefined);
      return mapAccount(data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.accounts }),
    onError: (e) => { toast.error(zaloActionErrorMessage(e, 'khởi tạo kết nối Zalo')); console.error('zalo_request_connect', e); },
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
    onError: (e) => { notifyActionError(e, 'Chưa xác nhận được kết quả ngắt kết nối Zalo'); console.error('zalo_disconnect_account', e); },
  });
}

// ── Realtime: cập nhật danh sách + luồng tin + trạng thái tài khoản tức thì ──
//
// 21/10/2026 (plan realtime + thông báo, A8 — RT-OTHER-2/3/7, RT-DB-3):
//   - Gom 800 ms, TRẦN 2,5 s (quy tắc egress #1 vẫn giữ: ≥400 ms). Debounce
//     400 ms trailing thuần cũ không có mốc nhả muộn nhất, mà giờ cao điểm ~24
//     tin/phút thì hầu như không gộp được gì.
//   - Tab ẩn chỉ đặt cờ, hiện lại mới tải MỘT lần: mỗi sự kiện danh sách kéo lại
//     tới 5.000 hội thoại (~2 MB JSON chưa nén) — tab bỏ quên không được trả giá đó.
//   - Key EXACT theo org/hội thoại: prefix QK.conversations cũ kéo theo cả key
//     thành viên nhóm ([..., orgId, 'members', …]) và danh sách của org khác.
//   - Sự kiện tin nhắn chỉ làm mới luồng tin đang mở: hội thoại đã có UPDATE
//     riêng trên zalo_conversations (n_tup_upd > số tin chèn) — gọi thêm ở đây là
//     tải danh sách lần hai cho cùng một tin.
//   - Kênh qua subscribeResilient (id 'zalo-convs' / 'zalo-msg'): rớt rồi nối lại,
//     tab hiện lại sau ≥60 s ⇒ làm tươi các key trên (query active). Topic kèm
//     org để hai org không chung một kênh tên tĩnh.
// Còn hở (ghi ở docs/he-thong/realtime-sync.md): kênh có filter không bao giờ
// nhận DELETE (REPLICA IDENTITY DEFAULT) — tin bị xoá hẳn chỉ biến mất ở lần
// tải kế tiếp.
export const ZALO_REALTIME_DEBOUNCE_MS = 800;
export const ZALO_REALTIME_MAX_WAIT_MS = 2_500;

/** Bộ gom key exact cho MỘT kênh Zalo. */
function taoBoGomZalo(qc: QueryClient) {
  const keys = new Map<string, readonly unknown[]>();
  const scheduler = createBurstScheduler({
    debounceMs: ZALO_REALTIME_DEBOUNCE_MS,
    maxWaitMs: ZALO_REALTIME_MAX_WAIT_MS,
    flush: () => {
      for (const key of keys.values()) void qc.invalidateQueries({ queryKey: [...key], exact: true });
      keys.clear();
    },
  });
  return {
    them(key: readonly unknown[]) {
      keys.set(JSON.stringify(key), key);
      scheduler.poke();
    },
    /** Bắt kịp: làm tươi mọi key của kênh (query active), bỏ việc chờ đã nằm trong đó. */
    batKip(all: readonly (readonly unknown[])[]) {
      scheduler.cancel();
      keys.clear();
      for (const key of all) void qc.invalidateQueries({ queryKey: [...key], exact: true, refetchType: 'active' });
    },
    dispose() {
      scheduler.dispose({ flush: true });
    },
  };
}

export function useZaloRealtime(activeId?: string) {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();

  useEffect(() => {
    if (!orgId) return undefined;
    const convKey = [...QK.conversations, orgId] as const;
    const accountKey = [...QK.accounts, orgId] as const;
    const labelKey = [...QK.labels, orgId] as const;
    const gom = taoBoGomZalo(qc);
    // Filter theo org ngay ở subscription: user đa-org không nhận event của
    // org khác → không refetch chéo (đúng tinh thần tách bạch + egress).
    const stop = subscribeResilient({
      id: 'zalo-convs',
      topic: `zalo-convs-${orgId}`,
      bind: (channel) => channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_conversations', filter: `organization_id=eq.${orgId}` }, () => gom.them(convKey))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_accounts', filter: `organization_id=eq.${orgId}` }, () => gom.them(accountKey))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_labels', filter: `organization_id=eq.${orgId}` }, () => gom.them(labelKey)),
      onResync: () => gom.batKip([convKey, accountKey, labelKey]),
    });
    return () => { gom.dispose(); stop(); };
  }, [qc, orgId]);

  useEffect(() => {
    if (!activeId) return undefined;
    const msgKey = QK.messages(activeId);
    const gom = taoBoGomZalo(qc);
    const stop = subscribeResilient({
      id: 'zalo-msg',
      topic: `zalo-msg-${activeId}`,
      bind: (channel) => channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'zalo_messages', filter: `conversation_id=eq.${activeId}` }, () => gom.them(msgKey)),
      onResync: () => gom.batKip([msgKey]),
    });
    return () => { gom.dispose(); stop(); };
  }, [qc, activeId]);
}
