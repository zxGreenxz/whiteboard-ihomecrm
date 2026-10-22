// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Room } from '@/pages/phong-trong/sampleData';
import type { RoomListTable } from '@/pages/phong-trong/roomListTable';
import type { SaleRoomInventory, SaleRoomRpcInvoker } from '@/lib/saleRoomOperations';
import type { PublicRoomSettings } from '@/hooks/usePublicRoomSettings';
import { sheetInventoryFixture } from './sheetInventoryFixture';
interface QueryFixture<T> {
  data: T;
  status: 'success' | 'error' | 'pending';
  fetchStatus: 'idle' | 'fetching' | 'paused';
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  dataUpdatedAt: number;
  refetch: () => unknown;
}
interface PermissionFixture {
  __superadmin?: boolean;
  sale_phong?: { edit?: { org_wide: boolean; building_ids: string[] } };
}
interface HotlineFixture { id: string; phone_number: string; is_active: boolean }
const ORG = '10000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000001';
const B1 = '40000000-0000-4000-8000-000000000001';
const R1 = '30000000-0000-4000-8000-000000000001';
const R2 = '30000000-0000-4000-8000-000000000002';
const m = vi.hoisted(() => {
  const retry = vi.fn<() => Promise<unknown>>();
  const initialQuery = <T,>(data: T): QueryFixture<T> => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, dataUpdatedAt: 0, refetch: retry });
  const perms: PermissionFixture = {};
  return {
    inventory: initialQuery<SaleRoomInventory>({ rooms: [], buildings: [], serverNow: '2026-10-21T01:00:00Z', nextPolicyBoundaryAt: null, settingsOwnerId: null, canManageAccountSettings: false }),
    settings: initialQuery<PublicRoomSettings>({ soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null }),
    hotlines: initialQuery<HotlineFixture[]>([]), perms, org: '', actor: '', rpc: vi.fn<SaleRoomRpcInvoker>(),
    saveSettings: vi.fn(), createHotline: vi.fn(), updateHotline: vi.fn(), retry,
    exportImage: vi.fn<(buildings: Building[]) => Promise<number>>(),
    drawImage: vi.fn<(table: RoomListTable) => { toDataURL: () => string }>(),
  };
});
vi.mock('@/pages/phong-trong/exportRoomListImage', () => ({ downloadRoomListImage: m.exportImage, drawRoomListImage: m.drawImage }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc, from: vi.fn(() => { throw new Error('Unexpected direct table write'); }) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: m.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: m.actor } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms, isError: false }) }));
vi.mock('@/hooks/useSaleRoomInventory', () => ({ useSaleRoomInventory: () => m.inventory }));
vi.mock('@/hooks/usePublicRoomSettings', () => ({
  usePublicRoomSettings: () => m.settings, useUpsertPublicRoomSettings: () => ({ mutateAsync: m.saveSettings, isPending: false }),
  PUBLIC_ROOM_SETTINGS_DEFAULTS: { soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null },
}));
vi.mock('@/hooks/useHotlines', () => ({ useHotlines: () => m.hotlines, useCreateHotline: () => ({ mutateAsync: m.createHotline, isPending: false }), useUpdateHotline: () => ({ mutateAsync: m.updateHotline, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../QuickRoomBoard', () => ({ default: () => <div>Bảng nhanh cùng danh sách phòng</div> }));
import DisplaySettingsTab from '../DisplaySettingsTab';
import MobileDisplaySettings from '../mobile/MobileDisplaySettings';
import SaleRoomWorkspace from '../SaleRoomWorkspace';
import { formatPriceInput } from '../roomListSheetDraft';
const room = (id: string, code: string): Room => ({ id, code, no: Number(code), buildingId: B1, buildingName: 'Nhà A', buildingArea: '', buildingAddr: '123 Đường A', floor: 1, type: 'Studio', price: 4, area: 20, status: 'free', amenities: ['Máy lạnh'], availDate: null, imgCount: 0, phClass: '', saleFactKey: 'fact-a', saleNote: 'Ghi chú nền', x: 0, y: 0, w: 0, h: 0 });
const building = (): Building => ({ id: B1, code: 'A', name: 'Nhà A', area: '', district: '', address: '123 Đường A', manager: '', phone: '0900000000', contactPhone: '', hotline: '0900000000', salePolicy: 'Chính sách của chủ nhà', lift: false, policy: '', floors: [], freeCount: 2, total: 2, rooms: [room(R1, '101'), room(R2, '102')] });
const query = <T,>(data: T): QueryFixture<T> => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, dataUpdatedAt: Date.now(), refetch: m.retry });
let cache: QueryClient;
const wrap = (child: React.ReactNode) => <QueryClientProvider client={cache}><MemoryRouter><div className="cm-app">{child}</div></MemoryRouter></QueryClientProvider>;
const price = () => screen.getByRole('textbox', { name: 'Giá phòng 101' });
const save = () => screen.getAllByRole('button', { name: 'Lưu cài đặt' })[0]!;
const enterPrice = (value: string) => fireEvent.change(price(), { target: { value } });
const draftKey = () => `sale-sheet-drafts:v2:${m.actor}:${m.org}`;
const storedDraft = () => JSON.parse(sessionStorage.getItem(draftKey()) ?? '{}');
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); m.org = ORG; m.actor = ACTOR; m.perms = { __superadmin: true };
  cache = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  m.inventory = query({ ...sheetInventoryFixture([building()]), settingsOwnerId: ACTOR });
  m.settings = query({ soon_days: 30, show_rented: true, hotline_id: null, sale_policy: 'Chính sách của chủ nhà' });
  m.hotlines = query([{ id: 'hotline-a', phone_number: '0900000000', is_active: true }]);
  m.retry.mockResolvedValue({ isError: false }); m.saveSettings.mockResolvedValue({});
  m.rpc.mockImplementation(async (_name, args) => ({ data: { room_id: args.p_room_id, building_id: B1, request_id: args.p_request_id, revision: 'b'.repeat(32), updated_at: '2026-10-21T01:00:00Z', fields: args.p_patch }, error: null }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); cache.clear(); vi.restoreAllMocks(); });
describe('Excel room operations acceptance', () => {
  it.each([
    ['E01', 'Chủ trọ', true], ['E02', 'Chủ công ty', true], ['E03', 'Quản lý', false], ['E04', 'Sale Admin', false], ['E05', 'Sale', false],
  ])('%s · %s: cập nhật giá trong phạm vi mà không ghi cài đặt chủ tài khoản', async (_id, _role, ownsSettings) => {
    m.inventory.data.canManageAccountSettings = ownsSettings;
    if (!ownsSettings) { m.inventory.data.settingsOwnerId = '20000000-0000-4000-8000-000000000002'; m.perms = { sale_phong: { edit: { org_wide: false, building_ids: [B1] } } }; }
    render(wrap(<DisplaySettingsTab />)); expect(price()).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Hotline chung cho tất cả nhà')).toHaveProperty('disabled', !ownsSettings);
    enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce());
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_room_id: R1, p_patch: { rent_price: 4500000 }, p_expected_revision: 'a'.repeat(32) });
    expect(m.saveSettings).not.toHaveBeenCalled(); expect(m.createHotline).not.toHaveBeenCalled();
  });
  it('E06 · Sale: phòng ngoài quyền sửa chỉ đọc, kể cả quyền cài đặt rộng', () => {
    m.inventory.data.rooms[0]!.capabilities.edit = false;
    render(wrap(<DisplaySettingsTab />)); expect(price()).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Chính sách sale phòng 101')).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: 'Giá phòng 102' })).toHaveProperty('disabled', false);
  });
  it('E07 · Quản lý: đang sửa mà tải lại thất bại thì giữ ô và khóa ghi', () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000');
    m.inventory = { ...m.inventory, isError: true, status: 'error', error: new Error('network') }; view.rerender(wrap(<DisplaySettingsTab />));
    expect(price()).toHaveProperty('value', '4.500.000'); expect(save()).toHaveProperty('disabled', true); expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E08 · Sale Admin: người khác sửa phòng thì giữ bản nháp và không ghi đè', async () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000');
    m.inventory.data.rooms[0]!.revision = 'b'.repeat(32); view.rerender(wrap(<DisplaySettingsTab />));
    expect(price()).toHaveProperty('value', '4.500.000'); fireEvent.click(save());
    await waitFor(() => expect(screen.getAllByText(/Phòng đã thay đổi kể từ/).length).toBeGreaterThan(0)); expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E09 · Chủ trọ: có thể bỏ nháp xung đột sau khi xác nhận rõ', () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); m.inventory.data.rooms[0]!.revision = 'b'.repeat(32); view.rerender(wrap(<DisplaySettingsTab />));
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ nháp phòng 101 và dùng bản mới' }));
    expect(window.confirm).toHaveBeenCalledOnce(); expect(price()).toHaveProperty('value', '4.000.000');
  });
  it('E10 · Sale Admin: mất phản hồi thì đối chiếu cùng mã và nội dung, không tạo yêu cầu mới', async () => {
    const original = m.rpc.getMockImplementation()!; m.rpc.mockRejectedValueOnce(new Error('network')).mockImplementation(original);
    render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(screen.getByText(/Bấm Lưu để đối chiếu/)).toBeTruthy());
    expect(price()).toHaveProperty('disabled', true); expect(screen.queryByRole('button', { name: /Bỏ nháp phòng 101/ })).toBeNull();
    const first = m.rpc.mock.calls[0]![1]; fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2)); expect(m.rpc.mock.calls[1]![1]).toEqual(first);
  });
  it('E11 · Quản lý: yêu cầu chưa xác nhận vẫn giữ nguyên sau đóng mở màn hình', async () => {
    m.rpc.mockRejectedValueOnce(new Error('network')); const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(screen.getByText(/Bấm Lưu để đối chiếu/)).toBeTruthy()); const first = m.rpc.mock.calls[0]![1];
    view.unmount(); render(wrap(<DisplaySettingsTab />)); expect(price()).toHaveProperty('value', '4.500.000'); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2)); expect(m.rpc.mock.calls[1]![1]).toEqual(first);
  });
  it('E12 · Chủ công ty: chuyển công ty không lẫn bản nháp rồi quay lại vẫn còn', () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); const oldOrg = m.org;
    m.org = '10000000-0000-4000-8000-000000000002'; view.rerender(wrap(<DisplaySettingsTab />)); expect(price()).toHaveProperty('value', '4.000.000');
    m.org = oldOrg; view.rerender(wrap(<DisplaySettingsTab />)); expect(price()).toHaveProperty('value', '4.500.000');
  });
  it('E13 · Sale: tài khoản khác không nhìn thấy bản nháp của tôi', () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); m.actor = '20000000-0000-4000-8000-000000000002'; view.rerender(wrap(<DisplaySettingsTab />));
    expect(price()).toHaveProperty('value', '4.000.000');
  });
  it('E14 · Sale Admin: chuyển Nhanh và Excel giữ ô đang gõ', () => {
    render(wrap(<SaleRoomWorkspace />)); fireEvent.click(screen.getByRole('button', { name: 'Bảng Excel' })); enterPrice('4500000');
    fireEvent.click(screen.getByRole('button', { name: 'Nhanh' })); expect(screen.getByText('Bảng nhanh cùng danh sách phòng')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bảng Excel' })); expect(price()).toHaveProperty('value', '4.500.000');
  });
  it('E15 · Chủ trọ: giá 0 hợp lệ, không cắt giá vượt 13 chữ số thành giá khác', async () => {
    expect(formatPriceInput('99999999999999')).toBe('99.999.999.999.999'); render(wrap(<DisplaySettingsTab />)); enterPrice('99999999999999'); fireEvent.click(save());
    await waitFor(() => expect(price().getAttribute('aria-invalid')).toBe('true')); expect(m.rpc).not.toHaveBeenCalled();
    enterPrice('0'); fireEvent.click(save()); await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); expect(m.rpc.mock.calls[0]![1].p_patch).toEqual({ rent_price: 0 });
  });
  it('E16 · Quản lý: xóa nội thất gửi danh sách rỗng, không gửi null', async () => {
    render(wrap(<DisplaySettingsTab />)); fireEvent.change(screen.getByLabelText('Nội thất phòng 101'), { target: { value: '' } }); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); expect(m.rpc.mock.calls[0]![1].p_patch).toEqual({ amenities: [] });
  });
  it('E17 · Sale: chương trình đang áp dụng chỉ đọc, không bị chép vào ghi chú nền khi lưu giá', async () => {
    m.inventory.data.rooms[0]!.activePolicyText = 'Ưu đãi tới 31/10'; m.inventory.data.buildings[0]!.rooms[0]!.saleNote = 'Ghi chú nền\nƯu đãi tới 31/10';
    render(wrap(<DisplaySettingsTab />)); expect(screen.getByLabelText('Chính sách sale phòng 101')).toHaveProperty('value', 'Ghi chú nền');
    expect(screen.getByLabelText('Chương trình đang áp dụng phòng 101').textContent).toContain('Ưu đãi tới 31/10'); enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); expect(m.rpc.mock.calls[0]![1].p_patch).toEqual({ rent_price: 4500000 });
  });
  it('E18 · Sale Admin: phòng biến mất khỏi phạm vi vẫn giữ nháp và báo rõ', async () => {
    const view = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); m.inventory.data.rooms = []; m.inventory.data.buildings = []; view.rerender(wrap(<DisplaySettingsTab />));
    expect(screen.getByText(/Phòng không còn trong danh sách được giao/)).toBeTruthy(); fireEvent.click(save());
    await waitFor(() => expect(storedDraft().edits.prices[R1]).toBe('4.500.000')); expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E19 · Chủ công ty: lô lưu dở chỉ xóa ô đã xác nhận, giữ phòng bị từ chối', async () => {
    const original = m.rpc.getMockImplementation()!; m.rpc.mockImplementation((name, args) => args.p_room_id === R2 ? Promise.resolve({ data: null, error: { code: '42501' } }) : original(name, args));
    render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.change(screen.getByRole('textbox', { name: 'Giá phòng 102' }), { target: { value: '4600000' } }); fireEvent.click(save());
    await waitFor(() => expect(screen.getByText(/Đã lưu 1\/2 ô/)).toBeTruthy()); expect(storedDraft().edits.prices[R1]).toBeUndefined(); expect(storedDraft().edits.prices[R2]).toBe('4.600.000');
  });
  it('E20 · Sale trên điện thoại: bản nháp dùng chung với Excel desktop và lưu đúng phòng', async () => {
    const desktop = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); desktop.unmount(); render(wrap(<MobileDisplaySettings />));
    expect(screen.getByRole('button', { name: /Giá phòng 101: 4\.500\.000/ })).toBeTruthy(); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_room_id: R1, p_patch: { rent_price: 4500000 } });
  });
  it.each([['E32', '42501'], ['E33', 'PT409']])('%s · Chủ trọ: lần đối chiếu bị %s không xóa trạng thái chưa xác nhận trước đó', async (_id, code) => {
    m.rpc.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: null, error: { code } });
    render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(screen.getByText(/Bấm Lưu để đối chiếu/)).toBeTruthy()); const first = m.rpc.mock.calls[0]![1];
    fireEvent.click(save()); await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(storedDraft().requests[R1].outcome).toBe('unknown'));
    expect(storedDraft().requests[R1].input.requestId).toBe(first.p_request_id);
    expect(price()).toHaveProperty('disabled', true); expect(screen.queryByRole('button', { name: /Bỏ nháp phòng 101/ })).toBeNull();
  });
  it('E34 · Quản lý: request đang bay khi màn hình bị đóng được đối chiếu cùng ID sau mở lại', async () => {
    m.rpc.mockImplementationOnce(() => new Promise(() => {}));
    const firstView = render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.click(save());
    await waitFor(() => expect(m.rpc).toHaveBeenCalledOnce()); const first = m.rpc.mock.calls[0]![1];
    firstView.unmount(); render(wrap(<DisplaySettingsTab />));
    expect(screen.getByText(/Bấm Lưu để đối chiếu/)).toBeTruthy(); expect(price()).toHaveProperty('disabled', true);
    fireEvent.click(save()); await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2)); expect(m.rpc.mock.calls[1]![1]).toEqual(first);
  });
  it('E35 · Sale Admin: không gửi khi trình duyệt không giữ được mã đối chiếu', async () => {
    render(wrap(<DisplaySettingsTab />)); enterPrice('4500000');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    fireEvent.click(save()); await waitFor(() => expect(screen.getByText(/chưa gửi lần lưu/)).toBeTruthy());
    expect(m.rpc).not.toHaveBeenCalled(); expect(price()).toHaveProperty('value', '4.500.000');
  });
  it('E36 · Chủ công ty: ảnh xem trước lấy chính sách mới và giữ giá đang nhập', async () => {
    const fresh = structuredClone(m.inventory.data); fresh.serverNow = '2026-10-21T07:00:00Z';
    m.inventory.data.rooms[0]!.activePolicyText = 'Chương trình cũ đã hết hạn';
    fresh.rooms[0]!.activePolicyText = ''; m.retry.mockResolvedValue({ data: fresh, isError: false }); m.exportImage.mockResolvedValue(2);
    render(wrap(<DisplaySettingsTab />)); enterPrice('4500000'); fireEvent.click(screen.getByRole('button', { name: 'Tải ảnh xem trước' }));
    await waitFor(() => expect(m.exportImage).toHaveBeenCalledOnce());
    const exported = m.exportImage.mock.calls[0]![0][0]!.rooms[0]!; expect(exported.price).toBe(4.5); expect(exported.saleNote).toBe('Ghi chú nền'); expect(m.retry).toHaveBeenCalledOnce();
  });
  it('E37 · Sale: tải chính sách mới thất bại thì không xuất ảnh cũ', async () => {
    m.retry.mockResolvedValue({ data: m.inventory.data, isError: true, error: new Error('offline') });
    render(wrap(<DisplaySettingsTab />)); fireEvent.click(screen.getByRole('button', { name: 'Tải ảnh xem trước' }));
    await waitFor(() => expect(m.retry).toHaveBeenCalledOnce()); expect(m.exportImage).not.toHaveBeenCalled();
  });
  it('E38 · Quản lý trên điện thoại: xem trước ảnh cũng đọc chính sách mới thay vì chụp cache', async () => {
    const fresh = structuredClone(m.inventory.data); fresh.rooms[0]!.saleNote = 'Nội dung mới nhất';
    m.retry.mockResolvedValue({ data: fresh, isError: false }); m.drawImage.mockReturnValue({ toDataURL: () => 'data:image/png;base64,test' });
    render(wrap(<MobileDisplaySettings />)); fireEvent.click(screen.getByRole('button', { name: 'Xem trước ảnh' }));
    await waitFor(() => expect(m.drawImage).toHaveBeenCalledOnce()); expect(m.retry).toHaveBeenCalledOnce();
    expect(JSON.stringify(m.drawImage.mock.calls[0]![0])).toContain('Nội dung mới nhất');
  });
});
