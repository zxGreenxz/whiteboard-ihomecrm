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
export function assertReadonlyResult(evidence: ReadonlyEvidence): void {
  requireEvidence(evidence.rounds.length >= 2, 'A full read tool/model cycle is required');
  const streams = evidence.rounds.map(round => inspectModelStream(round.body));
  const last = streams[streams.length - 1];
  requireEvidence(last.finish === 'stop' && last.text.trim(), 'A completed final assistant answer is required');
  requireEvidence(evidence.answer.trim() === last.text.trim(), 'Mounted assistant answer must match the completed stream');
  requireEvidence(evidence.rounds[0].messages.some(m => m.role === 'user' && m.content === evidence.prompt), 'Model request is not tied to the submitted prompt');
  const readIndex = streams.findIndex(s => s.tools.some(t => t.name === 'phong_trong' && t.id));
  requireEvidence(readIndex >= 0, 'Missing phong_trong read tool');
  const readId = streams[readIndex].tools.find(t => t.name === 'phong_trong')!.id;
  const result = evidence.rounds.slice(readIndex + 1).flatMap(r => r.messages)
    .find(m => m.role === 'tool' && m.tool_call_id === readId);
  requireEvidence(typeof result?.content === 'string' && !/lỗi|error|unavailable|not_permitted/i.test(result.content), 'Missing or failed matching tool result in the next model round');
  const payload = evidence.payload as { buildings?: { id: string }[]; rooms?: { building_id: string; code?: string; name?: string; id: string; status_public: string }[] } | null;
  requireEvidence(payload && Array.isArray(payload.buildings) && Array.isArray(payload.rooms), 'Missing or invalid read RPC payload');
  const buildings = new Set(payload.buildings.map(b => b.id));
  const free = payload.rooms.filter(r => buildings.has(r.building_id) && r.status_public === 'free');
  if (!free.length) {
    requireEvidence(/không (?:có |còn )?phòng (?:nào )?trống|0 phòng trống/i.test(evidence.answer), 'Expected an explicit empty state from the DEMO read response');
  } else {
    requireEvidence(!/không (?:có |còn )?phòng (?:nào )?trống/i.test(evidence.answer), 'Assistant claimed an empty state despite available rooms');
    for (const room of free) {
      const code = room.code || room.name || room.id.slice(0, 6);
      requireEvidence(evidence.answer.includes(code) && result.content.includes(code), `Answer/tool result missing DEMO room ${code}`);
    }
  }
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
