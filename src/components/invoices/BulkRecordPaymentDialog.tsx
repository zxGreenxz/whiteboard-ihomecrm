import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  Wallet,
  Download,
  Loader2,
  Eye,
  EyeOff,
  Image as ImageIcon,
  X,
  CheckCircle,
  AlertCircle,
  Pencil,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuildings } from '@/hooks/useBuildings';
import { useAccounts } from '@/hooks/useAccounts';
import { changeAccountOptions, ownChangeAccountName } from '@/lib/changeAccounts';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import {
  useBulkRecordPayment,
  type BulkPaymentItem,
  type BulkPaymentFailure,
} from '@/hooks/useBulkRecordPayment';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { useInvoice } from '@/hooks/useInvoices';
import { canEditInvoice } from '@/lib/invoiceUtils';
import type { InvoiceStatus } from '@/types/invoice';
import EditInvoiceDialog from './EditInvoiceDialog';
import PaymentsSummaryDialog from './PaymentsSummaryDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface RowData {
  invoice_id: string;
  invoice_number: string;
  room_id: string;
  room_name: string;
  customer_name: string;
  total_amount: number;
  paid_amount: number;
  remaining: number;
  status: InvoiceStatus;

  selected: boolean;
  amount_tm: number;
  amount_tk: number;
  amount_tt: number;
  change_amount: number;
  change_user_edited: boolean;
  keep_as_credit: boolean;

  receipt_image: File | null;
  receipt_preview_url: string | null;

  notes: string;

  account_id_override: string | null;
  change_account_id_override: string | null;

  error?: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

