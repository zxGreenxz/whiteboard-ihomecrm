import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CheckCircle } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import InvoiceStatusBadge from './InvoiceStatusBadge';
import InvoiceActionMenu from './InvoiceActionMenu';
import type { InvoiceWithRelations } from '@/types/invoice';
import { canApproveInvoice } from '@/lib/invoiceUtils';

interface InvoiceListTableProps {
  invoices: InvoiceWithRelations[];
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onApprove: (invoice: InvoiceWithRelations) => void;
  onEdit: (invoice: InvoiceWithRelations) => void;
  onDelete: (invoice: InvoiceWithRelations) => void;
  onRecordPayment: (invoice: InvoiceWithRelations) => void;
  onUnapprove: (invoice: InvoiceWithRelations) => void;
  onViewDetail: (invoice: InvoiceWithRelations) => void;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

const formatDate = (date: string | null) => {
  if (!date) return '—';
  return format(new Date(date), 'dd/MM/yyyy', { locale: vi });
};

const InvoiceListTable = ({
  invoices,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onApprove,
  onEdit,
  onDelete,
  onRecordPayment,
  onUnapprove,
  onViewDetail,
}: InvoiceListTableProps) => {
  const draftInvoices = invoices.filter((inv) => inv.status === 'DRAFT');
  const isAllDraftSelected = draftInvoices.length > 0 && selectedIds.length === draftInvoices.length;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              checked={isAllDraftSelected}
              onCheckedChange={onToggleSelectAll}
              disabled={draftInvoices.length === 0}
              aria-label="Chọn tất cả hoá đơn nháp"
            />
          </TableHead>
          <TableHead>Mã HD</TableHead>
          <TableHead>Toà nhà</TableHead>
          <TableHead>Phòng</TableHead>
          <TableHead>Khách thuê</TableHead>
          <TableHead>Kỳ TT</TableHead>
          <TableHead>Ngày lập</TableHead>
          <TableHead>Hạn TT</TableHead>
          <TableHead className="text-right">Tổng tiền</TableHead>
          <TableHead className="text-right">Đã trả</TableHead>
          <TableHead className="text-right">Còn nợ</TableHead>
          <TableHead>Trạng thái</TableHead>
          <TableHead className="text-right">Thao tác</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.length === 0 ? (
          <TableRow>
            <TableCell colSpan={13} className="h-24 text-center text-muted-foreground">
              Không có hoá đơn nào
            </TableCell>
          </TableRow>
        ) : (
          invoices.map((invoice) => {
            const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
            const isDraft = invoice.status === 'DRAFT';

            return (
              <TableRow key={invoice.id}>
                <TableCell>
                  <Checkbox
                    checked={selectedIds.includes(invoice.id)}
                    onCheckedChange={() => onToggleSelect(invoice.id)}
                    disabled={!isDraft}
                    aria-label={`Chọn hoá đơn ${invoice.invoice_number}`}
                  />
                </TableCell>
                <TableCell>
                  <button
                    className="font-medium text-blue-600 hover:underline cursor-pointer text-sm"
                    onClick={() => onViewDetail(invoice)}
                  >
                    {invoice.invoice_number || invoice.id.slice(0, 8)}
                  </button>
                </TableCell>
                <TableCell className="text-sm">{invoice.building?.name ?? '—'}</TableCell>
                <TableCell className="text-sm">{invoice.room?.name ?? '—'}</TableCell>
                <TableCell className="text-sm">
                  {invoice.tenant?.full_name ?? invoice.contract?.contract_number ?? '—'}
                </TableCell>
                <TableCell className="text-sm">{invoice.billing_month ?? '—'}</TableCell>
                <TableCell className="text-sm">{formatDate(invoice.issue_date)}</TableCell>
                <TableCell className="text-sm">{formatDate(invoice.due_date)}</TableCell>
                <TableCell className="text-right text-sm font-medium">
                  {formatCurrency(invoice.total_amount || 0)}
                </TableCell>
                <TableCell className="text-right text-sm text-green-600">
                  {formatCurrency(invoice.paid_amount || 0)}
                </TableCell>
                <TableCell
                  className={`text-right text-sm ${remaining > 0 ? 'text-orange-600 font-medium' : 'text-muted-foreground'}`}
                >
                  {formatCurrency(remaining)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <InvoiceStatusBadge status={invoice.status} />
                    {canApproveInvoice(invoice.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => onApprove(invoice)}
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Duyệt
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <InvoiceActionMenu
                    invoice={invoice}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onRecordPayment={onRecordPayment}
                    onUnapprove={onUnapprove}
                  />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
};

export default InvoiceListTable;
