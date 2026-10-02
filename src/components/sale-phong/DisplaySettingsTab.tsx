import {QueryRegion} from "@/components/errors/QueryRegion";
import {usePublicRoomSettingsDraft} from "./usePublicRoomSettingsDraft";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
const NONE = "__none__"; // Select không nhận value="" → dùng sentinel cho "Mặc định"

export default function DisplaySettingsTab() {
  const {settings,hotlines:hotlineQuery,mutation:upsertMut,root,form,days,errors,writeError,canSave,set,changeDays,save}=usePublicRoomSettingsDraft();
  const hotlines=hotlineQuery.data;

  return (
    <div ref={root}><QueryRegion label="cài đặt hiển thị" queries={[settings,hotlineQuery]} skeleton="detail" rows={4}><Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Cài đặt hiển thị trang "Phòng trống"</CardTitle>
        <CardDescription>Áp dụng chung cho mọi link chia sẻ của tài khoản.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
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

        {/* hotline */}
        <div className="space-y-1.5">
          <Label htmlFor="hotline">Hotline hiển thị</Label>
          <Select
            value={form.hotline_id ?? NONE}
            onValueChange={(v) => set("hotline_id", v === NONE ? null : v)}
          >
            <SelectTrigger id="hotline" data-field-name="hotline_id" aria-invalid={!!errors.hotline_id} aria-describedby={errors.hotline_id?"hotline-error":undefined} className="w-full sm:w-96">
              <SelectValue placeholder="Mặc định (hotline đầu tiên)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Mặc định (hotline đầu tiên)</SelectItem>
              {(hotlines ?? []).map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name} · {h.phone_number}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.hotline_id&&<p id="hotline-error" role="alert" className="text-destructive">{errors.hotline_id}</p>}
          <p className="text-xs text-muted-foreground">
            Số điện thoại/người liên hệ hiển thị trên trang. Để "Mặc định" sẽ lấy hotline đang
            hoạt động đầu tiên.
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

        {writeError&&<p role="alert" className="text-sm text-destructive">{writeError}</p>}
        <div className="flex justify-end">
          <Button onClick={()=>void save()} disabled={upsertMut.isPending||!canSave}>
            Lưu cài đặt
          </Button>
        </div>
      </CardContent>
    </Card></QueryRegion></div>
  );
}
