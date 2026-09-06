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
  it('reassembles fragmented tool names', () => { expect(inspectModelStream(call).tools).toEqual([{ id: 'call-1', name: 'phong_trong' }]); });
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
