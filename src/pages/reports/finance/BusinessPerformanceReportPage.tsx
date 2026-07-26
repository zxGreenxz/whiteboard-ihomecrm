import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  BarChart3,
  Building2,
  CalendarDays,
  ChevronRight,
  Info,
  Scale,
  TriangleAlert,
} from "lucide-react";

import MainLayout from "@/components/layout/MainLayout";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useBusinessPerformanceOrganizations } from "@/hooks/reports/useBusinessPerformance";
import {
  allowedBusinessPerformanceTabs,
  buildBusinessPerformanceFilters,
  canViewRestrictedBusinessPerformance,
  resolveAuthorizedBuildingIds,
  resolveBusinessPerformanceTab,
  type BusinessPerformanceBasis,
  type BusinessPerformanceFilters,
  type BusinessPerformanceOrganization,
  type BusinessPerformanceTabId,
} from "@/lib/businessPerformance";

type ReportTabProps = { filters: BusinessPerformanceFilters };
type ReportBuilding = { id: string; name: string };

const BusinessOverviewTab = lazy(() =>
  import("@/components/finance-performance/BusinessOverviewTab").then(
    (module) => ({
      default: module.BusinessOverviewTab,
    }),
  ),
);
const BuildingPerformanceTab = lazy(() =>
  import("@/components/finance-performance/BuildingPerformanceTab").then(
    (module) => ({
      default: module.BuildingPerformanceTab,
    }),
  ),
);
const OccupancyVacancyTab = lazy(() =>
  import("@/components/finance-performance/OccupancyVacancyTab").then(
    (module) => ({
      default: module.OccupancyVacancyTab,
    }),
  ),
);
const CollectionsDebtTab = lazy(() =>
  import("@/components/finance-performance/CollectionsDebtTab").then(
    (module) => ({
      default: module.CollectionsDebtTab,
    }),
  ),
);
const RevenueCostStructureTab = lazy(() =>
  import("@/components/finance-performance/RevenueCostStructureTab").then(
    (module) => ({
      default: module.RevenueCostStructureTab,
    }),
  ),
);
const TrendsComparisonTab = lazy(() =>
  import("@/components/finance-performance/TrendsComparisonTab").then(
    (module) => ({
      default: module.TrendsComparisonTab,
    }),
  ),
);
const DataDefinitionsTab = lazy(() =>
  import("@/components/finance-performance/DataDefinitionsTab").then(
    (module) => ({
      default: module.DataDefinitionsTab,
    }),
  ),
);

const BASIS_OPTIONS = [
  { value: "ACCRUAL", label: "Dồn tích theo kỳ áp dụng" },
  { value: "VOUCHER_DATE", label: "Theo ngày phiếu — đối chiếu" },
] satisfies ReadonlyArray<{ value: BusinessPerformanceBasis; label: string }>;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
const ACTIVE_REPORT_REGION_ID = "business-performance-active-report";
const ACTIVE_REPORT_LABEL_ID = "business-performance-active-report-label";
const BUSINESS_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

function currentBusinessMonthParts(): { year: number; monthIndex: number } {
  const parts = BUSINESS_MONTH_FORMATTER.formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return { year, monthIndex: month - 1 };
}

function currentMonth(): string {
  const { year, monthIndex } = currentBusinessMonthParts();
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [year, value] = month.split("-");
  return `Tháng ${value}/${year}`;
}

function buildMonthOptions(selectedMonth: string) {
  const { year, monthIndex } = currentBusinessMonthParts();
  const options = Array.from({ length: 72 }, (_, offset) => {
    const date = new Date(Date.UTC(year, monthIndex - offset, 1));
    const value = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { value, label: monthLabel(value), keywords: value };
  });

  if (!options.some((option) => option.value === selectedMonth)) {
    options.push({
      value: selectedMonth,
      label: monthLabel(selectedMonth),
      keywords: selectedMonth,
    });
  }

  return options;
}

