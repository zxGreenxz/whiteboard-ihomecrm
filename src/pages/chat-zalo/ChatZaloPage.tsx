import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import ConversationList from '@/components/chat-zalo/ConversationList';
import ChatThread from '@/components/chat-zalo/ChatThread';
import InfoPanel from '@/components/chat-zalo/InfoPanel';
import AccountSwitcher from '@/components/chat-zalo/AccountSwitcher';
import ConnectZaloDialog from '@/components/chat-zalo/ConnectZaloDialog';
import BroadcastDialog from '@/components/chat-zalo/BroadcastDialog';
import ComposeNewDialog from '@/components/chat-zalo/ComposeNewDialog';
import LinkCustomerDialog from '@/components/chat-zalo/LinkCustomerDialog';
import TemplateManagerDialog from '@/components/chat-zalo/TemplateManagerDialog';
import AutomationSettingsDialog from '@/components/chat-zalo/automation/AutomationSettingsDialog';
import type { FilterKey, RightTab, ZaloConversation, ZaloMessage } from '@/components/chat-zalo/types';
import {
  useZaloConversations, useZaloMessages, useSendZaloMessage, useMarkConversationRead,
  useZaloAutomations, useToggleAutomation, useZaloTemplates, useZaloRealtime,
  useZaloAccounts, useRequestConnect, useDisconnectAccount,
  useReactMessage, useRecallMessage, useLoadHistory,
  useZaloLabels, useBroadcast,
} from '@/hooks/useZaloChat';
import { useSendZaloMedia, useSendZaloSticker, type StickerItem } from '@/hooks/chat-zalo/useZaloMedia';
import { useSetConversationFlags, useStartChatByPhone, useDeleteMessageForMe, useThreadPresence } from '@/hooks/chat-zalo/useZaloConversationActions';
import { useMyPermissions, can } from '@/hooks/useMyPermissions';

/**
 * Trang Chat Zalo — workspace 3 cột (danh sách · khung chat · panel thông tin).
 * Khu chat của CÔNG TY (org-scoped): dữ liệu từ Supabase bảng zalo_* + realtime,
 * gửi qua RPC; media/voice/sticker qua bucket zalo-media + worker.
 */
