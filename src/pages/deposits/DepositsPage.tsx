import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import {
  Plus,
  Search,
  DollarSign,
  Wallet,
  Building2,
  AlertTriangle,
  RotateCcw,
  Ban,
  CheckCircle2,
} from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useDeposits, type DepositWithRelations } from "@/hooks/useDeposits";
import {
  useHeldDeposits,
  useDepositRefundsForfeits,
  summarizeByBuilding,
  type HeldDepositRow,
} from "@/hooks/useDepositDashboard";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { CreateDepositDialog } from "@/components/deposits/CreateDepositDialog";
import { EditDepositDialog } from "@/components/deposits/EditDepositDialog";
import { ConvertToContractDialog } from "@/components/deposits/ConvertToContractDialog";
import { formatCurrency, formatDate } from "@/lib/utils";

const STATUS_CONFIG = {
  PENDING: { label: "Chờ xác nhận", color: "bg-yellow-100 text-yellow-800" },
  CONFIRMED: { label: "Đã xác nhận", color: "bg-green-100 text-green-800" },
  CONVERTED: { label: "Đã chuyển HĐ", color: "bg-blue-100 text-blue-800" },
  REFUNDED: { label: "Đã hoàn trả", color: "bg-gray-100 text-gray-800" },
  FORFEITED: { label: "Mất cọc", color: "bg-red-100 text-red-800" },
};
const HOLDING_STATUSES = new Set(["PENDING", "CONFIRMED"]);

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "green" | "orange" | "red" | "blue";
}) {
  const toneMap: Record<string, string> = {
    default: "text-foreground",
    green: "text-green-600",
    orange: "text-orange-600",
    red: "text-red-600",
    blue: "text-blue-600",
  };
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={`text-xl font-bold ${toneMap[tone]}`}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
        <Icon className={`h-5 w-5 shrink-0 ${toneMap[tone]}`} />
      </div>
    </Card>
  );
}

