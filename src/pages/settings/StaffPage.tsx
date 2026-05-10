import { useState } from "react";
import { toast } from "sonner";
import {
  UserCog,
  Plus,
  Pencil,
  Trash2,
  Shield,
  Users,
  Search,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  type ProvisionStaffInput,
} from "@/hooks/useStaffAssignments";
import { useBuildings } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import type { Json } from "@/integrations/supabase/types";

// Permission modules — full Resident parity (35 nhóm)
const PERMISSION_MODULES = [
  { key: "dashboard",        label: "Bảng tin" },
  { key: "notifications",    label: "Thông báo" },
  { key: "messages",         label: "Nhắn tin" },
  { key: "tasks",            label: "Công việc" },
  { key: "buildings",        label: "Căn hộ (toà nhà)" },
  { key: "rooms",            label: "Phòng" },
  { key: "beds",             label: "Giường" },
  { key: "services",         label: "Phí dịch vụ" },
  { key: "service_quotas",   label: "Định mức" },
  { key: "meters",           label: "Công tơ" },
  { key: "meter_readings",   label: "Chốt công tơ" },
  { key: "deposits",         label: "Cọc giữ chỗ" },
  { key: "contracts",        label: "Hợp đồng" },
  { key: "customers",        label: "Cư dân" },
  { key: "vehicles",         label: "Phương tiện" },
  { key: "cashbooks",        label: "Sổ quỹ" },
  { key: "invoices",         label: "Hoá đơn" },
  { key: "income_expenses",  label: "Thu chi" },
  { key: "excess_amounts",   label: "Tiền thừa" },
  { key: "suppliers",        label: "Nhà cung cấp" },
  { key: "warehouses",       label: "Kho" },
  { key: "asset_types",      label: "Loại tài sản" },
  { key: "assets",           label: "Tài sản" },
  { key: "reports_real_estate", label: "Báo cáo BĐS" },
  { key: "reports_finance",  label: "Báo cáo tài chính" },
  { key: "reports_tasks",    label: "Báo cáo công việc" },
  { key: "roles",            label: "Loại tài khoản" },
  { key: "users",            label: "Người dùng" },
  { key: "subscription",     label: "Gói cước" },
  { key: "settings",         label: "Cài đặt" },
  { key: "areas",            label: "Khu vực" },
  { key: "hotline",          label: "Cài đặt Hotline" },
  { key: "iot_devices",      label: "Thiết bị IOT" },
  { key: "building_layout",  label: "Sơ đồ toà nhà" },
  { key: "leads",            label: "Khách hẹn" },
  { key: "auto_debt",        label: "Gạch nợ tự động" },
  { key: "templates",        label: "Biểu mẫu" },
  { key: "zalo_oa",          label: "Zalo OA" },
  { key: "task_types",       label: "Loại công việc" },
  { key: "categories",       label: "Danh mục khác" },
  { key: "e_invoices",       label: "Hoá đơn điện tử" },
] as const;

// 2 nhóm quyền: "Xem" (view) và "Quản lý" (gộp create + edit + delete).
// Vẫn lưu thành 4 trường trong roles.permissions để DB RLS dùng staff_can()
// kiểm tra từng action — chỉ UI gộp lại cho gọn.
const PERMISSION_BUCKETS = [
  { key: "view",   label: "Xem",      writes: ["view"] as const },
  { key: "manage", label: "Quản lý",  writes: ["create", "edit", "delete"] as const },
] as const;

type PermissionsMap = Record<string, Record<string, boolean>>;

const isBucketChecked = (
  perms: PermissionsMap,
  moduleKey: string,
  bucketKey: typeof PERMISSION_BUCKETS[number]["key"],
): boolean => {
  const bucket = PERMISSION_BUCKETS.find((b) => b.key === bucketKey);
  if (!bucket) return false;
  const mp = perms[moduleKey] || {};
  return bucket.writes.every((w) => !!mp[w]);
};

