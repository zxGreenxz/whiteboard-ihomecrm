// Panel chat AI Copilot — UI tiếng Việt (F9), chat read-only Phase 2
// + UI-control experimental Phase 3 (toggle "Điều khiển trang").
// Giao diện "Bé Chiu" theo design "Trợ lý AI - Bé Chiu.dc.html".
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  BarChart3, Brain, Building2, FileText, ImagePlus, Mic, MicOff, Plus, Receipt, Send, Square, Trash2, X,
} from 'lucide-react';
// Kiểu tin nhắn nay do chatEngine sở hữu, không còn lấy từ @page-agent/llms:
// `Message.content` của thư viện đó là `string | null`, không chứa được tin
// nhắn kèm ảnh.
import type { Message } from './chatEngine';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { useOrganization } from '@/contexts/OrganizationContext';
import XacNhanPhieuCard from './XacNhanPhieuCard';
import { datNguCanhXacNhan } from './confirmationStore';
import { canUse } from '@/lib/permissionPages';
import {
  createThread,
  loadLatestThread,
  loadThreadMessages,
  runChatTurn,
  saveMessages,
  isCurrentChatScope,
  type ChatToolEvent,
} from './chatEngine';
import { useAiProviders, useCopilotEntitlement, useCopilotModel } from './useAiProviders';
import { hrefAnToan } from './hrefAnToan';
import { anhTuDataTransfer, nenAnh, type AnhDaNen } from './anh';
import { BeChiu, TEN_LINH_THU } from './BeChiu';
import { useCopilotAvailability, type CopilotAvailabilitySnapshot } from './featureFlags';
import {
  quyetDinhGuiTheoAvailability,
  quyetDinhGuiTheoNguCanh,
  THONG_BAO_QUYEN_CHUA_TUOI,
} from './availabilityGate';
import { assertUiControlAvailability } from './uiControlAvailability';
import { lyDoChanUiControl } from './uiControlGate';
import { dienGiaiLoiChat } from './chatErrors';
import {
  boGhiNho,
  dienGiaiLoiGhiNho,
  ghiNhoLen,
  kiemGhiNho,
  layGhiNho,
  NHAN_COPILOT_TU_GHI,
  SO_GHI_NHO_TOI_DA,
  type GhiNho,
} from './memoryClient';
// `LoiModel` là lớp lỗi DUY NHẤT mang mã máy của proxy (`error.code`). Nhập lớp
// chứ không chỉ nhập kiểu: cần `instanceof` lúc chạy, không phải lúc biên dịch.
import { LoiModel } from './llmClient';

interface Props {
  onClose: () => void;
}

// Gợi ý nhanh khi thread trống — mỗi chip một màu status theo design.
const SUGGESTION_CHIPS = [
  { text: 'Phòng nào đang trống?', Icon: Building2, mau: 'bc-chip--success' },
  { text: 'Doanh thu tháng này?', Icon: BarChart3, mau: 'bc-chip--info' },
  { text: 'Hợp đồng nào sắp hết hạn?', Icon: FileText, mau: 'bc-chip--warning' },
  { text: 'Cách tạo hoá đơn?', Icon: Receipt, mau: 'bc-chip--tasks' },
];

// Web Speech API (Chrome/Edge) — nhận giọng nói tiếng Việt, đổ vào ô nhập.
function useVoiceInput(onText: (text: string) => void) {
  type SpeechResultEvent = { results: ArrayLike<{ 0: { transcript: string } }> };
  type SpeechRecognitionLike = {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((event: SpeechResultEvent) => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
    start: () => void;
    stop: () => void;
  };
  type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const speechWindow = typeof window !== 'undefined' ? window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  } : null;
  const supported =
    !!(speechWindow?.SpeechRecognition || speechWindow?.webkitSpeechRecognition);

  const toggle = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = speechWindow?.SpeechRecognition || speechWindow?.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'vi-VN';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ');
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
          <a key={i} href={p.href} className="font-medium text-primary underline" target={p.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
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

/**
 * `content` thành chữ để hiển thị.
 *
 * Tin nhắn multimodal là mảng phần; phần ảnh hiện bằng nhãn thay vì đổ data URL
 * base64 dài hàng trăm KB ra bong bóng chat.
 */
function chuHienThi(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '🖼 [ảnh]')).join('\n');
}

const toDisplay = (msgs: Message[]): DisplayItem[] =>
  msgs
    .map((m): DisplayItem | null => {
      if (m.role === 'user') return { kind: 'user', text: chuHienThi(m.content) };
      if (m.role === 'assistant' && m.content) {
        return { kind: 'assistant', text: chuHienThi(m.content) };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        // Mô hình xin nhiều tool một lúc thì kể đủ, đừng chỉ khoe cái đầu tiên.
        return { kind: 'tool', text: `Đang tra cứu: ${m.tool_calls.map((t) => t.function.name).join(', ')}` };
      }
      return null; // tool result thô không hiển thị
    })
    .filter((x): x is DisplayItem => !!x);

