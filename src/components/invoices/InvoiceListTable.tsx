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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import {
  CheckCircle,
  XCircle,
  Pencil,
  DollarSign,
  History,
  Trash2,
} from 'lucide-react';
import type { InvoiceWithRelations } from '@/types/invoice';
import { canApproveInvoice, canEditInvoice, canDeleteInvoice } from '@/lib/invoiceUtils';

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
  onViewHistory?: (invoice: InvoiceWithRelations) => void;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

/** Sum invoice_items amounts by type */
const sumByType = (items: InvoiceWithRelations['invoice_items'], types: string[]): number => {
  if (!items) return 0;
  return items
    .filter((item) => types.includes(item.type))
    .reduce((sum, item) => sum + (item.amount || 0), 0);
};

/** Build invoice title from type and billing_month */
const getInvoiceTitle = (invoice: InvoiceWithRelations): string => {
  const month = invoice.billing_month ?? '';
  // Check if it's a liquidation invoice by looking at notes or items
  const hasRent = invoice.invoice_items?.some((i) => i.type === 'RENT');
  const hasService = invoice.invoice_items?.some((i) => i.type === 'SERVICE' || i.type === 'PENALTY');

  if (hasRent && hasService) return `Hóa đơn hàng tháng - ${month}`;
  if (hasRent) return `Hóa đơn tiền nhà - ${month}`;
  if (hasService) return `Hóa đơn dịch vụ - ${month}`;
  return `Hóa đơn - ${month}`;
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
  onViewHistory,
}: InvoiceListTableProps) => {
  const { toast } = useToast();
  const draftInvoices = invoices.filter((inv) => inv.status === 'DRAFT');
  const isAllDraftSelected = draftInvoices.length > 0 && selectedIds.length === draftInvoices.length;

  const showTodo = (feature: string) => {
    console.log(`TODO: ${feature}`);
    toast({ title: 'Tính năng đang phát triển', description: feature });
  };

  return (
    <TooltipProvider>
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
            <TableHead className="w-[100px]">Mã</TableHead>
            <TableHead className="w-[180px]">Thao tác</TableHead>
            <TableHead>Hoá đơn</TableHead>
            <TableHead>Khách hàng</TableHead>
            <TableHead className="text-right">Tiền thuê</TableHead>
            <TableHead className="text-right">Tiền dịch vụ</TableHead>
            <TableHead className="text-right">Tổng tiền</TableHead>
            <TableHead className="text-right">Đã thanh toán</TableHead>
            <TableHead className="text-right">Còn nợ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                Không có hoá đơn nào
              </TableCell>
            </TableRow>
          ) : (
            invoices.map((invoice) => {
              const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
              const isDraft = invoice.status === 'DRAFT';
              const isApproved = invoice.status === 'APPROVED';
              const rentAmount = sumByType(invoice.invoice_items, ['RENT']);
              const serviceAmount = sumByType(invoice.invoice_items, ['SERVICE', 'PENALTY']);
              const customerName = invoice.tenant?.full_name ?? '—';
              const locationCode = [invoice.building?.name, invoice.room?.name]
                .filter(Boolean)
                .join(' / ');

              return (
                <TableRow key={invoice.id}>
                  {/* Checkbox */}
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(invoice.id)}
                      onCheckedChange={() => onToggleSelect(invoice.id)}
                      disabled={!isDraft}
                      aria-label={`Chọn hoá đơn ${invoice.invoice_number}`}
                    />
                  </TableCell>

                  {/* Mã */}
                  <TableCell>
                    <button
                      className="font-medium text-blue-600 hover:underline cursor-pointer text-sm"
                      onClick={() => onViewDetail(invoice)}
                    >
                      {invoice.invoice_number || invoice.id.slice(0, 8)}
                    </button>
                  </TableCell>

                  {/* Thao tác - inline icon buttons */}
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {/* Duyệt / Bỏ duyệt */}
                      {canApproveInvoice(invoice.status) ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-green-100 text-green-600 hover:bg-green-200"
                              onClick={() => onApprove(invoice)}
                            >
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Duyệt</TooltipContent>
                        </Tooltip>
                      ) : isApproved ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-orange-100 text-orange-600 hover:bg-orange-200"
                              onClick={() => onUnapprove(invoice)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Bỏ duyệt</TooltipContent>
                        </Tooltip>
                      ) : null}

                      {/* Cập nhật */}
                      {canEditInvoice(invoice.status) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-blue-100 text-blue-600 hover:bg-blue-200"
                              onClick={() => onEdit(invoice)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Cập nhật</TooltipContent>
                        </Tooltip>
                      )}

                      {/* Thu tiền */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full bg-green-100 text-green-600 hover:bg-green-200"
                            onClick={() => onRecordPayment(invoice)}
                          >
                            <DollarSign className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Thu tiền</TooltipContent>
                      </Tooltip>

                      {/* Lịch sử chỉnh sửa - TODO */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
                            onClick={() => {
                              if (onViewHistory) {
                                onViewHistory(invoice);
                              } else {
                                showTodo('Lịch sử chỉnh sửa');
                              }
                            }}
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Lịch sử chỉnh sửa</TooltipContent>
                      </Tooltip>

                      {/* Xoá */}
                      {canDeleteInvoice(invoice.status) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-red-100 text-red-600 hover:bg-red-200"
                              onClick={() => onDelete(invoice)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Xoá</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>

                  {/* Hoá đơn */}
                  <TableCell>
                    <div className="text-sm font-medium">{getInvoiceTitle(invoice)}</div>
                    <div className="text-xs text-muted-foreground">
                      Kỳ: {invoice.billing_month ?? '—'}
                    </div>
                  </TableCell>

                  {/* Khách hàng */}
                  <TableCell>
                    <div className="text-sm font-medium">{customerName}</div>
                    {locationCode && (
                      <div className="text-xs text-muted-foreground">{locationCode}</div>
                    )}
                  </TableCell>

                  {/* Tiền thuê */}
                  <TableCell className="text-right text-sm">
                    {formatCurrency(rentAmount)}
                  </TableCell>

                  {/* Tiền dịch vụ */}
                  <TableCell className="text-right text-sm">
                    {formatCurrency(serviceAmount)}
                  </TableCell>

                  {/* Tổng tiền */}
                  <TableCell className="text-right text-sm font-medium">
                    {formatCurrency(invoice.total_amount || 0)}
                  </TableCell>

                  {/* Đã thanh toán */}
                  <TableCell className="text-right text-sm text-green-600">
                    <span>{formatCurrency(invoice.paid_amount || 0)}</span>
                    {(invoice.paid_amount || 0) > 0 && (
                      <button
                        className="ml-1 text-blue-500 hover:underline text-xs"
                        onClick={() => onViewDetail(invoice)}
                      >
                        (Xem)
                      </button>
                    )}
                  </TableCell>

                  {/* Còn nợ */}
                  <TableCell
                    className={`text-right text-sm ${remaining > 0 ? 'text-orange-600 font-medium' : 'text-muted-foreground'}`}
                  >
                    {formatCurrency(remaining)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
};

export default InvoiceListTable;
