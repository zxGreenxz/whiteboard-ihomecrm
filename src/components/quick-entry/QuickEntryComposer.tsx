// Ô nhập của trang "Báo chi nhanh": gõ chữ, nói, chụp/chọn/dán ảnh bill.
// Giọng nói (chủ chốt 01/10: "chuyển hoàn toàn qua OpenRouter"): mic LUÔN ghi âm trong trang rồi gửi
// máy chủ chép lời qua OpenRouter — không dùng nhận giọng của trình duyệt, kể cả khi trình duyệt có.
// Máy không ghi âm được hoặc giọng nói tắt cho phiên ⇒ gợi ý mic trên bàn phím (của hệ điều hành, luôn
// có). Chữ từ giọng nói ĐỔ VÀO Ô để người dùng soát/sửa rồi mới gửi — nghe nhầm số tiền hay tên toà
// thì sửa ngay tại đây.

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Camera, ImagePlus, Loader2, Mic, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_RECORD_SECONDS, useVoiceRecorder, type RecordedAudio } from "@/hooks/quick-entry/useVoiceRecorder";
import type { TranscribeResult } from "@/hooks/quick-entry/quickEntryAi";
import type { DraftMode } from "@/lib/quickEntry/draft";
import {
  READ_EFFORTS,
  READ_MODELS,
  STT_OPTIONS,
  isSupported,
  modelLabel,
  normalizeChoice,
  readModelId,
  type ModelChoice,
} from "@/lib/quickEntry/models";

const SELECT_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-xs";

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
  /** null ⇒ chép giọng tắt cho phiên này — mic chỉ gợi ý dùng mic trên bàn phím. */
  transcribe: ((audio: RecordedAudio) => Promise<TranscribeResult>) | null;
  /** Lựa chọn mô hình AI (chủ muốn tự thử và so sánh); vắng ⇒ không hiện ô chọn. */
  modelChoice?: ModelChoice;
  onModelChoiceChange?: (choice: ModelChoice) => void;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function QuickEntryComposer(p: QuickEntryComposerProps) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [showModels, setShowModels] = useState(false);
  /** Mô hình máy chủ báo ĐÃ chép lần nói gần nhất — hiện để so sánh các mô hình. */
  const [heardBy, setHeardBy] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  const appendText = (t: string) => {
    setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t));
    box.current?.focus();
  };

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
          setHeardBy(r.model);
          return;
        }
        setNote(`${r.error.message} ${KEYBOARD_MIC_HINT}`);
      })
      .catch(() => setNote(`Chưa chuyển được giọng nói thành chữ. ${KEYBOARD_MIC_HINT}`))
      .finally(() => setTranscribing(false));
  });

  const serverVoice = p.transcribe !== null && recorder.supported;
  const recording = recorder.state === "recording" || recorder.state === "requesting";
  const voiceError = recorder.error;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    p.onSubmitText(t);
    setText("");
    setNote(null);
    setHeardBy(null);
  };

  const choice = p.modelChoice;
  const changeChoice = (patch: Partial<ModelChoice>) => {
    // normalizeChoice đưa mức về mặc định khi mô hình mới không nhận mức đang chọn (Astra + Tối thiểu).
    if (choice && p.onModelChoiceChange) p.onModelChoiceChange(normalizeChoice({ ...choice, ...patch }));
  };

  const onMic = () => {
    setNote(null);
    if (serverVoice) recorder.start();
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

      {choice && p.onModelChoiceChange && (
        <div className="space-y-2">
          <button
            type="button"
            className="flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showModels}
            onClick={() => setShowModels((v) => !v)}
          >
            <SlidersHorizontal className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Mô hình AI: {modelLabel(choice.stt)} · {modelLabel(readModelId(choice))}
            </span>
          </button>
          {showModels && (
            <div className="grid gap-2 rounded-lg border bg-muted/30 p-2 text-xs sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-muted-foreground">Giọng nói (chép lời)</span>
                <select
                  aria-label="Mô hình giọng nói"
                  className={SELECT_CLASS}
                  value={choice.stt}
                  onChange={(e) => changeChoice({ stt: e.target.value })}
                >
                  {STT_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} — {o.hint}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Đọc chữ / ảnh để lập phiếu</span>
                <select
                  aria-label="Mô hình đọc chữ"
                  className={SELECT_CLASS}
                  value={choice.readModel}
                  onChange={(e) => changeChoice({ readModel: e.target.value })}
                >
                  {READ_MODELS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} — {o.hint}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Mức suy nghĩ</span>
                <select
                  aria-label="Mức suy nghĩ"
                  className={SELECT_CLASS}
                  value={choice.effort}
                  onChange={(e) => changeChoice({ effort: e.target.value })}
                >
                  {READ_EFFORTS.map((o) => (
                    <option key={o.id || "auto"} value={o.id} disabled={!isSupported(choice.readModel, o.id)}>
                      {o.hint ? `${o.label} — ${o.hint}` : o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      {(note || voiceError) && (
        <p className="text-xs text-amber-800" role="status">
          {note ?? voiceError}
        </p>
      )}
      {heardBy && !note && !voiceError && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Chép bằng {modelLabel(heardBy)}
        </p>
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
