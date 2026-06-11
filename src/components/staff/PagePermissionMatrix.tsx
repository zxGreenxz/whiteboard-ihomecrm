// Bảng phân quyền THEO TRANG (redesign 2026-06-11) — thay PermissionMatrix cũ.
//
// Layout 2 cột: trái = danh sách trang (nhóm theo khu vực hệ thống, badge
// "đang bật/tổng" + chấm diff); phải = chi tiết TỪNG CHỨC NĂNG của trang đang
// chọn, mỗi chức năng 1 checkbox + mô tả + badge "Nhạy cảm" với quyền elevated.
// Search gõ-để-tìm lọc xuyên mọi trang. Checkbox hiển thị GIÁ TRỊ HIỆU LỰC
// (key tường minh hoặc fallback legacy) — toggle sẽ ghi key tường minh.

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Search, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  applyGlobalPreset,
  isSuperAdminPerms,
  type PermissionsMap,
  type Preset,
} from "@/lib/permissions";
import {
  ALL_PAGES,
  PAGE_GROUPS,
  diffFeatures,
  featureKey,
  featureValue,
  pageStats,
  setFeature,
  setPageAll,
  setPageViewOnly,
  type PageFeature,
  type PermissionPage,
} from "@/lib/permissionPages";

export interface PagePermissionMatrixProps {
  /** Current permissions (controlled). */
  value: PermissionsMap;
  onChange: (next: PermissionsMap) => void;
  /** Baseline (mẫu gốc) để hiển thị diff. */
  baseline?: PermissionsMap | null;
  /** Read-only (vd xem mẫu hệ thống). */
  disabled?: boolean;
}

