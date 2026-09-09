// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import VacantRoomsReport from '@/pages/reports/real-estate/VacantRoomsReport';
import { readActivePageContext } from '../activePageContext';

const org = 'dddd0000-0000-4000-8000-000000000001';
const buildingId = '22222222-2222-4222-8222-222222222222';
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'dddd0000-0000-4000-8000-000000000001' }) }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Demo B' }] }) }));
vi.mock('@/hooks/useFloors', () => ({ useFloors: () => ({ data: [] }) }));
vi.mock('@/hooks/useReports', () => ({ useVacantRoomsReport: () => ({ data: [], isLoading: false }) }));
let location: ReturnType<typeof useLocation>;
function Page() { location = useLocation(); return <VacantRoomsReport />; }
function context() { return readActivePageContext({ ...location, organizationId: org }); }
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('publishes restored filters from the actual report on its alias route and removes them on unmount', () => {
  sessionStorage.setItem('flt:rpt-vacant-rooms:floorId', JSON.stringify('old-floor'));
  const mounted = render(<MemoryRouter initialEntries={['/reports/real-estate/vacant']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Page /></MemoryRouter>);
  expect(context()?.filters).toEqual(['floor_id=old-floor']);
  mounted.unmount();
  expect(context()).toBeUndefined();
  sessionStorage.removeItem('flt:rpt-vacant-rooms:floorId');
  sessionStorage.setItem('flt:rpt-vacant-rooms:buildingId', JSON.stringify(buildingId));
  render(<MemoryRouter initialEntries={['/reports/real-estate/vacant-rooms']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Page /></MemoryRouter>);
  expect(context()?.filters).toEqual([`building_id=${buildingId}`]);
});
