import { Smile, Image as ImageIcon, Paperclip, Mic, Send } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import TemplatePicker from './TemplatePicker';

interface Props {
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  templates: { title: string; color: string }[];
  onPickTemplate: (title: string) => void;
}

const iconBtn = {
  width: 32, height: 32, border: 'none', background: 'transparent', borderRadius: 7,
  color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
} as const;

/** Ô soạn tin: input + hàng nút (emoji/ảnh/đính kèm/voice) + mẫu tin + gửi. */
export default function Composer({ draft, onDraft, onSend, templates, onPickTemplate }: Props) {
  return (
    <div style={{ flex: 'none', borderTop: '1px solid hsl(210 20% 90%)', background: '#fff', padding: '12px 16px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: 1, border: '1.5px solid hsl(210 20% 88%)', borderRadius: 14, background: 'hsl(210 20% 98%)', padding: '7px 12px 9px' }}>
          <input
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSend(); } }}
            placeholder="Nhập tin nhắn… gõ / để chèn mẫu"
            style={{ width: '100%', border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 13.5, color: 'hsl(160 30% 14%)', padding: '6px 0', outline: 'none' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 3 }}>
            <button style={iconBtn} title="Emoji"><Smile size={18} /></button>
            <button style={iconBtn} title="Gửi ảnh"><ImageIcon size={18} /></button>
            <button style={iconBtn} title="Đính kèm"><Paperclip size={18} /></button>
            <button style={iconBtn} title="Ghi âm"><Mic size={18} /></button>
            <span style={{ width: 1, height: 18, background: 'hsl(210 20% 88%)', margin: '0 4px' }} />
            <TemplatePicker templates={templates} onPick={onPickTemplate} />
          </div>
        </div>
        <button
          onClick={onSend}
          title="Gửi"
          style={{ width: 46, height: 46, borderRadius: 13, border: 'none', background: EMERALD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 6px 14px -5px hsl(152 69% 31% / .7)', flex: 'none' }}
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
