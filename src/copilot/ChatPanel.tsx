// Panel chat AI Copilot — UI tiếng Việt (F9), chat read-only Phase 2
// + UI-control experimental Phase 3 (toggle "Điều khiển trang").
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Mic, MicOff, Plus, Send, Square, X } from 'lucide-react';
import type { Message } from '@page-agent/llms';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { canUse } from '@/lib/permissionPages';
import {
  createThread,
  loadLatestThread,
  loadThreadMessages,
  runChatTurn,
  saveMessages,
  type ChatToolEvent,
} from './chatEngine';
import { useAiProviders, useCopilotEntitlement, useCopilotModel } from './useAiProviders';
import { hrefAnToan } from './hrefAnToan';

interface Props {
  onClose: () => void;
}

// Gợi ý nhanh khi thread trống
const SUGGESTION_CHIPS = [
  'Phòng nào đang trống?',
  'Doanh thu tháng này?',
  'Hợp đồng nào sắp hết hạn?',
  'Cách tạo hoá đơn?',
];

// Web Speech API (Chrome/Edge) — nhận giọng nói tiếng Việt, đổ vào ô nhập.
function useVoiceInput(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const supported =
    typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const toggle = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'vi-VN';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const text = Array.from(e.results).map((r: any) => r[0].transcript).join(' ');
      if (text) onText(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  return { supported, listening, toggle };
}

/** Render markdown TỐI GIẢN: xuống dòng + link [text](/route) → <a>. */
function MiniMarkdown({ text }: { text: string }) {
  const parts: (string | { label: string; href: string })[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const href = hrefAnToan(m[2]);
    // Scheme không an toàn → giữ nguyên cú pháp markdown dưới dạng chữ. Người
    // dùng vẫn thấy mô hình định trỏ đi đâu, nhưng không bấm được.
    parts.push(href ? { label: m[1], href } : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : (
          <a key={i} href={p.href} className="text-blue-600 underline" target={p.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
            {p.label}
          </a>
        ),
      )}
    </span>
  );
}

interface DisplayItem {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
}

const toDisplay = (msgs: Message[]): DisplayItem[] =>
  msgs
    .map((m): DisplayItem | null => {
      if (m.role === 'user') return { kind: 'user', text: m.content ?? '' };
      if (m.role === 'assistant' && m.content) return { kind: 'assistant', text: m.content };
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return { kind: 'tool', text: `Đang tra cứu: ${m.tool_calls[0].function.name}` };
      }
      return null; // tool result thô không hiển thị
    })
    .filter((x): x is DisplayItem => !!x);

