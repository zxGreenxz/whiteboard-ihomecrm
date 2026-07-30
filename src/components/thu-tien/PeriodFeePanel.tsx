// =============================================================================
// PeriodFeePanel V2 — panel DESKTOP "Đóng tiền Tập trung theo Kỳ" (cột trái).
// Ô chọn LOẠI PHÍ → family: Tổng quan · Điện & Nước (EN) · GRID · Hoa hồng ·
// Bảo trì. V2 (10/07): 3 trạng thái ô (chưa đóng / CHỜ DUYỆT chờ thanh toán / đã
// đóng), sửa/hủy/ảnh theo TỪNG phiếu, chống đóng trùng, cờ Không-áp-dụng,
// thang máy hiện theo phiếu, ẩn Quản Lý theo quyền, tab Lịch sử, HH modal
// Chờ duyệt|Chi&duyệt + nhắc kỳ trước, form bảo trì đủ sổ/ngày/ảnh.
// =============================================================================

import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, X, ChevronDown, Check, Camera, ArrowRight, Lock, Info, Plus, Trash2,
  HandCoins, Edit3, Calendar, Ban, Pencil, History, ListChecks,
} from 'lucide-react';
import { toast } from 'sonner';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';
import { useBuildings } from '@/hooks/useBuildings';
import { useIsAdmin, useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { useIsOrgOwner } from '@/hooks/useIsOrgOwner';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import {
  usePeriodFeeStatus, useFeeAccounts, usePeriodCommissions, usePeriodMaintenance,
  type PeriodCommissionRow, type PeriodFeeVoucher,
} from '@/hooks/usePeriodFees';
import { usePeriodFeeState, addMonths, rangeLabel } from '@/hooks/usePeriodFeeState';
import { useCreateMaintenanceBatch, type MaintenanceBatchLine } from '@/hooks/useMaintenanceBatch';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';
import { FEE_CATEGORIES, FEE_GROUPS, feeCategoryOf, gridKeysFor, type FeeCategory } from '@/lib/feeCategories';
import { FeeIcon } from './feeIcons';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityCancelModal } from './UtilityCancelModal';
import { UtilityReceiptThumb } from './UtilityReceiptThumb';
import { PeriodFeeEditModal } from './PeriodFeeEditModal';
import { PeriodFeeVoucherList, PeriodFeePayDraftModal, PeriodFeeDupConfirmModal } from './PeriodFeeVoucherList';
import { PeriodCommissionModal } from './PeriodCommissionModal';
import { UtilityEnContent } from './UtilityEnContent';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { BookIcon } from './utilityIcons';
import { usePersistedState } from '@/hooks/usePersistedState';

interface Props {
  billingMonth: string;
  onBillingMonthChange: (m: string) => void;
  onClose: () => void;
  canRecordPayment: boolean;
}

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => { const d = s.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };
const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const N_OPTIONS = [1, 3, 6, 12];

