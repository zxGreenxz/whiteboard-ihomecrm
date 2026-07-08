// =============================================================================
// usePeriodFeeState — state + hành động dùng chung (desktop panel + mobile sheet)
// cho họ GRID của trang "Đóng tiền Tập trung theo Kỳ". 1 dòng / tòa.
//
// Gói: nhập tiền, chọn số kỳ (đa kỳ→accrual), chọn sổ quỹ, đính ảnh, mã NCC/chủ
// hộ (autosave onBlur qua upsert_building_fee_account), đóng tiền, hủy phiếu,
// mở/sửa phiếu đã có (2 tầng quyền). Điện/Nước KHÔNG qua đây (dùng useUtilityPayState).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { getSessionUser } from '@/lib/authSession';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { useAccounts } from '@/hooks/useAccounts';
import {
  usePayPeriodFee,
  useCancelPeriodFee,
  useUpdatePeriodFee,
  useUpsertFeeAccount,
  type PeriodFeeStatus,
  type FeeAccount,
} from '@/hooks/usePeriodFees';
import type { FeeCategory } from '@/lib/feeCategories';
import type { CancelTarget } from '@/components/thu-tien/UtilityCancelModal';

const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

/** 'YYYY-MM' + n tháng (n có thể âm). */
export const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.slice(0, 7).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
/** 'T7/2026' hoặc 'T7/2026 → T12/2026'. */
export const rangeLabel = (start: string, end: string): string => {
  const f = (ym: string) => `T${Number(ym.slice(5, 7))}/${ym.slice(0, 4)}`;
  return start === end ? f(start) : `${f(start)} → ${f(end)}`;
};

/** Mục tiêu mở modal Sửa phiếu. */
export interface FeeEditTarget {
  voucherId: string;
  title: string;
  categoryLabel: string;
  buildingName: string;
  amount: number;
  periodStart: string;   // 'YYYY-MM'
  periodEnd: string;
  multi: boolean;
  bookName: string;      // '' = chưa gán sổ
  accountIsEmpty: boolean;
  hasReceipt: boolean;
  attachments: string[];
  notes: string;
}

