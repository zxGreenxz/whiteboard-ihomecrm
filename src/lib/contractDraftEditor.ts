import type { ContractFormData } from '@/lib/contractValidation';
import type { FirstInvoiceItem } from '@/lib/firstInvoiceBuilder';
import type { DepositRow, SelectedCustomer, SelectedService } from '@/components/contracts/contract-form/types';
import { contractDraftPayloadSchema, type ContractDraft, type ContractDraftPayload,
  type ContractDraftService, type DraftOwner } from '@/lib/contractDrafts';

export interface ContractDraftEditorInput {
  form: ContractFormData;
  selectedCustomers: SelectedCustomer[];
  selectedServices: SelectedService[];
  buildingServices: SelectedService[];
  useCustomServices: boolean;
  depositRows: DepositRow[];
  invoiceItems: FirstInvoiceItem[];
  rentUnlocked: boolean;
  depositUnlocked: boolean;
}

const copyService = (service: SelectedService): ContractDraftService => ({
  id: service.id, name: service.name, unit_price: service.unit_price, unit: service.unit,
  type: service.type, pricing_type: service.pricing_type ?? null,
  initial_reading: service.initial_reading, quantity: service.quantity,
});
// This project compiles Zod output without strictNullChecks, so inferred required
// DTO fields appear optional to TypeScript. Check them at the restore boundary.
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Bản nháp thiếu ${field}`);
  return value;
};
const requiredNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Bản nháp thiếu ${field}`);
  return value;
};
const requiredBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`Bản nháp thiếu ${field}`);
  return value;
};
const restoreService = (service: ContractDraftService): SelectedService => ({
  id: requiredString(service.id, 'dịch vụ'), name: requiredString(service.name, 'tên dịch vụ'),
  unit: service.unit ?? null, type: requiredString(service.type, 'loại dịch vụ'),
  pricing_type: service.pricing_type ?? null, unit_price: requiredNumber(service.unit_price, 'giá dịch vụ'),
  initial_reading: requiredNumber(service.initial_reading, 'chỉ số đầu'), quantity: requiredNumber(service.quantity, 'số lượng dịch vụ'),
});

/** Snapshot editable input, without derived paid balances or orphan voucher reads. */
export function buildContractDraftPayload(input: ContractDraftEditorInput, owner: DraftOwner): ContractDraftPayload {
  const { form } = input;
  return contractDraftPayloadSchema.parse({
    form: {
      room_id: form.room_id, signed_date: form.signed_date, start_date: form.start_date,
      end_date: form.end_date, rent_price: form.rent_price, total_deposit: form.total_deposit,
      payment_cycle: form.payment_cycle, start_billing_date: form.start_billing_date ?? '',
      end_billing_date: form.end_billing_date ?? '', notes: form.notes ?? '',
      discount_months: form.discount_months ?? 0,
      discount_amount_per_month: form.discount_amount_per_month ?? 0,
    },
    ...(form.rent_support ? { rent_support: form.rent_support } : {}),
    customers: input.selectedCustomers.map(customer => ({
      id: customer.id, full_name: customer.full_name, phone: customer.phone,
      id_number: customer.id_number, is_representative: customer.is_representative, notes: customer.notes,
    })),
    services: (input.useCustomServices ? input.selectedServices : input.buildingServices).map(copyService),
    use_custom_services: input.useCustomServices, owner: { ...owner },
    editor_state: {
      version: 1,
      form: {
        deposit_debt_acknowledged: form.deposit_debt_acknowledged ?? false,
        ...(form.deposit_debt_mode ? { deposit_debt_mode: form.deposit_debt_mode } : {}),
        deposit_debt_reason: form.deposit_debt_reason ?? '',
        deposit_topup_due_date: form.deposit_topup_due_date ?? '',
        invoice_template_id: form.invoice_template_id ?? null,
      },
      deposit_rows: input.depositRows.map(row => ({ uid: row.uid, amount: row.amount,
        account_id: row.account_id, received_date: row.received_date, images: [...row.images] })),
      invoice_items: input.invoiceItems.map(item => ({ id: item.id, type: item.type,
        accounting_class: item.accounting_class, description: item.description,
        unit_price: item.unit_price, quantity: item.quantity,
        ...(item.service_id !== undefined ? { service_id: item.service_id } : {}),
        ...(item.from_date !== undefined ? { from_date: item.from_date } : {}),
        ...(item.to_date !== undefined ? { to_date: item.to_date } : {}),
      })),
      selected_services: input.selectedServices.map(copyService),
      rent_unlocked: input.rentUnlocked, deposit_unlocked: input.depositUnlocked,
    },
  });
}

