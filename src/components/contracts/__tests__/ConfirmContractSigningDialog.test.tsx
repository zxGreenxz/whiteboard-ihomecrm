// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContractDraft } from '@/lib/contractDrafts';
import { emptyContractDraftPayload } from '@/lib/contractDrafts';
const mocks=vi.hoisted(()=>({sign:vi.fn(),download:vi.fn(),query:{data:{server_today:'2026-09-28',signing:null as unknown},isPending:false,isError:false,refetch:vi.fn()},reservations:{data:{reservations:[] as unknown[]},isPending:false,isError:false,refetch:vi.fn()},boundary:true,pendingRequestId:null as string|null}));
vi.mock('@/hooks/useRoomReservations',()=>({useRoomReservations:()=>mocks.reservations}));
vi.mock('@/hooks/contracts/useContractSigning',()=>({useContractDraftSigning:()=>mocks.query,useContractSigning:()=>({mutateAsync:mocks.sign,isPending:false,pendingRequestId:mocks.pendingRequestId}),useSignedContractDocument:()=>({mutateAsync:mocks.download,isPending:false,isError:false})}));
vi.mock('@/components/contracts/ContractMeterBoundaryFields',()=>({ContractMeterBoundaryFields:({onChange}:{onChange:(value:unknown)=>void})=><button type="button" onClick={()=>onChange({state:'VERIFIED',readings:[]})}>Xác minh chỉ số</button>}));
import { ConfirmContractSigningDialog } from '../ConfirmContractSigningDialog';
const id='11111111-1111-4111-8111-111111111111';const payload=emptyContractDraftPayload();payload.form={...payload.form,room_id:id,signed_date:'2026-09-28',start_date:'2026-09-28',end_date:'2027-09-28',start_billing_date:'2026-09-28',end_billing_date:'2026-09-30'};
const draft:ContractDraft={id,organization_id:id,building_id:id,room_id:id,revision:1,template_id:id,payload,created_by:id,created_at:'2026-09-28',updated_at:'2026-09-28',documents:[{id,draft_id:id,revision:1,document_path:'document.docx',template_path:'template.docx',document_sha256:'a'.repeat(64),template_sha256:'b'.repeat(64),template_snapshot:{id,name:'Mẫu đã xuất',updated_at:'2026-09-28'},created_at:'2026-09-28'}]};
const result={id,organization_id:id,draft_id:id,contract_id:id,contract_number:'HD-2026-00001',official_document_sha256:null};
function ready(){fireEvent.click(screen.getByLabelText(/Khách đã ký đúng/));fireEvent.click(screen.getByLabelText(/Phòng đã sẵn sàng/));fireEvent.click(screen.getByText('Xác minh chỉ số'));}
beforeEach(()=>{vi.clearAllMocks();mocks.pendingRequestId=null;mocks.query.data={server_today:'2026-09-28',signing:null};mocks.query.isError=false;mocks.reservations.data={reservations:[]};mocks.reservations.isError=false;mocks.sign.mockResolvedValue(result);});
afterEach(cleanup);
describe('confirm persisted document signing',()=>{
  it('signs exact saved bytes after funding-only revision and rejects customer-changed bytes', async () => {
    const current = { ...draft, revision: 3, customer_revision: 1 };
    const { rerender } = render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={current}/>);
    ready(); fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đã ký và nhận phòng' }));
    await waitFor(() => expect(mocks.sign).toHaveBeenCalledOnce());
    expect(mocks.sign.mock.calls[0][0].source).toEqual({ draftId: id, revision: 3, documentId: id, documentSha256: 'a'.repeat(64) });
    cleanup(); mocks.sign.mockClear();
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={{ ...current, customer_revision: 2 }}/>);
    ready();
    expect(screen.getByRole('button', { name: 'Xác nhận đã ký và nhận phòng' }).hasAttribute('disabled')).toBe(true);
  });
  it('requires all confirmations/physical readings and sends the exact artifact source once',async()=>{
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft}/>);
    expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(true);ready();
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));
    await waitFor(()=>expect(mocks.sign).toHaveBeenCalledTimes(1));expect(mocks.sign.mock.calls[0][0]).toMatchObject({source:{draftId:id,revision:1,documentId:id,documentSha256:'a'.repeat(64)},creationOptions:{}});
    await screen.findByText(/Đã ghi nhận ký.*HD-2026-00001/);expect(screen.queryByRole('button',{name:'Xác nhận đã ký và nhận phòng'})).toBeNull();
  });
  it('lost response blocks another signing and offers readonly reconciliation instead of a new identity',async()=>{
    mocks.sign.mockRejectedValueOnce(new Error('Network lost'));render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft}/>);ready();
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));await screen.findByText(/Chưa.*ký hợp đồng/);expect(screen.queryByText('Network lost')).toBeNull();
    const signButton=screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'});expect(signButton.hasAttribute('disabled')).toBe(true);fireEvent.click(signButton);expect(mocks.sign).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'Đối chiếu lần ký đã gửi'}));await waitFor(()=>expect(mocks.sign).toHaveBeenCalledTimes(2));expect(mocks.sign.mock.calls[1][0]).toBeUndefined();
  });
  it('continues once when a snapshot recovers the current signing intent after a lost response',async()=>{
    const onSigned=vi.fn();mocks.sign.mockRejectedValueOnce(new Error('Network lost'));
    const props={open:true,onOpenChange:vi.fn(),draft,onSigned};
    const {rerender}=render(<ConfirmContractSigningDialog {...props}/>);ready();
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));await screen.findByText(/Chưa.*ký hợp đồng/);
    const recovered={...result,request_id:mocks.sign.mock.calls[0][0].requestId};
    mocks.query.data.signing=recovered;rerender(<ConfirmContractSigningDialog {...props}/>);
    await waitFor(()=>expect(onSigned).toHaveBeenCalledWith(recovered));
    rerender(<ConfirmContractSigningDialog {...props}/>);
    expect(onSigned).toHaveBeenCalledTimes(1);expect(screen.queryByText('Network lost')).toBeNull();
  });
  it('does not reopen the follow-up for an old or another user signing snapshot',async()=>{
    const onSigned=vi.fn();mocks.query.data.signing={...result,request_id:'older-intent'};
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft} onSigned={onSigned}/>);
    await screen.findByText(/Đã ghi nhận ký.*HD-2026-00001/);expect(onSigned).not.toHaveBeenCalled();
  });
  it('keeps signed state and retries only the download when artifact rendering fails',async()=>{
    mocks.query.data.signing=result;mocks.download.mockRejectedValue(new Error('Render failed'));render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft} canPrint/>);
    fireEvent.click(screen.getByRole('button',{name:'Tạo lại bản tải'}));await screen.findByText(/Hợp đồng vẫn đã ký.*Chưa ghi nhận/);expect(mocks.sign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Tạo lại bản tải'}));await waitFor(()=>expect(mocks.download).toHaveBeenCalledTimes(2));
  });
  it('blocks signing on read error/unexported draft and gates official download by print permission',()=>{
    mocks.query.isError=true;const{rerender}=render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft}/>);expect(screen.queryByRole('button',{name:'Xác nhận đã ký và nhận phòng'})).toBeNull();
    mocks.query.isError=false;rerender(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={{...draft,documents:[]}}/>);expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(true);
    mocks.query.data.signing=result;rerender(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft}/>);expect(screen.queryByRole('button',{name:'Tạo lại bản tải'})).toBeNull();
  });
  it('selects only own matching live reservation and credits exact received sources without an extra receipt',async()=>{
    const own={id,organization_id:id,building_id:id,room_id:id,customer_id:id,customer_name:'Khách A',status:'HOLD',claim_status:'LIVE',revision:4,received_amount:2000000,source_voucher_ids:[id],receipts:[{received:true,approval_status:'APPROVED'}]};
    mocks.reservations.data.reservations=[own,{...own,id:'other',customer_id:'other',customer_name:'Khách khác'}];
    const positive={...draft,payload:{...payload,form:{...payload.form,total_deposit:2000000},customers:[{id,full_name:'Khách A',phone:'0900000000',id_number:'0123456789',is_representative:true,notes:null}]}};
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={positive}/>);
    expect(screen.queryByText(/Khách khác/)).toBeNull();fireEvent.click(screen.getByLabelText(/Khách A.*2.000.000/));ready();
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));await waitFor(()=>expect(mocks.sign).toHaveBeenCalledTimes(1));
    expect(mocks.sign.mock.calls[0][0]).toMatchObject({reservationSource:{reservationId:id,revision:4,sourceVoucherIds:[id]},creationOptions:{}});
    expect(JSON.stringify(mocks.sign.mock.calls[0][0])).not.toContain('deposit_receipts');
  });
  it('shows reservation read error as error and prevents stale selected claim from becoming a no-hold signing silently',()=>{
    const own={id,organization_id:id,building_id:id,room_id:id,customer_id:id,customer_name:'Khách A',status:'HOLD',claim_status:'LIVE',revision:4,received_amount:0,source_voucher_ids:[],receipts:[]};mocks.reservations.data.reservations=[own];
    const withCustomer={...draft,payload:{...payload,customers:[{id,full_name:'Khách A',phone:'',id_number:null,is_representative:true,notes:null}]}};
    const{rerender}=render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={withCustomer}/>);fireEvent.click(screen.getByLabelText(/Khách A.*0/));ready();
    mocks.reservations.isError=true;rerender(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={withCustomer}/>);
    expect(screen.getByText(/Không tải được nguồn giữ chỗ/)).toBeTruthy();expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/Không chuyển nguồn giữ chỗ/));expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(false);
  });
  it('uses prepared official money and invoice inputs without asking or rebuilding them',async()=>{
    const options={deposit_debt_mode:'DEBT' as const,deposit_debt_reason:'Đã xác nhận tại form',deposit_topup_due_date:'2026-10-02',
      deposit_receipts:[{amount:400000,account_id:id,received_date:'2026-09-28',attachments:['proof/1']}],
      existing_deposit_voucher_ids:[id],invoice_template_id:id,
      first_invoice:{items:[{type:'RENT' as const,accounting_class:'REVENUE' as const,description:'Dòng đã sửa tại form',unit_price:1234567,quantity:1}],
        discount_amount:11111,notes:'Ghi chú đã sửa'}};
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft} preparedCreation={{options,depositPaid:400000}}/>);
    expect(screen.queryByText(/Chọn cách bổ sung/)).toBeNull();
    expect(screen.queryByText(/Tạo hoá đơn đầu theo kỳ/)).toBeNull();
    ready();fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));
    await waitFor(()=>expect(mocks.sign).toHaveBeenCalledTimes(1));
    expect(mocks.sign.mock.calls[0][0].creationOptions).toEqual(options);
  });
  it('requires review in the shared form when selected reservation vouchers were absent from prepared inputs',()=>{
    const own={id,organization_id:id,building_id:id,room_id:id,customer_id:id,customer_name:'Khách A',status:'HOLD',claim_status:'LIVE',revision:4,
      received_amount:2000000,source_voucher_ids:[id],receipts:[{received:true,approval_status:'APPROVED'}]};
    mocks.reservations.data.reservations=[own];
    const withCustomer={...draft,payload:{...payload,form:{...payload.form,total_deposit:2000000},
      customers:[{id,full_name:'Khách A',phone:'0900000000',id_number:'0123456789',is_representative:true,notes:null}]}};
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={withCustomer}
      preparedCreation={{options:{existing_deposit_voucher_ids:[],deposit_debt_mode:'DEBT',deposit_debt_reason:'Theo form',deposit_topup_due_date:'2026-10-02'},depositPaid:0}}/>);
    ready();fireEvent.click(screen.getByLabelText(/Khách A.*2.000.000/));
    expect(screen.getByText(/quay lại form.*kiểm tra/i)).toBeTruthy();
    expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(true);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('keeps an already prepared reservation source without changing the official paid amount',async()=>{
    const own={id,organization_id:id,building_id:id,room_id:id,customer_id:id,customer_name:'Khách A',status:'HOLD',claim_status:'LIVE',revision:4,
      received_amount:2000000,source_voucher_ids:[id],receipts:[{received:true,approval_status:'APPROVED'}]};
    mocks.reservations.data.reservations=[own];
    const withCustomer={...draft,payload:{...payload,form:{...payload.form,total_deposit:2000000},
      customers:[{id,full_name:'Khách A',phone:'0900000000',id_number:'0123456789',is_representative:true,notes:null}]}};
    const options={existing_deposit_voucher_ids:[id],deposit_debt_mode:'DEBT' as const,deposit_debt_reason:'Theo form',deposit_topup_due_date:'2026-10-02'};
    render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={withCustomer}
      preparedCreation={{options,depositPaid:2000000}}/>);
    ready();fireEvent.click(screen.getByLabelText(/Khách A.*2.000.000/));
    expect(screen.queryByText(/quay lại form.*kiểm tra/i)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));
    await waitFor(()=>expect(mocks.sign).toHaveBeenCalledTimes(1));
    expect(mocks.sign.mock.calls[0][0]).toMatchObject({creationOptions:options,
      reservationSource:{reservationId:id,revision:4,sourceVoucherIds:[id]}});
  });
});

it('pending marker được hydrate khóa sign payload mới sau remount và chỉ cho readonly reconcile',async()=>{
 mocks.pendingRequestId=id;mocks.sign.mockResolvedValue({...result,request_id:id});const onSigned=vi.fn();render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft} onSigned={onSigned}/>);ready();
 expect(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}).hasAttribute('disabled')).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Đối chiếu lần ký đã gửi'}));await waitFor(()=>expect(mocks.sign).toHaveBeenCalledWith(undefined));await waitFor(()=>expect(onSigned).toHaveBeenCalledOnce());
});
it('manual sign giữ invalid date raw/focus và không bypass bằng ngày cũ trong state',async()=>{
 render(<ConfirmContractSigningDialog open onOpenChange={vi.fn()} draft={draft}/>);ready();const date=screen.getByLabelText('Ngày nhận phòng thực tế') as HTMLInputElement;fireEvent.change(date,{target:{value:'31/02/2026'}});fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã ký và nhận phòng'}));await screen.findByText(/Kiểm tra ngày\/số/);expect(date.value).toBe('31/02/2026');expect(document.activeElement).toBe(date);expect(mocks.sign).not.toHaveBeenCalled();
});
