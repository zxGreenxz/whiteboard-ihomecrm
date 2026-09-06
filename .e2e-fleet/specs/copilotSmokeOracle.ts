import { hrefAnToan } from '../../src/copilot/hrefAnToan';
// Pure assertions shared by the real browser smoke and controlled negative tests.
// A transport or quota failure is failure evidence, never a reason to upgrade models.
interface Tool { id: string; name: string }
interface Stream { tools: Tool[]; text: string; finish: string }
interface ModelMessage { role: string; content?: unknown; tool_call_id?: string }
export interface ReadonlyEvidence {
  prompt: string;
  answer: string;
  rounds: { body: string; messages: ModelMessage[] }[];
  payload: unknown;
}
function requireEvidence(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function inspectModelStream(body: string): Stream {
  let done = false;
  let text = '';
  let finish = '';
  const tools = new Map<number, Tool>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    const chunk = JSON.parse(data);
    requireEvidence(!chunk.error, 'Provider error in HTTP 200 stream');
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.delta?.content === 'string') text += choice.delta.content;
      for (const part of choice.delta?.tool_calls ?? []) {
        const tool = tools.get(part.index) ?? { id: '', name: '' };
        tool.id += part.id ?? ''; tool.name += part.function?.name ?? '';
        tools.set(part.index, tool);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  requireEvidence(done, 'Stream missing DONE');
  requireEvidence(['stop', 'tool_calls'].includes(finish), 'Stream did not finish successfully');
  requireEvidence(text.trim() || tools.size, 'Stream contains no answer or tool call');
  return { text, tools: [...tools.values()], finish };
}
/** Match MiniMarkdown: only safe links become labels; unsafe syntax stays text. */
export function renderedAssistantText(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (syntax, label: string, href: string) => hrefAnToan(href) ? label : syntax).trim();
}
function hasIdentifier(text: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?![\\p{L}\\p{N}_/-])`, 'u').test(text);
}
function sameRooms(actual: string[], expected: string[], label: string) {
  requireEvidence(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), `${label} room set differs from DEMO read RPC`);
}
/** Tool output is owned by registry.phong_trong, not free-form model prose. */
function assertToolRooms(text: string, free: string[], soon: string[]) {
  if (!free.length && !soon.length) {
    requireEvidence(text.trim() === 'Hiện không có phòng trống nào.', 'Empty RPC requires the empty tool result');
    return;
  }
  requireEvidence(text.startsWith(`Tổng ${free.length} phòng trống ngay.`), 'Incorrect tool room total');
  const rows: Record<'free' | 'soon', string[]> = { free: [], soon: [] };
  let section: 'free' | 'soon' | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s+Trống ngay \(\d+\):$/.test(line)) section = 'free';
    else if (/^\s+Sắp trống \(\d+\):$/.test(line)) section = 'soon';
    else {
      const row = /^\s+- (.+?): /.exec(line);
      if (row) {
        requireEvidence(section, 'Tool room row has no availability section');
        rows[section].push(row[1]);
      } else if (line.trim()) section = null;
    }
  }
  sameRooms(rows.free, free, 'tool free');
  sameRooms(rows.soon, soon, 'tool soon');
}
/** Keep ordinary sentences, bullets, tables and links usable, without requiring
 * JSON or a test-only answer template. Match known identifiers at token boundaries
 * and reject novel identifier-shaped tokens, including numeric list entries. */
function assertAnswerRooms(text: string, free: string[], nonFree: string[], metadata: string) {
  for (const code of free) requireEvidence(hasIdentifier(text, code), `Answer missing DEMO room ${code}`);
  for (const code of nonFree.filter(code => !free.includes(code))) {
    requireEvidence(!hasIdentifier(text, code), `Answer includes non-free room ${code}`);
  }
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:[-_/][\p{L}\p{N}]+)*/gu)) {
    const token = match[0];
    if (!/\d/.test(token) || free.some(code => hasIdentifier(code, token)) || hasIdentifier(metadata, token)) continue;
    if (/^\d+(?:m2|m²|triệu|tr|vnd|đ)$/iu.test(token)) continue;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index! + token.length);
    const mixedCode = /\p{L}/u.test(token);
    const numericListCode = /(?:phòng|căn|mã|[,|]|(?:^|\n)\s*[-*])\s*$/iu.test(before)
      && !/^\s*(?:phòng|triệu|đồng|m²|m2|tầng|%)/iu.test(after);
    requireEvidence(!mixedCode && !numericListCode, `Answer includes unexpected room identifier ${token}`);
  }
}
export function assertReadonlyResult(evidence: ReadonlyEvidence): void {
  requireEvidence(evidence.rounds.length >= 2, 'A full read tool/model cycle is required');
  const streams = evidence.rounds.map(round => inspectModelStream(round.body));
  const last = streams[streams.length - 1];
  requireEvidence(last.finish === 'stop' && last.text.trim(), 'A completed final assistant answer is required');
  requireEvidence(evidence.answer.trim() === renderedAssistantText(last.text), 'Mounted assistant answer must match the completed stream');
  requireEvidence(evidence.rounds[0].messages.some(m => m.role === 'user' && m.content === evidence.prompt), 'Model request is not tied to the submitted prompt');
  const readIndex = streams.findIndex(s => s.tools.some(t => t.name === 'phong_trong' && t.id));
  requireEvidence(readIndex >= 0, 'Missing phong_trong read tool');
  const readId = streams[readIndex].tools.find(t => t.name === 'phong_trong')!.id;
  const result = evidence.rounds.slice(readIndex + 1).flatMap(r => r.messages)
    .find(m => m.role === 'tool' && m.tool_call_id === readId);
  requireEvidence(typeof result?.content === 'string' && !/lỗi|error|unavailable|not_permitted/i.test(result.content), 'Missing or failed matching tool result in the next model round');
  const payload = evidence.payload as { buildings?: { id: string; name?: string; address?: string }[]; rooms?: { building_id: string; code?: string; name?: string; id: string; status_public: string }[] } | null;
  requireEvidence(payload && Array.isArray(payload.buildings) && Array.isArray(payload.rooms), 'Missing or invalid read RPC payload');
  const buildings = new Set(payload.buildings.map(b => b.id));
  const scoped = payload.rooms.filter(r => buildings.has(r.building_id));
  const code = (room: typeof scoped[number]) => room.code || room.name || room.id.slice(0, 6);
  const free = scoped.filter(r => r.status_public === 'free').map(code);
  const soon = scoped.filter(r => r.status_public === 'soon').map(code);
  assertToolRooms(result.content, free, soon);
  const emptyAnswer = /không (?:có |còn )?phòng (?:nào )?trống|0 phòng trống/i.test(evidence.answer);
  requireEvidence(free.length ? !emptyAnswer : emptyAnswer, 'Answer empty room state differs from DEMO read RPC');
  assertAnswerRooms(evidence.answer, free, scoped.filter(r => r.status_public !== 'free').map(code),
    payload.buildings.map(b => `${b.name ?? ''} ${b.address ?? ''}`).join(' '));
}
export function unexpectedReadonlyMutation(method: string, url: string): boolean {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return false;
  const path = new URL(url).pathname;
  if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(path)) return false;
  if (method === 'POST' && /\/rest\/v1\/rpc\/(copilot_available_rooms_v1|get_my_copilot_availability_v1)$/.test(path)) return false;
  if (method === 'POST' && /\/rest\/v1\/(ai_chat_threads|ai_chat_messages)$/.test(path)) return false;
  // Unknown RPCs/edge functions are potential business writes; fail closed.
  return /\/(rest|functions)\/v1\//.test(path);
}
