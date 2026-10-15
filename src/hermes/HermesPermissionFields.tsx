import { useMemo } from 'react';
import { PermissionPicker } from '@/components/authorization/PermissionPicker';
import { ScopePicker } from '@/components/authorization/ScopePicker';
import type { AuthorizationScope } from '@/hooks/useOrganizationAuthorization';
import { VISIBLE_PAGE_GROUPS, featureKey } from '@/lib/permissionPages';
import type { HermesConnectionRestrictions } from './connectionClient';

const catalog = new Set(VISIBLE_PAGE_GROUPS.flatMap(group => group.pages.flatMap(page => page.features.map(featureKey))));
const label = (key: string) => ({ 'assistant.context.read': 'Xem thông tin phiên và quyền của tôi', 'assistant.memory.read': 'Xem ghi nhớ công việc CRM được phép', 'assistant.memory.write': 'Lưu, sửa và quên ghi nhớ công việc CRM của tôi' } as Record<string, string>)[key] ?? key;
interface Props {
  value: HermesConnectionRestrictions; scopeIds: string[];
  readChoices: string[]; actionChoices?: string[]; scopes: AuthorizationScope[];
  onChange: (value: HermesConnectionRestrictions, scopeIds: string[]) => void;
  disabled?: boolean; effective?: HermesConnectionRestrictions;
}

/** Choices only narrow the fixed server response; shared pickers do not define
 * authority. Unknown existing scope IDs are retained unless explicitly removed. */
export function HermesPermissionFields({ value, scopeIds, readChoices, actionChoices = [], scopes, onChange, disabled, effective }: Props) {
  const choices = useMemo(() => ({ read: new Set(readChoices), action: new Set(actionChoices) }), [readChoices, actionChoices]);
  const allowedScopes = useMemo(() => new Set(scopes.map(scope => scope.scopeId)), [scopes]);
  const unknownScopes = scopeIds.filter(id => !allowedScopes.has(id));
  const change = (kind: 'read' | 'action', keys: string[], enabled: boolean) => {
    if (disabled) return;
    const allowed = keys.filter(key => choices[kind].has(key));
    const next = enabled ? [...new Set([...value[kind], ...allowed])] : value[kind].filter(key => !allowed.includes(key));
    onChange({ ...value, [kind]: next }, scopeIds);
  };
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Đây là giới hạn riêng của Hermes. Quyền CRM của bạn không thay đổi; Hermes chỉ dùng phần giao với quyền hiện tại và chính sách công ty.</p>
    <div className="grid gap-4 md:grid-cols-2">
      {(['read', 'action'] as const).map(kind => {
        const visible = new Set([...choices[kind]].filter(key => catalog.has(key)));
        const trailing = (key: string) => effective && <span className="text-xs text-muted-foreground">{effective[kind].includes(key) ? 'Đang có hiệu lực' : 'Hiện chưa có hiệu lực'}</span>;
        return <fieldset disabled={disabled} key={kind} className="min-w-0 space-y-3 rounded-lg border p-3">
          <legend className="px-1 font-medium">{kind === 'read' ? 'Đọc dữ liệu' : 'Thao tác dữ liệu'}</legend>
          {kind === 'action' && <p className="text-sm text-muted-foreground">Quyền đọc và thao tác được chọn độc lập. Gửi dữ liệu cần cả quyền đọc dữ liệu đó và quyền gửi tương ứng.</p>}
          {kind === 'action' && choices.action.has('tasks.create') && <p className="text-sm text-muted-foreground">Tạo và giao công việc được ghi dưới tài khoản của bạn. Người nhận là người thực hiện, không thay người tạo.</p>}
          {choices[kind].size === 0 && <p className="text-sm text-muted-foreground">{kind === 'read' ? 'Chưa có quyền đọc được phép cấp.' : 'Chưa cấp quyền thao tác.'}</p>}
          {[...choices[kind]].filter(key => !catalog.has(key)).map(key => <label key={key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={value[kind].includes(key)} disabled={disabled}
              onChange={event => change(kind, [key], event.target.checked)} />
            <span>{label(key)}<span className="block">{trailing(key)}</span></span>
          </label>)}
          {visible.size > 0 && <PermissionPicker value={new Set(value[kind])} availableKeys={choices[kind]} visibleKeys={visible}
            onToggle={(key, enabled) => change(kind, [key], enabled)} onToggleMany={(keys, enabled) => change(kind, keys, enabled)}
            disabled={disabled} renderTrailing={trailing} height="h-[240px]" />}
        </fieldset>;
      })}
    </div>
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 font-medium">Phạm vi dữ liệu CRM</legend>
      <p className="text-sm text-muted-foreground">Chọn trong phạm vi công ty cho phép. Hermes vẫn kiểm quyền CRM hiện tại đối với từng loại dữ liệu và tòa nhà.</p>
      {scopes.length > 0 ? <ScopePicker scopes={scopes} value={scopeIds.filter(id => allowedScopes.has(id))} disabled={disabled}
        onChange={next => { if (!disabled && next.every(id => allowedScopes.has(id))) onChange(value, [...unknownScopes, ...next]); }} />
        : <p className="text-sm text-muted-foreground">Chưa có phạm vi CRM được phép chọn.</p>}
      {unknownScopes.map(id => <label key={id} className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked disabled={disabled} onChange={() => { if (!disabled) onChange(value, scopeIds.filter(scope => scope !== id)); }} />
        <span>Phạm vi đã lưu …{id.slice(-8)} <span className="block text-xs text-muted-foreground">Chưa có trong danh sách phạm vi hiện tại. Bạn có thể bỏ chọn để thu hẹp.</span></span>
      </label>)}
    </fieldset>
  </div>;
}
