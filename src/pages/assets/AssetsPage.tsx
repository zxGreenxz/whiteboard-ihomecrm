import { useState } from "react";
import { Plus, Search, FileText, ArrowRightLeft, Wrench, Package } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssets, useAssetMovements, useAssetMaintenance, type AssetWithRelations } from "@/hooks/useAssets";
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

const AssetsPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [handoverDialogOpen, setHandoverDialogOpen] = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [maintenanceDialogOpen, setMaintenanceDialogOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AssetWithRelations | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [conditionFilter, setConditionFilter] = useState<string>("ALL");
  const [buildingFilter, setBuildingFilter] = useState<string>("ALL");
  const [roomFilter, setRoomFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(buildingFilter !== "ALL" ? buildingFilter : undefined);

  const { data: assets = [], isLoading } = useAssets({
    category_id: categoryFilter !== "ALL" ? categoryFilter : undefined,
    condition: conditionFilter !== "ALL" ? conditionFilter : undefined,
    building_id: buildingFilter !== "ALL" ? buildingFilter : undefined,
  });

  const { data: movements = [] } = useAssetMovements();
  const { data: maintenanceRecords = [] } = useAssetMaintenance();

  // Fetch categories for filter
  const { data: categories = [] } = useQuery({
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

  const handleEdit = (asset: AssetWithRelations) => {
    setSelectedAsset(asset);
    setEditDialogOpen(true);
  };

  const filteredAssets = assets.filter((asset) => {
    if (roomFilter !== "ALL" && asset.room_id !== roomFilter) return false;
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      asset.name?.toLowerCase().includes(search) ||
      asset.code?.toLowerCase().includes(search) ||
      asset.category?.name?.toLowerCase().includes(search)
    );
  });

  // Calculate summary stats
  const totalAssets = filteredAssets.length;
  const totalValue = filteredAssets.reduce((sum, asset) => sum + (asset.purchase_price || 0) * (asset.quantity || 1), 0);
  const byCondition = filteredAssets.reduce((acc, asset) => {
    const condition = asset.condition || "GOOD";
    acc[condition] = (acc[condition] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <MainLayout
      title="Quản lý Tài sản"
      subtitle="Theo dõi và quản lý tài sản nội thất"
      icon={Package}
    >
      {/* Action Buttons */}
      <div className="flex justify-end gap-2 mb-6">
        <Button variant="outline" size="sm" onClick={() => setMovementDialogOpen(true)}>
          <ArrowRightLeft className="w-4 h-4 mr-2" />
          Di chuyển
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMaintenanceDialogOpen(true)}>
          <Wrench className="w-4 h-4 mr-2" />
          Bảo trì
        </Button>
        <Button variant="outline" onClick={() => setHandoverDialogOpen(true)}>
          <FileText className="w-4 h-4 mr-2" />
          Biên bản bàn giao
        </Button>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Tạo tài sản
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tổng số tài sản</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalAssets}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Giá trị tổng</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{formatCurrency(totalValue)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tốt / Mới</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{(byCondition.GOOD || 0) + (byCondition.NEW || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Hỏng / Kém</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{(byCondition.BROKEN || 0) + (byCondition.POOR || 0)}</div>
          </CardContent>
        </Card>
      </div>

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
              placeholder="Toà nhà"
              options={[
                { value: 'ALL', label: 'Tất cả toà nhà' },
                ...buildings.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <SearchableSelect
              value={roomFilter}
              onValueChange={setRoomFilter}
              className="w-[180px]"
              placeholder="Căn hộ"
              options={[
                { value: 'ALL', label: 'Tất cả căn hộ' },
                ...rooms.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
            <SearchableSelect
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              className="w-[180px]"
              placeholder="Loại tài sản"
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

          {/* Assets Table */}
          <Card>
            <Table>
              <TableHeader>
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
              </TableHeader>
              <TableBody>
                {filteredAssets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      Không tìm thấy tài sản nào
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAssets.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell className="font-mono">{asset.code || "-"}</TableCell>
                      <TableCell className="font-medium">{asset.name}</TableCell>
                      <TableCell>{asset.category?.name || "-"}</TableCell>
                      <TableCell>{asset.quantity || 1}</TableCell>
                      <TableCell className="font-semibold">
                        {formatCurrency((asset.purchase_price || 0) * (asset.quantity || 1))}
                      </TableCell>
                      <TableCell>
                        <Badge className={CONDITION_CONFIG[asset.condition as keyof typeof CONDITION_CONFIG]?.color || ""}>
                          {CONDITION_CONFIG[asset.condition as keyof typeof CONDITION_CONFIG]?.label || asset.condition}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {asset.building?.name || "-"}
                        {asset.room && ` - ${asset.room.name}`}
                      </TableCell>
                      <TableCell>{asset.supplier?.name || "-"}</TableCell>
                      <TableCell>{asset.purchase_date || "-"}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => handleEdit(asset)}>
                          Sửa
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Tab: Lịch sử di chuyển */}
        <TabsContent value="movements" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lịch sử di chuyển tài sản</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Tài sản</TableHead>
                    <TableHead>Từ</TableHead>
                    <TableHead>Đến</TableHead>
                    <TableHead>Số lượng</TableHead>
                    <TableHead>Lý do</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        Chưa có lịch sử di chuyển tài sản
                      </TableCell>
                    </TableRow>
                  ) : (
                    movements.map((m) => (
                      <TableRow key={m.id}>
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
                    ))
                  )}
                </TableBody>
              </Table>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Tài sản</TableHead>
                    <TableHead>Mô tả</TableHead>
                    <TableHead>Người xử lý</TableHead>
                    <TableHead>Chi phí</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Ghi chú</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {maintenanceRecords.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        Chưa có lịch sử sửa chữa tài sản
                      </TableCell>
                    </TableRow>
                  ) : (
                    maintenanceRecords.map((rec) => (
                      <TableRow key={rec.id}>
                        <TableCell>{rec.maintenance_date || "-"}</TableCell>
                        <TableCell className="font-medium">
                          {rec.asset?.code ? `[${rec.asset.code}] ` : ""}
                          {rec.asset?.name || "-"}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">{rec.issue_description || "-"}</TableCell>
                        <TableCell>{rec.assigned_profile?.full_name || "-"}</TableCell>
                        <TableCell>{rec.cost ? formatCurrency(rec.cost) : "-"}</TableCell>
                        <TableCell>
                          <Badge className={MAINTENANCE_STATUS_CONFIG[rec.status as string]?.color || ""}>
                            {MAINTENANCE_STATUS_CONFIG[rec.status as string]?.label || rec.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[150px] truncate">{rec.notes || "-"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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

export default AssetsPage;
