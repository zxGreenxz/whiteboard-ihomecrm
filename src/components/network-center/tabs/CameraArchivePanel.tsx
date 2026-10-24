import { useEffect, useId, useRef, useState } from "react";
import { Download, History, Loader2, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import { cameraLiveCapabilities } from "@/lib/network-center/cameraLive";
import { cameraTimeLabel, cameraResolutionLabel, prepareCameraArchive, validateCameraWindow, vietnamCameraInput, type CameraArchiveReady, type CameraArchiveResolution } from "@/lib/network-center/cameraArchive";

interface Prepared { job: CameraArchiveReady; url: string }
const fieldClass = "min-w-0 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function CameraArchivePanel({ recorder, buildingName }: { recorder: CameraRecorder; buildingName: string }) {
  const uid = useId(); const video = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController>(); const urls = useRef(new Set<string>());
  const [channels, setChannels] = useState<number[]>([]); const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(true); const [channel, setChannel] = useState(1);
  const [from, setFrom] = useState(() => vietnamCameraInput(Date.now() - 3600_000));
  const [to, setTo] = useState(() => vietnamCameraInput(Date.now() - 1_000));
  const [window, setWindow] = useState<{ from: number; to: number }>(); const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<Prepared>(); const [exported, setExported] = useState<Prepared>();
  const [clipFrom, setClipFrom] = useState(""); const [clipTo, setClipTo] = useState("");
  const [resolution, setResolution] = useState<CameraArchiveResolution>("720p");
  const [cursor, setCursor] = useState(0); const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState<"preview" | "export">(); const [progress, setProgress] = useState(0); const [error, setError] = useState("");
  const channelName = (value: number) => recorder.snapshot?.channels.find((row) => row.channel === value)?.name || `Kênh ${value}`;
  useEffect(() => {
    const abort = new AbortController();
    void cameraLiveCapabilities(recorder.id, abort.signal).then((capabilities) => {
      if (abort.signal.aborted) return;
      setChannels(capabilities.channels); setChannel(capabilities.channels[0] ?? 1); setAvailable(capabilities.archive);
      if (!capabilities.archive) setError("Đầu ghi chưa được bật dịch vụ xem lại và xuất video. Cần cấu hình dịch vụ camera trên máy chủ.");
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không thể kiểm tra dịch vụ camera."); })
      .finally(() => { if (!abort.signal.aborted) setChecking(false); });
    const currentUrls = urls.current;
    return () => { abort.abort(); abortRef.current?.abort(); currentUrls.forEach((url) => URL.revokeObjectURL(url)); currentUrls.clear(); };
  }, [recorder.id]);
  const discard = (item?: Prepared) => { if (item) { URL.revokeObjectURL(item.url); urls.current.delete(item.url); } };
  const reset = () => { discard(preview); discard(exported); setPreview(undefined); setExported(undefined); setWindow(undefined); setClipFrom(""); setClipTo(""); setError(""); };
  const prepare = async (start: number, end: number, purpose: "preview" | "export") => {
    abortRef.current?.abort(); const abort = new AbortController(); abortRef.current = abort;
    setBusy(purpose); setProgress(0); setError("");
    if (purpose === "preview") { discard(preview); setPreview(undefined); }
    else { discard(exported); setExported(undefined); }
    try {
      const result = await prepareCameraArchive({ recorderId: recorder.id, channel, start: new Date(start).toISOString(), end: new Date(end).toISOString(), purpose, resolution: purpose === "preview" ? "720p" : resolution }, abort.signal, (job) => { if (!abort.signal.aborted) setProgress(job.progress); });
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(result.blob); urls.current.add(url); const item = { job: result.job, url };
      if (purpose === "preview") { setPreview(item); setCursor(start); } else setExported(item);
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không lấy được video. Vui lòng thử lại."); }
    finally { if (!abort.signal.aborted) setBusy(undefined); }
  };
  const openWindow = () => {
    try {
      const selected = validateCameraWindow(from, to, 24 * 60); reset(); setWindow(selected); setPage(0);
      const end = Math.min(selected.to, selected.from + 600_000);
      setClipFrom(vietnamCameraInput(selected.from)); setClipTo(vietnamCameraInput(end));
      void prepare(selected.from, end, "preview");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Khoảng thời gian chưa hợp lệ."); }
  };
  const changePage = (next: number) => {
    if (!window) return; const start = window.from + next * 600_000;
    setPage(next); void prepare(start, Math.min(start + 600_000, window.to), "preview");
  };
  const exportClip = () => {
    try {
      const clip = validateCameraWindow(clipFrom, clipTo, 30);
      if (!window || clip.from < window.from || clip.to > window.to) throw new Error("Đoạn cắt phải nằm trong khoảng thời gian đang xem lại.");
      void prepare(clip.from, clip.to, "export");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Đoạn cắt chưa hợp lệ."); }
  };
  const mark = (end: boolean) => {
    const position = preview && video.current ? Date.parse(preview.job.start) + video.current.currentTime * 1000 : cursor;
    const value = vietnamCameraInput(Math.floor(position / 1000) * 1000);
    discard(exported); setExported(undefined); if (end) setClipTo(value); else setClipFrom(value);
  };
  const receipt = () => {
    if (!exported) return;
    const { job } = exported;
    saveBlob(new Blob([JSON.stringify({ version: 1, building: buildingName, recorder: recorder.display_name, camera: channelName(job.channel), ...job, timezone: "Asia/Ho_Chi_Minh", source: "Bản ghi tại đầu ghi; MP4 chuyển mã H.264/AAC", sourceClockVerified: false, note: "Mốc thời gian do người dùng chọn theo giờ đầu ghi. Đối chiếu đồng hồ trên hình trước khi bàn giao. SHA-256 dùng kiểm tra file không thay đổi sau trích xuất." }, null, 2)], { type: "application/json;charset=utf-8" }), job.filename.replace(/\.mp4$/u, ".json"));
  };
  return <section className="nc-panel" aria-label={`Xem lại ${recorder.display_name}`}>
    <div className="nc-panel-heading"><div><p className="nc-eyebrow">Tìm đồ cho khách · Trích xuất video</p><h3 className="flex items-center gap-2"><History className="h-5 w-5" />Xem lại · {recorder.display_name}</h3></div></div>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">Chọn khoảng cần tìm (tối đa 24 giờ), xem từng đoạn 10 phút và tua nhanh để tìm sự việc. Giờ Việt Nam (UTC+7), theo đồng hồ đầu ghi.</p>
      {checking && <p role="status">Đang kiểm tra dịch vụ xem lại…</p>}
      <form onSubmit={(event) => { event.preventDefault(); openWindow(); }} className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-sm" htmlFor={`${uid}-channel`}><span>Camera cần tìm</span><select id={`${uid}-channel`} className={fieldClass} value={channel} disabled={Boolean(busy) || !available} onChange={(event) => { reset(); setChannel(Number(event.target.value)); }}>{channels.map((value) => <option key={value} value={value}>{channelName(value)}</option>)}</select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-from`}><span>Từ ngày giờ</span><input id={`${uid}-from`} className={fieldClass} type="datetime-local" step="1" required value={from} disabled={Boolean(busy)} onChange={(event) => { reset(); setFrom(event.target.value); }} /></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-to`}><span>Đến ngày giờ</span><input id={`${uid}-to`} className={fieldClass} type="datetime-local" step="1" required value={to} disabled={Boolean(busy)} onChange={(event) => { reset(); setTo(event.target.value); }} /></label>
        <Button type="submit" disabled={!available || !recorder.enabled || Boolean(busy)}><History className="mr-2 h-4 w-4" />Xem khoảng thời gian</Button>
      </form>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {busy && <div className="space-y-2 rounded-md bg-muted p-3" role="status"><div className="flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{busy === "export" ? "Đang tạo đoạn MP4" : "Đang chuẩn bị bản ghi"} · {progress}%</p><Button variant="outline" onClick={() => { abortRef.current?.abort(); setBusy(undefined); }}>Hủy tác vụ</Button></div><progress aria-label="Tiến độ xử lý video" className="h-2 w-full" max="100" value={progress} /><p className="text-xs">Đầu ghi có thể truyền video theo thời gian thực. Giữ màn hình này mở trong lúc xử lý.</p></div>}
      {window && <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">Chuyển đến <select aria-label="Chuyển đến đoạn" value={page} disabled={Boolean(busy)} className="ml-1 max-w-full rounded border p-2" onChange={(event) => changePage(Number(event.target.value))}>{Array.from({ length: Math.ceil((window.to - window.from) / 600_000) }, (_, index) => <option key={index} value={index}>{index + 1} · {cameraTimeLabel(window.from + index * 600_000)}</option>)}</select></label>
        <Button variant="outline" disabled={Boolean(busy) || page === 0} onClick={() => changePage(page - 1)}>Đoạn trước</Button>
        <span className="text-sm">Đoạn {page + 1}/{Math.ceil((window.to - window.from) / 600_000)} · {cameraTimeLabel(window.from + page * 600_000)} – {cameraTimeLabel(Math.min(window.to, window.from + (page + 1) * 600_000))}</span>
        <Button variant="outline" disabled={Boolean(busy) || window.from + (page + 1) * 600_000 >= window.to} onClick={() => changePage(page + 1)}>Đoạn sau</Button>
        {!preview && !busy && <Button variant="outline" onClick={() => changePage(page)}>Thử lại đoạn này</Button>}
      </div>}
      {preview && <div className="space-y-3">
        <video key={preview.url} ref={video} src={preview.url} controls playsInline preload="metadata" controlsList="nodownload" className="aspect-video max-h-[65vh] w-full bg-black" aria-label={`Video xem lại ${channelName(preview.job.channel)}`} onLoadedMetadata={() => { if (video.current) video.current.playbackRate = speed; }} onTimeUpdate={() => { if (video.current) setCursor(Date.parse(preview.job.start) + video.current.currentTime * 1000); }} onError={() => setError("Không phát được file video trên trình duyệt này. Hãy thử lại.")} />
        <div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm">Vị trí xem: {cameraTimeLabel(cursor)}</span>
          <Button variant="outline" onClick={() => { if (video.current) video.current.currentTime = Math.max(0, video.current.currentTime - 10); }}>Lùi 10 giây</Button>
          <Button variant="outline" onClick={() => { if (video.current) video.current.currentTime = Math.min(preview.job.durationSeconds, video.current.currentTime + 10); }}>Tới 10 giây</Button>
          <label className="text-sm">Tốc độ <select aria-label="Tốc độ xem lại" className="ml-1 rounded border p-2" value={speed} onChange={(event) => { const rate = Number(event.target.value); setSpeed(rate); if (video.current) video.current.playbackRate = rate; }}>{[0.5, 1, 2, 4, 8].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
        </div>
      </div>}
      {window && <div className="space-y-3 border-t pt-4">
        <h4 className="flex items-center gap-2 font-bold"><Scissors className="h-4 w-4" />Cắt đoạn để tải xuống</h4>
        <p className="text-sm text-muted-foreground">Mỗi file tối đa 30 phút. Mặc định HD 720p để xử lý và tải nhanh hơn; có thể chọn chất lượng cao hơn khi cần. Đối chiếu giờ trên hình trước khi bàn giao.</p>
        <label className="block max-w-sm space-y-1 text-sm" htmlFor={`${uid}-resolution`}><span>Độ phân giải video xuất</span><select id={`${uid}-resolution`} className={fieldClass} value={resolution} disabled={Boolean(busy)} onChange={(event) => { const value = event.target.value; if (value === "720p" || value === "1080p" || value === "original") { discard(exported); setExported(undefined); setResolution(value); } }}><option value="720p">HD 720p · Mặc định</option><option value="1080p">Full HD 1080p</option><option value="original">Độ phân giải gốc · File lớn hơn</option></select></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm" htmlFor={`${uid}-clip-from`}><span>Bắt đầu đoạn cắt</span><input id={`${uid}-clip-from`} className={fieldClass} type="datetime-local" step="1" value={clipFrom} disabled={Boolean(busy)} onChange={(event) => { discard(exported); setExported(undefined); setClipFrom(event.target.value); }} /></label>
          <label className="space-y-1 text-sm" htmlFor={`${uid}-clip-to`}><span>Kết thúc đoạn cắt</span><input id={`${uid}-clip-to`} className={fieldClass} type="datetime-local" step="1" value={clipTo} disabled={Boolean(busy)} onChange={(event) => { discard(exported); setExported(undefined); setClipTo(event.target.value); }} /></label>
        </div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!preview || Boolean(busy)} onClick={() => mark(false)}>Lấy vị trí xem làm bắt đầu</Button><Button variant="outline" disabled={!preview || Boolean(busy)} onClick={() => mark(true)}>Lấy vị trí xem làm kết thúc</Button><Button disabled={Boolean(busy)} onClick={exportClip}><Scissors className="mr-2 h-4 w-4" />Tạo đoạn MP4</Button></div>
        {exported && <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3" role="status"><p className="text-sm">Đã tạo: {cameraTimeLabel(exported.job.start)} – {cameraTimeLabel(exported.job.end)} · {cameraResolutionLabel(exported.job.resolution)} · {(exported.job.bytes / 1024 / 1024).toFixed(1)} MB</p><div className="flex flex-wrap gap-2"><Button asChild><a href={exported.url} download={exported.job.filename}><Download className="mr-2 h-4 w-4" />Tải video MP4</a></Button><Button variant="outline" onClick={receipt}>Tải thông tin bàn giao</Button></div><p className="break-all text-xs">SHA-256: {exported.job.sha256}</p></div>}
      </div>}
    </div>
  </section>;
}
