import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  infiniteOptions: [] as Array<{
    enabled?: boolean;
    queryKey?: readonly unknown[];
    maxPages?: number;
  }>,
  listArubaPage: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useEffect: () => undefined,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initialValue: T) => ({ current: initialValue }),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
  useQuery: (options: { enabled?: boolean }) => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isSuccess: false,
    refetch: vi.fn(async () => undefined),
    ...options,
  }),
  useInfiniteQuery: (options: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
    maxPages?: number;
  }) => {
    spies.infiniteOptions.push(options);
    return {
      data: undefined,
      error: null,
      isError: false,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(async () => undefined),
      refetch: vi.fn(async () => undefined),
    };
  },
  useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("@/lib/network-center/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/network-center/runtime")>();
  return {
    ...actual,
    NETWORK_CENTER_RUNTIME_MODE: "off" as const,
    NETWORK_CENTER_RUNTIME_ENABLED: false,
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
    listFleet: vi.fn(async () => []),
    listArubaPage: spies.listArubaPage,
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(),
    removeChannel: vi.fn(async () => undefined),
  },
}));

import { useNetworkCenter } from "@/hooks/network-center/useNetworkCenter";

describe("Network Center Aruba pagination runtime", () => {
  beforeEach(() => {
    spies.infiniteOptions.length = 0;
    spies.listArubaPage.mockClear();
  });

  it("uses an identity-scoped disabled query and keeps at most one page in memory", () => {
    useNetworkCenter("building-a");

    expect(spies.infiniteOptions).toHaveLength(1);
    expect(spies.infiniteOptions[0]).toMatchObject({
      enabled: false,
      maxPages: 1,
      queryKey: [
        "network-center",
        "user-a",
        "organization-a",
        "building",
        "building-a",
        "aruba",
      ],
    });
    expect(spies.listArubaPage).not.toHaveBeenCalled();
  });
});
