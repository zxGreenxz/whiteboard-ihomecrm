import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {QueryRegion} from "@/components/errors/QueryRegion";
import {usePublicRoomSettingsDraft} from "./usePublicRoomSettingsDraft";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useMyAvailableRooms } from "@/hooks/useMyAvailableRooms";
import { useCreateHotline, useUpdateHotline } from "@/hooks/useHotlines";
import { RoomListSheetSaveError, useSaveRoomListSheet } from "@/hooks/useSaveRoomListSheet";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { focusFirstError } from "@/lib/formErrors";
import { actionErrorMessage } from "@/lib/actionFeedback";
import RoomListSheetEditor from "./RoomListSheetEditor";
import {
  applySheetDraft, effectiveHotline, EMPTY_SHEET_EDITS, isPhone, sheetChanges, sheetErrors as validateSheet,
  type SheetEdits,
} from "./roomListSheetDraft";

/** Bỏ các ô đã lưu khỏi bản nháp, giữ ô chưa lưu để người dùng lưu lại. */
function dropSaved(edits: SheetEdits, saved: string[]): SheetEdits {
  const keys = new Set(saved);
  const keep = (prefix: string, rec: Record<string, string>) =>
    Object.fromEntries(Object.entries(rec).filter(([id]) => !keys.has(`${prefix}:${id}`)));
  return { phones: keep("phone", edits.phones), policies: keep("policy", edits.policies) };
}

