import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMyAvailableRooms } from "@/hooks/useMyAvailableRooms";
import { useCreateHotline, useUpdateHotline } from "@/hooks/useHotlines";
import { RoomListSheetSaveError, sheetCellKeys, useSaveRoomListSheet } from "@/hooks/useSaveRoomListSheet";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { focusFirstError } from "@/lib/formErrors";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { usePublicRoomSettingsDraft } from "./usePublicRoomSettingsDraft";
import {
  applySheetDraft, dropSaved, effectiveHotline, EMPTY_SHEET_EDITS, isPhone, sheetChanges, sheetErrors as validateSheet,
  withRoomField, type RoomField, type SheetEdits,
} from "./roomListSheetDraft";

/**
 * Bảng "DANH SÁCH PHÒNG TRỐNG" ở Cài đặt hiển thị — một nguồn cho desktop lẫn mobile:
 * cài đặt chung (usePublicRoomSettingsDraft), hotline, các ô của bảng, lưu và ảnh thử.
 */
export function useRoomListSheetDraft() {
  const draft = usePublicRoomSettingsDraft();
  const { hotlines: hotlineQuery, mutation: upsertMut, root, form, set, save } = draft;
  const hotlines = hotlineQuery.data ?? [];
  const rooms = useMyAvailableRooms();
  const sheetSave = useSaveRoomListSheet();
  const createHotline = useCreateHotline({ inlineError: true });
  const updateHotline = useUpdateHotline({ inlineError: true });
  const { selectedOrganizationId } = useOrganization();
  const [edits, setEdits] = useState<SheetEdits>(EMPTY_SHEET_EDITS);
  const [hotlineDraft, setHotlineDraft] = useState<string | undefined>();
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [sheetWriteError, setSheetWriteError] = useState("");
  const [exporting, setExporting] = useState(false);
  const buildings = useMemo(() => rooms.data ?? [], [rooms.data]);
  const busy = upsertMut.isPending || sheetSave.isPending || createHotline.isPending || updateHotline.isPending;
  const currentHotline = effectiveHotline(hotlines, form.hotline_id);
  const hotlinePhone = hotlineDraft ?? currentHotline?.phone_number ?? "";
  const salePolicy = form.sale_policy ?? "";
  /** Building[] như thể đã lưu — khung nhập, ảnh thử và ảnh tải về cùng đọc. */
  const preview = useMemo(
    () => applySheetDraft(buildings, { hotline: hotlinePhone.trim(), salePolicy, edits }),
    [buildings, hotlinePhone, salePolicy, edits],
  );

  const clearCell = (name: string) => setCellErrors((current) => ({ ...current, [name]: "" }));
  const setPhone = (id: string, value: string) => { setEdits((e) => ({ ...e, phones: { ...e.phones, [id]: value } })); clearCell(`phone:${id}`); };
  const setPolicy = (id: string, value: string) => { setEdits((e) => ({ ...e, policies: { ...e.policies, [id]: value } })); clearCell(`policy:${id}`); };
  const setRoomField = (field: RoomField, id: string, value: string) => { setEdits((e) => withRoomField(e, field, id, value)); clearCell(`${field}:${id}`); };
  const setHotlinePhone = (value: string) => { setHotlineDraft(value); clearCell("hotline_phone"); };
  const pickHotline = (id: string | null) => { set("hotline_id", id); setHotlineDraft(undefined); };

  /** Số hotline gõ ở ô liên hệ: có hotline đang dùng thì sửa số đó, chưa có thì tạo mới (gắn công ty). */
  const saveHotline = async (): Promise<{ ok: boolean; hotlineId?: string }> => {
    const next = hotlineDraft?.trim() ?? "";
    if (hotlineDraft === undefined || next === (currentHotline?.phone_number?.trim() ?? "")) return { ok: true };
    try {
      // Chỉ bỏ nháp khi đọc lại được danh sách — đọc lỗi thì ô vẫn giữ đúng số vừa lưu.
      const reread = async () => { if (!(await hotlineQuery.refetch()).isError) setHotlineDraft(undefined); };
      if (currentHotline) {
        await updateHotline.mutateAsync({ id: currentHotline.id, updates: { phone_number: next } });
        await reread();
        return { ok: true };
      }
      const row = await createHotline.mutateAsync(
        withOrg({ name: "Hotline chung", phone_number: next, is_active: true }, selectedOrganizationId),
      );
      // Đang trỏ một hotline đã tắt/không còn → chuyển hẳn sang số vừa tạo (ghi cả vào nháp để
      // lần Lưu lại sau một lỗi không tạo trùng); còn lại để "Mặc định".
      if (form.hotline_id) set("hotline_id", row.id);
      await reread();
      return { ok: true, hotlineId: form.hotline_id ? row.id : undefined };
    } catch (error) {
      setSheetWriteError(actionErrorMessage(error, "Chưa lưu được số hotline."));
      return { ok: false };
    }
  };

  /** Một nút lưu: hotline → cài đặt chung (chính sách chung…) → các ô của bảng. True khi mọi phần đã lưu. */
  const saveAll = async (): Promise<boolean> => {
    if (busy) return false;
    const changes = sheetChanges(buildings, edits);
    const invalid = validateSheet(changes);
    const hotlineNext = hotlineDraft?.trim();
    if (hotlineDraft !== undefined && hotlineNext && !isPhone(hotlineNext)) invalid.hotline_phone = "SĐT chỉ gồm số (8–20 ký tự).";
    if (hotlineDraft !== undefined && !hotlineNext && currentHotline) {
      invalid.hotline_phone = "Nhập số hotline. Muốn bỏ hẳn số này thì xoá ở Quản lý danh sách hotline.";
    }
    setCellErrors(invalid);
    if (Object.keys(invalid).length) { await focusFirstError(invalid, { root: root.current ?? undefined }); return false; }
    setSheetWriteError("");
    const hotlineResult = await saveHotline();
    if (!hotlineResult.ok) return false;
    if (!(await save(hotlineResult.hotlineId ? { hotline_id: hotlineResult.hotlineId } : {}))) return false;
    const total = sheetCellKeys(changes).length;
    if (!total) { setEdits(EMPTY_SHEET_EDITS); return true; }
    try {
      await sheetSave.mutateAsync(changes);
      toast.success(`Đã lưu ${total} ô của bảng phòng trống`);
      // Chỉ bỏ nháp khi đã đọc lại được bản mới — đọc lỗi thì ô vẫn giữ đúng giá trị vừa lưu.
      const reread = await rooms.refetch();
      if (!reread.isError) setEdits(EMPTY_SHEET_EDITS);
      return true;
    } catch (error) {
      const saved = error instanceof RoomListSheetSaveError ? error.savedKeys : [];
      setEdits((current) => dropSaved(current, saved));
      const cause = error instanceof RoomListSheetSaveError ? error.failure : error;
      setSheetWriteError(
        `${saved.length ? `Đã lưu ${saved.length}/${total} ô. ` : ""}${actionErrorMessage(cause, "Chưa lưu được bảng phòng trống.")} Các ô chưa lưu vẫn giữ nguyên để lưu lại.`,
      );
      return false;
    }
  };

  /** Ảnh thử theo đúng nội dung đang gõ (chưa cần lưu) — cùng hàm vẽ với nút Tải ảnh. */
  const exportPreview = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { downloadRoomListImage } = await import("@/pages/phong-trong/exportRoomListImage");
      const n = await downloadRoomListImage(preview);
      if (n) toast.success(`Đã tải ảnh ${n} phòng theo nội dung đang nhập`);
      else toast.info("Hiện chưa có phòng trống để xuất ảnh");
    } catch {
      toast.error("Không tạo được ảnh. Thử lại nhé.");
    } finally {
      setExporting(false);
    }
  };

  return {
    ...draft, rooms, buildings, preview, hotlineList: hotlines, currentHotline, hotlinePhone, edits, cellErrors, sheetWriteError,
    busy, exporting, setPhone, setPolicy, setRoomField, setHotlinePhone, pickHotline, saveAll, exportPreview,
  };
}
