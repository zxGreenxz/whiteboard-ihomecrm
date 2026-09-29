import { expect, it, vi } from 'vitest';
import { emptyContractDraftPayload } from '../contractDrafts';
import { saveContractDraft } from '../contractDraftApi';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

it('forwards versioned editor input with draft save, without derived paid or receipt writes', async () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const buildingId = '22222222-2222-4222-8222-222222222222';
  const draftId = '33333333-3333-4333-8333-333333333333';
  const payload = { ...emptyContractDraftPayload(), editor_state: {
    version: 1 as const,
    form: { deposit_debt_acknowledged: false, deposit_debt_reason: '', deposit_topup_due_date: '', invoice_template_id: null },
    deposit_rows: [{ uid: 'row-1', amount: 250000, account_id: '', received_date: '2026-09-29', images: [] }],
    invoice_items: [{ id: 'manual-1', type: 'OTHER' as const, accounting_class: 'REVENUE' as const,
      description: 'Khoản dự kiến', unit_price: 1000, quantity: 1 }],
    selected_services: [], rent_unlocked: true, deposit_unlocked: false,
  } };
  mocks.rpc.mockResolvedValueOnce({ data: { id: draftId, organization_id: organizationId, building_id: buildingId,
    room_id: null, payload, template_id: null, revision: 1, created_by: organizationId,
    created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', documents: [] }, error: null });
  await saveContractDraft({ organizationId, buildingId, payload, templateId: null, draftId,
    requestId: '44444444-4444-4444-8444-444444444444' });
  expect(mocks.rpc).toHaveBeenCalledOnce();
  const [functionName, args] = mocks.rpc.mock.calls[0];
  expect(functionName).toBe('save_contract_draft');
  expect(args.p_payload.editor_state).toEqual(payload.editor_state);
  expect(args.p_payload).not.toHaveProperty('deposit_paid');
  expect(args.p_payload).not.toHaveProperty('deposit_receipts');
});