export function usePeriodFeeState(
  period: string,
  category: FeeCategory,
  buildings: { id: string; name: string }[],
  statusOf: (buildingId: string, categoryKey: string) => PeriodFeeStatus | undefined,
  accountOf: (buildingId: string, feeCategory: string) => FeeAccount | undefined,
) {
  const { data: accounts = [] } = useAccounts();
  const payMut = usePayPeriodFee();
  const cancelMut = useCancelPeriodFee();
  const updateMut = useUpdatePeriodFee();
  const upsertCfg = useUpsertFeeAccount();

  const key = category.serverKey; // GRID key = fee_category

  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [bookSel, setBookSel] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Record<string, string>>({});
  const [periodN, setPeriodN] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Record<string, { code: string; holder: string }>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [editTarget, setEditTarget] = useState<FeeEditTarget | null>(null);

  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { getSessionUser().then((u) => setUid(u?.id ?? null)); }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachKeyRef = useRef<string | null>(null);
  const editAttachRef = useRef(false);

  const buildingName = (id: string) => buildings.find((b) => b.id === id)?.name ?? '';

  const myBooks = useMemo(
    () => accounts.filter((a) => !a.is_virtual && (!uid || a.user_id === uid)).map((a) => ({ id: a.id, name: a.name })),
    [accounts, uid],
  );
  const defaultBookId = useMemo(() => {
    const thu = accounts
      .filter((a) => !a.is_virtual && (!uid || a.user_id === uid) && a.name.trim().endsWith('Thu'))
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
    return thu[0]?.id ?? null;
  }, [accounts, uid]);

  // ── Per-row getters ──
  const cfgOf = (bId: string) => accountOf(bId, key);
  const codeOf = (bId: string) => draft[bId]?.code ?? cfgOf(bId)?.providerCode ?? '';
  const holderOf = (bId: string) => draft[bId]?.holder ?? cfgOf(bId)?.accountHolder ?? '';
  const amountOf = (bId: string) => amounts[bId] ?? 0;
  const defaultAmountOf = (bId: string) => cfgOf(bId)?.defaultAmount ?? null;
  const nOf = (bId: string) => (category.multiPeriod ? (periodN[bId] ?? 1) : 1);
  const paidOf = (bId: string) => statusOf(bId, key);

  const setField = (bId: string, patch: Partial<{ code: string; holder: string }>) =>
    setDraft((d) => ({ ...d, [bId]: { code: codeOf(bId), holder: holderOf(bId), ...patch } }));
  const setAmount = (bId: string, v: number) => setAmounts((a) => ({ ...a, [bId]: v }));
  const setBook = (bId: string, id: string) => setBookSel((s) => ({ ...s, [bId]: id }));
  const setN = (bId: string, n: number) => setPeriodN((s) => ({ ...s, [bId]: n }));

  // Lưu mã NCC/chủ hộ (autosave onBlur) — chỉ khi đổi so với cấu hình đã lưu.
  const saveConfig = (bId: string) => {
    const code = codeOf(bId).trim();
    const holder = holderOf(bId).trim();
    const cfg = cfgOf(bId);
    if (code === (cfg?.providerCode ?? '') && holder === (cfg?.accountHolder ?? '')) return;
    if (!code && !holder && !cfg) return;
    upsertCfg.mutate({ buildingId: bId, feeCategory: key, providerCode: code || null, accountHolder: holder || null });
  };

  // ── Đính ảnh ──
  const onAttachClick = (bId: string) => {
    if (uploadingKey) return;
    attachKeyRef.current = bId;
    editAttachRef.current = false;
    fileRef.current?.click();
  };
  const onEditAttachClick = () => {
    if (uploadingKey) return;
    editAttachRef.current = true;
    fileRef.current?.click();
  };
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = validateReceiptFile(file);
    if (err) { toast.error(err); return; }

    if (editAttachRef.current && editTarget) {
      setUploadingKey('__edit__');
      try {
        const url = await uploadReceiptToStorage(file);
        setEditTarget((t) => (t ? { ...t, attachments: [...t.attachments, url], hasReceipt: true } : t));
        toast.success('Đã thêm ảnh phiếu');
      } catch (ex) { toast.error('Không tải được ảnh: ' + (ex as Error).message); }
      finally { setUploadingKey(null); }
      return;
    }

    const k = attachKeyRef.current;
    if (!k) return;
    setUploadingKey(k);
    try {
      const url = await uploadReceiptToStorage(file);
      setAttach((a) => ({ ...a, [k]: url }));
      toast.success('Đã đính kèm ảnh phiếu');
    } catch (ex) { toast.error('Không tải được ảnh: ' + (ex as Error).message); }
    finally { setUploadingKey(null); }
  };

  // ── Đóng tiền ──
  const submitPay = async (bId: string) => {
    const amount = amountOf(bId);
    if (amount <= 0) { toast.error('Nhập số tiền cần đóng'); return; }
    const n = nOf(bId);
    const periodEnd = addMonths(period, n - 1);
    setPayingKey(bId);
    try {
      await payMut.mutateAsync({
        buildingId: bId, categoryKey: key, amount,
        periodStart: period, periodEnd,
        providerCode: codeOf(bId).trim(), accountHolder: holderOf(bId).trim(),
        accountId: bookSel[bId] ?? defaultBookId ?? null,
        attachments: attach[bId] ? [attach[bId]] : undefined,
      });
      setAmounts((a) => { const x = { ...a }; delete x[bId]; return x; });
      setAttach((a) => { const x = { ...a }; delete x[bId]; return x; });
      toast.success(`Đã chi ${fmtFull(amount * (category.multiPeriod ? n : 1))} — ${category.label} · ${buildingName(bId)}`);
    } catch (ex) { toast.error((ex as Error).message); }
    finally { setPayingKey(null); }
  };

  // ── Hủy phiếu ──
  const requestCancel = (bId: string) => {
    const p = paidOf(bId);
    if (!p || p.voucherIds.length === 0) return;
    setCancelTarget({
      voucherId: p.voucherIds[0],
      bld: buildingName(bId),
      typeText: category.label.toLowerCase(),
      amount: p.paidAmount,
      dateText: fmtDate(p.coveredStart),
      timeText: '',
      by: '',
      book: p.accountName ?? '',
    });
  };
  const confirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelMut.mutateAsync(cancelTarget.voucherId);
      toast.success('Đã hủy phiếu chi');
      setCancelTarget(null);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  // ── Mở / sửa phiếu đã có ──
  const openEdit = (bId: string) => {
    const p = paidOf(bId);
    if (!p || p.voucherIds.length === 0) return;
    setEditTarget({
      voucherId: p.voucherIds[0],
      title: `${category.label} · ${buildingName(bId)}`,
      categoryLabel: category.label,
      buildingName: buildingName(bId),
      amount: p.paidAmount,
      periodStart: (p.coveredStart ?? period + '-01').slice(0, 7),
      periodEnd: (p.coveredEnd ?? period + '-01').slice(0, 7),
      multi: category.multiPeriod,
      bookName: p.accountName ?? '',
      accountIsEmpty: p.accountIsEmpty,
      hasReceipt: p.hasReceipt,
      attachments: [],
      notes: '',
    });
  };
  const patchEdit = (patch: Partial<FeeEditTarget>) => setEditTarget((t) => (t ? { ...t, ...patch } : t));
  const submitEdit = async (args: {
    isAdmin: boolean;
    amount?: number;
    periodStart?: string;
    periodEnd?: string;
    accountId?: string | null;
    notes?: string;
  }) => {
    if (!editTarget) return;
    try {
      await updateMut.mutateAsync({
        voucherId: editTarget.voucherId,
        accountId: args.accountId ?? null,
        attachments: editTarget.attachments.length ? editTarget.attachments : null,
        amount: args.isAdmin ? args.amount ?? null : null,
        periodStart: args.isAdmin ? args.periodStart ?? null : null,
        periodEnd: args.isAdmin ? args.periodEnd ?? null : null,
        notes: args.isAdmin ? args.notes ?? null : null,
      });
      toast.success('Đã lưu thay đổi phiếu');
      setEditTarget(null);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  return {
    myBooks, defaultBookId,
    codeOf, holderOf, amountOf, defaultAmountOf, nOf, paidOf,
    setField, setAmount, setBook, setN, saveConfig,
    bookSel, attach, uploadingKey, payingKey,
    fileRef, onFileChange, onAttachClick, onEditAttachClick,
    submitPay,
    cancelTarget, requestCancel, confirmCancel, cancelling: cancelMut.isPending,
    closeCancel: () => setCancelTarget(null),
    editTarget, openEdit, patchEdit, submitEdit, closeEdit: () => setEditTarget(null),
    saving: updateMut.isPending,
  };
}
