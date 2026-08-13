import { Undo2, Share2, Reply, EyeOff } from 'lucide-react';
import { EMERALD } from './zaloTheme';

export const REACTION_EMOJIS = ['❤️', '👍', '😆', '😮', '😢', '😠'];

interface Props {
  out: boolean;
  canRecall: boolean;
  onReact: (emoji: string) => void;
  onRecall?: () => void;
  onShare?: () => void;
  /** Trả lời (quote) tin này */
  onReply?: () => void;
  /** Xoá phía mình (ẩn khỏi khu chat công ty) */
  onDelete?: () => void;
}

/** Thanh thao tác nổi khi hover bong bóng: cảm xúc + trả lời + chia sẻ + thu hồi + xoá phía mình. */
export default function MessageActions({ out, canRecall, onReact, onRecall, onShare, onReply, onDelete }: Props) {
  return (
    <div
      style={{
        position: 'absolute', top: -34, [out ? 'right' : 'left']: 0,
        display: 'flex', alignItems: 'center', gap: 1,
        background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 18,
        padding: '3px 5px', boxShadow: '0 3px 10px rgba(16,24,40,.14)', zIndex: 5,
      }}
    >
      {REACTION_EMOJIS.map((e) => (
        <button key={e} onClick={() => onReact(e)} title={`Thả ${e}`} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 3px', borderRadius: 6 }}>{e}</button>
      ))}
      {onReply && (
        <>
          <span style={{ width: 1, height: 16, background: 'hsl(210 20% 88%)', margin: '0 3px' }} />
          <button onClick={onReply} title="Trả lời" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: EMERALD, display: 'flex', padding: 3, borderRadius: 6 }}><Reply size={15} /></button>
        </>
      )}
      {onShare && (
        <>
          <span style={{ width: 1, height: 16, background: 'hsl(210 20% 88%)', margin: '0 3px' }} />
          <button onClick={onShare} title="Chia sẻ tin này" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: EMERALD, display: 'flex', padding: 3, borderRadius: 6 }}><Share2 size={15} /></button>
        </>
      )}
      {canRecall && onRecall && (
        <>
          <span style={{ width: 1, height: 16, background: 'hsl(210 20% 88%)', margin: '0 3px' }} />
          <button onClick={onRecall} title="Thu hồi (cả hai phía)" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(0 70% 50%)', display: 'flex', padding: 3, borderRadius: 6 }}><Undo2 size={15} /></button>
        </>
      )}
      {onDelete && (
        <>
          <span style={{ width: 1, height: 16, background: 'hsl(210 20% 88%)', margin: '0 3px' }} />
          <button onClick={onDelete} title="Xoá ở phía bạn" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(210 10% 45%)', display: 'flex', padding: 3, borderRadius: 6 }}><EyeOff size={15} /></button>
        </>
      )}
    </div>
  );
}
