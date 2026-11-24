// @vitest-environment jsdom
// Đợt 4 «Tải nhẹ» (25/11/2026): điện thoại chỉ chạy vòng tải «Phòng trống» (get_my_available_rooms)
// khi đang ở chế độ đó. Trước đây vòng này chạy ngầm cả ở «Cập nhật» song song với bảng nội bộ.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SalePhongMobilePage from '../SalePhongMobilePage';
import { useMyAvailableRooms } from '@/hooks/useMyAvailableRooms';

const rpc = vi.hoisted(() => vi.fn());
const idle = vi.hoisted(() => ({ data: [], status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: () => undefined, dataUpdatedAt: 0 }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => true }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: null }) }));
vi.mock('@/hooks/usePublicRoomTokens', () => ({ usePublicRoomTokens: () => idle }));
vi.mock('@/hooks/usePassListings', () => ({ usePassListings: () => idle }));
vi.mock('@/pages/phong-trong/PhongTrongPage', () => ({ default: () => <div>Danh sách phòng trống</div> }));
vi.mock('@/components/sale-phong/SaleRoomWorkspace', () => ({ default: () => <div>Bảng cập nhật phòng</div> }));

let client: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{children}</MemoryRouter></QueryClientProvider>;
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const myReads = () => rpc.mock.calls.filter(([name]) => name === 'get_my_available_rooms').length;
const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

// Nạp sẵn module lazy bằng đồng hồ thật để lazy() trong trang chỉ còn chờ microtask khi đồng hồ giả.
beforeAll(async () => { await import('@/components/sale-phong/SaleRoomWorkspace'); });
beforeEach(() => {
  vi.useFakeTimers(); rpc.mockReset(); focusManager.setFocused(true); onlineManager.setOnline(true);
  rpc.mockResolvedValue({ data: { buildings: [], rooms: [] }, error: null });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); focusManager.setFocused(undefined); onlineManager.setOnline(true); vi.useRealTimers(); });

describe('Sale Phòng điện thoại: một vòng tải theo chế độ đang mở', () => {
  it('Cập nhật và Quản lý không đọc «Phòng trống»; vào Phòng trống thì đọc ngay rồi 30 giây một lần', async () => {
    render(<SalePhongMobilePage />, { wrapper });
    await advance(1);
    expect(screen.getByText('Bảng cập nhật phòng')).toBeTruthy();
    await advance(300_000);
    expect(myReads()).toBe(0);

    pick('Phòng trống');
    await advance(1);
    expect(screen.getByText('Danh sách phòng trống')).toBeTruthy();
    expect(myReads()).toBe(1);
    await advance(29_000);
    expect(myReads()).toBe(1);
    await advance(1_000);
    expect(myReads()).toBe(2);

    pick('Cập nhật');
    await advance(300_000);
    expect(myReads()).toBe(2);
    pick('Quản lý');
    await advance(300_000);
    expect(myReads()).toBe(2);

    // Quay lại sau vài phút: dữ liệu đã cũ nên đọc ngay, không hiện danh sách cũ chờ chu kỳ.
    pick('Phòng trống');
    await advance(1);
    expect(myReads()).toBe(3);
  });
});

describe('useMyAvailableRooms', () => {
  const load = (enabled: boolean) => renderHook(({ on }) => useMyAvailableRooms({ enabled: on }), { wrapper, initialProps: { on: enabled } });

  it('tắt thì không đọc kể cả khi quay lại tab hoặc có mạng lại', async () => {
    load(false);
    await advance(300_000);
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); onlineManager.setOnline(false); onlineManager.setOnline(true); await vi.advanceTimersByTimeAsync(1); });
    expect(myReads()).toBe(0);
  });

  it('bật thì đọc 30 giây một lần, đọc ngay khi quay lại tab và khi có mạng lại', async () => {
    const view = load(true);
    await advance(1);
    expect(myReads()).toBe(1);
    expect(view.result.current.isSuccess).toBe(true);
    await advance(5_000);
    expect(myReads()).toBe(1);
    await advance(25_000);
    expect(myReads()).toBe(2);
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); await vi.advanceTimersByTimeAsync(1); });
    expect(myReads()).toBe(3);
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); await vi.advanceTimersByTimeAsync(1); });
    expect(myReads()).toBe(4);
    view.rerender({ on: false });
    await advance(300_000);
    expect(myReads()).toBe(4);
  });
});
