import { Download } from "lucide-react";
import {QueryRegion} from "@/components/errors/QueryRegion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import RoomListSheetEditor from "./RoomListSheetEditor";
import { useRoomListSheetDraft } from "./useRoomListSheetDraft";

export default function DisplaySettingsTab() {
  const sheet = useRoomListSheetDraft();
  const { settings, hotlines: hotlineQuery, root, form, days, errors, writeError, canSave, set, changeDays, rooms } = sheet;

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
              nhà đó dùng số khác hotline) và các ô của từng phòng: <b>giá, chính sách sale, loại phòng, nội thất,
              tình trạng</b>. Lưu là sửa thẳng dữ liệu phòng; ô tình trạng để trống thì tự tính theo hợp đồng.
              Ảnh tải về in đúng như bảng này.
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
              salePolicy={form.sale_policy ?? ""}
              onSalePolicyChange={(value) => set("sale_policy", value)}
              edits={sheet.edits}
              onPhoneChange={sheet.setPhone}
              onPolicyChange={sheet.setPolicy}
              onRoomFieldChange={sheet.setRoomField}
              errors={{ ...sheet.cellErrors, hotline_id: errors.hotline_id ?? "", sale_policy: errors.sale_policy ?? "" }}
              disabled={sheet.busy}
            />
          </QueryRegion>
        </section>

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
