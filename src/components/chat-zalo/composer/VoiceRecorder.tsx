import { useEffect, useRef, useState } from 'react';
import { Square, Send, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { EMERALD } from '../zaloTheme';

interface Props {
  onDone: (blob: Blob, durationMs: number, mime: string) => void;
  onCancel: () => void;
  sending?: boolean;
}

// Ưu tiên mp4/aac (Zalo nhận thẳng); fallback webm/opus (worker sẽ degrade
// thành tệp đính kèm nếu Zalo từ chối voice).
function pickMime(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** Thanh ghi âm thay chỗ ô soạn: timer đỏ + dừng/nghe lại + gửi/huỷ. */
export default function VoiceRecorder({ onDone, onCancel, sending }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAt = useRef(0);
  const durationRef = useRef(0);
  const mimeRef = useRef('');

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = pickMime();
        mimeRef.current = mime || 'audio/webm';
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        rec.addEventListener('dataavailable', (e) => { if (e.data.size) chunksRef.current.push(e.data); });
        rec.addEventListener('stop', () => {
          durationRef.current = Date.now() - startedAt.current;
          const b = new Blob(chunksRef.current, { type: mimeRef.current });
          setBlob(b);
          setPreviewUrl(URL.createObjectURL(b));
          stream?.getTracks().forEach((t) => t.stop());
        });
        recRef.current = rec;
        startedAt.current = Date.now();
        rec.start();
        setRecording(true);
        timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
      } catch {
        toast.error('Không truy cập được micro — kiểm tra quyền trình duyệt');
        onCancel();
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
      try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* */ }
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const stop = () => {
    try { recRef.current?.stop(); } catch { /* */ }
    setRecording(false);
  };
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1.5px solid hsl(0 60% 85%)', borderRadius: 14, background: 'hsl(0 60% 98%)', padding: '10px 14px' }}>
      {recording ? (
        <>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'hsl(0 70% 50%)', animation: 'pulse 1.2s infinite' }} />
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(0 60% 40%)', minWidth: 44 }}>{fmt(elapsed)}</span>
          <span style={{ fontSize: 12, color: 'hsl(210 10% 45%)' }}>Đang ghi âm…</span>
          <button onClick={stop} title="Dừng" style={{ marginLeft: 'auto', width: 34, height: 34, borderRadius: 9, border: 'none', background: 'hsl(0 70% 50%)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Square size={14} />
          </button>
        </>
      ) : (
        <>
          {previewUrl && <audio src={previewUrl} controls style={{ height: 34, flex: 1, minWidth: 0 }} />}
          <button
            onClick={() => blob && onDone(blob, durationRef.current, mimeRef.current)}
            disabled={!blob || sending}
            title="Gửi tin thoại"
            style={{ width: 38, height: 38, borderRadius: 10, border: 'none', background: EMERALD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: sending ? 0.75 : 1, flex: 'none' }}
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </>
      )}
      <button onClick={onCancel} disabled={sending} title="Huỷ" style={{ width: 34, height: 34, borderRadius: 9, border: '1px solid hsl(210 20% 88%)', background: '#fff', color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}>
        <Trash2 size={15} />
      </button>
    </div>
  );
}
