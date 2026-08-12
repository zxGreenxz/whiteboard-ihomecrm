// Chat engine — nói thẳng OpenAI-compat với `llm-proxy` qua `llmClient`.
//
// Bản trước dùng `LLM` class của @page-agent/llms và một tool giả tên `respond`
// làm dấu "xong". Cái tool giả đó không phải lựa chọn thiết kế mà là hệ quả:
// `LLM.invoke` ép `tool_choice: 'required'`, nên mô hình BUỘC phải gọi một tool
// gì đó, kể cả khi nó chỉ muốn trả lời. Hệ quả kéo theo là câu trả lời cuối về
// dưới dạng tham số JSON của tool — thứ không stream ra chữ được (người dùng sẽ
// thấy `{"text":"Xin ch…`).
//
// Nay `tool_choice: 'auto'`: mô hình gọi tool khi cần dữ liệu, trả lời thẳng
// bằng `content` khi đã đủ. Không còn `respond`, và chữ chảy dần được.
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import { CHAT_SYSTEM_PROMPT } from './systemPromptVi';
import { goiModelMotLuot, type KhaiBaoTool, type TinNhan } from './llmClient';
import { dongNguCanhTrang } from './banDoHeThong';
import { buildRegistry, toLlmTools, type ToolCtx } from './tools/registry';

/** Kiểu tin nhắn dùng chung trong chat mode (tương thích OpenAI). */
export type Message = TinNhan;

export interface ChatToolEvent {
  tool: string;
  args: unknown;
  output: string;
}

