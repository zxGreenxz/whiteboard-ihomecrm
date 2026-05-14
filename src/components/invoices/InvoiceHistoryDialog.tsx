import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FileText,
  Package,
  Wallet,
  Plus,
  Pencil,
  Trash2,
  User,
} from 'lucide-react';
import {
  useInvoiceHistory,
  type AuditEntity,
  type AuditAction,
  type InvoiceAuditEntry,
} from '@/hooks/useInvoiceHistory';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const DATE_FIELDS = new Set([
  'due_date',
  'issue_date',
  'paid_date',
  'from_date',
  'to_date',
  'payment_date',
  'approved_at',
  'created_at',
  'updated_at',
  'deleted_at',
]);

const MONEY_FIELDS = new Set([
  'subtotal',
  'discount_amount',
  'tax_amount',
  'total_amount',
  'prepaid_amount',
  'paid_amount',
  'remaining_amount',
  'previous_debt',
  'unit_price',
  'amount',
]);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Nháp',
  APPROVED: 'Đã duyệt',
  PAID: 'Đã thanh toán',
  PARTIAL_PAID: 'Thanh toán một phần',
  OVERDUE: 'Quá hạn',
  CANCELLED: 'Đã huỷ',
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  RENT: 'Tiền thuê',
  SERVICE: 'Dịch vụ',
  PENALTY: 'Phạt',
  DISCOUNT: 'Chiết khấu',
  OTHER: 'Khác',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  TM: 'Tiền mặt',
  TK: 'Chuyển khoản',
  TT: 'Thanh toán',
};

const FIELD_LABELS: Record<string, string> = {
  // invoice
  status: 'Trạng thái',
  due_date: 'Hạn TT',
  issue_date: 'Ngày phát hành',
  paid_date: 'Ngày TT',
  billing_month: 'Tháng tính phí',
  subtotal: 'Tạm tính',
  discount_amount: 'Chiết khấu',
  tax_percent: 'Thuế (%)',
  tax_amount: 'Tiền thuế',
  total_amount: 'Tổng tiền',
  prepaid_amount: 'Đã ứng trước',
  previous_debt: 'Nợ kỳ trước',
  notes: 'Ghi chú',
  approved_at: 'Phê duyệt lúc',
  approved_by: 'Người phê duyệt',
  deleted_at: 'Xoá lúc',
  invoice_number: 'Số HĐ',
  template_id: 'Mẫu',
  // invoice_items
  description: 'Mô tả',
  unit_price: 'Đơn giá',
  quantity: 'SL',
  coefficient: 'Hệ số',
  amount: 'Thành tiền',
  type: 'Loại',
  previous_reading: 'Chỉ số đầu',
  current_reading: 'Chỉ số cuối',
  from_date: 'Từ ngày',
  to_date: 'Đến ngày',
  sort_order: 'Thứ tự',
  // payments
  payment_method: 'Phương thức',
  payment_date: 'Ngày TT',
  receipt_image_url: 'Ảnh chứng từ',
  receipt_number: 'Số phiếu',
};

const formatValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'status' && typeof value === 'string') {
    return STATUS_LABEL[value] ?? value;
  }
  if (field === 'type' && typeof value === 'string') {
    return ITEM_TYPE_LABEL[value] ?? value;
  }
  if (field === 'payment_method' && typeof value === 'string') {
    return PAYMENT_METHOD_LABEL[value] ?? value;
  }
  if (MONEY_FIELDS.has(field)) {
    const n = Number(value);
    if (!Number.isNaN(n)) return fmtVND(n);
  }
  if (DATE_FIELDS.has(field) && typeof value === 'string') {
    try {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return field.endsWith('_at')
          ? format(d, 'dd/MM/yyyy HH:mm')
          : format(d, 'dd/MM/yyyy');
      }
    } catch {
      /* fall through */
    }
  }
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (typeof value === 'number') return value.toLocaleString('vi-VN');
  return String(value);
};

const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;

const ENTITY_META: Record<
  AuditEntity,
  { label: string; icon: typeof FileText; tint: string }
> = {
  invoice: { label: 'Hoá đơn', icon: FileText, tint: 'text-blue-600 bg-blue-50' },
  item: { label: 'Mục', icon: Package, tint: 'text-violet-600 bg-violet-50' },
  payment: {
    label: 'Thanh toán',
    icon: Wallet,
    tint: 'text-emerald-600 bg-emerald-50',
  },
};

