import { describe, expect, it } from 'vitest';
import { inspectModelStream, assertReadonlyResult, unexpectedReadonlyMutation } from '../../../.e2e-fleet/specs/copilotSmokeOracle';
const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const answer = chunk({ content: 'Có 1 phòng trống ngay: A101.' }, 'stop') + 'data: [DONE]\n\n';
const call = chunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'phong_', arguments: '' } }] }, null) +
  chunk({ tool_calls: [{ index: 0, function: { name: 'trong', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
const payload = { buildings: [{ id: 'b1' }], rooms: [{ id: 'r1', building_id: 'b1', code: 'A101', name: '101', status_public: 'free' }] };
const evidence = () => ({ prompt: 'Liệt kê phòng', answer: 'Có 1 phòng trống ngay: A101.',
  rounds: [{ body: call, messages: [{ role: 'user', content: 'Liệt kê phòng' }] },
    { body: answer, messages: [{ role: 'user', content: 'Liệt kê phòng' }, { role: 'tool', tool_call_id: 'call-1', content: 'Tổng 1 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Trống ngay (1):\n  - A101: 3 triệu/tháng, 20m², tầng 1' }] }], payload: structuredClone(payload) });
describe('readonly smoke failure oracle', () => {
  it('accepts a complete model/tool cycle with DEMO-consistent answer', () => { expect(() => assertReadonlyResult(evidence())).not.toThrow(); });
  it('reassembles fragmented tool names', () => { expect(inspectModelStream(call).tools).toEqual([{ id: 'call-1', name: 'phong_trong', arguments: '{}' }]); });
  it.each([
    ['empty', 'data: [DONE]\n\n'], ['missing DONE', answer.replace('data: [DONE]', '')],
    ['incomplete', chunk({ content: 'half an answer' }, null) + 'data: [DONE]\n\n'],
    ['length limit', chunk({ content: 'cut short' }, 'length') + 'data: [DONE]\n\n'],
    ['provider error', 'data: {"error":{"code":"daily_quota"}}\n\ndata: [DONE]\n\n'],
  ])('rejects %s stream', (_, body) => { expect(() => inspectModelStream(body)).toThrow(); });
  it('rejects the old prompt-only green even with a completed generic model response', () => {
    expect(() => assertReadonlyResult({ ...evidence(), rounds: [{ body: answer, messages: [] }], answer: 'Phòng nào đang trống?' })).toThrow();
  });
  it('rejects a read call never returned to the model', () => {
    const e = evidence(); e.rounds[1].messages = [{ role: 'user', content: e.prompt }]; expect(() => assertReadonlyResult(e)).toThrow(/tool result/);
  });
  it('rejects a tool error returned to the model', () => {
    const e = evidence(); e.rounds[1].messages[1].content = 'Lỗi: unavailable'; expect(() => assertReadonlyResult(e)).toThrow(/tool result/);
  });
  it('rejects mounted answer unrelated to its final stream', () => { expect(() => assertReadonlyResult({ ...evidence(), answer: 'Có 1 phòng trống ngay: Z999.' })).toThrow(); });
  it('rejects missing RPC payload instead of pretending it means empty', () => { expect(() => assertReadonlyResult({ ...evidence(), payload: null })).toThrow(); });
  it('accepts explicit empty state only when the read response is empty', () => {
    const text = 'Hiện không có phòng trống nào.';
    const e = evidence(); e.answer = text; e.payload.rooms = [];
    e.rounds[1].body = chunk({ content: text }, 'stop') + 'data: [DONE]\n\n'; e.rounds[1].messages[1].content = text;
    expect(() => assertReadonlyResult(e)).not.toThrow();
    e.payload.rooms = payload.rooms; expect(() => assertReadonlyResult(e)).toThrow();
  });
  it.each(['income_expenses', 'profiles', 'rpc/copilot_plan_execute_step_v1', 'rpc/unknown_write'])('rejects mutation to %s', path => {
    expect(unexpectedReadonlyMutation('POST', `https://demo/rest/v1/${path}`)).toBe(true);
  });
  it('allows only explicitly known read RPCs and chat persistence', () => {
    expect(unexpectedReadonlyMutation('POST', 'https://demo/rest/v1/rpc/copilot_available_rooms_v1')).toBe(false);
    expect(unexpectedReadonlyMutation('POST', 'https://demo/rest/v1/ai_chat_messages')).toBe(false);
    expect(unexpectedReadonlyMutation('GET', 'https://demo/rest/v1/income_expenses')).toBe(false);
    expect(unexpectedReadonlyMutation('DELETE', 'https://demo/rest/v1/ai_chat_messages')).toBe(true);
  });
});

// Stream and mounted answer are changed together: these must reach readback
// consistency checks, not fail early on a deliberately mismatched DOM string.
function setAnswer(e: ReturnType<typeof evidence>, text: string, rendered = text) {
  e.answer = rendered;
  e.rounds[1].body = chunk({ content: text }, 'stop') + 'data: [DONE]\n\n';
  return e;
}
describe('review regressions: read RPC → tool → rendered answer', () => {
  it.each(['Có 2 phòng trống: A101, Z999.', 'Có 1 phòng trống: A1010.'])('rejects invented or substring room IDs: %s', text => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).toThrow(/room/);
  });
  it('rejects an extra non-free room asserted in the answer', () => {
    const e = evidence(); e.payload.rooms.push({ ...e.payload.rooms[0], id: 'r2', code: 'A102', status_public: 'rented' });
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng trống: A101, A102.'))).toThrow(/room/);
  });
  it('rejects an empty RPC paired with a nonempty matching tool result', () => {
    const e = evidence(); e.payload.rooms = [];
    expect(() => assertReadonlyResult(setAnswer(e, 'Hiện không có phòng trống nào.'))).toThrow(/tool/);
  });
  it('rejects an invented room in tool output even when the final answer is accurate', () => {
    const e = evidence(); e.rounds[1].messages[1].content += '\n  - Z999: 3 triệu/tháng, 20m², tầng 1';
    expect(() => assertReadonlyResult(e)).toThrow(/tool/);
  });
  it('accepts a supported link after its label is rendered', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), 'Có 1 phòng trống ngay: [A101](/apartments).', 'Có 1 phòng trống ngay: A101.'))).not.toThrow();
  });
  it('keeps unsafe links as visible literal markdown', () => {
    const text = 'Phòng trống: [A101](javascript:evil).';
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(evidence(), text, 'Phòng trống: A101.'))).toThrow(/Mounted/);
  });
  it('still rejects unrelated mounted text after link normalization', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), '[A101](/apartments)', 'Z999'))).toThrow(/Mounted/);
  });
});

