// =============================================================
// Prefetch registry cho Home launcher (mobile web-app).
// Khi ngón tay chạm/rê một ô, ta nạp TRƯỚC song song:
//   - chunks: code chunk của route (+ biến thể *MobilePage lồng bên trong) để
//     bỏ waterfall 2 lần tải JS khi điều hướng.
//   - data: dữ liệu mặc định của trang qua queryClient.prefetchQuery, dùng đúng
//     query-options factory + queryKey mà trang dùng ở render đầu → vào trang là
//     đọc cache, không nháy "Đang tải".
// Key của map = tile.id trong launcherTiles.ts.
// =============================================================
import type { QueryClient } from '@tanstack/react-query';
import {
  contractsPagedQueryOptions,
  contractStatsQueryOptions,
  CONTRACTS_MOBILE_DEFAULT_FILTERS,
  CONTRACTS_MOBILE_DEFAULT_PAGINATION,
  CONTRACTS_STATS_DEFAULT_BUILDING_IDS,
} from '@/hooks/useContracts';
import {
  customersQueryOptions,
  CUSTOMERS_MOBILE_DEFAULT_FILTERS,
  CUSTOMERS_MOBILE_DEFAULT_PAGINATION,
} from '@/hooks/useCustomers';
import {
  invoicesQueryOptions,
  INVOICES_MOBILE_DEFAULT_FILTERS,
  INVOICES_MOBILE_DEFAULT_PAGINATION,
} from '@/hooks/useInvoices';
import { roomsQueryOptions } from '@/hooks/useRooms';
import { buildingsQueryOptions } from '@/hooks/useBuildings';

export interface PrefetchEntry {
  /** Nạp trước code chunk (route lazy + biến thể mobile lồng). */
  chunks: () => Promise<unknown>[];
  /** Nạp trước dữ liệu mặc định của trang (fire-and-forget). */
  data?: (qc: QueryClient) => void;
}

export const LAUNCHER_PREFETCH: Record<string, PrefetchEntry> = {
  // ---- Trang danh sách chính: prefetch cả chunk lẫn data ----
  contracts: {
    chunks: () => [
      import('@/pages/contracts/ContractsPage'),
      import('@/pages/contracts/ContractsMobilePage'),
    ],
    data: (qc) => {
      qc.prefetchQuery(
        contractsPagedQueryOptions(
          CONTRACTS_MOBILE_DEFAULT_FILTERS,
          CONTRACTS_MOBILE_DEFAULT_PAGINATION,
        ),
      );
      qc.prefetchQuery(contractStatsQueryOptions(CONTRACTS_STATS_DEFAULT_BUILDING_IDS));
      qc.prefetchQuery(buildingsQueryOptions());
      qc.prefetchQuery(roomsQueryOptions());
    },
  },
  customers: {
    chunks: () => [
      import('@/pages/customers/CustomersPage'),
      import('@/pages/customers/CustomersMobilePage'),
    ],
    data: (qc) => {
      qc.prefetchQuery(
        customersQueryOptions(
          CUSTOMERS_MOBILE_DEFAULT_FILTERS,
          CUSTOMERS_MOBILE_DEFAULT_PAGINATION,
        ),
      );
      qc.prefetchQuery(buildingsQueryOptions());
    },
  },
  invoices: {
    chunks: () => [
      import('@/pages/invoices/InvoicesPage'),
      import('@/pages/invoices/InvoicesMobilePage'),
    ],
    data: (qc) => {
      qc.prefetchQuery(
        invoicesQueryOptions(
          INVOICES_MOBILE_DEFAULT_FILTERS,
          INVOICES_MOBILE_DEFAULT_PAGINATION,
        ),
      );
      qc.prefetchQuery(buildingsQueryOptions());
      qc.prefetchQuery(roomsQueryOptions());
    },
  },
  // /apartments chưa có biến thể mobile riêng → chỉ chunk RoomsPage + data tham chiếu.
  rooms: {
    chunks: () => [import('@/pages/rooms/RoomsPage')],
    data: (qc) => {
      qc.prefetchQuery(roomsQueryOptions());
      qc.prefetchQuery(buildingsQueryOptions());
    },
  },
  // Thu tiền chọn toà động (effect set buildings[0].id) → KHÔNG prefetch danh
  // sách invoice (key đầu bị vứt). Chỉ chunk + buildings (cần để chọn toà đầu).
  'thu-tien': {
    chunks: () => [import('@/pages/ThuTien')],
    data: (qc) => {
      qc.prefetchQuery(buildingsQueryOptions());
    },
  },
  // Bảng tin: route DashboardRoute import tĩnh, chỉ biến thể mobile mới lazy.
  // Stats đã được HomeLauncher gọi sẵn (useDashboardStats) nên không cần data.
  dashboard: {
    chunks: () => [import('@/pages/DashboardMobilePage')],
  },

  // ---- Các ô còn lại: chỉ prefetch chunk (bỏ waterfall JS) ----
  map: { chunks: () => [import('@/pages/building-map/BuildingMapPage')] },
  leads: { chunks: () => [import('@/pages/leads/LeadsPage')] },
  tasks: { chunks: () => [import('@/pages/TaskManagementPage')] },
  vehicles: { chunks: () => [import('@/pages/vehicles/VehiclesPage')] },
  meters: { chunks: () => [import('@/pages/meter-readings/MeterReadingsPage')] },
  cashbook: { chunks: () => [import('@/pages/payments/IncomeExpensePage')] },
  funds: { chunks: () => [import('@/pages/settings/finance/CashbooksPage')] },
  reports: { chunks: () => [import('@/pages/reports/RealEstateReportsPage')] },
  settings: { chunks: () => [import('@/pages/settings/GeneralSettingsPage')] },
  account: { chunks: () => [import('@/pages/account/ProfilePage')] },
};

/** Chạy prefetch cho một tile (idempotent: prefetchQuery tôn trọng staleTime,
 *  import() được module cache dedupe). */
export function runLauncherPrefetch(tileId: string, qc: QueryClient): void {
  const entry = LAUNCHER_PREFETCH[tileId];
  if (!entry) return;
  // Bỏ promise — chỉ cần kích hoạt tải.
  entry.chunks();
  entry.data?.(qc);
}
