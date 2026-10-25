import { useEffect, useState } from "react";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import { cameraLiveCapabilities } from "@/lib/network-center/cameraLive";
import CameraPlaybackPanel from "./CameraPlaybackPanel";
import CameraExportPanel from "./CameraExportPanel";

export default function CameraArchivePanel({ recorder, buildingName }: { recorder: CameraRecorder; buildingName: string }) {
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<typeof cameraLiveCapabilities>>>();
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController(); setCapabilities(undefined); setError("");
    void cameraLiveCapabilities(recorder.id, abort.signal).then((result) => { if (!abort.signal.aborted) setCapabilities(result); })
      .catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không thể kiểm tra dịch vụ camera."); });
    return () => abort.abort();
  }, [recorder.id]);
  if (error) return <p role="alert" className="p-4 text-red-800">{error}</p>;
  if (!capabilities) return <p role="status" className="p-4">Đang kiểm tra dịch vụ xem lại…</p>;
  return <>
    {!capabilities.playback && <p role="alert">Đầu ghi chưa được bật dịch vụ phát lại trực tiếp.</p>}
    <CameraPlaybackPanel key={`playback-${recorder.id}`} recorder={recorder} channels={capabilities.channels} available={capabilities.playback} speeds={capabilities.playbackSpeeds} qualities={capabilities.playbackQualities} />
    {!capabilities.archive && <p role="alert">Đầu ghi chưa được bật dịch vụ trích xuất video.</p>}
    <CameraExportPanel key={`export-${recorder.id}`} recorder={recorder} buildingName={buildingName} channels={capabilities.channels} available={capabilities.archive} />
  </>;
}
