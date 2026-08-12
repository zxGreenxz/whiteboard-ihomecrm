// Test bộ gom SSE — phần THUẦN của llmClient, chạy được không cần mạng.
//
// Fixture KHÔNG bịa: đây là hình dạng chunk thật ghi được từ
// `cx/gpt-5.6-sol(max)` qua https://cli.chillhome.io.vn ngày 12/08/2026. Ba đặc
// điểm của luồng thật mà một fixture tưởng tượng dễ bỏ sót, và cả ba đều từng
// làm hỏng bộ gom nếu không xử đúng:
//   1. `arguments` về theo TỪNG MẢNH, nối theo `index` — mảnh thứ hai KHÔNG
//      mang `id` lẫn `name`.
//   2. Có `delta.reasoning_content` (token suy nghĩ). Nó KHÔNG phải câu trả
//      lời; lẫn nó vào là người dùng đọc được phần nháp của mô hình.
//   3. KHÔNG có dòng `[DONE]`. Bộ gom nào chờ `[DONE]` mới chốt thì treo.
import { describe, expect, it } from 'vitest';
import { BoGomSSE, tachDongSSE } from '../llmClient';

/** Chunk thật (đã rút gọn phần id/created cho dễ đọc, giữ nguyên cấu trúc). */
const LUONG_TOOL_SONG_SONG = [
  { choices: [{ index: 0, delta: { reasoning_content: '**Đang nghĩ**' }, finish_reason: null }] },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'doanh_thu_thang', arguments: '' } }] },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"thang":"2026-07"}' } }] },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 1, id: 'call_B', type: 'function', function: { name: 'phong_trong', arguments: '' } }] },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 1, function: { arguments: '{"toa_nha":"Sunrise"}' } }] },
      finish_reason: null,
    }],
  },
  {
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 4498, completion_tokens: 57, total_tokens: 4555 },
  },
];

const nap = (chunks: unknown[]) => {
  const bo = new BoGomSSE();
  const chuNhanDuoc: string[] = [];
  for (const c of chunks) {
    const { deltaChu } = bo.napChunk(c);
    if (deltaChu) chuNhanDuoc.push(deltaChu);
  }
  return { kq: bo.ketQua(), chuNhanDuoc };
};

describe('BoGomSSE — gom tool call nhiều mảnh', () => {
  it('gom ĐỦ HAI tool song song, không nuốt cái thứ hai', () => {
    // Đây là bất biến mà `LLM` class cũ vi phạm: nó chỉ phơi ra MỘT toolCall.
    const { kq } = nap(LUONG_TOOL_SONG_SONG);
    expect(kq.toolCalls).toHaveLength(2);
    expect(kq.toolCalls.map((t) => t.function.name)).toEqual(['doanh_thu_thang', 'phong_trong']);
  });

  it('nối arguments theo index — không lẫn tham số giữa hai tool', () => {
    const { kq } = nap(LUONG_TOOL_SONG_SONG);
    expect(JSON.parse(kq.toolCalls[0].function.arguments)).toEqual({ thang: '2026-07' });
    expect(JSON.parse(kq.toolCalls[1].function.arguments)).toEqual({ toa_nha: 'Sunrise' });
  });

  it('giữ id từ mảnh ĐẦU — mảnh sau không mang id', () => {
    // Message `tool` phải khớp `tool_call_id`; mất id là cả lượt hỏng.
    const { kq } = nap(LUONG_TOOL_SONG_SONG);
    expect(kq.toolCalls.map((t) => t.id)).toEqual(['call_A', 'call_B']);
  });

  it('KHÔNG coi reasoning_content là câu trả lời', () => {
    const { kq, chuNhanDuoc } = nap(LUONG_TOOL_SONG_SONG);
    expect(kq.content).toBe('');
    expect(chuNhanDuoc).toEqual([]);
    expect(JSON.stringify(kq)).not.toContain('Đang nghĩ');
  });

  it('lấy usage từ chunk cuối và finish_reason', () => {
    const { kq } = nap(LUONG_TOOL_SONG_SONG);
    expect(kq.usage).toEqual({ promptTokens: 4498, completionTokens: 57, totalTokens: 4555 });
    expect(kq.finishReason).toBe('tool_calls');
  });

  it('mảnh tool không có tên hàm thì bỏ, không sinh tool rỗng', () => {
    const { kq } = nap([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] },
    ]);
    expect(kq.toolCalls).toHaveLength(0);
  });
});

describe('BoGomSSE — trả lời bằng văn bản (đường streaming của người dùng)', () => {
  const LUONG_CHU = [
    { choices: [{ delta: { reasoning_content: 'nháp' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'Toà Sunrise ' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'doanh thu ' }, finish_reason: null }] },
    { choices: [{ delta: { content: '120.000.000 đ.' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } },
  ];

  it('nối chữ theo thứ tự và phát TỪNG mảnh ra ngoài', () => {
    const { kq, chuNhanDuoc } = nap(LUONG_CHU);
    expect(kq.content).toBe('Toà Sunrise doanh thu 120.000.000 đ.');
    // Phát từng mảnh mới là thứ làm chữ chảy dần trên màn hình; gom hết rồi mới
    // phát một lần thì streaming chỉ còn là cái tên.
    expect(chuNhanDuoc).toEqual(['Toà Sunrise ', 'doanh thu ', '120.000.000 đ.']);
    expect(kq.toolCalls).toHaveLength(0);
    expect(kq.finishReason).toBe('stop');
  });

  it('chuỗi rỗng không tính là mảnh chữ', () => {
    const { chuNhanDuoc } = nap([{ choices: [{ delta: { content: '' }, finish_reason: null }] }]);
    expect(chuNhanDuoc).toEqual([]);
  });
});

describe('tachDongSSE — chunk mạng cắt giữa dòng', () => {
  it('giữ lại phần đuôi chưa trọn dòng thay vì vứt đi', () => {
    // Bỏ qua điều này là mất token cuối một cách NGẪU NHIÊN — lỗi chỉ hiện khi
    // ranh giới gói tin rơi đúng chỗ, nên rất khó tái hiện lúc gỡ.
    const a = tachDongSSE('data: {"x":1}\ndata: {"y":');
    expect(a.payloads).toEqual(['{"x":1}']);
    expect(a.conLai).toBe('data: {"y":');

    const b = tachDongSSE(`${a.conLai}2}\n`);
    expect(b.payloads).toEqual(['{"y":2}']);
    expect(b.conLai).toBe('');
  });

  it('bỏ qua [DONE] và dòng không phải data:', () => {
    const r = tachDongSSE(': keep-alive\ndata: [DONE]\ndata: {"z":3}\n\n');
    expect(r.payloads).toEqual(['{"z":3}']);
  });
});
