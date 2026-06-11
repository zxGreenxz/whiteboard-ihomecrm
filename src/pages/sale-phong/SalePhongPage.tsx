import { useMemo, useState } from "react";
import { Share2, SlidersHorizontal, Image as ImageIcon, LayoutGrid } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ShareTokensTab from "@/components/sale-phong/ShareTokensTab";
import DisplaySettingsTab from "@/components/sale-phong/DisplaySettingsTab";
import SaleImagesTab from "@/components/sale-phong/SaleImagesTab";
import FloorPlanEditorTab from "@/components/sale-phong/floor-editor/FloorPlanEditorTab";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";

type TabKey = "tokens" | "settings" | "images" | "floorplan";

/**
 * Trang quản trị "SALE PHÒNG": vận hành trang công khai "Phòng trống" (/r/:token).
 * 4 tab: Link chia sẻ · Cài đặt hiển thị · Hình ảnh sale · Sơ đồ tòa nhà.
 * Mỗi tab gate theo quyền chi tiết sale_phong.* (fallback legacy: sale_phong.edit).
 */
export default function SalePhongPage() {
  const { data: perms } = useMyPermissions();

  const tabs = useMemo(
    () =>
      [
        { key: "tokens" as TabKey, allowed: canUse(perms, "sale_phong", "manage_tokens") },
        { key: "settings" as TabKey, allowed: canUse(perms, "sale_phong", "manage_settings") },
        { key: "images" as TabKey, allowed: canUse(perms, "sale_phong", "manage_images") },
        { key: "floorplan" as TabKey, allowed: canUse(perms, "sale_phong", "edit_floor_plan") },
      ].filter((t) => t.allowed),
    [perms],
  );

  const [tab, setTab] = useState<TabKey>("tokens");
  const activeTab = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Sale Phòng</h1>
          <p className="text-sm text-muted-foreground">
            Quản lý trang công khai "Phòng trống": tạo link chia sẻ, cài đặt hiển thị,
            hình ảnh sale và sơ đồ tọa độ từng tầng.
          </p>
        </div>

        {tabs.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            Bạn chỉ có quyền xem trang này — chưa được cấp quyền quản lý link chia sẻ,
            cài đặt, hình ảnh hay sơ đồ. Liên hệ quản trị viên nếu cần thêm quyền.
          </p>
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabKey)}>
            <TabsList className="flex-wrap h-auto">
              {tabs.some((t) => t.key === "tokens") && (
                <TabsTrigger value="tokens" className="gap-1.5">
                  <Share2 className="h-4 w-4" />Link chia sẻ
                </TabsTrigger>
              )}
              {tabs.some((t) => t.key === "settings") && (
                <TabsTrigger value="settings" className="gap-1.5">
                  <SlidersHorizontal className="h-4 w-4" />Cài đặt hiển thị
                </TabsTrigger>
              )}
              {tabs.some((t) => t.key === "images") && (
                <TabsTrigger value="images" className="gap-1.5">
                  <ImageIcon className="h-4 w-4" />Hình ảnh sale
                </TabsTrigger>
              )}
              {tabs.some((t) => t.key === "floorplan") && (
                <TabsTrigger value="floorplan" className="gap-1.5">
                  <LayoutGrid className="h-4 w-4" />Sơ đồ tòa nhà
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="tokens" className="mt-4"><ShareTokensTab /></TabsContent>
            <TabsContent value="settings" className="mt-4"><DisplaySettingsTab /></TabsContent>
            <TabsContent value="images" className="mt-4"><SaleImagesTab /></TabsContent>
            <TabsContent value="floorplan" className="mt-4"><FloorPlanEditorTab /></TabsContent>
          </Tabs>
        )}
      </div>
    </MainLayout>
  );
}
