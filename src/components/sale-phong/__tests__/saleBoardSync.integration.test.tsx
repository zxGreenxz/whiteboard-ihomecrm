// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleRoomPatch, SaleRoomRpcInvoker } from '@/lib/saleRoomOperations';

const ORG = '10000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000001';
const ROOM = '30000000-0000-4000-8000-000000000001';
const BUILDING = '40000000-0000-4000-8000-000000000001';
const m = vi.hoisted(() => ({ actor: '', org: '', rpc: vi.fn<SaleRoomRpcInvoker>(), owner: false }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: m.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: m.actor } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { sale_phong: { edit: { org_wide: true, building_ids: [] } } }, isError: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: m.rpc, storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }) }) },
} }));
vi.mock('@/hooks/usePublicRoomSettings', () => ({
  usePublicRoomSettings: () => ({ data: { soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null }, isError: false, status: 'success' }),
  useUpsertPublicRoomSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  PUBLIC_ROOM_SETTINGS_DEFAULTS: { soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null },
}));
vi.mock('@/hooks/useHotlines', () => ({ useHotlines: () => ({ data: [], isError: false, status: 'success' }), useCreateHotline: () => ({ isPending: false }), useUpdateHotline: () => ({ isPending: false }) }));
vi.mock('@/components/rooms/RoomTurnoverPanel', () => ({ RoomTurnoverPanel: () => null }));
vi.mock('@/pages/phong-trong/LockRoomModal', () => ({ LockRoomModal: () => null }));
vi.mock('@/pages/phong-trong/QuickDepositModal', () => ({ QuickDepositModal: () => null }));
vi.mock('../SaleImageManager', () => ({ default: () => null }));
vi.mock('../PassListingsTab', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import DisplaySettingsTab from '../DisplaySettingsTab';
import MobileDisplaySettings from '../mobile/MobileDisplaySettings';
import SaleRoomWorkspace from '../SaleRoomWorkspace';
import { usePatchSaleRoom, useSaleRoomInventory } from '@/hooks/useSaleRoomInventory';

interface StoredRoom { rent_price: number; sale_note: string | null; amenities: string[]; room_type: string; area: number }
let stored: StoredRoom;
let version: number;
let receipts: Map<string, unknown>;
let lostAck: boolean;
let denyWrites: boolean;
let failReads: boolean;
let policy: null | { id: string; version: number; title: string; content: string; starts_at: string; ends_at: string; status: 'ACTIVE'; cancelled_at: null };
const clients: QueryClient[] = [];
const revision = () => version.toString(16).padStart(32, '0');
const client = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(cache); return cache;
};
const wrapper = (cache: QueryClient) => ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={cache}><MemoryRouter><div className="cm-app">{children}</div></MemoryRouter></QueryClientProvider>;
const snapshot = () => ({
  server_now: new Date().toISOString(), areas: [], contact: null,
  settings_owner_id: m.owner ? m.actor : '20000000-0000-4000-8000-000000000099', can_manage_account_settings: m.owner,
  buildings: [{ id: BUILDING, name: 'Nhà đồng bộ', code: 'SYNC', district: null, ward: null, address: 'Địa chỉ thử', total_floors: 1, images: [] }],
  rooms: [{ id: ROOM, building_id: BUILDING, floor: 1, name: '101', code: '101', ...stored,
    max_occupants: 2, images: [], description: null, sale_bonus_note: null, status_public: 'free', avail_date: null,
    sale_state: 'READY', sale_today: '2026-10-22', revision: revision(), updated_at: new Date().toISOString(),
    capabilities: { edit: true, images: true, pass: false, lock: false, releaseLock: false, deposit: false },
    policy, policies: policy ? [policy] : [], active_policy_text: policy?.content ?? null,
  }],
});
const editDirectly = (patch: SaleRoomPatch) => { Object.assign(stored, patch); version += 1; };
function BothEntrypoints({ mobile }: { mobile: boolean }) {
  const [old, setOld] = useState(true);
  return <><button onClick={() => setOld(value => !value)}>Đổi lối vào</button>
    {old ? mobile ? <MobileDisplaySettings /> : <DisplaySettingsTab /> : <SaleRoomWorkspace mobile={mobile} />}</>;
}
async function priceField(mobile: boolean) {
  const current = screen.queryByRole('textbox', { name: 'Giá phòng 101' });
  if (current) return current;
  if (mobile) {
    const display = await screen.findByRole('button', { name: /^Giá phòng 101:/ });
    fireEvent.click(display); fireEvent.click(display);
  }
  return screen.findByRole('textbox', { name: 'Giá phòng 101' });
}
async function saveOld() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Lưu cài đặt' })[0]!);
  await waitFor(() => expect(sessionStorage.getItem(`sale-sheet-drafts:v2:${m.actor}:${ORG}`)).not.toContain('"prices":{"30000000'));
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); m.actor = ACTOR; m.org = ORG; m.owner = false;
  stored = { rent_price: 3_000_000, sale_note: 'Ghi chú gốc', amenities: ['Máy lạnh'], room_type: 'Studio', area: 20 };
  version = 1; receipts = new Map(); lostAck = false; denyWrites = false; failReads = false; policy = null;
  m.rpc.mockImplementation(async (name, args) => {
    if (name === 'get_sale_room_inventory_v1') {
      if (failReads) throw new TypeError('offline');
      return { data: structuredClone(snapshot()), error: null };
    }
    if (denyWrites) return { data: null, error: { code: '42501' } };
    const key = String(args.p_request_id);
    if (receipts.has(key)) return { data: receipts.get(key), error: null };
    if (args.p_expected_revision !== revision()) return { data: null, error: { code: 'PT409' } };
    editDirectly(args.p_patch as SaleRoomPatch);
    const receipt = { room_id: ROOM, building_id: BUILDING, request_id: key, revision: revision(), updated_at: new Date().toISOString(), fields: args.p_patch };
    receipts.set(key, receipt);
    if (lostAck) { lostAck = false; throw new TypeError('lost response after commit'); }
    return { data: receipt, error: null };
  });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(cache => cache.clear()); focusManager.setFocused(undefined); vi.useRealTimers(); });

