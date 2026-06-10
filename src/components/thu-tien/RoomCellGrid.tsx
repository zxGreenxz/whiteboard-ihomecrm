import { RoomCell } from './RoomCell';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  list: InvoiceWithRelations[];
  /** invoice_id → tên người thu theo thứ tự thu. */
  collectorsByInvoice?: Record<string, string[]>;
  canRecordPayment: boolean;
  emptyIcon: string;
  emptyMessage: string;
  onOpen: (inv: InvoiceWithRelations) => void;
  onFull: (inv: InvoiceWithRelations) => void;
  onPart: (inv: InvoiceWithRelations) => void;
}

export function RoomCellGrid({
  list,
  collectorsByInvoice = {},
  canRecordPayment,
  emptyIcon,
  emptyMessage,
  onOpen,
  onFull,
  onPart,
}: Props) {
  return (
    <div className="cells-wrap">
      {list.length === 0 ? (
        <div className="c-empty">
          <div className="e-ic">{emptyIcon}</div>
          <p>{emptyMessage}</p>
        </div>
      ) : (
        <div className="cells tiles">
          {list.map((inv) => (
            <RoomCell
              key={inv.id}
              inv={inv}
              collectors={collectorsByInvoice[inv.id]}
              canRecordPayment={canRecordPayment}
              onOpen={onOpen}
              onFull={onFull}
              onPart={onPart}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default RoomCellGrid;
