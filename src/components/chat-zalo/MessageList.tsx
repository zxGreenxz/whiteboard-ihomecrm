import { useEffect, useRef } from 'react';
import { Loader2, History } from 'lucide-react';
import SystemMessage from './SystemMessage';
import MessageBubble from './MessageBubble';
import ImageMessage from './ImageMessage';
import VideoMessage from './VideoMessage';
import TypingIndicator from './TypingIndicator';
import { EMERALD } from './zaloTheme';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  showTyping?: boolean;
  canLoadHistory?: boolean;
  loadingHistory?: boolean;
  onLoadHistory?: () => void;
  onReact?: (id: string, emoji: string) => void;
  onRecall?: (id: string) => void;
}

/** Khu vực cuộn chứa luồng tin; cuộn đáy khi đổi hội thoại / có tin mới (nếu đang ở đáy). */
export default function MessageList({ conv, showTyping, canLoadHistory, loadingHistory, onLoadHistory, onReact, onRecall }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const prevConv = useRef(conv.id);
  const atBottom = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevConv.current !== conv.id) {
      prevConv.current = conv.id;
      atBottom.current = true;
      el.scrollTop = el.scrollHeight + 999;
      return;
    }
    if (atBottom.current || showTyping) el.scrollTop = el.scrollHeight + 999;
  }, [conv.id, conv.messages.length, showTyping]);

  return (
    <div ref={ref} onScroll={onScroll} className="wz-scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 26px', display: 'flex', flexDirection: 'column', gap: 3, background: 'hsl(160 20% 98.5%)' }}>
      {canLoadHistory && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
          <button
            onClick={onLoadHistory}
            disabled={loadingHistory}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: EMERALD, background: '#fff', border: '1px solid hsl(152 40% 82%)', borderRadius: 10, padding: '6px 14px', cursor: loadingHistory ? 'default' : 'pointer', opacity: loadingHistory ? 0.7 : 1 }}
          >
            {loadingHistory ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />} Tải thêm tin cũ
          </button>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 10px' }}>
        <span style={{ background: 'hsl(210 20% 92%)', color: 'hsl(210 10% 40%)', fontSize: 11.5, fontWeight: 600, padding: '4px 12px', borderRadius: 10 }}>{conv.day}</span>
      </div>
      {conv.messages.map((m, i) => {
        if (m.type === 'sys') return <SystemMessage key={m.id || i} text={m.text || ''} />;
        if (m.type === 'image') return <ImageMessage key={m.id || i} m={m} onReact={onReact} onRecall={onRecall} />;
        if (m.type === 'video') return <VideoMessage key={m.id || i} m={m} onReact={onReact} onRecall={onRecall} />;
        return <MessageBubble key={m.id || i} m={m} onReact={onReact} onRecall={onRecall} />;
      })}
      {showTyping && <TypingIndicator />}
    </div>
  );
}
