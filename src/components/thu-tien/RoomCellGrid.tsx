import { RoomCell } from './RoomCell';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  list: InvoiceWithRelations[];
  canRecordPayment: boolean;
  emptyIcon: string;
  emptyMessage: string;
  onOpen: (inv: InvoiceWithRelations) => void;
  onFull: (inv: InvoiceWithRelations) => void;
  onPart: (inv: InvoiceWithRelations) => void;
}

export function RoomCellGrid({
  list,
  canRecordPayment,
  emptyIcon,
  emptyMessage,
  onOpen,
  onFull,
  onPart,
}: Props) {
  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
        <div className="text-4xl">{emptyIcon}</div>
        <p className="text-sm text-zinc-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 px-4 pb-28 pt-1">
      {list.map((inv) => (
        <RoomCell
          key={inv.id}
          inv={inv}
          canRecordPayment={canRecordPayment}
          onOpen={onOpen}
          onFull={onFull}
          onPart={onPart}
        />
      ))}
    </div>
  );
}

export default RoomCellGrid;
