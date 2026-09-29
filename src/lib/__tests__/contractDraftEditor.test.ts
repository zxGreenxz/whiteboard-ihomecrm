import { describe, expect, it } from 'vitest';
import { contractDraftPayloadSchema, emptyContractDraftPayload, emptyDraftOwner, type ContractDraft } from '../contractDrafts';
import { buildContractDraftPayload, restoreContractDraftEditorState } from '../contractDraftEditor';

const room = '11111111-1111-4111-8111-111111111111';
const building = '22222222-2222-4222-8222-222222222222';
const template = '33333333-3333-4333-8333-333333333333';
const service = { id: '44444444-4444-4444-8444-444444444444', name: 'Điện', unit_price: 3500,
  unit: 'kWh', type: 'METER_READING', pricing_type: 'METER', initial_reading: 0, quantity: 1 };
const customer = { id: '55555555-5555-4555-8555-555555555555', full_name: 'Khách DEMO', phone: '0900000000',
  id_number: null, is_representative: true, notes: null };
const draft = (payload = emptyContractDraftPayload()): ContractDraft => ({ id: '66666666-6666-4666-8666-666666666666',
  organization_id: '77777777-7777-4777-8777-777777777777', building_id: building, room_id: room,
  payload, template_id: template, revision: 1, created_by: '88888888-8888-4888-8888-888888888888',
  created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', documents: [] });

describe('unified contract draft editor metadata', () => {
  it('round-trips typed receipt input, edited invoice, hidden selected services and manual price locks without derived money', () => {
    const payload = buildContractDraftPayload({ form: { ...emptyContractDraftPayload().form, room_id: room,
      rent_price: 3200000, total_deposit: 3700000, invoice_template_id: template,
      deposit_debt_acknowledged: true, deposit_debt_mode: 'DEBT', deposit_debt_reason: 'Hẹn khách', deposit_topup_due_date: '2026-10-05',
      deposit_paid: 99000 }, selectedCustomers: [customer], selectedServices: [service],
      buildingServices: [{ ...service, unit_price: 3000 }], useCustomServices: false,
      depositRows: [{ uid: 'dep-1', amount: 500000, account_id: '', received_date: '2026-09-29', images: ['owned-path'] }],
      invoiceItems: [{ id: 'manual-1', type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí DEMO',
        unit_price: 12000, quantity: 2, service_id: null }], rentUnlocked: true, depositUnlocked: true }, emptyDraftOwner());
    expect(contractDraftPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).not.toHaveProperty('deposit_paid');
    expect(payload.form).not.toHaveProperty('deposit_paid');
    expect(payload.services[0].unit_price).toBe(3000);
    expect(payload.editor_state?.selected_services[0].unit_price).toBe(3500);
    const restored = restoreContractDraftEditorState(draft(payload));
    expect(restored.form).toMatchObject({ rent_price: 3200000, total_deposit: 3700000,
      contract_template_id: template, invoice_template_id: template, deposit_debt_mode: 'DEBT' });
    expect(restored.depositRows).toEqual(payload.editor_state?.deposit_rows);
    expect(restored.invoiceItems).toEqual(payload.editor_state?.invoice_items);
    expect(restored.selectedServices).toEqual(payload.editor_state?.selected_services);
    expect(restored.buildingDefaultServices).toEqual(payload.services);
    expect([restored.rentUnlocked, restored.depositUnlocked]).toEqual([true, true]);
  });

  it('reads a legacy draft without editor_state and refuses derived/writer keys in metadata', () => {
    const old = draft();
    expect(contractDraftPayloadSchema.safeParse(old.payload).success).toBe(true);
    const restored = restoreContractDraftEditorState(old);
    expect(restored.depositRows).toEqual([]);
    expect(restored.selectedServices).toEqual([]);
    expect(restored.form.deposit_paid).toBe(0);
    const payload = buildContractDraftPayload({ form: { ...emptyContractDraftPayload().form, room_id: room },
      selectedCustomers: [], selectedServices: [], buildingServices: [], useCustomServices: false,
      depositRows: [], invoiceItems: [], rentUnlocked: false, depositUnlocked: false }, emptyDraftOwner());
    expect(contractDraftPayloadSchema.safeParse({ ...payload, editor_state: { ...payload.editor_state, deposit_paid: 100 } }).success).toBe(false);
    expect(contractDraftPayloadSchema.safeParse({ ...payload, editor_state: { ...payload.editor_state, existing_deposit_voucher_ids: [room] } }).success).toBe(false);
    expect(contractDraftPayloadSchema.safeParse({ ...payload, editor_state: { ...payload.editor_state, deposit_rows: [{ uid: 'x', amount: 1, account_id: '', received_date: '', images: [], created_receipt_id: room }] } }).success).toBe(false);
  });
});