const ACTION_META: Record<
  AuditAction,
  { label: string; icon: typeof Plus; className: string }
> = {
  INSERT: {
    label: 'Tạo mới',
    icon: Plus,
    className: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  UPDATE: {
    label: 'Cập nhật',
    icon: Pencil,
    className: 'text-blue-700 bg-blue-50 border-blue-200',
  },
  DELETE: {
    label: 'Xoá',
    icon: Trash2,
    className: 'text-red-700 bg-red-50 border-red-200',
  },
};

const summarizeEntity = (entry: InvoiceAuditEntry): string => {
  const data = entry.after ?? entry.before ?? {};
  if (entry.entity === 'item') {
    const desc = (data.description as string) ?? '';
    const type = ITEM_TYPE_LABEL[(data.type as string) ?? ''] ?? data.type ?? '';
    return [type, desc].filter(Boolean).join(' · ') || 'Mục hoá đơn';
  }
  if (entry.entity === 'payment') {
    const amt = Number(data.amount ?? 0);
    const method =
      PAYMENT_METHOD_LABEL[(data.payment_method as string) ?? ''] ??
      data.payment_method ??
      '';
    return [fmtVND(amt), method].filter(Boolean).join(' · ');
  }
  return 'Hoá đơn';
};

const InvoiceHistoryDialog = ({ open, onOpenChange, invoice }: Props) => {
  const { data: entries, isLoading } = useInvoiceHistory(invoice?.id ?? null, open);

  if (!invoice) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Lịch sử chỉnh sửa</DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground -mt-2">
          Hoá đơn:{' '}
          <span className="font-medium text-foreground">
            {invoice.invoice_number}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !entries || entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Chưa có lịch sử chỉnh sửa.
            </p>
          ) : (
            <ol className="relative border-l border-zinc-200 ml-3 space-y-3">
              {entries.map((e) => {
                const entityMeta = ENTITY_META[e.entity];
                const actionMeta = ACTION_META[e.action];
                const EntityIcon = entityMeta.icon;
                const ActionIcon = actionMeta.icon;
                const dt = new Date(e.created_at);
                const dtStr = Number.isNaN(dt.getTime())
                  ? '—'
                  : format(dt, 'dd/MM/yyyy HH:mm');

                return (
                  <li key={e.id} className="ml-4">
                    <span
                      className={`absolute -left-3 mt-1 h-6 w-6 rounded-full grid place-items-center ring-4 ring-white ${entityMeta.tint}`}
                    >
                      <EntityIcon className="h-3 w-3" />
                    </span>
                    <div className="rounded-lg border border-zinc-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 text-sm">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${actionMeta.className}`}
                          >
                            <ActionIcon className="h-3 w-3" />
                            {actionMeta.label}
                          </span>
                          <span className="font-medium">
                            {entityMeta.label}
                          </span>
                          <span className="text-muted-foreground">
                            · {summarizeEntity(e)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-3">
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {e.actor_name ?? 'Hệ thống'}
                          </span>
                          <span>{dtStr}</span>
                        </div>
                      </div>

                      {e.action === 'UPDATE' &&
                        e.changed_fields &&
                        e.changed_fields.length > 0 && (
                          <div className="mt-2 rounded border border-zinc-200 overflow-hidden">
                            <table className="w-full text-xs">
                              <thead className="bg-zinc-50 text-zinc-600">
                                <tr>
                                  <th className="text-left px-2 py-1 font-medium w-32">
                                    Trường
                                  </th>
                                  <th className="text-left px-2 py-1 font-medium">
                                    Trước
                                  </th>
                                  <th className="text-left px-2 py-1 font-medium">
                                    Sau
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-100">
                                {e.changed_fields.map((f) => (
                                  <tr key={f}>
                                    <td className="px-2 py-1 font-medium text-zinc-700">
                                      {fieldLabel(f)}
                                    </td>
                                    <td className="px-2 py-1 text-red-600 line-through">
                                      {formatValue(
                                        f,
                                        (e.before ?? {})[f] ?? null,
                                      )}
                                    </td>
                                    <td className="px-2 py-1 text-emerald-700">
                                      {formatValue(
                                        f,
                                        (e.after ?? {})[f] ?? null,
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceHistoryDialog;
