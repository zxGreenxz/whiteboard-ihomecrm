import { useState } from 'react';
import { ChevronDown, Check, Tag } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EMERALD } from './zaloTheme';
import type { ZaloLabel } from './types';
import { zaloLabelKey } from './conversationState';

export function labelColor(c?: string | null): string {
  if (c && /^(#|rgb|hsl)/i.test(c)) return c;
  return 'hsl(210 10% 70%)';
}

interface Props {
  labels: ZaloLabel[];
  selectedLabel: string | null;
  onSelect: (labelKey: string | null) => void;
  /** Bật khi nằm trong Dialog: khoá cuộn của Dialog nuốt thao tác cuộn danh
   *  sách nhãn (portal ra ngoài hộp), nhãn cuối danh sách không với tới được. */
  modal?: boolean;
}

/** Dropdown "Phân loại" — lọc hội thoại theo nhãn Zalo. */
export default function LabelFilter({ labels, selectedLabel, onSelect, modal = false }: Props) {
  const [open, setOpen] = useState(false);
  const active = labels.find((l) => zaloLabelKey(l) === selectedLabel);
  const on = !!active;
  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <button
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', maxWidth: '100%', minWidth: 0,
            background: on ? EMERALD : '#fff', border: on ? 'none' : '1px solid hsl(210 20% 88%)',
            color: on ? '#fff' : 'hsl(160 20% 30%)', fontSize: 12, fontWeight: on ? 600 : 500,
            padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Tag size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{active ? `${active.emoji || ''} ${active.name} · ${active.accountName || active.accountId.slice(0, 8)}`.trim() : 'Phân loại'}</span>
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <div className="wz-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <button onClick={() => { onSelect(null); setOpen(false); }} className="w-full" style={rowStyle(!selectedLabel)}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Tất cả</span>
            {!selectedLabel && <Check size={15} color={EMERALD} />}
          </button>
          {labels.length === 0 && (
            <div style={{ padding: '10px 8px', fontSize: 12, color: 'hsl(210 10% 50%)' }}>Chưa có nhãn — sẽ đồng bộ khi worker kết nối.</div>
          )}
          {labels.map((l) => {
            const key = zaloLabelKey(l);
            const sel = key === selectedLabel;
            return (
              <button key={key} onClick={() => { onSelect(key); setOpen(false); }} className="w-full" style={rowStyle(sel)}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: labelColor(l.color), flex: 'none' }} />
                <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.emoji ? `${l.emoji} ` : ''}{l.name}<small className="block text-muted-foreground">{l.accountName || l.accountId.slice(0, 8)}</small></span>
                {sel && <Check size={15} color={EMERALD} />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function rowStyle(active: boolean): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 8, border: 'none', background: active ? 'hsl(152 30% 95%)' : 'transparent', cursor: 'pointer', textAlign: 'left' };
}
