// =============================================
// useUtilityPayState — state + hành động dùng chung cho màn Đóng tiền Điện nước
// (sheet mobile + panel desktop). Gói: sửa mã/chủ hộ inline (autosave), nhập
// số tiền, chọn sổ quỹ, đính ảnh phiếu, đóng tiền, hủy phiếu. Nhờ đó 2 surface
// hành xử y hệt nhau, tránh lệch logic.
// =============================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { getSessionUser } from '@/lib/authSession';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { useAccounts } from '@/hooks/useAccounts';
import {
  useUtilityAccounts,
  useUtilityPayments,
  usePayUtilityBill,
  useCancelUtilityBill,
  useUpsertUtilityAccount,
  type UtilType,
} from '@/hooks/useUtilityBills';
import type { CancelTarget } from '@/components/thu-tien/UtilityCancelModal';

const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export function useUtilityPayState(
  billingMonth: string,
  buildings: { id: string; name: string }[],
) {
  const { byKey, isLoading: loadingAccts } = useUtilityAccounts();
  const payments = useUtilityPayments(billingMonth);
  const { paidThisKy, byDay, isLoading: loadingPay } = payments;
  const { data: accounts = [] } = useAccounts();
  const payMut = usePayUtilityBill();
  const cancelMut = useCancelUtilityBill(billingMonth);
  const upsertMut = useUpsertUtilityAccount();

  const [draft, setDraft] = useState<Record<string, { code: string; holder: string }>>({});
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [bookSel, setBookSel] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Record<string, string>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);

  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { getSessionUser().then((u) => setUid(u?.id ?? null)); }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachKeyRef = useRef<string | null>(null);

  const key = (bId: string, t: UtilType) => `${bId}:${t}`;
  const codeOf = (bId: string, t: UtilType) => draft[key(bId, t)]?.code ?? byKey(bId, t)?.code ?? '';
  const holderOf = (bId: string, t: UtilType) => draft[key(bId, t)]?.holder ?? byKey(bId, t)?.holder ?? '';
  const amountOf = (bId: string, t: UtilType) => amounts[key(bId, t)] ?? 0;

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

  const setField = (bId: string, t: UtilType, patch: Partial<{ code: string; holder: string }>) =>
    setDraft((d) => ({ ...d, [key(bId, t)]: { code: codeOf(bId, t), holder: holderOf(bId, t), ...patch } }));
  const setAmount = (bId: string, t: UtilType, v: number) =>
    setAmounts((a) => ({ ...a, [key(bId, t)]: v }));
  const setBook = (k: string, id: string) => setBookSel((s) => ({ ...s, [k]: id }));

  const saveAccount = (bId: string, t: UtilType) => {
    const code = codeOf(bId, t).trim();
    const holder = holderOf(bId, t).trim();
    const cur = byKey(bId, t);
    if ((cur?.code ?? '') === code && (cur?.holder ?? '') === holder) return;
    if (!code && !holder) return;
    upsertMut.mutate({ buildingId: bId, type: t, code, holder });
  };

  const onAttachClick = (k: string) => {
    if (uploadingKey) return;
    attachKeyRef.current = k;
    fileRef.current?.click();
  };
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const k = attachKeyRef.current;
    if (!file || !k) return;
    const err = validateReceiptFile(file);
    if (err) { toast.error(err); return; }
    setUploadingKey(k);
    try {
      const url = await uploadReceiptToStorage(file);
      setAttach((a) => ({ ...a, [k]: url }));
      toast.success('Đã đính kèm ảnh phiếu');
    } catch (ex) {
      toast.error('Không tải được ảnh: ' + (ex as Error).message);
    } finally {
      setUploadingKey(null);
    }
  };

  const submitPay = async (bId: string, t: UtilType, name: string) => {
    const k = key(bId, t);
    const amount = amountOf(bId, t);
    if (amount <= 0) { toast.error('Nhập số tiền cần đóng'); return; }
    setPayingKey(k);
    try {
      await payMut.mutateAsync({
        buildingId: bId, type: t, billingMonth, amount,
        code: codeOf(bId, t).trim(), holder: holderOf(bId, t).trim(),
        accountId: bookSel[k] ?? null,
        attachments: attach[k] ? [attach[k]] : undefined,
      });
      setAmounts((a) => { const n = { ...a }; delete n[k]; return n; });
      setAttach((a) => { const n = { ...a }; delete n[k]; return n; });
      toast.success(`Đã chi ${fmtFull(amount)} tiền ${t === 'electric' ? 'điện' : 'nước'} · ${name}`);
    } catch (ex) {
      toast.error((ex as Error).message);
    } finally {
      setPayingKey(null);
    }
  };

  const requestCancel = (bId: string, t: UtilType) => {
    const paid = paidThisKy(bId, t);
    if (!paid) return;
    setCancelTarget({
      voucherId: paid.voucherId,
      bld: buildings.find((b) => b.id === bId)?.name ?? '',
      typeText: t === 'electric' ? 'điện' : 'nước',
      amount: paid.amount,
      dateText: fmtDate(paid.date),
      timeText: paid.time,
      by: paid.by,
      book: paid.book,
    });
  };
  const confirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelMut.mutateAsync(cancelTarget.voucherId);
      toast.success('Đã hủy phiếu thanh toán');
      setCancelTarget(null);
    } catch (ex) {
      toast.error((ex as Error).message);
    }
  };

  return {
    // data
    byKey, paidThisKy, byDay, loadingPay, loadingAccts,
    myBooks, defaultBookId,
    // per-row getters/setters
    key, codeOf, holderOf, amountOf, setField, setAmount,
    bookSel, setBook, attach, uploadingKey, saveAccount,
    payingKey, submitPay,
    // attach input
    fileRef, onFileChange, onAttachClick,
    // cancel
    cancelTarget, requestCancel, confirmCancel, cancelling: cancelMut.isPending,
    closeCancel: () => setCancelTarget(null),
  };
}
