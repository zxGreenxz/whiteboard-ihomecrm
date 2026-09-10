import { Building, Check, ChevronDown, TriangleAlert } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useOrganization } from '@/contexts/OrganizationContext';

/** Visible company context on desktop and mobile, including a single membership. */
export default function OrganizationBadge() {
  const {
    organization,
    organizations,
    selectedOrganizationId,
    selectOrganization,
    isMultiOrg,
    isLoading,
    isOrphan,
    canChonToChuc,
  } = useOrganization();

  if (isLoading) return null;

  if (isOrphan) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1"
        title="Tài khoản này chưa thuộc công ty nào nên hầu hết dữ liệu sẽ trống. Liên hệ quản trị viên để được thêm vào công ty."
      >
        <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
        <span className="text-xs font-medium text-amber-800">Chưa thuộc công ty nào</span>
      </div>
    );
  }

  if (!isMultiOrg && !organization) return null;

  const chuaChon = canChonToChuc || !organization;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="organization-badge"
          className={
            chuaChon
              ? 'flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1'
              : 'flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1'
          }
          title={
            chuaChon
              ? 'Bạn thuộc nhiều công ty. Chọn công ty làm việc — các công cụ theo công ty sẽ từ chối chạy cho tới khi chọn.'
              : `Công ty làm việc: ${organization!.name}`
          }
        >
          {chuaChon ? (
            <>
              <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
              <span className="text-xs font-medium text-amber-800">Chọn công ty</span>
            </>
          ) : (
            <>
              <Building className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[8rem] sm:max-w-[14rem] truncate text-xs font-medium">{organization!.name}</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Công ty làm việc
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={() => selectOrganization(o.id)}
            className="gap-2"
          >
            <Check
              className={
                o.id === selectedOrganizationId
                  ? 'h-3.5 w-3.5 shrink-0'
                  : 'h-3.5 w-3.5 shrink-0 opacity-0'
              }
            />
            <span className="truncate">{o.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
