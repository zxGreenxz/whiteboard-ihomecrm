import { useEffect, useId, useState } from "react";
import { useCameraQuality } from "@/hooks/network-center/useCameraQuality";
import { useCameraExport } from "@/hooks/network-center/useCameraExport";
import { Download, Loader2, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import { cameraTimeLabel, cameraResolutionLabel, validateCameraWindow, vietnamCameraInput, type CameraArchiveResolution } from "@/lib/network-center/cameraArchive";
import { cameraChannelName, cameraFieldClass } from "./CameraPlaybackPanel";

export default function CameraExportPanel({ recorder, buildingName, channels, available }: { recorder: CameraRecorder; buildingName: string; channels: number[]; available: boolean }) {
  const uid = useId();
  const [channel, setChannel] = useState(channels[0] ?? 1);
  const [from, setFrom] = useState(() => vietnamCameraInput(Date.now() - 300_000));
  const [to, setTo] = useState(() => vietnamCameraInput(Date.now() - 1000));
  const [preferredResolution, setResolution, qualityNotice] = useCameraQuality("export");
  const [restoredResolution, setRestoredResolution] = useState<CameraArchiveResolution>();
  const resolution = restoredResolution ?? preferredResolution;
  const task = useCameraExport(recorder.id, available && recorder.enabled);
  const { result: exported, busy, error, discard, setError } = task;
  useEffect(() => {
    if (!task.restored) return;
    setChannel(task.restored.channel); setFrom(vietnamCameraInput(Date.parse(task.restored.start))); setTo(vietnamCameraInput(Date.parse(task.restored.end))); setRestoredResolution(task.restored.resolution);
  }, [task.restored]);
  const progress = task.downloaded ?? task.job?.progress ?? 0;
  const phase = task.cancelling ? "Đang hủy trích xuất…" : task.downloaded !== undefined ? `Đang tải file về trình duyệt · ${task.downloaded}%` : task.job?.phase === "source" ? `Đang lấy bản ghi từ đầu ghi · ${((task.job.sourceBytes ?? 0) / 1024 / 1024).toFixed(1)} MB${task.job.sourceTotalBytes ? ` / ${(task.job.sourceTotalBytes / 1024 / 1024).toFixed(1)} MB` : ""}` : task.job?.phase === "verifying" ? "Đang kiểm tra file MP4…" : task.job ? `Đang tạo đoạn MP4 · ${progress}%` : "Đang kiểm tra tác vụ trích xuất…";
  const prepare = async () => {
    let range;
    try { range = validateCameraWindow(from, to, 30); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Đoạn cắt chưa hợp lệ."); return; }
    await task.prepare({ recorderId: recorder.id, channel, start: new Date(range.from).toISOString(), end: new Date(range.to).toISOString(), purpose: "export", resolution });
  };
  const receipt = () => {
    if (!exported) return; const { job } = exported;
    const blob = new Blob([JSON.stringify({ version: 1, building: buildingName, recorder: recorder.display_name, camera: cameraChannelName(recorder, job.channel), ...job, timezone: "Asia/Ho_Chi_Minh", source: "Bản ghi tại đầu ghi; MP4 chuyển mã H.264/AAC", sourceClockVerified: false, note: "Mốc thời gian do người dùng chọn theo giờ đầu ghi. Đối chiếu đồng hồ trên hình trước khi bàn giao. SHA-256 dùng kiểm tra file không thay đổi sau trích xuất." }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = job.filename.replace(/\.mp4$/u, ".json"); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="nc-panel" aria-label={`Trích xuất ${recorder.display_name}`}>
    <div className="nc-panel-heading"><h3 className="flex items-center gap-2"><Scissors className="h-5 w-5" />Trích xuất video · {recorder.display_name}</h3></div>
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">Cắt đoạn để tải về máy, mỗi file tối đa 30 phút. SD 480p xử lý nhanh hơn. Lựa chọn chất lượng được ghi nhớ cho lần sau. Có thể trích xuất mà không cần mở xem lại.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm" htmlFor={`${uid}-channel`}><span>Camera trích xuất</span><select id={`${uid}-channel`} className={cameraFieldClass} value={channel} disabled={busy || !available} onChange={(event) => { discard(); setChannel(Number(event.target.value)); }}>{channels.map((value) => <option key={value} value={value}>{cameraChannelName(recorder, value)}</option>)}</select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-resolution`}><span>Độ phân giải video xuất</span><select id={`${uid}-resolution`} className={cameraFieldClass} value={resolution} disabled={busy} onChange={(event) => { const value = event.target.value; if (value === "480p" || value === "720p" || value === "1080p" || value === "original") { discard(); setRestoredResolution(undefined); setResolution(value); } }}><option value="480p">SD 480p</option><option value="720p">HD 720p</option><option value="1080p">Full HD 1080p</option><option value="original">Độ phân giải gốc · File lớn hơn</option></select></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-from`}><span>Bắt đầu đoạn cắt</span><input id={`${uid}-from`} className={cameraFieldClass} type="datetime-local" step="1" value={from} disabled={busy} onChange={(event) => { discard(); setFrom(event.target.value); }} /></label>
        <label className="space-y-1 text-sm" htmlFor={`${uid}-to`}><span>Kết thúc đoạn cắt</span><input id={`${uid}-to`} className={cameraFieldClass} type="datetime-local" step="1" value={to} disabled={busy} onChange={(event) => { discard(); setTo(event.target.value); }} /></label>
      </div>
      <Button disabled={!available || !recorder.enabled || busy} onClick={() => void prepare()}><Scissors className="mr-2 h-4 w-4" />Tạo đoạn MP4</Button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      {qualityNotice && <p role="status" className="text-sm">{qualityNotice}</p>}
      {task.notice && <p role="status" className="text-sm">{task.notice}</p>}
      {(busy || task.cancelling) && <div className="space-y-2 rounded-md bg-muted p-3" role="status"><div className="flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2"><Loader2 className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />{phase}</p><Button variant="outline" disabled={task.cancelling && busy} onClick={() => void task.cancel()}>{task.cancelling ? "Thử hủy lại" : "Hủy trích xuất"}</Button></div><progress aria-label="Tiến độ trích xuất video" className="h-2 w-full" max="100" value={task.job?.phase === "source" && task.downloaded === undefined ? undefined : progress} /><p className="text-xs">Có thể tải lại trang hoặc quay lại sau; tác vụ sẽ tiếp tục. File hoàn tất được giữ tạm 15 phút để tải về.</p></div>}
      {exported && <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3" role="status"><p className="text-sm">Đã tạo: {cameraChannelName(recorder, exported.job.channel)} · {cameraTimeLabel(exported.job.start)} – {cameraTimeLabel(exported.job.end)} · {cameraResolutionLabel(exported.job.resolution)} · {(exported.job.bytes / 1024 / 1024).toFixed(1)} MB</p><div className="flex flex-wrap gap-2"><Button asChild><a href={exported.url} download={exported.job.filename}><Download className="mr-2 h-4 w-4" />Tải video MP4</a></Button><Button variant="outline" onClick={receipt}>Tải thông tin bàn giao</Button></div><p className="break-all text-xs">SHA-256: {exported.job.sha256}</p></div>}
    </div>
  </section>;
}
