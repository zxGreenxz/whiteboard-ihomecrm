import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { cancelCameraArchive, findCameraArchive, prepareCameraArchive, type CameraArchiveJob, type CameraArchiveReady, type CameraArchiveRequest } from "@/lib/network-center/cameraArchive";
import { CameraLiveError } from "@/lib/network-center/cameraLive";

const pendingSchema = z.object({
  input: z.object({ recorderId: z.string().uuid(), channel: z.number().int().positive(), start: z.string().datetime(), end: z.string().datetime(), purpose: z.literal("export"), resolution: z.enum(["480p", "720p", "1080p", "original"]), requestId: z.string().uuid().optional() }),
  jobId: z.string().uuid().optional(), cancelling: z.boolean().optional(), createdAt: z.number().finite().positive(),
}).refine((value) => Boolean(value.jobId || value.input.requestId));
interface Pending { input: CameraArchiveRequest; jobId?: string; cancelling?: boolean; createdAt: number }
const requestDeadline = (value: Pending) => value.createdAt + 2 * (Date.parse(value.input.end) - Date.parse(value.input.start)) + 120000;
interface ExportState { owner: string | null; busy: boolean; cancelling: boolean; job?: CameraArchiveJob; result?: { job: CameraArchiveReady; url: string }; restored?: CameraArchiveRequest; downloaded?: number; error: string; notice: string }
const empty = (owner: string | null): ExportState => ({ owner, busy: false, cancelling: false, error: "", notice: "" });
const sameClip = (a: CameraArchiveRequest, b: CameraArchiveRequest) => a.recorderId === b.recorderId && a.channel === b.channel && a.start === b.start && a.end === b.end && a.resolution === b.resolution;