export function PagePermissionMatrix({ value, onChange, baseline, disabled }: PagePermissionMatrixProps) {
  const [search, setSearch] = useState("");
  const [activePageKey, setActivePageKey] = useState<string>(ALL_PAGES[0]?.key ?? "");
  const isSuperAdmin = isSuperAdminPerms(value);

  // Diff vs baseline theo GIÁ TRỊ HIỆU LỰC từng feature → Set "{module}.{action}"
  const diffSet = useMemo(() => {
    if (!baseline) return new Set<string>();
    return new Set(diffFeatures(baseline, value).map(featureKey));
  }, [baseline, value]);

  const activePage = ALL_PAGES.find((p) => p.key === activePageKey) ?? ALL_PAGES[0];

  // Search: lọc feature xuyên trang
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const out: { page: PermissionPage; features: PageFeature[] }[] = [];
    for (const p of ALL_PAGES) {
      const matchPage = p.label.toLowerCase().includes(q) || p.route.toLowerCase().includes(q);
      const fts = matchPage
        ? p.features
        : p.features.filter(
            (ft) =>
              ft.label.toLowerCase().includes(q) ||
              ft.module.toLowerCase().includes(q) ||
              ft.action.toLowerCase().includes(q) ||
              (ft.desc || "").toLowerCase().includes(q),
          );
      if (fts.length > 0) out.push({ page: p, features: fts });
    }
    return out;
  }, [search]);

  const handlePreset = (p: Preset) => {
    if (disabled) return;
    onChange(applyGlobalPreset(value, p));
  };

  const handleToggle = (ft: PageFeature, checked: boolean) => {
    if (disabled) return;
    onChange(setFeature(value, ft, checked));
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

  const renderFeatureRow = (ft: PageFeature) => {
    const key = featureKey(ft);
    const checked = featureValue(value, ft);
    const isDiff = diffSet.has(key);
    const id = `pf-${key}`;
    return (
      <label
        key={key}
        htmlFor={id}
        className={cn(
          "flex items-start gap-2.5 px-3 py-2 rounded-md cursor-pointer select-none hover:bg-muted/40 border border-transparent",
          isDiff && "bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900",
          disabled && "cursor-not-allowed opacity-70",
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(c) => handleToggle(ft, c === true)}
          disabled={disabled}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm leading-tight">{ft.label}</span>
            {ft.tier === "elevated" && (
              <Badge variant="outline" className="h-4 px-1 text-[10px] border-rose-300 text-rose-600 dark:border-rose-800 dark:text-rose-400 gap-0.5">
                <ShieldAlert className="h-2.5 w-2.5" />
                Nhạy cảm
              </Badge>
            )}
            {isDiff && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" title="Khác mẫu gốc" />
            )}
          </div>
          {ft.desc && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{ft.desc}</p>
          )}
        </div>
      </label>
    );
  };

  const renderPagePanel = (page: PermissionPage) => {
    const stats = pageStats(value, page);
    // Nhóm feature theo section (nếu có)
    const sections = new Map<string, PageFeature[]>();
    for (const ft of page.features) {
      const s = ft.section || "";
      if (!sections.has(s)) sections.set(s, []);
      sections.get(s)!.push(ft);
    }
    return (
      <div className="flex-1 min-w-0 border rounded-lg bg-card">
        <div className="px-4 py-3 border-b">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="font-semibold text-sm">{page.label}</h4>
                <code className="text-[11px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">{page.route}</code>
                <Badge variant="secondary" className="h-5 px-1.5 text-xs font-normal">
                  {stats.granted}/{stats.total}
                </Badge>
              </div>
              {page.desc && <p className="text-xs text-muted-foreground mt-1">{page.desc}</p>}
            </div>
            {!disabled && (
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => onChange(setPageAll(value, page, false))}>
                  Bỏ hết
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => onChange(setPageViewOnly(value, page))}>
                  Chỉ xem
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => onChange(setPageAll(value, page, true))}>
                  Tất cả
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="p-2 space-y-1">
          {Array.from(sections.entries()).map(([sec, fts]) => (
            <div key={sec || "__default"}>
              {sec && (
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide px-3 pt-2 pb-1">
                  {sec}
                </p>
              )}
              <div className="space-y-0.5">{fts.map(renderFeatureRow)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm trang / chức năng…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {!disabled && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => handlePreset("none")}>Bỏ tất</Button>
            <Button variant="outline" size="sm" onClick={() => handlePreset("view")}>Chỉ xem</Button>
            <Button variant="outline" size="sm" onClick={() => handlePreset("manage")}>Quản lý</Button>
            <Button variant="outline" size="sm" onClick={() => handlePreset("all")}>Tất cả</Button>
          </div>
        )}
      </div>

      {baseline && diffSet.size > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>
            <strong>{diffSet.size}</strong> quyền khác mẫu gốc — nhân viên sẽ giữ bản tinh chỉnh riêng.
          </span>
        </div>
      )}

      {/* Search mode: flat results xuyên trang */}
      {searchResults ? (
        <div className="space-y-3">
          {searchResults.length === 0 && (
            <div className="text-center text-muted-foreground py-8 border rounded-lg text-sm">
              Không tìm thấy trang / chức năng phù hợp.
            </div>
          )}
          {searchResults.map(({ page, features }) => (
            <div key={page.key} className="border rounded-lg bg-card">
              <div className="px-4 py-2 border-b flex items-center gap-2">
                <h4 className="font-semibold text-sm">{page.label}</h4>
                <code className="text-[11px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">{page.route}</code>
              </div>
              <div className="p-2 space-y-0.5">{features.map(renderFeatureRow)}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Mobile: chọn trang bằng select */}
          <select
            value={activePage.key}
            onChange={(e) => setActivePageKey(e.target.value)}
            className="md:hidden w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            {PAGE_GROUPS.map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.pages.map((p) => {
                  const st = pageStats(value, p);
                  return (
                    <option key={p.key} value={p.key}>
                      {p.label} ({st.granted}/{st.total})
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>

          <div className="flex gap-3 items-start">
            {/* Page nav (desktop) */}
            <nav className="hidden md:block w-52 shrink-0 border rounded-lg bg-card overflow-hidden">
              <div className="max-h-[520px] overflow-y-auto py-1">
                {PAGE_GROUPS.map((g) => (
                  <div key={g.key}>
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide px-3 pt-2.5 pb-1">
                      {g.label}
                    </p>
                    {g.pages.map((p) => {
                      const st = pageStats(value, p);
                      const active = p.key === activePage.key;
                      const hasDiff = p.features.some((ft) => diffSet.has(featureKey(ft)));
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => setActivePageKey(p.key)}
                          className={cn(
                            "w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-sm hover:bg-muted/60",
                            active && "bg-muted font-medium",
                          )}
                        >
                          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground/50", active && "text-foreground")} />
                          <span className="flex-1 truncate">{p.label}</span>
                          {hasDiff && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />}
                          <span
                            className={cn(
                              "text-[10px] tabular-nums rounded px-1 py-0.5 shrink-0",
                              st.granted === 0
                                ? "text-muted-foreground/60 bg-muted"
                                : st.granted === st.total
                                  ? "text-emerald-700 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-950"
                                  : "text-blue-700 bg-blue-100 dark:text-blue-400 dark:bg-blue-950",
                            )}
                          >
                            {st.granted}/{st.total}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </nav>

            {/* Active page detail */}
            {renderPagePanel(activePage)}
          </div>
        </>
      )}
    </div>
  );
}
