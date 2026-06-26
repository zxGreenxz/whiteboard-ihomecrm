import { cn } from '@/lib/utils';
import ThreadHeader from './ThreadHeader';
import MessageList from './MessageList';
import Composer from './Composer';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  draft: string;
  showTyping?: boolean;
  templates: { title: string; color: string }[];
  onDraft: (v: string) => void;
  onSend: () => void;
  onPickTemplate: (title: string) => void;
  onBack?: () => void;
  onOpenInfo?: () => void;
  className?: string;
  canLoadHistory?: boolean;
  loadingHistory?: boolean;
  onLoadHistory?: () => void;
  onReact?: (id: string, emoji: string) => void;
  onRecall?: (id: string) => void;
  onShare?: (m: import('./types').ZaloMessage) => void;
}

/** Cột 2: header + luồng tin + ô soạn. */
export default function ChatThread({
  conv, draft, showTyping, templates, onDraft, onSend, onPickTemplate, onBack, onOpenInfo, className,
  canLoadHistory, loadingHistory, onLoadHistory, onReact, onRecall, onShare,
}: Props) {
  return (
    <section className={cn('flex-1 min-w-0 flex-col', className)} style={{ background: 'hsl(160 20% 98.5%)' }}>
      <ThreadHeader conv={conv} onBack={onBack} onOpenInfo={onOpenInfo} />
      <MessageList
        conv={conv}
        showTyping={showTyping}
        canLoadHistory={canLoadHistory}
        loadingHistory={loadingHistory}
        onLoadHistory={onLoadHistory}
        onReact={onReact}
        onRecall={onRecall}
        onShare={onShare}
      />
      <Composer draft={draft} onDraft={onDraft} onSend={onSend} templates={templates} onPickTemplate={onPickTemplate} />
    </section>
  );
}
