import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Paperclip, Mic, Send, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { EMERALD } from './zaloTheme';
import TemplatePicker from './TemplatePicker';
import EmojiPicker from './composer/EmojiPicker';
import StickerPicker from './composer/StickerPicker';
import AttachmentTray, { type PendingFile } from './composer/AttachmentTray';
import VoiceRecorder from './composer/VoiceRecorder';
import ReplyBar from './composer/ReplyBar';
import SuggestDropdown, { type SuggestItem } from './composer/SuggestDropdown';
import type { ZaloTemplateItem } from '@/hooks/useZaloChat';
import type { StickerItem } from '@/hooks/chat-zalo/useZaloMedia';

interface Props {
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  /** đang gửi text (busy-lock chống double-Enter) */
  sending?: boolean;
  templates: ZaloTemplateItem[];
  onPickTemplate: (body: string) => void;
  /** thanh trả lời (quote) */
  replyTo?: { name: string; text: string } | null;
  onCancelReply?: () => void;
  /** gửi media: ảnh (nhiều) / tệp (1) */
  onSendMedia?: (kind: 'image' | 'file', files: File[], caption: string) => Promise<unknown>;
  mediaSending?: boolean;
  /** gửi voice */
  onSendVoice?: (blob: Blob, durationMs: number, mime: string) => Promise<unknown>;
  voiceSending?: boolean;
  /** sticker */
  accountId?: string | null;
  onSendSticker?: (s: StickerItem) => void;
  /** tệp kéo-thả từ ChatThread */
  externalFiles?: File[] | null;
  onExternalConsumed?: () => void;
  /** best-effort "đang gõ" */
  onTyping?: () => void;
  /** mở dialog quản lý mẫu tin (chỉ truyền khi có quyền) */
  onManageTemplates?: () => void;
}

const iconBtn = {
  width: 32, height: 32, border: 'none', background: 'transparent', borderRadius: 7,
  color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
} as const;

