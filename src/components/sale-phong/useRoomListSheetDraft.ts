import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSaleRoomInventory } from '@/hooks/useSaleRoomInventory';
import { useCreateHotline, useHotlines, useUpdateHotline } from '@/hooks/useHotlines';
import { RoomListSheetSaveError, sheetCellKeys, sheetRoomPatch, useSaveRoomListSheet, type SheetSaveRequest } from '@/hooks/useSaveRoomListSheet';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSession } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { focusFirstError } from '@/lib/formErrors';
import { actionErrorMessage } from '@/lib/actionFeedback';
import { SaleRoomOperationError, saleRoomOperationErrorMessage, saleInventoryAtTime, saleInventoryClock } from '@/lib/saleRoomOperations';
import { usePublicRoomSettings, useUpsertPublicRoomSettings, PUBLIC_ROOM_SETTINGS_DEFAULTS, type PublicRoomSettings } from '@/hooks/usePublicRoomSettings';
import { SALE_POLICY_MAX } from '@/lib/publicRoomFeedback';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import {
  applySheetDraft, dropSaved, effectiveHotline, isPhone, sheetChanges, sheetErrors as validateSheet,
  withRoomField, type RoomField, type SheetEdits,
} from './roomListSheetDraft';
import { readSheetSession, type SheetSession } from './roomListSheetSession';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const removeKeys = <T,>(record: Record<string, T>, ids: Set<string>) => Object.fromEntries(Object.entries(record).filter(([id]) => !ids.has(id)));

