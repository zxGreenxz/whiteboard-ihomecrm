// `useCopilotAvailability` chỉ có staleTime, KHÔNG có refetchInterval: snapshot
// hết hạn sau 60s và không ai đi làm tươi lại. Panel chat mở lâu hơn một phút là
// mất sạch tool mà không báo gì.
//
// Test này soi ĐÚNG cái option đó, vì repo chưa có môi trường DOM để render hook
// thật. Mock `useQuery` trả lại nguyên options là cách rẻ nhất để khẳng định
// panel chat có bật polling còn trang admin thì không.
import { describe, expect, it, vi } from 'vitest';

const useQuery = vi.hoisted(() => vi.fn((options: Record<string, unknown>) => options));
vi.mock('@tanstack/react-query', () => ({ useQuery }));

const { useCopilotAvailability } = await import('../featureFlags');

const ORG = 'aaaa0000-0000-4000-8000-000000000001';

const options = (...args: Parameters<typeof useCopilotAvailability>) =>
  useCopilotAvailability(...args) as unknown as Record<string, unknown>;

describe('useCopilotAvailability — chế độ live', () => {
  it('mặc định KHÔNG poll (trang admin giữ nguyên hành vi cũ)', () => {
    const opt = options(ORG);
    expect(opt.refetchInterval).toBeUndefined();
    expect(opt.refetchIntervalInBackground).toBeUndefined();
    expect(opt.staleTime).toBe(60_000);
  });

  it('live: poll mỗi 30s và KHÔNG poll khi tab chạy nền', () => {
    const opt = options(ORG, { live: true });
    expect(opt.refetchInterval).toBe(30_000);
    expect(opt.refetchIntervalInBackground).toBe(false);
  });

  it('poll dày hơn nửa hạn dùng của snapshot nên không có khoảng chết', () => {
    expect(options(ORG, { live: true }).refetchInterval as number).toBeLessThan(60_000 / 2 + 1);
  });

  it('chưa chọn tổ chức thì query tắt, dù có bật live', () => {
    expect(options(null, { live: true }).enabled).toBe(false);
  });
});
