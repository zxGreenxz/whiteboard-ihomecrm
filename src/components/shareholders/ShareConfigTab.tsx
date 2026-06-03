import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, KeyRound } from "lucide-react";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useShareholders,
  useBuildingShareholders,
  useUpsertBuildingShare,
  useDeleteShareholder,
  type Shareholder,
} from "@/hooks/useShareholders";
import ShareholderForm from "./ShareholderForm";

export default function ShareConfigTab() {
  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings(); // ẩn tòa ảo
  const { data: shares = [] } = useBuildingShareholders();
  const upsertShare = useUpsertBuildingShare();
  const deleteSh = useDeleteShareholder();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shareholder | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const shareMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shares) m.set(`${s.building_id}:${s.shareholder_id}`, s.percent);
    return m;
  }, [shares]);

  const totalByBuilding = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shares) m.set(s.building_id, (m.get(s.building_id) ?? 0) + s.percent);
    return m;
  }, [shares]);

  const handleCellBlur = (buildingId: string, shareholderId: string, raw: string) => {
    const val = Math.max(0, Math.min(100, Number(raw) || 0));
    const prev = shareMap.get(`${buildingId}:${shareholderId}`) ?? 0;
    if (val === prev) return;
    upsertShare.mutate({ building_id: buildingId, shareholder_id: shareholderId, percent: val });
  };

  return (
    <div className="space-y-4">
      {/* Danh sách cổ đông */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Cổ đông</CardTitle>
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Thêm cổ đông
          </Button>
        </CardHeader>
        <CardContent>
          {shareholders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có cổ đông nào.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {shareholders.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {s.auth_user_id ? (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-200 gap-1">
                          <KeyRound className="h-3 w-3" /> Có tài khoản
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">Chưa có tài khoản</Badge>
                      )}
                      {!s.is_active && <Badge variant="outline" className="text-red-600">Ngừng</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(s); setFormOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteId(s.id)}>
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ma trận tỷ lệ Nhà × Cổ đông */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tỷ lệ chia theo nhà (%)</CardTitle>
        </CardHeader>
        <CardContent>
          {buildings.length === 0 || shareholders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Cần có ít nhất 1 tòa nhà và 1 cổ đông.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10">Nhà</TableHead>
                    {shareholders.map((s) => (
                      <TableHead key={s.id} className="text-center min-w-[90px]">{s.name}</TableHead>
                    ))}
                    <TableHead className="text-center">Tổng</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buildings.map((b: any) => {
                    const total = totalByBuilding.get(b.id) ?? 0;
                    return (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium sticky left-0 bg-background z-10">{b.name}</TableCell>
                        {shareholders.map((s) => (
                          <TableCell key={s.id} className="p-1">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              defaultValue={shareMap.get(`${b.id}:${s.id}`) ?? ""}
                              onBlur={(e) => handleCellBlur(b.id, s.id, e.target.value)}
                              className="h-8 text-center"
                              placeholder="0"
                            />
                          </TableCell>
                        ))}
                        <TableCell className={`text-center font-semibold tabular-nums ${total > 100 ? "text-red-600" : ""}`}>
                          {total}%
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-2">
                Nhập % phần lợi nhuận mỗi cổ đông nhận từ từng nhà. Tổng &gt; 100% sẽ tô đỏ để cảnh báo.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <ShareholderForm open={formOpen} onOpenChange={(o) => { setFormOpen(o); if (!o) setEditing(null); }} shareholder={editing} />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá cổ đông?</AlertDialogTitle>
            <AlertDialogDescription>
              Cổ đông sẽ bị ẩn. Dữ liệu lợi nhuận đã chốt và phiếu chi gắn cổ đông vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => { if (deleteId) await deleteSh.mutateAsync(deleteId); setDeleteId(null); }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
