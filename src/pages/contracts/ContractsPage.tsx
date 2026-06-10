import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { FileText, Plus, Upload, Download, Filter, Search } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EmptyState from '@/components/ui/EmptyState';
import ContractStatsCards from '@/components/contracts/ContractStatsCards';
import ContractListFilters from '@/components/contracts/ContractListFilters';
import ContractListTable from '@/components/contracts/ContractListTable';
import { ContractFormDialog } from '@/components/contracts/ContractFormDialog';
import { RenewDialog } from '@/components/contracts/RenewDialog';
import { TransferRoomDialog } from '@/components/contracts/TransferRoomDialog';
import { MoveOutDialog } from '@/components/contracts/MoveOutDialog';
import { TransferContractDialog } from '@/components/contracts/TransferContractDialog';
import { TerminateDialog } from '@/components/contracts/TerminateDialog';
import { DeleteContractDialog } from '@/components/contracts/DeleteContractDialog';
import { ContractImportExportDialog } from '@/components/contracts/ContractImportExportDialog';
import { PrintContractDialog } from '@/components/contracts/PrintContractDialog';
import ContractQRDialog from '@/components/contracts/ContractQRDialog';
import { exportContracts } from '@/lib/contractExcelHelpers';

import { useContracts } from '@/hooks/useContracts';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useProfile } from '@/hooks/useProfile';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { getContractDisplayStatus } from '@/types/contract';
import { compareBuildingThenRoom } from '@/lib/roomSort';
import type {
  ContractWithRelations,
  ContractStatFilter,
  ContractLifecycleFilter,
  ContractStats,
  ContractDisplayStatus,
} from '@/types/contract';
import type { BuildingWithRelations } from '@/types/building';
import type { RoomWithRelations } from '@/types/room';

