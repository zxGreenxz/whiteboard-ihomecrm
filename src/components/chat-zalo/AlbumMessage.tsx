import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

interface Props extends MsgActionProps {
  items: ZaloMessage[];
  onOpenLightbox?: (messageId: string) => void;
}

/** Album ≥2 ảnh liên tiếp — grid 2 cột (2 ảnh), 1+2 (3 ảnh), 2×2+“+N” (≥4). */
export default function AlbumMessage({ items, onOpenLightbox, onReact, onRecall, onShare, onReply, onDelete }: Props) {
  const first = items[0];
  const last = items[items.length - 1];
  const [hover, setHover] = useState(false);
  if (!first || !last) return null; // threadItems chỉ tạo album ≥2 — guard cho TS
  const out = first.dir === 'out';
  const shown = items.slice(0, 4);
  const [s0, s1, s2] = shown;
  const extra = items.length - shown.length;
  const caption = items.map((m) => m.text).find((t) => t && t.trim());

  const cell = (m: ZaloMessage, i: number, style: React.CSSProperties = {}) => (
    <AlbumCell key={m.id || i} m={m} onClick={() => m.id && onOpenLightbox?.(m.id)} overlay={i === 3 && extra > 0 ? `+${extra}` : undefined} style={style} />
  );

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative', maxWidth: 300 }}>
        {hover && (
          <MessageActions
            out={out} canRecall={out && !!onRecall && !!first.id}
            onReact={(e) => first.id && onReact?.(first.id, e)}
            onRecall={() => first.id && onRecall?.(first.id)}
            onShare={onShare ? () => onShare(first) : undefined}
            onReply={onReply && first.id ? () => onReply(first) : undefined}
            onDelete={onDelete && first.id ? () => onDelete(first.id!) : undefined}
          />
        )}
        {shown.length === 3 && s0 && s1 && s2 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {cell(s0, 0, { width: '100%', height: 150 })}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
              {cell(s1, 1, { height: 110 })}
              {cell(s2, 2, { height: 110 })}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            {shown.map((m, i) => cell(m, i, { height: shown.length === 2 ? 140 : 110 }))}
          </div>
        )}
        {caption && (
          <div style={{ marginTop: 4, fontSize: 13, color: 'hsl(160 30% 14%)', background: '#fff', border: '1px solid hsl(210 20% 89%)', borderRadius: 10, padding: '6px 10px' }}>{caption}</div>
        )}
        {(() => {
          // reaction thả lên album ghi vào tin ĐẦU (onReact dùng first.id) —
          // hiện badge từ bất kỳ item nào có react để bấm xong thấy ngay.
          const react = items.map((m) => m.react).find(Boolean);
          return react ? (
            <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', margin: '4px 8px 0' }}>
              <span style={{ background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 11, padding: '1px 7px', fontSize: 11, boxShadow: '0 1px 3px rgba(16,24,40,.12)' }}>{react}</span>
            </div>
          ) : null;
        })()}
        <MetaRow out={out} time={last.time} tick={last.tick} />
      </div>
    </div>
  );
}

function AlbumCell({ m, onClick, overlay, style }: { m: ZaloMessage; onClick: () => void; overlay?: string; style?: React.CSSProperties }) {
  const [err, setErr] = useState(false);
  const url = m.localUrl || m.mediaUrl;
  return (
    <button onClick={onClick} style={{ position: 'relative', border: '1px solid hsl(210 20% 86%)', borderRadius: 10, overflow: 'hidden', padding: 0, cursor: 'pointer', background: 'hsl(210 20% 95%)', ...style }}>
      {url && !err ? (
        <img src={url} alt={m.label || 'Ảnh'} referrerPolicy="no-referrer" loading="lazy" onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'hsl(210 10% 55%)' }}><ImageIcon size={22} strokeWidth={1.5} /></span>
      )}
      {overlay && (
        <span style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700 }}>{overlay}</span>
      )}
    </button>
  );
}
