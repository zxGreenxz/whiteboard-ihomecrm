// =============================================
// TeamsTab — Quản lý Đội ngũ trong trang Phân quyền nhân viên.
//
// Chủ tạo nhiều đội, thêm/bớt thành viên (nhân viên của mình + chính mình).
// Thành viên cùng đội sẽ thấy tên nhau (qua RLS profiles_select_same_team) →
// chọn nhau được khi "Bàn giao tiền mặt" ở /thu-tien. Đội này không thấy đội kia.
// =============================================

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

import { useTeams, useSaveTeam, useDeleteTeam } from "@/hooks/useTeams";
import { useStaffUsers } from "@/hooks/useStaffUsers";
import { useAuth } from "@/hooks/useAuth";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";

type TeamFormState = {
  id?: string;
  name: string;
  description: string;
  memberIds: string[];
};

const emptyForm = (): TeamFormState => ({ name: "", description: "", memberIds: [] });

export function TeamsTab() {
  const { data: teams, isLoading } = useTeams();
  const { data: staffUsers = [] } = useStaffUsers();
  const { data: currentUser } = useAuth();
  const { data: myPerms } = useMyPermissions();
  const canCreate = canUse(myPerms, "users", "create");
  const canEdit = canUse(myPerms, "users", "edit");
  const canDelete = canUse(myPerms, "users", "delete");

  const saveTeam = useSaveTeam();
  const deleteTeam = useDeleteTeam();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<TeamFormState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isEdit = !!form?.id;
  const myId = currentUser?.id;

  // Ứng viên = người mình quản lý (nhân viên) + chính mình. Tên mình kèm nhãn.
  const candidates = useMemo(
    () =>
      [...staffUsers]
        .filter((u) => u.is_active !== false)
        .sort((a, b) => (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "")),
    [staffUsers],
  );

  const openCreate = () => {
    setForm(emptyForm());
    setSheetOpen(true);
  };

  const openEdit = (t: NonNullable<typeof teams>[number]) => {
    setForm({
      id: t.id,
      name: t.name,
      description: t.description || "",
      memberIds: t.members.map((m) => m.member_id),
    });
    setSheetOpen(true);
  };

  const toggleMember = (id: string) =>
    setForm((f) =>
      f
        ? {
            ...f,
            memberIds: f.memberIds.includes(id)
              ? f.memberIds.filter((x) => x !== id)
              : [...f.memberIds, id],
          }
        : f,
    );

  const handleSave = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast.error("Nhập tên đội");
      return;
    }
    if (form.memberIds.length < 2) {
      toast.error("Đội cần ít nhất 2 thành viên để bàn giao cho nhau");
      return;
    }
    try {
      await saveTeam.mutateAsync(form);
      toast.success(isEdit ? "Đã lưu đội" : "Đã tạo đội");
      setSheetOpen(false);
      setForm(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteTeam.mutateAsync(deletingId);
      toast.success("Đã xoá đội");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setDeletingId(null);
  };

  const memberLabel = (m: { member_id: string; full_name: string | null; email: string | null }) =>
    (m.full_name || m.email || "—") + (m.member_id === myId ? " (bạn)" : "");

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const teamList = teams || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Đội ngũ ({teamList.length})</h3>
          <p className="text-xs text-muted-foreground">
            Thành viên cùng đội thấy tên nhau và bàn giao tiền cho nhau được. Đội khác nhau không thấy nhau.
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreate} className="bg-green-600 hover:bg-green-700 text-white">
            <Plus className="h-4 w-4 mr-1.5" />
            Tạo đội
          </Button>
        )}
      </div>

      {teamList.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <UsersRound className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              Chưa có đội nào. Bấm <strong>Tạo đội</strong> để gom nhân viên thành đội bàn giao tiền.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {teamList.map((t) => (
            <Card key={t.id} className="border-l-4 border-l-indigo-500">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 rounded-full flex items-center justify-center flex-shrink-0 bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                    <UsersRound className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-semibold text-sm">{t.name}</h4>
                        {t.description && (
                          <p className="text-xs text-muted-foreground truncate">{t.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {canEdit && (
                          <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                            <Pencil className="h-3.5 w-3.5 mr-1" />
                            Sửa
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setDeletingId(t.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      <Badge variant="secondary" className="text-xs h-5">
                        {t.members.length} thành viên
                      </Badge>
                      {t.members.map((m) => (
                        <Badge key={m.member_id} variant="outline" className="text-xs h-5 font-normal">
                          {memberLabel(m)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit sheet */}
      <Sheet open={sheetOpen} onOpenChange={(o) => !o && (setSheetOpen(false), setForm(null))}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{isEdit ? "Sửa đội" : "Tạo đội mới"}</SheetTitle>
            <SheetDescription>
              Đặt tên đội và chọn thành viên. Thành viên trong cùng đội sẽ thấy tên nhau để bàn giao tiền.
            </SheetDescription>
          </SheetHeader>

          {form && (
            <div className="py-4 space-y-4">
              <div className="space-y-1.5">
                <Label>Tên đội *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="VD: Đội thu tiền khu A"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Mô tả</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="(không bắt buộc)"
                />
              </div>
              <div className="space-y-2">
                <Label>Thành viên ({form.memberIds.length})</Label>
                <p className="text-xs text-muted-foreground">
                  Tick người vào đội. Nhớ thêm cả người sẽ <strong>nhận</strong> tiền (vd kế toán/chủ) để nhân viên bàn giao được.
                </p>
                <div className="rounded-md border divide-y max-h-[50vh] overflow-y-auto">
                  {candidates.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-3">Chưa có nhân viên nào.</p>
                  ) : (
                    candidates.map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={form.memberIds.includes(u.id)}
                          onCheckedChange={() => toggleMember(u.id)}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {(u.full_name || u.email || "—") + (u.id === myId ? " (bạn)" : "")}
                          </div>
                          {u.email && (
                            <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                          )}
                        </div>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <SheetFooter className="flex-row gap-2 justify-between sm:justify-between border-t pt-4">
            <Button variant="outline" onClick={() => (setSheetOpen(false), setForm(null))}>
              Hủy
            </Button>
            <Button
              onClick={handleSave}
              disabled={!form?.name.trim() || (form?.memberIds.length || 0) < 2 || saveTeam.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {isEdit ? "Lưu thay đổi" : "Tạo đội"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá đội?</AlertDialogTitle>
            <AlertDialogDescription>
              Đội sẽ bị xoá và thành viên không còn thấy nhau qua đội này nữa (không ảnh hưởng tài khoản nhân viên).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default TeamsTab;
