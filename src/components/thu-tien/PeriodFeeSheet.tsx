// =============================================================================
// PeriodFeeSheet V2 — sheet MOBILE "Đóng tiền Tập trung theo Kỳ".
// Mirror đầy đủ desktop V2: 3 trạng thái ô (chưa/CHỜ DUYỆT/đã đóng), sửa-hủy-ảnh
// theo TỪNG phiếu, chống trùng, Không-áp-dụng, thang máy theo phiếu, ẩn Quản Lý
// theo quyền, tab Lịch sử, HH modal Chờ duyệt|Chi&duyệt + nhắc kỳ trước, form phiếu
// tổng bảo trì (sổ+ngày+ảnh) NGAY TRÊN MOBILE.
// =============================================================================

import { useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Check, Camera, ArrowRight, LayoutGrid, Zap, Droplet, Calendar, HandCoins, Plus, Lock, Info, Edit3, Ban, Pencil, History, ListChecks, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';
import { useBuildings } from '@/hooks/useBuildings';
import { useIsAdmin, useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { useUtilityPayState, type MeterRow } from '@/hooks/useUtilityPayState';
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
import { BookIcon } from './utilityIcons';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { usePersistedState } from '@/hooks/usePersistedState';

interface Props {
  show: boolean;
  onClose: () => void;
  billingMonth: string;
  onBillingMonthChange?: (m: string) => void;
  canRecordPayment: boolean;
}

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => { const d = s.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };
const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const N_OPTIONS = [1, 3, 6, 12];

export function PeriodFeeSheet({ show, onClose, billingMonth, onBillingMonthChange, canRecordPayment }: Props) {
  const period = billingMonth;
  const { data: allBuildings = [] } = useIncomeExpenseFormBuildings();
  const buildings = useMemo(() => allBuildings.filter((b) => !b.is_virtual).map((b) => ({ id: b.id, name: b.name })), [allBuildings]);
  const buildingIds = useMemo(() => buildings.map((b) => b.id), [buildings]);
  const { data: rawBuildings = [] } = useBuildings();
  const elevatorIds = useMemo(() => new Set(rawBuildings.filter((b: any) => b.has_elevator).map((b: any) => b.id)), [rawBuildings]);
  const { data: isAdminFlag } = useIsAdmin();
  const { data: isSuperFlag } = useIsSuperAdmin();
  const isAdmin = !!isAdminFlag || !!isSuperFlag;
  const { data: perms } = useMyPermissions();
  const canRestricted = isAdmin || canUse(perms, 'income_expenses', 'restricted_view');
  const visibleCats = useMemo(() => FEE_CATEGORIES.filter((c) => !c.restricted || canRestricted), [canRestricted]);
  const gridKeys = useMemo(() => gridKeysFor(canRestricted), [canRestricted]);

  const [category, setCategory] = usePersistedState<string>('flt:thu-tien:fee-cat', 'overview');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enType, setEnType] = useState<'all' | 'electric' | 'water'>('all');
  const [onlyDue, setOnlyDue] = useState(false);
  const [gridTab, setGridTab] = useState<'pay' | 'history'>('pay');
  const [naOpen, setNaOpen] = useState(false);
  const [expectedEdit, setExpectedEdit] = useState<{ bId: string; value: number } | null>(null);
  const [vlistFor, setVlistFor] = useState<string | null>(null);
  const [commRow, setCommRow] = useState<PeriodCommissionRow | null>(null);
  const [viewer, setViewer] = useState<{ attachments: string[]; index: number | null }>({ attachments: [], index: null });
  const onView = (atts: string[]) => { if (atts.length) setViewer({ attachments: atts, index: 0 }); };

  const cat = feeCategoryOf(category);
  const catVisible = cat && (!cat.restricted || canRestricted);
  const fam = category === 'overview' || !catVisible ? 'over' : cat!.family;

  const feeStatus = usePeriodFeeStatus(period, gridKeys, buildingIds, { enabled: show && buildingIds.length > 0 });
  const feeAccounts = useFeeAccounts();
  const commissions = usePeriodCommissions(period, buildingIds, { enabled: show && buildingIds.length > 0 && (fam === 'over' || fam === 'COMMISSION') });
  const prevPeriod = addMonths(period, -1);
  const prevCommissions = usePeriodCommissions(prevPeriod, buildingIds, { enabled: show && buildingIds.length > 0 && fam === 'COMMISSION' });
  const maintenance = usePeriodMaintenance(period, buildingIds, { enabled: show && buildingIds.length > 0 && (fam === 'over' || fam === 'MAINTENANCE_BATCH') });

  const EN = useUtilityPayState(period, buildings);
  const gridCat = cat?.family === 'GRID' ? cat : FEE_CATEGORIES.find((c) => c.family === 'GRID')!;
  const S = usePeriodFeeState(period, gridCat, buildings, feeStatus.statusOf, feeAccounts.accountOf);

  const visibleIdsFor = (c: FeeCategory): string[] => {
    if (!c.elevatorGated) return buildingIds;
    return buildingIds.filter((id) => {
      if (elevatorIds.has(id)) return true;
      const st = feeStatus.statusOf(id, c.serverKey);
      return !!st && (st.paidAmount > 0 || st.draftAmount > 0);
    });
  };
  const activeIdsFor = (c: FeeCategory): string[] =>
    visibleIdsFor(c).filter((id) => !feeStatus.statusOf(id, c.serverKey)?.notApplicable);

  const dueCountFor = (c: FeeCategory): number => {
    if (c.family === 'EN') { let n = 0; for (const b of buildingIds) { if (!(feeStatus.statusOf(b, 'dien')?.paidAmount)) n++; if (!(feeStatus.statusOf(b, 'nuoc')?.paidAmount)) n++; } return n; }
    if (c.family === 'GRID') return activeIdsFor(c).filter((id) => !(feeStatus.statusOf(id, c.serverKey)?.paidAmount)).length;
    if (c.family === 'COMMISSION') return (commissions.data ?? []).filter((r) => r.status !== 'paid').length;
    return 0;
  };

  const overview = useMemo(() => {
    let dueCount = 0, dueSum = 0, draftCount = 0; const nameOf = (id: string) => buildings.find((b) => b.id === id)?.name ?? id;
    const rows = visibleCats.map((c) => {
      let total = 0, paidN = 0, rowDue = 0, rowDraftN = 0; const dueList: string[] = [];
      if (c.family === 'EN') { for (const b of buildingIds) for (const k of ['dien', 'nuoc'] as const) { const st = feeStatus.statusOf(b, k); if (st?.notApplicable) continue; total++; if (st && st.paidAmount > 0) paidN++; else { rowDue += st?.expectedAmount ?? 0; if (!dueList.includes(nameOf(b))) dueList.push(nameOf(b)); } } }
      else if (c.family === 'GRID') { for (const b of activeIdsFor(c)) { const st = feeStatus.statusOf(b, c.serverKey); total++; if (st && st.paidAmount > 0) paidN++; else { if (st && st.draftAmount > 0) { rowDraftN++; rowDue += st.draftAmount; } else rowDue += st?.expectedAmount ?? 0; dueList.push(nameOf(b)); } } }
      else if (c.family === 'COMMISSION') { for (const r of commissions.data ?? []) { total++; if (r.status === 'paid') paidN++; else { if (r.status === 'draft') rowDraftN++; rowDue += r.status === 'draft' ? (r.voucherAmount ?? r.expectedAmount) : r.expectedAmount; if (!dueList.includes(r.buildingName)) dueList.push(r.buildingName); } } }
      else if (c.family === 'MAINTENANCE_BATCH') { const l = maintenance.data ?? []; total = l.length; paidN = l.length; }
      const dueN = total - paidN; dueCount += dueN; dueSum += rowDue; draftCount += rowDraftN;
      return { cat: c, total, paidN, dueN, draftN: rowDraftN, dueList, dueSum: rowDue, pct: total ? Math.round((paidN / total) * 100) : 100, allPaid: dueN === 0 && total > 0 };
    });
    return { rows, dueCount, dueSum, draftCount };
  }, [buildingIds, feeStatus.byKey, commissions.data, maintenance.data, elevatorIds, buildings, visibleCats]);

  const pick = (k: string) => { setCategory(k); setPickerOpen(false); setOnlyDue(false); setGridTab('pay'); setNaOpen(false); setExpectedEdit(null); };
  const headerCat = (fam === 'over' ? undefined : cat) ?? { label: 'Tổng quan kỳ', sub: 'Còn thiếu phiếu · khớp Báo cáo Lợi Nhuận', icon: 'overview', accent: '#514c42' } as any;

  // ── Batch create (mobile) ──
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
      await createBatch.mutateAsync({ payerName: payer, voucherDate: batchDate, accountId: book, lines: batchLines.filter((l) => l.buildingId && l.amount > 0), attachments: batchAtts });
      toast.success('Đã tạo phiếu tổng bảo trì');
      setCreateOpen(false); setBatchLines([]); setPayer(''); setBatchAtts([]);
    } catch (ex) { toast.error((ex as Error).message); }
  };

  const mText = (m: 'ml' | 'mg') => (m === 'ml' ? 'Máy lạnh' : 'Máy giặt');
  const prevUnpaidComm = (prevCommissions.data ?? []).filter((r) => r.status !== 'paid').length;

  // ── EN card render ──
  const renderEnRow = (row: MeterRow) => {
    const k = row.key; const paid = EN.paidThisKy(row.accountId); const amount = EN.amountOf(k); const paying = EN.payingKey === k;
    const Icon = row.type === 'electric' ? Zap : Droplet;
    return (
      <div className="ubc-row" key={k} {...(paid ? {} : EN.pasteProps(k))}>
        <div className="ubc-rowhead">
          <span className={'ubc-ic ' + row.type}><Icon /></span>
          <input className="ubc-code" placeholder={row.type === 'electric' ? 'Mã PE' : 'Mã nước'} value={EN.codeOf(row)} onChange={(e) => EN.setField(row, { code: e.target.value })} onBlur={() => EN.saveMeter(row)} />
          <input className="ubc-holder" placeholder="Tên chủ hộ" value={EN.holderOf(row)} onChange={(e) => EN.setField(row, { holder: e.target.value })} onBlur={() => EN.saveMeter(row)} />
        </div>
        {paid ? (
          <div className="ubc-paid">
            <span className="ubc-paid-pill"><UtilityReceiptThumb attachments={paid.attachments} onView={EN.viewReceipt} size="sm" /><span className="ubc-paid-txt"><span className="ubc-paid-a">Đã đóng {paid.amount.toLocaleString('vi-VN')}</span><span className="ubc-paid-m">{fmtDate(paid.date)} · {paid.by}</span></span></span>
            <span className="ubc-bookchip"><BookIcon size={13} />{paid.book}</span>
            <button type="button" className="ubc-cancel" disabled={!canRecordPayment} onClick={() => EN.requestCancel(row)}><X /></button>
          </div>
        ) : (
          <div className="ubc-pay">
            <input className="ub-amt" type="text" inputMode="numeric" placeholder="Số tiền" value={formatVN(amount)} onFocus={() => EN.setActiveKey(k)} onChange={(e) => EN.setAmount(k, parseVN(e.target.value))} />
            <UtilityBookMenu accounts={EN.myBooks} valueId={EN.bookSel[k] ?? null} defaultId={EN.defaultBookId} onPick={(id) => EN.setBook(k, id)} compact disabled={!canRecordPayment} />
            <button type="button" className={'ub-attach' + (EN.attach[k] ? ' has' : '')} disabled={!canRecordPayment || EN.uploadingKey === k} onClick={() => EN.onAttachClick(k)}>{EN.uploadingKey === k ? <span className="ub-spin dark" /> : <Camera />}</button>
            <button type="button" className="ub-paybtn" disabled={!canRecordPayment || amount <= 0 || paying} onClick={() => EN.submitPay(row, row.buildingName)}>{paying ? <span className="ub-spin" /> : <Check />}</button>
          </div>
        )}
      </div>
    );
  };

  // ── GRID card (3 trạng thái) ──
  const renderGridCard = (b: { id: string; name: string }) => {
    const st = S.paidOf(b.id);
    if (st?.notApplicable) return null;
    const paid = !!st && st.paidAmount > 0;
    const hasDraft = !!st && st.draftAmount > 0;
    if (onlyDue && paid) return null;
    const vouchers = S.vouchersOf(b.id);
    const draftVoucher = vouchers.find((v) => v.status === 'UNAPPROVED');
    const paidVouchers = vouchers.filter((v) => v.status === 'APPROVED');
    const single = paidVouchers.length === 1 ? paidVouchers[0] : null;
    const n = S.nOf(b.id); const amount = S.amountOf(b.id); const paying = S.payingKey === b.id; const def = S.defaultAmountOf(b.id);
    const isEditingExp = expectedEdit?.bId === b.id;
    // Rê chuột vào thẻ + Ctrl+V = đính ảnh (đã có phiếu thì append vào phiếu).
    const pasteVoucher = paid ? (single ?? paidVouchers[0])?.id ?? null : null;
    const canPaste = paid ? !!pasteVoucher : !hasDraft;
    return (
      <div className="ptt-m-card" key={b.id} {...(canPaste ? S.rowPasteProps(b.id, pasteVoucher) : {})}>
        <div className="ptt-m-cardhead">
          <span className="ud-bldcode">{b.name}</span>
          <input className="ptt-m-code" placeholder={cat!.providerConfig ? 'Mã NCC' : 'Ghi chú'} value={S.codeOf(b.id)} onChange={(e) => S.setField(b.id, { code: e.target.value })} onBlur={() => S.saveConfig(b.id)} />
          {!paid && !hasDraft && (
            <button type="button" className="ptt-nabtn" title="Không áp dụng" disabled={!canRecordPayment} onClick={() => S.setNotApplicable(b.id, true)}><Ban /></button>
          )}
        </div>
        {cat!.multiPeriod && !paid && !hasDraft && (
          <div className="ptt-m-period">
            <Calendar />
            <span className="ptt-period-chips">
              {N_OPTIONS.map((v) => <button key={v} type="button" className={'ptt-period-chip' + (n === v ? ' on' : '')} onClick={() => S.setN(b.id, v)}>{v}</button>)}
              <input className="ptt-period-free" inputMode="numeric" placeholder="…" value={N_OPTIONS.includes(n) ? '' : String(n)} onChange={(e) => S.setN(b.id, parseVN(e.target.value) || 1)} />
            </span>
            <span className="ptt-period-range">{rangeLabel(period, addMonths(period, n - 1))}</span>
          </div>
        )}
        {cat!.multiPeriod && paid && st!.coveredStart && (
          <div className="ptt-cover self"><Calendar />Đã phủ {rangeLabel(st!.coveredStart.slice(0, 7), (st!.coveredEnd ?? st!.coveredStart).slice(0, 7))}</div>
        )}
        {paid ? (
          <div className="ubc-paid">
            <span className="ubc-paid-pill">
              <UtilityReceiptThumb attachments={(single ?? paidVouchers[0])?.attachments ?? []} onView={onView} size="sm" />
              <span className="ubc-paid-txt"><span className="ubc-paid-a">Đã đóng {st!.paidAmount.toLocaleString('vi-VN')}</span><span className="ubc-paid-m">{fmtDate(st!.coveredStart)}{hasDraft ? ` · +${formatVN(st!.draftAmount)} chờ duyệt` : ''}</span></span>
            </span>
            {(single ?? paidVouchers[0])?.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
            <span className="ptt-m-cardacts">
              <button type="button" className="ptt-quickcam" title="Đính nhanh ảnh" disabled={!canRecordPayment || S.uploadingKey === `__quick__${b.id}`} onClick={() => S.onQuickAttachClick(b.id, (single ?? paidVouchers[0]).id)}>{S.uploadingKey === `__quick__${b.id}` ? <span className="ub-spin dark" /> : <Camera />}</button>
              {vouchers.length > 1 ? (
                <button type="button" className="ptt-edit-btn" onClick={() => setVlistFor(b.id)}><ListChecks /></button>
              ) : (
                <>
                  <button type="button" className={'ptt-edit-btn' + (single?.isAuto ? ' auto' : '')} onClick={() => S.openEdit(b.id, single ?? undefined)}><Edit3 /></button>
                  {single?.cancellable && <button type="button" className="ubc-cancel" disabled={!canRecordPayment} onClick={() => S.requestCancel(b.id, single)}><X /></button>}
                </>
              )}
            </span>
          </div>
        ) : hasDraft && draftVoucher ? (
          <div className="ubc-paid">
            <span className="ubc-paid-pill draft"><span className="ubc-paid-txt"><span className="ubc-paid-a">Chờ duyệt {st!.draftAmount.toLocaleString('vi-VN')}</span><span className="ubc-paid-m">chờ thanh toán · {fmtDate(draftVoucher.date)}</span></span></span>
            {draftVoucher.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
            <span className="ptt-m-cardacts">
              <button type="button" className="ptt-paydraft" disabled={!canRecordPayment} onClick={() => S.openPayDraft(b.id, draftVoucher)}><HandCoins />Thanh toán</button>
              {vouchers.length > 1 && <button type="button" className="ptt-edit-btn" onClick={() => setVlistFor(b.id)}><ListChecks /></button>}
            </span>
          </div>
        ) : isEditingExp ? (
          <div className="ubc-pay">
            <input autoFocus className="ub-amt" inputMode="numeric" value={formatVN(expectedEdit!.value)}
              onChange={(e) => setExpectedEdit({ bId: b.id, value: parseVN(e.target.value) })}
              onBlur={() => { S.saveExpected(b.id, expectedEdit!.value || null); setExpectedEdit(null); }} />
            <span className="ptt-expedit-hint">dự kiến/kỳ</span>
          </div>
        ) : (
          <>
            <div className="ubc-pay">
              <input className="ub-amt" type="text" inputMode="numeric" placeholder={def ? formatVN(def * (cat!.multiPeriod ? n : 1)) : 'Số tiền'} value={formatVN(amount)} onChange={(e) => S.setAmount(b.id, parseVN(e.target.value))} />
              <button type="button" className="ptt-exppencil" title="Số tiền dự kiến" onClick={() => setExpectedEdit({ bId: b.id, value: def ?? 0 })}><Pencil /></button>
              <UtilityBookMenu accounts={S.myBooks} valueId={S.bookSel[b.id] ?? null} defaultId={S.defaultBookFor(b.id)} onPick={(id) => S.setBook(b.id, id)} compact disabled={!canRecordPayment} />
              <button type="button" className={'ub-attach' + (S.attach[b.id] ? ' has' : '')} disabled={!canRecordPayment || S.uploadingKey === b.id} onClick={() => S.onAttachClick(b.id)}>{S.uploadingKey === b.id ? <span className="ub-spin dark" /> : <Camera />}</button>
              <button type="button" className="ub-paybtn" disabled={!canRecordPayment || amount <= 0 || paying} onClick={() => S.submitPay(b.id)}>{paying ? <span className="ub-spin" /> : <Check />}</button>
            </div>
            {cat!.multiPeriod && n > 1 && amount > 0 && <div className="ptt-total">≈ <b>{fmtFull(Math.round(amount / n))}</b>/kỳ × {n} kỳ</div>}
          </>
        )}
      </div>
    );
  };

  const gridVisibleIds = fam === 'GRID' ? visibleIdsFor(cat!) : [];
  const gridBlds = buildings.filter((b) => gridVisibleIds.includes(b.id));
  const naRows = gridBlds.filter((b) => S.paidOf(b.id)?.notApplicable);

  const historyDays = (() => {
    if (fam !== 'GRID') return [] as { date: string; sum: number; rows: { v: PeriodFeeVoucher; bld: string }[] }[];
    const map = new Map<string, { date: string; sum: number; rows: { v: PeriodFeeVoucher; bld: string }[] }>();
    for (const b of gridBlds) for (const v of S.vouchersOf(b.id)) {
      let g = map.get(v.date);
      if (!g) { g = { date: v.date, sum: 0, rows: [] }; map.set(v.date, g); }
      g.rows.push({ v, bld: b.name });
      if (v.status === 'APPROVED') g.sum += v.amount;
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  })();

  return (
    <>
      <input ref={S.fileRef} type="file" accept="image/*" hidden onChange={S.onFileChange} />
      <input ref={EN.fileRef} type="file" accept="image/*" hidden onChange={EN.onFileChange} />
      <input ref={batchFileRef} type="file" accept="image/*" hidden onChange={onBatchFile} />
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet full ptt-sheet' + (show ? ' show' : '')}>
        {/* Header */}
        <div className="ptt-m-head">
          <button type="button" className="ptt-m-trigger" onClick={() => setPickerOpen(true)}>
            <span className="ptt-m-ic" style={{ background: headerCat.accent + '18', color: headerCat.accent }}><FeeIcon name={headerCat.icon} style={{ width: 18, height: 18 }} /></span>
            <span className="ptt-m-tt"><span className="ptt-m-lbl">{fam === 'over' ? 'Tổng quan kỳ' : cat!.label}<ChevronDown /></span><span className="ptt-m-sub">Kỳ {fmtBillingMonth(period)} · {fam === 'over' ? 'Còn thiếu phiếu' : cat!.sub}</span></span>
          </button>
          <button type="button" className="rp-x" onClick={onClose}><X /></button>
        </div>

        <div className="sheet-scroll ptt-m-body">
          {/* OVERVIEW */}
          {fam === 'over' && (
            <div className="ptt-m-ov">
              <div className="ptt-m-ovtop">
                <div className="ptt-m-ovcard red"><div className="ptt-ov-lbl">Còn thiếu</div><div className="ptt-m-ovbig">{overview.dueCount}</div><div className="ptt-ov-sub">khoản{overview.draftCount > 0 ? ` · ${overview.draftCount} chờ duyệt` : ''}</div></div>
                <div className="ptt-m-ovcard amber"><div className="ptt-ov-lbl">Dự kiến</div><div className="ptt-m-ovmid">{fmtFull(overview.dueSum)}</div><div className="ptt-ov-sub">còn phải chi</div></div>
              </div>
              {overview.rows.map((r) => (
                <div className="ptt-m-ovrow" key={r.cat.key}>
                  <div className="ptt-m-ovrow-top">
                    <span className="ptt-ov-hm-ic" style={{ background: r.cat.accent + '18', color: r.cat.accent }}><FeeIcon name={r.cat.icon} style={{ width: 15, height: 15 }} /></span>
                    <span className="ptt-m-ovrow-lbl">{r.cat.label}{r.draftN > 0 && <span className="ptt-badge-draft">{r.draftN} chờ duyệt</span>}</span>
                    <span className="ptt-m-ovrow-prog">{r.paidN}/{r.total}</span>
                    {r.dueN > 0 ? <button type="button" className="ptt-go sm" onClick={() => pick(r.cat.key)}>Đóng<ArrowRight /></button> : r.allPaid ? <span className="ptt-ov-check sm"><Check /></span> : null}
                  </div>
                  {r.dueN > 0 && (
                    <>
                      <div className="ptt-m-ovrow-bar"><span className="ptt-prog-bar grow"><span className="ptt-prog-fill" style={{ width: r.pct + '%' }} /></span><span className="ptt-m-ovrow-due">{fmtFull(r.dueSum)}</span></div>
                      <div className="ptt-ov-chips wrap">{r.dueList.map((n) => <span key={n} className="ptt-chip due">{n}</span>)}</div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ĐIỆN & NƯỚC */}
          {fam === 'EN' && (
            <>
              <div className="ub-filter">
                <div className="ub-segs">
                  <button type="button" className={'ub-seg' + (enType === 'all' ? ' on' : '')} onClick={() => setEnType('all')}>Tất cả</button>
                  <button type="button" className={'ub-seg' + (enType === 'electric' ? ' on' : '')} onClick={() => setEnType('electric')}><Zap />Điện</button>
                  <button type="button" className={'ub-seg' + (enType === 'water' ? ' on' : '')} onClick={() => setEnType('water')}><Droplet />Nước</button>
                </div>
                <button type="button" className={'ub-due' + (onlyDue ? ' on' : '')} onClick={() => setOnlyDue((v) => !v)}>{onlyDue ? <Check /> : <span className="ub-due-box" />}Chưa đóng</button>
              </div>
              <div className="ubc-list">
                {buildings.map((b) => {
                  const rows = EN.metersOf(b.id).filter((r) => (enType === 'all' || r.type === enType) && !(onlyDue && EN.paidThisKy(r.accountId)));
                  if (rows.length === 0) return null;
                  const dueN = EN.metersOf(b.id).filter((r) => !EN.paidThisKy(r.accountId)).length;
                  return (
                    <div className="ubc" key={b.id}>
                      <div className="ubc-head"><span className="ubc-bld">{b.name}</span>{dueN === 0 ? <span className="ubc-badge done">Đã xong</span> : <span className="ubc-badge pending">{dueN} khoản chưa đóng</span>}</div>
                      {rows.map(renderEnRow)}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* GRID */}
          {fam === 'GRID' && (
            <div className="ptt-m-grid">
              <div className="ptt-gridstat" style={{ borderLeftColor: cat!.accent }}>
                <span className="ptt-gridstat-ic" style={{ background: cat!.accent + '18', color: cat!.accent }}><FeeIcon name={cat!.icon} style={{ width: 18, height: 18 }} /></span>
                <div className="ptt-gridstat-h"><div className="ptt-gridstat-title">{cat!.label}</div><div className="ptt-gridstat-sub">kỳ {fmtBillingMonth(period)}</div></div>
              </div>
              {cat!.restricted && <div className="ptt-note warn"><Lock /><span>Hạng mục hạn chế — chỉ người có quyền thấy phiếu.</span></div>}
              {cat!.elevatorGated && <div className="ptt-note info"><Info /><span>Hiện {gridVisibleIds.length} tòa có thang máy (gồm tòa có phiếu kỳ này).</span></div>}
              <div className="ptt-m-gridtabs">
                <button type="button" className={'ub-seg' + (gridTab === 'pay' ? ' on' : '')} onClick={() => setGridTab('pay')}>Đóng tiền</button>
                <button type="button" className={'ub-seg' + (gridTab === 'history' ? ' on' : '')} onClick={() => setGridTab('history')}><History />Lịch sử</button>
                {gridTab === 'pay' && <button type="button" className={'ub-due' + (onlyDue ? ' on' : '')} onClick={() => setOnlyDue((v) => !v)}>{onlyDue ? <Check /> : <span className="ub-due-box" />}Chưa đóng</button>}
              </div>

              {gridTab === 'pay' && (
                <div className="ubc-list">
                  {gridBlds.map(renderGridCard)}
                  {naRows.length > 0 && (
                    <div className="ptt-nagroup">
                      <button type="button" className="ptt-nagroup-head" onClick={() => setNaOpen((v) => !v)}><Ban /> Không áp dụng ({naRows.length}) <ChevronDown className={naOpen ? 'up' : ''} /></button>
                      {naOpen && naRows.map((b) => (
                        <div className="ptt-narow" key={b.id}>
                          <span className="ud-bldcode">{b.name}</span>
                          <button type="button" className="ptt-btn ghost sm" onClick={() => S.setNotApplicable(b.id, false)}>Bật lại</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {gridTab === 'history' && (
                <div className="ptt-m-hist">
                  {historyDays.length === 0 ? <div className="c-empty"><div className="e-ic">🧾</div><p>Kỳ này chưa có phiếu.</p></div> : historyDays.map((d) => (
                    <div className="ptt-m-histday" key={d.date}>
                      <div className="ptt-m-histhead"><span>{fmtDate(d.date)}</span><span className="ptt-m-histsum">{fmtFull(d.sum)}</span></div>
                      {d.rows.map(({ v, bld }) => (
                        <div className="ptt-m-histrow" key={v.id}>
                          <span className="ud-bldcode">{bld}</span>
                          {v.status === 'UNAPPROVED' ? <span className="ptt-badge-draft">CHỜ DUYỆT</span> : v.isAuto ? <span className="ptt-auto">TỰ ĐỘNG</span> : null}
                          <UtilityReceiptThumb attachments={v.attachments} onView={onView} size="sm" />
                          <span className="ptt-m-histamt ud-mono">{fmtFull(v.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* COMMISSION */}
          {fam === 'COMMISSION' && (() => {
            const rows = commissions.data ?? [];
            const paidSum = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + (r.voucherAmount ?? r.expectedAmount), 0);
            const draftN = rows.filter((r) => r.status === 'draft').length;
            const dueSum = rows.filter((r) => r.status === 'unpaid').reduce((s, r) => s + r.expectedAmount, 0);
            return (
              <div className="ptt-m-comm">
                {prevUnpaidComm > 0 && (
                  <div className="ptt-note warn"><Info /><span>Kỳ trước ({fmtBillingMonth(prevPeriod)}) còn <b>{prevUnpaidComm} HĐ</b> chưa chi HH.</span>{onBillingMonthChange && <button type="button" className="ptt-btn ghost sm" onClick={() => onBillingMonthChange(prevPeriod)}>Xem</button>}</div>
                )}
                <div className="ptt-m-commstats">
                  <div className="ptt-m-commcard green"><div className="ptt-ov-lbl">Đã chi</div><div className="ptt-m-commnum green">{fmtFull(paidSum)}</div></div>
                  <div className="ptt-m-commcard amber"><div className="ptt-ov-lbl">Chờ duyệt</div><div className="ptt-m-commnum amber">{draftN}</div></div>
                  <div className="ptt-m-commcard red"><div className="ptt-ov-lbl">Chưa chi</div><div className="ptt-m-commnum red">{fmtFull(dueSum)}</div></div>
                </div>
                {rows.length === 0 ? <div className="c-empty"><div className="e-ic">📄</div><p>Không có HĐ ký trong kỳ.</p></div> : rows.map((r) => (
                  <div className="ptt-m-commrow" key={r.contractId}>
                    <div className="ptt-m-commr1"><span className="ud-mono2">{r.contractNumber ?? '—'}</span><span className="ptt-m-commroom">{r.buildingName} · {r.roomName ?? ''}</span>{r.status === 'paid' && <span className="ptt-comm-paid sm">Đã chi</span>}{r.status === 'draft' && <span className="ptt-badge-draft">CHỜ DUYỆT</span>}</div>
                    <div className="ptt-m-commr2"><div className="ptt-m-commtenant"><div>{r.tenantName}</div><div className="ptt-m-commmeta">Ký {fmtDate(r.signedDate)} · {r.months} th · bậc {r.tierPercent != null ? r.tierPercent + '%' : '—'}</div></div><span className={'ud-mono' + (r.status === 'paid' ? ' paid' : '')}>{fmtFull(r.voucherAmount ?? r.expectedAmount)}</span></div>
                    {r.status === 'unpaid' && <button type="button" className="ptt-m-commbtn" disabled={!canRecordPayment} onClick={() => setCommRow(r)}><HandCoins />Chi hoa hồng</button>}
                    {r.status === 'draft' && <button type="button" className="ptt-m-commbtn draft" disabled={!canRecordPayment} onClick={() => setCommRow(r)}><Check />Duyệt phiếu chờ duyệt</button>}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* MAINTENANCE */}
          {fam === 'MAINTENANCE_BATCH' && (
            <div className="ptt-m-batch">
              <button type="button" className={'ptt-batch-create wide' + (createOpen ? ' on' : '')} disabled={!canRecordPayment} onClick={() => { setCreateOpen((v) => !v); if (!createOpen && batchLines.length === 0) addLine(); }}><Plus />Tạo phiếu tổng mới</button>

              {createOpen && (
                <div className="ptt-batch-form m">
                  <label className="ptt-field"><span className="ptt-field-lbl">Nhà cung cấp</span><input className="ptt-field-in" value={payer} placeholder="Tên NCC" onChange={(e) => setPayer(e.target.value)} /></label>
                  <div className="ptt-edit-row">
                    <label className="ptt-field"><span className="ptt-field-lbl">Ngày phiếu</span><input type="date" className="ptt-field-in" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></label>
                    <label className="ptt-field"><span className="ptt-field-lbl">Sổ quỹ</span><UtilityBookMenu accounts={S.myBooks} valueId={batchBook} defaultId={S.defaultBookId} onPick={setBatchBook} compact /></label>
                  </div>
                  <div className="ptt-batch-lines">
                    {batchLines.map((ln, i) => (
                      <div className="ptt-batch-line" key={i}>
                        <select className="ptt-batch-bld" value={ln.buildingId} onChange={(e) => setLine(i, { buildingId: e.target.value })}>
                          {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                        <select className="ptt-batch-sub" value={ln.subtype} onChange={(e) => setLine(i, { subtype: e.target.value as 'ml' | 'mg' })}><option value="ml">ML</option><option value="mg">MG</option></select>
                        <input className="ptt-batch-amt mono" inputMode="numeric" placeholder="Tiền" value={formatVN(ln.amount)} onChange={(e) => setLine(i, { amount: parseVN(e.target.value) })} />
                        <button type="button" className="ptt-batch-rm" onClick={() => rmLine(i)}><Trash2 /></button>
                      </div>
                    ))}
                    <button type="button" className="ptt-batch-addline" onClick={addLine}><Plus />Thêm dòng</button>
                  </div>
                  <div className="ptt-batch-attrow">
                    <UtilityReceiptThumb attachments={batchAtts} onView={onView} size="md" />
                    <button type="button" className="ptt-edit-addimg" disabled={batchUploading} onClick={() => batchFileRef.current?.click()}>
                      {batchUploading ? <span className="ub-spin dark" /> : <Camera />}
                      {batchAtts.length > 0 ? `${batchAtts.length} ảnh` : 'Ảnh phiếu tổng'}
                    </button>
                  </div>
                  <div className="ptt-batch-foot">
                    <span className="ptt-batch-totallbl">Tổng</span>
                    <span className="ptt-batch-total">{fmtFull(batchTotal)}</span>
                    <button type="button" className="ptt-btn ghost sm" onClick={() => setCreateOpen(false)}>Hủy</button>
                    <button type="button" className="ptt-btn go sm" disabled={createBatch.isPending} onClick={saveBatch}>{createBatch.isPending ? <span className="ub-spin" /> : <Check />}Lưu</button>
                  </div>
                </div>
              )}

              {maintenance.groups.map((bt) => (
                <div className="ptt-m-batchgroup" key={bt.batchId}>
                  <div className="ptt-m-batchhead"><span className="ptt-batch-gic"><FeeIcon name="wrench" style={{ width: 15, height: 15 }} /></span><div className="ptt-batch-gh"><div className="ptt-batch-gtitle">{bt.payerName ?? 'Phiếu tổng'}</div><div className="ptt-batch-gmeta">{bt.lines.length} tòa</div></div><span className="ptt-batch-gtotal">{fmtFull(bt.total)}</span></div>
                  {bt.lines.map((ln) => (
                    <div className="ptt-m-batchrow" key={ln.voucherId}><span className="ud-bldcode">{ln.buildingName}</span><span className={'ptt-mchip ' + ln.subtype}>{mText(ln.subtype)}</span><span className="ptt-m-batchamt ud-mono">{fmtFull(ln.amount)}</span></div>
                  ))}
                </div>
              ))}
              {maintenance.standalone.length > 0 && (
                <div className="ptt-m-batchgroup">
                  <div className="ptt-batch-sohead"><span className="ptt-batch-sotitle">Phiếu lẻ (chưa gộp)</span></div>
                  {maintenance.standalone.map((r) => (
                    <div className="ptt-m-batchrow" key={r.voucherId}><span className="ud-bldcode">{r.buildingName}</span><span className={'ptt-mchip ' + r.subtype}>{mText(r.subtype)}</span><span className="ptt-m-batchamt ud-mono">{fmtFull(r.amount)}</span></div>
                  ))}
                </div>
              )}
              {maintenance.groups.length === 0 && maintenance.standalone.length === 0 && !createOpen && <div className="c-empty"><div className="e-ic">🔧</div><p>Kỳ này chưa có phiếu bảo trì.</p></div>}
            </div>
          )}

          <div className="rp-foot"><button type="button" className="rp-close" onClick={() => setPickerOpen(true)}><LayoutGrid style={{ width: 16, height: 16 }} />Đổi loại phí</button></div>
        </div>

        {/* Category picker */}
        <div className={'ptt-picker-scrim' + (pickerOpen ? ' show' : '')} onClick={() => setPickerOpen(false)} />
        <div className={'ptt-picker' + (pickerOpen ? ' show' : '')}>
          <div className="ptt-picker-grip" />
          <div className="ptt-picker-head"><span>Chọn loại phí</span><button type="button" className="rp-x" onClick={() => setPickerOpen(false)}><X /></button></div>
          <div className="ptt-picker-list">
            <button type="button" className={'ptt-menu-item ov' + (fam === 'over' ? ' on' : '')} onClick={() => pick('overview')}><span className="ptt-menu-ic ov"><FeeIcon name="overview" style={{ width: 15, height: 15 }} /></span><span className="ptt-menu-lbl grow">Tổng quan kỳ</span>{fam === 'over' && <Check className="ptt-menu-check" />}</button>
            {FEE_GROUPS.map((g) => (
              <div key={g}>
                <div className="ptt-menu-group">{g}</div>
                {visibleCats.filter((c) => c.group === g).map((c) => {
                  const active = c.key === category; const due = dueCountFor(c);
                  return (
                    <button key={c.key} type="button" className={'ptt-menu-item' + (active ? ' on' : '')} onClick={() => pick(c.key)}>
                      <span className="ptt-menu-ic" style={{ background: active ? '#1b1813' : c.accent + '18', color: active ? '#fff' : c.accent }}><FeeIcon name={c.icon} style={{ width: 15, height: 15 }} /></span>
                      <span className="ptt-menu-lbl grow">{c.label}</span>
                      {due > 0 && c.family !== 'MAINTENANCE_BATCH' && <span className="ptt-badge">{due}</span>}
                      {active && <Check className="ptt-menu-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modals dùng chung */}
      <PeriodFeeEditModal target={S.editTarget} isAdmin={isAdmin} myBooks={S.myBooks} saving={S.saving} uploading={S.uploadingKey === '__edit__'} onAttach={S.onEditAttachClick} onView={onView} onClose={S.closeEdit} onSave={(args) => S.submitEdit({ isAdmin, ...args })} />
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
      <PeriodFeeDupConfirmModal target={S.dupConfirm} busy={S.payingKey != null} onClose={S.closeDupConfirm} onConfirm={S.confirmPayDup} />
      <PeriodCommissionModal row={commRow} myBooks={S.myBooks} defaultBookId={S.defaultBookId} onClose={() => setCommRow(null)} />
      <UtilityCancelModal target={S.cancelTarget || EN.cancelTarget} busy={S.cancelling || EN.cancelling} onClose={() => { S.closeCancel(); EN.closeCancel(); }} onConfirm={S.cancelTarget ? S.confirmCancel : EN.confirmCancel} />
      {/* 2 nguồn ảnh (GRID viewer + EN receiptView) — chọn theo nguồn ĐANG MỞ
          (index != null), tránh dính ảnh cũ của nguồn kia sau khi đóng. */}
      <AttachmentLightbox
        attachments={viewer.index != null ? viewer.attachments : EN.receiptView.attachments}
        index={viewer.index ?? EN.receiptView.index}
        onIndexChange={(i) => {
          if (viewer.index != null) setViewer((v) => ({ ...v, index: i }));
          else EN.setReceiptIndex(i);
        }}
      />
    </>
  );
}

export default PeriodFeeSheet;