function ActiveReportTab({
  tab,
  filters,
  buildings,
}: ReportTabProps & {
  tab: BusinessPerformanceTabId;
  buildings: readonly ReportBuilding[];
}) {
  switch (tab) {
    case "building-performance":
      return <BuildingPerformanceTab filters={filters} buildings={buildings} />;
    case "occupancy-vacancy":
      return <OccupancyVacancyTab filters={filters} />;
    case "collections-debt":
      return <CollectionsDebtTab filters={filters} />;
    case "revenue-cost-structure":
      return <RevenueCostStructureTab filters={filters} />;
    case "trends-comparison":
      return <TrendsComparisonTab filters={filters} />;
    case "data-definitions":
      return <DataDefinitionsTab filters={filters} />;
    case "business-overview":
    default:
      return <BusinessOverviewTab filters={filters} />;
  }
}

function ReportLoadingState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Đang xác minh quyền truy cập báo cáo"
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">
        Đang xác minh quyền truy cập báo cáo…
      </p>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          aria-label="Thử xác minh lại quyền truy cập"
          data-testid="retry-business-performance-authorization"
          onClick={onRetry}
        >
          Thử xác minh lại
        </Button>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function AuthorizationBoundaryState({ children }: { children: ReactNode }) {
  return (
    <MainLayout>
      <div className="mx-auto w-full max-w-4xl py-4 sm:py-8">{children}</div>
    </MainLayout>
  );
}

function AuthorizationErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <AuthorizationBoundaryState>
      <Alert
        variant="destructive"
        data-testid="business-performance-auth-error"
      >
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Không thể xác minh quyền truy cập</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <p>
            Báo cáo đã dừng tải dữ liệu để bảo vệ thông tin tài chính. Hãy thử
            xác minh lại sau khi kết nối ổn định.
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            aria-label="Thử xác minh lại quyền truy cập"
            data-testid="retry-business-performance-authorization"
            onClick={onRetry}
          >
            Thử xác minh lại
          </Button>
        </AlertDescription>
      </Alert>
    </AuthorizationBoundaryState>
  );
}

type AuthorizedReportPageProps = {
  organizations: BusinessPerformanceOrganization[];
};

export default function BusinessPerformanceReportPage() {
  const {
    data: organizations = [],
    isLoading: organizationsLoading,
    isFetching: organizationsFetching,
    status: organizationsStatus,
    fetchStatus: organizationsFetchStatus,
    isError: organizationsError,
    refetch: refetchOrganizations,
  } = useBusinessPerformanceOrganizations();

  if (
    organizationsLoading ||
    organizationsFetching ||
    organizationsStatus === "pending" ||
    organizationsFetchStatus === "paused"
  ) {
    return (
      <AuthorizationBoundaryState>
        <ReportLoadingState
          onRetry={
            organizationsFetchStatus === "paused"
              ? () => void refetchOrganizations()
              : undefined
          }
        />
      </AuthorizationBoundaryState>
    );
  }

  if (organizationsError) {
    return (
      <AuthorizationErrorState
        onRetry={() => void refetchOrganizations()}
      />
    );
  }

  if (organizations.length === 0) {
    return (
      <AuthorizationBoundaryState>
        <Alert
          variant="destructive"
          data-testid="business-performance-auth-empty"
        >
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>Không có phạm vi báo cáo được cấp</AlertTitle>
          <AlertDescription>
            Tài khoản hiện không có tổ chức và tòa nhà hợp lệ từ nguồn phân
            quyền của báo cáo. Trang không tải bất kỳ dữ liệu tài chính nào.
          </AlertDescription>
        </Alert>
      </AuthorizationBoundaryState>
    );
  }

  return <AuthorizedBusinessPerformanceReportPage organizations={organizations} />;
}

