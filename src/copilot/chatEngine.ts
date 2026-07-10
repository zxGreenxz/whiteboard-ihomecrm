// Chat engine — R8 PLAN.md v2.1: TÁI DÙNG LLM class của @page-agent/llms
// (Message/Tool/zod conversion/validation/usage/error-mapping/retry có sẵn)
// + tool "respond" kiểu built-in done → loop đến khi model gọi respond.
import { LLM, type Message } from '@page-agent/llms';
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import {
  LLM_PROXY_BASE,
  OLLAMA_BASE,
  makeCopilotFetch,
  newTaskId,
  parseProviderModel,
} from './copilotConfig';
import { CHAT_SYSTEM_PROMPT } from './systemPromptVi';
import { buildRegistry, toLlmTools, type ToolCtx } from './tools/registry';

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
    const blockChars = block.reduce((s, m) => s + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
    if (chars + blockChars > maxChars && out.length > 0) break;
    out.unshift(block);
    chars += blockChars;
  }
  return out.flat();
}

/** Chạy MỘT lượt chat: user hỏi → (tool*) → respond. */
export async function runChatTurn(params: {
  providerModel: string; // "provider:model-id"
  history: Message[];    // các lượt trước (không gồm system)
  userText: string;
  ctx: ToolCtx;
  signal: AbortSignal;
  onToolEvent?: (ev: ChatToolEvent) => void;
}): Promise<ChatTurnResult> {
  const parsed = parseProviderModel(params.providerModel);
  if (!parsed) throw new Error(`Model không hợp lệ: "${params.providerModel}"`);
  const isLocal = parsed.provider === 'ollama';
  const taskId = newTaskId('chat');

  const llm = new LLM({
    baseURL: isLocal ? OLLAMA_BASE : LLM_PROXY_BASE,
    // local_only: browser → localhost, KHÔNG qua proxy; cloud: model giữ nguyên
    // "provider:model" để proxy route.
    model: isLocal ? parsed.modelId : params.providerModel,
    apiKey: 'unused-behind-proxy',
    maxRetries: 2, // retry CHỈ ở client — proxy không retry (F4)
    customFetch: isLocal ? undefined : makeCopilotFetch('chat', taskId),
  });

  const registry = buildRegistry();
  const tools = toLlmTools(registry, params.ctx);

  let finalText = '';
  const respondTool = {
    description:
      'Trả lời CUỐI CÙNG cho người dùng. Gọi tool này khi đã đủ dữ liệu — text là toàn bộ câu trả lời (markdown, tiếng Việt).',
    inputSchema: z.object({ text: z.string().min(1) }),
    execute: async (args: { text: string }) => {
      finalText = args.text;
      return 'OK';
    },
  };

  const messages: Message[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...buildChatContext(params.history),
    { role: 'user', content: params.userText },
  ];
  const newMessages: Message[] = [{ role: 'user', content: params.userText }];

  const toolEvents: ChatToolEvent[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await llm.invoke(
      messages,
      { ...tools, respond: respondTool },
      params.signal,
    );
    usage.promptTokens += result.usage.promptTokens;
    usage.completionTokens += result.usage.completionTokens;
    usage.totalTokens += result.usage.totalTokens;

    const { name, args } = result.toolCall;
    if (name === 'respond') {
      const respondMsg: Message = { role: 'assistant', content: finalText };
      newMessages.push(respondMsg);
      return { text: finalText, toolEvents, usage, newMessages };
    }

    const output = String(result.toolResult ?? '');
    const ev = { tool: name, args, output };
    toolEvents.push(ev);
    params.onToolEvent?.(ev);

    const callId = `call_${round}_${Date.now().toString(36)}`;
    const assistantMsg: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } }],
    };
    const toolMsg: Message = { role: 'tool', tool_call_id: callId, content: output.slice(0, 12_000) };
    messages.push(assistantMsg, toolMsg);
    newMessages.push(assistantMsg, toolMsg);
  }

  // Hết vòng mà chưa respond → ép trả lời từ dữ liệu đã có
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

export async function createThread(title: string): Promise<ThreadRow> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');
  const { data, error } = await supabase
    .from('ai_chat_threads')
    .insert({ user_id: userId, title: title.slice(0, 120) })
    .select('id, title, updated_at')
    .single();
  if (error) throw error;
  return data;
}

export async function saveMessages(threadId: string, msgs: Message[], model: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');
  const rows = msgs.map((m) => ({
    thread_id: threadId,
    user_id: userId,
    role: m.role,
    content: m.content ?? null,
    tool_calls: m.tool_calls ?? null,
    tool_call_id: m.tool_call_id ?? null,
    model,
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
