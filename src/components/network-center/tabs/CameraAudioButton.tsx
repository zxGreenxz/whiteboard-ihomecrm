import { useEffect, useState, type RefObject } from "react";
import { Volume2, VolumeX } from "lucide-react";

export default function CameraAudioButton({ video, available, enabled, onToggle, disabled = false }: { video: RefObject<HTMLVideoElement>; available: boolean; enabled: boolean; onToggle(): void; disabled?: boolean }) {
  const [error, setError] = useState("");
  useEffect(() => { if (video.current) video.current.muted = !enabled || disabled || !available; }, [video, available, enabled, disabled]);
  if (!available) return null;
  const label = disabled ? "Nghe ở tốc độ 1×" : enabled ? "Tắt âm thanh" : "Nghe âm thanh";
  return <div className="flex max-w-full items-center justify-end gap-2 text-sm">
    {error && <span role="status" className="rounded bg-black/80 p-2 text-xs text-white">{error}</span>}
    <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-colors hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50" disabled={disabled} aria-label={label} title={label} aria-pressed={enabled && !disabled} onClick={(event) => {
      event.stopPropagation(); setError("");
      if (video.current) { video.current.muted = enabled; void video.current.play().catch(() => setError("Chưa phát được âm thanh. Bấm nghe lại.")); }
      onToggle();
    }}>{enabled && !disabled ? <Volume2 className="h-5 w-5" aria-hidden="true" /> : <VolumeX className="h-5 w-5" aria-hidden="true" />}</button>
  </div>;
}
