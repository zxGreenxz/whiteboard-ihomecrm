import { useState } from "react";
import { Share2, SlidersHorizontal, Image as ImageIcon, LayoutGrid } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ShareTokensTab from "@/components/sale-phong/ShareTokensTab";
import DisplaySettingsTab from "@/components/sale-phong/DisplaySettingsTab";
import SaleImagesTab from "@/components/sale-phong/SaleImagesTab";
import FloorPlanEditorTab from "@/components/sale-phong/floor-editor/FloorPlanEditorTab";

type TabKey = "tokens" | "settings" | "images" | "floorplan";

/**
 * Trang quản trị "SALE PHÒNG": vận hành trang công khai "Phòng trống" (/r/:token).
 * 4 tab: Link chia sẻ · Cài đặt hiển thị · Hình ảnh sale · Sơ đồ tòa nhà.
 * Owner-scoped (token + settings RLS theo auth.uid).
 */
export default function SalePhongPage() {
  const [tab, setTab] = useState<TabKey>("tokens");

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

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="tokens" className="gap-1.5">
              <Share2 className="h-4 w-4" />Link chia sẻ
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              <SlidersHorizontal className="h-4 w-4" />Cài đặt hiển thị
            </TabsTrigger>
            <TabsTrigger value="images" className="gap-1.5">
              <ImageIcon className="h-4 w-4" />Hình ảnh sale
            </TabsTrigger>
            <TabsTrigger value="floorplan" className="gap-1.5">
              <LayoutGrid className="h-4 w-4" />Sơ đồ tòa nhà
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tokens" className="mt-4"><ShareTokensTab /></TabsContent>
          <TabsContent value="settings" className="mt-4"><DisplaySettingsTab /></TabsContent>
          <TabsContent value="images" className="mt-4"><SaleImagesTab /></TabsContent>
          <TabsContent value="floorplan" className="mt-4"><FloorPlanEditorTab /></TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
