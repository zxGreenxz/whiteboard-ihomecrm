import { useMemo, useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import ConversationList from '@/components/chat-zalo/ConversationList';
import ChatThread from '@/components/chat-zalo/ChatThread';
import InfoPanel from '@/components/chat-zalo/InfoPanel';
import { MOCK_CONVS, MOCK_TEMPLATES } from '@/components/chat-zalo/_mockConvs';
import type {
  ZaloConversation, ZaloAutomations, FilterKey, RightTab,
} from '@/components/chat-zalo/types';

function nowHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Trang Chat Zalo — workspace 3 cột (danh sách · khung chat · panel thông tin).
 * Phần 1: dữ liệu mock in-memory. Phần 2 sẽ thay bằng hook Supabase + realtime.
 */
export default function ChatZaloPage() {
  const [convs, setConvs] = useState<ZaloConversation[]>(
    () => JSON.parse(JSON.stringify(MOCK_CONVS)) as ZaloConversation[],
  );
  const [activeId, setActiveId] = useState<string>(MOCK_CONVS[0]?.id ?? '');
  const [rightTab, setRightTab] = useState<RightTab>('info');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [automations, setAutomations] = useState<ZaloAutomations>({ broadcastOn: true, autoReplyOn: true });
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list');
  const [infoOpen, setInfoOpen] = useState(false);

  const active = convs.find((c) => c.id === activeId) || convs[0];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return convs.filter((c) => {
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
  }, [convs, filter, search]);

  const automationActive = (automations.broadcastOn ? 1 : 0) + (automations.autoReplyOn ? 1 : 0);

  const select = (id: string) => {
    setActiveId(id);
    setMobileView('thread');
    // đánh dấu đã đọc (Phần 2: gọi RPC zalo_mark_read)
    setConvs((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !active) return;
    const time = nowHHmm();
    setConvs((prev) =>
      prev.map((c) =>
        c.id === active.id
          ? { ...c, preview: text, time, messages: [...c.messages, { dir: 'out', text, time, tick: 'sent' }] }
          : c,
      ),
    );
    setDraft('');
  };

  const toggleAutomation = (key: 'broadcastOn' | 'autoReplyOn') =>
    setAutomations((s) => ({ ...s, [key]: !s[key] }));

  if (!active) {
    return (
      <MainLayout fullBleed>
        <div className="h-full flex items-center justify-center text-muted-foreground">Chưa có hội thoại</div>
      </MainLayout>
    );
  }

  return (
    <MainLayout fullBleed>
      <div className="flex h-full min-w-0">
        <ConversationList
          className={cn('w-full lg:w-[322px] lg:flex', mobileView === 'list' ? 'flex' : 'hidden')}
          conversations={filtered}
          totalCount={convs.length}
          activeId={activeId}
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
          showTyping={active.id === 'an'}
          templates={MOCK_TEMPLATES}
          onDraft={setDraft}
          onSend={send}
          onPickTemplate={(t) => setDraft(t)}
          onBack={() => setMobileView('list')}
          onOpenInfo={() => setInfoOpen(true)}
        />

        {/* Panel thông tin — desktop cố định, mobile mở bằng Sheet */}
        <InfoPanel
          className="hidden lg:flex w-full lg:w-[330px]"
          conv={active}
          tab={rightTab}
          onTab={setRightTab}
          automations={automations}
          onToggle={toggleAutomation}
          templates={MOCK_TEMPLATES}
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
                templates={MOCK_TEMPLATES}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </MainLayout>
  );
}
