// Vitest Phase 2 (PLAN.md §Phase 2): maskPii, adapter ×2 cùng schema,
// buildChatContext giữ cặp tool-call, mo_trang canonical route + perm,
// parse provider:model, dựng lại conversation từ rows.
import { describe, expect, it } from 'vitest';
import type { Message } from '@page-agent/llms';
import { maskPii, maskPhonePartial } from '../maskPii';
import { parseProviderModel } from '../copilotConfig';
import { buildChatContext, rowsToMessages } from '../chatEngine';
import {
  buildRegistry,
  toLlmTools,
  toPageAgentTools,
  MO_TRANG_ROUTES,
} from '../tools/registry';
import type { PermissionsMap } from '@/lib/permissions';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const STAFF_ROOMS_ONLY: PermissionsMap = { rooms: { view: true } };

describe('maskPii', () => {
  it('che SĐT VN (0x và +84, có/không phân cách)', () => {
    expect(maskPii('gọi 0901234567 nhé')).not.toContain('0901234567');
    expect(maskPii('sđt +84 901 234 567')).not.toContain('901 234 567');
  });
  it('che CCCD 12 số', () => {
    expect(maskPii('CCCD 079123456789')).toContain('[CCCD đã ẩn]');
  });
  it('che STK khi có từ khoá ngữ cảnh', () => {
    expect(maskPii('STK: 19036789456013')).toContain('[STK đã ẩn]');
    expect(maskPii('số tài khoản 9704229211234')).toContain('[STK đã ẩn]');
  });
  it('KHÔNG nuốt số tiền định dạng VN', () => {
    const s = maskPii('giá 1.500.000 đ, cọc 3.000.000 đ');
    expect(s).toContain('1.500.000');
    expect(s).toContain('3.000.000');
  });
  it('maskPhonePartial giữ đầu-cuối', () => {
    expect(maskPhonePartial('0901234567')).toBe('090***4567');
    expect(maskPhonePartial('')).toBe('');
  });
});

describe('parseProviderModel', () => {
  it('tách đúng khi model-id chứa ":" (vd :free)', () => {
    expect(parseProviderModel('openrouter:qwen/qwen3-coder:free')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:free',
    });
  });
  it('null khi thiếu provider hoặc model', () => {
    expect(parseProviderModel('gpt-4o')).toBeNull();
    expect(parseProviderModel(':x')).toBeNull();
    expect(parseProviderModel('openai:')).toBeNull();
  });
});

describe('buildChatContext', () => {
  const toolPair = (id: string): Message[] => [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'tim_phong', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: 'kết quả' },
  ];

  it('giữ NGUYÊN cặp tool_calls ↔ tool khi cắt', () => {
    const history: Message[] = [
      { role: 'user', content: 'câu 1' },
      ...toolPair('a'),
      { role: 'assistant', content: 'trả lời 1' },
      { role: 'user', content: 'câu 2' },
      ...toolPair('b'),
      { role: 'assistant', content: 'trả lời 2' },
    ];
    const ctx = buildChatContext(history, { maxTurns: 3 });
    // Không được có message tool mồ côi (tool mà assistant tool_calls trước nó không nằm trong ctx)
    ctx.forEach((m, i) => {
      if (m.role === 'tool') {
        const prev = ctx.slice(0, i).reverse().find((x) => x.role === 'assistant');
        expect(prev?.tool_calls?.some((tc) => tc.id === m.tool_call_id)).toBe(true);
      }
    });
    // Cắt từ CUỐI: message cuối cùng phải giữ nguyên
    expect(ctx[ctx.length - 1].content).toBe('trả lời 2');
  });

  it('tôn trọng maxChars nhưng luôn giữ ít nhất 1 block', () => {
    const history: Message[] = [
      { role: 'user', content: 'x'.repeat(50_000) },
      { role: 'assistant', content: 'y'.repeat(50_000) },
    ];
    const ctx = buildChatContext(history, { maxChars: 100 });
    expect(ctx.length).toBeGreaterThan(0);
  });
});

describe('rowsToMessages (dựng lại conversation)', () => {
  it('map đúng role/content/tool_calls/tool_call_id theo thứ tự rows', () => {
    const rows = [
      { role: 'user', content: 'hỏi', tool_calls: null, tool_call_id: null },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
        tool_call_id: null,
      },
      { role: 'tool', content: 'kq', tool_calls: null, tool_call_id: 'c1' },
      { role: 'assistant', content: 'đáp', tool_calls: null, tool_call_id: null },
    ];
    const msgs = rowsToMessages(rows as any);
    expect(msgs).toHaveLength(4);
    expect(msgs[1].tool_calls?.[0].id).toBe('c1');
    expect(msgs[2].tool_call_id).toBe('c1');
    expect(msgs[3].content).toBe('đáp');
  });
});

describe('registry + adapters', () => {
  it('2 adapter cho ra CÙNG bộ schema với tool dùng chung', () => {
    const reg = buildRegistry();
    const llmTools = toLlmTools(reg, { perms: SUPER });
    const paTools = toPageAgentTools(reg, { perms: SUPER });
    for (const name of Object.keys(llmTools)) {
      expect(paTools[name]).toBeDefined();
      expect(paTools[name].description).toBe(llmTools[name].description);
      expect(paTools[name].inputSchema).toBe(llmTools[name].inputSchema);
    }
  });

  it('mo_trang CHỈ có ở adapter UI-control (chat không điều hướng)', () => {
    const reg = buildRegistry();
    expect(toLlmTools(reg, { perms: SUPER }).mo_trang).toBeUndefined();
    expect(toPageAgentTools(reg, { perms: SUPER }).mo_trang).toBeDefined();
  });

  it('tool bị LOẠI khỏi danh sách khi thiếu quyền', () => {
    const reg = buildRegistry();
    const tools = toLlmTools(reg, { perms: STAFF_ROOMS_ONLY });
    expect(tools.phong_trong).toBeDefined();       // rooms.view có
    expect(tools.doanh_thu_thang).toBeUndefined(); // reports_finance.analysis không
    expect(tools.huong_dan).toBeDefined();         // không cần quyền
  });

  it('mo_trang: route CANONICAL /apartments (không /rooms) + gọi navigate', async () => {
    expect(MO_TRANG_ROUTES.phong.route).toBe('/apartments');
    expect(Object.values(MO_TRANG_ROUTES).some((r) => r.route === '/rooms')).toBe(false);
    const reg = buildRegistry();
    const moTrang = reg.find((t) => t.name === 'mo_trang')!;
    let navigated = '';
    const out = await moTrang.execute({ trang: 'phong' }, { perms: SUPER, navigate: (to) => { navigated = to; } });
    expect(navigated).toBe('/apartments');
    expect(out).toContain('/apartments');
  });

  it('mo_trang: chặn khi không có quyền module đích', async () => {
    const reg = buildRegistry();
    const moTrang = reg.find((t) => t.name === 'mo_trang')!;
    await expect(
      moTrang.execute({ trang: 'hoa_don' }, { perms: STAFF_ROOMS_ONLY, navigate: () => {} }),
    ).rejects.toThrow(/quyền/);
  });
});
