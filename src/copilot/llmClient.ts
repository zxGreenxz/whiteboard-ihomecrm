// Client OpenAI-compat MỎNG cho chat mode — nói thẳng với Edge Function
// `llm-proxy`, không qua `LLM` class của @page-agent/llms.
//
// VÌ SAO KHÔNG DÙNG TIẾP `LLM` CLASS. Đọc file kiểu của nó (v1.11.0) thì thấy ba
// giới hạn, và chúng chặn đúng ba thứ Copilot cần:
//   - `invoke()` trả về một Promise, không có đường stream ⇒ người dùng ngồi
//     nhìn spinner cho tới khi câu trả lời xong hẳn. Nghịch lý là `llm-proxy`
//     ĐÃ hỗ trợ SSE đầy đủ từ Phase 4 (TEE parse usage, propagate abort) —
//     nhưng không ai gọi, nên đó là code chết.
//   - `Message.content?: string | null` ⇒ không gửi được ảnh.
//   - `InvokeResult.toolCall` là MỘT object số ít ⇒ khi mô hình xin nhiều tool
//     cùng lúc, các cái sau bị bỏ im lặng. Đã đo thật ngày 12/08/2026:
//     `cx/gpt-5.6-sol(max)` trả về hai `tool_calls` trong một lượt cho câu hỏi
//     doanh thu. Mô hình càng khoẻ thì càng lãng phí.
//
// `LLM` class và `PageAgent` VẪN dùng cho UI-control — file này không đụng tới.
import { LLM_PROXY_BASE, LOCAL_PROVIDER_BASES, makeCopilotFetch, parseProviderModel } from './copilotConfig';

// ── Kiểu tin nhắn ───────────────────────────────────────────────────────────
// Tương thích OpenAI, nhưng `content` nhận cả mảng multimodal (chuẩn bị cho
// ảnh). Giữ hình dạng khớp `Message` của @page-agent/llms để phần lưu lịch sử
// trong chatEngine không phải viết lại.

export interface PhanChu { type: 'text'; text: string }
export interface PhanAnh { type: 'image_url'; image_url: { url: string } }
export type NoiDung = string | (PhanChu | PhanAnh)[] | null;

export interface LoiGoiTool {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface TinNhan {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: NoiDung;
  tool_calls?: LoiGoiTool[];
  tool_call_id?: string;
}

export interface KhaiBaoTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface MucDung {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface KetQuaLuot {
  /** Văn bản mô hình trả (rỗng khi nó chỉ gọi tool). */
  content: string;
  /** Mọi tool mô hình xin gọi trong lượt này — MẢNG, không phải một cái. */
  toolCalls: LoiGoiTool[];
  usage: MucDung;
  finishReason: string | null;
}

// ── Bộ gom SSE (THUẦN — trái tim testable của file này) ─────────────────────
//
// Tách riêng khỏi phần mạng để test được bằng Vitest mà không cần server: đưa
// vào một dãy chuỗi `data:` y như thật, đòi ra đúng kết quả gom.
//
// Chỗ khó của SSE tool-call là `arguments` về theo TỪNG MẢNH và phải nối theo
// `index`, không phải theo `id` (nhiều nhà cung cấp chỉ gửi `id` ở mảnh đầu).
// Nối nhầm khoá là lỗi im lặng: JSON vẫn parse được nhưng tham số lẫn giữa hai
// tool.
export class BoGomSSE {
  private noiDung = '';
  private theoIndex = new Map<number, { id: string; name: string; args: string }>();
  private mucDung: MucDung = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private lyDoDung: string | null = null;

