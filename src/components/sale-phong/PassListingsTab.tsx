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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Plus, Pencil, Trash2, Eye, EyeOff, TriangleAlert, Users } from "lucide-react";
import {
  usePassListings, usePassListingFormRooms, usePassListingRoomCustomers, useUpsertPassListing,
  useSetPassListingActive, useDeletePassListing,
  type PassListing, type PassListingFormRoom,
} from "@/hooks/usePassListings";

const fmtVnd = (n: number | null | undefined) =>
  n == null ? "" : Math.round(n).toLocaleString("vi-VN");
// 'YYYY-MM-DD' -> 'DD/MM/YYYY' (không qua Date để tránh lệch múi giờ)
const fmtDateStr = (s: string | null | undefined) =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split("-").reverse().join("/") : "";

interface FormState {
  id: string | null;
  roomId: string;
  contactName: string;
  contactPhone: string;
  salePolicy: string;
  passPrice: string; // chuỗi nhập tay → parse khi lưu
  availDate: string; // 'YYYY-MM-DD' (input type=date)
  active: boolean;
  contactManager: boolean; // true = ẩn SĐT khách công khai, hiện "Liên hệ quản lý"
}

const emptyForm: FormState = {
  id: null, roomId: "", contactName: "", contactPhone: "",
  salePolicy: "", passPrice: "", availDate: "", active: true, contactManager: false,
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
  const [contactPickerOpen, setContactPickerOpen] = useState(false);

  // Khách thuê của phòng đang chọn (để điền sẵn đại diện + cho chọn khách khác).
  const { data: roomCustomers = [] } = usePassListingRoomCustomers(open ? form.roomId : null);

  // Đổi phòng → điền sẵn SĐT/tên khách ĐẠI DIỆN nếu contact đang trống.
  useEffect(() => {
    if (!open || !form.roomId || roomCustomers.length === 0) return;
    setForm((f) => {
      if (f.contactName.trim() || f.contactPhone.trim()) return f; // không ghi đè khi đã có
      const rep = roomCustomers.find((c) => c.is_representative) ?? roomCustomers[0];
      return { ...f, contactName: rep.full_name ?? "", contactPhone: rep.phone ?? "" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCustomers, form.roomId, open]);

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
      availDate: l.avail_date ?? "",
      active: l.active,
      contactManager: l.contact_manager ?? false,
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
        availDate: form.availDate || null,
        active: form.active,
        contactManager: form.contactManager,
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
        {l.avail_date && (
          <div className="text-xs text-muted-foreground">Trống từ {fmtDateStr(l.avail_date)}</div>
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
                      {l.contact_manager && (
                        <Badge variant="outline" className="mb-0.5 font-normal">Liên hệ QL · ẩn SĐT khách</Badge>
                      )}
                      <div>
                        {l.contact_phone || "—"}
                        {l.contact_name && <span className="text-muted-foreground"> ({l.contact_name})</span>}
                      </div>
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
                onValueChange={(v) => setForm((f) => ({ ...f, roomId: v, contactName: "", contactPhone: "" }))}
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
                <div className="relative">
                  <Input id="pass-phone" inputMode="tel" placeholder="VD: 0354058160" className="pr-9"
                    value={form.contactPhone}
                    onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} />
                  <Popover open={contactPickerOpen} onOpenChange={setContactPickerOpen}>
                    <PopoverTrigger asChild>
                      <button type="button" disabled={roomCustomers.length === 0}
                        title={roomCustomers.length ? "Chọn từ khách thuê phòng" : "Phòng chưa có khách thuê"}
                        className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed">
                        <Users className="h-4 w-4" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="p-0 w-[280px]">
                      <Command>
                        <CommandInput placeholder="Tìm khách thuê..." />
                        <CommandList>
                          <CommandEmpty>Không có khách thuê</CommandEmpty>
                          <CommandGroup heading="Khách thuê của phòng">
                            {roomCustomers.map((c, i) => (
                              <CommandItem
                                key={i}
                                value={`${c.full_name ?? ""} ${c.phone ?? ""}`}
                                onSelect={() => {
                                  setForm((f) => ({ ...f, contactPhone: c.phone ?? "", contactName: c.full_name ?? "" }));
                                  setContactPickerOpen(false);
                                }}
                              >
                                <span className="font-medium truncate">{c.full_name || "—"}</span>
                                {c.is_representative && <Badge variant="secondary" className="ml-1.5 shrink-0">Đại diện</Badge>}
                                <span className="ml-auto pl-2 text-xs text-muted-foreground shrink-0">{c.phone || "—"}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <p className="text-xs text-muted-foreground">Tự điền khách đại diện khi chọn phòng; bấm <Users className="inline h-3 w-3" /> để chọn khách khác.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass-name">Tên khách</Label>
                <Input id="pass-name" placeholder="VD: Phúc"
                  value={form.contactName}
                  onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="pr-3">
                <Label htmlFor="pass-contact-manager">Liên hệ quản lý (ẩn SĐT khách)</Label>
                <p className="text-xs text-muted-foreground">
                  Bật khi khách không muốn lộ số: trang công khai hiện "Liên hệ quản lý" + SĐT
                  quản lý của tòa, KHÔNG hiển thị SĐT khách. SĐT khách vẫn lưu để nội bộ tra cứu.
                </p>
              </div>
              <Switch id="pass-contact-manager" checked={form.contactManager}
                onCheckedChange={(v) => setForm((f) => ({ ...f, contactManager: v }))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pass-price">Giá pass (đ/tháng)</Label>
                <Input id="pass-price" inputMode="numeric" placeholder="Để trống = giá phòng"
                  value={form.passPrice}
                  onChange={(e) => setForm((f) => ({ ...f, passPrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass-avail">Ngày trống phòng (tuỳ chọn)</Label>
                <Input id="pass-avail" type="date"
                  value={form.availDate}
                  onChange={(e) => setForm((f) => ({ ...f, availDate: e.target.value }))} />
              </div>
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
