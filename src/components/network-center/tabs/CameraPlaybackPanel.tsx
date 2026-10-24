import { useEffect, useId, useRef, useState } from "react";
import { Expand, History, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraLiveConnection, type CameraLiveState } from "@/lib/network-center/cameraLive";
import { cameraTimeLabel, validateCameraWindow, vietnamCameraInput } from "@/lib/network-center/cameraArchive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";

export const cameraFieldClass = "min-w-0 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
export function cameraChannelName(recorder: CameraRecorder, channel: number) { return recorder.snapshot?.channels.find((row) => row.channel === channel)?.name || `Kênh ${channel}`; }
interface Window { from: number; to: number }
export default function CameraPlaybackPanel({ recorder, channels, available }: { recorder: CameraRecorder; channels: number[]; available: boolean }) {
  const uid = useId(); const video = useRef<HTMLVideoElement>(null); const dragging = useRef(false); const generation = useRef(0);
  const [channel, setChannel] = useState(channels[0] ?? 1);
  const [from, setFrom] = useState(() => vietnamCameraInput(Date.now() - 3600_000));
  const [to, setTo] = useState(() => vietnamCameraInput(Date.now() - 1000));
  const [window, setWindow] = useState<Window>(); const [selection, setSelection] = useState<Window & { generation: number }>();
  const [cursor, setCursor] = useState(0); const [slider, setSlider] = useState(0);
  const [state, setState] = useState<CameraLiveState>("stopped"); const [message, setMessage] = useState("");
  useEffect(() => {
    if (!selection) return;
    let active = true; const element = video.current;
    const connection = new CameraLiveConnection({ recorderId: recorder.id, channel, playback: { start: new Date(selection.from).toISOString(), end: new Date(selection.to).toISOString() },
      onStream(stream) { if (active && element) element.srcObject = stream; },
      onState(next, detail) { if (active) { setState(next); setMessage(detail ?? ""); } },
    });
    void connection.start();
    return () => { active = false; connection.stop(); if (element) element.srcObject = null; };
  }, [recorder.id, channel, selection]);
  const reset = () => { setSelection(undefined); setWindow(undefined); setState("stopped"); setMessage(""); };
  const seek = (value: number, selected = window) => {
    if (!selected) return;
    const time = Math.max(selected.from, Math.min(selected.to - 1000, Math.floor(value / 1000) * 1000));
    setCursor(time); setSlider((time - selected.from) / 1000); setSelection({ from: time, to: selected.to, generation: ++generation.current }); setState("connecting"); setMessage("");
  };
  const open = () => {
    try { const selected = validateCameraWindow(from, to, 24 * 60); setWindow(selected); seek(selected.from, selected); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Khoảng thời gian chưa hợp lệ."); setState("error"); }
  };
  const updateTime = (element: HTMLVideoElement) => {
    if (element !== video.current || !selection || !window || element.readyState < 2) return;
    const time = Math.min(selection.to, selection.from + element.currentTime * 1000);
    setCursor(time); if (!dragging.current) setSlider((time - window.from) / 1000);
    if (time >= selection.to) { setSelection(undefined); setState("stopped"); setMessage("Đã hết khoảng thời gian đã chọn."); }
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
      {message && <p role={state === "error" ? "alert" : "status"} className="text-sm">{message}</p>}
      {window && <div className="space-y-3">
        <div className="relative bg-black">
          <video key={selection?.generation ?? "paused"} ref={video} autoPlay muted playsInline className="aspect-video max-h-[65vh] w-full object-contain" aria-label={`Video xem lại ${cameraChannelName(recorder, channel)}`} onPlaying={(event) => { if (event.currentTarget === video.current && selection) setState("playing"); }} onTimeUpdate={(event) => updateTime(event.currentTarget)} />
          {state === "connecting" && <p role="status" className="absolute inset-0 flex items-center justify-center bg-black text-white">Đang mở bản ghi…</p>}
        </div>
        <label className="block space-y-1 text-sm">Thanh thời gian · {cameraTimeLabel(window.from + slider * 1000)}<input aria-label="Thanh thời gian xem lại" className="w-full" type="range" min="0" max={Math.max(0, (window.to - window.from) / 1000 - 1)} step="1" value={slider} onPointerDown={() => { dragging.current = true; }} onChange={(event) => setSlider(Number(event.target.value))} onPointerUp={(event) => { dragging.current = false; seek(window.from + Number(event.currentTarget.value) * 1000); }} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seek(window.from + Number(event.currentTarget.value) * 1000); }} /></label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm">Vị trí ước tính: {cameraTimeLabel(cursor)}</span>
          <Button variant="outline" onClick={() => seek(cursor - 10_000)}>Lùi 10 giây</Button><Button variant="outline" onClick={() => seek(cursor + 10_000)}>Tới 10 giây</Button>
          {selection && state !== "error" ? <Button variant="outline" onClick={() => { setSelection(undefined); setState("stopped"); }}><Pause className="mr-2 h-4 w-4" />Tạm dừng</Button> : <Button variant="outline" onClick={() => seek(cursor)}><Play className="mr-2 h-4 w-4" />{state === "error" ? "Thử lại" : "Tiếp tục xem"}</Button>}
          <Button variant="outline" onClick={reset}><Square className="mr-2 h-4 w-4" />Dừng xem lại</Button>
          <Button variant="outline" onClick={() => { void video.current?.requestFullscreen().catch(() => setMessage("Trình duyệt chưa cho phép toàn màn hình.")); }}><Expand className="mr-2 h-4 w-4" />Toàn màn hình</Button>
        </div>
        <p className="text-xs text-muted-foreground">Kéo đến mốc cần xem để chuyển ngay. Vị trí trên thanh thời gian là ước tính; xem ngày giờ chính xác trên hình rồi nhập vào phần trích xuất.</p>
      </div>}
    </div>
  </section>;
}
