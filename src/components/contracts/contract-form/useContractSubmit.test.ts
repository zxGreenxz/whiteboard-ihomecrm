import type {ContractRelationSnapshot} from '@/lib/contractRelationReconcile';
import {toast} from 'sonner';
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContractFormData } from "@/lib/contractValidation";
import { isStaleOrphanDepositError, refreshStaleOrphanDeposits, useContractSubmit } from "./useContractSubmit";
import type { ContractFormState } from "./useContractFormState";
import {readContractEditSnapshot,runContractEdit} from '@/lib/contractEditWorkflow';
import { buildFirstInvoiceDiscount, buildFirstInvoiceItems } from '@/lib/firstInvoiceBuilder';
import { buildContractSigningArgs, buildPreparedSigningCreation } from '@/lib/contractSigning';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
beforeEach(()=>localStorage.clear());

vi.mock('@/lib/contractEditWorkflow',async original=>{const actual=await original<typeof import('@/lib/contractEditWorkflow')>();return {...actual,readContractEditSnapshot:vi.fn()};});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("useContractSubmit", () => {
  it('blocks edit submission until full detail has loaded', () => {
    const setError = vi.fn();
    const state = { isEditMode: true, isEditDetailReady: false, form: { setError } } as unknown as ContractFormState;
    useContractSubmit({ state, onOpenChange: vi.fn() })({} as ContractFormData);
    expect(setError).toHaveBeenCalledWith('root.server', expect.objectContaining({ message: expect.stringContaining('đầy đủ') }));
  });
  it('không gửi tạo hợp đồng khi dịch vụ tòa chưa tải; giữ nguyên form để tải lại', () => {
    const createContract = { mutate: vi.fn() };
    const setError = vi.fn();
    const state = { isEditMode: false, form: { setError }, sourceIssues: [{ key: 'buildingServices', label: 'dịch vụ mặc định của tòa', retry: vi.fn() }],
      selectedCustomers: [{ id: 'customer-1', is_representative: true }], createContract } as unknown as ContractFormState;
    const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
    submit({ room_id: 'room-1' } as ContractFormData);
    expect(createContract.mutate).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('root.server', expect.objectContaining({ message: expect.stringContaining('dịch vụ mặc định của tòa') }));
  });
  it.each([
    { name: 'cọc đã nhận vượt', totalDeposit: 4_000_000, paid: 5_000_000, mode: undefined, reason: undefined, due: undefined, field: 'total_deposit' },
    { name: 'thiếu cách xử lý cọc', totalDeposit: 4_000_000, paid: 0, mode: undefined, reason: undefined, due: undefined, field: 'deposit_debt_mode' },
    { name: 'thiếu lý do nợ cọc', totalDeposit: 4_000_000, paid: 0, mode: 'DEBT', reason: '', due: undefined, field: 'deposit_debt_reason' },
    { name: 'thiếu hạn bổ sung cọc', totalDeposit: 4_000_000, paid: 0, mode: 'DEBT', reason: 'Khách hẹn', due: undefined, field: 'deposit_topup_due_date' },
  ])('gắn lỗi tại đúng ô khi $name', ({ totalDeposit, paid, mode, reason, due, field }) => {
    const setError = vi.fn();
    const createContract = { mutate: vi.fn() };
    const state = { isEditMode: false, form: { setError },
      selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222', is_representative: true }],
      selectedServices: [], useCustomServices: false, createContract,
      typedDepositTotal: paid, approvedOrphanTotal: 0, orphanDepositVouchers: [],
      invoiceItems: [], firstInvoiceDiscount: { amount: 0, notes: null }, depositRows: [],
    } as unknown as ContractFormState;
    const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
    submit({ room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-01',
      start_date: '2026-09-01', end_date: '2027-08-31', start_billing_date: '2026-09-01',
      end_billing_date: '2026-09-30', rent_price: 4_000_000, total_deposit: totalDeposit,
      payment_cycle: 'MONTHLY', deposit_debt_mode: mode, deposit_debt_reason: reason,
      deposit_topup_due_date: due } as ContractFormData);
    expect(setError).toHaveBeenCalledWith(field, expect.objectContaining({ message: expect.any(String) }));
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
  it('marks the first invoice when its deposit row differs from the outstanding deposit', () => {
    const setError = vi.fn();
    const createContract = { mutate: vi.fn() };
    const state = { isEditMode: false, form: { setError },
      selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222', is_representative: true }],
      selectedServices: [], useCustomServices: false, createContract,
      typedDepositTotal: 0, approvedOrphanTotal: 0, orphanDepositVouchers: [],
      invoiceItems: [{ id: 'deposit-1', type: 'OTHER', accounting_class: 'DEPOSIT',
        description: 'Tiền cọc', unit_price: 1_000_000, quantity: 1 }],
      firstInvoiceDiscount: { amount: 0, notes: null }, depositRows: [],
    } as unknown as ContractFormState;
    const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
    submit({ room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-01',
      start_date: '2026-09-01', end_date: '2027-08-31', start_billing_date: '2026-09-01',
      end_billing_date: '2026-09-30', rent_price: 4_000_000, total_deposit: 4_000_000,
      payment_cycle: 'MONTHLY', deposit_debt_mode: 'FIRST_INVOICE' } as ContractFormData);
    expect(setError).toHaveBeenCalledWith('invoice_items.deposit-1.unit_price', expect.objectContaining({ type: 'server' }));
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
  it('marks the specific first invoice row when its editable price is invalid', () => {
    const setError = vi.fn();
    const createContract = { mutate: vi.fn() };
    const state = { isEditMode: false, form: { setError },
      selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222', is_representative: true }],
      selectedServices: [], useCustomServices: false, createContract,
      typedDepositTotal: 0, approvedOrphanTotal: 0, orphanDepositVouchers: [],
      invoiceItems: [{ id: 'rent-1', type: 'RENT', accounting_class: 'REVENUE',
        description: 'Tiền thuê', unit_price: -1, quantity: 1, from_date: '2026-09-01', to_date: '2026-09-30' }],
      firstInvoiceDiscount: { amount: 0, notes: null }, depositRows: [],
    } as unknown as ContractFormState;
    const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
    submit({ room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-01',
      start_date: '2026-09-01', end_date: '2027-08-31', start_billing_date: '2026-09-01',
      end_billing_date: '2026-09-30', rent_price: 4_000_000, total_deposit: 0,
      payment_cycle: 'MONTHLY' } as ContractFormData);
    expect(setError).toHaveBeenCalledWith('invoice_items.rent-1.unit_price', expect.objectContaining({ type: 'server' }));
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
  it("reads persisted core/relations before retrying only confirmed missing insert, then saves later edits", async () => {
    const actual={contract:{id:'33333333-3333-4333-8333-333333333333',organization_id:'o1'} as Record<string,unknown>,customers:[] as ContractRelationSnapshot['customers'],services:[] as ContractRelationSnapshot['services']};
    vi.mocked(readContractEditSnapshot).mockImplementation(async()=>structuredClone(actual) as never);
    const updateContract = {mutateAsync:vi.fn(async ({updates})=>{Object.assign(actual.contract,updates);return actual.contract;})};
    const syncCustomers={mutateAsync:vi.fn(async input=>{input.onPhase('deleting');actual.customers=[];input.onPhase('deleted');input.onPhase('inserting');actual.customers=input.customers;input.onPhase('done');})};
    const syncServices={mutateAsync:vi.fn().mockImplementationOnce(async input=>{input.onPhase('deleting');actual.services=[];input.onPhase('deleted');input.onPhase('inserting');throw {code:'23514',message:'bad service'};}).mockImplementation(async input=>{expect(input.skipDelete).toBe(true);actual.services=input.services;input.onPhase('done');})};
    const partialSyncRef={current:null};const state={isEditMode:true,editCustomerBaselineRef:{current:[]},form:{setError:vi.fn()},partialSyncRef,
      selectedCustomers:[{id:'22222222-2222-4222-8222-222222222222',is_representative:true}],
      selectedServices:[{id:'44444444-4444-4444-8444-444444444444',name:'Điện',unit_price:10000,initial_reading:0,quantity:1}],useCustomServices:true,updateContract,syncCustomers,syncServices} as unknown as ContractFormState;
    const contract={id:actual.contract.id} as NonNullable<Parameters<typeof useContractSubmit>[0]['contract']>;const close=vi.fn();const submit=useContractSubmit({state,contract,onOpenChange:close});
    const data={room_id:'11111111-1111-4111-8111-111111111111',signed_date:'2026-09-01',start_date:'2026-09-01',end_date:'2027-08-31',rent_price:4000000,total_deposit:4000000,payment_cycle:'MONTHLY'} as ContractFormData;
    submit(data);await vi.waitFor(()=>expect(syncServices.mutateAsync).toHaveBeenCalledOnce());expect(close).not.toHaveBeenCalled();expect(partialSyncRef.current).not.toBeNull();
    const revised={...data,notes:'Ghi chú sửa sau lỗi'};submit(revised);await vi.waitFor(()=>expect(partialSyncRef.current).toBeNull());expect(readContractEditSnapshot).toHaveBeenCalledWith(contract.id);expect(close).not.toHaveBeenCalled();expect(updateContract.mutateAsync).toHaveBeenCalledOnce();expect(syncCustomers.mutateAsync).toHaveBeenCalledOnce();
    submit(revised);await vi.waitFor(()=>expect(close).toHaveBeenCalledWith(false));expect(updateContract.mutateAsync).toHaveBeenCalledTimes(2);
  });
  it('blocks recovery on authoritative read failure and retains contract ID/draft after reload', async () => {
    const snapshot={contract:{id:'contract-1',organization_id:'o1',rent_price:100},customers:[],services:[]};
    const read=vi.fn().mockResolvedValueOnce(snapshot);const update=vi.fn().mockResolvedValue(null);
    await expect(runContractEdit({contractId:'contract-1',expectedCustomers:[],updates:{rent_price:200},fieldsFingerprint:'{}',customers:[],services:[]},{read,update,customers:vi.fn(),services:vi.fn()})).rejects.toThrow();
    vi.mocked(readContractEditSnapshot).mockRejectedValueOnce(new Error('offline'));
    const syncCustomers={mutateAsync:vi.fn()},syncServices={mutateAsync:vi.fn()},setPartialSyncIssue=vi.fn(),setError=vi.fn();
    const state={isEditMode:true,form:{setError},setPartialSyncIssue,partialSyncRef:{current:null},selectedCustomers:[{id:'customer-1',is_representative:true}],selectedServices:[],useCustomServices:false,syncCustomers,syncServices,updateContract:{mutateAsync:vi.fn()}} as unknown as ContractFormState;
    useContractSubmit({state,contract:{id:'contract-1'} as never,onOpenChange:vi.fn()})({} as ContractFormData);
    await vi.waitFor(()=>expect(setPartialSyncIssue).toHaveBeenCalledWith(expect.stringContaining('contract-1')));expect(setError).toHaveBeenCalledWith('root.server',expect.objectContaining({type:'server'}));expect(syncCustomers.mutateAsync).not.toHaveBeenCalled();expect(syncServices.mutateAsync).not.toHaveBeenCalled();
  });
  it('preserves a signed v2 marker during unrelated legacy contract updates', async () => {
    const id = '11111111-1111-4111-8111-111111111111', customer = '22222222-2222-4222-8222-222222222222';
    const actual = { contract: { id, organization_id: 'o1', discounts: { version: 2 } } as Record<string, unknown>,
      customers: [{ customer_id: customer, is_representative: true, notes: undefined }], services: [] };
    vi.mocked(readContractEditSnapshot).mockImplementation(async () => structuredClone(actual) as never);
    const update = vi.fn(async ({ updates }: { updates: Record<string, unknown> }) => { Object.assign(actual.contract, updates); return actual.contract; });
    const close = vi.fn();
    const state = { isEditMode: true, editCustomerBaselineRef:{current:structuredClone(actual.customers)},hasPersistedRentSupport: true, form: { setError: vi.fn() }, partialSyncRef: { current: null },
      selectedCustomers: [{ id: customer, is_representative: true }], selectedServices: [], useCustomServices: false,
      updateContract: { mutateAsync: update }, syncCustomers: { mutateAsync: vi.fn() }, syncServices: { mutateAsync: vi.fn() } } as unknown as ContractFormState;
    useContractSubmit({ state, contract: { id } as never, onOpenChange: close })({ room_id: '33333333-3333-4333-8333-333333333333',
      signed_date: '2026-09-01', start_date: '2026-09-01', end_date: '2027-08-31', payment_cycle: 'MONTHLY',
      notes: 'Ghi chú mới', rent_price: 4000000, total_deposit: 0 } as ContractFormData);
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0].updates).not.toHaveProperty('discounts');
    expect(actual.contract.discounts).toEqual({ version: 2 });
  });
  it('blocks submission when support exceeds eligible first-invoice revenue', () => {
    const mutate = vi.fn();
    const state = { isEditMode: false, selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222' }], selectedServices: [], useCustomServices: false,
      form: { setError: vi.fn() }, typedDepositTotal: 0, approvedOrphanTotal: 0, orphanDepositVouchers: [], depositRows: [], invoiceItems: [],
      createContract: { mutate }, firstInvoiceDiscount: { amount: 0, state: 'NEEDS_REVIEW', notes: 'Hỗ trợ vượt doanh thu' } } as unknown as ContractFormState;
    useContractSubmit({ state, onOpenChange: vi.fn() })({ room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-20', start_date: '2026-09-20', end_date: '2027-09-20', start_billing_date: '2026-09-20', end_billing_date: '2026-10-05', rent_price: 0, total_deposit: 0, payment_cycle: 'MONTHLY', rent_support: { version: 2, start_billing_month: '2026-09', payer: 'BUILDING', sale_party_id: null, deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED', segments: [{ month_count: 1, monthly_amount: '300000' }] } } as ContractFormData);
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each([false, true])('carries full partial-month support through the official form request and signing payload (draft=%s)', (draft) => {
    const mutate = vi.fn(), prepared = vi.fn();
    const plan: NonNullable<ContractFormData['rent_support']> = { version: 2, start_billing_month: '2026-09', payer: 'BUILDING', sale_party_id: null,
      deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED',
      segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] };
    const builder = { rent_support: { version: plan.version, start_billing_month: plan.start_billing_month, segments: plan.segments },
      rent_price: 5000000, total_deposit: 0, deposit_paid: 0,
      start_billing_date: '2026-09-20', end_billing_date: '2026-10-05', services: [] };
    const invoiceItems = buildFirstInvoiceItems(builder);
    const firstInvoiceDiscount = buildFirstInvoiceDiscount(builder, invoiceItems);
    expect(invoiceItems[0]).toMatchObject({ unit_price: 2639785, from_date: '2026-09-20', to_date: '2026-10-05' });
    expect(firstInvoiceDiscount).toMatchObject({ amount: 300000, state: 'READY' });
    const state = { isEditMode: false, form: { setError: vi.fn() }, selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222' }],
      selectedServices: [], useCustomServices: false, createContract: { mutate }, typedDepositTotal: 0, approvedOrphanTotal: 0,
      orphanDepositVouchers: [], invoiceItems, firstInvoiceDiscount, depositRows: [] } as unknown as ContractFormState;
    useContractSubmit({ state, onOpenChange: vi.fn(), ...(draft ? { onCreateRequest: prepared } : {}) })({
      room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-20', start_date: '2026-09-20', end_date: '2027-09-20',
      start_billing_date: '2026-09-20', end_billing_date: '2026-10-05', rent_price: 5000000, total_deposit: 0,
      payment_cycle: 'MONTHLY', rent_support: plan, discount_months: 3, discount_amount_per_month: 300000 } as ContractFormData);
    const request: ContractCreateRequest = (draft ? prepared : mutate).mock.calls[0][0];
    expect(request.payload.contract.rent_support).toEqual(plan);
    expect(request.payload.contract.discounts).toBeNull();
    expect(request.payload.first_invoice).toMatchObject({ discount_amount: 300000, manual_discount_amount: '0',
      discount_notes: firstInvoiceDiscount.notes, items: [{ unit_price: 2639785, quantity: 1 }] });
    expect(draft ? mutate : prepared).not.toHaveBeenCalled();
    const creation = buildPreparedSigningCreation(request, 0);
    const id = '33333333-3333-4333-8333-333333333333';
    const args = buildContractSigningArgs(id, { source: { draftId: id, revision: 5, documentId: id, documentSha256: 'a'.repeat(64) },
      requestId: id, receivedOn: '2026-09-20', roomReady: true, termsConfirmed: true,
      boundary: { state: 'VERIFIED', readings: [] }, creationOptions: creation.options });
    expect(args.p_creation_options).toMatchObject({ first_invoice: request.payload.first_invoice });
    expect(args).toMatchObject({ p_expected_revision: 5, p_document_id: id, p_document_sha256: 'a'.repeat(64), p_received_on: '2026-09-20' });
  });
  it("passes the validated official request to draft signing without creating a second contract", () => {
    const createContract = { mutate: vi.fn() };
    const prepared = vi.fn();
    const state = {
      isEditMode: false, form: { setError: vi.fn() },
      selectedCustomers: [{ id: "22222222-2222-4222-8222-222222222222", is_representative: true }],
      selectedServices: [], useCustomServices: false, createContract,
      typedDepositTotal: 0, approvedOrphanTotal: 0, orphanDepositVouchers: [],
      invoiceItems: [], firstInvoiceDiscount: { amount: 0, notes: null }, depositRows: [],
    } as unknown as ContractFormState;
    const submit = useContractSubmit({ state, onOpenChange: vi.fn(), onCreateRequest: prepared });
    submit({ room_id: "11111111-1111-4111-8111-111111111111", signed_date: "2026-09-29",
      start_date: "2026-09-29", end_date: "2027-09-29", start_billing_date: "2026-09-29", end_billing_date: "2026-09-30",
      rent_price: 4000000, total_deposit: 0, payment_cycle: "MONTHLY", notes: "" } as ContractFormData);
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
      contract: expect.objectContaining({ room_id: "11111111-1111-4111-8111-111111111111" }),
      customers: [expect.objectContaining({ is_representative: true })],
    }) }));
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
  it("recognizes a stale orphan deposit rejected after settlement", () => {
    expect(isStaleOrphanDepositError(new Error("Phiếu cọc đã xử lý bỏ cọc; không được dùng lại"))).toBe(true);
    expect(isStaleOrphanDepositError(new Error("Lỗi kết nối"))).toBe(false);
  });
  it("refetches orphan deposits only for a stale settlement rejection", async () => {
    const refetch = vi.fn().mockResolvedValue({ error: null });
    await expect(refreshStaleOrphanDeposits(new Error("Phiếu cọc đã xử lý bỏ cọc; không được dùng lại"), refetch)).resolves.toBe("refreshed");
    expect(refetch).toHaveBeenCalledOnce();
    await expect(refreshStaleOrphanDeposits(new Error("Mất kết nối"), refetch)).resolves.toBe("not-stale");
    expect(refetch).toHaveBeenCalledOnce();
  });
  it("does not claim stale deposits were refreshed when refetch fails", async () => {
    const refetch = vi.fn().mockResolvedValue({ error: new Error("offline") });
    await expect(refreshStaleOrphanDeposits(new Error("Phiếu cọc đã được dùng cho nghiệp vụ khác"), refetch)).resolves.toBe("failed");
  });
  it("rejects an empty end billing date after normalization", () => {
    const setError = vi.fn();
    const createContract = { mutate: vi.fn() };
    const state = {
      isEditMode: false,
      form: { setError },
      selectedCustomers: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          is_representative: true,
          notes: null,
        },
      ],
      selectedServices: [],
      useCustomServices: false,
      createContract,
      updateContract: { mutate: vi.fn() },
      syncCustomers: { mutateAsync: vi.fn() },
      syncServices: { mutateAsync: vi.fn() },
      typedDepositTotal: 0,
      approvedOrphanTotal: 0,
      orphanDepositVouchers: [],
      invoiceItems: [],
      firstInvoiceDiscount: { amount: 0, notes: null },
      depositRows: [],
      setCommissionContractId: vi.fn(),
    } as unknown as ContractFormState;
    const data: ContractFormData = {
      room_id: "11111111-1111-4111-8111-111111111111",
      signed_date: "2026-07-21",
      start_date: "2026-07-22",
      end_date: "2027-07-21",
      rent_price: 4_000_000,
      total_deposit: 0,
      deposit_paid: 0,
      deposit_account_id: null,
      payment_cycle: "MONTHLY",
      start_billing_date: "",
      end_billing_date: "",
      contract_template_id: null,
      invoice_template_id: null,
      notes: "",
      discount_months: 0,
      discount_amount_per_month: 0,
      deposit_debt_acknowledged: false,
      deposit_debt_reason: "",
      deposit_topup_due_date: "",
    };

    const submit = useContractSubmit({
      state,
      onOpenChange: vi.fn(),
    });
    submit(data);

    expect(setError).toHaveBeenCalledWith("end_billing_date", {
      type: "manual",
      message: expect.any(String),
    });
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
});

it('marks every incomplete deposit row instead of silently filtering it out',()=>{
 const setError=vi.fn();const createContract={mutate:vi.fn()};const rows=[{uid:'row1',amount:100,account_id:'',received_date:'',images:[]},{uid:'row2',amount:0,account_id:'',received_date:'',images:[]},{uid:'row3',amount:0,account_id:'',received_date:'2026-02-31',images:[]}];
 const state={isEditMode:false,form:{setError},selectedCustomers:[{id:'22222222-2222-4222-8222-222222222222',is_representative:true}],selectedServices:[],useCustomServices:false,createContract,typedDepositTotal:100,approvedOrphanTotal:0,orphanDepositVouchers:[],invoiceItems:[],firstInvoiceDiscount:{amount:0,notes:null},depositRows:rows} as unknown as ContractFormState;
 useContractSubmit({state,onOpenChange:vi.fn()})({room_id:'11111111-1111-4111-8111-111111111111',signed_date:'2026-09-01',start_date:'2026-09-01',end_date:'2027-08-31',start_billing_date:'2026-09-01',end_billing_date:'2026-09-30',rent_price:4000000,total_deposit:100,payment_cycle:'MONTHLY'} as ContractFormData);
 expect(createContract.mutate).not.toHaveBeenCalled();expect(setError).toHaveBeenCalledWith('deposit_rows.row2.amount',expect.objectContaining({message:expect.stringContaining('Lần cọc 2')}));expect(setError).toHaveBeenCalledWith('deposit_rows.row3.amount',expect.objectContaining({message:expect.stringContaining('Lần cọc 3')}));expect(setError).toHaveBeenCalledWith('deposit_rows.row3.received_date',expect.objectContaining({message:expect.stringContaining('ngày')}));
});

 it('marks all invalid custom service values before sending an update',()=>{
  const setError=vi.fn(),updateContract={mutate:vi.fn()};
  const state={isEditMode:true,form:{setError},selectedCustomers:[{id:'customer',is_representative:true}],useCustomServices:true,
   partialSyncRef:{current:null},selectedServices:[{id:'s2',name:'Nước',unit_price:NaN,initial_reading:-1,quantity:0}],updateContract,depositRows:[]} as unknown as ContractFormState;
  const submit=useContractSubmit({state,contract:{id:'contract'} as never,onOpenChange:vi.fn()});
  submit({rent_price:100,total_deposit:100} as ContractFormData);
  expect(updateContract.mutate).not.toHaveBeenCalled();
  for(const field of ['unit_price','initial_reading','quantity'])expect(setError).toHaveBeenCalledWith(`services.s2.${field}`,expect.objectContaining({message:expect.stringContaining('Nước')}));
 });

it('identifies the entered deposit amount when received deposits exceed the contract deposit',()=>{
 const setError=vi.fn(),createContract={mutate:vi.fn()};
 const state={isEditMode:false,form:{setError},selectedCustomers:[{id:'customer',is_representative:true}],selectedServices:[],useCustomServices:false,createContract,typedDepositTotal:200,approvedOrphanTotal:0,orphanDepositVouchers:[],invoiceItems:[],firstInvoiceDiscount:{amount:0,notes:null},depositRows:[{uid:'entered',amount:200,received_date:'',account_id:'',images:[]}]} as unknown as ContractFormState;
 useContractSubmit({state,onOpenChange:vi.fn()})({room_id:'room',signed_date:'2026-09-01',start_date:'2026-09-01',end_date:'2027-08-31',start_billing_date:'2026-09-01',end_billing_date:'2026-09-30',rent_price:100,total_deposit:100,payment_cycle:'MONTHLY'} as ContractFormData);
 expect(setError).toHaveBeenCalledWith('deposit_rows.entered.amount',expect.objectContaining({message:expect.stringContaining('200')}));
 expect(createContract.mutate).not.toHaveBeenCalled();
});

it('stale deposit form error có một owner toast, callback giữ draft/field và không lặp hook toast',async()=>{
 vi.mocked(toast.error).mockClear();const error={code:'55000',message:'Phiếu cọc được chọn không hợp lệ hoặc đã được dùng'};
 const createContract={mutate:vi.fn((_request,callbacks)=>{void callbacks.onError(error);})};const refetch=vi.fn().mockResolvedValue({error:null});
 const state={isEditMode:false,form:{setError:vi.fn()},selectedCustomers:[{id:'22222222-2222-4222-8222-222222222222',is_representative:true}],selectedServices:[],useCustomServices:false,createContract,typedDepositTotal:0,approvedOrphanTotal:0,orphanDepositVouchers:[],refetchOrphanDepositVouchers:refetch,invoiceItems:[],firstInvoiceDiscount:{amount:0,notes:null},depositRows:[]} as unknown as ContractFormState;
 useContractSubmit({state,onOpenChange:vi.fn()})({room_id:'11111111-1111-4111-8111-111111111111',signed_date:'2026-09-01',start_date:'2026-09-01',end_date:'2027-09-01',start_billing_date:'2026-09-01',end_billing_date:'2026-09-30',rent_price:100,total_deposit:0,payment_cycle:'MONTHLY'} as ContractFormData);
 await vi.waitFor(()=>expect(toast.error).toHaveBeenCalledOnce());expect(createContract.mutate.mock.calls[0][0]).toMatchObject({suppressErrorToast:true});expect(refetch).toHaveBeenCalledOnce();
});
