import {validateInputDrafts} from '@/lib/inputDraftValidation';
import {isConfirmedFinancialRejection} from '@/lib/financialWorkflow';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LoadingState } from '@/components/loading/LoadingState';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DateInput } from '@/components/ui/date-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ContractMeterBoundaryFields } from '@/components/contracts/ContractMeterBoundaryFields';
import { useContractDraftSigning, useContractSigning, useSignedContractDocument } from '@/hooks/contracts/useContractSigning';
import { useContractRoomDeposits } from '@/hooks/useDeposits';
import { buildSigningCreationOptions, signingErrorMessage, validateSigningConfirmation, type ContractSigning, type PreparedSigningCreation } from '@/lib/contractSigning';
import { compatibleDraftDocument, type ContractDraft } from '@/lib/contractDrafts';
import type { MeterBoundaryInput } from '@/lib/contractMeterBoundaries';

export interface ConfirmContractSigningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ContractDraft;
  canSign?: boolean;
  canPrint?: boolean;
  onSigned?: (signing: ContractSigning) => void;
  preparedCreation?: PreparedSigningCreation;
}
export function ConfirmContractSigningDialog({ open, onOpenChange, draft, canSign = true, canPrint = false, onSigned, preparedCreation }: ConfirmContractSigningDialogProps) {
  const snapshot = useContractDraftSigning(draft.id, open);
  const signingMutation = useContractSigning(draft.organization_id,draft.id);
  const documentMutation = useSignedContractDocument(draft.organization_id);
  const reservationsQuery = useContractRoomDeposits(open && draft.room_id ? draft.room_id : undefined, draft.payload.form.start_date);
  const [receivedOn, setReceivedOn] = useState(draft.payload.form.start_date);
  const [roomReady, setRoomReady] = useState(false);
  const [termsConfirmed, setTermsConfirmed] = useState(false);
  const [meterBoundary, setMeterBoundary] = useState<MeterBoundaryInput | null>(null);
  const [createFirstInvoice, setCreateFirstInvoice] = useState(true);
  const [depositMode, setDepositMode] = useState<'DEBT' | 'FIRST_INVOICE' | undefined>();
  const [debtReason, setDebtReason] = useState('');
  const [topupDueOn, setTopupDueOn] = useState('');
  const [localSigning, setLocalSigning] = useState<ContractSigning | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [unconfirmed,setUnconfirmed]=useState(false);
  const dialogRoot=useRef<HTMLDivElement>(null);
  const reconcilingRequest=useRef<string|null>(null);
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const continuedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setReceivedOn(draft.payload.form.start_date); setRoomReady(false); setTermsConfirmed(false); setMeterBoundary(null);
    setCreateFirstInvoice(true); setDepositMode(undefined); setDebtReason(''); setTopupDueOn('');
    setLocalSigning(null); setErrors([]);setUnconfirmed(false);intent.current = null; continuedRequest.current = null;reconcilingRequest.current=null;
  }, [open, draft.id, draft.revision, draft.payload.form.start_date]);
  const document = compatibleDraftDocument(draft);
  const signed = localSigning ?? snapshot.data?.signing;
  useEffect(() => {
    const requestId = signingMutation.pendingRequestId??intent.current?.requestId;
    if (!open || !signed || !requestId || continuedRequest.current === requestId) return;
    // Only resume the intent submitted here; opening an older signed draft is a read operation.
    if (!localSigning && signed.request_id !== requestId) return;
    if(!localSigning&&signingMutation.pendingRequestId){
      if(reconcilingRequest.current===requestId)return;reconcilingRequest.current=requestId;
      // Positive matching snapshot may trigger another read to clear the exact marker; no signing writer is replayed.
      void signingMutation.mutateAsync(undefined).then(result=>{intent.current={key:'recovered',requestId:result.request_id};setLocalSigning(result);setUnconfirmed(false);}).catch(error=>setErrors([signingErrorMessage(error)]));return;
    }
    continuedRequest.current = requestId;
    setErrors([]);
    onSigned?.(signed);
  }, [open, signed, localSigning, onSigned,signingMutation.pendingRequestId]);
  const pending = signingMutation.isPending || documentMutation.isPending;
  const unresolved=unconfirmed||!!signingMutation.pendingRequestId;
  const roomSource = reservationsQuery.data;
  const vouchers = roomSource?.vouchers ?? [];
  const received = vouchers.filter(voucher => voucher.received && !voucher.outsideWindow);
  const sourceIds = received.map(voucher => voucher.id);
  const roomTotal = received.reduce((sum,voucher) => sum + voucher.total_amount, 0);
  const blocked = vouchers.find(voucher => !voucher.received || voucher.outsideWindow);
  const preparedIds = preparedCreation?.options.existing_deposit_voucher_ids ?? [];
  const changed = !!preparedCreation && (preparedIds.length !== sourceIds.length || preparedIds.some(id => !sourceIds.includes(id))
    || preparedCreation.roomHold?.id !== roomSource?.hold?.id || preparedCreation.roomHold?.revision !== roomSource?.hold?.revision
    || (preparedCreation.roomDepositTotal !== undefined && preparedCreation.roomDepositTotal !== roomTotal));
  const reservationValid = !!roomSource && !reservationsQuery.isError && !reservationsQuery.isFetching && !blocked && !changed;
  const depositPaid = preparedCreation?.depositPaid ?? roomTotal;
  const confirmationErrors = validateSigningConfirmation(draft, document, { receivedOn, roomReady, termsConfirmed,
    metersConfirmed: meterBoundary?.state === 'VERIFIED' }, snapshot.data?.server_today);

  const handleSign = async () => {
    if(unresolved)return;
    if(!validateInputDrafts(dialogRoot.current)){setErrors(['Kiểm tra ngày/số đang được đánh dấu đỏ trước khi ký.']);return;}
    setErrors(confirmationErrors);
    if (confirmationErrors.length || !document || meterBoundary?.state !== 'VERIFIED' || !canSign || !reservationValid) return;
    try {
      const creationOptions = preparedCreation?.options ?? {...buildSigningCreationOptions(draft.payload, { createFirstInvoice, depositMode, debtReason, topupDueOn, depositPaid }), expected_room_deposit_amount:roomTotal, ...(sourceIds.length ? {existing_deposit_voucher_ids:sourceIds} : {})};
      const value = { source: { draftId: draft.id, revision: draft.revision, documentId: document.id, documentSha256: document.document_sha256 },
        receivedOn, roomReady, termsConfirmed, boundary: meterBoundary, creationOptions,
        ...(roomSource?.hold ? { reservationSource: { reservationId: roomSource.hold.id, revision: roomSource.hold.revision, sourceVoucherIds: sourceIds } } : {}) };
      const key = JSON.stringify(value);
      if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
      const result = await signingMutation.mutateAsync({ ...value, requestId: intent.current.requestId });
      if(result.request_id)intent.current={key,requestId:result.request_id};setLocalSigning(result);setUnconfirmed(false);setErrors([]);
    } catch (error) {
      if(!isConfirmedFinancialRejection(error))setUnconfirmed(true);
      setErrors([signingErrorMessage(error)]);
      // A lost HTTP response can follow a successful commit. Refresh source truth before allowing another click.
      void snapshot.refetch();
      void reservationsQuery.refetch();
    }
  };
  const handleReconcile=async()=>{
    try{const result=await signingMutation.mutateAsync(undefined);intent.current={key:'recovered',requestId:result.request_id};setLocalSigning(result);setUnconfirmed(false);setErrors([]);}
    catch(error){setErrors([signingErrorMessage(error)]);void snapshot.refetch();}
  };
  const handleDownload = async () => {
    if (!signed || !canPrint) return;
    try {
      const result = await documentMutation.mutateAsync(signed);
      setLocalSigning(result.signing); setErrors([]);
    } catch (error) { setErrors([`Hợp đồng vẫn đã ký. Chưa tạo được bản tải: ${signingErrorMessage(error)}`]); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
    <DialogContent ref={dialogRoot} className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Xác nhận đã ký và nhận phòng ngay</DialogTitle><DialogDescription>Ghi nhận khách đã ký tài liệu đã xuất và bàn giao phòng theo ngày bắt đầu của bản nháp.</DialogDescription></DialogHeader>
      {errors.length > 0 && <Alert variant="destructive"><AlertDescription>{errors.map(error => <p key={error}>{error}</p>)}</AlertDescription></Alert>}
      {unresolved&&<Alert><AlertDescription>Lần ký đã gửi cần được đối chiếu trước khi tiếp tục. Tải lại trang không huỷ yêu cầu đã gửi. <Button type="button" variant="link" disabled={pending} onClick={()=>void handleReconcile()}>Đối chiếu lần ký đã gửi</Button></AlertDescription></Alert>}
      {signed ? <div className="space-y-4">
        <Alert><AlertDescription>Đã ghi nhận ký và nhận phòng · {signed.contract_number}</AlertDescription></Alert>
        <p className="text-sm">Hợp đồng chính thức đã được tạo từ nháp phiên bản {signed.revision}. Có thể tải lại đúng bản này.</p>
        {canPrint && <Button type="button" disabled={pending} onClick={() => void handleDownload()}>{documentMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{signed.official_document_sha256 ? 'Tải hợp đồng đã ký' : 'Tạo lại bản tải'}</Button>}
      </div> : snapshot.isPending ? <LoadingState label="nguồn hợp đồng" rows={4} /> : snapshot.isError ? <Alert variant="destructive"><AlertDescription>Không thể kiểm tra hợp đồng đã được ký hay chưa. <Button type="button" variant="link" onClick={() => void snapshot.refetch()}>Tải lại</Button></AlertDescription></Alert> : <div className="space-y-4">
        <div className="rounded-md bg-muted p-3 text-sm space-y-1">
          <p>Nháp phiên bản {draft.revision} · {document?.template_snapshot.name ?? 'Chưa xuất tài liệu phiên bản này'}</p>
          <p>Thời hạn: {draft.payload.form.start_date} → {draft.payload.form.end_date}</p>
          <p>Tiền thuê: {draft.payload.form.rent_price.toLocaleString('vi-VN')} đ · Cọc thoả thuận: {draft.payload.form.total_deposit.toLocaleString('vi-VN')} đ</p>
        </div>
        {!document && <p role="alert" className="text-sm text-destructive">Lưu và xuất đúng phiên bản nháp trước khi ký.</p>}
        <fieldset disabled={pending || !canSign} className="space-y-4">
          <div className="space-y-1"><Label htmlFor="signing-received-date">Ngày nhận phòng thực tế</Label><DateInput id="signing-received-date" name="receivedOn" value={receivedOn} onChange={setReceivedOn}/><p className="text-xs text-muted-foreground">Nếu ngày nhận khác ngày bắt đầu trên tài liệu, sửa và xuất lại nháp trước khi xác nhận.</p></div>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={termsConfirmed} onChange={event => setTermsConfirmed(event.target.checked)}/><span>Khách đã ký đúng tài liệu nháp phiên bản {draft.revision} đã xuất.</span></label>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={roomReady} onChange={event => setRoomReady(event.target.checked)}/><span>Phòng đã sẵn sàng và được bàn giao cho khách mới.</span></label>
          {draft.room_id && <ContractMeterBoundaryFields key={`${draft.id}:${draft.revision}:${draft.room_id}`} roomId={draft.room_id} onChange={setMeterBoundary} disabled={pending}/>}
          {reservationsQuery.isPending ? <LoadingState label="nguồn cọc của phòng" rows={2}/> :
            reservationsQuery.isError ? <p role="alert">Không tải được nguồn cọc của phòng. <Button type="button" variant="link" onClick={()=>void reservationsQuery.refetch()}>Tải lại</Button></p> :
            <div className="space-y-1 text-sm">
              {roomSource?.hold?.hint && <p>Tên gợi nhớ khi nhận cọc: {roomSource.hold.hint}</p>}
              {received.map(voucher => <p key={voucher.id}>{voucher.code ?? voucher.name} · Đã nhận {voucher.total_amount.toLocaleString('vi-VN')} đ</p>)}
              {blocked && <p role="alert">Phiếu {blocked.code ?? blocked.name} {blocked.outsideWindow ? 'nằm ngoài kỳ nhận cọc' : 'chưa đủ điều kiện ghi nhận tiền'}.</p>}
              {changed && <p role="alert">Nguồn cọc đã thay đổi. Quay lại form hợp đồng để kiểm tra số cọc và hóa đơn đầu.</p>}
            </div>}
          {preparedCreation ? <p className="rounded-md border p-3 text-sm">Dùng khoản cọc đã nhận {depositPaid.toLocaleString('vi-VN')} đ
            {preparedCreation.options.transfer_support_amount ? ` (gồm ${preparedCreation.options.transfer_support_amount.toLocaleString('vi-VN')} đ khách cũ hỗ trợ, chuyển từ cọc hợp đồng cũ)` : ''}
            {' '}cùng lựa chọn nợ cọc và hoá đơn đầu đã kiểm tra trong form hợp đồng chính thức.</p> : <>
          {draft.payload.form.total_deposit - depositPaid >= 0.01 && <div className="rounded-md border p-3 space-y-3 text-sm">
            <p>Cọc còn thiếu {(draft.payload.form.total_deposit - depositPaid).toLocaleString('vi-VN')} đ. Chọn cách bổ sung:</p>
            <label className="flex gap-2"><input type="radio" name="signing-deposit-mode" checked={depositMode === 'DEBT'} onChange={() => setDepositMode('DEBT')}/>Theo dõi nợ cọc, bổ sung sau</label>
            <label className="flex gap-2"><input type="radio" name="signing-deposit-mode" checked={depositMode === 'FIRST_INVOICE'} onChange={() => { setDepositMode('FIRST_INVOICE'); setCreateFirstInvoice(true); }}/>Gộp cọc vào hoá đơn đầu để thu sau</label>
            {depositMode === 'DEBT' && <div className="grid gap-3"><div><Label htmlFor="signing-debt-reason">Lý do nợ cọc</Label><Input id="signing-debt-reason" value={debtReason} onChange={event => setDebtReason(event.target.value)}/></div><div><Label>Hạn bổ sung cọc</Label><DateInput name="Hạn bổ sung cọc" value={topupDueOn} onChange={setTopupDueOn}/></div></div>}
          </div>}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={createFirstInvoice} disabled={depositMode === 'FIRST_INVOICE'} onChange={event => setCreateFirstInvoice(event.target.checked)}/><span>Tạo hoá đơn đầu theo kỳ tính tiền và dịch vụ đã lưu</span></label>
          <p className="text-xs text-muted-foreground">Nguồn cọc đã chọn được chuyển đúng sang hợp đồng; không ghi phiếu thu cọc lần nữa. Phần chưa thu theo cách bổ sung đã chọn.</p>
          </>}
        </fieldset>
        <Button type="button" disabled={pending || unresolved || !canSign || confirmationErrors.length > 0 || !meterBoundary || !reservationValid} onClick={() => void handleSign()}>{signingMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin"/>}Xác nhận đã ký và nhận phòng</Button>
      </div>}
      <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Đóng</Button>
    </DialogContent>
  </Dialog>;
}
