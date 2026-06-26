import { useEffect, useRef } from 'react';
import SystemMessage from './SystemMessage';
import MessageBubble from './MessageBubble';
import ImageMessage from './ImageMessage';
import TypingIndicator from './TypingIndicator';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  showTyping?: boolean;
}

/** Khu vực cuộn chứa luồng tin nhắn; tự cuộn đáy khi đổi hội thoại/thêm tin. */
export default function MessageList({ conv, showTyping }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight + 999;
  }, [conv.id, conv.messages.length, showTyping]);

  return (
    <div
      ref={ref}
      className="wz-scroll"
      style={{ flex: 1, overflowY: 'auto', padding: '18px 26px', display: 'flex', flexDirection: 'column', gap: 3, background: 'hsl(160 20% 98.5%)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 10px' }}>
        <span style={{ background: 'hsl(210 20% 92%)', color: 'hsl(210 10% 40%)', fontSize: 11.5, fontWeight: 600, padding: '4px 12px', borderRadius: 10 }}>{conv.day}</span>
      </div>
      {conv.messages.map((m, i) => {
        if (m.type === 'sys') return <SystemMessage key={i} text={m.text || ''} />;
        if (m.type === 'image') return <ImageMessage key={i} m={m} />;
        return <MessageBubble key={i} m={m} />;
      })}
      {showTyping && <TypingIndicator />}
    </div>
  );
}
