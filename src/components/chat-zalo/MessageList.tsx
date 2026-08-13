import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, History } from 'lucide-react';
import SystemMessage from './SystemMessage';
import MessageBubble from './MessageBubble';
import ImageMessage from './ImageMessage';
import VideoMessage from './VideoMessage';
import VoiceMessage from './VoiceMessage';
import FileMessage from './FileMessage';
import StickerMessage from './StickerMessage';
import AlbumMessage from './AlbumMessage';
import ZaloLightbox from './ZaloLightbox';
import TypingIndicator from './TypingIndicator';
import { buildThreadItems } from './threadItems';
import { EMERALD } from './zaloTheme';
import type { ZaloConversation, ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

interface Props extends MsgActionProps {
  conv: ZaloConversation;
  showTyping?: boolean;
  canLoadHistory?: boolean;
  loadingHistory?: boolean;
  onLoadHistory?: () => void;
  /** Số tin chưa đọc chốt lúc mở thread (vẽ divider "Tin nhắn chưa đọc") */
  unreadAtOpen?: number;
  /** id tin đang được cuộn tới từ ThreadSearchBar */
  scrollToId?: string | null;
}

/** Khu vực cuộn chứa luồng tin: divider ngày/chưa đọc, gom nhóm, album, lightbox. */
export default function MessageList({
  conv, showTyping, canLoadHistory, loadingHistory, onLoadHistory,
  unreadAtOpen = 0, scrollToId,
  onReact, onRecall, onShare, onReply, onDelete, highlightTerm,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const prevConv = useRef(conv.id);
  const atBottom = useRef(true);
  const msgRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const items = useMemo(() => buildThreadItems(conv.messages, unreadAtOpen), [conv.messages, unreadAtOpen]);

  // Mọi ảnh trong thread — cho lightbox prev/next xuyên album lẫn ảnh lẻ.
  const lightboxImages = useMemo(() =>
    conv.messages
      .filter((m): m is ZaloMessage & { id: string } => m.type === 'image' && !!m.id && !!(m.mediaUrl || m.localUrl))
      .map((m) => ({ id: m.id, url: (m.localUrl || m.mediaUrl)!, label: m.label })),
  [conv.messages]);
  const openLightbox = (messageId: string) => {
    const i = lightboxImages.findIndex((x) => x.id === messageId);
    if (i >= 0) setLightboxIndex(i);
  };

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

  // Điều hướng tìm kiếm: cuộn tới tin + nháy viền
  useEffect(() => {
    if (!scrollToId) return;
    const el = msgRefs.current[scrollToId];
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.style.outline = `2px solid ${EMERALD}`;
      el.style.outlineOffset = '2px';
      el.style.borderRadius = '12px';
      const t = setTimeout(() => { el.style.outline = 'none'; }, 1600);
      return () => clearTimeout(t);
    }
  }, [scrollToId]);

  const actionProps = { onReact, onRecall, onShare, onReply, onDelete };

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
      {items.map((it) => {
        if (it.kind === 'day') {
          return (
            <div key={it.key} style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 6px' }}>
              <span style={{ background: 'hsl(210 20% 92%)', color: 'hsl(210 10% 40%)', fontSize: 11.5, fontWeight: 600, padding: '4px 12px', borderRadius: 10 }}>{it.label}</span>
            </div>
          );
        }
        if (it.kind === 'unread') {
          return (
            <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 6px' }}>
              <span style={{ flex: 1, height: 1, background: 'hsl(0 70% 84%)' }} />
              <span style={{ color: 'hsl(0 60% 48%)', fontSize: 11.5, fontWeight: 700 }}>Tin nhắn chưa đọc</span>
              <span style={{ flex: 1, height: 1, background: 'hsl(0 70% 84%)' }} />
            </div>
          );
        }
        if (it.kind === 'album') {
          const head = it.items[0];
          return (
            <div key={it.key} ref={(el) => { if (head?.id) msgRefs.current[head.id] = el; }} style={it.grouped ? { marginTop: -5 } : undefined}>
              <AlbumMessage items={it.items} onOpenLightbox={openLightbox} {...actionProps} />
            </div>
          );
        }
        const m = it.m;
        const wrap = (node: React.ReactNode) => (
          <div key={it.key} ref={(el) => { if (m.id) msgRefs.current[m.id] = el; }} style={it.grouped ? { marginTop: -5 } : undefined}>
            {node}
          </div>
        );
        if (m.type === 'sys') return wrap(<SystemMessage text={m.text || ''} />);
        if (m.type === 'image') return wrap(<ImageMessage m={m} onOpenLightbox={openLightbox} {...actionProps} />);
        if (m.type === 'video') return wrap(<VideoMessage m={m} onReact={onReact} onRecall={onRecall} onShare={onShare} />);
        if (m.type === 'voice') return wrap(<VoiceMessage m={m} {...actionProps} />);
        if (m.type === 'file') return wrap(<FileMessage m={m} {...actionProps} />);
        if (m.type === 'sticker') return wrap(<StickerMessage m={m} {...actionProps} />);
        return wrap(<MessageBubble m={m} {...actionProps} highlightTerm={highlightTerm} />);
      })}
      {showTyping && <TypingIndicator />}
      <ZaloLightbox images={lightboxImages} index={lightboxIndex} onIndexChange={setLightboxIndex} />
    </div>
  );
}
