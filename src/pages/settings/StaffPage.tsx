// Trang Phân quyền nhân viên — refactor 2026-05-28
//
// Cấu trúc mới (per docs/DATABASE_SCHEMA.md mục 10):
//   Tab "Mẫu phân quyền" — 4 system templates (Super Admin / Quản Lý Tòa /
//       Partner / Viewer) + custom templates user tự tạo. Mỗi template chỉ
//       là cài đặt nhanh — Apply để copy vào staff_assignments.permissions.
//   Tab "Nhân viên" — list staff card, mỗi card có badge mẫu + phạm vi toà +
//       diff vs mẫu. Edit dialog có 3 bước: ① quick-apply mẫu, ② phạm vi
//       toà, ③ tinh chỉnh từng quyền qua <PermissionMatrix>.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Eye,
  Handshake,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  UserPlus,
  Users,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import {
  useRoles,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
} from "@/hooks/useRoles";
import {
  useStaffAssignments,
  useProvisionStaff,
  useUpdateStaffMember,
  useRemoveStaffMember,
  useUpdateStaffPermissions,
} from "@/hooks/useStaffAssignments";
import { useBuildings } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";
import {
  groupBuildingsByArea,
  summarizeSelection,
  type BuildingLite,
  type AreaLite,
} from "@/lib/buildingGroups";
import { AreaMultiSelect } from "@/components/areas/AreaMultiSelect";
import { PermissionMatrix } from "@/components/staff/PermissionMatrix";
import {
  ALL_MODULES,
  buildEmptyPermissions,
  countTrueActions,
  diffPermissions,
  isSuperAdminPerms,
  parsePermissions,
  type PermissionsMap,
} from "@/lib/permissions";
import type { Json } from "@/integrations/supabase/types";

// =============================================================
// Template metadata — icon + màu cho 4 system templates
// =============================================================

interface TemplateMeta {
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind classes cho border-l + bg accent */
  accent: string;
  /** Class cho icon container */
  iconBg: string;
}

