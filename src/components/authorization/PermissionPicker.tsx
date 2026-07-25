// Bộ chọn QUYỀN — trả lời câu "được làm gì".
//
// Nhóm theo TRANG (catalog src/lib/permissionPages.ts) chứ không theo bảng dữ
// liệu, vì người dùng nghĩ theo màn hình họ mở chứ không theo tên bảng. Mỗi
// dòng là một chức năng có thật trên trang đó.
//
// Tier quyết định màu và preset:
//   view     — chỉ đọc
//   manage   — thao tác thường ngày
//   elevated — nhạy cảm (duyệt, thanh lý, chốt lợi nhuận, phân quyền…)

import { useMemo, useState } from 'react';
import { ChevronRight, Search, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { PAGE_GROUPS, featureKey, type PageFeature } from '@/lib/permissionPages';

export interface PermissionPickerProps {
  /** Khoá đang bật. */
  value: Set<string>;
  onToggle: (key: string, bat: boolean) => void;
  onToggleMany?: (keys: string[], bat: boolean) => void;
  /** Khoá KHÔNG có trong permission_definitions -> khoá mờ, kèm giải thích. */
  availableKeys?: Set<string>;
  /** Hiện dấu hiệu "đến từ vai trò" cho các khoá này (dùng ở tab Ngoại lệ). */
  inheritedKeys?: Set<string>;
  disabled?: boolean;
  /** Nhãn ở cột phải khi khoá đang bật (mặc định không hiện). */
  renderTrailing?: (key: string) => React.ReactNode;
  height?: string;
}

const TIER_BADGE: Record<PageFeature['tier'], { nhan: string; cls: string }> = {
  view: { nhan: 'Xem', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  manage: { nhan: 'Thao tác', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  elevated: { nhan: 'Nhạy cảm', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
};

export function PermissionPicker({
  value,
  onToggle,
  onToggleMany,
  availableKeys,
  inheritedKeys,
  disabled,
  renderTrailing,
  height = 'h-[420px]',
}: PermissionPickerProps) {
  const [tim, setTim] = useState('');
  const [mo, setMo] = useState<Set<string>>(new Set());

  const q = tim.trim().toLowerCase();
  const nhomHienThi = useMemo(() => {
    if (!q) return PAGE_GROUPS;
    return PAGE_GROUPS.map((g) => ({
      ...g,
      pages: g.pages
        .map((p) => ({
          ...p,
          features: p.features.filter(
            (ft) =>
              ft.label.toLowerCase().includes(q) ||
              p.label.toLowerCase().includes(q) ||
              featureKey(ft).includes(q),
          ),
        }))
        .filter((p) => p.features.length),
    })).filter((g) => g.pages.length);
  }, [q]);

  const dat = (keys: string[], bat: boolean) => {
    const duoc = keys.filter((k) => !availableKeys || availableKeys.has(k));
    if (onToggleMany) onToggleMany(duoc, bat);
    else duoc.forEach((k) => onToggle(k, bat));
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={tim}
          onChange={(e) => setTim(e.target.value)}
          placeholder="Tìm quyền: 'duyệt', 'hợp đồng', 'sổ quỹ'…"
          className="pl-8"
        />
      </div>

      <ScrollArea className={cn(height, 'rounded-md border')}>
        <div className="divide-y">
          {nhomHienThi.map((g) => (
            <div key={g.key}>
              <div className="sticky top-0 z-10 bg-muted/95 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                {g.label}
              </div>
              {g.pages.map((p) => {
                const keys = p.features.map(featureKey);
                const daBat = keys.filter((k) => value.has(k)).length;
                const banMo = q.length > 0 || mo.has(p.key);
                return (
                  <div key={p.key} className="border-t first:border-t-0">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                      onClick={() =>
                        setMo((s) => {
                          const n = new Set(s);
                          if (n.has(p.key)) n.delete(p.key);
                          else n.add(p.key);
                          return n;
                        })
                      }
                    >
                      <ChevronRight
                        className={cn('h-4 w-4 shrink-0 transition-transform', banMo && 'rotate-90')}
                      />
                      <span className="flex-1 text-sm font-medium">{p.label}</span>
                      <span
                        className={cn(
                          'text-xs tabular-nums',
                          daBat === 0
                            ? 'text-muted-foreground'
                            : daBat === keys.length
                              ? 'font-medium text-primary'
                              : 'text-foreground',
                        )}
                      >
                        {daBat}/{keys.length}
                      </span>
                    </button>

                    {banMo && (
                      <div className="space-y-0.5 pb-2 pl-9 pr-3">
                        {p.desc && (
                          <p className="pb-1 text-xs text-muted-foreground">{p.desc}</p>
                        )}
                        {!disabled && !q && (
                          <div className="flex gap-2 pb-1">
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-xs"
                              onClick={() => dat(keys, true)}
                            >
                              Bật hết
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-xs"
                              onClick={() =>
                                dat(
                                  p.features.filter((ft) => ft.tier === 'view').map(featureKey),
                                  true,
                                )
                              }
                            >
                              Chỉ xem
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-xs text-muted-foreground"
                              onClick={() => dat(keys, false)}
                            >
                              Tắt hết
                            </Button>
                          </div>
                        )}
                        {p.features.map((ft) => {
                          const k = featureKey(ft);
                          const co = !availableKeys || availableKeys.has(k);
                          const tier = TIER_BADGE[ft.tier];
                          return (
                            <label
                              key={k}
                              className={cn(
                                'flex items-start gap-2 rounded-md px-2 py-1.5',
                                co && !disabled ? 'cursor-pointer hover:bg-muted/50' : 'cursor-not-allowed opacity-50',
                              )}
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={value.has(k)}
                                disabled={disabled || !co}
                                onCheckedChange={(c) => onToggle(k, c === true)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm">{ft.label}</span>
                                  {ft.tier === 'elevated' && (
                                    <Badge
                                      variant="outline"
                                      className={cn('gap-1 border-0 px-1.5 py-0 text-[10px]', tier.cls)}
                                    >
                                      <ShieldAlert className="h-2.5 w-2.5" />
                                      {tier.nhan}
                                    </Badge>
                                  )}
                                  {inheritedKeys?.has(k) && (
                                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                                      đã có từ vai trò
                                    </Badge>
                                  )}
                                </span>
                                {ft.desc && (
                                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                                    {ft.desc}
                                  </span>
                                )}
                                {!co && (
                                  <span className="mt-0.5 block text-xs text-muted-foreground">
                                    Quyền này chưa được khai báo trên máy chủ.
                                  </span>
                                )}
                              </span>
                              {renderTrailing?.(k)}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {!nhomHienThi.length && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Không có quyền nào khớp “{tim}”.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
