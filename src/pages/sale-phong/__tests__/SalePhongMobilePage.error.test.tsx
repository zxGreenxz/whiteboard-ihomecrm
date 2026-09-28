// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SalePhongMobilePage from '../SalePhongMobilePage';

const query = vi.hoisted(() => ({ data: [{}], isLoading: false, isError: false, refetch: vi.fn() }));
vi.mock('@/hooks/useMyAvailableRooms', () => ({ useMyAvailableRooms: () => query }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: null }) }));
vi.mock('@/hooks/usePublicRoomTokens', () => ({ usePublicRoomTokens: () => ({ data: [] }) }));
vi.mock('@/hooks/usePassListings', () => ({ usePassListings: () => ({ data: [] }) }));
vi.mock('@/pages/phong-trong/PhongTrongPage', () => ({ default: () => <div>Danh sách đã cache</div> }));
afterEach(() => { cleanup();Object.assign(query, { data: [{}], isLoading: false, isError: false });query.refetch.mockClear(); });
const open = () => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><SalePhongMobilePage /></MemoryRouter>);

describe('authenticated sale error state', () => {
  it('does not advertise cached rooms after a refresh failure and provides retry', () => {
    query.isError = true;open();
    expect(screen.queryByText('Danh sách đã cache')).toBeNull();
    expect(screen.getByText('Chưa tải được danh sách phòng. Thử lại để xem tình trạng hiện tại.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
  it('retains successful embedded lists including an empty result', () => {
    query.data = [];open();
    expect(screen.getByText('Danh sách đã cache')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  });
});