export default function ChatZaloPage() {
  const convQuery = useZaloConversations();
  const conversations = convQuery.data ?? [];
  const { data: automations = { broadcastOn: false, autoReplyOn: false } } = useZaloAutomations();
  const { data: templates = [] } = useZaloTemplates();
  const { data: accounts = [] } = useZaloAccounts();
  const { data: labels = [] } = useZaloLabels();
  const { data: perms } = useMyPermissions();
  const broadcastMut = useBroadcast();
  const sendMut = useSendZaloMessage();
  const sendMediaMut = useSendZaloMedia();
  const sendStickerMut = useSendZaloSticker();
  const markRead = useMarkConversationRead();
  const toggleMut = useToggleAutomation();
  const requestConnect = useRequestConnect();
  const disconnect = useDisconnectAccount();
  const reactMut = useReactMessage();
  const recallMut = useRecallMessage();
  const loadHistoryMut = useLoadHistory();
  const flagsMut = useSetConversationFlags();
  const startChatMut = useStartChatByPhone();
  const deleteForMeMut = useDeleteMessageForMe();
  const { sendSeen, sendTyping } = useThreadPresence();

  const [activeId, setActiveId] = useState<string>('');
  const [rightTab, setRightTab] = useState<RightTab>('info');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list');
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const seenAccounts = useRef<Set<string>>(new Set());
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<number | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastInitial, setBroadcastInitial] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [linkConv, setLinkConv] = useState<ZaloConversation | null>(null);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  // Màn cài đặt tự động hoá — dialog cấp TRANG chứ không nằm trong InfoPanel:
  // InfoPanel được render hai lần (cột phải desktop + sheet mobile), để dialog
  // bên trong nó thì sẽ có hai bản cùng lúc, hai bộ state, hai lần nạp cấu hình.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ZaloMessage | null>(null);
  // Số tin chưa đọc CHỐT tại lúc mở thread — vẽ divider "Tin nhắn chưa đọc"
  const [unreadAtOpen, setUnreadAtOpen] = useState<Record<string, number>>({});

  useEffect(() => {
    const newIds = accounts.map((a) => a.id).filter((id) => !seenAccounts.current.has(id));
    if (newIds.length) {
      newIds.forEach((id) => seenAccounts.current.add(id));
      setSelectedIds((prev) => (prev === null ? accounts.map((a) => a.id) : [...prev, ...newIds]));
    }
  }, [accounts]);

  const selIds = selectedIds ?? accounts.map((a) => a.id);

  const effectiveId = activeId || conversations[0]?.id || '';
  useZaloRealtime(effectiveId || undefined);
  const msgQuery = useZaloMessages(effectiveId || undefined);
  const messages = msgQuery.data ?? [];

  const base = conversations.find((c) => c.id === effectiveId);
  const active = base ? { ...base, messages } : undefined;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const selSet = new Set(selIds);
    const allSelected = selIds.length >= accounts.length;
    return conversations.filter((c) => {
      if (!allSelected && c.accountId && !selSet.has(c.accountId)) return false;
      if (selectedLabel != null && !(c.labelIds || []).includes(selectedLabel)) return false;
      // 'Danh bạ' = đã sync từ bạn bè nhưng CHƯA từng có tin nhắn; các chip khác ẩn nhóm này
      if (filter === 'contacts') { if (c.hasMessages) return false; }
      else if (!c.hasMessages && !q) return false;
      if (filter === 'unread' && c.unread <= 0 && !c.markedUnread) return false;
      if (filter === 'tenant' && !c.customerId) return false;
      if (filter === 'lead' && !c.leadId) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.sub.toLowerCase().includes(q) ||
        (c.profile.room || '').toLowerCase().includes(q)
      );
    });
  }, [conversations, filter, search, selIds, accounts.length, selectedLabel]);

  const connectingAccount = connectingId ? accounts.find((a) => a.id === connectingId) || null : null;

  const onConnectNew = async () => {
    try {
      const acc = await requestConnect.mutateAsync({});
      setConnectingId(acc.id);
      setConnectOpen(true);
    } catch { /* toast trong hook */ }
  };
  const onReconnect = async (id: string) => {
    try {
      const acc = await requestConnect.mutateAsync({ accountId: id });
      setConnectingId(acc.id);
      setConnectOpen(true);
    } catch { /* toast trong hook */ }
  };

  const automationActive = (automations.broadcastOn ? 1 : 0) + (automations.autoReplyOn ? 1 : 0);

  const select = useCallback((id: string) => {
    const conv = conversations.find((c) => c.id === id);
    setUnreadAtOpen((prev) => ({ ...prev, [id]: conv?.unread || 0 }));
    setActiveId(id);
    setMobileView('thread');
    setReplyTarget(null);
    markRead.mutate(id);
    sendSeen(id); // báo "đã xem" sang Zalo (best-effort)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  const send = () => {
    const text = draft.trim();
    if (!text || !active) return;
    const reply = replyTarget && replyTarget.id
      ? {
          replyToMessageId: replyTarget.id,
          replyPreview: {
            name: replyTarget.dir === 'out' ? 'Bạn' : active.name,
            text: (replyTarget.text || replyTarget.label || '[Media]').slice(0, 120),
          },
        }
      : {};
    sendMut.mutate({ conversationId: active.id, body: text, ...reply });
    setDraft('');
    setReplyTarget(null);
  };

  const sendMedia = async (kind: 'image' | 'file', files: File[], caption: string) => {
    if (!active?.accountId) throw new Error('Hội thoại chưa gắn tài khoản Zalo');
    return sendMediaMut.mutateAsync({
      conversationId: active.id,
      accountId: active.accountId,
      kind,
      attachments: files.map((f) => ({ file: f })),
      caption,
    });
  };

  const sendVoice = async (blob: Blob, durationMs: number, mime: string) => {
    if (!active?.accountId) throw new Error('Hội thoại chưa gắn tài khoản Zalo');
    const ext = mime.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: mime });
    return sendMediaMut.mutateAsync({
      conversationId: active.id,
      accountId: active.accountId,
      kind: 'voice',
      attachments: [{ file, durationMs }],
    });
  };

  const sendSticker = (s: StickerItem) => {
    if (!active) return;
    sendStickerMut.mutate({ conversationId: active.id, sticker: s });
  };

  const toggleAutomation = (key: 'broadcastOn' | 'autoReplyOn') => {
    const kind = key === 'broadcastOn' ? 'broadcast_vacant' : 'auto_reply';
    const cur = key === 'broadcastOn' ? automations.broadcastOn : automations.autoReplyOn;
    toggleMut.mutate({ kind, enabled: !cur });
  };

  const errorBanner = (label: string, onRetry: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: 'hsl(45 90% 95%)', borderBottom: '1px solid hsl(45 80% 85%)', fontSize: 12, color: 'hsl(30 60% 30%)' }}>
      <AlertTriangle size={13} />
      <span style={{ flex: 1 }}>{label}</span>
      <button onClick={onRetry} style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: 'hsl(30 60% 30%)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
        <RefreshCw size={12} />Thử lại
      </button>
    </div>
  );

  const switcher = (
    <AccountSwitcher
      accounts={accounts}
      selectedIds={selIds}
      onToggle={(id) =>
        setSelectedIds((prev) => {
          const base2 = prev ?? accounts.map((a) => a.id);
          return base2.includes(id) ? base2.filter((x) => x !== id) : [...base2, id];
        })
      }
      onOnly={(id) => setSelectedIds([id])}
      onAll={() => setSelectedIds(accounts.map((a) => a.id))}
      onConnectNew={onConnectNew}
      onReconnect={onReconnect}
      onDisconnect={(id) => disconnect.mutate(id)}
    />
  );

  return (
    <MainLayout fullBleed>
      <div className="flex h-full min-w-0">
        <ConversationList
          className={cn('w-full lg:w-[322px] lg:flex', mobileView === 'list' ? 'flex' : 'hidden')}
          conversations={filtered}
          totalCount={conversations.length}
          activeId={effectiveId}
          filter={filter}
          search={search}
          automationActive={automationActive}
          automationRuns={0}
          onFilter={setFilter}
          onSearch={setSearch}
          onSelect={select}
          topSlot={switcher}
          labels={labels}
          selectedLabel={selectedLabel}
          onSelectLabel={setSelectedLabel}
          onBroadcast={() => { setBroadcastInitial(''); setBroadcastOpen(true); }}
          onComposeNew={() => setComposeOpen(true)}
          onTogglePin={(c) => flagsMut.mutate({ conversationId: c.id, pinned: !c.pinned })}
          onToggleMute={(c) => flagsMut.mutate({ conversationId: c.id, muted: !c.muted })}
          onToggleUnread={(c) => flagsMut.mutate({ conversationId: c.id, markedUnread: !c.markedUnread })}
          onLinkCrm={setLinkConv}
          errorBanner={convQuery.isError
            ? errorBanner(convQuery.data ? 'Mất kết nối — danh sách có thể cũ' : 'Không tải được hội thoại', () => convQuery.refetch())
            : undefined}
        />

        {active ? (
          <ChatThread
            className={cn('lg:flex', mobileView === 'thread' ? 'flex' : 'hidden')}
            conv={active}
            draft={draft}
            templates={templates}
            onDraft={setDraft}
            onSend={send}
            sending={sendMut.isPending}
            onPickTemplate={(body) => setDraft(body)}
            onBack={() => setMobileView('list')}
            onOpenInfo={() => setInfoOpen(true)}
            canLoadHistory={active.isGroup}
            loadingHistory={loadHistoryMut.isPending}
            onLoadHistory={() => loadHistoryMut.mutate({ conversationId: active.id })}
            onReact={(id, emoji) => reactMut.mutate({ messageId: id, emoji, conversationId: active.id })}
            onRecall={(id) => recallMut.mutate({ messageId: id, conversationId: active.id })}
            onShare={(m) => {
              const content = m.text && m.text.trim() ? m.text : (m.mediaUrl || m.label || '[Nội dung]');
              setBroadcastInitial(content);
              setBroadcastOpen(true);
            }}
            onReply={setReplyTarget}
            onDelete={(id) => deleteForMeMut.mutate({ messageId: id, conversationId: active.id })}
            replyTo={replyTarget ? {
              name: replyTarget.dir === 'out' ? 'Bạn' : active.name,
              text: (replyTarget.text || replyTarget.label || '[Media]').slice(0, 120),
            } : null}
            onCancelReply={() => setReplyTarget(null)}
            onSendMedia={sendMedia}
            mediaSending={sendMediaMut.isPending}
            onSendVoice={sendVoice}
            voiceSending={sendMediaMut.isPending}
            onSendSticker={sendSticker}
            unreadAtOpen={unreadAtOpen[active.id] || 0}
            onTyping={() => sendTyping(active.id)}
            onManageTemplates={can(perms, 'chat_zalo', 'manage_templates') ? () => setTemplateManagerOpen(true) : undefined}
          />
        ) : (
          <section className="flex-1 min-w-0 hidden lg:flex items-center justify-center text-muted-foreground" style={{ background: 'hsl(160 20% 98.5%)' }}>
            {convQuery.isLoading ? 'Đang tải hội thoại…'
              : convQuery.isError ? 'Không tải được hội thoại — kiểm tra kết nối rồi thử lại'
              : 'Chưa có hội thoại — kết nối Zalo để bắt đầu'}
          </section>
        )}

        {active && (
          <>
            <InfoPanel
              className="hidden lg:flex w-full lg:w-[330px]"
              conv={active}
              tab={rightTab}
              onTab={setRightTab}
              automations={automations}
              onToggle={toggleAutomation}
              templates={templates}
              conversations={conversations}
              onOpenSettings={() => setSettingsOpen(true)}
              onLinkCrm={setLinkConv}
            />
            <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
              <SheetContent side="right" className="p-0 w-[330px] max-w-[90vw]">
                <div className="h-full">
                  <InfoPanel
                    className="flex w-full h-full"
                    conv={active}
                    tab={rightTab}
                    onTab={setRightTab}
                    automations={automations}
                    onToggle={toggleAutomation}
                    templates={templates}
                    conversations={conversations}
                    // Đóng sheet TRƯỚC khi mở dialog: hai lớp modal lồng nhau
                    // (Sheet + Dialog của Radix) tranh nhau focus trap, và trên
                    // màn hẹp thì dialog rộng 880px nằm dưới sheet 330px là
                    // không đọc được.
                    onOpenSettings={() => { setInfoOpen(false); setSettingsOpen(true); }}
                    onLinkCrm={setLinkConv}
                  />
                </div>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>

      <ConnectZaloDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        account={connectingAccount}
        onRetry={() => connectingId && onReconnect(connectingId)}
      />

      <BroadcastDialog
        open={broadcastOpen}
        onOpenChange={setBroadcastOpen}
        conversations={conversations}
        labels={labels}
        initialMessage={broadcastInitial}
        sending={broadcastMut.isPending}
        onSend={(ids, body) => broadcastMut.mutate({ conversationIds: ids, body }, { onSuccess: () => setBroadcastOpen(false) })}
      />

      <ComposeNewDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        accounts={accounts}
        conversations={conversations}
        finding={startChatMut.isPending}
        onStart={(accountId, phone) => startChatMut.mutate({ accountId, phone }, {
          onSuccess: (conversationId) => { setComposeOpen(false); select(conversationId); },
        })}
        onOpenExisting={(id) => { setComposeOpen(false); select(id); }}
      />

      <LinkCustomerDialog open={!!linkConv} onOpenChange={(v) => !v && setLinkConv(null)} conv={linkConv} />

      {/* Cấu hình tự động hoá theo TỔ CHỨC — không phụ thuộc hội thoại đang mở,
          nên render ở cấp trang và không nằm trong nhánh `active &&`. */}
      <AutomationSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        conversations={conversations}
      />

      {can(perms, 'chat_zalo', 'manage_templates') && (
        <TemplateManagerDialog open={templateManagerOpen} onOpenChange={setTemplateManagerOpen} />
      )}
    </MainLayout>
  );
}
