import { useMemo } from 'react';
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
  Receipt,
  Coins,
  Plus,
  Pencil,
  Trash2,
  User,
  CheckCircle2,
  Ban,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import {
  useInvoiceHistory,
  type AuditEntity,
  type InvoiceAuditEntry,
} from '@/hooks/useInvoiceHistory';
import { useAccounts } from '@/hooks/useAccounts';
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
  'voucher_date',
  'approved_at',
  'verified_at',
  'created_at',
  'updated_at',
  'deleted_at',
]);

const MONEY_FIELDS = new Set([
  'subtotal',
  'discount_amount',
  'total_amount',
  'prepaid_amount',
  'paid_amount',
  'remaining_amount',
  'previous_debt',
  'unit_price',
  'amount',
  'change_amount',
  'rounding_amount',
]);

const ACCOUNT_FIELDS = new Set([
  'account_id',
  'change_account_id',
  'rounding_account_id',
]);

const PERSON_FIELDS = new Set(['approved_by', 'verified_by']);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Nháp',
  APPROVED: 'Đã duyệt',
  PAID: 'Đã thanh toán',
  PARTIAL_PAID: 'Thanh toán một phần',
  OVERDUE: 'Quá hạn',
  CANCELLED: 'Đã huỷ',
};

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  CANCELLED: 'Đã huỷ',
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  RENT: 'Tiền thuê',
  SERVICE: 'Dịch vụ',
  PENALTY: 'Phạt',
  DISCOUNT: 'Chiết khấu',
  OTHER: 'Khác',
};

// Whitelist trường hiển thị trong bảng diff — trường đổi mà không có nhãn
// (id kỹ thuật, cột dẫn xuất…) chỉ đếm gộp "+N trường kỹ thuật".
const FIELD_LABELS: Record<string, string> = {
  // invoice
  status: 'Trạng thái',
  due_date: 'Hạn TT',
  issue_date: 'Ngày phát hành',
  paid_date: 'Ngày TT',
  billing_month: 'Tháng tính phí',
  subtotal: 'Tạm tính',
  discount_amount: 'Chiết khấu',
  discount_notes: 'Ghi chú giảm trừ',
  total_amount: 'Tổng tiền',
  prepaid_amount: 'Đã ứng trước',
  paid_amount: 'Đã thanh toán',
  previous_debt: 'Nợ kỳ trước',
  previous_debt_sources: 'Nguồn nợ kỳ trước',
  electricity_prev_overridden: 'Ghi đè chỉ số đầu',
  notes: 'Ghi chú',
  approved_at: 'Phê duyệt lúc',
  approved_by: 'Người phê duyệt',
  deleted_at: 'Xoá lúc',
  invoice_number: 'Số HĐ',
  // invoice_items
  description: 'Mô tả',
  unit_price: 'Đơn giá',
  quantity: 'SL',
  coefficient: 'Hệ số',
  amount: 'Số tiền',
  type: 'Loại',
  previous_reading: 'Chỉ số đầu',
  current_reading: 'Chỉ số cuối',
  from_date: 'Từ ngày',
  to_date: 'Đến ngày',
  // payments
  payment_method: 'Phương thức',
  payment_date: 'Ngày TT',
  receipt_image_url: 'Ảnh chứng từ',
  receipt_number: 'Số phiếu',
  // phiếu thu/chi (income_expenses)
  code: 'Mã phiếu',
  name: 'Tên phiếu',
  voucher_date: 'Ngày phiếu',
  approval_status: 'Trạng thái phiếu',
  account_id: 'Sổ quỹ',
  payer_name: 'Người nộp/nhận',
  change_amount: 'Tiền thối',
  change_account_id: 'Sổ tiền thối',
  rounding_amount: 'Làm tròn',
  rounding_account_id: 'Sổ làm tròn',
  attachments: 'Chứng từ',
  verified_at: 'Đối soát lúc',
  verified_by: 'Người đối soát',
  verified_note: 'Ghi chú đối soát',
};

interface FormatCtx {
  accounts: Map<string, string>;
  entry: InvoiceAuditEntry;
}

const shortId = (v: string) => `${v.slice(0, 8)}…`;

