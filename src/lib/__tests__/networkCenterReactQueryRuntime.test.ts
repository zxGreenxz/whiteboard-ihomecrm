import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSpies = vi.hoisted(() => {
  const channelOn = vi.fn();
  const channelSubscribe = vi.fn();
  const channelApi = { on: channelOn, subscribe: channelSubscribe };
  channelOn.mockImplementation(() => channelApi);

  return {
    queryOptions: [] as Array<{
      enabled?: boolean;
      queryFn?: () => unknown;
    }>,
    queryErrors: [] as unknown[],
    invalidateQueries: vi.fn(async () => undefined),
    listFleet: vi.fn(async () => []),
    channel: vi.fn(() => channelApi),
    channelOn,
    channelSubscribe,
    removeChannel: vi.fn(async () => undefined),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      void effect();
    },
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initialValue: T) => ({ current: initialValue }),
    useState: <T>(initialValue: T) => [initialValue, vi.fn()] as const,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: runtimeSpies.invalidateQueries,
  }),
  useQuery: (options: {
    enabled?: boolean;
    queryFn?: () => unknown;
  }) => {
    runtimeSpies.queryOptions.push(options);
    if (options.enabled) {
      try {
        void options.queryFn?.();
      } catch (error) {
        runtimeSpies.queryErrors.push(error);
      }
    }
    return {
      data: undefined,
      error: null,
      isError: false,
      isLoading: false,
      isSuccess: false,
      refetch: vi.fn(async () => undefined),
    };
  },
  useMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useInfiniteQuery: (options: {
    enabled?: boolean;
    queryFn?: () => unknown;
  }) => {
    runtimeSpies.queryOptions.push(options);
    if (options.enabled) {
      try {
        void options.queryFn?.();
      } catch (error) {
        runtimeSpies.queryErrors.push(error);
      }
    }
    return {
      data: undefined,
      error: null,
      hasNextPage: false,
      isError: false,
      isFetchingNextPage: false,
      isLoading: false,
      isSuccess: false,
      fetchNextPage: vi.fn(async () => undefined),
      refetch: vi.fn(async () => undefined),
    };
  },
}));

vi.mock("@/lib/network-center/runtime", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/network-center/runtime")
  >();
  const mode = "off" as const;

  return {
    ...actual,
    NETWORK_CENTER_RUNTIME_MODE: mode,
    NETWORK_CENTER_RUNTIME_ENABLED: actual.isNetworkCenterEnabled(mode),
  };
});

vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: () => ({
    data: [{
      id: "building-a",
      name: "Building A",
      rooms_count: 10,
      organization_id: "organization-a",
    }],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({
    data: { network_center: { view: true, execute: true } },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a", email: "user@example.com" } }),
}));

vi.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({ data: { full_name: "Test User" } }),
}));

vi.mock("@/lib/network-center/supabaseRepository", () => ({
  supabaseNetworkCenterRepository: {
    listFleet: runtimeSpies.listFleet,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: runtimeSpies.channel,
    removeChannel: runtimeSpies.removeChannel,
  },
}));

import {
  NETWORK_CENTER_REALTIME_TABLES,
  resolveNetworkCenterMode,
  resolveNetworkCenterRealtimeTarget,
  selectNetworkCenterRepository,
} from "@/lib/network-center/runtime";
import { useNetworkCenter } from "@/hooks/network-center/useNetworkCenter";

describe("Network Center React Query runtime", () => {
  beforeEach(() => {
    runtimeSpies.queryOptions.length = 0;
    runtimeSpies.queryErrors.length = 0;
    runtimeSpies.invalidateQueries.mockClear();
    runtimeSpies.listFleet.mockClear();
    runtimeSpies.channel.mockClear();
    runtimeSpies.channelOn.mockClear();
    runtimeSpies.channelSubscribe.mockClear();
    runtimeSpies.removeChannel.mockClear();
  });

  it("requires an explicit enabled mode", () => {
    expect(resolveNetworkCenterMode(undefined, true)).toBe("off");
    expect(resolveNetworkCenterMode("", true)).toBe("off");
    expect(resolveNetworkCenterMode("development", true)).toBe("off");
    expect(resolveNetworkCenterMode("production", true)).toBe("production");
    expect(resolveNetworkCenterMode(" DEMO ", false)).toBe("demo");

    const production = { kind: "production" };
    const demo = { kind: "demo" };
    expect(selectNetworkCenterRepository("production", production, demo)).toBe(production);
    expect(selectNetworkCenterRepository("demo", production, demo)).toBe(demo);
  });

  it("does not run repository queries or Realtime subscriptions while off", () => {
    const controller = useNetworkCenter("building-a");

    expect(runtimeSpies.channel).not.toHaveBeenCalled();
    expect(runtimeSpies.channelSubscribe).not.toHaveBeenCalled();
    expect(controller.mode).toBe("off");
    expect(controller.canView).toBe(false);
    expect(controller.canExecute).toBe(false);
    expect(runtimeSpies.queryOptions).toHaveLength(4);
    expect(runtimeSpies.queryOptions.every((options) => options.enabled === false)).toBe(true);
    expect(runtimeSpies.queryErrors).toEqual([]);
    expect(runtimeSpies.listFleet).not.toHaveBeenCalled();
  });

  it("subscribes only to the five sanitized Realtime projections", () => {
    expect(NETWORK_CENTER_REALTIME_TABLES).toEqual([
      "network_device_current",
      "network_interface_current",
      "network_incidents",
      "network_command_events",
      "network_worker_building_status",
    ]);
    expect(NETWORK_CENTER_REALTIME_TABLES).not.toContain("network_commands");
    expect(NETWORK_CENTER_REALTIME_TABLES).not.toContain("network_device_samples");
    expect(NETWORK_CENTER_REALTIME_TABLES).not.toContain("network_worker_heartbeats");
  });

  it("targets building invalidation without trusting payloads as cached domain state", () => {
    expect(resolveNetworkCenterRealtimeTarget(
      "network_device_current",
      { new: { building_id: " BUILDING-A " }, old: {} },
      "building-selected",
    )).toEqual({ invalidateFleet: true, buildingIds: ["building-a"] });

    expect(resolveNetworkCenterRealtimeTarget(
      "network_command_events",
      { new: { command_id: "command-a" } },
      " BUILDING-SELECTED ",
    )).toEqual({ invalidateFleet: true, buildingIds: ["building-selected"] });

    expect(resolveNetworkCenterRealtimeTarget(
      "network_worker_building_status",
      { new: { building_id: "BUILDING-A", status: "ONLINE" } },
      undefined,
    )).toEqual({ invalidateFleet: true, buildingIds: ["building-a"] });
  });
});
