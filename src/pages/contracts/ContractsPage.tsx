import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { FileText, Plus, Upload, Download, Filter, Search, AlertTriangle } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';

// Mobile: trang Hợp đồng dạng app full-screen (CSS + font scope riêng) — lazy
// để chỉ nạp trên điện thoại, không kéo vào bundle desktop.
const ContractsMobilePage = lazy(() => import('./ContractsMobilePage'));
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
import ContractDetailModal from '@/components/contracts/ContractDetailModal';
import { exportContracts } from '@/lib/contractExcelHelpers';

import {
  useContractsPaged,
  useContractStats,
  useContract,
  fetchContractsForExport,
  type ContractPagedFilters,
} from '@/hooks/useContracts';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useProfile } from '@/hooks/useProfile';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { compareBuildingThenRoom } from '@/lib/roomSort';
import { toast } from 'sonner';
import type {
  ContractWithRelations,
  ContractStatFilter,
  ContractLifecycleFilter,
  ContractStats,
} from '@/types/contract';
import type { BuildingWithRelations } from '@/types/building';
import type { RoomWithRelations } from '@/types/room';

// Tiêu đề thanh modal: "Toà Phòng · Khách đại diện" (fallback số HĐ).
function contractModalTitle(c: ContractWithRelations): string {
  const rep =
    c.contract_customers?.find((cc) => cc.is_representative)?.customer?.full_name ||
    c.contract_customers?.[0]?.customer?.full_name ||
    '';
  const loc = [c.room?.building?.name, c.room?.name].filter(Boolean).join(' ');
  const base = [loc, rep].filter(Boolean).join(' · ');
  return base || `Hợp đồng ${c.contract_number || c.id.slice(0, 8)}`;
}

