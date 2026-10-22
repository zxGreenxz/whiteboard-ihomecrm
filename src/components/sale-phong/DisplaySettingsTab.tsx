import { Download } from "lucide-react";
import {QueryRegion} from "@/components/errors/QueryRegion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import RoomListSheetEditor from "./RoomListSheetEditor";
import { useRoomListSheetDraft } from "./useRoomListSheetDraft";
import SheetDraftStatus from './SheetDraftStatus';

export default function DisplaySettingsTab({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const sheet = useRoomListSheetDraft(onBusyChange);
  const { settings, hotlines: hotlineQuery, root, form, days, errors, writeError, canSave, set, changeDays, rooms } = sheet;

  return (
    <div ref={root}><QueryRegion label="cài đặt hiển thị" queries={sheet.canManageSettings ? [settings,hotlineQuery] : []} skeleton="detail" rows={4}><Card>
      <CardHeader>
        <CardTitle>Bảng phòng trống — điền như Excel</CardTitle>
        <CardDescription>
          Cùng nguồn dữ liệu với bảng cập nhật nhanh. Chỉ sửa được phòng và cài đặt thuộc quyền được giao.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {sheet.canManageSettings ? <div className="grid gap-4 lg:grid-cols-2">
          {/* soon_days */}
          <div className="space-y-1.5">
            <Label htmlFor="soon-days">Số ngày báo "sắp trống"</Label>
            <Input
              id="soon-days" name="soon_days" type="text" inputMode="numeric" className={"w-40"+(errors.soon_days?" border-destructive":"")} aria-invalid={!!errors.soon_days} aria-describedby={errors.soon_days?"soon-days-error":undefined}
              value={days}
              disabled={sheet.busy}
              onChange={(e)=>changeDays(e.target.value)}
            />
            {errors.soon_days&&<p id="soon-days-error" role="alert" className="text-sm text-destructive">{errors.soon_days}</p>}
            <p className="text-xs text-muted-foreground">
              Khoảng ngày dùng để chào phòng đã có thông tin trả phòng hoặc ngày nhận khách phù hợp.
              Hợp đồng sắp hết hạn không tự xác nhận phòng "Sắp trống". Mặc định 30 ngày.
            </p>
          </div>

          {/* show_rented */}
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="show-rented">Phòng đã thuê trên sơ đồ</Label>
              <p className="text-xs text-muted-foreground">
                Trang công khai luôn vẽ mờ phòng đã thuê để giữ đầy đủ sơ đồ tầng.
                Tùy chọn thay đổi cách hiển thị này chưa được hỗ trợ.
              </p>
            </div>
            <Switch id="show-rented" checked disabled aria-label="Luôn vẽ mờ phòng đã thuê" />
          </div>
        </div> : <p className="text-sm text-muted-foreground">Hotline và chính sách chung được hiển thị theo cấu hình đang áp dụng; tài khoản này không thay đổi cấu hình chủ tài khoản.</p>}

        <section className="space-y-2" aria-labelledby="room-list-sheet-title">
          <div>
            <h3 id="room-list-sheet-title" className="font-semibold">Bảng phòng trống — điền như Excel</h3>
            <p className="text-xs text-muted-foreground">
              Ô trắng viền đứt là ô điền: <b>hotline chung cho tất cả nhà</b> (góc trên trái),{" "}
              <b>chính sách sale chung</b> (khối trên đầu), <b>SĐT riêng từng nhà</b> (trong ô địa chỉ — chỉ điền khi
              nhà đó dùng số khác hotline) và các ô của từng phòng: <b>giá, chính sách sale, loại phòng, nội thất,
              chú thích tình trạng</b>. Ô chú thích để trống sẽ dùng tình trạng từ nghiệp vụ phòng.
              Ảnh xem trước dùng nội dung đang nhập, kể cả bản nháp chưa lưu.
            </p>
          </div>
          <QueryRegion label="danh sách phòng trống" queries={[rooms]} skeleton="table" rows={6}>
            <RoomListSheetEditor
              buildings={sheet.buildings}
              preview={sheet.preview}
              hotlines={sheet.hotlineList}
              hotlineId={form.hotline_id}
              onHotlineChange={sheet.pickHotline}
              hotlinePhone={sheet.hotlinePhone}
              onHotlinePhoneChange={sheet.setHotlinePhone}
              salePolicy={sheet.salePolicy}
              onSalePolicyChange={(value) => set("sale_policy", value)}
              edits={sheet.edits}
              onPhoneChange={sheet.setPhone}
              onPolicyChange={sheet.setPolicy}
              onRoomFieldChange={sheet.setRoomField}
              errors={{ ...sheet.cellErrors, hotline_id: errors.hotline_id ?? "", sale_policy: errors.sale_policy ?? "" }}
              disabled={sheet.busy}
              roomWritable={sheet.roomWritable} phoneWritable={sheet.phoneWritable}
              canManageSettings={sheet.canManageSettings} activePolicies={sheet.activePolicies}
            />
          </QueryRegion>
        </section>
        <SheetDraftStatus sheet={sheet} />

        {writeError&&<p role="alert" className="text-sm text-destructive">{writeError}</p>}
        {sheet.sheetWriteError&&<p role="alert" className="text-sm text-destructive">{sheet.sheetWriteError}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={()=>void sheet.exportPreview()} disabled={sheet.exporting||!rooms.data}>
            <Download className="mr-1.5 h-4 w-4" />Tải ảnh xem trước
          </Button>
          <Button onClick={()=>void sheet.saveAll()} disabled={sheet.busy||!canSave}>
            Lưu cài đặt
          </Button>
        </div>
      </CardContent>
    </Card></QueryRegion></div>
  );
}