describe('Old sheet / Quick / embedded Excel with real query and mutation hooks', () => {
  it.each(['Chủ trọ', 'Chủ công ty', 'Quản lý', 'Sale Admin', 'Sale'].flatMap(role => [false, true].map(mobile => ({ role, mobile }))))(
   '$role mobile=$mobile: lưu từ bảng cũ → Nhanh → Excel mới → bảng cũ cùng một dữ liệu', async ({ role, mobile }) => {
      m.owner = role === 'Chủ trọ' || role === 'Chủ công ty';
      render(<BothEntrypoints mobile={mobile} />, { wrapper: wrapper(client()) });
      fireEvent.change(await priceField(mobile), { target: { value: '3500000' } });
      await saveOld(); expect(stored.rent_price).toBe(3_500_000);
      fireEvent.click(screen.getByRole('button', { name: 'Đổi lối vào' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Mở Nhà đồng bộ · 101' }));
      expect(screen.getByLabelText('Giá niêm yết (đ/tháng)')).toHaveProperty('value', '3500000');
      fireEvent.change(screen.getByLabelText('Giá niêm yết (đ/tháng)'), { target: { value: '3700000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
      await screen.findByText('Đã lưu Nhà đồng bộ · 101.');
      fireEvent.click(screen.getByRole('button', { name: 'Bảng Excel' }));
      expect(await priceField(mobile)).toHaveProperty('value', '3.700.000');
      fireEvent.change(await priceField(mobile), { target: { value: '3900000' } });
      await saveOld(); fireEvent.click(screen.getByRole('button', { name: 'Đổi lối vào' }));
      expect(await priceField(mobile)).toHaveProperty('value', '3.900.000');
      expect(stored).toMatchObject({ rent_price: 3_900_000, sale_note: 'Ghi chú gốc', amenities: ['Máy lạnh'] });
      expect(receipts.size).toBe(3);
    });

  it('hai tab có cache riêng: mở lại tab đọc bản đã lưu; nháp cũ được giữ và chặn ghi đè', async () => {
    const oldCache = client(); const secondCache = client();
    render(<DisplaySettingsTab />, { wrapper: wrapper(oldCache) });
    fireEvent.change(await priceField(false), { target: { value: '4100000' } });
    const other = renderHook(() => ({ read: useSaleRoomInventory(), write: usePatchSaleRoom() }), { wrapper: wrapper(secondCache) });
    await waitFor(() => expect(other.result.current.read.isSuccess).toBe(true));
    await act(async () => { await other.result.current.write.mutateAsync({ roomId: ROOM, expectedRevision: revision(), requestId: crypto.randomUUID(), patch: { rent_price: 4_200_000 } }); });
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByText('Phòng đã thay đổi kể từ khi bắt đầu sửa. Đối chiếu trước khi lưu.');
    expect(await priceField(false)).toHaveProperty('value', '4.100.000');
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    await waitFor(() => expect(stored.rent_price).toBe(4_200_000));
    expect(receipts.size).toBe(1);
  });

  it('cache khác tự đọc thay đổi sau chu kỳ 5 giây khi tab đang hiển thị', async () => {
    vi.useFakeTimers();
    const view = renderHook(useSaleRoomInventory, { wrapper: wrapper(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(view.result.current.data?.rooms[0]?.rentPrice).toBe(3_000_000);
    editDirectly({ rent_price: 4_300_000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_020); });
    expect(view.result.current.data?.rooms[0]?.rentPrice).toBe(4_300_000);
  });

  it('đổi người dùng hoặc tổ chức không sử dụng cache trước đó trong lúc đang đọc', async () => {
    const cache = client(); const view = renderHook(useSaleRoomInventory, { wrapper: wrapper(cache) });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    m.rpc.mockImplementation(() => new Promise(() => {}));
    m.actor = '20000000-0000-4000-8000-000000000002'; view.rerender();
    expect(view.result.current.data).toBeUndefined();
    m.org = '10000000-0000-4000-8000-000000000002'; view.rerender();
    expect(view.result.current.data).toBeUndefined();
    expect(cache.getQueryData(['sale-room-inventory', ORG, ACTOR])).toBeDefined();
  });

  it('commit mất phản hồi: bảng mới đã thấy giá nhưng bảng cũ giữ yêu cầu rồi replay đúng ID, không ghi lần hai', async () => {
    const cache = client(); lostAck = true;
    render(<BothEntrypoints mobile={false} />, { wrapper: wrapper(cache) });
    fireEvent.change(await priceField(false), { target: { value: '4400000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    await screen.findByText(/Bấm Lưu để đối chiếu/);
    expect(stored.rent_price).toBe(4_400_000); expect(receipts.size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Đổi lối vào' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mở Nhà đồng bộ · 101' }));
    expect(screen.getByLabelText('Giá niêm yết (đ/tháng)')).toHaveProperty('value', '4400000');
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    fireEvent.click(screen.getByRole('button', { name: 'Đổi lối vào' }));
    await saveOld();
    const writes = m.rpc.mock.calls.filter(([name]) => name === 'update_room_sale_info_v1');
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(version).toBe(2);
  });

  it('bảng Nhanh đã commit nhưng mất phản hồi: thu hồi quyền trước replay vẫn giữ yêu cầu chưa xác nhận', async () => {
    lostAck = true;
    render(<SaleRoomWorkspace />, { wrapper: wrapper(client()) });
    fireEvent.click(await screen.findByRole('button', { name: 'Mở Nhà đồng bộ · 101' }));
    fireEvent.change(screen.getByLabelText('Giá niêm yết (đ/tháng)'), { target: { value: '4600000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await screen.findByRole('button', { name: 'Đối chiếu lần lưu' });
    expect(stored.rent_price).toBe(4_600_000); denyWrites = true;
    fireEvent.click(screen.getByRole('button', { name: 'Đối chiếu lần lưu' }));
    await screen.findByText('Bạn không còn quyền thực hiện thay đổi này ở tòa đã chọn.');
    expect(screen.getByRole('button', { name: 'Đối chiếu lần lưu' })).toBeTruthy();
    expect(screen.getByLabelText('Giá niêm yết (đ/tháng)').closest('fieldset')).toHaveProperty('disabled', true);
    expect(receipts.size).toBe(1); expect(version).toBe(2);
    const writes = m.rpc.mock.calls.filter(([name]) => name === 'update_room_sale_info_v1');
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });

  it('chính sách hết hạn rời cả bảng Nhanh và Excel dù lần đọc mới bị mất mạng', async () => {
    vi.useFakeTimers();
    policy = { id: '50000000-0000-4000-8000-000000000001', version: 1, title: 'Khuyến mãi', content: 'Ưu đãi thử', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 1000).toISOString(), status: 'ACTIVE', cancelled_at: null };
    const view = renderHook(useSaleRoomInventory, { wrapper: wrapper(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(view.result.current.data?.rooms[0]?.room.saleNote).toContain('Ưu đãi thử');
    failReads = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(view.result.current.data?.rooms[0]?.room.saleNote).toBe('Ghi chú gốc');
    expect(view.result.current.data?.buildings[0]?.rooms[0]?.saleNote).toBe('Ghi chú gốc');
    expect(view.result.current.isError).toBe(true);
  });
});
