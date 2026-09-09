// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import RoomsMobilePage from '@/pages/rooms/RoomsMobilePage';
import { readActivePageContext } from '../activePageContext';

const fixtures = vi.hoisted(() => {
  const org = 'dddd0000-0000-4000-8000-000000000001';
  const buildingId = '22222222-2222-4222-8222-222222222222';
  return { org, buildingId, room: {
    id: '11111111-1111-4111-8111-111111111111', organization_id: org,
    building_id: buildingId, name: 'A101', code: 'A101', floor: 1, status: 'AVAILABLE',
    area: 20, max_occupants: 2, rent_price: 3000000, deposit_amount: 3000000,
    description: null, images: [], amenities: [], invoice_template_id: null, lease_template_id: null,
    created_at: '2026-09-01', updated_at: '2026-09-01', deleted_at: null,
    building: { id: buildingId, name: 'Demo', code: 'D' },
  } };
});
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: fixtures.org }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [fixtures.room], isLoading: false }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [fixtures.room.building] }) }));
vi.mock('@/hooks/useRoomsWithContracts', () => ({ useRoomsWithActiveContracts: () => ({ data: [] }) }));
// Unrelated create/edit form owns separate data requests; this test exercises the real list and detail sheet.
vi.mock('@/components/rooms/RoomFormDialog', () => ({ default: () => null }));
let location: ReturnType<typeof useLocation>;
function Page() { location = useLocation(); return <RoomsMobilePage />; }
function context() { return readActivePageContext({ ...location, organizationId: fixtures.org }); }
afterEach(() => { cleanup(); sessionStorage.clear(); });

it('publishes filters and opened detail from the actual room page controls', () => {
  render(<MemoryRouter initialEntries={['/apartments']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Page /></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Toà nhà' }), { target: { value: fixtures.buildingId } });
  fireEvent.click(screen.getByRole('button', { name: 'Trống' }));
  expect(context()?.filters).toEqual([`building_id=${fixtures.buildingId}`, 'status=AVAILABLE']);
  fireEvent.click(screen.getByText('A101'));
  expect(context()?.entityId).toBe(fixtures.room.id);
  fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
  expect(context()?.entityId).toBeUndefined();
  fireEvent.change(screen.getByPlaceholderText('Tìm phòng, mã căn hộ…'), { target: { value: 'private-search' } });
  expect(context()?.incompleteFilters).toBe(true);
  expect(JSON.stringify(context())).not.toContain('private-search');
});
