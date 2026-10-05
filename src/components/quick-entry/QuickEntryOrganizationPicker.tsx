import { useOrganization } from '@/contexts/OrganizationContext';

/** Personal records remain account-owned; AI uses the selected company's authorized service context. */
export function QuickEntryOrganizationPicker() {
  const org = useOrganization();
  if (org.selectedOrganizationId && !org.preferenceError) return null;
  return (
    <div className="space-y-2 px-1 py-2 text-sm">
      {org.preferenceError && <p role="status" className="text-amber-800">{org.preferenceError}</p>}
      {!org.selectedOrganizationId && (
        org.isLoading ? <p role="status">Đang khôi phục công ty đã chọn…</p> :
        org.organizations.length > 0 ? <label className="block space-y-1">
          <span>Chọn công ty để dùng AI. Khoản cá nhân vẫn lưu vào ví cá nhân.</span>
          <select aria-label="Công ty dùng AI" value="" className="h-11 w-full rounded-xl border bg-background px-3" onChange={e => org.selectOrganization(e.target.value)}>
            <option value="" disabled>Chọn công ty</option>
            {org.organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label> : <p role="status">{org.isError ? 'Chưa tải được công ty để dùng AI.' : 'Chưa có công ty để dùng AI. Bạn vẫn có thể nhập tay.'}</p>
      )}
      {(org.isError || org.preferenceError) && <button type="button" className="text-primary underline" onClick={() => void org.refetchOrganizations()}>Thử lại</button>}
    </div>
  );
}