const TEMPLATE_META: Record<string, TemplateMeta> = {
  "Super Admin": { icon: ShieldCheck, accent: "border-l-rose-500",   iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400" },
  "Quản Lý Tòa": { icon: Building2,   accent: "border-l-blue-500",   iconBg: "bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400" },
  "Partner":     { icon: Handshake,   accent: "border-l-emerald-500", iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" },
  "Viewer":      { icon: Eye,          accent: "border-l-slate-400",  iconBg: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
};

const DEFAULT_META: TemplateMeta = { icon: Shield, accent: "border-l-purple-500", iconBg: "bg-purple-100 text-purple-600 dark:bg-purple-950 dark:text-purple-400" };

const metaForRole = (name: string): TemplateMeta => TEMPLATE_META[name] ?? DEFAULT_META;

// =============================================================
// Tab 1 — Mẫu phân quyền (Templates)
// =============================================================

function TemplatesTab() {
  const { data: roles, isLoading } = useRoles();
  const { data: assignments } = useStaffAssignments();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  const [viewSheet, setViewSheet] = useState<{ role: any; editable: boolean } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; permissions: PermissionsMap } | null>(null);

  // Đếm số staff đang dùng mỗi role
  const staffCountByRole = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of assignments || []) {
      if (!map.has(a.role_id)) map.set(a.role_id, new Set());
      map.get(a.role_id)!.add(a.staff_id);
    }
    return map;
  }, [assignments]);

  const systemRoles = (roles || []).filter((r: any) => r.is_system);
  const customRoles = (roles || []).filter((r: any) => !r.is_system);

  const openView = (role: any) => setViewSheet({ role, editable: !role.is_system });
  const openCreate = () => {
    setDraft({ name: "", description: "", permissions: buildEmptyPermissions() });
    setCreateDialogOpen(true);
  };
  const openEdit = (role: any) => {
    setDraft({ name: role.name, description: role.description || "", permissions: parsePermissions(role.permissions) });
    setViewSheet({ role, editable: true });
  };
  const openCloneAsNew = (role: any) => {
    setDraft({
      name: `${role.name} (Bản sao)`,
      description: role.description || "",
      permissions: parsePermissions(role.permissions),
    });
    setCreateDialogOpen(true);
  };

  const handleSaveDraft = async (id?: string) => {
    if (!draft || !draft.name.trim()) {
      toast.error("Tên mẫu không được để trống");
      return;
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      permissions: draft.permissions as unknown as Json,
    };
    if (id) {
      await updateRole.mutateAsync({ id, updates: payload });
    } else {
      await createRole.mutateAsync(payload);
    }
    setCreateDialogOpen(false);
    setDraft(null);
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await deleteRole.mutateAsync(deleteId);
    setDeleteId(null);
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[1,2,3,4].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* System templates 4 cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Mẫu hệ thống</h3>
            <p className="text-xs text-muted-foreground">4 mẫu chuẩn — không sửa được, nhân bản để tạo mẫu riêng.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {systemRoles.map((r: any) => {
            const meta = metaForRole(r.name);
            const Icon = meta.icon;
            const count = staffCountByRole.get(r.id)?.size ?? 0;
            const isSuper = isSuperAdminPerms(parsePermissions(r.permissions));
            const permCount = isSuper ? "Toàn quyền" : `${countTrueActions(parsePermissions(r.permissions))} quyền`;
            return (
              <Card
                key={r.id}
                className={cn(
                  "relative border-l-4 transition-shadow hover:shadow-md cursor-pointer group",
                  meta.accent,
                )}
                onClick={() => openView(r)}
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className={cn("rounded-lg p-2", meta.iconBg)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <Badge variant="secondary" className="text-xs h-5">Hệ thống</Badge>
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm">{r.name}</h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 min-h-[2.5rem]">
                      {r.description || "—"}
                    </p>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{count}</span> nhân viên
                    </div>
                    <span className="text-xs text-muted-foreground">{permCount}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Custom templates */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Mẫu tuỳ chỉnh ({customRoles.length})</h3>
            <p className="text-xs text-muted-foreground">Mẫu riêng cho team của bạn.</p>
          </div>
          <Button onClick={openCreate} size="sm" className="bg-green-600 hover:bg-green-700 text-white">
            <Plus className="h-4 w-4 mr-1.5" />
            Tạo mẫu mới
          </Button>
        </div>
        {customRoles.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                Chưa có mẫu tuỳ chỉnh. Bấm <strong>Tạo mẫu mới</strong> để tạo mẫu riêng cho team.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {customRoles.map((r: any) => {
              const meta = metaForRole(r.name);
              const Icon = meta.icon;
              const count = staffCountByRole.get(r.id)?.size ?? 0;
              const permCount = countTrueActions(parsePermissions(r.permissions));
              return (
                <Card
                  key={r.id}
                  className={cn("relative border-l-4 group", meta.accent)}
                >
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className={cn("rounded-lg p-2", meta.iconBg)}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(r)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setDeleteId(r.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div>
                      <h4 className="font-semibold text-sm">{r.name}</h4>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2 min-h-[2.5rem]">
                        {r.description || "—"}
                      </p>
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{count}</span> nhân viên
                      </div>
                      <span className="text-xs text-muted-foreground">{permCount} quyền</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* View / Edit sheet */}
      <Sheet open={!!viewSheet} onOpenChange={(o) => !o && (setViewSheet(null), setDraft(null))}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          {viewSheet && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {(() => {
                    const Icon = metaForRole(viewSheet.role.name).icon;
                    return <Icon className="h-5 w-5" />;
                  })()}
                  {draft?.name || viewSheet.role.name}
                </SheetTitle>
                <SheetDescription>{viewSheet.role.description}</SheetDescription>
              </SheetHeader>

              <div className="py-4 space-y-4">
                {viewSheet.editable && draft && (
                  <>
                    <div className="space-y-2">
                      <Label>Tên mẫu *</Label>
                      <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Mô tả</Label>
                      <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </div>
                  </>
                )}

                <PermissionMatrix
                  value={draft?.permissions ?? parsePermissions(viewSheet.role.permissions)}
                  onChange={(p) => draft && setDraft({ ...draft, permissions: p })}
                  disabled={!viewSheet.editable}
                />
              </div>

              <SheetFooter className="flex-row gap-2 justify-between sm:justify-between">
                {viewSheet.role.is_system ? (
                  <>
                    <p className="text-xs text-muted-foreground">Mẫu hệ thống — chỉ xem.</p>
                    <Button variant="outline" onClick={() => openCloneAsNew(viewSheet.role)}>
                      <Sparkles className="h-4 w-4 mr-1.5" />
                      Tạo bản sao
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => (setViewSheet(null), setDraft(null))}>
                      Đóng
                    </Button>
                    <Button
                      onClick={() => handleSaveDraft(viewSheet.role.id)}
                      className="bg-green-600 hover:bg-green-700 text-white"
                    >
                      Lưu thay đổi
                    </Button>
                  </>
                )}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(o) => !o && (setCreateDialogOpen(false), setDraft(null))}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Tạo mẫu phân quyền mới</DialogTitle>
            <DialogDescription>
              Đặt tên + tick các quyền — sau đó áp cho nhân viên trong tab "Nhân viên".
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Tên mẫu *</Label>
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="VD: Lễ tân toà A" />
                </div>
                <div className="space-y-1.5">
                  <Label>Mô tả</Label>
                  <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="(không bắt buộc)" />
                </div>
              </div>
              <PermissionMatrix
                value={draft.permissions}
                onChange={(p) => setDraft({ ...draft, permissions: p })}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => (setCreateDialogOpen(false), setDraft(null))}>
              Hủy
            </Button>
            <Button
              onClick={() => handleSaveDraft()}
              disabled={!draft?.name.trim() || createRole.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              Tạo mẫu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá mẫu phân quyền?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động không thể hoàn tác. Nếu có nhân viên đang dùng mẫu này, hệ thống sẽ từ chối.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Xoá</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// =============================================================
// Tab 2 — Nhân viên (Staff)
// =============================================================

type StaffMember = {
  staff_id: string;
  profile: any;
  role_id: string;
  role: any;
  current_permissions: PermissionsMap | null;
  building_ids: string[];
  buildings: { id: string; name: string }[];
  /** Khu vực gán LIVE (staff_assignments.area_id) — phạm vi tự cập nhật theo khu */
  area_ids: string[];
  areas: { id: string; name: string }[];
  has_global: boolean;
};

function groupByStaff(assignments: any[]): StaffMember[] {
  const map = new Map<string, StaffMember>();
  for (const a of assignments || []) {
    if (!map.has(a.staff_id)) {
      map.set(a.staff_id, {
        staff_id: a.staff_id,
        profile: a.profile || null,
        role_id: a.role_id,
        role: a.role,
        current_permissions: a.permissions ? parsePermissions(a.permissions) : null,
        building_ids: [],
        buildings: [],
        area_ids: [],
        areas: [],
        has_global: false,
      });
    }
    const m = map.get(a.staff_id)!;
    if (a.area_id) {
      m.area_ids.push(a.area_id);
      if (a.area) m.areas.push({ id: a.area.id, name: a.area.name });
    } else if (a.building_id) {
      m.building_ids.push(a.building_id);
      if (a.building) m.buildings.push({ id: a.building.id, name: a.building.name });
    } else {
      m.has_global = true;
    }
  }
  return Array.from(map.values());
}

type StaffFormState = {
  staff_id?: string;
  username: string;
  full_name: string;
  phone: string;
  email: string;
  role_id: string;
  job_title: string;
  is_active: boolean;
  all_buildings: boolean;
  building_ids: string[];
  /** Khu vực gán LIVE — toà thêm vào khu sau này tự thuộc phạm vi */
  area_ids: string[];
  /** Permissions tinh chỉnh — null = dùng default từ role (chưa override) */
  permissions: PermissionsMap;
  /** Password (chỉ dùng khi tạo mới) */
  password: string;
  confirmPassword: string;
};

const emptyForm = (): StaffFormState => ({
  username: "",
  full_name: "",
  phone: "",
  email: "",
  role_id: "",
  job_title: "",
  is_active: true,
  all_buildings: true,
  building_ids: [],
  area_ids: [],
  permissions: buildEmptyPermissions(),
  password: "",
  confirmPassword: "",
});

function StaffTab() {
  const { data: assignments, isLoading: loadingA } = useStaffAssignments();
  const { data: roles, isLoading: loadingR } = useRoles();
  const { data: buildings, isLoading: loadingB } = useBuildings();
  const { data: areas } = useAreas();
  const provisionStaff = useProvisionStaff();
  const updateStaff = useUpdateStaffMember();
  const removeStaff = useRemoveStaffMember();
  const updatePerms = useUpdateStaffPermissions();

  const [searchTerm, setSearchTerm] = useState("");
  const [filterRoleId, setFilterRoleId] = useState<string>("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<StaffFormState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isLoading = loadingA || loadingR || loadingB;
  const isEdit = !!form?.staff_id;

  const staffMembers = useMemo(() => groupByStaff(assignments || []), [assignments]);

  // Nhóm toà theo khu vực cho phần chọn toà lẻ (label tóm tắt).
  const staffFormGroups = useMemo(() => {
    const blds: BuildingLite[] = ((buildings || []) as any[]).map((b) => ({
      id: b.id,
      name: b.name,
      area_ids: b.area_ids ?? [],
    }));
    const ars: AreaLite[] = ((areas || []) as any[]).map((a) => ({
      id: a.id,
      name: a.name,
    }));
    return groupBuildingsByArea(blds, ars);
  }, [buildings, areas]);

  const filtered = useMemo(() => {
    let list = staffMembers;
    if (filterRoleId) list = list.filter((m) => m.role_id === filterRoleId);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      list = list.filter((m) => {
        const p = m.profile || {};
        const name = (p.full_name || "").toLowerCase();
        const phone = (p.phone || "").toLowerCase();
        const email = (p.email || "").toLowerCase();
        const role = (m.role?.name || "").toLowerCase();
        const bldgs = m.buildings.map((b) => b.name.toLowerCase()).join(" ");
        return name.includes(s) || phone.includes(s) || email.includes(s) || role.includes(s) || bldgs.includes(s);
      });
    }
    return list;
  }, [staffMembers, filterRoleId, searchTerm]);

  const openCreate = () => {
    setForm(emptyForm());
    setSheetOpen(true);
  };

  const openEdit = (m: StaffMember) => {
    const p = m.profile || {};
    setForm({
      staff_id: m.staff_id,
      username: "",
      full_name: p.full_name || "",
      phone: p.phone || "",
      email: p.email || "",
      role_id: m.role_id || "",
      job_title: p.job_title || "",
      is_active: p.is_active ?? true,
      all_buildings: m.has_global,
      building_ids: m.building_ids,
      area_ids: m.area_ids,
      permissions: m.current_permissions ?? parsePermissions(m.role?.permissions),
      password: "",
      confirmPassword: "",
    });
    setSheetOpen(true);
  };

  // Khi user click "Áp mẫu" trong form → copy role.permissions vào draft
  const applyTemplateToDraft = (roleId: string) => {
    if (!form) return;
    const role = (roles || []).find((r: any) => r.id === roleId);
    if (!role) return;
    setForm({
      ...form,
      role_id: roleId,
      permissions: parsePermissions(role.permissions),
    });
  };

  const phoneIsValid = (p: string) => p === "" || /^[0-9]{10,11}$/.test(p);
  const emailIsValid = (e: string) => e === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleSave = async () => {
    if (!form) return;
    if (!form.role_id) {
      toast.error("Chọn mẫu phân quyền");
      return;
    }
    if (
      !form.all_buildings &&
      form.building_ids.length === 0 &&
      form.area_ids.length === 0
    ) {
      toast.error("Chọn ít nhất 1 khu vực hoặc toà nhà");
      return;
    }
    if (!phoneIsValid(form.phone.trim())) {
      toast.error("Số điện thoại 10-11 chữ số hoặc để trống");
      return;
    }
    if (!emailIsValid(form.email.trim())) {
      toast.error("Email không đúng định dạng");
      return;
    }

    if (isEdit && form.staff_id) {
      // Sửa: update member info + permissions (nếu khác với role.permissions)
      await updateStaff.mutateAsync({
        staff_id: form.staff_id,
        role_id: form.role_id,
        building_ids: form.all_buildings ? null : form.building_ids,
        area_ids: form.all_buildings ? null : form.area_ids,
        profile_patch: {
          full_name: form.full_name.trim() || undefined,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          job_title: form.job_title.trim() || null,
          is_active: form.is_active,
        },
      });
      // Sau khi update role, permissions đã re-snapshot từ role.permissions.
      // Nếu user tinh chỉnh thêm → save lại snapshot mới.
      const roleObj = (roles || []).find((r: any) => r.id === form.role_id);
      const rolePerms = parsePermissions(roleObj?.permissions);
      const draftDiffs = diffPermissions(rolePerms, form.permissions);
      if (draftDiffs.length > 0) {
        await updatePerms.mutateAsync({ staffId: form.staff_id, permissions: form.permissions });
      }
    } else {
      // Tạo mới
      if (!form.username.trim()) {
        toast.error("Tên đăng nhập bắt buộc");
        return;
      }
      if (form.password.length < 6) {
        toast.error("Mật khẩu tối thiểu 6 ký tự");
        return;
      }
      if (form.password !== form.confirmPassword) {
        toast.error("Mật khẩu xác nhận không khớp");
        return;
      }
      const result = await provisionStaff.mutateAsync({
        username: form.username.trim(),
        password: form.password,
        role_id: form.role_id,
        building_ids: form.all_buildings ? null : form.building_ids,
        area_ids: form.all_buildings ? null : form.area_ids,
        full_name: form.full_name.trim() || form.username.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        job_title: form.job_title.trim() || undefined,
        is_active: form.is_active,
      });
      // Nếu user đã tinh chỉnh permissions khác với template gốc → save override
      const roleObj = (roles || []).find((r: any) => r.id === form.role_id);
      const rolePerms = parsePermissions(roleObj?.permissions);
      const draftDiffs = diffPermissions(rolePerms, form.permissions);
      if (draftDiffs.length > 0 && result && result[0]?.staff_id) {
        await updatePerms.mutateAsync({ staffId: result[0].staff_id, permissions: form.permissions });
      }
    }

    setSheetOpen(false);
    setForm(null);
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    await removeStaff.mutateAsync(deletingId);
    setDeletingId(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
    );
  }

  const selectedRole = form ? (roles || []).find((r: any) => r.id === form.role_id) : null;
  const selectedRolePerms = parsePermissions(selectedRole?.permissions);
  const formDiffCount = form ? diffPermissions(selectedRolePerms, form.permissions).length : 0;

  return (
    <div className="space-y-4">
      {/* Header: search + filter + add button */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
        <div className="flex flex-col sm:flex-row gap-2 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo tên / SĐT / email / toà…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <select
            value={filterRoleId}
            onChange={(e) => setFilterRoleId(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Tất cả mẫu</option>
            {(roles || []).map((r: any) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <Button onClick={openCreate} className="bg-green-600 hover:bg-green-700 text-white">
          <UserPlus className="h-4 w-4 mr-1.5" />
          Thêm nhân viên
        </Button>
      </div>

      {/* Staff list */}
      {filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <Users className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {staffMembers.length === 0 ? "Chưa có nhân viên nào." : "Không tìm thấy nhân viên phù hợp."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((m) => {
            const meta = metaForRole(m.role?.name || "");
            const Icon = meta.icon;
            const profile = m.profile || {};
            const initials = (profile.full_name || profile.email || "?").split(/\s+/).map((s: string) => s[0]).slice(-2).join("").toUpperCase();

            // Diff vs template
            const isSuper = isSuperAdminPerms(m.current_permissions);
            const diffs = m.current_permissions && !isSuper
              ? diffPermissions(parsePermissions(m.role?.permissions), m.current_permissions)
              : [];
            const diffCount = diffs.length;
            const scopeLabel = m.has_global
              ? "Tất cả toà"
              : [
                  m.areas.length > 0 &&
                    `${m.areas.map((a) => a.name).join(", ")} (live)`,
                  m.buildings.length > 0 &&
                    `${m.buildings.length} toà lẻ (${m.buildings.slice(0, 3).map((b) => b.name).join(", ")}${m.buildings.length > 3 ? "…" : ""})`,
                ]
                  .filter(Boolean)
                  .join(" + ") || "—";

            return (
              <Card key={m.staff_id} className={cn("border-l-4 group", meta.accent)}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className={cn("h-11 w-11 rounded-full flex items-center justify-center flex-shrink-0 font-semibold text-sm", meta.iconBg)}>
                      {initials}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h4 className="font-semibold text-sm flex items-center gap-1.5">
                            {profile.full_name || "—"}
                            {!profile.is_active && (
                              <Badge variant="outline" className="h-4 text-xs">Khoá</Badge>
                            )}
                          </h4>
                          <p className="text-xs text-muted-foreground truncate">
                            {profile.email || profile.phone || "—"}
                            {profile.job_title && <span> · {profile.job_title}</span>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button variant="outline" size="sm" onClick={() => openEdit(m)}>
                            <Pencil className="h-3.5 w-3.5 mr-1" />
                            Sửa quyền
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setDeletingId(m.staff_id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-2 flex-wrap text-xs">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Icon className="h-3.5 w-3.5" />
                          <span className="font-medium text-foreground">{m.role?.name || "—"}</span>
                        </span>
                        <span className="text-muted-foreground/40">•</span>
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Building2 className="h-3.5 w-3.5" />
                          {scopeLabel}
                        </span>
                        <span className="text-muted-foreground/40">•</span>
                        {isSuper ? (
                          <span className="inline-flex items-center gap-1 text-rose-600 font-medium">
                            <ShieldCheck className="h-3.5 w-3.5" /> Bypass toàn quyền
                          </span>
                        ) : diffCount === 0 ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Khớp mẫu
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                            <AlertTriangle className="h-3.5 w-3.5" /> {diffCount} thay đổi so với mẫu
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={(o) => !o && (setSheetOpen(false), setForm(null))}>
        <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{isEdit ? "Sửa phân quyền nhân viên" : "Thêm nhân viên mới"}</SheetTitle>
            <SheetDescription>
              {isEdit
                ? "Cập nhật thông tin, áp mẫu phân quyền, và tinh chỉnh từng quyền cụ thể."
                : "Tạo tài khoản nhân viên + áp mẫu phân quyền + chỉ định phạm vi toà nhà."}
            </SheetDescription>
          </SheetHeader>

          {form && (
            <div className="py-4 space-y-6">
              {/* ===== Section: thông tin nhân viên ===== */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-md bg-muted h-7 w-7 flex items-center justify-center text-xs font-semibold">1</div>
                  <h3 className="font-semibold text-sm">Thông tin nhân viên</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {!isEdit && (
                    <>
                      <div className="space-y-1.5">
                        <Label>Tên đăng nhập *</Label>
                        <Input
                          value={form.username}
                          onChange={(e) => setForm({ ...form, username: e.target.value })}
                          placeholder="VD: joey hoặc joey-nathan"
                        />
                      </div>
                      <div /> {/* spacer */}
                      <div className="space-y-1.5">
                        <Label>Mật khẩu *</Label>
                        <Input
                          type="password"
                          value={form.password}
                          onChange={(e) => setForm({ ...form, password: e.target.value })}
                          placeholder="≥ 6 ký tự"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Xác nhận mật khẩu *</Label>
                        <Input
                          type="password"
                          value={form.confirmPassword}
                          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                          placeholder="Nhập lại mật khẩu"
                        />
                      </div>
                    </>
                  )}
                  <div className="space-y-1.5">
                    <Label>Họ tên</Label>
                    <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Chức danh</Label>
                    <Input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="VD: Quản lý toà A" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SĐT</Label>
                    <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="10-11 chữ số" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Email</Label>
                    <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <Label htmlFor="is-active" className="cursor-pointer">Trạng thái hoạt động</Label>
                  <Switch
                    id="is-active"
                    checked={form.is_active}
                    onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                  />
                </div>
              </section>

              <Separator />

              {/* ===== Section: Cài đặt nhanh mẫu ===== */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-md bg-muted h-7 w-7 flex items-center justify-center text-xs font-semibold">2</div>
                  <h3 className="font-semibold text-sm">Cài đặt nhanh — chọn mẫu</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  Bấm 1 mẫu để khởi tạo nhanh 35 quyền. Sau đó có thể tinh chỉnh thêm/bớt từng quyền ở bước 4.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(roles || []).map((r: any) => {
                    const meta = metaForRole(r.name);
                    const Icon = meta.icon;
                    const active = form.role_id === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => applyTemplateToDraft(r.id)}
                        className={cn(
                          "rounded-lg border-2 p-3 text-left transition-all hover:shadow-sm",
                          active ? "border-green-500 bg-green-50/50 dark:bg-green-950/20 ring-1 ring-green-500/20" : "border-border hover:border-foreground/20",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className={cn("rounded-md p-1.5", meta.iconBg)}>
                            <Icon className="h-4 w-4" />
                          </div>
                          {active && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        </div>
                        <div className="mt-2 text-sm font-medium leading-tight">{r.name}</div>
                        {r.is_system && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">Hệ thống</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <Separator />

              {/* ===== Section: Phạm vi toà nhà ===== */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-md bg-muted h-7 w-7 flex items-center justify-center text-xs font-semibold">3</div>
                  <h3 className="font-semibold text-sm">Phạm vi toà nhà</h3>
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={form.all_buildings}
                    onCheckedChange={(v) => setForm({ ...form, all_buildings: v === true })}
                  />
                  <span className="text-sm">Áp dụng cho <strong>tất cả toà nhà</strong></span>
                </label>
                {!form.all_buildings && (
                  <div className="space-y-3 pl-6">
                    {/* A. Khu vực = LIVE: lưu area_id trong staff_assignments,
                        DB bung ra toà qua area_buildings lúc query — thêm/bớt
                        toà trong khu là phạm vi nhân viên tự đổi theo. */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        Theo khu vực — tự cập nhật ({form.area_ids.length} khu)
                      </Label>
                      <AreaMultiSelect
                        value={form.area_ids}
                        onChange={(ids) => setForm({ ...form, area_ids: ids })}
                        placeholder="Chọn khu vực (phạm vi sống theo nhóm)..."
                      />
                      <p className="text-xs text-muted-foreground">
                        Toà thêm vào khu sau này <strong>TỰ ĐỘNG</strong> thuộc
                        phạm vi của nhân viên (bớt toà khỏi khu thì mất theo).
                      </p>
                    </div>
                    {/* B. Toà lẻ = SNAPSHOT: lưu cứng từng building_id. */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        Toà lẻ bổ sung — cố định ({form.building_ids.length} toà)
                      </Label>
                      <BuildingMultiSelect
                        value={form.building_ids}
                        onChange={(ids) => setForm({ ...form, building_ids: ids })}
                        placeholder="Chọn thêm toà lẻ ngoài các khu..."
                      />
                      {form.building_ids.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Đang chọn:{" "}
                          {summarizeSelection(form.building_ids, staffFormGroups)}
                        </p>
                      )}
                    </div>
                    {form.building_ids.length === 0 && form.area_ids.length === 0 && (
                      <p className="text-xs text-red-600">
                        Chọn ít nhất 1 khu vực hoặc toà nhà
                      </p>
                    )}
                  </div>
                )}
              </section>

              <Separator />

              {/* ===== Section: Permission matrix tinh chỉnh ===== */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-md bg-muted h-7 w-7 flex items-center justify-center text-xs font-semibold">4</div>
                  <h3 className="font-semibold text-sm">Tinh chỉnh từng quyền (tuỳ chọn)</h3>
                  {formDiffCount > 0 && (
                    <Badge variant="outline" className="ml-1 border-amber-500 text-amber-700 dark:text-amber-400">
                      {formDiffCount} thay đổi
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Bỏ tick hoặc thêm quyền so với mẫu gốc. Lưu sẽ tạo bản tinh chỉnh riêng cho nhân viên này.
                </p>
                <PermissionMatrix
                  value={form.permissions}
                  onChange={(p) => setForm({ ...form, permissions: p })}
                  baseline={form.role_id ? selectedRolePerms : null}
                />
              </section>
            </div>
          )}

          <SheetFooter className="flex-row gap-2 justify-between sm:justify-between border-t pt-4">
            <Button variant="outline" onClick={() => (setSheetOpen(false), setForm(null))}>
              Hủy
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !form?.role_id ||
                (!form?.all_buildings &&
                  (form?.building_ids?.length || 0) === 0 &&
                  (form?.area_ids?.length || 0) === 0) ||
                (!isEdit && (!form?.username?.trim() || !form?.password || form.password.length < 6 || form.password !== form.confirmPassword)) ||
                provisionStaff.isPending || updateStaff.isPending || updatePerms.isPending
              }
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {isEdit ? "Lưu thay đổi" : "Tạo nhân viên"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá nhân viên?</AlertDialogTitle>
            <AlertDialogDescription>
              Tài khoản auth + mọi phân quyền của nhân viên sẽ bị xoá vĩnh viễn. Hành động không thể hoàn tác.
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

// =============================================================
// Main page
// =============================================================

const StaffPage = () => {
  const [activeTab, setActiveTab] = useState("staff");
  return (
    <MainLayout>
      <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-950 flex items-center justify-center">
            <UserCog className="h-5 w-5 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Phân quyền nhân viên</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý mẫu phân quyền + cài quyền chi tiết cho từng nhân viên.
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="staff" className="flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              Nhân viên
            </TabsTrigger>
            <TabsTrigger value="templates" className="flex items-center gap-1.5">
              <Shield className="h-4 w-4" />
              Mẫu phân quyền
            </TabsTrigger>
          </TabsList>
          <TabsContent value="staff"><StaffTab /></TabsContent>
          <TabsContent value="templates"><TemplatesTab /></TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};

export default StaffPage;
