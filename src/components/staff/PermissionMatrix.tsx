// Permission matrix — controlled component dùng trong dialog gán quyền.
//
// Render 35 module × N action theo 7 nhóm accordion + 4 nút preset toàn cục
// (Bỏ tất / Chỉ xem / Quản lý / Tất cả) + search filter + diff indicator so
// với template gốc.

import { useMemo, useState } from "react";
import { Search, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import {
  ACTION_LABELS,
  ALL_MODULES,
  PERMISSION_GROUPS,
  actionsForModule,
  applyGlobalPreset,
  diffPermissions,
  isSuperAdminPerms,
  setModuleAction,
  setModuleAll,
  type ActionKey,
  type PermissionsMap,
  type Preset,
} from "@/lib/permissions";

export interface PermissionMatrixProps {
  /** Current permissions (controlled). */
  value: PermissionsMap;
  onChange: (next: PermissionsMap) => void;
  /** Baseline permission (template gốc) để so sánh diff. Pass null nếu không có. */
  baseline?: PermissionsMap | null;
  /** Read-only mode (vd: viewing system template). */
  disabled?: boolean;
}

export function PermissionMatrix({ value, onChange, baseline, disabled }: PermissionMatrixProps) {
  const [search, setSearch] = useState("");
  const isSuperAdmin = isSuperAdminPerms(value);

  // Diff vs baseline → Set "{module}.{action}" để dot indicator
  const diffSet = useMemo(() => {
    if (!baseline) return new Set<string>();
    return new Set(diffPermissions(baseline, value).map((d) => `${d.module}.${d.action}`));
  }, [baseline, value]);

  const diffCount = diffSet.size;

  // Filter modules theo search
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PERMISSION_GROUPS;
    return PERMISSION_GROUPS.map((g) => ({
      ...g,
      modules: g.modules.filter(
        (m) =>
          m.key.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q),
      ),
    })).filter((g) => g.modules.length > 0);
  }, [search]);

  const handleGlobalPreset = (p: Preset) => {
    if (disabled) return;
    onChange(applyGlobalPreset(value, p));
  };

  const handleToggleAction = (moduleKey: string, action: ActionKey, checked: boolean) => {
    if (disabled) return;
    onChange(setModuleAction(value, moduleKey, action, checked));
  };

  const handleToggleModule = (moduleKey: string, checked: boolean) => {
    if (disabled) return;
    onChange(setModuleAll(value, moduleKey, checked));
  };

  if (isSuperAdmin) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900 p-4 text-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-100 dark:bg-amber-900 p-2 flex-shrink-0">
            <CheckCircle2 className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <p className="font-medium text-amber-900 dark:text-amber-100">
              Bypass toàn quyền (Super Admin)
            </p>
            <p className="text-amber-700 dark:text-amber-300 mt-1">
              Tài khoản này có cờ <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900">__superadmin: true</code> — bỏ qua mọi
              kiểm tra quyền. Không cần cấu hình chi tiết.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: search + preset buttons + diff badge */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm chức năng…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => handleGlobalPreset("none")} disabled={disabled}>
            Bỏ tất
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleGlobalPreset("view")} disabled={disabled}>
            Chỉ xem
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleGlobalPreset("manage")} disabled={disabled}>
            Quản lý
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleGlobalPreset("all")} disabled={disabled}>
            Tất cả
          </Button>
        </div>
      </div>

      {baseline && diffCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>
            <strong>{diffCount}</strong> quyền khác mẫu gốc — staff sẽ giữ phiên bản tinh chỉnh.
          </span>
        </div>
      )}

      {/* Accordion theo 7 nhóm */}
      <Accordion
        type="multiple"
        defaultValue={PERMISSION_GROUPS.map((g) => g.key)}
        className="space-y-2"
      >
        {filteredGroups.map((g) => (
          <AccordionItem
            key={g.key}
            value={g.key}
            className="border rounded-lg overflow-hidden bg-card"
          >
            <AccordionTrigger className="px-4 py-3 hover:bg-muted/50 hover:no-underline">
              <div className="flex items-center gap-2">
                <span className="font-medium">{g.label}</span>
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs font-normal">
                  {g.modules.length}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className="border-t">
              <div className="divide-y">
                {g.modules.map((m) => {
                  const actions = actionsForModule(m.key);
                  const moduleAllOn = actions.every((a) => !!value[m.key]?.[a]);
                  const moduleAnyOn = actions.some((a) => !!value[m.key]?.[a]);
                  const moduleHasDiff = actions.some((a) => diffSet.has(`${m.key}.${a}`));
                  return (
                    <div
                      key={m.key}
                      className={cn(
                        "flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30",
                        moduleHasDiff && "bg-amber-50/30 dark:bg-amber-950/10",
                      )}
                    >
                      {/* Module name + select-all checkbox */}
                      <div className="flex items-center gap-2.5 min-w-[180px] flex-1">
                        <Checkbox
                          id={`mod-${m.key}`}
                          checked={moduleAllOn ? true : moduleAnyOn ? "indeterminate" : false}
                          onCheckedChange={(c) => handleToggleModule(m.key, c === true)}
                          disabled={disabled}
                          aria-label={`Toggle all ${m.label}`}
                        />
                        <label
                          htmlFor={`mod-${m.key}`}
                          className="text-sm font-medium leading-none cursor-pointer select-none flex items-center gap-1.5"
                        >
                          {m.label}
                          {moduleHasDiff && (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" title="Khác mẫu" />
                          )}
                        </label>
                      </div>

                      {/* Per-action checkboxes */}
                      <div className="flex items-center gap-3 flex-wrap justify-end">
                        {actions.map((a) => {
                          const checked = !!value[m.key]?.[a];
                          const diff = diffSet.has(`${m.key}.${a}`);
                          return (
                            <label
                              key={a}
                              className={cn(
                                "flex items-center gap-1.5 text-xs select-none cursor-pointer rounded px-1.5 py-0.5",
                                diff && "ring-1 ring-amber-400 dark:ring-amber-600",
                                disabled && "cursor-not-allowed opacity-60",
                              )}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(c) => handleToggleAction(m.key, a, c === true)}
                                disabled={disabled}
                                className="h-3.5 w-3.5"
                              />
                              <span className={cn("text-foreground", a !== "view" && "text-muted-foreground")}>
                                {ACTION_LABELS[a]}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
        {filteredGroups.length === 0 && (
          <div className="text-center text-muted-foreground py-8 border rounded-lg">
            Không tìm thấy chức năng phù hợp.
          </div>
        )}
      </Accordion>
    </div>
  );
}
