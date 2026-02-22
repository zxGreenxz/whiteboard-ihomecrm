import { useState } from "react";
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
  useCreateStaffAssignment,
  useUpdateStaffAssignment,
  useDeleteStaffAssignment,
} from "@/hooks/useStaffAssignments";
import { useBuildings } from "@/hooks/useBuildings";
import type { Json } from "@/integrations/supabase/types";

// Permission modules
const PERMISSION_MODULES = [
  { key: "buildings", label: "Toà nhà" },
  { key: "contracts", label: "Hợp đồng" },
  { key: "invoices", label: "Hoá đơn" },
  { key: "reports", label: "Báo cáo" },
  { key: "settings", label: "Cài đặt" },
] as const;

const PERMISSION_ACTIONS = [
  { key: "view", label: "Xem" },
  { key: "create", label: "Tạo" },
  { key: "edit", label: "Sửa" },
  { key: "delete", label: "Xóa" },
] as const;

type PermissionsMap = Record<string, Record<string, boolean>>;

function parsePermissions(permissions: Json): PermissionsMap {
  if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
    return permissions as unknown as PermissionsMap;
  }
  return {};
}

function buildDefaultPermissions(): PermissionsMap {
  const perms: PermissionsMap = {};
  for (const mod of PERMISSION_MODULES) {
    perms[mod.key] = {};
    for (const act of PERMISSION_ACTIONS) {
      perms[mod.key][act.key] = false;
    }
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

  const togglePermission = (moduleKey: string, actionKey: string) => {
    if (!editingRole) return;
    setEditingRole({
      ...editingRole,
      permissions: {
        ...editingRole.permissions,
        [moduleKey]: {
          ...(editingRole.permissions[moduleKey] || {}),
          [actionKey]: !(editingRole.permissions[moduleKey]?.[actionKey]),
        },
      },
    });
  };

  const toggleAllModule = (moduleKey: string, checked: boolean) => {
    if (!editingRole) return;
    const modulePerms: Record<string, boolean> = {};
    for (const act of PERMISSION_ACTIONS) {
      modulePerms[act.key] = checked;
    }
    setEditingRole({
      ...editingRole,
      permissions: {
        ...editingRole.permissions,
        [moduleKey]: modulePerms,
      },
    });
  };

  const isModuleAllChecked = (moduleKey: string) => {
    if (!editingRole) return false;
    const mp = editingRole.permissions[moduleKey];
    if (!mp) return false;
    return PERMISSION_ACTIONS.every((a) => mp[a.key]);
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
                        <TableHead className="w-[160px]">Module</TableHead>
                        <TableHead className="text-center w-[80px]">Tất cả</TableHead>
                        {PERMISSION_ACTIONS.map((act) => (
                          <TableHead key={act.key} className="text-center w-[80px]">
                            {act.label}
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
                          {PERMISSION_ACTIONS.map((act) => (
                            <TableCell key={act.key} className="text-center">
                              <Checkbox
                                checked={
                                  !!editingRole.permissions[mod.key]?.[act.key]
                                }
                                onCheckedChange={() =>
                                  togglePermission(mod.key, act.key)
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

function StaffTab() {
  const { data: assignments, isLoading: loadingAssignments } = useStaffAssignments();
  const { data: roles, isLoading: loadingRoles } = useRoles();
  const { data: buildings, isLoading: loadingBuildings } = useBuildings();
  const createAssignment = useCreateStaffAssignment();
  const updateAssignment = useUpdateStaffAssignment();
  const deleteAssignment = useDeleteStaffAssignment();

  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<{
    id?: string;
    staff_id: string;
    role_id: string;
    building_id: string;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isLoading = loadingAssignments || loadingRoles || loadingBuildings;

  const filteredAssignments = (assignments || []).filter((a) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    const roleName = (a.role as any)?.name?.toLowerCase() || "";
    const buildingName = (a.building as any)?.name?.toLowerCase() || "";
    return (
      a.staff_id.toLowerCase().includes(search) ||
      roleName.includes(search) ||
      buildingName.includes(search)
    );
  });

  const openCreateDialog = () => {
    setEditingAssignment({
      staff_id: "",
      role_id: "",
      building_id: "",
    });
    setDialogOpen(true);
  };

  const openEditDialog = (assignment: any) => {
    setEditingAssignment({
      id: assignment.id,
      staff_id: assignment.staff_id,
      role_id: assignment.role_id,
      building_id: assignment.building_id || "",
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!editingAssignment || !editingAssignment.staff_id || !editingAssignment.role_id) return;

    const payload = {
      staff_id: editingAssignment.staff_id,
      role_id: editingAssignment.role_id,
      building_id: editingAssignment.building_id || null,
    };

    if (editingAssignment.id) {
      await updateAssignment.mutateAsync({
        id: editingAssignment.id,
        updates: payload,
      });
    } else {
      await createAssignment.mutateAsync(payload);
    }
    setDialogOpen(false);
    setEditingAssignment(null);
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    await deleteAssignment.mutateAsync(deletingId);
    setDeleteDialogOpen(false);
    setDeletingId(null);
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
          Gán nhân viên
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nhân viên (ID)</TableHead>
                <TableHead>Vai trò</TableHead>
                <TableHead>Toà nhà</TableHead>
                <TableHead className="text-center">Trạng thái</TableHead>
                <TableHead className="w-[100px]">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAssignments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8">
                    <div className="flex flex-col items-center gap-2">
                      <Users className="h-12 w-12 text-gray-300" />
                      <p className="text-muted-foreground">
                        {searchTerm
                          ? "Không tìm thấy nhân viên nào"
                          : "Chưa có nhân viên nào được gán. Nhấn 'Gán nhân viên' để thêm."}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredAssignments.map((assignment) => {
                  const role = assignment.role as any;
                  const building = assignment.building as any;
                  return (
                    <TableRow key={assignment.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-primary text-white flex items-center justify-center text-xs font-semibold">
                            NV
                          </div>
                          <span className="font-mono text-sm">
                            {assignment.staff_id.substring(0, 8)}...
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{role?.name || "—"}</Badge>
                      </TableCell>
                      <TableCell>
                        {building?.name || (
                          <span className="text-muted-foreground italic">Tất cả toà nhà</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge className="bg-green-100 text-green-700">Hoạt động</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => openEditDialog(assignment)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => {
                              setDeletingId(assignment.id);
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

      {/* Create/Edit Assignment Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingAssignment?.id ? "Cập nhật phân quyền" : "Gán nhân viên"}
            </DialogTitle>
            <DialogDescription>
              Gán vai trò và toà nhà cho nhân viên
            </DialogDescription>
          </DialogHeader>

          {editingAssignment && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="staff-id">ID Nhân viên *</Label>
                <Input
                  id="staff-id"
                  placeholder="Nhập User ID của nhân viên"
                  value={editingAssignment.staff_id}
                  onChange={(e) =>
                    setEditingAssignment({
                      ...editingAssignment,
                      staff_id: e.target.value,
                    })
                  }
                  disabled={!!editingAssignment.id}
                />
                <p className="text-xs text-muted-foreground">
                  Nhập UUID của tài khoản nhân viên trong hệ thống
                </p>
              </div>

              <div className="space-y-2">
                <Label>Vai trò *</Label>
                <Select
                  value={editingAssignment.role_id}
                  onValueChange={(val) =>
                    setEditingAssignment({
                      ...editingAssignment,
                      role_id: val,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn vai trò" />
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

              <div className="space-y-2">
                <Label>Toà nhà (tuỳ chọn)</Label>
                <Select
                  value={editingAssignment.building_id}
                  onValueChange={(val) =>
                    setEditingAssignment({
                      ...editingAssignment,
                      building_id: val === "__all__" ? "" : val,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tất cả toà nhà" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Tất cả toà nhà</SelectItem>
                    {(buildings || []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Để trống nếu nhân viên quản lý tất cả toà nhà
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !editingAssignment?.staff_id ||
                !editingAssignment?.role_id ||
                createAssignment.isPending ||
                updateAssignment.isPending
              }
              className="bg-green-600 hover:bg-green-700"
            >
              {editingAssignment?.id ? "Cập nhật" : "Gán"}
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