describe('supported room result shapes', () => {
  it('accepts numeric room names with ordinary prices and area prose', () => {
    const e = evidence(); e.payload.rooms[0].code = ''; e.payload.rooms[0].name = '101';
    e.rounds[1].messages[1].content = 'Tổng 1 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Trống ngay (1):\n  - 101: 3 triệu/tháng, 20m², tầng 1';
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng 101 đang trống, giá 3 triệu/tháng, diện tích 20m2.'))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng trống: 101, 999.'))).toThrow(/room/);
  });
  it('allows a soon-only tool response while correctly answering no rooms free now', () => {
    const e = evidence(); e.payload.rooms[0].status_public = 'soon';
    e.rounds[1].messages[1].content = 'Tổng 0 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Sắp trống (1):\n  - A101: 3 triệu/tháng, 20m², tầng 1, trống từ 10/09/2026';
    expect(() => assertReadonlyResult(setAnswer(e, 'Hiện không có phòng trống ngay.'))).not.toThrow();
  });
});

describe('review round 2: table column semantics', () => {
  const table = (room: string, price = '3', area = '20', floor = '1') =>
    `Có 1 phòng trống: A101.\n| Mã phòng | Giá (triệu/tháng) | Diện tích (m²) | Tầng |\n|---|---|---|---|\n| ${room} | ${price} | ${area} | ${floor} |`;
  it('accepts numeric price, area and floor columns in an ordinary Markdown table', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), table('A101')))).not.toThrow();
  });
  it.each(['Z999', '999'])('rejects invented room %s in the room column despite valid numeric metadata', room => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), table(room)))).toThrow(/room/);
  });
  it('does not use a room identifier from a price column as evidence of an available room', () => {
    const text = table('999', 'A101').replace('Có 1 phòng trống: A101.', 'Danh sách phòng trống:');
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).toThrow(/room/);
  });
  it('accepts numeric room names but rejects another numeric identifier in the same table column', () => {
    const e = evidence(); e.payload.rooms[0].code = '101';
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('A101', '101');
    const valid = table('101').replace('Có 1 phòng trống: A101.', 'Có 1 phòng trống: 101.');
    expect(() => assertReadonlyResult(setAnswer(e, valid))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(e, valid + '\n| 999 | 3 | 20 | 1 |'))).toThrow(/room/);
  });
});

