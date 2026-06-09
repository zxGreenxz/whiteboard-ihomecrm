import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { fmtFull, remainingOf } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  invoice: InvoiceWithRelations | null;
  confirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Chống bấm nhầm "Thu đủ" ở ô phòng. */
export function ConfirmCollectDialog({ invoice, confirming, onConfirm, onCancel }: Props) {
  const open = !!invoice;
  const code =
    invoice?.building?.name && invoice?.room?.name
      ? `${invoice.building.name} - ${invoice.room.name}`
      : invoice?.room?.name ?? '';

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận thu đủ?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1">
              <div className="text-base font-semibold text-zinc-900">{code}</div>
              <div className="font-mono text-2xl font-bold tabular-nums text-emerald-600">
                {invoice ? fmtFull(remainingOf(invoice)) : ''}
              </div>
              <div>Đánh dấu phòng này đã thu đủ tiền mặt.</div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>Hủy</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirming}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            Thu đủ
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ConfirmCollectDialog;