/** A page owns only observation. The server owns the export until explicit cancellation or expiry. */
export function useCameraExport(recorderId: string, available: boolean) {
  const owner = useAuth().data?.id ?? null;
  const identity = `${owner}:${recorderId}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const key = owner ? `ihomecrm.camera-export:${identity}` : null;
  const pending = useRef<Pending>(); const controller = useRef<AbortController>(); const objectUrl = useRef<string>();
  const [state, setState] = useState<ExportState>(() => empty(identity));
  const revoke = useCallback(() => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = undefined; }, []);
  const remember = useCallback((value?: Pending) => {
    pending.current = value;
    if (!key) return;
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
    catch { setState((old) => ({ ...old, notice: "Trình duyệt chưa lưu được mã tác vụ; khi mở lại trang sẽ tìm tác vụ trên máy chủ." })); }
  }, [key]);
  const observe = useCallback(async (saved: Pending, abort: AbortController) => {
    const active = () => !abort.signal.aborted && currentIdentity.current === identity;
    try {
      const result = await prepareCameraArchive(saved.input, abort.signal, (job) => {
        if (!active()) return;
        remember({ ...saved, jobId: job.id }); setState((old) => ({ ...old, job }));
      }, { resumeId: saved.jobId, onDownloadProgress: (bytes, total) => { if (active()) setState((old) => ({ ...old, downloaded: Math.round(bytes / total * 100) })); } });
      if (!active()) return;
      remember({ ...saved, jobId: result.job.id });
      const url = URL.createObjectURL(result.blob); revoke(); objectUrl.current = url;
      setState((old) => ({ ...old, result: { job: result.job, url }, job: result.job }));
    } catch (cause) {
      if (!active()) return;
      if (cause instanceof CameraLiveError && ["ARCHIVE_EXPIRED", "ARCHIVE_NOT_FOUND", "ARCHIVE_CANCELLED"].includes(cause.code)) remember();
      setState((old) => ({ ...old, error: cause instanceof Error ? cause.message : "Không trích xuất được video. Vui lòng thử lại." }));
    } finally { if (active()) setState((old) => ({ ...old, busy: false })); }
  }, [identity, remember, revoke]);
  const cancel = useCallback(async () => {
    const saved = pending.current;
    if (!saved || !owner) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    remember({ ...saved, cancelling: true }); revoke();
    setState((old) => ({ ...old, busy: true, cancelling: true, result: undefined, error: "" }));
    try {
      await cancelCameraArchive(saved.input, abort.signal, saved.jobId);
      if (abort.signal.aborted || currentIdentity.current !== identity) return;
      remember(); setState(empty(identity));
    } catch (cause) {
      if (!abort.signal.aborted && currentIdentity.current === identity) setState((old) => ({ ...old, busy: false, error: `Chưa xác nhận hủy tác vụ. ${cause instanceof Error ? cause.message : "Vui lòng thử hủy lại."}` }));
    }
  }, [identity, owner, remember, revoke]);
  useEffect(() => {
    controller.current?.abort(); revoke(); pending.current = undefined;
    setState({ ...empty(identity), busy: Boolean(owner && available) });
    if (!owner || !available || !key) return;
    const abort = new AbortController(); controller.current = abort;
    void (async () => {
      let saved: Pending | undefined;
      try {
        const parsed = pendingSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));
        if (parsed.success && parsed.data.input.recorderId === recorderId) {
          const value = parsed.data, input = value.input;
          saved = { createdAt: value.createdAt, jobId: value.jobId, cancelling: value.cancelling, input: { recorderId, channel: input.channel, start: input.start, end: input.end, purpose: "export", resolution: input.resolution, requestId: input.requestId } };
        }
      }
      catch { /* Server lookup also recovers jobs when device storage is unavailable. */ }
      try {
        if (!saved) {
          const job = await findCameraArchive(recorderId, abort.signal);
          if (abort.signal.aborted) return;
          if (job && job.purpose === "export") saved = { createdAt: Date.now(), input: { recorderId, channel: job.channel, start: job.start, end: job.end, purpose: "export", resolution: job.resolution, ...(job.requestId ? { requestId: job.requestId } : {}) }, jobId: job.id };
        }
        if (abort.signal.aborted || currentIdentity.current !== identity) return;
        if (!saved) { setState(empty(identity)); return; }
        const restored = saved.input;
        remember(saved); setState((old) => ({ ...old, restored }));
        if (saved.cancelling) { await cancel(); return; }
        if (!saved.jobId) {
          if (Date.now() > requestDeadline(saved)) { remember(); setState((old) => ({ ...old, busy: false, error: "Yêu cầu trích xuất cũ đã hết hạn. Bấm Tạo đoạn MP4 để tạo lại khi cần." })); return; }
          const found = await findCameraArchive(recorderId, abort.signal, saved.input.requestId);
          if (abort.signal.aborted || currentIdentity.current !== identity) return;
          if (!found) { setState((old) => ({ ...old, busy: false, error: "Chưa xác nhận được tác vụ trước khi tải lại trang. Bấm Tạo đoạn MP4 để thử lại cùng yêu cầu." })); return; }
          saved = { ...saved, jobId: found.id }; remember(saved);
        }
        await observe(saved, abort);
      } catch (cause) {
        if (!abort.signal.aborted && currentIdentity.current === identity) {
          if (cause instanceof CameraLiveError && ["ARCHIVE_EXPIRED", "ARCHIVE_CANCELLED"].includes(cause.code)) remember();
          setState((old) => ({ ...old, busy: false, error: cause instanceof Error ? cause.message : "Chưa kiểm tra được tác vụ trích xuất trước đó." }));
        }
      }
    })();
    return () => { controller.current?.abort(); revoke(); };
  }, [available, identity, key, owner, recorderId, cancel, observe, remember, revoke]);
  const prepare = async (input: CameraArchiveRequest) => {
    if (!owner || !available || state.busy || pending.current?.cancelling) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    revoke(); setState((old) => ({ ...old, busy: true, error: "", result: undefined, job: undefined, downloaded: undefined }));
    try {
      let saved = pending.current;
      if (saved && (!sameClip(saved.input, input) || state.job?.state === "failed")) { await cancelCameraArchive(saved.input, abort.signal, saved.jobId); saved = undefined; }
      if (abort.signal.aborted || currentIdentity.current !== identity) return;
      if (saved && !saved.jobId && Date.now() > requestDeadline(saved)) saved = undefined;
      saved ??= { createdAt: Date.now(), input: { ...input, purpose: "export", resolution: input.resolution ?? "480p", requestId: crypto.randomUUID() } };
      remember(saved); // Commit the id before POST so a reload retries the identical request.
      await observe(saved, abort);
    } catch (cause) {
      if (!abort.signal.aborted && currentIdentity.current === identity) setState((old) => ({ ...old, busy: false, error: cause instanceof Error ? cause.message : "Không tạo được tác vụ trích xuất." }));
    }
  };
  const visible = state.owner === identity ? state : empty(identity);
  return { ...visible, busy: visible.busy || !owner, prepare, cancel, discard: () => { revoke(); setState((old) => ({ ...old, result: undefined, error: "" })); }, setError: (error: string) => setState((old) => ({ ...old, error })) };
}
