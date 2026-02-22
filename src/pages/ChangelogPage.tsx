import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";

interface ChangelogEntry {
  version: string;
  date: string;
  type: "major" | "minor" | "patch";
  changes: string[];
}

const changelog: ChangelogEntry[] = [
  {
    version: "1.0.0",
    date: "2025-01-15",
    type: "major",
    changes: [
      "Ra mắt phiên bản chính thức iHomeCRM Resident",
      "Đồng bộ toàn bộ giao diện với tài liệu hướng dẫn",
      "Đổi thuật ngữ: Phòng → Căn hộ, Sự cố → Công việc, Leads → Khách hẹn",
      "Tái cấu trúc Sidebar theo SUMMARY.md",
      "Bổ sung Sơ đồ toà nhà với mã màu trạng thái",
      "Bổ sung module Danh mục khác (14 danh mục con)",
      "Bổ sung 8 báo cáo BĐS, 8 báo cáo Tài chính, 3 báo cáo Công việc",
      "Cài đặt chung 5 tabs: Cơ bản, Hợp đồng, Hóa đơn, Thu chi, Thông báo",
      "Bổ sung trang Tài khoản: Thông tin cá nhân, Gói cước",
      "Hỗ trợ ký hợp đồng điện tử",
      "Onboarding wizard cho người dùng mới",
      "Cải thiện UX: Empty states, Tooltips, Breadcrumbs",
    ],
  },
  {
    version: "0.9.0",
    date: "2024-12-01",
    type: "minor",
    changes: [
      "Bổ sung quản lý phương tiện",
      "Cải thiện trang hóa đơn với bộ lọc nâng cao",
      "Bổ sung tính năng xuất báo cáo Excel/PDF",
      "Sửa lỗi hiển thị trên thiết bị di động",
    ],
  },
  {
    version: "0.8.0",
    date: "2024-11-01",
    type: "minor",
    changes: [
      "Bổ sung quản lý đặt cọc",
      "Bổ sung quản lý giường (dorm)",
      "Cải thiện Dashboard với biểu đồ doanh thu",
      "Bổ sung hệ thống thông báo",
    ],
  },
];

const typeBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  major: "default",
  minor: "secondary",
  patch: "outline",
};

const typeLabel: Record<string, string> = {
  major: "Phiên bản lớn",
  minor: "Cập nhật",
  patch: "Sửa lỗi",
};

export default function ChangelogPage() {
  return (
    <MainLayout
      title="Lịch sử cập nhật"
      subtitle="Theo dõi các thay đổi và cải tiến của hệ thống"
      icon={History}
    >
      <div className="max-w-3xl space-y-4">
        {changelog.map((entry) => (
          <Card key={entry.version}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-3">
                  <span>v{entry.version}</span>
                  <Badge variant={typeBadgeVariant[entry.type]}>
                    {typeLabel[entry.type]}
                  </Badge>
                </CardTitle>
                <span className="text-sm text-muted-foreground">
                  {new Date(entry.date).toLocaleDateString("vi-VN")}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                {entry.changes.map((change, i) => (
                  <li key={i}>{change}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </MainLayout>
  );
}
