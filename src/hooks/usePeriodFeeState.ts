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
//
// V3 (30/07 — Slice −1 §−1.6): STATE NHẬP LIỆU RA KHO DÙNG CHUNG.
//   /thanh-toan mount ĐỒNG THỜI PeriodFeePanel (cột trái) và PeriodFeeSheet
//   (khung điện thoại) — đó là CHỦ Ý sản phẩm, có spec bảo vệ
//   (.e2e-fleet/specs/thanh-toan-page.spec.ts:20/:27/:32 assert cả hai cùng
//   render; :143 assert panel chỉ bị CSS ẩn ở <1024px). Nhưng trước V3 mỗi bề
//   mặt gọi hook này riêng nên `amounts/bookSel/attach/payingKey` là HAI Record
//   độc lập ⇒ cùng một (toà × hạng mục × kỳ) đóng được HAI lần.
//   Hình dạng lỗi đã xảy ra thật trên production: PC2606046 + PC2606047,
//   'tiền nhà 102LVT', 66.000.000đ ×2, cùng người tạo, cùng voucher_date, cả hai
//   APPROVED+POSTED, cách nhau 460ms.
//   ⚠ ĐÍNH CHÍNH (đo lại 30/07): cặp đó mang `system_source = NULL` ⇒ do đường
//   TẠO PHIẾU CHUNG bên Thu chi, KHÔNG do `pay_period_fee`/lưới phí cố định này
//   (hàm đó đóng dấu 'fixed_fee', và cả DB chỉ có 2 phiếu 'fixed_fee', không
//   trùng nhau). 23 slot phí cố định trùng trên prod = 20 slot NULL + 3 slot
//   'utility.bill', 0 slot 'fixed_fee'. Vậy V3 + khoá slot của pay_period_fee
//   chặn ĐƯỜNG GHI CỦA CHÍNH TRANG NÀY; writer phiếu chung vẫn hở, đừng ghi nhận
//   là "đã bịt lỗ 23 slot".
//   Nay các Record đó nằm ở KHO NGOÀI REACT khoá theo (hạng mục | kỳ):
//     • hai bề mặt đang cùng hạng mục ⇒ đọc/ghi CÙNG một ô nhớ;
//     • hai bề mặt khác hạng mục ⇒ khoá khác nhau nên KHÔNG lây tiền chéo
//       (giữ đúng FIX P0 leak của V2, nay bằng cấu trúc chứ không bằng reset);
//     • một chốt in-flight ĐỒNG BỘ (Set, không qua React state) + cờ `justPaid`
//       chặn cú bấm thứ hai trong khe 460ms giữa lúc RPC trả về và lúc reader
//       refetch xong.
//   KHÔNG hoist theo kiểu unmount một bề mặt theo breakpoint — làm vậy là làm
//   đỏ chính spec ở trên. Cũng KHÔNG đụng `useReceiptPasteTarget` (arbitration
//   cấp module đã đúng, có spec hồi quy riêng).
//   Modal (edit/cancel/dup/draftpay) CỐ TÌNH giữ LOCAL từng bề mặt: mỗi bề mặt
//   render bộ modal của mình, dùng chung state là mở hai hộp thoại xếp lớp.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { getSessionUser } from '@/lib/authSession';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { useAccounts } from '@/hooks/useAccounts';
import { useUiPreferences, useSetUiPreference } from '@/hooks/useUiPreferences';
import { useReceiptPasteTarget } from '@/hooks/useReceiptPasteTarget';
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
  /**
   * TỔNG CẢ PHIẾU (`voucherTotal`), không phải phần thuộc hạng mục đang xem:
   * `update_period_fee` ghi lại `p_amount` thành số tiền CỦA PHIẾU, nên seed bằng
   * số một-phần là mời người dùng thu nhỏ phiếu mà tưởng chỉ sửa hạng mục.
   */
  amount: number;
  /** = amount; giữ tường minh để so với `itemAmount` khi phiếu đa hạng mục. */
  voucherTotal: number;
  /** Phần thuộc hạng mục đang xem (Σ item khớp) — chỉ để hiển thị đối chiếu. */
  itemAmount: number;
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
  /**
   * Quyền "Đóng thêm" theo lời SERVER (khoá `can_force` của payload cảnh báo trùng),
   * đã lùi về cờ `canForce` của UI nếu server bản cũ không trả. Giữ lại trong đối
   * tượng này để lần bấm xác nhận dùng ĐÚNG câu trả lời đã mở hộp thoại.
   */
  canForce: boolean;
}

