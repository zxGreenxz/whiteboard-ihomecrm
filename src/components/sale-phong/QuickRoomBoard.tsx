import { roomPhotoCount } from '@/lib/roomMedia';
import { compareBuildingNames } from '@/lib/roomSort';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, DoorOpen, ImagePlus, LockKeyhole, Megaphone, RefreshCw, Search, SlidersHorizontal, TimerReset, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading/LoadingState';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSession } from '@/hooks/useAuth';
import { useSaleRoomInventory, usePatchSaleRoom } from '@/hooks/useSaleRoomInventory';
import type { SaleRoomInventoryRow } from '@/lib/saleRoomOperations';
import { SaleRoomOperationError, saleRoomOperationErrorMessage } from '@/lib/saleRoomOperations';
import { RoomTurnoverPanel } from '@/components/rooms/RoomTurnoverPanel';
import { LockRoomModal, type SaleLockAction } from '@/pages/phong-trong/LockRoomModal';
import { QuickDepositModal } from '@/pages/phong-trong/QuickDepositModal';
import type { Room } from '@/pages/phong-trong/sampleData';
import '@/pages/phong-trong/phongTrong.css';
import SaleImageManager from './SaleImageManager';
import { SaleRoomNoticeDialog } from './SaleRoomNoticeDialog';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import PassListingsTab from './PassListingsTab';
import { ExitHoldDialog, type ExitHoldAction } from './ExitHoldDialog';
import { EXIT_HOLD_STATUS_LABEL, exitHoldActionBlockedReason, exitHoldLines, isExitHeld } from '@/pages/phong-trong/exitHold';
import { depositHoldLines, depositHoldStale, hasPrecontractDeposit, isDepositHeld } from '@/pages/phong-trong/depositHold';
import { roomSaleDepositLabel } from '@/lib/roomSaleFacts';
import { salePolicyTimeLabel } from '@/lib/saleRoomPolicyTypes';
import {
  newQuickRoomDraft, quickRoomChanges, quickRoomDraftDirty, quickRoomDraftTextChanged, quickRoomPriceWarning, readQuickRoomDrafts, roomSearchMatches, roomSearchWords,
  type QuickRoomDraft,
} from './quickRoomDraft';

type StatusFilter = 'all' | 'open' | Room['status'] | 'preparing' | 'exit-hold' | 'deposit-hold' | 'missing-images' | 'draft';
const SaleRoomBatchPanel = lazy(() => import('./SaleRoomBatchPanel'));
const EMPTY_ROOMS: SaleRoomInventoryRow[] = [];
const FILTERS: Array<{ value: StatusFilter; label: string; short?: string }> = [
  { value: 'all', label: 'Mọi tình trạng' },
  { value: 'open', label: 'Còn chào được (trống, sắp trống, lock, pass, chờ sang nhượng)', short: 'Còn chào được' }, { value: 'free', label: 'Trống sẵn' },
  { value: 'soon', label: 'Sắp trống / cần xác nhận' }, { value: 'preparing', label: 'Đang chuẩn bị' },
  { value: 'locked', label: 'Đang lock' }, { value: 'pass', label: 'Khách pass' },
  { value: 'rented', label: 'Đã thuê / giữ chỗ' }, { value: 'deposit-hold', label: 'Đã cọc chờ hợp đồng' }, { value: 'exit-hold', label: 'Chờ khách sang nhượng' },
  { value: 'missing-images', label: 'Thiếu ảnh' }, { value: 'draft', label: 'Có bản nháp của tôi' },
];
// Bảng nội bộ: phòng giữ bằng cọc ghi «Đã cọc · người nộp · N ngày» (nhãn riêng, KHÔNG phải saleFact.label công khai).
const statusLabel = (room: Room) => room.status === 'locked' ? 'Đang lock' : isExitHeld(room) ? EXIT_HOLD_STATUS_LABEL
  : isDepositHeld(room) && room.depositHold ? roomSaleDepositLabel(room.depositHold) : room.saleFact?.label ?? ({
  free: 'Trống sẵn', soon: 'Cần xác nhận ngày trống', rented: 'Đã thuê / giữ chỗ', pass: 'Khách pass phòng',
}[room.status]);
/** Cọc theo luật hiện có (trống / sắp trống / lock) và phòng đang giữ cho khách sang nhượng: người khác vẫn cọc được. */
const depositableStatus = (room: Room) => ['free', 'soon', 'locked'].includes(room.status) || hasPrecontractDeposit(room) || isExitHeld(room);
/**
 * Phòng đang có khách ở: đã thuê, sắp trống (khách báo trả) hoặc khách đã nhờ pass. Phòng trống, đang lock
 * (máy chủ che tình trạng thật), phòng giữ cho khách sang nhượng (khách cũ đã trả) và phòng chỉ có cọc giữ chỗ của
 * khách mới (chưa có ai ở — máy chủ báo room_occupied) không có ai để báo.
 */
const occupiedStatus = (room: Room) => ['rented', 'soon', 'pass'].includes(room.status) && !isExitHeld(room)
  && !(isDepositHeld(room) && room.depositHold?.roomOccupied === false);