export function PeriodFeePanel({ billingMonth, onBillingMonthChange, onClose, canRecordPayment }: Props) {
  const period = billingMonth;
  const { data: allBuildings = [], isLoading: loadingBld } = useIncomeExpenseFormBuildings();
  const buildings = useMemo(() => allBuildings.filter((b) => !b.is_virtual).map((b) => ({ id: b.id, name: b.name })), [allBuildings]);
  const buildingIds = useMemo(() => buildings.map((b) => b.id), [buildings]);

  const { data: rawBuildings = [] } = useBuildings();
  const elevatorIds = useMemo(() => new Set(rawBuildings.filter((b: any) => b.has_elevator).map((b: any) => b.id)), [rawBuildings]);

  const { data: isAdminFlag } = useIsAdmin();
  const { data: isSuperFlag } = useIsSuperAdmin();
  const isAdmin = !!isAdminFlag || !!isSuperFlag;
  // Cổng "Đóng thêm" của server là `is_super_admin() OR is_org_owner_v1(org,uid)`.
  // `isAdmin` KHÔNG mirror được nó: public.is_admin() nay chỉ còn
  // `SELECT public.is_super_admin()` (xem useIsOrgOwner).
  const { data: isOrgOwnerFlag } = useIsOrgOwner();
  const canForceFee = !!isSuperFlag || !!isOrgOwnerFlag;
  const { data: perms } = useMyPermissions();
  // Quản Lý (hạn chế): ẩn hẳn với người thiếu quyền xem (đã chốt).
  const canRestricted = isAdmin || canUse(perms, 'income_expenses', 'restricted_view');
  const visibleCats = useMemo(() => FEE_CATEGORIES.filter((c) => !c.restricted || canRestricted), [canRestricted]);
  const gridKeys = useMemo(() => gridKeysFor(canRestricted), [canRestricted]);

  const [category, setCategory] = usePersistedState<string>('flt:thu-tien:fee-cat', 'overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [bldFilter, setBldFilter] = useState('all');
  const [onlyDue, setOnlyDue] = useState(false);
  const [gridTab, setGridTab] = useState<'pay' | 'history'>('pay');
  const [naOpen, setNaOpen] = useState(false);
  const [expectedEdit, setExpectedEdit] = useState<{ bId: string; value: number } | null>(null);
  const [vlistFor, setVlistFor] = useState<string | null>(null);   // buildingId đang mở danh sách phiếu
  const [commRow, setCommRow] = useState<PeriodCommissionRow | null>(null);
  const [viewer, setViewer] = useState<{ attachments: string[]; index: number | null }>({ attachments: [], index: null });
  const onView = (atts: string[]) => { if (atts.length) setViewer({ attachments: atts, index: 0 }); };

  const cat = feeCategoryOf(category);
  const catVisible = cat && (!cat.restricted || canRestricted);
  const isOverview = category === 'overview' || !catVisible;
  const isEN = catVisible && cat!.family === 'EN';
  const isGrid = catVisible && cat!.family === 'GRID';
  const isComm = catVisible && cat!.family === 'COMMISSION';
  const isBatch = catVisible && cat!.family === 'MAINTENANCE_BATCH';

  // ── Data ──
  const feeStatus = usePeriodFeeStatus(period, gridKeys, buildingIds, { enabled: buildingIds.length > 0 });
  const feeAccounts = useFeeAccounts();
  const commissions = usePeriodCommissions(period, buildingIds, { enabled: buildingIds.length > 0 && (isOverview || isComm) });
  const prevPeriod = addMonths(period, -1);
  const prevCommissions = usePeriodCommissions(prevPeriod, buildingIds, { enabled: buildingIds.length > 0 && isComm });
  const maintenance = usePeriodMaintenance(period, buildingIds, { enabled: buildingIds.length > 0 && (isOverview || isBatch) });

  const gridCat = isGrid ? cat! : FEE_CATEGORIES.find((c) => c.family === 'GRID')!;
  // canForce: `p_force` (đóng THÊM cho kỳ đã có phiếu) là đặc quyền chủ tổ chức /
  // superadmin. Cờ này CHỈ là phỏng đoán TRƯỚC khi gọi RPC (super admin ∪ chủ ở
  // BẤT KỲ org — is_org_owner_self_v1 không nhận org), dùng để không mời người
  // chắc chắn bị từ chối bấm. Câu trả lời THẬT do server nói trong payload cảnh
  // báo trùng (`can_force`, cùng vị ngữ với cổng chặn và siết theo ĐÚNG org của
  // toà); usePeriodFeeState ưu tiên khoá đó và chỉ lùi về cờ này khi server bản
  // cũ không trả. Trước Slice −1 nó truyền `isAdmin`, mà is_admin() =
  // is_super_admin() nên CHỦ TỔ CHỨC THẬT không phải super admin bị khoá khỏi
  // chính đặc quyền của mình.
  const S = usePeriodFeeState(period, gridCat, buildings, feeStatus.statusOf, feeAccounts.accountOf, { canForce: canForceFee });

  // ── Helper: tòa hiển thị cho 1 hạng mục (thang máy = cờ ∪ tòa có phiếu kỳ này) ──
  const visibleIdsFor = (c: FeeCategory): string[] => {
    if (!c.elevatorGated) return buildingIds;
    return buildingIds.filter((id) => {
      if (elevatorIds.has(id)) return true;
      const st = feeStatus.statusOf(id, c.serverKey);
      return !!st && (st.paidAmount > 0 || st.draftAmount > 0);
    });
  };
  /** Tòa CÒN TÍNH (bỏ Không-áp-dụng). */
  const activeIdsFor = (c: FeeCategory): string[] =>
    visibleIdsFor(c).filter((id) => !feeStatus.statusOf(id, c.serverKey)?.notApplicable);

  const dueCountFor = (c: FeeCategory): number => {
    if (c.family === 'EN') {
      let n = 0;
      for (const b of buildingIds) { if (!(feeStatus.statusOf(b, 'dien')?.paidAmount)) n++; if (!(feeStatus.statusOf(b, 'nuoc')?.paidAmount)) n++; }
      return n;
    }
    if (c.family === 'GRID') return activeIdsFor(c).filter((id) => !(feeStatus.statusOf(id, c.serverKey)?.paidAmount)).length;
    if (c.family === 'COMMISSION') return (commissions.data ?? []).filter((r) => r.status !== 'paid').length;
    return 0;
  };

  // ── Tổng quan ──
  const overview = useMemo(() => {
    let dueCount = 0, slots = 0, dueSum = 0, paidSum = 0, paidCount = 0, draftCount = 0;
    const dueBld = new Set<string>();
    const nameOf = (id: string) => buildings.find((b) => b.id === id)?.name ?? id;
    const rows = visibleCats.map((c) => {
      let total = 0, paidN = 0, rowDueSum = 0, rowPaidSum = 0, rowDraftN = 0; const dueList: string[] = [];
      if (c.family === 'EN') {
        for (const b of buildingIds) {
          for (const kind of ['dien', 'nuoc'] as const) {
            const st = feeStatus.statusOf(b, kind);
            if (st?.notApplicable) continue;
            total++;
            if (st && st.paidAmount > 0) { paidN++; rowPaidSum += st.paidAmount; }
            else { rowDueSum += st?.expectedAmount ?? 0; if (!dueList.includes(nameOf(b))) dueList.push(nameOf(b)); dueBld.add(b); }
          }
        }
      } else if (c.family === 'GRID') {
        for (const b of activeIdsFor(c)) {
          const st = feeStatus.statusOf(b, c.serverKey);
          total++;
          if (st && st.paidAmount > 0) { paidN++; rowPaidSum += st.paidAmount; }
          else {
            if (st && st.draftAmount > 0) { rowDraftN++; rowDueSum += st.draftAmount; }
            else rowDueSum += st?.expectedAmount ?? 0;
            dueList.push(nameOf(b)); dueBld.add(b);
          }
        }
      } else if (c.family === 'COMMISSION') {
        for (const r of commissions.data ?? []) {
          total++;
          if (r.status === 'paid') { paidN++; rowPaidSum += r.voucherAmount ?? r.expectedAmount; }
          else {
            if (r.status === 'draft') rowDraftN++;
            rowDueSum += r.status === 'draft' ? (r.voucherAmount ?? r.expectedAmount) : r.expectedAmount;
            if (!dueList.includes(r.buildingName)) dueList.push(r.buildingName);
          }
        }
      } else if (c.family === 'MAINTENANCE_BATCH') {
        // Slice −1 A3a: reader nay trả CẢ phiếu CHỜ DUYỆT. Chúng là "đã có phiếu"
        // nhưng KHÔNG phải "đã chi" — cộng vào rowPaidSum là đếm tiền chưa duyệt
        // như đã tiêu.
        const lines = maintenance.data ?? [];
        total = lines.length;
        paidN = lines.filter((l) => !l.pending).length;
        for (const l of lines) {
          if (l.pending) { rowDraftN++; rowDueSum += l.amount; }
          else rowPaidSum += l.amount;
        }
      }
      const dueN = total - paidN;
      dueCount += dueN; slots += total; dueSum += rowDueSum; paidSum += rowPaidSum; paidCount += paidN; draftCount += rowDraftN;
      return {
        cat: c, total, paidN, dueN, draftN: rowDraftN, dueList, dueSum: rowDueSum,
        pct: total ? Math.round((paidN / total) * 100) : 100,
        allPaid: dueN === 0 && total > 0, empty: total === 0,
      };
    });
    return { rows, dueCount, slots, dueSum, paidSum, paidCount, draftCount, dueBldCount: dueBld.size };
  }, [buildingIds, feeStatus.byKey, commissions.data, maintenance.data, elevatorIds, buildings, visibleCats]);

  const pickCategory = (k: string) => { setCategory(k); setMenuOpen(false); setBldFilter('all'); setOnlyDue(false); setGridTab('pay'); setNaOpen(false); setExpectedEdit(null); };
  const headerCat = (isOverview ? undefined : cat) ?? { label: 'Tổng quan kỳ', sub: 'Còn thiếu phiếu · khớp Báo cáo Lợi Nhuận', icon: 'overview', accent: '#514c42' } as any;

  // ── GRID (tính thẳng mỗi render — rẻ, tránh memo dep theo array identity) ──
  const gridVisible = isGrid ? visibleIdsFor(cat!) : [];
  const gridBuildings = (() => {
    if (!isGrid) return [] as { id: string; name: string }[];
    let list = buildings.filter((b) => gridVisible.includes(b.id));
    if (bldFilter !== 'all') list = list.filter((b) => b.id === bldFilter);
    return list;
  })();
  const naRows = gridBuildings.filter((b) => S.paidOf(b.id)?.notApplicable);
  const gridRows = gridBuildings.filter((b) => !S.paidOf(b.id)?.notApplicable);

  const gridStat = useMemo(() => {
    if (!isGrid) return { sum: 0, draft: 0, total: 0, paidN: 0, dueList: [] as string[] };
    const ids = activeIdsFor(cat!);
    let sum = 0, draft = 0, paidN = 0; const dueList: string[] = [];
    for (const id of ids) {
      const st = feeStatus.statusOf(id, cat!.serverKey);
      if (st && st.paidAmount > 0) { sum += st.paidAmount; paidN++; }
      else dueList.push(buildings.find((b) => b.id === id)?.name ?? id);
      if (st) draft += st.draftAmount;
    }
    return { sum, draft, total: ids.length, paidN, dueList };
  }, [isGrid, cat, feeStatus.byKey, buildings, elevatorIds]);

  // Lịch sử: flatten phiếu của mọi tòa hiển thị, group theo ngày (plain compute —
  // vài chục phiếu/kỳ, memo theo array identity chỉ tốn công vô ích).
  const historyDays = (() => {
    if (!isGrid) return [] as { date: string; sum: number; rows: { v: PeriodFeeVoucher; bld: string }[] }[];
    const map = new Map<string, { date: string; sum: number; rows: { v: PeriodFeeVoucher; bld: string }[] }>();
    for (const b of gridBuildings) {
      for (const v of S.vouchersOf(b.id)) {
        let g = map.get(v.date);
        if (!g) { g = { date: v.date, sum: 0, rows: [] }; map.set(v.date, g); }
        g.rows.push({ v, bld: b.name });
        if (v.status === 'APPROVED') g.sum += v.amount;
      }
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  })();

  // ── Batch create (v2: sổ + ngày + ảnh + form mobile dùng chung state hook riêng surface) ──
  const [createOpen, setCreateOpen] = useState(false);
  const [payer, setPayer] = useState('');
  const [batchBook, setBatchBook] = useState<string | null>(null);
  const [batchDate, setBatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [batchAtts, setBatchAtts] = useState<string[]>([]);
  const [batchUploading, setBatchUploading] = useState(false);
  const batchFileRef = useRef<HTMLInputElement>(null);
  const [batchLines, setBatchLines] = useState<MaintenanceBatchLine[]>([]);
  const createBatch = useCreateMaintenanceBatch(period);
  const addLine = () => setBatchLines((l) => [...l, { buildingId: buildings[0]?.id ?? '', subtype: 'ml', amount: 0 }]);
  const setLine = (i: number, patch: Partial<MaintenanceBatchLine>) => setBatchLines((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const rmLine = (i: number) => setBatchLines((l) => l.filter((_, j) => j !== i));
  const batchTotal = batchLines.reduce((s, l) => s + (l.amount || 0), 0);
  const onBatchFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const err = validateReceiptFile(file);
    if (err) { toast.error(err); return; }
    setBatchUploading(true);
    try { const url = await uploadReceiptToStorage(file); setBatchAtts((a) => [...a, url]); toast.success('Đã thêm ảnh phiếu tổng'); }
    catch (ex) { toast.error('Không tải được ảnh: ' + (ex as Error).message); }
    finally { setBatchUploading(false); }
  };
  const saveBatch = async () => {
    const book = batchBook ?? S.defaultBookId;
    if (!book) { toast.error('Chọn sổ quỹ ghi chi'); return; }
    try {
      await createBatch.mutateAsync({
        payerName: payer, voucherDate: batchDate, accountId: book,
        lines: batchLines.filter((l) => l.buildingId && l.amount > 0),
        attachments: batchAtts,
      });
      toast.success('Đã tạo phiếu tổng bảo trì');
      setCreateOpen(false); setBatchLines([]); setPayer(''); setBatchAtts([]);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  const mText = (m: 'ml' | 'mg') => (m === 'ml' ? 'Máy lạnh' : 'Máy giặt');
  const prevUnpaidComm = (prevCommissions.data ?? []).filter((r) => r.status !== 'paid').length;

  // ── Render 1 dòng GRID ──
  const renderGridRow = (b: { id: string; name: string }) => {
    const st = S.paidOf(b.id);
    const paid = !!st && st.paidAmount > 0;
    const hasDraft = !!st && st.draftAmount > 0;
    // Vừa bấm đóng xong, reader chưa refetch kịp → ô phải nói "đã tạo" và KHÔNG
    // còn nút đóng. Đây là khe đã sinh 2 phiếu 66tr cách nhau 460ms (§−1.6).
    const justPaid = !paid && !hasDraft ? S.justPaidOf(b.id) : undefined;
    if (onlyDue && paid) return null;
    const vouchers = S.vouchersOf(b.id);
    const draftVoucher = vouchers.find((v) => v.status === 'UNAPPROVED');
    const paidVouchers = vouchers.filter((v) => v.status === 'APPROVED');
    const single = paidVouchers.length === 1 ? paidVouchers[0] : null;
    const n = S.nOf(b.id);
    const amount = S.amountOf(b.id);
    const paying = S.payingKey === b.id;
    const def = S.defaultAmountOf(b.id);
    const slim = !cat!.providerConfig;
    const isEditingExp = expectedEdit?.bId === b.id;

    // Rê chuột vào dòng + Ctrl+V = đính ảnh: chưa có phiếu → ảnh chờ đóng;
    // đã có phiếu → append thẳng vào phiếu (như nút camera nhanh). Dòng phiếu
    // NHÁP không có ô đính ảnh nên cũng không nhận dán.
    const pasteVoucher = paid ? (single ?? paidVouchers[0])?.id ?? null : null;
    const canPaste = paid ? !!pasteVoucher : !hasDraft && !justPaid;
    return (
      <tr key={b.id} {...(canPaste ? S.rowPasteProps(b.id, pasteVoucher) : {})}>
        <td className="ud-td-bld"><span className="ud-bldcode">{b.name}</span></td>
        {slim ? (
          <td><input className="ud-holder" placeholder="Ghi chú" value={S.codeOf(b.id)} onChange={(e) => S.setField(b.id, { code: e.target.value })} onBlur={() => S.saveConfig(b.id)} /></td>
        ) : (
          <>
            <td><input className="ud-code" placeholder="Mã NCC" value={S.codeOf(b.id)} onChange={(e) => S.setField(b.id, { code: e.target.value })} onBlur={() => S.saveConfig(b.id)} /></td>
            <td><input className="ud-holder" placeholder="Đơn vị" value={S.holderOf(b.id)} onChange={(e) => S.setField(b.id, { holder: e.target.value })} onBlur={() => S.saveConfig(b.id)} /></td>
          </>
        )}
        <td>
          {paid ? (
            <span className={'ud-bookchip' + (st!.accountIsEmpty ? ' empty' : '')}><BookIcon size={14} />{st!.accountName || 'chưa có sổ'}</span>
          ) : hasDraft ? (
            <span className="ud-bookchip empty"><BookIcon size={14} />chưa có sổ</span>
          ) : (
            <UtilityBookMenu accounts={S.myBooks} valueId={S.bookSel[b.id] ?? null} defaultId={S.defaultBookFor(b.id)} onPick={(id) => S.setBook(b.id, id)} disabled={!canRecordPayment} />
          )}
        </td>
        {cat!.multiPeriod && (
          <td>
            {paid ? (
              <span className="ptt-cover"><Calendar />{st!.coveredStart ? rangeLabel(st!.coveredStart.slice(0, 7), (st!.coveredEnd ?? st!.coveredStart).slice(0, 7)) : fmtBillingMonth(period)}</span>
            ) : (
              <span className="ptt-period">
                <span className="ptt-period-chips">
                  {N_OPTIONS.map((v) => <button key={v} type="button" className={'ptt-period-chip' + (n === v ? ' on' : '')} onClick={() => S.setN(b.id, v)}>{v}</button>)}
                  <input className="ptt-period-free" inputMode="numeric" placeholder="…" value={N_OPTIONS.includes(n) ? '' : String(n)} onChange={(e) => S.setN(b.id, parseVN(e.target.value) || 1)} title="Số kỳ tùy ý (1–36)" />
                </span>
                <span className="ptt-period-range">{rangeLabel(period, addMonths(period, n - 1))}</span>
              </span>
            )}
          </td>
        )}
        <td className="num">
          {paid ? (
            <div className="ud-paidamt">
              <span className="ud-paidamt-a">{fmtFull(st!.paidAmount)}</span>
              <span className="ud-paidamt-m">{fmtDate(st!.coveredStart)}{hasDraft ? ` · +${fmtFull(st!.draftAmount)} chờ duyệt` : ''}</span>
            </div>
          ) : hasDraft ? (
            <div className="ud-paidamt">
              <span className="ud-paidamt-a draft">{fmtFull(st!.draftAmount)}</span>
              <span className="ud-paidamt-m">đã tạo, chờ duyệt · chờ thanh toán</span>
            </div>
          ) : justPaid ? (
            <div className="ud-paidamt">
              <span className="ud-paidamt-a draft">{fmtFull(justPaid.amount)}</span>
              <span className="ud-paidamt-m">đã tạo phiếu — đang cập nhật danh sách</span>
            </div>
          ) : isEditingExp ? (
            <span className="ptt-expedit">
              <input autoFocus className="ud-amt" inputMode="numeric" value={formatVN(expectedEdit!.value)}
                onChange={(e) => setExpectedEdit({ bId: b.id, value: parseVN(e.target.value) })}
                onKeyDown={(e) => { if (e.key === 'Enter') { S.saveExpected(b.id, expectedEdit!.value || null); setExpectedEdit(null); } if (e.key === 'Escape') setExpectedEdit(null); }}
                onBlur={() => { S.saveExpected(b.id, expectedEdit!.value || null); setExpectedEdit(null); }} />
              <span className="ptt-expedit-hint">dự kiến/kỳ</span>
            </span>
          ) : (
            <span className="ptt-amtwrap">
              <input className="ud-amt" type="text" inputMode="numeric"
                placeholder={def ? formatVN(def * (cat!.multiPeriod ? n : 1)) : 'Số tiền'}
                value={formatVN(amount)} onChange={(e) => S.setAmount(b.id, parseVN(e.target.value))} />
              <button type="button" className="ptt-exppencil" title={def ? `Sửa dự kiến (${formatVN(def)}/kỳ)` : 'Đặt số tiền dự kiến'} onClick={() => setExpectedEdit({ bId: b.id, value: def ?? 0 })}><Pencil /></button>
              {cat!.multiPeriod && n > 1 && amount > 0 && <span className="ptt-total">≈ <b>{fmtFull(Math.round(amount / n))}</b>/kỳ</span>}
            </span>
          )}
        </td>
        <td className="act">
          {paid ? (
            <span className="ud-acts">
              {(single ?? paidVouchers[0])?.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
              <UtilityReceiptThumb attachments={(single ?? paidVouchers[0])?.attachments ?? []} onView={onView} size="md" />
              <button type="button" className="ptt-quickcam" title="Đính nhanh ảnh phiếu"
                disabled={!canRecordPayment || S.uploadingKey === `__quick__${b.id}`}
                onClick={() => S.onQuickAttachClick(b.id, (single ?? paidVouchers[0]).id)}>
                {S.uploadingKey === `__quick__${b.id}` ? <span className="ub-spin dark" /> : <Camera />}
              </button>
              {vouchers.length > 1 ? (
                <button type="button" className="ptt-edit-btn" title={`${vouchers.length} phiếu trong kỳ`} onClick={() => setVlistFor(b.id)}><ListChecks /></button>
              ) : (
                <>
                  <button type="button" className={'ptt-edit-btn' + (single?.isAuto ? ' auto' : '')} title="Sửa phiếu" onClick={() => S.openEdit(b.id, single ?? undefined)}><Edit3 /></button>
                  {single?.cancellable && <button type="button" className="ud-cancel" title="Hủy phiếu" disabled={!canRecordPayment} onClick={() => S.requestCancel(b.id, single)}><X /></button>}
                </>
              )}
            </span>
          ) : hasDraft && draftVoucher ? (
            <span className="ud-acts">
              {draftVoucher.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
              <span className="ptt-badge-draft">CHỜ DUYỆT</span>
              <button type="button" className="ptt-paydraft" disabled={!canRecordPayment} onClick={() => S.openPayDraft(b.id, draftVoucher)}>
                <HandCoins />Thanh toán
              </button>
              {vouchers.length > 1 && <button type="button" className="ptt-edit-btn" title={`${vouchers.length} phiếu`} onClick={() => setVlistFor(b.id)}><ListChecks /></button>}
            </span>
          ) : justPaid ? (
            <span className="ud-acts">
              <span className="ptt-badge-draft" title="Phiếu vừa tạo — danh sách đang tải lại">ĐÃ TẠO</span>
            </span>
          ) : (
            <span className="ud-acts">
              <button type="button" className={'ud-attach' + (S.attach[b.id] ? ' has' : '')} title="Đính kèm ảnh phiếu" disabled={!canRecordPayment || S.uploadingKey === b.id} onClick={() => S.onAttachClick(b.id)}>{S.uploadingKey === b.id ? <span className="ub-spin dark" /> : <Camera />}</button>
              <button type="button" className="ud-pay" title="Đóng tiền" disabled={!canRecordPayment || amount <= 0 || paying} onClick={() => S.submitPay(b.id)}>{paying ? <span className="ub-spin" /> : <Check />}</button>
              <button type="button" className="ptt-nabtn" title="Tòa không áp dụng hạng mục này" disabled={!canRecordPayment} onClick={() => S.setNotApplicable(b.id, true)}><Ban /></button>
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="tt-udesk ptt-panel">
      <input ref={S.fileRef} type="file" accept="image/*" hidden onChange={S.onFileChange} />
      <input ref={batchFileRef} type="file" accept="image/*" hidden onChange={onBatchFile} />

      {/* ===== Header ===== */}
      <div className="ptt-head">
        <button type="button" className="ud-back" title="Về Thu tiền" onClick={onClose}><ArrowLeft /></button>
        <span className="ptt-appic" style={{ background: headerCat.accent + '18', color: headerCat.accent }}>
          <FeeIcon name={headerCat.icon} style={{ width: 20, height: 20 }} />
        </span>
        <div className="ptt-titlewrap">
          <button type="button" className="ptt-trigger" onClick={() => setMenuOpen((v) => !v)}>
            <span className="ptt-title">{isOverview ? 'Tổng quan kỳ' : cat!.label}<ChevronDown /></span>
            <span className="ptt-sub">Kỳ {fmtBillingMonth(period)} · {isOverview ? 'Còn thiếu phiếu · khớp Báo cáo Lợi Nhuận' : cat!.sub}</span>
          </button>
          {menuOpen && (
            <div className="ptt-menu">
              <button type="button" className={'ptt-menu-item ov' + (isOverview ? ' on' : '')} onClick={() => pickCategory('overview')}>
                <span className="ptt-menu-ic ov"><FeeIcon name="overview" style={{ width: 15, height: 15 }} /></span>
                <span className="ptt-menu-txt"><span className="ptt-menu-lbl">Tổng quan kỳ</span><span className="ptt-menu-hint">Còn thiếu phiếu · khớp Báo cáo Lợi Nhuận</span></span>
                {overview.dueCount > 0 && <span className="ptt-badge">{overview.dueCount}</span>}
                {isOverview && <Check className="ptt-menu-check" />}
              </button>
              {FEE_GROUPS.map((g) => (
                <div key={g}>
                  <div className="ptt-menu-group">{g}</div>
                  {visibleCats.filter((c) => c.group === g).map((c) => {
                    const active = c.key === category;
                    const due = dueCountFor(c);
                    return (
                      <button key={c.key} type="button" className={'ptt-menu-item' + (active ? ' on' : '')} onClick={() => pickCategory(c.key)}>
                        <span className="ptt-menu-ic" style={{ background: active ? '#1b1813' : c.accent + '18', color: active ? '#fff' : c.accent }}><FeeIcon name={c.icon} style={{ width: 15, height: 15 }} /></span>
                        <span className="ptt-menu-lbl grow">{c.label}{c.restricted && <span className="ptt-tag-restricted">hạn chế</span>}</span>
                        {due > 0 && c.family !== 'MAINTENANCE_BATCH' && <span className="ptt-badge">{due}</span>}
                        {due === 0 && c.family !== 'MAINTENANCE_BATCH' && c.family !== 'COMMISSION' && <span className="ptt-badge done">đủ</span>}
                        {active && <Check className="ptt-menu-check" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <input className="ud-ky" type="month" value={period} onChange={(e) => e.target.value && onBillingMonthChange(e.target.value)} />
        <button type="button" className="ud-x" title="Tắt — quay lại Thu tiền" onClick={onClose}><X /></button>
      </div>
      {menuOpen && <div className="ptt-menu-scrim" onClick={() => setMenuOpen(false)} />}

      {/* ===== OVERVIEW ===== */}
      {isOverview && (
        <div className="ptt-scroll">
          <div className="ptt-ov-stats">
            <div className="ptt-ov-card red">
              <div className="ptt-ov-lbl">Còn thiếu phiếu kỳ này</div>
              <div className="ptt-ov-big">{overview.dueCount} khoản</div>
              <div className="ptt-ov-sub">trên {overview.slots} khoản · {overview.dueBldCount} tòa{overview.draftCount > 0 ? ` · ${overview.draftCount} chờ duyệt chờ TT` : ''}</div>
            </div>
            <div className="ptt-ov-card amber">
              <div className="ptt-ov-lbl">Dự kiến còn phải chi</div>
              <div className="ptt-ov-big">{fmtFull(overview.dueSum)}</div>
              <div className="ptt-ov-sub">theo dự kiến từng hạng mục + phiếu chờ duyệt</div>
            </div>
            <div className="ptt-ov-card green">
              <div className="ptt-ov-lbl">Đã chi trong kỳ</div>
              <div className="ptt-ov-big">{fmtFull(overview.paidSum)}</div>
              <div className="ptt-ov-sub">{overview.paidCount} khoản đã có phiếu duyệt</div>
            </div>
          </div>

          <div className="ptt-ov-tablecard">
            <div className="ptt-ov-tablehead">
              <span className="ptt-ov-th-title">Còn thiếu theo hạng mục</span>
              <span className="ptt-ov-th-hint">khớp cột "Khoản chi (chưa có phiếu)" của Báo cáo Lợi Nhuận</span>
            </div>
            <table className="ptt-ov-table">
              <thead><tr><th>Hạng mục</th><th className="ctr">Tiến độ</th><th>Tòa chưa có phiếu</th><th className="num">Dự kiến còn lại</th><th className="ctr">Thao tác</th></tr></thead>
              <tbody>
                {overview.rows.map((r) => (
                  <tr key={r.cat.key}>
                    <td>
                      <span className="ptt-ov-hm">
                        <span className="ptt-ov-hm-ic" style={{ background: r.cat.accent + '18', color: r.cat.accent }}><FeeIcon name={r.cat.icon} style={{ width: 15, height: 15 }} /></span>
                        <span className="ptt-ov-hm-lbl">{r.cat.label}</span>
                        {r.cat.restricted && <span className="ptt-tag-restricted">hạn chế</span>}
                        {r.draftN > 0 && <span className="ptt-badge-draft">{r.draftN} chờ duyệt</span>}
                      </span>
                    </td>
                    <td className="ctr"><span className="ptt-prog"><span className="ptt-prog-bar"><span className="ptt-prog-fill" style={{ width: r.pct + '%' }} /></span><span className="ptt-prog-t">{r.paidN}/{r.total}</span></span></td>
                    <td>
                      {r.allPaid ? <span className="ptt-ov-done">Đã đủ phiếu</span> : r.empty ? <span className="ptt-ov-none">—</span> : (
                        <span className="ptt-ov-chips">{r.dueList.map((n) => <span key={n} className="ptt-chip due">{n}</span>)}</span>
                      )}
                    </td>
                    <td className="num"><span className={'ptt-ov-duesum' + (r.dueN === 0 ? ' muted' : '')}>{r.dueN === 0 ? '—' : fmtFull(r.dueSum)}</span></td>
                    <td className="ctr">
                      {r.dueN > 0 ? (
                        <button type="button" className="ptt-go" onClick={() => pickCategory(r.cat.key)}>Đóng<ArrowRight /></button>
                      ) : r.empty ? <span className="ptt-ov-none">—</span> : (
                        <span className="ptt-ov-check"><Check /></span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== ĐIỆN & NƯỚC ===== */}
      {isEN && (
        <UtilityEnContent billingMonth={period} buildings={buildings} canRecordPayment={canRecordPayment} loadingBuildings={loadingBld} />
      )}

      {/* ===== GRID ===== */}
      {isGrid && (
        <div className="ptt-scroll">
          <div className="ptt-gridstat" style={{ borderLeftColor: cat!.accent }}>
            <span className="ptt-gridstat-ic" style={{ background: cat!.accent + '18', color: cat!.accent }}><FeeIcon name={cat!.icon} style={{ width: 18, height: 18 }} /></span>
            <div className="ptt-gridstat-h">
              <div className="ptt-gridstat-title">{cat!.label} · kỳ {fmtBillingMonth(period)}</div>
              <div className="ptt-gridstat-sub">{gridStat.paidN}/{gridStat.total} tòa đã có phiếu{gridStat.draft > 0 ? ` · chờ duyệt ${fmtFull(gridStat.draft)}` : ''}</div>
            </div>
            <div className="ptt-gridstat-amt"><div className="ptt-gridstat-num">{fmtFull(gridStat.sum)}</div><div className="ptt-gridstat-lbl">đã chi kỳ này</div></div>
            {gridStat.dueList.length > 0 && (
              <div className="ptt-gridstat-due"><span className="ptt-gridstat-duelbl">{gridStat.dueList.length} tòa chưa đóng</span><span className="ptt-ov-chips">{gridStat.dueList.map((n) => <span key={n} className="ptt-chip due">{n}</span>)}</span></div>
            )}
          </div>

          {cat!.restricted && (
            <div className="ptt-note warn mx"><Lock /><span>Hạng mục <b>hạn chế</b> — chỉ người có quyền xem/đóng thấy phiếu này.</span></div>
          )}
          {cat!.elevatorGated && (
            <div className="ptt-note info mx"><Info /><span>Hiển thị <b>{gridVisible.length} tòa có thang máy</b> (gồm tòa có phiếu thang máy trong kỳ).</span></div>
          )}

          <div className="ud-tabs ptt-gridtabs">
            <button type="button" className={'ud-tab' + (gridTab === 'pay' ? ' on' : '')} onClick={() => setGridTab('pay')}>Đóng tiền <span className="ud-tab-n">{gridRows.length}</span></button>
            <button type="button" className={'ud-tab' + (gridTab === 'history' ? ' on' : '')} onClick={() => setGridTab('history')}><History /> Lịch sử <span className="ud-tab-n">{historyDays.reduce((s, d) => s + d.rows.length, 0)}</span></button>
          </div>

          {gridTab === 'pay' && (
            <>
              <div className="ud-toolbar">
                <label className="ud-dd"><span>Tòa nhà</span>
                  <select value={bldFilter} onChange={(e) => setBldFilter(e.target.value)}>
                    <option value="all">Tất cả tòa</option>
                    {buildings.filter((b) => gridVisible.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                <button type="button" className={'ud-due' + (onlyDue ? ' on' : '')} onClick={() => setOnlyDue((v) => !v)}>{onlyDue ? <Check /> : <span className="ud-due-box" />}Chỉ tòa chưa đóng</button>
                {cat!.multiPeriod && <span className="ptt-multibadge"><Calendar />Trả trước nhiều kỳ — nhập TỔNG cả khoảng, chi phí tự chia đều</span>}
              </div>

              <div className="ud-body">
                {loadingBld || feeStatus.isLoading ? <div className="ud-empty">⏳ Đang tải…</div> : gridRows.length === 0 && naRows.length === 0 ? <div className="ud-empty">🏢 Không có tòa nào cho hạng mục này.</div> : (
                  <div className="ud-tablewrap">
                    <table className="ud-table">
                      <thead><tr>
                        <th>Tòa</th>
                        {cat!.providerConfig ? <><th>Mã NCC</th><th>Đơn vị</th></> : <th>Ghi chú</th>}
                        <th>Sổ quỹ ghi chi</th>
                        {cat!.multiPeriod && <th>Kỳ áp dụng</th>}
                        <th className="num">Số tiền</th><th className="act">Thao tác</th>
                      </tr></thead>
                      <tbody>{gridRows.map(renderGridRow)}</tbody>
                    </table>
                    {naRows.length > 0 && (
                      <div className="ptt-nagroup">
                        <button type="button" className="ptt-nagroup-head" onClick={() => setNaOpen((v) => !v)}>
                          <Ban /> Không áp dụng ({naRows.length}) <ChevronDown className={naOpen ? 'up' : ''} />
                        </button>
                        {naOpen && naRows.map((b) => (
                          <div className="ptt-narow" key={b.id}>
                            <span className="ud-bldcode">{b.name}</span>
                            <span className="ptt-narow-hint">không áp dụng {cat!.label.toLowerCase()}</span>
                            <button type="button" className="ptt-btn ghost sm" onClick={() => S.setNotApplicable(b.id, false)}>Bật lại</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {gridTab === 'history' && (
            <div className="ud-body">
              {historyDays.length === 0 ? <div className="ud-empty">🧾 Kỳ này chưa có phiếu {cat!.label.toLowerCase()}.</div> : (
                <div className="ud-report">
                  {historyDays.map((d) => (
                    <div className="ud-rday" key={d.date}>
                      <div className="ud-rday-head">
                        <span className="ud-rday-d">{fmtDate(d.date)}</span>
                        <span className="ud-rday-c">{d.rows.length} phiếu</span>
                        <span className="ud-rday-lbl">Đã duyệt trong ngày</span>
                        <span className="ud-rday-s">{fmtFull(d.sum)}</span>
                      </div>
                      <table className="ud-rtable">
                        <thead><tr><th>Tòa</th><th>Trạng thái</th><th>Người tạo</th><th>Sổ quỹ</th><th className="ctr">Chứng từ</th><th className="num">Số tiền</th></tr></thead>
                        <tbody>
                          {d.rows.map(({ v, bld }) => (
                            <tr key={v.id}>
                              <td className="ud-mono">{bld}</td>
                              <td>{v.status === 'UNAPPROVED' ? <span className="ptt-badge-draft">CHỜ DUYỆT</span> : v.isAuto ? <span className="ptt-auto">TỰ ĐỘNG</span> : <span className="ptt-comm-paid sm">Đã duyệt</span>}</td>
                              <td>{v.creatorName || '—'}</td>
                              <td><span className="ud-bookchip"><BookIcon size={14} />{v.accountName ?? '—'}</span></td>
                              <td className="ctr"><UtilityReceiptThumb attachments={v.attachments} onView={onView} size="md" /></td>
                              <td className="num ud-mono">{fmtFull(v.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== COMMISSION ===== */}
      {isComm && (
        <div className="ptt-scroll">
          {(() => {
            const rows = commissions.data ?? [];
            const paidSum = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + (r.voucherAmount ?? r.expectedAmount), 0);
            const draftSum = rows.filter((r) => r.status === 'draft').reduce((s, r) => s + (r.voucherAmount ?? r.expectedAmount), 0);
            const dueSum = rows.filter((r) => r.status === 'unpaid').reduce((s, r) => s + r.expectedAmount, 0);
            const paidN = rows.filter((r) => r.status === 'paid').length;
            const draftN = rows.filter((r) => r.status === 'draft').length;
            return (
              <>
                {prevUnpaidComm > 0 && (
                  <div className="ptt-note warn mx">
                    <Info />
                    <span>Kỳ trước ({fmtBillingMonth(prevPeriod)}) còn <b>{prevUnpaidComm} HĐ chưa chi/duyệt HH</b>.</span>
                    <button type="button" className="ptt-btn ghost sm" onClick={() => onBillingMonthChange(prevPeriod)}>Xem kỳ trước</button>
                  </div>
                )}
                <div className="ptt-comm-stats">
                  <div className="ptt-comm-card"><div className="ptt-ov-lbl">HH dự kiến kỳ này</div><div className="ptt-comm-num">{fmtFull(rows.reduce((s, r) => s + r.expectedAmount, 0))}</div><div className="ptt-ov-sub">{rows.length} hợp đồng ký trong kỳ</div></div>
                  <div className="ptt-comm-card green"><div className="ptt-ov-lbl">Đã chi (phiếu duyệt)</div><div className="ptt-comm-num green">{fmtFull(paidSum)}</div><div className="ptt-ov-sub">{paidN} phiếu · số THẬT trên phiếu</div></div>
                  <div className="ptt-comm-card amber"><div className="ptt-ov-lbl">Chờ duyệt chờ duyệt</div><div className="ptt-comm-num amber">{fmtFull(draftSum)}</div><div className="ptt-ov-sub">{draftN} phiếu chờ duyệt</div></div>
                  <div className="ptt-comm-card red"><div className="ptt-ov-lbl">Chưa chi</div><div className="ptt-comm-num red">{fmtFull(dueSum)}</div><div className="ptt-ov-sub">{rows.length - paidN - draftN} hợp đồng</div></div>
                </div>
                <div className="ud-body">
                  {commissions.isLoading ? <div className="ud-empty">⏳ Đang tải…</div> : rows.length === 0 ? <div className="ud-empty">📄 Không có hợp đồng nào ký trong kỳ.</div> : (
                    <div className="ud-tablewrap">
                      <table className="ud-table">
                        <thead><tr><th>Hợp đồng</th><th>Phòng · Khách thuê</th><th>Ngày ký</th><th className="ctr">Số tháng</th><th className="ctr">Bậc HH</th><th className="num">HH dự kiến</th><th className="num">Phiếu thật</th><th className="act">Thao tác</th></tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.contractId}>
                              <td className="ud-mono2">{r.contractNumber ?? '—'}</td>
                              <td><div className="ptt-comm-room"><span className="ptt-comm-roomn">{r.buildingName} · {r.roomName ?? ''}</span><span className="ptt-comm-tenant">{r.tenantName}</span></div></td>
                              <td className="ud-mono2">{fmtDate(r.signedDate)}</td>
                              <td className="ctr ud-mono2">{r.months} th</td>
                              <td className="ctr"><span className="ptt-tier">{r.tierPercent != null ? r.tierPercent + '%' : '—'}</span></td>
                              <td className="num"><span className="ud-mono">{fmtFull(r.expectedAmount)}</span></td>
                              <td className="num"><span className={'ud-mono' + (r.status === 'paid' ? ' paid' : '')}>{r.voucherAmount != null ? fmtFull(r.voucherAmount) : '—'}</span></td>
                              <td className="act">
                                {r.status === 'unpaid' && (
                                  <button type="button" className="ptt-comm-pay" disabled={!canRecordPayment} onClick={() => setCommRow(r)}><HandCoins />Chi HH</button>
                                )}
                                {r.status === 'draft' && (
                                  <span className="ud-acts">
                                    <span className="ptt-badge-draft">CHỜ DUYỆT</span>
                                    <button type="button" className="ptt-paydraft" disabled={!canRecordPayment} onClick={() => setCommRow(r)}><Check />Duyệt</button>
                                  </span>
                                )}
                                {r.status === 'paid' && <span className="ptt-comm-paid">Đã chi</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="ptt-comm-note">HH dự kiến = <b>bậc hoa hồng</b> của tòa × tiền phòng theo số tháng HĐ. <b>Lưu chờ duyệt</b> chờ duyệt · <b>Chi &amp; duyệt</b> vào sổ ngay. Mỗi HĐ chỉ chi 1 lần (khoá ở DB).</div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ===== MAINTENANCE BATCH ===== */}
      {isBatch && (
        <div className="ptt-scroll">
          <div className="ptt-batch-top">
            <div className="ptt-batch-th"><div className="ptt-batch-title">Phiếu tổng đã có trong kỳ</div><div className="ptt-batch-sub">Lấy đúng phiếu tổng / phiếu lẻ đã tạo bên Thu chi — không nhập lại</div></div>
            <button type="button" className={'ptt-batch-create' + (createOpen ? ' on' : '')} disabled={!canRecordPayment} onClick={() => { setCreateOpen((v) => !v); if (!createOpen && batchLines.length === 0) addLine(); }}><Plus />Tạo phiếu tổng</button>
          </div>

          {createOpen && (
            <div className="ptt-batch-form">
              <div className="ptt-batch-formhead"><span className="ptt-batch-formic"><FeeIcon name="wrench" style={{ width: 16, height: 16 }} /></span><span>Phiếu tổng mới — 1 nhà cung cấp, nhiều tòa</span></div>
              <div className="ptt-batch-formrow">
                <label className="ptt-field grow"><span className="ptt-field-lbl">Nhà cung cấp</span><input className="ptt-field-in" value={payer} placeholder="Tên NCC" onChange={(e) => setPayer(e.target.value)} /></label>
                <label className="ptt-field"><span className="ptt-field-lbl">Ngày phiếu</span><input type="date" className="ptt-field-in" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></label>
                <label className="ptt-field"><span className="ptt-field-lbl">Sổ quỹ ghi chi</span><UtilityBookMenu accounts={S.myBooks} valueId={batchBook} defaultId={S.defaultBookId} onPick={setBatchBook} /></label>
              </div>
              <div className="ptt-batch-lines">
                {batchLines.map((ln, i) => (
                  <div className="ptt-batch-line" key={i}>
                    <select className="ptt-batch-bld" value={ln.buildingId} onChange={(e) => setLine(i, { buildingId: e.target.value })}>
                      {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    <select className="ptt-batch-sub" value={ln.subtype} onChange={(e) => setLine(i, { subtype: e.target.value as 'ml' | 'mg' })}><option value="ml">Máy lạnh</option><option value="mg">Máy giặt</option></select>
                    <input className="ptt-batch-amt mono" inputMode="numeric" placeholder="Số tiền" value={formatVN(ln.amount)} onChange={(e) => setLine(i, { amount: parseVN(e.target.value) })} />
                    <button type="button" className="ptt-batch-rm" onClick={() => rmLine(i)}><Trash2 /></button>
                  </div>
                ))}
                <button type="button" className="ptt-batch-addline" onClick={addLine}><Plus />Thêm dòng (tòa × loại máy)</button>
              </div>
              <div className="ptt-batch-attrow">
                <UtilityReceiptThumb attachments={batchAtts} onView={onView} size="md" />
                <button type="button" className="ptt-edit-addimg" disabled={batchUploading} onClick={() => batchFileRef.current?.click()}>
                  {batchUploading ? <span className="ub-spin dark" /> : <Camera />}
                  {batchAtts.length > 0 ? `Đã có ${batchAtts.length} ảnh phiếu tổng` : 'Đính ảnh phiếu tổng NCC'}
                </button>
              </div>
              <div className="ptt-batch-foot">
                <span className="ptt-batch-totallbl">Tổng phiếu</span>
                <span className="ptt-batch-total">{fmtFull(batchTotal)}</span>
                <button type="button" className="ptt-btn ghost" onClick={() => setCreateOpen(false)}>Hủy</button>
                <button type="button" className="ptt-btn go" disabled={createBatch.isPending} onClick={saveBatch}>{createBatch.isPending ? <span className="ub-spin" /> : <Check />}Lưu phiếu tổng · {batchLines.length} tòa</button>
              </div>
            </div>
          )}

          <div className="ud-body">
            {maintenance.isLoading ? <div className="ud-empty">⏳ Đang tải…</div> : (
              <div className="ptt-batch-list">
                {maintenance.groups.map((bt) => (
                  <div className="ptt-batch-group" key={bt.batchId}>
                    <div className="ptt-batch-ghead">
                      <span className="ptt-batch-gic"><FeeIcon name="wrench" style={{ width: 16, height: 16 }} /></span>
                      <div className="ptt-batch-gh"><div className="ptt-batch-gtitle">{bt.payerName ?? 'Phiếu tổng'}</div><div className="ptt-batch-gmeta">Phiếu tổng · {bt.lines.length} tòa</div></div>
                      {bt.hasReceipt && <span className="ptt-batch-gtag">Có ảnh phiếu</span>}
                      {/* Tiền chờ duyệt hiện RIÊNG, không gộp vào tổng đã chi (A3a). */}
                      {bt.pendingTotal > 0 && <span className="ptt-badge-draft">chờ duyệt {fmtFull(bt.pendingTotal)}</span>}
                      <span className="ptt-batch-gtotal">{fmtFull(bt.total)}</span>
                    </div>
                    <table className="ud-table">
                      <thead><tr><th>Tòa (phiếu con)</th><th>Loại máy</th><th>Sổ quỹ</th><th className="num">Số tiền</th></tr></thead>
                      <tbody>
                        {bt.lines.map((ln) => (
                          <tr key={ln.voucherId}>
                            <td className="ud-td-bld"><span className="ud-bldcode">{ln.buildingName}</span></td>
                            <td>
                              <span className={'ptt-mchip ' + ln.subtype}>{mText(ln.subtype)}</span>
                              {ln.pending && <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                            </td>
                            <td><span className="ud-bookchip"><BookIcon size={14} />{ln.accountName ?? '—'}</span></td>
                            <td className="num ud-mono">{fmtFull(ln.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

                {maintenance.standalone.length > 0 && (
                  <div className="ptt-batch-standalone">
                    <div className="ptt-batch-sohead"><span className="ptt-batch-sotitle">Phiếu lẻ (chưa gộp phiếu tổng)</span><span className="ptt-batch-sohint">tạo tay bên Thu chi</span></div>
                    {maintenance.standalone.map((r) => (
                      <div className="ptt-batch-sorow" key={r.voucherId}>
                        <span className="ud-bldcode">{r.buildingName}</span>
                        <span className={'ptt-mchip ' + r.subtype}>{mText(r.subtype)}</span>
                        {r.pending && <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                        <span className="ptt-batch-someta">{fmtDate(r.voucherDate)} · {r.accountName ?? '—'}</span>
                        <span className="ptt-batch-soamt ud-mono">{fmtFull(r.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {maintenance.groups.length === 0 && maintenance.standalone.length === 0 && (
                  <div className="ud-empty">🔧 Kỳ này chưa có phiếu bảo trì nào. Bấm "Tạo phiếu tổng" để thêm.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Modals ===== */}
      <PeriodFeeEditModal
        target={S.editTarget}
        isAdmin={isAdmin}
        myBooks={S.myBooks}
        saving={S.saving}
        uploading={S.uploadingKey === '__edit__'}
        onAttach={S.onEditAttachClick}
        onView={onView}
        onClose={S.closeEdit}
        onSave={(args) => S.submitEdit({ isAdmin, ...args })}
      />
      <PeriodFeeVoucherList
        open={!!vlistFor}
        title={vlistFor ? `${cat?.label ?? ''} · ${buildings.find((b) => b.id === vlistFor)?.name ?? ''}` : ''}
        vouchers={vlistFor ? S.vouchersOf(vlistFor) : []}
        canRecordPayment={canRecordPayment}
        onView={onView}
        onEdit={(v) => { S.openEdit(vlistFor!, v); setVlistFor(null); }}
        onCancel={(v) => { S.requestCancel(vlistFor!, v); setVlistFor(null); }}
        onPayDraft={(v) => { S.openPayDraft(vlistFor!, v); setVlistFor(null); }}
        onClose={() => setVlistFor(null)}
      />
      <PeriodFeePayDraftModal
        target={S.draftTarget}
        myBooks={S.myBooks}
        defaultBookId={S.draftTarget ? S.defaultBookFor(S.draftTarget.buildingId) : S.defaultBookId}
        attachments={S.draftPayAttachments}
        uploading={S.uploadingKey === '__draftpay__'}
        busy={S.payingDraft}
        onAttach={S.onDraftPayAttachClick}
        onView={onView}
        onClose={S.closePayDraft}
        onSubmit={S.submitPayDraft}
      />
      <PeriodFeeDupConfirmModal
        target={S.dupConfirm}
        busy={S.payingKey != null}
        onClose={S.closeDupConfirm}
        onConfirm={S.confirmPayDup}
      />
      <PeriodCommissionModal
        row={commRow}
        myBooks={S.myBooks}
        defaultBookId={S.defaultBookId}
        onClose={() => setCommRow(null)}
      />
      <UtilityCancelModal target={S.cancelTarget} busy={S.cancelling} onClose={S.closeCancel} onConfirm={S.confirmCancel} />
      <AttachmentLightbox attachments={viewer.attachments} index={viewer.index} onIndexChange={(i) => setViewer((v) => ({ ...v, index: i }))} />
    </div>
  );
}

export default PeriodFeePanel;
