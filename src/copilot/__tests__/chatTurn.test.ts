// Test vòng lặp runChatTurn — phần rủi ro nhất của đợt thay lõi.
//
// Giả lập `goiModelMotLuot` để điều khiển được mô hình trả gì; tool thật vẫn
// chạy (dùng `huong_dan`, thứ chỉ đọc tài liệu trong bundle, không cần mạng).
// Bất biến đắt nhất ở đây KHÔNG phải "trả về đúng chữ" mà là **mọi `tool_call`
// phải có đúng một message `tool` khớp `tool_call_id`** — sai chỗ này thì nhà
// cung cấp từ chối nguyên lượt sau, và triệu chứng hiện ra ở một chỗ khác hẳn.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KetQuaLuot } from '../llmClient';

const goiModelMotLuot = vi.hoisted(() => vi.fn());
vi.mock('../llmClient', async (goc) => ({
  ...(await goc<typeof import('../llmClient')>()),
  goiModelMotLuot,
}));

const { runChatTurn, toolSangKhaiBao, dongHomNay } = await import('../chatEngine');
const { buildRegistry, toLlmTools } = await import('../tools/registry');

const luot = (p: Partial<KetQuaLuot>): KetQuaLuot => ({
  content: '',
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: null,
  ...p,
});

const goiTool = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

const chay = (over: Partial<Parameters<typeof runChatTurn>[0]> = {}) =>
  runChatTurn({
    providerModel: '9router:cx/gpt-5.6-sol(max)',
    history: [],
    userText: 'Cách thanh lý hợp đồng?',
    // perms undefined ⇒ chỉ còn tool không gắn quyền (`huong_dan`). Giữ test
    // khỏi phải chạm Supabase.
    ctx: { perms: undefined, organizationId: null },
    signal: new AbortController().signal,
    ...over,
  });

beforeEach(() => goiModelMotLuot.mockReset());

