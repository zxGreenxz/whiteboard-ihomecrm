import { X, Reply } from 'lucide-react';
import { EMERALD } from '../zaloTheme';

interface Props {
  replyTo: { name: string; text: string };
  onCancel: () => void;
}

/** Thanh quote phía trên ô soạn khi đang trả lời một tin. */
export default function ReplyBar({ replyTo, onCancel }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'hsl(152 40% 96%)', border: '1px solid hsl(152 40% 88%)', borderRadius: 10, padding: '6px 10px', marginBottom: 8 }}>
      <Reply size={15} color={EMERALD} style={{ flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'hsl(152 69% 28%)' }}>Trả lời {replyTo.name}</div>
        <div style={{ fontSize: 12, color: 'hsl(210 10% 45%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyTo.text}</div>
      </div>
      <button onClick={onCancel} title="Huỷ trả lời" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(210 10% 50%)', display: 'flex', padding: 3, flex: 'none' }}>
        <X size={15} />
      </button>
    </div>
  );
}