describe('golden C13: building identity survives duplicate room codes', () => {
  const scoped = (toolBuilding = 'DEMO Toà A', resultBuilding = 'DEMO Toà A', answerBuilding = 'DEMO Toà A') => {
    const e = evidence();
    const prompt = 'Phòng trống ngay tòa DEMO Toà A?';
    const response = `Tại ${answerBuilding}, phòng 101 đang trống ngay.`;
    return { ...e, prompt, answer: response,
      buildingScope: { id: 'a', name: 'DEMO Toà A' },
      payload: { buildings: [{ id: 'a', name: 'DEMO Toà A', address: 'Địa chỉ A' }], rooms: [
        { id: 'a101', building_id: 'a', code: '101', status_public: 'free' },
        { id: 'b101', building_id: 'b', code: '101', status_public: 'free' },
      ] },
      rounds: [{ body: chunk({ tool_calls: [{ index: 0, id: 'read-1', function: { name: 'phong_trong', arguments: JSON.stringify({ toa_nha: toolBuilding }) } }] }, 'tool_calls') + 'data: [DONE]\n\n', messages: [{ role: 'user', content: prompt }] },
        { body: chunk({ content: response }, 'stop') + 'data: [DONE]\n\n', messages: [{ role: 'user', content: prompt },
          { role: 'tool', tool_call_id: 'read-1', content: `Tổng 1 phòng trống ngay.\n\n${resultBuilding} (Địa chỉ ${resultBuilding.endsWith('B') ? 'B' : 'A'}):\n  Trống ngay (1):\n  - 101: 3 triệu/tháng, 20m², tầng 1` }] }],
    };
  };
  it('accepts the intended building even when another building has the same room code', () => {
    const e = scoped();
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
  it.each(['Khác', 'Quận 1', 'Khu A (phường cũ)'])('accepts the correct building with formatted fallback address %s', address => {
    const e = scoped();
    e.payload.buildings[0].address = '';
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('(Địa chỉ A):', `(${address}):`);
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
  it('still rejects a wrong building when both raw addresses are empty and rendered fallback is Khác', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà B');
    e.payload.buildings[0].address = '';
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: '' });
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('(Địa chỉ B):', '(Khác):');
    expect(() => assertReadonlyResult(e)).toThrow(/different building/i);
  });
  it('does not confuse a known building name suffix with the requested building address', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà A (Chi nhánh)');
    e.payload.buildings.push({ id: 'branch', name: 'DEMO Toà A (Chi nhánh)', address: 'Địa chỉ A' });
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it.each([
    ['wrong argument', 'DEMO Toà B', 'DEMO Toà A', 'DEMO Toà A'],
    ['wrong tool result', 'DEMO Toà A', 'DEMO Toà B', 'DEMO Toà A'],
    ['wrong answer', 'DEMO Toà A', 'DEMO Toà A', 'DEMO Toà B'],
    ['all wrong but identical room code', 'DEMO Toà B', 'DEMO Toà B', 'DEMO Toà B'],
  ])('rejects %s instead of trusting the shared room code', (_, args, result, answer) => {
    expect(() => assertReadonlyResult(scoped(args, result, answer))).toThrow(/building/i);
  });
  it('resolves tool arguments against the full RPC building set, rejecting an ambiguous filter', () => {
    const e = scoped('DEMO');
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it('rejects missing tool arguments, even when every room code is correct', () => {
    const e = scoped(); e.rounds[0].body = e.rounds[0].body.replace(/\\"toa_nha\\":\\"DEMO Toà A\\"/, '');
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it('rejects an answer that names the correct and wrong building together', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà A', 'DEMO Toà A và DEMO Toà B');
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).toThrow(/different building/i);
  });
  it('preserves fragmented building arguments across SSE chunks', () => {
    const e = scoped();
    e.rounds[0].body = chunk({ tool_calls: [{ index: 0, id: 'read-1', function: { name: 'phong_trong', arguments: '{"toa_' } }] }, null)
      + chunk({ tool_calls: [{ index: 0, function: { arguments: 'nha":"DEMO Toà A"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
});
