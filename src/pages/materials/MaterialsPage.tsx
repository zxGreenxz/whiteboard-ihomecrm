import { useLocation, useNavigate } from 'react-router-dom';
import { Package, Receipt, ClipboardList } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import MaterialsListContent from '@/components/materials/MaterialsListContent';
import MaterialPurchasesContent from '@/components/materials/MaterialPurchasesContent';
import MaterialAdjustmentsContent from '@/components/materials/MaterialAdjustmentsContent';

type TabKey = 'list' | 'purchases' | 'adjustments';

const PATH_TO_TAB: Record<string, TabKey> = {
  '/materials': 'list',
  '/materials/purchases': 'purchases',
  '/materials/adjustments': 'adjustments',
};

const TAB_TO_PATH: Record<TabKey, string> = {
  list: '/materials',
  purchases: '/materials/purchases',
  adjustments: '/materials/adjustments',
};

export default function MaterialsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab: TabKey = PATH_TO_TAB[location.pathname] ?? 'list';

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Kho vật tư</h1>
          <p className="text-sm text-muted-foreground">
            Quản lý vòi nước, bóng đèn, ống nước, v.v. — tồn cập nhật tự động khi
            nhập/xuất theo phiếu công việc.
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => navigate(TAB_TO_PATH[v as TabKey])}>
          <TabsList>
            <TabsTrigger value="list" className="gap-1.5">
              <Package className="h-4 w-4" />
              Vật tư
            </TabsTrigger>
            <TabsTrigger value="purchases" className="gap-1.5">
              <Receipt className="h-4 w-4" />
              Phiếu nhập
            </TabsTrigger>
            <TabsTrigger value="adjustments" className="gap-1.5">
              <ClipboardList className="h-4 w-4" />
              Kiểm kê
            </TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="mt-4">
            <MaterialsListContent />
          </TabsContent>
          <TabsContent value="purchases" className="mt-4">
            <MaterialPurchasesContent />
          </TabsContent>
          <TabsContent value="adjustments" className="mt-4">
            <MaterialAdjustmentsContent />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
