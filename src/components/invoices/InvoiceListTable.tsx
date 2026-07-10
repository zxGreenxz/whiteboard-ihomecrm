import { useMemo, useState } from 'react';
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
  Pencil,
  DollarSign,
  History,
  Trash2,
  Eye,
  RotateCcw,
} from 'lucide-react';
import type { InvoiceWithRelations, InvoiceItem } from '@/types/invoice';
import { canEditInvoice, canDeleteInvoice, getInvoiceTitle } from '@/lib/invoiceUtils';
import type { InvoiceColumnVisibility } from './invoiceListColumns';

interface InvoiceListTableProps {
  invoices: InvoiceWithRelations[];
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (invoice: InvoiceWithRelations) => void;
  onDelete: (invoice: InvoiceWithRelations) => void;
  onRecordPayment: (invoice: InvoiceWithRelations) => void;
  onViewDetail: (invoice: InvoiceWithRelations) => void;
  onViewPayments?: (invoice: InvoiceWithRelations) => void;
  onViewHistory?: (invoice: InvoiceWithRelations) => void;
  /** Super admin: phục hồi HĐ đã huỷ. Chỉ render khi callback != undefined. */
  onRestore?: (invoice: InvoiceWithRelations) => void;
  /** Super admin: xoá HĐ ở mọi trạng thái (hard-delete payments + chuyển CANCELLED). */
  onForceCancel?: (invoice: InvoiceWithRelations) => void;
  columnVisibility: InvoiceColumnVisibility;
  /** Gate quyền — ẩn các nút action khi user không có quyền. */
  canEdit?: boolean;
  canDelete?: boolean;
  canRecordPayment?: boolean;
  /** Super admin → mở rộng nút Xoá cho mọi HĐ (gọi onForceCancel). */
  isSuper?: boolean;
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

/**
 * Phân loại các invoice_items không phải RENT/DISCOUNT thành 4 nhóm:
 * Điện (desc chứa "điện"), Nước (desc chứa "nước"), Phạt (type PENALTY —
 * vd phí phạt thanh lý/bỏ cọc, tách khỏi PDV kẻo đọc nhầm thành phí dịch vụ
 * — B6, audit 03/07), PDV (còn lại).
 */
const splitServiceAmounts = (items: InvoiceItem[] | undefined) => {
  let electric = 0;
  let water = 0;
  let pdv = 0;
  let penalty = 0;
  if (!items) return { electric, water, pdv, penalty };
  for (const item of items) {
    if (item.type === 'RENT' || item.type === 'DISCOUNT') continue;
    if (item.type === 'PENALTY') {
      penalty += item.amount || 0;
      continue;
    }
    const desc = (item.description || '').toLowerCase();
    if (desc.includes('điện')) {
      electric += item.amount || 0;
    } else if (desc.includes('nước')) {
      water += item.amount || 0;
    } else {
      pdv += item.amount || 0;
    }
  }
  return { electric, water, pdv, penalty };
};

const InvoiceListTable = ({
  invoices,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onEdit,
  onDelete,
  onRecordPayment,
  onViewDetail,
  onViewPayments,
  onViewHistory,
  onRestore,
  onForceCancel,
  columnVisibility,
  canEdit = true,
  canDelete = true,
  canRecordPayment = true,
  isSuper = false,
}: InvoiceListTableProps) => {
  const { toast } = useToast();
  // Double-click header "Đã thanh toán" → đưa các HĐ tô vàng (TK kèm TM/TT)
  // lên đầu danh sách. Double-click lần nữa để tắt.
  const [mixedToTop, setMixedToTop] = useState(false);
  const selectableInvoices = invoices.filter((inv) => (inv.paid_amount ?? 0) === 0);

  // Set hoá đơn có TK đi kèm TM hoặc TT (cả TM+TK, TT+TK, hoặc TM+TT+TK)
  // → tô vàng nhẹ cell "Đã thanh toán". Mix mà KHÔNG có TK (ví dụ TM+TT)
  // thì không cảnh báo.
  // Tính TRỰC TIẾP từ invoice.payments đã nạp sẵn trong danh sách
  // (INVOICE_LIST_SELECT đã embed payments.payment_method) → BỎ query payments
  // thứ 2 từng bắn mỗi lần render bảng, đua tài nguyên với query chính.
  const mixedInvoiceIds = useMemo(() => {
    const mixed = new Set<string>();
    for (const inv of invoices) {
      const methods = new Set(
        ((inv as any).payments ?? []).map((p: { payment_method?: string }) => p.payment_method),
      );
      if (methods.has('TK') && (methods.has('TM') || methods.has('TT'))) {
        mixed.add(inv.id);
      }
    }
    return mixed;
  }, [invoices]);

  const displayInvoices = useMemo(() => {
    if (!mixedToTop || !mixedInvoiceIds || mixedInvoiceIds.size === 0) return invoices;
    // Stable partition: yellow ones first, giữ nguyên thứ tự gốc trong mỗi nhóm.
    const top: typeof invoices = [];
    const rest: typeof invoices = [];
    for (const inv of invoices) {
      (mixedInvoiceIds.has(inv.id) ? top : rest).push(inv);
    }
    return [...top, ...rest];
  }, [mixedToTop, mixedInvoiceIds, invoices]);
  const isAllSelected =
    selectableInvoices.length > 0 && selectedIds.length === selectableInvoices.length;

  const showTodo = (feature: string) => {
    toast({ title: 'Tính năng đang phát triển', description: feature });
  };

  const v = columnVisibility;
  const visibleColCount =
    3 /* checkbox + thao tác + hoá đơn */ +
    Number(v.tien_thue) +
    Number(v.dien) +
    Number(v.nuoc) +
    Number(v.pdv) +
    Number(v.giam_tru) +
    Number(v.tong_tien) +
    Number(v.da_thanh_toan) +
    Number(v.con_no) +
    Number(v.no_cong_don) +
    Number(v.han_tt) +
    Number(v.nguoi_tao);

  return (
    <TooltipProvider>
      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={onToggleSelectAll}
                disabled={selectableInvoices.length === 0}
                aria-label="Chọn tất cả hoá đơn chưa thu tiền"
              />
            </TableHead>
            <TableHead className="w-[200px]">Thao tác</TableHead>
            <TableHead>Hoá đơn</TableHead>
            {v.tien_thue && <TableHead className="text-right">Tiền thuê</TableHead>}
            {v.dien && <TableHead className="text-right">Điện</TableHead>}
            {v.nuoc && <TableHead className="text-right">Nước</TableHead>}
            {v.pdv && <TableHead className="text-right">PDV</TableHead>}
            {v.giam_tru && <TableHead className="text-right">Giảm trừ</TableHead>}
            {v.tong_tien && <TableHead className="text-right">Tổng tiền</TableHead>}
            {v.da_thanh_toan && (
              <TableHead
                className={`text-right select-none cursor-pointer ${
                  mixedToTop ? 'text-yellow-700' : ''
                }`}
                onDoubleClick={() => setMixedToTop((v) => !v)}
                title="Nhấp đúp để đưa các hoá đơn TK + TM/TT (tô vàng) lên đầu"
              >
                Đã thanh toán{mixedToTop ? ' ▼' : ''}
              </TableHead>
            )}
            {v.con_no && <TableHead className="text-right">Còn nợ</TableHead>}
            {v.no_cong_don && <TableHead className="text-right">Nợ cộng dồn</TableHead>}
            {v.han_tt && <TableHead>Hạn TT</TableHead>}
            {v.nguoi_tao && <TableHead>Người tạo</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayInvoices.length === 0 ? (
            <TableRow>
              <TableCell colSpan={visibleColCount} className="h-24 text-center text-muted-foreground">
                Không có hoá đơn nào
              </TableCell>
            </TableRow>
          ) : (
            displayInvoices.map((invoice) => {
              const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
              const isSelectable = (invoice.paid_amount ?? 0) === 0;
              const isFullyPaid =
                (invoice.total_amount || 0) > 0 &&
                (invoice.paid_amount || 0) >= (invoice.total_amount || 0);
              const rentAmount = sumByType(invoice.invoice_items, ['RENT']);
              const { electric, water, pdv, penalty } = splitServiceAmounts(invoice.invoice_items);

              // Tô nền dòng theo trạng thái thanh toán:
              //  - PAID (kể cả đã làm tròn) → xanh nhạt
              //  - CANCELLED → bỏ qua (đã có line-through riêng)
              //  - còn lại (APPROVED / PARTIAL_PAID / OVERDUE) → đỏ nhạt
              // Cell-level vàng nhạt ở "Đã thanh toán" (TK+TM/TT mix) vẫn ưu tiên
              // do là background của <td>, ghi đè bg của <tr>.
              const rowBgClass =
                invoice.status === 'CANCELLED'
                  ? ''
                  : invoice.status === 'PAID'
                    ? 'bg-emerald-50/60 hover:bg-emerald-50'
                    : 'bg-rose-50/60 hover:bg-rose-50';

              return (
                <TableRow key={invoice.id} className={rowBgClass}>
                  {/* Checkbox */}
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(invoice.id)}
                      onCheckedChange={() => onToggleSelect(invoice.id)}
                      disabled={!isSelectable}
                      aria-label={`Chọn hoá đơn ${invoice.invoice_number}`}
                    />
                  </TableCell>

                  {/* Thao tác - inline icon buttons */}
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {/* Xem chi tiết */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 hover:bg-emerald-200"
                            onClick={() => onViewDetail(invoice)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Xem chi tiết</TooltipContent>
                      </Tooltip>

                      {/* Cập nhật */}
                      {canEdit && canEditInvoice(invoice) && (
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

                      {/* Thu tiền — ẩn khi đã thu đủ hoặc không có quyền */}
                      {canRecordPayment && !isFullyPaid && (
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
                      )}

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
                      {canDelete && canDeleteInvoice(invoice, { isSuper }) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-red-100 text-red-600 hover:bg-red-200"
                              onClick={() => {
                                // Super admin: với HĐ vượt quy tắc thường (đã thu/quá hạn)
                                // dùng force-cancel flow; với HĐ DRAFT/APPROVED chưa thu thì
                                // vẫn dùng force-cancel để thống nhất ("đã xoá" = "đã huỷ").
                                if (isSuper && onForceCancel) {
                                  onForceCancel(invoice);
                                } else {
                                  onDelete(invoice);
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isSuper ? 'Xoá hoá đơn (chuyển sang Đã huỷ)' : 'Xoá'}
                          </TooltipContent>
                        </Tooltip>
                      )}

                      {/* Phục hồi — chỉ super admin, chỉ với HĐ đã huỷ */}
                      {onRestore && invoice.status === 'CANCELLED' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200"
                              onClick={() => onRestore(invoice)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Phục hồi hoá đơn</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>

                  {/* Hoá đơn */}
                  <TableCell>
                    <div className="text-sm font-medium flex items-center gap-2">
                      <span className={invoice.status === 'CANCELLED' ? 'line-through text-zinc-500' : ''}>
                        {getInvoiceTitle(invoice)}
                      </span>
                      {invoice.status === 'CANCELLED' && (
                        <span className="inline-flex items-center rounded-full bg-black px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                          Đã huỷ
                        </span>
                      )}
                    </div>
                  </TableCell>

                  {/* Tiền thuê */}
                  {v.tien_thue && (
                    <TableCell className="text-right text-sm">
                      {formatCurrency(rentAmount)}
                    </TableCell>
                  )}

                  {/* Điện — tô đỏ nếu chỉ số đầu bị sửa tay */}
                  {v.dien && (
                    <TableCell
                      className={
                        invoice.electricity_prev_overridden
                          ? 'text-right text-sm bg-red-100 text-red-700 font-semibold'
                          : 'text-right text-sm'
                      }
                      title={
                        invoice.electricity_prev_overridden
                          ? 'Chỉ số điện đầu của HĐ này được NV sửa tay'
                          : undefined
                      }
                    >
                      {electric > 0 ? formatCurrency(electric) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )}

                  {/* Nước */}
                  {v.nuoc && (
                    <TableCell className="text-right text-sm">
                      {water > 0 ? formatCurrency(water) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )}

                  {/* PDV (phí dịch vụ khác) — tiền PHẠT (thanh lý/bỏ cọc) hiện dòng riêng
                      có nhãn thay vì dồn chung vào PDV (B6, audit 03/07) */}
                  {v.pdv && (
                    <TableCell className="text-right text-sm">
                      {pdv > 0 ? formatCurrency(pdv) : penalty > 0 ? null : <span className="text-muted-foreground">—</span>}
                      {penalty > 0 && (
                        <div className="text-xs text-amber-700 whitespace-nowrap">
                          Phạt: {formatCurrency(penalty)}
                        </div>
                      )}
                    </TableCell>
                  )}

                  {/* Giảm trừ — discount_amount: dương = giảm, âm = bổ sung; notes hiển thị tooltip */}
                  {v.giam_tru && (
                    <TableCell className="text-right text-sm relative">
                      <div className="relative inline-block pr-3">
                        {(() => {
                          const d = Number(invoice.discount_amount || 0);
                          if (d > 0) return <span className="text-rose-600">{`(${formatCurrency(d)})`}</span>;
                          if (d < 0) return <span className="text-emerald-600">{`+${formatCurrency(Math.abs(d))}`}</span>;
                          return <span className="text-muted-foreground">{formatCurrency(0)}</span>;
                        })()}
                        {(() => {
                          const dn = invoice.discount_notes?.trim();
                          const note = dn || invoice.notes;
                          if (!note) return null;
                          return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  aria-label="Ghi chú giảm trừ"
                                  className="absolute top-0 right-0 h-0 w-0 border-t-[6px] border-l-[6px] border-t-red-500 border-l-transparent cursor-help"
                                />
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs whitespace-pre-line text-left">
                                {note}
                              </TooltipContent>
                            </Tooltip>
                          );
                        })()}
                      </div>
                    </TableCell>
                  )}

                  {/* Tổng tiền */}
                  {v.tong_tien && (
                    <TableCell className="text-right text-sm font-medium">
                      {formatCurrency(invoice.total_amount || 0)}
                    </TableCell>
                  )}

                  {/* Đã thanh toán */}
                  {v.da_thanh_toan && (
                    <TableCell
                      className={`text-right text-sm text-green-600 ${
                        mixedInvoiceIds?.has(invoice.id) ? 'bg-yellow-50' : ''
                      }`}
                      title={
                        mixedInvoiceIds?.has(invoice.id)
                          ? 'Có TK kèm TM/TT — đối soát sổ quỹ kỹ'
                          : undefined
                      }
                    >
                      <span>{formatCurrency(invoice.paid_amount || 0)}</span>
                      {(invoice.paid_amount || 0) > 0 && (
                        <button
                          className="ml-1 text-blue-500 hover:underline text-xs"
                          onClick={() =>
                            onViewPayments ? onViewPayments(invoice) : onViewDetail(invoice)
                          }
                        >
                          (Xem)
                        </button>
                      )}
                    </TableCell>
                  )}

                  {/* Còn nợ */}
                  {v.con_no && (
                    <TableCell
                      className={`text-right text-sm ${remaining > 0 ? 'text-orange-600 font-medium' : 'text-muted-foreground'}`}
                    >
                      {formatCurrency(remaining)}
                    </TableCell>
                  )}

                  {/* Nợ cộng dồn — sau migration nợ cũ:
                     total_amount đã bao gồm previous_debt → remaining_amount
                     chính là tổng còn nợ (kỳ này + nợ cũ kéo sang).
                     Hiển thị bằng `remaining` để tránh double count. */}
                  {v.no_cong_don && (
                    <TableCell
                      className={`text-right text-sm ${
                        remaining > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'
                      }`}
                    >
                      {formatCurrency(remaining)}
                    </TableCell>
                  )}

                  {/* Hạn TT + sub-line "Còn N ngày" / "Quá hạn N ngày" */}
                  {v.han_tt && (
                    <TableCell className="text-sm">
                      <DueCell dueDate={invoice.due_date} status={invoice.status} />
                    </TableCell>
                  )}

                  {/* Người tạo */}
                  {v.nguoi_tao && (
                    <TableCell className="text-sm text-muted-foreground">
                      {invoice.creator_name || '—'}
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
};

/**
 * Hạn TT cell — show date + "Còn N ngày" or "Quá hạn N ngày" indicator,
 * matching Resident's invoice list layout.
 */
function DueCell({ dueDate, status }: { dueDate: string | null; status: string }) {
  if (!dueDate) return <span className="text-muted-foreground">—</span>;
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  const dateStr = due.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let sub: React.ReactNode = null;
  if (status === 'PAID') {
    sub = <span className="text-xs text-emerald-600">Đã thanh toán</span>;
  } else if (diffDays < 0) {
    sub = <span className="text-xs text-red-600 font-medium">Quá hạn {Math.abs(diffDays)} ngày</span>;
  } else if (diffDays === 0) {
    sub = <span className="text-xs text-amber-600 font-medium">Hết hạn hôm nay</span>;
  } else if (diffDays <= 14) {
    sub = <span className="text-xs text-amber-600">Còn {diffDays} ngày</span>;
  }

  return (
    <div className="flex flex-col leading-tight">
      <span>{dateStr}</span>
      {sub}
    </div>
  );
}

export default InvoiceListTable;
