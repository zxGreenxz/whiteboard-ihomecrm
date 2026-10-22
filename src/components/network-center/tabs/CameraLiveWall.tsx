import { useEffect, useRef, useState } from "react";
import { Expand, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraLiveConnection, cameraLiveCapabilities, type CameraLiveState } from "@/lib/network-center/cameraLive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";

function LiveTile({ recorderId, channel, name }: { recorderId: string; channel: number; name: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraLiveState>("connecting");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const element = video.current;
    const connection = new CameraLiveConnection({ recorderId, channel,
      onStream(stream) { if (active && video.current) video.current.srcObject = stream; },
      onState(next, detail) { if (active) { setState(next); setMessage(detail ?? ""); } },
    });
    void connection.start();
    return () => { active = false; connection.stop(); if (element) element.srcObject = null; };
  }, [recorderId, channel, attempt]);
  return <article className="overflow-hidden border-2 border-black bg-black text-white" aria-label={`Trực tiếp ${name}`}>
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm"><strong>{name}</strong><span aria-live="polite">{state === "playing" ? "● Trực tiếp" : state === "connecting" ? "Đang kết nối" : "Chưa có hình"}</span></div>
    <div className="relative aspect-video">
      <video ref={video} autoPlay muted playsInline className={`h-full w-full object-contain ${state === "playing" ? "" : "invisible"}`} aria-label={`Video ${name}`} />
      {state !== "playing" && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black p-3 text-center text-sm"><p>{message || "Đang kết nối camera…"}</p>{state === "error" && <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Xem lại</Button>}</div>}
    </div>
  </article>;
}

export default function CameraLiveWall({ recorder }: { recorder: CameraRecorder }) {
  const container = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [channels, setChannels] = useState<number[]>([]);
  const [count, setCount] = useState(4);
  const [page, setPage] = useState(0);
  const abortRef = useRef<AbortController>();
  useEffect(() => () => abortRef.current?.abort(), []);
  const start = async () => {
    abortRef.current?.abort(); const abort = new AbortController(); abortRef.current = abort;
    setLoading(true); setError("");
    try {
      const result = await cameraLiveCapabilities(recorder.id, abort.signal);
      if (!abort.signal.aborted) { setChannels(result.channels); setPage(0); setRunning(true); }
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không thể kết nối camera."); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  };
  const displayed = channels.slice(page * count, (page + 1) * count);
  return <section ref={container} className="nc-panel bg-white" aria-label={`Xem trực tiếp ${recorder.display_name}`}>
    <div className="nc-panel-heading flex-wrap gap-3">
      <div><p className="nc-eyebrow">Hình ảnh trực tiếp</p><h3>{recorder.display_name}</h3></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">Số ô <select aria-label="Số camera cùng lúc" value={count} className="ml-2 border-2 border-black bg-white p-2" onChange={(event) => { setCount(Number(event.target.value)); setPage(0); }}>{[1, 4, 9, 16].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        {!running ? <Button disabled={loading || !recorder.enabled} onClick={() => void start()}><Play className="mr-2 h-4 w-4" />{loading ? "Đang kiểm tra quyền…" : "Xem trực tiếp"}</Button>
          : <Button variant="outline" onClick={() => setRunning(false)}><Square className="mr-2 h-4 w-4" />Dừng xem</Button>}
        {running && <Button variant="outline" onClick={() => { void container.current?.requestFullscreen().catch(() => setError("Trình duyệt chưa cho phép toàn màn hình.")); }}><Expand className="mr-2 h-4 w-4" />Toàn màn hình</Button>}
      </div>
    </div>
    {error && <p role="alert" className="p-4 text-red-700">{error}</p>}
    {running ? <>
      <div className={`grid gap-2 bg-neutral-900 p-2 ${count === 1 ? "grid-cols-1" : count === 4 ? "grid-cols-1 sm:grid-cols-2" : count === 9 ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"}`}>
        {displayed.map((channel) => <LiveTile key={channel} recorderId={recorder.id} channel={channel} name={recorder.snapshot?.channels.find((row) => row.channel === channel)?.name || `Kênh ${channel}`} />)}
      </div>
      {channels.length > count && <div className="flex items-center justify-center gap-3 p-3"><Button variant="outline" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Nhóm trước</Button><span>{page + 1} / {Math.ceil(channels.length / count)}</span><Button variant="outline" disabled={(page + 1) * count >= channels.length} onClick={() => setPage((value) => value + 1)}>Nhóm sau</Button></div>}
    </> : <p className="p-4 text-sm">Bấm xem để kết nối. Video không được lưu thêm tại CRM. Khả năng phát phụ thuộc định dạng camera và trình duyệt; đường truyền hạn chế có thể cần thử mạng khác.</p>}
  </section>;
}