/** Thanh toán phiếu NHÁP. */
export interface DraftPayTarget {
  voucher: PeriodFeeVoucher;
  buildingId: string;
  buildingName: string;
  categoryLabel: string;
}

/** Ô vừa gửi RPC xong nhưng reader chưa kịp thấy phiếu (khe refetch). */
export interface JustPaidMark {
  amount: number;
  /** true = phiếu thứ 2+ do chủ xác nhận đóng thêm. */
  force: boolean;
}

// ── KHO STATE DÙNG CHUNG (module-level) ─────────────────────────────────────
// Khoá = `${hạng mục}|${kỳ}`. Cùng khuôn với `useReceiptPasteTarget`: hai
// instance hook trên cùng một màn hình phải nói chuyện với nhau qua biến module,
// vì React state không đi xuyên hai cây con.
interface FeeSlot {
  amounts: Record<string, number>;
  bookSel: Record<string, string>;
  attach: Record<string, string>;
  periodN: Record<string, number>;
  draft: Record<string, { code: string; holder: string }>;
  payingKey: string | null;
  justPaid: Record<string, JustPaidMark>;
}

const EMPTY_SLOT: FeeSlot = Object.freeze({
  amounts: {}, bookSel: {}, attach: {}, periodN: {}, draft: {},
  payingKey: null, justPaid: {},
}) as FeeSlot;

const slotStore = new Map<string, FeeSlot>();
const slotSubs = new Map<string, Set<() => void>>();
const slotRefs = new Map<string, number>();
/** Chốt ĐỒNG BỘ theo `${scope}::${buildingId}` — chống re-entry trước cả re-render. */
const inflightPays = new Set<string>();

const readSlot = (scope: string): FeeSlot => slotStore.get(scope) ?? EMPTY_SLOT;

const writeSlot = (scope: string, patch: (s: FeeSlot) => FeeSlot) => {
  slotStore.set(scope, patch(readSlot(scope)));
  slotSubs.get(scope)?.forEach((fn) => fn());
};

const subscribeSlot = (scope: string, fn: () => void) => {
  let set = slotSubs.get(scope);
  if (!set) { set = new Set(); slotSubs.set(scope, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) slotSubs.delete(scope);
  };
};

// Đếm consumer để BIẾT KHI NÀO được xoá ô nhớ: đổi hạng mục/kỳ trong khi bề mặt
// kia vẫn ở hạng mục cũ thì KHÔNG được xoá (bên kia đang gõ dở). Về 0 mới xoá —
// giữ đúng hành vi "đổi hạng mục là reset sạch" của V2.
const retainSlot = (scope: string) => slotRefs.set(scope, (slotRefs.get(scope) ?? 0) + 1);
const releaseSlot = (scope: string) => {
  const n = (slotRefs.get(scope) ?? 1) - 1;
  if (n > 0) { slotRefs.set(scope, n); return; }
  slotRefs.delete(scope);
  slotStore.delete(scope);
  // CỐ TÌNH không dọn `inflightPays` ở đây: chốt phải sống đến khi RPC trả về
  // (doPay tự xoá trong finally). Dọn sớm = mở lại đúng khe re-entry cần chặn
  // cho ca "đổi hạng mục qua-lại trong lúc phiếu đang bay".
};

