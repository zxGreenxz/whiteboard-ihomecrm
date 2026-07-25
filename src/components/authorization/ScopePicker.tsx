// Bộ chọn PHẠM VI — trả lời câu "áp ở đâu".
//
// Luật hình dạng do máy chủ ép (a90_override_edge_shape, DEFERRABLE nên báo lỗi
// tận lúc COMMIT với mã 23514 khó hiểu). Thành phần này ép sẵn ở giao diện để
// người dùng không bao giờ chạm tới lỗi đó:
//   · Chọn "Toàn tổ chức"  -> chỉ đúng một phạm vi, mọi lựa chọn hẹp bị bỏ.
//   · Chọn phạm vi hẹp     -> tự bỏ "Toàn tổ chức".
// Ngoài ra chỉ hiện những LOẠI phạm vi mà khoá quyền chấp nhận (scope_kinds) —
// vd auto_debt.create chỉ nhận BUILDING/AREA thì không hiện sổ quỹ.

import { useMemo, useState } from 'react';
import { Building2, Landmark, Layers, Search, Wallet, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { AuthorizationScope, ScopeType } from '@/hooks/useOrganizationAuthorization';

const NHOM: { type: ScopeType; nhan: string; icon: React.ElementType }[] = [
  { type: 'ORGANIZATION', nhan: 'Toàn tổ chức', icon: Landmark },
  { type: 'AREA', nhan: 'Khu vực', icon: Layers },
  { type: 'BUILDING', nhan: 'Toà nhà', icon: Building2 },
  { type: 'CASHBOOK', nhan: 'Sổ quỹ', icon: Wallet },
];

export const SCOPE_ICON: Record<ScopeType, React.ElementType> = {
  ORGANIZATION: Landmark,
  AREA: Layers,
  BUILDING: Building2,
  CASHBOOK: Wallet,
};

/** Bỏ phần tiền tố loại khỏi nhãn máy chủ ("Toà: Nhà A" -> "Nhà A"). */
export const tenNgan = (label: string) => label.replace(/^(Toà|Khu vực|Sổ quỹ):\s*/, '');

interface Props {
  scopes: AuthorizationScope[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Chỉ cho chọn các loại này. Bỏ trống = cho tất cả. */
  allowedKinds?: ScopeType[];
  disabled?: boolean;
  className?: string;
}

export function ScopePicker({ scopes, value, onChange, allowedKinds, disabled, className }: Props) {
  const [tim, setTim] = useState('');

  const duocPhep = useMemo(
    () => (allowedKinds?.length ? scopes.filter((s) => allowedKinds.includes(s.scopeType)) : scopes),
    [scopes, allowedKinds],
  );

  const scopeOrg = duocPhep.find((s) => s.scopeType === 'ORGANIZATION');
  const dangToanTC = !!scopeOrg && value.includes(scopeOrg.scopeId);

  const loc = useMemo(() => {
    const q = tim.trim().toLowerCase();
    return q ? duocPhep.filter((s) => s.label.toLowerCase().includes(q)) : duocPhep;
  }, [duocPhep, tim]);

  const doi = (s: AuthorizationScope, bat: boolean) => {
    if (disabled) return;
    if (s.scopeType === 'ORGANIZATION') {
      // Toàn tổ chức là lựa chọn ĐỘC QUYỀN — máy chủ đòi đúng 1 cạnh.
      onChange(bat ? [s.scopeId] : []);
      return;
    }
    const conLai = value.filter((id) => id !== s.scopeId && id !== scopeOrg?.scopeId);
    onChange(bat ? [...conLai, s.scopeId] : conLai);
  };

  const chonHet = (type: ScopeType) => {
    const ids = duocPhep.filter((s) => s.scopeType === type).map((s) => s.scopeId);
    const conLai = value.filter((id) => !ids.includes(id) && id !== scopeOrg?.scopeId);
    onChange([...conLai, ...ids]);
  };

  if (!duocPhep.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Quyền này không áp theo phạm vi nào trong tổ chức của bạn.
      </p>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={tim}
            onChange={(e) => setTim(e.target.value)}
            placeholder="Tìm toà nhà, khu vực, sổ quỹ…"
            className="pl-8"
            disabled={disabled}
          />
        </div>
        {value.length > 0 && !disabled && (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>
            <X className="mr-1 h-4 w-4" />
            Bỏ chọn ({value.length})
          </Button>
        )}
      </div>

      <ScrollArea className="h-64 rounded-md border">
        <div className="space-y-4 p-3">
          {NHOM.map(({ type, nhan, icon: Icon }) => {
            const items = loc.filter((s) => s.scopeType === type);
            if (!items.length) return null;
            const moTat = type !== 'ORGANIZATION' && dangToanTC;
            return (
              <div key={type}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    {nhan}
                  </span>
                  {type !== 'ORGANIZATION' && items.length > 1 && !disabled && !moTat && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => chonHet(type)}
                    >
                      Chọn tất cả
                    </Button>
                  )}
                </div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {items.map((s) => {
                    const bat = value.includes(s.scopeId);
                    return (
                      <label
                        key={s.scopeId}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                          moTat || disabled
                            ? 'cursor-not-allowed opacity-45'
                            : 'cursor-pointer hover:bg-muted/60',
                          bat && 'bg-primary/5',
                        )}
                      >
                        <Checkbox
                          checked={bat}
                          disabled={disabled || moTat}
                          onCheckedChange={(c) => doi(s, c === true)}
                        />
                        <span className="truncate">
                          {s.scopeType === 'ORGANIZATION' ? 'Toàn tổ chức' : tenNgan(s.label)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!loc.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">Không tìm thấy phạm vi nào.</p>
          )}
        </div>
      </ScrollArea>

      {dangToanTC && (
        <p className="text-xs text-muted-foreground">
          Đang áp cho <strong>toàn tổ chức</strong> — bao gồm cả toà nhà và sổ quỹ thêm mới sau này.
          Bỏ chọn mục này nếu muốn giới hạn theo từng nơi.
        </p>
      )}
    </div>
  );
}

/** Tóm tắt phạm vi thành chuỗi ngắn cho thẻ/bảng. */
export function ScopeSummary({
  scopes,
  ids,
  max = 3,
}: {
  scopes: AuthorizationScope[];
  ids: string[];
  max?: number;
}) {
  const map = useMemo(() => new Map(scopes.map((s) => [s.scopeId, s])), [scopes]);
  const chon = ids.map((id) => map.get(id)).filter(Boolean) as AuthorizationScope[];
  if (!chon.length) return <span className="text-xs text-muted-foreground">chưa có phạm vi</span>;
  if (chon.some((s) => s.scopeType === 'ORGANIZATION')) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Landmark className="h-3 w-3" />
        Toàn tổ chức
      </Badge>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {chon.slice(0, max).map((s) => {
        const Icon = SCOPE_ICON[s.scopeType];
        return (
          <Badge key={s.scopeId} variant="outline" className="gap-1 font-normal">
            <Icon className="h-3 w-3" />
            {tenNgan(s.label)}
          </Badge>
        );
      })}
      {chon.length > max && (
        <Badge variant="outline" className="font-normal">
          +{chon.length - max}
        </Badge>
      )}
    </span>
  );
}
