import {
  createElement,
  type DependencyList,
  type EffectCallback,
  type ReactNode,
} from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_TZ = process.env.TZ;
const PAGE_SOURCE = readFileSync(
  new URL("../BusinessPerformanceReportPage.tsx", import.meta.url),
  "utf8",
);

type TestComponentProps = {
  children?: ReactNode;
  [key: string]: unknown;
};

type AuthorizedBuilding = {
  id: string;
  name: string;
  restricted_allowed: boolean;
  analysis_provenance: Record<string, unknown>;
};

type Organization = {
  id: string;
  name: string;
  authorized_buildings: AuthorizedBuilding[];
  authorized_physical_building_count: number;
  authorization_version: number;
};

type SelectCapture = {
  ariaLabel?: string;
  "aria-label"?: string;
  value?: string;
  options: Array<{ value?: string }>;
  onValueChange?: (value: string) => void;
};

type BuildingSelectCapture = {
  value: string[];
  buildings: Array<{ id: string; name: string }>;
  disabled?: boolean;
  onChange?: (value: string[]) => void;
};

type ShadcnSelectItemCapture = {
  value?: string;
  label: string;
};

const harness = vi.hoisted(() => ({
  query: "",
  isPhone: false,
  runEffects: false,
  organizationLoading: false,
  organizationFetching: false,
  organizationStatus: "success" as "pending" | "error" | "success",
  organizationFetchStatus: "idle" as "fetching" | "paused" | "idle",
  organizationError: false,
  organizationLoadError: null as Error | null,
  organizations: [] as Organization[],
  persistedMonth: "2026-07" as string | undefined,
  persistedBasis: "ACCRUAL",
  persistedOrganizationId: "org-a",
  persistedBuildingIds: [] as string[],
  legacyAuthorizationCalls: 0,
  buildingQueryCalls: 0,
  lazyRegistrations: 0,
  leafMounts: [] as Array<{ registration: number; props: unknown }>,
  organizationQueryArgs: [] as unknown[][],
  searchableSelects: [] as SelectCapture[],
  shadcnSelectValue: undefined as string | undefined,
  shadcnSelectAriaLabel: undefined as string | undefined,
  shadcnSelectOnValueChange: undefined as
    | ((value: string) => void)
    | undefined,
  shadcnSelectItems: [] as ShadcnSelectItemCapture[],
  buildingSelect: undefined as BuildingSelectCapture | undefined,
  recoveryAction: undefined as (() => void) | undefined,
  authorizationRetryAction: undefined as (() => void) | undefined,
  monthInitializerValue: "",
  previousActiveTab: undefined as string | undefined,
  activeReportFocus: vi.fn(),
  activeReportElement: null as { focus: ReturnType<typeof vi.fn> } | null,
  documentBody: {} as object,
  activeElement: null as object | null,
  animationFrameCallbacks: [] as Array<(timestamp: number) => void>,
  setSearchParams: vi.fn(),
  setPersistedValue: vi.fn(),
  refetchOrganizations: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    lazy: vi.fn(() => {
      const registration = harness.lazyRegistrations;
      harness.lazyRegistrations += 1;
      return function TestReportLeaf(props: unknown) {
        harness.leafMounts.push({ registration, props });
        return actual.createElement("div", {
          "data-testid": "active-report-leaf",
          "data-leaf-registration": registration,
        });
      };
    }),
    useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
      if (harness.runEffects) {
        effect();
        return;
      }
      return actual.useEffect(effect, dependencies);
    },
    useRef: <T,>(initialValue: T) => {
      if (initialValue === null) {
        return { current: harness.activeReportElement };
      }
      if (
        typeof initialValue === "string" &&
        harness.previousActiveTab !== undefined
      ) {
        return { current: harness.previousActiveTab };
      }
      return { current: initialValue };
    },
  };
});

vi.mock("react-router-dom", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Link: ({ children, to, ...props }: TestComponentProps) =>
      React.createElement(
        "a",
        { ...props, href: typeof to === "string" ? to : "" },
        children,
      ),
    useSearchParams: () => [
      new URLSearchParams(harness.query),
      harness.setSearchParams,
    ],
  };
});

vi.mock("@/components/layout/MainLayout", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({ children }: TestComponentProps) =>
      React.createElement("main", null, children),
  };
});

