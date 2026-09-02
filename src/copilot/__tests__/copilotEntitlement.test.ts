// `useCopilotEntitlement` đọc `ai_copilot_entitlements` bằng `.maybeSingle()`
// nhưng KHÔNG lọc `user_id`. Với người thường thì RLS "select own" che mất lỗi
// — chỉ thấy đúng dòng của mình. Với SUPER ADMIN, RLS cho thấy MỌI dòng, nên
// `maybeSingle()` gặp ≥2 dòng là nổ PGRST116, query throw, `entitlement` về
// undefined và NÚT COPILOT BIẾN MẤT hẳn khỏi giao diện.
//
// Bảng chỉ cần thêm dòng thứ hai (một người dùng nữa được cấp quyền) là lỗi
// xuất hiện — nghĩa là nó chờ sẵn ở mọi môi trường có nhiều hơn một người dùng.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useQuery = vi.hoisted(() => vi.fn((options: Record<string, unknown>) => options));
vi.mock('@tanstack/react-query', () => ({
  useQuery,
  useMutation: vi.fn(() => ({ mutate: vi.fn() })),
  useQueryClient: vi.fn(() => ({})),
}));

const from = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from, auth: { getSession } },
}));

const { useCopilotEntitlement } = await import('../useAiProviders');

const USER = '00000000-0000-4000-8000-0000000000ff';

type KetQua = { data: unknown; error: unknown };

function chain(ketQua: KetQua, goi: [string, unknown[]][]) {
  const q: Record<string, unknown> = {};
  for (const ten of ['select', 'eq', 'limit', 'order']) {
    q[ten] = (...args: unknown[]) => {
      goi.push([ten, args]);
      return q;
    };
  }
  q.maybeSingle = () => Promise.resolve(ketQua);
  return q;
}

const queryFn = () =>
  // `useQuery` đã bị mock thành hàm trả lại chính options — không có React nào
  // chạy ở đây, nên luật thứ tự hook không áp dụng.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  (useCopilotEntitlement() as unknown as { queryFn: () => Promise<unknown> }).queryFn();

beforeEach(() => {
  from.mockReset();
  getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: USER } } } });
});

describe('useCopilotEntitlement — phải lọc theo user_id', () => {
  it('lọc đích danh user_id của phiên đăng nhập', async () => {
    const goi: [string, unknown[]][] = [];
    from.mockReturnValue(chain({ data: { chat_enabled: true, ui_control_enabled: false }, error: null }, goi));

    await expect(queryFn()).resolves.toEqual({ chat_enabled: true, ui_control_enabled: false });
    expect(from).toHaveBeenCalledWith('ai_copilot_entitlements');
    expect(goi).toContainEqual(['eq', ['user_id', USER]]);
  });

  it('chưa đăng nhập: trả null, KHÔNG chạm bảng và KHÔNG ném lỗi', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    await expect(queryFn()).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('lỗi thật từ database vẫn ném ra, không nuốt', async () => {
    const goi: [string, unknown[]][] = [];
    from.mockReturnValue(chain({ data: null, error: new Error('PGRST301') }, goi));

    await expect(queryFn()).rejects.toThrow('PGRST301');
  });

  it('không có dòng entitlement: trả null (ẩn launcher), không ném', async () => {
    const goi: [string, unknown[]][] = [];
    from.mockReturnValue(chain({ data: null, error: null }, goi));

    await expect(queryFn()).resolves.toBeNull();
  });
});
