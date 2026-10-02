import { useCopilotPageContext } from '@/hooks/useCopilotPageContext';
import { memo, useCallback, useMemo, useState } from "react";
import { Plus, Search, FileText, ArrowRightLeft, Wrench, Package } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { VirtualTable, type MeasureRef } from "@/components/ui/virtual-table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAssets,
  useAssetMovements,
  useAssetMaintenance,
  filterAssets,
  summarizeAssets,
  type AssetWithRelations,
  type AssetMovementWithRelations,
  type AssetMaintenanceWithRelations,
} from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { CreateAssetDialog } from "@/components/assets/CreateAssetDialog";
import { EditAssetDialog } from "@/components/assets/EditAssetDialog";
import { AssetHandoverDialog } from "@/components/assets/AssetHandoverDialog";
import { AssetMovementDialog } from "@/components/assets/AssetMovementDialog";
import { AssetMaintenanceDialog } from "@/components/assets/AssetMaintenanceDialog";
import { formatCurrency } from "@/lib/utils";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { usePersistedState } from "@/hooks/usePersistedState";
import { QueryRegion } from '@/components/errors/QueryRegion';
import { InlineSkeleton } from '@/components/loading/LoadingState';

const CONDITION_CONFIG = {
  NEW: { label: "Mới", color: "bg-green-100 text-green-800" },
  GOOD: { label: "Tốt", color: "bg-blue-100 text-blue-800" },
  FAIR: { label: "Khá", color: "bg-yellow-100 text-yellow-800" },
  POOR: { label: "Kém", color: "bg-orange-100 text-orange-800" },
  BROKEN: { label: "Hỏng", color: "bg-red-100 text-red-800" },
};

const MAINTENANCE_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Chờ xử lý", color: "bg-yellow-100 text-yellow-800" },
  IN_PROGRESS: { label: "Đang xử lý", color: "bg-blue-100 text-blue-800" },
  COMPLETED: { label: "Hoàn thành", color: "bg-green-100 text-green-800" },
};

interface AssetRowProps {
  asset: AssetWithRelations;
  index: number;
  measureRef: MeasureRef | undefined;
  onEdit: (asset: AssetWithRelations) => void;
}

/**
 * Một dòng tài sản — memo: gõ tìm kiếm chỉ dựng lại dòng vào/ra cửa sổ ảo
 * hoá, dòng còn nguyên (cùng object, cùng callback) bỏ qua.
 */
const AssetRow = memo(function AssetRow({ asset, index, measureRef, onEdit }: AssetRowProps) {
  const condition = CONDITION_CONFIG[asset.condition as keyof typeof CONDITION_CONFIG];
  return (
    <TableRow ref={measureRef} data-index={index}>
      <TableCell className="font-mono">{asset.code || "-"}</TableCell>
      <TableCell className="font-medium">{asset.name}</TableCell>
      <TableCell>{asset.category?.name || "-"}</TableCell>
      <TableCell>{asset.quantity || 1}</TableCell>
      <TableCell className="font-semibold">
        {formatCurrency((asset.purchase_price || 0) * (asset.quantity || 1))}
      </TableCell>
      <TableCell>
        <Badge className={condition?.color || ""}>{condition?.label || asset.condition}</Badge>
      </TableCell>
      <TableCell>
        {asset.building?.name || "-"}
        {asset.room && ` - ${asset.room.name}`}
      </TableCell>
      <TableCell>{asset.supplier?.name || "-"}</TableCell>
      <TableCell>{asset.purchase_date || "-"}</TableCell>
      <TableCell>
        <Button size="sm" variant="outline" onClick={() => onEdit(asset)}>
          Sửa
        </Button>
      </TableCell>
    </TableRow>
  );
});

interface MovementRowProps {
  m: AssetMovementWithRelations;
  index: number;
  measureRef: MeasureRef | undefined;
}

const MovementRow = memo(function MovementRow({ m, index, measureRef }: MovementRowProps) {
  return (
    <TableRow ref={measureRef} data-index={index}>
      <TableCell>{m.movement_date || "-"}</TableCell>
      <TableCell className="font-medium">
        {m.asset?.code ? `[${m.asset.code}] ` : ""}
        {m.asset?.name || "-"}
      </TableCell>
      <TableCell>
        {m.from_room
          ? `${m.from_room.building?.name || ""} - ${m.from_room.name}`
          : m.from_location || "Kho"}
      </TableCell>
      <TableCell>
        {m.to_room
          ? `${m.to_room.building?.name || ""} - ${m.to_room.name}`
          : m.to_location || "-"}
      </TableCell>
      <TableCell>{m.quantity || 1}</TableCell>
      <TableCell>{m.reason || "-"}</TableCell>
    </TableRow>
  );
});

