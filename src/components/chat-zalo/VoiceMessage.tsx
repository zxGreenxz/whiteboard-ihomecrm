import { useRef, useState, useEffect } from 'react';
import { Play, Pause, Mic } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import { MetaRow } from './MessageBubble';
import MessageActions from './MessageActions';
import type { ZaloMessage } from './types';
import type { MsgActionProps } from './MessageBubble';

function fmtDur(ms?: number): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Tin nhắn thoại — player play/pause + progress + thời lượng. */
export default function VoiceMessage({ m, onReact, onRecall, onShare, onReply, onDelete }: { m: ZaloMessage } & MsgActionProps) {
  const out = m.dir === 'out';
  const [hover, setHover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const url = m.localUrl || m.mediaUrl;
  const durMs = Number(m.mediaMeta?.duration_ms) || undefined;

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const toggle = () => {
    if (!url) return;
    if (!audioRef.current) {
      const a = new Audio(url);
      a.addEventListener('timeupdate', () => setProgress(a.duration ? a.currentTime / a.duration : 0));
      a.addEventListener('ended', () => { setPlaying(false); setProgress(0); });
      audioRef.current = a;
    }
    if (playing) { audioRef.current.pause(); setPlaying(false); }
    else { audioRef.current.play().catch(() => setPlaying(false)); setPlaying(true); }
  };

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginTop: 8 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'relative' }}>
        {hover && (
          <MessageActions
            out={out} canRecall={out && !!onRecall && !!m.id}
            onReact={(e) => m.id && onReact?.(m.id, e)}
            onRecall={() => m.id && onRecall?.(m.id)}
            onShare={onShare ? () => onShare(m) : undefined}
            onReply={onReply && m.id ? () => onReply(m) : undefined}
            onDelete={onDelete && m.id ? () => onDelete(m.id!) : undefined}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: out ? EMERALD : '#fff', border: out ? 'none' : '1px solid hsl(210 20% 88%)', color: out ? '#fff' : 'hsl(160 30% 14%)', borderRadius: 14, padding: '9px 14px', minWidth: 190 }}>
          <button onClick={toggle} disabled={!url} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: out ? 'rgba(255,255,255,.22)' : 'hsl(152 40% 94%)', color: out ? '#fff' : 'hsl(152 69% 30%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: url ? 'pointer' : 'default', flex: 'none' }}>
            {playing ? <Pause size={14} /> : <Play size={14} style={{ marginLeft: 2 }} />}
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ height: 4, borderRadius: 2, background: out ? 'rgba(255,255,255,.3)' : 'hsl(210 20% 92%)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: out ? '#fff' : EMERALD, transition: 'width .2s' }} />
            </div>
          </div>
          <span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.9, display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
            <Mic size={12} />{fmtDur(durMs)}
          </span>
        </div>
        {m.react && (
          <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', margin: '4px 8px 0' }}>
            <span style={{ background: '#fff', border: '1px solid hsl(210 20% 88%)', borderRadius: 11, padding: '1px 7px', fontSize: 11 }}>{m.react}</span>
          </div>
        )}
        <MetaRow out={out} time={m.time} tick={m.tick} />
      </div>
    </div>
  );
}
