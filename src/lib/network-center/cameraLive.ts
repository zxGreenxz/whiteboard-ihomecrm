import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const cameraVideoEndpoint = "https://crm-hermes.chillhome.io.vn/camera-live/v1";
const endpoint = cameraVideoEndpoint;
const sessionSchema = z.object({ id: z.string().uuid(), answer: z.string().min(1).max(65_536), expiresAt: z.number() });
export type CameraPlaybackQuality = "sd" | "hd" | "fullhd" | "original";
export type CameraLiveQuality = CameraPlaybackQuality;
const capabilitiesSchema = z.object({ channels: z.array(z.number().int().positive()), maxView: z.number().int().positive(), leaseSeconds: z.number().positive(), archive: z.boolean().optional().default(false), playback: z.boolean().optional().default(false), playbackControl: z.boolean().optional().default(false), playbackPreview: z.boolean().optional().default(false), playbackSpeeds: z.array(z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)])).optional().default([1]), playbackQualities: z.array(z.enum(["sd", "hd", "fullhd", "original"])).optional().default([]), liveQualities: z.array(z.enum(["sd", "hd", "fullhd", "original"])).optional().default(["sd"]) });
const messages: Record<string, string> = {
  LOGIN_REQUIRED: "Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.",
  SESSION_EXPIRED: "Phiên xem đã hết hạn. Bấm xem lại để kết nối.",
  AUTH_UNAVAILABLE: "Chưa xác minh được phiên đăng nhập. Vui lòng thử lại.",
  CAMERA_ACCESS_DENIED: "Bạn không còn quyền xem camera này.",
  CAMERA_NOT_CONFIGURED: "Đầu ghi chưa được cấu hình xem trực tiếp.",
  CAMERA_LIMIT: "Đã đạt giới hạn số camera đang xem. Hãy dừng bớt cửa sổ khác.",
  CAMERA_BUSY: "Hệ thống đang bận. Vui lòng thử lại.",
  LIVE_VIEW_CLOSED: "Phiên xem cũ đã đóng. Bấm Làm mới camera để kết nối lại.",
  CAMERA_QUALITY_LIMIT: "Đang có luồng chất lượng cao khác. Hãy chọn SD, độ phân giải gốc hoặc dừng bớt luồng HD/Full HD.",
  CODEC_UNSUPPORTED: "Trình duyệt chưa hỗ trợ định dạng của camera. Hãy thử Chrome hoặc Edge mới trên máy có hỗ trợ H.265.",
  CAMERA_UNAVAILABLE: "Chưa nhận được video từ đầu ghi. Vui lòng thử lại.",
  ARCHIVE_NOT_CONFIGURED: "Đầu ghi chưa được bật dịch vụ xem lại và xuất video. Cần cấu hình dịch vụ camera trên máy chủ.",
  INVALID_ARCHIVE_RANGE: "Khoảng thời gian chưa hợp lệ. Xem mỗi đoạn tối đa 10 phút; xuất mỗi file tối đa 30 phút và không chọn giờ tương lai.",
  ARCHIVE_BUSY: "Đang có tác vụ xử lý video. Hãy chờ hoàn tất hoặc hủy tác vụ đang chạy rồi thử lại.",
  RECORDING_UNAVAILABLE: "Không lấy được bản ghi trong khoảng này. Có thể video đã bị ghi đè, đầu ghi mất kết nối hoặc không hỗ trợ xem lại. Hãy thử khoảng ngắn hơn.",
  ARCHIVE_INCOMPLETE: "Đầu ghi trả về thiếu thời lượng đã chọn. Hãy thu hẹp khoảng thời gian; chưa tạo file để tránh cung cấp đoạn bị thiếu.",
  ARCHIVE_TOO_LARGE: "Đoạn video vượt giới hạn dung lượng. Hãy chia thành các đoạn ngắn hơn.",
  ARCHIVE_EXPIRED: "Đoạn video tạm đã hết hạn. Hãy chọn xem hoặc xuất lại.",
  ARCHIVE_CANCELLED: "Yêu cầu trích xuất đã được hủy. Có thể tạo đoạn video mới.",
  ARCHIVE_REQUEST_CONFLICT: "Yêu cầu đã tồn tại với khoảng thời gian khác. Hãy tạo yêu cầu mới.",
  ARCHIVE_STORAGE_FULL: "Máy chủ chưa đủ dung lượng tạm để trích xuất. Hãy thử lại sau khi các đoạn cũ được dọn.",
  ARCHIVE_ENCODER_FAILED: "Dịch vụ xử lý video chưa hoạt động. Vui lòng báo người quản trị.",
  ARCHIVE_DOWNLOAD_INVALID: "File tải về không khớp bản trích xuất. Vui lòng thử lại.",
  INVALID_PLAYBACK_RANGE: "Chọn khoảng xem lại tối đa 24 giờ, không chọn giờ tương lai.",
  PLAYBACK_BUSY: "Đang có nhiều phiên xem lại. Hãy dừng bớt cửa sổ hoặc thử lại sau.",
  PLAYBACK_QUALITY_UNAVAILABLE: "Dịch vụ chưa hỗ trợ chất lượng đã chọn. Hãy tải lại trang để cập nhật.",
};
export class CameraLiveError extends Error {
  constructor(readonly code: string) { super(messages[code] ?? "Không thể kết nối video. Vui lòng thử lại."); }
}
async function liveRequest(path: string, method: string, body?: string, signal?: AbortSignal, contentType = "application/sdp", viewId?: string) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new CameraLiveError("LOGIN_REQUIRED");
  let response: Response;
  try {
    response = await fetch(endpoint + path, {
      method, headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "Content-Type": contentType } : {}), ...(viewId ? { "X-Camera-View-Id": viewId } : {}) },
      ...(body ? { body } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
      credentials: "omit", redirect: "error", cache: "no-store",
    });
  } catch { throw new CameraLiveError("VIDEO_NETWORK_ERROR"); }
  const result: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ code: z.string() }).safeParse(result);
    throw new CameraLiveError(parsed.success ? parsed.data.code : "CAMERA_UNAVAILABLE");
  }
  return result;
}
const liveViews = new Map<string, { id: string; previous?: string; preparing?: Promise<void>; ready?: boolean }>();
const viewLocks = new Map<string, Promise<boolean>>();
function claimLiveView(id: string): Promise<boolean> {
  let claimed = viewLocks.get(id);
  if (!claimed) {
    claimed = new Promise<boolean>((resolve) => {
      if (!navigator.locks) { resolve(false); return; }
      // The browser releases this lock when the document dies, including a reload/crash.
      // An inherited sessionStorage UUID alone is not proof that its tab has closed.
      void navigator.locks.request(`camera-live-view:${id}`, { ifAvailable: true }, (lock) => {
        resolve(Boolean(lock));
        if (lock) return new Promise<void>(() => {});
      }).catch(() => resolve(false));
    });
    viewLocks.set(id, claimed);
  }
  return claimed;
}
export async function prepareCameraLiveView(recorderId: string) {
  z.string().uuid().parse(recorderId);
  let view = liveViews.get(recorderId);
  if (!view) {
    let previous: string | undefined;
    const key = `camera-live-view:${recorderId}`;
    try {
      // A duplicated/new tab can inherit sessionStorage; it must not close its opener's video.
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (navigation?.type === "reload" || navigation?.type === "back_forward") {
        const stored = z.string().uuid().safeParse(sessionStorage.getItem(key));
        if (stored.success) previous = stored.data;
      }
    } catch { /* Storage can be unavailable; the server still enforces short leases. */ }
    view = { id: crypto.randomUUID(), ...(previous ? { previous } : {}) };
    liveViews.set(recorderId, view);
  }
  const current = view;
  if (!current.ready) {
    current.preparing ??= (async () => {
      // An active tab owns its lock, even if a duplicate tab reloads before opening video.
      if (current.previous && await claimLiveView(current.previous)) await liveRequest(`/recorders/${recorderId}/live-views/${current.previous}`, "DELETE");
      await claimLiveView(current.id);
      delete current.previous;
      try { sessionStorage.setItem(`camera-live-view:${recorderId}`, current.id); } catch { /* Optional recovery storage. */ }
      current.ready = true;
    })().finally(() => { delete current.preparing; });
    await current.preparing;
  }
  return current.id;
}
export async function cameraLiveCapabilities(recorderId: string, signal: AbortSignal) {
  z.string().uuid().parse(recorderId);
  return capabilitiesSchema.parse(await liveRequest(`/recorders/${recorderId}`, "GET", undefined, signal));
}
export type CameraLiveState = "connecting" | "playing" | "stalled" | "stopped" | "error";
export interface CameraLiveOptions {
  recorderId: string; channel: number; liveQuality?: CameraLiveQuality; audio?: boolean; viewId?: string;
  playback?: { start: string; end: string; position?: string; speed?: number; quality?: CameraPlaybackQuality };
  onStream(stream: MediaStream | null): void;
  onAudio?(available: boolean): void;
  onState(state: CameraLiveState, message?: string): void;
}
export class CameraLiveConnection {
  private peer: RTCPeerConnection | undefined;
  private sessionId: string | undefined;
  private readonly abort = new AbortController();
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private renewing = false;
  private checking = false;
  private starting: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  constructor(private readonly options: CameraLiveOptions) {}