function ContractsDesktopPage() {
  // =============================================
  // State
  // =============================================

  // Stats filter
  const [activeStatFilter, setActiveStatFilter] = useState<ContractStatFilter>('ALL');

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  // Search đẩy xuống server → debounce để không bắn query mỗi phím gõ.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Lọc theo nhiều toà nhà (khu vực = phím tắt chọn nhóm toà). [] = tất cả.
  const [buildingIds, setBuildingIds] = useState<string[]>([]);
  const [roomFilter, setRoomFilter] = useState('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<ContractLifecycleFilter>('ACTIVE');
  const [monthFilter, setMonthFilter] = useState('');
  const [showFilters, setShowFilters] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const areaDefaultAppliedRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

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

  // Modal xem chi tiết — mở ngay tại trang để KHÔNG mất bộ lọc đang dò.
  const [detailContract, setDetailContract] = useState<ContractWithRelations | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  // =============================================
  // Data fetching — phân trang + lọc SERVER-SIDE (useContractsPaged)
  // =============================================

  const pagedFilters = useMemo<ContractPagedFilters>(
    () => ({
      search: debouncedSearch || undefined,
      building_ids: buildingIds.length > 0 ? buildingIds : undefined,
      room_name: roomFilter !== 'all' ? roomFilter : undefined,
      lifecycle: lifecycleFilter,
      stat: activeStatFilter,
      month: monthFilter || undefined,
    }),
    [debouncedSearch, buildingIds, roomFilter, lifecycleFilter, activeStatFilter, monthFilter]
  );

  const { data: pagedContracts, isLoading, isError, error, refetch } = useContractsPaged(pagedFilters, {
    page,
    pageSize,
  });
  const contracts = useMemo(
    () => (pagedContracts?.data ?? []) as ContractWithRelations[],
    [pagedContracts]
  );
  const totalCount = pagedContracts?.count ?? 0;

  // HĐ đang chọn cho dialog: dòng trong danh sách là bản RÚT GỌN (không có
  // contract_services / CMND...), nên fetch bản đầy đủ qua useContract(id) —
  // dialog Sửa/In cần đủ dữ liệu (form reset lại khi prop contract đổi).
  const { data: selectedContractFull } = useContract(selectedContract?.id);
  const dialogContract: ContractWithRelations | null =
    selectedContract && selectedContractFull?.id === selectedContract.id
      ? selectedContractFull
      : selectedContract;

  const { data: buildingsData } = useBuildings();
  const allBuildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as unknown as BuildingWithRelations[],
    [buildingsData]
  );

  const { data: roomsData } = useRooms();
  const allRooms = useMemo(
    () => (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[],
    [roomsData]
  );

  const { data: profile } = useProfile();
  const { hasAnyScope: hasBuildingScope } = useMyBuildingScope();
  const { data: perms } = useMyPermissions();
  // Tạo HĐ cần cả scope toà lẫn quyền contracts.create; nhập file đi theo create.
  const hasAnyScope = hasBuildingScope && canUse(perms, 'contracts', 'create');
  const canExport = canUse(perms, 'contracts', 'export');

  // =============================================
  // Compute areas from buildings
  // =============================================

  const areas = useMemo(() => {
    const areaMap = new Map<string, { id: string; name: string; code: string | null; status: string }>();
    allBuildings.forEach((b) => {
      (b.areas ?? []).forEach((a) => {
        if (!areaMap.has(a.id)) {
          areaMap.set(a.id, { id: a.id, name: a.name, code: a.code, status: 'ACTIVE' });
        }
      });
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
          allBuildings
            .filter((b) => (b.area_ids ?? []).includes(matched.id))
            .map((b) => b.id)
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
  // Stats 4 ô — 4 HEAD count song song server-side (useContractStats),
  // không còn tính từ full list. Theo bộ lọc toà nhà đang chọn.
  // =============================================

  const { data: statsData } = useContractStats(buildingIds);
  const stats = useMemo<ContractStats>(
    () => statsData ?? { total: 0, expiring: 0, expired: 0, terminated: 0 },
    [statsData]
  );

  // =============================================
  // Sort TRONG TRANG: gom theo toà nhà rồi tên phòng (MB* → G* → L* → 1,2,3...)
  // Thứ tự toàn cục giữa các trang là created_at desc (server); sort tuỳ biến
  // này không đẩy xuống SQL được nên chỉ áp trong phạm vi 1 trang.
  // =============================================

  const sortedContracts = useMemo(() => {
    return [...contracts].sort((a, b) =>
      compareBuildingThenRoom(
        a.room?.building?.name ?? '',
        a.room?.name ?? '',
        b.room?.building?.name ?? '',
        b.room?.name ?? '',
      ),
    );
  }, [contracts]);

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

  const handleView = useCallback((contract: ContractWithRelations) => {
    setDetailContract(contract);
    setDetailModalOpen(true);
  }, []);

  // Xuất Excel: kéo TOÀN BỘ kết quả theo filter hiện tại (loop .range từng
  // khúc 1000) — không chỉ trang đang xem.
  const handleExport = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const all = await fetchContractsForExport(pagedFilters);
      const sorted = [...all].sort((a, b) =>
        compareBuildingThenRoom(
          a.room?.building?.name ?? '',
          a.room?.name ?? '',
          b.room?.building?.name ?? '',
          b.room?.name ?? '',
        ),
      );
      await exportContracts(sorted);
    } catch (e: any) {
      console.error('Export contracts failed:', e);
      toast.error('Không xuất được danh sách hợp đồng', {
        description: e?.message,
      });
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, pagedFilters]);

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
            {canExport && (
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleExport} disabled={isExporting} title="Xuất">
                <Download className="h-4 w-4" />
              </Button>
            )}
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
          ) : isError ? (
            <div className="p-8 flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="h-10 w-10 text-destructive" />
              <div className="font-medium">Không tải được danh sách hợp đồng</div>
              <div className="text-sm text-muted-foreground max-w-md break-words">
                {(error as Error)?.message || 'Lỗi kết nối hoặc máy chủ. Vui lòng thử lại.'}
              </div>
              <Button variant="outline" onClick={() => refetch()}>Thử lại</Button>
            </div>
          ) : contracts.length === 0 ? (
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
              contracts={sortedContracts}
              selectedIds={selectedContractIds}
              onSelectionChange={setSelectedContractIds}
              onView={handleView}
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

        {/* Dialogs — dùng dialogContract (bản FULL từ useContract(id), fallback
            bản rút gọn của danh sách trong lúc đang fetch). Dialog Sửa/In cần
            contract_services + thông tin khách đầy đủ vốn không còn trong
            select rút gọn của danh sách. */}
        <ContractFormDialog
          open={formDialogOpen}
          onOpenChange={(open) => {
            setFormDialogOpen(open);
            if (!open) setSelectedContract(null);
          }}
          contract={dialogContract ?? undefined}
        />
        {dialogContract && (
          <RenewDialog
            open={renewDialogOpen}
            onOpenChange={(open) => {
              setRenewDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
          />
        )}
        {dialogContract && (
          <TransferRoomDialog
            open={transferRoomDialogOpen}
            onOpenChange={(open) => {
              setTransferRoomDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
          />
        )}
        {dialogContract && (
          <MoveOutDialog
            open={moveOutDialogOpen}
            onOpenChange={(open) => {
              setMoveOutDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
          />
        )}
        {dialogContract && (
          <TransferContractDialog
            open={transferContractDialogOpen}
            onOpenChange={(open) => {
              setTransferContractDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
          />
        )}
        {dialogContract && (
          <TerminateDialog
            open={terminateDialogOpen}
            onOpenChange={(open) => {
              setTerminateDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
          />
        )}
        {dialogContract && (
          <DeleteContractDialog
            open={deleteDialogOpen}
            onOpenChange={(open) => {
              setDeleteDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            contract={dialogContract}
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
          contract={dialogContract}
        />
        {dialogContract && (
          <ContractQRDialog
            open={qrDialogOpen}
            onOpenChange={(open) => {
              setQrDialogOpen(open);
              if (!open) setSelectedContract(null);
            }}
            publicCode={dialogContract.public_code}
            contractLabel={
              dialogContract.contract_number ||
              dialogContract.id.slice(0, 8)
            }
            buildingName={dialogContract.room?.building?.name}
            roomName={dialogContract.room?.name}
          />
        )}

        {/* Xem chi tiết hợp đồng — modal full-screen (giữ nguyên bộ lọc danh sách) */}
        <ContractDetailModal
          contractId={detailContract?.id ?? null}
          title={detailContract ? contractModalTitle(detailContract) : ''}
          open={detailModalOpen}
          onOpenChange={setDetailModalOpen}
        />
      </div>
    </MainLayout>
  );
}

// Mobile (≤767px): màn hình app full-screen riêng. Khởi tạo ĐỒNG BỘ từ
// matchMedia (như HomeRoute) để không nháy bảng desktop / không mount query
// nặng của desktop trên điện thoại. Wrapper giữ số hook cố định → an toàn
// rules-of-hooks khi đổi kích thước.
function usePhoneViewport() {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const onChange = () => setPhone(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return phone;
}

export default function ContractsPage() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <ContractsMobilePage />
      </Suspense>
    );
  }
  return <ContractsDesktopPage />;
}