const DepositsPage = () => {
  const [tab, setTab] = useState("overview");

  // Bộ lọc dùng chung cho các tab dashboard.
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");

  // Tab "Phiếu giữ chỗ" (CRUD).
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [selectedDeposit, setSelectedDeposit] =
    useState<DepositWithRelations | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings();
  const { data: held = [], isLoading: heldLoading } = useHeldDeposits();
  const { data: refunds = [], isLoading: refundsLoading } =
    useDepositRefundsForfeits();
  const { data: deposits = [], isLoading: depositsLoading } = useDeposits({
    status: statusFilter !== "ALL" ? statusFilter : undefined,
  });

  // Lọc theo toà nhà (client-side) cho dashboard.
  const heldFiltered = useMemo(
    () =>
      buildingId === "all"
        ? held
        : held.filter((r) => r.building_id === buildingId),
    [held, buildingId],
  );
  const refundsFiltered = useMemo(
    () =>
      buildingId === "all"
        ? refunds
        : refunds.filter((r) => r.building_id === buildingId),
    [refunds, buildingId],
  );

  const byBuilding = useMemo(
    () => summarizeByBuilding(heldFiltered),
    [heldFiltered],
  );

  // KPI tổng.
  const kpi = useMemo(() => {
    const held_ = heldFiltered.reduce((s, r) => s + r.deposit_paid, 0);
    const expected = heldFiltered.reduce((s, r) => s + r.total_deposit, 0);
    const shortRows = heldFiltered.filter((r) => r.state === "SHORT");
    const shortfall = shortRows.reduce(
      (s, r) => s + Math.max(0, r.deposit_remaining),
      0,
    );
    const refundTotal = refundsFiltered
      .filter((r) => r.kind === "REFUND")
      .reduce((s, r) => s + Math.max(0, r.refund_amount), 0);
    const refundCount = refundsFiltered.filter((r) => r.kind === "REFUND").length;
    const forfeitTotal = refundsFiltered
      .filter((r) => r.kind === "FORFEIT")
      .reduce((s, r) => s + r.total_deposit, 0);
    const forfeitCount = refundsFiltered.filter(
      (r) => r.kind === "FORFEIT",
    ).length;
    return {
      held_,
      expected,
      shortfall,
      shortCount: shortRows.length,
      refundTotal,
      refundCount,
      forfeitTotal,
      forfeitCount,
    };
  }, [heldFiltered, refundsFiltered]);

  // Giữ chỗ đang chờ (bảng deposits, PENDING/CONFIRMED) — lọc theo toà.
  const holdingAmount = useMemo(() => {
    return deposits
      .filter((d) => HOLDING_STATUSES.has(d.status as string))
      .filter((d) =>
        buildingId === "all" ? true : d.room?.building?.id === buildingId,
      )
      .reduce((s, d) => s + (d.amount || 0), 0);
  }, [deposits, buildingId]);

  const shortfallRows = useMemo(() => {
    const rows = heldFiltered.filter((r) => r.state !== "FULL");
    return onlyShort ? rows.filter((r) => r.state === "SHORT") : rows;
  }, [heldFiltered, onlyShort]);

  // Tab giữ chỗ — lọc theo search + toà nhà.
  const filteredDeposits = deposits.filter((deposit) => {
    if (buildingId !== "all" && deposit.room?.building?.id !== buildingId)
      return false;
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      deposit.tenant?.full_name?.toLowerCase().includes(search) ||
      deposit.tenant?.phone?.toLowerCase().includes(search) ||
      deposit.room?.name?.toLowerCase().includes(search)
    );
  });

  const handleEdit = (deposit: DepositWithRelations) => {
    setSelectedDeposit(deposit);
    setEditDialogOpen(true);
  };
  const handleConvert = (deposit: DepositWithRelations) => {
    setSelectedDeposit(deposit);
    setConvertDialogOpen(true);
  };

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold">Quản lý Cọc</h1>
            <p className="text-muted-foreground mt-1">
              Theo dõi cọc toàn hệ thống: đủ/thiếu cọc, hoàn cọc, bỏ cọc, phiếu
              giữ chỗ
            </p>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo đặt cọc
          </Button>
        </div>

        {/* Bộ lọc khu vực / toà nhà — dùng chung */}
        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={areaId}
            onValueChange={setAreaId}
            className="w-[200px]"
            placeholder="Chọn khu vực"
            options={[
              { value: "all", label: "Tất cả khu vực" },
              ...(areas as any[]).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <SearchableSelect
            value={buildingId}
            onValueChange={setBuildingId}
            className="w-[200px]"
            placeholder="Chọn toà nhà"
            options={[
              { value: "all", label: "Tất cả toà nhà" },
              ...(buildings as any[])
                .filter((b) => areaId === "all" || b.area_id === areaId)
                .map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="overview">Tổng quan</TabsTrigger>
            <TabsTrigger value="rooms">Đủ / Thiếu cọc</TabsTrigger>
            <TabsTrigger value="refunds">Hoàn / Bỏ cọc</TabsTrigger>
            <TabsTrigger value="holds">Phiếu giữ chỗ</TabsTrigger>
          </TabsList>

          {/* ===== TAB 1: TỔNG QUAN ===== */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
              <KpiCard
                label="Cọc đang giữ"
                value={formatCurrency(kpi.held_)}
                icon={Wallet}
                tone="green"
              />
              <KpiCard
                label="Cọc cần thu"
                value={formatCurrency(kpi.expected)}
                icon={DollarSign}
              />
              <KpiCard
                label="Thiếu cọc"
                value={formatCurrency(kpi.shortfall)}
                sub={`${kpi.shortCount} hợp đồng`}
                icon={AlertTriangle}
                tone="orange"
              />
              <KpiCard
                label="Giữ chỗ chờ"
                value={formatCurrency(holdingAmount)}
                icon={Building2}
                tone="blue"
              />
              <KpiCard
                label="Đã hoàn cọc"
                value={formatCurrency(kpi.refundTotal)}
                sub={`${kpi.refundCount} lần`}
                icon={RotateCcw}
              />
              <KpiCard
                label="Đã bỏ cọc"
                value={formatCurrency(kpi.forfeitTotal)}
                sub={`${kpi.forfeitCount} lần`}
                icon={Ban}
                tone="red"
              />
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Toà nhà</TableHead>
                    <TableHead className="text-right">Số HĐ</TableHead>
                    <TableHead className="text-right">Cọc cần thu</TableHead>
                    <TableHead className="text-right">Đang giữ</TableHead>
                    <TableHead className="text-right">Thiếu cọc</TableHead>
                    <TableHead className="text-right">Đủ / Thiếu</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {heldLoading ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        Đang tải...
                      </TableCell>
                    </TableRow>
                  ) : byBuilding.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        Không có hợp đồng đang hiệu lực
                      </TableCell>
                    </TableRow>
                  ) : (
                    byBuilding.map((b) => (
                      <TableRow key={b.building_id || b.building_name}>
                        <TableCell className="font-medium">{b.building_name}</TableCell>
                        <TableCell className="text-right">{b.contractCount}</TableCell>
                        <TableCell className="text-right">{formatCurrency(b.expected)}</TableCell>
                        <TableCell className="text-right text-green-700">{formatCurrency(b.held)}</TableCell>
                        <TableCell className={`text-right ${b.shortfall > 0 ? "text-orange-600 font-medium" : ""}`}>
                          {formatCurrency(b.shortfall)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="text-green-700">{b.fullCount}</span>
                          {" / "}
                          <span className={b.shortCount > 0 ? "text-orange-600" : ""}>{b.shortCount}</span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* ===== TAB 2: ĐỦ / THIẾU CỌC THEO PHÒNG ===== */}
          <TabsContent value="rooms" className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={onlyShort ? "default" : "outline"}
                onClick={() => setOnlyShort((v) => !v)}
              >
                {onlyShort ? "Đang lọc: chỉ thiếu cọc" : "Chỉ hiện thiếu cọc"}
              </Button>
              <span className="text-sm text-muted-foreground">
                {shortfallRows.length} hợp đồng còn thiếu cọc
              </span>
            </div>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Toà nhà</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead className="text-right">Cần thu</TableHead>
                    <TableHead className="text-right">Đã thu</TableHead>
                    <TableHead className="text-right">Còn thiếu</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Hẹn bổ sung</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {heldLoading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell>
                    </TableRow>
                  ) : shortfallRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        Tất cả hợp đồng đã thu đủ cọc 🎉
                      </TableCell>
                    </TableRow>
                  ) : (
                    shortfallRows.map((r: HeldDepositRow) => (
                      <TableRow key={r.contract_id}>
                        <TableCell>{r.building_name}</TableCell>
                        <TableCell>{r.room_name}</TableCell>
                        <TableCell>
                          <Link
                            to={`/contracts/${r.contract_id}`}
                            className="text-blue-600 hover:underline"
                          >
                            {r.customer_name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(r.total_deposit)}</TableCell>
                        <TableCell className="text-right text-green-700">{formatCurrency(r.deposit_paid)}</TableCell>
                        <TableCell className="text-right font-medium text-orange-600">
                          {formatCurrency(r.deposit_remaining)}
                        </TableCell>
                        <TableCell>
                          {r.state === "FIRST_INVOICE" ? (
                            <Badge className="bg-blue-100 text-blue-700">Thu ở HĐ đầu</Badge>
                          ) : (
                            <Badge className="bg-orange-100 text-orange-700">Nợ cọc</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {r.deposit_topup_due_date
                            ? formatDate(r.deposit_topup_due_date)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* ===== TAB 3: HOÀN / BỎ CỌC ===== */}
          <TabsContent value="refunds" className="space-y-3">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Toà nhà</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Loại</TableHead>
                    <TableHead className="text-right">Cọc gốc</TableHead>
                    <TableHead className="text-right">Khấu trừ</TableHead>
                    <TableHead className="text-right">Hoàn lại</TableHead>
                    <TableHead>Tình trạng</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refundsLoading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell>
                    </TableRow>
                  ) : refundsFiltered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                        Chưa có hợp đồng thanh lý nào
                      </TableCell>
                    </TableRow>
                  ) : (
                    refundsFiltered.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>{formatDate(r.termination_date)}</TableCell>
                        <TableCell>{r.building_name}</TableCell>
                        <TableCell>{r.room_name}</TableCell>
                        <TableCell>
                          <Link to={`/contracts/${r.contract_id}`} className="text-blue-600 hover:underline">
                            {r.customer_name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {r.kind === "FORFEIT" ? (
                            <Badge className="bg-red-100 text-red-700">Bỏ cọc</Badge>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-700">Hoàn cọc</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(r.total_deposit)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(r.total_deductions)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {r.kind === "FORFEIT" ? "—" : formatCurrency(Math.max(0, r.refund_amount))}
                        </TableCell>
                        <TableCell>
                          {r.kind === "FORFEIT" ? (
                            <span className="text-xs text-muted-foreground">Cọc thành doanh thu</span>
                          ) : r.refund_done ? (
                            <span className="inline-flex items-center gap-1 text-xs text-green-700">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Đã hoàn
                            </span>
                          ) : (
                            <span className="text-xs text-orange-600">Chờ hoàn</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* ===== TAB 4: PHIẾU GIỮ CHỖ (CRUD) ===== */}
          <TabsContent value="holds" className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {Object.entries(STATUS_CONFIG).map(([key, config]) => {
                const count = deposits.filter((d) => d.status === key).length;
                return (
                  <Card key={key} className="p-4">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">{config.label}</p>
                      <p className="text-2xl font-bold">{count}</p>
                    </div>
                  </Card>
                );
              })}
            </div>

            <div className="flex gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                <Input
                  placeholder="Tìm kiếm theo tên, SĐT, căn hộ..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <SearchableSelect
                value={statusFilter}
                onValueChange={setStatusFilter}
                className="w-[200px]"
                placeholder="Lọc theo trạng thái"
                options={[
                  { value: "ALL", label: "Tất cả" },
                  ...Object.entries(STATUS_CONFIG).map(([key, config]) => ({
                    value: key,
                    label: config.label,
                  })),
                ]}
              />
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>SĐT</TableHead>
                    <TableHead>Toà nhà</TableHead>
                    <TableHead>Căn hộ</TableHead>
                    <TableHead>CTV</TableHead>
                    <TableHead>Số tiền</TableHead>
                    <TableHead>Ngày cọc</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {depositsLoading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell>
                    </TableRow>
                  ) : filteredDeposits.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10}>
                        {deposits.length === 0 && statusFilter === "ALL" && !searchQuery ? (
                          <EmptyState
                            icon={DollarSign}
                            title="Chưa có phiếu đặt cọc nào"
                            description="Hãy tạo phiếu đặt cọc đầu tiên để bắt đầu quản lý"
                            actionLabel="Tạo đặt cọc"
                            onAction={() => setCreateDialogOpen(true)}
                          />
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            Không tìm thấy phiếu đặt cọc nào
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredDeposits.map((deposit) => (
                      <TableRow key={deposit.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {(deposit as any).code || "-"}
                        </TableCell>
                        <TableCell className="font-medium">
                          {deposit.tenant?.full_name || "-"}
                        </TableCell>
                        <TableCell>{deposit.tenant?.phone || "-"}</TableCell>
                        <TableCell>{deposit.room?.building?.name || "-"}</TableCell>
                        <TableCell>{deposit.room?.name || "-"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {(deposit as any).ctv_name || "-"}
                        </TableCell>
                        <TableCell>{formatCurrency(deposit.amount)}</TableCell>
                        <TableCell>
                          {deposit.deposit_date ? formatDate(deposit.deposit_date) : "-"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={
                              STATUS_CONFIG[deposit.status as keyof typeof STATUS_CONFIG]?.color || ""
                            }
                          >
                            {STATUS_CONFIG[deposit.status as keyof typeof STATUS_CONFIG]?.label ||
                              deposit.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => handleEdit(deposit)}>
                              Sửa
                            </Button>
                            {deposit.status === "CONFIRMED" && (
                              <Button size="sm" onClick={() => handleConvert(deposit)}>
                                Tạo HĐ
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Dialogs */}
        <CreateDepositDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        {selectedDeposit && (
          <>
            <EditDepositDialog
              open={editDialogOpen}
              onOpenChange={setEditDialogOpen}
              deposit={selectedDeposit}
            />
            <ConvertToContractDialog
              open={convertDialogOpen}
              onOpenChange={setConvertDialogOpen}
              deposit={selectedDeposit}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
};

export default DepositsPage;