  /** Nạp một payload JSON đã bóc khỏi dòng `data: ` (bỏ qua `[DONE]`). */
  napChunk(payload: unknown): { deltaChu?: string } {
    const chunk = payload as {
      choices?: { delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    if (chunk.usage) {
      this.mucDung = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return {};
    if (choice.finish_reason) this.lyDoDung = choice.finish_reason;

    let deltaChu: string | undefined;
    const c = choice.delta?.content;
    if (typeof c === 'string' && c.length > 0) {
      this.noiDung += c;
      deltaChu = c;
    }

    for (const tcRaw of choice.delta?.tool_calls ?? []) {
      const tc = tcRaw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      // `index` là khoá nối. Thiếu nó (một số bản trả thiếu) thì coi như 0 —
      // vẫn đúng cho trường hợp một tool, và không tệ hơn việc vứt mảnh đi.
      const idx = tc.index ?? 0;
      const cu = this.theoIndex.get(idx) ?? { id: '', name: '', args: '' };
      this.theoIndex.set(idx, {
        id: tc.id || cu.id,
        name: tc.function?.name || cu.name,
        args: cu.args + (tc.function?.arguments ?? ''),
      });
    }

    return deltaChu === undefined ? {} : { deltaChu };
  }

  ketQua(): KetQuaLuot {
    const toolCalls: LoiGoiTool[] = [...this.theoIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, t]) => t.name) // mảnh rác không có tên hàm thì bỏ
      .map(([idx, t]) => ({
        // Thiếu `id` thì tự sinh ổn định theo index: message `tool` bắt buộc
        // phải khớp `tool_call_id`, không có id là cả lượt hỏng.
        id: t.id || `call_${idx}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.args || '{}' },
      }));
    return {
      content: this.noiDung,
      toolCalls,
      usage: this.mucDung,
      finishReason: this.lyDoDung,
    };
  }
}

/**
 * Tách các dòng `data:` hoàn chỉnh ra khỏi bộ đệm SSE.
 *
 * Trả về phần đuôi CHƯA trọn dòng để người gọi giữ lại — chunk mạng cắt giữa
 * dòng là chuyện bình thường, và bỏ qua điều đó là mất token cuối một cách
 * ngẫu nhiên.
 */
export function tachDongSSE(dem: string): { payloads: string[]; conLai: string } {
  const payloads: string[] = [];
  let conLai = dem;
  let nl: number;
  while ((nl = conLai.indexOf('\n')) >= 0) {
    const dong = conLai.slice(0, nl).trim();
    conLai = conLai.slice(nl + 1);
    if (!dong.startsWith('data:')) continue;
    const payload = dong.slice(5).trim();
    if (payload && payload !== '[DONE]') payloads.push(payload);
  }
  return { payloads, conLai };
}

// ── Gọi mạng ────────────────────────────────────────────────────────────────

export interface ThamSoGoi {
  /** "provider:model-id" — proxy tự route. */
  providerModel: string;
  messages: TinNhan[];
  tools: KhaiBaoTool[];
  signal: AbortSignal;
  /** Nhận từng mảnh văn bản khi mô hình trả lời (chỉ gọi ở chế độ stream). */
  onDeltaChu?: (chu: string) => void;
  maxTokens?: number;
  /**
   * Công ty đang chọn — đi lên proxy qua `x-organization-id` rồi vào
   * `reserve_ai_usage`. `null` nghĩa là CHƯA chốt được, không phải "công ty mặc
   * định": proxy sẽ trả 400 `organization_required`, và đó là câu trả lời đúng.
   * Nhánh local (Ollama) không dùng trường này — nó không đi qua proxy.
   */
  organizationId: string | null;
}

/** Lỗi mang mã của proxy để chỗ gọi phân biệt hết-hạn-mức với lỗi mạng. */
export class LoiModel extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'LoiModel';
  }
}

async function nemLoiTheoBody(res: Response): Promise<never> {
  const text = await res.text();
  let code: string | null = null;
  let message = `HTTP ${res.status}`;
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
    code = j.error?.code ?? null;
    message = j.error?.message ?? message;
  } catch {
    if (text) message = text.slice(0, 300);
  }
  throw new LoiModel(message, res.status, code);
}

/**
 * Gọi mô hình MỘT lượt. Luôn dùng stream: lúc gửi request ta chưa biết mô hình
 * sẽ gọi tool hay trả lời thẳng, nên cứ stream rồi phân loại theo cái nhận
 * được — đó cũng là cách duy nhất để chữ hiện dần mà vẫn nhận được tool call.
 */
export async function goiModelMotLuot(p: ThamSoGoi): Promise<KetQuaLuot> {
  const parsed = parseProviderModel(p.providerModel);
  if (!parsed) throw new LoiModel(`Model không hợp lệ: "${p.providerModel}"`, 400, 'bad_model');

  const localBase = LOCAL_PROVIDER_BASES[parsed.provider];
  const isLocal = !!localBase;
  const base = isLocal ? localBase : LLM_PROXY_BASE;
  // local_only (Ollama): browser gọi thẳng localhost, KHÔNG qua proxy nên cũng
  // không gắn JWT — đó là lý do fetch khác nhau ở hai nhánh.
  const fetchFn = isLocal ? fetch : makeCopilotFetch('chat', newTaskIdChat(), p.organizationId);

  const body: Record<string, unknown> = {
    model: isLocal ? parsed.modelId : p.providerModel,
    messages: p.messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: p.maxTokens ?? 4096,
  };
  if (p.tools.length) {
    body.tools = p.tools;
    // 'auto' chứ KHÔNG phải 'required': mô hình phải được phép trả lời thẳng
    // bằng văn bản. Ép gọi tool là lý do bản cũ cần một tool giả tên `respond`,
    // và cũng là lý do câu trả lời cuối về dưới dạng JSON — không stream nổi.
    body.tool_choice = 'auto';
  }

  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: p.signal,
  });

  if (!res.ok || !res.body) await nemLoiTheoBody(res);

  const bo = new BoGomSSE();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let dem = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      dem += decoder.decode(value, { stream: true });
      const { payloads, conLai } = tachDongSSE(dem);
      dem = conLai;
      for (const raw of payloads) {
        let parsedChunk: unknown;
        try {
          parsedChunk = JSON.parse(raw);
        } catch {
          continue; // mảnh dở — bỏ qua, dòng sau sẽ tới
        }
        const { deltaChu } = bo.napChunk(parsedChunk);
        if (deltaChu) p.onDeltaChu?.(deltaChu);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return bo.ketQua();
}

// Tránh import vòng: `newTaskId` nằm ở copilotConfig cùng `makeCopilotFetch`,
// nhưng gói lại ở đây cho chỗ gọi khỏi phải tự nghĩ ra tiền tố.
function newTaskIdChat(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