export default function ChatPanel({ onClose }: Props) {
  const { data: perms } = useMyPermissions();
  // Tổ chức đang xem — chỉ CẦN khi người dùng thuộc nhiều tổ chức; database tự
  // suy được cho trường hợp một tổ chức (20260809040000).
  const { organization } = useOrganization();
  const { data: providers } = useAiProviders();
  const { data: entitlement } = useCopilotEntitlement();
  const { model, setModel } = useCopilotModel();
  const navigate = useNavigate();

  const canUiControl =
    !!entitlement?.ui_control_enabled && !!perms && canUse(perms, 'ai_copilot', 'ui_control');

  const [uiMode, setUiMode] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [liveTool, setLiveTool] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const uiAgentRef = useRef<{ stop: () => Promise<void>; dispose: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Chặn race: nếu user đã tương tác (gửi tin / mở thread mới) trước khi
  // loadLatestThread resolve, KHÔNG đè state đang chạy.
  const touchedRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const t = await loadLatestThread();
        if (touchedRef.current || !t) return;
        const msgs = await loadThreadMessages(t.id);
        if (touchedRef.current) return;
        setThreadId(t.id);
        setHistory(msgs);
      } catch {
        /* chưa có thread — bỏ qua */
      }
    })();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, liveTool]);

  const newThread = () => {
    touchedRef.current = true;
    setThreadId(null);
    setHistory([]);
    setError('');
  };

  const handleError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(
      /not_entitled|not_permitted|403/.test(msg)
        ? 'Tài khoản chưa được cấp quyền dùng AI Copilot hoặc đã hết hạn mức hôm nay.'
        : `Lỗi: ${msg}`,
    );
  };

  // UI-control: mỗi lệnh ĐỘC LẬP (execute reset history) — không lưu thread.
  const runUiControl = async (text: string) => {
    setHistory((h) => [...h, { role: 'user', content: text }]);
    setLiveTool('điều khiển trang');
    const { createUiControlAgent } = await import('./createAgent');
    const agent = createUiControlAgent({ providerModel: model, ctx: { perms, navigate } });
    uiAgentRef.current = agent;
    try {
      const result = await agent.run(text);
      setHistory((h) => [...h, { role: 'assistant', content: result.data }]);
    } finally {
      agent.dispose();
      uiAgentRef.current = null;
    }
  };

  const runChat = async (text: string) => {
    setHistory((h) => [...h, { role: 'user', content: text }]);
    const abort = new AbortController();
    abortRef.current = abort;
    let tid = threadId;
    if (!tid) {
      tid = (await createThread(text, organization?.id ?? null)).id;
      setThreadId(tid);
    }
    const result = await runChatTurn({
      providerModel: model,
      history,
      userText: text,
      ctx: { perms },
      signal: abort.signal,
      onToolEvent: (ev: ChatToolEvent) => setLiveTool(ev.tool),
    });
    setHistory((h) => [...h.slice(0, -1), ...result.newMessages]);
    void saveMessages(tid, result.newMessages, model, organization?.id ?? null).catch(() => {
      /* lưu lịch sử lỗi không chặn chat */
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    touchedRef.current = true;
    setInput('');
    setError('');
    setRunning(true);
    try {
      if (uiMode && canUiControl) await runUiControl(text);
      else await runChat(text);
    } catch (e) {
      handleError(e);
    } finally {
      setLiveTool(null);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
    void uiAgentRef.current?.stop();
  };

  const voice = useVoiceInput((text) => setInput((cur) => (cur ? `${cur} ${text}` : text)));

  const items = toDisplay(history);

  return (
    <div
      className="fixed bottom-4 right-4 z-[9998] flex h-[min(640px,80vh)] w-[min(420px,calc(100vw-2rem))] flex-col rounded-xl border bg-background shadow-2xl"
      data-testid="copilot-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-semibold text-sm">Trợ lý AI</span>
        <select
          className="ml-auto max-w-[180px] truncate rounded border bg-background px-1 py-0.5 text-xs"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          data-testid="copilot-model-select"
        >
          {!providers?.some((p) => p.value === model) && <option value={model}>{model}</option>}
          {providers?.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="rounded p-1 hover:bg-muted" title="Cuộc trò chuyện mới" onClick={newThread}>
          <Plus className="h-4 w-4" />
        </button>
        <button className="rounded p-1 hover:bg-muted" title="Đóng" onClick={onClose} data-testid="copilot-close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Toggle UI-control (experimental) — chỉ hiện khi có entitlement + quyền */}
      {canUiControl && (
        <label className="flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          <input
            type="checkbox"
            checked={uiMode}
            onChange={(e) => setUiMode(e.target.checked)}
            disabled={running}
            data-testid="copilot-uimode"
          />
          Điều khiển trang (thử nghiệm) — chỉ điều hướng & lọc, mỗi lệnh độc lập
        </label>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {items.length === 0 && (
          <div className="mt-8 space-y-3 text-center text-muted-foreground">
            <div>Hỏi tôi về phòng trống, hoá đơn, hợp đồng sắp hết hạn, doanh thu tháng, cách dùng hệ thống…</div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  className="rounded-full border px-3 py-1 text-xs hover:bg-muted"
                  onClick={() => setInput(chip)}
                  data-testid="copilot-chip"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, i) =>
          it.kind === 'tool' ? (
            <div key={i} className="text-xs italic text-muted-foreground">⚙ {it.text}</div>
          ) : (
            <div key={i} className={`flex ${it.kind === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 ${
                  it.kind === 'user' ? 'bg-blue-600 text-white' : 'bg-muted'
                }`}
              >
                <MiniMarkdown text={it.text} />
              </div>
            </div>
          ),
        )}
        {running && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {liveTool ? `Đang tra cứu: ${liveTool}…` : 'Đang suy nghĩ…'}
          </div>
        )}
        {error && <div className="rounded bg-red-50 p-2 text-xs text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 border-t p-2">
        <textarea
          className="max-h-28 min-h-[38px] flex-1 resize-none rounded border bg-background px-2 py-1.5 text-sm"
          rows={1}
          placeholder={uiMode ? 'Lệnh điều khiển, vd "mở trang phòng"…' : 'Nhập câu hỏi…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="copilot-input"
        />
        {voice.supported && !running && (
          <button
            className={`rounded p-2 ${voice.listening ? 'bg-red-100 text-red-600' : 'hover:bg-muted'}`}
            title={voice.listening ? 'Đang nghe… (bấm để dừng)' : 'Nói tiếng Việt'}
            onClick={voice.toggle}
          >
            {voice.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        )}
        {running ? (
          <button
            className="rounded bg-red-600 p-2 text-white"
            title="Dừng"
            onClick={stopRun}
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            className="rounded bg-blue-600 p-2 text-white disabled:opacity-50"
            disabled={!input.trim()}
            onClick={() => void send()}
            title="Gửi"
            data-testid="copilot-send"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
