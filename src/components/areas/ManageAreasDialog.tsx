import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useMemo, useRef, useState } from "react";
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
  AreaDeletePartialError,
  useAssignBuildingsToArea,
} from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";
import { QueryRegion } from "@/components/errors/QueryRegion";

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
  // CHƯA GATE: useAreas chưa nhận `enabled` (hook thuộc plan con C).
  const areasQuery = useAreas();
  const { data: areasData } = areasQuery;
  const areas = Array.isArray(areasData) ? areasData : [];
  const buildingsQuery = useBuildings({ enabled: open });
  const { data: buildingsData } = buildingsQuery;
  const buildings = Array.isArray(buildingsData) ? (buildingsData as any[]) : [];

  const createArea = useCreateArea();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();
  const assignBuildings = useAssignBuildingsToArea();

  const [newName, setNewName] = useState("");
  const [failure,setFailure]=useState('');
  const busy=useRef(false);
  const newNameInput=useRef<HTMLInputElement>(null);
  const editingInput=useRef<HTMLInputElement>(null);
  const [invalidName,setInvalidName]=useState(false);
  // Đợt 8 (luật 5): sửa tên, gán tòa, xoá khu ghi lặp lại được — kết quả chưa rõ chỉ báo (kèm mã) và cho bấm lại, không khoá.
  const onFailure=(error:unknown,operation:string)=>{setFailure(recordWriteMessage(error,operation));busy.current=false;};
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  // Đường TẠO khu vực (đợt 9) vẫn khoá ô thêm khi kết quả chưa rõ, cho tới khi đối chiếu xong.
  const [createUnknown, setCreateUnknown] = useState<string | null>(null);
  // Xoá chưa xong (khu có thể đã xoá mềm nên không còn trong danh sách): giữ tên để bấm «Xoá lại» không cần hỏi lại.
  const [retryDelete, setRetryDelete] = useState<{ id: string; name: string } | null>(null);

  // building_ids hiện tại của từng khu (N-N: từ buildings.area_ids).
  const membersByArea = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const b of buildings) {
      for (const areaId of b.area_ids ?? []) {
        const list = map.get(areaId);
        if (list) list.push(b.id);
        else map.set(areaId, [b.id]);
      }
    }
    return map;
  }, [buildings]);

  const handleCreate = () => {
    const name = newName.trim();
    if (busy.current || createUnknown || areasQuery.isError || buildingsQuery.isError)return;
    if (!name) {setInvalidName(true);setFailure('Nhập tên khu vực.');newNameInput.current?.focus();return;}
    busy.current=true;setFailure('');setInvalidName(false);
    createArea.mutate(
      { name },
      { onSuccess: () => {setNewName("");busy.current=false;}, onError:error=>{if(recordWriteBlocked(error)){setCreateUnknown(recordWriteMessage(error,'tạo khu vực'));busy.current=false;}else onFailure(error,'tạo khu vực');},onSettled:()=>{busy.current=false;} },
    );
  };

  const handleRename = (id: string) => {
    const name = editingName.trim();
    if (busy.current || areasQuery.isError || buildingsQuery.isError)return;
    if (!name) {setInvalidName(true);setFailure('Nhập tên khu vực.');editingInput.current?.focus();return;}
    busy.current=true;setFailure('');setInvalidName(false);
    updateArea.mutate(
      { id, updates: { name } },
      { onSuccess: () => {setEditingId(null);busy.current=false;},onError:error=>onFailure(error,'cập nhật khu vực'),onSettled:()=>{busy.current=false;} },
    );
  };

  const runDelete = (area: { id: string; name: string }) => {
    busy.current=true;setFailure('');
    deleteArea.mutate(area.id, {
      onSuccess: () => {setRetryDelete(null);busy.current=false;},
      onError: error => {onFailure(error,'xoá khu vực');setRetryDelete(error instanceof AreaDeletePartialError ? area : null);},onSettled:()=>{busy.current=false;},
    });
  };

  const handleDelete = (area: { id: string; name: string }) => {
    if (busy.current || areasQuery.isError || buildingsQuery.isError) return;
    const count = membersByArea.get(area.id)?.length ?? 0;
    const msg =
      count > 0
        ? `Xoá khu vực "${area.name}"? Khu sẽ bị gỡ khỏi ${count} toà (toà vẫn giữ các khu khác, không ảnh hưởng dữ liệu toà).`
        : `Xoá khu vực "${area.name}"?`;
    if (confirm(msg)) runDelete({ id: area.id, name: area.name });
  };

  const handleMembersChange = (areaId: string, nextIds: string[]) => {
    const current = membersByArea.get(areaId) ?? [];
    const next = new Set(nextIds);
    const cur = new Set(current);
    const toAddIds = nextIds.filter((id) => !cur.has(id));
    const toRemoveIds = current.filter((id) => !next.has(id));
    if (toAddIds.length === 0 && toRemoveIds.length === 0) return;
    if (busy.current || areasQuery.isError || buildingsQuery.isError) return;
    busy.current=true;setFailure('');assignBuildings.mutate({ areaId, toAddIds, toRemoveIds }, {
      onError: error => onFailure(error,'gán tòa vào khu vực'),onSettled:()=>{busy.current=false;},
    });
  };

  return (
    <Dialog open={open} onOpenChange={next=>{if(!busy.current)onOpenChange(next);}}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Quản lý khu vực</DialogTitle>
          <DialogDescription>
            Khu vực là nhãn nhóm toà nhà — dùng để chọn nhanh cả nhóm trong các
            ô lọc và khi gán phạm vi cho nhân viên. Một toà có thể thuộc nhiều khu.
          </DialogDescription>
        </DialogHeader>

        {failure && <div role="alert" className="text-sm text-destructive">
          <p>{failure}</p>
          {retryDelete && <Button type="button" variant="outline" size="sm" className="mt-2" disabled={deleteArea.isPending} onClick={() => {if(!busy.current)runDelete(retryDelete);}}>
            Xoá lại «{retryDelete.name}»
          </Button>}
        </div>}
        {createUnknown && <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">
          {createUnknown}
          <Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={async () => {
            const results = await Promise.all([areasQuery.refetch(), buildingsQuery.refetch()]);
            // Refresh shows current state; it cannot prove completion or clear the pending request.
            if(results.some(result=>result.isError))setFailure('Chưa tải đủ trạng thái khu vực để đối chiếu.');
          }}>Tải lại để đối chiếu</Button>
        </div>}

        {/* Ô thêm khu vực cố ý nằm trong vùng chờ: tạo/gán khu cần danh sách khu + toà đã về. */}
        <QueryRegion label="khu vực và tòa nhà" queries={[areasQuery, buildingsQuery]} skeleton="detail" rows={4}>

        {/* Thêm khu vực mới */}
        <div className="flex items-center gap-2">
          <Input
            ref={newNameInput} aria-label="Tên khu vực mới" aria-invalid={invalidName} disabled={!!createUnknown}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Tên khu vực mới (vd: Quận 7, Khu A...)"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <Button
            onClick={handleCreate}
            disabled={!newName.trim() || createArea.isPending || !!createUnknown}
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
                          ref={editingInput} aria-label="Tên khu vực" aria-invalid={invalidName} disabled={updateArea.isPending}
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
                          disabled={deleteArea.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                  <fieldset disabled={assignBuildings.isPending}>
                  <BuildingMultiSelect
                    value={memberIds}
                    onChange={(ids) => handleMembersChange(area.id, ids)}
                    placeholder="Chưa có toà nào — chọn toà cho khu này"
                  />
                  </fieldset>
                </div>
              );
            })}
          </div>
        )}
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}

export default ManageAreasDialog;
