import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { DateInput } from '@/components/ui/date-input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useReadContractMoveOutNotice, useSaveContractMoveOutNotice } from '@/hooks/useContractMoveOutNotice';
import { classifyDbError } from '@/lib/contracts/errors';
import {
  getMoveOutNoticeState, moveOutNoticeErrorMessage, moveOutNoticeFormSchema,
  type MoveOutNoticeFormData, type MoveOutNoticeSnapshot,
} from '@/lib/contractMoveOutNotice';

export interface MoveOutNoticeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: { id: string } | null;
}

export function MoveOutNoticeDialog({ open, onOpenChange, contract }: MoveOutNoticeDialogProps) {
  const read = useReadContractMoveOutNotice();
  const save = useSaveContractMoveOutNotice();
  const [snapshot, setSnapshot] = useState<MoveOutNoticeSnapshot | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const form = useForm<MoveOutNoticeFormData>({
    resolver: zodResolver(moveOutNoticeFormSchema),
    defaultValues: { expected_move_out_date: '', reason: '' },
  });
  const contractId = contract?.id;
  const readAsync = read.mutateAsync;
  const reset = form.reset;
  useEffect(() => {
    const request = ++sequence.current;
    setSnapshot(null);
    setReadError(null);
    setSaveError(null);
    if (open && contractId) {
      reset({ expected_move_out_date: '', reason: '' });
      void readAsync(contractId).then(data => {
        if (sequence.current !== request) return;
        setSnapshot(data);
        reset({ expected_move_out_date: data.expected_move_out_date ?? '', reason: '' });
      }).catch(error => { if (sequence.current === request) setReadError(error); });
    }
    return () => { sequence.current = request + 1; };
  }, [open, contractId, revision, readAsync, reset, read.selectedOrganizationId]);

  const persist = async (date: string | null, reason: string) => {
    if (!snapshot || save.isPending) return;
    const request = sequence.current;
    setSaveError(null);
    try {
      await save.mutateAsync({ contractId: snapshot.contract_id, expectedUpdatedAt: snapshot.updated_at,
        expectedMoveOutDate: date, reason });
      if (request === sequence.current) onOpenChange(false);
    } catch (error) { if (request === sequence.current) setSaveError(error); }
  };
  const cancelNotice = () => {
    const reason = form.getValues('reason').trim();
    if (!reason) {
      form.setError('reason', { message: 'Vui lòng nhập lý do hủy báo trả phòng' });
      return;
    }
    void persist(null, reason);
  };
  const reload = () => setRevision(value => value + 1);
  const noticeState = snapshot ? getMoveOutNoticeState(snapshot.expected_move_out_date, snapshot.today) : 'none';
  const stale = classifyDbError(saveError) === 'conflict';

  return (
    <Dialog open={open && !!contract} onOpenChange={value => { if (!save.isPending) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{snapshot?.expected_move_out_date ? 'Sửa báo trả phòng' : 'Báo ngày dự kiến trả phòng'}</DialogTitle>
          <DialogDescription>Ghi nhận ngày khách dự kiến trả phòng. Hợp đồng vẫn đang ở cho đến khi làm thanh lý.</DialogDescription>
        </DialogHeader>
        {readError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">{moveOutNoticeErrorMessage(readError)}</p>
            <Button variant="outline" onClick={reload}>Thử tải lại</Button>
          </div>
        ) : !snapshot ? (
          <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Đang tải báo trả phòng...</p>
        ) : snapshot.status !== 'ACTIVE' ? (
          <p role="alert" className="text-sm text-destructive">Hợp đồng không còn đang ở. Vui lòng tải lại danh sách hợp đồng.</p>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(data => persist(data.expected_move_out_date, data.reason))} className="space-y-4">
              {(noticeState === 'due' || noticeState === 'overdue') && (
                <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  {noticeState === 'due' ? 'Đến ngày dự kiến trả phòng.' : 'Đã quá ngày dự kiến trả phòng.'} Khách vẫn đang ở: xác nhận lại ngày hoặc hủy báo nếu khách ở tiếp.
                </p>
              )}
              <FormField control={form.control} name="expected_move_out_date" render={({ field }) => (
                <FormItem><FormLabel>Ngày dự kiến trả phòng *</FormLabel><FormControl>
                  <DateInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} disabled={save.isPending || stale} />
                </FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="reason" render={({ field }) => (
                <FormItem><FormLabel>Lý do / ghi chú</FormLabel><FormControl>
                  <Textarea {...field} rows={3} placeholder="Khách đổi ngày, ở tiếp..." disabled={save.isPending || stale} />
                </FormControl><FormMessage /></FormItem>
              )} />
              {saveError != null && <p role="alert" className="text-sm text-destructive">{moveOutNoticeErrorMessage(saveError)}</p>}
              {stale && <Button type="button" variant="outline" onClick={reload}>Tải lại báo trả phòng</Button>}
              <DialogFooter className="flex-wrap gap-2">
                {snapshot.expected_move_out_date && <Button type="button" variant="destructive" disabled={save.isPending || stale} onClick={cancelNotice}>Hủy báo trả phòng</Button>}
                <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                <Button type="submit" disabled={save.isPending || stale}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu ngày dự kiến</Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
