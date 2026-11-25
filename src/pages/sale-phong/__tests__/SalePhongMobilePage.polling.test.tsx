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
const ok = { data: { buildings: [], rooms: [] }, error: null };
const fail = { data: null, error: new Error('offline') };
/** Payload hợp lệ có ranh giới chính sách sau `ms` (tính theo đồng hồ giả lúc gọi). */
const withBoundary = (ms: number) => ({ data: { buildings: [], rooms: [], server_now: new Date(Date.now()).toISOString(), next_policy_boundary_at: new Date(Date.now() + ms).toISOString() }, error: null });

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

  it('dữ liệu có ranh giới chính sách sau 40 giây: rời «Phòng trống» thì hẹn giờ ranh giới không đọc ngầm', async () => {
    rpc.mockImplementation(async () => withBoundary(40_000));
    render(<SalePhongMobilePage />, { wrapper });
    await advance(1);
    pick('Phòng trống');
    await advance(1);
    expect(myReads()).toBe(1);
    pick('Cập nhật');
    await advance(300_000);
    expect(myReads()).toBe(1);
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

  it('đối chứng: đang bật thì ranh giới chính sách 10 giây vẫn đọc lại trước chu kỳ 30 giây', async () => {
    rpc.mockImplementation(async () => withBoundary(10_000));
    load(true);
    await advance(1);
    expect(myReads()).toBe(1);
    await advance(10_000);
    expect(myReads()).toBe(2);
  });

  it('lỗi LIÊN TIẾP giãn 60 → 120 giây; một lần đọc thành công đưa về 30 giây; lỗi lẻ sau đó chỉ giãn 60 giây', async () => {
    rpc.mockResolvedValueOnce(fail).mockResolvedValueOnce(fail).mockResolvedValueOnce(ok).mockResolvedValueOnce(fail).mockResolvedValue(ok);
    load(true);
    await advance(1); expect(myReads()).toBe(1);            // t=0 lỗi 1 ⇒ 60 giây
    await advance(59_999); expect(myReads()).toBe(2);       // t=60 lỗi 2 ⇒ 120 giây
    await advance(119_999); expect(myReads()).toBe(2);
    await advance(1); expect(myReads()).toBe(3);            // t=180 thành công ⇒ 30 giây
    await advance(29_999); expect(myReads()).toBe(3);
    await advance(1); expect(myReads()).toBe(4);            // t=210 lỗi (lần thứ 3 cả phiên) ⇒ vẫn 60 giây
    await advance(59_999); expect(myReads()).toBe(4);
    await advance(1); expect(myReads()).toBe(5);
  });
});
