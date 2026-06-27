import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAdminUsers } from "@/hooks/useAdminUsers";
import { useBuildings } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import {
  useCreateShareholder,
  useUpdateShareholder,
  useShareholders,
  useBuildingShareholders,
  useSyncShareholderBuildings,
  type Shareholder,
} from "@/hooks/useShareholders";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shareholder: Shareholder | null;
}

interface BRow {
  building_id: string;
  percent: number;
}

export default function ShareholderForm({ open, onOpenChange, shareholder }: Props) {
  const isEdit = !!shareholder;
  const { data: users = [] } = useAdminUsers();
  const { data: buildings = [] } = useBuildings(); // ẩn tòa ảo
  const { data: areas = [] } = useAreas();
  const { data: shareholders = [] } = useShareholders();
  const { data: allShares = [] } = useBuildingShareholders();

  const createMut = useCreateShareholder();
  const updateMut = useUpdateShareholder();
  const syncMut = useSyncShareholderBuildings();

  const [authUserId, setAuthUserId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [rows, setRows] = useState<BRow[]>([]);

  useEffect(() => {
    if (!open) return;
    setAuthUserId(shareholder?.auth_user_id ?? "");
    setName(shareholder?.name ?? "");
    setNote(shareholder?.note ?? "");
    setIsActive(shareholder?.is_active ?? true);
    if (shareholder) {
      setRows(
        allShares
          .filter((s) => s.shareholder_id === shareholder.id)
          .map((s) => ({ building_id: s.building_id, percent: s.percent }))
      );
    } else {
      setRows([]);
    }
  }, [open, shareholder, allShares]);

  // Loại user đã gán cho cổ đông KHÁC (auth_user_id là UNIQUE).
  const linkedElsewhere = useMemo(() => {
    const set = new Set<string>();
    for (const s of shareholders) {
      if (s.auth_user_id && s.id !== shareholder?.id) set.add(s.auth_user_id);
    }
    return set;
  }, [shareholders, shareholder?.id]);

  const userOptions = useMemo(
    () =>
      users
        .filter((u) => !linkedElsewhere.has(u.id))
        .map((u) => ({
          value: u.id,
          label: u.full_name || u.email || u.id,
          keywords: [u.full_name ?? "", u.email ?? ""].filter(Boolean),
        })),
    [users, linkedElsewhere]
  );

  const buildingOptionsFor = (currentId: string) => {
    const chosen = new Set(rows.map((r) => r.building_id).filter((b) => b !== currentId));
    return buildings
      .filter((b: any) => !chosen.has(b.id))
      .map((b: any) => ({ value: b.id, label: b.name }));
  };

  // Khu vực → gợi ý thêm nhanh cả nhóm tòa. Đếm theo `buildings` (đã ẩn tòa ảo)
  // để số "(N toà)" khớp đúng những gì có thể thêm, bỏ qua khu rỗng.
  const areaOptions = useMemo(() => {
    return areas
      .map((a: any) => ({
        id: a.id as string,
        name: a.name as string,
        count: buildings.filter((b: any) => (b.area_ids || []).includes(a.id)).length,
      }))
      .filter((a) => a.count > 0)
      .map((a) => ({
        value: a.id,
        label: `${a.name} (${a.count} toà)`,
        keywords: a.name,
      }));
  }, [areas, buildings]);

  // Thêm tất cả tòa của một khu (bỏ qua tòa đã có) thành các dòng tỷ lệ 0%.
  const addAreaBuildings = (areaId: string) => {
    if (!areaId) return;
    const existing = new Set(rows.map((r) => r.building_id).filter(Boolean));
    const toAdd = buildings
      .filter((b: any) => (b.area_ids || []).includes(areaId) && !existing.has(b.id))
      .map((b: any) => ({ building_id: b.id as string, percent: 0 }));
    if (toAdd.length === 0) {
      toast.info("Các tòa của khu này đã được thêm hết.");
      return;
    }
    setRows((p) => [...p, ...toAdd]);
  };

  const handleUserChange = (uid: string) => {
    setAuthUserId(uid);
    if (!name.trim()) {
      const u = users.find((x) => x.id === uid);
      if (u) setName(u.full_name || u.email || "");
    }
  };

  const addRow = () => setRows((p) => [...p, { building_id: "", percent: 0 }]);
  const removeRow = (i: number) => setRows((p) => p.filter((_, idx) => idx !== i));
  const setRow = (i: number, patch: Partial<BRow>) =>
    setRows((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const canSave = name.trim().length > 0 && !!authUserId;
  const busy = createMut.isPending || updateMut.isPending || syncMut.isPending;

  const handleSave = async () => {
    if (!canSave) return;
    const values = {
      name: name.trim(),
      note: note.trim() || null,
      is_active: isActive,
      auth_user_id: authUserId || null,
    };
    const validRows = rows.filter((r) => r.building_id);
    let id = shareholder?.id;
    if (isEdit && shareholder) {
      await updateMut.mutateAsync({ id: shareholder.id, values });
    } else {
      const created = await createMut.mutateAsync(values);
      id = (created as any).id;
    }
    if (id) await syncMut.mutateAsync({ shareholder_id: id, rows: validRows });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa cổ đông" : "Thêm cổ đông"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Tài khoản (user) <span className="text-red-500">*</span></Label>
            <SearchableSelect
              value={authUserId}
              onValueChange={handleUserChange}
              placeholder="Chọn user để gắn cổ đông"
              options={userOptions}
            />
            <p className="text-xs text-muted-foreground">
              Cổ đông đăng nhập bằng tài khoản này để xem đúng phần của mình. Chưa có tài khoản? Tạo ở Quản trị → Người dùng.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Tên hiển thị <span className="text-red-500">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Hiệp, Hiển..." />
          </div>

          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label className="text-sm">Đang hoạt động</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Tòa nhà &amp; tỷ lệ (%)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4 mr-1" /> Thêm tòa
              </Button>
            </div>
            {areaOptions.length > 0 && (
              <SearchableSelect
                value=""
                onValueChange={addAreaBuildings}
                placeholder="+ Thêm nhanh theo khu vực…"
                searchPlaceholder="Tìm khu vực..."
                options={areaOptions}
              />
            )}
            {rows.length === 0 && (
              <p className="text-xs text-muted-foreground">Cổ đông này chưa có phần ở tòa nào. Bấm "Thêm tòa".</p>
            )}
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <SearchableSelect
                    value={r.building_id}
                    onValueChange={(v) => setRow(i, { building_id: v })}
                    placeholder="Chọn tòa"
                    options={buildingOptionsFor(r.building_id)}
                  />
                </div>
                <div className="w-24 relative">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={r.percent || ""}
                    onChange={(e) => setRow(i, { percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                    className="pr-6 text-right"
                    placeholder="0"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
                <Button type="button" variant="ghost" size="icon" onClick={() => removeRow(i)}>
                  <Trash2 className="h-4 w-4 text-red-600" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSave} disabled={!canSave || busy}>
            {busy ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
