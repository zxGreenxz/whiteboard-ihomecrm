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
import { useToast } from '@/hooks/use-toast';
import { useBuildings } from '@/hooks/useBuildings';
import { useAccounts } from '@/hooks/useAccounts';
import {
  missingReceivingBookMessage,
  receivingBooksFor,
  useReceivingCashbooks,
  type ReceivingBook,
} from '@/hooks/useReceivingCashbooks';
import { fetchRecentInvoiceCollections } from '@/hooks/useCollectionTenders';
import { changeAccountOptions, ownChangeAccountName } from '@/lib/changeAccounts';
import { collectionClock, findRecentDuplicateCollection } from '@/lib/duplicateCollection';
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
import { canOpenInvoiceEditor } from '@/lib/invoiceUtils';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { deriveOverpayPolicy, planCollect } from '@/lib/collectPlan';
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
  has_contract: boolean;

  selected: boolean;
  amount_tm: number;
  amount_tk: number;
  amount_tt: number;
  change_amount: number;
  change_user_edited: boolean;
  keep_as_credit: boolean;
  credit_user_edited: boolean;

  receipt_image: File | null;
  receipt_preview_url: string | null;

  notes: string;

  /** Sổ nhận CK/TT chọn riêng cho dòng (null = sổ chung ở đầu bảng). TM luôn là sổ tiền mặt riêng. */
  tk_account_override: string | null;
  tt_account_override: string | null;
  change_account_id_override: string | null;

  error?: string;
}

type BookMethod = 'TK' | 'TT';

