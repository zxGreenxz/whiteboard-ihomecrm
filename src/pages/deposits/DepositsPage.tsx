import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Plus, Search, DollarSign } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useDeposits, type DepositWithRelations } from "@/hooks/useDeposits";
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

const DepositsPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState<DepositWithRelations | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: deposits = [], isLoading } = useDeposits({
    status: statusFilter !== "ALL" ? statusFilter : undefined,
  });

  const handleEdit = (deposit: DepositWithRelations) => {
    setSelectedDeposit(deposit);
    setEditDialogOpen(true);
  };

  const handleConvert = (deposit: DepositWithRelations) => {
    setSelectedDeposit(deposit);
    setConvertDialogOpen(true);
  };

  const filteredDeposits = deposits.filter((deposit) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      deposit.tenant?.full_name?.toLowerCase().includes(search) ||
      deposit.tenant?.phone?.toLowerCase().includes(search) ||
      deposit.room?.name?.toLowerCase().includes(search)
    );
  });

  if (isLoading) {
    return (
      <MainLayout>
        <div className="p-6">
          <div className="flex items-center justify-center h-96">
            <p className="text-muted-foreground">Đang tải...</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Quản lý Đặt cọc</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi và quản lý các phiếu đặt cọc
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Tạo đặt cọc
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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

      {/* Filters */}
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Lọc theo trạng thái" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tất cả</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([key, config]) => (
              <SelectItem key={key} value={key}>
                {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Khách hàng</TableHead>
              <TableHead>SĐT</TableHead>
              <TableHead>Căn hộ/Giường</TableHead>
              <TableHead>Số tiền</TableHead>
              <TableHead>Ngày đặt cọc</TableHead>
              <TableHead>Giữ đến ngày</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredDeposits.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
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
                  <TableCell className="font-medium">
                    {deposit.tenant?.full_name || "-"}
                  </TableCell>
                  <TableCell>{deposit.tenant?.phone || "-"}</TableCell>
                  <TableCell>
                    {deposit.room?.name || "-"}
                    {deposit.bed && ` - ${deposit.bed.name}`}
                  </TableCell>
                  <TableCell>{formatCurrency(deposit.amount)}</TableCell>
                  <TableCell>
                    {deposit.deposit_date ? formatDate(deposit.deposit_date) : "-"}
                  </TableCell>
                  <TableCell>
                    {deposit.hold_until_date ? formatDate(deposit.hold_until_date) : "-"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        STATUS_CONFIG[deposit.status as keyof typeof STATUS_CONFIG]?.color ||
                        ""
                      }
                    >
                      {STATUS_CONFIG[deposit.status as keyof typeof STATUS_CONFIG]?.label ||
                        deposit.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(deposit)}
                      >
                        Sửa
                      </Button>
                      {deposit.status === "CONFIRMED" && (
                        <Button
                          size="sm"
                          onClick={() => handleConvert(deposit)}
                        >
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

      {/* Dialogs */}
      <CreateDepositDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

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