export default function BulkRecordPaymentDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  // enabled: open — dialog mounted sẵn (đóng) không fetch accounts/buildings.
  const { data: buildings } = useBuildings({ enabled: open });
  const { data: accounts = [] } = useAccounts({ enabled: open });
  const { data: authUser } = useAuth();
  const currentUserId = authUser?.id ?? null;
  const bulkMutation = useBulkRecordPayment();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [paymentDate, setPaymentDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showAccountColumns, setShowAccountColumns] = useState(false);

  const [headerAccountId, setHeaderAccountId] = useState('');
  const [headerAccountUserEdited, setHeaderAccountUserEdited] = useState(false);
  const [headerChangeAccountId, setHeaderChangeAccountId] = useState('');
  const [headerChangeAccountUserEdited, setHeaderChangeAccountUserEdited] = useState(false);

  const [rows, setRows] = useState<RowData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failures, setFailures] = useState<BulkPaymentFailure[]>([]);
  const [editInvoiceId, setEditInvoiceId] = useState<string | null>(null);
  const [viewPaymentsInvoiceId, setViewPaymentsInvoiceId] = useState<string | null>(null);

  const { data: editingInvoice } = useInvoice(editInvoiceId ?? undefined);
  const { data: viewingPaymentsInvoice } = useInvoice(
    viewPaymentsInvoiceId ?? undefined,
  );

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ─── Auto-detect sổ quỹ nhận khi đổi toà ───
  const buildingName = useMemo(
    () => (buildings ?? []).find((b: any) => b.id === buildingId)?.name?.trim() ?? '',
    [buildings, buildingId],
  );

  useEffect(() => {
    if (headerAccountUserEdited) return;
    if (!buildingName || !accounts.length) {
      setHeaderAccountId('');
      return;
    }
    const matched = (accounts as any[]).find(
      (a) => a.name?.trim() === buildingName,
    );
    if (matched) {
      setHeaderAccountId(matched.id);
    } else {
      setHeaderAccountId('');
      // Không tìm được → tự bật cột để user chọn
      setShowAccountColumns(true);
    }
  }, [buildingName, accounts, headerAccountUserEdited]);

  // ─── Auto-detect sổ quỹ thối theo user: Hiển→Hiển Thối, Hiệp→Hiệp Thối ───
  useEffect(() => {
    if (headerChangeAccountUserEdited) return;
    if (!accounts.length || !currentUserId) return;
    const ownName = ownChangeAccountName(currentUserId);
    if (!ownName) return;
    const target = (accounts as any[]).find(
      (a) => (a.name ?? '').trim() === ownName,
    );
    if (target) setHeaderChangeAccountId(target.id);
  }, [accounts, currentUserId, headerChangeAccountUserEdited]);

  const headerAccountName = useMemo(
    () => (accounts as any[]).find((a) => a.id === headerAccountId)?.name ?? '',
    [accounts, headerAccountId],
  );
  const headerChangeAccountName = useMemo(
    () => (accounts as any[]).find((a) => a.id === headerChangeAccountId)?.name ?? '',
    [accounts, headerChangeAccountId],
  );

  // Sổ quỹ "Làm tròn tiền thiếu" — audit cho rounding < 10K (FE tự
  // detect khi submit, không cần UI riêng).
  const roundingAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (accounts as any[]).find(
      (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';
  }, [accounts]);

  const handleLoad = async () => {
    if (!buildingId) return;
    setLoaded(false);
    setFailures([]);
    try {
      const { data, error } = await (supabase as any)
        .from('invoices')
        .select(
          `id, invoice_number, building_id, room_id, status,
           total_amount, paid_amount, remaining_amount, billing_month,
           room:rooms!invoices_room_id_fkey(id, name),
           contract:contracts!invoices_contract_id_fkey(
             id,
             contract_customers!contract_customers_contract_id_fkey(
               is_representative,
               customer:customers(full_name)
             )
           )`,
        )
        .eq('building_id', buildingId)
        .eq('billing_month', billingMonth)
        .in('status', ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'])
        .gt('remaining_amount', 0)
        .is('deleted_at', null);
      if (error) throw error;

      const next: RowData[] = (data || [])
        .map((inv: any) => {
          const total = Number(inv.total_amount) || 0;
          const paid = Number(inv.paid_amount) || 0;
          const remaining =
            Number(inv.remaining_amount) || Math.max(0, total - paid);
          const cc = inv.contract?.contract_customers ?? [];
          const rep =
            cc.find((x: any) => x.is_representative)?.customer?.full_name ??
            cc[0]?.customer?.full_name ??
            '—';
          return {
            invoice_id: inv.id,
            invoice_number: inv.invoice_number ?? '',
            room_id: inv.room_id,
            room_name: inv.room?.name ?? '?',
            customer_name: rep,
            total_amount: total,
            paid_amount: paid,
            remaining,
            status: (inv.status ?? 'APPROVED') as InvoiceStatus,
            selected: remaining > 0,
            amount_tm: 0,
            amount_tk: 0,
            amount_tt: 0,
            change_amount: 0,
            change_user_edited: false,
            keep_as_credit: false,
            receipt_image: null,
            receipt_preview_url: null,
            notes: '',
            account_id_override: null,
            change_account_id_override: null,
          } as RowData;
        })
        .sort((a: RowData, b: RowData) =>
          a.room_name.localeCompare(b.room_name, 'vi', { numeric: true }),
        );
      setRows(next);
      setLoaded(true);
    } catch (err: any) {
      console.error(err);
      toast({
        variant: 'destructive',
        title: 'Lỗi tải dữ liệu',
        description: err.message || 'Không tải được danh sách hoá đơn',
      });
    }
  };

  const updateRow = (idx: number, patch: Partial<RowData>) => {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx], ...patch };

      // Auto-recompute change_amount nếu user chưa override
      const sumChanged =
        'amount_tm' in patch || 'amount_tk' in patch || 'amount_tt' in patch;
      if (sumChanged && !row.change_user_edited) {
        const total = row.amount_tm + row.amount_tk + row.amount_tt;
        row.change_amount = Math.max(0, total - row.remaining);
      }
      // Reset error khi user thao tác
      if ('amount_tm' in patch || 'amount_tk' in patch || 'amount_tt' in patch || 'change_amount' in patch) {
        row.error = undefined;
      }
      next[idx] = row;
      return next;
    });
  };

  const handleFileSelect = (idx: number, file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ variant: 'destructive', title: 'Chỉ chấp nhận file ảnh' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ variant: 'destructive', title: 'File quá 5MB' });
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      if (row.receipt_preview_url) URL.revokeObjectURL(row.receipt_preview_url);
      next[idx] = { ...row, receipt_image: file, receipt_preview_url: previewUrl };
      return next;
    });
  };

  const handleRemoveImage = (idx: number) => {
    setRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      if (row.receipt_preview_url) URL.revokeObjectURL(row.receipt_preview_url);
      next[idx] = { ...row, receipt_image: null, receipt_preview_url: null };
      return next;
    });
    const ref = fileInputRefs.current[rows[idx]?.invoice_id];
    if (ref) ref.value = '';
  };

  const totals = useMemo(() => {
    let count = 0;
    let tm = 0;
    let tk = 0;
    let tt = 0;
    let change = 0;
    for (const r of rows) {
      if (!r.selected) continue;
      const hasMoney = r.amount_tm + r.amount_tk + r.amount_tt + r.change_amount > 0;
      if (!hasMoney) continue;
      count += 1;
      tm += r.amount_tm;
      tk += r.amount_tk;
      tt += r.amount_tt;
      change += r.change_amount;
    }
    return { count, tm, tk, tt, change, net: tm + tk + tt - change };
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const toggleAll = () =>
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));

  const handleClose = () => {
    if (submitting) return;
    rows.forEach((r) => {
      if (r.receipt_preview_url) URL.revokeObjectURL(r.receipt_preview_url);
    });
    setRows([]);
    setLoaded(false);
    setFailures([]);
    setHeaderAccountUserEdited(false);
    setHeaderChangeAccountUserEdited(false);
    setShowAccountColumns(false);
    onOpenChange(false);
  };

  const validateBeforeSubmit = (): boolean => {
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: 'Chưa chọn phòng nào' });
      return false;
    }
    let bad = false;
    setRows((prev) =>
      prev.map((r) => {
        if (!r.selected) return r;
        const sum = r.amount_tm + r.amount_tk + r.amount_tt;
        const net = sum - r.change_amount;
        if (
          r.amount_tm < 0 ||
          r.amount_tk < 0 ||
          r.amount_tt < 0 ||
          r.change_amount < 0
        ) {
          bad = true;
          return { ...r, error: 'Số tiền không hợp lệ' };
        }
        if (net > r.remaining) {
          bad = true;
          return {
            ...r,
            error: `Tiền nhận thực (${fmt(net)}đ) > Còn lại (${fmt(r.remaining)}đ). Nhập tiền thối nếu khách trả dư.`,
          };
        }
        return { ...r, error: undefined };
      }),
    );
    if (bad) {
      toast({
        variant: 'destructive',
        title: 'Có dòng nhập sai',
        description: 'Vui lòng kiểm tra lại các dòng được đánh dấu đỏ',
      });
      return false;
    }

    // Cần sổ quỹ nhận
    const needsAccount = selected.some((r) => {
      const accountId = r.account_id_override ?? headerAccountId;
      const sum = r.amount_tm + r.amount_tk + r.amount_tt;
      return sum > 0 && !accountId;
    });
    if (needsAccount) {
      toast({
        variant: 'destructive',
        title: 'Thiếu sổ quỹ nhận',
        description: 'Vui lòng chọn sổ quỹ nhận (chung hoặc từng dòng)',
      });
      setShowAccountColumns(true);
      return false;
    }

    // Cần sổ quỹ thối (chỉ khi không giữ làm credit)
    const needsChangeAccount = selected.some((r) => {
      const ca = r.change_account_id_override ?? headerChangeAccountId;
      return r.change_amount > 0 && !r.keep_as_credit && !ca;
    });
    if (needsChangeAccount) {
      toast({
        variant: 'destructive',
        title: 'Thiếu sổ quỹ tiền thối',
        description: 'Có dòng có tiền thối nhưng chưa chọn sổ quỹ thối',
      });
      setShowAccountColumns(true);
      return false;
    }
    return true;
  };

  const uploadReceipt = async (file: File): Promise<string | null> => {
    const user = await getSessionUser();
    if (!user) return null;
    const fileExt = file.name.split('.').pop();
    const fileName = `${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}_receipt.${fileExt}`;

    const { error } = await supabase.storage
      .from('payment-receipts')
      .upload(fileName, file, { cacheControl: '3600', upsert: false });
    if (error) {
      const { error: fallbackErr } = await supabase.storage
        .from('documents')
        .upload(`receipts/${fileName}`, file, {
          cacheControl: '3600',
          upsert: false,
        });
      if (fallbackErr) {
        console.error('Upload error:', fallbackErr);
        return null;
      }
      const { data: urlData } = supabase.storage
        .from('documents')
        .getPublicUrl(`receipts/${fileName}`);
      return urlData.publicUrl;
    }
    const { data: urlData } = supabase.storage
      .from('payment-receipts')
      .getPublicUrl(fileName);
    return urlData.publicUrl;
  };

  const handleSubmit = async () => {
    if (!validateBeforeSubmit()) return;
    const selected = rows.filter(
      (r) =>
        r.selected &&
        r.amount_tm + r.amount_tk + r.amount_tt + r.change_amount > 0,
    );
    if (selected.length === 0) return;

    setSubmitting(true);
    setFailures([]);
    try {
      // Upload tất cả ảnh song song để nhanh
      const uploads = await Promise.all(
        selected.map(async (r) => {
          if (!r.receipt_image) return { invoice_id: r.invoice_id, url: null };
          try {
            const url = await uploadReceipt(r.receipt_image);
            return { invoice_id: r.invoice_id, url };
          } catch (err) {
            console.error('Upload failed for', r.room_name, err);
            return { invoice_id: r.invoice_id, url: null };
          }
        }),
      );
      const urlMap = new Map(uploads.map((u) => [u.invoice_id, u.url]));

      const items: BulkPaymentItem[] = selected.map((r) => {
        // Làm tròn tự động: residual sau payment > 0 và < 10K → đính rounding
        // metadata vào voucher cuối; trigger DB tự mark invoice PAID.
        const sumThisRow = r.amount_tm + r.amount_tk + r.amount_tt;
        const netThisRow = sumThisRow - r.change_amount;
        const residualAfter = r.remaining - netThisRow;
        const willRoundRow =
          residualAfter > 0 && residualAfter < 10000 && netThisRow > 0;
        return {
          invoice_id: r.invoice_id,
          invoice_number: r.invoice_number,
          room_name: r.room_name,
          amount_tm: r.amount_tm,
          amount_tk: r.amount_tk,
          amount_tt: r.amount_tt,
          change_amount: r.change_amount,
          account_id: r.account_id_override ?? headerAccountId,
          change_account_id:
            r.change_amount > 0 && !r.keep_as_credit
              ? (r.change_account_id_override ?? headerChangeAccountId)
              : null,
          keep_as_credit: r.keep_as_credit && r.change_amount > 0,
          receipt_image_url: urlMap.get(r.invoice_id) ?? null,
          notes: r.notes || undefined,
          rounding_amount: willRoundRow ? residualAfter : 0,
          rounding_account_id:
            willRoundRow && roundingAccountId ? roundingAccountId : null,
        };
      });

      const result = await bulkMutation.mutateAsync({
        payment_date: paymentDate,
        items,
      });

      if (result.failures.length === 0) {
        handleClose();
      } else {
        // Giữ dialog mở, hiển thị lỗi từng dòng + bỏ chọn các row đã ok
        const okSet = new Set(result.ok);
        const failMap = new Map(result.failures.map((f) => [f.invoice_id, f.message]));
        setRows((prev) =>
          prev.map((r) => {
            if (okSet.has(r.invoice_id)) {
              return { ...r, selected: false, error: undefined };
            }
            const failMsg = failMap.get(r.invoice_id);
            if (failMsg) return { ...r, error: failMsg };
            return r;
          }),
        );
        setFailures(result.failures);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-[1700px] max-h-[92vh] overflow-hidden flex flex-col"
        style={{ width: 'calc(100vw - 32px)' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-green-600" />
            Thanh toán hàng loạt — Mode Excel
          </DialogTitle>
          <DialogDescription>
            Chọn toà & kỳ → Tải dữ liệu → Nhập số tiền TM/TT/TK/Thối cho từng phòng → Bấm "Ghi nhận".
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-3 py-2">
          <div className="space-y-1 col-span-2">
            <Label>Toà nhà *</Label>
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà..." />
              </SelectTrigger>
              <SelectContent>
                {(buildings ?? []).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Kỳ thanh toán *</Label>
            <Input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Ngày thanh toán</Label>
            <DateInput value={paymentDate} onChange={setPaymentDate} />
          </div>
          <div className="space-y-1">
            <Label>&nbsp;</Label>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setShowAccountColumns((v) => !v)}
            >
              {showAccountColumns ? (
                <>
                  <EyeOff className="h-4 w-4 mr-2" />
                  Ẩn sổ quỹ
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4 mr-2" />
                  Hiện sổ quỹ
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Button onClick={handleLoad} disabled={!buildingId || submitting}>
            <Download className="h-4 w-4 mr-2" />
            Tải dữ liệu
          </Button>
          {loaded && (
            <span className="text-sm text-muted-foreground">
              Đã tải {rows.length} hoá đơn còn nợ
            </span>
          )}
          <span className="ml-auto text-sm text-muted-foreground">
            Mặc định nhận:{' '}
            <span className="font-medium text-foreground">
              {headerAccountName || '— chưa chọn —'}
            </span>
            {' · '}
            Mặc định thối:{' '}
            <span className="font-medium text-foreground">
              {headerChangeAccountName || '— chưa chọn —'}
            </span>
          </span>
        </div>

        {showAccountColumns && (
          <div className="grid grid-cols-2 gap-3 pb-2">
            <div className="space-y-1">
              <Label>Sổ quỹ nhận chung *</Label>
              <Select
                value={headerAccountId}
                onValueChange={(v) => {
                  setHeaderAccountId(v);
                  setHeaderAccountUserEdited(true);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn sổ quỹ nhận tiền..." />
                </SelectTrigger>
                <SelectContent>
                  {(accounts as any[]).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.bank_name ? ` — ${a.bank_name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Sổ quỹ tiền thối chung</Label>
              <Select
                value={headerChangeAccountId}
                onValueChange={(v) => {
                  setHeaderChangeAccountId(v);
                  setHeaderChangeAccountUserEdited(true);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn sổ quỹ chi tiền thối..." />
                </SelectTrigger>
                <SelectContent>
                  {changeAccountOptions(accounts as any[], currentUserId).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.bank_name ? ` — ${a.bank_name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-xs uppercase">
                <th className="p-2 border w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </th>
                <th className="p-2 border text-left">Phòng</th>
                <th className="p-2 border text-left">Khách</th>
                <th className="p-2 border text-right">Tổng</th>
                <th className="p-2 border text-right">Đã trả</th>
                <th className="p-2 border text-right bg-orange-50">Còn lại</th>
                <th className="p-2 border text-right w-[120px]">TM</th>
                <th className="p-2 border text-right w-[120px]">TT</th>
                <th className="p-2 border text-right w-[120px]">TK</th>
                <th className="p-2 border text-right w-[120px] bg-amber-50">
                  Tiền thối
                </th>
                {showAccountColumns && (
                  <>
                    <th className="p-2 border text-left w-[160px]">Sổ quỹ nhận</th>
                    <th className="p-2 border text-left w-[160px]">Sổ quỹ thối</th>
                  </>
                )}
                <th className="p-2 border text-center w-[80px]">Ảnh</th>
                <th className="p-2 border text-left w-[180px]">Ghi chú</th>
                <th className="p-2 border text-center w-[140px]">TT sau</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={showAccountColumns ? 15 : 13}
                    className="text-center p-8 text-muted-foreground"
                  >
                    {loaded
                      ? 'Toà này không có hoá đơn cần thu trong kỳ này.'
                      : 'Chưa tải dữ liệu.'}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const sum = r.amount_tm + r.amount_tk + r.amount_tt;
                const net = sum - r.change_amount;
                const newPaid = r.paid_amount + net;
                const residualAfter = r.total_amount - newPaid;
                const willRound =
                  residualAfter > 0 && residualAfter < 10000 && net > 0;
                const willBePaid =
                  net > 0 && (newPaid >= r.total_amount || willRound);
                const willBePartial =
                  newPaid > 0 && newPaid < r.total_amount && !willRound;
                const noChange = net === 0;
                return (
                  <tr
                    key={r.invoice_id}
                    className={
                      r.error
                        ? 'bg-red-50'
                        : r.selected
                          ? ''
                          : 'opacity-50'
                    }
                  >
                    <td className="p-1 border text-center">
                      <Checkbox
                        checked={r.selected}
                        onCheckedChange={(v) => updateRow(i, { selected: !!v })}
                      />
                    </td>
                    <td className="p-1 border font-medium">
                      <div className="flex items-center justify-between gap-1">
                        <span>{r.room_name}</span>
                        {canEditInvoice(r) ? (
                          <button
                            type="button"
                            title="Sửa hoá đơn"
                            className="text-slate-400 hover:text-blue-600 p-0.5 rounded"
                            onClick={() => setEditInvoiceId(r.invoice_id)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span
                            title="Hoá đơn đã có thanh toán — không thể sửa"
                            className="text-slate-300 p-0.5 cursor-not-allowed"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-1 border text-xs">{r.customer_name}</td>
                    <td className="p-1 border text-right text-slate-600">
                      {fmt(r.total_amount)}
                    </td>
                    <td className="p-1 border text-right text-green-600">
                      <span>{fmt(r.paid_amount)}</span>
                      {r.paid_amount > 0 && (
                        <button
                          type="button"
                          className="ml-1 text-blue-500 hover:underline text-xs"
                          onClick={() => setViewPaymentsInvoiceId(r.invoice_id)}
                        >
                          (Xem)
                        </button>
                      )}
                    </td>
                    <td className="p-1 border text-right font-semibold text-orange-600 bg-orange-50">
                      {fmt(r.remaining)}
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="text"
                        inputMode="numeric"
                        value={formatVN(r.amount_tm)}
                        onChange={(e) =>
                          updateRow(i, { amount_tm: parseVN(e.target.value) })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="text"
                        inputMode="numeric"
                        value={formatVN(r.amount_tt)}
                        onChange={(e) =>
                          updateRow(i, { amount_tt: parseVN(e.target.value) })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-right"
                        type="text"
                        inputMode="numeric"
                        value={formatVN(r.amount_tk)}
                        onChange={(e) =>
                          updateRow(i, { amount_tk: parseVN(e.target.value) })
                        }
                      />
                    </td>
                    <td className="p-1 border bg-amber-50">
                      <Input
                        className="h-7 text-right"
                        type="text"
                        inputMode="numeric"
                        value={formatVN(r.change_amount)}
                        onChange={(e) =>
                          updateRow(i, {
                            change_amount: parseVN(e.target.value),
                            change_user_edited: true,
                          })
                        }
                      />
                      <label
                        className={`flex items-center gap-1 mt-1 text-[10px] cursor-pointer leading-tight ${
                          r.change_amount > 0 ? 'text-blue-700' : 'text-muted-foreground opacity-50'
                        }`}
                        title="Tick: giữ tiền thối làm credit (trừ kỳ sau), không tạo phiếu chi thối"
                      >
                        <Checkbox
                          className="h-3 w-3"
                          checked={r.keep_as_credit}
                          disabled={r.change_amount <= 0}
                          onCheckedChange={(v) =>
                            updateRow(i, { keep_as_credit: !!v })
                          }
                        />
                        Nợ kỳ sau
                      </label>
                    </td>
                    {showAccountColumns && (
                      <>
                        <td className="p-1 border">
                          <Select
                            value={r.account_id_override ?? headerAccountId}
                            onValueChange={(v) =>
                              updateRow(i, { account_id_override: v })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              {(accounts as any[]).map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-1 border">
                          <Select
                            value={
                              r.change_account_id_override ?? headerChangeAccountId
                            }
                            onValueChange={(v) =>
                              updateRow(i, { change_account_id_override: v })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              {changeAccountOptions(accounts as any[], currentUserId).map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      </>
                    )}
                    <BulkPaymentImageCell
                      previewUrl={r.receipt_preview_url}
                      onFile={(file) => handleFileSelect(i, file)}
                      onRemove={() => handleRemoveImage(i)}
                      registerInputRef={(el) => {
                        fileInputRefs.current[r.invoice_id] = el;
                      }}
                    />
                    <td className="p-1 border">
                      <Input
                        className="h-7 text-xs"
                        type="text"
                        value={r.notes}
                        placeholder="Ghi chú"
                        onChange={(e) => updateRow(i, { notes: e.target.value })}
                      />
                    </td>
                    <td className="p-1 border text-center text-xs">
                      {r.error ? (
                        <span
                          className="inline-flex items-center gap-1 text-red-600"
                          title={r.error}
                        >
                          <AlertCircle className="h-3.5 w-3.5" />
                          Lỗi
                        </span>
                      ) : noChange ? (
                        <span className="text-slate-400">—</span>
                      ) : willBePaid ? (
                        <span
                          className="inline-flex items-center gap-1 text-green-600"
                          title={
                            willRound
                              ? `Làm tròn thiếu ${fmt(residualAfter)}đ`
                              : undefined
                          }
                        >
                          <CheckCircle className="h-3.5 w-3.5" />
                          {willRound ? 'Đủ (làm tròn)' : 'Đủ'}
                        </span>
                      ) : willBePartial ? (
                        <span className="text-amber-600">Một phần</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100">
                <tr className="font-semibold text-xs">
                  <td colSpan={6} className="p-2 border text-right">
                    {totals.count} hoá đơn —
                  </td>
                  <td className="p-2 border text-right">{fmt(totals.tm)}</td>
                  <td className="p-2 border text-right">{fmt(totals.tt)}</td>
                  <td className="p-2 border text-right">{fmt(totals.tk)}</td>
                  <td className="p-2 border text-right bg-amber-50">
                    {fmt(totals.change)}
                  </td>
                  {showAccountColumns && <td colSpan={2} className="p-2 border" />}
                  <td colSpan={3} className="p-2 border text-right text-green-700">
                    Nhận thực: {fmt(totals.net)}đ
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {failures.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-md p-2 max-h-24 overflow-auto text-xs space-y-1">
            <div className="font-semibold text-red-700">
              {failures.length} hoá đơn lỗi:
            </div>
            {failures.map((f) => (
              <div key={f.invoice_id} className="text-red-700">
                • {f.room_name || f.invoice_number}: {f.message}
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Huỷ
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || totals.count === 0}
            className="bg-green-600 hover:bg-green-700"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang ghi nhận...
              </>
            ) : (
              <>Ghi nhận {totals.count} thanh toán</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      {editingInvoice && (
        <EditInvoiceDialog
          open={editInvoiceId != null}
          onOpenChange={(v) => {
            if (!v) {
              const wasOpen = editInvoiceId != null;
              setEditInvoiceId(null);
              // Reload toàn bộ bảng để cell phản ánh dữ liệu HĐ vừa sửa
              if (wasOpen && buildingId) handleLoad();
            }
          }}
          invoice={editingInvoice}
        />
      )}

      <PaymentsSummaryDialog
        open={viewPaymentsInvoiceId != null && !!viewingPaymentsInvoice}
        onOpenChange={(v) => {
          if (!v) {
            const wasOpen = viewPaymentsInvoiceId != null;
            setViewPaymentsInvoiceId(null);
            // Reload bảng để paid_amount/còn lại phản ánh các phiếu vừa
            // xoá trong PaymentsSummaryDialog.
            if (wasOpen && buildingId) handleLoad();
          }
        }}
        invoice={viewingPaymentsInvoice ?? null}
      />
    </Dialog>
  );
}

interface BulkPaymentImageCellProps {
  previewUrl: string | null;
  onFile: (file: File | null) => void;
  onRemove: () => void;
  registerInputRef: (el: HTMLInputElement | null) => void;
}

function BulkPaymentImageCell({
  previewUrl,
  onFile,
  onRemove,
  registerInputRef,
}: BulkPaymentImageCellProps) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => onFile(files[0] ?? null),
    enabled: !previewUrl,
  });

  return (
    <td
      className="p-1 border text-center"
      title={previewUrl ? undefined : 'Hover rồi Ctrl+V để dán ảnh'}
      {...pasteHandlers}
    >
      {previewUrl ? (
        <div className="relative inline-block">
          <img
            src={previewUrl}
            alt="receipt"
            className="h-8 w-8 object-cover rounded border"
          />
          <button
            type="button"
            className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full h-4 w-4 flex items-center justify-center"
            onClick={onRemove}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ) : (
        <>
          <input
            ref={(el) => {
              localRef.current = el;
              registerInputRef(el);
            }}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => localRef.current?.click()}
          >
            <ImageIcon className="h-4 w-4" />
          </Button>
        </>
      )}
    </td>
  );
}