/** Câu lỗi máy chủ (tiếng Việt), bỏ tiền tố máy-đọc kiểu [PROFIT_LOCKED]. */
const loiDoc = (error: unknown, fallback: string): string => {
  const msg = (error as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^\[[A-Z_]+\]\s*/, '') : fallback;
};

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
  const { data: permissions } = useMyPermissions();
  const canEditInvoicePerm = canUse(permissions, 'invoices', 'edit');

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [paymentDate, setPaymentDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [showAccountColumns, setShowAccountColumns] = useState(false);

  // Sổ CK/TT chung người thu chọn ở đầu bảng ('' = sổ mặc định của toà).
  const [headerBook, setHeaderBook] = useState<Record<BookMethod, string>>({ TK: '', TT: '' });
  const [headerChangeAccountId, setHeaderChangeAccountId] = useState('');
  const [headerChangeAccountUserEdited, setHeaderChangeAccountUserEdited] = useState(false);

  const [rows, setRows] = useState<RowData[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Toà của các dòng ĐÃ TẢI: sổ nhận đọc theo toà này, kể cả khi người dùng đổi ô
  // "Toà nhà" mà chưa bấm tải lại.
  const [loadedBuildingId, setLoadedBuildingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failures, setFailures] = useState<BulkPaymentFailure[]>([]);
  const [editInvoiceId, setEditInvoiceId] = useState<string | null>(null);
  const [viewPaymentsInvoiceId, setViewPaymentsInvoiceId] = useState<string | null>(null);
  // Thu trùng (đợt 1 sửa phiếu): các phòng vừa được thu cùng số tiền trong 30 phút.
  const [bulkDupAsk, setBulkDupAsk] = useState<{ lines: string[]; ackKey: string } | null>(null);
  const bulkDupAckRef = useRef<string | null>(null);

  const { data: editingInvoice } = useInvoice(editInvoiceId ?? undefined);
  const { data: viewingPaymentsInvoice } = useInvoice(
    viewPaymentsInvoiceId ?? undefined,
  );

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const submitAttemptsRef = useRef<Map<string, {
    fingerprint: string;
    idempotencyKey: string;
    receiptUrl: string | null;
  }>>(new Map());
  // ─── Toà đang chọn → tổ chức (lọc sổ thối / làm tròn cùng tổ chức) ───
  const selectedBuilding = useMemo(
    () => (buildings ?? []).find((building: any) => building.id === buildingId) ?? null,
    [buildings, buildingId],
  );
  const buildingOrganizationId = selectedBuilding?.organization_id ?? null;
  // Chỉ dùng sổ quỹ cùng tổ chức với toà đang chọn — tránh chọn nhầm sổ tenant khác.
  const organizationAccounts = useMemo(
    () =>
      (accounts as any[]).filter(
        (account) =>
          !buildingOrganizationId || account.organization_id === buildingOrganizationId,
      ),
    [accounts, buildingOrganizationId],
  );
  const virtualAccounts = useMemo(
    () => organizationAccounts.filter((account) => account.is_virtual === true),
    [organizationAccounts],
  );

  // ─── Sổ nhận tiền theo hình thức (máy chủ quyết — đợt 1 sửa phiếu 25/09/2026) ───
  // TM = sổ tiền mặt riêng của người đang thu; TK/TT = danh sách sổ của toà (mặc
  // định đứng đầu) giao với sổ người thu giữ/biết. Hình thức chưa có sổ ⇒ chặn
  // ghi nhận các dòng có tiền ở hình thức đó (không rơi về sổ trùng tên toà).
  const receivingBuildingId = (loaded && loadedBuildingId) || buildingId || null;
  const receivingBuilding = useMemo(
    () => (buildings ?? []).find((building) => building.id === receivingBuildingId) ?? null,
    [buildings, receivingBuildingId],
  );
  const receivingBuildingName = receivingBuilding?.name?.trim() || null;
  const receivingOrgId = receivingBuilding?.organization_id ?? null;
  const receiving = useReceivingCashbooks(
    open && receivingBuildingId ? receivingOrgId : null,
    receivingBuildingId,
  );
  const receivingData = receiving.data;
  const receivingError = receiving.isError
    ? loiDoc(receiving.error, 'Không tải được danh sách sổ nhận tiền.')
    : receivingBuilding && !receivingOrgId
      ? 'Chưa xác định được công ty của toà — tải lại trang rồi thử lại.'
      : null;
  const receivingLoading = !!receivingBuildingId && !receivingError && !receivingData;
  const tmBook = receivingData?.personalCashBook ?? null;
  const booksOf = (method: BookMethod): ReceivingBook[] => receivingBooksFor(receivingData, method);
  /** Sổ CK/TT chung: sổ người thu chọn ở đầu bảng nếu còn trong danh sách, không thì sổ mặc định. */
  const headerBookId = (method: BookMethod): string => {
    const list = booksOf(method);
    const picked = headerBook[method];
    return picked && list.some((b) => b.id === picked) ? picked : list[0]?.id ?? '';
  };
  /** Sổ CK/TT của một dòng: sổ chọn riêng (nếu hợp lệ) → sổ chung. '' = chưa có sổ. */
  const rowBookId = (r: RowData, method: BookMethod): string => {
    const own = method === 'TK' ? r.tk_account_override : r.tt_account_override;
    return own && booksOf(method).some((b) => b.id === own) ? own : headerBookId(method);
  };
  /** Sổ nhận của từng hình thức CÓ TIỀN trong dòng — gửi nguyên vào useBulkRecordPayment. */
  const accountsForRow = (r: RowData): Partial<Record<'TM' | 'TK' | 'TT', string>> => {
    const out: Partial<Record<'TM' | 'TK' | 'TT', string>> = {};
    if (r.amount_tm > 0 && tmBook) out.TM = tmBook.id;
    if (r.amount_tk > 0 && rowBookId(r, 'TK')) out.TK = rowBookId(r, 'TK');
    if (r.amount_tt > 0 && rowBookId(r, 'TT')) out.TT = rowBookId(r, 'TT');
    return out;
  };
  const bookName = (method: BookMethod, id: string) => booksOf(method).find((b) => b.id === id)?.name ?? '';

  // ─── Auto-detect sổ quỹ thối theo user: Hiển→Hiển Thối, Hiệp→Hiệp Thối ───
  useEffect(() => {
    if (headerChangeAccountUserEdited) return;
    if (!virtualAccounts.length || !currentUserId) return;
    const ownName = ownChangeAccountName(currentUserId);
    if (!ownName) return;
    const target = virtualAccounts.find(
      (a) => (a.name ?? '').trim() === ownName,
    );
    if (target) setHeaderChangeAccountId(target.id);
  }, [virtualAccounts, currentUserId, headerChangeAccountUserEdited]);

  // Đổi toà (→ đổi tổ chức) có thể làm sổ thối đã chọn không còn hợp lệ → reset
  // để fail-closed, buộc auto-detect/chọn lại theo danh sách sổ đã lọc.
  useEffect(() => {
    if (
      headerChangeAccountId &&
      !virtualAccounts.some((account) => account.id === headerChangeAccountId)
    ) {
      setHeaderChangeAccountId('');
      setHeaderChangeAccountUserEdited(false);
    }
  }, [headerChangeAccountId, virtualAccounts]);

  const headerChangeAccountName = useMemo(
    () => virtualAccounts.find((a) => a.id === headerChangeAccountId)?.name ?? '',
    [virtualAccounts, headerChangeAccountId],
  );

  // Sổ quỹ "Làm tròn tiền thiếu" — audit cho rounding < 10K (FE tự
  // detect khi submit, không cần UI riêng).
  const roundingAccountId = useMemo(() => {
    if (!virtualAccounts.length) return '';
    return virtualAccounts.find(
      (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';
  }, [virtualAccounts]);

  const handleLoad = async () => {
    if (!buildingId) return;
    setLoaded(false);
    setFailures([]);
    try {
      const { data, error } = await supabase
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
            has_contract: !!inv.contract?.id,
            selected: remaining > 0,
            amount_tm: 0,
            amount_tk: 0,
            amount_tt: 0,
            change_amount: 0,
            change_user_edited: false,
            keep_as_credit: false,
            credit_user_edited: false,
            receipt_image: null,
            receipt_preview_url: null,
            notes: '',
            tk_account_override: null,
            tt_account_override: null,
            change_account_id_override: null,
          } as RowData;
        })
        .sort((a: RowData, b: RowData) =>
          a.room_name.localeCompare(b.room_name, 'vi', { numeric: true }),
        );
      setRows(next);
      setLoadedBuildingId(buildingId);
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
      if (sumChanged || 'keep_as_credit' in patch) {
        const total = row.amount_tm + row.amount_tk + row.amount_tt;
        row.change_amount = Math.max(0, total - row.remaining);
        row.change_user_edited = false;
      }
      if (sumChanged) {
        const total = row.amount_tm + row.amount_tk + row.amount_tt;
        const policy = deriveOverpayPolicy({
          total,
          amountTm: row.amount_tm,
          remaining: row.remaining,
          hasContract: row.has_contract,
        });
        row.keep_as_credit = policy.mustKeepAsCredit
          || (policy.overpay > 0 && row.credit_user_edited && row.keep_as_credit);
        if (policy.overpay === 0) row.credit_user_edited = false;
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
    submitAttemptsRef.current.delete(rows[idx]?.invoice_id);
    setRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      if (row.receipt_preview_url) URL.revokeObjectURL(row.receipt_preview_url);
      next[idx] = { ...row, receipt_image: file, receipt_preview_url: previewUrl };
      return next;
    });
  };

  const handleRemoveImage = (idx: number) => {
    submitAttemptsRef.current.delete(rows[idx]?.invoice_id);
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
    setLoadedBuildingId(null);
    setFailures([]);
    setHeaderBook({ TK: '', TT: '' });
    setHeaderChangeAccountUserEdited(false);
    setShowAccountColumns(false);
    setBulkDupAsk(null);
    bulkDupAckRef.current = null;
    submitAttemptsRef.current.clear();
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
        const overpay = Math.max(sum - r.remaining, 0);
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
        const checked = planCollect({ lines: [{ method: 'TM', amount: r.amount_tm }, { method: 'TK', amount: r.amount_tk }, { method: 'TT', amount: r.amount_tt }],
          remaining: r.remaining, hasContract: r.has_contract, keepAsCredit: r.keep_as_credit,
          changeAmount: r.keep_as_credit ? undefined : r.change_amount });
        if (checked.ok === false) {
          bad = true;
          return { ...r, error: checked.error };
        }
        if (r.keep_as_credit && overpay > 0 && !r.has_contract) {
          bad = true;
          return { ...r, error: 'Hóa đơn không có hợp đồng nên không thể giữ credit.' };
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

    // Cần sổ nhận cho MỌI hình thức có tiền — trong danh sách máy chủ cho phép.
    if (receivingError) {
      toast({ variant: 'destructive', title: 'Không đọc được sổ nhận tiền', description: receivingError });
      return false;
    }
    if (!receivingData) {
      toast({ variant: 'destructive', title: 'Đang tải sổ nhận tiền', description: 'Thử lại sau giây lát.' });
      return false;
    }
    const thieuSo = new Set<string>();
    for (const r of selected) {
      if (r.amount_tm > 0 && !tmBook) thieuSo.add(missingReceivingBookMessage('TM'));
      if (r.amount_tk > 0 && !rowBookId(r, 'TK')) thieuSo.add(missingReceivingBookMessage('TK', receivingBuildingName));
      if (r.amount_tt > 0 && !rowBookId(r, 'TT')) thieuSo.add(missingReceivingBookMessage('TT', receivingBuildingName));
    }
    if (thieuSo.size > 0) {
      toast({
        variant: 'destructive',
        title: 'Thiếu sổ nhận tiền',
        description: [...thieuSo].join(' '),
      });
      setShowAccountColumns(true);
      return false;
    }

    // Cần sổ quỹ thối (chỉ khi không giữ làm credit)
    const needsChangeAccount = selected.some((r) => {
      const ca = r.change_account_id_override ?? headerChangeAccountId;
      return (
        r.change_amount > 0 &&
        !r.keep_as_credit &&
        (!ca || !virtualAccounts.some((account) => account.id === ca))
      );
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
      // KHÔNG fallback: bucket 'documents' không tồn tại trên production
      // (audit 02/09/2026) — nhánh fallback cũ chỉ che mờ lỗi thật.
      console.error('Upload error:', error);
      return null;
    }
    const { data: urlData } = supabase.storage
      .from('payment-receipts')
      .getPublicUrl(fileName);
    return urlData.publicUrl;
  };

  /** Vân tay nội dung một dòng — cùng vân tay ⇒ gọi lại dùng đúng idempotency key cũ. */
  const rowFingerprint = (r: RowData) => {
    const fileSignature = r.receipt_image
      ? `${r.receipt_image.name}:${r.receipt_image.size}:${r.receipt_image.type}:${r.receipt_image.lastModified}`
      : null;
    return JSON.stringify({
      paymentDate,
      invoice_id: r.invoice_id,
      amount_tm: r.amount_tm,
      amount_tk: r.amount_tk,
      amount_tt: r.amount_tt,
      change_amount: r.change_amount,
      keep_as_credit: r.keep_as_credit,
      accounts: accountsForRow(r),
      change_account_id: r.change_account_id_override ?? headerChangeAccountId,
      rounding_account_id: roundingAccountId || null,
      notes: r.notes.trim() || null,
      file: fileSignature,
    });
  };

  /**
   * Thu trùng (đợt 1 sửa phiếu): phòng nào vừa có khoản thu CÒN HIỆU LỰC cùng
   * tổng tiền trong 30 phút? Bỏ qua dòng đang gọi lại đúng lần gửi trước (cùng
   * idempotency key — máy chủ trả kết quả cũ, không ghi thêm). null = không trùng.
   */
  const findBulkDuplicates = async (selected: RowData[]): Promise<string[] | null> => {
    const toCheck = selected.filter(
      (r) => submitAttemptsRef.current.get(r.invoice_id)?.fingerprint !== rowFingerprint(r),
    );
    if (toCheck.length === 0) return null;
    try {
      const recent = await fetchRecentInvoiceCollections(toCheck.map((r) => r.invoice_id));
      const now = Date.now();
      const lines = toCheck.flatMap((r) => {
        const dup = findRecentDuplicateCollection(
          recent.filter((c) => c.invoice_id === r.invoice_id),
          r.amount_tm + r.amount_tk + r.amount_tt,
          now,
        );
        return dup
          ? [`${r.room_name}: ${fmt(dup.gross_amount)} đ lúc ${collectionClock(dup.created_at)} bởi ${dup.collector_name || 'một người khác'}`]
          : [];
      });
      return lines.length ? lines : null;
    } catch (error) {
      return [`Không kiểm tra được các khoản thu gần đây (${loiDoc(error, 'lỗi mạng')}).`];
    }
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
      const ackKey = JSON.stringify(selected.map(rowFingerprint));
      if (bulkDupAckRef.current !== ackKey) {
        const dupLines = await findBulkDuplicates(selected);
        if (dupLines) {
          setBulkDupAsk({ lines: dupLines, ackKey });
          return;
        }
      }

      // Giữ cả URL ảnh và idempotency key ổn định cho retry cùng payload.
      const preparedAttempts = await Promise.all(
        selected.map(async (r) => {
          const fingerprint = rowFingerprint(r);
          const cached = submitAttemptsRef.current.get(r.invoice_id);
          if (cached?.fingerprint === fingerprint) {
            return { invoice_id: r.invoice_id, ...cached };
          }

          let receiptUrl: string | null = null;
          if (r.receipt_image) {
            try {
              receiptUrl = await uploadReceipt(r.receipt_image);
            } catch (err) {
              console.error('Upload failed for', r.room_name, err);
            }
          }
          const prepared = {
            fingerprint,
            idempotencyKey: `collect-${crypto.randomUUID()}`,
            receiptUrl,
          };
          submitAttemptsRef.current.set(r.invoice_id, prepared);
          return { invoice_id: r.invoice_id, ...prepared };
        }),
      );
      const attemptMap = new Map(preparedAttempts.map((attempt) => [attempt.invoice_id, attempt]));

      const items: BulkPaymentItem[] = selected.map((r) => {
        // Làm tròn tự động: residual sau payment > 0 và < 10K → đính rounding
        // metadata vào voucher cuối; trigger DB tự mark invoice PAID.
        const sumThisRow = r.amount_tm + r.amount_tk + r.amount_tt;
        const netThisRow = sumThisRow - r.change_amount;
        const residualAfter = r.remaining - netThisRow;
        const willRoundRow =
          residualAfter > 0 && residualAfter < 10000 && netThisRow > 0;
        // Mỗi hình thức vào ĐÚNG sổ của nó (useBulkRecordPayment không rơi về
        // account_id khi đã có bảng sổ theo hình thức).
        const accounts = accountsForRow(r);
        return {
          invoice_id: r.invoice_id,
          invoice_number: r.invoice_number,
          room_name: r.room_name,
          amount_tm: r.amount_tm,
          amount_tk: r.amount_tk,
          amount_tt: r.amount_tt,
          change_amount: r.change_amount,
          account_id: accounts.TM || accounts.TK || accounts.TT || '',
          accounts,
          change_account_id:
            r.change_amount > 0 && !r.keep_as_credit
              ? (r.change_account_id_override ?? headerChangeAccountId)
              : null,
          keep_as_credit: r.keep_as_credit && r.change_amount > 0,
          receipt_image_url: attemptMap.get(r.invoice_id)?.receiptUrl ?? null,
          notes: r.notes || undefined,
          rounding_amount: willRoundRow ? residualAfter : 0,
          rounding_account_id:
            willRoundRow && roundingAccountId ? roundingAccountId : null,
          idempotency_key: attemptMap.get(r.invoice_id)?.idempotencyKey,
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
        result.ok.forEach((invoiceId) => submitAttemptsRef.current.delete(invoiceId));
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
            Sổ nhận:{' '}
            {receivingLoading ? (
              <span className="font-medium text-foreground">đang tải…</span>
            ) : receivingError ? (
              <span className="font-medium text-red-600">{receivingError}</span>
            ) : receivingBuildingId ? (
              <span className="font-medium text-foreground">
                TM {tmBook?.name || '— chưa cài —'} · TK {bookName('TK', headerBookId('TK')) || '— chưa cài —'} · TT{' '}
                {bookName('TT', headerBookId('TT')) || '— chưa cài —'}
              </span>
            ) : (
              <span className="font-medium text-foreground">— chọn toà —</span>
            )}
            {' · '}
            Mặc định thối:{' '}
            <span className="font-medium text-foreground">
              {headerChangeAccountName || '— chưa chọn —'}
            </span>
          </span>
        </div>

        {showAccountColumns && (
          <div className="grid grid-cols-4 gap-3 pb-2">
            <div className="space-y-1">
              <Label>Sổ nhận TM (sổ tiền mặt riêng)</Label>
              {receivingLoading ? (
                <p className="flex h-10 items-center text-sm text-muted-foreground">Đang tải…</p>
              ) : tmBook ? (
                <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">{tmBook.name}</div>
              ) : (
                <p className="text-xs text-red-600">{receivingError || missingReceivingBookMessage('TM')}</p>
              )}
            </div>
            {(['TK', 'TT'] as const).map((m) => {
              const list = booksOf(m);
              return (
                <div key={m} className="space-y-1">
                  <Label>{m === 'TK' ? 'Sổ nhận TK (chuyển khoản) chung' : 'Sổ nhận TT (thanh toán) chung'}</Label>
                  {receivingLoading ? (
                    <p className="flex h-10 items-center text-sm text-muted-foreground">Đang tải…</p>
                  ) : list.length === 0 ? (
                    <p className="text-xs text-red-600">
                      {receivingError || missingReceivingBookMessage(m, receivingBuildingName)}
                    </p>
                  ) : (
                    <Select
                      value={headerBookId(m)}
                      onValueChange={(v) => setHeaderBook((prev) => ({ ...prev, [m]: v }))}
                      disabled={list.length === 1}
                    >
                      <SelectTrigger aria-label={`Sổ nhận ${m} chung`}>
                        <SelectValue placeholder="Chọn sổ nhận..." />
                      </SelectTrigger>
                      <SelectContent>
                        {list.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                            {b.isDefault ? ' (mặc định)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
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
                  {changeAccountOptions(virtualAccounts, currentUserId).map((a) => (
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
                        {canEditInvoicePerm && (canOpenInvoiceEditor(r) ? (
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
                            title="Trạng thái hóa đơn không cho phép chỉnh sửa"
                            className="text-slate-300 p-0.5 cursor-not-allowed"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </span>
                        ))}
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
                        aria-label="Tiền thối thực tế"
                        disabled={r.keep_as_credit}
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
                          disabled={
                            r.change_amount <= 0
                            || !r.has_contract
                            || r.amount_tm < r.change_amount
                          }
                          onCheckedChange={(checked) => updateRow(i, {
                            keep_as_credit: checked === true,
                            credit_user_edited: true,
                          })}
                        />
                        {r.amount_tm < r.change_amount && r.change_amount > 0
                          ? 'Nợ kỳ sau (bắt buộc)'
                          : 'Nợ kỳ sau'}
                      </label>
                    </td>
                    {showAccountColumns && (
                      <>
                        <td className="p-1 border align-top">
                          {/* Sổ nhận của từng hình thức có tiền trong dòng: TM cố định
                              sổ tiền mặt riêng; TK/TT chọn riêng cho dòng này. */}
                          {r.amount_tm + r.amount_tk + r.amount_tt <= 0 ? (
                            <span className="text-xs text-slate-400">—</span>
                          ) : (
                            <div className="space-y-1">
                              {r.amount_tm > 0 && (
                                <RowBookCell
                                  label="TM"
                                  books={tmBook ? [tmBook] : []}
                                  value={tmBook?.id ?? ''}
                                  locked
                                />
                              )}
                              {r.amount_tk > 0 && (
                                <RowBookCell
                                  label="TK"
                                  books={booksOf('TK')}
                                  value={rowBookId(r, 'TK')}
                                  onChange={(v) => updateRow(i, { tk_account_override: v })}
                                />
                              )}
                              {r.amount_tt > 0 && (
                                <RowBookCell
                                  label="TT"
                                  books={booksOf('TT')}
                                  value={rowBookId(r, 'TT')}
                                  onChange={(v) => updateRow(i, { tt_account_override: v })}
                                />
                              )}
                            </div>
                          )}
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
                              {changeAccountOptions(virtualAccounts, currentUserId).map((a) => (
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
                          {willRound ? `Đủ · bỏ qua ${fmt(residualAfter)}đ` : 'Đủ'}
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
      {canEditInvoicePerm && editingInvoice && (
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

      {/* Thu trùng: phòng vừa được thu cùng số tiền trong 30 phút. */}
      <AlertDialog
        open={!!bulkDupAsk}
        onOpenChange={(v) => {
          if (!v) setBulkDupAsk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Có thể đang thu trùng</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Các phòng sau vừa được thu cùng số tiền trong 30 phút gần đây:</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {(bulkDupAsk?.lines ?? []).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p>Vẫn ghi nhận tất cả?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Không thu</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!bulkDupAsk) return;
                bulkDupAckRef.current = bulkDupAsk.ackKey;
                setBulkDupAsk(null);
                void handleSubmit();
              }}
            >
              Vẫn thu tiếp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

interface RowBookCellProps {
  label: 'TM' | 'TK' | 'TT';
  books: ReceivingBook[];
  value: string;
  /** TM: sổ tiền mặt riêng — chỉ hiện, không cho chọn. */
  locked?: boolean;
  onChange?: (accountId: string) => void;
}

/** Sổ nhận của một hình thức trong một dòng: chọn được khi có ≥ 2 sổ. */
function RowBookCell({ label, books, value, locked, onChange }: RowBookCellProps) {
  if (books.length === 0) {
    return <div className="text-[11px] text-red-600">{label} · chưa cài sổ</div>;
  }
  if (locked || books.length === 1 || !onChange) {
    const name = books.find((b) => b.id === value)?.name ?? books[0].name;
    return (
      <div className="truncate text-[11px] text-slate-600" title={name}>
        {label} · {name}
      </div>
    );
  }
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 text-xs" aria-label={`Sổ nhận ${label} của dòng`}>
        <span className="mr-1 text-slate-500">{label}</span>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {books.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
