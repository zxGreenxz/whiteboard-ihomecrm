import { FileText, Send, Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EMERALD } from './zaloTheme';
import type { ZaloTemplateItem } from '@/hooks/useZaloChat';

interface Props {
  templates: ZaloTemplateItem[];
  /** chèn NỘI DUNG (body) mẫu tin vào ô soạn — title chỉ là nhãn */
  onPick: (body: string) => void;
  /** mở dialog quản lý mẫu tin (chỉ hiện khi có quyền) */
  onManage?: () => void;
}

/** Nút "Mẫu tin" + popover thư viện mẫu (cũng mở khi gõ "/"). */
export default function TemplatePicker({ templates, onPick, onManage }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          style={{ height: 30, padding: '0 11px', border: '1px solid hsl(152 40% 82%)', background: 'hsl(152 40% 96%)', borderRadius: 8, color: 'hsl(152 69% 28%)', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        >
          <FileText size={14} />
          Mẫu tin
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-2">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 6px' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'hsl(210 10% 45%)' }}>Thư viện mẫu tin</span>
          {onManage && (
            <button onClick={onManage} title="Quản lý mẫu tin" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: EMERALD, display: 'flex', padding: 2 }}>
              <Settings2 size={14} />
            </button>
          )}
        </div>
        {templates.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'hsl(210 10% 50%)', padding: '6px 8px' }}>Chưa có mẫu tin nào</div>
        )}
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => onPick(t.body)}
            className="w-full"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'hsl(210 20% 96%)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flex: 'none', marginTop: 5 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t.title}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'hsl(210 10% 50%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.body}</span>
            </span>
            <Send size={15} color={EMERALD} style={{ flex: 'none', marginTop: 3 }} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
