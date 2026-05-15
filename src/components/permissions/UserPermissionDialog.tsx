import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, KeyRound, RotateCcw, Search, Shield, ShieldCheck, ShieldOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  PERMISSION_CATALOG,
  RESOURCES_BY_DOMAIN,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  type Domain,
  type ResourceDef,
  allActionsOf,
  labelOfAction,
} from "@/lib/permissionCatalog";
import {
  useUserPermissionOverrides,
  useSaveUserPermissionOverrides,
  useResetUserPermissionOverrides,
  overrideKey,
  type UserPermissionOverride,
} from "@/hooks/useUserPermissionOverrides";
import { useSuperAdminUserIds } from "@/hooks/useIsSuperAdmin";

type OverrideEffect = "grant" | "revoke";

interface RolePermissionsMap {
  [resource: string]: { [action: string]: boolean };
}

interface UserPermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  roleName: string | null;
  // Permissions JSONB từ role baseline. Shape: { resource: { view, create, edit, delete, ...specials } }
  rolePermissions: RolePermissionsMap;
}

// Kiểm tra role baseline có action này không.
const baselineHas = (rolePerms: RolePermissionsMap, resource: string, action: string): boolean =>
  !!rolePerms?.[resource]?.[action];

// Hiệu lực thực tế = baseline ± override.
const effectiveHas = (
  baseline: boolean,
  override: OverrideEffect | undefined,
): boolean => {
  if (override === "grant") return true;
  if (override === "revoke") return false;
  return baseline;
};

const overridesToMap = (rows: UserPermissionOverride[]): Map<string, OverrideEffect> => {
  const m = new Map<string, OverrideEffect>();
  for (const r of rows) m.set(overrideKey(r.resource, r.action), r.effect);
  return m;
};