/** Both layouts use one actor/org draft and the same scoped inventory as QuickBoard. */
export function useRoomListSheetDraft(onBusyChange?: (busy: boolean) => void) {
  const rooms = useSaleRoomInventory();
  const settings = usePublicRoomSettings();
  const hotlineQuery = useHotlines();
  const upsertMut = useUpsertPublicRoomSettings({ inlineError: true });
  const sheetSave = useSaveRoomListSheet();
  const createHotline = useCreateHotline({ inlineError: true });
  const updateHotline = useUpdateHotline({ inlineError: true });
  const permissions = useMyPermissions();
  const { selectedOrganizationId } = useOrganization();
  const { data: session } = useSession();
  const actorId = session?.user.id;
  const cache = useQueryClient();
  const storageKey = `sale-sheet-drafts:v2:${actorId ?? 'none'}:${selectedOrganizationId ?? 'none'}`;
  const [stored, setStored] = useState(() => ({ key: storageKey, value: readSheetSession(storageKey) }));
  if (stored.key !== storageKey) setStored({ key: storageKey, value: readSheetSession(storageKey) });
  const state = stored.key === storageKey ? stored.value : readSheetSession(storageKey);
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const [storageWarning, setStorageWarning] = useState(false);
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sheetWriteError, setSheetWriteError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountUnknown, setAccountUnknown] = useState(false);
  const submitting = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const changeState = (change: (current: SheetSession) => SheetSession) => setStored(current => {
    if (current.key !== storageKey) return current;
    return { key: storageKey, value: change(current.value) };
  });
  const persist = (value: SheetSession) => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); setStorageWarning(false); return true; }
    catch { setStorageWarning(true); return false; }
  };
  useEffect(() => { if (stored.key === storageKey) persist(stored.value); }, [stored, storageKey]);
  const busy = saving || sheetSave.isPending || upsertMut.isPending || createHotline.isPending || updateHotline.isPending;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const rows = rooms.data?.rooms ?? [];
  const byId = new Map(rows.map(row => [row.room.id, row]));
  const inventoryBlocked = rooms.isError || !rooms.data || !actorId || !selectedOrganizationId;
  const canManageSettings = !inventoryBlocked && !permissions.isError && !!rooms.data?.canManageAccountSettings
    && rooms.data.settingsOwnerId === actorId && canUse(permissions.data, 'sale_phong', 'manage_settings');
  const hotlines = hotlineQuery.data ?? [];
  const savedForm = settings.data ?? PUBLIC_ROOM_SETTINGS_DEFAULTS;
  const form = state.account?.form ?? savedForm;
  const days = state.account?.days ?? String(savedForm.soon_days);
  const edits = state.edits;
  // Effective campaigns are deliberately excluded from editable base sale_note.
  const buildings = useMemo(() => (rooms.data?.buildings ?? []).map(building => ({
    ...building, rooms: building.rooms.map(room => ({ ...room, saleNote: rooms.data?.rooms.find(row => row.room.id === room.id)?.saleNote ?? null })),
  })), [rooms.data]);
  const currentHotline = effectiveHotline(hotlines, form.hotline_id);
  const inheritedHotline = buildings.find(building => building.hotline)?.hotline ?? '';
  const hotlinePhone = canManageSettings ? state.hotline ?? currentHotline?.phone_number ?? '' : inheritedHotline;
  const salePolicy = canManageSettings ? form.sale_policy ?? '' : buildings.find(building => building.salePolicy)?.salePolicy ?? '';
  const preview = useMemo(() => applySheetDraft(buildings, { hotline: hotlinePhone.trim(), salePolicy, edits })
    .map(building => ({ ...building, rooms: building.rooms.map(room => {
      const activePolicy = rooms.data?.rooms.find(row => row.room.id === room.id)?.activePolicyText;
      return activePolicy ? { ...room, saleNote: [room.saleNote, activePolicy].filter(Boolean).join('\n') } : room;
    }) })), [buildings, hotlinePhone, salePolicy, edits, rooms.data]);
  const dirtyRoomIds = [...new Set(Object.entries(edits).filter(([key]) => key !== 'phones').flatMap(([, values]) => Object.keys(values)))];
  const dirty = dirtyRoomIds.length > 0 || Object.keys(edits.phones).length > 0 || !!state.account || state.hotline !== undefined;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (busy || dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, dirty]);
  const roomWritable = (id: string) => !inventoryBlocked && !busy && !!byId.get(id)?.capabilities.edit && state.requests[id]?.outcome !== 'unknown';
  const phoneWritable = (id: string) => !inventoryBlocked && !busy && !permissions.isError
    && canUse(permissions.data, 'sale_phong', 'manage_settings', id) && buildings.some(building => building.id === id);
  const clearCell = (name: string) => setCellErrors(current => ({ ...current, [name]: '' }));
  const editRoom = (id: string, change: (current: SheetEdits) => SheetEdits) => {
    const row = byId.get(id);
    if (!row || !roomWritable(id)) return;
    changeState(current => ({ ...current, edits: change(current.edits),
      bases: { ...current.bases, [id]: current.bases[id] ?? { room: { ...row.room, saleNote: row.saleNote }, revision: row.revision } },
      requests: removeKeys(current.requests, new Set([id])),
    }));
  };
  const setPhone = (id: string, value: string) => {
    if (!phoneWritable(id)) return;
    const building = buildings.find(item => item.id === id)!;
    changeState(current => ({ ...current, edits: { ...current.edits, phones: { ...current.edits.phones, [id]: value } },
      phoneBases: { ...current.phoneBases, [id]: Object.prototype.hasOwnProperty.call(current.phoneBases, id) ? current.phoneBases[id]! : building.contactPhone || null } }));
    clearCell(`phone:${id}`);
  };
  const setPolicy = (id: string, value: string) => { editRoom(id, current => ({ ...current, policies: { ...current.policies, [id]: value } })); clearCell(`policy:${id}`); };
  const setRoomField = (field: RoomField, id: string, value: string) => { editRoom(id, current => withRoomField(current, field, id, value)); clearCell(`${field}:${id}`); };
  const set = <K extends keyof PublicRoomSettings>(key: K, value: PublicRoomSettings[K]) => {
    if (!canManageSettings || busy || accountUnknown) return;
    changeState(current => ({ ...current, account: { original: current.account?.original ?? savedForm,
      form: { ...(current.account?.form ?? savedForm), [key]: value }, days: current.account?.days ?? String(savedForm.soon_days) } }));
    setErrors(current => ({ ...current, [key]: '' }));
  };
  const changeDays = (value: string) => {
    if (!canManageSettings || busy || accountUnknown) return;
    changeState(current => ({ ...current, account: { original: current.account?.original ?? savedForm,
      form: current.account?.form ?? savedForm, days: value } }));
    setErrors(current => ({ ...current, soon_days: '' }));
  };
  const setHotlinePhone = (value: string) => { if (canManageSettings && !busy && !accountUnknown) changeState(current => ({ ...current, hotline: value })); clearCell('hotline_phone'); };
  const pickHotline = (id: string | null) => { set('hotline_id', id); changeState(current => ({ ...current, hotline: undefined })); };
  const issues = dirtyRoomIds.flatMap(id => {
    const row = byId.get(id); const base = state.bases[id]; const pending = state.requests[id];
    const unknown = pending?.outcome === 'unknown';
    const message = !row ? 'Phòng không còn trong danh sách được giao; bản nháp vẫn được giữ.'
      : !row.capabilities.edit ? 'Bạn không còn quyền sửa phòng này.'
      : unknown ? 'Chưa xác nhận lần lưu. Đối chiếu lại bằng đúng yêu cầu cũ.'
      : row.revision !== base?.revision || pending?.outcome === 'conflict' ? 'Phòng đã thay đổi kể từ khi bắt đầu sửa. Đối chiếu trước khi lưu.' : '';
    return message ? [{ id, label: base?.room.code || row?.name || id, message, unknown }] : [];
  });
  const discardRoom = (id: string) => {
    if (busy || state.requests[id]?.outcome === 'unknown') return;
    if (!window.confirm('Bỏ bản nháp của phòng này và dùng dữ liệu mới nhất?')) return;
    const keys = ['policy', 'price', 'type', 'amenities', 'status'].map(field => `${field}:${id}`);
    changeState(current => ({ ...current, edits: dropSaved(current.edits, keys), bases: removeKeys(current.bases, new Set([id])), requests: removeKeys(current.requests, new Set([id])) }));
    setCellErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))));
    setSheetWriteError('');
  };
  const canSave = !inventoryBlocked && !busy && dirty && !accountUnknown
    && (!(state.account || state.hotline !== undefined) || (!settings.isError && !hotlineQuery.isError));
  const saveAll = async (): Promise<boolean> => {
    if (!canSave || submitting.current || !actorId || !selectedOrganizationId) return false;
    const snapshot = state;
    const operationScope = storageKey;
    const originalBuildings = buildings.map(building => ({ ...building,
      contactPhone: Object.prototype.hasOwnProperty.call(snapshot.phoneBases, building.id) ? snapshot.phoneBases[building.id] ?? '' : building.contactPhone,
      rooms: building.rooms.map(room => snapshot.bases[room.id]?.room ?? room),
    }));
    const changes = sheetChanges(originalBuildings, snapshot.edits);
    const invalid = validateSheet(changes);
    for (const issue of issues) if (!issue.unknown) invalid[`policy:${issue.id}`] = issue.message;
    if (changes.rooms.length > 50) invalid.batch = 'Mỗi lần lưu tối đa 50 phòng. Giảm số phòng trong bản nháp trước khi lưu.';
    for (const building of changes.buildings) if (!phoneWritable(building.id)) invalid[`phone:${building.id}`] = 'Không còn quyền sửa SĐT của tòa này.';
    const accountInvalid: Record<string, string> = {};
    const accountChanged = !!snapshot.account || snapshot.hotline !== undefined;
    if (accountChanged) {
      if (!canManageSettings || settings.isError || hotlineQuery.isError || !settings.data || !hotlineQuery.data) accountInvalid.account = 'Chưa đủ quyền hoặc dữ liệu để lưu cài đặt chung.';
      if (snapshot.account && !same(snapshot.account.original, settings.data)) accountInvalid.account = 'Cài đặt chung đã thay đổi. Bỏ bản nháp cài đặt để đọc lại trước khi lưu.';
      if (!/^\d+$/.test(days) || Number(days) > 365) accountInvalid.soon_days = 'Nhập số ngày nguyên từ 0 đến 365.';
      if ((form.sale_policy?.trim().length ?? 0) > SALE_POLICY_MAX) accountInvalid.sale_policy = `Chính sách sale chung tối đa ${SALE_POLICY_MAX} ký tự.`;
      if (form.hotline_id && !hotlines.some(hotline => hotline.id === form.hotline_id)) accountInvalid.hotline_id = 'Chọn hotline hiện có hoặc dùng mặc định.';
      if (snapshot.hotline !== undefined && (!snapshot.hotline.trim() || !isPhone(snapshot.hotline.trim()))) invalid.hotline_phone = 'Nhập SĐT hợp lệ (8–20 ký tự).';
    }
    setCellErrors(invalid); setErrors(accountInvalid);
    if (Object.keys(invalid).length || Object.keys(accountInvalid).length) {
      await focusFirstError({ ...invalid, ...accountInvalid }, { root: root.current ?? undefined });
      return false;
    }
    const request: SheetSaveRequest = {
      organizationId: selectedOrganizationId, actorId,
      buildings: changes.buildings.map(building => ({ ...building, originalPhone: snapshot.phoneBases[building.id] ?? null })),
      rooms: changes.rooms.map(room => snapshot.requests[room.id]?.outcome === 'unknown' ? snapshot.requests[room.id]! : {
        input: { roomId: room.id, expectedRevision: snapshot.bases[room.id]!.revision, requestId: crypto.randomUUID(), patch: sheetRoomPatch(room) },
        keys: sheetCellKeys({ buildings: [], rooms: [room] }),
      }),
    };
    // Unknown requests remain eligible even when a refetch already displays their requested values.
    for (const pending of Object.values(snapshot.requests)) if (pending.outcome === 'unknown' && !request.rooms.some(row => row.input.roomId === pending.input.roomId)) request.rooms.push(pending);
    const prepared = { ...snapshot, requests: { ...snapshot.requests, ...Object.fromEntries(request.rooms.map(row => [row.input.roomId, row])) } };
    if (!persist(prepared)) {
      setSheetWriteError('Chưa giữ được mã đối chiếu trên trình duyệt nên chưa gửi lần lưu. Giữ bản nháp mở và thử lại.');
      return false;
    }
    changeState(() => prepared);
    submitting.current = true; setSaving(true); setSheetWriteError(''); setWriteError('');
    let savedKeys: string[] = [];
    const settle = (keys: string[], failure?: RoomListSheetSaveError) => {
      const ids = new Set(request.rooms.filter(row => row.keys.every(key => keys.includes(key))).map(row => row.input.roomId));
      const noChangeRooms = dirtyRoomIds.filter(id => !request.rooms.some(row => row.input.roomId === id)
        && byId.get(id)?.revision === snapshot.bases[id]?.revision);
      const noChangeKeys = noChangeRooms.flatMap(id => ['policy', 'price', 'type', 'amenities', 'status'].map(field => `${field}:${id}`));
      const noChangePhones = Object.keys(snapshot.edits.phones).filter(id => !request.buildings.some(building => building.id === id)
        && buildings.some(building => building.id === id));
      noChangeRooms.forEach(id => ids.add(id));
      const phoneIds = new Set([...keys.filter(key => key.startsWith('phone:')).map(key => key.slice(6)), ...noChangePhones]);
      const next: SheetSession = { ...prepared,
        edits: dropSaved(prepared.edits, [...keys, ...noChangeKeys, ...noChangePhones.map(id => `phone:${id}`)]),
        bases: removeKeys(prepared.bases, ids), requests: removeKeys(prepared.requests, ids), phoneBases: removeKeys(prepared.phoneBases, phoneIds) };
      if (failure?.failedRoomId && next.requests[failure.failedRoomId]) next.requests[failure.failedRoomId] = { ...next.requests[failure.failedRoomId]!,
        // A later rejection/conflict cannot disprove an earlier write with a lost receipt.
        outcome: snapshot.requests[failure.failedRoomId]?.outcome === 'unknown' ? 'unknown'
          : failure.failure instanceof SaleRoomOperationError ? failure.failure.outcome : 'unknown' };
      if (operationScope === scope.current) changeState(() => next);
      persist(next);
    };
    try {
      if (accountChanged) {
        let hotlineId = form.hotline_id;
        if (snapshot.hotline !== undefined && snapshot.hotline.trim() !== currentHotline?.phone_number) {
          if (currentHotline) await updateHotline.mutateAsync({ id: currentHotline.id, updates: { phone_number: snapshot.hotline.trim() } });
          else { const created = await createHotline.mutateAsync({ name: 'Hotline chung', phone_number: snapshot.hotline.trim(), is_active: true }); hotlineId = created.id; }
        }
        if (operationScope !== scope.current) throw new SaleRoomOperationError('Đã đổi tài khoản hoặc tổ chức; dừng lưu phần còn lại.', 'rejected', '42501');
        await upsertMut.mutateAsync({ ...form, hotline_id: hotlineId, soon_days: Number(days), sale_policy: form.sale_policy?.trim() || null });
        prepared.account = undefined; prepared.hotline = undefined;
        await Promise.all(['public-room-settings', 'hotlines', 'sale-room-inventory', 'my-available-rooms', 'phong-trong'].map(key => cache.invalidateQueries({ queryKey: [key] })));
      }
      if (request.rooms.length || request.buildings.length) savedKeys = await sheetSave.mutateAsync(request);
      settle(savedKeys);
      if (savedKeys.length) toast.success(`Đã xác nhận lưu ${savedKeys.length} ô của bảng phòng trống`);
      return true;
    } catch (error) {
      if (error instanceof RoomListSheetSaveError) {
        savedKeys = error.savedKeys; settle(savedKeys, error);
        const cause = error.failure instanceof SaleRoomOperationError ? saleRoomOperationErrorMessage(error.failure) : actionErrorMessage(error.failure, 'Chưa xác nhận được lần lưu. Đọc lại trước khi thử tiếp.');
        setSheetWriteError(`${savedKeys.length ? `Đã lưu ${savedKeys.length}/${error.total} ô. ` : ''}${cause} Các ô chưa xác nhận vẫn được giữ.`);
      } else {
        settle(savedKeys); setWriteError(actionErrorMessage(error, 'Chưa lưu được cài đặt chung. Bản nháp vẫn được giữ.'));
        if (error instanceof FinancialWorkflowError && error.outcome !== 'failure') setAccountUnknown(true);
      }
      return false;
    } finally { submitting.current = false; setSaving(false); }
  };
  const discardAccount = () => {
    if (busy || !window.confirm('Bỏ bản nháp cài đặt chung và đọc lại dữ liệu?')) return;
    changeState(current => ({ ...current, account: undefined, hotline: undefined }));
    setAccountUnknown(false); setWriteError(''); setErrors({}); void settings.refetch(); void hotlineQuery.refetch();
  };
  const readPreview = async () => {
      if (inventoryBlocked) throw new Error('Inventory unavailable');
      const operationScope = storageKey;
      const refreshed = await rooms.refetch();
      if (operationScope !== scope.current || refreshed.isError || refreshed.error || !refreshed.data) throw new Error('Inventory refresh unavailable');
      const clock = saleInventoryClock(refreshed.data);
      const fresh = saleInventoryAtTime(refreshed.data, clock.lowerBoundMs, clock.upperBoundMs);
      return applySheetDraft(fresh.buildings.map(building => ({ ...building,
        rooms: building.rooms.map(room => ({ ...room, saleNote: fresh.rooms.find(row => row.room.id === room.id)?.saleNote ?? null })),
      })), { hotline: hotlinePhone.trim(), salePolicy, edits }).map(building => ({ ...building,
        rooms: building.rooms.map(room => {
          const activePolicy = fresh.rooms.find(row => row.room.id === room.id)?.activePolicyText;
          return activePolicy ? { ...room, saleNote: [room.saleNote, activePolicy].filter(Boolean).join('\n') } : room;
        }),
      }));
  };
  const exportPreview = async () => {
    if (exporting || inventoryBlocked) return;
    setExporting(true);
    try {
      const exportBuildings = await readPreview();
      const { downloadRoomListImage } = await import('@/pages/phong-trong/exportRoomListImage');
      const n = await downloadRoomListImage(exportBuildings);
      if (n) toast.success(`Đã tải ảnh ${n} phòng theo nội dung đang nhập`);
      else toast.info('Hiện chưa có phòng trống để xuất ảnh');
    } catch { toast.error('Không tạo được ảnh. Thử lại nhé.'); }
    finally { setExporting(false); }
  };
  return {
    settings, hotlines: hotlineQuery, mutation: upsertMut, root, form, days, errors, writeError, canSave, set, changeDays,
    rooms, buildings, preview, hotlineList: hotlines, currentHotline, hotlinePhone, salePolicy, edits, cellErrors, sheetWriteError,
    busy, exporting, setPhone, setPolicy, setRoomField, setHotlinePhone, pickHotline, saveAll, exportPreview, readPreview,
    roomWritable, phoneWritable, canManageSettings, inventoryBlocked, issues, discardRoom, discardAccount,
    storageWarning, dirty, accountDraft: !!state.account || state.hotline !== undefined,
    activePolicies: Object.fromEntries(rows.map(row => [row.room.id, row.activePolicyText ?? ''])),
  };
}
