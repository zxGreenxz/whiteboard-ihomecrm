import { useEffect, useId, useRef, useState } from "react";
import { Expand, History, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraLiveConnection, CameraLiveError, type CameraLiveState, type CameraPlaybackQuality } from "@/lib/network-center/cameraLive";
import { cameraTimeLabel, validateCameraWindow, vietnamCameraInput } from "@/lib/network-center/cameraArchive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import { cameraFrame, capturePlaybackFrame, PlaybackClock, PlaybackControls, PlaybackPreviews, type PlaybackPreview } from "@/lib/network-center/cameraPlayback";
import { useCameraQuality } from "@/hooks/network-center/useCameraQuality";

export const cameraFieldClass = "min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
export function cameraChannelName(recorder: CameraRecorder, channel: number) { return recorder.snapshot?.channels.find((row) => row.channel === channel)?.name || `Kênh ${channel}`; }
interface Window { from: number; to: number }
export default function CameraPlaybackPanel({ recorder, channels, available, speeds = [1], qualities = [], controlAvailable = false, previewAvailable = false }: { recorder: CameraRecorder; channels: number[]; available: boolean; speeds?: number[]; qualities?: CameraPlaybackQuality[]; controlAvailable?: boolean; previewAvailable?: boolean }) {
  const uid = useId(); const video = useRef<HTMLVideoElement>(null); const dragging = useRef(false); const generation = useRef(0);
  const [channel, setChannel] = useState(channels[0] ?? 1);
  const [from, setFrom] = useState(() => vietnamCameraInput(Date.now() - 3600_000));
  const [to, setTo] = useState(() => vietnamCameraInput(Date.now() - 1000));
  const [window, setWindow] = useState<Window>(); const [selection, setSelection] = useState<Window & { generation: number; speed: number; quality?: CameraPlaybackQuality }>();
  const [quality, setQuality, qualityNotice] = useCameraQuality("playback"); const previewQuality = qualities.includes("sd") ? "sd" : undefined;
  const supportedQuality = qualities.includes(quality) ? quality : previewQuality;
  const [cursor, setCursor] = useState(0); const [slider, setSlider] = useState(0);
  const [speed, setSpeed] = useState(1); const [poster, setPoster] = useState<string>();
  const [preview, setPreview] = useState<PlaybackPreview>();
  const previews = useRef<PlaybackPreviews>(); const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  const clock = useRef(new PlaybackClock(1));
  const position = useRef<Window>(); const controls = useRef<PlaybackControls>(); const switching = useRef(false);
  const released = useRef(Promise.resolve()); const recoveries = useRef(0);
  const [state, setState] = useState<CameraLiveState>("stopped"); const [message, setMessage] = useState("");
  useEffect(() => {
    if (!window) return;
    const queue = new PlaybackPreviews((time, signal) => capturePlaybackFrame(recorder.id, channel, time, window.to, signal, previewQuality, previewAvailable)); previews.current = queue;
    return () => { clearTimeout(previewTimer.current); queue.clear(); if (previews.current === queue) previews.current = undefined; };
  }, [recorder.id, channel, window, previewQuality, previewAvailable]);
  useEffect(() => {
    if (!selection) return;
    let active = true; const element = video.current;
    // SD/HD has realtime RTP timestamps; the recorder still supplies accelerated content.
    clock.current = new PlaybackClock(selection.speed, selection.quality ? selection.speed : 1); position.current = selection; switching.current = false;
    let callback: number | undefined; let lastUpdate = 0;
    const frame: VideoFrameRequestCallback = (now, metadata) => {
      if (!active || !element || element !== video.current) return;
      const current = position.current;
      if (current && !switching.current) {
        const seconds = clock.current.frame(metadata.rtpTimestamp, metadata.mediaTime);
        setPoster(undefined); setState("playing");
        if (now - lastUpdate >= 250 || current.from + seconds * 1000 >= current.to) { updatePosition(seconds, current); lastUpdate = now; }
      }
      callback = element.requestVideoFrameCallback(frame);
    };
    if (element?.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(frame);
    const connection = new CameraLiveConnection({ recorderId: recorder.id, channel, playback: { start: new Date(controlAvailable && window ? window.from : selection.from).toISOString(), end: new Date(selection.to).toISOString(), ...(controlAvailable && window && selection.from !== window.from ? { position: new Date(selection.from).toISOString() } : {}), ...(selection.speed === 1 ? {} : { speed: selection.speed }), ...(selection.quality ? { quality: selection.quality } : {}) },
      onStream(stream) { if (active && element) element.srcObject = stream; },
      onState(next, detail) { if (active && (next !== "playing" || !switching.current)) { setState(next); setMessage(detail ?? ""); } },
    });
    const started = released.current.then(() => { if (active) return connection.start(); });
    const queue = new PlaybackControls((time, nextSpeed) => started.then(() => connection.seek(time, nextSpeed)), (time, nextSpeed) => {
      if (!active) return;
      clock.current = new PlaybackClock(nextSpeed, nextSpeed, element?.currentTime ?? 0); position.current = { from: time, to: selection.to }; switching.current = false;
    }, (error, time, nextSpeed) => {
      if (!active) return;
      switching.current = false;
      if (recoveries.current < 2 && (!(error instanceof CameraLiveError) || ["CAMERA_UNAVAILABLE", "PLAYBACK_CONTROL_FAILED", "PLAYBACK_CONTROL_UNAVAILABLE", "SESSION_NOT_FOUND"].includes(error.code))) {
        recoveries.current++; setSelection({ ...selection, from: time, speed: nextSpeed, generation: ++generation.current }); setMessage("Đang nối lại bản ghi tại mốc đã chọn…");
      } else { void connection.stop(); setState("error"); setMessage(error instanceof Error ? error.message : "Không chuyển được mốc xem."); }
    });
    controls.current = queue;
    return () => { active = false; queue.cancel(); if (controls.current === queue) controls.current = undefined; if (element && callback !== undefined) element.cancelVideoFrameCallback(callback); released.current = Promise.all([released.current, connection.stop()]).then(() => undefined); if (element) element.srcObject = null; };
    // updatePosition uses the window paired with this selection; a new window always replaces the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.id, channel, selection, controlAvailable]);
  const hidePreview = () => { clearTimeout(previewTimer.current); previews.current?.cancel(); setPreview(undefined); dragging.current = false; };
  const reset = () => { hidePreview(); setPoster(undefined); setSelection(undefined); setWindow(undefined); setState("stopped"); setMessage(""); };
  const holdFrame = () => { const image = cameraFrame(video.current); if (image) setPoster(image); };
  const seek = (value: number, selected = window, nextSpeed = speed, nextQuality = supportedQuality) => {
    if (!selected) return;
    holdFrame(); hidePreview();
    const time = Math.max(selected.from, Math.min(selected.to - 1000, Math.floor(value / 1000) * 1000));
    setCursor(time); setSlider((time - selected.from) / 1000); setState("connecting"); setMessage("");
    if (controlAvailable && selection && selected === window && selection.quality === nextQuality && state !== "error" && controls.current) {
      switching.current = true; controls.current.request(time, nextSpeed);
    } else setSelection({ from: time, to: selected.to, generation: ++generation.current, speed: nextSpeed, ...(nextQuality && qualities.includes(nextQuality) ? { quality: nextQuality } : {}) });
  };
  const open = () => {
    try { const selected = validateCameraWindow(from, to, 24 * 60); recoveries.current = 0; setWindow(selected); seek(selected.from, selected); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Khoảng thời gian chưa hợp lệ."); setState("error"); }
  };
  const updatePosition = (seconds: number, current: Window) => {
    if (!window) return;
    const time = Math.min(current.to, current.from + seconds * 1000);
    setCursor(time); if (!dragging.current) setSlider((time - window.from) / 1000);
    if (time >= current.to) { holdFrame(); hidePreview(); setSelection(undefined); setState("stopped"); setMessage("Đã hết khoảng thời gian đã chọn."); }
  };
  const updateTime = (element: HTMLVideoElement) => {
    if (element !== video.current || !selection || !position.current || switching.current || element.readyState < 2) return;
    updatePosition(clock.current.seconds(element.currentTime), position.current);
  };
  const scrub = (value: number) => {
    if (!window) return;
    dragging.current = true; setSlider(value);
    const time = window.from + value * 1000;
    clearTimeout(previewTimer.current); previews.current?.cancel(); setPreview({ time });
    previewTimer.current = setTimeout(() => previews.current?.request(time, setPreview), 250);
  };
  return <section className="nc-panel" aria-label={`Xem lại ${recorder.display_name}`}>
    <div className="nc-panel-heading"><div><p className="nc-eyebrow">Tìm đồ cho khách</p><h3 className="flex items-center gap-2"><History className="h-5 w-5" />Xem lại · {recorder.display_name}</h3></div></div>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">Phát trực tiếp bản ghi từ đầu ghi. Chọn khoảng tối đa 24 giờ rồi kéo thanh thời gian để tìm sự việc. Giờ Việt Nam (UTC+7).</p>
      <form onSubmit={(event) => { event.preventDefault(); open(); }} className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-sm" htmlFor={`${uid}-channel`}><span>Camera cần tìm</span><select id={`${uid}-channel`} className={cameraFieldClass} value={channel} disabled={!available} onChange={(event) => { reset(); setChannel(Number(event.target.value)); }}>{channels.map((value) => <option key={value} value={value}>{cameraChannelName(recorder, value)}</option>)}</select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-from`}><span>Từ ngày giờ</span><input id={`${uid}-from`} className={cameraFieldClass} type="datetime-local" step="1" required value={from} onChange={(event) => { reset(); setFrom(event.target.value); }} /></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-to`}><span>Đến ngày giờ</span><input id={`${uid}-to`} className={cameraFieldClass} type="datetime-local" step="1" required value={to} onChange={(event) => { reset(); setTo(event.target.value); }} /></label>
        <Button type="submit" disabled={!available || !recorder.enabled}><History className="mr-2 h-4 w-4" />Xem khoảng thời gian</Button>
      </form>
      {qualities.length > 0 && <label className="block max-w-sm space-y-1 text-sm"><span>Chất lượng xem lại</span><select className={cameraFieldClass} value={supportedQuality} onChange={(event) => { const next = event.target.value as CameraPlaybackQuality; if (qualities.includes(next)) { setQuality(next); if (selection) seek(cursor, window, speed, next); } }}>{qualities.map((value) => <option key={value} value={value}>{{ sd: "SD 480p", hd: "HD 720p", fullhd: "Full HD 1080p", original: "Độ phân giải gốc · Cao nhất đầu ghi có" }[value]}</option>)}</select></label>}
      {message && <p role={state === "error" ? "alert" : "status"} className="text-sm">{message}</p>}
      {qualityNotice && <p role="status" className="text-sm">{qualityNotice}</p>}
      {window && <div className="space-y-3">
        <div className="relative bg-black">
          <video key={selection?.generation ?? "paused"} ref={video} autoPlay muted playsInline className="aspect-video max-h-[65vh] w-full object-contain" aria-label={`Video xem lại ${cameraChannelName(recorder, channel)}`} onPlaying={(event) => { if (event.currentTarget === video.current && selection && !switching.current) { setState("playing"); setPoster(undefined); } }} onTimeUpdate={(event) => updateTime(event.currentTarget)} />
          {poster && <img src={poster} alt="Khung hình trước khi chuyển mốc" className="absolute inset-0 h-full w-full object-contain" />}
          {state === "connecting" && <p role="status" className={`absolute flex items-center justify-center text-white ${poster ? "inset-x-0 bottom-0 bg-black/70 p-2 text-sm" : "inset-0 bg-black"}`}>{poster ? "Đang chuyển mốc · đang giữ khung hình trước…" : "Đang mở bản ghi…"}</p>}
          {poster && selection && state !== "connecting" && <p className="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-sm text-white">Ảnh của mốc trước · chưa có hình tại mốc đã chọn</p>}
          {!selection && poster && <p className="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-sm text-white">Đã tạm dừng</p>}
        </div>
        <div className="relative">
          {preview && <div role="status" className="pointer-events-none absolute bottom-full z-10 mb-2 w-56 max-w-full overflow-hidden rounded-md border bg-background p-1 shadow-lg" style={{ left: `clamp(0px, calc(${(preview.time - window.from) / (window.to - window.from) * 100}% - 7rem), max(0px, calc(100% - 14rem)))` }}>
            {preview.image ? <img src={preview.image} alt={`Ảnh xem trước · ${cameraTimeLabel(preview.time)}`} className="aspect-video w-full object-contain" /> : <p className="flex aspect-video items-center justify-center bg-muted p-2 text-center text-xs">{preview.error ? "Chưa lấy được ảnh. Thả thanh tua để xem mốc này." : "Đang lấy ảnh xem trước…"}</p>}
            <p className="p-1 text-center text-xs">{cameraTimeLabel(preview.time)}</p>
          </div>}
          <label className="block space-y-1 text-sm">Thanh thời gian · {cameraTimeLabel(window.from + slider * 1000)}<input aria-label="Thanh thời gian xem lại" className="h-11 w-full touch-none" type="range" min="0" max={Math.max(0, (window.to - window.from) / 1000 - 1)} step="1" value={slider} onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); dragging.current = true; }} onChange={(event) => scrub(Number(event.target.value))} onPointerUp={(event) => seek(window.from + Number(event.currentTarget.value) * 1000)} onPointerCancel={() => { hidePreview(); setSlider((cursor - window.from) / 1000); }} onBlur={hidePreview} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seek(window.from + Number(event.currentTarget.value) * 1000); }} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm">Vị trí ước tính: {cameraTimeLabel(cursor)}</span>
          <label className="flex items-center gap-2 text-sm"><span>Tốc độ xem lại</span><select className={cameraFieldClass} value={speed} onChange={(event) => { const next = Number(event.target.value); setSpeed(next); if (selection) seek(cursor, window, next); }}>{speeds.map((value) => <option key={value} value={value}>{value}×{value === 1 ? " · Bình thường" : ""}</option>)}</select></label>
          <Button variant="outline" onClick={() => seek(cursor - 10_000)}>Lùi 10 giây</Button><Button variant="outline" onClick={() => seek(cursor + 10_000)}>Tới 10 giây</Button>
          {selection && state !== "error" ? <Button variant="outline" onClick={() => { holdFrame(); hidePreview(); setSelection(undefined); setState("stopped"); }}><Pause className="mr-2 h-4 w-4" />Tạm dừng</Button> : <Button variant="outline" onClick={() => seek(cursor)}><Play className="mr-2 h-4 w-4" />{state === "error" ? "Thử lại" : "Tiếp tục xem"}</Button>}
          <Button variant="outline" onClick={reset}><Square className="mr-2 h-4 w-4" />Dừng xem lại</Button>
          <Button variant="outline" onClick={() => { void video.current?.requestFullscreen().catch(() => setMessage("Trình duyệt chưa cho phép toàn màn hình.")); }}><Expand className="mr-2 h-4 w-4" />Toàn màn hình</Button>
        </div>
        <p className="text-xs text-muted-foreground">Giữ thanh tua tại một mốc để xem trước ảnh, thả để chuyển. Tốc độ áp dụng trực tiếp trên đầu ghi. Vị trí trên thanh thời gian là ước tính; đối chiếu ngày giờ trên hình khi trích xuất.</p>
      </div>}
    </div>
  </section>;
}
