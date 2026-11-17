// @vitest-environment jsdom
// Bộ lọc nhà bảng "LN được chia Nhà × Tháng" lưu THEO TÀI KHOẢN (public.settings), trình duyệt chỉ là bộ đệm
// (chủ yêu cầu 17/11/2026: tạo bộ lọc thì phải còn khi mở lại, theo từng người dùng).
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildingFilterState } from '@/lib/profitLedger/buildingFilters';

type Row = { id: string; user_id: string; key: string; value: unknown; organization_id: string };
const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  writes: [] as Record<string, unknown>[],
  failWrite: false,
  failRead: false,
  user: { id: 'user-1' } as { id: string } | null,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: db.user }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'settings') throw new Error(`bảng ngoài dự kiến: ${table}`);
      const where: Record<string, unknown> = {};
      let payload: Record<string, unknown> | null = null;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { where[column] = value; return builder; },
        maybeSingle: async () => {
          if (db.failRead) return { data: null, error: { code: 'XX000', message: 'đọc lỗi' } };
          const row = db.rows.get(`${String(where.user_id)}|${String(where.key)}`);
          return { data: row ? { value: row.value } : null, error: null };
        },
        upsert: (next: Record<string, unknown>) => { payload = next; return builder; },
        single: async () => {
          const written = payload ?? {};
          db.writes.push(written);
          if (db.failWrite) return { data: null, error: { code: '42501', message: 'từ chối' } };
          const id = `${String(written.user_id)}|${String(written.key)}`;
          const row = { id: db.rows.get(id)?.id ?? `row-${db.rows.size + 1}`, ...written } as Row;
          db.rows.set(id, row);
          return { data: row, error: null };
        },
      };
      return builder;
    },
  },
}));

import { BUILDING_FILTER_READ_ERROR, BUILDING_FILTER_SAVE_ERROR, useBuildingFilterState } from '../useBuildingFilterState';

const SETTING_KEY = 'ln_nha_thang_bo_loc:v1:org-a:sh-1';
const CACHE_KEY = 'ihome:ln-nha-thang:bo-loc:v1:org-a:sh-1';
const MOT: BuildingFilterState = { presets: [{ id: 'p1', name: 'Cụm một', keys: ['b1'] }], activeId: 'p1' };
const HAI: BuildingFilterState = { presets: [{ id: 'p1', name: 'Cụm một', keys: ['b1'] }, { id: 'p2', name: 'Cụm hai', keys: ['b2'] }], activeId: 'p2' };

function mount(org = 'org-a', shareholder = 'sh-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(() => useBuildingFilterState(org, shareholder), { wrapper }), client };
}
const serverRow = (user = 'user-1', key = SETTING_KEY) => db.rows.get(`${user}|${key}`);

beforeEach(() => {
  db.rows.clear(); db.writes = []; db.failWrite = false; db.failRead = false; db.user = { id: 'user-1' };
  window.localStorage.clear();
});
afterEach(() => { vi.clearAllMocks(); });

