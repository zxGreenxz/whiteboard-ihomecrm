// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft } from '@/lib/contractDrafts';
import { useContractDraftForm } from '../useContractDraftForm';

const defaults = vi.hoisted(() => ({ rows: undefined as unknown, isPending: true }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [
  { id: '22222222-2222-4222-8222-222222222222', organization_id: '11111111-1111-4111-8111-111111111111' },
  { id: '88888888-8888-4888-8888-888888888888', organization_id: '99999999-9999-4999-8999-999999999999' },
] }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: defaults.rows, isPending: defaults.isPending, isSuccess: !defaults.isPending }) }));

afterEach(cleanup);
it('keeps the saved service snapshot when opening a draft while defaults load, then when defaults change', () => {
  defaults.rows = undefined;
  defaults.isPending = true;
  const payload = emptyContractDraftPayload();
  payload.services = [{ id: '44444444-4444-4444-8444-444444444444', name: 'Internet', unit_price: 100000,
    unit: 'tháng', type: 'FIXED', pricing_type: 'FIXED', initial_reading: 0, quantity: 1 }];
  const draft: ContractDraft = { id: '77777777-7777-4777-8777-777777777777', organization_id: '11111111-1111-4111-8111-111111111111',
    building_id: '22222222-2222-4222-8222-222222222222', room_id: null, payload, template_id: null, revision: 1,
    created_by: '66666666-6666-4666-8666-666666666666', created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', documents: [] };
  const { result, rerender } = renderHook(() => useContractDraftForm(true, draft));
  expect(result.current.buildings.map(building => building.id)).toEqual([draft.building_id]);
  expect(result.current.getPayload().services).toEqual(payload.services);
  act(() => result.current.handleToggleCustomServices(true));
  act(() => result.current.handleToggleCustomServices(false));
  expect(result.current.getPayload().services).toEqual(payload.services);
  act(() => {
    defaults.isPending = false;
    defaults.rows = [{ service_id: payload.services[0].id, is_active: true, unit_price_override: 250000,
      service: { ...payload.services[0], unit_price: 250000 } }];
    rerender();
  });
  expect(result.current.getPayload().services).toEqual(payload.services);
});
