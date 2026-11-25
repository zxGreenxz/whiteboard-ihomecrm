import { Suspense, lazy, useMemo, useState } from "react";
import { Share2, SlidersHorizontal, Info, LayoutGrid, Repeat, BarChart3, ClipboardList } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ShareTokensTab from "@/components/sale-phong/ShareTokensTab";
import DisplaySettingsTab from "@/components/sale-phong/DisplaySettingsTab";
import SaleImagesTab from "@/components/sale-phong/SaleImagesTab";
import PassListingsTab from "@/components/sale-phong/PassListingsTab";
import FloorPlanEditorTab from "@/components/sale-phong/floor-editor/FloorPlanEditorTab";
import AnalyticsTab from "@/components/sale-phong/AnalyticsTab";
import SaleRoomWorkspace from "@/components/sale-phong/SaleRoomWorkspace";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";

type TabKey = "rooms" | "tokens" | "settings" | "images" | "pass" | "floorplan" | "analytics";

const SalePhongMobilePage = lazy(() => import("./SalePhongMobilePage"));

/**
 * Entry "SALE PHÒNG" — branch theo viewport (giống CustomersPage):
 * điện thoại → SalePhongMobilePage (shell .cm-*), còn lại → bản desktop dưới đây.
 */
export default function SalePhongPage() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <SalePhongMobilePage />
      </Suspense>
    );
  }
  return <SalePhongDesktopPage />;
}

/**
 * Trang quản trị "SALE PHÒNG": vận hành trang công khai "Phòng trống" (/r/:token).
 * Bảng cập nhật dùng quyền từng phòng từ máy chủ; các tab cấu hình giữ quyền riêng.
 * Mỗi tab gate theo quyền chi tiết sale_phong.* (fallback legacy: sale_phong.edit).
 */
function SalePhongDesktopPage() {
  const { data: perms } = useMyPermissions();

  const tabs = useMemo(
    () =>
      [
        { key: "rooms" as TabKey, allowed: true },
        { key: "tokens" as TabKey, allowed: canUse(perms, "sale_phong", "manage_tokens") },
        { key: "settings" as TabKey, allowed: canUse(perms, "sale_phong", "manage_settings") },
        { key: "images" as TabKey, allowed: canUse(perms, "sale_phong", "manage_images") },
        { key: "pass" as TabKey, allowed: canUse(perms, "sale_phong", "manage_pass_listings") },
        { key: "floorplan" as TabKey, allowed: canUse(perms, "sale_phong", "edit_floor_plan") },
        { key: "analytics" as TabKey, allowed: canUse(perms, "sale_phong", "view_analytics") },
      ].filter((t) => t.allowed),
    [perms],
  );

  const [tab, setTab] = useState<TabKey>("rooms");
  const [tabBusy, setTabBusy] = useState(false);
  // Tab đang mở còn bản sửa chưa lưu (sơ đồ toà, thông tin sale): đổi tab là mất bản đó nên hỏi trước.
  const [tabDirty, setTabDirty] = useState(false);
  const activeTab = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;
  const changeTab = (next: string) => {
    if (tabBusy || next === activeTab) return;
    if (tabDirty && !window.confirm("Tab đang mở còn thay đổi chưa lưu. Bỏ các thay đổi này và chuyển tab?")) return;
    setTabDirty(false);
    setTab(next as TabKey);
  };

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Sale Phòng</h1>
          <p className="text-sm text-muted-foreground">
            Cập nhật tình trạng, giá, ảnh và chính sách từng phòng; quản lý link phòng trống gửi sale và khách.
          </p>
        </div>

        {/* Tab "Cập nhật phòng" luôn có (quyền từng phòng do máy chủ trả) nên danh sách tab không bao giờ rỗng. */}
        <Tabs value={activeTab} onValueChange={changeTab}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger disabled={tabBusy} value="rooms" className="gap-1.5"><ClipboardList className="h-4 w-4" />Cập nhật phòng</TabsTrigger>
            {tabs.some((t) => t.key === "tokens") && (
              <TabsTrigger disabled={tabBusy} value="tokens" className="gap-1.5">
                <Share2 className="h-4 w-4" />Link chia sẻ
              </TabsTrigger>
            )}
            {tabs.some((t) => t.key === "settings") && (
              <TabsTrigger disabled={tabBusy} value="settings" className="gap-1.5">
                <SlidersHorizontal className="h-4 w-4" />Cài đặt hiển thị
              </TabsTrigger>
            )}
            {tabs.some((t) => t.key === "images") && (
              <TabsTrigger disabled={tabBusy} value="images" className="gap-1.5">
                <Info className="h-4 w-4" />Thông tin sale
              </TabsTrigger>
            )}
            {tabs.some((t) => t.key === "pass") && (
              <TabsTrigger disabled={tabBusy} value="pass" className="gap-1.5">
                <Repeat className="h-4 w-4" />Khách nhờ sale
              </TabsTrigger>
            )}
            {tabs.some((t) => t.key === "floorplan") && (
              <TabsTrigger disabled={tabBusy} value="floorplan" className="gap-1.5">
                <LayoutGrid className="h-4 w-4" />Sơ đồ tòa nhà
              </TabsTrigger>
            )}
            {tabs.some((t) => t.key === "analytics") && (
              <TabsTrigger disabled={tabBusy} value="analytics" className="gap-1.5">
                <BarChart3 className="h-4 w-4" />Thống kê
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="rooms" className="mt-4"><SaleRoomWorkspace onBusyChange={setTabBusy} /></TabsContent>
          <TabsContent value="tokens" className="mt-4"><ShareTokensTab /></TabsContent>
          <TabsContent value="settings" className="mt-4"><DisplaySettingsTab onBusyChange={setTabBusy} /></TabsContent>
          <TabsContent value="images" className="mt-4"><SaleImagesTab onBusyChange={setTabBusy} onDirtyChange={setTabDirty} /></TabsContent>
          <TabsContent value="pass" className="mt-4"><PassListingsTab /></TabsContent>
          <TabsContent value="floorplan" className="mt-4"><FloorPlanEditorTab onDirtyChange={setTabDirty} /></TabsContent>
          <TabsContent value="analytics" className="mt-4"><AnalyticsTab /></TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
