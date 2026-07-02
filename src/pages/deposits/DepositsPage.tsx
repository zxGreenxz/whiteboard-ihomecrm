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
import { useQueryClient } from "@tanstack/react-query";
import {
  useReservationDeposits,
  type ReservationDepositRow,
} from "@/hooks/useDeposits";
import {
  useHeldDeposits,
  useDepositRefundsForfeits,
  summarizeByBuilding,
  type HeldDepositRow,
} from "@/hooks/useDepositDashboard";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import { CreateDepositDialog } from "@/components/deposits/CreateDepositDialog";
import {
  ContractFormDialog,
  type ContractPrefill,
} from "@/components/contracts/ContractFormDialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { usePersistedState } from "@/hooks/usePersistedState";

// Trạng thái phiếu giữ chỗ (theo approval_status của phiếu thu cọc mồ côi).
const RESV_STATUS = {
  UNAPPROVED: { label: "Chờ duyệt", color: "bg-yellow-100 text-yellow-800" },
  APPROVED: { label: "Đang giữ chỗ", color: "bg-green-100 text-green-800" },
  CANCELLED: { label: "Đã huỷ", color: "bg-gray-100 text-gray-700" },
} as const;

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
  const queryClient = useQueryClient();
  const [tab, setTab] = usePersistedState("flt:deposits:tab", "overview");
  const { data: perms } = useMyPermissions();
  const canCreateDeposit = canUse(perms, "deposits", "create");
  const canConvertDeposit = canUse(perms, "deposits", "convert");

  // Bộ lọc toà nhà dùng chung cho mọi tab ([] = tất cả toà).
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:deposits:buildingIds", []);

  // Tab "Phiếu giữ chỗ".
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [resvContractOpen, setResvContractOpen] = useState(false);
  const [resvPrefill, setResvPrefill] = useState<ContractPrefill | null>(null);
  const [statusFilter, setStatusFilter] = usePersistedState<string>("flt:deposits:status", "ALL");
  const [searchQuery, setSearchQuery] = usePersistedState("flt:deposits:search", "");
  const [onlyShort, setOnlyShort] = usePersistedState("flt:deposits:onlyShort", false);

  const { data: held = [], isLoading: heldLoading } = useHeldDeposits();
  const { data: refunds = [], isLoading: refundsLoading } =
    useDepositRefundsForfeits();
  // Cọc giữ chỗ — nguồn thống nhất từ income_expenses (lọc toà server-side).
  const { data: reservations = [], isLoading: resvLoading } =
    useReservationDeposits(buildingIds);

  // Lọc theo toà nhà (client-side) cho dashboard.
  const heldFiltered = useMemo(
    () =>
      buildingIds.length === 0
        ? held
        : held.filter((r) => buildingIds.includes(r.building_id)),
    [held, buildingIds],
  );
  const refundsFiltered = useMemo(
    () =>
      buildingIds.length === 0
        ? refunds
        : refunds.filter((r) => buildingIds.includes(r.building_id)),
    [refunds, buildingIds],
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

  // Giữ chỗ đang giữ (phiếu thu cọc mồ côi đã duyệt) — đã lọc toà trong hook.
  const holdingAmount = useMemo(
    () =>
      reservations
        .filter((r) => r.approval_status === "APPROVED")
        .reduce((s, r) => s + r.total_amount, 0),
    [reservations],
  );

  const shortfallRows = useMemo(() => {
    const rows = heldFiltered.filter((r) => r.state !== "FULL");
    return onlyShort ? rows.filter((r) => r.state === "SHORT") : rows;
  }, [heldFiltered, onlyShort]);

  // Tab giữ chỗ — lọc theo trạng thái + search (toà đã lọc server-side).
  const filteredReservations = reservations.filter((r) => {
    if (statusFilter !== "ALL" && r.approval_status !== statusFilter)
      return false;
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      r.code?.toLowerCase().includes(search) ||
      r.name?.toLowerCase().includes(search) ||
      r.payer_name?.toLowerCase().includes(search) ||
      r.room_name?.toLowerCase().includes(search)
    );
  });

  // "Tạo HĐ" từ phiếu giữ chỗ: mở form HĐ prefill phòng; KHÔNG truyền depositId
  // (phiếu cọc mồ côi tự gắn vào HĐ qua trigger trg_contract_link_orphan_deposits).
  const handleConvertReservation = (r: ReservationDepositRow) => {
    if (!r.room_id) return;
    setResvPrefill({ buildingId: r.building_id, roomId: r.room_id });
    setResvContractOpen(true);
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
          {canCreateDeposit && (
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Tạo đặt cọc
            </Button>
          )}
        </div>

        {/* Bộ lọc toà nhà (1 toà hoặc tất cả) — dùng chung mọi tab */}
        <div className="flex flex-wrap items-end gap-3">
          <BuildingFilterSelect
            value={buildingIds}
            onChange={setBuildingIds}
            className="w-[280px]"
            aria-label="Lọc theo toà nhà"
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
            <p className="text-sm text-muted-foreground">
              Bỏ cọc = khách mất cọc, cọc thành doanh thu. "Tổng nợ tất toán" là
              tổng nợ khách khi thanh lý (tiền phòng + phí),{" "}
              <strong>không trừ vào cọc</strong>; nếu nợ &gt; cọc thì khách còn
              nợ thêm.
            </p>
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
                    <TableHead className="text-right">Tổng nợ tất toán</TableHead>
                    <TableHead>Còn nợ / Hoàn lại</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refundsLoading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell>
                    </TableRow>
                  ) : refundsFiltered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        Chưa có hợp đồng thanh lý nào
                      </TableCell>
                    </TableRow>
                  ) : (
                    refundsFiltered.map((r) => {
                      // Số tiền khách CÒN NỢ sau khi mất cọc (nợ > cọc).
                      const stillOwed = Math.max(0, -r.refund_amount);
                      return (
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
                          <TableCell
                            className="text-right text-muted-foreground"
                            title="Tổng nợ khách khi thanh lý (tiền phòng nợ + phí) — KHÔNG trừ vào cọc"
                          >
                            {formatCurrency(r.total_deductions)}
                          </TableCell>
                          <TableCell>
                            {r.kind === "FORFEIT" ? (
                              stillOwed > 0 ? (
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  Khách nợ {formatCurrency(stillOwed)}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                  <Ban className="h-3.5 w-3.5" /> Cọc thành doanh thu
                                </span>
                              )
                            ) : r.refund_done ? (
                              <span className="inline-flex items-center gap-1 text-xs text-green-700">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Đã hoàn{" "}
                                {formatCurrency(Math.max(0, r.refund_amount))}
                              </span>
                            ) : (
                              <span className="text-xs text-orange-600">
                                Chờ hoàn {formatCurrency(Math.max(0, r.refund_amount))}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* ===== TAB 4: PHIẾU GIỮ CHỖ ===== */}
          <TabsContent value="holds" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Cọc giữ chỗ trước hợp đồng — gộp mọi nguồn (trang Phòng trống,
              Thu-chi, nút "Tạo đặt cọc"). Khi ký hợp đồng, phiếu cọc tự gắn vào
              HĐ và rời danh sách này.
            </p>

            <div className="grid grid-cols-3 gap-4">
              {(
                Object.entries(RESV_STATUS) as [
                  keyof typeof RESV_STATUS,
                  (typeof RESV_STATUS)[keyof typeof RESV_STATUS],
                ][]
              ).map(([key, config]) => {
                const count = reservations.filter(
                  (r) => r.approval_status === key,
                ).length;
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
                  placeholder="Tìm mã, nội dung, người nộp, phòng..."
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
                  ...Object.entries(RESV_STATUS).map(([key, config]) => ({
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
                    <TableHead>Nội dung</TableHead>
                    <TableHead>Toà nhà</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Người nộp</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resvLoading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell>
                    </TableRow>
                  ) : filteredReservations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9}>
                        {reservations.length === 0 && statusFilter === "ALL" && !searchQuery ? (
                          <EmptyState
                            icon={DollarSign}
                            title="Chưa có phiếu giữ chỗ nào"
                            description="Tạo cọc giữ chỗ từ trang Phòng trống, Thu-chi, hoặc nút Tạo đặt cọc"
                            actionLabel={canCreateDeposit ? "Tạo đặt cọc" : undefined}
                            onAction={canCreateDeposit ? () => setCreateDialogOpen(true) : undefined}
                          />
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            Không tìm thấy phiếu giữ chỗ nào
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredReservations.map((r) => {
                      const st = RESV_STATUS[r.approval_status];
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.code || "-"}
                          </TableCell>
                          <TableCell className="max-w-[260px] truncate" title={r.name}>
                            {r.name || "-"}
                          </TableCell>
                          <TableCell>{r.building_name || "-"}</TableCell>
                          <TableCell>{r.room_name || "—"}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.payer_name || "-"}
                          </TableCell>
                          <TableCell className="text-right">{formatCurrency(r.total_amount)}</TableCell>
                          <TableCell>{r.voucher_date ? formatDate(r.voucher_date) : "-"}</TableCell>
                          <TableCell>
                            <Badge className={st?.color || ""}>{st?.label || r.approval_status}</Badge>
                          </TableCell>
                          <TableCell>
                            {canConvertDeposit &&
                              r.approval_status === "APPROVED" &&
                              r.room_id && (
                                <Button size="sm" onClick={() => handleConvertReservation(r)}>
                                  Tạo HĐ
                                </Button>
                              )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Dialogs */}
        <CreateDepositDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        {resvPrefill && (
          <ContractFormDialog
            open={resvContractOpen}
            onOpenChange={setResvContractOpen}
            prefill={resvPrefill}
            onCreated={() =>
              queryClient.invalidateQueries({ queryKey: ["reservation-deposits"] })
            }
          />
        )}
      </div>
    </MainLayout>
  );
};

export default DepositsPage;
