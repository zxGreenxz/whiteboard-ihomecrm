import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { IMG_GRADS } from './zaloTheme';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

interface Props extends MsgActionProps {
  m: ZaloMessage;
  /** Mở lightbox thay vì tab mới */
  onOpenLightbox?: (messageId: string) => void;
}

/** Tin nhắn ảnh — hiện ảnh thật (no-referrer) nếu có URL, lỗi/không có thì tile gradient. */
export default function ImageMessage({ m, onReact, onRecall, onShare, onReply, onDelete, onOpenLightbox }: Props) {
  const out = m.dir === 'out';
  const [err, setErr] = useState(false);
  const [hover, setHover] = useState(false);
  const canAct = (!!m.id && (!!onReact || !!onRecall || !!onReply || !!onDelete)) || !!onShare;
  const radius = out ? '14px 4px 14px 14px' : '14px 14px 14px 4px';
  const url = m.localUrl || m.mediaUrl;

  const img = (
    <img
      src={url || undefined}
      alt={m.label || 'Ảnh'}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setErr(true)}
      style={{ maxWidth: 240, maxHeight: 280, borderRadius: radius, border: '1px solid hsl(210 20% 86%)', display: 'block', objectFit: 'cover' }}
    />
  );

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative' }}>
        {hover && canAct && (
          <MessageActions
            out={out} canRecall={out && !!onRecall && !!m.id}
            onReact={(e) => m.id && onReact?.(m.id, e)}
            onRecall={() => m.id && onRecall?.(m.id)}
            onShare={onShare ? () => onShare(m) : undefined}
            onReply={onReply && m.id ? () => onReply(m) : undefined}
            onDelete={onDelete && m.id ? () => onDelete(m.id!) : undefined}
          />
        )}
        {url && !err ? (
          onOpenLightbox && m.id ? (
            <button onClick={() => onOpenLightbox(m.id!)} style={{ border: 'none', padding: 0, background: 'transparent', cursor: 'zoom-in' }}>{img}</button>
          ) : (
            <a href={url} target="_blank" rel="noreferrer">{img}</a>
          )
        ) : (
          <div style={{ width: 206, height: 140, borderRadius: radius, border: '1px solid hsl(210 20% 86%)', background: IMG_GRADS[m.imgTone || 'neutral'] || IMG_GRADS.neutral, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, color: 'hsl(160 16% 46%)' }}>
            <ImageIcon size={28} strokeWidth={1.6} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{m.label || 'Hình ảnh'}</span>
          </div>
        )}
        {m.text && m.text.trim() && (
          <div style={{ marginTop: 4, fontSize: 13, color: 'hsl(160 30% 14%)', background: '#fff', border: '1px solid hsl(210 20% 89%)', borderRadius: 10, padding: '6px 10px', maxWidth: 240 }}>{m.text}</div>
        )}
        {m.react && (
          <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', margin: out ? '4px 8px 0 0' : '4px 0 0 8px' }}>
            <span style={{ background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 11, padding: '1px 7px 1px 5px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3, boxShadow: '0 1px 3px rgba(16,24,40,.12)' }}>{m.react}</span>
          </div>
        )}
        <MetaRow out={out} time={m.time} tick={m.tick} />
      </div>
    </div>
  );
}
