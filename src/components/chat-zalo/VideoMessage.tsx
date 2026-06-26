import { useState } from 'react';
import { Play, Video as VideoIcon } from 'lucide-react';
import { IMG_GRADS } from './zaloTheme';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

/** Tin video Zalo — phát inline (poster = thumbnail). Lỗi tải thì hiện poster + nút mở. */
export default function VideoMessage({ m, onReact, onRecall, onShare }: { m: ZaloMessage } & MsgActionProps) {
  const out = m.dir === 'out';
  const [err, setErr] = useState(false);
  const [hover, setHover] = useState(false);
  const canAct = (!!m.id && (!!onReact || !!onRecall)) || !!onShare;
  const radius = out ? '14px 4px 14px 14px' : '14px 14px 14px 4px';

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative' }}>
        {hover && canAct && (
          <MessageActions out={out} canRecall={out && !!onRecall && !!m.id} onReact={(e) => m.id && onReact?.(m.id, e)} onRecall={() => m.id && onRecall?.(m.id)} onShare={onShare ? () => onShare(m) : undefined} />
        )}
        {m.mediaUrl && !err ? (
          <video
            controls
            preload="metadata"
            poster={m.videoThumb || undefined}
            src={m.mediaUrl}
            onError={() => setErr(true)}
            style={{ maxWidth: 260, maxHeight: 320, borderRadius: radius, border: '1px solid hsl(210 20% 86%)', display: 'block', background: '#000' }}
          />
        ) : m.videoThumb ? (
          <a href={m.mediaUrl || m.videoThumb} target="_blank" rel="noreferrer" style={{ display: 'block', position: 'relative', width: 206, borderRadius: radius, overflow: 'hidden', border: '1px solid hsl(210 20% 86%)' }}>
            <img src={m.videoThumb} alt="Video" referrerPolicy="no-referrer" loading="lazy" style={{ width: '100%', display: 'block', objectFit: 'cover' }} />
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.28)' }}>
              <span style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Play size={22} color="#fff" fill="#fff" /></span>
            </span>
          </a>
        ) : (
          <a href={m.mediaUrl || '#'} target="_blank" rel="noreferrer" style={{ width: 206, height: 140, borderRadius: radius, border: '1px solid hsl(210 20% 86%)', background: IMG_GRADS.warm, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, color: 'hsl(160 16% 46%)', textDecoration: 'none' }}>
            <VideoIcon size={28} strokeWidth={1.6} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{m.label || 'Video'}</span>
          </a>
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
