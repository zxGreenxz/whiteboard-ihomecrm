// `makeCopilotFetch` là chỗ DUY NHẤT gắn header định danh cho mọi lượt gọi
// Copilot đi qua llm-proxy. Từ G0-B nó phải mang thêm công ty đang chọn.
//
// Vì sao header chứ không phải một trường trong body: body là payload
// OpenAI-compat do thư viện LLM/PageAgent dựng, proxy chỉ được phép chuyển tiếp
// một allow-list khoá của nó. Nhét `organization_id` vào đó thì hoặc bị lọc
// mất, hoặc đi lên upstream như một khoá lạ.
//
// Và vì sao KHÔNG chặn ở client khi chưa chọn công ty: một cú `return` im lặng ở
// đây biến "chưa chọn công ty" thành "Copilot không phản hồi". Cứ gửi, để server
// trả 400 `organization_required` — người dùng đọc được một câu nói đúng chuyện.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession } },
}));

const { makeCopilotFetch } = await import('../copilotConfig');

const ORG = '00000000-0000-4000-8000-00000000000a';

/** fetch giả: ghi lại headers của lượt gọi cuối. */
function bayFetch() {
  const daGoi: Headers[] = [];
  const goc = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    daGoi.push(new Headers(init?.headers));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { daGoi, tra: () => { globalThis.fetch = goc; } };
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-tuoi' } } });
});

describe('makeCopilotFetch gắn công ty đang chọn', () => {
  it('có organizationId → gửi header x-organization-id đúng giá trị', async () => {
    const { daGoi, tra } = bayFetch();
    try {
      await makeCopilotFetch('chat', 'task-1', ORG)('https://proxy.test/chat/completions', {
        method: 'POST',
      });
    } finally {
      tra();
    }
    expect(daGoi).toHaveLength(1);
    expect(daGoi[0].get('x-organization-id')).toBe(ORG);
  });

  it('organizationId null → KHÔNG có header, và VẪN gọi (server trả 400 rõ ràng)', async () => {
    const { daGoi, tra } = bayFetch();
    try {
      await makeCopilotFetch('ui_control', 'task-2', null)('https://proxy.test/chat/completions', {
        method: 'POST',
      });
    } finally {
      tra();
    }
    // Gọi thật: chặn im lặng ở client biến lỗi cấu hình thành "Copilot treo".
    expect(daGoi).toHaveLength(1);
    expect(daGoi[0].get('x-organization-id')).toBeNull();
  });

  it('giữ nguyên JWT tươi + feature + task-id đã có từ trước', async () => {
    const { daGoi, tra } = bayFetch();
    try {
      await makeCopilotFetch('ui_control', 'ui-abc', ORG)('https://proxy.test/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      tra();
    }
    const h = daGoi[0];
    expect(h.get('Authorization')).toBe('Bearer jwt-tuoi');
    expect(h.get('x-copilot-feature')).toBe('ui_control');
    expect(h.get('x-task-id')).toBe('ui-abc');
    expect(h.get('Content-Type')).toBe('application/json');
  });

  it('chuỗi rỗng cũng coi như chưa chọn — không gửi header rỗng', async () => {
    // Header rỗng đi tới proxy sẽ trượt regex uuid và trả 400 `organization_required`
    // đúng như khi thiếu hẳn, nhưng gửi nó đi là nói dối rằng đã có lựa chọn.
    const { daGoi, tra } = bayFetch();
    try {
      await makeCopilotFetch('chat', 'task-3', '')('https://proxy.test/chat/completions', {
        method: 'POST',
      });
    } finally {
      tra();
    }
    expect(daGoi[0].get('x-organization-id')).toBeNull();
  });
});
