import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useCameraQuality } from "@/hooks/network-center/useCameraQuality";
import { ArrowLeft, Expand, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraLiveConnection, cameraLiveCapabilities, type CameraLiveState, type CameraLiveQuality } from "@/lib/network-center/cameraLive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import CameraAudioButton from "./CameraAudioButton";

function LiveTile({ recorderId, channel, name, quality, hidden, audible, pendingStops, onFocus, onAudio }: { recorderId: string; channel: number; name: string; quality: CameraLiveQuality; hidden: boolean; audible: boolean; pendingStops: MutableRefObject<Promise<void>>; onFocus(): void; onAudio(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraLiveState>("connecting");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);
  useEffect(() => {
    let active = true;
    setState("connecting"); setMessage(""); setHasAudio(false);
    const element = video.current;
    const connection = new CameraLiveConnection({ recorderId, channel, liveQuality: quality,
      onStream(stream) { if (active && video.current) video.current.srcObject = stream; },
      onAudio(available) { if (active) setHasAudio(available); },
      onState(next, detail) { if (active) { setState(next); setMessage(detail ?? ""); } },
    });
    // All tiles release their old profiles before any new profile starts. Read after this effect flush
    // so a slow sibling DELETE cannot collide with Full HD's exclusive transcoding reservation.
    void Promise.resolve().then(() => pendingStops.current).then(() => { if (active) return connection.start(); });
    return () => { active = false; pendingStops.current = Promise.all([pendingStops.current, connection.stop()]).then(() => undefined); if (element) element.srcObject = null; };
  }, [recorderId, channel, attempt, quality, pendingStops]);
  return <article hidden={hidden} tabIndex={hidden ? -1 : 0} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") onFocus(); }} onDoubleClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("button")) onFocus(); }} className={`${hidden ? "hidden" : "flex"} min-h-0 touch-manipulation flex-col overflow-hidden border-2 border-black bg-black text-white`} aria-label={`Trực tiếp ${name}`} title="Bấm đôi để xem riêng camera">
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm"><strong>{name}</strong><span aria-live="polite">{state === "playing" ? "● Trực tiếp" : state === "connecting" ? "Đang kết nối" : "Chưa có hình"}</span></div>
    <div className="relative aspect-video group-[:fullscreen]/live-wall:min-h-0 group-[:fullscreen]/live-wall:flex-1 group-[:fullscreen]/live-wall:aspect-auto">
      <video ref={video} autoPlay muted={!audible || hidden} playsInline onLoadedData={(event) => { if (event.currentTarget.readyState >= 2 && event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0 && state === "connecting") { setState("playing"); setMessage(""); } }} className={`h-full w-full object-contain ${state === "playing" ? "" : "invisible"}`} aria-label={`Video ${name}`} />
      {state !== "playing" && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black p-3 text-center text-sm"><p>{message || "Đang kết nối camera…"}</p>{state === "error" && <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Kết nối lại</Button>}</div>}
      <div className="absolute bottom-2 right-2"><CameraAudioButton video={video} available={hasAudio} enabled={audible && !hidden} onToggle={onAudio} /></div>
    </div>
  </article>;
}

export default function CameraLiveWall({ recorder }: { recorder: CameraRecorder }) {
  const container = useRef<HTMLElement>(null);
  const pendingStops = useRef<Promise<void>>(Promise.resolve());
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [channels, setChannels] = useState<number[]>([]);
  const [count, setCount] = useState(4);
  const [quality, setQuality, qualityNotice] = useCameraQuality("live"); const [qualities, setQualities] = useState<CameraLiveQuality[]>(["sd"]);
  const [focused, setFocused] = useState<number>(); const [audible, setAudible] = useState<number>();
  const [page, setPage] = useState(0);
  const abortRef = useRef<AbortController>();
  useEffect(() => () => abortRef.current?.abort(), []);
  const start = async () => {
    abortRef.current?.abort(); const abort = new AbortController(); abortRef.current = abort;
    setLoading(true); setError("");
    try {
      const result = await cameraLiveCapabilities(recorder.id, abort.signal);
      if (!abort.signal.aborted) { setQualities(result.liveQualities); setChannels(result.channels); setPage(0); setFocused(undefined); setAudible(undefined); setRunning(true); }
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không thể kết nối camera."); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  };
  const displayed = channels.slice(page * count, (page + 1) * count);
  const visibleCount = focused === undefined ? count : 1;
  const qualityTileLimit = quality === "fullhd" ? 1 : quality === "hd" ? 4 : 16;
  const qualityLimited = visibleCount > qualityTileLimit;
  return <section ref={container} className="nc-panel group/live-wall bg-white [&:fullscreen]:flex [&:fullscreen]:h-screen [&:fullscreen]:flex-col [&:fullscreen]:overflow-hidden" aria-label={`Xem trực tiếp ${recorder.display_name}`}>
    <div className="nc-panel-heading shrink-0 flex-wrap gap-3">
      <div><p className="nc-eyebrow">Hình ảnh trực tiếp</p><h3>{recorder.display_name}</h3></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">Chất lượng trực tiếp <select aria-label="Chất lượng trực tiếp" value={quality} className="ml-2 min-h-11 border-2 border-black bg-white p-2" onChange={(event) => setQuality(event.target.value as CameraLiveQuality)}>{([['sd', 'SD · Nhẹ hơn'], ['hd', 'HD 720p'], ['fullhd', 'Full HD 1080p'], ['original', 'Độ phân giải gốc']] as const).map(([value, label]) => <option key={value} value={value} disabled={running && !qualities.includes(value)}>{label}</option>)}</select></label>
        <label className="text-sm">Số ô <select aria-label="Số camera cùng lúc" value={count} disabled={focused !== undefined} className="ml-2 border-2 border-black bg-white p-2" onChange={(event) => { setCount(Number(event.target.value)); setPage(0); setAudible(undefined); }}>{[1, 4, 9, 16].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        {focused !== undefined && <Button variant="outline" onClick={() => setFocused(undefined)}><ArrowLeft className="mr-2 h-4 w-4" />Quay về {count} camera</Button>}
        {!running ? <Button disabled={loading || !recorder.enabled} onClick={() => void start()}><Play className="mr-2 h-4 w-4" />{loading ? "Đang kiểm tra quyền…" : "Xem trực tiếp"}</Button>
          : <Button variant="outline" onClick={() => { setRunning(false); setFocused(undefined); setAudible(undefined); }}><Square className="mr-2 h-4 w-4" />Dừng xem</Button>}
        {running && <Button variant="outline" onClick={() => { const request = document.fullscreenElement === container.current ? document.exitFullscreen() : container.current?.requestFullscreen(); void request?.catch(() => setError("Trình duyệt chưa cho phép toàn màn hình.")); }}><Expand className="mr-2 h-4 w-4" /><span className="group-[:fullscreen]/live-wall:hidden">Toàn màn hình</span><span className="hidden group-[:fullscreen]/live-wall:inline">Thoát toàn màn hình</span></Button>}
      </div>
    </div>
    {error && <p role="alert" className="p-4 text-red-700">{error}</p>}
    {qualityNotice && <p role="status" className="px-4 py-2 text-sm">{qualityNotice}</p>}
    {running && qualityLimited && <p role="status" className="px-4 py-2 text-sm">Đang dùng SD cho lưới nhiều camera. Bấm đôi một ô hoặc chọn tối đa {qualityTileLimit} ô để xem {quality === "hd" ? "HD" : "Full HD"}.</p>}
    {running ? <>
      <div className={`grid gap-2 bg-neutral-900 p-2 group-[:fullscreen]/live-wall:min-h-0 group-[:fullscreen]/live-wall:flex-1 ${visibleCount === 1 ? "grid-cols-1 group-[:fullscreen]/live-wall:grid-rows-1" : visibleCount === 4 ? "grid-cols-1 sm:grid-cols-2 group-[:fullscreen]/live-wall:grid-cols-2 group-[:fullscreen]/live-wall:grid-rows-2" : visibleCount === 9 ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 group-[:fullscreen]/live-wall:grid-cols-3 group-[:fullscreen]/live-wall:grid-rows-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 group-[:fullscreen]/live-wall:grid-cols-4 group-[:fullscreen]/live-wall:grid-rows-4"}`}>
        {displayed.map((channel) => <LiveTile key={channel} recorderId={recorder.id} channel={channel} quality={!qualityLimited && !(count > qualityTileLimit && focused !== channel) && qualities.includes(quality) ? quality : "sd"} hidden={focused !== undefined && focused !== channel} audible={audible === channel} pendingStops={pendingStops} onFocus={() => { setFocused(channel); if (audible !== channel) setAudible(undefined); }} onAudio={() => setAudible(audible === channel ? undefined : channel)} name={recorder.snapshot?.channels.find((row) => row.channel === channel)?.name || `Kênh ${channel}`} />)}
      </div>
      {focused === undefined && channels.length > count && <div className="flex shrink-0 items-center justify-center gap-3 p-3"><Button variant="outline" disabled={page === 0} onClick={() => { setPage((value) => value - 1); setAudible(undefined); }}>Nhóm trước</Button><span>{page + 1} / {Math.ceil(channels.length / count)}</span><Button variant="outline" disabled={(page + 1) * count >= channels.length} onClick={() => { setPage((value) => value + 1); setAudible(undefined); }}>Nhóm sau</Button></div>}
    </> : <p className="p-4 text-sm">Bấm xem để kết nối. Video không được lưu thêm tại CRM. Khả năng phát phụ thuộc định dạng camera và trình duyệt; đường truyền hạn chế có thể cần thử mạng khác.</p>}
  </section>;
}