describe('runChatTurn — trả lời thẳng bằng văn bản', () => {
  it('không gọi tool thì content chính là câu trả lời', async () => {
    goiModelMotLuot.mockResolvedValueOnce(luot({ content: 'Xin chào.', finishReason: 'stop' }));
    const r = await chay();
    expect(r.text).toBe('Xin chào.');
    expect(r.toolEvents).toHaveLength(0);
    // user + assistant, không có message `tool` thừa
    expect(r.newMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(goiModelMotLuot).toHaveBeenCalledTimes(1);
  });
});

describe('runChatTurn — tool song song', () => {
  it('MỌI tool_call đều có đúng một message tool khớp id', async () => {
    goiModelMotLuot
      .mockResolvedValueOnce(luot({
        content: 'Để tôi tra.',
        toolCalls: [
          goiTool('call_A', 'huong_dan', { chu_de: 'hop dong' }),
          goiTool('call_B', 'huong_dan', { chu_de: 'thanh ly' }),
        ],
        finishReason: 'tool_calls',
      }))
      .mockResolvedValueOnce(luot({ content: 'Xong.', finishReason: 'stop' }));

    const r = await chay();

    const assistant = r.newMessages.find((m) => m.tool_calls?.length)!;
    const idsXin = assistant.tool_calls!.map((t) => t.id);
    const idsTraLoi = r.newMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(idsXin).toEqual(['call_A', 'call_B']);
    expect(idsTraLoi).toEqual(['call_A', 'call_B']); // đủ, đúng thứ tự, không thiếu
    expect(r.toolEvents).toHaveLength(2);
    expect(r.text).toBe('Xong.');
  });

  it('giữ câu dẫn của mô hình khi nó vừa nói vừa gọi tool', async () => {
    goiModelMotLuot
      .mockResolvedValueOnce(luot({
        content: 'Để tôi tra.',
        toolCalls: [goiTool('c1', 'huong_dan', { chu_de: 'hop dong' })],
      }))
      .mockResolvedValueOnce(luot({ content: 'Xong.' }));
    const r = await chay();
    // Câu dẫn đã hiện trên màn hình rồi; vứt khỏi lịch sử thì lần tải lại sau
    // người dùng thấy khác những gì họ đã đọc.
    expect(r.newMessages.find((m) => m.tool_calls?.length)?.content).toBe('Để tôi tra.');
  });

  it('ba tool cùng lượt đều chạy, đủ id, đúng thứ tự', async () => {
    goiModelMotLuot
      .mockResolvedValueOnce(luot({
        toolCalls: [
          goiTool('a', 'huong_dan', { chu_de: 'hop dong' }),
          goiTool('b', 'huong_dan', { chu_de: 'thanh ly' }),
          goiTool('c', 'huong_dan', { chu_de: 'hoa don' }),
        ],
      }))
      .mockResolvedValueOnce(luot({ content: 'Xong.' }));
    const r = await chay();
    expect(r.toolEvents).toHaveLength(3);
    expect(r.newMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['a', 'b', 'c']);
  });

  it('SONG SONG thật: ba tool chậm chồng lấn nhau, không cộng dồn', async () => {
    // Đo bằng số tool đang chạy đồng thời. Tuần tự thì đỉnh luôn = 1, dù tổng
    // thời gian có thể trông "đủ nhanh" trên máy rảnh — nên đừng đo bằng đồng hồ.
    const registryMod = await import('../tools/registry');
    const z = await import('zod/v4');
    let dangChay = 0;
    let dinhCao = 0;
    const spy = vi.spyOn(registryMod, 'toLlmTools').mockReturnValue({
      cham: {
        description: 'tool chậm',
        inputSchema: z.object({}),
        execute: async () => {
          dangChay++;
          dinhCao = Math.max(dinhCao, dangChay);
          await new Promise((r) => setTimeout(r, 40));
          dangChay--;
          return 'xong';
        },
      },
    });
    try {
      goiModelMotLuot
        .mockResolvedValueOnce(luot({
          toolCalls: [goiTool('a', 'cham', {}), goiTool('b', 'cham', {}), goiTool('c', 'cham', {})],
        }))
        .mockResolvedValueOnce(luot({ content: 'Xong.' }));
      await chay();
      expect(dinhCao).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runChatTurn — hỏng thì mô hình phải ĐỌC được lỗi', () => {
  it('tool ném lỗi → thành nội dung message tool, không làm vỡ cả lượt', async () => {
    goiModelMotLuot
      .mockResolvedValueOnce(luot({ toolCalls: [goiTool('c1', 'khong_ton_tai', {})] }))
      .mockResolvedValueOnce(luot({ content: 'Tôi không tra được.' }));
    const r = await chay();
    const toolMsg = r.newMessages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('không có công cụ');
    expect(r.text).toBe('Tôi không tra được.');
  });

  it('arguments không phải JSON → báo lỗi có nội dung, vẫn khớp tool_call_id', async () => {
    goiModelMotLuot
      .mockResolvedValueOnce(luot({
        toolCalls: [{ id: 'c9', type: 'function' as const, function: { name: 'huong_dan', arguments: '{hỏng' } }],
      }))
      .mockResolvedValueOnce(luot({ content: 'ok' }));
    const r = await chay();
    const toolMsg = r.newMessages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('c9');
    expect(String(toolMsg.content)).toContain('JSON');
  });

  it('quá số vòng → trả dữ liệu đã gom, không im lặng', async () => {
    goiModelMotLuot.mockResolvedValue(
      luot({ toolCalls: [goiTool('c', 'huong_dan', { chu_de: 'hop dong' })] }),
    );
    const r = await chay();
    expect(r.text).toContain('Kết quả tra cứu');
    expect(goiModelMotLuot).toHaveBeenCalledTimes(6); // MAX_TOOL_ROUNDS
  });
});

describe('runChatTurn — ảnh kèm lượt hỏi', () => {
  const anh = 'data:image/jpeg;base64,AAAA';

  it('không có ảnh ⇒ content vẫn là CHUỖI, không phải mảng', async () => {
    // Giữ dạng chuỗi khi không cần mảng là cố ý: mọi nhà cung cấp đều nhận, và
    // lịch sử cũ trong DB cũng là chuỗi.
    goiModelMotLuot.mockResolvedValueOnce(luot({ content: 'ok' }));
    await chay();
    const msgs = goiModelMotLuot.mock.calls[0][0].messages;
    expect(typeof msgs[msgs.length - 1].content).toBe('string');
  });

  it('có ảnh ⇒ content là mảng text + image_url, chữ đứng TRƯỚC', async () => {
    goiModelMotLuot.mockResolvedValueOnce(luot({ content: 'ok' }));
    const r = await chay({ userText: 'Đọc chỉ số', anh: [anh] });
    const msgs = goiModelMotLuot.mock.calls[0][0].messages;
    const cuoi = msgs[msgs.length - 1].content;
    expect(Array.isArray(cuoi)).toBe(true);
    expect(cuoi[0]).toEqual({ type: 'text', text: 'Đọc chỉ số' });
    expect(cuoi[1]).toEqual({ type: 'image_url', image_url: { url: anh } });
    // và message trả về cho UI cũng mang ảnh (để hiện dải xem trước đúng chỗ)
    expect(Array.isArray(r.newMessages[0].content)).toBe(true);
  });

  it('nhiều ảnh giữ đủ và đúng thứ tự', async () => {
    goiModelMotLuot.mockResolvedValueOnce(luot({ content: 'ok' }));
    await chay({ userText: 'x', anh: [`${anh}1`, `${anh}2`] });
    const msgs = goiModelMotLuot.mock.calls[0][0].messages;
    const cuoi = msgs[msgs.length - 1].content;
    expect(cuoi).toHaveLength(3);
    expect(cuoi[1].image_url.url).toBe(`${anh}1`);
    expect(cuoi[2].image_url.url).toBe(`${anh}2`);
  });
});

describe('dongHomNay — mô hình không có đồng hồ', () => {
  // Bắt gặp thật 12/08/2026: mô hình tự truyền `ngay: 2026-03-27` vào tool rồi
  // trình bày báo cáo "tại 27/03/2026". Số liệu đều thật, chỉ sai KỲ — kiểu sai
  // không có gì đỏ và người đọc không có cách nào biết.
  it('nêu ngày theo GIỜ LOCAL, không lệch sang UTC', () => {
    // 01/01/2026 lúc 00:30 giờ VN — `toISOString()` sẽ cho 2025-12-31.
    const d = new Date(2026, 0, 1, 0, 30);
    const s = dongHomNay(d);
    expect(s).toContain('01/01/2026');
    expect(s).toContain('2026-01');
    expect(s).not.toContain('2025');
  });

  it('dặn BỎ TRỐNG tham số ngày thay vì đoán', () => {
    expect(dongHomNay(new Date(2026, 7, 12))).toMatch(/không tự đoán ngày/i);
  });

  it('đi vào system prompt của mọi lượt', async () => {
    goiModelMotLuot.mockResolvedValueOnce(luot({ content: 'ok' }));
    await chay();
    const sys = goiModelMotLuot.mock.calls[0][0].messages[0];
    expect(sys.role).toBe('system');
    expect(String(sys.content)).toContain('HÔM NAY là');
  });
});

describe('toolSangKhaiBao — schema gửi cho mô hình', () => {
  it('trường có .default() KHÔNG bị xếp vào required', async () => {
    // Nếu lấy schema đầu RA thay vì đầu VÀO, `xac_nhan` thành bắt buộc và mô
    // hình buộc phải tự khai — phá đúng cái mặc-định-an-toàn `xac_nhan=false`
    // của write tool.
    const z = await import('zod/v4');
    const kb = toolSangKhaiBao({
      thu: {
        description: 'x',
        inputSchema: z.object({ bat_buoc: z.string(), co_mac_dinh: z.boolean().default(false) }),
      },
    });
    const params = kb[0].function.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(params.required).toEqual(['bat_buoc']);
    expect(Object.keys(params.properties)).toContain('co_mac_dinh');
  });

  it('không gửi khoá meta $schema', async () => {
    const z = await import('zod/v4');
    const kb = toolSangKhaiBao({ thu: { description: 'x', inputSchema: z.object({ a: z.string() }) } });
    expect(kb[0].function.parameters).not.toHaveProperty('$schema');
  });

  it('giữ description của tool — mô hình chọn tool bằng chính câu này', async () => {
    const registry = buildRegistry();
    const kb = toolSangKhaiBao(toLlmTools(registry, { perms: undefined, organizationId: null }));
    const hd = kb.find((t) => t.function.name === 'huong_dan')!;
    expect(hd.function.description).toContain('tài liệu');
  });
});
