import { useState } from 'react';
import { Check, CheckCheck } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';

export interface MsgActionProps {
  onReact?: (id: string, emoji: string) => void;
  onRecall?: (id: string) => void;
}

/** Hàng meta (giờ + tick seen/sent) dùng chung cho bubble & ảnh. */
export function MetaRow({ out, time, tick }: { out: boolean; time?: string; tick?: 'seen' | 'sent' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: out ? 'flex-end' : 'flex-start', gap: 5, margin: '3px 4px 0' }}>
      <span style={{ fontSize: 11, color: 'hsl(210 10% 55%)' }}>{time}</span>
      {tick === 'seen' && <CheckCheck size={15} color="hsl(152 69% 38%)" strokeWidth={2.4} />}
      {tick === 'sent' && <Check size={14} color="hsl(210 10% 55%)" strokeWidth={2.4} />}
    </div>
  );
}

/** Bong bóng tin nhắn text (in/out), kèm reply-quote + reaction + hover actions. */
export default function MessageBubble({ m, onReact, onRecall }: { m: ZaloMessage } & MsgActionProps) {
  const out = m.dir === 'out';
  const [hover, setHover] = useState(false);
  const canAct = !!m.id && (!!onReact || !!onRecall);
  const bubbleStyle = out
    ? { background: EMERALD, color: '#fff', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', fontSize: 13.5, lineHeight: 1.5, boxShadow: '0 1px 2px rgba(16,40,30,.12)' as const }
    : { background: '#fff', border: '1px solid hsl(210 20% 89%)', color: 'hsl(160 30% 14%)', padding: '10px 14px', borderRadius: '16px 16px 16px 4px', fontSize: 13.5, lineHeight: 1.5 };

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ maxWidth: '74%', position: 'relative' }}>
        {hover && canAct && (
          <MessageActions out={out} canRecall={out && !!onRecall} onReact={(e) => m.id && onReact?.(m.id, e)} onRecall={() => m.id && onRecall?.(m.id)} />
        )}
        <div style={bubbleStyle}>
          {m.reply && (
            <div style={{ background: 'rgba(255,255,255,.16)', borderLeft: '3px solid rgba(255,255,255,.6)', borderRadius: 6, padding: '5px 9px', marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9 }}>{m.reply.name}</div>
              <div style={{ fontSize: 12, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.reply.text}</div>
            </div>
          )}
          {m.text}
        </div>
        {m.react && (
          <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', margin: out ? '4px 8px 0 0' : '4px 0 0 8px' }}>
            <span style={{ background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 11, padding: '1px 7px 1px 5px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3, boxShadow: '0 1px 3px rgba(16,24,40,.12)' }}>
              {m.react}
              <span style={{ color: 'hsl(210 10% 45%)', fontWeight: 600 }}>1</span>
            </span>
          </div>
        )}
        <MetaRow out={out} time={m.time} tick={m.tick} />
      </div>
    </div>
  );
}
