import {runContractEdit} from '@/lib/contractEditWorkflow';
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, emptyDraftOwner, type ContractDraft } from '@/lib/contractDrafts';
import { buildContractDraftPayload } from '@/lib/contractDraftEditor';
import { useContractFormState } from './useContractFormState';

const defaults = vi.hoisted(() => ({ rows: [] as unknown[], buildingError: false, roomError: false, serviceError: false, accountError: false, orphanError: false }));
vi.mock('@/hooks/useContracts', () => ({ useCreateContract: () => ({ isPending: false }),
  useUpdateContract: () => ({ isPending: false }), useSyncContractCustomers: () => ({ isPending: false }),
  useSyncContractServices: () => ({ isPending: false }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: defaults.buildingError ? undefined : [], isError: defaults.buildingError, refetch: vi.fn() }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: defaults.roomError ? undefined : [{ id: '11111111-1111-4111-8111-111111111111', rent_price: 9000000 }], isError: defaults.roomError, refetch: vi.fn() }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: defaults.serviceError ? undefined : defaults.rows, isError: defaults.serviceError, refetch: vi.fn() }) }));
vi.mock('@/hooks/useDeposits', () => ({ useOrphanDepositVouchers: () => ({ data: defaults.orphanError ? undefined : [], isError: defaults.orphanError, refetch: vi.fn() }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: defaults.accountError ? undefined : [], isError: defaults.accountError, refetch: vi.fn() }) }));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: '99999999-9999-4999-8999-999999999999' } }) }));