vi.mock("@/components/buildings/BuildingFilterSelect", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    BuildingFilterSelect: (props: BuildingSelectCapture) => {
      harness.buildingSelect = props;
      return React.createElement("div", {
        "data-testid": "building-filter-select",
      });
    },
  };
});

vi.mock("@/components/finance-performance/FinanceDataState", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    FinanceQueryError: () =>
      React.createElement("div", { "data-testid": "finance-query-error" }),
  };
});

vi.mock("@/components/ui/alert", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Wrapper = ({ children, ...props }: TestComponentProps) =>
    React.createElement("div", props, children);
  return {
    Alert: Wrapper,
    AlertDescription: Wrapper,
    AlertTitle: Wrapper,
  };
});

vi.mock("@/components/ui/button", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Button: ({ asChild, children, ...props }: TestComponentProps) => {
      if (
        props["data-testid"] === "recover-business-performance-organization" &&
        typeof props.onClick === "function"
      ) {
        harness.recoveryAction = props.onClick as () => void;
      }
      if (
        props["data-testid"] ===
          "retry-business-performance-authorization" &&
        typeof props.onClick === "function"
      ) {
        harness.authorizationRetryAction = props.onClick as () => void;
      }
      return asChild
        ? children
        : React.createElement("button", props, children);
    },
  };
});

vi.mock("@/components/ui/searchable-select", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    SearchableSelect: ({
      options = [],
      value,
      onValueChange,
      "aria-label": ariaLabel,
    }: SelectCapture) => {
      harness.searchableSelects.push({
        ariaLabel,
        value,
        options,
        onValueChange,
      });
      return React.createElement("div", {
        "data-searchable-select": ariaLabel,
      });
    },
  };
});

vi.mock("@/components/ui/select", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Wrapper = ({ children }: TestComponentProps) =>
    React.createElement("div", null, children);

  return {
    Select: ({ children, value, onValueChange }: TestComponentProps) => {
      harness.shadcnSelectValue = typeof value === "string" ? value : undefined;
      harness.shadcnSelectOnValueChange =
        typeof onValueChange === "function"
          ? (onValueChange as (value: string) => void)
          : undefined;
      return React.createElement("div", { "data-shadcn-select": value }, children);
    },
    SelectContent: Wrapper,
    SelectGroup: Wrapper,
    SelectItem: ({ children, value }: TestComponentProps) => {
      harness.shadcnSelectItems.push({
        value: typeof value === "string" ? value : undefined,
        label: typeof children === "string" ? children : "",
      });
      return React.createElement("div", { "data-select-item": value }, children);
    },
    SelectTrigger: ({ children, "aria-label": ariaLabel }: TestComponentProps) => {
      harness.shadcnSelectAriaLabel =
        typeof ariaLabel === "string" ? ariaLabel : undefined;
      return React.createElement("button", { "aria-label": ariaLabel }, children);
    },
    SelectValue: () => React.createElement("span"),
  };
});

vi.mock("@/components/ui/skeleton", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return { Skeleton: () => React.createElement("div") };
});

vi.mock("@/components/ui/tabs", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Wrapper = ({ children }: TestComponentProps) =>
    React.createElement("div", null, children);
  return {
    Tabs: Wrapper,
    TabsContent: Wrapper,
    TabsList: Wrapper,
    TabsTrigger: Wrapper,
  };
});

vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: () => {
    harness.buildingQueryCalls += 1;
    return {
      data: [
        {
          id: "rogue-building",
          name: "Rogue building",
          is_virtual: false,
          organization_id: "org-a",
        },
      ],
      isLoading: false,
      isError: false,
      error: null as unknown,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/useIsAdmin", () => ({
  useIsAdmin: () => {
    harness.legacyAuthorizationCalls += 1;
    return { data: false, isLoading: false, isError: false };
  },
  useIsSuperAdmin: () => {
    harness.legacyAuthorizationCalls += 1;
    return { data: false, isLoading: false, isError: false };
  },
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => {
    harness.legacyAuthorizationCalls += 1;
    return { data: [] as unknown[], isLoading: false, isError: false };
  },
}));

vi.mock("@/lib/permissionPages", () => ({
  canUse: () => {
    harness.legacyAuthorizationCalls += 1;
    return false;
  },
}));

vi.mock("@/hooks/use-mobile", () => ({
  usePhoneViewport: () => harness.isPhone,
}));

vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: (key: string, initialValue: unknown) => {
    if (key.endsWith(":month")) {
      const fallback =
        typeof initialValue === "function"
          ? (initialValue as () => string)()
          : String(initialValue);
      harness.monthInitializerValue = fallback;
      return [harness.persistedMonth ?? fallback, harness.setPersistedValue];
    }
    if (key.endsWith(":basis")) {
      return [harness.persistedBasis, harness.setPersistedValue];
    }
    if (key.endsWith(":organizationId")) {
      return [harness.persistedOrganizationId, harness.setPersistedValue];
    }
    return [harness.persistedBuildingIds, harness.setPersistedValue];
  },
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceOrganizations: (...args: unknown[]) => {
    harness.organizationQueryArgs.push(args);
    return {
      data: harness.organizations,
      isLoading: harness.organizationLoading,
      isFetching: harness.organizationFetching,
      status: harness.organizationStatus,
      fetchStatus: harness.organizationFetchStatus,
      isError: harness.organizationError,
      error: harness.organizationLoadError,
      refetch: harness.refetchOrganizations,
    };
  },
}));

import BusinessPerformanceReportPage from "../BusinessPerformanceReportPage";

function building(
  id: string,
  name: string,
  restrictedAllowed: boolean,
): AuthorizedBuilding {
  return {
    id,
    name,
    restricted_allowed: restrictedAllowed,
    analysis_provenance: { decision: "test" },
  };
}

function organization(
  id: string,
  name: string,
  buildings: AuthorizedBuilding[],
): Organization {
  return {
    id,
    name,
    authorized_buildings: buildings,
    authorized_physical_building_count: buildings.length,
    authorization_version: 1,
  };
}

function renderPage() {
  return renderToString(createElement(BusinessPerformanceReportPage));
}

function selectCapture(ariaLabel: string) {
  return harness.searchableSelects.find(
    (select) => select.ariaLabel === ariaLabel,
  );
}

function expectMountedRegistration(registration: number) {
  expect(harness.leafMounts).toHaveLength(1);
  expect(harness.leafMounts[0]?.registration).toBe(registration);
  return harness.leafMounts[0]?.props as {
    filters?: { buildingIds?: string[]; organizationId?: string };
    buildings?: Array<{ id: string; name: string }>;
  };
}

