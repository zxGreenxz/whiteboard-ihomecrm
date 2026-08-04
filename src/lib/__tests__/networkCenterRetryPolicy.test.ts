import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Án lệ production 04/08/2026: `/network-center` bắn 144 POST
 * `network_center_get_building_v1` trong 25 giây, MỌI response HTTP 200. Máy chủ
 * không hề hỏng — client tự nhân bản request vì `listFleet()` ném lỗi hợp đồng
 * rồi React Query thử lại theo mặc định toàn cục, và mỗi lần observer mount lại
 * là một lượt thử nữa (`retryOnMount` mặc định = true).
 *
 * Luật ở đây: lỗi do DỊCH VỤ Network Center trả về (server đã trả lời) KHÔNG
 * được thử lại; lỗi hạ tầng (mất mạng) được thử lại đúng một lần.
 */

const spies = vi.hoisted(() => ({
  queryOptions: [] as Array<{
    enabled?: boolean;
    retry?: unknown;
    retryOnMount?: unknown;
    queryFn?: () => unknown;
  }>,
}));

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

vi.mock("@tanstack/react-query", () => {
  const capture = (options: Record<string, unknown>) => {
    spies.queryOptions.push(options);
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
  };
  return {
    useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
    useQuery: capture,
    useInfiniteQuery: capture,
    useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  };
});

vi.mock("@/lib/network-center/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/network-center/runtime")>();
  const mode = "off" as const;
  return {
    ...actual,
    NETWORK_CENTER_RUNTIME_MODE: mode,
    NETWORK_CENTER_RUNTIME_ENABLED: actual.isNetworkCenterEnabled(mode),
  };
});

vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({ data: {}, isLoading: false }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a", email: "user@example.com" } }),
}));

vi.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({ data: { full_name: "Test User" } }),
}));

vi.mock("@/lib/network-center/supabaseRepository", () => ({
  NetworkCenterRepositoryError: class extends Error {},
  supabaseNetworkCenterRepository: { listFleet: vi.fn(async () => []) },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => ({ on: vi.fn(), subscribe: vi.fn() })),
    removeChannel: vi.fn(async () => undefined),
  },
}));

import {
  NETWORK_CENTER_MAX_QUERY_RETRIES,
  shouldRetryNetworkCenterQuery,
} from "@/lib/network-center/retryPolicy";
import { useNetworkCenter } from "@/hooks/network-center/useNetworkCenter";

function serviceError(message = "Dữ liệu Network Center không đúng hợp đồng"): Error {
  const error = new Error(message);
  error.name = "NetworkCenterRepositoryError";
  return error;
}

describe("Network Center — trần thử lại", () => {
  beforeEach(() => {
    spies.queryOptions.length = 0;
  });

  it("không thử lại khi dịch vụ Network Center đã trả lời", () => {
    expect(shouldRetryNetworkCenterQuery(0, serviceError())).toBe(false);
    expect(shouldRetryNetworkCenterQuery(5, serviceError())).toBe(false);
  });

  it("chỉ thử lại đúng một lần với lỗi hạ tầng", () => {
    expect(NETWORK_CENTER_MAX_QUERY_RETRIES).toBe(1);
    expect(shouldRetryNetworkCenterQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryNetworkCenterQuery(1, new TypeError("Failed to fetch"))).toBe(false);
    expect(shouldRetryNetworkCenterQuery(9, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("mọi query Network Center đều khai trần thử lại, không rơi về mặc định toàn cục", () => {
    useNetworkCenter("building-a");
    expect(spies.queryOptions.length).toBeGreaterThanOrEqual(4);
    for (const options of spies.queryOptions) {
      expect(options.retry).toBeDefined();
    }
    // Thứ tự khai báo trong hook: fleet, building, activeCommand, aruba.
    const [fleet, building, , aruba] = spies.queryOptions;
    for (const options of [fleet, building, aruba]) {
      expect(options.retry).toBe(shouldRetryNetworkCenterQuery);
      expect(options.retryOnMount).toBe(false);
    }
  });
});