const room = '11111111-1111-4111-8111-111111111111';
const building = '22222222-2222-4222-8222-222222222222';
const payload = buildContractDraftPayload({ form: { ...emptyContractDraftPayload().form,
  room_id: room, rent_price: 3200000, total_deposit: 3700000, notes: 'Lưu từ nháp',
  start_date: '2026-09-29', start_billing_date: '2026-09-29', end_billing_date: '2026-10-05',
  deposit_debt_mode: 'DEBT', deposit_debt_reason: 'Hẹn trả', deposit_topup_due_date: '2026-10-05' },
  selectedCustomers: [], selectedServices: [], buildingServices: [], useCustomServices: false,
  depositRows: [{ uid: 'dep-1', amount: 500000, account_id: '', received_date: '2026-09-29', images: [] }],
  invoiceItems: [{ id: 'manual-1', type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí sửa', unit_price: 12000, quantity: 1 }],
  rentUnlocked: false, depositUnlocked: false }, emptyDraftOwner());
const makeDraft = (notes: string): ContractDraft => ({ id: '33333333-3333-4333-8333-333333333333',
  organization_id: '44444444-4444-4444-8444-444444444444', building_id: building, room_id: room,
  template_id: null, revision: 1, payload: { ...payload, form: { ...payload.form, notes } },
  created_by: '55555555-5555-4555-8555-555555555555', created_at: '2026-09-29', updated_at: '2026-09-29', documents: [] });
afterEach(cleanup);

it('giữ nháp và chặn lưu khi nguồn phòng, dịch vụ tòa hoặc sổ quỹ lỗi', async () => {
  defaults.rows = []; defaults.roomError = true; defaults.serviceError = true; defaults.accountError = true;
  const { result } = renderHook(() => useContractFormState({ open: true, draft: makeDraft('Nháp cần giữ') }));
  await waitFor(() => expect(result.current.selectedBuildingId).toBe(building));
  expect(result.current.sourceIssues.map(issue => issue.key)).toEqual(['rooms', 'buildingServices', 'accounts']);
  expect(result.current.form.getValues('notes')).toBe('Nháp cần giữ');
  defaults.roomError = false; defaults.serviceError = false; defaults.accountError = false;
});

it('không xem lỗi đọc cọc cũ là phòng chưa có cọc', async () => {
  defaults.orphanError = true;
  const { result } = renderHook(() => useContractFormState({ open: true, draft: makeDraft('Giữ dữ liệu cọc') }));
  await waitFor(() => expect(result.current.selectedRoomId).toBe(room));
  expect(result.current.sourceIssues.map(issue => issue.key)).toContain('orphanDeposits');
  expect(result.current.form.getValues('notes')).toBe('Giữ dữ liệu cọc');
  defaults.orphanError = false;
});

it('hydrates one saved draft per open/id and preserves edits against query refresh and default effects', async () => {
  defaults.rows = [];
  const initial = makeDraft('Lưu từ nháp');
  const { result, rerender } = renderHook(({ open, draft }) => useContractFormState({ open, draft }),
    { initialProps: { open: true, draft: initial } });
  await waitFor(() => expect(result.current.form.getValues('notes')).toBe('Lưu từ nháp'));
  expect(result.current.selectedBuildingId).toBe(building);
  expect(result.current.form.getValues('rent_price')).toBe(3200000);
  expect(result.current.form.getValues('total_deposit')).toBe(3700000);
  expect(result.current.invoiceItems[0]?.description).toBe('Phí sửa');
  expect(result.current.depositRows[0]?.amount).toBe(500000);
  expect([result.current.rentUnlocked, result.current.depositUnlocked]).toEqual([false, false]);
  act(() => result.current.form.setValue('notes', 'Đang gõ dở'));
  rerender({ open: true, draft: makeDraft('Bản query vừa refresh') });
  expect(result.current.form.getValues('notes')).toBe('Đang gõ dở');
  expect(result.current.invoiceItems[0]?.description).toBe('Phí sửa');
  rerender({ open: false, draft: makeDraft('Bản mới lúc mở lại') });
  rerender({ open: true, draft: makeDraft('Bản mới lúc mở lại') });
  await waitFor(() => expect(result.current.form.getValues('notes')).toBe('Bản mới lúc mở lại'));
});

it('keeps an older draft’s saved building-service snapshot while live defaults load and change', () => {
  defaults.rows = [];
  const service = { id: '66666666-6666-4666-8666-666666666666', name: 'Internet', unit_price: 100000,
    unit: 'tháng', type: 'FIXED', pricing_type: 'FIXED', initial_reading: 0, quantity: 1 };
  const old = makeDraft('Nháp cũ');
  old.payload = { ...emptyContractDraftPayload(), services: [service] };
  const { result, rerender } = renderHook(() => useContractFormState({ open: true, draft: old }));
  expect(result.current.getDraftPayload().services).toEqual([service]);
  act(() => result.current.handleToggleCustomServices(true));
  act(() => result.current.handleToggleCustomServices(false));
  expect(result.current.getDraftPayload().services).toEqual([service]);
  act(() => {
    defaults.rows = [{ service_id: service.id, is_active: true, unit_price_override: 250000,
      service: { ...service, unit_price: 250000 } }];
    rerender();
  });
  expect(result.current.getDraftPayload().services).toEqual([service]);
});

it('preserves saved manual invoice on hydration, then rebuilds it after an actual rent edit', async () => {
  defaults.rows = [];
  const { result } = renderHook(() => useContractFormState({ open: true, draft: makeDraft('Nháp') }));
  await waitFor(() => expect(result.current.invoiceItems[0]?.id).toBe('manual-1'));
  act(() => result.current.form.setValue('rent_price', 3500000, { shouldDirty: true }));
  await waitFor(() => expect(result.current.invoiceItems.some((item) => item.id === 'manual-1')).toBe(false));
  expect(result.current.invoiceItems.some((item) => item.type === 'RENT')).toBe(true);
  const rentBeforeDateEdit = result.current.invoiceItems.find((item) => item.type === 'RENT')?.unit_price;
  act(() => result.current.form.setValue('end_billing_date', '2026-10-06', { shouldDirty: true }));
  await waitFor(() => expect(result.current.invoiceItems.find((item) => item.type === 'RENT')?.unit_price).not.toBe(rentBeforeDateEdit));
});

it('B15 tải lại form khôi phục issue/contract ID từ storage, đổi selector không mất pending',async()=>{
 localStorage.clear();const saved={contract:{id:'edit-c1',organization_id:'actual-a',rent_price:100},customers:[],services:[]};
 await expect(runContractEdit({contractId:'edit-c1',updates:{rent_price:200},fieldsFingerprint:'intent',customers:[{customer_id:'customer1',is_representative:true}],services:[]},{read:async()=>saved,update:async()=>null,customers:vi.fn(),services:vi.fn()})).rejects.toThrow();
 localStorage.setItem('ihomecrm.selectedOrganizationId','selected-b');
 const contract={id:'edit-c1',room_id:room,room:{building_id:building},signed_date:'2026-09-01',start_date:'2026-09-01',end_date:'2027-09-01',rent_price:100,total_deposit:0,contract_customers:[],contract_services:[]} as never;
 const first=renderHook(()=>useContractFormState({open:true,contract}));await waitFor(()=>expect(first.result.current.partialSyncIssue).toContain('edit-c1'));expect(first.result.current.partialSyncRef.current).toMatchObject({corePhase:'sending',organizationId:'actual-a'});first.unmount();
 const reopened=renderHook(()=>useContractFormState({open:true,contract}));await waitFor(()=>expect(reopened.result.current.partialSyncIssue).toContain('edit-c1'));expect(reopened.result.current.partialSyncRef.current).toMatchObject({contractId:'edit-c1',updates:{rent_price:200}});expect(reopened.result.current.isPending).toBe(false);localStorage.clear();
});