/** Ô soạn tin: textarea auto-grow + emoji/ảnh/tệp/voice/sticker/mẫu tin + khay media + reply bar. */
export default function Composer({
  draft, onDraft, onSend, sending, templates, onPickTemplate,
  replyTo, onCancelReply,
  onSendMedia, mediaSending, onSendVoice, voiceSending,
  accountId, onSendSticker,
  externalFiles, onExternalConsumed, onTyping, onManageTemplates,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Busy-lock: khoá NGAY trong keydown, thả khi mutation xong — double-Enter
  // sinh 2 cli id khác nhau nên server không dedup được (bài học WEB2 §13.16).
  const sendLock = useRef(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [pendingKind, setPendingKind] = useState<'image' | 'file'>('image');
  const [caption, setCaption] = useState('');
  const [recording, setRecording] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);

  useEffect(() => { if (!sending) sendLock.current = false; }, [sending]);

  // textarea auto-grow (tối đa ~5 dòng)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`;
  }, [draft]);

  // Quick reply: draft bắt đầu bằng "/" → gợi ý mẫu tin
  const slashItems: SuggestItem[] = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const q = draft.slice(1).toLowerCase();
    return templates
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q))
      .slice(0, 8)
      .map((t) => ({ key: t.id, label: t.title, sub: t.body.slice(0, 80) }));
  }, [draft, templates]);
  useEffect(() => { setSuggestIdx(0); }, [slashItems.length]);

  const addFiles = (files: File[], kind?: 'image' | 'file') => {
    if (!files.length || !onSendMedia) return;
    const allImages = files.every((f) => f.type.startsWith('image/'));
    const k = kind || (allImages ? 'image' : 'file');
    if (k === 'file' && files.length > 1) {
      toast.error('Tệp đính kèm gửi từng tệp một');
      files = files.slice(0, 1);
    }
    setPendingKind(k);
    setPending((prev) => {
      const base = k === 'file' ? [] : prev.filter((p) => p.file.type.startsWith('image/'));
      const next = [...base, ...files.map((f) => ({
        file: f,
        previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      }))];
      return next.slice(0, 12);
    });
  };

  // tệp kéo-thả từ ChatThread
  useEffect(() => {
    if (externalFiles && externalFiles.length) {
      addFiles(externalFiles);
      onExternalConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalFiles]);

  const sendMedia = async () => {
    if (!pending.length || !onSendMedia || mediaSending) return;
    try {
      await onSendMedia(pendingKind, pending.map((p) => p.file), caption);
      setPending([]);
      setCaption('');
    } catch { /* toast trong hook */ }
  };

  const pickSuggest = (item: SuggestItem) => {
    const t = templates.find((x) => x.id === item.key);
    if (t) onDraft(t.body);
  };

  const trySend = () => {
    if (sendLock.current || sending) return;
    if (!draft.trim()) return;
    sendLock.current = true;
    onSend();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIdx((i) => Math.min(i + 1, slashItems.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = slashItems[suggestIdx];
        if (chosen) pickSuggest(chosen);
        return;
      }
      if (e.key === 'Escape') { onDraft(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  };

  const insertAtCaret = (text: string) => {
    const ta = taRef.current;
    if (!ta) { onDraft(draft + text); return; }
    const s = ta.selectionStart ?? draft.length;
    const epos = ta.selectionEnd ?? draft.length;
    onDraft(draft.slice(0, s) + text + draft.slice(epos));
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  return (
    <div style={{ flex: 'none', borderTop: '1px solid hsl(210 20% 90%)', background: '#fff', padding: '12px 16px 14px' }}>
      {replyTo && onCancelReply && <ReplyBar replyTo={replyTo} onCancel={onCancelReply} />}
      <AttachmentTray
        items={pending}
        caption={caption}
        onCaption={setCaption}
        onRemove={(i) => setPending((prev) => prev.filter((_, x) => x !== i))}
        onSend={sendMedia}
        onCancel={() => { setPending([]); setCaption(''); }}
        uploading={!!mediaSending}
      />
      {recording && onSendVoice ? (
        <VoiceRecorder
          sending={voiceSending}
          onCancel={() => setRecording(false)}
          onDone={async (blob, dur, mime) => {
            try {
              await onSendVoice(blob, dur, mime);
              setRecording(false);
            } catch { /* toast trong hook */ }
          }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <div style={{ flex: 1, position: 'relative', border: '1.5px solid hsl(210 20% 88%)', borderRadius: 14, background: 'hsl(210 20% 98%)', padding: '7px 12px 9px' }}>
            {slashItems.length > 0 && (
              <SuggestDropdown title="Mẫu tin — Enter để chèn" items={slashItems} activeIndex={suggestIdx} onHover={setSuggestIdx} onPick={pickSuggest} />
            )}
            <textarea
              ref={taRef}
              value={draft}
              rows={1}
              onChange={(e) => { onDraft(e.target.value); onTyping?.(); }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="Nhập tin nhắn… gõ / để chèn mẫu, Shift+Enter xuống dòng"
              style={{ width: '100%', border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 13.5, color: 'hsl(160 30% 14%)', padding: '6px 0', outline: 'none', resize: 'none', lineHeight: 1.45 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 3 }}>
              <EmojiPicker onPick={insertAtCaret} />
              {onSendMedia && (
                <>
                  <button style={iconBtn} title="Gửi ảnh" onClick={() => imgInputRef.current?.click()}><ImageIcon size={18} /></button>
                  <button style={iconBtn} title="Đính kèm tệp" onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button>
                </>
              )}
              {onSendVoice && (
                <button style={iconBtn} title="Ghi âm" onClick={() => setRecording(true)}><Mic size={18} /></button>
              )}
              {onSendSticker && <StickerPicker accountId={accountId} onPick={onSendSticker} />}
              <span style={{ width: 1, height: 18, background: 'hsl(210 20% 88%)', margin: '0 4px' }} />
              <TemplatePicker templates={templates} onPick={onPickTemplate} onManage={onManageTemplates} />
            </div>
          </div>
          <button
            onClick={trySend}
            disabled={sending}
            title="Gửi"
            style={{ width: 46, height: 46, borderRadius: 13, border: 'none', background: EMERALD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.75 : 1, boxShadow: '0 6px 14px -5px hsl(152 69% 31% / .7)', flex: 'none' }}
          >
            {sending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
          </button>
        </div>
      )}
      <input ref={imgInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files || []), 'image'); e.target.value = ''; }} />
      <input ref={fileInputRef} type="file" hidden onChange={(e) => { addFiles(Array.from(e.target.files || []), 'file'); e.target.value = ''; }} />
    </div>
  );
}
