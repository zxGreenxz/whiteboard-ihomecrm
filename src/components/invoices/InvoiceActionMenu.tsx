import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Pencil, Trash2, DollarSign } from 'lucide-react';
import { canEditInvoice, canDeleteInvoice } from '@/lib/invoiceUtils';
import type { InvoiceWithRelations } from '@/types/invoice';

interface InvoiceActionMenuProps {
  invoice: InvoiceWithRelations;
  onEdit?: (invoice: InvoiceWithRelations) => void;
  onDelete?: (invoice: InvoiceWithRelations) => void;
  onRecordPayment?: (invoice: InvoiceWithRelations) => void;
  /** Gate quyền — ẩn nút khi user không có quyền tương ứng. */
  canEdit?: boolean;
  canDelete?: boolean;
  canRecordPayment?: boolean;
}

const InvoiceActionMenu = ({
  invoice,
  onEdit,
  onDelete,
  onRecordPayment,
  canEdit = true,
  canDelete = true,
  canRecordPayment = true,
}: InvoiceActionMenuProps) => {
  const showEdit = canEdit && canEditInvoice(invoice);
  const showDelete = canDelete && canDeleteInvoice(invoice);
  const showPayment =
    canRecordPayment &&
    (invoice.status === 'APPROVED' || invoice.status === 'PARTIAL_PAID');

  const hasAnyAction = showEdit || showDelete || showPayment;
  if (!hasAnyAction) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {showEdit && (
          <DropdownMenuItem onClick={() => onEdit?.(invoice)}>
            <Pencil className="h-4 w-4 mr-2" />
            Cập nhật
          </DropdownMenuItem>
        )}

        {showPayment && (
          <DropdownMenuItem onClick={() => onRecordPayment?.(invoice)}>
            <DollarSign className="h-4 w-4 mr-2" />
            Thu tiền
          </DropdownMenuItem>
        )}

        {showDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => onDelete?.(invoice)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Xoá
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default InvoiceActionMenu;
