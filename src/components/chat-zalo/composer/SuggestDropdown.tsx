import { useEffect, useRef } from 'react';

export interface SuggestItem {
  key: string;
  label: string;
  sub?: string;
  avatarUrl?: string | null;
}

interface Props {
  items: SuggestItem[];
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (item: SuggestItem) => void;
  /** tiêu đề nhỏ trên đầu dropdown */
  title: string;
}

/** Dropdown gợi ý nổi phía trên composer — dùng chung cho @mention và / mẫu tin. */
export default function SuggestDropdown({ items, activeIndex, onHover, onPick, title }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!items.length) return null;
  return (
    <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 12, boxShadow: '0 8px 24px rgba(16,24,40,.14)', zIndex: 50, overflow: 'hidden' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'hsl(210 10% 50%)', padding: '7px 12px 3px' }}>{title}</div>
      <div ref={listRef} className="wz-scroll" style={{ maxHeight: 220, overflowY: 'auto', paddingBottom: 4 }}>
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
              padding: '7px 12px', border: 'none', cursor: 'pointer',
              background: i === activeIndex ? 'hsl(152 40% 96%)' : 'transparent',
            }}
          >
            {it.avatarUrl !== undefined && (
              it.avatarUrl
                ? <img src={it.avatarUrl} alt="" referrerPolicy="no-referrer" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} />
                : <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'hsl(152 40% 92%)', color: 'hsl(152 69% 30%)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{it.label.slice(0, 1)}</span>
            )}
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              {it.sub && <span style={{ display: 'block', fontSize: 11.5, color: 'hsl(210 10% 50%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
