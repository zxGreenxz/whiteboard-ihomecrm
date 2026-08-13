import { useState, useRef } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import ThreadHeader from './ThreadHeader';
import MessageList from './MessageList';
import Composer from './Composer';
import ThreadSearchBar from './ThreadSearchBar';
import { EMERALD } from './zaloTheme';
import type { ZaloConversation, ZaloMessage } from './types';
import type { ZaloTemplateItem } from '@/hooks/useZaloChat';
import type { StickerItem } from '@/hooks/chat-zalo/useZaloMedia';

interface Props {
  conv: ZaloConversation;
  draft: string;
  showTyping?: boolean;
  templates: ZaloTemplateItem[];
  onDraft: (v: string) => void;
  onSend: () => void;
  sending?: boolean;
  onPickTemplate: (body: string) => void;
  onBack?: () => void;
  onOpenInfo?: () => void;
  className?: string;
  canLoadHistory?: boolean;
  loadingHistory?: boolean;
  onLoadHistory?: () => void;
  onReact?: (id: string, emoji: string) => void;
  onRecall?: (id: string) => void;
  onShare?: (m: ZaloMessage) => void;
  onReply?: (m: ZaloMessage) => void;
  onDelete?: (id: string) => void;
  replyTo?: { name: string; text: string } | null;
  onCancelReply?: () => void;
  onSendMedia?: (kind: 'image' | 'file', files: File[], caption: string) => Promise<unknown>;
  mediaSending?: boolean;
  onSendVoice?: (blob: Blob, durationMs: number, mime: string) => Promise<unknown>;
  voiceSending?: boolean;
  onSendSticker?: (s: StickerItem) => void;
  unreadAtOpen?: number;
  onTyping?: () => void;
  onManageTemplates?: () => void;
}

/** Cột 2: header + (thanh tìm) + luồng tin + ô soạn; kéo-thả tệp vào để gửi. */
export default function ChatThread({
  conv, draft, showTyping, templates, onDraft, onSend, sending, onPickTemplate, onBack, onOpenInfo, className,
  canLoadHistory, loadingHistory, onLoadHistory, onReact, onRecall, onShare, onReply, onDelete,
  replyTo, onCancelReply, onSendMedia, mediaSending, onSendVoice, voiceSending, onSendSticker,
  unreadAtOpen, onTyping, onManageTemplates,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const dragDepth = useRef(0);

  return (
    <section
      className={cn('flex-1 min-w-0 flex-col relative', className)}
      style={{ background: 'hsl(160 20% 98.5%)' }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDropping(true); } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length && onSendMedia) setDroppedFiles(files);
      }}
    >
      <ThreadHeader conv={conv} onBack={onBack} onOpenInfo={onOpenInfo} onSearch={() => setSearchOpen((v) => !v)} />
      {searchOpen && (
        <ThreadSearchBar
          messages={conv.messages}
          onNavigate={setScrollToId}
          onTerm={setSearchTerm}
          onClose={() => { setSearchOpen(false); setSearchTerm(''); setScrollToId(null); }}
        />
      )}
      <MessageList
        conv={conv}
        showTyping={showTyping}
        canLoadHistory={canLoadHistory}
        loadingHistory={loadingHistory}
        onLoadHistory={onLoadHistory}
        onReact={onReact}
        onRecall={onRecall}
        onShare={onShare}
        onReply={onReply}
        onDelete={onDelete}
        highlightTerm={searchTerm}
        unreadAtOpen={unreadAtOpen}
        scrollToId={scrollToId}
      />
      <Composer
        draft={draft}
        onDraft={onDraft}
        onSend={onSend}
        sending={sending}
        templates={templates}
        onPickTemplate={onPickTemplate}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        onSendMedia={onSendMedia}
        mediaSending={mediaSending}
        onSendVoice={onSendVoice}
        voiceSending={voiceSending}
        accountId={conv.accountId}
        onSendSticker={onSendSticker}
        externalFiles={droppedFiles}
        onExternalConsumed={() => setDroppedFiles(null)}
        onTyping={onTyping}
        onManageTemplates={onManageTemplates}
      />
      {dropping && onSendMedia && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'hsl(152 40% 96% / .92)', border: `2.5px dashed ${EMERALD}`, borderRadius: 12, margin: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none' }}>
          <UploadCloud size={40} color={EMERALD} />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'hsl(152 69% 26%)' }}>Thả để gửi vào hội thoại</span>
        </div>
      )}
    </section>
  );
}
