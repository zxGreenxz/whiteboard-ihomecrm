import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StorageImage } from '@/components/ui/storage-image';
import { FileText } from 'lucide-react';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import AttachmentUpload from './AttachmentUpload';
import { VoucherSupplementNotes } from './VoucherNote';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { useAppendIncomeExpenseSupplement, useIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { getVoucherDisplayAttachments, supplementFormSchema, type SupplementFormValues } from '@/lib/incomeExpenseSupplement';
import { useAuth } from '@/hooks/useAuth';

interface Props { open: boolean; onOpenChange: (open: boolean) => void; voucher: IncomeExpenseWithRelations | null; }

/** Only additional narrative/evidence; original financial data is never submitted. */
export function IncomeExpenseQuickEditDialog({ open, onOpenChange, voucher }: Props) {
  const { data: user } = useAuth();
  const append = useAppendIncomeExpenseSupplement();
  const previous = useIncomeExpenseSupplements(voucher?.id, open);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const saving = useRef(false);
  const operation = useRef<{ payload: string; key: string } | null>(null);
  const form = useForm<SupplementFormValues>({ resolver: zodResolver(supplementFormSchema),
    defaultValues: { note: '', attachments: [] } });
  const { reset } = form;
  useEffect(() => {
    if (open) { reset({ note: '', attachments: [] }); operation.current = null; setLightbox(null); }
  }, [open, voucher?.id, reset]);
  const attachments = form.watch('attachments');
  const note = form.watch('note');
  const busy = uploading || append.isPending;
  const oldSupplements = previous.data ?? voucher?.supplements ?? [];
  const oldAttachments = getVoucherDisplayAttachments({ attachments: voucher?.attachments, supplements: oldSupplements });
  const changeOpen = (next: boolean) => { if (!busy && !saving.current) onOpenChange(next); };
  const save = form.handleSubmit(async values => {
    if (!voucher || busy || saving.current) return;
    saving.current = true;
    const payload = JSON.stringify({ voucherId: voucher.id, ...values });
    if (operation.current?.payload !== payload) operation.current = { payload, key: crypto.randomUUID() };
    try {
      await append.mutateAsync({ voucherId: voucher.id, ...values, idempotencyKey: operation.current.key });
      onOpenChange(false);
    } catch {
      // The mutation shows a classified error; keep additions and retry key intact.
    } finally { saving.current = false; }
  });
  if (!voucher) return null;

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent className="sm:max-w-[560px] max-h-[90dvh] overflow-y-auto"
      onInteractOutside={event => { if (busy || lightbox !== null) event.preventDefault(); }}
      onEscapeKeyDown={event => { if (busy || lightbox !== null) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>BỔ SUNG CHỨNG TỪ / GHI CHÚ</DialogTitle>
        <DialogDescription>Bổ sung cho phiếu <b>{voucher.code}</b>. Nội dung cũ được giữ nguyên. Mỗi lần bổ sung sẽ ghi rõ người thực hiện và thời gian.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <section aria-label="Nội dung đã có" className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <Label>Ghi chú đã có</Label>
          {voucher.notes ? <div className="whitespace-pre-wrap text-sm break-words">{voucher.notes}</div> : <p className="text-sm text-muted-foreground">Chưa có ghi chú gốc.</p>}
          <VoucherSupplementNotes supplements={oldSupplements} />
          <Label>Ảnh / chứng từ đã có</Label>
          {oldAttachments.length ? <div className="flex flex-wrap gap-2">{oldAttachments.map((url, index) =>
            <button type="button" key={url} className="h-20 w-20 rounded border overflow-hidden" aria-label={`Xem chứng từ đã có ${index + 1}`} onClick={() => setLightbox(index)}>
              {/\.pdf(?:$|[?#])/i.test(url) ? <FileText className="m-auto h-8 w-8" /> : <StorageImage value={url} alt={`Chứng từ đã có ${index + 1}`} className="h-full w-full object-cover" />}
            </button>)}</div> : <p className="text-sm text-muted-foreground">Chưa có ảnh đính kèm.</p>}
          {previous.isLoading && <p className="text-xs text-muted-foreground">Đang tải các lần bổ sung…</p>}
          {previous.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được các lần bổ sung. Hãy đóng và mở lại phiếu.</p>}
        </section>
        <div className="space-y-2"><Label>Ảnh / chứng từ bổ sung</Label>
          <AttachmentUpload attachments={attachments} onChange={urls => form.setValue('attachments', urls, { shouldValidate: true })}
            userId={user?.id ?? ''} disabled={busy} onUploadingChange={setUploading} maxFiles={20} deleteOnRemove={false} />
          {form.formState.errors.attachments && <p role="alert" className="text-sm text-destructive">{form.formState.errors.attachments.message}</p>}
        </div>
        <div className="space-y-2"><Label htmlFor="supplement-note">Ghi chú bổ sung</Label>
          <Textarea id="supplement-note" {...form.register('note')} disabled={busy} rows={3} maxLength={5000} placeholder="Nhập nội dung cần bổ sung…" />
          {form.formState.errors.note && <p role="alert" className="text-sm text-destructive">{form.formState.errors.note.message}</p>}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy}>Huỷ</Button>
          <Button type="submit" aria-label="Lưu bổ sung" disabled={busy || (!note.trim() && !attachments.length) || !user?.id}>{busy ? 'Đang lưu…' : 'Lưu bổ sung'}</Button>
        </DialogFooter>
      </form>
      <AttachmentLightbox index={lightbox} onIndexChange={setLightbox} attachments={oldAttachments} />
    </DialogContent>
  </Dialog>;
}
export default IncomeExpenseQuickEditDialog;