describe("BusinessPerformanceReportPage organization roster authorization", () => {
  beforeEach(() => {
    harness.query = "org=org-a&tab=occupancy-vacancy";
    harness.isPhone = false;
    harness.runEffects = false;
    harness.organizationLoading = false;
    harness.organizationFetching = false;
    harness.organizationStatus = "success";
    harness.organizationFetchStatus = "idle";
    harness.organizationError = false;
    harness.organizationLoadError = null;
    harness.organizations = [
      organization("org-a", "Organization A", [
        building("building-a", "Building A", true),
        building("building-b", "Building B", false),
      ]),
    ];
    harness.persistedMonth = "2026-07";
    harness.persistedBasis = "ACCRUAL";
    harness.persistedOrganizationId = "org-a";
    harness.persistedBuildingIds = [];
    harness.legacyAuthorizationCalls = 0;
    harness.buildingQueryCalls = 0;
    harness.leafMounts = [];
    harness.organizationQueryArgs = [];
    harness.searchableSelects = [];
    harness.shadcnSelectValue = undefined;
    harness.shadcnSelectAriaLabel = undefined;
    harness.shadcnSelectOnValueChange = undefined;
    harness.shadcnSelectItems = [];
    harness.buildingSelect = undefined;
    harness.recoveryAction = undefined;
    harness.authorizationRetryAction = undefined;
    harness.monthInitializerValue = "";
    harness.previousActiveTab = undefined;
    harness.activeReportFocus.mockReset();
    harness.activeReportElement = null;
    harness.documentBody = {};
    harness.activeElement = null;
    harness.animationFrameCallbacks = [];
    harness.setSearchParams.mockReset();
    harness.setPersistedValue.mockReset();
    harness.refetchOrganizations.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  test("keeps all seven lazy report leaves registered", () => {
    renderPage();

    expect(harness.lazyRegistrations).toBe(7);
  });

  test("does not show the obsolete blanket backend-gate banner", () => {
    const html = renderPage();

    expect(html).not.toContain("Phạm vi dữ liệu hiện tại");
    expect(html).not.toContain("backend mapping");
    expect(html).not.toContain("allocation và snapshot chưa đạt gate");
  });

  test("uses the organization roster as the only page authorization and building authority", () => {
    renderPage();

    expect(harness.organizationQueryArgs).toEqual([[]]);
    expect(harness.legacyAuthorizationCalls).toBe(0);
    expect(harness.buildingQueryCalls).toBe(0);
    expect(harness.buildingSelect?.buildings).toEqual([
      expect.objectContaining({ id: "building-a", name: "Building A" }),
      expect.objectContaining({ id: "building-b", name: "Building B" }),
    ]);
    expect(harness.buildingSelect?.buildings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "rogue-building" }),
      ]),
    );
  });

  test("fails closed while the organization roster is loading", () => {
    harness.organizationLoading = true;

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain("Đang xác minh quyền truy cập báo cáo");
  });

  test("fails closed while a cached organization roster is revalidating", () => {
    harness.organizationFetching = true;

    const html = renderPage();

    expect(harness.organizations).not.toHaveLength(0);
    expect(harness.leafMounts).toHaveLength(0);
    expect(harness.buildingSelect).toBeUndefined();
    expect(html).toContain("Đang xác minh quyền truy cập báo cáo");
    expect(html).not.toContain('data-testid="active-report-leaf"');
  });

  test("fails closed and offers retry for an initial paused roster request", () => {
    harness.organizations = [];
    harness.organizationStatus = "pending";
    harness.organizationFetchStatus = "paused";

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain("Đang xác minh quyền truy cập báo cáo");
    expect(html).not.toContain('data-testid="business-performance-auth-empty"');
    expect(html).toContain('aria-label="Thử xác minh lại quyền truy cập"');

    harness.authorizationRetryAction?.();
    expect(harness.refetchOrganizations).toHaveBeenCalledTimes(1);
  });

  test("fails closed for a cached roster whose revalidation is paused", () => {
    harness.organizationStatus = "success";
    harness.organizationFetchStatus = "paused";

    const html = renderPage();

    expect(harness.organizations).not.toHaveLength(0);
    expect(harness.leafMounts).toHaveLength(0);
    expect(harness.buildingSelect).toBeUndefined();
    expect(html).toContain("Đang xác minh quyền truy cập báo cáo");
    expect(html).not.toContain('data-testid="active-report-leaf"');
  });

  test("fails closed when the organization roster errors", () => {
    harness.organizationError = true;
    harness.organizationLoadError = new Error("roster unavailable");

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain('data-testid="business-performance-auth-error"');
    expect(html).toContain('aria-label="Thử xác minh lại quyền truy cập"');

    harness.authorizationRetryAction?.();
    expect(harness.refetchOrganizations).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the organization roster is empty", () => {
    harness.organizations = [];

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain('data-testid="business-performance-auth-empty"');
  });

  test("fails closed when the selected organization has no authorized buildings", () => {
    harness.organizations = [organization("org-a", "Organization A", [])];

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain("Chưa có tòa nhà được cấp quyền");
  });

  test("resolves an empty building selection to the entire authorized roster", () => {
    renderPage();

    const props = expectMountedRegistration(2);

    expect(props.filters?.buildingIds).toEqual(["building-a", "building-b"]);
    expect(props.filters?.organizationId).toBe("org-a");
  });

  test("allows restricted leaves when every explicitly selected building is allowed", () => {
    harness.query = "org=org-a&tab=business-overview";
    harness.persistedBuildingIds = ["building-a"];

    renderPage();

    const props = expectMountedRegistration(0);
    expect(props.filters?.buildingIds).toEqual(["building-a"]);
  });

  test("keeps occupancy usable for an explicitly selected denied building", () => {
    harness.persistedBuildingIds = ["building-b"];

    const html = renderPage();

    const props = expectMountedRegistration(2);
    expect(props.filters?.buildingIds).toEqual(["building-b"]);
    expect(html).toContain("Phạm vi xem được giới hạn theo quyền");
  });

  test("normalizes a mixed restricted deep link to the safe occupancy tab before mounting", () => {
    harness.query = "org=org-a&tab=revenue-cost-structure";
    harness.persistedBuildingIds = ["building-a", "building-b"];
    harness.runEffects = true;

    renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(harness.setSearchParams).toHaveBeenCalledTimes(1);
    const [nextSearchParams, options] = harness.setSearchParams.mock.calls[0];
    expect(nextSearchParams.toString()).toBe(
      "org=org-a&tab=occupancy-vacancy",
    );
    expect(options).toEqual({ replace: true });
  });

  test("exposes only safe tabs when the resolved selection lacks full restricted capability", () => {
    harness.isPhone = true;
    harness.persistedBuildingIds = ["building-a", "building-b"];

    const html = renderPage();
    const viewPickerHtml = html.slice(
      html.indexOf('data-testid="business-performance-view-picker"'),
    );

    expect(viewPickerHtml).toContain('value="occupancy-vacancy"');
    expect(viewPickerHtml).toContain('value="data-definitions"');
    expect(viewPickerHtml).not.toContain('value="business-overview"');
  });

  test("keeps data definitions usable without restricted capability", () => {
    harness.query = "org=org-a&tab=data-definitions";

    renderPage();

    expectMountedRegistration(6);
  });

  test("normalizes stale building IDs before any leaf mounts", () => {
    harness.query = "org=org-a&tab=business-overview";
    harness.persistedBuildingIds = ["stale-building", "building-a"];
    harness.runEffects = true;

    renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(harness.setPersistedValue).toHaveBeenCalledTimes(1);
    expect(harness.setPersistedValue).toHaveBeenCalledWith(["building-a"]);
    expect(harness.setSearchParams).not.toHaveBeenCalled();

    harness.runEffects = false;
    harness.persistedBuildingIds = ["building-a"];
    renderPage();

    expectMountedRegistration(0);
  });

  test("fails closed when every explicitly selected building is stale", () => {
    harness.persistedBuildingIds = ["stale-building"];
    harness.runEffects = true;

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain(
      'data-testid="business-performance-building-scope-unavailable"',
    );
    expect(harness.setPersistedValue).not.toHaveBeenCalledWith([]);
    expect(harness.buildingSelect?.disabled).toBe(false);
    expect(harness.buildingSelect?.value).toEqual(["stale-building"]);

    harness.buildingSelect?.onChange?.([]);
    expect(harness.setPersistedValue).toHaveBeenCalledWith([]);
  });

  test("does not mount a leaf before organization and tab query state is canonical", () => {
    harness.query = "tab=business-overview";

    renderPage();

    expect(harness.leafMounts).toHaveLength(0);
  });

  test("recovers an invalid single-organization URL with replace navigation", () => {
    harness.query = "org=outside-scope&tab=occupancy-vacancy";

    const html = renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    expect(html).toContain(
      'data-testid="recover-business-performance-organization"',
    );
    harness.recoveryAction?.();
    expect(harness.setPersistedValue).toHaveBeenNthCalledWith(1, "org-a");
    expect(harness.setPersistedValue).toHaveBeenNthCalledWith(2, []);
    const [nextSearchParams, options] = harness.setSearchParams.mock.calls[0];
    expect(nextSearchParams.toString()).toBe(
      "org=org-a&tab=occupancy-vacancy",
    );
    expect(options).toEqual({ replace: true });
  });

  test("pushes an explicit organization change into history and resets the building selection", () => {
    harness.organizations = [
      ...harness.organizations,
      organization("org-b", "Organization B", [
        building("building-c", "Building C", true),
      ]),
    ];

    renderPage();
    selectCapture("Chọn tổ chức")?.onValueChange?.("org-b");

    expect(harness.setPersistedValue).toHaveBeenNthCalledWith(1, "org-b");
    expect(harness.setPersistedValue).toHaveBeenNthCalledWith(2, []);
    const [nextSearchParams, options] = harness.setSearchParams.mock.calls[0];
    expect(nextSearchParams.toString()).toBe(
      "org=org-b&tab=occupancy-vacancy",
    );
    expect(options).toBeUndefined();
  });

  test.each([
    ["deep link", "org-a", "building-a", "org-b", "building-c"],
    ["history traversal", "org-b", "building-c", "org-a", "building-a"],
  ])(
    "resets the previous organization building scope during a valid %s organization change",
    (
      _navigation,
      storedOrganizationId,
      storedBuildingId,
      targetOrganizationId,
      targetBuildingId,
    ) => {
      harness.organizations = [
        organization("org-a", "Organization A", [
          building("building-a", "Building A", true),
        ]),
        organization("org-b", "Organization B", [
          building("building-c", "Building C", true),
        ]),
      ];
      harness.query = `org=${targetOrganizationId}&tab=business-overview`;
      harness.persistedOrganizationId = storedOrganizationId;
      harness.persistedBuildingIds = [storedBuildingId];
      harness.runEffects = true;

      renderPage();

      expect(harness.leafMounts).toHaveLength(0);
      expect(harness.setPersistedValue).toHaveBeenNthCalledWith(
        1,
        targetOrganizationId,
      );
      expect(harness.setPersistedValue).toHaveBeenNthCalledWith(2, []);
      expect(harness.setSearchParams).not.toHaveBeenCalled();

      harness.persistedOrganizationId = targetOrganizationId;
      harness.persistedBuildingIds = [];
      harness.runEffects = false;
      harness.leafMounts = [];
      renderPage();

      const props = expectMountedRegistration(0);
      expect(props.filters?.organizationId).toBe(targetOrganizationId);
      expect(props.filters?.buildingIds).toEqual([targetBuildingId]);
    },
  );

  test("canonicalizes a stored multi-organization choice with replace navigation", () => {
    harness.organizations = [
      ...harness.organizations,
      organization("org-b", "Organization B", [
        building("building-c", "Building C", true),
      ]),
    ];
    harness.query = "tab=business-overview";
    harness.persistedOrganizationId = "org-b";
    harness.runEffects = true;

    renderPage();

    expect(harness.leafMounts).toHaveLength(0);
    const [nextSearchParams, options] = harness.setSearchParams.mock.calls[0];
    expect(nextSearchParams.toString()).toBe(
      "tab=business-overview&org=org-b",
    );
    expect(options).toEqual({ replace: true });
  });

  test("does not couple the business-performance page to the standalone profit report", () => {
    const html = renderPage();

    expect(PAGE_SOURCE).not.toMatch(
      /useProfitDistributionAccess|ProfitDistributionRouteGuard|profitDistributionAccess/,
    );
    expect(PAGE_SOURCE).not.toMatch(
      /\/reports\/finance\/profit-distribution|Báo cáo Lợi Nhuận|Mở Báo cáo Lợi Nhuận/,
    );
    expect(html).not.toContain('href="/reports/finance/profit-distribution"');
    expect(harness.leafMounts).toHaveLength(1);
  });

  test("does not link the standalone page breadcrumb to the finance index", () => {
    const html = renderPage();

    expect(html).toContain("Báo cáo tài chính");
    expect(html).not.toContain('href="/reports/finance"');
    expect(html).toMatch(
      /<span(?=[^>]*aria-current="page")[^>]*>Trung tâm tài chính<\/span>/,
    );
  });

  test("uses the keyboard-operable shadcn select for the report basis", () => {
    renderPage();

    expect(PAGE_SOURCE).not.toContain("searchable={false}");
    expect(PAGE_SOURCE).not.toMatch(
      /<SearchableSelect[^>]*aria-label="Chọn cơ sở ghi nhận"/s,
    );
    expect(PAGE_SOURCE).toMatch(
      /<Select[\s\S]*?onValueChange=\{\(value\) =>[\s\S]*?setStoredBasis/,
    );
    expect(selectCapture("Chọn cơ sở ghi nhận")).toBeUndefined();
    expect(harness.shadcnSelectValue).toBe("ACCRUAL");
    expect(harness.shadcnSelectAriaLabel).toBe("Chọn cơ sở ghi nhận");
    expect(harness.shadcnSelectOnValueChange).toBeTypeOf("function");
    expect(harness.shadcnSelectItems).toEqual([
      { value: "ACCRUAL", label: "Dồn tích theo kỳ áp dụng" },
      { value: "VOUCHER_DATE", label: "Theo ngày phiếu — đối chiếu" },
    ]);

    harness.shadcnSelectOnValueChange?.("VOUCHER_DATE");
    expect(harness.setPersistedValue).toHaveBeenCalledWith("VOUCHER_DATE");
  });

  test("associates the native mobile view picker with a named report region", () => {
    harness.isPhone = true;

    const html = renderPage();

    expect(PAGE_SOURCE).not.toMatch(
      /<SearchableSelect[^>]*aria-label="Chọn góc nhìn tài chính"/s,
    );
    expect(PAGE_SOURCE).toMatch(
      /<select[\s\S]*?onChange=\{\(event\) => selectTab\(event\.currentTarget\.value\)\}[\s\S]*?aria-controls=\{ACTIVE_REPORT_REGION_ID\}/,
    );
    expect(html).toMatch(
      /<select[^>]*aria-label="Chọn góc nhìn tài chính"[^>]*aria-controls="business-performance-active-report"/,
    );
    expect(html).toMatch(
      /<section(?=[^>]*id="business-performance-active-report")(?=[^>]*role="region")(?=[^>]*aria-labelledby="business-performance-active-report-label")(?=[^>]*tabindex="-1")[^>]*>/,
    );
    expect(html).toMatch(
      /id="business-performance-active-report-label"[^>]*aria-live="polite"[^>]*>Góc nhìn hiện tại: Lấp đầy &amp; Phòng trống</,
    );
    expect(html).not.toMatch(
      /<section[^>]*id="business-performance-active-report"[^>]*aria-live=/,
    );
  });

  test("exposes the same focusable report region on desktop", () => {
    const html = renderPage();

    expect(html).toMatch(
      /<section(?=[^>]*id="business-performance-active-report")(?=[^>]*role="region")(?=[^>]*aria-labelledby="business-performance-active-report-label")(?=[^>]*tabindex="-1")[^>]*>/,
    );
  });

  test.each([
    ["desktop", false],
    ["mobile", true],
  ])(
    "focuses the committed %s report when the old drill-down control unmounts",
    (_viewport, isPhone) => {
      harness.isPhone = isPhone;
      harness.runEffects = true;
      harness.previousActiveTab = "business-overview";
      harness.activeReportElement = { focus: harness.activeReportFocus };
      harness.activeElement = {};
      vi.stubGlobal("document", {
        get activeElement() {
          return harness.activeElement;
        },
        body: harness.documentBody,
      });
      vi.stubGlobal("window", {
        requestAnimationFrame: (callback: (timestamp: number) => void) => {
          harness.animationFrameCallbacks.push(callback);
          return harness.animationFrameCallbacks.length;
        },
        cancelAnimationFrame: vi.fn(),
      });

      renderPage();

      expect(harness.activeReportFocus).not.toHaveBeenCalled();
      harness.animationFrameCallbacks[0]?.(0);
      expect(harness.activeReportFocus).not.toHaveBeenCalled();
      harness.activeElement = harness.documentBody;
      harness.animationFrameCallbacks[1]?.(16);
      expect(harness.activeReportFocus).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["desktop tab", false],
    ["mobile picker", true],
  ])("keeps focus on the mounted %s during tab changes", (_control, isPhone) => {
    harness.isPhone = isPhone;
    harness.runEffects = true;
    harness.previousActiveTab = "business-overview";
    harness.activeReportElement = { focus: harness.activeReportFocus };
    harness.activeElement = {};
    vi.stubGlobal("document", {
      get activeElement() {
        return harness.activeElement;
      },
      body: harness.documentBody,
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        harness.animationFrameCallbacks.push(callback);
        return harness.animationFrameCallbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
    });

    renderPage();

    harness.animationFrameCallbacks[0]?.(0);
    harness.animationFrameCallbacks[1]?.(16);
    expect(harness.activeReportFocus).not.toHaveBeenCalled();
  });

  test("marks static report notices as notes", () => {
    harness.isPhone = true;
    harness.persistedBuildingIds = ["building-b"];

    const html = renderPage();

    expect(html.match(/role="note"/g)).toHaveLength(1);
  });

  test("keeps the mobile report before the limited-access notice", () => {
    harness.isPhone = true;
    harness.persistedBuildingIds = ["building-b"];

    const html = renderPage();

    const reportIndex = html.indexOf('data-testid="active-report-leaf"');
    const noticeIndex = html.indexOf(
      "Chỉ các góc nhìn được phép được tải",
    );
    expect(reportIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeGreaterThan(reportIndex);
  });

  test("derives the business month in Asia/Ho_Chi_Minh", () => {
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T18:30:00.000Z"));
    harness.persistedMonth = undefined;

    renderPage();

    expect(harness.monthInitializerValue).toBe("2026-08");
  });
});