export default function ChatPanel({ onClose }: Props) {
  const { data: perms } = useMyPermissions();
  // Chỉ để LỌC tool `superAdminOnly` khỏi danh sách gửi cho mô hình. Chưa tải
  // xong ⇒ `undefined` ⇒ coi như KHÔNG phải super admin: hàng rào thật nằm ở
  // `is_super_admin()` của server, ở đây fail-closed chỉ để mô hình đừng gọi một tool
  // mà nó chắc chắn bị từ chối.
  const { data: laSuperAdmin } = useIsSuperAdmin();
  // Tổ chức đang xem — chỉ CẦN khi người dùng thuộc nhiều tổ chức; database tự
  // suy được cho trường hợp một tổ chức (20260809040000).
  // `selectedOrganizationId` chứ không phải `organization?.id`: hai thứ này đã
  // từng là một, nhưng nay `organization` chỉ để HIỂN THỊ còn lựa chọn tường minh
  // mới là thứ đi vào ToolCtx. `null` = chưa chốt, và tool org-scoped sẽ từ chối
  // chạy chứ không lặng lẽ đọc union nhiều công ty.
  const { selectedOrganizationId } = useOrganization();
  // `live: true` — panel chat mở lâu; xem chú thích trong useCopilotAvailability.
  const { data: availability, refetch: refetchAvailability } = useCopilotAvailability(
    selectedOrganizationId,
    { live: true },
  );
  const { data: providers } = useAiProviders();
  const { data: entitlement } = useCopilotEntitlement();
  const { model, setModel, modelLoiThoi, modelThayThe } = useCopilotModel();
  const navigate = useNavigate();
  const location = useLocation();

  const canUiControl =
    !!entitlement?.ui_control_enabled && !!perms && canUse(perms, 'ai_copilot', 'ui_control');

  const [uiMode, setUiMode] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [liveTool, setLiveTool] = useState<string | null>(null);
  /** Câu trả lời đang chảy về, chưa chốt vào history. */
  const [dangChay, setDangChay] = useState('');
  /** Ảnh đính kèm cho LƯỢT SẮP GỬI. Không lưu, không mang sang lượt sau. */
  const [anhKem, setAnhKem] = useState<AnhDaNen[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  /** Đang nạp lại lịch sử của tổ chức đang chọn — khác hẳn "chưa có gì". */
  const [dangTaiLichSu, setDangTaiLichSu] = useState(false);
  /**
   * Ghi nhớ dài hạn của chính người dùng trong CÔNG TY ĐANG CHỌN.
   *
   * Giữ trong state chứ không đọc lại mỗi lượt: một lượt chat đã tốn một vòng mạng
   * tới model, thêm một vòng cho danh sách hầu như không đổi là trả độ trễ cho một thứ
   * không ai sửa sau lưng. Nạp lại đúng hai lúc: đổi công ty, và sau một lượt có gọi
   * `ghi_nho`/`quen`.
   */
  const [ghiNho, setGhiNho] = useState<GhiNho[]>([]);
  const [moGhiNho, setMoGhiNho] = useState(false);
  const [khoaMoi, setKhoaMoi] = useState('');
  const [noiDungMoi, setNoiDungMoi] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const uiAgentRef = useRef<{ stop: () => Promise<void>; dispose: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Chặn race: nếu user đã tương tác (gửi tin / mở thread mới) trước khi
  // loadLatestThread resolve, KHÔNG đè state đang chạy.
  const touchedRef = useRef(false);
  const orgGenerationRef = useRef(0);

  /* load latest thread for the selected organization; stale generations are ignored */
  useEffect(() => {
    const generation = ++orgGenerationRef.current;
    datNguCanhXacNhan({ organizationId: selectedOrganizationId, threadId: null, generation });
    abortRef.current?.abort();
    abortRef.current = null;
    void uiAgentRef.current?.stop();
    uiAgentRef.current?.dispose();
    uiAgentRef.current = null;
    touchedRef.current = false;
    setThreadId(null);
    setHistory([]);
    setError('');
    setLiveTool(null);
    setDangChay('');
    setRunning(false);
    setDangTaiLichSu(false);
    if (!selectedOrganizationId) return;
    setDangTaiLichSu(true);
    void (async () => {
      try {
        const t = await loadLatestThread(selectedOrganizationId);
        if (generation !== orgGenerationRef.current || touchedRef.current || !t) return;
        const msgs = await loadThreadMessages(t.id, selectedOrganizationId);
        if (generation !== orgGenerationRef.current || touchedRef.current) return;
        setThreadId(t.id);
        datNguCanhXacNhan({ organizationId: selectedOrganizationId, threadId: t.id, generation });
        setHistory(msgs);
      } catch {
        /* chưa có thread — bỏ qua */
      } finally {
        if (generation === orgGenerationRef.current) setDangTaiLichSu(false);
      }
    })();
    return () => {
      if (orgGenerationRef.current === generation) abortRef.current?.abort();
    };
  }, [selectedOrganizationId]);

  // Ghi nhớ theo CÔNG TY: đổi công ty thì phải đổi cả danh sách. Giữ lại danh sách
  // cũ sẽ đưa "toà ưu tiên" của công ty A vào prompt khi đang hỏi về công ty B — một
  // câu trả lời sai mà không có lỗi nào nổ ra.
  useEffect(() => {
    const generation = orgGenerationRef.current;
    setGhiNho([]);
    setMoGhiNho(false);
    if (!selectedOrganizationId) return;
    void (async () => {
      try {
        const ds = await layGhiNho(selectedOrganizationId);
        if (generation !== orgGenerationRef.current) return;
        setGhiNho(ds);
      } catch {
        /* chưa có ghi nhớ nào, hoặc RPC chưa apply — chat vẫn chạy bình thường */
      }
    })();
  }, [selectedOrganizationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, liveTool, dangChay]);

  const newThread = () => {
    orgGenerationRef.current += 1;
    datNguCanhXacNhan({ organizationId: selectedOrganizationId, threadId: null, generation: orgGenerationRef.current });
    abortRef.current?.abort();
    abortRef.current = null;
    touchedRef.current = true;
    setThreadId(null);
    setHistory([]);
    setError('');
    setRunning(false);
  };

  // Ném MÃ đi cùng CÂU, không chọn một trong hai.
  //
  // `dienGiaiLoiChat` khớp theo chuỗi con, nên nó chỉ dịch được thứ nó nhìn
  // thấy. Proxy trả mã máy ở `error.code` (`organization_forbidden`) còn `message`
  // là câu tiếng Anh của tầng dưới ('No access to the selected organization') —
  // đưa mỗi `message` lên thì mọi mã của proxy đều rơi vào nhánh 'lỗi lạ' và
  // người dùng đọc một câu tiếng Anh không hành động được. Đưa mỗi `code` lên thì
  // ngược lại: mã chưa có trong bảng sẽ hiện trơ một token như `busy`, còn tệ hơn.
  // Ghép `code: message` giữ được cả hai — bảng dịch bắt được mã đã biết, mã chưa
  // biết vẫn kéo theo câu gốc để người dùng chụp màn hình gửi đi.
  const handleError = (e: unknown) => {
    const cau = e instanceof Error ? e.message : String(e);
    const ma = e instanceof LoiModel ? e.code : null;
    setError(dienGiaiLoiChat(ma ? `${ma}: ${cau}` : cau));
  };

  // UI-control: mỗi lệnh ĐỘC LẬP (execute reset history) — không lưu thread.
  const runUiControl = async (text: string, snapshot: CopilotAvailabilitySnapshot) => {
    const organizationId = selectedOrganizationId;
    const generation = orgGenerationRef.current;
    setHistory((h) => [...h, { role: 'user', content: text }]);
    setLiveTool('điều khiển trang');
    const { createUiControlAgent } = await import('./createAgent');
    // Trước đây chỗ này `return` trần: câu hỏi đã hiện trong khung chat rồi
    // im bặt. Năm điều kiện có năm cách sửa khác nhau nên phải nói ra cái nào.
    const lyDoChan = lyDoChanUiControl({
      cungPhamVi: isCurrentChatScope(
        generation,
        orgGenerationRef.current,
        organizationId,
        selectedOrganizationId,
      ),
      coQuyenDieuKhien: canUiControl,
      organizationId,
      snapshot,
    });
    if (lyDoChan) {
      setError(lyDoChan);
      return;
    }
    assertUiControlAvailability({
      pathname: location.pathname,
      // `UiControlAvailabilityContext` HẸP hơn `ToolCtx` (chỉ perms + org +
      // availability) và là object literal, nên thêm trường thừa ở đây là lỗi
      // biên dịch chứ không phải chuyện vô hại.
      ctx: { perms, organizationId, availability: snapshot },
    });
    const agent = createUiControlAgent({
      providerModel: model,
      ctx: {
        perms,
        organizationId,
        navigate,
        availability: snapshot,
        threadId,
        generation,
        isSuperAdmin: !!laSuperAdmin,
      },
    });
    uiAgentRef.current = agent;
    try {
      const result = await agent.run(text);
      if (!isCurrentChatScope(generation, orgGenerationRef.current, organizationId, selectedOrganizationId)) return;
      setHistory((h) => [...h, { role: 'assistant', content: result.data }]);
    } finally {
      agent.dispose();
      if (uiAgentRef.current === agent) uiAgentRef.current = null;
    }
  };

  /**
   * Lưu lịch sử — thử lại ĐÚNG một lần rồi báo bằng toast.
   *
   * Hỏng ở đây không chặn chat (câu trả lời đã hiện rồi), nhưng nuốt im lặng
   * thì người dùng F5 xong mất nguyên lượt vừa nói mà vẫn tưởng đã lưu.
   * Một lần thử lại là để đỡ cú mạng chớp nhoáng — ca thường gặp nhất.
   */
  const luuLichSuCoThuLai = async (
    tid: string,
    msgs: Message[],
    organizationId: string | null,
  ): Promise<void> => {
    try {
      await saveMessages(tid, msgs, model, organizationId);
      return;
    } catch {
      /* thử lại ngay bên dưới */
    }
    try {
      await saveMessages(tid, msgs, model, organizationId);
    } catch {
      toast.error('Không lưu được lịch sử chat.');
    }
  };

  const runChat = async (text: string, anh: string[], snapshot: CopilotAvailabilitySnapshot) => {
    const organizationId = selectedOrganizationId;
    const generation = orgGenerationRef.current;
    setHistory((h) => [
      ...h,
      {
        role: 'user',
        content: anh.length
          ? [{ type: 'text' as const, text }, ...anh.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
          : text,
      },
    ]);
    const abort = new AbortController();
    abortRef.current = abort;
    let tid = threadId;
    if (!tid) {
      tid = (await createThread(text, organizationId)).id;
      if (generation !== orgGenerationRef.current) return;
      setThreadId(tid);
    }
    datNguCanhXacNhan({ organizationId, threadId: tid, generation });
    const result = await runChatTurn({
      providerModel: model,
      history,
      userText: text,
      ctx: {
        perms,
        organizationId,
        availability: snapshot,
        threadId: tid,
        generation,
        isSuperAdmin: !!laSuperAdmin,
      },
      signal: abort.signal,
      // Cho Copilot biết người dùng đang xem màn hình nào — để hiểu "cái này".
      // Kèm cả query string: bộ lọc đang áp mới quyết định con số họ đang nhìn
      // (chỉ khoá trong allowlist của `banDoHeThong` được kể lại).
      pathname: location.pathname,
      search: location.search,
      ghiNho,
      anh,
      onToolEvent: (ev: ChatToolEvent) => {
        if (generation !== orgGenerationRef.current) return;
        setLiveTool(ev.tool);
        // Mô hình có thể nói một câu dẫn rồi mới gọi tool. Câu đó đã hiện ra;
        // dọn nó đi khi sang vòng tool để bong bóng "đang chảy" không dính lại
        // phần dẫn của vòng trước.
        setDangChay('');
      },
      onDeltaChu: (chu) => {
        if (generation !== orgGenerationRef.current) return;
        setLiveTool(null);
        setDangChay((s) => s + chu);
      },
    });
    if (!isCurrentChatScope(generation, orgGenerationRef.current, organizationId, selectedOrganizationId)) return;
    setDangChay('');
    setHistory((h) => [...h.slice(0, -1), ...result.newMessages]);
    void luuLichSuCoThuLai(tid, result.newMessages, organizationId);
    // Một lượt có gọi tool bộ nhớ thì danh sách trên màn hình đã cũ. Đọc lại từ server
    // chứ không đoán từ chuỗi tool trả về: server mới biết đã ghì đè hay chạm trần.
    if (organizationId && result.toolEvents.some((ev) => ev.tool === 'ghi_nho' || ev.tool === 'quen')) {
      void (async () => {
        try {
          const ds = await layGhiNho(organizationId);
          if (generation === orgGenerationRef.current) setGhiNho(ds);
        } catch {
          /* không đọc lại được thì danh sách trên màn hình cũ một lúc, không phải lỗi chặn */
        }
      })();
    }
  };

  /**
   * Snapshot quyền công cụ đủ tươi để chạy một lượt — làm mới trước nếu cần.
   *
   * Snapshot hết hạn KHÔNG làm hỏng lượt chat: registry trả danh sách tool rỗng
   * và Copilot lặng lẽ trả lời như một mô hình chay. Phải chặn ở đây.
   *
   * CHƯA CHỌN TỔ CHỨC thì không đi làm mới: query bị `enabled: false` nên
   * refetch trả null vĩnh viễn. `quyetDinhGuiTheoNguCanh` tách sẵn nhánh đó
   * và trả về lý do đúng thay vì hẹn người dùng chờ một thứ không đến.
   */
  const quyenCongCuTuoi = async () => {
    let snapshot: CopilotAvailabilitySnapshot | null = availability ?? null;
    let quyetDinh = quyetDinhGuiTheoNguCanh({ organizationId: selectedOrganizationId, snapshot });
    if (quyetDinh.canRefetch) {
      snapshot = (await refetchAvailability()).data ?? null;
      quyetDinh = quyetDinhGuiTheoNguCanh({ organizationId: selectedOrganizationId, snapshot });
    }
    return { ...quyetDinh, snapshot };
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !anhKem.length) || running) return;
    // Ảnh không kèm câu hỏi thì mô hình không biết phải làm gì với nó; đưa một
    // câu mặc định còn hơn để nó tự đoán ý.
    const cauHoi = text || 'Đọc giúp tôi ảnh này.';
    const anh = anhKem.map((a) => a.dataUrl);
    const generation = orgGenerationRef.current;
    touchedRef.current = true;
    setError('');
    setRunning(true);
    try {
      // Phải có tổ chức, và quyền công cụ phải TƯƠI. Chặn TRƯỚC khi dọn ô nhập để
      // người dùng thử lại được ngay thay vì phải gõ lại câu hỏi.
      const quyen = await quyenCongCuTuoi();
      if (generation !== orgGenerationRef.current) return;
      if (!quyen.guiDuoc || !quyen.snapshot) {
        setError(quyen.thongBao ?? THONG_BAO_QUYEN_CHUA_TUOI);
        return;
      }
      setInput('');
      setAnhKem([]);
      if (uiMode && canUiControl) await runUiControl(cauHoi, quyen.snapshot);
      else await runChat(cauHoi, anh, quyen.snapshot);
    } catch (e) {
      handleError(e);
    } finally {
      if (generation === orgGenerationRef.current) setLiveTool(null);
      // Dọn bong bóng đang-chảy kể cả khi lỗi hoặc user bấm Dừng: để lại một
      // câu dở dang không thuộc history là nói dối người đọc về thứ đã lưu.
      if (generation === orgGenerationRef.current) setDangChay('');
      if (generation === orgGenerationRef.current) setRunning(false);
      if (generation === orgGenerationRef.current) abortRef.current = null;
    }
  };

  /** Nén rồi xếp vào hàng chờ. Lỗi hiện ngay cho người dùng, không nuốt. */
  const themAnh = async (files: File[]) => {
    if (!files.length) return;
    for (const f of files.slice(0, 3)) {
      try {
        const a = await nenAnh(f);
        setAnhKem((cu) => [...cu, a]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
    void uiAgentRef.current?.stop();
  };

  /** Bỏ MỘT ghi nhớ từ giao diện. State chỉ đổi sau khi server đã nhận. */
  const boMotGhiNho = async (khoa: string) => {
    const organizationId = selectedOrganizationId;
    if (!organizationId) return;
    const generation = orgGenerationRef.current;
    try {
      await boGhiNho(organizationId, khoa);
      if (generation !== orgGenerationRef.current) return;
      setGhiNho((cu) => cu.filter((m) => m.khoa !== khoa));
    } catch {
      toast.error('Không bỏ được ghi nhớ này.');
    }
  };

  /**
   * Thêm/sửa MỘT ghi nhớ bằng tay, nguồn `user`.
   *
   * VÌ SAO CẦN Ô NHẬP DÙ NÓI "nhớ giúp tôi…" ĐÃ LƯU ĐƯỢC
   *   Hai đường ghi này khác nhau ở thứ đi vào cột `source`, và cột đó có việc:
   *   một câu Copilot NGHE NHẦM rồi tự ghi lại không được mang cùng sức nặng với một
   *   câu người dùng gõ tay. Không có đường gõ tay thì `source` chỉ có một giá trị
   *   khả dĩ — một cột chết, và nhãn dựa trên nó không phân biệt được gì.
   *
   *   Đây cũng là đường SỬA duy nhất: gõ lại cùng một khoá là ghi đè (UNIQUE),
   *   nên người dùng chữa được một mục Copilot nhớ sai mà không phải bỏ rồi nói lại.
   */
  const themGhiNhoTay = async () => {
    const organizationId = selectedOrganizationId;
    if (!organizationId) return;
    const kiem = kiemGhiNho(khoaMoi, noiDungMoi);
    if (!kiem.ok) {
      toast.error(kiem.loi ?? '');
      return;
    }
    const generation = orgGenerationRef.current;
    try {
      const kq = await ghiNhoLen(organizationId, kiem.khoa, kiem.noiDung, 'user');
      if (generation !== orgGenerationRef.current) return;
      setGhiNho((cu) => [
        { khoa: kq.khoa, noiDung: kq.noiDung, nguon: kq.nguon, capNhat: new Date().toISOString() },
        ...cu.filter((m) => m.khoa !== kq.khoa),
      ]);
      setKhoaMoi('');
      setNoiDungMoi('');
    } catch (e) {
      toast.error(dienGiaiLoiGhiNho(e instanceof Error ? e.message : String(e)));
    }
  };

  const voice = useVoiceInput((text) => setInput((cur) => (cur ? `${cur} ${text}` : text)));

  const items = toDisplay(history);
  const confirmationGeneration = orgGenerationRef.current;
  const confirmationOrganizationId = selectedOrganizationId;
  const confirmationThreadId = threadId;

  return (
    <div
      className="bc-goc fixed bottom-4 right-4 z-[9998] flex h-[min(640px,80vh)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_22px_45px_-18px_hsl(152_69%_25%/.28)]"
      data-testid="copilot-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b bg-accent px-3 py-2.5">
        <BeChiu size={32} animated blush cuaSo className="shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-bold leading-tight tracking-tight">{TEN_LINH_THU}</span>
          <span className="text-[11px] leading-snug text-muted-foreground">Trợ lý nhỏ xinh của bạn</span>
        </div>
        {/* Danh sách provider chưa về thì ô này không chọn được gì có nghĩa;
            để mở là mời người dùng bấm vào một danh sách rỗng. */}
        <select
          className="ml-auto max-w-[132px] cursor-pointer truncate rounded-full border border-[hsl(var(--primary-100))] bg-card px-2.5 py-1 text-[11px] font-semibold text-accent-foreground shadow-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!providers}
          data-testid="copilot-model-select"
        >
          {!providers && <option value={model}>Đang tải…</option>}
          {/* `model` đã được useCopilotModel thay thế nếu preference lỗi thời, nên
              nhánh này chỉ còn cho ca hiếm: danh sách đã về mà model đang chọn
              không nằm trong đó. */}
          {!!providers && !providers.some((p) => p.value === model) && (
            <option value={model}>{model}</option>
          )}
          {providers?.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {/* Ghi nhớ dài hạn. Nút luôn hiện, kể cả khi chưa có mục nào: người dùng
            phải có một chỗ cố định để hỏi "Copilot đang nhớ gì về tôi", và câu trả
            lời "chưa nhớ gì" cũng là một câu trả lời. */}
        <button
          className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--primary-100))] text-accent-foreground transition hover:-translate-y-px hover:bg-[hsl(var(--primary-50))] ${
            moGhiNho ? 'bg-[hsl(var(--primary-50))]' : 'bg-card'
          }`}
          title={`Ghi nhớ (${ghiNho.length}/${SO_GHI_NHO_TOI_DA})`}
          aria-expanded={moGhiNho}
          onClick={() => setMoGhiNho((v) => !v)}
          data-testid="copilot-ghi-nho-toggle"
        >
          <Brain className="h-4 w-4" />
          {ghiNho.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
              {ghiNho.length}
            </span>
          )}
        </button>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--primary-100))] bg-card text-accent-foreground transition hover:-translate-y-px hover:bg-[hsl(var(--primary-50))]"
          title="Cuộc trò chuyện mới"
          onClick={newThread}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--primary-100))] bg-card text-accent-foreground transition hover:-translate-y-px hover:bg-[hsl(var(--primary-50))]"
          title="Đóng"
          onClick={onClose}
          data-testid="copilot-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Mục "Ghi nhớ" — XEM và BỎA, không thêm tay.

          Thêm một mục bằng tay đòi hai ô nhập (khoá và nội dung) và một bộ luật khoá
          mà người dùng phải học — trong khi nói "nhớ giúp tôi…" trong khung chat làm
          đúng việc đó mà không cần học gì. Ngược lại, XOÁ thì phải có nút: bảo trợ lý
          quên một thứ mà phải tin rằng nó đã quên là đúng kiểu kiểm soát mà người dùng
          không xác minh được. */}
      {moGhiNho && (
        <div className="max-h-40 overflow-y-auto border-b bg-muted/40 px-3 py-2" data-testid="copilot-ghi-nho">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <Brain className="h-3.5 w-3.5" />
            Copilot đang nhớ về bạn ({ghiNho.length}/{SO_GHI_NHO_TOI_DA})
          </div>
          {ghiNho.length === 0 ? (
            <div className="text-[11px] italic text-muted-foreground">
              Chưa nhớ gì. Nói "nhớ giúp tôi: toà ưu tiên là DEMO A" để lưu một điều.
            </div>
          ) : (
            <ul className="space-y-1">
              {ghiNho.map((m) => (
                <li key={m.khoa} className="flex items-start gap-1.5 text-[11px] leading-snug">
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-semibold">{m.khoa}</span>: {m.noiDung}
                    {m.nguon === 'copilot' && (
                      <span className="ml-1 whitespace-nowrap rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                        {NHAN_COPILOT_TU_GHI}
                      </span>
                    )}
                  </span>
                  <button
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                    title={`Bỏ ghi nhớ "${m.khoa}"`}
                    onClick={() => void boMotGhiNho(m.khoa)}
                    data-testid="copilot-ghi-nho-bo"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Ô gõ tay. Có mặt vì `source` cần hai giá trị thật mới phân biệt được
              mục người dùng viết với mục Copilot tự suy ra — và vì đây là đường
              SỬA duy nhất: gõ lại cùng khoá là ghi đè. */}
          <div className="mt-2 flex items-center gap-1 border-t pt-2">
            <input
              className="w-24 shrink-0 rounded border bg-card px-1.5 py-1 text-[11px] outline-none focus:border-[hsl(var(--ring))]"
              placeholder="khoá"
              value={khoaMoi}
              onChange={(ev) => setKhoaMoi(ev.target.value)}
              data-testid="copilot-ghi-nho-khoa"
            />
            <input
              className="min-w-0 flex-1 rounded border bg-card px-1.5 py-1 text-[11px] outline-none focus:border-[hsl(var(--ring))]"
              placeholder="điều cần nhớ"
              value={noiDungMoi}
              onChange={(ev) => setNoiDungMoi(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  ev.preventDefault();
                  void themGhiNhoTay();
                }
              }}
              data-testid="copilot-ghi-nho-noi-dung"
            />
            <button
              className="shrink-0 rounded bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
              disabled={!khoaMoi.trim() || !noiDungMoi.trim()}
              onClick={() => void themGhiNhoTay()}
              data-testid="copilot-ghi-nho-them"
            >
              Lưu
            </button>
          </div>
        </div>
      )}

      {/* Model đã lưu không còn được bật: nói ra thay vì lặng lẽ đổi. Người
          dùng cần biết vì sao hôm nay Copilot trả lời khác hôm qua. */}
      {modelLoiThoi && (
        <div className="border-b bg-[hsl(var(--status-warning-bg))] px-3 py-1.5 text-xs text-[hsl(var(--status-warning-fg))]">
          {modelThayThe
            ? `Đang dùng tạm ${modelThayThe} vì model đã chọn không khả dụng. Chọn lại ở ô trên để lưu.`
            : 'Model bạn chọn trước đây không còn được bật — đang tạm dùng model mặc định. Chọn lại ở ô trên để lưu.'}
        </div>
      )}

      {/* Quyền công cụ hết hạn thì Copilot lặng lẽ mất sạch tool. Nói ra ngay,
          nhưng KHÔNG chặn gõ — chỗ chặn là lúc bấm gửi. */}
      {!!selectedOrganizationId && !quyetDinhGuiTheoAvailability(availability ?? null, Date.now()).guiDuoc && (
        <div
          className="border-b bg-[hsl(var(--status-warning-bg))] px-3 py-1.5 text-[11px] text-[hsl(var(--status-warning-fg))]"
          data-testid="copilot-quyen-chua-tuoi"
        >
          Quyền công cụ đang được làm mới…
        </div>
      )}

      {/* Toggle UI-control (experimental) — chỉ hiện khi có entitlement + quyền */}
      {canUiControl && (
        <label className="flex cursor-pointer items-center gap-2 border-b bg-[hsl(var(--status-warning-bg))] px-3 py-1.5 text-[11px] text-[hsl(var(--status-warning-fg))]">
          <input
            type="checkbox"
            className="sr-only"
            checked={uiMode}
            onChange={(e) => setUiMode(e.target.checked)}
            disabled={running}
            data-testid="copilot-uimode"
          />
          <span className="bc-switch" aria-hidden="true" />
          Điều khiển trang (thử nghiệm) — chỉ điều hướng & lọc, mỗi lệnh độc lập
        </label>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3.5 text-sm leading-relaxed">
        {dangTaiLichSu && items.length === 0 && (
          <div
            className="flex h-full items-center justify-center text-xs italic text-muted-foreground"
            data-testid="copilot-dang-tai-lich-su"
          >
            Đang tải lịch sử…
          </div>
        )}
        {items.length === 0 && !running && !dangTaiLichSu && (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-3 text-center">
            <BeChiu size={96} animated smoke blush cuaSo shadow />
            <div className="flex flex-col gap-1.5">
              <div className="text-lg font-bold tracking-tight">Chào bạn, mình là {TEN_LINH_THU}!</div>
              <div className="max-w-[300px] text-[13px] leading-normal text-muted-foreground">
                Hỏi mình về phòng trống, hoá đơn, hợp đồng sắp hết hạn, doanh thu tháng hay cách dùng hệ thống nhé.
              </div>
            </div>
            <div className="grid grid-cols-[auto_auto] justify-center gap-2">
              {SUGGESTION_CHIPS.map(({ text, Icon, mau }) => (
                <button
                  key={text}
                  className={`bc-chip ${mau}`}
                  onClick={() => setInput(text)}
                  data-testid="copilot-chip"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {text}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ImagePlus className="h-3.5 w-3.5" />
              Dán hoặc kéo ảnh công tơ, biên lai vào đây
            </div>
          </div>
        )}
        {items.map((it, i) =>
          it.kind === 'tool' ? (
            <div key={i} className="text-xs italic text-muted-foreground">⚙ {it.text}</div>
          ) : it.kind === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[82%] break-words rounded-[14px] rounded-tr-[4px] bg-primary px-3 py-2 text-primary-foreground shadow-[0_6px_14px_-8px_hsl(152_69%_25%/.5)]">
                <MiniMarkdown text={it.text} />
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start gap-2">
              <BeChiu size={24} className="mt-0.5 shrink-0" />
              <div className="max-w-[82%] break-words rounded-[14px] rounded-tl-[4px] bg-muted px-3 py-2">
                <MiniMarkdown text={it.text} />
              </div>
            </div>
          ),
        )}
        {/* Bong bóng "đang chảy": cùng khuôn với bong bóng trả lời thật, nên
            lúc chốt vào history chữ không nhảy chỗ. */}
        {dangChay && (
          <div className="flex justify-start gap-2">
            <BeChiu size={24} className="mt-0.5 shrink-0" />
            <div className="max-w-[82%] break-words rounded-[14px] rounded-tl-[4px] bg-muted px-3 py-2">
              <MiniMarkdown text={dangChay} />
            </div>
          </div>
        )}
        {running && !dangChay && (
          <div className="flex items-center justify-start gap-2">
            <BeChiu size={24} eyes="nham" className="shrink-0" />
            <div className="flex items-center gap-[5px] rounded-[14px] rounded-tl-[4px] bg-muted px-[13px] py-[11px]">
              <span className="bc-dot" />
              <span className="bc-dot" style={{ animationDelay: '.15s' }} />
              <span className="bc-dot" style={{ animationDelay: '.3s' }} />
            </div>
            <span className="text-[11px] italic text-muted-foreground">
              {liveTool ? `Đang tra cứu: ${liveTool}…` : `${TEN_LINH_THU} đang nghĩ…`}
            </span>
          </div>
        )}
        {/* Thẻ xác nhận GHI. Đặt sau tin nhắn cuối và trước điểm cuộn để nó
            luôn nằm trong tầm mắt ngay khi xuất hiện — một nút xác nhận nằm
            ngoài màn hình là một nút không ai bấm. Nonce đi qua bộ nhớ, không
            qua chuỗi trả về của tool, nên mô hình không chạm được vào đây. */}
        {!running && (
          <XacNhanPhieuCard
            organizationId={selectedOrganizationId}
            threadId={threadId}
            generation={confirmationGeneration}
            availability={availability}
            onXong={(thongBao) => {
              if (
                !isCurrentChatScope(
                  confirmationGeneration,
                  orgGenerationRef.current,
                  confirmationOrganizationId,
                  selectedOrganizationId,
                )
              ) return;
              if (confirmationThreadId !== threadId) return;
              setHistory((h) => [...h, { role: 'assistant', content: thongBao }]);
            }}
          />
        )}
        {error && <div className="rounded bg-red-50 p-2 text-xs text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Ảnh đã đính kèm cho lượt sắp gửi. Nhắc rõ ảnh KHÔNG được lưu — người
          dùng cần biết trước khi gửi ảnh giấy tờ. */}
      {anhKem.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5" data-testid="copilot-anh-kem">
          {anhKem.map((a, i) => (
            <div key={i} className="relative">
              <img src={a.dataUrl} alt="" className="h-12 w-12 rounded border object-cover" />
              <button
                className="absolute -right-1 -top-1 rounded-full bg-black/70 p-0.5 text-white"
                title="Bỏ ảnh này"
                onClick={() => setAnhKem((cu) => cu.filter((_, j) => j !== i))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <span className="text-xs text-muted-foreground">Ảnh chỉ dùng cho câu hỏi này, không được lưu lại.</span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-end gap-2 border-t p-2.5">
        <textarea
          className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-transparent bg-muted px-3 py-2 text-base leading-snug text-foreground outline-none focus:border-[hsl(var(--ring))] focus:bg-card"
          rows={1}
          placeholder={uiMode ? 'Lệnh điều khiển, vd "mở trang phòng"…' : `Hỏi ${TEN_LINH_THU} điều gì đó…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          onPaste={(e) => {
            const files = anhTuDataTransfer(e.clipboardData);
            if (files.length) {
              e.preventDefault();
              void themAnh(files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const files = anhTuDataTransfer(e.dataTransfer);
            if (files.length) {
              e.preventDefault();
              void themAnh(files);
            }
          }}
          data-testid="copilot-input"
        />
        {/* Nút chọn ảnh. Dán và kéo-thả KHÔNG tồn tại trên điện thoại, mà chụp
            ảnh công tơ bằng điện thoại đúng là ca dùng chính của tính năng này —
            thiếu nút này thì vision chỉ chạy được trên máy bàn.
            `capture="environment"` để điện thoại mở thẳng camera sau. */}
        {!running && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => {
                void themAnh(Array.from(e.target.files ?? []));
                e.target.value = ''; // cho chọn lại đúng file vừa bỏ ra
              }}
              data-testid="copilot-file"
            />
            <button
              className="rounded-full p-2 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
              title="Gửi ảnh (công tơ, biên lai…)"
              onClick={() => fileRef.current?.click()}
              data-testid="copilot-chon-anh"
            >
              <ImagePlus className="h-[17px] w-[17px]" />
            </button>
          </>
        )}
        {voice.supported && !running && (
          <button
            className={`rounded-full p-2 transition ${
              voice.listening
                ? 'bg-red-100 text-red-600'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            title={voice.listening ? 'Đang nghe… (bấm để dừng)' : 'Nói tiếng Việt'}
            onClick={voice.toggle}
          >
            {voice.listening ? <MicOff className="h-[17px] w-[17px]" /> : <Mic className="h-[17px] w-[17px]" />}
          </button>
        )}
        {running ? (
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-600 text-white"
            title="Dừng"
            onClick={stopRun}
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_14px_-6px_hsl(152_69%_25%/.6)] transition hover:bg-[hsl(var(--primary-600))] disabled:opacity-50"
            disabled={!input.trim() && !anhKem.length}
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
