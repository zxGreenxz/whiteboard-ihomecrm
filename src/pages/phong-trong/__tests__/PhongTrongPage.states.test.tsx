// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PhongTrongPage from '../PhongTrongPage';
import { PublicRoomLinkError } from '../supabaseData';

const query = vi.hoisted(() => ({
  data: [] as unknown[], isLoading: false, isError: false,
  error: null as Error | { code?: string; message?: string } | null,
  refetch: vi.fn(),
}));
vi.mock('../usePhongTrong', () => ({ usePhongTrong: () => query }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: null }), can: () => false }));
vi.mock('../QuickDepositModal', () => ({ QuickDepositModal: () => null }));
vi.mock('../useTracking', () => ({
  useTracking: () => ({ track: () => undefined, trackError: () => undefined }),
  useTrack: () => ({ track: () => undefined, trackError: () => undefined }),
  TrackingProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  Object.assign(query, { data: [], isLoading: false, isError: false, error: null });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
const open = (props: Parameters<typeof PhongTrongPage>[0] = { token: 'test-link' }) =>
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><PhongTrongPage {...props} /></MemoryRouter>);

describe('public room data states', () => {
  it('an empty live result stays empty instead of displaying invented rooms', () => {
    open();
    expect(screen.getByText('Hiện chưa có phòng trống.')).toBeTruthy();
    expect(screen.queryByTitle('Tải ảnh danh sách phòng trống')).toBeNull();
  });

  it('a missing link never opens the sample listing', () => {
    open({});
    expect(screen.getByText(/Liên kết không hợp lệ/)).toBeTruthy();
    expect(screen.queryByTitle('Tải ảnh danh sách phòng trống')).toBeNull();
  });

  it('a network failure is recoverable and does not claim the link expired', () => {
    Object.assign(query, { isError: true, error: { message: 'Failed to fetch' } });
    open();
    expect(screen.getByText(/Chưa tải được danh sách phòng/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
    expect(screen.queryByText(/Liên kết không hợp lệ/)).toBeNull();
  });

  it('loading cannot expose sample rooms', () => {
    query.isLoading = true;
    open();
    expect(screen.getByText('Đang tải danh sách phòng…')).toBeTruthy();
    expect(screen.queryByTitle('Tải ảnh danh sách phòng trống')).toBeNull();
  });

  it('a revoked link asks for a new link without showing a listing', () => {
    Object.assign(query, { isError: true, error: new PublicRoomLinkError() });
    open();
    expect(screen.getByText(/Liên kết không hợp lệ/)).toBeTruthy();
    expect(screen.queryByTitle('Tải ảnh danh sách phòng trống')).toBeNull();
  });

  it('embedded empty data remains empty without requiring a public token', () => {
    open({ embedded: true, buildings: [] });
    expect(screen.getByText('Hiện chưa có phòng trống.')).toBeTruthy();
  });
});
