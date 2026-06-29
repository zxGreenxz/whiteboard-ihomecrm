import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Pencil, Trash2, KeyRound, AlertTriangle, Building2, Briefcase } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useBuildings } from "@/hooks/useBuildings";
import { useAdminUsers } from "@/hooks/useAdminUsers";
import {
  useShareholders,
  useBuildingShareholders,
  useDeleteShareholder,
  type Shareholder,
} from "@/hooks/useShareholders";
import {
  useProfitManagers,
  useManagerSalaries,
  useDeleteProfitManager,
  type ProfitManager,
} from "@/hooks/useProfitManagers";
import ShareholderForm from "./ShareholderForm";
import ProfitManagerForm from "./ProfitManagerForm";

export default function ShareConfigTab() {
  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings();
  const { data: shares = [] } = useBuildingShareholders();
  const { data: users = [] } = useAdminUsers();
  const deleteSh = useDeleteShareholder();

  const { data: managers = [] } = useProfitManagers();
  const { data: salaryRules = [] } = useManagerSalaries();
  const deleteMgr = useDeleteProfitManager();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shareholder | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [mgrFormOpen, setMgrFormOpen] = useState(false);
  const [editingMgr, setEditingMgr] = useState<ProfitManager | null>(null);
  const [deleteMgrId, setDeleteMgrId] = useState<string | null>(null);

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";
  const userEmail = (uid: string | null) =>
    uid ? users.find((u) => u.id === uid)?.email ?? users.find((u) => u.id === uid)?.full_name ?? "—" : null;

  const sharesByShareholder = useMemo(() => {
    const m = new Map<string, { building_id: string; percent: number }[]>();
    for (const s of shares) {
      const arr = m.get(s.shareholder_id) ?? [];
      arr.push({ building_id: s.building_id, percent: s.percent });
      m.set(s.shareholder_id, arr);
    }
    return m;
  }, [shares]);

  const rulesByManager = useMemo(() => {
    const m = new Map<string, typeof salaryRules>();
    for (const r of salaryRules) {
      const arr = m.get(r.manager_id) ?? [];
      arr.push(r);
      m.set(r.manager_id, arr);
    }
    return m;
  }, [salaryRules]);

  // Mô tả gọn 1 quy tắc lương: hình thức + cơ sở + giá trị + số nhà.
  const ruleLabel = (r: (typeof salaryRules)[number]): string => {
    const basis = r.basis === "PER_BUILDING" ? "mỗi nhà" : "tổng nhóm";
    const value = r.form === "FIXED" ? formatCurrency(r.amount) : `${r.percent}% LN`;
    return `${value} · ${basis} · ${r.building_ids.length} nhà`;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Cổ đông &amp; tỷ lệ theo tòa</CardTitle>
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Thêm cổ đông
          </Button>
        </CardHeader>
        <CardContent>
          {shareholders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có cổ đông nào. Bấm "Thêm cổ đông" để gán user + chọn tòa.</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {shareholders.map((s) => {
                const rows = sharesByShareholder.get(s.id) ?? [];
                return (
                  <div key={s.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{s.name}</p>
                        {s.auth_user_id ? (
                          <span className="text-xs text-emerald-600 flex items-center gap-1">
                            <KeyRound className="h-3 w-3" /> {userEmail(s.auth_user_id)}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-600 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" /> Chưa gán user — cổ đông không đăng nhập được
                          </span>
                        )}
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

                    {rows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Chưa gán tòa nào.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {rows.map((r) => (
                          <Badge key={r.building_id} variant="outline" className="gap-1 font-normal">
                            <Building2 className="h-3 w-3" />
                            {buildingName(r.building_id)}
                            <span className="font-semibold text-blue-600">{r.percent}%</span>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lương điều hành — trừ khỏi LN từng nhà trước khi chia cổ đông */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Lương điều hành</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Trừ khỏi lợi nhuận từng nhà <strong>trước</strong> khi chia cho cổ đông.
            </p>
          </div>
          <Button size="sm" onClick={() => { setEditingMgr(null); setMgrFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Thêm quản lý
          </Button>
        </CardHeader>
        <CardContent>
          {managers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có quản lý điều hành nào. Bấm "Thêm quản lý" để gán user + cấu hình lương.</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {managers.map((m) => {
                const rows = rulesByManager.get(m.id) ?? [];
                return (
                  <div key={m.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate flex items-center gap-1">
                          <Briefcase className="h-3.5 w-3.5 text-muted-foreground" /> {m.name}
                        </p>
                        {m.auth_user_id ? (
                          <span className="text-xs text-emerald-600 flex items-center gap-1">
                            <KeyRound className="h-3 w-3" /> {userEmail(m.auth_user_id)}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-600 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" /> Chưa gán user — quản lý không đăng nhập được
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="icon" onClick={() => { setEditingMgr(m); setMgrFormOpen(true); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteMgrId(m.id)}>
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>
                    </div>

                    {rows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Chưa có quy tắc lương.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {rows.map((r) => (
                          <div key={r.id} className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                            <div className="font-medium text-foreground">
                              {r.label || (r.form === "FIXED" ? "Tiền thực" : "Phần trăm")}
                            </div>
                            <div className="text-muted-foreground">{ruleLabel(r)}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {r.building_ids.slice(0, 6).map((bid) => (
                                <Badge key={bid} variant="outline" className="gap-1 font-normal">
                                  <Building2 className="h-3 w-3" />
                                  {buildingName(bid)}
                                </Badge>
                              ))}
                              {r.building_ids.length > 6 && (
                                <Badge variant="outline" className="font-normal">+{r.building_ids.length - 6}</Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ShareholderForm open={formOpen} onOpenChange={(o) => { setFormOpen(o); if (!o) setEditing(null); }} shareholder={editing} />
      <ProfitManagerForm open={mgrFormOpen} onOpenChange={(o) => { setMgrFormOpen(o); if (!o) setEditingMgr(null); }} manager={editingMgr} />

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

      <AlertDialog open={!!deleteMgrId} onOpenChange={(o) => { if (!o) setDeleteMgrId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá quản lý điều hành?</AlertDialogTitle>
            <AlertDialogDescription>
              Quản lý sẽ bị ẩn và các quy tắc lương ngừng áp dụng cho lần chốt sau. Lương đã chốt
              và phiếu chi đã trả vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => { if (deleteMgrId) await deleteMgr.mutateAsync(deleteMgrId); setDeleteMgrId(null); }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