export function usePeriodFeeState(
  period: string,
  category: FeeCategory,
  buildings: { id: string; name: string }[],
  statusOf: (buildingId: string, categoryKey: string) => PeriodFeeStatus | undefined,
  accountOf: (buildingId: string, feeCategory: string) => FeeAccount | undefined,
  opts?: {
    /**
     * Được phép gửi `p_force=true` (đóng THÊM cho kỳ đã có phiếu). Chỉ chủ tổ
     * chức / superadmin — server cũng siết đúng lối này, cờ đây chỉ để không
     * mời người khác bấm một nút chắc chắn bị từ chối.
     */
    canForce?: boolean;
  },
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
  const canForce = !!opts?.canForce;

  // ── State NHẬP LIỆU: kho dùng chung, khoá theo (hạng mục | kỳ) ──
  const scope = `${key}|${period}`;
  const slot = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeSlot(scope, cb), [scope]),
    useCallback(() => readSlot(scope), [scope]),
    useCallback(() => readSlot(scope), [scope]),
  );
  useEffect(() => {
    retainSlot(scope);
    return () => releaseSlot(scope);
  }, [scope]);
  const { amounts, bookSel, attach, periodN, draft, payingKey } = slot;
  const patch = (p: (s: FeeSlot) => Partial<FeeSlot>) =>
    writeSlot(scope, (s) => ({ ...s, ...p(s) }));

  // ── State CỦA RIÊNG BỀ MẶT (modal + spinner upload) ──
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  // Toà của phiếu đang chờ xác nhận huỷ. CancelTarget (dùng chung với Điện &
  // Nước) chỉ mang TÊN toà, mà cờ `justPaid` khoá theo id ⇒ phải giữ id riêng,
  // xem confirmCancel.
  const [cancelBId, setCancelBId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<FeeEditTarget | null>(null);
  const [dupConfirm, setDupConfirm] = useState<DupConfirm | null>(null);
  const [draftTarget, setDraftTarget] = useState<DraftPayTarget | null>(null);

  // Đổi hạng mục / kỳ → đóng modal đang treo. Input KHÔNG cần reset ở đây nữa:
  // đổi scope là đổi ô nhớ, và ô cũ bị xoá khi không còn bề mặt nào dùng.
  useEffect(() => {
    setEditTarget(null); setCancelTarget(null); setCancelBId(null); setDupConfirm(null); setDraftTarget(null);
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

  const setField = (bId: string, p: Partial<{ code: string; holder: string }>) =>
    patch((s) => ({ draft: { ...s.draft, [bId]: { code: codeOf(bId), holder: holderOf(bId), ...p } } }));
  const setAmount = (bId: string, v: number) =>
    patch((s) => ({ amounts: { ...s.amounts, [bId]: v } }));
  const setBook = (bId: string, id: string) =>
    patch((s) => ({ bookSel: { ...s.bookSel, [bId]: id } }));
  const setN = (bId: string, n: number) =>
    patch((s) => ({ periodN: { ...s.periodN, [bId]: Math.max(1, Math.min(36, Math.round(n) || 1)) } }));

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

  /** Upload + gắn 1 ảnh theo chế độ — dùng chung cho chọn file lẫn Ctrl+V. */
  const runReceiptUpload = async (file: File, mode: string, bId: string | null) => {
    const err = validateReceiptFile(file);
    if (err) { toast.error(err); return; }
    const busyKey = mode === 'edit' ? '__edit__' : mode === 'draftpay' ? '__draftpay__'
      : mode.startsWith('quick:') ? `__quick__${bId}` : bId;
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
        patch((s) => ({ attach: { ...s.attach, [bId!]: url } }));
        toast.success('Đã đính kèm ảnh phiếu');
      }
    } catch (ex) { toast.error('Không tải được ảnh: ' + (ex as Error).message); }
    finally { setUploadingKey(null); }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await runReceiptUpload(file, attachModeRef.current, attachKeyRef.current);
  };

  // Ctrl+V ảnh chứng từ trên dòng đang RÊ CHUỘT. Key mã hoá luôn chế độ:
  //   'pay:<bId>'               → ảnh cho phiếu sắp đóng
  //   'quick:<bId>:<voucherId>' → đính thẳng vào phiếu đã có (append server-side)
  const uploadingRef = useRef<string | null>(null);
  uploadingRef.current = uploadingKey;
  const { pasteProps } = useReceiptPasteTarget((target, file) => {
    if (uploadingRef.current) return;
    const [mode, bId, voucherId] = target.split(':');
    void runReceiptUpload(file, mode === 'quick' ? `quick:${voucherId}` : 'pay', bId);
  });
  /** Spread vào dòng/thẻ 1 tòa — rê chuột tới đâu, Ctrl+V đính ảnh vào đó. */
  const rowPasteProps = (bId: string, voucherId?: string | null) =>
    pasteProps(voucherId ? `quick:${bId}:${voucherId}` : `pay:${bId}`);

  // ── Đóng tiền (TỔNG cả khoảng; chống trùng 2 bước) ──
  //
  // Ô "vừa tạo phiếu": RPC đã trả về nhưng reader (get_period_fee_status) chưa
  // refetch xong. Khe đó dài cỡ vài trăm ms — đúng khe đã sinh PC2606046/47 cách
  // nhau 460ms. Trong khe này ô phải hiện "đã tạo" và KHÔNG cho bấm nữa. Không
  // dùng hẹn giờ: cờ tự tan ngay khi reader thấy phiếu (paid/draft > 0).
  const justPaidOf = (bId: string): JustPaidMark | undefined => {
    const mark = slot.justPaid[bId];
    if (!mark) return undefined;
    const st = statusOf(bId, key);
    if (st && (st.paidAmount > 0 || st.draftAmount > 0)) return undefined;
    return mark;
  };

  const doPay = async (bId: string, force: boolean) => {
    // Chốt đồng bộ: chặn cú bấm thứ hai (bề mặt kia, hoặc double-click) NGAY,
    // không chờ re-render như `disabled` của nút.
    const lock = `${scope}::${bId}`;
    if (inflightPays.has(lock)) {
      toast.error('Đang gửi phiếu cho ô này — chờ kết quả rồi hãy bấm lại.');
      return;
    }
    if (!force && justPaidOf(bId)) {
      toast.error(`Vừa tạo phiếu cho ${buildingName(bId)} ở kỳ này — chờ danh sách cập nhật, đừng bấm lại.`);
      return;
    }
    const amount = amountOf(bId);
    const n = nOf(bId);
    const periodEnd = addMonths(period, n - 1);
    const accountId = bookSel[bId] ?? defaultBookFor(bId) ?? null;
    inflightPays.add(lock);
    patch(() => ({ payingKey: bId }));
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
        // Kỳ đã có phiếu. `p_force` là đặc quyền của chủ/superadmin — người khác
        // KHÔNG được mời bấm "Đóng thêm" (server cũng từ chối), chỉ được báo rõ.
        //
        // AI TRẢ LỜI "có được đóng thêm không?" — SERVER, không phải UI. `can_force`
        // là chính vị ngữ của cổng chặn (`is_super_admin() OR is_org_owner_v1(org
        // của TOÀ, uid)`), nên nó không lệch được với hàng rào. Cờ `canForce` của
        // UI chỉ còn là dự phòng cho thân hàm CŨ (chưa có khoá này): `??` chứ không
        // `||`/`!!`, vì `can_force === false` là câu trả lời DỨT KHOÁT của server và
        // phải thắng cờ lạc quan của client.
        const mayForce = res.can_force ?? canForce;
        if (!mayForce) {
          toast.error(
            `${buildingName(bId)} đã có ${res.existing_count ?? 1} phiếu ${category.label.toLowerCase()} ` +
            `trong kỳ (tổng ${fmtFull(res.existing_amount ?? 0)}). Xem tab Lịch sử; muốn đóng THÊM phải nhờ chủ tổ chức.`,
            { duration: 10_000 },
          );
          return;
        }
        setDupConfirm({
          buildingId: bId, buildingName: buildingName(bId), amount,
          existingAmount: res.existing_amount ?? 0,
          existingCount: res.existing_count ?? 1,
          canForce: mayForce,
        });
        return;
      }
      patch((s) => {
        const nextAmounts = { ...s.amounts }; delete nextAmounts[bId];
        const nextAttach = { ...s.attach }; delete nextAttach[bId];
        return {
          amounts: nextAmounts,
          attach: nextAttach,
          justPaid: { ...s.justPaid, [bId]: { amount, force } },
        };
      });
      if (accountId) rememberBook(bId, accountId);
      toast.success(`Đã chi ${fmtFull(amount)} — ${category.label} · ${buildingName(bId)}`);
    } catch (ex) { toast.error((ex as Error).message); }
    finally {
      inflightPays.delete(lock);
      patch((s) => (s.payingKey === bId ? { payingKey: null } : {}));
    }
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
    // Hàng rào thứ hai: dialog chỉ mở cho chủ, nhưng nếu quyền bị rút giữa lúc
    // hộp thoại đang mở thì cũng không được gửi force. Dùng câu trả lời của SERVER
    // đã mở hộp thoại này (dupConfirm.canForce), không dùng lại cờ đoán của UI —
    // cờ UI là is_admin()/is_super_admin() nên chính nó là chỗ khoá chủ ra ngoài.
    if (!dupConfirm.canForce) {
      toast.error('Chỉ chủ tổ chức / superadmin được đóng thêm cho kỳ đã có phiếu.');
      return;
    }
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
    setCancelBId(bId);
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
    const bId = cancelBId;
    try {
      await cancelMut.mutateAsync(cancelTarget.voucherId);
      // BỎ CỜ "vừa tạo phiếu" của ĐÚNG toà vừa huỷ. Không bỏ là ô kẹt vĩnh viễn:
      // `justPaidOf` chỉ ẩn cờ khi reader thấy paid/draft > 0, mà cancel_period_fee
      // đặt deleted_at nên reader trả về 0 lại ⇒ cờ cũ hiện lên, ô render "đã tạo
      // phiếu — đang cập nhật danh sách" + badge ĐÃ TẠO, không còn nút đóng, và
      // doPay từ chối "đừng bấm lại". Cờ chỉ chết khi ô nhớ dùng chung hết
      // consumer (đổi kỳ / tải lại trang) — trong khi chính thông báo lỗi lại bảo
      // "phiếu cũ sai thì HUỶ nó rồi đóng lại". useUtilityPayState.confirmCancel
      // đã dọn cờ tương ứng của Điện & Nước; đây là chỗ đối xứng còn thiếu.
      // Chỉ xoá cờ của toà này, KHÔNG xoá cả scope: toà khác đang trong khe
      // refetch phải giữ chốt chống bấm hai lần.
      if (bId) patch((s) => {
        if (!s.justPaid[bId]) return {};
        const next = { ...s.justPaid };
        delete next[bId];
        return { justPaid: next };
      });
      toast.success('Đã hủy phiếu chi');
      setCancelTarget(null);
      setCancelBId(null);
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
      amount: v.voucherTotal,
      voucherTotal: v.voucherTotal,
      itemAmount: v.amount,
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
    codeOf, holderOf, amountOf, defaultAmountOf, nOf, paidOf, vouchersOf, justPaidOf,
    setField, setAmount, setBook, setN, saveConfig, saveExpected, setNotApplicable,
    bookSel, attach, uploadingKey, payingKey, canForce,
    fileRef, onFileChange, onAttachClick, onEditAttachClick, onQuickAttachClick, onDraftPayAttachClick,
    rowPasteProps,
    submitPay,
    dupConfirm, confirmPayDup, closeDupConfirm: () => setDupConfirm(null),
    draftTarget, draftPayAttachments, openPayDraft, submitPayDraft,
    closePayDraft: () => { setDraftTarget(null); setDraftPayAttachments([]); },
    payingDraft: payDraftMut.isPending,
    cancelTarget, requestCancel, confirmCancel, cancelling: cancelMut.isPending,
    closeCancel: () => { setCancelTarget(null); setCancelBId(null); },
    editTarget, openEdit, submitEdit, closeEdit: () => setEditTarget(null),
    saving: updateMut.isPending,
  };
}
