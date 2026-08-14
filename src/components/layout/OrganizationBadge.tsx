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

/**
 * Nhãn "đang xem sổ của công ty nào" trên thanh đầu trang — phần nhìn thấy được
 * của GĐ9, và từ 14/08/2026 là cả chỗ CHỌN công ty.
 *
 * BỐN TRẠNG THÁI:
 *
 *   đang nạp            → không vẽ. Nhấp nháy một khung xám rồi thay bằng tên
 *                          công ty gây chú ý vào đúng thứ không đáng chú ý.
 *   đúng MỘT tổ chức    → không vẽ. Nhãn không mang thông tin nào khi không có
 *                          gì để phân biệt; nó chỉ chiếm chỗ trên màn hình hẹp.
 *   nhiều tổ chức       → VẼ tên tổ chức đang xem, kèm ô đổi. Đây là lúc nhầm sổ
 *                          công ty này với công ty kia là lỗi nghiệp vụ thật.
 *   không tổ chức nào   → VẼ cảnh báo. Tài khoản không có membership ACTIVE sẽ
 *                          thấy màn hình trống rỗng ở gần như mọi trang vì RLS
 *                          lọc sạch; không nói ra thì người dùng tưởng hệ thống
 *                          hỏng. Trạng thái này có thật: sau khi xoá hai tổ chức
 *                          Test/Demo, 6 tài khoản demo.* rơi vào đúng đây.
 *
 * TRẠNG THÁI THỨ NĂM, MỚI: nhiều tổ chức mà CHƯA CHỌN.
 *   Trước đây không tồn tại vì context tự lấy `organizations[0]`. Nay lựa chọn
 *   phải tường minh, nên có một khoảng người dùng chưa chốt — và khoảng đó phải
 *   NHÌN THẤY ĐƯỢC. Vẽ nhãn hổ phách kèm lời nhắc: mọi công cụ có phạm vi công
 *   ty sẽ từ chối chạy cho tới khi chọn, nên im lặng ở đây sẽ biến thành một
 *   chuỗi lỗi khó hiểu ở chỗ khác.
 */
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
        className="hidden md:flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1"
        title="Tài khoản này chưa thuộc công ty nào nên hầu hết dữ liệu sẽ trống. Liên hệ quản trị viên để được thêm vào công ty."
      >
        <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
        <span className="text-xs font-medium text-amber-800">Chưa thuộc công ty nào</span>
      </div>
    );
  }

  if (!isMultiOrg) return null;

  const chuaChon = canChonToChuc || !organization;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="organization-badge"
          className={
            chuaChon
              ? 'hidden md:flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1'
              : 'hidden md:flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1'
          }
          title={
            chuaChon
              ? 'Bạn thuộc nhiều công ty. Chọn công ty để xem đúng sổ — các công cụ theo công ty sẽ từ chối chạy cho tới khi chọn.'
              : `Đang xem dữ liệu của: ${organization!.name}`
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
              <span className="max-w-[14rem] truncate text-xs font-medium">{organization!.name}</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Đang xem sổ của công ty
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
