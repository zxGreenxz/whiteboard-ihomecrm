// @vitest-environment jsdom
// Nối HAI gói trên cùng một bảng push_subscriptions giả (SETTINGS-1 / NOTIF-CLIENT-3):
//   gói D — "Thiết bị đã đăng ký": máy A gỡ máy B (useRemovePushDevice);
//   gói C — cầu nối lúc mở app: máy B chạy ensurePushSubscription.
// Trước 22/10, D xoá cứng dòng còn C thấy "máy chủ thiếu dòng" là lưu lại ⇒ gỡ vô hiệu.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string; endpoint: string; user_id: string };

const io = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  seq: 0,
  getSub: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  permission: vi.fn(),
}));

/** Bảng giả đủ cho các truy vấn push.ts dùng: select/eq/order/maybeSingle/single, upsert theo endpoint, update, delete. */
function fakeFrom() {
  let op: 'select' | 'upsert' | 'update' | 'delete' = 'select';
  let payload: Record<string, unknown> = {};
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Record<string, unknown>) => filters.every(([k, v]) => r[k] === v);
  const exec = (): Array<Record<string, unknown>> => {
    if (op === 'select') return io.rows.filter(matches).map((r) => ({ ...r }));
    if (op === 'upsert') {
      const existing = io.rows.find((r) => r.endpoint === payload.endpoint);
      if (existing) {
        Object.assign(existing, payload);
        return [{ ...existing }];
      }
      const row = { id: `dev-${++io.seq}`, created_at: '2026-10-22T00:00:00+00:00', updated_at: '2026-10-22T00:00:00+00:00', revoked_at: null, ...payload };
      io.rows.push(row);
      return [{ ...row }];
    }
    if (op === 'update') {
      const hit = io.rows.filter(matches);
      for (const r of hit) Object.assign(r, payload);
      return hit.map((r) => ({ ...r }));
    }
    const removed = io.rows.filter(matches);
    io.rows = io.rows.filter((r) => !matches(r));
    return removed.map((r) => ({ ...r }));
  };
  const q = {
    select: () => q,
    order: () => q,
    eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
    upsert: (p: Record<string, unknown>) => { op = 'upsert'; payload = p; return q; },
    update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return q; },
    delete: () => { op = 'delete'; return q; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }),
    single: async () => { const r = exec(); return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { code: 'PGRST116' } }; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: exec(), error: null }).then(res, rej),
  };
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => fakeFrom(), rpc: vi.fn() } }));
vi.mock('@/lib/authSession', () => ({ getSessionUserId: async () => 'actor-a' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { VAPID_PUBLIC_KEY, enablePush, ensurePushSubscription, isSubscribed } from '../push';
import { useRemovePushDevice } from '@/hooks/useNotificationSettings';

const EP_B = 'https://push.example/machine-b';
function keyBytes() {
  const raw = atob(VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}
/** Đăng ký trình duyệt của MÁY B — gỡ từ xa không hủy được nó. */
const subB = { endpoint: EP_B, options: { applicationServerKey: keyBytes() }, unsubscribe: io.unsubscribe, getKey: () => new Uint8Array([1, 2]).buffer } as unknown as PushSubscription;
const rowB = () => io.rows.find((r) => r.endpoint === EP_B) as Row | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  io.rows = [];
  io.seq = 0;
  io.getSub.mockResolvedValue(subB);
  io.permission.mockResolvedValue('granted');
  const registration = { active: {}, pushManager: { getSubscription: io.getSub, subscribe: io.subscribe } };
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: io.permission });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('gỡ thiết bị từ máy A ⇒ máy B mở CRM không tự bật lại; chỉ công tắc trên máy B bật lại', () => {
  it('chuỗi đầy đủ trên một bảng', async () => {
    // Máy B từng bật push.
    await expect(enablePush('org-a')).resolves.toBe('granted');
    expect(rowB()).toMatchObject({ is_active: true, revoked_at: null, user_id: 'actor-a' });

    // Máy A gỡ máy B ở "Thiết bị đã đăng ký".
    const remove = renderHook(() => useRemovePushDevice(), { wrapper });
    await act(async () => { await remove.result.current.mutateAsync(rowB()!.id); });
    expect(io.rows).toHaveLength(1); // không xoá dòng — dấu thu hồi nằm trên chính dòng
    expect(rowB()).toMatchObject({ is_active: false });
    expect(typeof rowB()!.revoked_at).toBe('string');

    // Máy B mở CRM (cầu nối đối chiếu): KHÔNG tạo, KHÔNG kích hoạt lại, KHÔNG đụng trình duyệt.
    await expect(ensurePushSubscription('org-a')).resolves.toBe('revoked');
    expect(io.rows).toHaveLength(1);
    expect(rowB()).toMatchObject({ is_active: false });
    expect(rowB()!.revoked_at).not.toBeNull();
    expect(io.subscribe).not.toHaveBeenCalled();
    expect(io.unsubscribe).not.toHaveBeenCalled();
    await expect(isSubscribed()).resolves.toBe(false); // công tắc trên máy B hiện TẮT

    // Người dùng chủ động bật lại bằng công tắc trên máy B ⇒ xoá dấu thu hồi.
    await expect(enablePush('org-a')).resolves.toBe('granted');
    expect(rowB()).toMatchObject({ is_active: true, revoked_at: null });
    await expect(isSubscribed()).resolves.toBe(true);
    await expect(ensurePushSubscription('org-a')).resolves.toBe('in-sync');
  });

  it('dòng bị send-push prune (is_active=false, revoked_at NULL) vẫn đi đường cũ: đăng ký mới rồi lưu', async () => {
    io.rows.push({ id: 'dev-old', user_id: 'actor-a', endpoint: EP_B, p256dh: 'AQI', auth: 'AQI', is_active: false, revoked_at: null, organization_id: 'org-a' });
    const fresh = { ...subB, endpoint: 'https://push.example/machine-b-fresh' } as PushSubscription;
    io.unsubscribe.mockResolvedValue(true);
    io.subscribe.mockResolvedValue(fresh);
    await expect(ensurePushSubscription('org-a')).resolves.toBe('resubscribed');
    expect(io.rows.map((r) => [r.endpoint, r.is_active])).toEqual([['https://push.example/machine-b-fresh', true]]);
  });
});
