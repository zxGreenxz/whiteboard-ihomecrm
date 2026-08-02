// =============================================
// useUtilityPayState — state + hành động dùng chung cho màn Đóng tiền Điện nước
// (sheet mobile + panel desktop). Đơn vị là ĐỒNG HỒ (meter): 1 toà có thể nhiều
// đồng hồ điện / nước, mỗi đồng hồ 1 dòng, đóng + theo dõi riêng.
//
// Gói: sửa mã/chủ hộ inline (autosave theo đồng hồ), nhập tiền, chọn sổ quỹ,
// đính ảnh, đóng tiền, hủy phiếu, thêm/xoá đồng hồ, xem ảnh (lightbox).
//
// 30/07/2026 (Slice −1):
//   • §−1.5 KHÔNG GỬI ĐỒNG HỒ NULL. Dòng "synthetic" (toà chưa khai đồng hồ,
//     `accountId=null`) trước đây bấm check là gửi `p_utility_account_id=null`,
//     nhánh ELSE của `pay_utility_bill` TỰ TẠO một dòng
//     `building_utility_accounts` mới; vì `paidThisKy` khoá theo meter id nên
//     dòng đó KHÔNG BAO GIỜ hiện "đã đóng" ⇒ mời đóng lại. Nay client chặn từ
//     gốc và đổi thành hành động tường minh "Tạo công tơ".
//   • §−1.1/§−1.6 chốt in-flight cấp MODULE: hai bề mặt Điện & Nước cùng sống
//     trên /thanh-toan (bảng desktop trong PeriodFeePanel → UtilityEnContent, và
//     khối EN của PeriodFeeSheet). Hai instance hook = hai `amounts` riêng, nên
//     chống trùng phải nằm ngoài React: một Set khoá theo (kỳ × đồng hồ) chặn cú
//     bấm thứ hai NGAY, và một map "vừa tạo phiếu" bịt khe giữa lúc RPC trả về
//     và lúc reader refetch xong.
//     Ghi chú: state nhập liệu của EN CỐ TÌNH không dùng chung như GRID —
//     `.e2e-fleet/specs/utility-paste-receipt.spec.ts:169` assert dòng desktop
//     KHÔNG sáng đèn ảnh khi dán vào thẻ mobile, mà hai bề mặt EN dùng CÙNG khoá
//     (meter id) nên gộp `attach` là làm đỏ spec đó.
// =============================================

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { getSessionUser } from '@/lib/authSession';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { useAccounts } from '@/hooks/useAccounts';
import { useReceiptPasteTarget } from '@/hooks/useReceiptPasteTarget';
import {
  useUtilityAccounts,
  useUtilityPayments,
  usePayUtilityBill,
  useCancelUtilityBill,
  useSaveUtilityMeter,
  useAddUtilityMeter,
  useDeleteUtilityMeter,
  type UtilType,
  type PaidInfo,
} from '@/hooks/useUtilityBills';
import type { CancelTarget } from '@/components/thu-tien/UtilityCancelModal';

const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

/** 1 dòng đồng hồ để render (đã lưu = có accountId; "synthetic" = dòng mặc định chưa lưu). */
export interface MeterRow {
  key: string;
  accountId: string | null;
  buildingId: string;
  buildingName: string;
  type: UtilType;
  persistedCode: string;
  persistedHolder: string;
  isSynthetic: boolean;
  canDelete: boolean;
}

// ── Chốt chống trùng dùng chung giữa MỌI instance (module-level) ─────────────
/** `${kỳ}::${khoá dòng}` đang có RPC bay — chặn re-entry trước cả re-render. */
const utilityInflight = new Set<string>();
/** `${kỳ}::${meter id}` → số tiền vừa gửi, sống đến khi reader thấy phiếu. */
const utilityJustPaid = new Map<string, number>();
let utilityVersion = 0;
const utilitySubs = new Set<() => void>();
const bumpUtility = () => { utilityVersion += 1; utilitySubs.forEach((fn) => fn()); };
const subscribeUtility = (fn: () => void) => { utilitySubs.add(fn); return () => { utilitySubs.delete(fn); }; };
const getUtilityVersion = () => utilityVersion;

