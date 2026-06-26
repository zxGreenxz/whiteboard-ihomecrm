import { Undo2 } from 'lucide-react';

export const REACTION_EMOJIS = ['❤️', '👍', '😆', '😮', '😢', '😠'];

interface Props {
  out: boolean;
  canRecall: boolean;
  onReact: (emoji: string) => void;
  onRecall?: () => void;
}

/** Thanh thao tác nổi khi hover bong bóng: thả cảm xúc + thu hồi (tin của mình). */
export default function MessageActions({ out, canRecall, onReact, onRecall }: Props) {
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
      {canRecall && onRecall && (
        <>
          <span style={{ width: 1, height: 16, background: 'hsl(210 20% 88%)', margin: '0 3px' }} />
          <button onClick={onRecall} title="Thu hồi" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(0 70% 50%)', display: 'flex', padding: 3, borderRadius: 6 }}><Undo2 size={15} /></button>
        </>
      )}
    </div>
  );
}