export interface RestoredContractDraftEditorState {
  form: ContractFormData;
  selectedCustomers: SelectedCustomer[];
  selectedServices: SelectedService[];
  buildingDefaultServices: SelectedService[] | null;
  useCustomServices: boolean;
  depositRows: DepositRow[];
  invoiceItems: FirstInvoiceItem[];
  rentUnlocked: boolean;
  depositUnlocked: boolean;
}

/** Existing pre-metadata drafts remain editable, with no invented paid or voucher state. */
export function restoreContractDraftEditorState(draft: ContractDraft): RestoredContractDraftEditorState {
  const payload = draft.payload;
  const editor = payload.editor_state;
  return {
    form: {
      ...(payload.rent_support ? { rent_support: payload.rent_support } : {}),
      ...payload.form, room_id: draft.room_id ?? payload.form.room_id,
      deposit_paid: 0, deposit_account_id: null,
      contract_template_id: draft.template_id,
      invoice_template_id: editor?.form.invoice_template_id ?? null,
      deposit_debt_acknowledged: editor?.form.deposit_debt_acknowledged ?? false,
      deposit_debt_mode: editor?.form.deposit_debt_mode,
      deposit_debt_reason: editor?.form.deposit_debt_reason ?? '',
      deposit_topup_due_date: editor?.form.deposit_topup_due_date ?? '',
    },
    selectedCustomers: payload.customers.map(customer => ({
      id: requiredString(customer.id, 'khách'), full_name: requiredString(customer.full_name, 'tên khách'),
      phone: requiredString(customer.phone, 'điện thoại khách'), id_number: customer.id_number ?? null,
      is_representative: requiredBoolean(customer.is_representative, 'khách đại diện'), notes: customer.notes ?? null,
    })),
    selectedServices: (editor?.selected_services ?? (payload.use_custom_services ? payload.services : [])).map(restoreService),
    buildingDefaultServices: payload.use_custom_services ? null : payload.services.map(restoreService),
    useCustomServices: payload.use_custom_services,
    depositRows: editor?.deposit_rows.map(row => ({ uid: requiredString(row.uid, 'dòng cọc'),
      amount: requiredNumber(row.amount, 'số tiền cọc'), account_id: requiredString(row.account_id, 'sổ cọc'),
      received_date: requiredString(row.received_date, 'ngày cọc'), images: [...row.images] })) ?? [],
    invoiceItems: editor?.invoice_items.map(item => ({
      id: requiredString(item.id, 'dòng hoá đơn'), type: item.type,
      accounting_class: item.accounting_class, description: requiredString(item.description, 'nội dung hoá đơn'),
      unit_price: requiredNumber(item.unit_price, 'đơn giá hoá đơn'), quantity: requiredNumber(item.quantity, 'số lượng hoá đơn'),
      ...(item.service_id !== undefined ? { service_id: item.service_id } : {}),
      ...(item.from_date !== undefined ? { from_date: item.from_date } : {}),
      ...(item.to_date !== undefined ? { to_date: item.to_date } : {}),
    })) ?? [],
    // Old drafts have no lock intent. Unlocking protects their saved terms while editing.
    rentUnlocked: editor?.rent_unlocked ?? true,
    depositUnlocked: editor?.deposit_unlocked ?? true,
  };
}
