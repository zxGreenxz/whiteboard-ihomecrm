import { useState, useMemo, useCallback } from 'react';
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
import { exportContracts } from '@/lib/contractExcelHelpers';

import { useContracts } from '@/hooks/useContracts';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { getContractDisplayStatus } from '@/types/contract';
import type {
  ContractWithRelations,
  ContractStatFilter,
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
  const [areaFilter, setAreaFilter] = useState('all');
  const [buildingFilter, setBuildingFilter] = useState('all');
  const [roomFilter, setRoomFilter] = useState('all');
  const [bedFilter, setBedFilter] = useState('all');
  const [rentalTypeFilter, setRentalTypeFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState('');
  const [showFilters, setShowFilters] = useState(true);

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

  const { data: bedsData } = useBeds();
  const allBeds = useMemo(
    () => (Array.isArray(bedsData) ? bedsData : []) as any[],
    [bedsData]
  );

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

  // =============================================
  // Cascading filter data
  // =============================================

  const filteredBuildings = useMemo(() => {
    if (areaFilter === 'all') return allBuildings;
    return allBuildings.filter((b) => b.area_id === areaFilter);
  }, [allBuildings, areaFilter]);

  const filteredRooms = useMemo(() => {
    if (buildingFilter === 'all') return allRooms;
    return allRooms.filter((r) => r.building_id === buildingFilter);
  }, [allRooms, buildingFilter]);

  const filteredBeds = useMemo(() => {
    if (roomFilter === 'all') return allBeds;
    return allBeds.filter((b: any) => b.room_id === roomFilter);
  }, [allBeds, roomFilter]);

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

      // Area filter
      if (areaFilter !== 'all') {
        if (contract.room?.building?.area_id !== areaFilter) return false;
      }

      // Building filter
      if (buildingFilter !== 'all') {
        if (contract.room?.building_id !== buildingFilter) return false;
      }

      // Room filter
      if (roomFilter !== 'all') {
        if (contract.room_id !== roomFilter) return false;
      }

      // Bed filter
      if (bedFilter !== 'all') {
        if (contract.bed_id !== bedFilter) return false;
      }

      // Rental type filter
      if (rentalTypeFilter !== 'all') {
        if (contract.room?.building?.type !== rentalTypeFilter) return false;
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
    searchTerm,
    areaFilter,
    buildingFilter,
    roomFilter,
    bedFilter,
    rentalTypeFilter,
    monthFilter,
  ]);

  // =============================================
  // Pagination (client-side slice)
  // =============================================

  const totalCount = filteredContracts.length;
  const paginatedContracts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredContracts.slice(start, start + pageSize);
  }, [filteredContracts, page, pageSize]);

  // =============================================
  // Handlers
  // =============================================

  const handleStatFilterChange = useCallback((filter: ContractStatFilter) => {
    setActiveStatFilter(filter);
    setPage(1);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
    setPage(1);
  }, []);

  const handleAreaChange = useCallback((value: string) => {
    setAreaFilter(value);
    setPage(1);
  }, []);

  const handleBuildingChange = useCallback((value: string) => {
    setBuildingFilter(value);
    setPage(1);
  }, []);

  const handleRoomChange = useCallback((value: string) => {
    setRoomFilter(value);
    setPage(1);
  }, []);

  const handleBedChange = useCallback((value: string) => {
    setBedFilter(value);
    setPage(1);
  }, []);

  const handleRentalTypeChange = useCallback((value: string) => {
    setRentalTypeFilter(value);
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

  const handlePrint = useCallback((contract: ContractWithRelations) => {
    setSelectedContract(contract);
    setPrintDialogOpen(true);
  }, []);

  const hasFilters =
    searchTerm ||
    areaFilter !== 'all' ||
    buildingFilter !== 'all' ||
    roomFilter !== 'all' ||
    bedFilter !== 'all' ||
    rentalTypeFilter !== 'all' ||
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
            areaFilter={areaFilter}
            onAreaChange={handleAreaChange}
            buildingFilter={buildingFilter}
            onBuildingChange={handleBuildingChange}
            roomFilter={roomFilter}
            onRoomChange={handleRoomChange}
            bedFilter={bedFilter}
            onBedChange={handleBedChange}
            rentalTypeFilter={rentalTypeFilter}
            onRentalTypeChange={handleRentalTypeChange}
            monthFilter={monthFilter}
            onMonthChange={handleMonthChange}
            areas={areas}
            buildings={filteredBuildings}
            rooms={filteredRooms}
            beds={filteredBeds}
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
            <Button onClick={() => setFormDialogOpen(true)} size="icon" className="h-8 w-8 bg-green-500 hover:bg-green-600">
              <Plus className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setImportDialogOpen(true)} title="Nhập">
              <Upload className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => exportContracts(filteredContracts)} title="Xuất">
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
                actionLabel="Thêm hợp đồng"
                onAction={() => setFormDialogOpen(true)}
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
      </div>
    </MainLayout>
  );
}
