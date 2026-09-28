import { describe, expect, it } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft } from '../contractDrafts';
import { buildContractSigningArgs, buildSigningCreationOptions, matchingSigningReservations, signingErrorMessage, signingReservationReady, validateSigningConfirmation } from '../contractSigning';

const id = '11111111-1111-4111-8111-111111111111';
const payload = emptyContractDraftPayload();
payload.form = { ...payload.form, room_id:id, signed_date:'2026-09-28', start_date:'2026-09-28', end_date:'2027-09-28', start_billing_date:'2026-09-28', end_billing_date:'2026-09-30',rent_price:3000000 };
const draft:ContractDraft = {id,organization_id:id,building_id:id,room_id:id,template_id:id,revision:3,payload,created_by:id,created_at:'2026-09-28',updated_at:'2026-09-28',documents:[]};
const document={id,draft_id:id,revision:3,document_path:'document.docx',template_path:'template.docx',document_sha256:'a'.repeat(64),template_sha256:'b'.repeat(64),template_snapshot:{id,name:'Mẫu',updated_at:'2026-09-28'},created_at:'2026-09-28'};
draft.documents=[document];
describe('sign exact persisted draft, without automatic money',()=>{
  it('requires the latest exported source and explicit date/room/meter confirmations',()=>{
    expect(validateSigningConfirmation(draft,document,{receivedOn:'2026-09-28',roomReady:true,termsConfirmed:true,metersConfirmed:true},'2026-09-28')).toEqual([]);
    expect(validateSigningConfirmation(draft,{...document,revision:2},{receivedOn:'2026-09-29',roomReady:false,termsConfirmed:false,metersConfirmed:false},'2026-09-28')).toHaveLength(5);
  });
  it('keeps zero deposit and does not invent a receipt or require debt mode',()=>{
    const options=buildSigningCreationOptions(payload,{createFirstInvoice:false});
    expect(options).toEqual({});
    expect(JSON.stringify(options)).not.toMatch(/receipt|voucher|account/);
  });
  it('requires an explicit existing debt choice for positive deposit',()=>{
    const positive={...payload,form:{...payload.form,total_deposit:3000000}};
    expect(()=>buildSigningCreationOptions(positive,{createFirstInvoice:true})).toThrow();
    expect(()=>buildSigningCreationOptions(positive,{createFirstInvoice:false,depositMode:'DEBT',debtReason:'',topupDueOn:''})).toThrow();
    expect(buildSigningCreationOptions(positive,{createFirstInvoice:false,depositMode:'DEBT',debtReason:'Bổ sung sau',topupDueOn:'2026-10-02'})).toEqual({deposit_debt_mode:'DEBT',deposit_debt_reason:'Bổ sung sau',deposit_topup_due_date:'2026-10-02'});
  });
  it('uses the existing invoice builder with the saved period and services',()=>{
    const positive={...payload,form:{...payload.form,total_deposit:2000000}};
    const options=buildSigningCreationOptions(positive,{createFirstInvoice:true,depositMode:'FIRST_INVOICE'});
    expect(options.first_invoice?.items).toEqual(expect.arrayContaining([expect.objectContaining({type:'RENT',unit_price:300000}),expect.objectContaining({accounting_class:'DEPOSIT',unit_price:2000000})]));
    expect(()=>buildSigningCreationOptions(positive,{createFirstInvoice:false,depositMode:'FIRST_INVOICE'})).toThrow();
  });
  it('uses exactly received selected-source credit, avoids collecting it twice and requires a choice only for the shortfall',()=>{
    const positive={...payload,form:{...payload.form,total_deposit:2000000}};
    const paid=buildSigningCreationOptions(positive,{createFirstInvoice:true,depositPaid:2000000});
    expect(paid.deposit_debt_mode).toBeUndefined();expect(paid.first_invoice?.items.some(item=>item.accounting_class==='DEPOSIT')).toBe(false);
    const partial=buildSigningCreationOptions(positive,{createFirstInvoice:true,depositPaid:1500000,depositMode:'FIRST_INVOICE'});
    expect(partial.first_invoice?.items.find(item=>item.accounting_class==='DEPOSIT')?.unit_price).toBe(500000);
    expect(()=>buildSigningCreationOptions(positive,{createFirstInvoice:false,depositPaid:Infinity})).toThrow();
  });
  it('binds selected reservation revision and exact source IDs, rejects duplicated sources',()=>{
    const input={source:{draftId:id,revision:3,documentId:id,documentSha256:'a'.repeat(64)},requestId:id,receivedOn:'2026-09-28',roomReady:true,termsConfirmed:true,boundary:{state:'VERIFIED' as const,readings:[]},creationOptions:{},reservationSource:{reservationId:id,revision:4,sourceVoucherIds:[id]}};
    expect(buildContractSigningArgs(id,input)).toMatchObject({p_reservation_id:id,p_reservation_revision:4,p_source_voucher_ids:[id]});
    expect(()=>buildContractSigningArgs(id,{...input,reservationSource:{...input.reservationSource,sourceVoucherIds:[id,id]}})).toThrow();
  });
  it('selects only the current own room/party/org live claim and does not treat pending money as received',()=>{
    const currentDraft={...draft,payload:{...payload,customers:[{id,full_name:'A',phone:'',id_number:null,is_representative:true,notes:null}]}};
    const row={id,organization_id:id,building_id:id,room_id:id,customer_id:id,status:'HOLD',claim_status:'LIVE',revision:1,received_amount:0,source_voucher_ids:[],receipts:[]};
    expect(matchingSigningReservations(currentDraft,[row,{...row,organization_id:'other'},{...row,customer_id:'other'},{...row,claim_status:'CONSUMED'}])).toEqual([row]);
    expect(signingReservationReady(row)).toBe(true);expect(signingReservationReady({...row,receipts:[{received:false,approval_status:'UNAPPROVED'}]})).toBe(false);
  });
  it('binds stable intent to revision/id/hash, never accepts mutable terms as RPC args',()=>{
    const args=buildContractSigningArgs(id,{source:{draftId:id,revision:3,documentId:id,documentSha256:'a'.repeat(64)},requestId:id,receivedOn:'2026-09-28',roomReady:true,termsConfirmed:true,boundary:{state:'VERIFIED',readings:[]},creationOptions:{}});
    expect(args).toMatchObject({p_expected_revision:3,p_document_id:id,p_document_sha256:'a'.repeat(64),p_request_id:id,p_received_on:'2026-09-28',p_boundary:{state:'VERIFIED',reason:null,readings:[]}});
    expect(args).not.toHaveProperty('p_payload');
  });
  it('allows physical zero reading, rejects non-finite reading and unverified boundaries',()=>{
    const input={source:{draftId:id,revision:3,documentId:id,documentSha256:'a'.repeat(64)},requestId:id,receivedOn:'2026-09-28',roomReady:true,termsConfirmed:true,creationOptions:{},boundary:{state:'VERIFIED' as const,readings:[{meterId:id,reading:0,measuredAt:'2026-09-28T08:00:00+07:00'}]}};
    expect(buildContractSigningArgs(id,input).p_boundary).toMatchObject({readings:[{reading:0}]});
    expect(()=>buildContractSigningArgs(id,{...input,boundary:{state:'VERIFIED',readings:[{...input.boundary.readings[0],reading:Infinity}]}})).toThrow();
  });
  it('classifies stale/hold/permission failures without hiding signing status',()=>{
    expect(signingErrorMessage({code:'40001'})).toMatch(/phiên bản/i);
    expect(signingErrorMessage({code:'42501'})).toMatch(/quyền/);
    expect(signingErrorMessage({code:'55P03'})).toMatch(/giữ/);
    expect(signingErrorMessage({code:'55000'})).toMatch(/nhận phòng/);
  });
});