describe('useBuildingFilterState — lưu theo tài khoản', () => {
  it('tài khoản đã có bộ lọc trên máy chủ ⇒ hiện dù trình duyệt này chưa từng lưu (máy / trình duyệt khác, ẩn danh)', async () => {
    db.rows.set(`user-1|${SETTING_KEY}`, { id: 'r1', user_id: 'user-1', key: SETTING_KEY, value: MOT, organization_id: 'org-a' });
    const { result } = mount();
    await waitFor(() => expect(result.current.state).toEqual(MOT));
    expect(result.current.sync).toBe('saved');
    expect(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null')).toEqual(MOT);
    expect(db.writes).toHaveLength(0);
  });

  it('tạo bộ lọc ⇒ ghi lên tài khoản kèm công ty, khoá theo công ty + cổ đông; bộ đệm trình duyệt cũng có', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    act(() => result.current.update(MOT));
    expect(result.current.state).toEqual(MOT);
    await waitFor(() => expect(serverRow()?.value).toEqual(MOT));
    expect(db.writes).toEqual([{ user_id: 'user-1', key: SETTING_KEY, value: MOT, organization_id: 'org-a' }]);
    expect(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null')).toEqual(MOT);
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    expect(result.current.syncError).toBeNull();
  });

  it('mở lại ở trình duyệt khác (bộ đệm trống) ⇒ vẫn còn đúng bộ lọc đang chọn', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.sync).toBe('saved'));
    act(() => first.result.current.update(HAI));
    await waitFor(() => expect(serverRow()?.value).toEqual(HAI));
    first.unmount();
    window.localStorage.clear();
    const second = mount();
    await waitFor(() => expect(second.result.current.state).toEqual(HAI));
  });

  it('tài khoản khác / cổ đông khác / công ty khác không thấy bộ lọc của nhau', async () => {
    db.rows.set(`user-1|${SETTING_KEY}`, { id: 'r1', user_id: 'user-1', key: SETTING_KEY, value: MOT, organization_id: 'org-a' });
    db.user = { id: 'user-2' };
    const other = mount();
    await waitFor(() => expect(other.result.current.sync).toBe('saved'));
    expect(other.result.current.state).toEqual({ presets: [], activeId: null });
    other.unmount();
    db.user = { id: 'user-1' };
    const otherShareholder = mount('org-a', 'sh-2');
    await waitFor(() => expect(otherShareholder.result.current.sync).toBe('saved'));
    expect(otherShareholder.result.current.state.presets).toEqual([]);
    otherShareholder.unmount();
    const otherOrg = mount('org-b', 'sh-1');
    await waitFor(() => expect(otherOrg.result.current.sync).toBe('saved'));
    expect(otherOrg.result.current.state.presets).toEqual([]);
  });

  it('bộ lọc cũ chỉ có trên trình duyệt (trước thay đổi này) ⇒ đẩy lên tài khoản đúng một lần', async () => {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(MOT));
    const { result, rerender } = mount();
    expect(result.current.state).toEqual(MOT);
    await waitFor(() => expect(serverRow()?.value).toEqual(MOT));
    rerender();
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    expect(db.writes).toHaveLength(1);
    expect(result.current.state).toEqual(MOT);
  });

  it('ghi lên tài khoản lỗi ⇒ giữ bộ lọc trên màn, báo rõ; "Thử lại" ghi lại được', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    db.failWrite = true;
    act(() => result.current.update(MOT));
    await waitFor(() => expect(result.current.sync).toBe('error'));
    expect(result.current.syncError).toBe(BUILDING_FILTER_SAVE_ERROR);
    expect(result.current.state).toEqual(MOT);
    expect(serverRow()).toBeUndefined();
    db.failWrite = false;
    act(() => result.current.retry());
    await waitFor(() => expect(serverRow()?.value).toEqual(MOT));
    await waitFor(() => expect(result.current.syncError).toBeNull());
    expect(result.current.state).toEqual(MOT);
  });

  it('còn thay đổi chưa lưu được mà màn đọc lại tài khoản (vd quay lại tab) ⇒ KHÔNG trả bộ lọc về bản cũ', async () => {
    db.rows.set(`user-1|${SETTING_KEY}`, { id: 'r1', user_id: 'user-1', key: SETTING_KEY, value: MOT, organization_id: 'org-a' });
    const { result, client } = mount();
    await waitFor(() => expect(result.current.state).toEqual(MOT));
    db.failWrite = true;
    act(() => result.current.update(HAI));
    await waitFor(() => expect(result.current.sync).toBe('error'));
    const before = client.getQueryState(['settings', SETTING_KEY, 'user-1'])?.dataUpdatedAt ?? 0;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['settings', SETTING_KEY, 'user-1'] });
      // React Query báo kết quả cho component qua setTimeout(0): chờ thêm một nhịp để màn đã nhận bản đọc lại.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(client.getQueryState(['settings', SETTING_KEY, 'user-1'])?.dataUpdatedAt ?? 0).toBeGreaterThan(before);
    expect(result.current.state).toEqual(HAI);
    expect(result.current.syncError).toBe(BUILDING_FILTER_SAVE_ERROR);
  });

  it('đọc tài khoản lỗi ⇒ dùng bộ đệm trình duyệt và báo lỗi đọc', async () => {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(HAI));
    db.failRead = true;
    const { result } = mount();
    await waitFor(() => expect(result.current.syncError).toBe(BUILDING_FILTER_READ_ERROR));
    expect(result.current.state).toEqual(HAI);
    expect(db.writes).toHaveLength(0);
  });

  it('đổi liên tiếp hai lần ⇒ máy chủ giữ bản cuối, màn không quay về bản giữa', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    act(() => { result.current.update(MOT); });
    act(() => { result.current.update(HAI); });
    await waitFor(() => expect(db.writes).toHaveLength(2));
    await waitFor(() => expect(result.current.sync).toBe('saved'));
    expect(serverRow()?.value).toEqual(HAI);
    expect(result.current.state).toEqual(HAI);
  });
});
