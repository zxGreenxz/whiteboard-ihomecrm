// Ô nhập của trang "Báo chi nhanh": gõ chữ, nói, chụp/chọn/dán ảnh bill.
// Giọng nói (chủ chốt 01/10: "chuyển hoàn toàn qua OpenRouter"): mic LUÔN ghi âm trong trang rồi gửi
// máy chủ chép lời qua OpenRouter — không dùng nhận giọng của trình duyệt, kể cả khi trình duyệt có.
// Máy không ghi âm được hoặc giọng nói tắt cho phiên ⇒ gợi ý mic trên bàn phím (của hệ điều hành, luôn
// có). Dừng ghi âm ⇒ chép lời rồi gửi cùng chữ/ảnh đang soạn; người dùng soát ở thẻ nháp trước khi lưu.

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Camera, ImagePlus, Loader2, Mic, Paperclip, Send, SlidersHorizontal, Square, X, Wallet, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_RECORD_SECONDS, useVoiceRecorder, type RecordedAudio } from "@/hooks/quick-entry/useVoiceRecorder";
import type { TranscribeResult } from "@/hooks/quick-entry/quickEntryAi";
import type { DraftMode } from "@/lib/quickEntry/draft";
import {
  READ_EFFORTS,
  READ_MODELS,
  SERVER_DEFAULT_LABEL,
  STT_OPTIONS,
  isSupported,
  modelLabel,
  normalizeChoice,
  readModelId,
  type ModelChoice,
} from "@/lib/quickEntry/models";

const SELECT_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50";
/** "" = máy chủ chọn theo chuỗi vận hành đặt. */
const shortLabel = (id: string) => modelLabel(id) || "mặc định";

const KEYBOARD_MIC_HINT = "Dùng nút micro trên bàn phím điện thoại để nói.";
const MODE_LABEL: Record<DraftMode, string> = { company: "Công ty", personal: "Cá nhân" };
const PLACEHOLDER: Record<DraftMode, string> = {
  company: "Vd: 102LVT sơn 300k, keo 20k",
  personal: "Vd: bún bò 50k, xăng 100k",
};

export interface QuickEntryComposerProps {
  /** Hold AI submissions until company context is ready without discarding input or attachments. */
  aiContextRequired?: boolean;
  contextKey?: string;
  launchAction?: { id: number; action: 'attachment' | 'camera' | 'gallery' | 'voice' };

