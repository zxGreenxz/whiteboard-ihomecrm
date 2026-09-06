import { hrefAnToan } from '../../src/copilot/hrefAnToan';
import { providerFailureReason } from '../../scripts/copilot-golden-browser-evidence.mjs';
// Pure assertions shared by the real browser smoke and controlled negative tests.
// A transport or quota failure is failure evidence, never a reason to upgrade models.
interface Tool { id: string; name: string; arguments: string }
interface Stream { tools: Tool[]; text: string; finish: string }
interface ModelMessage { role: string; content?: unknown; tool_call_id?: string }
export interface ReadonlyEvidence {
  prompt: string;
  answer: string;
  rounds: { body: string; messages: ModelMessage[] }[];
  payload: unknown;
  buildingScope?: { id: string; name: string };
}
export class ModelStreamFailure extends Error {
  readonly reason: ReturnType<typeof providerFailureReason>;
  constructor(error: unknown) {
    const reason = providerFailureReason(error);
    super(`Provider error in HTTP 200 stream: ${reason}`);
    this.reason = reason;
  }
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
    if (chunk.error) throw new ModelStreamFailure(chunk.error);
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.delta?.content === 'string') text += choice.delta.content;
      for (const part of choice.delta?.tool_calls ?? []) {
        const tool = tools.get(part.index) ?? { id: '', name: '', arguments: '' };
        tool.id += part.id ?? ''; tool.name += part.function?.name ?? '';
        tool.arguments += part.function?.arguments ?? '';
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
/** A Markdown table's price/area/floor cells are not room assertions. Preserve
 * prose, and project only a declared room/code column when a table has a real
 * header separator. Unknown table layouts keep the conservative prose checks. */
function roomColumnText(text: string): string {
  const lines = text.split(/\r?\n/);
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  let roomColumn = -1;
  return lines.map((line, index) => {
    if (!line.includes('|')) { roomColumn = -1; return line; }
    const row = cells(line);
    const next = lines[index + 1];
    if (next?.includes('|') && cells(next).every(cell => /^:?-{3,}:?$/.test(cell))) {
      roomColumn = row.findIndex(cell => /^(?:mã(?: phòng)?|số phòng|phòng|căn hộ)$/iu.test(cell.replace(/[*_`]/g, '')));
      return roomColumn >= 0 ? '' : line;
    }
    if (roomColumn < 0) return line;
    if (row.every(cell => /^:?-{3,}:?$/.test(cell))) return '';
    // Keep explicit room context for numeric identifiers, even a single cell.
    return `phòng ${row[roomColumn] ?? ''}`;
  }).join('\n');
}
/** Keep ordinary sentences, bullets, tables and links usable, without requiring
 * JSON or a test-only answer template. Match known identifiers at token boundaries
 * and reject novel identifier-shaped tokens, including numeric list entries. */
function assertAnswerRooms(text: string, free: string[], nonFree: string[], metadata: string) {
  text = roomColumnText(text);
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
  let selectedBuildings = payload.buildings;
  if (evidence.buildingScope) {
    const target = evidence.buildingScope;
    selectedBuildings = payload.buildings.filter(b => b.id === target.id && b.name === target.name);
    requireEvidence(selectedBuildings.length === 1, 'Requested building identity missing from RPC');
    const calls = streams.flatMap(s => s.tools).filter(t => t.name === 'phong_trong');
    requireEvidence(calls.length === 1, 'Building oracle requires exactly one scoped room call');
    let args: { toa_nha?: unknown };
    try { args = JSON.parse(calls[0].arguments); }
    catch { throw new Error('Building tool arguments are not valid JSON'); }
    requireEvidence(typeof args?.toa_nha === 'string' && args.toa_nha.trim(), 'Building filter is missing from tool arguments');
    // Match the actual registry filter against the FULL authorized RPC payload.
    // A common room code cannot prove which building the model requested.
    const matched = payload.buildings.filter(b => b.name?.toLowerCase().includes((args.toa_nha as string).toLowerCase()));
    requireEvidence(matched.length === 1 && matched[0].id === target.id, 'Tool arguments resolve to a different or ambiguous building');
    const normalizeName = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    requireEvidence(hasIdentifier(normalizeName(evidence.prompt), normalizeName(target.name)), 'Submitted prompt is not bound to requested building');
    requireEvidence(hasIdentifier(normalizeName(evidence.answer), normalizeName(target.name)), 'Answer omits or names a different requested building');
    for (const other of payload.buildings.filter(b => b.id !== target.id && b.name)) {
      requireEvidence(!hasIdentifier(normalizeName(evidence.answer), normalizeName(other.name!)), 'Answer includes a different building');
    }
    const buildingHeaders = result.content.split(/\r?\n/).filter(line => /^\S.*\):$/.test(line));
    const hasAvailable = payload.rooms.some(r => r.building_id === target.id && ['free','soon'].includes(r.status_public));
    // The product mapper owns address/district/area/ward fallbacks. Identify the
    // building from its canonical name instead of duplicating that formatting.
    // Prefer the longest known name so "A (Annex)" cannot be mistaken for A.
    const headerBuildingIds = buildingHeaders.map(line => {
      const matches = payload.buildings.filter(b => b.name && line.startsWith(`${b.name} (`))
        .sort((a, b) => b.name!.length - a.name!.length);
      return matches.length && matches[0].name !== matches[1]?.name ? matches[0].id : undefined;
    });
    requireEvidence(JSON.stringify(headerBuildingIds) === JSON.stringify(hasAvailable ? [target.id] : []), 'Tool result belongs to a different building');
  }
  const buildings = new Set(selectedBuildings.map(b => b.id));
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