export function useUtilityPayState(
  billingMonth: string,
  buildings: { id: string; name: string }[],
) {
  const { byBuilding, isLoading: loadingAccts } = useUtilityAccounts();
  const payments = useUtilityPayments(billingMonth);
  const { paidThisKy, pendingThisKy, noMeterThisKy, byDay, isLoading: loadingPay } = payments;
  // Đăng ký nhận thay đổi của kho chống trùng (bề mặt kia đóng thì bên này cũng
  // đổi trạng thái ngay, không chờ refetch).
  useSyncExternalStore(subscribeUtility, getUtilityVersion, getUtilityVersion);
  const { data: accounts = [] } = useAccounts();
  const payMut = usePayUtilityBill();
  const cancelMut = useCancelUtilityBill(billingMonth);
  const saveMeterMut = useSaveUtilityMeter();
  const addMeterMut = useAddUtilityMeter();
  const deleteMeterMut = useDeleteUtilityMeter();

  const [draft, setDraft] = useState<Record<string, { code: string; holder: string }>>({});
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [bookSel, setBookSel] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Record<string, string>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [receiptView, setReceiptView] = useState<{ attachments: string[]; index: number | null }>({
    attachments: [], index: null,
  });

  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { getSessionUser().then((u) => setUid(u?.id ?? null)); }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachKeyRef = useRef<string | null>(null);

  const buildingName = (id: string) => buildings.find((b) => b.id === id)?.name ?? '';

  // ── Danh sách đồng hồ để render cho 1 toà (đã lưu + dòng mặc định nếu chưa có) ──
  const metersOf = (buildingId: string): MeterRow[] => {
    const list = byBuilding[buildingId] ?? [];
    const rows: MeterRow[] = [];
    (['electric', 'water'] as UtilType[]).forEach((type) => {
      const ms = list.filter((m) => m.type === type);
      if (ms.length === 0) {
        rows.push({
          key: `syn:${buildingId}:${type}`, accountId: null, buildingId,
          buildingName: buildingName(buildingId), type, persistedCode: '', persistedHolder: '',
          isSynthetic: true, canDelete: false,
        });
      } else {
        ms.forEach((m) =>
          rows.push({
            key: m.id, accountId: m.id, buildingId, buildingName: buildingName(buildingId),
            type, persistedCode: m.code, persistedHolder: m.holder, isSynthetic: false,
            // Đồng hồ đã có phiếu CHỜ DUYỆT cũng không được xoá (server chặn,
            // nhưng đừng hiện nút mời bấm).
            canDelete: ms.length > 1 && !paidThisKy(m.id) && !pendingThisKy(m.id),
          }),
        );
      }
    });
    return rows;
  };

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

  const codeOf = (row: MeterRow) => draft[row.key]?.code ?? row.persistedCode;
  const holderOf = (row: MeterRow) => draft[row.key]?.holder ?? row.persistedHolder;
  const amountOf = (key: string) => amounts[key] ?? 0;

  const setField = (row: MeterRow, patch: Partial<{ code: string; holder: string }>) =>
    setDraft((d) => ({ ...d, [row.key]: { code: codeOf(row), holder: holderOf(row), ...patch } }));
  const setAmount = (key: string, v: number) => setAmounts((a) => ({ ...a, [key]: v }));
  const setBook = (key: string, id: string) => setBookSel((s) => ({ ...s, [key]: id }));

  const saveMeter = (row: MeterRow) => {
    const code = codeOf(row).trim();
    const holder = holderOf(row).trim();
    if (row.accountId) {
      if (code === (row.persistedCode ?? '') && holder === (row.persistedHolder ?? '')) return;
      saveMeterMut.mutate({ id: row.accountId, buildingId: row.buildingId, type: row.type, code, holder });
    } else {
      if (!code && !holder) return; // dòng synthetic trống → chưa tạo
      saveMeterMut.mutate({ id: null, buildingId: row.buildingId, type: row.type, code, holder });
    }
  };

  const addMeter = (buildingId: string, type: UtilType) => {
    addMeterMut.mutate({ buildingId, type }, {
      onError: (e) => toast.error((e as Error).message),
    });
  };

  const typeText = (t: UtilType) => (t === 'electric' ? 'điện' : 'nước');

  /**
   * Khai công tơ cho dòng tổng hợp (synthetic) — thay cho nhánh "server tự tạo
   * công tơ trong im lặng" (§−1.5). Có gõ mã/chủ hộ thì tạo kèm luôn.
   */
  const createMeter = async (row: MeterRow) => {
    if (!row.isSynthetic) return;
    try {
      await saveMeterMut.mutateAsync({
        id: null, buildingId: row.buildingId, type: row.type,
        code: codeOf(row).trim(), holder: holderOf(row).trim(),
      });
      toast.success(`Đã tạo công tơ ${typeText(row.type)} — ${row.buildingName}. Giờ mới đóng tiền được.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const deleteMeter = async (accountId: string) => {
    try {
      await deleteMeterMut.mutateAsync(accountId);
      toast.success('Đã xoá đồng hồ');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** Upload 1 file cho khoản `k` — dùng chung cho chọn file lẫn Ctrl+V. */
  const attachFile = useCallback(async (k: string, file: File) => {
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
  }, []);
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const k = attachKeyRef.current;
    if (!file || !k) return;
    await attachFile(k, file);
  };

  // Ctrl+V ảnh chứng từ: đích là dòng đang RÊ CHUỘT, hoặc dòng vừa bấm ô Số
  // tiền. Đích nằm ở biến module (xem useReceiptPasteTarget) vì panel desktop
  // và sheet mobile cùng mount hook này → 2 instance tranh event 'paste'.
  const uploadingRef = useRef<string | null>(null);
  uploadingRef.current = uploadingKey;
  const { setActiveKey, pasteProps } = useReceiptPasteTarget((k, file) => {
    if (uploadingRef.current) return;
    void attachFile(k, file);
  });

  const onAttachClick = (key: string) => {
    if (uploadingKey) return;
    attachKeyRef.current = key;
    setActiveKey(key);
    fileRef.current?.click();
  };

  /**
   * Ô vừa gửi phiếu xong nhưng reader chưa refetch kịp — trả số tiền vừa gửi.
   * Tự tan khi reader đã thấy phiếu (đã duyệt HOẶC chờ duyệt).
   */
  const justPaidThisKy = (accountId: string | null | undefined): number | undefined => {
    if (!accountId) return undefined;
    const k = `${billingMonth}::${accountId}`;
    const amt = utilityJustPaid.get(k);
    if (amt == null) return undefined;
    if (paidThisKy(accountId) || pendingThisKy(accountId)) { utilityJustPaid.delete(k); return undefined; }
    return amt;
  };

  const submitPay = async (row: MeterRow, name: string) => {
    // §−1.5: KHÔNG BAO GIỜ gửi p_utility_account_id = null. Server (WS-B) cũng
    // từ chối, nhưng chặn ở đây mới nói được câu tiếng Việt tử tế.
    if (!row.accountId) {
      toast.error(
        `${row.buildingName} chưa khai công tơ ${typeText(row.type)}. Bấm "Tạo công tơ" trên dòng này rồi mới đóng tiền được.`,
        { duration: 8_000 },
      );
      return;
    }
    const amount = amountOf(row.key);
    if (amount <= 0) { toast.error('Nhập số tiền cần đóng'); return; }
    const lock = `${billingMonth}::${row.key}`;
    if (utilityInflight.has(lock)) {
      toast.error('Đang gửi phiếu cho đồng hồ này — chờ kết quả rồi hãy bấm lại.');
      return;
    }
    if (justPaidThisKy(row.accountId) != null) {
      toast.error(`Vừa tạo phiếu ${typeText(row.type)} cho đồng hồ này ở kỳ ${billingMonth} — chờ danh sách cập nhật.`);
      return;
    }
    utilityInflight.add(lock);
    setPayingKey(row.key);
    try {
      await payMut.mutateAsync({
        buildingId: row.buildingId, type: row.type, billingMonth, amount,
        code: codeOf(row).trim(), holder: holderOf(row).trim(),
        accountId: bookSel[row.key] ?? null,
        utilityAccountId: row.accountId,
        attachments: attach[row.key] ? [attach[row.key]] : undefined,
      });
      utilityJustPaid.set(`${billingMonth}::${row.accountId}`, amount);
      setAmounts((a) => { const n = { ...a }; delete n[row.key]; return n; });
      setAttach((a) => { const n = { ...a }; delete n[row.key]; return n; });
      toast.success(`Đã chi ${fmtFull(amount)} tiền ${typeText(row.type)} · ${name}`);
    } catch (ex) {
      toast.error((ex as Error).message);
    } finally {
      utilityInflight.delete(lock);
      setPayingKey(null);
      bumpUtility();
    }
  };

  // Huỷ được cả phiếu ĐÃ DUYỆT và phiếu CHỜ DUYỆT: phiếu chờ duyệt chiếm slot
  // (toà × loại × kỳ) nên không có lối huỷ là ô kẹt cho tới khi ai đó đi duyệt.
  const requestCancel = (row: MeterRow) => {
    const v = paidThisKy(row.accountId) ?? pendingThisKy(row.accountId);
    if (!v) return;
    setCancelTarget({
      voucherId: v.voucherId,
      bld: row.buildingName,
      typeText: typeText(row.type),
      amount: v.amount,
      dateText: fmtDate(v.date),
      timeText: v.time,
      by: v.by,
      book: v.book,
    });
  };
  const confirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelMut.mutateAsync(cancelTarget.voucherId);
      // Bỏ cờ "vừa tạo phiếu" của mọi đồng hồ — phiếu vừa huỷ phải cho đóng lại
      // ngay, không bị cờ cũ chặn (cờ khoá theo meter, huỷ thì reader trả rỗng).
      for (const k of [...utilityJustPaid.keys()]) if (k.startsWith(billingMonth + '::')) utilityJustPaid.delete(k);
      bumpUtility();
      toast.success('Đã hủy phiếu thanh toán');
      setCancelTarget(null);
    } catch (ex) {
      toast.error((ex as Error).message);
    }
  };

  return {
    // data
    metersOf, paidThisKy, pendingThisKy, noMeterThisKy, justPaidThisKy, byDay, loadingPay, loadingAccts,
    myBooks, defaultBookId,
    // per-row getters/setters
    codeOf, holderOf, amountOf, setField, setAmount,
    bookSel, setBook, attach, uploadingKey, saveMeter,
    payingKey, submitPay,
    // meters
    addMeter, adding: addMeterMut.isPending, deleteMeter, deleting: deleteMeterMut.isPending,
    createMeter, creatingMeter: saveMeterMut.isPending,
    // attach input (pasteProps: spread vào dòng để rê chuột + Ctrl+V dán ảnh)
    fileRef, onFileChange, onAttachClick, setActiveKey, pasteProps,
    // cancel
    cancelTarget, requestCancel, confirmCancel, cancelling: cancelMut.isPending,
    closeCancel: () => setCancelTarget(null),
    // xem ảnh phiếu chi (lightbox)
    receiptView,
    viewReceipt: (attachments: string[], index = 0) => {
      if (attachments && attachments.length) setReceiptView({ attachments, index });
    },
    setReceiptIndex: (index: number | null) => setReceiptView((v) => ({ ...v, index })),
  };
}

export type { PaidInfo };