interface MaintenanceRowProps {
  rec: AssetMaintenanceWithRelations;
  index: number;
  measureRef: MeasureRef | undefined;
}

const MaintenanceRow = memo(function MaintenanceRow({ rec, index, measureRef }: MaintenanceRowProps) {
  const status = MAINTENANCE_STATUS_CONFIG[rec.status as string];
  return (
    <TableRow ref={measureRef} data-index={index}>
      <TableCell>{rec.maintenance_date || "-"}</TableCell>
      <TableCell className="font-medium">
        {rec.asset?.code ? `[${rec.asset.code}] ` : ""}
        {rec.asset?.name || "-"}
      </TableCell>
      <TableCell className="max-w-[200px] truncate">{rec.issue_description || "-"}</TableCell>
      <TableCell>{rec.assigned_profile?.full_name || "-"}</TableCell>
      <TableCell>{rec.cost ? formatCurrency(rec.cost) : "-"}</TableCell>
      <TableCell>
        <Badge className={status?.color || ""}>{status?.label || rec.status}</Badge>
      </TableCell>
      <TableCell className="max-w-[150px] truncate">{rec.notes || "-"}</TableCell>
    </TableRow>
  );
});

const AssetsPage = () => {
  const { data: perms } = useMyPermissions();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [handoverDialogOpen, setHandoverDialogOpen] = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [maintenanceDialogOpen, setMaintenanceDialogOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AssetWithRelations | null>(null);
  const [categoryFilter, setCategoryFilter] = usePersistedState<string>("flt:assets:category", "ALL");
  const [conditionFilter, setConditionFilter] = usePersistedState<string>("flt:assets:condition", "ALL");
  const [buildingFilter, setBuildingFilter] = usePersistedState<string>("flt:assets:building", "ALL");
  const [roomFilter, setRoomFilter] = usePersistedState<string>("flt:assets:room", "ALL");
  const [searchQuery, setSearchQuery] = usePersistedState("flt:assets:search", "");

  useCopilotPageContext('assets.list', { category_id: categoryFilter, condition: conditionFilter, building_id: buildingFilter, room_id: roomFilter, search: searchQuery });
  const buildingsQuery = useBuildings();
  const roomsQuery = useRooms(buildingFilter !== "ALL" ? buildingFilter : undefined);
  const { data: buildings = [] } = buildingsQuery;
  const { data: rooms = [] } = roomsQuery;

  const assetsQuery = useAssets({
    category_id: categoryFilter !== "ALL" ? categoryFilter : undefined,
    condition: conditionFilter !== "ALL" ? conditionFilter : undefined,
    building_id: buildingFilter !== "ALL" ? buildingFilter : undefined,
  });
  const { data: assets = [] } = assetsQuery;

  const movementsQuery = useAssetMovements();
  const maintenanceQuery = useAssetMaintenance();
  const { data: movements = [] } = movementsQuery;
  const { data: maintenanceRecords = [] } = maintenanceQuery;

  // Fetch categories for filter
  const categoriesQuery = useQuery({
    queryKey: ["asset-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("asset_categories")
        .select("*")
        .order("name");
      if (error) throw error;
      return data || [];
    },
  });
  const { data: categories = [] } = categoriesQuery;

  const handleEdit = useCallback((asset: AssetWithRelations) => {
    setSelectedAsset(asset);
    setEditDialogOpen(true);
  }, []);

  // Lọc + tổng hợp chỉ chạy lại khi dữ liệu hoặc bộ lọc đổi. Trước đây cả hai
  // chạy mỗi render trên toàn bộ danh sách (fetchAllRows, không cap 1000) —
  // kể cả khi chỉ mở/đóng dialog.
  const filteredAssets = useMemo(
    () =>
      filterAssets(assets, {
        roomId: roomFilter !== "ALL" ? roomFilter : undefined,
        search: searchQuery,
      }),
    [assets, roomFilter, searchQuery],
  );

  // Calculate summary stats
  const { totalAssets, totalValue, byCondition } = useMemo(
    () => summarizeAssets(filteredAssets),
    [filteredAssets],
  );

  // Chủ chốt 02/10/2026: khung trang (nút, tab, bộ lọc) hiện ngay; chỉ phần dữ liệu chờ.
  // Trước đây cả trang thành "Đang tải..." (ngoài MainLayout) mỗi lần đổi lọc vì key đổi.
  // Ô lọc có nguồn riêng (toà/căn/loại) khoá + vạch xám tới khi danh sách về.
  const buildingsLoading = buildingsQuery.data === undefined && !buildingsQuery.isError;
  const roomsLoading = roomsQuery.data === undefined && !roomsQuery.isError;
  const categoriesLoading = categoriesQuery.data === undefined && !categoriesQuery.isError;

  return (
    <MainLayout
      title="Quản lý Tài sản"
      subtitle="Theo dõi và quản lý tài sản nội thất"
      icon={Package}
    >
      {/* Action Buttons */}
      <div className="flex justify-end gap-2 mb-6">
        {canUse(perms, "assets", "move") && (
          <Button variant="outline" size="sm" onClick={() => setMovementDialogOpen(true)}>
            <ArrowRightLeft className="w-4 h-4 mr-2" />
            Di chuyển
          </Button>
        )}
        {canUse(perms, "assets", "maintain") && (
          <Button variant="outline" size="sm" onClick={() => setMaintenanceDialogOpen(true)}>
            <Wrench className="w-4 h-4 mr-2" />
            Bảo trì
          </Button>
        )}
        {canUse(perms, "contracts", "handover") && (
          <Button variant="outline" onClick={() => setHandoverDialogOpen(true)}>
            <FileText className="w-4 h-4 mr-2" />
            Biên bản bàn giao
          </Button>
        )}
        {canUse(perms, "assets", "create") && (
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo tài sản
          </Button>
        )}
      </div>

      {/* Summary Cards — chưa có số thì khung thẻ hiện, ô số là vạch xám. */}
      <QueryRegion label="tổng quan tài sản" queries={[assetsQuery]} loading={<AssetSummaryCards summary={null} />}>
        <AssetSummaryCards
          summary={{
            total: totalAssets,
            value: formatCurrency(totalValue),
            good: (byCondition.GOOD || 0) + (byCondition.NEW || 0),
            bad: (byCondition.BROKEN || 0) + (byCondition.POOR || 0),
          }}
        />
      </QueryRegion>

      {/* Tabs: Danh sách, Lịch sử di chuyển, Lịch sử sửa chữa */}
      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">Danh sách tài sản</TabsTrigger>
          <TabsTrigger value="movements">Lịch sử di chuyển</TabsTrigger>
          <TabsTrigger value="maintenance">Lịch sử sửa chữa</TabsTrigger>
        </TabsList>

        {/* Tab: Danh sách tài sản */}
        <TabsContent value="list" className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã, loại..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <SearchableSelect
              value={buildingFilter}
              onValueChange={(val) => { setBuildingFilter(val); setRoomFilter("ALL"); }}
              className="w-[180px]"
              disabled={buildingsLoading}
              placeholder={buildingsLoading ? <InlineSkeleton label="danh sách toà nhà" width="6rem" /> : "Toà nhà"}
              options={[
                { value: 'ALL', label: 'Tất cả toà nhà' },
                ...buildings.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <SearchableSelect
              value={roomFilter}
              onValueChange={setRoomFilter}
              className="w-[180px]"
              disabled={roomsLoading}
              placeholder={roomsLoading ? <InlineSkeleton label="danh sách căn hộ" width="6rem" /> : "Căn hộ"}
              options={[
                { value: 'ALL', label: 'Tất cả căn hộ' },
                ...rooms.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
            <SearchableSelect
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              className="w-[180px]"
              disabled={categoriesLoading}
              placeholder={categoriesLoading ? <InlineSkeleton label="loại tài sản" width="6rem" /> : "Loại tài sản"}
              options={[
                { value: 'ALL', label: 'Tất cả loại' },
                ...categories.map((cat) => ({ value: cat.id, label: cat.name })),
              ]}
            />
            <SearchableSelect
              value={conditionFilter}
              onValueChange={setConditionFilter}
              className="w-[160px]"
              placeholder="Tình trạng"
              options={[
                { value: 'ALL', label: 'Tất cả' },
                ...Object.entries(CONDITION_CONFIG).map(([key, config]) => ({ value: key, label: config.label })),
              ]}
            />
          </div>

          {/* Nguồn của ô lọc chỉ báo lỗi ở đây; bảng chờ riêng danh sách tài sản. */}
          <QueryRegion label="toà nhà, căn hộ và loại tài sản" queries={[categoriesQuery, buildingsQuery, roomsQuery]} skeleton="none"><></></QueryRegion>

          {/* Assets Table — ảo hoá từ 50 dòng (VirtualTable) */}
          <QueryRegion label="danh sách tài sản" queries={[assetsQuery]} skeleton="table" rows={8}>
          <Card>
            <VirtualTable
              rows={filteredAssets}
              header={
                <TableRow>
                  <TableHead>Mã TS</TableHead>
                  <TableHead>Tên tài sản</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Số lượng</TableHead>
                  <TableHead>Giá trị</TableHead>
                  <TableHead>Tình trạng</TableHead>
                  <TableHead>Vị trí</TableHead>
                  <TableHead>Nhà cung cấp</TableHead>
                  <TableHead>Ngày mua</TableHead>
                  <TableHead>Thao tác</TableHead>
                </TableRow>
              }
              emptyRow={
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                    Không tìm thấy tài sản nào
                  </TableCell>
                </TableRow>
              }
              renderRow={(asset, index, measureRef) => (
                <AssetRow key={asset.id} asset={asset} index={index} measureRef={measureRef} onEdit={handleEdit} />
              )}
            />
          </Card>
          </QueryRegion>
        </TabsContent>

        {/* Tab: Lịch sử di chuyển */}
        <TabsContent value="movements" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lịch sử di chuyển tài sản</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryRegion label="lịch sử di chuyển tài sản" queries={[movementsQuery]} skeleton="table" rows={5}>
              <VirtualTable
                rows={movements}
                header={
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Tài sản</TableHead>
                    <TableHead>Từ</TableHead>
                    <TableHead>Đến</TableHead>
                    <TableHead>Số lượng</TableHead>
                    <TableHead>Lý do</TableHead>
                  </TableRow>
                }
                emptyRow={
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Chưa có lịch sử di chuyển tài sản
                    </TableCell>
                  </TableRow>
                }
                renderRow={(m, index, measureRef) => (
                  <MovementRow key={m.id} m={m} index={index} measureRef={measureRef} />
                )}
              />
              </QueryRegion>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Lịch sử sửa chữa */}
        <TabsContent value="maintenance" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lịch sử sửa chữa tài sản</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryRegion label="lịch sử sửa chữa tài sản" queries={[maintenanceQuery]} skeleton="table" rows={5}>
              <VirtualTable
                rows={maintenanceRecords}
                header={
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Tài sản</TableHead>
                    <TableHead>Mô tả</TableHead>
                    <TableHead>Người xử lý</TableHead>
                    <TableHead>Chi phí</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                }
                emptyRow={
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Chưa có lịch sử sửa chữa tài sản
                    </TableCell>
                  </TableRow>
                }
                renderRow={(rec, index, measureRef) => (
                  <MaintenanceRow key={rec.id} rec={rec} index={index} measureRef={measureRef} />
                )}
              />
              </QueryRegion>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <CreateAssetDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      {selectedAsset && (
        <EditAssetDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} asset={selectedAsset} />
      )}
      <AssetHandoverDialog open={handoverDialogOpen} onOpenChange={setHandoverDialogOpen} />
      <AssetMovementDialog open={movementDialogOpen} onOpenChange={setMovementDialogOpen} />
      <AssetMaintenanceDialog open={maintenanceDialogOpen} onOpenChange={setMaintenanceDialogOpen} />
    </MainLayout>
  );
};

/** Bốn thẻ tổng quan; `null` = chưa có số — khung thẻ hiện, ô số là vạch xám. */
function AssetSummaryCards({ summary }: { summary: { total: number; value: string; good: number; bad: number } | null }) {
  const items = [
    { key: 'total', title: 'Tổng số tài sản', cls: '', value: summary?.total },
    { key: 'value', title: 'Giá trị tổng', cls: 'text-blue-600', value: summary?.value },
    { key: 'good', title: 'Tốt / Mới', cls: 'text-green-600', value: summary?.good },
    { key: 'bad', title: 'Hỏng / Kém', cls: 'text-red-600', value: summary?.bad },
  ] as const;
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {items.map((item) => (
        <Card key={item.key}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{item.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${item.cls}`}>
              {summary ? item.value : <InlineSkeleton label={item.title.toLowerCase()} width={item.key === 'value' ? '7rem' : '2.5rem'} />}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default AssetsPage;
