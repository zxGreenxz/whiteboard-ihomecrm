import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { CameraLiveError, cameraVideoEndpoint } from "./cameraLive";

const resolutionSchema = z.enum(["720p", "1080p", "original"]);
export type CameraArchiveResolution = z.infer<typeof resolutionSchema>;
export const cameraResolutionLabel = (value: CameraArchiveResolution) => ({ "720p": "HD 720p", "1080p": "Full HD 1080p", original: "Độ phân giải gốc" })[value];
const base = z.object({ id: z.string().uuid(), recorderId: z.string().uuid(), channel: z.number().int().positive(), start: z.string().datetime(), end: z.string().datetime(), purpose: z.enum(["preview", "export"]), resolution: resolutionSchema, progress: z.number().min(0).max(100), expiresAt: z.number() });
const readySchema = base.extend({ state: z.literal("ready"), bytes: z.number().int().positive().max(256 * 1024 * 1024), durationSeconds: z.number().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), filename: z.string().regex(/^[a-zA-Z0-9_.-]+\.mp4$/u) });
const jobSchema = z.discriminatedUnion("state", [base.extend({ state: z.literal("processing") }), base.extend({ state: z.literal("failed"), code: z.string() }), readySchema]);
export type CameraArchiveJob = z.infer<typeof jobSchema>;
export type CameraArchiveReady = z.infer<typeof readySchema>;
export interface CameraArchiveRequest { recorderId: string; channel: number; start: string; end: string; purpose: "preview" | "export"; resolution?: CameraArchiveResolution }
export function vietnamCameraInput(ms: number) { return new Date(ms + 7 * 3600_000).toISOString().slice(0, 19); }
export function cameraInputTime(value: string) {
  const seconds = value.replace(/\.0+$/u, "");
  const normalized = seconds.length === 16 ? `${seconds}:00` : seconds;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(normalized)) return NaN;
  const ms = Date.parse(`${normalized}+07:00`);
  return Number.isFinite(ms) && vietnamCameraInput(ms) === normalized ? ms : NaN;
}
export function validateCameraWindow(start: string, end: string, maxMinutes: number, now = Date.now()) {
  const from = cameraInputTime(start); const to = cameraInputTime(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < Date.UTC(2000, 0, 1)) throw new Error("Vui lòng chọn đầy đủ ngày và giờ hợp lệ.");
  if (to <= from) throw new Error("Giờ kết thúc phải sau giờ bắt đầu.");
  if (to > now) throw new Error("Không thể xem video trong tương lai.");
  if (to - from > maxMinutes * 60_000) throw new Error(`Chọn khoảng tối đa ${maxMinutes >= 60 ? `${maxMinutes / 60} giờ` : `${maxMinutes} phút`}.`);
  return { from, to };
}
export function cameraTimeLabel(value: string | number) {
  return new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}
async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new CameraLiveError("LOGIN_REQUIRED");
  signal.throwIfAborted();
  const response = await fetch(cameraVideoEndpoint + path, {
    method, headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(path.endsWith("/file") ? 120_000 : 25_000)]),
    credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    const parsed = z.object({ code: z.string() }).safeParse(await response.json());
    throw new CameraLiveError(parsed.success ? parsed.data.code : "CAMERA_UNAVAILABLE");
  }
  return response;
}
async function pause(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}
async function download(job: CameraArchiveReady, signal: AbortSignal) {
  const response = await request(`/archive/${job.id}/file`, "GET", signal);
  if (!response.headers.get("content-type")?.startsWith("video/mp4") || !response.body) { await response.body?.cancel(); throw new CameraLiveError("ARCHIVE_DOWNLOAD_INVALID"); }
  const chunks: Uint8Array<ArrayBuffer>[] = []; const reader = response.body.getReader(); let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > job.bytes) throw new CameraLiveError("ARCHIVE_DOWNLOAD_INVALID");
      chunks.push(new Uint8Array(part.value));
    }
  } finally { await reader.cancel(); }
  const blob = new Blob(chunks, { type: "video/mp4" });
  if (bytes !== job.bytes) throw new CameraLiveError("ARCHIVE_DOWNLOAD_INVALID");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  if ([...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") !== job.sha256) throw new CameraLiveError("ARCHIVE_DOWNLOAD_INVALID");
  return blob;
}
export async function prepareCameraArchive(input: CameraArchiveRequest, signal: AbortSignal, onProgress: (job: CameraArchiveJob) => void) {
  z.string().uuid().parse(input.recorderId); z.number().int().min(1).max(64).parse(input.channel);
  const resolution = resolutionSchema.parse(input.purpose === "preview" ? "720p" : input.resolution ?? "720p");
  let id: string | undefined;
  try {
    let job = jobSchema.parse(await (await request(`/recorders/${input.recorderId}/channels/${input.channel}/archive`, "POST", signal, { start: input.start, end: input.end, purpose: input.purpose, resolution })).json());
    id = job.id;
    for (;;) {
      signal.throwIfAborted();
      if (job.recorderId !== input.recorderId || job.channel !== input.channel || Date.parse(job.start) !== Date.parse(input.start) || Date.parse(job.end) !== Date.parse(input.end) || job.purpose !== input.purpose || job.resolution !== resolution) throw new CameraLiveError("ARCHIVE_DOWNLOAD_INVALID");
      onProgress(job);
      if (job.state === "failed") throw new CameraLiveError(job.code);
      if (job.state === "ready") return { job, blob: await download(job, signal) };
      await pause(signal);
      job = jobSchema.parse(await (await request(`/archive/${id}`, "GET", signal)).json());
    }
  } finally {
    if (id) {
      try { await request(`/archive/${id}`, "DELETE", AbortSignal.timeout(10_000)); }
      catch { /* The gateway independently expires abandoned jobs and removes their files. */ }
    }
  }
}
