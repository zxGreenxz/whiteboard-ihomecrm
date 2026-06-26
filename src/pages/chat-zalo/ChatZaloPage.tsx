import { useMemo, useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import ConversationList from '@/components/chat-zalo/ConversationList';
import ChatThread from '@/components/chat-zalo/ChatThread';
import InfoPanel from '@/components/chat-zalo/InfoPanel';
import type { FilterKey, RightTab } from '@/components/chat-zalo/types';
import {
  useZaloConversations, useZaloMessages, useSendZaloMessage, useMarkConversationRead,
  useZaloAutomations, useToggleAutomation, useZaloTemplates, useZaloRealtime,
} from '@/hooks/useZaloChat';

/**
 * Trang Chat Zalo — workspace 3 cột (danh sách · khung chat · panel thông tin).
 * Dữ liệu từ Supabase (bảng zalo_*) + realtime; gửi tin qua RPC zalo_send_message.
 */
export default function ChatZaloPage() {
  const { data: conversations = [], isLoading } = useZaloConversations();
  const { data: automations = { broadcastOn: false, autoReplyOn: false } } = useZaloAutomations();
  const { data: templates = [] } = useZaloTemplates();
  const sendMut = useSendZaloMessage();
  const markRead = useMarkConversationRead();
  const toggleMut = useToggleAutomation();

  const [activeId, setActiveId] = useState<string>('');
  const [rightTab, setRightTab] = useState<RightTab>('info');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list');
  const [infoOpen, setInfoOpen] = useState(false);

  const effectiveId = activeId || conversations[0]?.id || '';
  useZaloRealtime(effectiveId || undefined);
  const { data: messages = [] } = useZaloMessages(effectiveId || undefined);

  const base = conversations.find((c) => c.id === effectiveId);
  const active = base ? { ...base, messages } : undefined;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
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
  }, [conversations, filter, search]);

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

  if (!active) {
    return (
      <MainLayout fullBleed>
        <div className="h-full flex items-center justify-center text-muted-foreground">
          {isLoading ? 'Đang tải hội thoại…' : 'Chưa có hội thoại Zalo nào'}
        </div>
      </MainLayout>
    );
  }

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
        />

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
        />

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
      </div>
    </MainLayout>
  );
}
