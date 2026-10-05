// Ghi âm ngay trong trang "Báo chi nhanh" — đường DUY NHẤT của giọng nói (không dùng nhận giọng của
// trình duyệt). Chạm để nói, chạm lần nữa để gửi, tự dừng ở 30 giây. Không giữ âm thanh: bản ghi chỉ
// đi một lần tới hàm máy chủ `quick-entry` /audio/transcriptions (OpenRouter) rồi bỏ.
//
// Bài học ghi âm iPhone (chép có chọn lọc từ trang thử giọng nói đã cất kho
// `archive/voice-task-lab-20260930`): Safari đời cũ chỉ ghi được audio/mp4 (AAC), Safari 18.4+ và
// Chrome/Android ghi webm/opus — chọn theo isTypeSupported; getUserMedia chỉ chạy trên HTTPS;
// luôn tắt track micro khi xong để đèn micro của máy tắt.

import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_RECORD_SECONDS = 30;
/** Gợi ý bitrate: 48 kbps đủ rõ cho nhận giọng, 30 giây ≈ 180 KB — gửi nhanh trên 4G. Trình duyệt được
 *  phép bỏ qua gợi ý (mặc định thường ~128 kbps) nên trần gửi vẫn chừa chỗ cho trường hợp đó. */
export const AUDIO_BITS_PER_SECOND = 48_000;

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export type AudioFormat = "webm" | "mp4" | "ogg";

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  format: AudioFormat;
  seconds: number;
}

export type RecorderState = "idle" | "requesting" | "recording" | "error";

export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  return MIME_PREFERENCE.find((t) => isSupported(t)) ?? null;
}

export function formatOf(mimeType: string): AudioFormat | null {
  if (mimeType.startsWith("audio/webm")) return "webm";
  if (mimeType.startsWith("audio/mp4")) return "mp4";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return null;
}

function friendlyError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Bạn chưa cho phép dùng micro. Bật quyền micro cho trang này trong cài đặt trình duyệt rồi thử lại.";
  }
  if (name === "NotFoundError") return "Không tìm thấy micro trên máy.";
  return "Không ghi âm được. Hãy dùng nút micro trên bàn phím điện thoại.";
}

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  cancelled: boolean;
}

export function useVoiceRecorder(onDone: (audio: RecordedAudio) => void) {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDoneRef = useRef(onDone);
  const requestEpoch = useRef(0);
  const requesting = useRef(false);
  onDoneRef.current = onDone;

  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const stop = useCallback(() => {
    const rec = current.current;
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    requestEpoch.current += 1;
    requesting.current = false;
    if (current.current) current.current.cancelled = true;
    stop();
    setState("idle");
  }, [stop]);

  const start = useCallback(async () => {
    if (current.current || requesting.current) return;
    setError(null);
    if (!supported) {
      setState("error");
      setError("Trình duyệt này không ghi âm được. Hãy dùng nút micro trên bàn phím điện thoại.");
      return;
    }
    if (!window.isSecureContext) {
      setState("error");
      setError("Chỉ ghi âm được khi trang mở bằng https.");
      return;
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      setState("error");
      setError("Máy này không ghi được định dạng âm thanh phù hợp. Hãy dùng micro trên bàn phím.");
      return;
    }
    setState("requesting");
    requesting.current = true;
    const epoch = ++requestEpoch.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      requesting.current = false;
      setState("error");
      setError(friendlyError(e));
      return;
    }
    if (epoch !== requestEpoch.current) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    requesting.current = false;
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const rec: Recording = { recorder, stream, chunks: [], mimeType, startedAt: Date.now(), cancelled: false };
    current.current = rec;
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };
    recorder.onstop = () => {
      clearTimer();
      rec.stream.getTracks().forEach((t) => t.stop());
      current.current = null;
      setState("idle");
      setSeconds(0);
      const format = formatOf(rec.mimeType);
      const blob = new Blob(rec.chunks, { type: rec.mimeType });
      if (!rec.cancelled && format && blob.size > 0) {
        onDoneRef.current({ blob, mimeType: rec.mimeType, format, seconds: Math.round((Date.now() - rec.startedAt) / 1000) });
      }
    };
    recorder.start(1000);
    setState("recording");
    setSeconds(0);
    let elapsed = 0;
    timer.current = setInterval(() => {
      elapsed += 1;
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORD_SECONDS) stop();
    }, 1000);
  }, [stop, supported]);

  // Rời trang khi đang ghi ⇒ huỷ và tắt micro.
  useEffect(
    () => () => {
      requestEpoch.current += 1;
      requesting.current = false;
      clearTimer();
      const rec = current.current;
      if (rec) {
        rec.cancelled = true;
        if (rec.recorder.state !== "inactive") rec.recorder.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  return { supported, state, seconds, error, start, stop, cancel };
}
