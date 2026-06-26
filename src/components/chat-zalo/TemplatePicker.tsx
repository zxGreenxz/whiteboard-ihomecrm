import { FileText, Send } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EMERALD } from './zaloTheme';

interface Props {
  templates: { title: string; color: string }[];
  onPick: (title: string) => void;
}

/** Nút "Mẫu tin" + popover thư viện mẫu (cũng mở khi gõ "/"). */
export default function TemplatePicker({ templates, onPick }: Props) {
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
        <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(210 10% 45%)', padding: '4px 6px 6px' }}>Thư viện mẫu tin</div>
        {templates.map((t) => (
          <button
            key={t.title}
            onClick={() => onPick(t.title)}
            className="w-full"
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'hsl(210 20% 96%)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flex: 'none' }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>{t.title}</span>
            <Send size={15} color={EMERALD} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
