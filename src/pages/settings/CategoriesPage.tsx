import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { List, Landmark, Package, Phone, FolderOpen, Layers, Wrench } from "lucide-react";
import { Link } from "react-router-dom";

interface CategoryItem {
  title: string;
  href: string;
  description: string;
}

interface CategoryGroup {
  title: string;
  icon: React.ElementType;
  items: CategoryItem[];
}

const CATEGORY_GROUPS: CategoryGroup[] = [
  {
    title: "Tài chính",
    icon: Landmark,
    items: [
      { title: "Tài khoản (sổ quỹ)", href: "/finance/cashbooks", description: "Quản lý tài khoản tiền mặt / ngân hàng / ví — đã chuyển sang VẬN HÀNH → Tài chính" },
      { title: "Gạch nợ tự động", href: "/settings/categories/auto-debt", description: "Cấu hình gạch nợ tự động" },
      { title: "Loại thu chi", href: "/settings/categories/income-expense-types", description: "Quản lý loại thu chi" },
      { title: "Định mức dịch vụ", href: "/settings/categories/service-quotas", description: "Quản lý định mức dịch vụ" },
      { title: "Đồng hồ công tơ", href: "/settings/meters", description: "Quản lý đồng hồ công tơ" },
    ],
  },
  {
    title: "Tài sản",
    icon: Package,
    items: [
      { title: "Nhà cung cấp", href: "/settings/categories/suppliers", description: "Quản lý nhà cung cấp" },
      { title: "Kho tài sản", href: "/settings/categories/warehouses", description: "Quản lý kho tài sản" },
      { title: "Loại tài sản", href: "/settings/categories/asset-types", description: "Quản lý loại tài sản" },
      { title: "Lịch sử di chuyển", href: "/settings/categories/asset-movements", description: "Xem lịch sử di chuyển tài sản" },
      { title: "Lịch sử sửa chữa", href: "/settings/categories/asset-maintenance", description: "Xem lịch sử sửa chữa tài sản" },
    ],
  },
];

const STANDALONE_ITEMS: CategoryItem[] = [
  { title: "Quản lý Hotline", href: "/settings/categories/hotlines", description: "Quản lý danh sách hotline" },
  { title: "Danh mục chung", href: "/settings/categories/general", description: "Quản lý danh mục chung" },
  { title: "Danh sách tầng", href: "/settings/categories/floors", description: "Quản lý danh sách tầng" },
  { title: "Loại công việc", href: "/settings/categories/task-types", description: "Quản lý loại công việc vận hành" },
];

const STANDALONE_ICONS: Record<string, React.ElementType> = {
  "Quản lý Hotline": Phone,
  "Danh mục chung": FolderOpen,
  "Danh sách tầng": Layers,
  "Loại công việc": Wrench,
};

export default function CategoriesPage() {
  return (
    <MainLayout title="Danh mục khác" subtitle="Quản lý các danh mục phụ trong hệ thống" icon={List}>
      <div className="space-y-6">
        {/* Grouped categories */}
        {CATEGORY_GROUPS.map((group) => (
          <Card key={group.title}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <group.icon className="h-5 w-5" />
                {group.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="flex flex-col gap-1 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <span className="font-medium">{item.title}</span>
                    <span className="text-sm text-muted-foreground">{item.description}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}

        {/* Standalone items */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Khác</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {STANDALONE_ITEMS.map((item) => {
                const Icon = STANDALONE_ICONS[item.title] || FolderOpen;
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="flex items-center gap-3 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <Icon className="h-5 w-5 text-muted-foreground" />
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{item.title}</span>
                      <span className="text-sm text-muted-foreground">{item.description}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