  start() { return this.starting ??= this.connect(); }
  private async connect() {
    if (this.stopped) return;
    try {
      z.string().uuid().parse(this.options.recorderId);
      z.number().int().min(1).max(64).parse(this.options.channel);
      this.options.onState("connecting");
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      this.peer = peer; peer.addTransceiver("video", { direction: "recvonly" });
      if (this.options.audio !== false) peer.addTransceiver("audio", { direction: "recvonly" });
      const tracks = new Map<string, MediaStreamTrack>();
      const stream = new MediaStream(); let delivered = false;
      const audioState = () => { if (!this.stopped) this.options.onAudio?.([...tracks.values()].some((track) => track.kind === "audio" && track.readyState === "live" && !track.muted)); };
      peer.ontrack = (event) => {
        if (this.stopped) return;
        if (tracks.has(event.track.id)) return;
        tracks.set(event.track.id, event.track); stream.addTrack(event.track);
        if (event.track.kind === "audio") for (const name of ["unmute", "mute", "ended"]) event.track.addEventListener(name, audioState);
        if (!delivered) { delivered = true; this.options.onStream(stream); }
        audioState();
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" && !this.stopped) this.fail("Không thiết lập được đường truyền video. Hãy thử lại hoặc đổi mạng.");
      };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); this.abort.signal.removeEventListener("abort", done); resolve(); };
        const changed = () => { if (peer.iceGatheringState === "complete") done(); };
        const timer = setTimeout(done, 6000);
        peer.addEventListener("icegatheringstatechange", changed); this.abort.signal.addEventListener("abort", done, { once: true }); changed();
      });
      if (this.stopped) return;
      const offer = peer.localDescription?.sdp;
      if (!offer) throw new CameraLiveError("CAMERA_UNAVAILABLE");
      const playback = this.options.playback;
      // Keep creation's bounded request alive after stop so its id can be deleted before the next preview.
      // Aborting fetch alone leaves an unknown server-side reservation until WHEP finishes.
      let session: z.infer<typeof sessionSchema> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.stopped) return;
        try {
          session = sessionSchema.parse(await liveRequest(`/recorders/${this.options.recorderId}/channels/${this.options.channel}/${playback ? "playback" : `sessions${this.options.liveQuality && this.options.liveQuality !== "sd" ? `?quality=${this.options.liveQuality}` : ""}`}`, "POST", playback ? JSON.stringify({ ...playback, offer }) : offer, undefined, playback ? "application/json" : "application/sdp", playback ? undefined : this.options.viewId));
          break;
        } catch (error) {
          if (!playback || attempt === 2 || !(error instanceof CameraLiveError) || !["CAMERA_UNAVAILABLE", "RECORDING_UNAVAILABLE"].includes(error.code)) throw error;
          if (this.stopped) return;
          this.options.onState("connecting", "Đang kết nối lại bản ghi…");
          await new Promise<void>((resolve) => { const timer = setTimeout(done, 400 * (attempt + 1)); const signal = this.abort.signal; function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
        }
      }
      if (!session) return;
      this.sessionId = session.id;
      if (this.stopped) { void this.releaseSession(); return; }
      await peer.setRemoteDescription({ type: "answer", sdp: session.answer });
      if (this.stopped) return;
      this.renewTimer = setInterval(() => { void this.renew(); }, 25_000);
      let frames = 0; let changedAt = Date.now();
      this.statsTimer = setInterval(() => {
        if (this.checking || this.stopped) return;
        this.checking = true;
        void peer.getStats().then((report) => {
          if (this.stopped) return;
          let decoded = 0;
          report.forEach((row) => { if (row.type === "inbound-rtp" && row.kind === "video" && typeof row.framesDecoded === "number") decoded += row.framesDecoded; });
          if (decoded > frames) { frames = decoded; changedAt = Date.now(); this.options.onState("playing"); }
          else if (Date.now() - changedAt > 10_000) this.options.onState("stalled", frames ? "Đang mất hình ảnh mới." : "Chưa nhận được hình ảnh. Kiểm tra hỗ trợ H.265 của trình duyệt hoặc thử mạng khác.");
          if (Date.now() - changedAt > 30_000) this.fail("Không nhận được hình ảnh mới. Bấm xem lại để kết nối.");
        }).catch(() => { if (!this.stopped) this.fail("Không đọc được trạng thái video."); }).finally(() => { this.checking = false; });
      }, 2000);
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof CameraLiveError ? error.message : "Không thể phát video trên trình duyệt này.");
    }
  }
  async seek(time: number, speed: number) {
    await this.starting;
    if (this.stopped || !this.sessionId) throw new CameraLiveError("SESSION_EXPIRED");
    const iso = new Date(time).toISOString();
    const result = z.object({ time: z.literal(iso), speed: z.literal(speed), expiresAt: z.number() }).parse(await liveRequest(`/sessions/${this.sessionId}/playback`, "POST", JSON.stringify({ time: iso, speed }), this.abort.signal, "application/json"));
    if (this.stopped) throw new CameraLiveError("SESSION_EXPIRED");
    return result;
  }
  private async renew() {
    if (this.renewing || !this.sessionId || this.stopped) return;
    this.renewing = true;
    try { await liveRequest(`/sessions/${this.sessionId}/renew`, "POST", undefined, this.abort.signal); }
    catch (error) { if (!this.stopped) this.fail(error instanceof CameraLiveError ? error.message : "Phiên xem bị ngắt."); }
    finally { this.renewing = false; }
  }
  private fail(message: string) { this.stop(); this.options.onState("error", message); }
  private releaseSession(): Promise<void> {
    const id = this.sessionId; this.sessionId = undefined;
    if (id) this.releasing = liveRequest(`/sessions/${id}`, "DELETE").then(() => {}).catch(() => { /* The server independently expires the lease within 75 seconds. */ });
    return this.releasing ?? Promise.resolve();
  }
  stop() {
    if (this.stopped) return this.starting?.then(() => this.releaseSession()) ?? this.releaseSession();
    this.stopped = true; this.abort.abort();
    clearInterval(this.renewTimer); clearInterval(this.statsTimer);
    this.peer?.close(); this.peer = undefined; this.options.onStream(null); this.options.onAudio?.(false);
    void this.releaseSession();
    return this.starting?.then(() => this.releaseSession()) ?? this.releaseSession();
  }
}
