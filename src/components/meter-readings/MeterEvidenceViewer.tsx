import { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import { StorageImage } from '@/components/ui/storage-image';
import { useSignedUrl } from '@/hooks/useSignedUrl';
import type { MeterEvidenceFrame } from '@/lib/meter-capture/types';

function clipTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

/** Private evidence only; callers mount this after opening an internal review. */
export function MeterEvidenceViewer({ imageUrl, videoUrl, evidenceFrames = [], timestampSeconds, label = 'Ảnh đối chiếu đồng hồ nội bộ' }: {
  imageUrl?: string | null; videoUrl?: string | null; evidenceFrames?: MeterEvidenceFrame[];
  timestampSeconds?: number | null; label?: string;
}) {
  const [selected, setSelected] = useState<MeterEvidenceFrame | null>(null);
  const [play, setPlay] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const video = useSignedUrl(play ? videoUrl : null);
  const frames = evidenceFrames.slice(0, 6);
  const time = selected?.timestampSeconds ?? timestampSeconds ?? frames.find(frame => frame.imageUrl === imageUrl)?.timestampSeconds ?? frames[0]?.timestampSeconds ?? 0;
  const image = selected?.imageUrl ?? imageUrl ?? frames[0]?.imageUrl;
  useEffect(() => { if (player.current && player.current.readyState >= 1) player.current.currentTime = time; }, [time]);
  return <div className="space-y-2">
    {play && video ? <video ref={player} aria-label="Clip đối chiếu đồng hồ" controls playsInline preload="metadata" className="max-h-[65vh] w-full rounded" src={video}
      onLoadedMetadata={event => { event.currentTarget.currentTime = time; }} />
      : image ? <StorageImage value={image} alt={label} className="max-h-[65vh] w-full object-contain" />
        : <p className="text-sm text-muted-foreground">Chưa có ảnh trích; mở clip gốc để đối chiếu.</p>}
    {frames.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Các ảnh chứng cứ trong clip">
      {frames.map(frame => <button key={`${frame.imageUrl}:${frame.timestampSeconds}`} type="button"
        className={`w-24 overflow-hidden rounded border p-1 ${selected === frame ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
        aria-label={`Ảnh tại ${clipTime(frame.timestampSeconds)}`} aria-pressed={selected === frame}
        onClick={() => { setSelected(frame); setPlay(false); }}>
        <StorageImage value={frame.imageUrl} alt={`Mặt số tại ${clipTime(frame.timestampSeconds)}`} className="h-16 w-full object-contain" />
        <span className="text-xs">{clipTime(frame.timestampSeconds)}</span>
      </button>)}
    </div>}
    {videoUrl && <button type="button" className="inline-flex items-center gap-2 text-sm underline" onClick={() => setPlay(current => !current)}>
      <Film className="h-4 w-4" />{play ? 'Xem ảnh chốt' : `Xem clip tại ${clipTime(time)}`}
    </button>}
  </div>;
}
