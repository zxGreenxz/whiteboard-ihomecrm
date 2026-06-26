import { ImageIcon } from 'lucide-react';
import { IMG_GRADS } from './zaloTheme';
import { MetaRow } from './MessageBubble';
import type { ZaloMessage } from './types';

/** Tin nhắn ảnh — tile gradient placeholder + nhãn. */
export default function ImageMessage({ m }: { m: ZaloMessage }) {
  const out = m.dir === 'out';
  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }}>
      <div>
        <div
          style={{
            width: 206, height: 140,
            borderRadius: out ? '14px 4px 14px 14px' : '14px 14px 14px 4px',
            border: '1px solid hsl(210 20% 86%)',
            background: IMG_GRADS[m.imgTone || 'neutral'] || IMG_GRADS.neutral,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
            color: 'hsl(160 16% 46%)',
          }}
        >
          <ImageIcon size={28} strokeWidth={1.6} />
          <span style={{ fontSize: 11, fontWeight: 600 }}>{m.label}</span>
        </div>
        <MetaRow out={out} time={m.time} tick={m.tick} />
      </div>
    </div>
  );
}
