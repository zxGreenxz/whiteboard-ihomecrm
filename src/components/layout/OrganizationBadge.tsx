import { Building, TriangleAlert } from 'lucide-react';

import { useOrganization } from '@/contexts/OrganizationContext';

/**
 * Nhãn "đang xem sổ của công ty nào" trên thanh đầu trang — phần nhìn thấy được
 * của GĐ9.
 *
 * BA TRẠNG THÁI, và chỉ hai trong số đó vẽ ra gì:
 *
 *   đang nạp            → không vẽ. Nhấp nháy một khung xám rồi thay bằng tên
 *                          công ty gây chú ý vào đúng thứ không đáng chú ý.
 *   đúng MỘT tổ chức    → không vẽ. Nhãn không mang thông tin nào khi không có
 *                          gì để phân biệt; nó chỉ chiếm chỗ trên màn hình hẹp.
 *   nhiều tổ chức       → VẼ tên tổ chức đang xem. Đây là lúc nhầm sổ công ty
 *                          này với công ty kia là lỗi nghiệp vụ thật.
 *   không tổ chức nào   → VẼ cảnh báo. Tài khoản không có membership ACTIVE sẽ
 *                          thấy màn hình trống rỗng ở gần như mọi trang vì RLS
 *                          lọc sạch; không nói ra thì người dùng tưởng hệ thống
 *                          hỏng. Trạng thái này có thật: sau khi xoá hai tổ chức
 *                          Test/Demo, 6 tài khoản demo.* rơi vào đúng đây.
 */
export default function OrganizationBadge() {
  const { organization, isMultiOrg, isLoading, isOrphan } = useOrganization();

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

  if (!isMultiOrg || !organization) return null;

  return (
    <div
      className="hidden md:flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1"
      title={`Đang xem dữ liệu của: ${organization.name}`}
    >
      <Building className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="max-w-[14rem] truncate text-xs font-medium">{organization.name}</span>
    </div>
  );
}
