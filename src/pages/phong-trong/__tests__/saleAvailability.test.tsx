// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomCard } from '../PhongTrongParts';
import { DetailSheet } from '../PhongTrongSheet';
import PhongTrongPage from '../PhongTrongPage';
import { mapPayloadToBuildings, type RpcPayload } from '../supabaseData';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('../usePhongTrong', () => ({ usePhongTrong: () => ({}) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: null }), can: () => false }));
vi.mock('../QuickDepositModal', () => ({ QuickDepositModal: () => null }));
vi.mock('../useTracking', () => ({
  useRoomImpression: () => ({ current: null }),
  useTracking: () => ({ track: vi.fn(), trackError: vi.fn() }),
  useTrack: () => ({ track: vi.fn(), trackError: vi.fn() }),
  TrackingProvider: ({ children }: { children: React.ReactNode }) => children,
}));
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà thật', code: 'B', district: null, ward: null, address: 'Địa chỉ thật', total_floors: 1 }],
  rooms: [{ id: 'r', building_id: 'b', floor: 1, name: '101', code: null, area: 20, rent_price: 4000000,
    max_occupants: 2, amenities: [], images: [], description: null, status_public: 'free', avail_date: null,
    sale_state: 'PREPARING', sale_today: '2026-09-28', expected_ready_on: null }],
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('actual sale room presentation', () => {
  it('renders preparation instead of ready now and never loads a sample photograph', () => {
    const [building] = mapPayloadToBuildings(payload);
    render(<RoomCard r={building.rooms[0]} onOpen={vi.fn()} />);
    expect(screen.getAllByText('Đang chuẩn bị · chưa có ngày dự kiến')).toHaveLength(2);
    expect(screen.queryByText('Trống sẵn')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByLabelText('Chưa có ảnh phòng')).toBeTruthy();
  });
  it('shares the same unknown readiness fact and disables missing contact/photo actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const [building] = mapPayloadToBuildings(payload);
    render(<DetailSheet room={building.rooms[0]} show onClose={vi.fn()} onToast={vi.fn()} saved={[]}
      toggleSave={vi.fn()} onGo={vi.fn()} buildings={[building]} />);
    expect((screen.getByRole('button', { name: 'Chưa có số liên hệ' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Zalo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Tải ảnh' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0][0]);
    expect(text).toContain('Đang chuẩn bị · chưa có ngày dự kiến');
    expect(text).not.toMatch(/100k|150k|Free xe|Trống sẵn|0923/);
  });
  it('updates an already open detail after notice changes and removes it when a hold blocks the room', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const initial = mapPayloadToBuildings({ ...payload, rooms: [{ ...payload.rooms[0], status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-01' }] });
    const view = render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><PhongTrongPage embedded buildings={initial} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Toà thật/ }));
    fireEvent.click(screen.getByText('101'));
    expect(screen.getAllByText('Sắp trống · 01/10/2026').length).toBeGreaterThan(2);
    const updated = mapPayloadToBuildings({ ...payload, rooms: [{ ...payload.rooms[0], status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-03' }] });
    view.rerender(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><PhongTrongPage embedded buildings={updated} /></MemoryRouter>);
    expect(screen.queryByText('Sắp trống · 01/10/2026')).toBeNull();
    expect(screen.getAllByText('Sắp trống · 03/10/2026').length).toBeGreaterThan(2);
    const blocked = mapPayloadToBuildings({ ...payload, rooms: [{ ...payload.rooms[0], status_public: 'rented', sale_state: 'RENTED' }] });
    view.rerender(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><PhongTrongPage embedded buildings={blocked} /></MemoryRouter>);
    expect(screen.queryByText('Sắp trống · 03/10/2026')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chia sẻ' })).toBeNull();
  });
});