const formatValue = (field: string, value: unknown, ctx: FormatCtx): string => {
  if (value === null || value === undefined || value === '') return '—';
  const { entry, accounts } = ctx;
  if (field === 'status' && typeof value === 'string') {
    return STATUS_LABEL[value] ?? value;
  }
  if (field === 'approval_status' && typeof value === 'string') {
    return APPROVAL_STATUS_LABEL[value] ?? value;
  }
  if (field === 'type' && typeof value === 'string') {
    if (entry.entity === 'receipt') {
      return value === 'EXPENSE' ? 'Chi' : 'Thu';
    }
    return ITEM_TYPE_LABEL[value] ?? value;
  }
  if (field === 'billing_month' && typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})$/.exec(value);
    if (m) return `${m[2]}/${m[1]}`;
  }
  if (ACCOUNT_FIELDS.has(field) && typeof value === 'string') {
    return accounts.get(value) ?? shortId(value);
  }
  if (PERSON_FIELDS.has(field) && typeof value === 'string') {
    if (entry.actor_id && value === entry.actor_id && entry.actor_name) {
      return entry.actor_name;
    }
    return shortId(value);
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
  if (Array.isArray(value)) {
    if (field === 'previous_debt_sources') return `${value.length} nguồn nợ`;
    if (field === 'attachments') return `${value.length} tệp`;
    return `${value.length} mục`;
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  }
  return String(value);
};

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
  receipt: {
    label: 'Phiếu thu/chi',
    icon: Receipt,
    tint: 'text-teal-600 bg-teal-50',
  },
  excess: {
    label: 'Nợ khách (credit)',
    icon: Coins,
    tint: 'text-amber-600 bg-amber-50',
  },
};

type Tone =
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'cancel'
  | 'restore'
  | 'status';

