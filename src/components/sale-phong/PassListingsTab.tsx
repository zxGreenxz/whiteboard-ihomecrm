import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Eye, EyeOff, TriangleAlert } from "lucide-react";
import {
  usePassListings, usePassListingFormRooms, useUpsertPassListing,
  useSetPassListingActive, useDeletePassListing,
  type PassListing, type PassListingFormRoom,
} from "@/hooks/usePassListings";

const fmtVnd = (n: number | null | undefined) =>
  n == null ? "" : Math.round(n).toLocaleString("vi-VN");

interface FormState {
  id: string | null;
  roomId: string;
  contactName: string;
  contactPhone: string;
  salePolicy: string;
  passPrice: string; // chuỗi nhập tay → parse khi lưu
  active: boolean;
}

const emptyForm: FormState = {
  id: null, roomId: "", contactName: "", contactPhone: "",
  salePolicy: "", passPrice: "", active: true,
};

export default function PassListingsTab() {
  const { data: listings, isLoading } = usePassListings();
  const { data: formRooms } = usePassListingFormRooms();
  const upsertMut = useUpsertPassListing();
  const activeMut = useSetPassListingActive();
  const deleteMut = useDeletePassListing();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleting, setDeleting] = useState<PassListing | null>(null);

  // Tra cứu tên phòng/tòa từ danh sách form (listings chỉ lưu id).
  const roomById = useMemo(() => {
    const m = new Map<string, PassListingFormRoom>();
    (formRooms ?? []).forEach((r) => m.set(r.room_id, r));
    return m;
  }, [formRooms]);

  const roomOpts = useMemo(
    () =>
      (formRooms ?? []).map((r) => ({
        value: r.room_id,
        label: `${r.building_name} · ${r.room_name}${r.room_code && r.room_code !== r.room_name ? ` (${r.room_code})` : ""}${r.has_active_contract ? "" : " — (phòng trống)"}`,
        keywords: `${r.building_name} ${r.room_name} ${r.room_code ?? ""}`,
      })),
    [formRooms],
  );

  const selectedRoom = form.roomId ? roomById.get(form.roomId) : undefined;

  const openCreate = () => { setForm(emptyForm); setOpen(true); };
  const openEdit = (l: PassListing) => {
    setForm({
      id: l.id,
      roomId: l.room_id,
      contactName: l.contact_name ?? "",
      contactPhone: l.contact_phone ?? "",
      salePolicy: l.sale_policy ?? "",
      passPrice: l.pass_price != null ? String(l.pass_price) : "",
      active: l.active,
    });
    setOpen(true);
  };

  const doSave = () => {
    if (!form.roomId) return;
    const price = form.passPrice.replace(/[^\d]/g, "");
    upsertMut.mutate(
      {
        id: form.id,
        roomId: form.roomId,
        contactName: form.contactName.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        salePolicy: form.salePolicy.trim() || null,
        passPrice: price ? Number(price) : null,
        active: form.active,
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  const roomLabel = (l: PassListing) => {
    const r = roomById.get(l.room_id);
    if (!r) return <span className="text-muted-foreground">Phòng đã xoá</span>;
    return (
      <div className="leading-tight">
        <div className="font-medium">{r.building_name} · {r.room_name}</div>
        {r.room_code && r.room_code !== r.room_name && (
          <div className="text-xs text-muted-foreground">{r.room_code}</div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Phòng đang có khách thuê nhưng khách <b>nhờ sale / pass phòng</b>. Phòng sẽ hiện trên
          trang công khai với SĐT của khách + chính sách sale riêng (tô màu hồng). Tắt hiển thị
          khi khách dừng nhờ — không ảnh hưởng hợp đồng đang thuê.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" />Thêm phòng pass
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải...</div>
          ) : !listings || listings.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              Chưa có phòng khách nhờ sale nào. Bấm "Thêm phòng pass" để bắt đầu.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phòng</TableHead>
                  <TableHead>Liên hệ khách</TableHead>
                  <TableHead>Chính sách sale</TableHead>
                  <TableHead>Giá pass</TableHead>
                  <TableHead>Hiển thị</TableHead>
                  <TableHead className="w-[130px]">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l) => (
                  <TableRow key={l.id} className={l.active ? "" : "opacity-60"}>
                    <TableCell>{roomLabel(l)}</TableCell>
                    <TableCell className="text-sm">
                      {l.contact_phone || "—"}
                      {l.contact_name && <span className="text-muted-foreground"> ({l.contact_name})</span>}
                    </TableCell>
                    <TableCell className="text-sm max-w-[240px] truncate" title={l.sale_policy ?? ""}>
                      {l.sale_policy || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">{l.pass_price != null ? fmtVnd(l.pass_price) : <span className="text-muted-foreground">theo giá phòng</span>}</TableCell>
                    <TableCell>
                      {l.active
                        ? <Badge variant="default">Đang hiện</Badge>
                        : <Badge variant="secondary">Đang ẩn</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" title="Sửa" onClick={() => openEdit(l)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          title={l.active ? "Ẩn khỏi trang công khai" : "Hiện lại"}
                          onClick={() => activeMut.mutate({ id: l.id, active: !l.active })}
                        >
                          {l.active ? <EyeOff className="h-4 w-4 text-amber-600" /> : <Eye className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" title="Xoá" onClick={() => setDeleting(l)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Tạo / sửa listing */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Sửa phòng khách nhờ sale" : "Thêm phòng khách nhờ sale"}</DialogTitle>
            <DialogDescription>
              Chọn phòng đang có khách, nhập SĐT khách + chính sách sale để hiển thị trên trang công khai.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label>Phòng</Label>
              <SearchableSelect
                value={form.roomId}
                onValueChange={(v) => setForm((f) => ({ ...f, roomId: v }))}
                options={roomOpts}
                placeholder="Chọn phòng (gõ để tìm tòa/mã phòng)"
                emptyText="Không có phòng trong phạm vi"
              />
              {selectedRoom && !selectedRoom.has_active_contract && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  Phòng này hiện không có hợp đồng đang hiệu lực — vẫn đăng được nhưng kiểm tra lại.
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pass-phone">SĐT khách</Label>
                <Input id="pass-phone" inputMode="tel" placeholder="VD: 0354058160"
                  value={form.contactPhone}
                  onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass-name">Tên khách</Label>
                <Input id="pass-name" placeholder="VD: Phúc"
                  value={form.contactName}
                  onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pass-price">Giá pass (đ/tháng) — để trống nếu dùng giá phòng</Label>
              <Input id="pass-price" inputMode="numeric" placeholder="VD: 3300000"
                value={form.passPrice}
                onChange={(e) => setForm((f) => ({ ...f, passPrice: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pass-policy">Chính sách sale (của khách)</Label>
              <Textarea id="pass-policy" rows={2}
                placeholder="VD: Giảm khách 500k tháng đầu hoặc thưởng sale 500k"
                value={form.salePolicy}
                onChange={(e) => setForm((f) => ({ ...f, salePolicy: e.target.value }))} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="pass-active">Hiển thị trên trang công khai</Label>
                <p className="text-xs text-muted-foreground">Tắt để tạm ẩn mà không xoá.</p>
              </div>
              <Switch id="pass-active" checked={form.active}
                onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Hủy</Button>
            <Button onClick={doSave} disabled={!form.roomId || upsertMut.isPending}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Xoá */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá phòng khách nhờ sale này?</AlertDialogTitle>
            <AlertDialogDescription>
              Phòng sẽ không còn hiển thị dạng "khách pass" trên trang công khai. Hợp đồng đang thuê
              KHÔNG bị ảnh hưởng. Nếu chỉ muốn tạm ẩn, hãy dùng nút Ẩn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleting) deleteMut.mutate(deleting.id); setDeleting(null); }}>
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
