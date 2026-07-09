// =============================================================================
// usePeriodFeeState V2 — state + hành động dùng chung (desktop panel + mobile sheet)
// cho họ GRID của trang "Đóng tiền Tập trung theo Kỳ". 1 dòng / tòa.
//
// V2 (10/07):
//   - FIX leak: reset toàn bộ state khi đổi hạng mục/kỳ (trước đây tiền gõ ở
//     Internet lây sang Rác, saveConfig ghi nhầm hạng mục).
//   - Sổ mặc định tòa×hạng mục×user (profiles.ui_preferences key 'feeBooks').
//   - Đa kỳ = TỔNG cả khoảng (đã chốt): toast/hint không nhân n nữa.
//   - Chống đóng trùng: pay lần 1 không force → RPC trả warning → expose
//     dupConfirm để UI hiện hộp xác nhận → confirmPayDup() gọi lại force.
//   - Sửa/hủy/thanh toán theo TỪNG PHIẾU (vouchers payload) — hết mất ảnh/ghi chú.
//   - appendReceipt: camera nhanh đính ảnh vào phiếu ngay trên dòng.
//   - Thanh toán phiếu NHÁP (recurring draft-mode): draftTarget + submitPayDraft.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { getSessionUser } from '@/lib/authSession';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { useAccounts } from '@/hooks/useAccounts';
import { useUiPreferences, useSetUiPreference } from '@/hooks/useUiPreferences';
import {
  usePayPeriodFee,
  usePayDraftFeeVoucher,
  useCancelPeriodFee,
  useUpdatePeriodFee,
  useUpsertFeeAccount,
  useAppendFeeAttachment,
  type PeriodFeeStatus,
  type PeriodFeeVoucher,
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

/** Mục tiêu mở modal Sửa phiếu (seed từ 1 phiếu CỤ THỂ). */
export interface FeeEditTarget {
  voucherId: string;
  title: string;
  categoryLabel: string;
  buildingName: string;
  amount: number;
  periodStart: string;
  periodEnd: string;
  multi: boolean;
  bookName: string;
  accountIsEmpty: boolean;
  itemCount: number;
  existingAttachments: string[];  // ảnh ĐANG có trên phiếu
  newAttachments: string[];       // ảnh vừa thêm trong modal (chưa lưu)
  notes: string;
  notesOriginal: string;          // để phát hiện có đổi hay không
  isAuto: boolean;
}

/** Xác nhận đóng trùng (RPC trả warning). */
export interface DupConfirm {
  buildingId: string;
  buildingName: string;
  amount: number;
  existingAmount: number;
  existingCount: number;
}

/** Thanh toán phiếu NHÁP. */
export interface DraftPayTarget {
  voucher: PeriodFeeVoucher;
  buildingId: string;
  buildingName: string;
  categoryLabel: string;
}

export function usePeriodFeeState(
  period: string,
  category: FeeCategory,
  buildings: { id: string; name: string }[],
  statusOf: (buildingId: string, categoryKey: string) => PeriodFeeStatus | undefined,
  accountOf: (buildingId: string, feeCategory: string) => FeeAccount | undefined,
) {
  const { data: accounts = [] } = useAccounts();
  const { data: uiPrefs } = useUiPreferences();
  const setPref = useSetUiPreference();
  const payMut = usePayPeriodFee();
  const payDraftMut = usePayDraftFeeVoucher();
  const cancelMut = useCancelPeriodFee();
  const updateMut = useUpdatePeriodFee();
  const appendMut = useAppendFeeAttachment();
  const upsertCfg = useUpsertFeeAccount();

  const key = category.serverKey;

  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [bookSel, setBookSel] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Record<string, string>>({});
  const [periodN, setPeriodN] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Record<string, { code: string; holder: string }>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [editTarget, setEditTarget] = useState<FeeEditTarget | null>(null);
  const [dupConfirm, setDupConfirm] = useState<DupConfirm | null>(null);
  const [draftTarget, setDraftTarget] = useState<DraftPayTarget | null>(null);

  // FIX P0 leak: đổi hạng mục / kỳ → reset sạch input + modal đang treo.
  useEffect(() => {
    setAmounts({}); setBookSel({}); setAttach({}); setPeriodN({}); setDraft({});
    setEditTarget(null); setCancelTarget(null); setDupConfirm(null); setDraftTarget(null);
    attachKeyRef.current = null; attachModeRef.current = 'pay';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.serverKey, period]);

  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { getSessionUser().then((u) => setUid(u?.id ?? null)); }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachKeyRef = useRef<string | null>(null);
  // 'pay' = đính cho ô sắp đóng; 'edit' = thêm vào modal Sửa; 'quick:<voucherId>' =
  // camera nhanh trên dòng; 'draftpay' = ảnh CK trong modal Thanh toán nháp.
  const attachModeRef = useRef<string>('pay');
  const [draftPayAttachments, setDraftPayAttachments] = useState<string[]>([]);

  const buildingName = (id: string) => buildings.find((b) => b.id === id)?.name ?? '';

  const myBooks = useMemo(
    () => accounts.filter((a) => !a.is_virtual && (!uid || a.user_id === uid)).map((a) => ({ id: a.id, name: a.name })),
    [accounts, uid],
  );
  const thuBookId = useMemo(() => {
    const thu = accounts
      .filter((a) => !a.is_virtual && (!uid || a.user_id === uid) && a.name.trim().endsWith('Thu'))
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
    return thu[0]?.id ?? null;
  }, [accounts, uid]);

  // ── Sổ mặc định tòa×hạng mục×user (ui_preferences.feeBooks) ──
  const feeBooks = (uiPrefs?.feeBooks ?? {}) as Record<string, string>;
  const validBook = (id?: string | null) => (id && myBooks.some((b) => b.id === id) ? id : null);
  /** pref (tòa×hạng mục) → pref (hạng mục, last-used) → sổ "…Thu". */
  const defaultBookFor = (bId: string): string | null =>
    validBook(feeBooks[`${bId}:${key}`]) ?? validBook(feeBooks[`cat:${key}`]) ?? thuBookId;
  const rememberBook = (bId: string, accountId: string) => {
    const next = { ...feeBooks, [`${bId}:${key}`]: accountId, [`cat:${key}`]: accountId };
    setPref.mutate({ key: 'feeBooks', value: next });
  };

  // ── Per-row getters ──
  const cfgOf = (bId: string) => accountOf(bId, key);
  const codeOf = (bId: string) => draft[bId]?.code ?? cfgOf(bId)?.providerCode ?? '';
  const holderOf = (bId: string) => draft[bId]?.holder ?? cfgOf(bId)?.accountHolder ?? '';
  const amountOf = (bId: string) => amounts[bId] ?? 0;
  const defaultAmountOf = (bId: string) => cfgOf(bId)?.defaultAmount ?? null;
  const nOf = (bId: string) => (category.multiPeriod ? (periodN[bId] ?? 1) : 1);
  const paidOf = (bId: string) => statusOf(bId, key);
  const vouchersOf = (bId: string): PeriodFeeVoucher[] => paidOf(bId)?.vouchers ?? [];

  const setField = (bId: string, patch: Partial<{ code: string; holder: string }>) =>
    setDraft((d) => ({ ...d, [bId]: { code: codeOf(bId), holder: holderOf(bId), ...patch } }));
  const setAmount = (bId: string, v: number) => setAmounts((a) => ({ ...a, [bId]: v }));
  const setBook = (bId: string, id: string) => setBookSel((s) => ({ ...s, [bId]: id }));
  const setN = (bId: string, n: number) => setPeriodN((s) => ({ ...s, [bId]: Math.max(1, Math.min(36, Math.round(n) || 1)) }));

  const saveConfig = (bId: string) => {
    const code = codeOf(bId).trim();
    const holder = holderOf(bId).trim();
    const cfg = cfgOf(bId);
    if (code === (cfg?.providerCode ?? '') && holder === (cfg?.accountHolder ?? '')) return;
    if (!code && !holder && !cfg) return;
    upsertCfg.mutate({ buildingId: bId, feeCategory: key, providerCode: code || null, accountHolder: holder || null });
  };

  /** Sửa số tiền DỰ KIẾN (inline). */
  const saveExpected = (bId: string, amount: number | null) =>
    upsertCfg.mutate(
      { buildingId: bId, feeCategory: key, defaultAmount: amount },
      { onSuccess: () => toast.success('Đã lưu số tiền dự kiến') },
    );

  /** Cờ "Không áp dụng" cho tòa×hạng mục. */
  const setNotApplicable = (bId: string, na: boolean) =>
    upsertCfg.mutate(
      { buildingId: bId, feeCategory: key, notApplicable: na },
      { onSuccess: () => toast.success(na ? `Đã đánh dấu KHÔNG áp dụng — ${buildingName(bId)}` : `Đã bật lại hạng mục — ${buildingName(bId)}`) },
    );

  // ── Đính ảnh (1 input file dùng chung 4 mode) ──
  const onAttachClick = (bId: string) => {
    if (uploadingKey) return;
    attachKeyRef.current = bId; attachModeRef.current = 'pay';
    fileRef.current?.click();
  };
  const onEditAttachClick = () => {
    if (uploadingKey) return;
    attachModeRef.current = 'edit';
    fileRef.current?.click();
  };
  const onQuickAttachClick = (bId: string, voucherId: string) => {
    if (uploadingKey) return;
    attachKeyRef.current = bId; attachModeRef.current = `quick:${voucherId}`;
    fileRef.current?.click();
  };
  const onDraftPayAttachClick = () => {
    if (uploadingKey) return;
    attachModeRef.current = 'draftpay';
    fileRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = validateReceiptFile(file);
    if (err) { toast.error(err); return; }
    const mode = attachModeRef.current;
    const busyKey = mode === 'edit' ? '__edit__' : mode === 'draftpay' ? '__draftpay__'
      : mode.startsWith('quick:') ? `__quick__${attachKeyRef.current}` : attachKeyRef.current;
    if (!busyKey) return;
    setUploadingKey(busyKey);
    try {
      const url = await uploadReceiptToStorage(file);
      if (mode === 'edit') {
        setEditTarget((t) => (t ? { ...t, newAttachments: [...t.newAttachments, url] } : t));
        toast.success('Đã thêm ảnh phiếu');
      } else if (mode === 'draftpay') {
        setDraftPayAttachments((a) => [...a, url]);
        toast.success('Đã thêm ảnh chứng từ');
      } else if (mode.startsWith('quick:')) {
        // Append server-side — không đè ảnh người khác vừa đính (RPC riêng).
        const voucherId = mode.slice('quick:'.length);
        await appendMut.mutateAsync({ voucherId, url });
        toast.success('Đã đính ảnh vào phiếu');
      } else {
        setAttach((a) => ({ ...a, [attachKeyRef.current!]: url }));
        toast.success('Đã đính kèm ảnh phiếu');
      }
    } catch (ex) { toast.error('Không tải được ảnh: ' + (ex as Error).message); }
    finally { setUploadingKey(null); }
  };

  // ── Đóng tiền (TỔNG cả khoảng; chống trùng 2 bước) ──
  const doPay = async (bId: string, force: boolean) => {
    const amount = amountOf(bId);
    const n = nOf(bId);
    const periodEnd = addMonths(period, n - 1);
    const accountId = bookSel[bId] ?? defaultBookFor(bId) ?? null;
    setPayingKey(bId);
    try {
      const res = await payMut.mutateAsync({
        buildingId: bId, categoryKey: key, amount,
        periodStart: period, periodEnd,
        providerCode: codeOf(bId).trim(), accountHolder: holderOf(bId).trim(),
        accountId,
        attachments: attach[bId] ? [attach[bId]] : undefined,
        force,
      });
      if ('warning' in res && res.warning === 'duplicate') {
        setDupConfirm({
          buildingId: bId, buildingName: buildingName(bId), amount,
          existingAmount: res.existing_amount ?? 0,
          existingCount: res.existing_count ?? 1,
        });
        return;
      }
      setAmounts((a) => { const x = { ...a }; delete x[bId]; return x; });
      setAttach((a) => { const x = { ...a }; delete x[bId]; return x; });
      if (accountId) rememberBook(bId, accountId);
      toast.success(`Đã chi ${fmtFull(amount)} — ${category.label} · ${buildingName(bId)}`);
    } catch (ex) { toast.error((ex as Error).message); }
    finally { setPayingKey(null); }
  };
  const submitPay = async (bId: string) => {
    const amount = amountOf(bId);
    if (amount <= 0) { toast.error('Nhập số tiền cần đóng'); return; }
    await doPay(bId, false);
  };
  const confirmPayDup = async () => {
    if (!dupConfirm) return;
    const bId = dupConfirm.buildingId;
    setDupConfirm(null);
    await doPay(bId, true);
  };

  // ── Thanh toán phiếu NHÁP ──
  const openPayDraft = (bId: string, voucher: PeriodFeeVoucher) => {
    setDraftPayAttachments(voucher.attachments);
    setDraftTarget({ voucher, buildingId: bId, buildingName: buildingName(bId), categoryLabel: category.label });
  };
  const submitPayDraft = async (accountId: string) => {
    if (!draftTarget) return;
    try {
      const res = await payDraftMut.mutateAsync({
        voucherId: draftTarget.voucher.id,
        accountId,
        attachments: draftPayAttachments.length ? draftPayAttachments : null,
      });
      rememberBook(draftTarget.buildingId, accountId);
      toast.success(`Đã thanh toán & duyệt phiếu ${res.code ?? ''} — ${draftTarget.categoryLabel} · ${draftTarget.buildingName}`);
      setDraftTarget(null);
      setDraftPayAttachments([]);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  // ── Hủy phiếu (per-voucher) ──
  const requestCancel = (bId: string, voucher?: PeriodFeeVoucher) => {
    const vs = vouchersOf(bId);
    const v = voucher ?? vs.find((x) => x.cancellable);
    if (!v) return;
    // Modal hiển thị "phiếu chi tiền {typeText}" → bỏ tiền tố "tiền " của label
    // (tránh "tiền tiền nhà").
    const label = category.label.toLowerCase().replace(/^tiền\s+/, '');
    setCancelTarget({
      voucherId: v.id,
      bld: buildingName(bId),
      // Generator dedup theo (parent, ngày, deleted_at NULL) → hủy phiếu auto thì
      // lần sinh sau CÓ THỂ tạo lại đúng phiếu này. Muốn dừng hẳn: sửa phiếu định kỳ gốc.
      typeText: label + (v.isAuto ? ' (tự động lập — recurring có thể sinh LẠI, kể cả kỳ này; muốn dừng hẳn sửa phiếu định kỳ gốc)' : ''),
      amount: v.amount,
      dateText: fmtDate(v.date),
      timeText: '',
      by: v.creatorName ?? '',
      book: v.accountName ?? '',
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

  // ── Sửa phiếu (seed từ voucher CỤ THỂ) ──
  const openEdit = (bId: string, voucher?: PeriodFeeVoucher) => {
    const vs = vouchersOf(bId);
    const v = voucher ?? vs[0];
    if (!v) return;
    setEditTarget({
      voucherId: v.id,
      title: `${category.label} · ${buildingName(bId)}`,
      categoryLabel: category.label,
      buildingName: buildingName(bId),
      amount: v.amount,
      periodStart: (v.start ?? period + '-01').slice(0, 7),
      periodEnd: (v.end ?? v.start ?? period + '-01').slice(0, 7),
      multi: category.multiPeriod,
      bookName: v.accountName ?? '',
      accountIsEmpty: v.accountId == null,
      itemCount: v.itemCount,
      existingAttachments: v.attachments,
      newAttachments: [],
      notes: v.notes ?? '',
      notesOriginal: v.notes ?? '',
      isAuto: v.isAuto,
    });
  };
  const submitEdit = async (args: {
    isAdmin: boolean;
    amount?: number;
    periodStart?: string;
    periodEnd?: string;
    accountId?: string | null;
    notes?: string;
  }) => {
    if (!editTarget) return;
    const t = editTarget;
    const mergedAtts = t.newAttachments.length ? [...t.existingAttachments, ...t.newAttachments] : null;
    const notesChanged = args.isAdmin && args.notes != null && args.notes !== t.notesOriginal;
    try {
      await updateMut.mutateAsync({
        voucherId: t.voucherId,
        accountId: args.accountId ?? null,
        attachments: mergedAtts,
        amount: args.isAdmin && t.itemCount <= 1 ? args.amount ?? null : null,
        periodStart: args.isAdmin && t.itemCount <= 1 ? args.periodStart ?? null : null,
        periodEnd: args.isAdmin && t.itemCount <= 1 ? args.periodEnd ?? null : null,
        notes: notesChanged ? args.notes! : null,
      });
      toast.success('Đã lưu thay đổi phiếu');
      setEditTarget(null);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  return {
    myBooks, defaultBookFor, defaultBookId: thuBookId,
    codeOf, holderOf, amountOf, defaultAmountOf, nOf, paidOf, vouchersOf,
    setField, setAmount, setBook, setN, saveConfig, saveExpected, setNotApplicable,
    bookSel, attach, uploadingKey, payingKey,
    fileRef, onFileChange, onAttachClick, onEditAttachClick, onQuickAttachClick, onDraftPayAttachClick,
    submitPay,
    dupConfirm, confirmPayDup, closeDupConfirm: () => setDupConfirm(null),
    draftTarget, draftPayAttachments, openPayDraft, submitPayDraft,
    closePayDraft: () => { setDraftTarget(null); setDraftPayAttachments([]); },
    payingDraft: payDraftMut.isPending,
    cancelTarget, requestCancel, confirmCancel, cancelling: cancelMut.isPending,
    closeCancel: () => setCancelTarget(null),
    editTarget, openEdit, submitEdit, closeEdit: () => setEditTarget(null),
    saving: updateMut.isPending,
  };
}
