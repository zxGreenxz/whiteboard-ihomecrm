import { useMemo, useState, useEffect, useRef } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import ConversationList from '@/components/chat-zalo/ConversationList';
import ChatThread from '@/components/chat-zalo/ChatThread';
import InfoPanel from '@/components/chat-zalo/InfoPanel';
import AccountSwitcher from '@/components/chat-zalo/AccountSwitcher';
import ConnectZaloDialog from '@/components/chat-zalo/ConnectZaloDialog';
import type { FilterKey, RightTab } from '@/components/chat-zalo/types';
import {
  useZaloConversations, useZaloMessages, useSendZaloMessage, useMarkConversationRead,
  useZaloAutomations, useToggleAutomation, useZaloTemplates, useZaloRealtime,
  useZaloAccounts, useRequestConnect, useDisconnectAccount,
  useReactMessage, useRecallMessage, useLoadHistory,
} from '@/hooks/useZaloChat';

/**
 * Trang Chat Zalo — workspace 3 cột (danh sách · khung chat · panel thông tin).
 * Dữ liệu từ Supabase (bảng zalo_*) + realtime; gửi tin qua RPC zalo_send_message.
 */
export default function ChatZaloPage() {
  const { data: conversations = [], isLoading } = useZaloConversations();
  const { data: automations = { broadcastOn: false, autoReplyOn: false } } = useZaloAutomations();
  const { data: templates = [] } = useZaloTemplates();
  const { data: accounts = [] } = useZaloAccounts();
  const sendMut = useSendZaloMessage();
  const markRead = useMarkConversationRead();
  const toggleMut = useToggleAutomation();
  const requestConnect = useRequestConnect();
  const disconnect = useDisconnectAccount();
  const reactMut = useReactMessage();
  const recallMut = useRecallMessage();
  const loadHistoryMut = useLoadHistory();

  const [activeId, setActiveId] = useState<string>('');
  const [rightTab, setRightTab] = useState<RightTab>('info');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list');
  const [infoOpen, setInfoOpen] = useState(false);
  // Tập tài khoản đang xem (chọn nhiều cùng lúc); null = chưa khởi tạo (= tất cả).
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const seenAccounts = useRef<Set<string>>(new Set());
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  // Tài khoản MỚI xuất hiện → tự thêm vào tập xem (mặc định hiện); KHÔNG đụng
  // tài khoản người dùng đã bỏ chọn.
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
  const { data: messages = [] } = useZaloMessages(effectiveId || undefined);

  const base = conversations.find((c) => c.id === effectiveId);
  const active = base ? { ...base, messages } : undefined;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const selSet = new Set(selIds);
    const allSelected = selIds.length >= accounts.length;
    return conversations.filter((c) => {
      if (!allSelected && c.accountId && !selSet.has(c.accountId)) return false;
      if (filter === 'unread' && c.unread <= 0) return false;
      if (filter === 'tenant' && c.profile.kind !== 'tenant') return false;
      if (filter === 'lead' && c.profile.kind !== 'lead') return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.sub.toLowerCase().includes(q) ||
        (c.profile.room || '').toLowerCase().includes(q)
      );
    });
  }, [conversations, filter, search, selIds, accounts.length]);

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

  const select = (id: string) => {
    setActiveId(id);
    setMobileView('thread');
    markRead.mutate(id);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !active) return;
    sendMut.mutate({ conversationId: active.id, body: text });
    setDraft('');
  };

  const toggleAutomation = (key: 'broadcastOn' | 'autoReplyOn') => {
    const kind = key === 'broadcastOn' ? 'broadcast_vacant' : 'auto_reply';
    const cur = key === 'broadcastOn' ? automations.broadcastOn : automations.autoReplyOn;
    toggleMut.mutate({ kind, enabled: !cur });
  };

  const switcher = (
    <AccountSwitcher
      accounts={accounts}
      selectedIds={selIds}
      onToggle={(id) =>
        setSelectedIds((prev) => {
          const base = prev ?? accounts.map((a) => a.id);
          return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
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
          automationRuns={34}
          onFilter={setFilter}
          onSearch={setSearch}
          onSelect={select}
          topSlot={switcher}
        />

        {active ? (
          <ChatThread
            className={cn('lg:flex', mobileView === 'thread' ? 'flex' : 'hidden')}
            conv={active}
            draft={draft}
            templates={templates}
            onDraft={setDraft}
            onSend={send}
            onPickTemplate={(t) => setDraft(t)}
            onBack={() => setMobileView('list')}
            onOpenInfo={() => setInfoOpen(true)}
            canLoadHistory={!!active.profile.isGroup}
            loadingHistory={loadHistoryMut.isPending}
            onLoadHistory={() => loadHistoryMut.mutate({ conversationId: active.id })}
            onReact={(id, emoji) => reactMut.mutate({ messageId: id, emoji, conversationId: active.id })}
            onRecall={(id) => recallMut.mutate({ messageId: id, conversationId: active.id })}
          />
        ) : (
          <section className="flex-1 min-w-0 hidden lg:flex items-center justify-center text-muted-foreground" style={{ background: 'hsl(160 20% 98.5%)' }}>
            {isLoading ? 'Đang tải hội thoại…' : 'Chưa có hội thoại — kết nối Zalo để bắt đầu'}
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
    </MainLayout>
  );
}
