import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useHotlines } from "@/hooks/useHotlines";
import {
  usePublicRoomSettings, useUpsertPublicRoomSettings, PUBLIC_ROOM_SETTINGS_DEFAULTS,
  type PublicRoomSettings,
} from "@/hooks/usePublicRoomSettings";

const NONE = "__none__"; // Select không nhận value="" → dùng sentinel cho "Mặc định"

export default function DisplaySettingsTab() {
  const { data, isLoading } = usePublicRoomSettings();
  const { data: hotlines } = useHotlines();
  const upsertMut = useUpsertPublicRoomSettings();

  const [form, setForm] = useState<PublicRoomSettings>(PUBLIC_ROOM_SETTINGS_DEFAULTS);

  useEffect(() => { if (data) setForm(data); }, [data]);

  const set = <K extends keyof PublicRoomSettings>(k: K, v: PublicRoomSettings[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Đang tải...</div>;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Cài đặt hiển thị trang "Phòng trống"</CardTitle>
        <CardDescription>Áp dụng chung cho mọi link chia sẻ của tài khoản.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* soon_days */}
        <div className="space-y-1.5">
          <Label htmlFor="soon-days">Số ngày báo "sắp trống"</Label>
          <Input
            id="soon-days" type="number" min={0} max={365} className="w-40"
            value={form.soon_days}
            onChange={(e) => set("soon_days", Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
          />
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
            <SelectTrigger id="hotline" className="w-full sm:w-96">
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

        <div className="flex justify-end">
          <Button onClick={() => upsertMut.mutate(form)} disabled={upsertMut.isPending}>
            Lưu cài đặt
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