export default function DisplaySettingsTab() {
  const {settings,hotlines:hotlineQuery,mutation:upsertMut,root,form,days,errors,writeError,canSave,set,changeDays,save}=usePublicRoomSettingsDraft();
  const hotlines=hotlineQuery.data ?? [];
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
  const buildings = rooms.data ?? [];
  const busy = upsertMut.isPending || sheetSave.isPending || createHotline.isPending || updateHotline.isPending;
  const currentHotline = effectiveHotline(hotlines, form.hotline_id);
  const hotlinePhone = hotlineDraft ?? currentHotline?.phone_number ?? "";

  const clearCell = (name: string) => setCellErrors((current) => ({ ...current, [name]: "" }));
  const setPhone = (id: string, value: string) => { setEdits((e) => ({ ...e, phones: { ...e.phones, [id]: value } })); clearCell(`phone:${id}`); };
  const setPolicy = (id: string, value: string) => { setEdits((e) => ({ ...e, policies: { ...e.policies, [id]: value } })); clearCell(`policy:${id}`); };

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

  // Một nút lưu: hotline → cài đặt chung (chính sách chung…) → các ô của bảng.
  const saveAll = async () => {
    if (busy) return;
    const changes = sheetChanges(buildings, edits);
    const invalid = validateSheet(changes);
    const hotlineNext = hotlineDraft?.trim();
    if (hotlineDraft !== undefined && hotlineNext && !isPhone(hotlineNext)) invalid.hotline_phone = "SĐT chỉ gồm số (8–20 ký tự).";
    if (hotlineDraft !== undefined && !hotlineNext && currentHotline) {
      invalid.hotline_phone = "Nhập số hotline. Muốn bỏ hẳn số này thì xoá ở Quản lý danh sách hotline.";
    }
    setCellErrors(invalid);
    if (Object.keys(invalid).length) { await focusFirstError(invalid, { root: root.current ?? undefined }); return; }
    setSheetWriteError("");
    const hotlineResult = await saveHotline();
    if (!hotlineResult.ok) return;
    if (!(await save(hotlineResult.hotlineId ? { hotline_id: hotlineResult.hotlineId } : {}))) return;
    const total = changes.buildings.length + changes.rooms.length;
    if (!total) { setEdits(EMPTY_SHEET_EDITS); return; }
    try {
      await sheetSave.mutateAsync(changes);
      toast.success(`Đã lưu ${total} ô của bảng phòng trống`);
      // Chỉ bỏ nháp khi đã đọc lại được bản mới — đọc lỗi thì ô vẫn giữ đúng giá trị vừa lưu.
      const reread = await rooms.refetch();
      if (!reread.isError) setEdits(EMPTY_SHEET_EDITS);
    } catch (error) {
      const saved = error instanceof RoomListSheetSaveError ? error.savedKeys : [];
      setEdits((current) => dropSaved(current, saved));
      const cause = error instanceof RoomListSheetSaveError ? error.failure : error;
      setSheetWriteError(
        `${saved.length ? `Đã lưu ${saved.length}/${total} ô. ` : ""}${actionErrorMessage(cause, "Chưa lưu được bảng phòng trống.")} Các ô chưa lưu vẫn giữ nguyên để lưu lại.`,
      );
    }
  };

  // Ảnh thử theo đúng nội dung đang gõ (chưa cần lưu) — cùng hàm vẽ với nút Tải ảnh.
  const exportPreview = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { downloadRoomListImage } = await import("@/pages/phong-trong/exportRoomListImage");
      const n = await downloadRoomListImage(
        applySheetDraft(buildings, { hotline: hotlinePhone.trim(), salePolicy: form.sale_policy ?? "", edits }),
      );
      if (n) toast.success(`Đã tải ảnh ${n} phòng theo nội dung đang nhập`);
      else toast.info("Hiện chưa có phòng trống để xuất ảnh");
    } catch {
      toast.error("Không tạo được ảnh. Thử lại nhé.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div ref={root}><QueryRegion label="cài đặt hiển thị" queries={[settings,hotlineQuery]} skeleton="detail" rows={4}><Card>
      <CardHeader>
        <CardTitle>Cài đặt hiển thị trang "Phòng trống"</CardTitle>
        <CardDescription>
          Áp dụng chung cho mọi link chia sẻ của tài khoản và cho ảnh "Danh sách phòng trống" (nút Tải ảnh, tin gửi Zalo).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* soon_days */}
          <div className="space-y-1.5">
            <Label htmlFor="soon-days">Số ngày báo "sắp trống"</Label>
            <Input
              id="soon-days" name="soon_days" type="text" inputMode="numeric" className={"w-40"+(errors.soon_days?" border-destructive":"")} aria-invalid={!!errors.soon_days} aria-describedby={errors.soon_days?"soon-days-error":undefined}
              value={days}
              onChange={(e)=>changeDays(e.target.value)}
            />
            {errors.soon_days&&<p id="soon-days-error" role="alert" className="text-sm text-destructive">{errors.soon_days}</p>}
            <p className="text-xs text-muted-foreground">
              Phòng có hợp đồng còn hiệu lực sẽ hết hạn trong vòng số ngày này sẽ được đánh dấu
              "Sắp trống" trên trang công khai. Mặc định 30 ngày.
            </p>
          </div>

          {/* show_rented */}
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="show-rented">Hiển thị phòng đã thuê (trên sơ đồ)</Label>
              <p className="text-xs text-muted-foreground">
                Lưu cấu hình này cho lần cập nhật sau. Hiện trang công khai luôn vẽ phòng đã thuê
                (làm mờ) để giữ đầy đủ sơ đồ tầng.
              </p>
            </div>
            <Switch id="show-rented" checked={form.show_rented} onCheckedChange={(v) => set("show_rented", v)} />
          </div>
        </div>

        <section className="space-y-2" aria-labelledby="room-list-sheet-title">
          <div>
            <h3 id="room-list-sheet-title" className="font-semibold">Bảng phòng trống — điền như Excel</h3>
            <p className="text-xs text-muted-foreground">
              Ô trắng viền đứt là ô điền: <b>hotline chung cho tất cả nhà</b> (góc trên trái),{" "}
              <b>chính sách sale chung</b> (khối trên đầu), <b>SĐT riêng từng nhà</b> (trong ô địa chỉ — chỉ điền khi
              nhà đó dùng số khác hotline) và <b>chính sách sale từng phòng</b>. Ảnh tải về in đúng như bảng này.
            </p>
          </div>
          <QueryRegion label="danh sách phòng trống" queries={[rooms]} skeleton="table" rows={6}>
            <RoomListSheetEditor
              buildings={buildings}
              hotlines={hotlines}
              hotlineId={form.hotline_id}
              onHotlineChange={(id) => { set("hotline_id", id); setHotlineDraft(undefined); }}
              hotlinePhone={hotlinePhone}
              onHotlinePhoneChange={(value) => { setHotlineDraft(value); clearCell("hotline_phone"); }}
              salePolicy={form.sale_policy ?? ""}
              onSalePolicyChange={(value) => set("sale_policy", value)}
              edits={edits}
              onPhoneChange={setPhone}
              onPolicyChange={setPolicy}
              errors={{ ...cellErrors, hotline_id: errors.hotline_id ?? "", sale_policy: errors.sale_policy ?? "" }}
              disabled={busy}
            />
          </QueryRegion>
        </section>

        {writeError&&<p role="alert" className="text-sm text-destructive">{writeError}</p>}
        {sheetWriteError&&<p role="alert" className="text-sm text-destructive">{sheetWriteError}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={()=>void exportPreview()} disabled={exporting||!rooms.data}>
            <Download className="mr-1.5 h-4 w-4" />Tải ảnh xem trước
          </Button>
          <Button onClick={()=>void saveAll()} disabled={busy||!canSave}>
            Lưu cài đặt
          </Button>
        </div>
      </CardContent>
    </Card></QueryRegion></div>
  );
}