  appearance?: 'personal';
  disabled?: boolean;
  placeholder?: string;
  mode: DraftMode;
  /** Chế độ người dùng có quyền — một chế độ thì không hiện công tắc. */
  modes: readonly DraftMode[];
  onModeChange: (mode: DraftMode) => void;
  onSubmitText: (text: string) => void;
  onPhoto: (file: File, text?: string) => void;
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
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Mô hình máy chủ báo ĐÃ chép lần nói gần nhất — hiện để so sánh các mô hình. */
  const [heardBy, setHeardBy] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const attachment = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const voicePending = useRef(false);
  const context = useRef({ key: p.contextKey, epoch: 0 });
  if (context.current.key !== p.contextKey) context.current = { key: p.contextKey, epoch: context.current.epoch + 1 };
  const contextEpoch = context.current.epoch;
  const recordingEpoch = useRef(contextEpoch);
  const companyHint = "Chọn công ty để dùng AI. Khoản cá nhân vẫn lưu vào ví cá nhân.";
  useEffect(() => { setNote(null); setHeardBy(null); }, [p.contextKey]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!pendingPhoto) {
      setPreviewUrl(null);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(pendingPhoto);
    } catch {
      // Vẫn gửi được file khi trình duyệt không tạo được ảnh xem trước.
      setPreviewUrl(null);
      return;
    }
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhoto]);

  const submit = (content: string) => {
    if(p.disabled)return;
    if (p.aiContextRequired) { setNote(companyHint); return; }
    const t = content.trim();
    if (!t && !pendingPhoto) return;
    if (pendingPhoto) p.onPhoto(pendingPhoto, t);
    else p.onSubmitText(t);
    setText("");
    setPendingPhoto(null);
    setNote(null);
    setHeardBy(null);
  };

  const recorder = useVoiceRecorder((audio) => {
    const transcribe = p.transcribe;
    if (!transcribe || voicePending.current || !mounted.current || recordingEpoch.current !== context.current.epoch) return;
    voicePending.current = true;
    setTranscribing(true);
    setNote(null);
    transcribe(audio)
      .then((r) => {
        if (!mounted.current || context.current.epoch !== contextEpoch) return;
        // Thu hẹp bằng `in`: tsconfig.app.json không bật strictNullChecks nên `r.ok` không thu hẹp được.
        if ("text" in r) {
          if (!r.text.trim()) {
            setNote(`Chưa nghe rõ nội dung. Thử nói lại. ${KEYBOARD_MIC_HINT}`);
            return;
          }
          submit([text.trim(), r.text.trim()].filter(Boolean).join(" "));
          setHeardBy(r.model);
          return;
        }
        setNote(`${r.error.message} ${KEYBOARD_MIC_HINT}`);
      })
      .catch(() => {
        if (mounted.current && context.current.epoch === contextEpoch) setNote(`Chưa chuyển được giọng nói thành chữ. ${KEYBOARD_MIC_HINT}`);
      })
      .finally(() => {
        voicePending.current = false;
        if (mounted.current) setTranscribing(false);
      });
  });

  const previousContextEpoch = useRef(contextEpoch);
  useEffect(() => {
    if (previousContextEpoch.current !== contextEpoch) recorder.cancel();
    previousContextEpoch.current = contextEpoch;
  }, [contextEpoch, recorder.cancel]);

  const serverVoice = p.transcribe !== null && recorder.supported;
  const recording = recorder.state === "recording" || recorder.state === "requesting";
  const busy = recording || transcribing;
  const voiceError = recorder.error;

  const send = () => {
    if (busy || voicePending.current) return;
    submit(text);
  };

  const choice = p.modelChoice;
  const changeChoice = (patch: Partial<ModelChoice>) => {
    // normalizeChoice đưa mức về mặc định khi mô hình mới không nhận mức đang chọn (Astra + Tối thiểu).
    if (choice && p.onModelChoiceChange) p.onModelChoiceChange(normalizeChoice({ ...choice, ...patch }));
  };

  const onMic = () => {
    setNote(null);
    if (p.aiContextRequired) { setNote(companyHint); return; }
    if (serverVoice) { recordingEpoch.current = context.current.epoch; recorder.start(); }
    else setNote(KEYBOARD_MIC_HINT);
  };

  const lastLaunch = useRef<number | null>(null);
  useEffect(() => {
    const launch = p.launchAction;
    if (!launch || lastLaunch.current === launch.id || p.disabled) return;
    lastLaunch.current = launch.id;
    if (launch.action === "voice") { setNote(null); if(p.aiContextRequired)setNote(companyHint);else if(serverVoice){recordingEpoch.current = context.current.epoch;recorder.start();}else setNote(KEYBOARD_MIC_HINT); }
    else
      (launch.action === "camera"
        ? camera
        : launch.action === "gallery"
          ? gallery
          : attachment
      ).current?.click();
  }, [p.launchAction, p.disabled, p.aiContextRequired, serverVoice, recorder.start]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Bộ gõ tiếng Việt trên Mac/điện thoại dùng composition: Enter lúc đang ghép dấu không phải "gửi".
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (busy || voicePending.current) return;
    const image = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!image) return;
    e.preventDefault();
    if (pendingPhoto || p.aiContextRequired || p.appearance === 'personal') setPendingPhoto(image);
    else p.onPhoto(image);
  };

  const pickFile = (input: HTMLInputElement | null, withContent = false) => {
    const file = input?.files?.[0];
    if (input) input.value = "";
    if (!file || busy || voicePending.current) return;
    if (withContent || pendingPhoto || p.aiContextRequired) {
      setPendingPhoto(file);
      setNote(null);
      box.current?.focus();
    } else if (p.appearance === 'personal') {
      setPendingPhoto(file);
      setNote(null);
      box.current?.focus();
    } else p.onPhoto(file);
  };

  return (
    <div className={p.appearance==='personal'?'pf-composer':'space-y-2 border-t bg-background p-2'} data-testid="quick-entry-composer">
      {(p.modes.length > 1 || p.appearance==='personal') && (
        <div className="flex gap-1" role="group" aria-label="Ghi vào">
          {p.appearance==='personal'&&<span className="pf-destination-caption">Gửi thu chi vào</span>}
          {p.modes.map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={p.mode === m ? "default" : "outline"}
              aria-pressed={p.mode === m}
              disabled={busy}
              className="h-7 px-3 text-xs"
              onClick={() => p.onModeChange(m)}
            >
              {p.appearance==='personal'&&(m==='personal'?<Wallet size={18}/>:<Building2 size={18}/>)} {MODE_LABEL[m]}
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
              Mô hình AI: {shortLabel(choice.stt)} · {shortLabel(readModelId(choice))}
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
                  disabled={busy || p.disabled}
                  onChange={(e) => changeChoice({ stt: e.target.value })}
                >
                  <option value="">{SERVER_DEFAULT_LABEL}</option>
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
                  disabled={busy || p.disabled}
                  onChange={(e) => changeChoice({ readModel: e.target.value })}
                >
                  <option value="">{SERVER_DEFAULT_LABEL}</option>
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
                  disabled={busy || !choice.readModel}
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

      {pendingPhoto && (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
          {previewUrl && <img src={previewUrl} alt="Ảnh chờ gửi" className="h-16 w-16 shrink-0 rounded-md object-cover" />}
          <div className="min-w-0 flex-1 text-xs">
            <p className="truncate font-medium">{pendingPhoto.name}</p>
            <p className="text-muted-foreground">Nhập thêm nội dung hoặc bấm mic để nói và gửi cùng ảnh.</p>
          </div>
          <Button type="button" size="icon" variant="ghost" aria-label="Bỏ ảnh đính kèm" disabled={busy || p.disabled} onClick={() => setPendingPhoto(null)}>
            <X className="h-4 w-4" />
          </Button>
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
        <div className={cn("flex items-end gap-1", pendingPhoto && "flex-wrap")}>
          <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="Ảnh kèm nội dung" title="Ảnh kèm nội dung" disabled={busy || p.disabled} onClick={() => attachment.current?.click()}>
            <Paperclip className="h-5 w-5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="Chụp bill" disabled={busy || p.disabled} onClick={() => camera.current?.click()}>
            <Camera className="h-5 w-5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="Chọn ảnh" disabled={busy || p.disabled} onClick={() => gallery.current?.click()}>
            <ImagePlus className="h-5 w-5" />
          </Button>
          <input
            ref={attachment}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Chọn ảnh kèm nội dung"
            disabled={busy || p.disabled}
            onChange={(e) => pickFile(e.currentTarget, true)}
          />
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            aria-label="Chụp ảnh bill"
            disabled={busy || p.disabled}
            onChange={(e) => pickFile(e.currentTarget)}
          />
          <input
            ref={gallery}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Chọn ảnh bill"
            disabled={busy || p.disabled}
            onChange={(e) => pickFile(e.currentTarget)}
          />
          <div className={cn("flex min-w-0 flex-1 items-end gap-1", pendingPhoto && "basis-full")}>
            <Textarea
              ref={box}
              value={text}
              rows={Math.min(5, Math.max(1, text.split("\n").length))}
              placeholder={transcribing ? "Đang chuyển giọng nói thành chữ…" : pendingPhoto ? "Bổ sung nội dung cho ảnh…" : p.placeholder ?? PLACEHOLDER[p.mode]}
              aria-label="Nội dung khoản chi"
              className="min-h-[40px] min-w-0 flex-1 resize-none"
              disabled={busy || p.disabled}
              onChange={(e) => setText(e.target.value)}
              // Bảng chọn mở + bàn phím điện thoại bật ⇒ che gần hết thẻ nháp; gõ là xong việc chọn.
              onFocus={() => setShowModels(false)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label="Nói"
              disabled={busy || p.disabled}
              className={cn("shrink-0", transcribing && "opacity-70")}
              onClick={onMic}
            >
              {transcribing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
            </Button>
            {(text.trim() || pendingPhoto || p.appearance==='personal') && (
              <Button type="button" size={p.appearance==='personal'?'default':'icon'} className="shrink-0" aria-label="Gửi" disabled={busy || p.disabled || (!text.trim()&&!pendingPhoto)} onClick={send}>
                <Send className="h-5 w-5" />
                {p.appearance==='personal' && 'Gửi'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
