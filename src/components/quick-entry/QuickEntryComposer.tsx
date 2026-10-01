// Ô nhập của trang "Báo chi nhanh": gõ chữ, nói, chụp/chọn/dán ảnh bill.
// Giọng nói: ghi âm trong trang ⇒ máy chủ chuyển chữ (đường chính); lỗi thì mời dùng nhận giọng của
// trình duyệt; không có cả hai thì gợi ý mic trên bàn phím. Chữ từ giọng nói ĐỔ VÀO Ô để người dùng
// soát/sửa rồi mới gửi — nghe nhầm số tiền hay tên toà thì sửa ngay tại đây.

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Camera, ImagePlus, Loader2, Mic, Send, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_RECORD_SECONDS, useVoiceRecorder, type RecordedAudio } from "@/hooks/quick-entry/useVoiceRecorder";
import { useSpeechInput } from "@/hooks/quick-entry/useSpeechInput";
import type { TranscribeResult } from "@/hooks/quick-entry/quickEntryAi";
import type { DraftMode } from "@/lib/quickEntry/draft";

const KEYBOARD_MIC_HINT = "Dùng nút micro trên bàn phím điện thoại để nói.";
const MODE_LABEL: Record<DraftMode, string> = { company: "Công ty", personal: "Cá nhân" };
const PLACEHOLDER: Record<DraftMode, string> = {
  company: "Vd: 102LVT sơn 300k, keo 20k",
  personal: "Vd: bún bò 50k, xăng 100k",
};

export interface QuickEntryComposerProps {
  mode: DraftMode;
  /** Chế độ người dùng có quyền — một chế độ thì không hiện công tắc. */
  modes: readonly DraftMode[];
  onModeChange: (mode: DraftMode) => void;
  onSubmitText: (text: string) => void;
  onPhoto: (file: File) => void;
  /** null ⇒ đường máy chủ không dùng được (AI tắt cho phiên này) — mic đi thẳng đường dự phòng. */
  transcribe: ((audio: RecordedAudio) => Promise<TranscribeResult>) | null;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function QuickEntryComposer(p: QuickEntryComposerProps) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [offerBrowser, setOfferBrowser] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  const appendText = (t: string) => {
    setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t));
    box.current?.focus();
  };

  const speech = useSpeechInput(appendText);
  const recorder = useVoiceRecorder((audio) => {
    const transcribe = p.transcribe;
    if (!transcribe) return;
    setTranscribing(true);
    setNote(null);
    transcribe(audio)
      .then((r) => {
        // Thu hẹp bằng `in`: tsconfig.app.json không bật strictNullChecks nên `r.ok` không thu hẹp được.
        if ("text" in r) {
          appendText(r.text);
          return;
        }
        setNote(r.error.message);
        setOfferBrowser(speech.supported);
      })
      .catch(() => {
        setNote("Chưa chuyển được giọng nói thành chữ. Thử lại hoặc gõ tay.");
        setOfferBrowser(speech.supported);
      })
      .finally(() => setTranscribing(false));
  });

  const serverVoice = p.transcribe !== null && recorder.supported;
  const recording = recorder.state === "recording" || recorder.state === "requesting";
  const voiceError = recorder.error ?? speech.error;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    p.onSubmitText(t);
    setText("");
    setNote(null);
    setOfferBrowser(false);
  };

  const onMic = () => {
    setNote(null);
    setOfferBrowser(false);
    if (serverVoice) recorder.start();
    else if (speech.supported) speech.start();
    else setNote(KEYBOARD_MIC_HINT);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Bộ gõ tiếng Việt trên Mac/điện thoại dùng composition: Enter lúc đang ghép dấu không phải "gửi".
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!image) return;
    e.preventDefault();
    p.onPhoto(image);
  };

  const pickFile = (input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (input) input.value = "";
    if (file) p.onPhoto(file);
  };

  return (
    <div className="space-y-2 border-t bg-background p-2" data-testid="quick-entry-composer">
      {p.modes.length > 1 && (
        <div className="flex gap-1" role="group" aria-label="Ghi vào">
          {p.modes.map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={p.mode === m ? "default" : "outline"}
              aria-pressed={p.mode === m}
              className="h-7 px-3 text-xs"
              onClick={() => p.onModeChange(m)}
            >
              {MODE_LABEL[m]}
            </Button>
          ))}
        </div>
      )}

      {(note || voiceError) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-800" role="status">
          <span>{note ?? voiceError}</span>
          {offerBrowser && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setNote(null);
                setOfferBrowser(false);
                speech.start();
              }}
            >
              Dùng nhận giọng của trình duyệt
            </Button>
          )}
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" aria-live="polite">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
          <span className="flex-1 tabular-nums">
            Đang nghe… {clock(recorder.seconds)} / {clock(MAX_RECORD_SECONDS)}
          </span>
          <Button type="button" size="icon" variant="ghost" aria-label="Huỷ ghi âm" onClick={recorder.cancel}>
            <X className="h-4 w-4" />
          </Button>
          <Button type="button" size="sm" onClick={recorder.stop}>
            <Square className="mr-1 h-3 w-3" /> Xong
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-1">
          <Button type="button" size="icon" variant="ghost" aria-label="Chụp bill" onClick={() => camera.current?.click()}>
            <Camera className="h-5 w-5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" aria-label="Chọn ảnh" onClick={() => gallery.current?.click()}>
            <ImagePlus className="h-5 w-5" />
          </Button>
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            aria-label="Chụp ảnh bill"
            onChange={(e) => pickFile(e.currentTarget)}
          />
          <input
            ref={gallery}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Chọn ảnh bill"
            onChange={(e) => pickFile(e.currentTarget)}
          />
          <Textarea
            ref={box}
            value={text}
            rows={Math.min(5, Math.max(1, text.split("\n").length))}
            placeholder={transcribing ? "Đang chuyển giọng nói thành chữ…" : PLACEHOLDER[p.mode]}
            aria-label="Nội dung khoản chi"
            className="min-h-[40px] flex-1 resize-none"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {text.trim() ? (
            <Button type="button" size="icon" aria-label="Gửi" onClick={send}>
              <Send className="h-5 w-5" />
            </Button>
          ) : speech.listening ? (
            <Button type="button" size="icon" variant="destructive" aria-label="Dừng nghe" onClick={speech.stop}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label="Nói"
              disabled={transcribing}
              className={cn(transcribing && "opacity-70")}
              onClick={onMic}
            >
              {transcribing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
