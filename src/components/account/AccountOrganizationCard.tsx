import { useId } from 'react';
import { Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrganization } from '@/contexts/OrganizationContext';
import { InlineSkeleton } from '@/components/loading/LoadingState';

/** Cùng lựa chọn với Copilot; đổi tại Tài khoản lưu theo tài khoản và giữ cache trên thiết bị. */
export default function AccountOrganizationCard({ variant = 'desktop' }: { variant?: 'desktop' | 'mobile' }) {
  const id = useId();
  const mobile = variant === 'mobile';
  const {
    organizations, selectedOrganizationId, selectOrganization,
    isLoading, isError, isOrphan, refetchOrganizations, preferenceError,
  } = useOrganization();
  const placeholder = isError ? 'Chưa tải được công ty' : isOrphan ? 'Chưa có công ty' : 'Chọn công ty';
  // Đang nạp danh sách công ty: ô chọn để trống kèm vạch xám trong ô, không chữ
  // "Đang tải…" (chủ chốt 02/10/2026); câu đó chỉ còn cho trình đọc màn hình.
  const loadingBar = <InlineSkeleton label="công ty" width="9rem" />;
  const disabled = isLoading || isError || organizations.length === 0;
  const helpId = `${id}-help`;
  const content = (
    <div className={mobile ? 'ff' : 'space-y-2'}>
      <Label htmlFor={id} className={mobile ? 'ff-lbl' : undefined}>Công ty đang chọn</Label>
      {mobile ? (
        <div className="relative">
          <select
            id={id}
            className="ff-input"
            value={selectedOrganizationId ?? ''}
            onChange={(event) => selectOrganization(event.target.value)}
            disabled={disabled}
            aria-describedby={helpId}
            data-testid="account-organization-select"
          >
            <option value="" disabled>{isLoading ? '' : placeholder}</option>
            {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select>
          {isLoading && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">{loadingBar}</span>
          )}
        </div>
      ) : (
        <Select value={selectedOrganizationId ?? ''} onValueChange={selectOrganization} disabled={disabled}>
          <SelectTrigger id={id} aria-describedby={helpId} data-testid="account-organization-select">
            <SelectValue placeholder={isLoading ? loadingBar : placeholder} />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((org) => <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <p id={helpId} className="mt-2 text-sm text-muted-foreground" role={isError || preferenceError ? 'alert' : undefined}>
        {isError
          ? 'Chưa tải được danh sách công ty. Lựa chọn đã lưu vẫn được giữ lại.'
          : preferenceError
            ? preferenceError
            : isOrphan
              ? 'Tài khoản chưa có công ty khả dụng. Liên hệ quản trị viên để được cấp quyền.'
            : 'Copilot dùng công ty đang chọn. Lựa chọn tự lưu theo tài khoản và được giữ khi đăng xuất, mở lại web hoặc đăng nhập trên thiết bị khác, cho đến khi bạn đổi công ty.'}
      </p>
      {(isError || preferenceError) && <Button type="button" variant="outline" size="sm" onClick={() => void refetchOrganizations()}>Thử lại</Button>}
    </div>
  );

  if (mobile) return (
    <div className="cd-card" data-testid="account-organization-card">
      <div className="cd-card-h"><div className="cd-card-t"><Building2 size={17} />Công ty làm việc</div></div>
      {content}
    </div>
  );

  return (
    <Card data-testid="account-organization-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" />Công ty làm việc</CardTitle></CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