export interface ChatTurnResult {
  text: string;
  toolEvents: ChatToolEvent[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Các message sinh ra trong lượt này (đã gồm user + assistant/tool + respond). */
  newMessages: Message[];
}

const MAX_TOOL_ROUNDS = 6;

/**
 * Độ dài "tính theo ký tự" của một `content`.
 *
 * `content` có thể là chuỗi, hoặc mảng multimodal (chuẩn bị cho ảnh). Với mảng
 * thì `.length` là SỐ PHẦN TỬ — dùng nó làm ngân sách ký tự sẽ coi một ảnh
 * base64 nửa megabyte là "1 ký tự" và ngân sách ngữ cảnh mất tác dụng đúng lúc
 * cần nhất.
 */
export function doDaiNoiDung(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return JSON.stringify(content).length;
  return 0;
}

/**
 * Cắt history cho context: giữ NGUYÊN VẸN từng "block" (user-message hoặc
 * assistant-tool_calls + các tool-reply của nó) — không bao giờ tách cặp
 * tool_calls ↔ tool (v2.1 F7). System KHÔNG nằm trong history (truyền riêng).
 */
export function buildChatContext(
  history: Message[],
  opts: { maxTurns?: number; maxChars?: number } = {},
): Message[] {
  const maxTurns = opts.maxTurns ?? 12;
  const maxChars = opts.maxChars ?? 16_000;

  // Gom block: 'user'/'assistant'(text) đứng riêng; 'assistant' có tool_calls
  // kéo theo các message 'tool' ngay sau nó.
  const blocks: Message[][] = [];
  for (const msg of history) {
    if (msg.role === 'tool' && blocks.length && blocks[blocks.length - 1].some((m) => m.tool_calls?.length)) {
      blocks[blocks.length - 1].push(msg);
    } else {
      blocks.push([msg]);
    }
  }

  const out: Message[][] = [];
  let chars = 0;
  for (let i = blocks.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const block = blocks[i];
    const blockChars = block.reduce((s, m) => s + doDaiNoiDung(m.content) + JSON.stringify(m.tool_calls ?? '').length, 0);
    if (chars + blockChars > maxChars && out.length > 0) break;
    out.unshift(block);
    chars += blockChars;
  }
  return out.flat();
}

/** Giới hạn ký tự cho MỘT kết quả tool nhét vào ngữ cảnh. */
const CAP_KET_QUA_TOOL = 12_000;

/**
 * Đổi registry tool (schema zod) sang khai báo hàm kiểu OpenAI.
 *
 * `io: 'input'` là chi tiết quan trọng: nó khiến trường có `.default()` KHÔNG bị
 * xếp vào `required`. Lấy schema đầu ra sẽ bắt mô hình luôn phải truyền
 * `xac_nhan`, tức phá đúng cái mặc-định-an-toàn `xac_nhan = false` của write tool.
 */
export function toolSangKhaiBao(
  tools: Record<string, { description: string; inputSchema: z.ZodType<unknown> }>,
): KhaiBaoTool[] {
  return Object.entries(tools).map(([name, t]) => {
    const schema = z.toJSONSchema(t.inputSchema, { io: 'input' }) as Record<string, unknown>;
    delete schema.$schema; // khoá meta, không nhà cung cấp nào cần
    return { type: 'function' as const, function: { name, description: t.description, parameters: schema } };
  });
}

/**
 * Chạy MỘT lượt chat: user hỏi → (tool*) → mô hình trả lời bằng văn bản.
 *
 * Tool trong cùng một vòng chạy SONG SONG. Mô hình thường xin nhiều thứ một lúc
 * ("doanh thu toà X" + "phòng trống toà X"); chạy tuần tự thì độ trễ cộng dồn vô
 * ích vì chúng không phụ thuộc nhau.
 */
export async function runChatTurn(params: {
  providerModel: string; // "provider:model-id"
  history: Message[];    // các lượt trước (không gồm system)
  userText: string;
  ctx: ToolCtx;
  signal: AbortSignal;
  onToolEvent?: (ev: ChatToolEvent) => void;
  /** Từng mảnh chữ mô hình trả — để UI hiện dần thay vì đợi xong. */
  onDeltaChu?: (chu: string) => void;
  /** Đường dẫn trang người dùng đang xem, để hiểu "cái này", "ở đây". */
  pathname?: string;
}): Promise<ChatTurnResult> {
  const registry = buildRegistry();
  const toolMap = toLlmTools(registry, params.ctx);
  const khaiBao = toolSangKhaiBao(toolMap);

  // Ngữ cảnh trang đi vào system prompt chứ không thành tool: nó là MỘT DÒNG và
  // luôn đúng, bắt mô hình gọi tool để biết mình đang ở đâu là thêm một vòng
  // mạng cho một sự thật đã nằm sẵn trong tay.
  const nguCanh = params.pathname
    ? dongNguCanhTrang(params.pathname, params.ctx.perms)
    : null;

  const messages: Message[] = [
    { role: 'system', content: nguCanh ? `${CHAT_SYSTEM_PROMPT}\n\n${nguCanh}` : CHAT_SYSTEM_PROMPT },
    ...buildChatContext(params.history),
    { role: 'user', content: params.userText },
  ];
  const newMessages: Message[] = [{ role: 'user', content: params.userText }];

  const toolEvents: ChatToolEvent[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const kq = await goiModelMotLuot({
      providerModel: params.providerModel,
      messages,
      tools: khaiBao,
      signal: params.signal,
      onDeltaChu: params.onDeltaChu,
    });
    usage.promptTokens += kq.usage.promptTokens;
    usage.completionTokens += kq.usage.completionTokens;
    usage.totalTokens += kq.usage.totalTokens;

    // Không xin tool nữa ⇒ đây là câu trả lời.
    if (kq.toolCalls.length === 0) {
      const text = kq.content.trim();
      const cuoi: Message = { role: 'assistant', content: text };
      newMessages.push(cuoi);
      return { text, toolEvents, usage, newMessages };
    }

    // Mô hình có thể vừa nói một câu dẫn ("để tôi tra…") vừa gọi tool. Giữ câu
    // đó trong message: nó đã hiện trên màn hình rồi, bỏ đi thì lịch sử tải lại
    // sẽ khác những gì người dùng đã đọc.
    const assistantMsg: Message = {
      role: 'assistant',
      content: kq.content || null,
      tool_calls: kq.toolCalls,
    };
    messages.push(assistantMsg);
    newMessages.push(assistantMsg);

    // SONG SONG. Mỗi tool tự nuốt lỗi của mình thành text: một tool hỏng không
    // được làm hỏng cả lượt, và mô hình cần ĐỌC được lỗi để đổi cách hỏi.
    const ketQua = await Promise.all(
      kq.toolCalls.map(async (tc): Promise<Message> => {
        const ten = tc.function.name;
        let args: unknown = {};
        let output: string;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          output = `Lỗi: tham số không phải JSON hợp lệ (${tc.function.arguments.slice(0, 200)}).`;
          const evLoi = { tool: ten, args, output };
          toolEvents.push(evLoi);
          params.onToolEvent?.(evLoi);
          return { role: 'tool', tool_call_id: tc.id, content: output };
        }
        const tool = toolMap[ten];
        if (!tool) {
          output = `Lỗi: không có công cụ tên "${ten}" (hoặc bạn không có quyền dùng).`;
        } else {
          try {
            const parsedArgs = tool.inputSchema.parse(args);
            output = String(await tool.execute(parsedArgs));
          } catch (e) {
            output = `Lỗi khi chạy "${ten}": ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        const ev = { tool: ten, args, output };
        toolEvents.push(ev);
        params.onToolEvent?.(ev);
        return { role: 'tool', tool_call_id: tc.id, content: output.slice(0, CAP_KET_QUA_TOOL) };
      }),
    );

    // Mọi tool_call phải có ĐÚNG một message `tool` khớp `tool_call_id`, nếu
    // không nhà cung cấp từ chối cả lượt sau.
    messages.push(...ketQua);
    newMessages.push(...ketQua);
  }

  // Hết vòng mà mô hình vẫn chưa chốt → trả thẳng dữ liệu đã gom, đừng im lặng.
  const fallback =
    toolEvents.length > 0
      ? `Kết quả tra cứu:\n${toolEvents[toolEvents.length - 1].output.slice(0, 4000)}`
      : 'Xin lỗi, tôi chưa trả lời được câu hỏi này (quá số vòng công cụ cho phép).';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, toolEvents, usage, newMessages };
}

// ── Persistence (ai_chat_threads/messages — RLS own; seq = identity DB) ──────

export interface ThreadRow { id: string; title: string | null; updated_at: string }

export async function loadLatestThread(): Promise<ThreadRow | null> {
  const { data, error } = await supabase
    .from('ai_chat_threads')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * `organizationId` là TUỲ CHỌN vì database đã tự suy được cho người thuộc đúng
 * một tổ chức (trigger app_private.autofill_org_chat, 20260809040000). Nó chỉ
 * BẮT BUỘC với người thuộc NHIỀU tổ chức — lúc đó chỉ client mới biết đang chat
 * trong ngữ cảnh nào, và trigger sẽ từ chối ghi thay vì đoán bừa.
 *
 * Truyền lên đây KHÔNG phải hàng rào: trigger mới là hàng rào, và nó kiểm lại
 * rằng người dùng thật sự có membership ACTIVE ở tổ chức được khai.
 */
export async function createThread(title: string, organizationId?: string | null): Promise<ThreadRow> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');
  const { data, error } = await supabase
    .from('ai_chat_threads')
    .insert({
      user_id: userId,
      title: title.slice(0, 120),
      ...(organizationId ? { organization_id: organizationId } : {}),
    })
    .select('id, title, updated_at')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Ép `content` về chuỗi để lưu — cột `ai_chat_messages.content` là text.
 *
 * Với tin nhắn multimodal, phần ảnh KHÔNG được lưu: một data URL ảnh là hàng
 * trăm KB base64, và lưu nó biến bảng lịch sử chat thành kho ảnh có kèm bài
 * toán retention/PII mà chưa ai thiết kế. Giữ lại phần chữ, đánh dấu chỗ có ảnh
 * để đọc lại lịch sử vẫn hiểu được mạch hội thoại.
 */
export function noiDungDeLuu(content: Message['content']): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const phan = content.map((p) => (p.type === 'text' ? p.text : '[ảnh]'));
  return phan.join('\n') || null;
}

export async function saveMessages(
  threadId: string,
  msgs: Message[],
  model: string,
  organizationId?: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');
  const rows = msgs.map((m) => ({
    thread_id: threadId,
    user_id: userId,
    role: m.role,
    content: noiDungDeLuu(m.content),
    tool_calls: m.tool_calls ?? null,
    tool_call_id: m.tool_call_id ?? null,
    model,
    // Tin nhắn vốn kế thừa tổ chức của LUỒNG cha nên thường không cần; gửi kèm
    // để đường ghi không phụ thuộc vào việc luồng đã có nhãn hay chưa.
    ...(organizationId ? { organization_id: organizationId } : {}),
  }));
  const { error } = await supabase.from('ai_chat_messages').insert(rows as any);
  if (error) throw error;
}

/** Dựng lại Message[] từ rows DB (order theo seq — identity toàn cục). */
export function rowsToMessages(
  rows: { role: string; content: string | null; tool_calls: unknown; tool_call_id: string | null }[],
): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
    ...(r.tool_calls ? { tool_calls: r.tool_calls as Message['tool_calls'] } : {}),
    ...(r.tool_call_id ? { tool_call_id: r.tool_call_id } : {}),
  }));
}

export async function loadThreadMessages(threadId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('ai_chat_messages')
    .select('role, content, tool_calls, tool_call_id')
    .eq('thread_id', threadId)
    .order('seq', { ascending: true })
    .limit(200);
  if (error) throw error;
  return rowsToMessages((data ?? []) as any);
}
