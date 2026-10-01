// DỰ PHÒNG cho giọng nói của trang "Báo chi nhanh": nhận giọng của chính trình duyệt (Web Speech API,
// vi-VN). Chỉ dùng khi đường chính (ghi âm → máy chủ) không dùng được. Không có ở Firefox, và
// KHÔNG chạy trong app thêm ra màn hình chính iPhone — khi đó gợi ý mic trên bàn phím điện thoại.

import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResult {
  transcript: string;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<RecognitionResult> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// "network" cũng là lỗi trình duyệt nhân Chromium KHÔNG có dịch vụ nhận giọng của Google trả về (dịch vụ đó
// Google chỉ cấp cho Chrome) — nên câu báo nói cả hai khả năng, không chỉ bảo kiểm tra mạng.
const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "Bạn chưa cho phép dùng micro cho trang này.",
  "service-not-allowed": "Trình duyệt không cho nhận giọng ở đây. Hãy dùng micro trên bàn phím.",
  "no-speech": "Chưa nghe thấy gì. Nói gần micro hơn rồi thử lại.",
  network: "Chưa nhận được giọng qua trình duyệt: mất mạng, hoặc trình duyệt này không có dịch vụ nhận giọng. Thử Chrome, hoặc dùng micro trên bàn phím.",
};

export function useSpeechInput(onText: (text: string) => void) {
  const Ctor = recognitionCtor();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Mã lỗi gốc của trình duyệt ("service-not-allowed", "network"…) để nơi gọi chọn đường dự phòng. */
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const rec = useRef<RecognitionLike | null>(null);
  const finalText = useRef("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const start = useCallback(() => {
    if (!Ctor || rec.current) return;
    setError(null);
    setErrorCode(null);
    finalText.current = "";
    const r = new Ctor();
    r.lang = "vi-VN";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i += 1) {
        const result = e.results[i];
        if (result.isFinal && result[0]) parts.push(result[0].transcript);
      }
      finalText.current = parts.join(" ").trim();
    };
    r.onerror = (e) => {
      setErrorCode(e.error);
      setError(ERROR_TEXT[e.error] ?? "Không nhận được giọng nói. Hãy dùng micro trên bàn phím.");
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      if (finalText.current) onTextRef.current(finalText.current);
    };
    rec.current = r;
    setListening(true);
    r.start();
  }, [Ctor]);

  const stop = useCallback(() => rec.current?.stop(), []);

  useEffect(() => () => rec.current?.stop(), []);

  return { supported: !!Ctor, listening, error, errorCode, start, stop };
}
