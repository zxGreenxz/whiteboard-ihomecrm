import { useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';
import { useSignedMediaUrl } from '@/hooks/chat-zalo/useSignedMediaUrl';

function fmtSize(n?: unknown): string {
  const b = Number(n);
  if (!b || Number.isNaN(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Tin nhắn tệp đính kèm — card tên tệp + size, bấm mở/tải. */
export default function FileMessage({ m, onReact, onRecall, onShare, onReply, onDelete }: { m: ZaloMessage } & MsgActionProps) {
  const out = m.dir === 'out';
  const [hover, setHover] = useState(false);
  const name = (m.mediaMeta?.filename as string) || m.label || m.text || 'Tệp đính kèm';
  const size = fmtSize(m.mediaMeta?.size);
  const url = useSignedMediaUrl(m.localUrl || m.mediaUrl);

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative', maxWidth: '74%' }}>
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
        <a
          href={url || undefined}
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
            background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 12,
            padding: '10px 14px', minWidth: 180, cursor: url ? 'pointer' : 'default',
          }}
        >
          <span style={{ width: 36, height: 36, borderRadius: 9, background: 'hsl(152 40% 94%)', color: 'hsl(152 69% 30%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <FileText size={18} />
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'hsl(160 30% 14%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{name}</span>
            {size && <span style={{ fontSize: 11, color: 'hsl(210 10% 50%)' }}>{size}</span>}
          </span>
          {url && <Download size={15} color="hsl(210 10% 50%)" style={{ marginLeft: 'auto', flex: 'none' }} />}
        </a>
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
