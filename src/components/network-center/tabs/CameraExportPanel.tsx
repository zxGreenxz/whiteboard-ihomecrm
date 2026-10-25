import { useEffect, useId, useRef, useState } from "react";
import { Download, Loader2, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import { cameraTimeLabel, cameraResolutionLabel, prepareCameraArchive, validateCameraWindow, vietnamCameraInput, type CameraArchiveReady, type CameraArchiveResolution } from "@/lib/network-center/cameraArchive";
import { cameraChannelName, cameraFieldClass } from "./CameraPlaybackPanel";

interface Prepared { job: CameraArchiveReady; url: string }
export default function CameraExportPanel({ recorder, buildingName, channels, available }: { recorder: CameraRecorder; buildingName: string; channels: number[]; available: boolean }) {
  const uid = useId(); const abortRef = useRef<AbortController>(); const urls = useRef(new Set<string>());
  const [channel, setChannel] = useState(channels[0] ?? 1);
  const [from, setFrom] = useState(() => vietnamCameraInput(Date.now() - 300_000));
  const [to, setTo] = useState(() => vietnamCameraInput(Date.now() - 1000));
  const [resolution, setResolution] = useState<CameraArchiveResolution>("480p");
  const [exported, setExported] = useState<Prepared>(); const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); const [error, setError] = useState("");
  useEffect(() => { const current = urls.current; return () => { abortRef.current?.abort(); current.forEach(URL.revokeObjectURL); current.clear(); }; }, []);
  const discard = () => { if (exported) { URL.revokeObjectURL(exported.url); urls.current.delete(exported.url); } setExported(undefined); setError(""); };
  const prepare = async () => {
    let range;
    try { range = validateCameraWindow(from, to, 30); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Đoạn cắt chưa hợp lệ."); return; }
    abortRef.current?.abort(); const abort = new AbortController(); abortRef.current = abort;
    discard(); setBusy(true); setProgress(0);
    try {
      const result = await prepareCameraArchive({ recorderId: recorder.id, channel, start: new Date(range.from).toISOString(), end: new Date(range.to).toISOString(), purpose: "export", resolution }, abort.signal, (job) => { if (!abort.signal.aborted) setProgress(job.progress); });
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(result.blob); urls.current.add(url); setExported({ job: result.job, url });
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không trích xuất được video. Vui lòng thử lại."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const receipt = () => {
    if (!exported) return; const { job } = exported;
    const blob = new Blob([JSON.stringify({ version: 1, building: buildingName, recorder: recorder.display_name, camera: cameraChannelName(recorder, job.channel), ...job, timezone: "Asia/Ho_Chi_Minh", source: "Bản ghi tại đầu ghi; MP4 chuyển mã H.264/AAC", sourceClockVerified: false, note: "Mốc thời gian do người dùng chọn theo giờ đầu ghi. Đối chiếu đồng hồ trên hình trước khi bàn giao. SHA-256 dùng kiểm tra file không thay đổi sau trích xuất." }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = job.filename.replace(/\.mp4$/u, ".json"); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="nc-panel" aria-label={`Trích xuất ${recorder.display_name}`}>
    <div className="nc-panel-heading"><h3 className="flex items-center gap-2"><Scissors className="h-5 w-5" />Trích xuất video · {recorder.display_name}</h3></div>
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">Cắt đoạn để tải về máy, mỗi file tối đa 30 phút. Mặc định SD 480p để xử lý nhanh hơn. Có thể trích xuất mà không cần mở xem lại.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm" htmlFor={`${uid}-channel`}><span>Camera trích xuất</span><select id={`${uid}-channel`} className={cameraFieldClass} value={channel} disabled={busy || !available} onChange={(event) => { discard(); setChannel(Number(event.target.value)); }}>{channels.map((value) => <option key={value} value={value}>{cameraChannelName(recorder, value)}</option>)}</select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-resolution`}><span>Độ phân giải video xuất</span><select id={`${uid}-resolution`} className={cameraFieldClass} value={resolution} disabled={busy} onChange={(event) => { const value = event.target.value; if (value === "480p" || value === "720p" || value === "1080p" || value === "original") { discard(); setResolution(value); } }}><option value="480p">SD 480p · Mặc định</option><option value="720p">HD 720p</option><option value="1080p">Full HD 1080p</option><option value="original">Độ phân giải gốc · File lớn hơn</option></select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-from`}><span>Bắt đầu đoạn cắt</span><input id={`${uid}-from`} className={cameraFieldClass} type="datetime-local" step="1" value={from} disabled={busy} onChange={(event) => { discard(); setFrom(event.target.value); }} /></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-to`}><span>Kết thúc đoạn cắt</span><input id={`${uid}-to`} className={cameraFieldClass} type="datetime-local" step="1" value={to} disabled={busy} onChange={(event) => { discard(); setTo(event.target.value); }} /></label>
      </div>
      <Button disabled={!available || !recorder.enabled || busy} onClick={() => void prepare()}><Scissors className="mr-2 h-4 w-4" />Tạo đoạn MP4</Button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      {busy && <div className="space-y-2 rounded-md bg-muted p-3" role="status"><div className="flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Đang tạo đoạn MP4 · {progress}%</p><Button variant="outline" onClick={() => { abortRef.current?.abort(); setBusy(false); }}>Hủy trích xuất</Button></div><progress aria-label="Tiến độ trích xuất video" className="h-2 w-full" max="100" value={progress} /><p className="text-xs">Giữ màn hình này mở trong lúc tạo file. Bạn vẫn có thể xem lại ở phía trên.</p></div>}
      {exported && <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3" role="status"><p className="text-sm">Đã tạo: {cameraChannelName(recorder, exported.job.channel)} · {cameraTimeLabel(exported.job.start)} – {cameraTimeLabel(exported.job.end)} · {cameraResolutionLabel(exported.job.resolution)} · {(exported.job.bytes / 1024 / 1024).toFixed(1)} MB</p><div className="flex flex-wrap gap-2"><Button asChild><a href={exported.url} download={exported.job.filename}><Download className="mr-2 h-4 w-4" />Tải video MP4</a></Button><Button variant="outline" onClick={receipt}>Tải thông tin bàn giao</Button></div><p className="break-all text-xs">SHA-256: {exported.job.sha256}</p></div>}
    </div>
  </section>;
}