const TONE_META: Record<Tone, { icon: typeof Plus; className: string }> = {
  create: { icon: Plus, className: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  update: { icon: Pencil, className: 'text-blue-700 bg-blue-50 border-blue-200' },
  delete: { icon: Trash2, className: 'text-red-700 bg-red-50 border-red-200' },
  approve: { icon: CheckCircle2, className: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  cancel: { icon: Ban, className: 'text-orange-700 bg-orange-50 border-orange-200' },
  restore: { icon: RotateCcw, className: 'text-teal-700 bg-teal-50 border-teal-200' },
  status: { icon: RefreshCw, className: 'text-zinc-700 bg-zinc-50 border-zinc-200' },
};

interface DerivedEvent {
  title: string;
  tone: Tone;
  /** Điểm chọn sự kiện chính của một phiên thao tác (cao = đại diện). */
  score: number;
  /** Dòng tóm tắt giá trị chính (hiện cạnh tiêu đề). */
  summary: string | null;
  /** Trường hiển thị dạng "Nhãn: giá trị" cho INSERT/DELETE. */
  snapshotFields: string[];
}

const has = (e: InvoiceAuditEntry, f: string) =>
  !!e.changed_fields && e.changed_fields.includes(f);

const val = (
  data: Record<string, unknown> | null,
  f: string,
): unknown => (data ? data[f] : undefined);

const deriveEvent = (e: InvoiceAuditEntry): DerivedEvent => {
  const b = e.before;
  const a = e.after;
  const data = a ?? b ?? {};

  if (e.entity === 'invoice') {
    if (e.action === 'INSERT') {
      return {
        title: 'Tạo hoá đơn',
        tone: 'create',
        score: 100,
        summary: null,
        snapshotFields: ['billing_month', 'total_amount', 'status', 'due_date'],
      };
    }
    if (e.action === 'DELETE') {
      return {
        title: 'Xoá vĩnh viễn hoá đơn',
        tone: 'delete',
        score: 95,
        summary: null,
        snapshotFields: ['billing_month', 'total_amount', 'status'],
      };
    }
    if (has(e, 'deleted_at')) {
      return val(a, 'deleted_at')
        ? { title: 'Xoá hoá đơn', tone: 'delete', score: 85, summary: null, snapshotFields: [] }
        : { title: 'Khôi phục hoá đơn', tone: 'restore', score: 85, summary: null, snapshotFields: [] };
    }
    if (has(e, 'status')) {
      const from = String(val(b, 'status') ?? '');
      const to = String(val(a, 'status') ?? '');
      if (to === 'APPROVED' && from === 'DRAFT') {
        return { title: 'Duyệt hoá đơn', tone: 'approve', score: 80, summary: null, snapshotFields: [] };
      }
      if (to === 'DRAFT' && from === 'APPROVED') {
        return { title: 'Huỷ duyệt hoá đơn', tone: 'cancel', score: 80, summary: null, snapshotFields: [] };
      }
      if (to === 'CANCELLED') {
        return { title: 'Huỷ hoá đơn', tone: 'cancel', score: 80, summary: null, snapshotFields: [] };
      }
      if (from === 'CANCELLED') {
        return { title: 'Khôi phục hoá đơn', tone: 'restore', score: 80, summary: null, snapshotFields: [] };
      }
      // PAID / PARTIAL_PAID / OVERDUE — thường là hệ quả tự động của thu tiền.
      return {
        title: `Chuyển trạng thái: ${STATUS_LABEL[to] ?? to}`,
        tone: 'status',
        score: 30,
        summary: null,
        snapshotFields: [],
      };
    }
    return { title: 'Sửa hoá đơn', tone: 'update', score: 70, summary: null, snapshotFields: [] };
  }

  if (e.entity === 'receipt') {
    const kind = val(data as Record<string, unknown>, 'type') === 'EXPENSE' ? 'phiếu chi' : 'phiếu thu';
    const code = (val(data as Record<string, unknown>, 'code') as string) ?? '';
    const amt = Number(val(data as Record<string, unknown>, 'total_amount') ?? 0);
    const summary = [code, fmtVND(amt)].filter(Boolean).join(' · ');
    if (e.action === 'INSERT') {
      return {
        title: `Lập ${kind}`,
        tone: 'create',
        score: 90,
        summary,
        snapshotFields: ['total_amount', 'account_id', 'payer_name', 'voucher_date'],
      };
    }
    if (e.action === 'DELETE') {
      return {
        title: `Xoá vĩnh viễn ${kind}`,
        tone: 'delete',
        score: 76,
        summary,
        snapshotFields: ['total_amount', 'account_id', 'approval_status'],
      };
    }
    if (has(e, 'deleted_at')) {
      return val(a, 'deleted_at')
        ? { title: `Xoá ${kind}`, tone: 'delete', score: 75, summary, snapshotFields: [] }
        : { title: `Khôi phục ${kind}`, tone: 'restore', score: 75, summary, snapshotFields: [] };
    }
    if (has(e, 'approval_status')) {
      const to = String(val(a, 'approval_status') ?? '');
      if (to === 'CANCELLED') {
        return { title: `Huỷ ${kind}`, tone: 'cancel', score: 75, summary, snapshotFields: [] };
      }
      if (to === 'APPROVED') {
        return { title: `Duyệt ${kind}`, tone: 'approve', score: 75, summary, snapshotFields: [] };
      }
      return { title: `Huỷ duyệt ${kind}`, tone: 'cancel', score: 75, summary, snapshotFields: [] };
    }
    if (has(e, 'account_id')) {
      return { title: 'Chuyển sổ quỹ', tone: 'update', score: 65, summary, snapshotFields: [] };
    }
    return { title: `Sửa ${kind}`, tone: 'update', score: 60, summary, snapshotFields: [] };
  }

  if (e.entity === 'payment') {
    const amt = Number(val(data as Record<string, unknown>, 'amount') ?? 0);
    const method = (val(data as Record<string, unknown>, 'payment_method') as string) ?? '';
    const summary = [fmtVND(amt), method].filter(Boolean).join(' · ');
    if (e.action === 'INSERT') {
      return { title: 'Ghi nhận thanh toán', tone: 'create', score: 84, summary, snapshotFields: ['payment_date'] };
    }
    if (e.action === 'DELETE') {
      return { title: 'Gỡ thanh toán', tone: 'delete', score: 74, summary, snapshotFields: ['payment_date'] };
    }
    return { title: 'Sửa thanh toán', tone: 'update', score: 60, summary, snapshotFields: [] };
  }

  if (e.entity === 'excess') {
    const amt = Number(val(data as Record<string, unknown>, 'amount') ?? 0);
    const desc = (val(data as Record<string, unknown>, 'description') as string) ?? '';
    const summary = [fmtVND(amt), desc].filter(Boolean).join(' · ');
    if (e.action === 'INSERT') {
      return { title: 'Ghi nợ khách (credit)', tone: 'create', score: 50, summary, snapshotFields: [] };
    }
    if (e.action === 'DELETE') {
      return { title: 'Xoá nợ khách (credit)', tone: 'delete', score: 50, summary, snapshotFields: [] };
    }
    return { title: 'Sửa nợ khách (credit)', tone: 'update', score: 50, summary, snapshotFields: [] };
  }

  // item
  const desc = (val(data as Record<string, unknown>, 'description') as string) ?? '';
  const type = ITEM_TYPE_LABEL[(val(data as Record<string, unknown>, 'type') as string) ?? ''] ?? '';
  const amt = Number(val(data as Record<string, unknown>, 'amount') ?? 0);
  const summary = [[type, desc].filter(Boolean).join(' · ') || 'Mục hoá đơn', fmtVND(amt)].join(' · ');
  if (e.action === 'INSERT') {
    return { title: 'Thêm mục', tone: 'create', score: 40, summary, snapshotFields: [] };
  }
  if (e.action === 'DELETE') {
    return { title: 'Xoá mục', tone: 'delete', score: 40, summary, snapshotFields: [] };
  }
  return { title: 'Sửa mục', tone: 'update', score: 40, summary, snapshotFields: [] };
};

interface HistoryGroup {
  key: string;
  actorName: string | null;
  time: Date;
  entries: { entry: InvoiceAuditEntry; event: DerivedEvent }[];
}

/**
 * Gộp các bản ghi liên tiếp của cùng một người trong cửa sổ 5 giây thành một
 * "phiên thao tác": một lần sửa HĐ sinh 1 UPDATE + N xoá mục + M thêm mục
 * (3 câu lệnh, timestamp lệch nhau vài trăm ms) — hiển thị rời rạc rất khó đọc.
 */
const GROUP_WINDOW_MS = 5000;

const buildGroups = (entries: InvoiceAuditEntry[]): HistoryGroup[] => {
  const asc = [...entries].sort(
    (x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id),
  );
  const groups: (HistoryGroup & { lastMs: number; actorId: string | null })[] = [];
  for (const entry of asc) {
    const ms = new Date(entry.created_at).getTime();
    const last = groups[groups.length - 1];
    const item = { entry, event: deriveEvent(entry) };
    if (
      last &&
      (last.actorId ?? '') === (entry.actor_id ?? '') &&
      ms - last.lastMs <= GROUP_WINDOW_MS
    ) {
      last.entries.push(item);
      last.lastMs = ms;
    } else {
      groups.push({
        key: entry.id,
        actorId: entry.actor_id,
        actorName: entry.actor_name,
        time: new Date(entry.created_at),
        entries: [item],
        lastMs: ms,
      });
    }
  }
  // Trong một phiên: sự kiện đại diện (điểm cao) lên đầu, còn lại giữ thứ tự thời gian.
  for (const g of groups) {
    g.entries.sort(
      (x, y) =>
        y.event.score - x.event.score ||
        x.entry.created_at.localeCompare(y.entry.created_at) ||
        x.entry.id.localeCompare(y.entry.id),
    );
  }
  return groups.reverse();
};

const DiffTable = ({
  entry,
  ctx,
}: {
  entry: InvoiceAuditEntry;
  ctx: FormatCtx;
}) => {
  const fields = (entry.changed_fields ?? []).filter((f) => FIELD_LABELS[f]);
  const hidden = (entry.changed_fields ?? []).length - fields.length;
  if (fields.length === 0 && hidden === 0) return null;
  return (
    <div className="mt-1.5">
      {fields.length > 0 && (
        <div className="rounded border border-zinc-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 text-zinc-600">
              <tr>
                <th className="text-left px-2 py-1 font-medium w-32">Trường</th>
                <th className="text-left px-2 py-1 font-medium">Trước</th>
                <th className="text-left px-2 py-1 font-medium">Sau</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {fields.map((f) => (
                <tr key={f}>
                  <td className="px-2 py-1 font-medium text-zinc-700">
                    {FIELD_LABELS[f]}
                  </td>
                  <td className="px-2 py-1 text-red-600 line-through">
                    {formatValue(f, (entry.before ?? {})[f] ?? null, ctx)}
                  </td>
                  <td className="px-2 py-1 text-emerald-700">
                    {formatValue(f, (entry.after ?? {})[f] ?? null, ctx)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hidden > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          +{hidden} trường kỹ thuật khác
        </p>
      )}
    </div>
  );
};

const SnapshotLine = ({
  entry,
  event,
  ctx,
}: {
  entry: InvoiceAuditEntry;
  event: DerivedEvent;
  ctx: FormatCtx;
}) => {
  if (event.snapshotFields.length === 0) return null;
  const data = (entry.action === 'DELETE' ? entry.before : entry.after) ?? {};
  const parts = event.snapshotFields
    .map((f) => {
      const v = data[f];
      if (v === null || v === undefined || v === '') return null;
      return `${FIELD_LABELS[f] ?? f}: ${formatValue(f, v, ctx)}`;
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">{parts.join(' · ')}</p>
  );
};

const InvoiceHistoryDialog = ({ open, onOpenChange, invoice }: Props) => {
  const { data: entries, isLoading } = useInvoiceHistory(invoice?.id ?? null, open);
  const { data: accounts } = useAccounts({ enabled: open });

  const accountMap = useMemo(
    () => new Map((accounts ?? []).map((acc) => [acc.id, acc.name])),
    [accounts],
  );

  const groups = useMemo(
    () => (entries ? buildGroups(entries) : []),
    [entries],
  );

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
              {groups.map((g) => {
                const primary = g.entries[0];
                const primaryEntityMeta = ENTITY_META[primary.entry.entity] ?? ENTITY_META.invoice;
                const PrimaryIcon = primaryEntityMeta.icon;
                const dtStr = Number.isNaN(g.time.getTime())
                  ? '—'
                  : format(g.time, 'dd/MM/yyyy HH:mm');

                return (
                  <li key={g.key} className="ml-4">
                    <span
                      className={`absolute -left-3 mt-1 h-6 w-6 rounded-full grid place-items-center ring-4 ring-white ${primaryEntityMeta.tint}`}
                    >
                      <PrimaryIcon className="h-3 w-3" />
                    </span>
                    <div className="rounded-lg border border-zinc-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-sm">
                          <span className="font-medium">{primary.event.title}</span>
                          {primary.event.summary && (
                            <span className="text-muted-foreground">
                              {' '}· {primary.event.summary}
                            </span>
                          )}
                        </span>
                        <div className="text-xs text-muted-foreground flex items-center gap-3">
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {g.actorName ?? 'Hệ thống'}
                          </span>
                          <span>{dtStr}</span>
                        </div>
                      </div>

                      <div className="mt-1.5 space-y-2">
                        {g.entries.map(({ entry, event }, idx) => {
                          const toneMeta = TONE_META[event.tone];
                          const ToneIcon = toneMeta.icon;
                          const ctx: FormatCtx = { accounts: accountMap, entry };
                          return (
                            <div key={entry.id}>
                              {/* Sự kiện chính đã nằm trên header nhóm — không lặp chip. */}
                              {idx > 0 && (
                                <div className="flex items-center gap-2 text-xs flex-wrap">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${toneMeta.className}`}
                                  >
                                    <ToneIcon className="h-3 w-3" />
                                    {event.title}
                                  </span>
                                  {event.summary && (
                                    <span className="text-muted-foreground">
                                      {event.summary}
                                    </span>
                                  )}
                                </div>
                              )}
                              {entry.action === 'UPDATE' && (
                                <DiffTable entry={entry} ctx={ctx} />
                              )}
                              {entry.action !== 'UPDATE' && (
                                <SnapshotLine entry={entry} event={event} ctx={ctx} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground border-t pt-2">
          Lịch sử ghi từ 16/05/2026 (hoá đơn, mục, thanh toán) và từ 03/07/2026
          (phiếu thu/chi, nợ khách). Thao tác trước các mốc này không có dữ liệu.
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceHistoryDialog;