function AuthorizedBusinessPerformanceReportPage({
  organizations,
}: AuthorizedReportPageProps) {
  const isPhone = usePhoneViewport();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const rawOrganizationId = searchParams.get("org");
  const hasOrganizationParam = searchParams.has("org");

  const [storedMonth, setStoredMonth] = usePersistedState<string>(
    "flt:rpt-business-performance:month",
    currentMonth,
  );
  const [selectedBuildingIds, setSelectedBuildingIds] = usePersistedState<
    string[]
  >("flt:rpt-business-performance:buildingIds", []);
  const [storedBasis, setStoredBasis] =
    usePersistedState<BusinessPerformanceBasis>(
      "flt:rpt-business-performance:basis",
      "ACCRUAL",
    );
  const [storedOrganizationId, setStoredOrganizationId] =
    usePersistedState<string>(
      "flt:rpt-business-performance:organizationId",
      "",
    );

  const month = MONTH_PATTERN.test(storedMonth) ? storedMonth : currentMonth();
  const basis: BusinessPerformanceBasis =
    storedBasis === "VOUCHER_DATE" ? "VOUCHER_DATE" : "ACCRUAL";
  const monthOptions = useMemo(() => buildMonthOptions(month), [month]);
  const safeSelectedBuildingIds = useMemo(
    () =>
      Array.isArray(selectedBuildingIds)
        ? Array.from(
            new Set(
              selectedBuildingIds.filter((id) => typeof id === "string" && id),
            ),
          )
        : [],
    [selectedBuildingIds],
  );

  const organizationIds = useMemo(
    () => organizations.map((organization) => organization.id),
    [organizations],
  );
  const organizationIdSet = useMemo(
    () => new Set(organizationIds),
    [organizationIds],
  );
  const selectedOrganizationId = useMemo(() => {
    if (hasOrganizationParam) {
      return rawOrganizationId && organizationIdSet.has(rawOrganizationId)
        ? rawOrganizationId
        : "";
    }
    if (storedOrganizationId && organizationIdSet.has(storedOrganizationId)) {
      return storedOrganizationId;
    }
    return organizationIds.length === 1 ? organizationIds[0] : "";
  }, [
    hasOrganizationParam,
    organizationIdSet,
    organizationIds,
    rawOrganizationId,
    storedOrganizationId,
  ]);
  const invalidOrganizationParam =
    hasOrganizationParam &&
    (!rawOrganizationId || !organizationIdSet.has(rawOrganizationId));
  const selectedOrganization = useMemo(
    () =>
      organizations.find(
        (organization) => organization.id === selectedOrganizationId,
      ),
    [organizations, selectedOrganizationId],
  );
  const organizationOptions = useMemo(
    () =>
      organizations.map((organization) => ({
        value: organization.id,
        label: organization.name,
        keywords: organization.id,
      })),
    [organizations],
  );
  const singleOrganizationLabel =
    organizationIds.length === 1
      ? (organizationOptions.find(
          (organization) => organization.value === organizationIds[0],
        )?.label ?? "")
      : "";
  const scopedPhysicalBuildings = useMemo(
    () => selectedOrganization?.authorized_buildings ?? [],
    [selectedOrganization],
  );
  const visibleSelectedBuildingIds = useMemo(
    () =>
      safeSelectedBuildingIds.length === 0
        ? []
        : resolveAuthorizedBuildingIds(
            selectedOrganization,
            safeSelectedBuildingIds,
          ),
    [safeSelectedBuildingIds, selectedOrganization],
  );
  const hasExplicitBuildingSelection =
    !Array.isArray(selectedBuildingIds) || selectedBuildingIds.length > 0;
  const buildingSelectionUnavailable =
    hasExplicitBuildingSelection && visibleSelectedBuildingIds.length === 0;
  const buildingFilterValue = buildingSelectionUnavailable
    ? safeSelectedBuildingIds
    : visibleSelectedBuildingIds;
  const buildingSelectionNeedsNormalization = useMemo(
    () =>
      !Array.isArray(selectedBuildingIds) ||
      selectedBuildingIds.length !== visibleSelectedBuildingIds.length ||
      selectedBuildingIds.some(
        (id, index) => id !== visibleSelectedBuildingIds[index],
      ),
    [selectedBuildingIds, visibleSelectedBuildingIds],
  );
  const resolvedBuildingIds = useMemo(
    () =>
      buildingSelectionUnavailable
        ? []
        : resolveAuthorizedBuildingIds(
            selectedOrganization,
            visibleSelectedBuildingIds,
          ),
    [
      buildingSelectionUnavailable,
      selectedOrganization,
      visibleSelectedBuildingIds,
    ],
  );
  const canViewRestrictedFinance = useMemo(
    () =>
      canViewRestrictedBusinessPerformance(
        selectedOrganization,
        resolvedBuildingIds,
      ),
    [resolvedBuildingIds, selectedOrganization],
  );
  const availableTabs = useMemo(
    () => allowedBusinessPerformanceTabs(canViewRestrictedFinance),
    [canViewRestrictedFinance],
  );
  const activeTab = resolveBusinessPerformanceTab(
    rawTab,
    canViewRestrictedFinance,
  );
  const activeReportRef = useRef<HTMLElement>(null);
  const previousActiveTabRef = useRef(activeTab);
  const activeTabLabel =
    availableTabs.find((tab) => tab.id === activeTab)?.label ?? activeTab;
  const canonicalQueryReady =
    Boolean(selectedOrganizationId) &&
    hasOrganizationParam &&
    rawOrganizationId === selectedOrganizationId &&
    rawTab === activeTab;
  const filters = useMemo(
    () =>
      selectedOrganizationId &&
      !buildingSelectionNeedsNormalization &&
      !buildingSelectionUnavailable &&
      resolvedBuildingIds.length > 0
        ? buildBusinessPerformanceFilters(
            month,
            resolvedBuildingIds,
            basis,
            selectedOrganizationId,
          )
        : null,
    [
      basis,
      buildingSelectionNeedsNormalization,
      buildingSelectionUnavailable,
      month,
      resolvedBuildingIds,
      selectedOrganizationId,
    ],
  );

  useEffect(() => {
    if (storedMonth !== month) setStoredMonth(month);
  }, [month, setStoredMonth, storedMonth]);

  useEffect(() => {
    if (storedBasis !== basis) setStoredBasis(basis);
  }, [basis, setStoredBasis, storedBasis]);

  useEffect(() => {
    if (buildingSelectionNeedsNormalization) return;

    const next = new URLSearchParams(searchParams);
    let changed = false;

    if (rawTab !== activeTab) {
      next.set("tab", activeTab);
      changed = true;
    }

    if (selectedOrganizationId) {
      if (rawOrganizationId !== selectedOrganizationId) {
        next.set("org", selectedOrganizationId);
        changed = true;
      }
    }

    if (changed) setSearchParams(next, { replace: true });
  }, [
    activeTab,
    buildingSelectionNeedsNormalization,
    rawOrganizationId,
    rawTab,
    searchParams,
    selectedOrganizationId,
    setSearchParams,
  ]);

  useEffect(() => {
    if (!canonicalQueryReady) return;

    const previousActiveTab = previousActiveTabRef.current;
    previousActiveTabRef.current = activeTab;
    if (previousActiveTab === activeTab) return;
    if (typeof window === "undefined") return;

    let focusFrame: number | null = null;
    const settleFrame = window.requestAnimationFrame(() => {
      focusFrame = window.requestAnimationFrame(() => {
        if (
          document.activeElement &&
          document.activeElement !== document.body
        ) {
          return;
        }

        activeReportRef.current?.focus();
      });
    });

    return () => {
      window.cancelAnimationFrame(settleFrame);
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [activeTab, canonicalQueryReady]);

  useEffect(() => {
    if (
      invalidOrganizationParam ||
      storedOrganizationId === selectedOrganizationId
    ) {
      return;
    }
    setStoredOrganizationId(selectedOrganizationId);
    if (
      storedOrganizationId &&
      selectedOrganizationId &&
      hasExplicitBuildingSelection
    ) {
      setSelectedBuildingIds([]);
    }
  }, [
    hasExplicitBuildingSelection,
    invalidOrganizationParam,
    selectedOrganizationId,
    setSelectedBuildingIds,
    setStoredOrganizationId,
    storedOrganizationId,
  ]);

  useEffect(() => {
    if (
      invalidOrganizationParam ||
      !selectedOrganization ||
      buildingSelectionUnavailable
    ) {
      return;
    }
    if (buildingSelectionNeedsNormalization) {
      setSelectedBuildingIds(visibleSelectedBuildingIds);
    }
  }, [
    buildingSelectionNeedsNormalization,
    buildingSelectionUnavailable,
    invalidOrganizationParam,
    selectedBuildingIds,
    selectedOrganization,
    setSelectedBuildingIds,
    visibleSelectedBuildingIds,
  ]);

  const selectTab = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(
      "tab",
      resolveBusinessPerformanceTab(value, canViewRestrictedFinance),
    );
    setSearchParams(next);
  };

  const selectOrganization = (organizationId: string, replace = false) => {
    if (!organizationIdSet.has(organizationId)) return;
    setStoredOrganizationId(organizationId);
    setSelectedBuildingIds([]);
    const next = new URLSearchParams(searchParams);
    next.set("org", organizationId);
    setSearchParams(next, replace ? { replace: true } : undefined);
  };

  let reportContent: ReactNode;
  if (invalidOrganizationParam) {
    reportContent = (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Liên kết tổ chức không hợp lệ</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <p>
            Tổ chức trong đường dẫn không thuộc phạm vi hiện tại. Hãy chọn một
            tổ chức hợp lệ ở bộ lọc để tiếp tục; báo cáo chưa tải dữ liệu tài
            chính.
          </p>
          {organizationIds.length === 1 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="recover-business-performance-organization"
              onClick={() => selectOrganization(organizationIds[0], true)}
            >
              Chọn {singleOrganizationLabel}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  } else if (organizationIds.length > 1 && !selectedOrganizationId) {
    reportContent = (
      <Alert>
        <Building2 className="size-4" aria-hidden="true" />
        <AlertTitle>Chọn tổ chức để tiếp tục</AlertTitle>
        <AlertDescription>
          Tài khoản có quyền trên nhiều tổ chức. Hãy chọn một tổ chức trước; báo
          cáo không tổng hợp dữ liệu chéo tổ chức.
        </AlertDescription>
      </Alert>
    );
  } else if (scopedPhysicalBuildings.length === 0) {
    reportContent = (
      <Alert variant="destructive">
        <Building2 className="size-4" aria-hidden="true" />
        <AlertTitle>Chưa có tòa nhà được cấp quyền</AlertTitle>
        <AlertDescription>
          Tổ chức đã chọn không có tòa nhà trong danh sách phân quyền của báo
          cáo. Trang không tải dữ liệu cho đến khi phạm vi được cấp lại.
        </AlertDescription>
      </Alert>
    );
  } else if (buildingSelectionUnavailable) {
    reportContent = (
      <Alert
        variant="destructive"
        data-testid="business-performance-building-scope-unavailable"
      >
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Lựa chọn tòa nhà không còn hiệu lực</AlertTitle>
        <AlertDescription>
          Bộ lọc đã lưu không còn khớp tòa nhà vật lý hiện tại. Hãy chọn lại một
          tòa nhà hoặc “Tất cả tòa nhà vật lý”.
        </AlertDescription>
      </Alert>
    );
  } else if (!canonicalQueryReady) {
    reportContent = <ReportLoadingState />;
  } else if (buildingSelectionNeedsNormalization) {
    reportContent = <ReportLoadingState />;
  } else if (!filters) {
    reportContent = (
      <Alert
        variant="destructive"
        data-testid="business-performance-building-scope-unavailable"
      >
        <TriangleAlert className="size-4" aria-hidden="true" />
        <AlertTitle>Lựa chọn tòa nhà không còn hiệu lực</AlertTitle>
        <AlertDescription>
          Bộ lọc đã lưu không còn khớp tòa nhà vật lý hiện tại. Hãy chọn lại một
          tòa nhà hoặc “Tất cả tòa nhà vật lý”.
        </AlertDescription>
      </Alert>
    );
  } else {
    reportContent = (
      <Suspense fallback={<ReportLoadingState />}>
        <ActiveReportTab
          tab={activeTab}
          filters={filters}
          buildings={scopedPhysicalBuildings}
        />
      </Suspense>
    );
  }

  const dataScopeNotice = isPhone ? (
    <Alert role="note" className="bg-muted/30 py-2">
      <Info className="size-4" aria-hidden="true" />
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Phạm vi dữ liệu hiện tại
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">
          Chỉ số hòa vốn và cohort lịch sử chưa hiển thị khi backend mapping,
          allocation và snapshot chưa đạt gate; hệ thống không điền số giả.
        </p>
      </details>
    </Alert>
  ) : (
    <Alert role="note" className="bg-muted/30 py-3">
      <Info className="size-4" aria-hidden="true" />
      <AlertTitle>Phạm vi dữ liệu hiện tại</AlertTitle>
      <AlertDescription>
        Các chỉ số hòa vốn và cohort lịch sử chưa hiển thị khi backend mapping,
        allocation và snapshot chưa đạt gate kiểm soát. Hệ thống không điền số
        giả cho các phần chưa đủ dữ liệu chuẩn.
      </AlertDescription>
    </Alert>
  );
  const permissionNotice =
    !canViewRestrictedFinance ? (
      <Alert role="note" className="py-2 sm:py-3">
        <Info className="size-4" aria-hidden="true" />
        <AlertTitle className="hidden sm:block">
          Phạm vi xem được giới hạn theo quyền
        </AlertTitle>
        <AlertDescription>
          <span className="sm:hidden">
            Chỉ các góc nhìn được phép được tải; không tải chi tiết hạn chế.
          </span>
          <span className="hidden sm:inline">
            Một số góc nhìn tài chính được ẩn. Trang chỉ tải dữ liệu vận hành và
            định nghĩa được phép, không tải chi tiết hạn chế.
          </span>
        </AlertDescription>
      </Alert>
    ) : null;

  return (
    <MainLayout>
      <div className="flex flex-col gap-4 sm:gap-5">
        <nav
          aria-label="Điều hướng báo cáo tài chính"
          className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex"
        >
          <span>Báo cáo tài chính</span>
          <ChevronRight className="size-4" aria-hidden="true" />
          <span aria-current="page" className="font-medium text-foreground">
            Trung tâm tài chính
          </span>
        </nav>

        <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:size-11">
                <BarChart3 aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-3xl">
                  Trung tâm Tài chính &amp; Hiệu quả kinh doanh
                </h1>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground sm:hidden">
                  Chỉ tòa nhà vật lý, theo cơ sở ghi nhận đã chọn.
                </p>
                <p className="mt-2 hidden max-w-3xl text-base leading-relaxed text-muted-foreground sm:block">
                  Phân tích chỉ trên các tòa nhà vật lý. Số liệu đang ghi nhận
                  theo
                  {basis === "ACCRUAL"
                    ? " kỳ áp dụng (dồn tích)"
                    : " ngày phiếu (đối chiếu)"}{" "}
                  để đối chiếu doanh thu, chi phí, công nợ và hiệu quả vận hành
                  nhất quán.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-label="Bộ lọc báo cáo"
          className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-3 shadow-sm sm:gap-3 sm:p-4 xl:grid-cols-4"
        >
          <div className="col-span-1 flex min-w-0 flex-col gap-1.5 sm:col-span-2 xl:col-span-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Building2 className="size-4" aria-hidden="true" />
              Tổ chức
            </span>
            {organizationIds.length > 1 ? (
              <SearchableSelect
                value={selectedOrganizationId || undefined}
                onValueChange={selectOrganization}
                options={organizationOptions}
                placeholder="Chọn tổ chức"
                searchPlaceholder="Tìm tổ chức..."
                disabled={organizationOptions.length === 0}
                aria-label="Chọn tổ chức"
              />
            ) : (
              <div
                data-testid="business-performance-organization-scope"
                aria-label={
                  organizationIds.length === 1
                    ? "Tổ chức áp dụng tự động"
                    : "Không có tổ chức hợp lệ"
                }
                className="flex min-h-10 items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-2 sm:px-3"
              >
                <span className="truncate text-sm font-medium text-foreground">
                  {organizationIds.length === 1
                    ? singleOrganizationLabel
                    : "Chưa có tổ chức hợp lệ"}
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {organizationIds.length === 1
                    ? "Phạm vi tự động"
                    : "Không khả dụng"}
                </span>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CalendarDays className="size-4" aria-hidden="true" />
              Kỳ báo cáo
            </span>
            <SearchableSelect
              value={month}
              onValueChange={setStoredMonth}
              options={monthOptions}
              searchPlaceholder="Tìm tháng..."
              aria-label="Chọn kỳ báo cáo"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Scale className="size-4" aria-hidden="true" />
              Cơ sở ghi nhận
            </span>
            <Select
              value={basis}
              onValueChange={(value) =>
                setStoredBasis(
                  value === "VOUCHER_DATE" ? "VOUCHER_DATE" : "ACCRUAL",
                )
              }
            >
              <SelectTrigger aria-label="Chọn cơ sở ghi nhận">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {BASIS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-1 flex min-w-0 flex-col gap-1.5 sm:col-span-2 xl:col-span-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Building2 className="size-4" aria-hidden="true" />
              Tòa nhà vật lý
            </span>
            <BuildingFilterSelect
              value={buildingFilterValue}
              onChange={setSelectedBuildingIds}
              buildings={scopedPhysicalBuildings}
              placeholder="Tất cả tòa nhà vật lý"
              disabled={
                !selectedOrganizationId || scopedPhysicalBuildings.length === 0
              }
              aria-label="Chọn tòa nhà vật lý"
            />
          </div>
        </section>

        {!isPhone ? dataScopeNotice : null}
        {!isPhone ? permissionNotice : null}

        <div data-testid="business-performance-view-picker">
          {isPhone ? (
            <div className="flex flex-col gap-3">
              <select
                value={activeTab}
                onChange={(event) => selectTab(event.currentTarget.value)}
                aria-label="Chọn góc nhìn tài chính"
                aria-controls={ACTIVE_REPORT_REGION_ID}
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {availableTabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {tab.label}
                  </option>
                ))}
              </select>
              <p
                id={ACTIVE_REPORT_LABEL_ID}
                className="sr-only"
                aria-live="polite"
                aria-atomic="true"
              >
                {`Góc nhìn hiện tại: ${activeTabLabel}`}
              </p>
              <section
                ref={activeReportRef}
                id={ACTIVE_REPORT_REGION_ID}
                role="region"
                aria-labelledby={ACTIVE_REPORT_LABEL_ID}
                tabIndex={-1}
              >
                {reportContent}
              </section>
              {dataScopeNotice}
              {permissionNotice}
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={selectTab}>
              <div className="overflow-x-auto pb-1">
                <TabsList
                  aria-label="Góc nhìn tài chính"
                  className="h-auto min-w-max justify-start"
                >
                  {availableTabs.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value={activeTab} className="mt-4">
                <p
                  id={ACTIVE_REPORT_LABEL_ID}
                  className="sr-only"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {`Góc nhìn hiện tại: ${activeTabLabel}`}
                </p>
                <section
                  ref={activeReportRef}
                  id={ACTIVE_REPORT_REGION_ID}
                  role="region"
                  aria-labelledby={ACTIVE_REPORT_LABEL_ID}
                  tabIndex={-1}
                >
                  {reportContent}
                </section>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
