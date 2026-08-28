import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  infiniteOptions: [] as Array<{
    enabled?: boolean;
    queryKey?: readonly unknown[];
    maxPages?: number;
  }>,
  listArubaPage: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

/**
 * Hình dạng TỐI THIỂU của kết quả react-query mà `useNetworkCenter` đọc tới.
 * Khai tường minh vì object literal toàn `undefined`/`null` không có ngữ cảnh
 * kiểu thì mọi trường đều rơi về `any` ngầm.
 */
type QueryStub = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  refetch: () => Promise<void>;
  /** Mock trả lại chính options nhận được để test soi cờ gate. */
  enabled?: boolean;
};

type InfiniteQueryStub = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<void>;
  refetch: () => Promise<void>;
};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useEffect: (): void => undefined,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initialValue: T) => ({ current: initialValue }),
    useState: <T>(initialValue: T) => [initialValue, vi.fn()] as const,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
  useQuery: (options: { enabled?: boolean }): QueryStub => ({
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
  }): InfiniteQueryStub => {
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

    // HAI truy vấn phân trang: Aruba và H196A. Hai toà thật chạy hai mô hình
    // khác nhau — 102LVT có 10 con Aruba và 0 con H196A, 950NK thì ngược lại —
    // nên mỗi loại có đường nạp riêng. Con số này được ghim để một truy vấn thứ
    // ba không lặng lẽ chui vào ngân sách request.
    expect(spies.infiniteOptions).toHaveLength(2);
    // Tìm theo khoá thay vì theo chỉ số: thứ tự khai báo trong hook không phải
    // là thứ mà test này muốn ghim.
    const theoLoai = (loai: string) => spies.infiniteOptions.find(
      (options) => (options.queryKey as unknown[]).at(-1) === loai,
    );
    for (const loai of ["aruba", "h196a"]) {
      expect(theoLoai(loai)).toMatchObject({
        enabled: false,
        maxPages: 1,
        queryKey: [
          "network-center",
          "user-a",
          "organization-a",
          "building",
          "building-a",
          loai,
        ],
      });
    }
    expect(spies.listArubaPage).not.toHaveBeenCalled();
  });
});