/** Bộ lọc «Còn chào được» (mặc định trên điện thoại): mọi phòng trừ đã thuê / giữ chỗ; vẫn giữ lock, pass, chờ sang nhượng. */
const openForSale = (room: Room) => room.status !== 'rented' || hasPrecontractDeposit(room) || isExitHeld(room);
const money = (value: number | null) => value == null ? 'Chưa khai giá' : `${value.toLocaleString('vi-VN')} đ`;
const timeLabel = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Chưa có thời điểm';
  return new Date(value).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
};
const rowLabel = (row: SaleRoomInventoryRow) => `${row.buildingName} · ${row.name}${row.code && row.code !== row.name ? ` (${row.code})` : ''}`;

/** Full scoped inventory for operators. Public availability remains a separate projection. */
export default function QuickRoomBoard({ mobile = false, onBusyChange }: { mobile?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { selectedOrganizationId } = useOrganization();
  const { data: session } = useSession();
  const actor = session?.user?.id;
  if (!selectedOrganizationId || !actor) {
    return <p className="rounded-lg border p-5 text-sm text-muted-foreground">Chọn tổ chức và đăng nhập để cập nhật phòng trong phạm vi được giao.</p>;
  }
  const storageKey = `sale-room-drafts:v1:${actor}:${selectedOrganizationId}`;
  return <QuickRoomBoardContent key={storageKey} mobile={mobile} storageKey={storageKey} organizationId={selectedOrganizationId} actorId={actor} onBusyChange={onBusyChange} />;
}

function QuickRoomBoardContent({ mobile, storageKey, organizationId, actorId, onBusyChange }: { mobile: boolean; storageKey: string; organizationId: string; actorId: string; onBusyChange?: (busy: boolean) => void }) {
  const inventory = useSaleRoomInventory();
  const { data: permissions } = useMyPermissions();
  const [noticeRoomId, setNoticeRoomId] = useState<string | null>(null);
  // Chỉ phòng đang có khách mới báo được sắp trống: phòng giữ cho khách sang nhượng đã trả phòng (hợp đồng
  // cũ không còn ở), phòng đang lock thì máy chủ che tình trạng thật nên không biết có hợp đồng nào để báo.
  const canReport = (row: SaleRoomInventoryRow) => occupiedStatus(row.room)
    && canUse(permissions, 'contracts', 'view', row.buildingId)
    && canUse(permissions, 'contracts', 'edit', row.buildingId)
    && canUse(permissions, 'contracts', 'terminate', row.buildingId);
  const update = usePatchSaleRoom();
  const rows = inventory.data?.rooms ?? EMPTY_ROOMS;
  const [search, setSearch] = useState('');
  const [buildingId, setBuildingId] = useState('');
  // Điện thoại mở sẵn phòng còn chào được; phòng đã thuê chỉ hiện khi chọn bộ lọc khác.
  const [status, setStatus] = useState<StatusFilter>(mobile ? 'open' : 'all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, QuickRoomDraft>>(() => readQuickRoomDrafts(storageKey));
  const [uploading, setUploading] = useState(false);
  const [turnoverBusy, setTurnoverBusy] = useState(false);
  const [turnoverEditing, setTurnoverEditing] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState<{ text: string; roomId: string } | null>(null);
  const [lockAction, setLockAction] = useState<SaleLockAction | null>(null);
  const [depositRoom, setDepositRoom] = useState<Room | null>(null);
  const [passRoomId, setPassRoomId] = useState<string | null>(null);
  const [holdAction, setHoldAction] = useState<ExitHoldAction | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchRoomIds, setBatchRoomIds] = useState<string[]>([]);
  const submitting = useRef(false);
  const editor = useRef<HTMLFormElement>(null);
  const busy = update.isPending || uploading || turnoverBusy || batchBusy;
  const blocked = inventory.isError || !inventory.data || busy || turnoverEditing || batchOpen;
  const selected = rows.find(row => row.room.id === selectedId);
  const savedDraft = selectedId ? drafts[selectedId] : undefined;
  // Giữ chữ đang gõ kể cả khi chỉ đổi cách viết giá (không phải bản nháp): ô nhập không tự nhảy về chữ cũ.
  // Chữ chỉ đổi cách viết mà máy chủ đã có bản mới thì lấy bản mới, không báo "đối chiếu" cho thứ chưa sửa.
  const draft = selected ? (savedDraft && (quickRoomDraftDirty(savedDraft) || savedDraft.request?.unknown
    || (quickRoomDraftTextChanged(savedDraft) && savedDraft.revision === selected.revision))
    ? savedDraft : newQuickRoomDraft(selected, selected.revision)) : undefined;
  const dirty = !!draft && quickRoomDraftDirty(draft);
  const priceWarning = draft ? quickRoomPriceWarning(draft.price) : null;
  const stale = !!selected && !!draft && (selected.revision !== draft.revision || !!draft.request?.conflict);
  const unknown = !!draft?.request?.unknown;
  const draftCount = rows.filter(row => drafts[row.room.id] && quickRoomDraftDirty(drafts[row.room.id])).length;
  const noticeRoom = rows.find(row => row.room.id === noticeRoomId && canReport(row));
  const navigationBusy = busy || batchOpen || turnoverEditing || !!selectedId || !!lockAction || !!depositRoom || !!passRoomId || !!noticeRoom || !!holdAction;
  useEffect(() => { if (noticeRoomId && !noticeRoom) setNoticeRoomId(null); }, [noticeRoomId, noticeRoom]);
  useEffect(() => { onBusyChange?.(navigationBusy); return () => onBusyChange?.(false); }, [navigationBusy, onBusyChange]);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(drafts));
      setStorageWarning(false);
    } catch { setStorageWarning(true); }
  }, [drafts, storageKey]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!busy && !turnoverEditing && !draftCount) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, turnoverEditing, draftCount]);

  const buildings = useMemo(() => [...new Map(rows.map(row => [row.buildingId, row.buildingName])).entries()]
    .sort((left, right) => compareBuildingNames(left[1], right[1])), [rows]);
  // Đang tìm mà bộ lọc còn ở mặc định «Còn chào được» của điện thoại: tìm trên mọi phòng, vì Báo sắp trống /
  // Báo pass chỉ có ở phòng đang có khách — gõ «101» để báo trả mà không thấy phòng là chặn mất việc.
  const searchAll = mobile && status === 'open' && roomSearchWords(search).length > 0;
  const effectiveStatus: StatusFilter = searchAll ? 'all' : status;
  const visible = useMemo(() => {
    return rows.filter(row => {
      if (buildingId && row.buildingId !== buildingId) return false;
      if (!roomSearchMatches(`${row.buildingName} ${row.name} ${row.code ?? ''}`, search)) return false;
      const status = effectiveStatus;
      if (status === 'missing-images') return roomPhotoCount(row.images) === 0;
      if (status === 'draft') return !!drafts[row.room.id] && quickRoomDraftDirty(drafts[row.room.id]);
      if (status === 'preparing') return row.room.saleFact?.kind === 'preparing';
      if (status === 'exit-hold') return !!row.room.exitHold;
      if (status === 'deposit-hold') return isDepositHeld(row.room);
      if (status === 'open') return openForSale(row.room);
      if (status === 'free') return row.room.status === 'free' && row.room.saleFact?.kind !== 'preparing';
      return status === 'all' || row.room.status === status;
    });
  }, [rows, search, buildingId, effectiveStatus, drafts]);
  // Phòng đúng tòa + từ khoá nhưng đang bị bộ lọc «Còn chào được» ẩn: nói rõ số lượng, không để người dùng tưởng không có.
  const hiddenRented = useMemo(() => effectiveStatus !== 'open' ? 0 : rows.filter(row => (!buildingId || row.buildingId === buildingId)
    && roomSearchMatches(`${row.buildingName} ${row.name} ${row.code ?? ''}`, search) && !openForSale(row.room)).length, [rows, search, buildingId, effectiveStatus]);
  const [batchHidden, setBatchHidden] = useState(0);

  const openRoom = (id: string) => {
    if (busy || turnoverEditing) return;
    setSelectedId(id);
    setErrors({});
    setWriteError('');
  };
  const change = <K extends keyof QuickRoomDraft>(field: K, value: QuickRoomDraft[K]) => {
    if (!selected || !draft || unknown || update.isPending) return;
    setDrafts(current => ({ ...current, [selected.room.id]: { ...draft, [field]: value } }));
    setErrors(current => ({ ...current, [field]: '' }));
    setWriteError('');
  };
  const removeDraft = (id: string) => setDrafts(current => {
    const next = { ...current }; delete next[id]; return next;
  });
  const done = (text: string, roomId: string) => {
    setNotice({ text, roomId });
    void inventory.refetch();
  };
  const save = async (reconcile = false) => {
    if (!selected || !draft || blocked || submitting.current || (stale && !reconcile) || (unknown && !reconcile)) return;
    const changes = quickRoomChanges(draft, { edit: selected.capabilities.edit === true, images: selected.capabilities.images === true });
    // An unknown attempt is replayed byte-for-byte. Newly revoked permissions are
    // rechecked by the writer, never used to silently shrink its original payload.
    const patch = reconcile && draft.request?.patch ? draft.request.patch : changes.patch;
    const invalid = reconcile && draft.request?.patch ? {} : changes.errors;
    setErrors(invalid);
    if (Object.keys(invalid).length) {
      editor.current?.querySelector<HTMLElement>(`[name="${Object.keys(invalid)[0]}"]`)?.focus();
      return;
    }
    if (!Object.keys(patch).length) return;
    const fingerprint = JSON.stringify({ roomId: selected.room.id, expectedRevision: draft.revision, patch });
    const request = reconcile && draft.request ? draft.request
      : draft.request?.fingerprint === fingerprint ? draft.request : { id: crypto.randomUUID(), fingerprint, patch };
    const id = selected.room.id;
    const pendingDrafts = { ...drafts, [id]: { ...draft, request: { ...request, patch, unknown: true } } };
    // Persist the identity before dispatch, including an interrupted in-flight
    // attempt. Reloading the page must reconcile it, not issue a new edit.
    try { sessionStorage.setItem(storageKey, JSON.stringify(pendingDrafts)); }
    catch {
      setStorageWarning(true);
      setWriteError('Chưa lưu được bản nháp và mã yêu cầu trên trình duyệt. Chưa gửi thay đổi; giữ màn hình này và thử lại.');
      return;
    }
    setDrafts(pendingDrafts);
    setWriteError('');
    submitting.current = true;
    try {
      await update.mutateAsync({ roomId: id, expectedRevision: draft.revision, requestId: request.id, patch });
      removeDraft(id);
      done(`Đã lưu ${rowLabel(selected)}.`, id);
      setSelectedId(null);
    } catch (error) {
      // A denial/conflict while replaying cannot disprove the earlier write
      // whose receipt was lost. Keep its identity locked until confirmed.
      const outcome = draft.request?.unknown ? 'unknown'
        : error instanceof SaleRoomOperationError ? error.outcome : 'unknown';
      setDrafts(current => ({ ...current, [id]: { ...draft, request: { ...request, patch, unknown: outcome === 'unknown', conflict: outcome === 'conflict' } } }));
      setWriteError(outcome === 'conflict'
        ? 'Phòng đã được người khác cập nhật. Bản nháp của bạn vẫn giữ nguyên; đối chiếu thông tin mới trước khi lưu.'
        : saleRoomOperationErrorMessage(error));
      void inventory.refetch();
    } finally { submitting.current = false; }
  };
  const inventoryBlockedReason = () => inventory.isError || !inventory.data
    ? 'Chưa tải được tình trạng mới nhất. Giữ nội dung đã nhập, đóng hộp thoại và tải lại trước khi tiếp tục.' : undefined;
  const actionBlockedReason = (id: string, capability: keyof SaleRoomInventoryRow['capabilities'], allowedStatus?: (room: Room) => boolean) => {
    const unavailable = inventoryBlockedReason();
    if (unavailable) return unavailable;
    const target = rows.find(row => row.room.id === id);
    if (!target) return 'Phòng không còn trong phạm vi được giao. Nội dung đã nhập được giữ trong hộp thoại; không thể gửi thay đổi.';
    if (!target.capabilities[capability]) return 'Quyền thao tác phòng này đã thay đổi. Nội dung đã nhập được giữ; không thể gửi khi chưa được cấp quyền.';
    if (allowedStatus && !allowedStatus(target.room)) return 'Tình trạng phòng đã thay đổi. Nội dung đã nhập được giữ; kiểm tra lại trước khi tiếp tục.';
    return undefined;
  };
  const currentLockRoom = lockAction ? rows.find(row => row.room.id === lockAction.room.id)?.room : undefined;
  const lockBlockedReason = lockAction ? actionBlockedReason(lockAction.room.id, lockAction.mode === 'lock' ? 'lock' : 'releaseLock',
    lockAction.mode === 'lock' ? room => room.status === 'free' || room.status === 'soon' : room => room.status === 'locked')
    ?? (lockAction.mode === 'release' && currentLockRoom?.saleLock?.id !== lockAction.room.saleLock?.id ? 'Lock đang chọn đã thay đổi hoặc hết hạn. Đóng hộp thoại và kiểm tra lock hiện tại.' : undefined) : undefined;
  const currentDepositRoom = depositRoom ? rows.find(row => row.room.id === depositRoom.id)?.room : undefined;
  // Mở bán lại / Giữ tiếp luôn gửi phiên bản hồ sơ đọc mới nhất; hồ sơ đổi hoặc mất quyền thì khoá nút gửi.
  const holdRoom = holdAction ? rows.find(row => row.room.id === holdAction.roomId)?.room : undefined;
  const currentHold = holdAction && holdRoom?.exitHold?.exitCaseId === holdAction.hold.exitCaseId ? holdRoom.exitHold : undefined;
  const holdBlockedReason = holdAction ? inventoryBlockedReason()
    ?? (holdRoom ? exitHoldActionBlockedReason(holdAction.hold, holdRoom.exitHold) : 'Phòng không còn trong phạm vi được giao; không thể gửi thay đổi.') : undefined;
  const openHold = (row: SaleRoomInventoryRow, mode: ExitHoldAction['mode']) => {
    if (row.room.exitHold) setHoldAction({ mode, roomId: row.room.id, roomLabel: rowLabel(row), hold: row.room.exitHold });
  };
  // Đã cọc chờ hợp đồng: mã phiếu, ngày lập; quá 14 ngày tô cảnh báo (không tự gỡ giữ phòng vì tiền đã thu).
  const depositSummary = (room: Room) => room.depositHold && isDepositHeld(room) ? <div data-testid="deposit-hold-summary"
    className={`mt-1 space-y-0.5 text-xs ${depositHoldStale(room.depositHold) ? 'rounded border border-amber-300 bg-amber-50 px-1.5 py-1 font-medium text-amber-900' : 'text-muted-foreground'}`}>
    {depositHoldLines(room.depositHold).map(line => <p key={line}>{line}</p>)}
  </div> : null;
  const holdSummary = (room: Room) => room.exitHold ? <div className={`mt-1 space-y-0.5 text-xs ${room.exitHold.active ? 'text-amber-800' : 'text-muted-foreground'}`}>
    {exitHoldLines(room.exitHold).map(line => <p key={line}>{line}</p>)}
  </div> : null;
  const actions = (row: SaleRoomInventoryRow) => <div className="flex flex-wrap gap-1.5">
    <Button size="sm" variant="outline" disabled={blocked} onClick={() => openRoom(row.room.id)} aria-label={`Chi tiết ${rowLabel(row)}`}>
      <DoorOpen className="mr-1.5 h-3.5 w-3.5" />Chi tiết
    </Button>
    {canReport(row) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => setNoticeRoomId(row.room.id)}>
      {row.room.status === 'soon' ? 'Cập nhật ngày sắp trống' : 'Báo sắp trống'}
    </Button>}
    {row.capabilities.lock && ['free', 'soon'].includes(row.room.status) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => setLockAction({ room: row.room, mode: 'lock' })}>
      <LockKeyhole className="mr-1.5 h-3.5 w-3.5" />Lock
    </Button>}
    {row.capabilities.releaseLock && row.room.saleLock && <Button size="sm" variant="outline" disabled={blocked} onClick={() => setLockAction({ room: row.room, mode: 'release' })}>Gỡ lock</Button>}
    {row.capabilities.deposit && depositableStatus(row.room) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => setDepositRoom(row.room)}>
      <Wallet className="mr-1.5 h-3.5 w-3.5" />Cọc
    </Button>}
    {row.room.exitHold?.canManage && row.room.exitHold.active && <Button size="sm" variant="outline" disabled={blocked} onClick={() => openHold(row, 'reopen')}>
      <Megaphone className="mr-1.5 h-3.5 w-3.5" />Mở bán lại
    </Button>}
    {row.room.exitHold?.canManage && <Button size="sm" variant="outline" disabled={blocked} onClick={() => openHold(row, 'extend')}>
      <TimerReset className="mr-1.5 h-3.5 w-3.5" />Giữ tiếp
    </Button>}
    {row.capabilities.pass && occupiedStatus(row.room) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => setPassRoomId(row.room.id)}>{row.room.status === 'pass' ? 'Sửa pass' : 'Báo pass'}</Button>}
  </div>;
  const fieldError = (name: string) => errors[name] ? <p id={`quick-${name}-error`} role="alert" className="text-sm text-destructive">{errors[name]}</p> : null;
  const policySummary = (row: SaleRoomInventoryRow) => row.policy && row.policy.status !== 'CANCELLED' ? <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs">
    <p className="font-medium">{row.policy.title} · {row.policy.status === 'ACTIVE' ? 'Đang áp dụng' : row.policy.status === 'SCHEDULED' ? 'Sắp áp dụng' : 'Đã hết hạn'}</p>
    <p>{salePolicyTimeLabel(row.policy.starts_at)} → {salePolicyTimeLabel(row.policy.ends_at)}</p>
    {row.activePolicyText && <p className="mt-1 whitespace-pre-wrap">{row.activePolicyText}</p>}
  </div> : null;

  const searchField = <div className="space-y-1"><Label htmlFor="quick-room-search" className={mobile ? 'sr-only' : undefined}>Tìm tòa hoặc phòng</Label><div className="relative">
    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input id="quick-room-search" className="pl-8" placeholder={mobile ? 'Tìm tòa hoặc phòng, ví dụ: Tòa A 101' : 'Ví dụ: Tòa A 101'} value={search} onChange={event => setSearch(event.target.value)} />
  </div></div>;
  const buildingField = <div className="space-y-1"><Label htmlFor="quick-building">Tòa nhà</Label><select id="quick-building" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={buildingId} onChange={event => setBuildingId(event.target.value)}>
    <option value="">Tất cả tòa được giao</option>{buildings.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
  </select></div>;
  const statusField = <div className="space-y-1"><Label htmlFor="quick-status">Tình trạng</Label><select id="quick-status" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={status} onChange={event => setStatus(event.target.value as StatusFilter)}>
    {FILTERS.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
  </select></div>;
  const statusFilter = FILTERS.find(filter => filter.value === status);
  const filterSummary = `${searchAll ? 'Mọi tình trạng (đang tìm)' : statusFilter?.short ?? statusFilter?.label ?? 'Mọi tình trạng'} · ${buildings.find(([id]) => id === buildingId)?.[1] ?? 'Tất cả tòa'}`;
  const hiddenNote = hiddenRented > 0 && <span>Đang ẩn {hiddenRented} phòng đã thuê / giữ chỗ — đổi bộ lọc để xem. <button type="button" className="font-medium text-primary underline" onClick={() => setStatus('all')}>Hiện cả phòng đã thuê</button></span>;

  return <section className="space-y-4" aria-label="Bảng cập nhật phòng">
    <div className="flex flex-wrap items-start justify-between gap-3">
      {/* Điện thoại: tiêu đề màn đã nói "Cập nhật nhanh từng phòng"; giữ tiêu đề cho trình đọc, hai nút sát trái. */}
      {mobile ? <h2 className="sr-only">Bảng cập nhật phòng</h2> : <div><h2 className="text-lg font-semibold">Bảng cập nhật phòng</h2>
        <p className="text-sm text-muted-foreground">Tìm phòng, sửa thông tin và xử lý ngay trong phạm vi được giao.</p></div>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={blocked || !!selectedId} onClick={() => { setBatchRoomIds(visible.map(row => row.room.id)); setBatchHidden(hiddenRented); setBatchOpen(true); }}>Cập nhật nhiều phòng / chính sách</Button>
      <Button size="sm" variant="outline" disabled={inventory.isFetching || busy} onClick={() => void inventory.refetch()}
        aria-label={mobile ? 'Tải lại' : undefined} title={mobile ? 'Tải lại' : undefined}>
        {/* Điện thoại chỉ để biểu tượng cho hai nút nằm một hàng, thẻ phòng đầu tiên lên cao hơn. */}
        <RefreshCw className={`${mobile ? '' : 'mr-1.5 '}h-4 w-4 ${inventory.isFetching ? 'animate-spin' : ''}`} />{!mobile && 'Tải lại'}
      </Button></div>
    </div>
    {mobile ? <div className="space-y-2 rounded-lg border bg-muted/20 p-2.5">
      {searchField}
      {/* Điện thoại: tòa + tình trạng gộp vào một nút thu gọn để thẻ phòng đầu tiên lên gần đầu màn. */}
      <Button type="button" variant="outline" size="sm" className="h-9 w-full justify-between gap-2 px-3 font-normal"
        aria-expanded={filtersOpen} aria-controls="quick-room-filters" onClick={() => setFiltersOpen(open => !open)}>
        <span className="flex min-w-0 items-center gap-1.5"><SlidersHorizontal className="h-4 w-4 shrink-0" />
          <span className="truncate">Bộ lọc: {filterSummary}</span></span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
      </Button>
      {filtersOpen && <div id="quick-room-filters" className="grid gap-3 pt-1">{buildingField}{statusField}</div>}
    </div> : <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
      {searchField}{buildingField}{statusField}
    </div>}
    {batchOpen && batchHidden > 0 && <p role="note" className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900">
      Lô chỉ gồm các phòng đang hiện trong danh sách. {batchHidden} phòng đã thuê / giữ chỗ đang ẩn theo bộ lọc «Còn chào được» không nằm trong lô; muốn sửa cả các phòng đó thì đóng lô, chọn «Mọi tình trạng» rồi mở lại.
    </p>}
    {batchOpen && <Suspense fallback={<LoadingState label="cập nhật nhiều phòng" />}><SaleRoomBatchPanel
      rows={rows} initialRoomIds={batchRoomIds} organizationId={organizationId} actorId={actorId}
      blocked={inventory.isError || !inventory.data} onBusyChange={setBatchBusy}
      onClose={() => { if (!batchBusy) setBatchOpen(false); }} onSaved={() => void inventory.refetch()} /></Suspense>}
    {notice && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
      <span>{notice.text}</span><Button size="sm" variant="outline" onClick={() => openRoom(notice.roomId)}>Mở lại phòng</Button>
    </div>}
    {storageWarning && <p role="alert" className="text-sm text-amber-700">Trình duyệt chưa lưu được bản nháp. Giữ màn hình này mở đến khi lưu xong.</p>}
    {inventory.isError && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">Chưa tải được tình trạng phòng mới nhất. Thao tác ghi tạm khóa; bấm Tải lại để tiếp tục.</p>}
    {inventory.isLoading ? <LoadingState label="danh sách phòng trong phạm vi" variant="table" rows={6} /> : <>
      <div className="flex flex-wrap justify-between gap-1 text-xs text-muted-foreground">
        <span>{visible.length}/{rows.length} phòng{draftCount ? ` · ${draftCount} bản nháp của bạn` : ''}{searchAll ? ' · tìm trên mọi tình trạng' : ''}</span>
        <span>Đọc thành công: {inventory.dataUpdatedAt ? timeLabel(new Date(inventory.dataUpdatedAt).toISOString()) : 'Chưa xác nhận'}</span>
      </div>
      {hiddenNote && visible.length > 0 && <p role="status" className="text-xs text-muted-foreground">{hiddenNote}</p>}
      {!visible.length ? <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">{rows.length ? <>Không có phòng khớp bộ lọc. Thử đổi tòa, tình trạng hoặc từ khóa.{hiddenNote && <><br />{hiddenNote}</>}</> : inventory.isError ? 'Chưa có dữ liệu phòng để hiển thị.' : 'Chưa có phòng trong phạm vi được giao.'}</p>
        : mobile ? <div className="space-y-3">{visible.map(row => <article key={row.room.id} className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold">{rowLabel(row)}</h3><p className="mt-1 text-sm text-muted-foreground">{statusLabel(row.room)}</p></div>
            {drafts[row.room.id] && quickRoomDraftDirty(drafts[row.room.id]) && <Badge variant="secondary">Có nháp</Badge>}</div>
          <div className="flex justify-between text-sm"><span>{money(row.rentPrice)}</span><span className="text-muted-foreground">{roomPhotoCount(row.images)} ảnh</span></div>
          {row.room.saleLock && <p className="text-xs text-amber-700">Lock đến {timeLabel(row.room.saleLock.expiresAt)}</p>}
          {holdSummary(row.room)}
          {depositSummary(row.room)}
          {policySummary(row)}
          {actions(row)}
        </article>)}</div> : <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/40 text-muted-foreground"><tr>{['Tòa · phòng', 'Tình trạng chào', 'Giá niêm yết', 'Ảnh', 'Cập nhật phòng', 'Thao tác'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead>
          <tbody>{visible.map(row => <tr key={row.room.id} className="border-b last:border-b-0">
            <td className="px-3 py-3"><button className="text-left font-medium underline-offset-4 hover:underline" onClick={() => openRoom(row.room.id)}>{rowLabel(row)}</button>
              {drafts[row.room.id] && quickRoomDraftDirty(drafts[row.room.id]) && <span className="mt-1 block text-xs text-amber-700">Bản nháp chưa lưu</span>}</td>
            <td className="px-3 py-3">{statusLabel(row.room)}{row.room.saleLock && <span className="mt-1 block text-xs text-muted-foreground">Đến {timeLabel(row.room.saleLock.expiresAt)}</span>}{holdSummary(row.room)}{depositSummary(row.room)}{policySummary(row)}</td>
            <td className="whitespace-nowrap px-3 py-3">{money(row.rentPrice)}{row.room.status === 'pass' && <span className="block text-xs text-muted-foreground">Giá pass: {money(Math.round(row.room.price * 1_000_000))}</span>}</td>
            <td className="px-3 py-3"><span className={roomPhotoCount(row.images) ? '' : 'text-amber-700'}>{roomPhotoCount(row.images) || 'Thiếu'} ảnh</span></td>
            <td className="px-3 py-3 text-xs text-muted-foreground">{timeLabel(row.updatedAt)}{row.updatedByName && <span className="block">{row.updatedByName}</span>}</td><td className="px-3 py-3">{actions(row)}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
    <Sheet open={!!selectedId} onOpenChange={open => { if (!open && !busy && !turnoverEditing) setSelectedId(null); }}>
      <SheetContent side={mobile ? 'bottom' : 'right'} className={mobile ? 'max-h-[94dvh] overflow-y-auto rounded-t-2xl p-4' : 'w-full overflow-y-auto sm:max-w-xl'}
        onEscapeKeyDown={event => { if (busy || turnoverEditing) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy || turnoverEditing) event.preventDefault(); }}>
        <SheetHeader><SheetTitle>{selected ? rowLabel(selected) : 'Phòng không còn trong danh sách'}</SheetTitle>
          <SheetDescription>{selected ? statusLabel(selected.room) : 'Phòng đã đổi phạm vi hoặc bị xóa. Bản nháp được giữ theo tài khoản và tổ chức; không ghi sang phòng khác.'}</SheetDescription></SheetHeader>
        {selected && draft && <form ref={editor} className="mt-5 space-y-5" onSubmit={event => { event.preventDefault(); void save(); }}>
          <p className="text-xs text-muted-foreground">Tình trạng lấy từ hợp đồng, báo trả, cọc và lock. Sửa thông tin sale không đổi hợp đồng.</p>
          {selected.room.exitHold && <div role="note" className="rounded-md border border-amber-200 bg-amber-50/60 p-2" aria-label="Giữ phòng cho khách sang nhượng">{holdSummary(selected.room)}</div>}
          {isDepositHeld(selected.room) && <div role="note" aria-label="Phòng đã có người cọc">{statusLabel(selected.room)}{depositSummary(selected.room)}</div>}
          {policySummary(selected)}
          {(stale || (unknown && !update.isPending)) && <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p>{unknown ? 'Chưa rõ lần lưu đã hoàn tất hay chưa. Bản nháp tạm khóa để đối chiếu đúng yêu cầu cũ.' : 'Thông tin máy chủ đã thay đổi. Bản nháp của bạn vẫn được giữ; hãy đối chiếu trước khi lưu.'}</p>
            <p>Hiện tại: {money(selected.rentPrice)} · {selected.area ?? '—'} m² · {roomPhotoCount(selected.images)} ảnh.</p>
            {!unknown && <Button type="button" size="sm" variant="outline" onClick={() => { removeDraft(selected.room.id); setErrors({}); setWriteError(''); }}>Dùng bản mới, bỏ bản nháp</Button>}
            {unknown && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => void save(true)}>Đối chiếu lần lưu</Button>}
          </div>}
          {!selected.capabilities.edit && <p className="rounded-lg bg-muted p-3 text-sm">Bạn chưa có quyền sửa thông tin phòng này. Liên hệ quản lý để được cấp đúng quyền.</p>}
          <fieldset disabled={!selected.capabilities.edit || busy || turnoverEditing || unknown} className="space-y-4 disabled:opacity-75">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label htmlFor="quick-price">Giá niêm yết (đ/tháng)</Label><Input id="quick-price" name="price" inputMode="numeric" value={draft.price} onChange={event => change('price', event.target.value)} aria-invalid={!!errors.price}
                aria-describedby={errors.price ? 'quick-price-error' : priceWarning ? 'quick-price-warning' : undefined} />{fieldError('price')}
                {!errors.price && priceWarning && <p id="quick-price-warning" className="text-xs text-amber-700">{priceWarning}</p>}
                {selected.room.status === 'pass' && <p className="text-xs text-muted-foreground">Giá pass riêng được sửa ở Báo pass.</p>}</div>
              <div className="space-y-1.5"><Label htmlFor="quick-area">Diện tích (m²)</Label><Input id="quick-area" name="area" inputMode="decimal" value={draft.area} onChange={event => change('area', event.target.value)} aria-invalid={!!errors.area} />{fieldError('area')}</div>
            </div>
            <div className="space-y-1.5"><Label htmlFor="quick-type">Loại phòng</Label><Input id="quick-type" name="roomType" value={draft.roomType} onChange={event => change('roomType', event.target.value)} />{fieldError('roomType')}</div>
            <div className="space-y-1.5"><Label htmlFor="quick-description">Mô tả phòng gửi khách</Label><Textarea id="quick-description" name="description" rows={3} value={draft.description} onChange={event => change('description', event.target.value)} />{fieldError('description')}</div>
            <div className="space-y-1.5"><Label htmlFor="quick-amenities">Nội thất · mỗi dòng một mục</Label><Textarea id="quick-amenities" name="amenities" rows={4} value={draft.amenities} onChange={event => change('amenities', event.target.value)} />{fieldError('amenities')}</div>
            <div className="space-y-1.5"><Label htmlFor="quick-policy">Khuyến mãi / chính sách gửi khách</Label><Textarea id="quick-policy" name="saleNote" rows={3} value={draft.saleNote} onChange={event => change('saleNote', event.target.value)} />{fieldError('saleNote')}</div>
            {selected.capabilities.edit && <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/40 p-3"><Label htmlFor="quick-bonus">Thưởng sale · chỉ nội bộ</Label><Textarea id="quick-bonus" name="saleBonusNote" rows={2} value={draft.saleBonusNote} onChange={event => change('saleBonusNote', event.target.value)} />{fieldError('saleBonusNote')}<p className="text-xs text-muted-foreground">Không xuất vào nội dung gửi khách hoặc link công khai.</p></div>}
          </fieldset>
          {selected.capabilities.images && <div className="space-y-2 border-t pt-4"><h3 className="flex items-center gap-2 font-medium"><ImagePlus className="h-4 w-4" />Ảnh phòng</h3>
            <p className="text-xs text-muted-foreground">Ảnh mới được thêm vào cuối. Chọn ảnh bìa hoặc gỡ ảnh rồi bấm Lưu thay đổi.</p>
            <SaleImageManager allowRoomVideo key={selected.room.id} value={draft.images} onChange={images => change('images', images)} disabled={update.isPending || turnoverBusy || turnoverEditing || unknown} onUploadingChange={setUploading} />
            {fieldError('images')}{uploading && <p role="status" className="text-sm text-muted-foreground">Đang tải ảnh. Chờ tải xong trước khi lưu hoặc chuyển phòng.</p>}
          </div>}
          {writeError && <p role="alert" className="text-sm text-destructive">{writeError}</p>}
          {turnoverEditing && <p className="text-sm text-muted-foreground">Hoàn tất hoặc đóng phần dọn/sửa bên dưới trước khi lưu thông tin hoặc chuyển phòng.</p>}
          <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t bg-background py-3">
            <Button type="button" variant="outline" disabled={busy || turnoverEditing} onClick={() => setSelectedId(null)}>{dirty ? 'Đóng, giữ bản nháp' : 'Đóng'}</Button>
            {(selected.capabilities.edit || selected.capabilities.images) && <Button type="submit" disabled={blocked || !dirty || stale || unknown}>{update.isPending ? 'Đang lưu…' : 'Lưu thay đổi'}</Button>}
          </div>
        </form>}
        {selected?.capabilities.edit && <div className="mt-5 space-y-4">
          {!unknown && !uploading && !update.isPending && <RoomTurnoverPanel key={selected.room.id} roomId={selected.room.id} canEdit={!inventory.isError}
            onBusyChange={setTurnoverBusy} onEditingChange={setTurnoverEditing} onSaved={() => done(`Đã cập nhật việc dọn/sửa ${rowLabel(selected)}.`, selected.room.id)} />}
          <div className="rounded-lg border p-3 text-sm">
            <p className="mb-2">Khách báo trả hoặc đổi ngày trả cần cập nhật đúng hợp đồng đang thuê; ngày hết hạn hợp đồng không tự xác nhận phòng trống.</p>
            <a className="font-medium text-primary underline" href={`/rooms/${encodeURIComponent(selected.room.id)}`} target="_blank" rel="noreferrer">Mở hồ sơ phòng và hợp đồng để báo trả</a>
          </div>
        </div>}
      </SheetContent>
    </Sheet>
    {lockAction && <LockRoomModal action={{ ...lockAction, room: currentLockRoom ?? lockAction.room }} blockedReason={lockBlockedReason} onClose={() => setLockAction(null)} onDone={text => done(text, lockAction.room.id)} />}
    {noticeRoom && <SaleRoomNoticeDialog key={noticeRoom.room.id} roomId={noticeRoom.room.id} organizationId={organizationId} actorId={actorId}
      roomLabel={rowLabel(noticeRoom)} onClose={() => setNoticeRoomId(null)} />}
    {depositRoom && <QuickDepositModal room={currentDepositRoom ?? depositRoom} blockedReason={actionBlockedReason(depositRoom.id, 'deposit', depositableStatus)} onClose={() => setDepositRoom(null)} onDone={text => done(text, depositRoom.id)} />}
    {holdAction && <ExitHoldDialog key={`${holdAction.roomId}:${holdAction.mode}`} action={{ ...holdAction, hold: currentHold ?? holdAction.hold }}
      blockedReason={holdBlockedReason} onClose={() => setHoldAction(null)} />}
    {passRoomId && <div className="space-y-2 rounded-lg border p-3">
      <PassListingsTab key={passRoomId} focusRoomId={passRoomId} blockedReason={actionBlockedReason(passRoomId, 'pass', occupiedStatus)} onFocusedClose={() => { setPassRoomId(null); void inventory.refetch(); }} />
    </div>}
  </section>;
}
