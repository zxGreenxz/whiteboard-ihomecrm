// =============================================================================
// Trình xem lại cho khách (trang /xem-camera): một kênh, trong khung giờ được chia sẻ, bằng phiên `cs_…` thay đăng nhập
// CRM. Không xem trực tiếp, không tải video. Dựng riêng thay vì tham số hoá CameraPlaybackPanel (gắn form chọn khoảng,
// hồ sơ chất lượng theo tài khoản và đầu ghi đầy đủ) nhưng dùng chung bộ ước lượng vị trí và hàng đợi tua của nó.
// =============================================================================
import { useEffect, useRef, useState } from "react";
import { Expand, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CameraAudioButton from "@/components/network-center/tabs/CameraAudioButton";
import { cameraInputTime, cameraTimeLabel, vietnamCameraInput } from "@/lib/network-center/cameraArchive";
import { CameraLiveConnection, CameraLiveError, cameraLiveCapabilities, type CameraLiveCapabilities, type CameraLiveState } from "@/lib/network-center/cameraLive";
import { cameraFrame, PLAYBACK_POSTER_FALLBACK_MS, PlaybackClock, PlaybackControls, playbackOpensAtNormalSpeed, playbackReachedEnd } from "@/lib/network-center/cameraPlayback";
import { cameraSharePlayableSpan, cameraShareRequestTime, cameraShareViewSpan, type CameraShare, type CameraShareSpan } from "@/lib/network-center/cameraShare";
import { cn } from "@/lib/utils";

type ShareQuality = "sd" | "hd";
interface Selection extends CameraShareSpan { base: number; speed: number; quality: ShareQuality; generation: number }

const RECOVERABLE = ["CAMERA_UNAVAILABLE", "PLAYBACK_CONTROL_FAILED", "PLAYBACK_CONTROL_UNAVAILABLE", "SESSION_NOT_FOUND"];
/** Mỗi lượt chia sẻ chỉ một người xem: mở ở máy/tab khác thì cổng đóng phiên ở đây, gia hạn nhận SESSION_NOT_FOUND. */
const DISPLACED = "Lượt chia sẻ đang được mở ở máy hoặc tab khác nên máy này đã dừng. Bấm Thử lại để xem tiếp tại đây.";
const EXPIRY_RECHECK_MARGIN_MS = 3000;
const qualityLabel: Record<ShareQuality, string> = { sd: "SD", hd: "HD" };
const iso = (ms: number) => new Date(ms).toISOString();

export default function SharedCameraPlayer({ share, token, onEnded, onExpired }: {
  share: CameraShare; token: string;
  /** Cổng video báo lượt chia sẻ đã hết hạn / bị thu hồi. */
  onEnded(): void;
  /** Đồng hồ máy đã qua giờ hết hạn — trang hỏi lại máy chủ (đồng hồ máy có thể lệch). */
  onExpired(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onEnded, onExpired });
  useEffect(() => { callbacks.current = { onEnded, onExpired }; }, [onEnded, onExpired]);
  const [capabilities, setCapabilities] = useState<CameraLiveCapabilities>();
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Đầu ghi có thể phát sớm hơn mốc được xin (Hikvision): cổng xin trễ hơn `lead`, nên thanh thời gian bắt đầu ở đầu khung
  // giờ + lead và mốc gửi cổng là mốc trên thanh − lead. Đầu ghi khác: lead = 0, mọi thứ như cũ.
  const lead = (capabilities?.playbackStartLeadSeconds ?? 0) * 1000;
  const span = cameraShareViewSpan(cameraSharePlayableSpan(share, now), lead);
  const playable = span.to - span.from >= 2000;
  const qualities: ShareQuality[] = (capabilities?.playbackQualities ?? []).filter((value): value is ShareQuality => value === "sd" || value === "hd");
  const [quality, setQuality] = useState<ShareQuality>("sd");
  const activeQuality: ShareQuality = qualities.includes(quality) ? quality : qualities[0] ?? "sd";
  const speeds = capabilities?.playbackSpeeds.length ? capabilities.playbackSpeeds : [1];
  const controlAvailable = capabilities?.playbackControl ?? false;

  const [selection, setSelection] = useState<Selection>();
  const [cursor, setCursor] = useState(span.from); const [slider, setSlider] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [state, setState] = useState<CameraLiveState>("stopped"); const [message, setMessage] = useState("");
  const [poster, setPoster] = useState<string>();
  const [hasAudio, setHasAudio] = useState(false); const [audible, setAudible] = useState(false);
  const [jump, setJump] = useState(() => vietnamCameraInput(span.from)); const [jumpError, setJumpError] = useState("");
  const clock = useRef(new PlaybackClock(1)); const position = useRef<CameraShareSpan>();
  const controls = useRef<PlaybackControls>(); const switching = useRef(false); const dragging = useRef(false);
  const released = useRef(Promise.resolve()); const recoveries = useRef(0); const generation = useRef(0);
  /** Mốc đang xem mới nhất cho bộ canh cuối khung giờ (state `cursor` chỉ có ở lần render sau). */
  const cursorRef = useRef(span.from);
  /** Lúc luồng mới mở / lệnh tua gần nhất được đầu ghi nhận — mốc để gỡ ảnh giữ tạm khi trình duyệt không báo từng khung hình. */
  const seekAckAt = useRef(0);
  // `lead` chỉ biết sau khi cổng trả lời, lúc mốc đang xem đã được đặt ở đầu khung giờ: kéo nó về đầu thanh thật.
  useEffect(() => {
    if (!lead || cursorRef.current >= span.from) return;
    cursorRef.current = span.from; setCursor(span.from); setJump(vietnamCameraInput(span.from));
  }, [lead, span.from]);

  // Khung giờ kéo tới tương lai thì phần xem được dài thêm theo thời gian.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // Hỏi lại máy chủ SAU giờ hết hạn vài giây: đồng hồ máy khách nhanh hơn máy chủ thì hỏi đúng giờ vẫn nhận "còn hạn".
    // Trường hợp lệch nhiều hơn được bắt ở onErrorCode: cổng đóng phiên khi hết hạn thật ⇒ SESSION_NOT_FOUND ⇒ hỏi lại.
    const delay = Date.parse(share.expires_at) + EXPIRY_RECHECK_MARGIN_MS - Date.now();
    const timer = setTimeout(() => callbacks.current.onExpired(), Math.max(0, Math.min(delay, 2_000_000_000)));
    return () => clearTimeout(timer);
  }, [share.expires_at]);
  useEffect(() => {
    const abort = new AbortController(); setCapabilities(undefined); setCapabilityError("");
    void cameraLiveCapabilities(share.recorder_id, abort.signal, token).then((result) => { if (!abort.signal.aborted) setCapabilities(result); })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        if (cause instanceof CameraLiveError && cause.code === "SHARE_ENDED") { callbacks.current.onEnded(); return; }
        setCapabilityError(cause instanceof CameraLiveError ? cause.message : "Không kiểm tra được dịch vụ xem lại. Vui lòng thử lại.");
      });
    return () => abort.abort();
  }, [share.recorder_id, token, capabilityAttempt]);

  const holdFrame = () => { const image = cameraFrame(video.current); if (image) setPoster(image); };
  const finish = (current: CameraShareSpan) => {
    holdFrame(); dragging.current = false; setSelection(undefined); setState("stopped"); setNow(Date.now());
    setMessage(current.to < Date.parse(share.window_end) - 1000 ? "Đã xem tới thời điểm gần nhất có bản ghi. Bấm Xem để xem tiếp phần mới." : "Đã xem hết khung giờ được chia sẻ.");
  };
  const advance = (seconds: number, current: CameraShareSpan) => {
    const time = Math.min(current.to, current.from + seconds * 1000);
    cursorRef.current = time; setCursor(time); if (!dragging.current) setSlider((time - span.from) / 1000);
    if (time >= current.to) finish(current);
  };

  useEffect(() => {
    if (!selection) return;
    let active = true; const element = video.current; setHasAudio(false);
    // Luồng SD/HD mới không mở thẳng được ở tốc độ khác 1× (xem playbackOpensAtNormalSpeed): mở ở 1× rồi xin tốc độ
    // mong muốn bằng lệnh tua; trong lúc đó giao diện vẫn ở trạng thái "đang mở".
    const openAtNormalSpeed = playbackOpensAtNormalSpeed({ controlAvailable, speed: selection.speed, quality: selection.quality });
    const openSpeed = openAtNormalSpeed ? 1 : selection.speed;
    // Chất lượng SD/HD luôn chuyển mã ở máy chủ: dấu thời gian RTP chạy theo thời gian thực, nội dung theo tốc độ.
    clock.current = new PlaybackClock(openSpeed, openSpeed); position.current = { from: selection.from, to: selection.to }; switching.current = false;
    seekAckAt.current = Date.now();
    let callback: number | undefined; let lastUpdate = 0; let errorCode: string | undefined; let connectionFailed = false;
    let lastFrameAt = 0; let liveSpeed = openSpeed;
    const frame: VideoFrameRequestCallback = (stamp, metadata) => {
      if (!active || !element || element !== video.current) return;
      lastFrameAt = Date.now();
      const current = position.current;
      if (current && !switching.current) {
        const seconds = clock.current.frame(metadata.rtpTimestamp, metadata.mediaTime);
        setPoster(undefined); setState("playing");
        if (stamp - lastUpdate >= 250 || current.from + seconds * 1000 >= current.to) { advance(seconds, current); lastUpdate = stamp; }
      }
      callback = element.requestVideoFrameCallback(frame);
    };
    if (element?.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(frame);
    // Hình đã ngừng trong lúc mốc ước tính đang sát cuối khung giờ ⇒ đã xem hết (xem playbackReachedEnd).
    const endWatch = setInterval(() => {
      const current = position.current;
      if (!active || switching.current || !current) return;
      if (!playbackReachedEnd({ cursor: cursorRef.current, to: current.to, speed: liveSpeed, lastFrameAt, now: Date.now() })) return;
      cursorRef.current = current.to; setCursor(current.to); if (!dragging.current) setSlider((current.to - span.from) / 1000);
      finish(current);
    }, 500);
    const connection = new CameraLiveConnection({
      recorderId: share.recorder_id, channel: share.channel, accessToken: token,
      playback: {
        start: iso(cameraShareRequestTime(controlAvailable ? selection.base : selection.from, lead)), end: iso(selection.to),
        ...(controlAvailable && selection.from !== selection.base ? { position: iso(cameraShareRequestTime(selection.from, lead)) } : {}),
        ...(openSpeed === 1 ? {} : { speed: openSpeed }), quality: selection.quality,
      },
      onStream(stream) { if (active && element) element.srcObject = stream; },
      onAudio(available) { if (active) setHasAudio(available); },
      onErrorCode(code) {
        if (!active) return;
        errorCode = code;
        if (code === "SHARE_ENDED") callbacks.current.onEnded();
        // Phiên biến mất ở cổng có hai nguyên do: máy khác mở cùng lượt, hoặc lượt vừa hết hạn. Hỏi máy chủ để phân biệt:
        // hết hạn thì trang chuyển sang màn "đã kết thúc", còn hạn thì giữ câu "đang mở ở máy khác" bên dưới.
        else if (code === "SESSION_NOT_FOUND") callbacks.current.onExpired();
      },
      onState(next, detail) {
        if (!active) return;
        if (next === "error") connectionFailed = true;
        if (next !== "playing" || !switching.current) { setState(next); setMessage(next === "error" && errorCode === "SESSION_NOT_FOUND" ? DISPLACED : detail ?? ""); }
      },
    });
    const started = released.current.then(() => { if (active) return connection.start(); });
    const queue = new PlaybackControls((time, nextSpeed) => started.then(() => connection.seek(time, nextSpeed)), (time, nextSpeed) => {
      if (!active) return;
      clock.current = new PlaybackClock(nextSpeed, nextSpeed, element?.currentTime ?? 0); position.current = { from: time, to: selection.to }; switching.current = false;
      liveSpeed = nextSpeed; lastFrameAt = Date.now(); seekAckAt.current = Date.now();
    }, (error, time, nextSpeed) => {
      if (!active) return;
      switching.current = false;
      // Luồng đã báo lỗi mở (mạng, đầu ghi…) thì giữ nguyên câu báo đó, không đè bằng lỗi của lệnh tua đi kèm.
      if (connectionFailed) return;
      if (error instanceof CameraLiveError && error.code === "SHARE_ENDED") { void connection.stop(); callbacks.current.onEnded(); return; }
      if (recoveries.current < 2 && (!(error instanceof CameraLiveError) || RECOVERABLE.includes(error.code))) {
        recoveries.current++; setSelection({ ...selection, from: time, speed: nextSpeed, generation: ++generation.current }); setMessage("Đang nối lại bản ghi tại mốc đã chọn…");
      } else { void connection.stop(); setState("error"); setMessage(error instanceof Error ? error.message : "Không chuyển được mốc xem."); }
    });
    controls.current = queue;
    if (openAtNormalSpeed) { switching.current = true; queue.request(selection.from, selection.speed); }
    return () => {
      active = false; clearInterval(endWatch); queue.cancel(); if (controls.current === queue) controls.current = undefined;
      if (element && callback !== undefined) element.cancelVideoFrameCallback(callback);
      released.current = Promise.all([released.current, connection.stop()]).then(() => undefined);
      if (element) element.srcObject = null;
    };
    // advance chỉ đọc khung giờ cố định của lượt chia sẻ; mỗi lựa chọn mới luôn dựng lại kết nối.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, share.recorder_id, share.channel, token, controlAvailable, lead]);

  const seek = (value: number, nextSpeed = speed, nextQuality = activeQuality) => {
    if (!playable) return;
    holdFrame(); dragging.current = false; setJumpError("");
    const time = Math.max(span.from, Math.min(span.to - 1000, Math.floor(value / 1000) * 1000));
    cursorRef.current = time; setCursor(time); setSlider((time - span.from) / 1000); setState("connecting"); setMessage("");
    if (controlAvailable && selection && selection.quality === nextQuality && time < selection.to - 1000 && state !== "error" && controls.current) {
      switching.current = true; controls.current.request(time, nextSpeed);
    } else {
      // Thao tác của người xem mở lại hạn mức tự nối lại; chỉ lỗi tự động mới tiêu hạn mức đó.
      recoveries.current = 0;
      setSelection({ from: time, to: span.to, base: span.from, speed: nextSpeed, quality: nextQuality, generation: ++generation.current });
    }
  };
  const pause = () => { holdFrame(); dragging.current = false; setSelection(undefined); setState("stopped"); setMessage(""); };
  const updateTime = (element: HTMLVideoElement) => {
    if (element !== video.current || !selection || !position.current || switching.current || element.readyState < 2) return;
    // Trình duyệt không báo từng khung hình (iPhone) thì `timeupdate` gỡ ảnh giữ tạm — xem PLAYBACK_POSTER_FALLBACK_MS.
    if (seekAckAt.current && Date.now() - seekAckAt.current >= PLAYBACK_POSTER_FALLBACK_MS) {
      if (poster) setPoster(undefined);
      if (state === "connecting") setState("playing");
    }
    advance(clock.current.seconds(element.currentTime), position.current);
  };
  const fullscreen = () => {
    const element = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!element) return;
    if (element.requestFullscreen) void element.requestFullscreen().catch(() => setMessage("Trình duyệt chưa cho phép toàn màn hình."));
    else element.webkitEnterFullscreen?.();
  };
  const jumpTo = () => {
    const time = cameraInputTime(jump);
    if (!Number.isFinite(time) || time < span.from || time > span.to) { setJumpError(`Chọn thời điểm trong khoảng ${cameraTimeLabel(span.from)} → ${cameraTimeLabel(span.to)}.`); return; }
    seek(time);
  };

  if (capabilityError) {
    return <div role="alert" className="space-y-3 rounded-md border border-destructive/40 bg-background p-4 text-sm">
      <p>{capabilityError}</p>
      <Button type="button" variant="outline" onClick={() => setCapabilityAttempt((value) => value + 1)}>Thử lại</Button>
    </div>;
  }
  if (!capabilities) return <p role="status" className="rounded-md border bg-background p-4 text-sm">Đang kiểm tra dịch vụ xem lại…</p>;
  if (!capabilities.playback || !capabilities.channels.includes(share.channel)) {
    return <p role="alert" className="rounded-md border bg-background p-4 text-sm">Camera được chia sẻ hiện chưa xem lại được. Vui lòng liên hệ bên quản lý.</p>;
  }
  if (!playable) return <p role="status" className="rounded-md border bg-background p-4 text-sm">Khung giờ được chia sẻ chưa có bản ghi để xem. Vui lòng quay lại sau ít phút.</p>;

  const playing = Boolean(selection) && state !== "error";
  return <div className="space-y-3">
    <div className="relative -mx-4 bg-black sm:mx-0 sm:rounded-md">
      <video key={selection?.generation ?? "paused"} ref={video} autoPlay muted={!audible || speed !== 1} playsInline
        className="aspect-video max-h-[70vh] w-full object-contain" aria-label="Video xem lại camera được chia sẻ"
        onPlaying={(event) => { if (event.currentTarget === video.current && selection && !switching.current) { setState("playing"); setPoster(undefined); } }}
        onTimeUpdate={(event) => updateTime(event.currentTarget)} />
      <div className="absolute bottom-2 right-2 z-20"><CameraAudioButton video={video} available={hasAudio} enabled={audible} disabled={speed !== 1 || !selection} onToggle={() => setAudible(!audible)} /></div>
      {poster && <img src={poster} alt="Khung hình trước khi chuyển mốc" className="absolute inset-0 h-full w-full object-contain" />}
      {!selection && !poster && state !== "error" && <button type="button" onClick={() => seek(cursor)} className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/20"><Play className="h-8 w-8" aria-hidden="true" /></span>
        <span className="text-sm">Bấm để xem từ {cameraTimeLabel(cursor)}</span>
      </button>}
      {state === "connecting" && <p role="status" className={cn("absolute flex items-center justify-center text-white", poster ? "inset-x-0 bottom-0 bg-black/70 p-2 text-sm" : "inset-0 bg-black")}>{poster ? "Đang chuyển mốc…" : "Đang mở bản ghi…"}</p>}
      {!selection && poster && state !== "connecting" && <p className="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-sm text-white">Đã tạm dừng</p>}
    </div>
    {message && <p role={state === "error" ? "alert" : "status"} className={cn("text-sm", state === "error" && "text-destructive")}>{message}</p>}
    <label className="block space-y-1 text-sm">
      <span className="flex flex-wrap justify-between gap-2"><span>Thanh thời gian</span><span className="font-medium tabular-nums">{cameraTimeLabel(span.from + slider * 1000)}</span></span>
      <input aria-label="Thanh thời gian xem lại" className="h-11 w-full touch-none" type="range" min="0" max={Math.max(0, (span.to - span.from) / 1000 - 1)} step="1" value={slider}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); dragging.current = true; }}
        onChange={(event) => { dragging.current = true; setSlider(Number(event.target.value)); }}
        onPointerUp={(event) => seek(span.from + Number(event.currentTarget.value) * 1000)}
        onPointerCancel={() => { dragging.current = false; setSlider((cursor - span.from) / 1000); }}
        onBlur={() => { dragging.current = false; }}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seek(span.from + Number(event.currentTarget.value) * 1000); }} />
      <span className="flex justify-between text-xs text-muted-foreground"><span>{cameraTimeLabel(span.from)}</span><span>{cameraTimeLabel(span.to)}</span></span>
    </label>
    <div className="grid grid-cols-3 gap-2">
      <Button type="button" variant="outline" className="min-h-11" onClick={() => seek(cursor - 10_000)}><RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />Lùi 10 giây</Button>
      {playing
        ? <Button type="button" className="min-h-11" onClick={pause}><Pause className="mr-1 h-4 w-4" aria-hidden="true" />Tạm dừng</Button>
        : <Button type="button" className="min-h-11" onClick={() => seek(cursor)}><Play className="mr-1 h-4 w-4" aria-hidden="true" />{state === "error" ? "Thử lại" : "Xem"}</Button>}
      <Button type="button" variant="outline" className="min-h-11" onClick={() => seek(cursor + 10_000)}><RotateCw className="mr-1 h-4 w-4" aria-hidden="true" />Tới 10 giây</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {speeds.length > 1 && <div role="radiogroup" aria-label="Tốc độ xem lại" className="flex flex-wrap gap-1.5">
        {speeds.map((value) => <button key={value} type="button" role="radio" aria-checked={speed === value} onClick={() => { setSpeed(value); if (selection) seek(cursor, value); }}
          className={cn("h-11 min-w-11 rounded-full border px-3 text-sm", speed === value ? "border-primary bg-primary text-primary-foreground" : "bg-background")}>{value}×</button>)}
      </div>}
      {qualities.length > 1 && <div role="radiogroup" aria-label="Chất lượng xem lại" className="flex gap-1.5">
        {qualities.map((value) => <button key={value} type="button" role="radio" aria-checked={activeQuality === value} onClick={() => { setQuality(value); if (selection && value !== activeQuality) seek(cursor, speed, value); }}
          className={cn("h-11 min-w-11 rounded-full border px-3 text-sm", activeQuality === value ? "border-primary bg-primary text-primary-foreground" : "bg-background")}>{qualityLabel[value]}</button>)}
      </div>}
      <Button type="button" variant="outline" className="ml-auto min-h-11" onClick={fullscreen}><Expand className="mr-1 h-4 w-4" aria-hidden="true" />Toàn màn hình</Button>
    </div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); jumpTo(); }}>
      <label className="min-w-0 flex-1 space-y-1 text-sm"><span>Đi tới thời điểm</span>
        <Input type="datetime-local" step="1" value={jump} min={vietnamCameraInput(span.from)} max={vietnamCameraInput(span.to)} onChange={(event) => setJump(event.target.value)} className="h-11" />
      </label>
      <Button type="submit" variant="outline" className="min-h-11">Đi tới</Button>
    </form>
    {jumpError && <p role="alert" className="text-sm text-destructive">{jumpError}</p>}
    <p className="text-xs text-muted-foreground">Giờ Việt Nam (UTC+7). Vị trí trên thanh là ước tính — đối chiếu ngày giờ in trên hình. Mỗi lúc chỉ một máy xem được; mở ở máy khác thì máy này dừng.{lead > 0 && ` Đầu ghi này cho xem từ ${cameraTimeLabel(span.from)}, sau đầu khung giờ ${lead / 1000} giây.`}</p>
  </div>;
}
