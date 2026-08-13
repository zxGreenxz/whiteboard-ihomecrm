import { useState } from 'react';
import { Sticker as StickerIcon } from 'lucide-react';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

/** Tin nhắn sticker — ảnh 120px không bong bóng; thiếu URL thì icon placeholder. */
export default function StickerMessage({ m, onReact, onRecall, onShare, onReply, onDelete }: { m: ZaloMessage } & MsgActionProps) {
  const out = m.dir === 'out';
  const [hover, setHover] = useState(false);
  const [err, setErr] = useState(false);
  const url = (m.mediaMeta?.url as string) || m.mediaUrl || m.localUrl;

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative' }}>
        {hover && (
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
          <img src={url} alt="Sticker" referrerPolicy="no-referrer" loading="lazy" onError={() => setErr(true)} style={{ width: 120, height: 120, objectFit: 'contain', display: 'block' }} />
        ) : (
          <div style={{ width: 100, height: 100, borderRadius: 14, background: 'hsl(210 20% 95%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'hsl(210 10% 55%)' }}>
            <StickerIcon size={30} strokeWidth={1.5} />
          </div>
        )}
        {m.react && (
          <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', margin: '4px 8px 0' }}>
            <span style={{ background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 11, padding: '1px 7px', fontSize: 11 }}>{m.react}</span>
          </div>
        )}
        <MetaRow out={out} time={m.time} tick={m.tick} />
      </div>
    </div>
  );
}
