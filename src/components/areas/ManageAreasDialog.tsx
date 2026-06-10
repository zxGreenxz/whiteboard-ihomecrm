import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  useAreas,
  useCreateArea,
  useUpdateArea,
  useDeleteArea,
  useAssignBuildingsToArea,
} from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";

interface ManageAreasDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Quản lý Khu vực — thay thế trang /areas cũ. Khu vực giờ chỉ là NHÃN NHÓM
 * toà nhà (không status, không module quyền riêng): đặt tên nhóm + gán toà.
 * Mọi ô lọc/scope trong app chọn theo khu qua BuildingMultiSelect.
 */
export function ManageAreasDialog({ open, onOpenChange }: ManageAreasDialogProps) {
  const { data: areasData } = useAreas();
  const areas = Array.isArray(areasData) ? areasData : [];
  const { data: buildingsData } = useBuildings();
  const buildings = Array.isArray(buildingsData) ? (buildingsData as any[]) : [];

  const createArea = useCreateArea();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();
  const assignBuildings = useAssignBuildingsToArea();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // building_ids hiện tại của từng khu (từ buildings.area_id).
  const membersByArea = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const b of buildings) {
      if (!b.area_id) continue;
      const list = map.get(b.area_id);
      if (list) list.push(b.id);
      else map.set(b.area_id, [b.id]);
    }
    return map;
  }, [buildings]);

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createArea.mutate(
      { name },
      { onSuccess: () => setNewName("") },
    );
  };

  const handleRename = (id: string) => {
    const name = editingName.trim();
    if (!name) return;
    updateArea.mutate(
      { id, updates: { name } },
      { onSuccess: () => setEditingId(null) },
    );
  };

  const handleDelete = (area: { id: string; name: string }) => {
    const count = membersByArea.get(area.id)?.length ?? 0;
    const msg =
      count > 0
        ? `Xoá khu vực "${area.name}"? ${count} toà trong khu sẽ về "Chưa phân khu" (không ảnh hưởng dữ liệu toà).`
        : `Xoá khu vực "${area.name}"?`;
    if (confirm(msg)) deleteArea.mutate(area.id);
  };

  const handleMembersChange = (areaId: string, nextIds: string[]) => {
    const current = membersByArea.get(areaId) ?? [];
    const next = new Set(nextIds);
    const cur = new Set(current);
    const toAddIds = nextIds.filter((id) => !cur.has(id));
    const toRemoveIds = current.filter((id) => !next.has(id));
    if (toAddIds.length === 0 && toRemoveIds.length === 0) return;
    assignBuildings.mutate({ areaId, toAddIds, toRemoveIds });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Quản lý khu vực</DialogTitle>
          <DialogDescription>
            Khu vực là nhãn nhóm toà nhà — dùng để chọn nhanh cả nhóm trong các
            ô lọc và khi gán phạm vi cho nhân viên. Mỗi toà thuộc tối đa 1 khu.
          </DialogDescription>
        </DialogHeader>

        {/* Thêm khu vực mới */}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Tên khu vực mới (vd: Quận 7, Khu A...)"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <Button
            onClick={handleCreate}
            disabled={!newName.trim() || createArea.isPending}
          >
            <Plus className="h-4 w-4 mr-1" />
            Thêm
          </Button>
        </div>

        <Separator />

        {areas.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có khu vực nào — thêm khu đầu tiên ở trên, sau đó gán toà vào khu.
          </p>
        ) : (
          <div className="space-y-4">
            {areas.map((area: any) => {
              const memberIds = membersByArea.get(area.id) ?? [];
              const isEditing = editingId === area.id;
              return (
                <div key={area.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <Input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className="h-8"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(area.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          onClick={() => handleRename(area.id)}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">{area.name}</span>
                        <Badge variant="secondary">{memberIds.length} toà</Badge>
                        <div className="flex-1" />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => {
                            setEditingId(area.id);
                            setEditingName(area.name);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive"
                          onClick={() => handleDelete(area)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                  <BuildingMultiSelect
                    value={memberIds}
                    onChange={(ids) => handleMembersChange(area.id, ids)}
                    placeholder="Chưa có toà nào — chọn toà cho khu này"
                  />
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ManageAreasDialog;
