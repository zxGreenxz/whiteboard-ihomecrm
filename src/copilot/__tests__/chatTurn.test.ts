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

const { runChatTurn, toolSangKhaiBao } = await import('../chatEngine');
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
    ctx: { perms: undefined },
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
    const kb = toolSangKhaiBao(toLlmTools(registry, { perms: undefined }));
    const hd = kb.find((t) => t.function.name === 'huong_dan')!;
    expect(hd.function.description).toContain('tài liệu');
  });
});