function parsePermissions(permissions: Json): PermissionsMap {
  if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
    return permissions as unknown as PermissionsMap;
  }
  return {};
}

function buildDefaultPermissions(): PermissionsMap {
  const perms: PermissionsMap = {};
  for (const mod of PERMISSION_MODULES) {
    perms[mod.key] = { view: false, create: false, edit: false, delete: false };
  }
  return perms;
}

// ==================== ROLES TAB ====================

function RolesTab() {
  const { data: roles, isLoading } = useRoles();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<{
    id?: string;
    name: string;
    description: string;
    permissions: PermissionsMap;
  } | null>(null);
  const [deletingRoleId, setDeletingRoleId] = useState<string | null>(null);

  const filteredRoles = (roles || []).filter((r) =>
    !searchTerm || r.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const openCreateDialog = () => {
    setEditingRole({
      name: "",
      description: "",
      permissions: buildDefaultPermissions(),
    });
    setDialogOpen(true);
  };

  const openEditDialog = (role: (typeof roles extends (infer T)[] | undefined ? T : never)) => {
    if (!role) return;
    setEditingRole({
      id: role.id,
      name: role.name,
      description: role.description || "",
      permissions: parsePermissions(role.permissions),
    });
    setDialogOpen(true);
  };

  const handleSaveRole = async () => {
    if (!editingRole || !editingRole.name.trim()) return;

    const payload = {
      name: editingRole.name.trim(),
      description: editingRole.description.trim() || null,
      permissions: editingRole.permissions as unknown as Json,
    };

    if (editingRole.id) {
      await updateRole.mutateAsync({ id: editingRole.id, updates: payload });
    } else {
      await createRole.mutateAsync(payload);
    }
    setDialogOpen(false);
    setEditingRole(null);
  };

  const handleDeleteRole = async () => {
    if (!deletingRoleId) return;
    await deleteRole.mutateAsync(deletingRoleId);
    setDeleteDialogOpen(false);
    setDeletingRoleId(null);
  };

  const toggleBucket = (
    moduleKey: string,
    bucketKey: typeof PERMISSION_BUCKETS[number]["key"],
    next: boolean,
  ) => {
    if (!editingRole) return;
    const bucket = PERMISSION_BUCKETS.find((b) => b.key === bucketKey);
    if (!bucket) return;
    const mp = { ...(editingRole.permissions[moduleKey] || {}) };
    for (const w of bucket.writes) mp[w] = next;
    setEditingRole({
      ...editingRole,
      permissions: { ...editingRole.permissions, [moduleKey]: mp },
    });
  };

  const toggleAllModule = (moduleKey: string, checked: boolean) => {
    if (!editingRole) return;
    setEditingRole({
      ...editingRole,
      permissions: {
        ...editingRole.permissions,
        [moduleKey]: {
          view: checked,
          create: checked,
          edit: checked,
          delete: checked,
        },
      },
    });
  };

  const isModuleAllChecked = (moduleKey: string) => {
    if (!editingRole) return false;
    return PERMISSION_BUCKETS.every((b) =>
      isBucketChecked(editingRole.permissions, moduleKey, b.key),
    );
  };

  const countPermissions = (permissions: Json) => {
    const perms = parsePermissions(permissions);
    let count = 0;
    for (const mod of Object.values(perms)) {
      for (const val of Object.values(mod)) {
        if (val) count++;
      }
    }
    return count;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-muted-foreground">Đang tải...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm kiếm vai trò..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button onClick={openCreateDialog} className="bg-green-600 hover:bg-green-700">
          <Plus className="h-4 w-4 mr-2" />
          Thêm vai trò
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên vai trò</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead className="text-center">Số quyền</TableHead>
                <TableHead className="w-[100px]">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRoles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8">
                    <div className="flex flex-col items-center gap-2">
                      <Shield className="h-12 w-12 text-gray-300" />
                      <p className="text-muted-foreground">
                        {searchTerm
                          ? "Không tìm thấy vai trò nào"
                          : "Chưa có vai trò nào. Nhấn 'Thêm vai trò' để tạo mới."}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredRoles.map((role) => (
                  <TableRow key={role.id}>
                    <TableCell className="font-medium">{role.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {role.description || "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">
                        {countPermissions(role.permissions)} quyền
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={() => openEditDialog(role)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => {
                            setDeletingRoleId(role.id);
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Role Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingRole?.id ? "Cập nhật vai trò" : "Thêm vai trò mới"}
            </DialogTitle>
            <DialogDescription>
              Thiết lập tên, mô tả và phân quyền cho vai trò
            </DialogDescription>
          </DialogHeader>

          {editingRole && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="role-name">Tên vai trò *</Label>
                <Input
                  id="role-name"
                  placeholder="VD: Quản lý toà nhà"
                  value={editingRole.name}
                  onChange={(e) =>
                    setEditingRole({ ...editingRole, name: e.target.value })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="role-desc">Mô tả</Label>
                <Textarea
                  id="role-desc"
                  placeholder="Mô tả vai trò..."
                  value={editingRole.description}
                  onChange={(e) =>
                    setEditingRole({ ...editingRole, description: e.target.value })
                  }
                  rows={2}
                />
              </div>

              <div className="space-y-3">
                <Label>Phân quyền theo module</Label>
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[200px]">Module</TableHead>
                        <TableHead className="text-center w-[100px]">Tất cả</TableHead>
                        {PERMISSION_BUCKETS.map((b) => (
                          <TableHead key={b.key} className="text-center w-[120px]">
                            {b.label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {PERMISSION_MODULES.map((mod) => (
                        <TableRow key={mod.key}>
                          <TableCell className="font-medium">{mod.label}</TableCell>
                          <TableCell className="text-center">
                            <Checkbox
                              checked={isModuleAllChecked(mod.key)}
                              onCheckedChange={(checked) =>
                                toggleAllModule(mod.key, !!checked)
                              }
                            />
                          </TableCell>
                          {PERMISSION_BUCKETS.map((b) => (
                            <TableCell key={b.key} className="text-center">
                              <Checkbox
                                checked={isBucketChecked(
                                  editingRole.permissions,
                                  mod.key,
                                  b.key,
                                )}
                                onCheckedChange={(checked) =>
                                  toggleBucket(mod.key, b.key, !!checked)
                                }
                              />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button
              onClick={handleSaveRole}
              disabled={
                !editingRole?.name.trim() ||
                createRole.isPending ||
                updateRole.isPending
              }
              className="bg-green-600 hover:bg-green-700"
            >
              {editingRole?.id ? "Cập nhật" : "Tạo mới"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa vai trò này? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRole}
              className="bg-red-600 hover:bg-red-700"
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ==================== STAFF TAB ====================

type StaffFormState = {
  /** Edit mode: the staff_id (auth user uuid) being edited. Empty for create. */
  staff_id?: string;
  /** Tên đăng nhập — required on create only, free-form characters. */
  username: string;
  // All identity fields are OPTIONAL.
  full_name: string;
  phone: string;
  email: string;
  role_id: string;
  department: string;
  job_title: string;
  employee_code: string;
  is_active: boolean;
  all_buildings: boolean;
  /** Multi-select buildings (empty when all_buildings = true) */
  building_ids: string[];
  /** Selected area filter (subset of areas) — purely a UI filter */
  area_ids: string[];
  building_search: string;
  // Create-only:
  password: string;
  confirmPassword: string;
};

const emptyForm = (): StaffFormState => ({
  username: "",
  full_name: "",
  phone: "",
  email: "",
  role_id: "",
  department: "",
  job_title: "",
  employee_code: "",
  is_active: true,
  all_buildings: true,
  building_ids: [],
  area_ids: [],
  building_search: "",
  password: "",
  confirmPassword: "",
});

/** Group raw assignments rows by staff_id → {profile, role, building_ids[]} */
type StaffMember = {
  staff_id: string;
  profile: any;
  role_id: string;
  role: any;
  building_ids: string[];        // [] = all buildings
  buildings: { id: string; name: string }[];
  has_global: boolean;            // true if any row has building_id null
  assignment_ids: string[];
};

function groupByStaff(assignments: any[]): StaffMember[] {
  const map = new Map<string, StaffMember>();
  for (const a of assignments || []) {
    const sid = a.staff_id;
    if (!map.has(sid)) {
      map.set(sid, {
        staff_id: sid,
        profile: a.profile || null,
        role_id: a.role_id,
        role: a.role,
        building_ids: [],
        buildings: [],
        has_global: false,
        assignment_ids: [],
      });
    }
    const m = map.get(sid)!;
    m.assignment_ids.push(a.id);
    if (a.building_id) {
      m.building_ids.push(a.building_id);
      if (a.building) m.buildings.push({ id: a.building.id, name: a.building.name });
    } else {
      m.has_global = true;
    }
  }
  return Array.from(map.values());
}

function StaffTab() {
  const { data: assignments, isLoading: loadingAssignments } = useStaffAssignments();
  const { data: roles, isLoading: loadingRoles } = useRoles();
  const { data: buildings, isLoading: loadingBuildings } = useBuildings();
  const { data: areas } = useAreas();
  const provisionStaff = useProvisionStaff();
  const updateStaff = useUpdateStaffMember();
  const removeStaff = useRemoveStaffMember();

  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [form, setForm] = useState<StaffFormState | null>(null);
  const [deletingStaffId, setDeletingStaffId] = useState<string | null>(null);

  const isLoading = loadingAssignments || loadingRoles || loadingBuildings;
  const isEdit = !!form?.staff_id;

  const staffMembers = groupByStaff(assignments || []);

  const filteredMembers = staffMembers.filter((m) => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    const roleName = m.role?.name?.toLowerCase() || "";
    const profile = m.profile || {};
    const name = (profile.full_name || "").toLowerCase();
    const phone = (profile.phone || "").toLowerCase();
    const code = (profile.employee_code || "").toLowerCase();
    const buildingNames = m.buildings.map((b) => b.name.toLowerCase()).join(" ");
    return (
      name.includes(s) ||
      phone.includes(s) ||
      code.includes(s) ||
      roleName.includes(s) ||
      buildingNames.includes(s)
    );
  });

  const openCreateDialog = () => {
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEditDialog = (m: StaffMember) => {
    const profile = m.profile || {};
    setForm({
      staff_id: m.staff_id,
      username: "", // not editable post-creation
      full_name: profile.full_name || "",
      phone: profile.phone || "",
      email: profile.email || "",
      role_id: m.role_id || "",
      department: profile.department || "",
      job_title: profile.job_title || "",
      employee_code: profile.employee_code || "",
      is_active: profile.is_active ?? true,
      all_buildings: m.has_global,
      building_ids: m.building_ids,
      area_ids: [],
      building_search: "",
      password: "",
      confirmPassword: "",
    });
    setDialogOpen(true);
  };

  const phoneIsValid = (p: string) => p === "" || /^[0-9]{10,11}$/.test(p);
  const emailIsValid = (e: string) => e === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleSave = async () => {
    if (!form) return;
    if (!form.role_id) return;
    if (!form.all_buildings && form.building_ids.length === 0) return;

    const phone = form.phone.trim();
    const email = form.email.trim();
    if (!phoneIsValid(phone)) {
      toast.error("Số điện thoại phải có 10-11 chữ số (hoặc bỏ trống).");
      return;
    }
    if (!emailIsValid(email)) {
      toast.error("Email không đúng định dạng (hoặc bỏ trống).");
      return;
    }

    if (!isEdit) {
      if (!form.username.trim()) return;
      if (!form.password || form.password.length < 6) return;
      if (form.password !== form.confirmPassword) return;
      const payload: ProvisionStaffInput = {
        username: form.username.trim(),
        password: form.password,
        role_id: form.role_id,
        building_ids: form.all_buildings ? null : form.building_ids,
        full_name: form.full_name.trim() || undefined,
        phone: phone || undefined,
        email: email || undefined,
        department: form.department.trim() || undefined,
        job_title: form.job_title.trim() || undefined,
        employee_code: form.employee_code.trim() || undefined,
        is_active: form.is_active,
      };
      await provisionStaff.mutateAsync(payload);
    } else {
      await updateStaff.mutateAsync({
        staff_id: form.staff_id!,
        role_id: form.role_id,
        building_ids: form.all_buildings ? null : form.building_ids,
        profile_patch: {
          full_name: form.full_name.trim(),
          phone: phone || null,
          email: email || null,
          department: form.department.trim() || null,
          job_title: form.job_title.trim() || null,
          employee_code: form.employee_code.trim() || null,
          is_active: form.is_active,
        },
      });
    }
    setDialogOpen(false);
    setForm(null);
  };

  const handleDelete = async () => {
    if (!deletingStaffId) return;
    await removeStaff.mutateAsync(deletingStaffId);
    setDeleteDialogOpen(false);
    setDeletingStaffId(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-muted-foreground">Đang tải...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm kiếm nhân viên..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button onClick={openCreateDialog} className="bg-green-600 hover:bg-green-700">
          <Plus className="h-4 w-4 mr-2" />
          Thêm người dùng
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nhân viên</TableHead>
                <TableHead>SĐT / Email</TableHead>
                <TableHead>Vai trò</TableHead>
                <TableHead>Toà nhà</TableHead>
                <TableHead className="text-center">Trạng thái</TableHead>
                <TableHead className="w-[100px]">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMembers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <div className="flex flex-col items-center gap-2">
                      <Users className="h-12 w-12 text-gray-300" />
                      <p className="text-muted-foreground">
                        {searchTerm
                          ? "Không tìm thấy nhân viên nào"
                          : "Chưa có nhân viên nào. Nhấn 'Thêm người dùng' để tạo mới."}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredMembers.map((m) => {
                  const profile = m.profile || {};
                  const initials = (profile.full_name || "NV")
                    .split(" ")
                    .map((p: string) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <TableRow key={m.staff_id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-primary text-white flex items-center justify-center text-xs font-semibold">
                            {initials}
                          </div>
                          <div>
                            <div className="font-medium">
                              {profile.full_name || (
                                <span className="font-mono text-xs text-muted-foreground">
                                  {m.staff_id.substring(0, 8)}…
                                </span>
                              )}
                            </div>
                            {profile.employee_code && (
                              <div className="text-xs text-muted-foreground">
                                Mã: {profile.employee_code}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{profile.phone || "—"}</div>
                        {profile.email && (
                          <div className="text-xs text-muted-foreground">{profile.email}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{m.role?.name || "—"}</Badge>
                        {profile.job_title && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {profile.job_title}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.has_global ? (
                          <span className="text-muted-foreground italic">Tất cả toà nhà</span>
                        ) : m.buildings.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : m.buildings.length <= 2 ? (
                          <div className="flex flex-wrap gap-1">
                            {m.buildings.map((b) => (
                              <Badge key={b.id} variant="secondary" className="text-xs">
                                {b.name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="secondary" className="text-xs">
                              {m.buildings[0].name}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              {m.buildings[1].name}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              +{m.buildings.length - 2}
                            </Badge>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {profile.is_active === false ? (
                          <Badge className="bg-gray-100 text-gray-700">Tạm khoá</Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700">Hoạt động</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => openEditDialog(m)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => {
                              setDeletingStaffId(m.staff_id);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create / Edit Manager Dialog — Resident-style fields */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isEdit ? "Cập nhật người dùng" : "Thêm người dùng"}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Cập nhật vai trò và phạm vi quản lý của nhân viên"
                : "Tạo tài khoản nhân viên mới với loại tài khoản, phạm vi và mật khẩu khởi tạo"}
            </DialogDescription>
          </DialogHeader>

          {form && (
            <div className="space-y-5">
              {/* Active toggle */}
              <div className="flex items-center justify-between border rounded-lg p-3 bg-muted/30">
                <div>
                  <Label className="text-sm font-medium">Hoạt động</Label>
                  <p className="text-xs text-muted-foreground">
                    Tắt nếu tài khoản này tạm thời không sử dụng
                  </p>
                </div>
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: !!v })}
                />
              </div>

              {/* Basic info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {!isEdit && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="staff-username">Tên đăng nhập *</Label>
                    <Input
                      id="staff-username"
                      placeholder="VD: phukim, an.nguyen, Nhân viên 01..."
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Cho phép bất kỳ ký tự nào (kể cả tiếng Việt có dấu, khoảng trắng).
                      Đây là tên nhân viên dùng để đăng nhập.
                    </p>
                  </div>
                )}

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="staff-fullname">Họ tên</Label>
                  <Input
                    id="staff-fullname"
                    placeholder="VD: Nguyễn Văn A (không bắt buộc)"
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="staff-phone">Số điện thoại</Label>
                  <Input
                    id="staff-phone"
                    placeholder="0901234567 (không bắt buộc)"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                  {form.phone.trim() !== "" && !/^[0-9]{10,11}$/.test(form.phone.trim()) && (
                    <p className="text-xs text-red-600">Phải là 10-11 chữ số</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="staff-email">Email</Label>
                  <Input
                    id="staff-email"
                    placeholder="email@domain.com (không bắt buộc)"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                  {form.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) && (
                    <p className="text-xs text-red-600">Email không đúng định dạng</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>Loại người dùng *</Label>
                  <Select
                    value={form.role_id}
                    onValueChange={(val) => setForm({ ...form, role_id: val })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn loại tài khoản" />
                    </SelectTrigger>
                    <SelectContent>
                      {(roles || []).map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="staff-dept">Bộ phận</Label>
                  <Input
                    id="staff-dept"
                    placeholder="Chọn bộ phận"
                    value={form.department}
                    onChange={(e) => setForm({ ...form, department: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="staff-job">Chức danh</Label>
                  <Input
                    id="staff-job"
                    placeholder="Chức danh"
                    value={form.job_title}
                    onChange={(e) => setForm({ ...form, job_title: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="staff-code">Mã nhân viên</Label>
                  <Input
                    id="staff-code"
                    placeholder="VD: NV001"
                    value={form.employee_code}
                    onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
                  />
                </div>
              </div>

              {/* Password (create only) */}
              {!isEdit && (
                <div className="border-t pt-4 space-y-3">
                  <div className="text-sm font-medium">Mật khẩu</div>
                  <p className="text-xs text-muted-foreground">
                    Lưu ý: Nếu tên đăng nhập đã tồn tại trên hệ thống, bạn sẽ phải chọn tên khác.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="staff-pw">Mật khẩu *</Label>
                      <Input
                        id="staff-pw"
                        type="password"
                        placeholder="Tối thiểu 6 ký tự"
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="staff-pw2">Xác nhận mật khẩu *</Label>
                      <Input
                        id="staff-pw2"
                        type="password"
                        placeholder="Nhập lại mật khẩu"
                        value={form.confirmPassword}
                        onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                      />
                    </div>
                  </div>
                  {form.password && form.confirmPassword && form.password !== form.confirmPassword && (
                    <p className="text-xs text-red-600">Mật khẩu xác nhận không khớp</p>
                  )}
                </div>
              )}

              {/* Buildings scope — Resident-style */}
              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Quản lý toà nhà & công việc</div>
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-normal">Quản lý tất cả toà nhà</Label>
                    <Switch
                      checked={form.all_buildings}
                      onCheckedChange={(v) =>
                        setForm({
                          ...form,
                          all_buildings: !!v,
                          building_ids: v ? [] : form.building_ids,
                          area_ids: v ? [] : form.area_ids,
                        })
                      }
                    />
                  </div>
                </div>

                {!form.all_buildings && (
                  <>
                    {/* Khu vực filter */}
                    {(areas || []).length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-sm">Khu vực</Label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {(areas || []).map((a: any) => {
                            const checked = form.area_ids.includes(a.id);
                            return (
                              <label
                                key={a.id}
                                className="flex items-center gap-2 text-sm cursor-pointer"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(v) => {
                                    const next = v
                                      ? [...form.area_ids, a.id]
                                      : form.area_ids.filter((x) => x !== a.id);
                                    setForm({ ...form, area_ids: next });
                                  }}
                                />
                                <span>{a.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Tòa nhà search + multi-select */}
                    <div className="space-y-2">
                      <Label className="text-sm">Tòa nhà</Label>
                      <Input
                        placeholder="Tìm kiếm toà nhà..."
                        value={form.building_search}
                        onChange={(e) =>
                          setForm({ ...form, building_search: e.target.value })
                        }
                      />
                      {(() => {
                        const search = form.building_search.trim().toLowerCase();
                        const list = (buildings || []).filter((b: any) => {
                          // area filter
                          if (form.area_ids.length > 0) {
                            if (!b.area_id || !form.area_ids.includes(b.area_id)) return false;
                          }
                          // search filter
                          if (search && !(b.name || "").toLowerCase().includes(search)) return false;
                          return true;
                        });
                        if (list.length === 0) {
                          return (
                            <p className="text-xs text-muted-foreground italic px-1">
                              Không có toà nhà phù hợp.
                            </p>
                          );
                        }
                        return (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-56 overflow-y-auto border rounded-md p-2">
                            {list.map((b: any) => {
                              const checked = form.building_ids.includes(b.id);
                              return (
                                <label
                                  key={b.id}
                                  className="flex items-start gap-2 text-sm cursor-pointer"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => {
                                      const next = v
                                        ? [...form.building_ids, b.id]
                                        : form.building_ids.filter((x) => x !== b.id);
                                      setForm({ ...form, building_ids: next });
                                    }}
                                    className="mt-0.5"
                                  />
                                  <span className="leading-tight">{b.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        );
                      })()}
                      {form.building_ids.length === 0 && (
                        <p className="text-xs text-red-600">Chọn ít nhất 1 toà nhà</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Hủy bỏ
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !form?.role_id ||
                (!form?.all_buildings && (form?.building_ids?.length || 0) === 0) ||
                (!isEdit && (
                  !form?.username?.trim() ||
                  !form?.password ||
                  form.password.length < 6 ||
                  form.password !== form.confirmPassword
                )) ||
                provisionStaff.isPending ||
                updateStaff.isPending
              }
              className="bg-green-600 hover:bg-green-700"
            >
              {isEdit ? "Cập nhật" : "Lưu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa phân quyền này? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ==================== MAIN PAGE ====================

const StaffPage = () => {
  const [activeTab, setActiveTab] = useState("roles");

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center">
            <UserCog className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Quản lý Nhân viên</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý loại tài khoản, phân quyền và gán nhân viên theo toà nhà
            </p>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="roles" className="flex items-center gap-1.5">
              <Shield className="h-4 w-4" />
              Loại tài khoản
            </TabsTrigger>
            <TabsTrigger value="staff" className="flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              Người dùng
            </TabsTrigger>
          </TabsList>

          <TabsContent value="roles">
            <RolesTab />
          </TabsContent>

          <TabsContent value="staff">
            <StaffTab />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};

export default StaffPage;