export const UserPermissionDialog = ({
  open,
  onOpenChange,
  userId,
  userName,
  roleName,
  rolePermissions,
}: UserPermissionDialogProps) => {
  const { data: existingOverrides, isLoading: loadingOverrides } = useUserPermissionOverrides(open ? userId : null);
  const { data: superAdminIds } = useSuperAdminUserIds();
  const saveOverrides = useSaveUserPermissionOverrides();
  const resetOverrides = useResetUserPermissionOverrides();

  const targetIsSuperAdmin = !!superAdminIds?.has(userId);

  const [overrides, setOverrides] = useState<Map<string, OverrideEffect>>(new Map());
  const [search, setSearch] = useState("");
  const [activeDomain, setActiveDomain] = useState<Domain>("customer");
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Re-seed local state khi mở dialog hoặc data overrides đổi.
  useEffect(() => {
    if (open) {
      setOverrides(overridesToMap(existingOverrides ?? []));
      setSearch("");
    }
  }, [open, existingOverrides]);

  const setEffectFor = (resource: string, action: string, effect: OverrideEffect | "inherit") => {
    setOverrides((prev) => {
      const next = new Map(prev);
      const key = overrideKey(resource, action);
      if (effect === "inherit") next.delete(key);
      else next.set(key, effect);
      return next;
    });
  };

  // Diff summary so với baseline.
  const { grantCount, revokeCount } = useMemo(() => {
    let g = 0, r = 0;
    for (const effect of overrides.values()) {
      if (effect === "grant") g++;
      else if (effect === "revoke") r++;
    }
    return { grantCount: g, revokeCount: r };
  }, [overrides]);

  // Lọc resource theo search.
  const filterResource = (res: ResourceDef): boolean => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (res.label.toLowerCase().includes(q)) return true;
    if (res.key.toLowerCase().includes(q)) return true;
    return allActionsOf(res).some((act) => labelOfAction(res, act).toLowerCase().includes(q));
  };

  const handleSave = async () => {
    const desired = Array.from(overrides.entries()).map(([key, effect]) => {
      const [resource, action] = key.split(".");
      return { resource, action, effect };
    });
    await saveOverrides.mutateAsync({ userId, desired });
    onOpenChange(false);
  };

  const handleReset = async () => {
    await resetOverrides.mutateAsync(userId);
    setResetConfirmOpen(false);
    onOpenChange(false);
  };

  const disabled = targetIsSuperAdmin || loadingOverrides;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-green-600" />
              Phân quyền chi tiết — {userName}
            </DialogTitle>
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2">
              <span>Vai trò baseline:</span>
              <Badge variant="outline">{roleName || "(chưa gán)"}</Badge>
              <span>— Cộng/trừ quyền chi tiết so với vai trò.</span>
            </div>
          </DialogHeader>

          {targetIsSuperAdmin && (
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">User này là Super Admin</div>
                <div className="text-red-800">
                  Super admin bypass toàn bộ RLS và phân quyền. Override trong dialog này
                  <strong> không có hiệu lực</strong>. Để gỡ đặc quyền, xoá user khỏi bảng
                  <code className="mx-1 rounded bg-red-100 px-1 py-0.5 text-xs">super_admins</code>.
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Tìm theo tên quyền, resource, action..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
                disabled={disabled}
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="outline" className="border-green-300 text-green-700">
                +{grantCount} grant
              </Badge>
              <Badge variant="outline" className="border-red-300 text-red-700">
                −{revokeCount} revoke
              </Badge>
            </div>
          </div>

          <Tabs value={activeDomain} onValueChange={(v) => setActiveDomain(v as Domain)} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid grid-cols-5 lg:grid-cols-10 gap-1 h-auto p-1">
              {DOMAIN_ORDER.map((d) =>
                RESOURCES_BY_DOMAIN[d]?.length ? (
                  <TabsTrigger key={d} value={d} className="text-xs">
                    {DOMAIN_LABELS[d]}
                  </TabsTrigger>
                ) : null,
              )}
            </TabsList>

            {DOMAIN_ORDER.map((d) => {
              const resources = (RESOURCES_BY_DOMAIN[d] ?? []).filter(filterResource);
              return (
                <TabsContent key={d} value={d} className="flex-1 mt-3 min-h-0">
                  <ScrollArea className="h-[55vh] pr-3">
                    {resources.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        Không có resource nào khớp tìm kiếm.
                      </p>
                    ) : (
                      <Accordion type="multiple" className="space-y-2">
                        {resources.map((res) => (
                          <AccordionItem key={res.key} value={res.key} className="border rounded-md px-3">
                            <AccordionTrigger className="hover:no-underline py-3">
                              <div className="flex items-center gap-3 text-left flex-1">
                                <span className="font-medium">{res.label}</span>
                                <ResourceSummary
                                  res={res}
                                  rolePermissions={rolePermissions}
                                  overrides={overrides}
                                />
                              </div>
                            </AccordionTrigger>
                            <AccordionContent>
                              <ResourceActionTable
                                res={res}
                                rolePermissions={rolePermissions}
                                overrides={overrides}
                                disabled={disabled}
                                onChange={setEffectFor}
                              />
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                      </Accordion>
                    )}
                  </ScrollArea>
                </TabsContent>
              );
            })}
          </Tabs>

          <DialogFooter className="gap-2 sm:gap-0 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => setResetConfirmOpen(true)}
              disabled={disabled || (overrides.size === 0 && (existingOverrides?.length ?? 0) === 0)}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Khôi phục về vai trò
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Huỷ
              </Button>
              <Button
                onClick={handleSave}
                disabled={disabled || saveOverrides.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {saveOverrides.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Khôi phục về quyền của vai trò?</AlertDialogTitle>
            <AlertDialogDescription>
              Sẽ xoá toàn bộ override (grant/revoke) hiện có cho user này. Quyền sẽ
              trở về đúng những gì vai trò {roleName ? <strong>{roleName}</strong> : "baseline"} quy định.
              Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} className="bg-red-600 hover:bg-red-700">
              Khôi phục
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

// ── Sub-components ─────────────────────────────────────────

const ResourceSummary = ({
  res,
  rolePermissions,
  overrides,
}: {
  res: ResourceDef;
  rolePermissions: RolePermissionsMap;
  overrides: Map<string, OverrideEffect>;
}) => {
  const actions = allActionsOf(res);
  let effectiveCount = 0;
  let overrideCount = 0;
  for (const action of actions) {
    const baseline = baselineHas(rolePermissions, res.key, action);
    const ov = overrides.get(overrideKey(res.key, action));
    if (ov) overrideCount++;
    if (effectiveHas(baseline, ov)) effectiveCount++;
  }
  return (
    <div className="flex items-center gap-2 ml-auto mr-2 text-xs font-normal">
      <Badge variant="secondary">
        {effectiveCount}/{actions.length} quyền
      </Badge>
      {overrideCount > 0 && (
        <Badge variant="outline" className="border-amber-300 text-amber-700">
          {overrideCount} override
        </Badge>
      )}
    </div>
  );
};

const ResourceActionTable = ({
  res,
  rolePermissions,
  overrides,
  disabled,
  onChange,
}: {
  res: ResourceDef;
  rolePermissions: RolePermissionsMap;
  overrides: Map<string, OverrideEffect>;
  disabled: boolean;
  onChange: (resource: string, action: string, effect: OverrideEffect | "inherit") => void;
}) => {
  const actions = allActionsOf(res);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Action</TableHead>
          <TableHead className="w-[100px] text-center">Vai trò</TableHead>
          <TableHead className="w-[160px]">Override</TableHead>
          <TableHead className="w-[100px] text-center">Hiệu lực</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {actions.map((action) => {
          const baseline = baselineHas(rolePermissions, res.key, action);
          const ov = overrides.get(overrideKey(res.key, action));
          const effective = effectiveHas(baseline, ov);
          return (
            <TableRow key={action}>
              <TableCell className="font-medium">{labelOfAction(res, action)}</TableCell>
              <TableCell className="text-center">
                {baseline ? (
                  <ShieldCheck className="h-4 w-4 text-green-600 inline" />
                ) : (
                  <ShieldOff className="h-4 w-4 text-gray-300 inline" />
                )}
              </TableCell>
              <TableCell>
                <Select
                  value={ov ?? "inherit"}
                  onValueChange={(v) => onChange(res.key, action, v as OverrideEffect | "inherit")}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Inherit (theo vai trò)</SelectItem>
                    <SelectItem value="grant">Grant (cấp thêm)</SelectItem>
                    <SelectItem value="revoke">Revoke (gỡ bỏ)</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-center">
                {effective ? (
                  <Shield className="h-4 w-4 text-green-600 inline" />
                ) : (
                  <ShieldOff className="h-4 w-4 text-red-400 inline" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export default UserPermissionDialog;