export default function ContractsPage() {
  // =============================================
  // State
  // =============================================

  // Stats filter
  const [activeStatFilter, setActiveStatFilter] = useState<ContractStatFilter>('ALL');

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  // Lọc theo nhiều toà nhà (khu vực = phím tắt chọn nhóm toà). [] = tất cả.
  const [buildingIds, setBuildingIds] = useState<string[]>([]);
  const [roomFilter, setRoomFilter] = useState('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<ContractLifecycleFilter>('ACTIVE');
  const [monthFilter, setMonthFilter] = useState('');
  const [showFilters, setShowFilters] = useState(true);
  const areaDefaultAppliedRef = useRef(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Dialogs
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const [transferRoomDialogOpen, setTransferRoomDialogOpen] = useState(false);
  const [moveOutDialogOpen, setMoveOutDialogOpen] = useState(false);
  const [transferContractDialogOpen, setTransferContractDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);

  // Selection
  const [selectedContract, setSelectedContract] = useState<ContractWithRelations | null>(null);
  const [selectedContractIds, setSelectedContractIds] = useState<string[]>([]);

  // =============================================
  // Data fetching
  // =============================================

  const { data: contractsData, isLoading } = useContracts();
  const contracts = useMemo(
    () => (Array.isArray(contractsData) ? contractsData : []) as ContractWithRelations[],
    [contractsData]
  );

  const { data: buildingsData } = useBuildings();
  const allBuildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
  );

  const { data: roomsData } = useRooms();
  const allRooms = useMemo(
    () => (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[],
    [roomsData]
  );

  const { data: profile } = useProfile();
  const { hasAnyScope } = useMyBuildingScope();

  // =============================================
  // Compute areas from buildings
  // =============================================

  const areas = useMemo(() => {
    const areaMap = new Map<string, { id: string; name: string; code: string | null; status: string }>();
    allBuildings.forEach((b) => {
      if (b.area && !areaMap.has(b.area.id)) {
        areaMap.set(b.area.id, { id: b.area.id, name: b.area.name, code: b.area.code, status: 'ACTIVE' });
      }
    });
    return Array.from(areaMap.values());
  }, [allBuildings]);

  // Mặc định khu vực theo user: Joey → JOEY, Nathan → NATHAN, còn lại → Tất cả
  // (khu vực = chọn sẵn toàn bộ toà nhà thuộc khu đó)
  useEffect(() => {
    if (areaDefaultAppliedRef.current) return;
    if (!profile || areas.length === 0) return;
    const name = (profile.full_name || '').trim().toLowerCase();
    if (name === 'joey' || name === 'nathan') {
      const matched = areas.find((a) => a.name.trim().toLowerCase() === name);
      if (matched) {
        setBuildingIds(
          allBuildings.filter((b) => b.area_id === matched.id).map((b) => b.id)
        );
      }
    }
    areaDefaultAppliedRef.current = true;
  }, [profile, areas, allBuildings]);

  // =============================================
  // Cascading filter data
  // =============================================

  // Phòng hiện trong dropdown = phòng thuộc các toà đang chọn ([] = mọi toà)
  const filteredRooms = useMemo(() => {
    if (buildingIds.length === 0) return allRooms;
    return allRooms.filter((r) => buildingIds.includes(r.building_id));
  }, [allRooms, buildingIds]);

  // =============================================
  // Compute stats from full contract list
  // =============================================

  const stats = useMemo<ContractStats>(() => {
    const result: ContractStats = { total: 0, expiring: 0, expired: 0, terminated: 0 };
    contracts.forEach((c) => {
      result.total++;
      const displayStatus = getContractDisplayStatus(c);
      if (displayStatus === 'EXPIRING') result.expiring++;
      else if (displayStatus === 'EXPIRED') result.expired++;
      else if (displayStatus === 'TERMINATED') result.terminated++;
    });
    return result;
  }, [contracts]);

  // =============================================
  // Client-side filtering
  // =============================================

  const filteredContracts = useMemo(() => {
    return contracts.filter((contract) => {
      // Lifecycle filter (Đang ở = tất cả trừ thanh lý, Thanh lý = chỉ thanh lý)
      if (lifecycleFilter === 'ACTIVE' && contract.status === 'TERMINATED') return false;
      if (lifecycleFilter === 'TERMINATED' && contract.status !== 'TERMINATED') return false;

      // Stat filter
      if (activeStatFilter !== 'ALL') {
        const displayStatus = getContractDisplayStatus(contract);
        const statusMap: Record<ContractStatFilter, ContractDisplayStatus[]> = {
          ALL: [],
          EXPIRING: ['EXPIRING'],
          EXPIRED: ['EXPIRED'],
          TERMINATED: ['TERMINATED'],
        };
        if (!statusMap[activeStatFilter]?.includes(displayStatus)) return false;
      }

      // Search filter: case-insensitive match on contract_number, customer name, phone, room name
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const contractNumber = contract.contract_number?.toLowerCase() || '';
        const roomName = contract.room?.name?.toLowerCase() || '';
        const customerName = contract.contract_customers
          ?.find((cc) => cc.is_representative)
          ?.customer?.full_name?.toLowerCase() || '';
        const customerPhone = contract.contract_customers
          ?.find((cc) => cc.is_representative)
          ?.customer?.phone || '';

        const matchesSearch =
          contractNumber.includes(term) ||
          roomName.includes(term) ||
          customerName.includes(term) ||
          customerPhone.includes(term);

        if (!matchesSearch) return false;
      }

      // Building filter (nhiều toà; [] = tất cả)
      if (buildingIds.length > 0) {
        if (!buildingIds.includes(contract.room?.building_id ?? '')) return false;
      }

      // Room filter — lọc theo TÊN phòng (gộp phòng cùng tên ở mọi toà nhà)
      if (roomFilter !== 'all') {
        if ((contract.room?.name ?? '') !== roomFilter) return false;
      }

      // Month filter: contract's active period overlaps with selected month
      if (monthFilter) {
        const [year, month] = monthFilter.split('-').map(Number);
        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 0, 23, 59, 59);
        const contractStart = new Date(contract.start_date);
        const contractEnd = new Date(contract.end_date);
        // Overlap check: contractStart <= monthEnd && contractEnd >= monthStart
        if (contractStart > monthEnd || contractEnd < monthStart) return false;
      }

      return true;
    });
  }, [
    contracts,
    activeStatFilter,
    lifecycleFilter,
    searchTerm,
    buildingIds,
    roomFilter,
    monthFilter,
  ]);

  // =============================================
  // Sort: gom theo toà nhà rồi sắp theo tên phòng (MB* → G* → L* → 1,2,3,4...)
  // =============================================

  const sortedContracts = useMemo(() => {
    return [...filteredContracts].sort((a, b) =>
      compareBuildingThenRoom(
        a.room?.building?.name ?? '',
        a.room?.name ?? '',
        b.room?.building?.name ?? '',
        b.room?.name ?? '',
      ),
    );
  }, [filteredContracts]);

  // =============================================
  // Pagination (client-side slice)
  // =============================================

  const totalCount = sortedContracts.length;
  const paginatedContracts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedContracts.slice(start, start + pageSize);
  }, [sortedContracts, page, pageSize]);

  // =============================================
  // Handlers
  // =============================================

  const handleStatFilterChange = useCallback((filter: ContractStatFilter) => {
    setActiveStatFilter(filter);
    // Đồng bộ lifecycle filter để không bị mâu thuẫn với stats card
    if (filter === 'TERMINATED') setLifecycleFilter('TERMINATED');
    else if (filter === 'ALL') setLifecycleFilter('ALL');
    else setLifecycleFilter('ACTIVE');
    setPage(1);
  }, []);

  const handleLifecycleChange = useCallback((value: ContractLifecycleFilter) => {
    setLifecycleFilter(value);
    setPage(1);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
    setPage(1);
  }, []);

  // Đổi toà nhà → reset phòng (phòng cũ có thể không thuộc các toà mới)
  const handleBuildingIdsChange = useCallback((ids: string[]) => {
    setBuildingIds(ids);
    setRoomFilter('all');
    setPage(1);
  }, []);

  const handleRoomChange = useCallback((value: string) => {
    setRoomFilter(value);
    setPage(1);
  }, []);

  const handleMonthChange = useCallback((value: string) => {
    setMonthFilter(value);
    setPage(1);
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  }, []);

  // Dialog handlers
  const handleEdit = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setFormDialogOpen(true);
  }, []);

  const handleRenew = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setRenewDialogOpen(true);
  }, []);

  const handleTransferRoom = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setTransferRoomDialogOpen(true);
  }, []);

  const handleMoveOut = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setMoveOutDialogOpen(true);
  }, []);

  const handleTransferContract = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setTransferContractDialogOpen(true);
  }, []);

  const handleTerminate = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setTerminateDialogOpen(true);
  }, []);

  const handleDelete = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setDeleteDialogOpen(true);
  }, []);

  const handleShowQR = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setQrDialogOpen(true);
  }, []);

  const handlePrint = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setPrintDialogOpen(true);
  }, []);

  const hasFilters =
    searchTerm ||
    buildingIds.length > 0 ||
    roomFilter !== 'all' ||
    lifecycleFilter !== 'ALL' ||
    monthFilter ||
    activeStatFilter !== 'ALL';

  // =============================================
  // Render
  // =============================================

  return (
    <MainLayout title="Hợp đồng thuê" subtitle="Khách hàng > Hợp đồng" icon={FileText}>
      <div className="space-y-4">
        {/* Stats Cards */}
        <ContractStatsCards
          stats={stats}
          activeFilter={activeStatFilter}
          onFilterChange={handleStatFilterChange}
        />

        {/* Filters row */}
        {showFilters && (
          <ContractListFilters
            searchTerm={searchTerm}
            onSearchChange={handleSearchChange}
            buildingIds={buildingIds}
            onBuildingIdsChange={handleBuildingIdsChange}
            roomFilter={roomFilter}
            onRoomChange={handleRoomChange}
            lifecycleFilter={lifecycleFilter}
            onLifecycleChange={handleLifecycleChange}
            monthFilter={monthFilter}
            onMonthChange={handleMonthChange}
            areas={areas}
            buildings={allBuildings}
            rooms={filteredRooms}
          />
        )}

        {/* Search + Toolbar row */}
        <div className="flex items-center justify-between gap-4">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo mã HĐ, tên khách, SĐT, tên phòng..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1">
            {hasAnyScope && (
              <Button onClick={() => setFormDialogOpen(true)} size="icon" className="h-8 w-8 bg-green-500 hover:bg-green-600">
                <Plus className="h-4 w-4" />
              </Button>
            )}
            {hasAnyScope && (
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setImportDialogOpen(true)} title="Nhập">
                <Upload className="h-4 w-4" />
              </Button>
            )}
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => exportContracts(sortedContracts)} title="Xuất">
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant={showFilters ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowFilters((prev) => !prev)}
              title="Bộ lọc"
            >
              <Filter className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
          ) : filteredContracts.length === 0 ? (
            hasFilters ? (
              <div className="p-8 text-center text-muted-foreground">
                Không tìm thấy hợp đồng nào
              </div>
            ) : (
              <EmptyState
                icon={FileText}
                title="Chưa có hợp đồng nào"
                description="Hãy thêm hợp đồng đầu tiên để bắt đầu quản lý"
                actionLabel={hasAnyScope ? 'Thêm hợp đồng' : undefined}
                onAction={hasAnyScope ? () => setFormDialogOpen(true) : undefined}
              />
            )
          ) : (
            <ContractListTable
              contracts={paginatedContracts}
              selectedIds={selectedContractIds}
              onSelectionChange={setSelectedContractIds}
              onEdit={handleEdit}
              onRenew={handleRenew}
              onTransferRoom={handleTransferRoom}
              onMoveOut={handleMoveOut}
              onTransferContract={handleTransferContract}
              onTerminate={handleTerminate}
              onDelete={handleDelete}
              onPrint={handlePrint}
              onShowQR={handleShowQR}
              page={page}
              pageSize={pageSize}
              totalCount={totalCount}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          )}
        </div>

        {/* Dialogs */}
        <ContractFormDialog
          open={formDialogOpen}
          onOpenChange={(open) => {
            setFormDialogOpen(open);
            if (!open) setSelectedContract(null);
          }}
          contract={selectedContract ?? undefined}
        />
        {selectedContract && (
          <RenewDialog
            open={renewDialogOpen}
            onOpenChange={(open) => {
              setRenewDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        {selectedContract && (
          <TransferRoomDialog
            open={transferRoomDialogOpen}
            onOpenChange={(open) => {
              setTransferRoomDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        {selectedContract && (
          <MoveOutDialog
            open={moveOutDialogOpen}
            onOpenChange={(open) => {
              setMoveOutDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        {selectedContract && (
          <TransferContractDialog
            open={transferContractDialogOpen}
            onOpenChange={(open) => {
              setTransferContractDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        {selectedContract && (
          <TerminateDialog
            open={terminateDialogOpen}
            onOpenChange={(open) => {
              setTerminateDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        {selectedContract && (
          <DeleteContractDialog
            open={deleteDialogOpen}
            onOpenChange={(open) => {
              setDeleteDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={selectedContract}
          />
        )}
        <ContractImportExportDialog
          open={importDialogOpen}
          onOpenChange={setImportDialogOpen}
          mode="import"
        />
        <PrintContractDialog
          open={printDialogOpen}
          onOpenChange={(open) => {
            setPrintDialogOpen(open);
            if (!open) setSelectedContract(null);
          }}
          contract={selectedContract}
        />
        {selectedContract && (
          <ContractQRDialog
            open={qrDialogOpen}
            onOpenChange={(open) => {
              setQrDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            publicCode={selectedContract.public_code}
            contractLabel={
              selectedContract.contract_number ||
              selectedContract.id.slice(0, 8)
            }
            buildingName={selectedContract.room?.building?.name}
            roomName={selectedContract.room?.name}
          />
        )}
      </div>
    </MainLayout>
  );
}
